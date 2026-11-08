import { HttpError } from "../errors.js";
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
  "recovery.reconcile_pending_review_rearm",
  "recovery.ingest_stale_in_review_child_issues",
  "recovery.reconcile_cancelled_only_blocker_dependents",
  "recovery.reconcile_undispatchable_assigned",
  "recovery.completed_run_strand_sweep",
] as const;

export type RecoverySweepName = (typeof RECOVERY_SWEEP_NAMES)[number];

function isCanonicalWikiHandoffRefusal(error: unknown): boolean {
  if (!(error instanceof HttpError) || error.status !== 422) return false;
  const details = error.details;
  return (
    details !== null &&
    typeof details === "object" &&
    (details as { subGuard?: unknown }).subGuard === "wiki_handoff" &&
    (details as { reason?: unknown }).reason === "wiki_handoff_non_canonical_assignee"
  );
}

/**
 * Per-card isolation for the startup recovery sweeps. Only the canonical Wiki handoff refusal is
 * safe to skip; all other errors preserve the fail-fast recovery contract. Writes made earlier in
 * the same `run` are not rolled back.
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
    if (isTransientDbConnectionError(err) || !isCanonicalWikiHandoffRefusal(err)) throw err;
    const details = (err as HttpError).details as { reason?: unknown } | null | undefined;
    logger.error(
      {
        err,
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
        errorMessage: err instanceof Error ? err.message : String(err),
        refusalReason: typeof details?.reason === "string" ? details.reason : null,
        issueId: issue.id,
        identifier: issue.identifier ?? null,
        sweep,
      },
      "recovery sweep skipped a card after an error; writes made earlier in the same iteration (recovery action, comment, wake) may already have persisted",
    );
    return false;
  }
}
