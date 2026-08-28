import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const COMPANY_ID = "00000000-0000-0000-0000-000000000001";
const AGENT_ID = "00000000-0000-0000-0000-0000000000a1";
const ISSUE_ID = "00000000-0000-0000-0000-0000000000b1";

// SUP-14275: run-secret redaction resolves the runs for an issue by ORing
// `context_snapshot ->> 'issueId'` (indexed) with
// `context_snapshot -> 'paperclipIssue' ->> 'id'` (previously unindexed).
// Postgres cannot BitmapOr when one arm has no index, so it sequentially
// scanned and detoasted every run snapshot in the company on every
// issue-scoped redaction — which is every issue heartbeat. That made a single
// unreadable snapshot anywhere in the table fatal to the whole instance, and
// it grows linearly with run history.
d("heartbeat paperclipIssue expression index migration", () => {
  it("keeps the issue-scoped redaction lookup off a full snapshot scan", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("sup14275-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'heartbeat_runs'`;
    const names = idx.map((r) => r.indexname as string);
    expect(names).toContain("heartbeat_runs_company_ctx_paperclip_issue_idx");
    expect(names).toContain("heartbeat_runs_company_ctx_issue_created_idx");

    // A plan is only meaningful at realistic row counts: on an empty table the
    // planner collapses everything to a single index scan with a filter, which
    // would pass whether or not the nested arm is indexed.
    await sql.unsafe(`INSERT INTO companies (id, name) VALUES ('${COMPANY_ID}', 'Plan Fixture')`);
    await sql.unsafe(
      `INSERT INTO agents (id, company_id, name) VALUES ('${AGENT_ID}', '${COMPANY_ID}', 'Plan Fixture Agent')`,
    );
    await sql.unsafe(`
      INSERT INTO heartbeat_runs (company_id, agent_id, context_snapshot)
      SELECT '${COMPANY_ID}', '${AGENT_ID}',
        jsonb_build_object(
          'issueId', gen_random_uuid()::text,
          'paperclipIssue', jsonb_build_object('id', gen_random_uuid()::text)
        )
      FROM generate_series(1, 5000)
    `);
    await sql.unsafe(`
      INSERT INTO heartbeat_runs (company_id, agent_id, context_snapshot)
      VALUES ('${COMPANY_ID}', '${AGENT_ID}',
        jsonb_build_object('paperclipIssue', jsonb_build_object('id', '${ISSUE_ID}')))
    `);
    await sql.unsafe("ANALYZE heartbeat_runs");

    const redactionQuery = "SELECT context_snapshot FROM heartbeat_runs"
      + ` WHERE company_id = '${COMPANY_ID}'`
      + ` AND (context_snapshot ->> 'issueId' = '${ISSUE_ID}'`
      + ` OR context_snapshot -> 'paperclipIssue' ->> 'id' = '${ISSUE_ID}')`;

    const plan = await sql.unsafe(`EXPLAIN ${redactionQuery}`);
    const planText = plan.map((r) => Object.values(r)[0]).join("\n");
    expect(planText).toContain("heartbeat_runs_company_ctx_paperclip_issue_idx");
    expect(planText).toContain("heartbeat_runs_company_ctx_issue_created_idx");
    expect(planText).toContain("BitmapOr");
    expect(planText).not.toContain("Seq Scan");

    const rows = await sql.unsafe(redactionQuery);
    expect(rows).toHaveLength(1);

    // Idempotency: re-running the migration must be a no-op, not an error.
    const migrationSql = await readFile(
      fileURLToPath(new URL("./migrations/0221_heartbeat_ctx_paperclip_issue_index.sql", import.meta.url)),
      "utf8",
    );
    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) await sql.unsafe(statement);
  }, 240_000);
});
