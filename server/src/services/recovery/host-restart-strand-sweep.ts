import { and, desc, eq, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type {
  IssueExecutionMonitorPolicy,
  IssueExecutionPolicy,
  IssueMonitorScheduledBy,
} from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";
import { applyIssueMonitorPolicyTransition, parseIssueExecutionState } from "../issue-execution-policy.js";
import { readHostRestartMarker, resolveHostBootId } from "../host-boot-identity.js";
import { blockIssueWithUnresolvedBlockers } from "./service.js";
import {
  buildImmediateExecutionPathRecoveryNoticeSeed,
  buildStrandedRecoveryEscalationNotice,
} from "./stranded-notice.js";

// Post-host-restart strand sweep (B2). After a host restart, B1's
// `reapOrphanedRuns` reaps any in-flight run and stamps `resultJson.hostRestart`
// on the one that carried the card. A card that was mid-run at the moment of the
// restart can be left with `monitorNextCheckAt: null` and no live run — i.e. no
// §2a live-continuation path and no wake scheduled, so it sits stranded. This
// sweep runs once at startup, right after the reap, and repairs those cards.
//
// Two repair shapes, picked per card:
//   - re-arm: the card's monitor policy is still live (not exhausted) → restore
//     the scheduled monitor (policy + state + flat columns) and point
//     `monitorNextCheckAt` back at "now" so the existing `tickDueIssueMonitors`
//     scheduler dispatches it.
//   - escalate: the monitor is exhausted, was never armed, or the card is not
//     monitorable → mirror `reconcileStrandedAssignedIssues` by blocking the card
//     and posting a host-restart-flavored stranded-notice.
//
// Never touch a card that still has a live run, or whose most recent run was not
// a failed run carrying a host-restart marker stamped for the currently detected
// boot.
//
// Idempotency is DURABLE and per-card, never an in-memory per-boot flag: a
// repaired card leaves the candidate set in persisted state — a re-arm writes
// `monitorNextCheckAt`, an escalation posts a system notice keyed to the source
// run — so a second invocation (a double startup path, a hot reconcile, a manual
// re-run) finds nothing left to repair. That survives a process restart, which an
// in-memory flag cannot. Each repair write is additionally guarded in SQL, so two
// overlapping invocations cannot double-apply: the re-arm is one conditional
// UPDATE and the escalation takes a row lock before it writes.

const MONITORABLE_STATUSES = ["in_progress", "in_review", "blocked"] as const;
const DEFAULT_SWEEP_REPAIR_CAP = 50;
const MAX_CANDIDATES_INSPECTED = 500;
const SWEEP_SOURCE = "host-restart-strand-sweep";

export interface HostRestartStrandCandidate {
  id: string;
  companyId: string;
  identifier: string | null;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionPolicy: unknown;
  executionState: unknown;
  monitorAttemptCount: number | null;
  monitorNextCheckAt: Date | null;
  monitorWakeRequestedAt: Date | null;
  monitorLastTriggeredAt: Date | null;
  monitorNotes: string | null;
  monitorScheduledBy: string | null;
}

// The candidate fields the re-arm patch needs. Kept as a Pick so tests can pass
// a full candidate and the builder stays decoupled from the collection columns.
export type HostRestartStrandRearmSource = Pick<
  HostRestartStrandCandidate,
  | "status"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "executionPolicy"
  | "executionState"
  | "monitorAttemptCount"
  | "monitorLastTriggeredAt"
  | "monitorNotes"
  | "monitorScheduledBy"
>;

export interface HostRestartStrandSourceRun {
  id: string;
  agentId: string | null;
  status: string;
  errorCode: string | null;
}

export interface HostRestartStrandLatestRun extends HostRestartStrandSourceRun {
  resultJson: Record<string, unknown> | null;
}

export interface HostRestartStrandFacts {
  hasLiveRun: boolean;
  latestRun: HostRestartStrandLatestRun | null;
  alreadyEscalated: boolean;
}

export type HostRestartStrandDecision =
  | { action: "skip-live" }
  | { action: "skip-no-marker" }
  | { action: "skip-already-escalated" }
  | { action: "rearm" }
  | { action: "escalate"; reason: "exhausted" | "never-armed" | "not-monitorable" };

export interface HostRestartStrandRearmPatch {
  executionPolicy: Record<string, unknown>;
  executionState: Record<string, unknown>;
  monitorNextCheckAt: Date;
  monitorWakeRequestedAt: null;
  monitorNotes: string | null;
  monitorScheduledBy: string | null;
}

// A card is eligible for monitor re-arm only if it mirrors `issueAllowsMonitor`
// in issue-execution-policy.ts: an agent-assigned card (no user assignee) in one
// of the monitorable statuses. Kept local so the sweep has no dependency on the
// policy module's private predicate.
export function isMonitorableIssueShape(shape: {
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}): boolean {
  return (
    Boolean(shape.assigneeAgentId) &&
    !shape.assigneeUserId &&
    (MONITORABLE_STATUSES as readonly string[]).includes(shape.status)
  );
}

// Re-implements `exhaustedMonitorClearReason`'s bounds check against the live
// persisted monitor state. A monitor with no bounds is never "exhausted".
export function isMonitorExhausted(
  monitorState: { maxAttempts?: number | null; timeoutAt?: string | null } | null,
  attemptCount: number | null,
  now: Date,
): boolean {
  if (!monitorState) return false;
  if (typeof monitorState.timeoutAt === "string") {
    const timeoutAt = new Date(monitorState.timeoutAt).getTime();
    if (!Number.isNaN(timeoutAt) && now.getTime() >= timeoutAt) return true;
  }
  if (
    typeof monitorState.maxAttempts === "number" &&
    typeof attemptCount === "number" &&
    attemptCount >= monitorState.maxAttempts
  ) {
    return true;
  }
  return false;
}

// The per-card repair decision. Pure: no db, no clock reads (uses `now`), no host
// reads (uses the injected `detectedBootId`).
export function decideHostRestartStrandRepair(input: {
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionState: unknown;
  monitorAttemptCount: number | null;
  hasLiveRun: boolean;
  alreadyEscalated: boolean;
  latestRun: HostRestartStrandLatestRun | null;
  now: Date;
  detectedBootId?: string | null;
}): HostRestartStrandDecision {
  if (input.hasLiveRun) return { action: "skip-live" };

  const run = input.latestRun;
  // Only a failed run stamped with a host-restart marker (by B1's reap) proves
  // this card was torn down by a host restart. Anything else is out of scope.
  const marker = run ? readHostRestartMarker(run.resultJson) : null;
  if (!run || run.status !== "failed" || !marker) {
    return { action: "skip-no-marker" };
  }
  // Fail-safe: without a detected boot id we cannot attribute any marker to
  // the current boot, so skip before comparing boots (no candidate is eligible
  // on an undetectable boot). When a boot id IS detected, a marker stamped for
  // a different (older) boot is stale — the reap for this boot would have
  // re-stamped it.
  if (!input.detectedBootId || marker.currentBootId !== input.detectedBootId) {
    return { action: "skip-no-marker" };
  }

  // Idempotency guard: an already-posted system notice for this run means a
  // prior pass (this sweep on an earlier boot, or the recovery sweep) already
  // handled the card. Never double-post.
  if (input.alreadyEscalated) return { action: "skip-already-escalated" };

  const monitorable = isMonitorableIssueShape({
    status: input.status,
    assigneeAgentId: input.assigneeAgentId,
    assigneeUserId: input.assigneeUserId,
  });
  const monitorState = parseIssueExecutionState(input.executionState)?.monitor ?? null;
  // Only a "triggered" monitor (the shape left by a fired monitor) carries the
  // bounds/metadata needed to reconstruct a scheduled re-arm. A "cleared" or
  // absent monitor cannot be re-armed.
  const armed = monitorState?.status === "triggered";

  if (monitorable && armed && !isMonitorExhausted(monitorState, input.monitorAttemptCount, input.now)) {
    return { action: "rearm" };
  }

  const reason = !monitorable ? "not-monitorable" : !armed ? "never-armed" : "exhausted";
  return { action: "escalate", reason };
}

// The re-arm patch. Reconstructs the `executionPolicy.monitor` stripped by the
// fire path (`buildIssueMonitorTriggeredPatch`, issue-execution-policy.ts), then
// delegates the scheduled-state + flat-column write to the canonical
// `applyIssueMonitorPolicyTransition` re-arm branch — so the persisted monitor
// state, its bounds/metadata, and the flat columns stay in lockstep with the
// policy module instead of a hand-rolled shape that can drift. The transition
// preserves the card's existing execution state (stages/review) via
// `executionStateWithMonitor`. Returns null when the persisted monitor is not a
// fired ("triggered") monitor — there is nothing to reconstruct from — or when
// the policy module rejects the transition; the caller then skips the card.
export function buildRearmMonitorPatch(input: {
  now: Date;
  candidate: HostRestartStrandRearmSource;
}): HostRestartStrandRearmPatch | null {
  const { candidate } = input;
  const state = parseIssueExecutionState(candidate.executionState);
  const monitor = state?.monitor;
  if (!state || !monitor || monitor.status !== "triggered") return null;

  // A fired monitor carries the bounds/metadata forward; only `nextCheckAt` is
  // reset to "now" so the scheduler picks the card up on the next tick.
  const scheduledBy: IssueMonitorScheduledBy =
    monitor.scheduledBy === "board" ? "board" : "assignee";
  const policyMonitor: IssueExecutionMonitorPolicy = {
    nextCheckAt: input.now.toISOString(),
    notes: monitor.notes ?? null,
    scheduledBy,
    kind: monitor.kind ?? null,
    serviceName: monitor.serviceName ?? null,
    externalRef: monitor.externalRef ?? null,
    timeoutAt: monitor.timeoutAt ?? null,
    maxAttempts: monitor.maxAttempts ?? null,
    recoveryPolicy: monitor.recoveryPolicy ?? null,
  };
  const currentPolicy =
    candidate.executionPolicy && typeof candidate.executionPolicy === "object"
      ? (candidate.executionPolicy as Record<string, unknown>)
      : { mode: "normal", commentRequired: true, stages: [] };
  const executionPolicy: Record<string, unknown> = { ...currentPolicy, monitor: policyMonitor };

  let monitorPatch: Record<string, unknown>;
  try {
    monitorPatch = applyIssueMonitorPolicyTransition({
      issue: {
        status: candidate.status,
        assigneeAgentId: candidate.assigneeAgentId,
        assigneeUserId: candidate.assigneeUserId,
        executionPolicy: currentPolicy,
        executionState: candidate.executionState as Record<string, unknown> | null,
        monitorNextCheckAt: null,
        monitorWakeRequestedAt: null,
        monitorLastTriggeredAt: candidate.monitorLastTriggeredAt,
        monitorAttemptCount: candidate.monitorAttemptCount,
        monitorNotes: candidate.monitorNotes,
        monitorScheduledBy: candidate.monitorScheduledBy,
      },
      policy: executionPolicy as unknown as IssueExecutionPolicy,
      requestedAssigneePatch: {
        assigneeAgentId: candidate.assigneeAgentId,
        assigneeUserId: candidate.assigneeUserId,
      },
      actor: { agentId: null, userId: null },
    }).patch;
  } catch {
    // The policy module refuses this monitor (e.g. bounds exhausted under its own
    // clock). Fail safe: do not re-arm; the caller skips the card.
    return null;
  }

  // The scheduled re-arm branch always writes both; if it did not, the
  // transition took a different branch and we must not claim a re-arm.
  if (monitorPatch.monitorNextCheckAt === undefined || monitorPatch.executionState === undefined) {
    return null;
  }

  return {
    executionPolicy,
    executionState: monitorPatch.executionState as Record<string, unknown>,
    monitorNextCheckAt: monitorPatch.monitorNextCheckAt as Date,
    monitorWakeRequestedAt: null,
    monitorNotes: (monitorPatch.monitorNotes as string | null) ?? null,
    monitorScheduledBy: (monitorPatch.monitorScheduledBy as string | null) ?? scheduledBy,
  };
}

export interface HostRestartStrandEscalationComment {
  body: string;
  presentation: ReturnType<typeof buildStrandedRecoveryEscalationNotice>["presentation"];
  metadata: ReturnType<typeof buildStrandedRecoveryEscalationNotice>["metadata"];
  recoveryActionId: string;
}

// Stable, deterministic marker id for the notice's "Recovery action" row. It is
// not a real recovery-action row — it is a stable dedupe key for this sweep.
export function buildHostRestartStrandRecoveryActionId(identifier: string | null, sourceRunId: string): string {
  return `host-restart-strand-sweep:${identifier ?? "issue"}:${sourceRunId}`;
}

export function buildHostRestartStrandEscalationComment(input: {
  identifier: string | null;
  sourceRun: HostRestartStrandSourceRun;
  reason: "exhausted" | "never-armed" | "not-monitorable";
  bootId: string | null;
}): HostRestartStrandEscalationComment {
  const seed = buildImmediateExecutionPathRecoveryNoticeSeed({ status: "in_progress" });
  const recoveryActionId = buildHostRestartStrandRecoveryActionId(input.identifier, input.sourceRun.id);
  const body = `${seed.body} (host-restart strand sweep: ${input.reason}; boot ${input.bootId ?? "unknown"})`;
  const notice = buildStrandedRecoveryEscalationNotice({
    seed: { body, title: seed.title, tone: seed.tone },
    recoveryCause: "host_restart_strand",
    recoveryActionId,
    recoveryOwner: null,
    sourceRun: {
      id: input.sourceRun.id,
      agentId: input.sourceRun.agentId,
      status: input.sourceRun.status,
      errorCode: input.sourceRun.errorCode,
    },
  });
  return { body: notice.body, presentation: notice.presentation, metadata: notice.metadata, recoveryActionId };
}

export interface HostRestartStrandSkip {
  liveRun: string[];
  noHostRestartMarker: string[];
  alreadyEscalated: string[];
  capExceeded: string[];
}

export interface HostRestartStrandPlanItem {
  issueId: string;
  identifier: string | null;
  kind: "rearm" | "escalate";
  escalation?: { reason: "exhausted" | "never-armed" | "not-monitorable"; sourceRun: HostRestartStrandSourceRun };
}

export interface HostRestartStrandPlan {
  repairs: HostRestartStrandPlanItem[];
  skipped: HostRestartStrandSkip;
}

// Pure planner: turns (candidate + facts) pairs into an ordered repair list,
// enforcing the per-sweep repair cap. Ordering is the candidate-set order so the
// cap is deterministic and stable across runs.
export function planHostRestartStrandRepairs(input: {
  candidates: HostRestartStrandCandidate[];
  facts: Map<string, HostRestartStrandFacts>;
  now: Date;
  cap: number;
  detectedBootId?: string | null;
}): HostRestartStrandPlan {
  const repairs: HostRestartStrandPlanItem[] = [];
  const skipped: HostRestartStrandSkip = {
    liveRun: [],
    noHostRestartMarker: [],
    alreadyEscalated: [],
    capExceeded: [],
  };

  for (const candidate of input.candidates) {
    const facts = input.facts.get(candidate.id);
    if (!facts) continue;

    const decision = decideHostRestartStrandRepair({
      status: candidate.status,
      assigneeAgentId: candidate.assigneeAgentId,
      assigneeUserId: candidate.assigneeUserId,
      executionState: candidate.executionState,
      monitorAttemptCount: candidate.monitorAttemptCount,
      hasLiveRun: facts.hasLiveRun,
      alreadyEscalated: facts.alreadyEscalated,
      latestRun: facts.latestRun,
      now: input.now,
      detectedBootId: input.detectedBootId ?? null,
    });

    if (decision.action === "skip-live") {
      skipped.liveRun.push(candidate.id);
      continue;
    }
    if (decision.action === "skip-no-marker") {
      skipped.noHostRestartMarker.push(candidate.id);
      continue;
    }
    if (decision.action === "skip-already-escalated") {
      skipped.alreadyEscalated.push(candidate.id);
      continue;
    }

    if (repairs.length >= input.cap) {
      skipped.capExceeded.push(candidate.id);
      continue;
    }

    if (decision.action === "rearm") {
      repairs.push({ issueId: candidate.id, identifier: candidate.identifier, kind: "rearm" });
      continue;
    }
    const sourceRun = facts.latestRun;
    if (!sourceRun) continue;
    repairs.push({
      issueId: candidate.id,
      identifier: candidate.identifier,
      kind: "escalate",
      escalation: {
        reason: decision.reason,
        sourceRun: {
          id: sourceRun.id,
          agentId: sourceRun.agentId,
          status: sourceRun.status,
          errorCode: sourceRun.errorCode,
        },
      },
    });
  }

  return { repairs, skipped };
}

export interface HostRestartStrandSweepInput {
  db: Db;
  now?: Date;
  companyId?: string | null;
  cap?: number;
  // Injectable clock/boot seam so tests can pin the detected boot id. Defaults to
  // B1's `resolveHostBootId`.
  resolveBootId?: () => Promise<string | null>;
  // Injectable mutation seams. Defaults apply the real re-arm UPDATE and the
  // real block + stranded-notice escalation; tests pass fakes to stay hermetic.
  rearmMonitor?: (
    db: Db,
    candidate: HostRestartStrandCandidate,
    patch: HostRestartStrandRearmPatch,
  ) => Promise<number>;
  escalateIssue?: (
    db: Db,
    candidate: HostRestartStrandCandidate,
    escalation: { reason: "exhausted" | "never-armed" | "not-monitorable"; sourceRun: HostRestartStrandSourceRun },
    bootId: string | null,
  ) => Promise<boolean>;
}

export interface HostRestartStrandSweepReport {
  bootId: string | null;
  considered: number;
  reArmed: string[];
  escalated: string[];
  skipped: HostRestartStrandSkip;
}

function emptySkipped(): HostRestartStrandSkip {
  return { liveRun: [], noHostRestartMarker: [], alreadyEscalated: [], capExceeded: [] };
}

function candidateWhere(companyId: string | null) {
  const clauses = [
    notInArray(issues.status, ["done", "cancelled"]),
    isNull(issues.monitorNextCheckAt),
    isNotNull(issues.assigneeAgentId),
  ];
  if (companyId) clauses.push(eq(issues.companyId, companyId));
  return and(...clauses);
}

function issueRunCondition(companyId: string, issueId: string) {
  return and(
    eq(heartbeatRuns.companyId, companyId),
    sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
  );
}

// Correlated "no live run for this card" predicate, with NO table alias. The
// subquery intentionally does not alias `heartbeat_runs`: the correlated columns
// are emitted fully qualified (`"heartbeat_runs"."company_id"`), so aliasing the
// FROM (`... live_run`) leaves that qualifier dangling and Postgres rejects the
// entire statement with `missing FROM-clause entry for table "heartbeat_runs"`.
// Shared by the re-arm UPDATE and the escalation row-lock gate so both are
// guarded by exactly the same SQL.
export function buildNoLiveRunGuard(companyId: string, issueId: string) {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${heartbeatRuns}
    WHERE ${heartbeatRuns.companyId} = ${companyId}
      AND ${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}
      AND ${heartbeatRuns.status} = 'running'
  )`;
}

// True when any heartbeat run for this card is currently in flight. Used at
// collection to skip a live card and as a cheap pre-check before an escalation
// write; the escalation's authoritative guard is the row-lock gate below, which
// cannot be raced.
async function hasLiveRun(db: Db, companyId: string, issueId: string): Promise<boolean> {
  const rows = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(issueRunCondition(companyId, issueId), eq(heartbeatRuns.status, "running")))
    .limit(1);
  return rows.length > 0;
}

// Real re-arm as a single conditional UPDATE, guarded atomically on both
// `monitorNextCheckAt IS NULL` (a concurrent repair wins without a double write)
// and the no-live-run subquery (a run that started between planning and this
// write is not raced out from under the re-arm). Exported so tests can compile
// and assert the real SQL shape.
export function buildRearmMonitorUpdate(
  db: Db,
  candidate: HostRestartStrandCandidate,
  patch: HostRestartStrandRearmPatch,
) {
  return db
    .update(issues)
    .set(patch)
    .where(and(eq(issues.id, candidate.id), isNull(issues.monitorNextCheckAt), buildNoLiveRunGuard(candidate.companyId, candidate.id)))
    .returning({ id: issues.id });
}

// Real re-arm. Returns rows affected.
async function defaultRearmMonitor(
  db: Db,
  candidate: HostRestartStrandCandidate,
  patch: HostRestartStrandRearmPatch,
): Promise<number> {
  return (await buildRearmMonitorUpdate(db, candidate, patch)).length;
}

// Row-lock gate for the escalation write. `SELECT ... FOR UPDATE` acquires the
// issue-row lock ONLY while no run is live; holding that lock for the rest of the
// transaction both serializes concurrent escalations of the same card and closes
// the check-then-write race — a run claimed after planning either blocks on this
// lock or is seen by the NOT-EXISTS predicate at lock time. Exported so tests can
// compile and assert the real SQL shape.
export function buildEscalationGateSelect(db: Db, companyId: string, issueId: string) {
  return db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, issueId), buildNoLiveRunGuard(companyId, issueId)))
    .limit(1)
    .for("update");
}

// Real escalation: block the card (canonical recovery write) and post the
// host-restart-flavored stranded notice as a system comment. Returns whether the
// escalation was applied; `false` means the card was left untouched because a
// live run owns it or a prior pass already posted the notice.
async function defaultEscalateIssue(
  db: Db,
  candidate: HostRestartStrandCandidate,
  escalation: { reason: "exhausted" | "never-armed" | "not-monitorable"; sourceRun: HostRestartStrandSourceRun },
  bootId: string | null,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;

    // Never-touch-live-run gate. Acquire the card's row lock only while no run is
    // live, and hold it for the whole escalation, so a run claimed after planning
    // cannot be raced out from under the block.
    const gate = await buildEscalationGateSelect(txDb, candidate.companyId, candidate.id).then((rows) => rows.length > 0);
    if (!gate) return false;

    // Idempotency is re-checked AFTER the lock, so a concurrent escalation that
    // committed first is observed here and cannot double-post the notice.
    const alreadyNoticed = await tx
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, candidate.id),
          eq(issueComments.authorType, "system"),
          sql`${issueComments.metadata} ->> 'sourceRunId' = ${escalation.sourceRun.id}`,
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0);
    if (alreadyNoticed) return false;

    // Canonical block write: sets status blocked from the card's ORIGINAL status
    // (so the status-transition side effects still run) and syncs blocker
    // relations, on the same transaction and row lock as the gate.
    await blockIssueWithUnresolvedBlockers(
      txDb,
      {
        id: candidate.id,
        companyId: candidate.companyId,
        identifier: candidate.identifier,
        status: candidate.status,
      },
      { source: SWEEP_SOURCE, previousStatus: candidate.status },
    );
    const comment = buildHostRestartStrandEscalationComment({
      identifier: candidate.identifier,
      sourceRun: escalation.sourceRun,
      reason: escalation.reason,
      bootId,
    });
    await issueService(txDb).addComment(candidate.id, comment.body, {}, {
      authorType: "system",
      presentation: comment.presentation,
      metadata: comment.metadata,
    });
    return true;
  });
}

export async function sweepHostRestartStrandedIssues(input: HostRestartStrandSweepInput): Promise<HostRestartStrandSweepReport> {
  const db = input.db;
  const now = input.now ?? new Date();
  const cap = input.cap ?? DEFAULT_SWEEP_REPAIR_CAP;
  const bootId = await (input.resolveBootId ?? resolveHostBootId)();

  const candidates = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      executionPolicy: issues.executionPolicy,
      executionState: issues.executionState,
      monitorAttemptCount: issues.monitorAttemptCount,
      monitorNextCheckAt: issues.monitorNextCheckAt,
      monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
      monitorLastTriggeredAt: issues.monitorLastTriggeredAt,
      monitorNotes: issues.monitorNotes,
      monitorScheduledBy: issues.monitorScheduledBy,
    })
    .from(issues)
    .where(candidateWhere(input.companyId ?? null))
    .orderBy(desc(issues.updatedAt))
    .limit(MAX_CANDIDATES_INSPECTED)
    .then((rows) => rows as unknown as HostRestartStrandCandidate[]);

  const report: HostRestartStrandSweepReport = {
    bootId,
    considered: candidates.length,
    reArmed: [],
    escalated: [],
    skipped: emptySkipped(),
  };

  const facts = new Map<string, HostRestartStrandFacts>();
  for (const candidate of candidates) {
    const liveRun = await hasLiveRun(db, candidate.companyId, candidate.id);

    const latestRunRow = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(issueRunCondition(candidate.companyId, candidate.id))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const latestRun: HostRestartStrandLatestRun | null = latestRunRow
      ? {
          id: latestRunRow.id,
          agentId: latestRunRow.agentId,
          status: latestRunRow.status,
          errorCode: latestRunRow.errorCode,
          resultJson:
            latestRunRow.resultJson && typeof latestRunRow.resultJson === "object"
              ? (latestRunRow.resultJson as Record<string, unknown>)
              : null,
        }
      : null;

    const alreadyEscalated = latestRunRow
      ? await db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(
            and(
              eq(issueComments.issueId, candidate.id),
              eq(issueComments.authorType, "system"),
              sql`${issueComments.metadata} ->> 'sourceRunId' = ${latestRunRow.id}`,
            ),
          )
          .limit(1)
          .then((rows) => rows.length > 0)
      : false;

    facts.set(candidate.id, { hasLiveRun: liveRun, latestRun, alreadyEscalated });
  }

  const plan = planHostRestartStrandRepairs({ candidates, facts, now, cap, detectedBootId: bootId });
  report.skipped = plan.skipped;

  for (const repair of plan.repairs) {
    const candidate = candidates.find((c) => c.id === repair.issueId);
    if (!candidate) continue;

    if (repair.kind === "rearm") {
      const patch = buildRearmMonitorPatch({ now, candidate });
      if (!patch) continue;
      const rowsAffected = await (input.rearmMonitor ?? defaultRearmMonitor)(db, candidate, patch);
      if (rowsAffected > 0) {
        report.reArmed.push(candidate.id);
        logger.info(
          { issueId: candidate.id, identifier: candidate.identifier, bootId },
          "host-restart strand sweep re-armed monitor",
        );
      }
      continue;
    }

    if (repair.kind === "escalate" && repair.escalation) {
      // Cheap pre-check only; the authoritative never-touch-live-run guard lives
      // inside the escalation write (row lock + NOT-EXISTS) and cannot be raced.
      if (await hasLiveRun(db, candidate.companyId, candidate.id)) continue;
      const escalated = await (input.escalateIssue ?? defaultEscalateIssue)(db, candidate, repair.escalation, bootId);
      if (!escalated) continue;
      report.escalated.push(candidate.id);
      logger.info(
        { issueId: candidate.id, identifier: candidate.identifier, reason: repair.escalation.reason, bootId },
        "host-restart strand sweep escalated stranded card",
      );
    }
  }

  if (report.skipped.capExceeded.length > 0) {
    logger.warn(
      { cap, skipped: report.skipped.capExceeded, bootId },
      "host-restart strand sweep cap exceeded; remaining cards deferred to the next pass",
    );
  }

  return report;
}
