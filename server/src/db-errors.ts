const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const MAX_CAUSE_DEPTH = 4;

/**
 * Recognizes a Postgres unique-constraint violation (SQLSTATE 23505).
 *
 * Drizzle wraps driver failures in its own `Failed query: ...` error, so the
 * Postgres error that carries the code and the constraint name is reachable
 * only through `cause` — inspecting the thrown error directly misses it. The
 * constraint name itself lands on `constraint_name` under postgres.js and on
 * `constraint` under node-postgres, and is not always surfaced at all, so fall
 * back to the driver message.
 */
export function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === "object"; depth += 1) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (candidate.code === UNIQUE_VIOLATION) {
      if (!constraintName) return true;
      const constraint = candidate.constraint ?? candidate.constraint_name;
      if (constraint === constraintName) return true;
      if (typeof candidate.message === "string" && candidate.message.includes(constraintName)) return true;
    }
    current = candidate.cause;
  }
  return false;
}

/**
 * Recognizes a Postgres foreign-key-constraint violation (SQLSTATE 23503).
 *
 * A delete that leaves an orphan reference raises this code. Drizzle wraps the
 * driver failure in its own `Failed query: ...` error, so the Postgres error
 * that carries the code is reachable only through `cause`. This helper walks
 * the `cause` chain, the same way `isUniqueViolation` does. With a
 * `constraintNamePrefix` it matches only constraints whose name starts with it
 * (the driver's `constraint` / `constraint_name`, or the name quoted in the message).
 */
export function isForeignKeyViolation(error: unknown, constraintNamePrefix?: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; constraint_name?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === FOREIGN_KEY_VIOLATION) {
      if (!constraintNamePrefix) return true;
      const constraint = candidate.constraint ?? candidate.constraint_name;
      if (typeof constraint === "string" && constraint.startsWith(constraintNamePrefix)) return true;
      if (typeof candidate.message === "string" && candidate.message.includes(`"${constraintNamePrefix}`)) return true;
    }
    current = candidate.cause;
  }
  return false;
}
