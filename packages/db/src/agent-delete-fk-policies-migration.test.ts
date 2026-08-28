import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

type FkActionRow = { conname: string; confdeltype: string };

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
        SELECT conname, confdeltype
        FROM pg_constraint
        WHERE conrelid = ANY (${tables}::regclass[])
          AND contype = 'f'
          AND confrelid = ANY (ARRAY['agents', 'heartbeat_runs', 'agent_api_keys']::regclass[])
        ORDER BY conname
      `;

      expect(rows).toEqual(
        Object.entries(EXPECTED_FK_ACTIONS)
          .map(([conname, confdeltype]) => ({ conname: pgIdent(conname), confdeltype }))
          .sort((a, b) => (a.conname < b.conname ? -1 : a.conname > b.conname ? 1 : 0)),
      );
    } finally {
      await sql.end();
    }
  });
});
