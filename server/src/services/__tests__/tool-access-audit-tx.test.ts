/**
 * SUP-17464: a tool-access audit write that fails INSIDE a transaction must not
 * re-enter the aborted transaction to record the failure.
 *
 * `audit()` in `services/tool-access.ts` used to call
 * `recordToolRuntimeAuditWriteFailure(db, companyId)` unconditionally in its
 * catch block. When `db` is a transaction handle, the insert that just failed
 * has already aborted the Postgres transaction, so the counter write issued
 * another statement on that aborted transaction, failed with "current
 * transaction is aborted", and `recordToolRuntimeAuditWriteFailure` swallowed
 * the error — the audit-write-failure counter signal was silently dropped.
 *
 * These tests drive `refreshCatalog` — the SUP-17464 witness path
 * (`tool-access.ts:13394` constructs the service on a tx handle and calls it) —
 * against a hand-rolled handle that models abort semantics, and assert:
 *   - the pool handle keeps today's behaviour (counter recorded, original
 *     error rethrown);
 *   - the transaction handle defers the counter past the rollback, so the
 *     original error still propagates and the signal is still recorded.
 *
 * No database is involved: the branch under test is `isTransactionHandle(db)`,
 * so a fake handle that rejects the audit insert is the whole setup. Real
 * Postgres abort semantics are modelled explicitly rather than simulated.
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

type FakeDbState = {
  /** Mirrors Postgres: a failed statement leaves the transaction aborted. */
  aborted: boolean;
  /** How many times the counter insert was actually invoked. */
  counterValuesCalls: number;
  /** Outcome of each counter write attempt, in order. */
  counterWrites: Array<{ ok: boolean }>;
};

function makeFailingAuditDb(options: { modelTransaction: boolean }) {
  const state: FakeDbState = {
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
          // transaction case so the pool case keeps a healthy counter path.
          if (options.modelTransaction) state.aborted = true;
          return Promise.reject(AUDIT_ERROR);
        }
        if (table === toolRuntimeMetricCounters) {
          state.counterValuesCalls += 1;
          return {
            onConflictDoUpdate: async () => {
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
  it("pool handle: records the failure counter and rethrows the original error", async () => {
    const { db, state } = makeFailingAuditDb({ modelTransaction: false });
    const service = toolAccessService(db as unknown as Db, {});

    await expect(service.refreshCatalog("conn_test")).rejects.toBe(AUDIT_ERROR);

    expect(state.counterWrites).toEqual([{ ok: true }]);
  });

  it("transaction handle: does not re-enter the aborted tx; defers the counter past the rollback", async () => {
    const { db, state } = makeFailingAuditDb({ modelTransaction: true });
    const txHandle = brandAsTransactionHandle(db);
    const service = toolAccessService(txHandle as unknown as Db, {});

    // The original insert error propagates — not "current transaction is
    // aborted".
    await expect(service.refreshCatalog("conn_test")).rejects.toBe(AUDIT_ERROR);

    // The counter has not touched the aborted handle yet: the whole point of
    // the fix is that it must not. (Without the deferral this is 1 and the
    // write below is lost with `{ ok: false }`.)
    expect(state.counterValuesCalls).toBe(0);

    // Simulate the transaction settling: the rollback that clears the abort.
    state.aborted = false;
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The deferred counter ran after the rollback and was actually recorded.
    expect(state.counterWrites).toEqual([{ ok: true }]);
  });
});
