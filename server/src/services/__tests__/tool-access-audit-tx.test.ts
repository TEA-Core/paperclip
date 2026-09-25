/**
 * SUP-17464: a tool-access audit write that fails INSIDE a transaction must
 * record the failure counter on a separate, live pool handle — never by
 * re-entering the aborted transaction handle.
 *
 * `audit()` in `services/tool-access.ts` records the audit-write-failure
 * counter in its catch. When `db` is a transaction handle, the insert that
 * just failed has aborted the Postgres transaction: issuing the counter on
 * that same handle would get "current transaction is aborted", and
 * `recordToolRuntimeAuditWriteFailure` swallows that error — the counter
 * signal is silently dropped. A `setImmediate` around that does not help: the
 * awaited ROLLBACK only runs after the transaction callback rethrows, so
 * event-loop ordering does not place the deferred write past the rollback, and
 * the released transaction sub-client is unsafe to reuse on a later turn.
 *
 * The fix routes the counter to `options.auditDb` — an explicitly supplied,
 * separate live pool handle — when the service's handle is a transaction, and
 * to `db` itself when it is already the pool. These tests drive
 * `refreshCatalog` (the SUP-17464 witness path) against two hand-rolled
 * handles and assert:
 *   - pool handle: counter recorded on it, original error rethrown;
 *   - transaction handle: the counter write lands on the separate pool handle
 *     (never the aborted tx, which stays aborted), and the original error is
 *     still the rejection.
 *
 * No database is involved: the branch under test is `isTransactionHandle(db)`
 * plus the auditDb routing, so two fakes — one that aborts, one that records —
 * are the whole setup. No event-loop timing is relied on: the counter is
 * recorded synchronously (awaited) in the catch, before the error rethrows, so
 * the assertions hold at the moment `refreshCatalog` rejects.
 */

import { describe, expect, it } from "vitest";
import {
  type Db,
  toolAccessAuditEvents,
  toolRuntimeMetricCounters,
} from "@paperclipai/db";
import { brandAsTransactionHandle } from "../db-handle.js";
import { toolAccessService } from "../tool-access.js";

/** The original insert failure we expect to see propagated to the caller. */
const AUDIT_ERROR = new Error("audit insert failed: connection reset by peer");

const CONNECTION = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "conn_test",
  companyId: "22222222-2222-4222-8222-222222222222",
  connectionPurpose: "standard",
  // Neither "mcp_remote" nor "local_stdio": `discoverTools()` rejects it with
  // `tool_connection_transport_unsupported`, which lands `refreshCatalog` on the
  // failure path that records the audit and then writes the counter.
  transport: "standalone",
  status: "active",
  config: {},
  credentialRefs: [],
  credentialSecretRefs: [],
} as unknown as Record<string, unknown>;

type HandleState = {
  /** Mirrors Postgres: a failed statement leaves the transaction aborted. */
  aborted: boolean;
  /** How many times the counter insert was actually invoked on this handle. */
  counterValuesCalls: number;
  /** Outcome of each counter write attempt on this handle, in order. */
  counterWrites: Array<{ ok: boolean }>;
};

/**
 * A handle that always fails the audit insert. When `isTransaction`, that
 * failure also aborts the handle (mirroring a real Postgres transaction); when
 * it is the pool handle, the failure does not abort it. The counter write is
 * recorded on whatever handle it is issued against, so these two fakes let us
 * tell apart "counter re-entered the aborted tx" from "counter recorded on the
 * separate pool".
 */
function makeHandle(options: { isTransaction: boolean }) {
  const state: HandleState = {
    aborted: false,
    counterValuesCalls: 0,
    counterWrites: [],
  };

  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([CONNECTION]),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([CONNECTION]),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: () => {
        if (table === toolAccessAuditEvents) {
          // The audit write is the statement that fails. On a real transaction
          // it is also the statement that aborts it; model that only for the
          // transaction handle so the pool handle keeps a healthy counter path.
          if (options.isTransaction) state.aborted = true;
          return Promise.reject(AUDIT_ERROR);
        }
        if (table === toolRuntimeMetricCounters) {
          state.counterValuesCalls += 1;
          return {
            onConflictDoUpdate: async () => {
              // A counter write issued while this handle is aborted would be
              // swallowed by recordToolRuntimeAuditWriteFailure — model that so
              // a regression to re-entering the aborted tx is caught here.
              if (state.aborted) {
                state.counterWrites.push({ ok: false });
                throw new Error("current transaction is aborted");
              }
              state.counterWrites.push({ ok: true });
            },
          };
        }
        return Promise.resolve(undefined);
      },
    }),
  };

  return { db, state };
}

describe("tool-access audit() failure path (SUP-17464)", () => {
  it("pool handle: records the failure counter on the pool and rethrows the original error", async () => {
    const { db, state } = makeHandle({ isTransaction: false });
    const service = toolAccessService(db as unknown as Db, {});

    await expect(service.refreshCatalog("conn_test")).rejects.toBe(AUDIT_ERROR);

    // The counter is recorded on the pool handle and the original error (not
    // "current transaction is aborted") propagates.
    expect(state.counterValuesCalls).toBe(1);
    expect(state.counterWrites).toEqual([{ ok: true }]);
  });

  it("transaction handle: records the counter on the separate pool handle, never re-enters the aborted tx", async () => {
    // The transaction handle aborts on the failed audit insert and STAYS
    // aborted: the test never clears it and never yields to event-loop timing,
    // so any counter that tried to re-enter this handle would be caught here.
    const { db: txRaw, state: txState } = makeHandle({ isTransaction: true });
    // The healthy, separate pool handle that the counter must land on.
    const { db: poolRaw, state: poolState } = makeHandle({
      isTransaction: false,
    });
    const txHandle = brandAsTransactionHandle(txRaw);
    const service = toolAccessService(txHandle as unknown as Db, {
      auditDb: poolRaw as unknown as Db,
    });

    // The original insert error propagates — not "current transaction is
    // aborted".
    await expect(service.refreshCatalog("conn_test")).rejects.toBe(AUDIT_ERROR);

    // The aborted transaction was never re-entered for the counter: it stayed
    // aborted and the counter insert was never invoked on it.
    expect(txState.aborted).toBe(true);
    expect(txState.counterValuesCalls).toBe(0);
    expect(txState.counterWrites).toEqual([]);

    // Exactly one counter write happened — on the separate pool handle — and
    // it succeeded.
    expect(poolState.counterValuesCalls).toBe(1);
    expect(poolState.counterWrites).toEqual([{ ok: true }]);
  });
});
