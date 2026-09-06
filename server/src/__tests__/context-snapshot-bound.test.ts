/**
 * Regression test for the defensive byte-bound on `heartbeat_runs.context_snapshot`
 * (SUP-15270): a future oversized snapshot must degrade under a cap instead of becoming the
 * fatal step that kills an issue-bound run.
 *
 * Context: `context_snapshot` is unbounded `jsonb`. During dispatch the context object grows
 * (issue description, secret-binding inventory, environment, workspace, runtime services) and is
 * re-written at several heartbeat_runs update sites. An oversized value combined with a transient
 * driver failure was observed to flip an issue-bound run to `setup_failed` before the agent
 * process started. Every such update site now passes its value through `boundContextSnapshot`,
 * which guarantees the value sent to the column always fits under
 * {@link CONTEXT_SNAPSHOT_MAX_BYTES}.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import {
  boundContextSnapshot,
  CONTEXT_SNAPSHOT_MAX_BYTES,
  CONTEXT_SNAPSHOT_PRESERVED_KEYS,
  CONTEXT_SNAPSHOT_TRUNCATION_MARKER,
} from "../services/context-snapshot-bound.ts";

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function boundedSnapshot(lengthBytes: number, issueId: string): Record<string, unknown> {
  return {
    issueId,
    wakeReason: "issue_activity",
    paperclipWake: {
      issue: { description: "x".repeat(lengthBytes) },
    },
  };
}

describe("boundContextSnapshot (pure)", () => {
  it("passes a value already under the cap through unchanged", () => {
    const context = { issueId: "i-1", wakeReason: "issue_activity", count: 3 };
    const result = boundContextSnapshot(context);
    expect(result).toBe(context);
    expect(result).not.toHaveProperty(CONTEXT_SNAPSHOT_TRUNCATION_MARKER);
  });

  it("bounds an oversized value to under the cap, marking it and preserving identity keys", () => {
    const oversized = boundedSnapshot(3 * 1024 * 1024, "issue-over");
    expect(jsonByteLength(oversized)).toBeGreaterThan(CONTEXT_SNAPSHOT_MAX_BYTES);

    const result = boundContextSnapshot(oversized);

    expect(jsonByteLength(result)).toBeLessThanOrEqual(CONTEXT_SNAPSHOT_MAX_BYTES);
    expect(result[CONTEXT_SNAPSHOT_TRUNCATION_MARKER]).toBeTruthy();
    expect(result.paperclipWake).toBeDefined();
    expect(result.paperclipWake?.issue?.description).toContain(CONTEXT_SNAPSHOT_TRUNCATION_MARKER);
    for (const key of CONTEXT_SNAPSHOT_PRESERVED_KEYS) {
      if (key in oversized) expect(result[key]).toBe(oversized[key]);
    }
  });

  it("still bounds a value far past the cap (drop-to-skeleton path)", () => {
    const manyFields: Record<string, unknown> = { issueId: "issue-skeleton" };
    for (let i = 0; i < 5000; i += 1) {
      manyFields[`field-${i}`] = "y".repeat(4000);
    }
    const result = boundContextSnapshot(manyFields);
    expect(jsonByteLength(result)).toBeLessThanOrEqual(CONTEXT_SNAPSHOT_MAX_BYTES);
    expect(result[CONTEXT_SNAPSHOT_TRUNCATION_MARKER]).toBeTruthy();
    expect(result.issueId).toBe("issue-skeleton");
  });

  it("degrades a non-serializable (circular) value to a bounded skeleton without throwing", () => {
    const circular: Record<string, unknown> = { issueId: "issue-circular" };
    circular.self = circular;
    const result = boundContextSnapshot(circular);
    expect(jsonByteLength(result)).toBeLessThanOrEqual(CONTEXT_SNAPSHOT_MAX_BYTES);
    expect(result[CONTEXT_SNAPSHOT_TRUNCATION_MARKER]).toBeTruthy();
    expect(result.issueId).toBe("issue-circular");
  });

  it("stays at or under the cap even when a single oversized preserved key (e.g. wakeReason) is present", () => {
    const oversizedPreserved = boundedSnapshot(2 * 1024 * 1024, "issue-wake");
    oversizedPreserved.wakeReason = "w".repeat(2 * 1024 * 1024);
    expect(jsonByteLength(oversizedPreserved)).toBeGreaterThan(CONTEXT_SNAPSHOT_MAX_BYTES);

    const result = boundContextSnapshot(oversizedPreserved);

    expect(jsonByteLength(result)).toBeLessThanOrEqual(CONTEXT_SNAPSHOT_MAX_BYTES);
    expect(result[CONTEXT_SNAPSHOT_TRUNCATION_MARKER]).toBeTruthy();
    expect(typeof result.wakeReason).toBe("string");
    expect(String(result.wakeReason)).toContain(CONTEXT_SNAPSHOT_TRUNCATION_MARKER);
  });
});

describe("boundContextSnapshot (jsonb write round-trip)", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let db: ReturnType<typeof createDb> | null = null;

  beforeAll(async () => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      console.warn(`Skipping jsonb round-trip (embedded Postgres unavailable): ${support.reason ?? ""}`);
      return;
    }
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-context-snapshot-bound-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  }, 90_000);

  it("round-trips a bounded oversized value through a real jsonb column", async () => {
    if (!db) {
      // Embedded Postgres unsupported in this environment; the pure cases above still ran.
      return;
    }
    const oversized = boundedSnapshot(2 * 1024 * 1024, `issue-rt-${randomUUID()}`);
    const bounded = boundContextSnapshot(oversized);
    expect(jsonByteLength(bounded)).toBeLessThanOrEqual(CONTEXT_SNAPSHOT_MAX_BYTES);

    const tableName = `tsb_probe_${randomUUID().replaceAll("-", "")}`;
    try {
      await db.execute(sql.raw(`CREATE TABLE ${tableName} (id text, snapshot jsonb)`));
      await db.execute(
        sql`INSERT INTO ${sql.raw(tableName)} VALUES ('a', ${JSON.stringify(bounded)}::jsonb)`,
      );
      const [row] = await db.execute<{ raw: string; typeof: string }>(
        sql`SELECT snapshot::text AS raw, jsonb_typeof(snapshot) AS typeof FROM ${sql.raw(tableName)}`,
      );
      expect(row).toBeDefined();
      expect(row.typeof).toBe("object");

      const stored = JSON.parse(row.raw) as Record<string, unknown>;
      expect(stored[CONTEXT_SNAPSHOT_TRUNCATION_MARKER]).toBeTruthy();
      expect(jsonByteLength(stored)).toBeLessThanOrEqual(CONTEXT_SNAPSHOT_MAX_BYTES);
    } finally {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS ${tableName}`));
    }
  }, 90_000);
});
