/**
 * postgres.js codes for a connection the server side closed out from under
 * an in-flight query — a pooled Postgres endpoint recycling or suspending
 * (observed 2026-09-03 with a managed pooler closing the socket mid-INSERT).
 * The driver reconnects transparently on the next query; only the statement
 * that was on the wire is lost.
 */
const transientDbConnectionCodes = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);

/**
 * True when the error chain (drizzle wraps the driver error as `cause`)
 * carries a postgres.js closed-connection code.
 */
export function isTransientDbConnectionError(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && transientDbConnectionCodes.has(code)) return true;
  }
  return false;
}
