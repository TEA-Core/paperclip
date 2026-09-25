/**
 * db-handle.ts — tell a drizzle transaction handle apart from the pool handle,
 * in a way that survives test stubs.
 *
 * Route/service code threads a single "db-or-transaction" value through a
 * mutation and historically decided which it was by identity:
 *
 *   const ranInsideTx = dbOrTx === db;
 *
 * That comparison is an inversion, not a check. `db.transaction(cb)` hands
 * `cb` a `PgTransaction` that is *never* `=== db`, so the moment a real
 * transaction (or a test stub standing in for one) arrives, `dbOrTx === db`
 * is false and the branch flips to the wrong side. The intent was "are we
 * already inside a transaction?" but the code asks "is this literally the
 * pool?" — two different questions that only agree when a transaction is
 * passed.
 *
 * `isTransactionHandle` asks the real question. It is safe to call with any
 * `unknown` and is stable across stubs: a hand-rolled stub is not a drizzle
 * instance, so the check registers an explicit brand first and only falls
 * back to `instanceof PgTransaction` for genuine drizzle handles.
 *
 * `brandAsTransactionHandle` is the brand registrar. It is for test
 * scaffolding and non-drizzle wrappers: it tags an object so
 * `isTransactionHandle` reports it `true` even though it is not a drizzle
 * instance. It is idempotent, a no-op on primitives/`null`, and it does not
 * own the handle's lifetime — it never starts or ends a transaction.
 * Production drizzle transactions need no branding; they are detected by the
 * `instanceof` fallback.
 */

import { PgTransaction } from "drizzle-orm/pg-core";

// Module-scoped brand. A WeakSet keeps handles collectable (no long-lived
// strong reference, no leaked property) and is naturally scoped to this
// module's instance, so test files that import the stub and the predicate
// share one brand even under vitest's per-file module graph.
const transactionHandleBrand = new WeakSet<object>();

/**
 * True when `handle` is a transaction handle: either explicitly branded with
 * `brandAsTransactionHandle`, or a real drizzle `PgTransaction` (the value a
 * `db.transaction(cb)` callback receives). False for the pool handle, plain
 * objects, `null`, `undefined`, and every primitive. Never throws.
 */
export function isTransactionHandle(handle: unknown): boolean {
  // typeof guards first: WeakSet.has/add reject primitives, and a bare
  // function or null is never a db/transaction handle. After this guard the
  // value is a non-null object, so the brand and instanceof checks are safe.
  if (typeof handle !== "object" || handle === null) {
    return false;
  }
  // Brand before instanceof: a hand-rolled test stub is not a drizzle
  // instance, so it can only be recognized through the explicit brand.
  if (transactionHandleBrand.has(handle)) {
    return true;
  }
  // A genuine drizzle transaction is a PgTransaction; the pool handle is not.
  return handle instanceof PgTransaction;
}

/**
 * Tag `handle` as a transaction handle so `isTransactionHandle` reports it
 * `true`, then return the same handle unchanged. Idempotent: branding an
 * already-branded handle is a no-op. Non-objects (primitives, `null`,
 * `undefined`, functions) are returned untouched without being branded, so
 * this is safe to call unconditionally on an `unknown`.
 */
export function brandAsTransactionHandle<T>(handle: T): T {
  if (typeof handle === "object" && handle !== null) {
    transactionHandleBrand.add(handle);
  }
  return handle;
}
