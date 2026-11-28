import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const previousMigration = await readFile(new URL("./migrations/0333_issue_monitor_recovery_claims.sql", import.meta.url), "utf8");
const migration = await readFile(new URL("./migrations/0335_issue_monitor_arm_generation_bigint.sql", import.meta.url), "utf8");
const statements = (sql: string) => sql.split("--> statement-breakpoint").filter((statement) => statement.trim());

describePostgres("issue monitor arm generation bigint migration", () => {
  it("keeps every arm generation, widens it past 32 bits and prunes superseded claims", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-arm-generation-migration-");
    const query = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      // Fresh database applied the migration. Reconstruct the 0333 schema in this
      // disposable fixture to exercise the upgrade of existing rows.
      await query`alter table issues drop column monitor_arm_generation`;
      await query`alter table issues add column monitor_arm_generation integer default 0 not null`;
      await query`alter table issue_monitor_recovery_claims alter column arm_generation type integer`;
      const previousFunction = statements(previousMigration).find((statement) => statement.includes("CREATE FUNCTION"))!;
      await query.unsafe(previousFunction.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"));

      const companyId = randomUUID();
      const [neverArmed, armed, atLimit] = [randomUUID(), randomUUID(), randomUUID()];
      await query`insert into companies (id, name, issue_prefix) values (${companyId}, 'Migration fixture', 'MIGA')`;
      await query`insert into issues (id, company_id, title) values
        (${neverArmed}, ${companyId}, 'Never armed'), (${armed}, ${companyId}, 'Armed'), (${atLimit}, ${companyId}, 'At limit')`;
      // Not an arm (no monitor_next_check_at), so the 0333 trigger keeps these values.
      await query`update issues set monitor_arm_generation = 7 where id = ${armed}`;
      await query`update issues set monitor_arm_generation = 2147483647 where id = ${atLimit}`;
      await query`insert into issue_monitor_recovery_claims (company_id, issue_id, arm_generation, clear_reason, scheduled_at, recovery_policy)
        values (${companyId}, ${armed}, 6, 'max_attempts_exhausted', now(), 'wake_owner'),
          (${companyId}, ${armed}, 7, 'max_attempts_exhausted', now(), 'wake_owner')`;

      for (const statement of statements(migration)) await query.unsafe(statement);

      const columns = await query`select table_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and ((table_name = 'issues' and column_name = 'monitor_arm_generation')
          or (table_name = 'issue_monitor_recovery_claims' and column_name = 'arm_generation'))
        order by table_name`;
      expect(columns).toEqual([
        { table_name: "issue_monitor_recovery_claims", data_type: "bigint", is_nullable: "NO", column_default: null },
        { table_name: "issues", data_type: "bigint", is_nullable: "NO", column_default: "0" },
      ]);
      const generations = async () =>
        Object.fromEntries(
          (await query<{ id: string; generation: string }[]>`select id, monitor_arm_generation::text as generation from issues where company_id = ${companyId}`)
            .map((row) => [row.id, row.generation]),
        );
      expect(await generations()).toEqual({ [neverArmed]: "0", [armed]: "7", [atLimit]: "2147483647" });
      const claimGenerations = async () =>
        (await query<{ generation: string }[]>`select arm_generation::text as generation from issue_monitor_recovery_claims where issue_id = ${armed} order by arm_generation`)
          .map((row) => row.generation);
      expect(await claimGenerations()).toEqual(["7"]);

      // A write that does not arm keeps the current claim; an arm prunes it.
      await query`update issues set title = 'Armed (renamed)' where id = ${armed}`;
      expect(await claimGenerations()).toEqual(["7"]);
      await query`update issues set monitor_next_check_at = now() + interval '1 hour' where id in (${armed}, ${atLimit})`;
      expect(await generations()).toEqual({ [neverArmed]: "0", [armed]: "8", [atLimit]: "2147483648" });
      expect(await claimGenerations()).toEqual([]);
    } finally {
      await query.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
