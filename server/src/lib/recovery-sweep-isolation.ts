import { logger } from "../middleware/logger.js";
import { isTransientDbConnectionError } from "./db-connection-errors.js";

export const RECOVERY_SWEEP_NAMES = [
  "task_watchdogs.reconcile_task_watchdogs",
  "recovery.host_restart_strand_sweep",
  "recovery.reconcile_unassigned_blocking_issue",
  "recovery.reconcile_stranded_assigned_issues",
  "recovery.sweep_stale_issue_locks",
  "recovery.reconcile_exhausted_recovery_drain",
  "recovery.reconcile_blocked_without_blockers",
  "recovery.reconcile_dispatch_suppression_parks",
  "recovery.reconcile_todo_stranded_cards",
  "recovery.reconcile_stale_recovery_action_wakes",
  "recovery.reconcile_stillborn_assigned_backlog",
] as const;

export type RecoverySweepName = (typeof RECOVERY_SWEEP_NAMES)[number];

/**
 * Per-card isolation for the startup recovery sweeps: one card whose recovery write is refused or
 * fails must not abort the sweep (and with it server startup) for every other card. Returns
 * `true` when `run` completed and `false` when the card was skipped for this sweep after an
 * error, so callers can count it. Writes made earlier in the same `run` (recovery action,
 * comment, wake) are not rolled back. A lost database connection is rethrown: that is not a
 * one-card problem, and startup should fail visibly instead of silently skipping every card.
 */
export async function runRecoverySweepIssue(
  issue: { id: string; identifier?: string | null },
  sweep: RecoverySweepName,
  run: () => Promise<void>,
): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (err) {
    if (isTransientDbConnectionError(err)) throw err;
    logger.error(
      {
        err,
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
        errorMessage: err instanceof Error ? err.message : String(err),
        issueId: issue.id,
        identifier: issue.identifier ?? null,
        sweep,
      },
      "recovery sweep skipped a card after an error; writes made earlier in the same iteration (recovery action, comment, wake) may already have persisted",
    );
    return false;
  }
}
