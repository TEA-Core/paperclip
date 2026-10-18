/**
 * SUP-20246: governed existing-PR delivery-receipt recovery — persistence
 * foundation only (plan SUP-20244). Two brand-new tables; nothing existing is
 * altered, so the rewind here is a raw-file replay check plus constraint
 * enforcement proved against a real database, not a data migration.
 *
 * The receipt is the single-use authority binding a card to an exact live PR
 * head. What makes it trustworthy is database-enforced, not service-enforced:
 * a canonical unique index so a second receipt for the same card/PR/head
 * cannot exist, a separate (companyId, idempotencyKey) unique index so a retry
 * replays or fails instead of forking, a closed state CHECK, and a dedicated
 * link table whose foreign keys are required. Ordinary `external_object_mentions`
 * rows stay citation-only and can never satisfy the link relation — the link's
 * FK targets `external_objects` and `issue_delivery_receipts`, not mentions —
 * and deleting the linked external object is RESTRICTed so recovery provenance
 * outlives display-record cleanup. This suite asserts each of those in the
 * database itself.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { issueDeliveryReceiptLinks } from "./schema/issue_delivery_receipt_links.js";
import { issueDeliveryReceipts } from "./schema/issue_delivery_receipts.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0298_issue_delivery_receipts.sql";
const RECEIPTS = "issue_delivery_receipts";
const LINKS = "issue_delivery_receipt_links";
const HEAD_SHA = "a".repeat(40);
const OTHER_HEAD_SHA = "b".repeat(40);

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationSql() {
  return fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
}

async function migrationHash() {
  return createHash("sha256").update(await migrationSql()).digest("hex");
}

type IndexRow = {
  indexname: string;
  indexdef: string;
};

type FkRow = {
  fk_name: string;
  column_name: string;
  foreign_table: string;
  on_delete: string;
};

async function uniqueIndexes(sql: postgres.Sql, table: string): Promise<Map<string, IndexRow>> {
  const rows = await sql<{ indexname: string; indexdef: string }[]>`
    SELECT "indexname", "indexdef" FROM "pg_indexes"
    WHERE "schemaname" = 'public' AND "tablename" = ${table}
  `;
  return new Map(
    rows
      .filter((row) => row.indexdef.toUpperCase().includes("UNIQUE"))
      .map((row) => [row.indexname, row] as const),
  );
}

async function foreignKeys(sql: postgres.Sql, table: string): Promise<Map<string, FkRow>> {
  const rows = await sql<{
    fk_name: string;
    column_name: string;
    foreign_table: string;
    on_delete: string;
  }[]>`
    SELECT
      "rc"."constraint_name" AS fk_name,
      "kcu"."column_name" AS column_name,
      "ccu"."table_name" AS foreign_table,
      "rc"."delete_rule" AS on_delete
    FROM "information_schema"."referential_constraints" AS "rc"
    JOIN "information_schema"."key_column_usage" AS "kcu"
      ON "kcu"."constraint_name" = "rc"."constraint_name" AND "kcu"."table_name" = ${table}
    JOIN "information_schema"."constraint_column_usage" AS "ccu"
      ON "ccu"."constraint_name" = "rc"."constraint_name" AND "ccu"."table_name" <> ${table}
    WHERE "kcu"."table_schema" = 'public'
  `;
  return new Map(rows.map((row) => [row.fk_name, row] as const));
}

async function insertCompanyAndIssue(sql: postgres.Sql) {
  const companyId = randomUUID();
  const issueId = randomUUID();
  await sql`INSERT INTO "companies" ("id", "name") VALUES (${companyId}, 'Delivery Receipt Co')`;
  await sql`
    INSERT INTO "issues" ("id", "company_id", "title")
    VALUES (${issueId}, ${companyId}, 'Delivery receipt card')
  `;
  return { companyId, issueId };
}

async function insertExternalObject(sql: postgres.Sql, companyId: string, externalId: string) {
  const objectId = randomUUID();
  await sql`
    INSERT INTO "external_objects" ("id", "company_id", "provider_key", "object_type", "external_id")
    VALUES (${objectId}, ${companyId}, 'github', 'pull_request', ${externalId})
  `;
  return objectId;
}

async function insertReceipt(
  sql: postgres.Sql,
  overrides: {
    companyId: string;
    sourceIssueId: string;
    idempotencyKey: string;
    headSha?: string;
    pullRequestNumber?: number;
  },
) {
  const receiptId = randomUUID();
  await sql`
    INSERT INTO ${sql(RECEIPTS)} (
      "id", "company_id", "source_issue_id", "provider", "owner", "repo",
      "pull_request_number", "head_sha", "branch_name", "recovery_reason",
      "authorized_by_actor_type", "authorized_by_actor_id", "idempotency_key"
    )
    VALUES (
      ${receiptId}, ${overrides.companyId}, ${overrides.sourceIssueId}, 'github',
      'acme', 'widgets', ${overrides.pullRequestNumber ?? 579},
      ${overrides.headSha ?? HEAD_SHA}, 'SUP-579-branch', 'approved PR head lost its status write',
      'board', 'board-actor', ${overrides.idempotencyKey}
    )
  `;
  return receiptId;
}

describe("delivery receipt schema exports", () => {
  it("declares the closed receipt state set and both dedicated tables", () => {
    const receipts = getTableConfig(issueDeliveryReceipts);
    expect(receipts.name).toBe(RECEIPTS);
    const links = getTableConfig(issueDeliveryReceiptLinks);
    expect(links.name).toBe(LINKS);

    const state = getTableConfig(issueDeliveryReceipts).columns.find((c) => c.name === "state");
    expect(state?.notNull).toBe(true);
    expect(state?.hasDefault).toBe(true);
    expect(state?.default).toBe("ready");
  });
});

describeEmbeddedPostgres("delivery receipt migration", () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  it(
    "applies cleanly, enforces canonical/idempotency uniqueness and FKs, keeps mentions out of the relation, and is re-runnable",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-delivery-receipt-");
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1 });
      cleanups.push(async () => sql.end());

      // The migration is already applied by the test-database bootstrap; prove
      // the raw file is re-runnable statement-by-statement (IF NOT EXISTS /
      // duplicate_object guards absorb the target shape).
      const statements = (await migrationSql())
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);
      for (const statement of statements) {
        await sql.unsafe(statement);
      }

      // Rewind the ledger and re-apply through the product migrator so the
      // accepted evidence is "the migration applies cleanly", not just
      // "the file parses".
      await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
      await sql`DROP TABLE IF EXISTS ${sql(LINKS)} CASCADE`;
      await sql`DROP TABLE IF EXISTS ${sql(RECEIPTS)} CASCADE`;
      await applyPendingMigrations(database.connectionString);
      const [ledgerRow] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}
      `;
      expect(ledgerRow?.count).toBe("1");

      // --- Declared unique indexes exist and carry the exact column lists. ---
      const receiptIndexes = await uniqueIndexes(sql, RECEIPTS);
      expect(receiptIndexes.has(`${RECEIPTS}_canonical_uq`)).toBe(true);
      expect(receiptIndexes.get(`${RECEIPTS}_canonical_uq`)?.indexdef).toContain(
        '(company_id, source_issue_id, provider, owner, repo, pull_request_number, head_sha)',
      );
      expect(receiptIndexes.has(`${RECEIPTS}_company_idempotency_uq`)).toBe(true);
      expect(receiptIndexes.get(`${RECEIPTS}_company_idempotency_uq`)?.indexdef).toContain(
        '(company_id, idempotency_key)',
      );

      const linkIndexes = await uniqueIndexes(sql, LINKS);
      expect(linkIndexes.has(`${LINKS}_company_receipt_uq`)).toBe(true);
      expect(linkIndexes.get(`${LINKS}_company_receipt_uq`)?.indexdef).toContain('(company_id, receipt_id)');
      expect(linkIndexes.has(`${LINKS}_company_source_object_head_uq`)).toBe(true);
      expect(linkIndexes.get(`${LINKS}_company_source_object_head_uq`)?.indexdef).toContain(
        '(company_id, source_issue_id, external_object_id, head_sha)',
      );
      const [lookupIdx] = await sql<{ indexdef: string }[]>`
        SELECT "indexdef" FROM "pg_indexes"
        WHERE "schemaname" = 'public' AND "tablename" = ${LINKS} AND "indexname" = ${LINKS + "_lookup_idx"}
      `;
      expect(lookupIdx?.indexdef).toContain(
        '(company_id, source_issue_id, provider, owner, repo, pull_request_number, head_sha)',
      );

      // --- Foreign keys and their delete actions. ---
      const receiptFks = await foreignKeys(sql, RECEIPTS);
      expect(receiptFks.get(`${RECEIPTS}_company_id_companies_id_fk`)).toMatchObject({
        column_name: "company_id",
        foreign_table: "companies",
        on_delete: "CASCADE",
      });
      expect(receiptFks.get(`${RECEIPTS}_source_issue_id_issues_id_fk`)).toMatchObject({
        column_name: "source_issue_id",
        foreign_table: "issues",
        on_delete: "CASCADE",
      });
      expect(receiptFks.get(`${RECEIPTS}_source_run_id_heartbeat_runs_id_fk`)).toMatchObject({
        column_name: "source_run_id",
        foreign_table: "heartbeat_runs",
        on_delete: "SET NULL",
      });
      // Postgres silently truncates the drizzle-generated name for
      // `authorized_by_run_id` to 63 bytes; match by column instead.
      const authorizedByRunFk = [...receiptFks.values()].find((row) => row.column_name === "authorized_by_run_id");
      expect(authorizedByRunFk).toMatchObject({
        foreign_table: "heartbeat_runs",
        on_delete: "SET NULL",
      });

      const linkFks = await foreignKeys(sql, LINKS);
      // Truncated 63-byte drizzle name; match by column instead.
      const receiptLinkFk = [...linkFks.values()].find((row) => row.column_name === "receipt_id");
      expect(receiptLinkFk).toMatchObject({
        foreign_table: RECEIPTS,
        on_delete: "CASCADE",
      });
      expect(linkFks.get(`${LINKS}_source_issue_id_issues_id_fk`)).toMatchObject({
        column_name: "source_issue_id",
        foreign_table: "issues",
        on_delete: "CASCADE",
      });
      expect(linkFks.get(`${LINKS}_company_id_companies_id_fk`)).toMatchObject({
        column_name: "company_id",
        foreign_table: "companies",
        on_delete: "CASCADE",
      });
      // Provenance over convenience: the link must outlive a display cleanup.
      // Truncated 63-byte drizzle name; match by column instead.
      const externalObjectFk = [...linkFks.values()].find((row) => row.column_name === "external_object_id");
      expect(externalObjectFk).toMatchObject({
        foreign_table: "external_objects",
        on_delete: "RESTRICT",
      });

      const { companyId, issueId } = await insertCompanyAndIssue(sql);
      const objectId = await insertExternalObject(sql, companyId, "acme/widgets#579");

      // --- Happy path: one receipt + one dedicated link. ---
      const receiptId = await insertReceipt(sql, { companyId, sourceIssueId: issueId, idempotencyKey: "idem-1" });
      await sql`
        INSERT INTO ${sql(LINKS)} (
          "company_id", "receipt_id", "source_issue_id", "external_object_id",
          "provider", "owner", "repo", "pull_request_number", "head_sha"
        )
        VALUES (
          ${companyId}, ${receiptId}, ${issueId}, ${objectId},
          'github', 'acme', 'widgets', 579, ${HEAD_SHA}
        )
      `;

      // Omitting state lands on the 'ready' default.
      const [receipt] = await sql<{ state: string }[]>`
        SELECT "state" FROM ${sql(RECEIPTS)} WHERE "id" = ${receiptId}
      `;
      expect(receipt?.state).toBe("ready");

      // --- Conflicting canonical receipt insert fails. ---
      await expect(
        insertReceipt(sql, { companyId, sourceIssueId: issueId, idempotencyKey: "idem-2" }),
      ).rejects.toMatchObject({ code: "23505", constraint_name: `${RECEIPTS}_canonical_uq` });

      // --- Conflicting (companyId, idempotencyKey) insert fails even with a
      // different canonical tuple (different PR number here). ---
      await expect(
        insertReceipt(sql, {
          companyId,
          sourceIssueId: issueId,
          idempotencyKey: "idem-1",
          pullRequestNumber: 580,
        }),
      ).rejects.toMatchObject({ code: "23505", constraint_name: `${RECEIPTS}_company_idempotency_uq` });

      // A different head for the same card/PR is a different canonical tuple.
      const secondReceiptId = await insertReceipt(sql, {
        companyId,
        sourceIssueId: issueId,
        idempotencyKey: "idem-3",
        headSha: OTHER_HEAD_SHA,
      });
      expect(secondReceiptId).not.toBe(receiptId);

      // --- State CHECK is a closed set. ---
      await expect(
        sql`UPDATE ${sql(RECEIPTS)} SET "state" = 'published' WHERE "id" = ${secondReceiptId}`,
      ).rejects.toMatchObject({ code: "23514" });

      // --- Link FKs are required, not optional. Each probe uses a canonical
      // tuple that cannot collide, so the FK is what the database reports:
      // PostgreSQL checks unique indexes on insert and triggers on FK, so a
      // duplicate row would otherwise mask the missing reference. ---
      const insertLinkRaw = (values: {
        receiptId: string;
        externalObjectId: string;
        headSha: string;
      }) => sql`
        INSERT INTO ${sql(LINKS)} (
          "company_id", "receipt_id", "source_issue_id", "external_object_id",
          "provider", "owner", "repo", "pull_request_number", "head_sha"
        )
        VALUES (
          ${companyId}, ${values.receiptId}, ${issueId}, ${values.externalObjectId},
          'github', 'acme', 'widgets', 579, ${values.headSha}
        )
      `;

      // Missing receipt.
      await expect(
        insertLinkRaw({ receiptId: randomUUID(), externalObjectId: objectId, headSha: "c".repeat(40) }),
      ).rejects.toMatchObject({ code: "23503" });
      // Missing external object.
      await expect(
        insertLinkRaw({ receiptId: secondReceiptId, externalObjectId: randomUUID(), headSha: "d".repeat(40) }),
      ).rejects.toMatchObject({ code: "23503" });
      // Missing source issue.
      await expect(
        sql`
          INSERT INTO ${sql(LINKS)} (
            "company_id", "receipt_id", "source_issue_id", "external_object_id",
            "provider", "owner", "repo", "pull_request_number", "head_sha"
          )
          VALUES (
            ${companyId}, ${secondReceiptId}, ${randomUUID()}, ${objectId},
            'github', 'acme', 'widgets', 579, ${"e".repeat(40)}
          )
        `,
      ).rejects.toMatchObject({ code: "23503" });

      // --- Canonical receipt uniqueness on the link: one link per receipt,
      // even when the repeated coordinates and head differ. ---
      await expect(
        insertLinkRaw({ receiptId: receiptId, externalObjectId: objectId, headSha: "f".repeat(40) }),
      ).rejects.toMatchObject({ code: "23505", constraint_name: `${LINKS}_company_receipt_uq` });

      // --- A normal external_object_mentions row cannot satisfy the relation. ---
      // It is citation-only: the link FK targets external_objects and
      // issue_delivery_receipts, never mentions, so a mention id as the
      // external object id is a missing-reference violation.
      const mentionId = randomUUID();
      await sql`
        INSERT INTO "external_object_mentions" ("id", "company_id", "source_issue_id", "source_kind", "object_id")
        VALUES (${mentionId}, ${companyId}, ${issueId}, 'description', ${objectId})
      `;
      await expect(
        insertLinkRaw({ receiptId: secondReceiptId, externalObjectId: mentionId, headSha: "1".repeat(40) }),
      ).rejects.toMatchObject({ code: "23503" });
      // The link relation is unaffected by mention rows: still exactly one.
      const [linkCount] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ${sql(LINKS)}
      `;
      expect(linkCount?.count).toBe("1");

      // Deleting the linked external object is restricted while the link lives.
      // ON DELETE RESTRICT reports 23001 (restrict_violation), not 23503.
      await expect(sql`DELETE FROM "external_objects" WHERE "id" = ${objectId}`).rejects.toMatchObject({
        code: "23001",
      });

      // --- No secret or token columns beyond the sanctioned claim token. ---
      const receiptColumns = await sql<{ column_name: string }[]>`
        SELECT "column_name" FROM "information_schema"."columns"
        WHERE "table_schema" = 'public' AND "table_name" = ${RECEIPTS}
      `;
      const secretish = receiptColumns
        .map((row) => row.column_name)
        .filter((name) => /secret|pat\b|github_token|credential/i.test(name));
      expect(secretish).toEqual([]);
    },
    120_000,
  );
});
