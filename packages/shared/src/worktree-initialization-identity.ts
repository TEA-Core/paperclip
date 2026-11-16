/**
 * Destination identity for v3 worktree initialization manifests.
 *
 * - The schema lineage is computed from a build's own migration journal and
 *   SQL files. The initializer records the head revision it migrated to, and a
 *   reader accepts a manifest only for a revision of its own lineage (see
 *   `WorktreeInitializationExpectation.schema`). Migrations are repository
 *   program input, not worktree state.
 * - The target instance id is read from the `PAPERCLIP_INSTANCE_ID` entry of the
 *   worktree state `.env`. Callers read those bytes through the bounded state
 *   file reader; this module only parses them.
 *
 * This module is self-contained (no relative imports) so the runtime
 * provisioner can load it through Node's type stripping without a build step.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export type WorktreeSchemaRevision = {
  /** Migration file name, for example `0316_broad_rattler.sql`. */
  migrationRevision: string;
  /** `sha256:` fingerprint of the migration chain up to and including this revision. */
  schemaFingerprint: string;
};

const LINEAGE_DOMAIN = "paperclip-worktree-schema-lineage-v1";
const MIGRATION_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,122}$/;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INSTANCE_ID_LINE = /^\s*(?:export\s+)?PAPERCLIP_INSTANCE_ID\s*=\s*(.*?)\s*$/;

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Ordered migration lineage of the migrations folder. Throws when the journal
 * is missing, malformed, out of order, or names a migration file that does not
 * exist. Errors name the folder only, never file content.
 */
export function computeWorktreeSchemaLineage(migrationsFolder: string): WorktreeSchemaRevision[] {
  const folder = path.resolve(migrationsFolder);
  const invalid = () => new Error(`Migration journal in ${folder} is missing or invalid.`);
  let journal: unknown;
  try {
    journal = JSON.parse(readFileSync(path.join(folder, "meta", "_journal.json"), "utf8"));
  } catch {
    throw invalid();
  }
  const entries = (journal as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries) || entries.length === 0) throw invalid();

  const lineage: WorktreeSchemaRevision[] = [];
  let chain = sha256Hex(LINEAGE_DOMAIN);
  entries.forEach((entry: unknown, index) => {
    const { idx, tag } = (entry ?? {}) as { idx?: unknown; tag?: unknown };
    if (idx !== index || typeof tag !== "string" || !MIGRATION_TAG_PATTERN.test(tag)) throw invalid();
    const migrationRevision = `${tag}.sql`;
    let sqlBytes: Buffer;
    try {
      sqlBytes = readFileSync(path.join(folder, migrationRevision));
    } catch {
      throw invalid();
    }
    chain = sha256Hex(`${chain}\n${migrationRevision}\n${sha256Hex(sqlBytes)}`);
    lineage.push({ migrationRevision, schemaFingerprint: `sha256:${chain}` });
  });
  return lineage;
}

const lineageCache = new Map<string, readonly WorktreeSchemaRevision[] | null>();

/**
 * Memoized {@link computeWorktreeSchemaLineage} for readers: `null` when the
 * lineage cannot be computed, so the reader cannot confirm any v3 schema.
 */
export function resolveWorktreeSchemaLineage(migrationsFolder: string): readonly WorktreeSchemaRevision[] | null {
  const folder = path.resolve(migrationsFolder);
  if (!lineageCache.has(folder)) {
    let lineage: readonly WorktreeSchemaRevision[] | null;
    try {
      lineage = computeWorktreeSchemaLineage(folder);
    } catch {
      lineage = null;
    }
    lineageCache.set(folder, lineage);
  }
  return lineageCache.get(folder) ?? null;
}

/**
 * `PAPERCLIP_INSTANCE_ID` from worktree state `.env` bytes, or `null` when the
 * entry is absent, empty, or not a plain instance id. The last assignment wins,
 * as in dotenv.
 */
export function parseWorktreeEnvInstanceId(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  let value: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const match = INSTANCE_ID_LINE.exec(line);
    if (match) value = match[1] ?? "";
  }
  if (value === null) return null;
  const unquoted = /^(['"])(.*)\1$/.exec(value)?.[2] ?? value;
  return INSTANCE_ID_PATTERN.test(unquoted) ? unquoted : null;
}
