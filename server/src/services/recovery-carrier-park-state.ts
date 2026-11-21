import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { issueRecoveryActions, issueRelations, issues, issueThreadInteractions, issueTreeHolds, type Db } from "@paperclipai/db";
import type { RecoveryCarrierParkSummary } from "@paperclipai/shared";

/** Used in write predicates too: an accepted hold never grants action mutation. */
export function recoveryActionNotBoardParked(companyId: string, actionId: string | SQL) {
  return sql`not exists (select 1 from ${issueTreeHolds}
    where ${issueTreeHolds.companyId} = ${companyId} and ${issueTreeHolds.status} = 'active'
      and ${issueTreeHolds.mode} = 'pause' and ${issueTreeHolds.recoveryCarrierPark} is not null
      and ${issueTreeHolds.recoveryCarrierPark} ->> 'recoveryActionId' = (${actionId})::text)`;
}

export async function isRecoveryActionBoardParked(db: Db, companyId: string, actionId: string) {
  const [row] = await db.select({ id: issueTreeHolds.id }).from(issueTreeHolds).where(and(
    eq(issueTreeHolds.companyId, companyId), eq(issueTreeHolds.status, "active"), eq(issueTreeHolds.mode, "pause"),
    isNotNull(issueTreeHolds.recoveryCarrierPark),
    sql`${issueTreeHolds.recoveryCarrierPark} ->> 'recoveryActionId' = ${actionId}`,
  )).limit(1);
  return Boolean(row);
}


export async function hasBoardParkedRecoveryAction(db: Db, companyId: string, sourceIssueId: string) {
  const [action] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
    sql`not (${recoveryActionNotBoardParked(companyId, sql`${issueRecoveryActions.id}`)})`,
  )).limit(1);
  return Boolean(action);
}
/** Staleness removes consent from presentation, never the persisted safety hold. */
export async function listRecoveryCarrierParks(db: Db, companyId: string, carrierIds: string[]) {
  const result = new Map<string, RecoveryCarrierParkSummary>();
  if (!carrierIds.length) return result;
  const holds = await db.select().from(issueTreeHolds).where(and(
    eq(issueTreeHolds.companyId, companyId), inArray(issueTreeHolds.rootIssueId, carrierIds),
    eq(issueTreeHolds.status, "active"), eq(issueTreeHolds.mode, "pause"), isNotNull(issueTreeHolds.recoveryCarrierPark),
  ));
  if (!holds.length) return result;
  const bindings = holds.flatMap(hold => hold.recoveryCarrierPark ? [hold.recoveryCarrierPark] : []);
  const [carriers, actions, decisions, blockers] = await Promise.all([
    db.select().from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, carrierIds))),
    db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId), inArray(issueRecoveryActions.id, bindings.map(b => b.recoveryActionId)))),
    db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, companyId), inArray(issueThreadInteractions.id, bindings.map(b => b.decisionInteractionId)))),
    db.select({ carrierId: issueRelations.relatedIssueId, id: issues.id, status: issues.status, statusVersion: issues.statusVersion })
      .from(issueRelations).innerJoin(issues, and(eq(issues.id, issueRelations.issueId), eq(issues.companyId, companyId)))
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks"), inArray(issueRelations.relatedIssueId, carrierIds))),
  ]);
  const carrierMap = new Map(carriers.map(row => [row.id, row]));
  const actionMap = new Map(actions.map(row => [row.id, row]));
  const decisionMap = new Map(decisions.map(row => [row.id, row]));
  for (const hold of holds) {
    const b = hold.recoveryCarrierPark!;
    const carrier = carrierMap.get(hold.rootIssueId), action = actionMap.get(b.recoveryActionId), decision = decisionMap.get(b.decisionInteractionId);
    const currentBlockers = blockers.filter(row => row.carrierId === hold.rootIssueId);
    const accepted = b.version === 1 && hold.releasePolicy?.strategy === "manual" && carrier && !carrier.hiddenAt &&
      carrier.status === b.expectedStatus && carrier.statusVersion === b.expectedStatusVersion &&
      carrier.assigneeAgentId === b.expectedAssigneeAgentId && carrier.assigneeUserId === b.expectedAssigneeUserId &&
      action?.sourceIssueId === b.sourceIssueId && action.recoveryIssueId === carrier.id &&
      action.status === "escalated" && action.outcome === "exhausted" && action.ownerType === "board" && !action.ownerAgentId &&
      !action.wakePolicy && !action.monitorPolicy && !action.resolvedAt && action.updatedAt.toISOString() === b.expectedActionUpdatedAt &&
      decision?.issueId === carrier.id && decision.kind === "request_confirmation" && decision.status === "rejected" &&
      Boolean(decision.resolvedByUserId) && !decision.resolvedByAgentId && Boolean(decision.resolvedAt) &&
      decision.updatedAt.toISOString() === b.expectedDecisionUpdatedAt &&
      currentBlockers.length === b.expectedBlockers.length && currentBlockers.every(row => b.expectedBlockers.some(expected =>
        row.id === expected.id && row.status === expected.status && row.statusVersion === expected.statusVersion));
    result.set(hold.rootIssueId, { state: accepted ? "accepted" : "stale", holdId: hold.id,
      sourceIssueId: b.sourceIssueId, recoveryActionId: b.recoveryActionId, decisionInteractionId: b.decisionInteractionId, reason: b.reason });
  }
  return result;
}
