import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS_FOLDER } from "@paperclipai/db";
import {
  computeWorktreeSchemaLineage,
  type WorktreeSchemaRevision,
} from "@paperclipai/shared/worktree-initialization-identity";

/** Head revision of this server build's migration lineage. */
export function serverSchemaHead(): WorktreeSchemaRevision {
  return computeWorktreeSchemaLineage(MIGRATIONS_FOLDER).at(-1)!;
}

/**
 * A small checkout migrations folder at `<root>/packages/db/src/migrations`
 * with generated SQL; returns its lineage head.
 */
export function writeCheckoutMigrations(root: string): WorktreeSchemaRevision {
  const folder = path.join(root, "packages", "db", "src", "migrations");
  fs.mkdirSync(path.join(folder, "meta"), { recursive: true });
  const tags = ["0000_fixture_base", "0001_fixture_next"];
  fs.writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({ version: "7", entries: tags.map((tag, idx) => ({ idx, tag, when: idx, breakpoints: true })) }),
  );
  for (const tag of tags) fs.writeFileSync(path.join(folder, `${tag}.sql`), `-- ${randomBytes(8).toString("hex")}\n`);
  return computeWorktreeSchemaLineage(folder).at(-1)!;
}

/** A verified v3 `fresh` initialization manifest with generated identities. */
export function verifiedInitializationManifest(input: {
  targetInstanceId: string;
  revision: WorktreeSchemaRevision;
  overrides?: Record<string, unknown>;
}): string {
  const generationId = randomUUID();
  const attemptId = randomUUID();
  return JSON.stringify({
    version: 3,
    kind: "worktree-initialization",
    profile: "fresh",
    policyVersion: 1,
    schemaFingerprint: input.revision.schemaFingerprint,
    migrationRevision: input.revision.migrationRevision,
    targetInstanceId: input.targetInstanceId,
    generationId,
    attemptId,
    state: "verified",
    phase: "complete",
    startedAt: "2026-11-16T10:00:00.000Z",
    finishedAt: "2026-11-16T10:00:05.000Z",
    source: null,
    diagnostics: [{ phase: "complete", code: "fresh_ready", status: "succeeded", at: "2026-11-16T10:00:05.000Z" }],
    validation: { kind: "fresh-ready", attemptId, generationId, completedAt: "2026-11-16T10:00:05.000Z" },
    ...input.overrides,
  });
}
