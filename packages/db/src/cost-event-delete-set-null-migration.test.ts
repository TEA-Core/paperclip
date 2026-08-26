import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres billing event delete-set-null migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type FkActionRow = { conname: string; confdeltype: string };

describeEmbeddedPostgres("billing event agent/run delete-set-null migration (0220)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let connectionString = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-billing-event-delete-set-null-");
    connectionString = tempDb.connectionString;
    await applyPendingMigrations(connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("detaches cost_events and finance_events from agents and heartbeat_runs with ON DELETE SET NULL", async () => {
    const sql = postgres(connectionString, { max: 1 });
    try {
      const rows = await sql<FkActionRow[]>`
        SELECT conname, confdeltype
        FROM pg_constraint
        WHERE conrelid = ANY (ARRAY['cost_events', 'finance_events']::regclass[])
          AND contype = 'f'
          AND confrelid = ANY (ARRAY['agents', 'heartbeat_runs']::regclass[])
        ORDER BY conname
      `;

      expect(rows).toEqual([
        { conname: "cost_events_agent_id_agents_id_fk", confdeltype: "n" },
        { conname: "cost_events_heartbeat_run_id_heartbeat_runs_id_fk", confdeltype: "n" },
        { conname: "finance_events_agent_id_agents_id_fk", confdeltype: "n" },
        { conname: "finance_events_heartbeat_run_id_heartbeat_runs_id_fk", confdeltype: "n" },
      ]);
    } finally {
      await sql.end();
    }
  });

  it("makes cost_events.agent_id nullable so billing rows survive agent deletion", async () => {
    const sql = postgres(connectionString, { max: 1 });
    try {
      const [row] = await sql<{ nullable: boolean }[]>`
        SELECT is_nullable = 'YES' AS nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'cost_events'
          AND column_name = 'agent_id'
      `;
      expect(row).toEqual({ nullable: true });
    } finally {
      await sql.end();
    }
  });
});

