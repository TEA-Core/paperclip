import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueRecoveryActions, issueRelations, issues, issueThreadInteractions, issueTreeHolds, type Db } from "@paperclipai/db";
import type { ParkRecoveryCarrier, RecoveryCarrierParkBinding, RecoveryCarrierParkCandidate, ReleaseRecoveryCarrierPark } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { logActivityInTransaction, publishActivity, type ActivityPublication, type LogActivityInput } from "./activity-log.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { listRecoveryCarrierParks } from "./recovery-carrier-park-state.js";

type BoardParkActor = Pick<LogActivityInput, "actorType" | "actorId" | "boardApiKeyId" | "runId">;

export function recoveryCarrierParkService(db: Db) {
  async function candidate(companyId: string, carrierId: string): Promise<RecoveryCarrierParkCandidate | null> {
    const [carrier] = await db.select().from(issues).where(and(eq(issues.id, carrierId), eq(issues.companyId, companyId)));
    if (!carrier || carrier.hiddenAt || ["done", "cancelled"].includes(carrier.status)) return null;
    const actions = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.recoveryIssueId, carrierId),
      eq(issueRecoveryActions.status, "escalated"), eq(issueRecoveryActions.outcome, "exhausted"),
    )).limit(2);
    if (actions.length !== 1) return null;
    const action = actions[0];
    const [decisions, blockers] = await Promise.all([
      db.select({ id: issueThreadInteractions.id, summary: issueThreadInteractions.summary, updatedAt: issueThreadInteractions.updatedAt })
        .from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.issueId, carrierId), eq(issueThreadInteractions.kind, "request_confirmation"),
          eq(issueThreadInteractions.status, "rejected"), sql`${issueThreadInteractions.resolvedByUserId} is not null`,
          sql`${issueThreadInteractions.resolvedByAgentId} is null`)).orderBy(asc(issueThreadInteractions.id)),
      db.select({ id: issues.id, status: issues.status, statusVersion: issues.statusVersion }).from(issueRelations)
        .innerJoin(issues, and(eq(issues.id, issueRelations.issueId), eq(issues.companyId, companyId)))
        .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.relatedIssueId, carrierId), eq(issueRelations.type, "blocks"))),
    ]);
    return { sourceIssueId: action.sourceIssueId, recoveryActionId: action.id,
      expectedStatus: carrier.status, expectedStatusVersion: carrier.statusVersion,
      expectedAssigneeAgentId: carrier.assigneeAgentId, expectedAssigneeUserId: carrier.assigneeUserId,
      expectedActionUpdatedAt: action.updatedAt.toISOString(), expectedBlockers: blockers,
      decisions: decisions.map(row => ({ ...row, updatedAt: row.updatedAt.toISOString() })) };
  }
  async function park(companyId: string, carrierId: string, input: ParkRecoveryCarrier, actor: BoardParkActor) {
    if (actor.actorType !== "user") throw forbidden("Only the board can park recovery work");
    const publications: ActivityPublication[] = [];
    const result = await db.transaction(async tx => {
      // All recovery upserts take the source lock first. No source/action writes.
      const [source] = await tx.select().from(issues).where(and(eq(issues.id, input.sourceIssueId), eq(issues.companyId, companyId))).for("update");
      if (!source || source.id === carrierId) throw conflict("Recovery source changed");
      if (source.monitorNextCheckAt) throw conflict("The source has a scheduled monitor; park cannot discard it");
      const [carrier] = await tx.select().from(issues).where(and(eq(issues.id, carrierId), eq(issues.companyId, companyId))).for("update");
      if (!carrier) throw notFound("Recovery carrier not found");
      const [action] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.id, input.recoveryActionId), eq(issueRecoveryActions.companyId, companyId))).for("share");
      const [decision] = await tx.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id, input.decisionInteractionId), eq(issueThreadInteractions.companyId, companyId))).for("share");
      if (!action || action.sourceIssueId !== source.id || action.recoveryIssueId !== carrier.id ||
          action.status !== "escalated" || action.outcome !== "exhausted" || action.ownerType !== "board" || action.ownerAgentId ||
          action.wakePolicy || action.monitorPolicy || action.resolvedAt || action.updatedAt.toISOString() !== input.expectedActionUpdatedAt) {
        throw conflict("The exact exhausted board recovery action changed");
      }
      if (!decision || decision.issueId !== carrier.id || decision.kind !== "request_confirmation" || decision.status !== "rejected" ||
          !decision.resolvedByUserId || decision.resolvedByAgentId || !decision.resolvedAt || decision.updatedAt.toISOString() !== input.expectedDecisionUpdatedAt) {
        throw conflict("The historical board decision changed");
      }
      if (carrier.hiddenAt || ["done", "cancelled"].includes(carrier.status) || carrier.status !== input.expectedStatus ||
          carrier.statusVersion !== input.expectedStatusVersion || carrier.assigneeAgentId !== input.expectedAssigneeAgentId ||
          carrier.assigneeUserId !== input.expectedAssigneeUserId) throw conflict("Carrier status or ownership changed");

      const relationRows = await tx.select().from(issueRelations).where(and(eq(issueRelations.companyId, companyId),
        eq(issueRelations.relatedIssueId, carrier.id), eq(issueRelations.type, "blocks"))).for("share");
      const blockers = relationRows.length ? await tx.select().from(issues).where(and(eq(issues.companyId, companyId),
        inArray(issues.id, relationRows.map(row => row.issueId)))).orderBy(asc(issues.id)).for("share") : [];
      if (blockers.length !== input.expectedBlockers.length || !blockers.every(row => ["done", "cancelled"].includes(row.status) &&
          input.expectedBlockers.some(expected => expected.id === row.id && expected.status === row.status && expected.statusVersion === row.statusVersion))) {
        throw conflict("Carrier blockers changed");
      }

      const runner = tx as unknown as Db; // Drizzle transaction exposes the same service query surface.
      const treeControl = issueTreeControlService(runner);
      let tree = await treeControl.listTreeIssues(companyId, carrier.id);
      const lockedIds = new Set<string>();
      // Lock every discovered parent before accepting its descendant snapshot.
      // New children can commit before their parent lock, so re-read until stable.
      while (tree.some(row => !lockedIds.has(row.id))) {
        const unlockedIds = tree.filter(row => !lockedIds.has(row.id)).map(row => row.id);
        await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, unlockedIds)))
          .orderBy(asc(issues.id)).for("update");
        for (const id of unlockedIds) lockedIds.add(id);
        tree = await treeControl.listTreeIssues(companyId, carrier.id);
      }
      const treeIds = tree.map(row => row.id);
      const locks = tree.flatMap(row => [row.checkoutRunId, row.executionRunId].filter((id): id is string => Boolean(id)));
      const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]), or(
          inArray(heartbeatRuns.nativeIssueId, treeIds),
          inArray(sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`, treeIds),
          inArray(sql<string>`${heartbeatRuns.contextSnapshot} ->> 'taskId'`, treeIds),
          inArray(sql<string>`${heartbeatRuns.contextSnapshot} #>> '{paperclipIssue,id}'`, treeIds),
          ...(locks.length ? [inArray(heartbeatRuns.id, locks)] : []),
          eq(sql<string>`${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId'`, action.id),
        ),
      )).limit(1);
      const [wake] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId), inArray(agentWakeupRequests.status, ["pending", "queued", "claimed"]), or(
          inArray(sql<string>`${agentWakeupRequests.payload} ->> 'issueId'`, treeIds),
          inArray(sql<string>`${agentWakeupRequests.payload} ->> 'taskId'`, treeIds),
          inArray(sql<string>`${agentWakeupRequests.payload} #>> '{contextSnapshot,issueId}'`, treeIds),
          inArray(sql<string>`${agentWakeupRequests.payload} #>> '{contextSnapshot,paperclipIssue,id}'`, treeIds),
          eq(sql<string>`${agentWakeupRequests.payload} ->> 'recoveryActionId'`, action.id),
        ),
      )).limit(1);
      if (run || wake || tree.some(row => row.checkoutRunId || row.executionRunId || row.monitorNextCheckAt)) {
        throw conflict("Carrier has active or queued execution");
      }
      const existing = await treeControl.getActivePauseHoldGate(companyId, carrier.id);
      const binding: RecoveryCarrierParkBinding = { version: 1, ...input };
      if (existing) {
        const hold = await treeControl.getHold(companyId, existing.holdId);
        const summary = (await listRecoveryCarrierParks(runner, companyId, [carrierId])).get(carrierId);
        if (hold?.recoveryCarrierPark && summary?.state === "accepted" &&
            isDeepStrictEqual(hold.recoveryCarrierPark, binding)) return { hold, created: false };
        throw conflict("Release the existing pause before choosing a new carrier disposition");
      }
      const created = await treeControl.createHold(companyId, carrier.id, { mode: "pause", reason: input.reason,
        releasePolicy: { strategy: "manual" }, actor: { actorType: "user", actorId: actor.actorId, userId: actor.actorId } });
      await tx.update(issueTreeHolds).set({ recoveryCarrierPark: binding }).where(eq(issueTreeHolds.id, created.hold.id));
      await logActivityInTransaction(runner, { ...actor, companyId, action: "issue.recovery_carrier_parked", entityType: "issue", entityId: carrier.id,
        details: { holdId: created.hold.id, sourceIssueId: source.id, recoveryActionId: action.id, decisionInteractionId: decision.id,
          reason: input.reason, historicalBlockers: blockers.map(row => ({ id: row.id, status: row.status, statusVersion: row.statusVersion })) } }, publications);
      return { hold: { ...created.hold, recoveryCarrierPark: binding }, created: true };
    });
    publications.forEach(publishActivity);
    return result;
  }

  async function release(companyId: string, carrierId: string, holdId: string, input: ReleaseRecoveryCarrierPark, actor: BoardParkActor) {
    if (actor.actorType !== "user") throw forbidden("Only the board can release a recovery carrier park");
    const publications: ActivityPublication[] = [];
    const result = await db.transaction(async tx => {
      const [carrier] = await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, carrierId))).for("update");
      if (!carrier) throw notFound("Recovery carrier not found");
      const [hold] = await tx.select().from(issueTreeHolds).where(and(eq(issueTreeHolds.companyId, companyId), eq(issueTreeHolds.id, holdId))).for("update");
      if (!hold || hold.rootIssueId !== carrierId || !hold.recoveryCarrierPark) throw notFound("Recovery carrier park not found");
      if (hold.recoveryCarrierPark.recoveryActionId !== input.recoveryActionId) throw conflict("Recovery carrier park identity changed");
      if (hold.status === "released") return hold;
      const [released] = await tx.update(issueTreeHolds).set({ status: "released", releasedAt: new Date(), releasedByActorType: "user",
        releasedByUserId: actor.actorId, releaseReason: input.reason, updatedAt: new Date() }).where(eq(issueTreeHolds.id, hold.id)).returning();
      const runner = tx as unknown as Db; // Same query surface; transaction is retained for audit.
      await logActivityInTransaction(runner, { ...actor, companyId, action: "issue.recovery_carrier_park_released", entityType: "issue", entityId: carrierId,
        details: { holdId, recoveryActionId: input.recoveryActionId, reason: input.reason, sourceActionUnchanged: true } }, publications);
      return released;
    });
    publications.forEach(publishActivity);
    return result;
  }
  return { candidate, park, release };
}
