import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { makeRouteDbStub } from "../../__tests__/helpers/route-db-stub.js";
import {
  brandAsTransactionHandle,
  isTransactionHandle,
} from "../db-handle.js";

// Pure predicate/brand behaviour. No database: these pin the ordering the whole
// team relies on — a handle is "a transaction" if it is branded, and the brand
// is consulted before the `instanceof PgTransaction` fallback.

describe("isTransactionHandle (pure, no database)", () => {
  it("returns false for null and undefined without throwing", () => {
    expect(isTransactionHandle(null)).toBe(false);
    expect(isTransactionHandle(undefined)).toBe(false);
  });

  it("returns false for every primitive without throwing", () => {
    expect(isTransactionHandle("db")).toBe(false);
    expect(isTransactionHandle(0)).toBe(false);
    expect(isTransactionHandle(false)).toBe(false);
    expect(isTransactionHandle(Symbol("db"))).toBe(false);
    expect(isTransactionHandle(1n)).toBe(false);
  });

  it("returns false for an unbranded plain object (the pool-like case)", () => {
    expect(isTransactionHandle({})).toBe(false);
    expect(isTransactionHandle({ select: () => ({ from: () => [] }) })).toBe(
      false,
    );
  });

  it("recognizes a non-drizzle handle only through the brand, never via instanceof", () => {
    // A plain object literal can never be a drizzle `PgTransaction` instance,
    // so before branding the predicate must be false. The explicit brand — not
    // `instanceof` — is what flips it to true. This is exactly the ordering
    // that keeps hand-rolled test stubs honest: an instanceof-only predicate
    // would have left this handle reporting false forever.
    const stub = { select: () => ({ from: () => [] }) };
    expect(isTransactionHandle(stub)).toBe(false);
    brandAsTransactionHandle(stub);
    expect(isTransactionHandle(stub)).toBe(true);
  });
});

describe("brandAsTransactionHandle", () => {
  it("returns the same object it was given and is idempotent", () => {
    const handle = { x: 1 };
    const first = brandAsTransactionHandle(handle);
    const second = brandAsTransactionHandle(first);
    expect(first).toBe(handle);
    expect(second).toBe(handle);
    expect(isTransactionHandle(handle)).toBe(true);
  });

  it("is a no-op (no throw) on null, undefined, and primitives", () => {
    expect(brandAsTransactionHandle(null)).toBeNull();
    expect(brandAsTransactionHandle(undefined)).toBeUndefined();
    expect(brandAsTransactionHandle(42)).toBe(42);
    expect(brandAsTransactionHandle("db")).toBe("db");
    // none of these are reported as transaction handles afterwards
    expect(isTransactionHandle(42)).toBe(false);
    expect(isTransactionHandle("db")).toBe(false);
  });
});

describe("isTransactionHandle on the shared route-db stub", () => {
  it("the pool stub is not a transaction handle; the tx its transaction() hands out is", async () => {
    const stub = makeRouteDbStub();
    // The stub standing in for the pool is not branded and not a drizzle
    // instance, so it reports false.
    expect(isTransactionHandle(stub)).toBe(false);

    let tx: unknown;
    await stub.transaction(async (t) => {
      tx = t;
      // The branded handle still mirrors the read surface: reads resolve to
      // zero rows exactly as the pool stub did.
      expect(await t.select().from()).toEqual([]);
    });
    expect(isTransactionHandle(tx)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A genuine drizzle transaction handle: prove the `instanceof PgTransaction`
// fallback (not the brand) recognises a real `db.transaction(cb)` callback
// argument, while the pool handle reports false. Uses embedded Postgres
// (or PAPERCLIP_TEST_DATABASE_URL when provided), no network.
// ---------------------------------------------------------------------------

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const realSuite = support.supported ? describe.sequential : describe.skip;

realSuite("isTransactionHandle against a real drizzle transaction", () => {
  let db: ReturnType<typeof createDb>;
  let temporary:
    | Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>
    | undefined;
  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      temporary = await startEmbeddedPostgresTestDatabase("paperclip-db-handle-");
      db = createDb(temporary.connectionString);
    }
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  it("reports the pool handle false and a real db.transaction handle true", async () => {
    const pool = db;
    let tx: unknown;
    await db.transaction(async (t) => {
      tx = t;
    });
    expect(isTransactionHandle(tx)).toBe(true);
    expect(isTransactionHandle(pool)).toBe(false);
  });
});
