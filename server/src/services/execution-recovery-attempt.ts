/** Resource waits and productive continuations are not failed provider attempts. */
export function executionFailureRetryCount(run: {
  scheduledRetryAttempt?: number | null;
  scheduledRetryReason?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
}): number {
  if (run.scheduledRetryReason === "max_turns_continuation") return 0;
  // Upstream #13438: a subscription wait is a resource wait too, and its
  // scheduler carries the predecessor's durable count in its own field.
  if (run.scheduledRetryReason === "ai_connection_busy") {
    const count = run.contextSnapshot?.failureRetriesBeforeAiConnectionWait;
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) return count;
  }
  if (
    run.scheduledRetryReason === "workspace_busy" ||
    // Fold 2c / occupancy-retry-count (operator ruling 2026-09-16): the fork's
    // shared execution-workspace occupancy deferral (heartbeat.ts
    // onExecutionWorkspaceOccupied, EXECUTION_WORKSPACE_OCCUPIED_RETRY_REASON)
    // is the same kind of resource wait. Its scheduledRetryAttempt counts
    // deferrals for its own eight-deferral bound, not failed attempts, so its
    // successors carry the pre-wait count in this field too (written by the
    // same scheduler) and a real failure after waiting keeps its retry budget.
    run.scheduledRetryReason === "execution_workspace_occupied"
  ) {
    // Only a server-created workspace retry can consume this field. Its
    // scheduler overwrites caller context with the predecessor's durable count.
    const count = run.contextSnapshot?.failureRetriesBeforeWorkspaceWait;
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) return count;
  }
  // Historical ambiguous counters remain conservative rather than resetting.
  return run.scheduledRetryAttempt ?? 0;
}
