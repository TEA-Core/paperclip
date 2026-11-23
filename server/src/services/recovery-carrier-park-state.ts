import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { issueRecoveryActions, issueRelations, issues, issueThreadInteractions, issueTreeHolds, type Db } from "@paperclipai/db";
import type { RecoveryCarrierParkSummary } from "@paperclipai/shared";
import { alias } from "drizzle-orm/pg-core";

type RecoveryCarrierParkBlocker = Pick<typeof issues.$inferSelect,
  "id" | "companyId" | "parentId" | "identifier" | "title" | "status" | "statusVersion" |
  "executionRunId" | "assigneeAgentId" | "assigneeUserId">;
const parkCarrier = alias(issues, "recovery_park_carrier");

export const RECOVERY_CARRIER_PARK_WAKE_SUPPRESSED = "Board-parked recovery carrier: native wake suppressed without replay";

/** Compare UUID spellings without casting untrusted JSON. Malformed aliases fail closed. */
export function recoveryActionIdentityMatches(saved: SQL, actionId: string | SQL) {
  return sql`translate(lower(${saved}), '{}-', '') = translate(lower((${actionId})::text), '{}-', '')`;
}

/** The gate applies only while the acceptance is active; board release lifts it. */
export function recoveryActionNotBoardParked(companyId: string | SQL, actionId: string | SQL) {
  return sql`not exists (select 1 from ${issueTreeHolds}
    where ${issueTreeHolds.companyId} = ${companyId} and ${issueTreeHolds.status} = 'active'
      and ${issueTreeHolds.mode} = 'pause' and ${issueTreeHolds.recoveryCarrierPark} is not null
      and ${recoveryActionIdentityMatches(sql`${issueTreeHolds.recoveryCarrierPark} ->> 'recoveryActionId'`, actionId)})`;
}

export async function isRecoveryActionBoardParked(db: Db, companyId: string, actionId: string) {
  const [row] = await db.select({ id: issueTreeHolds.id }).from(issueTreeHolds).where(and(
    eq(issueTreeHolds.companyId, companyId), eq(issueTreeHolds.status, "active"), eq(issueTreeHolds.mode, "pause"),
    isNotNull(issueTreeHolds.recoveryCarrierPark),
    recoveryActionIdentityMatches(sql`${issueTreeHolds.recoveryCarrierPark} ->> 'recoveryActionId'`, actionId),
  )).limit(1);
  return Boolean(row);
}


/** Consent and its direct blocker facts share one statement, including caller-owned transactions. */
export async function readRecoveryCarrierParkSnapshot(db: Db, companyId: string, carrierIds: string[]) {
  const parks = new Map<string, RecoveryCarrierParkSummary>();
  const blockers = new Map<string, RecoveryCarrierParkBlocker[]>();
  if (!carrierIds.length) return { parks, blockers };
  const rows = await db.select({
    carrier: { id: parkCarrier.id, hiddenAt: parkCarrier.hiddenAt, status: parkCarrier.status,
      statusVersion: parkCarrier.statusVersion, assigneeAgentId: parkCarrier.assigneeAgentId, assigneeUserId: parkCarrier.assigneeUserId },
    hold: { id: issueTreeHolds.id, releasePolicy: issueTreeHolds.releasePolicy, recoveryCarrierPark: issueTreeHolds.recoveryCarrierPark },
    action: { sourceIssueId: issueRecoveryActions.sourceIssueId, recoveryIssueId: issueRecoveryActions.recoveryIssueId,
      status: issueRecoveryActions.status, outcome: issueRecoveryActions.outcome, ownerType: issueRecoveryActions.ownerType,
      ownerAgentId: issueRecoveryActions.ownerAgentId, wakePolicy: issueRecoveryActions.wakePolicy,
      monitorPolicy: issueRecoveryActions.monitorPolicy, resolvedAt: issueRecoveryActions.resolvedAt, updatedAt: issueRecoveryActions.updatedAt },
    decision: { issueId: issueThreadInteractions.issueId, kind: issueThreadInteractions.kind, status: issueThreadInteractions.status,
      resolvedByUserId: issueThreadInteractions.resolvedByUserId, resolvedByAgentId: issueThreadInteractions.resolvedByAgentId,
      resolvedAt: issueThreadInteractions.resolvedAt, updatedAt: issueThreadInteractions.updatedAt },
    blockers: sql<RecoveryCarrierParkBlocker[]>`case when ${parkCarrier.status} = 'blocked' or ${issueTreeHolds.id} is not null then
      coalesce((select jsonb_agg(jsonb_build_object(
        'id', ${issues.id}, 'companyId', ${issues.companyId}, 'parentId', ${issues.parentId},
        'identifier', ${issues.identifier}, 'title', ${issues.title}, 'status', ${issues.status},
        'statusVersion', ${issues.statusVersion}, 'executionRunId', ${issues.executionRunId},
        'assigneeAgentId', ${issues.assigneeAgentId}, 'assigneeUserId', ${issues.assigneeUserId}))
        from ${issueRelations} inner join ${issues} on ${issues.id} = ${issueRelations.issueId}
        where ${issueRelations.companyId} = ${companyId} and ${issues.companyId} = ${companyId}
          and ${issueRelations.relatedIssueId} = ${parkCarrier.id} and ${issueRelations.type} = 'blocks'), '[]'::jsonb)
      else '[]'::jsonb end`,
  }).from(parkCarrier).leftJoin(issueTreeHolds, and(
    eq(issueTreeHolds.companyId, companyId), eq(issueTreeHolds.rootIssueId, parkCarrier.id),
    eq(issueTreeHolds.status, "active"), eq(issueTreeHolds.mode, "pause"), isNotNull(issueTreeHolds.recoveryCarrierPark),
  )).leftJoin(issueRecoveryActions, and(eq(issueRecoveryActions.companyId, companyId),
    sql`lower(${issueTreeHolds.recoveryCarrierPark} ->> 'recoveryActionId') = ${issueRecoveryActions.id}::text`,
  )).leftJoin(issueThreadInteractions, and(eq(issueThreadInteractions.companyId, companyId),
    sql`lower(${issueTreeHolds.recoveryCarrierPark} ->> 'decisionInteractionId') = ${issueThreadInteractions.id}::text`,
  )).where(and(eq(parkCarrier.companyId, companyId), inArray(parkCarrier.id, carrierIds)));
  for (const { carrier, hold, action, decision, blockers: currentBlockers } of rows) {
    blockers.set(carrier.id, currentBlockers);
    const b = hold?.recoveryCarrierPark;
    if (!hold || !b) continue;
    const accepted = b.version === 1 && hold.releasePolicy?.strategy === "manual" && !carrier.hiddenAt &&
      carrier.status === b.expectedStatus && carrier.statusVersion === b.expectedStatusVersion &&
      carrier.assigneeAgentId === b.expectedAssigneeAgentId && carrier.assigneeUserId === b.expectedAssigneeUserId &&
      action?.sourceIssueId === b.sourceIssueId.toLowerCase() && action.recoveryIssueId === carrier.id &&
      action.status === "escalated" && action.outcome === "exhausted" && action.ownerType === "board" && !action.ownerAgentId &&
      !action.wakePolicy && !action.monitorPolicy && !action.resolvedAt && action.updatedAt.toISOString() === b.expectedActionUpdatedAt &&
      decision?.issueId === carrier.id && decision.kind === "request_confirmation" && decision.status === "rejected" &&
      Boolean(decision.resolvedByUserId) && !decision.resolvedByAgentId && Boolean(decision.resolvedAt) &&
      decision.updatedAt.toISOString() === b.expectedDecisionUpdatedAt &&
      currentBlockers.length === b.expectedBlockers.length && currentBlockers.every(row => b.expectedBlockers.some(expected =>
        row.id === expected.id.toLowerCase() && row.status === expected.status && row.statusVersion === expected.statusVersion));
    parks.set(carrier.id, { state: accepted ? "accepted" : "stale", holdId: hold.id,
      sourceIssueId: b.sourceIssueId, recoveryActionId: b.recoveryActionId, decisionInteractionId: b.decisionInteractionId, reason: b.reason });
  }
  return { parks, blockers };
}
