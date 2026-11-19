import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS_FOLDER } from "@paperclipai/db";
import {
  computeWorktreeSchemaLineage,
  type WorktreeSchemaRevision,
} from "@paperclipai/shared/worktree-initialization-identity";
import {
  computeWorktreeInitializationBinding,
  WORKTREE_INITIALIZATION_KEY_FILE,
} from "@paperclipai/shared/worktree-initialization-manifest";

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

/** A verified v3 `fresh` manifest body with generated identities and no binding. */
function verifiedInitializationBody(input: {
  targetInstanceId: string;
  revision: WorktreeSchemaRevision;
}): Record<string, unknown> {
  const generationId = randomUUID();
  const attemptId = randomUUID();
  return {
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
  };
}

/**
 * Write a verified v3 manifest into `stateDir` the way the real writer does:
 * a new 0600 initialization key next to it and a binding under that key.
 * `forge` keeps the key file but writes a hand-made binding that the key did
 * not produce, as a hand-written or edited manifest would look.
 */
export function writeVerifiedInitialization(
  stateDir: string,
  input: { targetInstanceId: string; revision: WorktreeSchemaRevision; forge?: boolean },
): void {
  const body = verifiedInitializationBody(input);
  const key = randomBytes(32);
  fs.writeFileSync(path.join(stateDir, WORKTREE_INITIALIZATION_KEY_FILE), key, { mode: 0o600 });
  const binding = input.forge
    ? `hmac-sha256:${randomBytes(32).toString("hex")}`
    : computeWorktreeInitializationBinding(key, body);
  fs.writeFileSync(path.join(stateDir, "seed-manifest.json"), JSON.stringify({ ...body, binding }), "utf8");
}
