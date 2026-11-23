import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationFile = "0332_child_carrier_history_identity.sql";
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("child carrier historical identity migration", () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("backfills stored identities losslessly, swaps atomically, and keeps one current proof", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-child-carrier-history-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());
    const migration = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
    const statements = migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean);
    const hash = createHash("sha256").update(migration).digest("hex");

    // Rewind this isolated fixture to the landed 0330 key, then seed legacy data.
    await sql`DROP INDEX issue_child_carrier_attributions_history_uq`;
    await sql`CREATE UNIQUE INDEX issue_child_carrier_attributions_child_pr_head_uq
      ON issue_child_carrier_attributions (company_id, child_issue_id, pull_request_number, head_sha)`;
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
    const companyId = randomUUID();
    const childId = randomUUID();
    const ancestorId = randomUUID();
    const otherAncestorId = randomUUID();
    await sql`INSERT INTO companies (id, name) VALUES (${companyId}, 'Historical carriers')`;
    for (const id of [childId, ancestorId, otherAncestorId]) {
      await sql`INSERT INTO issues (id, company_id, title) VALUES (${id}, ${companyId}, 'Carrier fixture')`;
    }
    const head = "a".repeat(40);
    const legacy = {
      id: randomUUID(), company_id: companyId, child_issue_id: childId, ancestor_issue_id: ancestorId,
      provider: "github", owner: "Mixed-Owner", repo: "Mixed-Repo", pull_request_number: 653,
      branch_name: "carrier", head_sha: head, commit_shas: [head], state: "current",
      written_by_actor_type: "system", written_by_actor_id: "system:child-carrier-attribution",
      provenance: { source: "control-plane-verification", retained: true },
    };
    await sql`INSERT INTO issue_child_carrier_attributions ${sql(legacy)}`;
    await sql`INSERT INTO issue_child_carrier_attributions ${sql({
      ...legacy, id: randomUUID(), head_sha: "b".repeat(40), state: "invalidated",
      invalidated_at: new Date("2026-11-01T00:00:00Z"),
    })}`;
    const before = await sql`SELECT * FROM issue_child_carrier_attributions ORDER BY id`;

    await expect(sql.begin(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
      throw new Error("rollback index swap");
    })).rejects.toThrow("rollback index swap");
    const [rolledBack] = await sql`SELECT
      to_regclass('issue_child_carrier_attributions_child_pr_head_uq')::text AS old_key,
      to_regclass('issue_child_carrier_attributions_history_uq')::text AS new_key`;
    expect(rolledBack).toEqual({ old_key: "issue_child_carrier_attributions_child_pr_head_uq", new_key: null });
    expect(await sql`SELECT * FROM issue_child_carrier_attributions ORDER BY id`).toEqual(before);

    await applyPendingMigrations(database.connectionString);
    expect(await sql`SELECT * FROM issue_child_carrier_attributions ORDER BY id`).toEqual(before);
    const [swapped] = await sql`SELECT
      to_regclass('issue_child_carrier_attributions_child_pr_head_uq')::text AS old_key,
      to_regclass('issue_child_carrier_attributions_history_uq')::text AS new_key`;
    expect(swapped).toEqual({ old_key: null, new_key: "issue_child_carrier_attributions_history_uq" });

    // Each new identity keeps the same child, PR number and head; none replaces legacy data.
    for (const identity of [{ owner: "other-owner" }, { repo: "other-repo" }, { ancestor_issue_id: otherAncestorId }]) {
      await sql`INSERT INTO issue_child_carrier_attributions ${sql({
        ...legacy, ...identity, id: randomUUID(), state: "invalidated",
      })}`;
    }
    await expect(sql`INSERT INTO issue_child_carrier_attributions ${sql({
      ...legacy, id: randomUUID(), state: "invalidated", owner: "MIXED-OWNER", repo: "mixed-repo",
    })}`).rejects.toMatchObject({ code: "23505", constraint_name: "issue_child_carrier_attributions_history_uq" });
    await expect(sql`INSERT INTO issue_child_carrier_attributions ${sql({
      ...legacy, id: randomUUID(), repo: "another-current-repo",
    })}`).rejects.toMatchObject({ code: "23505", constraint_name: "issue_child_carrier_attributions_current_child_uq" });
    await expect(sql`INSERT INTO issue_child_carrier_attributions ${sql({
      ...legacy, id: randomUUID(), state: "invalidated", provider: "unsupported",
    })}`).rejects.toMatchObject({ code: "23514", constraint_name: "issue_child_carrier_attributions_provider_check" });
    const after = await sql`SELECT * FROM issue_child_carrier_attributions ORDER BY id`;
    expect(after.filter((row) => before.some((old) => old.id === row.id))).toEqual(before);
    expect(after.filter((row) => row.state === "current").map((row) => row.id)).toEqual([legacy.id]);
    await applyPendingMigrations(database.connectionString);
    expect(await sql`SELECT * FROM issue_child_carrier_attributions ORDER BY id`).toEqual(after);
  }, 30_000);
});
