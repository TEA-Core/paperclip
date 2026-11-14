type RetryRun = {
  scheduledRetryAttempt?: number | null;
  scheduledRetryReason?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
};

/** Server-owned counts for one automatic continuation chain. Repair slots live
 * in legacyDispositionEpisode and are never charged to either counter here. */
export interface ExecutionRetryAccounting {
  version: 1;
  failureRetries: number;
  maxTurnContinuations: number;
}

// Fold 2c / occupancy-retry-count (operator ruling 2026-09-16): the fork's
// shared execution-workspace occupancy deferral (heartbeat.ts
// onExecutionWorkspaceOccupied, EXECUTION_WORKSPACE_OCCUPIED_RETRY_REASON)
// is the same kind of resource wait as workspace_busy. Its
// scheduledRetryAttempt counts deferrals for its own eight-deferral bound, not
// failed attempts, so it never spends (or overwrites) the failure budget.
const WORKSPACE_WAIT_REASONS = ["workspace_busy", "execution_workspace_occupied"];
const RESOURCE_WAIT_REASONS = [...WORKSPACE_WAIT_REASONS, "ai_connection_busy"];

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function savedAccounting(run: RetryRun): ExecutionRetryAccounting | null {
  const value = run.contextSnapshot?.executionRetryAccounting;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const saved = value as Record<string, unknown>;
  const failureRetries = count(saved.failureRetries);
  const maxTurnContinuations = count(saved.maxTurnContinuations);
  if (saved.version !== 1 || failureRetries === null || maxTurnContinuations === null) return null;
  return { version: 1, failureRetries, maxTurnContinuations };
}

function historicalFailureCount(run: RetryRun): number {
  if (run.scheduledRetryReason === "max_turns_continuation" || run.scheduledRetryReason === "issue_disposition_repair") return 0;
  // Upstream #13438: a subscription wait is a resource wait too, and its
  // scheduler carries the predecessor's durable count in its own field.
  if (run.scheduledRetryReason === "ai_connection_busy") {
    const saved = count(run.contextSnapshot?.failureRetriesBeforeAiConnectionWait);
    if (saved !== null) return saved;
  }
  if (WORKSPACE_WAIT_REASONS.includes(run.scheduledRetryReason ?? "")) {
    // Only a server-created workspace retry (workspace_busy or the fork's
    // occupancy deferral) can consume this field. Its scheduler overwrites
    // caller context with the predecessor's durable count.
    const saved = count(run.contextSnapshot?.failureRetriesBeforeWorkspaceWait);
    if (saved !== null) return saved;
  }
  // Historical ambiguous counters remain conservative rather than resetting.
  return count(run.scheduledRetryAttempt) ?? 0;
}

export function executionRetryAccounting(run: RetryRun): ExecutionRetryAccounting {
  const saved = savedAccounting(run);
  const nonFailureLane = ["max_turns_continuation", "issue_disposition_repair", ...RESOURCE_WAIT_REASONS].includes(run.scheduledRetryReason ?? "");
  return {
    version: 1,
    failureRetries: Math.max(saved?.failureRetries ?? 0, saved && nonFailureLane ? 0 : historicalFailureCount(run)),
    maxTurnContinuations: Math.max(saved?.maxTurnContinuations ?? 0,
      run.scheduledRetryReason === "max_turns_continuation" ? count(run.scheduledRetryAttempt) ?? 0 : 0),
  };
}

/** Resource waits, repairs and productive continuations do not spend failures. */
export function executionFailureRetryCount(run: RetryRun): number {
  return executionRetryAccounting(run).failureRetries;
}

export function executionRetryAttemptCount(run: RetryRun, reason: string): number {
  if (RESOURCE_WAIT_REASONS.includes(reason)) {
    return run.scheduledRetryReason === reason ? count(run.scheduledRetryAttempt) ?? 0 : 0;
  }
  const accounting = executionRetryAccounting(run);
  return reason === "max_turns_continuation" ? accounting.maxTurnContinuations : accounting.failureRetries;
}

export function accountingForScheduledRetry(run: RetryRun, reason: string, attempt: number): ExecutionRetryAccounting {
  const accounting = executionRetryAccounting(run);
  if (reason === "max_turns_continuation") accounting.maxTurnContinuations = attempt;
  else if (!RESOURCE_WAIT_REASONS.includes(reason)) accounting.failureRetries = attempt;
  return accounting;
}
