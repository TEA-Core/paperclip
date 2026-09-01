import { and, eq, gte, inArray, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";

export const ISSUE_BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved";

// A wake counts as "already delivered or in flight for the current ready state"
// for these statuses. The level-triggered state key uses this full set so that
// one wake for a ready state suppresses further wakes for the SAME state. This
// bounds reconciliation: after one wake, later passes find the completed row.
const IDEMPOTENT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "completed",
] as const;

// A wake counts as "still in flight" for these statuses. The `completed` status
// is not in this set on purpose. Dependency readiness is level-triggered, so a
// historical completed per-edge wake must never suppress a new wake for the
// current ready state. The dedup uses this set only for the legacy per-edge key
// and for old no-cycle state keys that are still queued after a deploy.
const IN_FLIGHT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
] as const;

const IDEMPOTENT_DEPENDENCY_WAKE_STATUS_SET = new Set<string>(IDEMPOTENT_DEPENDENCY_WAKE_STATUSES);
const IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET = new Set<string>(IN_FLIGHT_DEPENDENCY_WAKE_STATUSES);

export type IssueBlockersResolvedWakeCycleInput = Date | string | null | undefined;

export type IssueBlockersResolvedReadyStateInput = {
  dependentIssueId: string;
  blockerIssueIds: string[];
  blockedTransitionAt?: IssueBlockersResolvedWakeCycleInput;
};

/**
 * Canonical blocked-cycle stamp for the dependency-ready state key.
 * `blockedTransitionAt` is UTC ISO-8601, or `none` when the dependent has no
 * recorded transition into `blocked`.
 */
export function formatIssueBlockersResolvedWakeCycle(
  blockedTransitionAt: IssueBlockersResolvedWakeCycleInput,
): string {
  if (blockedTransitionAt == null || blockedTransitionAt === "") return "none";
  const parsed = blockedTransitionAt instanceof Date
    ? blockedTransitionAt
    : new Date(blockedTransitionAt);
  if (Number.isNaN(parsed.getTime())) return "none";
  return parsed.toISOString();
}

function uniqueSortedBlockerIssueIds(blockerIssueIds: string[]): string[] {
  return [...new Set(blockerIssueIds.filter(Boolean))].sort();
}

function hashBlockerReadyStateDigest(sortedBlockerIssueIds: string[], cycle: string | null): string {
  const payload = cycle == null
    ? sortedBlockerIssueIds.join(",")
    : `${sortedBlockerIssueIds.join(",")}\n${cycle}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function buildStateKey(dependentIssueId: string, digest: string, blockerCount: number): string {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    "state",
    dependentIssueId,
    String(blockerCount),
    digest,
  ].join(":");
}

/**
 * Legacy per-edge idempotency key. One key encodes a single resolved blocker
 * edge `issue_blockers_resolved:{dependentIssueId}:{resolvedBlockerIssueId}`.
 * The dedup keeps this format only to read wake rows written before the
 * level-triggered state key existed.
 */
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

/**
 * Pre-cycle level-triggered key. Rows written before the ready state included
 * `blockedTransitionAt` hashed only the sorted blocker ids. Lookup still reads
 * this format so an in-flight deploy-overlap wake can suppress a duplicate.
 */
export function buildIssueBlockersResolvedWakeStateKeyWithoutCycle(input: {
  dependentIssueId: string;
  blockerIssueIds: string[];
}) {
  const sortedBlockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  return buildStateKey(
    input.dependentIssueId,
    hashBlockerReadyStateDigest(sortedBlockerIssueIds, null),
    sortedBlockerIssueIds.length,
  );
}

/**
 * Level-triggered idempotency key. One key encodes the full set of blockers that
 * defines the current dependency-ready state plus the dependent's current
 * blocked cycle (`blockedTransitionAt`, or `none`). Two wakes for the same ready
 * state share the key. A wake from an earlier blocked cycle has a different
 * cycle stamp, so it produces a different key and never suppresses the current
 * wake. All three emit paths (route-time, finalize-time, periodic backstop) use
 * this key so they share one idempotency rule.
 */
export function buildIssueBlockersResolvedWakeStateKey(input: IssueBlockersResolvedReadyStateInput) {
  const sortedBlockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  const cycle = formatIssueBlockersResolvedWakeCycle(input.blockedTransitionAt);
  return buildStateKey(
    input.dependentIssueId,
    hashBlockerReadyStateDigest(sortedBlockerIssueIds, cycle),
    sortedBlockerIssueIds.length,
  );
}

function parseWakeCycleDate(blockedTransitionAt: IssueBlockersResolvedWakeCycleInput): Date | null {
  if (blockedTransitionAt == null || blockedTransitionAt === "") return null;
  const parsed = blockedTransitionAt instanceof Date
    ? blockedTransitionAt
    : new Date(blockedTransitionAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function wakeCoversIssueBlockersResolvedReadyState(
  wake: {
    status: string;
    idempotencyKey: string | null;
    requestedAt: Date;
    updatedAt: Date;
  },
  keys: {
    cycleKey: string;
    oldStateKey: string;
    legacyKeys: Set<string>;
    blockedTransitionAt: Date | null;
    completedRearmCutoff: Date | null;
  },
): boolean {
  const idempotencyKey = wake.idempotencyKey;
  if (!idempotencyKey) return false;

  if (idempotencyKey === keys.cycleKey) {
    if (IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status)) return true;
    if (!IDEMPOTENT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status)) return false;
    // Fork re-arm window: a wake that COMPLETED and left the dependent dead is
    // allowed to re-arm once it ages past the cutoff, which is what feeds the
    // re-arm cap and the blocked_without_blockers escalation. Without this a
    // completed cycle-key wake would suppress forever and the cap would never
    // fire. No cutoff configured keeps upstream's plain idempotent behaviour.
    if (!keys.completedRearmCutoff) return true;
    return wake.updatedAt.getTime() >= keys.completedRearmCutoff.getTime();
  }

  if (idempotencyKey === keys.oldStateKey) {
    if (IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status)) return true;
    if (wake.status !== "completed") return false;
    if (!keys.blockedTransitionAt) return true;
    return wake.requestedAt.getTime() >= keys.blockedTransitionAt.getTime();
  }

  if (keys.legacyKeys.has(idempotencyKey)) {
    return IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status);
  }

  return false;
}

/**
 * Find a wake that already covers the current dependency-ready state of the
 * dependent issue. The check is level-triggered and cycle-aware:
 *
 * - The cycle-aware state key matches a wake in any idempotent status
 *   (including `completed`). This suppresses a duplicate for the SAME ready
 *   state, including the current blocked cycle.
 * - The old no-cycle state key matches in-flight statuses (deploy overlap),
 *   or a `completed` wake whose `requestedAt` is at or after the current
 *   `blockedTransitionAt` (same cycle). A completed old-key wake from a
 *   previous cycle does not suppress.
 * - Each legacy per-edge key matches only a wake that is still in flight.
 * - `completedRearmCutoff` (fork) lets a COMPLETED cycle-key wake stop
 *   suppressing once it ages past the cutoff, so the re-arm cap and the
 *   blocked_without_blockers escalation still have something to count.
 *
 * Returns the first matching wake or `null`.
 */
export async function findExistingIssueBlockersResolvedWakeForReadyState(
  db: Db,
  input: {
    companyId: string;
    dependentIssueId: string;
    blockerIssueIds: string[];
    blockedTransitionAt?: IssueBlockersResolvedWakeCycleInput;
    completedRearmCutoff?: Date | null;
  },
) {
  const cycleKey = buildIssueBlockersResolvedWakeStateKey(input);
  const oldStateKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle(input);
  const legacyKeyList = [
    ...new Set(
      input.blockerIssueIds
        .filter(Boolean)
        .map((resolvedBlockerIssueId) =>
          buildIssueBlockersResolvedWakeIdempotencyKey({
            dependentIssueId: input.dependentIssueId,
            resolvedBlockerIssueId,
          }),
        ),
    ),
  ];
  const lookupKeys = [...new Set([cycleKey, oldStateKey, ...legacyKeyList])];
  const blockedTransitionAt = parseWakeCycleDate(input.blockedTransitionAt);

  const rows = await db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      requestedAt: agentWakeupRequests.requestedAt,
      updatedAt: agentWakeupRequests.updatedAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        inArray(agentWakeupRequests.idempotencyKey, lookupKeys),
      ),
    );

  const covering = rows.find((row) =>
    wakeCoversIssueBlockersResolvedReadyState(row, {
      cycleKey,
      oldStateKey,
      legacyKeys: new Set(legacyKeyList),
      blockedTransitionAt,
      completedRearmCutoff: input.completedRearmCutoff ?? null,
    }),
  );
  return covering ?? null;
}

/**
 * Zero-blocker heal wakes have no resolved blocker to key on, so they get
 * their own key leaf in the same namespace. The key is per-issue and
 * permanent: once the heal wake row exists in an idempotent status the
 * backstop never re-wakes that issue on a later sweep pass.
 */
export function buildIssueZeroBlockerHealWakeIdempotencyKey(input: {
  dependentIssueId: string;
}) {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    input.dependentIssueId,
    "zero_blocker",
  ].join(":");
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
