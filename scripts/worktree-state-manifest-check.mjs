#!/usr/bin/env node
// Bounded executable interface to the worktree state manifest validator for
// shell provisioners (scripts/provision-worktree-runtime.sh).
//
// Usage: node scripts/worktree-state-manifest-check.mjs <manifest-path>
//
// Prints exactly one token on stdout and exits 0:
//   absent      no manifest exists
//   verified    complete v2 `minimal`/`full` seed manifest
//   incomplete  any other v2 seed manifest (pending, running, failed, partial)
// Exits 3 after printing an actionable reason on stderr when the manifest is
// refused: legacy-unsafe v2 `minimal-no-secrets`, any v3 initialization
// manifest this legacy seed path must not provision, malformed, non-regular,
// oversized, or unknown-version input. A refusal never selects a parent source
// or triggers a reseed. Other exits are usage or internal errors.
//
// The reader opens with O_NOFOLLOW | O_NONBLOCK, so a FIFO, socket, directory,
// or symlink is refused without waiting. The validator modules are loaded as
// TypeScript through Node's built-in type stripping (Node >= 22.18).
import path from "node:path";

const REFUSED_EXIT = 3;

const manifestArgument = process.argv[2];
if (!manifestArgument || process.argv.length !== 3) {
  process.stderr.write("usage: worktree-state-manifest-check.mjs <manifest-path>\n");
  process.exit(2);
}

const sharedSource = new URL("../packages/shared/src/", import.meta.url);
const { readBoundedStateFile } = await import(new URL("bounded-state-file.ts", sharedSource).href);
const { classifyWorktreeStateManifest, isVerifiedWorktreeSeedManifest } = await import(
  new URL("worktree-initialization-manifest.ts", sharedSource).href
);

const manifestPath = path.resolve(manifestArgument);
let bytes;
try {
  bytes = readBoundedStateFile(manifestPath);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Worktree state manifest could not be read."}\n`);
  process.exit(REFUSED_EXIT);
}
if (bytes === null) {
  process.stdout.write("absent");
  process.exit(0);
}

// The shell provisioner cannot confirm a v3 target identity or destination
// schema, and this legacy seed path must never provision a v3 directory, so
// every v3 manifest is refused here.
const classification = classifyWorktreeStateManifest(bytes, { targetInstanceId: null, schema: null });
if (classification.kind === "legacy-seed") {
  process.stdout.write(isVerifiedWorktreeSeedManifest(classification.manifest) ? "verified" : "incomplete");
  process.exit(0);
}
const reason = classification.kind === "refused"
  ? classification.message
  : "Worktree initialization manifests are not provisioned by the legacy seed path.";
process.stderr.write(`Refusing worktree state manifest ${manifestPath}: ${reason}\n`);
process.exit(REFUSED_EXIT);
