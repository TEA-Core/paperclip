import { sql, type SQL } from "drizzle-orm";

// Every embedded-Postgres suite tears its fixtures down with a TRUNCATE, and a
// TRUNCATE takes AccessExclusiveLock on every listed table. A heartbeat run the
// test dispatched and that is still writing in the background can therefore
// deadlock with the teardown (Postgres 40P01), block it past lock_timeout
// (55P03), or lose a serialization check (40001). Losing that race aborts
// cleanup and leaks the previous test's rows into the next test, which then
// fails on unrelated count assertions.
//
// The durable fix is two guards, in this order:
//   1. await heartbeatService(db).drainActiveRunExecutions() so the background
//      writers have settled before the lock is taken, and
//   2. retry the TRUNCATE on a retryable lock error, because a heartbeat run is
//      not the only possible writer.
// This module owns the second guard plus the predicate it retries on, so every
// suite retries the same set of SQLSTATEs.

const RETRYABLE_LOCK_SQLSTATES = new Set(["40P01", "55P03", "40001"]);

// Postgres drivers wrap the original error, so walk the `cause` chain rather
// than only inspecting the outermost error. The message checks are a fallback
// for wrappers that drop `code` while preserving the text.
export function isRetryableLockError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 6; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE_LOCK_SQLSTATES.has(code)) return true;
    const message = (current as { message?: unknown }).message;
    if (
      typeof message === "string" &&
      (message.includes("deadlock detected") || message.includes("due to lock timeout"))
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// Heartbeat completion can write issue-thread comments shortly after the run
// leaves queued/running. A comment inserted between the truncate's plan and its
// execution breaks the issues delete with this foreign key.
export function isLateIssueCommentFkError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 6; depth += 1) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && message.includes("issue_comments_issue_id_issues_id_fk")) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// Both failure modes describe a writer that is already finishing, so both are
// worth another attempt.
export function isRetryableTruncateError(error: unknown): boolean {
  return isRetryableLockError(error) || isLateIssueCommentFkError(error);
}

export type TruncateWithLockRetryOptions = {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Backoff base; attempt N sleeps baseDelayMs * (N + 1). */
  baseDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
};

type TruncatableDb = { execute: (query: SQL) => Promise<unknown> };

/**
 * Run a teardown TRUNCATE, retrying while the failure looks like a losing race
 * with a writer that is already finishing. Rethrows anything else immediately,
 * and rethrows the last error once the attempts are spent.
 */
export async function truncateWithLockRetry(
  db: TruncatableDb,
  truncateSql: string,
  options: TruncateWithLockRetryOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const isRetryable = options.isRetryable ?? isRetryableTruncateError;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await db.execute(sql.raw(truncateSql));
      return;
    } catch (error) {
      if (!isRetryable(error)) throw error;
      lastError = error;
      // Back off only while another attempt remains. After the last one there is
      // nothing to wait for, so the sleep would only delay the rethrow — 500ms
      // at the default five attempts, 1s for a ten-attempt caller.
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
      }
    }
  }
  throw lastError;
}
