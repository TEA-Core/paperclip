import { and, desc, eq, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";
import { parseIssueExecutionState } from "../issue-execution-policy.js";
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
//   - re-arm: the card's monitor policy is still live (not exhausted) → point
//     `monitorNextCheckAt` back at "now" and clear any pending wake marker so the
//     existing `tickDueIssueMonitors` scheduler dispatches it.
//   - escalate: the monitor is exhausted, was never armed, or the card is not
//     monitorable → mirror `reconcileStrandedAssignedIssues` by blocking the card
//     and posting a host-restart-flavored stranded-notice.
//
// Never touch a card that still has a live run, or whose most recent run was not
// a failed run carrying a host-restart marker. The whole pass is idempotent: a
// repaired card leaves the candidate set on the next pass.

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
  executionState: unknown;
  monitorAttemptCount: number | null;
  monitorNextCheckAt: Date | null;
  monitorWakeRequestedAt: Date | null;
}

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

export interface HostRestartStrandRepairPatch {
  monitorNextCheckAt: Date;
  monitorWakeRequestedAt: null;
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

// The per-card repair decision. Pure: no db, no clock reads (uses `now`).
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
}): HostRestartStrandDecision {
  if (input.hasLiveRun) return { action: "skip-live" };

  const run = input.latestRun;
  // Only a failed run stamped with a host-restart marker (by B1's reap) proves
  // this card was torn down by a host restart. Anything else is out of scope.
  if (!run || run.status !== "failed" || !readHostRestartMarker(run.resultJson)) {
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

  if (monitorable && monitorState && !isMonitorExhausted(monitorState, input.monitorAttemptCount, input.now)) {
    return { action: "rearm" };
  }

  const reason = !monitorable ? "not-monitorable" : !monitorState ? "never-armed" : "exhausted";
  return { action: "escalate", reason };
}

// The re-arm patch: re-arm the monitor at "now" and drop any pending wake marker.
// Setting `monitorNextCheckAt <= now` is what re-enters the card into the
// existing `tickDueIssueMonitors` scheduler's due set.
export function buildRearmMonitorPatch(now: Date): HostRestartStrandRepairPatch {
  return { monitorNextCheckAt: now, monitorWakeRequestedAt: null };
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
  // Injectable mutation seams. Defaults apply the real re-arm UPDATE and the
  // real block + stranded-notice escalation; tests pass fakes to stay hermetic.
  rearmMonitor?: (db: Db, issueId: string, patch: HostRestartStrandRepairPatch) => Promise<number>;
  escalateIssue?: (
    db: Db,
    candidate: HostRestartStrandCandidate,
    escalation: { reason: "exhausted" | "never-armed" | "not-monitorable"; sourceRun: HostRestartStrandSourceRun },
    bootId: string | null,
  ) => Promise<void>;
}

export interface HostRestartStrandSweepReport {
  bootId: string | null;
  considered: number;
  reArmed: string[];
  escalated: string[];
  skipped: HostRestartStrandSkip;
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

// Real re-arm: flip the monitor's next check back to `now` (so it re-enters the
// due set) and clear the pending wake marker. Guarded on `monitorNextCheckAt IS
// NULL` so a concurrent repair wins without a double write; returns rows affected.
async function defaultRearmMonitor(
  db: Db,
  issueId: string,
  patch: HostRestartStrandRepairPatch,
): Promise<number> {
  const rows = await db
    .update(issues)
    .set(patch)
    .where(and(eq(issues.id, issueId), isNull(issues.monitorNextCheckAt)))
    .returning({ id: issues.id });
  return rows.length;
}

// Real escalation: block the card (canonical recovery write) and post the
// host-restart-flavored stranded notice as a system comment.
async function defaultEscalateIssue(
  db: Db,
  candidate: HostRestartStrandCandidate,
  escalation: { reason: "exhausted" | "never-armed" | "not-monitorable"; sourceRun: HostRestartStrandSourceRun },
  bootId: string | null,
): Promise<void> {
  await blockIssueWithUnresolvedBlockers(
    db,
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
  await issueService(db).addComment(candidate.id, comment.body, {}, {
    authorType: "system",
    presentation: comment.presentation,
    metadata: comment.metadata,
  });
}

export async function sweepHostRestartStrandedIssues(input: HostRestartStrandSweepInput): Promise<HostRestartStrandSweepReport> {
  const db = input.db;
  const now = input.now ?? new Date();
  const cap = input.cap ?? DEFAULT_SWEEP_REPAIR_CAP;
  const bootId = await resolveHostBootId();

  const candidates = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      executionState: issues.executionState,
      monitorAttemptCount: issues.monitorAttemptCount,
      monitorNextCheckAt: issues.monitorNextCheckAt,
      monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
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
    skipped: { liveRun: [], noHostRestartMarker: [], alreadyEscalated: [], capExceeded: [] },
  };

  const facts = new Map<string, HostRestartStrandFacts>();
  for (const candidate of candidates) {
    const liveRun = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(issueRunCondition(candidate.companyId, candidate.id), eq(heartbeatRuns.status, "running")))
      .limit(1)
      .then((rows) => rows.length > 0);

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

  const plan = planHostRestartStrandRepairs({ candidates, facts, now, cap });
  report.skipped = plan.skipped;

  for (const repair of plan.repairs) {
    const candidate = candidates.find((c) => c.id === repair.issueId);
    if (!candidate) continue;

    if (repair.kind === "rearm") {
      const patch = buildRearmMonitorPatch(now);
      const rowsAffected = await (input.rearmMonitor ?? defaultRearmMonitor)(db, candidate.id, patch);
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
      await (input.escalateIssue ?? defaultEscalateIssue)(db, candidate, repair.escalation, bootId);
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
