import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type Db,
} from "@paperclipai/db";
import { createToastReadabilitySweepService } from "../services/toast-readability-sweep.js";

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

interface RecordedCall {
  sql: string;
  params?: unknown[];
}

/**
 * Builds a fake `Db` whose `$client.reserve()` pins a fake connection whose
 * `unsafe` dispatches on the SQL string. The handler receives the probe call's
 * bound parameters, so table-level probe failures can be simulated per table.
 */
function makeFakeDb(handler: (sql: string, params?: unknown[]) => unknown) {
  const calls: RecordedCall[] = [];
  let released = 0;
  const reserved = {
    async unsafe(sqlText: string, params?: unknown[]) {
      calls.push({ sql: sqlText, params });
      return await handler(sqlText, params);
    },
    release() {
      released += 1;
    },
  };
  const db = { $client: { async reserve() { return reserved; } } };
  return {
    db: db as unknown as Db,
    calls,
    get released() {
      return released;
    },
  };
}

const TARGETS = [
  { schema_name: "public", table_name: "alpha", column_name: "body" },
  { schema_name: "public", table_name: "beta", column_name: "body" },
];

/**
 * Routes the sweep's SQL: catalog enumeration, the pg_temp function DDL, the
 * drop, and the per-table probe call. Per-table probe outcomes come from the
 * `failures` / `results` maps keyed by table name.
 */
function sweepHandler(
  failures: Record<string, string>,
  results: Record<string, Array<{ ctid: string; probe_error: string }>>,
) {
  return (sqlText: string, params?: unknown[]) => {
    if (sqlText.includes("pg_attribute")) return TARGETS;
    if (sqlText.includes("CREATE OR REPLACE FUNCTION")) return [];
    if (sqlText.includes("DROP FUNCTION")) return [];
    if (sqlText.includes("paperclip_toast_probe($1")) {
      const table = params?.[1] as string;
      const failure = failures[table];
      if (failure !== undefined) throw new Error(failure);
      return results[table] ?? [];
    }
    throw new Error(`unexpected SQL: ${sqlText}`);
  };
}

beforeEach(() => {
  delete process.env.TOAST_READABILITY_SWEEP_DISABLED;
  delete process.env.TOAST_READABILITY_SWEEP_INTERVAL_MS;
});

describe("toast readability sweep (control flow, mocked db client)", () => {
  it("records a failing table and continues with the remaining tables", async () => {
    const fake = makeFakeDb(
      sweepHandler(
        { alpha: 'relation "public.alpha" does not exist' },
        { beta: [{ ctid: "(3,2)", probe_error: "compressed pglz data is corrupt" }] },
      ),
    );
    const service = createToastReadabilitySweepService(fake.db, { sweepIntervalMs: 60_000 });
    const result = await service.sweep();

    expect(result.due).toBe(true);
    expect(result.sweepError).toBeNull();
    expect(result.tablesScanned).toBe(2);
    expect(result.columnsProbed).toBe(2);
    expect(result.failedTables).toEqual([
      { table: "public.alpha", error: 'relation "public.alpha" does not exist' },
    ]);
    expect(result.unreadableRows).toEqual([
      { table: "public.beta", column: "body", ctid: "(3,2)", error: "compressed pglz data is corrupt" },
    ]);
    // The probe for beta ran even though alpha's probe call failed.
    const probeTables = fake.calls
      .filter((call) => call.sql.includes("paperclip_toast_probe($1"))
      .map((call) => call.params?.[1]);
    expect(probeTables).toEqual(["alpha", "beta"]);
    expect(fake.released).toBe(1);
  });

  it("pins the probe to a decompressing expression: length(column::text), never pg_column_size", async () => {
    const fake = makeFakeDb(sweepHandler({}, {}));
    await createToastReadabilitySweepService(fake.db, { sweepIntervalMs: 60_000 }).sweep();

    const ddl = fake.calls.find((call) => call.sql.includes("CREATE OR REPLACE FUNCTION"))?.sql;
    expect(ddl).toBeDefined();
    // Regression pin for the round-1 bounce (finding 2): pg_column_size
    // reports the stored/compressed size and never runs pglz_decompress, so
    // the in-scope corruption (SUP-14272, "compressed pglz data is corrupt")
    // would probe clean and the sweep would be a silent no-op.
    // length(column::text) forces the full detoast + decompression.
    expect(ddl).toContain("length(");
    expect(ddl).toContain("::text");
    expect(ddl).not.toContain("pg_column_size");
  });

  it("never rejects out of the entry point and records infrastructure failures", async () => {
    const fake = makeFakeDb(() => {
      throw new Error("connection closed");
    });
    const result = await createToastReadabilitySweepService(fake.db, { sweepIntervalMs: 60_000 }).sweep();

    expect(result.due).toBe(true);
    expect(result.sweepError).toBe("connection closed");
    expect(result.unreadableRows).toEqual([]);
    expect(result.failedTables).toEqual([]);
    // The pinned connection is still released even when the scan aborts.
    expect(fake.released).toBe(1);

    const broken = { $client: { async reserve() { throw new Error("pool exhausted"); } } } as unknown as Db;
    const pooled = await createToastReadabilitySweepService(broken, { sweepIntervalMs: 60_000 }).sweep();
    expect(pooled.due).toBe(true);
    expect(pooled.sweepError).toBe("pool exhausted");
  });

  it("makes non-due ticks no-ops without additional database calls", async () => {
    const base = Date.UTC(2026, 7, 31, 12, 0, 0);
    let offsetMs = 0;
    const fake = makeFakeDb(sweepHandler({}, {}));
    const service = createToastReadabilitySweepService(fake.db, {
      sweepIntervalMs: 60_000,
      now: () => new Date(base + offsetMs),
    });

    const first = await service.sweep();
    expect(first.due).toBe(true);
    const callsAfterFirst = fake.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    offsetMs = 30_000; // 30 s later: inside the 60 s interval
    const second = await service.sweep();
    expect(second.due).toBe(false);
    expect(second.tablesScanned).toBe(0);
    expect(fake.calls.length).toBe(callsAfterFirst);
  });

  it("does not launch a second overlapping scan while one is in flight", async () => {
    // A probe that stays blocked forever simulates a full scan that outlives the
    // interval (a 6 GB scan can exceed sweepIntervalMs on a degraded DB). The
    // start-to-start cadence gate cannot stop a second scan in that state, so
    // the in-flight guard must: the second due tick is a no-op that starts no
    // new database work (SUP-14582 finding 3).
    const fake = makeFakeDb((sqlText: string) => {
      if (sqlText.includes("pg_attribute")) return TARGETS;
      if (sqlText.includes("CREATE OR REPLACE FUNCTION")) return [];
      if (sqlText.includes("DROP FUNCTION")) return [];
      if (sqlText.includes("paperclip_toast_probe($1")) {
        return new Promise<unknown>(() => {}); // never settles
      }
      throw new Error(`unexpected SQL: ${sqlText}`);
    });
    const base = Date.UTC(2026, 7, 31, 0, 0, 0);
    let offsetMs = 0;
    const service = createToastReadabilitySweepService(fake.db, {
      sweepIntervalMs: 60_000,
      now: () => new Date(base + offsetMs),
    });

    const first = service.sweep(); // due: passes the gates, starts the scan
    // Let the in-flight scan progress to its (blocked) probe call.
    await new Promise((resolve) => setImmediate(resolve));
    const callsAfterFirst = fake.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Advance past the interval so the cadence gate WOULD allow a second scan;
    // only the in-flight guard stops it.
    offsetMs = 61_000;
    const second = await service.sweep();
    expect(second.due).toBe(false);
    expect(second.tablesScanned).toBe(0);
    expect(second.sweepError).toBeNull();
    expect(fake.calls.length).toBe(callsAfterFirst); // no second scan started
    void first; // first stays pending on the blocked probe by design
  });

  it("defaults to a daily cadence when no interval env var is set", async () => {
    const base = Date.UTC(2026, 7, 31, 0, 0, 0);
    let offsetMs = 0;
    const fake = makeFakeDb(sweepHandler({}, {}));
    const service = createToastReadabilitySweepService(fake.db, {
      now: () => new Date(base + offsetMs),
    });

    expect((await service.sweep()).due).toBe(true);
    offsetMs = 23 * 3_600_000 + 59_000;
    expect((await service.sweep()).due).toBe(false);
    offsetMs = 24 * 3_600_000;
    expect((await service.sweep()).due).toBe(true);
  });

  it("is a no-op that never touches the database while disabled", async () => {
    process.env.TOAST_READABILITY_SWEEP_DISABLED = "true";
    try {
      const fake = makeFakeDb(sweepHandler({}, {}));
      const service = createToastReadabilitySweepService(fake.db, { sweepIntervalMs: 60_000 });
      expect(service.disabled).toBe(true);
      const result = await service.sweep();
      expect(result.due).toBe(false);
      expect(fake.calls.length).toBe(0);
      expect(fake.released).toBe(0);
    } finally {
      delete process.env.TOAST_READABILITY_SWEEP_DISABLED;
    }
  });
});

/**
 * Builds a payload that pglz stores in pg_toast as compressed chunks (too
 * large to keep inline, but compressible enough that pglz accepts it). Highly
 * repetitive payloads like `repeat('x', 8192)` compress to ~100 bytes and are
 * kept inline in the main table, which would not exercise detoast at all.
 */
function mkPayload(units: number, salt: number): string {
  let out = "";
  for (let i = 0; i < units; i += 1) {
    out += crypto.createHash("md5").update(String(i * 7919 + salt)).digest("hex") + "0".repeat(32);
  }
  return out;
}

describeEmbeddedPostgres("toast readability sweep (real Postgres)", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-toast-readability-sweep-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  }, 60_000);

  it("reports zero unreadable rows on a clean table whose values are actually TOASTed", async () => {
    await db.execute(sql.raw(`CREATE TABLE toast_sweep_clean (id int PRIMARY KEY, payload text)`));
    await db.execute(sql`INSERT INTO toast_sweep_clean VALUES (1, ${mkPayload(256, 0)})`);
    await db.execute(sql`INSERT INTO toast_sweep_clean VALUES (2, ${mkPayload(256, 4242)})`);

    const [toastRow] = await db.execute(sql.raw(`
      SELECT c.relname AS toast_rel
      FROM pg_class t
      JOIN pg_class c ON c.oid = t.reltoastrelid
      WHERE t.relname = 'toast_sweep_clean' AND t.relnamespace = 'public'::regnamespace
    `));
    const toastRel = String((toastRow as { toast_rel: string }).toast_rel);
    expect(toastRel.startsWith("pg_toast_")).toBe(true);
    const [chunkRow] = await db.execute(sql.raw(`SELECT count(*)::int AS n FROM pg_toast."${toastRel}"`));
    // The payloads must actually live in pg_toast, otherwise the clean-table
    // case would not exercise a detoast at all.
    expect(Number((chunkRow as { n: number | string }).n)).toBeGreaterThan(0);

    const result = await createToastReadabilitySweepService(db, { sweepIntervalMs: 60_000 }).sweep();
    expect(result.due).toBe(true);
    expect(result.sweepError).toBeNull();
    expect(result.tablesScanned).toBeGreaterThan(0);
    expect(result.columnsProbed).toBeGreaterThan(0);
    expect(result.unreadableRows).toEqual([]);
    expect(result.failedTables).toEqual([]);

    await db.execute(sql.raw(`DROP TABLE toast_sweep_clean`));
  }, 60_000);

  // The "one unreadable row reports exactly that ctid" and "a failing table does
  // not abort the remaining tables" cases are covered by the mocked control-flow
  // tests above. A real-DB corrupt-row case is intentionally not asserted here:
  // PostgreSQL refuses DML against `pg_toast.*` relations ("cannot change TOAST
  // relation"), so the only way to manufacture a genuinely unreadable TOAST
  // value is on-disk byte corruption plus a server stop/restart, which is
  // disproportionate for this unit-test card (the production corruption in
  // SUP-14272 was exactly such an on-disk event, out of scope to simulate).
});
