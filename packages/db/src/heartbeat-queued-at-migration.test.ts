import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { inspectMigrations } from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const migration = await readFile(
  new URL("./migrations/0332_breezy_harrier.sql", import.meta.url), "utf8",
);
const statements = migration.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function fixture() {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-queued-at-");
  cleanups.push(db.cleanup);
  const sql = postgres(db.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(async () => sql.end());
  const company = randomUUID();
  const agent = randomUUID();
  await sql`INSERT INTO companies (id, name) VALUES (${company}, 'Queue fixture')`;
  await sql`INSERT INTO agents (id, company_id, name) VALUES (${agent}, ${company}, 'Queue agent')`;
  return { db, sql, company, agent };
}

describePostgres("heartbeat queued_at migration", () => {
  it("stamps every queue entry at wall clock time, preserves metadata updates and enforces bypass protection", async () => {
    const { db, sql, company, agent } = await fixture();
    expect((await inspectMigrations(db.connectionString)).status).toBe("upToDate");
    expect(await sql`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'heartbeat_runs' AND column_name = 'queued_at'
    `).toEqual([{ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null }]);

    const queued = randomUUID();
    const running = randomUUID();
    const scheduled = randomUUID();
    await sql.begin(async (tx) => {
      // A transaction timestamp/default would be too early after this delay.
      await tx`SELECT pg_sleep(0.02)`;
      await tx`
        INSERT INTO heartbeat_runs (id, company_id, agent_id, queued_at)
        VALUES (${queued}, ${company}, ${agent}, '2000-01-01'::timestamptz)
      `;
      const [entry] = await tx`
        SELECT queued_at::text AS stamp, queued_at > transaction_timestamp() AS wall_clock,
          queued_at <= clock_timestamp() AS not_future FROM heartbeat_runs WHERE id = ${queued}
      `;
      expect(entry.wall_clock).toBe(true);
      expect(entry.not_future).toBe(true);
      await tx`UPDATE heartbeat_runs SET error = 'metadata only' WHERE id = ${queued}`;
      await tx`UPDATE heartbeat_runs SET status = 'queued', updated_at = now() WHERE id = ${queued}`;
      expect((await tx`SELECT queued_at::text AS stamp FROM heartbeat_runs WHERE id = ${queued}`)[0].stamp)
        .toBe(entry.stamp);

      await tx`
        INSERT INTO heartbeat_runs (id, company_id, agent_id, status) VALUES
        (${running}, ${company}, ${agent}, 'running'),
        (${scheduled}, ${company}, ${agent}, 'scheduled')
      `;
      expect(await tx`SELECT queued_at FROM heartbeat_runs WHERE id IN (${running}, ${scheduled})`)
        .toEqual([{ queued_at: null }, { queued_at: null }]);
      for (const id of [running, scheduled]) {
        await tx`UPDATE heartbeat_runs SET status = 'queued', queued_at = '2000-01-01' WHERE id = ${id}`;
        expect((await tx`
          SELECT queued_at > transaction_timestamp() AS stamped FROM heartbeat_runs WHERE id = ${id}
        `)[0].stamped).toBe(true);
      }
      await tx`UPDATE heartbeat_runs SET status = 'running' WHERE id = ${queued}`;
      await tx`SELECT pg_sleep(0.02)`;
      await tx`UPDATE heartbeat_runs SET status = 'queued' WHERE id = ${queued}`;
      expect((await tx`
        SELECT queued_at > ${entry.stamp}::timestamptz AS refreshed FROM heartbeat_runs WHERE id = ${queued}
      `)[0].refreshed).toBe(true);
    });

    const violation = { code: "23514", constraint_name: "heartbeat_runs_queued_at_required" };
    await expect(sql`UPDATE heartbeat_runs SET queued_at = NULL WHERE id = ${queued}`)
      .rejects.toMatchObject(violation);
    expect(await sql`
      SELECT convalidated FROM pg_constraint WHERE conrelid = 'heartbeat_runs'::regclass
      AND conname = 'heartbeat_runs_queued_at_required'
    `).toEqual([{ convalidated: true }]);
    await sql`ALTER TABLE heartbeat_runs DISABLE TRIGGER heartbeat_runs_stamp_queued_at`;
    try {
      await expect(sql`
        INSERT INTO heartbeat_runs (company_id, agent_id) VALUES (${company}, ${agent})
      `).rejects.toMatchObject(violation);
      await sql`UPDATE heartbeat_runs SET status = 'running', queued_at = NULL WHERE id = ${running}`;
      await expect(sql`UPDATE heartbeat_runs SET status = 'queued' WHERE id = ${running}`)
        .rejects.toMatchObject(violation);
    } finally {
      await sql`ALTER TABLE heartbeat_runs ENABLE TRIGGER heartbeat_runs_stamp_queued_at`;
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("backfills tied keys in bounded deterministic batches before adding the check and replays without data changes", async () => {
    const { sql, company, agent } = await fixture();
    // Reconstruct the preceding schema on a disposable, fully migrated database.
    await sql`DROP TRIGGER heartbeat_runs_stamp_queued_at ON heartbeat_runs`;
    await sql`ALTER TABLE heartbeat_runs DROP COLUMN queued_at CASCADE`;
    await sql`
      INSERT INTO heartbeat_runs (id, company_id, agent_id, status, created_at)
      SELECT ('00000000-0000-0000-0000-' || lpad(to_hex(n), 12, '0'))::uuid,
        ${company}, ${agent}, 'queued',
        CASE WHEN n <= 6000 THEN '2020-01-01'::timestamptz ELSE '2020-01-02'::timestamptz END
      FROM generate_series(1, 10003) AS n
    `;
    await sql`ALTER TABLE heartbeat_runs ADD COLUMN queued_at timestamptz`;
    const preserved = randomUUID();
    await sql`
      INSERT INTO heartbeat_runs (id, company_id, agent_id, status, queued_at)
      VALUES (${preserved}, ${company}, ${agent}, 'queued', '2019-01-01')
    `;
    await sql`INSERT INTO heartbeat_runs (company_id, agent_id, status) VALUES (${company}, ${agent}, 'running')`;
    await sql`CREATE TEMP TABLE queue_batches (n int, first_id text, last_id text)`;
    await sql.unsafe(`
      CREATE FUNCTION pg_temp.record_queue_batch() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO queue_batches SELECT count(*), min(id::text), max(id::text) FROM changed;
        RETURN NULL;
      END; $$;
      CREATE TRIGGER record_queue_batch AFTER UPDATE ON heartbeat_runs
      REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.record_queue_batch();
    `);
    await sql.begin(async (tx) => {
      for (const statement of statements) {
        if (statement.includes('ADD CONSTRAINT "heartbeat_runs_queued_at_required"')) {
          expect((await tx`SELECT count(*)::int AS n FROM heartbeat_runs WHERE status = 'queued' AND queued_at IS NULL`)[0].n).toBe(0);
          expect(await tx`SELECT conname FROM pg_constraint WHERE conrelid = 'heartbeat_runs'::regclass AND conname = 'heartbeat_runs_queued_at_required'`).toEqual([]);
        }
        await tx.unsafe(statement);
      }
    });
    const key = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;
    expect(await sql`SELECT * FROM queue_batches WHERE n > 0 ORDER BY first_id`).toEqual([
      { n: 5000, first_id: key(1), last_id: key(5000) },
      { n: 5000, first_id: key(5001), last_id: key(10000) },
      { n: 3, first_id: key(10001), last_id: key(10003) },
    ]);
    expect((await sql`
      SELECT count(*)::int AS n FROM heartbeat_runs WHERE id <> ${preserved}
      AND status = 'queued' AND queued_at IS DISTINCT FROM created_at
    `)[0].n).toBe(0);
    expect((await sql`SELECT queued_at = '2019-01-01'::timestamptz AS preserved FROM heartbeat_runs WHERE id = ${preserved}`)[0].preserved).toBe(true);
    expect((await sql`SELECT count(*)::int AS n FROM heartbeat_runs WHERE status = 'running' AND queued_at IS NULL`)[0].n).toBe(1);
    const fingerprint = async () => (await sql`
      SELECT md5(string_agg(id::text || coalesce(queued_at::text, '') || xmin::text, ',' ORDER BY id)) AS value
      FROM heartbeat_runs
    `)[0].value;
    const beforeReplay = await fingerprint();
    await sql.begin(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
    });
    expect(await fingerprint()).toBe(beforeReplay);
    expect(await sql`SELECT indexname FROM pg_indexes WHERE indexname = 'heartbeat_runs_queued_at_backfill_idx'`).toEqual([]);
    expect(await sql`SELECT convalidated FROM pg_constraint WHERE conrelid = 'heartbeat_runs'::regclass AND conname = 'heartbeat_runs_queued_at_required'`)
      .toEqual([{ convalidated: true }]);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
