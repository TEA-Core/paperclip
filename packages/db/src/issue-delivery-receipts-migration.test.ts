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
 * database itself. The generated 0329 follow-up tightens both head_sha CHECKs
 * from 40-64 to exactly 40 lowercase hex characters; the second case proves a
 * database that already ran 0298 converges on the fresh-install definitions.
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
// 0298 shipped `head_sha ~ '^[0-9a-f]{40,64}$'`, and databases that already ran
// it keep that text. 0329 is the generated follow-up that tightens both tables
// to exactly 40 lowercase hex characters on every install.
const TIGHTEN_MIGRATION_FILE = "0329_cooing_thor.sql";
const RECEIPTS = "issue_delivery_receipts";
const LINKS = "issue_delivery_receipt_links";
const HEAD_SHA = "a".repeat(40);
const OTHER_HEAD_SHA = "b".repeat(40);
const HEAD_SHA_CHECKS = [`${LINKS}_head_sha_check`, `${RECEIPTS}_head_sha_check`];

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationSql(file = MIGRATION_FILE) {
  return fs.promises.readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8");
}

async function migrationHash(file = MIGRATION_FILE) {
  return createHash("sha256").update(await migrationSql(file)).digest("hex");
}

async function migrationStatements(file: string) {
  return (await migrationSql(file))
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function ledgerCount(sql: postgres.Sql, file: string) {
  const [row] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash(file)}
  `;
  return row?.count;
}

// Every CHECK on either table that references head_sha, whatever its name, so
// a leftover loose check under another name shows up in the comparison.
async function headShaChecks(sql: postgres.Sql) {
  return sql<{ table_name: string; conname: string; def: string; validated: boolean }[]>`
    SELECT "c"."conrelid"::regclass::text AS table_name, "c"."conname", pg_get_constraintdef("c"."oid") AS def,
      "c"."convalidated" AS validated
    FROM "pg_constraint" AS "c"
    JOIN "pg_class" AS "t" ON "t"."oid" = "c"."conrelid"
    JOIN "pg_namespace" AS "n" ON "n"."oid" = "t"."relnamespace"
    JOIN "pg_attribute" AS "a" ON "a"."attrelid" = "c"."conrelid" AND "a"."attnum" = ANY ("c"."conkey")
    WHERE "c"."contype" = 'c' AND "n"."nspname" = 'public' AND "t"."relname" IN (${RECEIPTS}, ${LINKS}) AND "a"."attname" = 'head_sha'
    ORDER BY "c"."conname"
  `;
}

async function releaseAssuranceChecks(sql: postgres.Sql) {
  return sql<{ conname: string; def: string; validated: boolean }[]>`
    SELECT "c"."conname", pg_get_constraintdef("c"."oid") AS def, "c"."convalidated" AS validated
    FROM "pg_constraint" AS "c"
    JOIN "pg_class" AS "t" ON "t"."oid" = "c"."conrelid"
    JOIN "pg_namespace" AS "n" ON "n"."oid" = "t"."relnamespace"
    WHERE "c"."contype" = 'c' AND "n"."nspname" = 'public' AND "t"."relname" = 'release_assurance_events'
    ORDER BY "c"."conname"
  `;
}

async function headShaNullable(sql: postgres.Sql) {
  const rows = await sql<{ table_name: string; is_nullable: string }[]>`
    SELECT "table_name", "is_nullable" FROM "information_schema"."columns"
    WHERE "table_schema" = 'public' AND "table_name" IN (${RECEIPTS}, ${LINKS}) AND "column_name" = 'head_sha'
    ORDER BY "table_name"
  `;
  return rows.map((row) => row.is_nullable);
}

async function tableRows(sql: postgres.Sql) {
  return {
    receipts: await sql`SELECT "id", "head_sha" FROM ${sql(RECEIPTS)} ORDER BY "id"`,
    links: await sql`SELECT "id", "head_sha" FROM ${sql(LINKS)} ORDER BY "id"`,
  };
}

// Recreate the shape of a database that ran 0298 but not 0329. 0298's text is
// unchanged, so its raw statements rebuild the {40,64} checks.
async function rewindToLegacy0298(sql: postgres.Sql) {
  await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash(TIGHTEN_MIGRATION_FILE)}`;
  await sql`DROP TABLE IF EXISTS ${sql(LINKS)} CASCADE`;
  await sql`DROP TABLE IF EXISTS ${sql(RECEIPTS)} CASCADE`;
  for (const statement of await migrationStatements(MIGRATION_FILE)) {
    await sql.unsafe(statement);
  }
}

async function insertLink(
  sql: postgres.Sql,
  values: { companyId: string; receiptId: string; issueId: string; objectId: string; headSha: string },
) {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO ${sql(LINKS)} (
      "company_id", "receipt_id", "source_issue_id", "external_object_id",
      "provider", "owner", "repo", "pull_request_number", "head_sha"
    )
    VALUES (
      ${values.companyId}, ${values.receiptId}, ${values.issueId}, ${values.objectId},
      'github', 'acme', 'widgets', 579, ${values.headSha}
    )
    RETURNING "id"
  `;
  return row!.id;
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
      for (const statement of await migrationStatements(MIGRATION_FILE)) {
        await sql.unsafe(statement);
      }

      // Rewind the ledger and re-apply through the product migrator so the
      // accepted evidence is "the migration applies cleanly", not just
      // "the file parses". The 0329 tightening is rewound with it: it alters
      // the tables 0298 creates, so 0298 alone would recreate the old shape.
      await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
      await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash(TIGHTEN_MIGRATION_FILE)}`;
      await sql`DROP TABLE IF EXISTS ${sql(LINKS)} CASCADE`;
      await sql`DROP TABLE IF EXISTS ${sql(RECEIPTS)} CASCADE`;
      await applyPendingMigrations(database.connectionString);
      expect(await ledgerCount(sql, MIGRATION_FILE)).toBe("1");
      expect(await ledgerCount(sql, TIGHTEN_MIGRATION_FILE)).toBe("1");

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
      const [validatedReceipt] = await sql<{ head_sha: string }[]>`
        SELECT "head_sha" FROM ${sql(RECEIPTS)} WHERE "id" = ${receiptId}
      `;
      expect(validatedReceipt?.head_sha).toMatch(/^[0-9a-f]{40}$/);
      for (const [label, headSha] of [
        ["39", "a".repeat(39)],
        ["41", "a".repeat(41)],
        ["64", "a".repeat(64)],
        ["40-upper", "A".repeat(40)],
        ["40-mixed", `F${"a".repeat(39)}`],
      ] as const) {
        await expect(
          insertReceipt(sql, {
            companyId,
            sourceIssueId: issueId,
            idempotencyKey: `invalid-head-${label}`,
            headSha,
          }),
        ).rejects.toMatchObject({ code: "23514", constraint_name: `${RECEIPTS}_head_sha_check` });
      }

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

      for (const [label, headSha, receiptHeadSha] of [
        ["39", "a".repeat(39), "2".repeat(40)],
        ["41", "a".repeat(41), "3".repeat(40)],
        ["64", "a".repeat(64), "4".repeat(40)],
        ["40-upper", "A".repeat(40), "5".repeat(40)],
        ["40-mixed", `F${"a".repeat(39)}`, "6".repeat(40)],
      ] as const) {
        const boundaryReceiptId = await insertReceipt(sql, {
          companyId,
          sourceIssueId: issueId,
          idempotencyKey: `invalid-link-head-${label}`,
          headSha: receiptHeadSha,
        });
        await expect(insertLinkRaw({ receiptId: boundaryReceiptId, externalObjectId: objectId, headSha })).rejects.toMatchObject({
          code: "23514",
          constraint_name: `${LINKS}_head_sha_check`,
        });
      }

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

  it(
    "tightens a database that already ran 0298 to the fresh-install head_sha checks without touching rows",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-delivery-receipt-upgrade-");
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1 });
      cleanups.push(async () => sql.end());

      // A fresh install runs 0298 and 0329 in order.
      const fresh = await headShaChecks(sql);
      expect(fresh.map((row) => row.conname)).toEqual(HEAD_SHA_CHECKS);
      for (const row of fresh) {
        expect(row.def).toContain("'^[0-9a-f]{40}$'");
        expect(row.validated).toBe(true);
      }

      await rewindToLegacy0298(sql);
      expect(await ledgerCount(sql, MIGRATION_FILE)).toBe("1");
      expect(await ledgerCount(sql, TIGHTEN_MIGRATION_FILE)).toBe("0");
      for (const row of await headShaChecks(sql)) {
        expect(row.def).toContain("'^[0-9a-f]{40,64}$'");
      }

      // Happy path: one valid receipt and its link.
      const { companyId, issueId } = await insertCompanyAndIssue(sql);
      const objectId = await insertExternalObject(sql, companyId, "acme/widgets#579");
      const validReceiptId = await insertReceipt(sql, { companyId, sourceIssueId: issueId, idempotencyKey: "legacy-valid" });
      await insertLink(sql, { companyId, receiptId: validReceiptId, issueId, objectId, headSha: HEAD_SHA });
      const rowsBefore = await tableRows(sql);

      // A loose head_sha check recreated under another name (for example by a
      // backup tool) must not survive next to the exact one.
      await sql`
        ALTER TABLE ${sql(RECEIPTS)} ADD CONSTRAINT "legacy_receipts_head_sha_loose"
        CHECK ("head_sha" ~ '^[0-9a-f]{40,64}$')
      `;
      await sql`
        ALTER TABLE ${sql(LINKS)} ADD CONSTRAINT "legacy_links_head_sha_loose"
        CHECK ("head_sha" ~ '^[0-9a-fA-F]{40,64}$')
      `;

      await applyPendingMigrations(database.connectionString);
      expect(await ledgerCount(sql, TIGHTEN_MIGRATION_FILE)).toBe("1");
      expect(await headShaChecks(sql)).toEqual(fresh);
      expect(await tableRows(sql)).toEqual(rowsBefore);

      // Re-running the migrator is a no-op: one ledger row, same checks.
      await applyPendingMigrations(database.connectionString);
      expect(await ledgerCount(sql, TIGHTEN_MIGRATION_FILE)).toBe("1");
      expect(await headShaChecks(sql)).toEqual(fresh);

      // Re-running 0329's raw statements is also safe on the tightened tables.
      for (const statement of await migrationStatements(TIGHTEN_MIGRATION_FILE)) {
        await sql.unsafe(statement);
      }
      expect(await headShaChecks(sql)).toEqual(fresh);
      expect(await tableRows(sql)).toEqual(rowsBefore);

      await expect(
        insertReceipt(sql, { companyId, sourceIssueId: issueId, idempotencyKey: "post-upgrade-41", headSha: "d".repeat(41) }),
      ).rejects.toMatchObject({ code: "23514", constraint_name: `${RECEIPTS}_head_sha_check` });
    },
    120_000,
  );

  it(
    "refuses each non-conforming legacy head_sha with a named pre-flight error and changes nothing",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-delivery-receipt-preflight-");
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1 });
      cleanups.push(async () => sql.end());
      const fresh = await headShaChecks(sql);

      await rewindToLegacy0298(sql);
      const { companyId, issueId } = await insertCompanyAndIssue(sql);
      const objectId = await insertExternalObject(sql, companyId, "acme/widgets#579");
      const validReceiptId = await insertReceipt(sql, { companyId, sourceIssueId: issueId, idempotencyKey: "valid" });
      await insertLink(sql, { companyId, receiptId: validReceiptId, issueId, objectId, headSha: HEAD_SHA });

      const expectBlocked = async (table: string, offendingIds: string[], hiddenValue: string) => {
        const checksBefore = await headShaChecks(sql);
        const rowsBefore = await tableRows(sql);
        const error = await applyPendingMigrations(database.connectionString).then(
          () => null,
          (caught: unknown) => caught as { code?: string; message?: string },
        );
        expect(error?.code).toBe("23514");
        expect(error?.message).toMatch(/^0329_head_sha_preflight: /);
        expect(error?.message).toContain(`${table}: ${offendingIds.length} row(s)`);
        for (const id of offendingIds) expect(error?.message).toContain(id);
        if (hiddenValue) expect(error?.message).not.toContain(hiddenValue);
        expect(await ledgerCount(sql, TIGHTEN_MIGRATION_FILE)).toBe("0");
        expect(await headShaChecks(sql)).toEqual(checksBefore);
        expect(await tableRows(sql)).toEqual(rowsBefore);
      };

      // 41 and 64 characters pass the 0298 checks, so these rows can exist on a
      // database that only ran 0298.
      for (const [label, headSha] of [["41", "c".repeat(41)], ["64", "d".repeat(64)]] as const) {
        const receiptId = await insertReceipt(sql, { companyId, sourceIssueId: issueId, idempotencyKey: `receipt-${label}`, headSha });
        await expectBlocked(RECEIPTS, [receiptId], headSha);
        await sql`DELETE FROM ${sql(RECEIPTS)} WHERE "id" = ${receiptId}`;

        const linkReceiptId = await insertReceipt(sql, {
          companyId,
          sourceIssueId: issueId,
          idempotencyKey: `link-${label}`,
          headSha: "e".repeat(40),
        });
        const linkId = await insertLink(sql, { companyId, receiptId: linkReceiptId, issueId, objectId, headSha });
        await expectBlocked(LINKS, [linkId], headSha);
        await sql`DELETE FROM ${sql(RECEIPTS)} WHERE "id" = ${linkReceiptId}`;
      }

      // A database restored from a Paperclip backup has no head_sha CHECK, so
      // any text can be stored there.
      await sql`ALTER TABLE ${sql(RECEIPTS)} DROP CONSTRAINT ${sql(`${RECEIPTS}_head_sha_check`)}`;
      await sql`ALTER TABLE ${sql(LINKS)} DROP CONSTRAINT ${sql(`${LINKS}_head_sha_check`)}`;
      for (const [label, headSha] of [
        ["upper", "C".repeat(40)],
        ["non-hex", "g".repeat(40)],
        ["empty", ""],
      ] as const) {
        const receiptId = await insertReceipt(sql, { companyId, sourceIssueId: issueId, idempotencyKey: `receipt-${label}`, headSha });
        await expectBlocked(RECEIPTS, [receiptId], headSha);
        await sql`DELETE FROM ${sql(RECEIPTS)} WHERE "id" = ${receiptId}`;

        const linkReceiptId = await insertReceipt(sql, {
          companyId,
          sourceIssueId: issueId,
          idempotencyKey: `link-${label}`,
          headSha: "f".repeat(40),
        });
        const linkId = await insertLink(sql, { companyId, receiptId: linkReceiptId, issueId, objectId, headSha });
        await expectBlocked(LINKS, [linkId], headSha);
        await sql`DELETE FROM ${sql(RECEIPTS)} WHERE "id" = ${linkReceiptId}`;
      }

      // NULL head_sha: `NULL !~ '...'` is NULL, not true, so a pre-flight
      // without an explicit IS NULL term would miss these rows and the new
      // CHECK would also pass them. A backup restore can carry a nullable
      // column, so drop NOT NULL here to store the rows.
      await sql`ALTER TABLE ${sql(RECEIPTS)} ALTER COLUMN "head_sha" DROP NOT NULL`;
      await sql`ALTER TABLE ${sql(LINKS)} ALTER COLUMN "head_sha" DROP NOT NULL`;
      const nullReceiptId = randomUUID();
      await sql`
        INSERT INTO ${sql(RECEIPTS)} (
          "id", "company_id", "source_issue_id", "provider", "owner", "repo",
          "pull_request_number", "head_sha", "branch_name", "recovery_reason",
          "authorized_by_actor_type", "authorized_by_actor_id", "idempotency_key"
        ) VALUES (
          ${nullReceiptId}, ${companyId}, ${issueId}, 'github', 'acme', 'widgets', 579,
          NULL, 'SUP-579-branch', 'approved PR head lost its status write',
          'board', 'board-actor', 'receipt-null'
        )
      `;
      await expectBlocked(RECEIPTS, [nullReceiptId], "");
      await sql`DELETE FROM ${sql(RECEIPTS)} WHERE "id" = ${nullReceiptId}`;
      const nullLinkReceiptId = await insertReceipt(sql, {
        companyId,
        sourceIssueId: issueId,
        idempotencyKey: "link-null",
        headSha: "f".repeat(40),
      });
      const nullLinkId = randomUUID();
      await sql`
        INSERT INTO ${sql(LINKS)} (
          "id", "company_id", "receipt_id", "source_issue_id", "external_object_id",
          "provider", "owner", "repo", "pull_request_number", "head_sha"
        ) VALUES (
          ${nullLinkId}, ${companyId}, ${nullLinkReceiptId}, ${issueId}, ${objectId},
          'github', 'acme', 'widgets', 579, NULL
        )
      `;
      await expectBlocked(LINKS, [nullLinkId], "");
      await sql`DELETE FROM ${sql(RECEIPTS)} WHERE "id" = ${nullLinkReceiptId}`;
      await sql`ALTER TABLE ${sql(RECEIPTS)} ALTER COLUMN "head_sha" SET NOT NULL`;
      await sql`ALTER TABLE ${sql(LINKS)} ALTER COLUMN "head_sha" SET NOT NULL`;

      // The message names both tables, gives the full count, and lists at most
      // 20 ids per table.
      const manyIds: string[] = [];
      for (let index = 0; index < 21; index += 1) {
        manyIds.push(await insertReceipt(sql, {
          companyId,
          sourceIssueId: issueId,
          idempotencyKey: `many-${index}`,
          headSha: index.toString(16).padStart(2, "0").repeat(32),
        }));
      }
      const manyLinkReceiptId = await insertReceipt(sql, { companyId, sourceIssueId: issueId, idempotencyKey: "many-link", headSha: "9".repeat(40) });
      const manyLinkId = await insertLink(sql, { companyId, receiptId: manyLinkReceiptId, issueId, objectId, headSha: "A".repeat(40) });
      const manyError = await applyPendingMigrations(database.connectionString).then(
        () => null,
        (caught: unknown) => caught as { message?: string },
      );
      expect(manyError?.message).toContain(`${RECEIPTS}: 21 row(s)`);
      expect(manyError?.message).toContain(`${LINKS}: 1 row(s)`);
      expect(manyError?.message).toContain(manyLinkId);
      const listedReceiptIds = manyIds.filter((id) => manyError?.message?.includes(id));
      expect(listedReceiptIds).toHaveLength(20);
      expect(listedReceiptIds.sort()).toEqual([...manyIds].sort().slice(0, 20));
      expect(await ledgerCount(sql, TIGHTEN_MIGRATION_FILE)).toBe("0");

      // After cleanup the restored database gets the exact checks.
      await sql`DELETE FROM ${sql(RECEIPTS)} WHERE "id" = ANY(${sql.array([...manyIds, manyLinkReceiptId])}::uuid[])`;
      await applyPendingMigrations(database.connectionString);
      expect(await ledgerCount(sql, TIGHTEN_MIGRATION_FILE)).toBe("1");
      expect(await headShaChecks(sql)).toEqual(fresh);
      const [survivor] = await sql<{ head_sha: string }[]>`
        SELECT "head_sha" FROM ${sql(RECEIPTS)} WHERE "id" = ${validReceiptId}
      `;
      expect(survivor?.head_sha).toBe(HEAD_SHA);
    },
    240_000,
  );

  it(
    "keeps head_sha NOT NULL and leaves release_assurance_events checks intact after 0329 (S8, S9)",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-delivery-receipt-guards-");
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1 });
      cleanups.push(async () => sql.end());

      // S9: the drop in 0329 is scoped to the two receipt tables. The
      // release-assurance ledger in the same schema has its own head_sha
      // CHECK (nullable by design for hold rows) and six sibling CHECKs:
      // none of them may be dropped or loosened by 0329.
      const raBefore = await releaseAssuranceChecks(sql);
      expect(raBefore.map((row) => row.conname)).toEqual([
        "release_assurance_events_evidence_digest_check",
        "release_assurance_events_go_evidence_check",
        "release_assurance_events_head_binding_check",
        "release_assurance_events_head_sha_check",
        "release_assurance_events_kind_check",
        "release_assurance_events_publication_mode_check",
        "release_assurance_events_pull_request_number_check",
      ]);
      for (const row of raBefore) expect(row.validated).toBe(true);
      expect(raBefore.find((row) => row.conname === "release_assurance_events_head_sha_check")?.def).toContain(
        "'^[0-9a-f]{40}$'",
      );
      // S8: both receipt head_sha columns are NOT NULL on a fresh install.
      expect(await headShaNullable(sql)).toEqual(["NO", "NO"]);

      // Re-run 0329 raw: it must not change either guard.
      for (const statement of await migrationStatements(TIGHTEN_MIGRATION_FILE)) {
        await sql.unsafe(statement);
      }
      expect(await releaseAssuranceChecks(sql)).toEqual(raBefore);
      expect(await headShaNullable(sql)).toEqual(["NO", "NO"]);

      const { companyId, issueId } = await insertCompanyAndIssue(sql);
      // S8 enforcement: NULL is refused by NOT NULL (23502), not by the CHECK.
      await expect(
        sql`
          INSERT INTO ${sql(RECEIPTS)} (
            "company_id", "source_issue_id", "provider", "owner", "repo",
            "pull_request_number", "head_sha", "branch_name", "recovery_reason",
            "authorized_by_actor_type", "authorized_by_actor_id", "idempotency_key"
          ) VALUES (
            ${companyId}, ${issueId}, 'github', 'acme', 'widgets', 579,
            NULL, 'SUP-579-branch', 'reason', 'board', 'board-actor', 'null-guard'
          )
        `,
      ).rejects.toMatchObject({ code: "23502" });
      // S9 enforcement: a go row with a non-conforming head_sha is refused
      // by the surviving release-assurance CHECK.
      await expect(
        sql`
          INSERT INTO "release_assurance_events" (
            "company_id", "issue_id", "event_id", "kind", "owner", "repo",
            "pull_request_number", "head_sha", "evidence_digest", "ci_run_ids",
            "reason", "payload_digest", "recorded_by_actor_type", "recorded_by_actor_id"
          ) VALUES (
            ${companyId}, ${issueId}, ${randomUUID()}, 'go', 'acme', 'widgets', 579,
            'not-a-sha', ${"a".repeat(64)}, ${sql.json([1])}, 'reason', 'digest', 'user', 'actor-1'
          )
        `,
      ).rejects.toMatchObject({ code: "23514", constraint_name: "release_assurance_events_head_sha_check" });
    },
    120_000,
  );

  it(
    "targets the public schema even when search_path resolves the table names elsewhere (N13)",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-delivery-receipt-searchpath-");
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1 });
      cleanups.push(async () => sql.end());
      const fresh = await headShaChecks(sql);

      await rewindToLegacy0298(sql);
      const { companyId, issueId } = await insertCompanyAndIssue(sql);
      const objectId = await insertExternalObject(sql, companyId, "acme/widgets#579");
      const validReceiptId = await insertReceipt(sql, { companyId, sourceIssueId: issueId, idempotencyKey: "searchpath-valid" });
      await insertLink(sql, { companyId, receiptId: validReceiptId, issueId, objectId, headSha: HEAD_SHA });
      const rowsBefore = await tableRows(sql);

      // A decoy schema whose same-named tables shadow the public ones under
      // an unqualified search_path. The decoy receipts row is non-conforming:
      // a migration that resolved names through search_path would either
      // refuse on the decoy row or tighten the decoy tables instead.
      await sql`CREATE SCHEMA "decoy"`;
      await sql`
        CREATE TABLE "decoy"."issue_delivery_receipts" ("id" uuid PRIMARY KEY, "head_sha" text,
          CONSTRAINT "decoy_receipts_head_sha_loose" CHECK ("head_sha" ~ '^[0-9a-f]{40,64}$'))
      `;
      await sql`
        CREATE TABLE "decoy"."issue_delivery_receipt_links" ("id" uuid PRIMARY KEY, "head_sha" text,
          CONSTRAINT "decoy_links_head_sha_loose" CHECK ("head_sha" ~ '^[0-9a-f]{40,64}$'))
      `;
      const decoyId = randomUUID();
      await sql`INSERT INTO "decoy"."issue_delivery_receipts" ("id", "head_sha") VALUES (${decoyId}, ${"c".repeat(41)})`;

      await sql`SET search_path TO "decoy", "pg_catalog"`;
      for (const statement of await migrationStatements(TIGHTEN_MIGRATION_FILE)) {
        await sql.unsafe(statement);
      }
      await sql`SET search_path TO "public", "pg_catalog"`;

      expect(await headShaChecks(sql)).toEqual(fresh);
      expect(await tableRows(sql)).toEqual(rowsBefore);
      const decoyChecks = await sql<{ conname: string; def: string }[]>`
        SELECT "c"."conname", pg_get_constraintdef("c"."oid") AS def
        FROM "pg_constraint" AS "c"
        JOIN "pg_class" AS "t" ON "t"."oid" = "c"."conrelid"
        JOIN "pg_namespace" AS "n" ON "n"."oid" = "t"."relnamespace"
        WHERE "c"."contype" = 'c' AND "n"."nspname" = 'decoy'
        ORDER BY "c"."conname"
      `;
      expect(decoyChecks.map((row) => row.conname)).toEqual([
        "decoy_links_head_sha_loose",
        "decoy_receipts_head_sha_loose",
      ]);
      for (const row of decoyChecks) expect(row.def).toContain("{40,64}");
      const [decoyRow] = await sql<{ head_sha: string }[]>`
        SELECT "head_sha" FROM "decoy"."issue_delivery_receipts" WHERE "id" = ${decoyId}
      `;
      expect(decoyRow?.head_sha).toBe("c".repeat(41));
    },
    120_000,
  );
});
