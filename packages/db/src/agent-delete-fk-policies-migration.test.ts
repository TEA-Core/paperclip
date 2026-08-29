import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent delete FK policy migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type FkActionRow = { conname: string; confdeltype: string; convalidated: boolean };

// PostgreSQL truncates identifiers to NAMEDATALEN-1 (63) bytes, so constraint
// names longer than that are stored truncated.
const pgIdent = (name: string) => name.slice(0, 63);

// confdeltype: 'c' = CASCADE, 'n' = SET NULL.
const EXPECTED_FK_ACTIONS: Record<string, string> = {
  // Cascade: agent-owned rows that have no meaning without the agent.
  issue_watchdogs_watchdog_agent_id_agents_id_fk: "c",
  decision_bundles_origin_agent_id_agents_id_fk: "c",
  decision_bundles_origin_run_id_heartbeat_runs_id_fk: "c",
  decisions_origin_agent_id_agents_id_fk: "c",
  decisions_origin_run_id_heartbeat_runs_id_fk: "c",
  decision_archive_notification_outbox_origin_agent_id_agents_id_fk: "c",
  company_skill_test_runs_agent_id_agents_id_fk: "c",
  // Set null: attribution survives as history.
  approval_comments_author_agent_id_agents_id_fk: "n",
  approvals_requested_by_agent_id_agents_id_fk: "n",
  assets_created_by_agent_id_agents_id_fk: "n",
  goals_owner_agent_id_agents_id_fk: "n",
  projects_lead_agent_id_agents_id_fk: "n",
  routines_assignee_agent_id_agents_id_fk: "n",
  join_requests_created_agent_id_agents_id_fk: "n",
  issue_thread_interactions_created_by_agent_id_agents_id_fk: "n",
  issue_thread_interactions_resolved_by_agent_id_agents_id_fk: "n",
  decision_queues_created_by_agent_id_agents_id_fk: "n",
  decision_queue_items_added_by_agent_id_agents_id_fk: "n",
  decision_triage_set_by_agent_id_agents_id_fk: "n",
  decision_triage_events_actor_agent_id_agents_id_fk: "n",
  decision_retention_archived_by_agent_id_agents_id_fk: "n",
  decision_queues_created_by_run_id_heartbeat_runs_id_fk: "n",
  decision_queue_items_added_by_run_id_heartbeat_runs_id_fk: "n",
  decision_triage_set_by_run_id_heartbeat_runs_id_fk: "n",
  decision_triage_events_actor_run_id_heartbeat_runs_id_fk: "n",
  decision_retention_archived_by_run_id_heartbeat_runs_id_fk: "n",
  decision_queues_created_by_agent_api_key_id_agent_api_keys_id_fk: "n",
  decision_queue_items_added_by_agent_api_key_id_agent_api_keys_id_fk: "n",
  decision_triage_set_by_agent_api_key_id_agent_api_keys_id_fk: "n",
  decision_triage_events_agent_api_key_id_agent_api_keys_id_fk: "n",
  // Pre-existing ON DELETE SET NULL FKs on the same tables (unchanged).
  issue_watchdogs_created_by_agent_id_agents_id_fk: "n",
  issue_watchdogs_created_by_run_id_heartbeat_runs_id_fk: "n",
  issue_watchdogs_updated_by_agent_id_agents_id_fk: "n",
  issue_watchdogs_updated_by_run_id_heartbeat_runs_id_fk: "n",
  routines_created_by_agent_id_agents_id_fk: "n",
  routines_updated_by_agent_id_agents_id_fk: "n",
  issue_thread_interactions_addressee_agent_id_agents_id_fk: "n",
  issue_thread_interactions_resolved_by_run_id_heartbeat_runs_id_fk: "n",
  issue_thread_interactions_source_run_id_heartbeat_runs_id_fk: "n",
};

describeEmbeddedPostgres("agent delete FK policy migration (0222)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let connectionString = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-delete-fk-policies-");
    connectionString = tempDb.connectionString;
    await applyPendingMigrations(connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("gives every remaining agents/heartbeat_runs/agent_api_keys FK on decision, watchdog, and ownership tables a delete policy", async () => {
    const sql = postgres(connectionString, { max: 1 });
    try {
      const tables = [
        "issue_watchdogs",
        "decision_bundles",
        "decisions",
        "decision_archive_notification_outbox",
        "company_skill_test_runs",
        "approval_comments",
        "approvals",
        "assets",
        "goals",
        "projects",
        "routines",
        "join_requests",
        "issue_thread_interactions",
        "decision_queues",
        "decision_queue_items",
        "decision_triage",
        "decision_triage_events",
        "decision_retention",
      ];
      const rows = await sql<FkActionRow[]>`
        SELECT conname, confdeltype, convalidated
        FROM pg_constraint
        WHERE conrelid = ANY (${tables}::regclass[])
          AND contype = 'f'
          AND confrelid = ANY (ARRAY['agents', 'heartbeat_runs', 'agent_api_keys']::regclass[])
        ORDER BY conname
      `;

      // Every FK on these tables must be fully validated. Re-adding an FK with
      // NOT VALID (the online replacement pattern) without a VALIDATE step
      // leaves the constraint enforced-but-unvalidated, which this catches.
      const unvalidated = rows.filter((row) => row.convalidated !== true);
      expect(unvalidated, `FKs left NOT VALID: ${JSON.stringify(unvalidated)}`).toEqual([]);

      expect(rows).toEqual(
        Object.entries(EXPECTED_FK_ACTIONS)
          .map(([conname, confdeltype]) => ({ conname: pgIdent(conname), confdeltype, convalidated: true }))
          .sort((a, b) => (a.conname < b.conname ? -1 : a.conname > b.conname ? 1 : 0)),
      );
    } finally {
      await sql.end();
    }
  });
});

// Staged two-file sequence (SUP-14439): the migration runner applies each
// migration file in ONE transaction, so the ADD phase (write-blocking
// SHARE ROW EXCLUSIVE, released at the file's COMMIT) and the VALIDATE
// phase (SHARE UPDATE EXCLUSIVE, concurrent with writes) must live in
// separate committed migrations: 0222 = ADD NOT VALID only, 0223 =
// VALIDATE / DROP / RENAME.
const migrationStatements = (raw: string) =>
  raw
    .replace(/^--.*$/gm, "")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

const readMigration = (name: string) =>
  readFile(fileURLToPath(new URL(`./migrations/${name}`, import.meta.url)), "utf8");

describe("agent delete FK policy migration (0222/0223) staged static lint", () => {
  it("0222 adds every FK NOT VALID and contains zero VALIDATE/DROP/RENAME statements (those belong to 0223)", async () => {
    const raw = await readMigration("0222_agent_delete_fk_policies.sql");
    const statements = migrationStatements(raw);

    const addPattern = /^ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)" FOREIGN KEY .* NOT VALID;$/;
    const adds = statements.filter((statement) => /ADD CONSTRAINT "[^"]+" FOREIGN KEY /i.test(statement));
    const plainAdds = adds.filter((statement) => !addPattern.test(statement));
    expect(
      plainAdds,
      `plain (write-blocking) ADD CONSTRAINT ... FOREIGN KEY statements found; each must carry NOT VALID:\n${plainAdds.join("\n")}`,
    ).toEqual([]);
    expect(adds).toHaveLength(30);

    for (const statement of adds) {
      const match = statement.match(addPattern);
      expect(match, `ADD statement is not in the <table> ADD <tmp> ... NOT VALID shape: ${statement}`).not.toBeNull();
    }

    // The distinguishing assertion: validation must NOT run inside the
    // ADD-phase transaction. Any VALIDATE here would scan under the
    // write-blocking lock still held by the ADDs.
    const validates = statements.filter((statement) => /^ALTER TABLE "[^"]+" VALIDATE CONSTRAINT /i.test(statement));
    const drops = statements.filter((statement) => /^ALTER TABLE "[^"]+" DROP CONSTRAINT /i.test(statement));
    const renames = statements.filter((statement) => /^ALTER TABLE "[^"]+" RENAME CONSTRAINT /i.test(statement));
    expect(
      [validates.length, drops.length, renames.length],
      `0222 must contain zero VALIDATE/DROP/RENAME statements - they belong to 0223_agent_delete_fk_policies_validate.sql; found VALIDATE=${validates.length} DROP=${drops.length} RENAME=${renames.length}:\n${[...validates, ...drops, ...renames].join("\n")}`,
    ).toEqual([0, 0, 0]);
  });

  it("0223 validates, drops, and renames back every temporary constraint staged in 0222", async () => {
    const [raw0222, raw0223] = await Promise.all([
      readMigration("0222_agent_delete_fk_policies.sql"),
      readMigration("0223_agent_delete_fk_policies_validate.sql"),
    ]);
    const staged = migrationStatements(raw0222)
      .filter((statement) => /ADD CONSTRAINT "[^"]+" FOREIGN KEY /i.test(statement))
      .map((statement) => {
        const match = statement.match(/^ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)" FOREIGN KEY .* NOT VALID;$/);
        expect(match, `0222 ADD statement is not in the staged shape: ${statement}`).not.toBeNull();
        const [, table, tempName] = match as [string, string, string, string];
        return { table, tempName };
      });
    const stagedTempNames = new Set(staged.map(({ tempName }) => tempName));
    expect(stagedTempNames).toHaveLength(30);

    const statements = migrationStatements(raw0223);
    const validates = statements.filter((statement) => /^ALTER TABLE "[^"]+" VALIDATE CONSTRAINT /i.test(statement));
    const drops = statements.filter((statement) => /^ALTER TABLE "[^"]+" DROP CONSTRAINT /i.test(statement));
    const renames = statements.filter((statement) => /^ALTER TABLE "[^"]+" RENAME CONSTRAINT /i.test(statement));
    expect(validates).toHaveLength(30);
    expect(drops).toHaveLength(30);
    expect(renames).toHaveLength(30);
    expect(statements.length).toBe(90);

    const validateNames = new Set<string>();
    for (const statement of validates) {
      const match = statement.match(/^ALTER TABLE "([^"]+)" VALIDATE CONSTRAINT "([^"]+)";$/);
      expect(match, `0223 VALIDATE statement is not in the <table> VALIDATE <tmp> shape: ${statement}`).not.toBeNull();
      const [, table, tempName] = match as [string, string, string, string];
      expect(staged.some(({ table: stagedTable, tempName: stagedTemp }) => stagedTable === table && stagedTemp === tempName), `0223 validates "${tempName}" on "${table}", which 0222 does not stage`).toBe(true);
      validateNames.add(tempName);
    }
    expect(validateNames).toEqual(stagedTempNames);

    const renameTmpNames = new Set<string>();
    for (const statement of renames) {
      const match = statement.match(/^ALTER TABLE "([^"]+)" RENAME CONSTRAINT "([^"]+)" TO "([^"]+)";$/);
      expect(match, `0223 RENAME statement is not in the <table> RENAME <tmp> TO <canonical> shape: ${statement}`).not.toBeNull();
      const [, table, tempName, canonicalName] = match as [string, string, string, string];
      expect(staged.some(({ table: stagedTable, tempName: stagedTemp }) => stagedTable === table && stagedTemp === tempName), `0223 renames "${tempName}" on "${table}", which 0222 does not stage`).toBe(true);
      renameTmpNames.add(tempName);
      expect(statements, `0223 has no DROP of canonical constraint "${canonicalName}" on "${table}"`).toContain(
        `ALTER TABLE "${table}" DROP CONSTRAINT "${canonicalName}";`,
      );
    }
    expect(renameTmpNames).toEqual(stagedTempNames);

    const dropNames = new Set<string>();
    for (const statement of drops) {
      const match = statement.match(/^ALTER TABLE "([^"]+)" DROP CONSTRAINT "([^"]+)";$/);
      expect(match, `0223 DROP statement is not in the <table> DROP <canonical> shape: ${statement}`).not.toBeNull();
      dropNames.add((match as [string, string, string, string])[2]);
    }
    const canonicalNames = new Set<string>();
    for (const statement of renames) {
      canonicalNames.add((statement.match(/^ALTER TABLE "[^"]+" RENAME CONSTRAINT "[^"]+" TO "([^"]+)";$/) as RegExpMatchArray)[1]);
    }
    expect(dropNames).toEqual(canonicalNames);
  });
});
