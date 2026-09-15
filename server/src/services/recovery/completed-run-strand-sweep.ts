import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";
import { isChatDrivenWake } from "./successful-run-handoff.js";
import {
  buildStrandedRecoveryEscalationNotice,
  type StrandedRecoveryNoticeSeed,
} from "./stranded-notice.js";

// Post-success strand sweep. When a run for an agent-assigned `in_progress`
// card finishes on the success path WITHOUT writing a terminal disposition
// (no in_review / done / blocked transition, no re-armed monitor, no scheduled
// retry), the card is left sitting in `in_progress` with no live run and no
// scheduled wake. Every other sweep is keyed to a failure signal — a failed
// run, an exhausted monitor, a host-restart marker, a stillborn `todo` — so a
// card abandoned by a run that simply "succeeded" is invisible to all of them
// and strands until a human notices. This sweep detects that shape and
// escalates it (system notice + logger.warn). It never auto-heals: it does not
// patch status, reassign, or re-dispatch.
//
// Detection target, per card:
//   - shape: `in_progress`, agent-assigned, no user assignee, not hidden, and
//     no scheduled monitor (monitorNextCheckAt IS NULL) — i.e. no live
//     continuation path of its own;
//   - no live run (heartbeat_runs.status = 'running');
//   - the most recent run for the card finished on a non-failed terminal
//     status (`succeeded` — the API displays this as `completed`) — a `failed`
//     run is the host-restart sweep's domain, and `cancelled`/`interrupted`/
//     `timed_out`/`running` did not finish on the success path;
//   - not a chat conversation turn: a `chat_channel` card whose latest run was a
//     correlated chat wake is waiting on the next chat message, not stranded
//     (fold 2c: the same predicate the successful-run handoff treats as a valid
//     path, "chat conversation already owns the next action");
//   - idle: now - run anchor >= idle threshold (default 30 min);
//   - not already escalated for this run.
//
// Idempotency is durable and per (issue, run): an escalated card leaves a
// system notice keyed to the source run (issueComments.metadata.sourceRunId),
// so a second invocation finds nothing left to escalate. Each escalation write
// is additionally guarded in SQL (row lock + re-validated shape + no-live-run),
// so two overlapping invocations cannot double-post.

// The only heartbeat_runs.status value of a run that finished on the success
// path (HEARTBEAT_RUN_TERMINAL_STATUSES is succeeded/interrupted/failed/
// cancelled/timed_out; every other terminal state is a failure or cancellation
// signal with its own owner). The Paperclip API displays this status as
// "completed", which is why the incident reports name it that way.
const COMPLETED_RUN_TERMINAL_STATUSES = ["succeeded"] as const;
const DEFAULT_SWEEP_IDLE_THRESHOLD_MS = 30 * 60 * 1000;
const MAX_CANDIDATES_INSPECTED = 500;
const DEFAULT_SWEEP_ESCALATION_CAP = 50;

export interface CompletedRunStrandCandidate {
  id: string;
  companyId: string;
  identifier: string | null;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  originKind?: string | null;
}

export interface CompletedRunStrandLatestRun {
  id: string;
  agentId: string | null;
  status: string;
  errorCode: string | null;
  finishedAt: Date | null;
  updatedAt: Date | null;
  createdAt: Date | null;
  contextSnapshot?: Record<string, unknown> | null;
}

export interface CompletedRunStrandFacts {
  hasLiveRun: boolean;
  latestRun: CompletedRunStrandLatestRun | null;
  alreadyEscalated: boolean;
  chatConversationOwnsNextAction?: boolean;
}

export type CompletedRunStrandDecision =
  | { action: "skip-not-scope" }
  | { action: "skip-live" }
  | { action: "skip-run-not-completed" }
  | { action: "skip-chat-conversation" }
  | { action: "skip-already-escalated" }
  | { action: "skip-within-threshold" }
  | { action: "escalate" };

// The card is a completed-run strand candidate only if it mirrors the
// "agent-assigned in_progress card with no live continuation path" shape:
// in_progress, agent-assigned, no user assignee. Kept local so the sweep has no
// dependency on a private policy predicate.
export function isCompletedRunStrandIssueShape(shape: {
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}): boolean {
  return (
    shape.status === "in_progress" &&
    Boolean(shape.assigneeAgentId) &&
    !shape.assigneeUserId
  );
}

// True when a run status is the success-path terminal status this sweep targets.
// A `failed` run is out of scope (host-restart domain), `cancelled`/
// `interrupted`/`timed_out` are failure/cancellation signals, and
// `running`/`queued` are live, not a strand.
export function isCompletedRunStatus(status: string | null): boolean {
  return (
    typeof status === "string" &&
    (COMPLETED_RUN_TERMINAL_STATUSES as readonly string[]).includes(status)
  );
}

// The idle anchor for a completed run: when it stopped. A terminal run always
// stamps finishedAt; updatedAt/createdAt are fallbacks for a terminal run that
// never got a finished timestamp.
export function completedRunIdleAnchor(run: CompletedRunStrandLatestRun): Date {
  return run.finishedAt ?? run.updatedAt ?? run.createdAt ?? new Date(0);
}

// The per-card decision. Pure: no db, no clock reads (uses `now`), no host
// reads.
export function decideCompletedRunStrandEscalation(input: {
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  hasLiveRun: boolean;
  alreadyEscalated: boolean;
  latestRun: CompletedRunStrandLatestRun | null;
  chatConversationOwnsNextAction?: boolean;
  now: Date;
  idleThresholdMs: number;
}): CompletedRunStrandDecision {
  // Scope guard: a card that is no longer an agent-assigned in_progress card
  // (flipped to in_review/done, re-assigned to a user, etc.) is out of scope.
  if (!isCompletedRunStrandIssueShape(input)) return { action: "skip-not-scope" };
  if (input.hasLiveRun) return { action: "skip-live" };
  if (!input.latestRun || !isCompletedRunStatus(input.latestRun.status)) {
    return { action: "skip-run-not-completed" };
  }
  // Fold 2c: a chat conversation card idles in_progress between turns by design.
  if (input.chatConversationOwnsNextAction) return { action: "skip-chat-conversation" };
  // Idempotency guard: a system notice already keyed to this run means a prior
  // pass handled the card. Never double-post.
  if (input.alreadyEscalated) return { action: "skip-already-escalated" };
  const idleMs = input.now.getTime() - completedRunIdleAnchor(input.latestRun).getTime();
  if (idleMs < input.idleThresholdMs) return { action: "skip-within-threshold" };
  return { action: "escalate" };
}

export interface CompletedRunStrandEscalationComment {
  body: string;
  presentation: ReturnType<typeof buildStrandedRecoveryEscalationNotice>["presentation"];
  metadata: ReturnType<typeof buildStrandedRecoveryEscalationNotice>["metadata"];
  recoveryActionId: string;
}

// Stable, deterministic marker id for the notice's "Recovery action" row. It is
// not a real recovery-action row — it is a stable dedupe key for this sweep.
export function buildCompletedRunStrandRecoveryActionId(
  identifier: string | null,
  sourceRunId: string,
): string {
  return `completed-run-strand-sweep:${identifier ?? "issue"}:${sourceRunId}`;
}

export function buildCompletedRunStrandNoticeSeed(): StrandedRecoveryNoticeSeed {
  return {
    body:
      "Paperclip found this `in_progress` card likely stranded: its assigned agent's most recent run " +
      "finished on the success path without writing a terminal disposition, and no live run or " +
      "scheduled wake owns it. It has been left in place for a human or manager to inspect and resolve.",
    title: "Completed run left card stranded",
    tone: "warning",
  };
}

export function buildCompletedRunStrandEscalationComment(input: {
  identifier: string | null;
  sourceRun: { id: string; agentId?: string | null; status: string; errorCode?: string | null };
}): CompletedRunStrandEscalationComment {
  const seed = buildCompletedRunStrandNoticeSeed();
  const recoveryActionId = buildCompletedRunStrandRecoveryActionId(input.identifier, input.sourceRun.id);
  const notice = buildStrandedRecoveryEscalationNotice({
    seed,
    recoveryCause: "completed_run_strand",
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

export interface CompletedRunStrandSkip {
  notScope: string[];
  liveRun: string[];
  runNotCompleted: string[];
  chatConversation: string[];
  alreadyEscalated: string[];
  withinThreshold: string[];
  capExceeded: string[];
}

export interface CompletedRunStrandPlanItem {
  issueId: string;
  identifier: string | null;
  sourceRun: { id: string; agentId: string | null; status: string; errorCode: string | null };
}

export interface CompletedRunStrandPlan {
  escalations: CompletedRunStrandPlanItem[];
  skipped: CompletedRunStrandSkip;
}

// Pure planner: turns (candidate + facts) pairs into an ordered escalation list,
// enforcing the per-sweep escalation cap. Ordering is the candidate-set order so
// the cap is deterministic and stable across runs.
export function planCompletedRunStrandEscalations(input: {
  candidates: CompletedRunStrandCandidate[];
  facts: Map<string, CompletedRunStrandFacts>;
  now: Date;
  idleThresholdMs: number;
  cap: number;
}): CompletedRunStrandPlan {
  const escalations: CompletedRunStrandPlanItem[] = [];
  const skipped: CompletedRunStrandSkip = {
    notScope: [],
    liveRun: [],
    runNotCompleted: [],
    chatConversation: [],
    alreadyEscalated: [],
    withinThreshold: [],
    capExceeded: [],
  };

  for (const candidate of input.candidates) {
    const facts = input.facts.get(candidate.id);
    if (!facts) continue;

    const decision = decideCompletedRunStrandEscalation({
      status: candidate.status,
      assigneeAgentId: candidate.assigneeAgentId,
      assigneeUserId: candidate.assigneeUserId,
      hasLiveRun: facts.hasLiveRun,
      alreadyEscalated: facts.alreadyEscalated,
      latestRun: facts.latestRun,
      chatConversationOwnsNextAction: facts.chatConversationOwnsNextAction,
      now: input.now,
      idleThresholdMs: input.idleThresholdMs,
    });

    switch (decision.action) {
      case "skip-not-scope":
        skipped.notScope.push(candidate.id);
        continue;
      case "skip-live":
        skipped.liveRun.push(candidate.id);
        continue;
      case "skip-run-not-completed":
        skipped.runNotCompleted.push(candidate.id);
        continue;
      case "skip-chat-conversation":
        skipped.chatConversation.push(candidate.id);
        continue;
      case "skip-already-escalated":
        skipped.alreadyEscalated.push(candidate.id);
        continue;
      case "skip-within-threshold":
        skipped.withinThreshold.push(candidate.id);
        continue;
    }

    if (escalations.length >= input.cap) {
      skipped.capExceeded.push(candidate.id);
      continue;
    }
    const sourceRun = facts.latestRun;
    if (!sourceRun) continue;
    escalations.push({
      issueId: candidate.id,
      identifier: candidate.identifier,
      sourceRun: {
        id: sourceRun.id,
        agentId: sourceRun.agentId,
        status: sourceRun.status,
        errorCode: sourceRun.errorCode,
      },
    });
  }

  return { escalations, skipped };
}

export interface CompletedRunStrandSweepInput {
  db: Db;
  now?: Date;
  companyId?: string | null;
  idleThresholdMs?: number;
  cap?: number;
  // Injectable mutation seam. The default posts the real system notice under a
  // row-locked, shape-validated, no-live-run guard; tests pass a fake to stay
  // hermetic.
  escalateIssue?: (
    db: Db,
    candidate: CompletedRunStrandCandidate,
    escalation: { sourceRun: CompletedRunStrandLatestRun },
  ) => Promise<boolean>;
}

export interface CompletedRunStrandSweepReport {
  considered: number;
  escalated: string[];
  skipped: CompletedRunStrandSkip;
}

function emptySkipped(): CompletedRunStrandSkip {
  return {
    notScope: [],
    liveRun: [],
    runNotCompleted: [],
    chatConversation: [],
    alreadyEscalated: [],
    withinThreshold: [],
    capExceeded: [],
  };
}

function candidateWhere(companyId: string | null) {
  const clauses = [
    eq(issues.status, "in_progress"),
    isNotNull(issues.assigneeAgentId),
    isNull(issues.assigneeUserId),
    isNull(issues.hiddenAt),
    isNull(issues.monitorNextCheckAt),
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
// FROM leaves that qualifier dangling and Postgres rejects the statement.
// Shared with the escalation row-lock gate so the write is guarded by exactly
// the same SQL.
export function buildCompletedRunNoLiveRunGuard(companyId: string, issueId: string) {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${heartbeatRuns}
    WHERE ${heartbeatRuns.companyId} = ${companyId}
      AND ${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}
      AND ${heartbeatRuns.status} = 'running'
  )`;
}

// Row-lock gate for the escalation write. `SELECT ... FOR UPDATE` re-validates
// the target shape (still in_progress, agent-assigned, no user assignee, not
// hidden, no scheduled monitor) AND the no-live-run predicate on the same row
// lock. Holding that lock for the rest of the transaction both serializes
// concurrent escalations of the same card and closes the check-then-write race:
// a card that flipped status, gained a user assignee, or was claimed by a run
// after planning either blocks on this lock or is seen by the predicates and
// returns no rows. Exported so tests can compile and assert the real SQL shape.
export function buildCompletedRunEscalationGateSelect(db: Db, companyId: string, issueId: string) {
  return db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.id, issueId),
        eq(issues.status, "in_progress"),
        isNotNull(issues.assigneeAgentId),
        isNull(issues.assigneeUserId),
        isNull(issues.hiddenAt),
        isNull(issues.monitorNextCheckAt),
        buildCompletedRunNoLiveRunGuard(companyId, issueId),
      ),
    )
    .limit(1)
    .for("update");
}

// Real escalation: post the completed-run-flavored stranded notice as a system
// comment. Never blocks, reassigns, or re-dispatches. Returns whether the notice
// was posted; `false` means the card was left untouched because it is no longer
// in scope, a live run owns it, or a prior pass already posted the notice.
async function defaultEscalateCompletedRunStrand(
  db: Db,
  candidate: CompletedRunStrandCandidate,
  escalation: { sourceRun: CompletedRunStrandLatestRun },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;

    // Never-escalate guard: re-validate the shape and the no-live-run predicate
    // on the card's row lock before writing, so a card that changed between
    // planning and this write is not escalated.
    const gate = await buildCompletedRunEscalationGateSelect(txDb, candidate.companyId, candidate.id).then(
      (rows) => rows.length > 0,
    );
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

    const comment = buildCompletedRunStrandEscalationComment({
      identifier: candidate.identifier,
      sourceRun: escalation.sourceRun,
    });
    await issueService(txDb).addComment(candidate.id, comment.body, {}, {
      authorType: "system",
      presentation: comment.presentation,
      metadata: comment.metadata,
    });
    return true;
  });
}

// True when any heartbeat run for this card is currently in flight. Used at
// collection to skip a live card and as a cheap pre-check before an escalation
// write; the escalation's authoritative guard is the row-lock gate, which cannot
// be raced.
async function hasLiveRun(db: Db, companyId: string, issueId: string): Promise<boolean> {
  const rows = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(issueRunCondition(companyId, issueId), eq(heartbeatRuns.status, "running")))
    .limit(1);
  return rows.length > 0;
}

export async function sweepCompletedRunStrandedIssues(
  input: CompletedRunStrandSweepInput,
): Promise<CompletedRunStrandSweepReport> {
  const db = input.db;
  const now = input.now ?? new Date();
  const idleThresholdMs = input.idleThresholdMs ?? DEFAULT_SWEEP_IDLE_THRESHOLD_MS;
  const cap = input.cap ?? DEFAULT_SWEEP_ESCALATION_CAP;

  const candidates = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      originKind: issues.originKind,
    })
    .from(issues)
    .where(candidateWhere(input.companyId ?? null))
    .orderBy(desc(issues.updatedAt))
    .limit(MAX_CANDIDATES_INSPECTED)
    .then((rows) => rows as unknown as CompletedRunStrandCandidate[]);

  const report: CompletedRunStrandSweepReport = {
    considered: candidates.length,
    escalated: [],
    skipped: emptySkipped(),
  };

  const facts = new Map<string, CompletedRunStrandFacts>();
  for (const candidate of candidates) {
    const liveRun = await hasLiveRun(db, candidate.companyId, candidate.id);

    const latestRunRow = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        finishedAt: heartbeatRuns.finishedAt,
        updatedAt: heartbeatRuns.updatedAt,
        createdAt: heartbeatRuns.createdAt,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(issueRunCondition(candidate.companyId, candidate.id))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const latestRun: CompletedRunStrandLatestRun | null = latestRunRow
      ? {
          id: latestRunRow.id,
          agentId: latestRunRow.agentId,
          status: latestRunRow.status,
          errorCode: latestRunRow.errorCode,
          finishedAt: latestRunRow.finishedAt ?? null,
          updatedAt: latestRunRow.updatedAt ?? null,
          createdAt: latestRunRow.createdAt ?? null,
          contextSnapshot: latestRunRow.contextSnapshot ?? null,
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

    const chatConversationOwnsNextAction = latestRun
      ? isChatDrivenWake(
          { contextSnapshot: latestRun.contextSnapshot ?? null },
          { originKind: candidate.originKind ?? null },
        )
      : false;

    facts.set(candidate.id, { hasLiveRun: liveRun, latestRun, alreadyEscalated, chatConversationOwnsNextAction });
  }

  const plan = planCompletedRunStrandEscalations({ candidates, facts, now, idleThresholdMs, cap });
  report.skipped = plan.skipped;

  for (const item of plan.escalations) {
    const candidate = candidates.find((c) => c.id === item.issueId);
    if (!candidate) continue;

    // Cheap pre-check only; the authoritative never-escalate guard lives inside
    // the escalation write (row lock + re-validated shape + no-live-run) and
    // cannot be raced.
    if (await hasLiveRun(db, candidate.companyId, candidate.id)) continue;

    const sourceRun = facts.get(candidate.id)?.latestRun ?? null;
    if (!sourceRun) continue;

    const escalated = await (input.escalateIssue ?? defaultEscalateCompletedRunStrand)(
      db,
      candidate,
      { sourceRun },
    );
    if (!escalated) continue;
    report.escalated.push(candidate.id);
    logger.info(
      { issueId: candidate.id, identifier: candidate.identifier, sourceRunId: sourceRun.id },
      "completed-run strand sweep escalated stranded card",
    );
  }

  if (report.skipped.capExceeded.length > 0) {
    logger.warn(
      { cap, skipped: report.skipped.capExceeded },
      "completed-run strand sweep cap exceeded; remaining cards deferred to the next pass",
    );
  }

  return report;
}
