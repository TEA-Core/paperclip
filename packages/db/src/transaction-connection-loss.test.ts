import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { sql as drizzleSql } from "drizzle-orm";
import { createDb } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// SUP-17979. A backend that disappears under an open transaction or a reserved
// connection (a `pg_terminate_backend`, a failover, a connection reaper) must
// fail that work — never the process, and never by running the dead
// transaction's remaining statements somewhere else.
//
// postgres.js 3.4.9 rejects `sql.begin()` as soon as the socket closes, but the
// transaction callback keeps running. Its next statement, or the driver's own
// ROLLBACK, is written to a connection whose socket is already null, from a
// `setImmediate`, and the TypeError is uncaught: production exited and Docker
// restarted it, failing every in-flight agent run. When the pool has queued work
// it reconnects the same connection object first, and the dead transaction's
// next statement autocommits on the replacement session instead. The fix is
// patches/postgres@3.4.9.patch, taken from paperclipai/paperclip#13643 (driver
// issues porsager/postgres#1154, #1186, #1199, #1208). These cases complement
// postgres-connection-recovery.test.ts: they cover a statement that is in
// flight when the backend dies (a row-lock waiter), a FATAL that must not
// reject the reconnected session's first query, and the drizzle client
// (createDb) the server actually uses.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Settled = { ok: true } | { ok: false; error: { code?: string } };

function settle(promise: Promise<unknown>): Promise<Settled> {
  return promise.then(
    () => ({ ok: true }),
    (error: { code?: string }) => ({ ok: false, error }),
  );
}

// A statement written to a dead connection by an unpatched driver never
// settles; report that as a result instead of hanging the test.
function settleWithin(promise: Promise<unknown>, ms: number): Promise<Settled | "never settled"> {
  return Promise.race([settle(promise), sleep(ms).then(() => "never settled" as const)]);
}

describeEmbeddedPostgres("transaction connection loss (SUP-17979)", () => {
  let database: EmbeddedPostgresTestDatabase;
  let admin: postgres.Sql;
  const clients: postgres.Sql[] = [];
  const uncaught: unknown[] = [];
  const recordUncaught = (error: unknown) => {
    uncaught.push(error);
  };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-tx-connection-loss-");
    admin = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    await admin`create table if not exists sup_17979_probe (id int primary key)`;
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
    await database?.cleanup();
  });

  beforeEach(async () => {
    uncaught.length = 0;
    process.prependListener("uncaughtException", recordUncaught);
    await admin`truncate sup_17979_probe`;
  });

  afterEach(async () => {
    process.removeListener("uncaughtException", recordUncaught);
    await Promise.all(clients.splice(0).map((client) => client.end({ timeout: 1 })));
  });

  // A one-connection pool: the terminated connection is the only one, so
  // nothing reconnects it before the transaction callback resumes.
  // `options` also carries driver settings the bundled typings omit (max_pipeline).
  function pool(options: Record<string, unknown> = {}) {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const client = postgres(database.connectionString, {
      max: 1,
      onnotice: () => {},
      onclose: () => resolveClosed(),
      ...options,
    });
    clients.push(client);
    return { client, closed };
  }

  async function terminate(pid: number) {
    const [row] = await admin<{ terminated: boolean }[]>`select pg_terminate_backend(${pid}) as terminated`;
    expect(row?.terminated).toBe(true);
  }

  async function waitForBackendExit(pid: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const [row] = await admin<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where pid = ${pid}`;
      if (row?.n === 0) return;
      await sleep(20);
    }
    throw new Error(`backend ${pid} did not exit`);
  }

  // `begin()` rejects the moment the socket closes, while the callback is still
  // running. Wait for both, then for anything the driver scheduled with
  // setImmediate, so a crash is attributed to the test that caused it.
  async function runTransaction(
    client: { begin: (fn: (tx: postgres.TransactionSql) => Promise<unknown>) => Promise<unknown> },
    body: (tx: postgres.TransactionSql) => Promise<unknown>,
  ): Promise<Settled> {
    let callback: Promise<unknown> = Promise.resolve();
    const outcome = await settle(client.begin((tx) => (callback = body(tx))));
    // Bounded: on an unpatched driver the statement that hit the dead
    // connection never settles, so the callback never does either.
    await Promise.race([callback.catch(() => undefined), sleep(2_000)]);
    await sleep(50);
    return outcome;
  }

  it("rejects the transaction when the backend is terminated between statements (idle in transaction)", async () => {
    const { client, closed } = pool();

    const result = await runTransaction(client, async (tx) => {
      const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await terminate(pid);
      await closed;
      await tx`insert into sup_17979_probe (id) values (1)`;
    });

    expect(uncaught).toEqual([]);
    expect(result.ok).toBe(false);
    expect((result as { error: { code?: string } }).error.code).toMatch(/^CONNECTION_(CLOSED|DESTROYED)$/);
    // The pool recovers: the next query gets a fresh connection.
    await expect(client`select 1 as one`).resolves.toEqual([{ one: 1 }]);
    await expect(admin`select count(*)::int as n from sup_17979_probe`).resolves.toEqual([{ n: 0 }]);
  });

  it("rejects the transaction when the backend is terminated mid-statement (row-lock waiter)", async () => {
    const { client } = pool();

    const result = await runTransaction(client, async (tx) => {
      const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      setTimeout(() => void terminate(pid), 100);
      await tx`select pg_sleep(30)`;
    });

    expect(uncaught).toEqual([]);
    expect(result.ok).toBe(false);
    await expect(client`select 1 as one`).resolves.toEqual([{ one: 1 }]);
  });

  it("never replays a dead transaction's statements on the connection that replaces it", async () => {
    const { client, closed } = pool();

    let queued: Promise<unknown> | undefined;
    const result = await runTransaction(client, async (tx) => {
      const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      // Queue ordinary pool work behind the transaction, so the pool
      // reconnects the same connection object the moment the socket closes.
      queued = Promise.resolve(client`select 1 as one`);
      queued.catch(() => {});
      await terminate(pid);
      await closed;
      await sleep(100);
      await tx`insert into sup_17979_probe (id) values (2)`;
    });

    expect(uncaught).toEqual([]);
    expect(result.ok).toBe(false);
    await expect(queued).resolves.toEqual([{ one: 1 }]);
    // The insert belonged to a transaction that no longer exists. It must not
    // run, autocommitted, on the replacement session.
    await expect(admin`select count(*)::int as n from sup_17979_probe`).resolves.toEqual([{ n: 0 }]);
    await expect(client`select 1 as one`).resolves.toEqual([{ one: 1 }]);
  });

  it("settles statements queued inside the transaction when its connection closes", async () => {
    // max_pipeline 1: every statement after the first waits in the
    // transaction's own queue instead of on the wire.
    const { client } = pool({ max_pipeline: 1 });

    const settled: string[] = [];
    await Promise.race([
      runTransaction(client, async (tx) => {
        const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        const statements = [tx`select pg_sleep(30)`, tx`select 1`, tx`select 2`].map((statement, index) =>
          statement.then(
            () => settled.push(`${index}:resolved`),
            () => settled.push(`${index}:rejected`),
          ),
        );
        setTimeout(() => void terminate(pid), 100);
        await Promise.all(statements);
      }),
      sleep(3_000),
    ]);

    expect(uncaught).toEqual([]);
    expect(settled.sort()).toEqual(["0:rejected", "1:rejected", "2:rejected"]);
  });

  it("fails a reserved connection's next query, and the pool recovers after release", async () => {
    const { client, closed } = pool();

    const reserved = await client.reserve();
    const [{ pid }] = await reserved<{ pid: number }[]>`select pg_backend_pid() as pid`;
    await terminate(pid);
    await closed;

    const first = await settleWithin(Promise.resolve(reserved`select 1`), 1_000);
    const second = await settleWithin(Promise.resolve(reserved`select 1`), 1_000);
    reserved.release();
    const next = await Promise.race([client`select 1 as one`, sleep(2_000).then(() => "timed out")]);
    await sleep(50);

    expect(uncaught).toEqual([]);
    expect(first).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^CONNECTION_/) } });
    expect(second).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^CONNECTION_/) } });
    expect(next).toEqual([{ one: 1 }]);
  }, 15_000);

  it("keeps the process alive through the drizzle client Paperclip uses (createDb)", async () => {
    const db = createDb(database.connectionString, { maxConnections: 1 });
    clients.push(db.$client);

    const result = await runTransaction(
      { begin: (fn) => db.transaction((tx) => fn(tx as never) as Promise<unknown>) },
      async (tx) => {
        const drizzleTx = tx as unknown as Parameters<Parameters<typeof db.transaction>[0]>[0];
        const rows = (await drizzleTx.execute(drizzleSql`select pg_backend_pid() as pid`)) as unknown as Array<{ pid: number }>;
        const pid = rows[0]!.pid;
        await terminate(pid);
        await waitForBackendExit(pid);
        await sleep(100);
        await drizzleTx.execute(drizzleSql`insert into sup_17979_probe (id) values (3)`);
      },
    );

    expect(uncaught).toEqual([]);
    expect(result.ok).toBe(false);
    await expect(db.execute(drizzleSql`select 1 as one`)).resolves.toBeTruthy();
    await expect(admin`select count(*)::int as n from sup_17979_probe`).resolves.toEqual([{ n: 0 }]);
  });
});
