import { randomUUID } from "node:crypto";
import { logger } from "../middleware/logger.js";
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  agents,
  environmentLeases,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { reportRunFailure } from "./run-failure-report.js";

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
 * the scan and the update is left untouched. Restricting to `legacy` runtime
 * keeps the reaper on the in-plane conversation runs whose leases are pure
 * bookkeeping — it never touches a remote-sandbox lease whose teardown the
 * pending-cleanup sweep owns.
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

/** Only newly recorded control deadlines are eligible. Upgrades never replay ambiguous historical runs. */
export async function reconcileAbandonedExecutionControl(
  db: Db,
  now = new Date(),
) {
  // Clear dead-holder leases first, so a terminal run cannot keep the
  // execution_owner_active gate wedged. Runs in the same periodic sweep — no
  // second, competing sweep — and is strictly liveness-based.
  const leaseReaping = await reapStaleExecutionOwnerLeases(db, now);
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
  return { scanned: due.length, surfaced, reaped: leaseReaping.reaped };
}
