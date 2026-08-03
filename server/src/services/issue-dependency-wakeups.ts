import { and, eq, gte, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";

export const ISSUE_BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved";

export const IN_FLIGHT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
] as const;

const IDEMPOTENT_DEPENDENCY_WAKE_STATUSES = [
  ...IN_FLIGHT_DEPENDENCY_WAKE_STATUSES,
  "completed",
] as const;

export function buildIssueBlockersResolvedWakeIdempotencyKey(input: {
  dependentIssueId: string;
  resolvedBlockerIssueId: string;
}) {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    input.dependentIssueId,
    input.resolvedBlockerIssueId,
  ].join(":");
}

export async function findExistingIssueBlockersResolvedWake(
  db: Db,
  input: {
    companyId: string;
    idempotencyKey: string;
  },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, [...IDEMPOTENT_DEPENDENCY_WAKE_STATUSES]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/**
 * The single dependency-unblock wake contract. Every route that can resolve a
 * blocker — PATCH /issues/:id, the comment decision path, and recovery-action
 * resolution — builds its wake here so the reason, payload, context snapshot and
 * idempotency key stay byte-identical no matter which path closed the blocker.
 *
 * Kept structurally typed (no heartbeat import) because heartbeat.ts already
 * imports this module.
 */
export type IssueBlockersResolvedWakeup = {
  source: "automation";
  triggerDetail: "system";
  reason: typeof ISSUE_BLOCKERS_RESOLVED_WAKE_REASON;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  requestedByActorType: "user" | "agent" | "system";
  requestedByActorId: string | null;
  contextSnapshot: Record<string, unknown>;
};

export function buildIssueBlockersResolvedWakeup(input: {
  dependentIssueId: string;
  resolvedBlockerIssueId: string;
  blockerIssueIds: string[];
  /** Provenance recorded on the wake context, e.g. `issue.blockers_resolved`. */
  source: string;
  /** Which mutation resolved the blocker, e.g. `blocker_done` or `comment`. */
  mutation: string;
  requestedByActorType: "user" | "agent" | "system";
  requestedByActorId: string | null;
}): { idempotencyKey: string; wakeup: IssueBlockersResolvedWakeup } {
  const idempotencyKey = buildIssueBlockersResolvedWakeIdempotencyKey({
    dependentIssueId: input.dependentIssueId,
    resolvedBlockerIssueId: input.resolvedBlockerIssueId,
  });
  return {
    idempotencyKey,
    wakeup: {
      source: "automation",
      triggerDetail: "system",
      reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
      payload: {
        issueId: input.dependentIssueId,
        resolvedBlockerIssueId: input.resolvedBlockerIssueId,
        blockerIssueIds: input.blockerIssueIds,
        mutation: input.mutation,
      },
      idempotencyKey,
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId,
      contextSnapshot: {
        issueId: input.dependentIssueId,
        taskId: input.dependentIssueId,
        wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
        source: input.source,
        resolvedBlockerIssueId: input.resolvedBlockerIssueId,
        blockerIssueIds: input.blockerIssueIds,
      },
    },
  };
}

/**
 * Companion audit record for a wake emitted through the contract above. Callers
 * pass the result straight to `logActivity` so every path emits the same
 * `issue.blockers_resolved_wake_emitted` entry after the enqueue resolves.
 */
export function buildIssueBlockersResolvedWakeEmittedActivity(input: {
  companyId: string;
  /** Which route emitted it, e.g. `issue_update` / `issue_comment`. */
  emittedBy: string;
  agentId: string;
  runId: string | null;
  agentApiKeyId: string | null;
  wakeup: {
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
    contextSnapshot?: Record<string, unknown>;
  };
  wakeupRunId: string | null;
  /** Used when the wake payload carries no dependent issue id. */
  fallbackDependentIssueId: string;
  defaultSource: string;
}) {
  const payload = input.wakeup.payload && typeof input.wakeup.payload === "object" ? input.wakeup.payload : {};
  const dependentIssueId =
    typeof payload.issueId === "string" ? payload.issueId : input.fallbackDependentIssueId;
  return {
    companyId: input.companyId,
    actorType: "system" as const,
    actorId: input.emittedBy,
    agentId: input.agentId,
    runId: input.runId,
    agentApiKeyId: input.agentApiKeyId,
    action: "issue.blockers_resolved_wake_emitted",
    entityType: "issue" as const,
    entityId: dependentIssueId,
    details: {
      source: input.wakeup.contextSnapshot?.source ?? input.defaultSource,
      wakeupRunId: input.wakeupRunId,
      idempotencyKey: input.wakeup.idempotencyKey ?? null,
      resolvedBlockerIssueId:
        typeof payload.resolvedBlockerIssueId === "string" ? payload.resolvedBlockerIssueId : null,
      blockerIssueIds: Array.isArray(payload.blockerIssueIds) ? payload.blockerIssueIds : [],
    },
  };
}

export async function findExistingIssueBlockersResolvedWakeForAnyKey(
  db: Db,
  input: {
    companyId: string;
    idempotencyKeys: string[];
    completedRearmCutoff?: Date | null;
  },
) {
  const idempotencyKeys = [...new Set(input.idempotencyKeys.filter(Boolean))];
  if (idempotencyKeys.length === 0) return null;

  const inFlightStatuses = [...IN_FLIGHT_DEPENDENCY_WAKE_STATUSES];
  const statusFilter = input.completedRearmCutoff
    ? or(
        inArray(agentWakeupRequests.status, inFlightStatuses),
        and(
          eq(agentWakeupRequests.status, "completed"),
          gte(agentWakeupRequests.updatedAt, input.completedRearmCutoff),
        ),
      )
    : inArray(agentWakeupRequests.status, [...IDEMPOTENT_DEPENDENCY_WAKE_STATUSES]);

  return db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        inArray(agentWakeupRequests.idempotencyKey, idempotencyKeys),
        statusFilter,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}
