#!/usr/bin/env node
// Bounded executable interface to the worktree state manifest validator for
// shell provisioners (scripts/provision-worktree-runtime.sh).
//
// Usage: node scripts/worktree-state-manifest-check.mjs <manifest-path>
//
// Prints exactly one token on stdout and exits 0:
//   absent      no manifest exists
//   verified    complete v2 `minimal`/`full` seed manifest, or a verified v3
//               initialization manifest for the instance named in the state
//               `.env` and for a revision of this checkout's migration lineage
//   incomplete  any other v2 seed manifest (pending, running, failed, partial)
// Exits 3 after printing an actionable reason on stderr when the manifest is
// refused: legacy-unsafe v2 `minimal-no-secrets`, a v3 initialization
// manifest that is not verified for this instance and schema, malformed,
// non-regular, oversized, or unknown-version input. A refusal never selects a
// parent source or triggers a reseed. Other exits are usage or internal errors.
//
// The reader opens with O_NOFOLLOW | O_NONBLOCK, so a FIFO, socket, directory,
// or symlink is refused without waiting. The directory that holds `.paperclip`
// is the trusted root: a linked `.paperclip` or `uid-<uid>` state directory is
// refused, never followed to another instance's manifest. The validator
// modules are loaded as TypeScript through Node's built-in type stripping
// (Node >= 22.18).
import path from "node:path";
import { fileURLToPath } from "node:url";

const REFUSED_EXIT = 3;

const manifestArgument = process.argv[2];
if (!manifestArgument || process.argv.length !== 3) {
  process.stderr.write("usage: worktree-state-manifest-check.mjs <manifest-path>\n");
  process.exit(2);
}

const sharedSource = new URL("../packages/shared/src/", import.meta.url);
const migrationsFolder = fileURLToPath(new URL("../packages/db/src/migrations/", import.meta.url));
const { readBoundedStateFile, resolveWorktreeStateRoot } = await import(new URL("bounded-state-file.ts", sharedSource).href);
const { parseWorktreeEnvInstanceId, resolveWorktreeSchemaLineage } = await import(
  new URL("worktree-initialization-identity.ts", sharedSource).href
);
const { classifyWorktreeStateManifest, isVerifiedWorktreeSeedManifest } = await import(
  new URL("worktree-initialization-manifest.ts", sharedSource).href
);

function readStateFile(filePath) {
  return readBoundedStateFile(filePath, { trustedRoot: resolveWorktreeStateRoot(filePath) });
}

const manifestPath = path.resolve(manifestArgument);
let bytes;
try {
  bytes = readStateFile(manifestPath);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Worktree state manifest could not be read."}\n`);
  process.exit(REFUSED_EXIT);
}
if (bytes === null) {
  process.stdout.write("absent");
  process.exit(0);
}

// A v3 manifest is accepted only for the instance the worktree runs as (its
// state `.env`) and a revision of this checkout's migration lineage.
let targetInstanceId = null;
try {
  const envBytes = readStateFile(path.join(path.dirname(manifestPath), ".env"));
  targetInstanceId = envBytes === null ? null : parseWorktreeEnvInstanceId(envBytes);
} catch {
  // An unreadable `.env` cannot confirm the target, so a v3 manifest is refused.
}
const classification = classifyWorktreeStateManifest(bytes, {
  targetInstanceId,
  schema: resolveWorktreeSchemaLineage(migrationsFolder),
});
if (classification.kind === "initialization") {
  process.stdout.write("verified");
  process.exit(0);
}
if (classification.kind === "legacy-seed") {
  process.stdout.write(isVerifiedWorktreeSeedManifest(classification.manifest) ? "verified" : "incomplete");
  process.exit(0);
}
process.stderr.write(`Refusing worktree state manifest ${manifestPath}: ${classification.message}\n`);
process.exit(REFUSED_EXIT);
