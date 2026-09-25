/**
 * Shared route-db stub for route suites (SUP-17284 / SUP-17288).
 *
 * Route code awaits drizzle read chains at varying depths —
 * `db.select().from()`, `db.select().from().where(...)`,
 * `db.select().from().where(...).limit(1)`,
 * `db.select().from().where(...).orderBy(...)`. drizzle's select builder is
 * `PromiseLike`, so every terminal link of the chain must be thenable and
 * resolve to rows. A hand-rolled stub that stops short of that surface —
 * `issueRoutes({} as any)`, a `select` whose `where()` returns a non-thenable —
 * answers a new `db` read on a shared route path with a bare 500
 * (`TypeError: db.select is not a function`,
 * `TypeError: db.select(...).from(...).where(...).then is not a function`).
 * Three "post-fix bare500" CI failures (runs 35782699852, 35777871815,
 * 34627265042, analysed in SUP-17284) were all this, not the `vi.doMock` race
 * PR #618 closed.
 *
 * New route suites must use this helper (or a stub that mirrors this surface)
 * instead of passing an empty object literal as the db argument to a
 * `*Routes(...)` factory. `no-empty-db-route-stub.test.ts` is the ratchet that
 * keeps it that way.
 *
 * The stub mirrors the drizzle read surface route code uses, plus a
 * `transaction` executor that hands the callback a separate object branded as
 * a transaction handle (via `services/db-handle.ts`) while mirroring the same
 * read surface, and resolves every read to zero rows. Branding the tx (and
 * leaving the pool stub unbranded) is what lets `isTransactionHandle` tell
 * the pool apart from a transaction in suite-level fate-sharing tests.
 * Modelled on the working inline `mockDb` in
 * `issue-assigned-backlog-contract-routes.test.ts`. Test scaffolding only: no
 * production import may reference this helper, and callers cast with
 * `as any` at the call site exactly as they do today.
 */

import { brandAsTransactionHandle } from "../../services/db-handle.js";

type Row = Record<string, unknown>;

/**
 * A thenable link of the drizzle read chain. drizzle's query builder is
 * `PromiseLike`, so the link itself must be awaitable — route code awaits the
 * chain at varying depths, and a non-thenable terminal link is exactly the
 * `.then is not a function` failure.
 */
type ThenableQueryBuilder = {
  where: (...args: unknown[]) => ThenableQueryBuilder;
  orderBy: (...args: unknown[]) => ThenableQueryBuilder;
  limit: (count: number) => ThenableQueryBuilder;
  for: (mode: string) => ThenableQueryBuilder;
  then<TResult1 = Row[], TResult2 = never>(
    onfulfilled?: ((result: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
};

export type RouteDbStub = {
  select: (...args: unknown[]) => {
    from: (...args: unknown[]) => ThenableQueryBuilder;
  };
  transaction: <T>(callback: (tx: RouteDbStub) => T | Promise<T>) => Promise<T>;
};

function makeQuery(): ThenableQueryBuilder {
  const query: ThenableQueryBuilder = {
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    for: () => query,
    then: (onfulfilled, onrejected) =>
      Promise.resolve([] as Row[]).then(onfulfilled, onrejected),
  };
  return query;
}

export function makeRouteDbStub(): RouteDbStub {
  const stub: RouteDbStub = {
    select: () => ({
      from: () => makeQuery(),
    }),
    transaction: async (callback) =>
      callback(brandAsTransactionHandle({ ...stub })),
  };
  return stub;
}
