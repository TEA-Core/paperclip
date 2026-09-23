/**
 * ADR-103 M2a: the parent edge carries its kind. `issues.parent_id` is
 * overloaded — decomposition, programme membership, procedural attachment — and
 * only decomposition is an ADR-072 roll-up signal, so the relation has to be
 * stated on the edge rather than inferred from `parent_id is not null`.
 *
 * The column lands NOT NULL, so the migration cannot guess a kind for a row it
 * did not classify: `'decomposition'` is the DEFAULT so every pre-existing row
 * keeps today's meaning and the done-transition guard stays fail-closed. This
 * suite rewinds the migration, seeds the pre-upgrade rows an existing install
 * would have, and re-applies it — a migration that backfilled or omitted the
 * default fails here, as does one whose CHECK admits anything outside the two
 * declared relations. It also reapplies the raw file to prove it is re-runnable.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { issues } from "./schema/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0290_issue_parent_link_kind.sql";
const CHECK_CONSTRAINT = "issues_parent_link_kind_check";
const COLUMN = "parent_link_kind";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationSql() {
  return fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
}

async function migrationHash() {
  return createHash("sha256").update(await migrationSql()).digest("hex");
}

describe("issue parent link kind schema", () => {
  it("declares a NOT NULL parent_link_kind defaulting to decomposition, guarded by a CHECK", () => {
    const config = getTableConfig(issues);
    const column = config.columns.find((candidate) => candidate.name === COLUMN);
    expect(column).toBeDefined();
    expect(column?.notNull).toBe(true);
    expect(column?.hasDefault).toBe(true);
    expect(column?.default).toBe("decomposition");

    // The CHECK, not convention, is what makes the relation a closed set.
    const check = config.checks.find((candidate) => candidate.name === CHECK_CONSTRAINT);
    expect(check).toBeDefined();
  });
});

describeEmbeddedPostgres("issue parent link kind migration", () => {
  // Reverse registration order, one at a time. The raw `postgres` client is not
  // registered with the module's client registry, so the cluster teardown does
  // not close it. Stopping the cluster while that client is still draining kills
  // the backend socket under a queued write and can crash the runner.
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  it("defaults every pre-upgrade row, rejects out-of-enum kinds, and is re-runnable", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-parent-link-kind-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    // Rewind to the pre-upgrade shape: no column, no CHECK, no applied record.
    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await sql`ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS ${sql(CHECK_CONSTRAINT)}`;
    await sql`ALTER TABLE "issues" DROP COLUMN IF EXISTS ${sql(COLUMN)}`;

    // Seed the rows an existing install would have: an issue with no kind at all.
    const companyId = randomUUID();
    const preExistingIssueId = randomUUID();
    await sql`INSERT INTO "companies" ("id", "name") VALUES (${companyId}, 'Parent Link Co')`;
    await sql`
      INSERT INTO "issues" ("id", "company_id", "title")
      VALUES (${preExistingIssueId}, ${companyId}, 'Pre-upgrade issue')
    `;

    await applyPendingMigrations(database.connectionString);

    // Every existing row kept today's meaning — the DEFAULT did the backfill.
    const [preExisting] = await sql<{ parent_link_kind: string }[]>`
      SELECT "parent_link_kind" FROM "issues" WHERE "id" = ${preExistingIssueId}
    `;
    expect(preExisting?.parent_link_kind).toBe("decomposition");

    const [column] = await sql<{ is_nullable: string; column_default: string | null }[]>`
      SELECT "is_nullable", "column_default" FROM "information_schema"."columns"
      WHERE "table_name" = 'issues' AND "column_name" = ${COLUMN}
    `;
    expect(column?.is_nullable).toBe("NO");
    expect(column?.column_default).toContain("decomposition");

    // An out-of-enum kind is rejected by the database, not by convention.
    await expect(
      sql`
        INSERT INTO "issues" ("id", "company_id", "title", "parent_link_kind")
        VALUES (${randomUUID()}, ${companyId}, 'Bad kind', 'delivery')
      `,
    ).rejects.toMatchObject({ code: "23514", constraint_name: CHECK_CONSTRAINT });

    // The other declared relation is accepted.
    await sql`
      INSERT INTO "issues" ("id", "company_id", "title", "parent_link_kind")
      VALUES (${randomUUID()}, ${companyId}, 'Process child', 'process')
    `;

    // A row that omits the column still lands on the default.
    const implicitId = randomUUID();
    await sql`
      INSERT INTO "issues" ("id", "company_id", "title")
      VALUES (${implicitId}, ${companyId}, 'Implicit kind')
    `;
    const [implicit] = await sql<{ parent_link_kind: string }[]>`
      SELECT "parent_link_kind" FROM "issues" WHERE "id" = ${implicitId}
    `;
    expect(implicit?.parent_link_kind).toBe("decomposition");

    // Forward-only and re-runnable: the raw file applied a second time is a
    // no-op, because ADD COLUMN IF NOT EXISTS and the duplicate_object guard
    // absorb the table already being in the target shape.
    const statements = (await migrationSql())
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
    const [stillThere] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM "issues"
      WHERE "id" = ${preExistingIssueId} AND "parent_link_kind" = 'decomposition'
    `;
    expect(stillThere?.count).toBe("1");
  }, 30_000);
});