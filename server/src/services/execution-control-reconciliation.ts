import { randomUUID } from "node:crypto";
import { logger } from "../middleware/logger.js";
import { and, desc, eq, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  environmentLeases,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueThreadInteractions,
  issueWatchdogs,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import type { SuccessfulRunHandoffState } from "@paperclipai/shared";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { reportRunFailure } from "./run-failure-report.js";
import { conversationRunPredicate } from "./conversation-continuation.js";
import { publishActivity, type ActivityPublication } from "./activity-log.js";
import {
  executeIssuePostCommitActions,
  issueService,
  type IssuePostCommitAction,
} from "./issues.js";
import {
  evaluateIssueContinuationPath,
  toContinuationPathDate,
} from "./issue-continuation-path.js";
import { hydrateSuccessfulRunHandoffLiveness } from "./successful-run-handoff-state.js";

/**
 * Terminal run states — a run in any of these is not live and cannot be
 * holding a dispatch lease. Mirrors the candidate set in
 * `getConversationOwnershipBlocker`, so a run the reaper clears is exactly one
 * that could be producing a `execution_owner_active` gate.
 */
const DEAD_RUN_STATUSES: readonly string[] = ["failed", "timed_out", "interrupted", "cancelled"];

/**
 * A lease still reads as held by `getConversationOwnershipBlocker` when any of
 * these is true. This is the exact condition that keeps the
 * `execution_owner_active` dispatch gate closed.
 */
function staleOwnerLeasePredicate() {
  return or(
    isNull(environmentLeases.releasedAt),
    eq(environmentLeases.status, "pending_cleanup"),
    eq(environmentLeases.cleanupStatus, "failed"),
  );
}

/**
 * The Summarizer agent — owner of the summary-generation lane (SUP-17698).
 * The amended backfill contract (exec-CEO, 2026-09-27) pins the stranded
 * population by assignee, not by execution state: every non-terminal card
 * assigned to this agent whose continuation paths have all died is a strand
 * this reaper drains.
 */
export const SUMMARIZER_AGENT_ID = "bf538a39-f705-4600-9918-f4c8a49bb0a7";

/** The run→issue link used by the dispatch path (§2a disjuncts 1 and 4). */
const HEARTBEAT_RUN_ISSUE_ID = sql<string>`coalesce(
  ${heartbeatRuns.contextSnapshot} ->> 'issueId',
  ${heartbeatRuns.contextSnapshot} ->> 'taskId'
)`;

/** A run in one of these statuses is a live scheduled retry (dispatch rule). */
const SCHEDULED_RETRY_RUN_STATUSES: readonly string[] = [
  "scheduled_retry",
  "queued",
  "running",
];

/** The activity actions that record a successful-run handoff state. */
const SUCCESSFUL_RUN_HANDOFF_ACTIONS = [
  "issue.successful_run_handoff_required",
  "issue.successful_run_handoff_resolved",
  "issue.successful_run_handoff_escalated",
] as const;

/**
 * Release environment leases that a dead holder run left wedging the
 * `execution_owner_active` dispatch gate.
 *
 * The holder run is dead (terminal) but its lease was never released, so the
 * gate's reader keeps reporting "wait for cleanup" for a cleanup that can never
 * run — the only actors who may release are the (gated) assignee and the
 * creator. This reaper clears that strand.
 *
 * The clear is **liveness-based, not age-based**: a lease whose holder run is
 * still `queued`/`running` is never released, and the liveness is re-verified
 * under the run lock before the write, so a candidate that goes live between
 * the scan and the update is left untouched.
 *
 * The candidate query requires `conversationRunPredicate()` — the same
 * predicate `getConversationOwnershipBlocker` uses to decide that a lease
 * holds the `execution_owner_active` gate. This ensures the reaper only
 * releases leases that are actually blocking dispatch through that gate and
 * never touches a provider-backed or non-conversation lease whose teardown
 * belongs to the pending-cleanup sweep.
 */
export async function reapStaleExecutionOwnerLeases(
  db: Db,
  now = new Date(),
): Promise<{ scanned: number; reaped: number }> {
  const candidates = await db
    .select({
      leaseId: environmentLeases.id,
      companyId: environmentLeases.companyId,
      runId: heartbeatRuns.id,
    })
    .from(environmentLeases)
    .innerJoin(
      heartbeatRuns,
      and(
        eq(environmentLeases.heartbeatRunId, heartbeatRuns.id),
        eq(environmentLeases.companyId, heartbeatRuns.companyId),
      ),
    )
    .where(
      and(
        isNotNull(environmentLeases.heartbeatRunId),
        eq(heartbeatRuns.runtimeMode, "legacy"),
        inArray(heartbeatRuns.status, [...DEAD_RUN_STATUSES]),
        conversationRunPredicate(),
        staleOwnerLeasePredicate(),
      ),
    )
    .limit(50);

  let reaped = 0;
  let nextCandidate = 0;
  await Promise.all(
    Array.from({ length: Math.min(5, candidates.length) }, async () => {
      while (nextCandidate < candidates.length) {
        const candidate = candidates[nextCandidate++]!;
        try {
          const cleared = await db.transaction(async (tx) => {
            await tx.execute(
              sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
            );
            const [run] = await tx
              .select({ status: heartbeatRuns.status })
              .from(heartbeatRuns)
              .where(
                and(
                  eq(heartbeatRuns.id, candidate.runId),
                  eq(heartbeatRuns.companyId, candidate.companyId),
                ),
              )
              .for("update");
            // Re-check liveness under the lock: a run that is no longer terminal
            // (or is gone) must not have its lease released.
            if (!run || !DEAD_RUN_STATUSES.includes(run.status)) return false;
            const [updated] = await tx
              .update(environmentLeases)
              .set({
                status: "released",
                releasedAt: now,
                cleanupStatus: "success",
                updatedAt: now,
              })
              .where(
                and(
                  eq(environmentLeases.id, candidate.leaseId),
                  // Re-check the wedge under lock so a concurrent release, or a
                  // lease a live holder re-armed, is left untouched.
                  staleOwnerLeasePredicate(),
                ),
              )
              .returning({ id: environmentLeases.id });
            return updated?.id != null;
          });
          if (cleared) reaped += 1;
        } catch {
          // A lock/statement timeout leaves this lease for the next tick; the
          // sweep is periodic, so a skipped candidate is retried.
          logger.warn(
            { runId: candidate.runId },
            "Stale execution-owner lease reaping remains pending; continuing with other leases",
          );
        }
      }
    }),
  );
  return { scanned: candidates.length, reaped };
}

/**
 * Terminalize summary-generation cards assigned to the Summarizer whose
 * continuation paths have all died (SUP-17698 backfill, amended contract).
 *
 * A card that never writes — bounced to `changes_requested`, or never
 * dispatched at all (`executionState: null`) — stays non-terminal forever:
 * `in_progress`/`blocked`/`todo` with no run is swept by nothing, and the
 * read-path dead-binding reclaim (SUP-16945) clears the slot binding without
 * terminalizing the issue. The 2026-09-27 sweep measured 17 such cards: six
 * with `executionState.status = "changes_requested"` and eleven with
 * `executionState: null`.
 *
 * The selector is the amended population, not an execution state: every
 * non-terminal card assigned to the Summarizer with no continuation path of
 * any kind — no live run (a stamped run still `queued`/`running`, or the
 * assignee's live running run targeting the card), no pending thread
 * interaction, no armed monitor, no active watchdog or scheduled retry, no
 * live recovery action, no live successful-run handoff, and outside the §2a
 * settle window. A stamped run that is already terminal is NOT a live run:
 * the amended contract selects on the absence of a *live* run, so a card
 * whose last run died but whose status never settled is exactly the strand
 * this reaper drains. The §2a disjuncts reuse the canonical
 * `evaluateIssueContinuationPath` predicate so the reaper and the dispatch
 * path cannot drift; the pending-interaction exclusion is the amended
 * contract's addition (a question awaiting a human is a continuation the
 * §2a predicate does not model).
 *
 * Terminalization reuses the standard issue-update funnel, so the status flip,
 * slot release via `finalizeSummarySlotsForTerminalIssue`, interaction expiry,
 * and activity logging all land in one transaction with normal close-out
 * semantics. Every continuation path is re-verified under the issue row lock,
 * so a card that gained a live run, a pending interaction, or a terminal
 * status between scan and write is left to its own owner; a re-run over
 * already-terminal rows matches nothing and is a no-op.
 */
export async function reapStrandedSummaryGenerationIssues(
  db: Db,
): Promise<{ scanned: number; terminalized: number }> {
  const candidates = await db
    .select({
      issueId: issues.id,
      companyId: issues.companyId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.assigneeAgentId, SUMMARIZER_AGENT_ID),
        notInArray(issues.status, ["done", "cancelled"]),
        isNull(issues.monitorNextCheckAt),
        sql`not exists (
          select 1
          from ${issueThreadInteractions}
          where ${issueThreadInteractions.companyId} = ${issues.companyId}
            and ${issueThreadInteractions.issueId} = ${issues.id}
            and ${issueThreadInteractions.status} = 'pending'
        )`,
        sql`not exists (
          select 1
          from ${issueRecoveryActions}
          where ${issueRecoveryActions.companyId} = ${issues.companyId}
            and ${issueRecoveryActions.sourceIssueId} = ${issues.id}
            and ${issueRecoveryActions.status} in ('active', 'escalated')
        )`,
      ),
    )
    .limit(50);

  let terminalized = 0;
  let nextCandidate = 0;
  await Promise.all(
    Array.from({ length: Math.min(5, candidates.length) }, async () => {
      while (nextCandidate < candidates.length) {
        const candidate = candidates[nextCandidate++]!;
        try {
          const postCommitActivityPublications: ActivityPublication[] = [];
          const postCommitIssueActions: IssuePostCommitAction[] = [];
          const settled = await db.transaction(async (tx) => {
            await tx.execute(
              sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
            );
            const [issue] = await tx
              .select()
              .from(issues)
              .where(
                and(
                  eq(issues.id, candidate.issueId),
                  eq(issues.companyId, candidate.companyId),
                ),
              )
              .for("update");
            // Re-check the stranded shape under the row lock: a card that
            // went terminal, changed assignee, or gained a continuation path
            // since the scan belongs to its own owner.
            if (!issue) return false;
            if (issue.status === "done" || issue.status === "cancelled") return false;
            if (issue.assigneeAgentId !== SUMMARIZER_AGENT_ID) return false;
            // Amended-contract continuation path: an armed monitor.
            if (issue.monitorNextCheckAt) return false;

            // Amended-contract continuation path: a pending thread
            // interaction awaiting a human answer (§2a does not model it).
            const [pendingInteraction] = await tx
              .select({ one: sql<number>`1` })
              .from(issueThreadInteractions)
              .where(
                and(
                  eq(issueThreadInteractions.companyId, issue.companyId),
                  eq(issueThreadInteractions.issueId, issue.id),
                  eq(issueThreadInteractions.status, "pending"),
                ),
              )
              .limit(1);
            if (pendingInteraction) return false;

            // §2a disjunct 1 (activeRun): a stamped run still queued|running,
            // or the assignee's live running run targeting this issue. A
            // stamped run in any terminal state is not live.
            let activeRun = false;
            const stampedRunIds = [issue.executionRunId, issue.checkoutRunId].filter(
              (value): value is string => typeof value === "string" && value.length > 0,
            );
            if (stampedRunIds.length > 0) {
              const stampedRuns = await tx
                .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
                .from(heartbeatRuns)
                .where(inArray(heartbeatRuns.id, stampedRunIds));
              activeRun = stampedRuns.some(
                (row) => row.status === "queued" || row.status === "running",
              );
            }
            if (!activeRun) {
              const [assigneeLiveRun] = await tx
                .select({ one: sql<number>`1` })
                .from(heartbeatRuns)
                .where(
                  and(
                    eq(heartbeatRuns.agentId, issue.assigneeAgentId),
                    eq(heartbeatRuns.status, "running"),
                    eq(HEARTBEAT_RUN_ISSUE_ID, issue.id),
                  ),
                )
                .limit(1);
              activeRun = Boolean(assigneeLiveRun);
            }

            // §2a disjunct 3 (watchdog): a live task watchdog on the issue.
            const [watchdogRow] = await tx
              .select({ one: sql<number>`1` })
              .from(issueWatchdogs)
              .where(
                and(
                  eq(issueWatchdogs.companyId, issue.companyId),
                  eq(issueWatchdogs.issueId, issue.id),
                  eq(issueWatchdogs.status, "active"),
                ),
              )
              .limit(1);

            // §2a disjunct 4 (scheduledRetry): a scheduled_retry/queued/running
            // run with a scheduledRetryReason targeting this issue (same rule
            // as the dispatch path).
            const [scheduledRetryRow] = await tx
              .select({ one: sql<number>`1` })
              .from(heartbeatRuns)
              .where(
                and(
                  eq(heartbeatRuns.companyId, issue.companyId),
                  inArray(heartbeatRuns.status, [...SCHEDULED_RETRY_RUN_STATUSES]),
                  isNotNull(heartbeatRuns.scheduledRetryReason),
                  eq(HEARTBEAT_RUN_ISSUE_ID, issue.id),
                ),
              )
              .limit(1);

            // §2a disjunct 6 (activeRecoveryAction): the D2 live-only reader.
            // An `escalated` action parked on the board is not a live
            // continuation path; only a genuinely `active` action is.
            const activeRecoveryAction = await issueRecoveryActionService(
              tx as unknown as Db,
            ).getLiveContinuationForIssue(issue.companyId, issue.id);

            // §2a disjunct 5 (successfulRunHandoff): the latest handoff
            // activity row, liveness-hydrated exactly like the dispatch path.
            let successfulRunHandoff: SuccessfulRunHandoffState | null = null;
            const [handoffRow] = await tx
              .select({
                action: activityLog.action,
                createdAt: activityLog.createdAt,
              })
              .from(activityLog)
              .where(
                and(
                  eq(activityLog.companyId, issue.companyId),
                  eq(activityLog.entityType, "issue"),
                  eq(activityLog.entityId, issue.id),
                  inArray(activityLog.action, [...SUCCESSFUL_RUN_HANDOFF_ACTIONS]),
                ),
              )
              .orderBy(desc(activityLog.createdAt))
              .limit(1);
            if (handoffRow) {
              const state =
                handoffRow.action === "issue.successful_run_handoff_required"
                  ? "required"
                  : handoffRow.action === "issue.successful_run_handoff_resolved"
                    ? "resolved"
                    : "escalated";
              const handoffStates = new Map<string, SuccessfulRunHandoffState>([
                [
                  issue.id,
                  {
                    state,
                    required: state === "required",
                    hasLiveContinuation: false,
                    sourceRunId: null,
                    correctiveRunId: null,
                    assigneeAgentId: null,
                    detectedProgressSummary: null,
                    createdAt: handoffRow.createdAt,
                  },
                ],
              ]);
              await hydrateSuccessfulRunHandoffLiveness(tx, issue.companyId, handoffStates);
              successfulRunHandoff = handoffStates.get(issue.id) ?? null;
            }

            // Settle-window input: max(updatedAt, latest comment, latest
            // activity-log row) — the same three sources the dispatch path
            // feeds the canonical predicate.
            const [commentRow] = await tx
              .select({
                latestCommentAt: sql<Date | null>`MAX(${issueComments.createdAt})`,
              })
              .from(issueComments)
              .where(
                and(
                  eq(issueComments.companyId, issue.companyId),
                  eq(issueComments.issueId, issue.id),
                ),
              );
            const [logRow] = await tx
              .select({
                latestLogAt: sql<Date | null>`MAX(${activityLog.createdAt})`,
              })
              .from(activityLog)
              .where(
                and(
                  eq(activityLog.companyId, issue.companyId),
                  eq(activityLog.entityType, "issue"),
                  eq(activityLog.entityId, issue.id),
                ),
              );
            const lastActivityAt = [
              issue.updatedAt,
              commentRow?.latestCommentAt ?? null,
              logRow?.latestLogAt ?? null,
            ]
              .map(toContinuationPathDate)
              .filter((value): value is Date => value !== null)
              .reduce<Date | null>(
                (latest, candidate) =>
                  latest === null || candidate.getTime() > latest.getTime()
                    ? candidate
                    : latest,
                null,
              );

            // One canonical decision: the card is terminalizable only when NO
            // §2a disjunct holds and it has settled outside the window.
            const continuation = evaluateIssueContinuationPath({
              activeRun,
              monitorNextCheckAt: issue.monitorNextCheckAt,
              watchdog: watchdogRow ? { present: true } : null,
              scheduledRetry: scheduledRetryRow ? { present: true } : null,
              activeRecoveryAction,
              successfulRunHandoff,
              lastActivityAt,
            });
            if (continuation.ok) return false;

            // The funnel re-locks this same row (a no-op inside this
            // transaction), flips the status, and runs the terminal side
            // effects in place. Post-commit work is deferred to the queues
            // below because this write is part of an external transaction.
            const updated = await issueService(db).update(
              issue.id,
              { status: "done", companyGuard: issue.companyId },
              tx,
              postCommitActivityPublications,
              postCommitIssueActions,
            );
            return updated?.status === "done";
          });
          if (settled) {
            terminalized += 1;
            for (const publication of postCommitActivityPublications) publishActivity(publication);
            if (postCommitIssueActions.length > 0) {
              await executeIssuePostCommitActions(db, postCommitIssueActions);
            }
          }
        } catch {
          // A lock/statement timeout leaves this card for the next tick; the
          // sweep is periodic, so a skipped candidate is retried.
          logger.warn(
            { issueId: candidate.issueId },
            "Stranded summary-generation terminalization remains pending; continuing with other issues",
          );
        }
      }
    }),
  );
  return { scanned: candidates.length, terminalized };
}

/** Only newly recorded control deadlines are eligible. Upgrades never replay ambiguous historical runs. */
export async function reconcileAbandonedExecutionControl(
  db: Db,
  now = new Date(),
) {
  // Clear dead-holder leases first, so a terminal run cannot keep the
  // execution_owner_active gate wedged. Runs in the same periodic sweep — no
  // second, competing sweep — and is strictly liveness-based.
  const leaseReaping = await reapStaleExecutionOwnerLeases(db, now);
    // Terminalize Summarizer cards whose continuation paths have all died
    // (SUP-17698 backfill, amended contract). Same periodic sweep, same
    // single-flight guarantee, strictly liveness-based.
  const summaryReaping = await reapStrandedSummaryGenerationIssues(db);
  const nativeDue = await db
    .select({
      runId: nativeRunFinalizations.runId,
      issueId: nativeRunFinalizations.issueId,
      companyId: nativeRunFinalizations.companyId,
    })
    .from(nativeRunFinalizations)
    .where(
      and(
        isNotNull(nativeRunFinalizations.controlDeadlineAt),
        lte(nativeRunFinalizations.controlDeadlineAt, now),
      ),
    )
    .limit(50);
  const controlDue = await db
    .select({
      runId: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      context: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(
      and(
        isNotNull(heartbeatRuns.executionControlDeadlineAt),
        lte(heartbeatRuns.executionControlDeadlineAt, now),
      ),
    )
    .limit(50);
  const due = [
    ...new Map(
      [
        ...nativeDue,
        ...controlDue.map((row) => ({
          ...row,
          issueId:
            typeof row.context?.issueId === "string"
              ? row.context.issueId
              : null,
        })),
      ].map((row) => [row.runId, row]),
    ).values(),
  ];
  let surfaced = 0;
  // Bound contention latency across independent tasks: a locked task must not
  // consume the entire reconciliation window for every task behind it.
  let nextCandidate = 0;
  await Promise.all(Array.from({ length: Math.min(5, due.length) }, async () => {
    while (nextCandidate < due.length) {
      const candidate = due[nextCandidate++]!;
      try {
        // Set inside the transaction only when the write below genuinely
        // transitions the run into "failed". Read after the transaction
        // commits, so a rolled-back write never reports a false failure.
        let terminalRunToReport: typeof heartbeatRuns.$inferSelect | null = null;
        const repaired = await db.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
          );
          const task = candidate.issueId
            ? (
                await tx
                  .select()
                  .from(issues)
                  .where(
                    and(
                      eq(issues.id, candidate.issueId),
                      eq(issues.companyId, candidate.companyId),
                    ),
                  )
                  .for("update")
              )[0]
            : null;
          const [coordinator] = await tx
            .select()
            .from(nativeRunFinalizations)
            .where(
              and(
                eq(nativeRunFinalizations.runId, candidate.runId),
                eq(nativeRunFinalizations.companyId, candidate.companyId),
              ),
            )
            .for("update");
          const [run] = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.id, candidate.runId),
                eq(heartbeatRuns.companyId, candidate.companyId),
              ),
            )
            .for("update");
          if (
            !run ||
            ![
              coordinator?.controlDeadlineAt,
              run.executionControlDeadlineAt,
            ].some((deadline) => deadline && deadline <= now)
          )
            return false;
          await tx
            .update(heartbeatRuns)
            .set({ executionControlDeadlineAt: null })
            .where(eq(heartbeatRuns.id, run.id));
          if (
            [
              "succeeded",
              "failed",
              "cancelled",
              "timed_out",
              "interrupted",
            ].includes(run.status)
          ) {
            if (coordinator?.controlDeadlineAt)
              await tx
                .update(nativeRunFinalizations)
                .set({ controlDeadlineAt: null })
                .where(eq(nativeRunFinalizations.runId, run.id));
            return true;
          }
          // A persisted result belongs to the existing finalizer, not a replacement provider.
          if (coordinator?.resultId) {
            await tx
              .update(nativeRunFinalizations)
              .set({
                controlDeadlineAt: null,
                leaseOwner: null,
                leaseExpiresAt: null,
                updatedAt: now,
              })
              .where(eq(nativeRunFinalizations.runId, run.id));
            return true;
          }
          const cause = "execution_finalization_deadline_exceeded";
          const nextAction =
            "Inspect the failed run and verify its provider has stopped. Reconcile any uncertain external action before explicitly continuing this task.";
          if (coordinator)
            await tx
              .update(nativeRunFinalizations)
              .set({
                phase: "terminal_failure",
                controlDeadlineAt: null,
                leaseOwner: null,
                leaseExpiresAt: null,
                recoveryState: "blocked",
                nextAttemptAt: null,
                failureCode: cause,
                failureDetail: {
                  ...coordinator.failureDetail,
                  nextAction,
                  recoveryOwner: { kind: "board" },
                },
                updatedAt: now,
              })
              .where(eq(nativeRunFinalizations.runId, run.id));
          const [updatedRun] = await tx
            .update(heartbeatRuns)
            .set({
              status: "failed",
              executionStatusDeliveryId: randomUUID(),
              finishedAt: now,
              ...(coordinator
                ? { nativePhase: "terminal_failure", nativePhaseUpdatedAt: now }
                : {}),
              errorCode: cause,
              error: nextAction,
              nextAction,
              updatedAt: now,
            })
            .where(eq(heartbeatRuns.id, run.id))
            .returning();
          if (updatedRun && updatedRun.status !== run.status) {
            terminalRunToReport = updatedRun;
          }
          await tx
            .update(agents)
            .set({ status: "idle", updatedAt: now })
            .where(
              and(
                eq(agents.id, run.agentId),
                eq(agents.companyId, run.companyId),
                eq(agents.status, "running"),
                sql`not exists (select 1 from ${heartbeatRuns} where ${heartbeatRuns.agentId} = ${run.agentId} and ${heartbeatRuns.status} = 'running')`,
              ),
            );
          const review = task?.status === "in_review" ? parseIssueExecutionState(task.executionState) : null;
          const isCurrentReviewer = review?.status === "pending" &&
            review.currentParticipant?.type === "agent" && review.currentParticipant.agentId === run.agentId;
          if (
            !task ||
            (task.assigneeAgentId !== run.agentId && !isCurrentReviewer) ||
            ["done", "cancelled"].includes(task.status) ||
            (task.executionRunId && task.executionRunId !== run.id) ||
            (task.checkoutRunId && task.checkoutRunId !== run.id)
          )
            return true;
          await tx
            .update(issues)
            .set({ executionRunId: null, checkoutRunId: null, updatedAt: now })
            .where(eq(issues.id, task.id));
          await issueRecoveryActionService(
            tx as unknown as Db,
          ).upsertSourceScoped({
            companyId: run.companyId,
            sourceIssueId: task.id,
            kind: "active_run_watchdog",
            ownerType: "board",
            ownerAgentId: null,
            returnOwnerAgentId: task.assigneeAgentId,
            cause,
            fingerprint: `execution-control:${run.id}`,
            evidence: {
              runId: run.id,
              ...(isCurrentReviewer ? { reviewParticipantAgentId: run.agentId } : {}),
              originalFailureCode: coordinator?.failureCode ?? run.errorCode,
              providerOwnership: "unverified",
            },
            nextAction,
            wakePolicy: null,
            maxAttempts: 3,
            supersedeOnIdentityChange: true,
          });
          return true;
        });
        if (repaired) surfaced += 1;
        if (terminalRunToReport) void reportRunFailure(db, terminalRunToReport);
      } catch {
        logger.warn(
          { runId: candidate.runId },
          "Execution finalization reconciliation remains pending; continuing with other runs",
        );
      }
    }
  }));
  return {
    scanned: due.length,
    surfaced,
    reaped: leaseReaping.reaped,
    summaryTerminalized: summaryReaping.terminalized,
  };
}
