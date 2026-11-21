import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const migration = await readFile(new URL("./migrations/0331_board_recovery_carrier_park.sql", import.meta.url), "utf8");

describePostgres("board recovery carrier park migration", () => {
  it("upgrades an existing ordinary hold without rewriting rows or inferring consent", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-carrier-park-migration-");
    const query = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const companyId = randomUUID(), issueId = randomUUID(), holdId = randomUUID();
      await query`insert into companies (id, name, issue_prefix) values (${companyId}, 'Migration fixture', 'MIGP')`;
      await query`insert into issues (id, company_id, title, status) values (${issueId}, ${companyId}, 'Ordinary paused task', 'blocked')`;
      await query`insert into issue_tree_holds (id, company_id, root_issue_id, mode, release_policy) values (${holdId}, ${companyId}, ${issueId}, 'pause', '{"strategy":"manual"}')`;
      // Fresh database applied the migration. Reconstruct the prior schema in
      // this disposable fixture to exercise the existing-row upgrade as well.
      await query`alter table issue_tree_holds drop column recovery_carrier_park`;
      const [before] = await query`select to_jsonb(h) as row, xmin::text, ctid::text, pg_relation_filenode('issue_tree_holds'::regclass)::text as storage from issue_tree_holds h where id = ${holdId}`;
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await query.unsafe(statement);
      }
      const [after] = await query`select to_jsonb(h) - 'recovery_carrier_park' as row, xmin::text, ctid::text, pg_relation_filenode('issue_tree_holds'::regclass)::text as storage, recovery_carrier_park from issue_tree_holds h where id = ${holdId}`;
      expect(after).toEqual({ ...before, recovery_carrier_park: null });
      const [column] = await query`select is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'issue_tree_holds' and column_name = 'recovery_carrier_park'`;
      expect(column).toEqual({ is_nullable: "YES", column_default: null });
      const [index] = await query`select indisvalid, indisready from pg_index where indexrelid = 'issue_tree_holds_active_park_action_idx'::regclass`;
      expect(index).toEqual({ indisvalid: true, indisready: true });
    } finally {
      await query.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
