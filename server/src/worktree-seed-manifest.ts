import path from "node:path";
import { readBoundedStateFile, resolveWorktreeStateRoot } from "@paperclipai/shared/bounded-state-file";
import { parseWorktreeEnvInstanceId } from "@paperclipai/shared/worktree-initialization-identity";
import {
  classifyWorktreeStateManifest,
  isVerifiedWorktreeSeedManifest,
  type WorktreeInitializationExpectation,
  type WorktreeInitializationManifest,
} from "@paperclipai/shared/worktree-initialization-manifest";

export type WorktreeSeedManifestStatus =
  | { kind: "absent" }
  | { kind: "verified" }
  | { kind: "incomplete" }
  | { kind: "refused"; message: string };

export type WorktreeStateManifestRead =
  | { kind: "absent" }
  | { kind: "legacy-seed"; manifest: Record<string, unknown> }
  | { kind: "initialization"; manifest: WorktreeInitializationManifest }
  | { kind: "refused"; message: string };

export type LegacySeedManifestRead = Exclude<WorktreeStateManifestRead, { kind: "initialization" }>;

/**
 * Callers that cannot confirm a v3 target identity and destination schema
 * refuse every v3 initialization manifest.
 */
const UNCONFIRMED_INITIALIZATION: WorktreeInitializationExpectation = { targetInstanceId: null, schema: null };

/**
 * Bounded read of a file in a worktree state directory. The directory that
 * holds `.paperclip` is the trusted root, so a `.paperclip` or `uid-<uid>` link
 * to another instance's state is refused rather than followed.
 */
function readStateFileBytes(absolutePath: string): Buffer | null {
  return readBoundedStateFile(absolutePath, { trustedRoot: resolveWorktreeStateRoot(absolutePath) });
}

/**
 * `PAPERCLIP_INSTANCE_ID` of the worktree state `.env` in `stateDir`: the
 * instance a worktree process started from that directory runs as. `null` when
 * the file is absent, refused by the bounded reader, or has no valid entry.
 */
export function readWorktreeStateInstanceId(stateDir: string): string | null {
  try {
    const bytes = readStateFileBytes(path.resolve(stateDir, ".env"));
    return bytes === null ? null : parseWorktreeEnvInstanceId(bytes);
  } catch {
    return null;
  }
}

/**
 * Bounded read and classification of a worktree state manifest. A v3
 * initialization manifest is returned only when it is verified for `expected`.
 *
 * `refused` covers legacy-unsafe `minimal-no-secrets`, v3 manifests that are
 * not verified for `expected`, malformed or non-regular files, and a state
 * directory that is a link. Callers must surface it and must not fall back to a
 * parent source or reseed on their own.
 */
export function readWorktreeStateManifest(
  manifestPath: string,
  expected: WorktreeInitializationExpectation = UNCONFIRMED_INITIALIZATION,
): WorktreeStateManifestRead {
  const absolutePath = path.resolve(manifestPath);
  let bytes: Buffer | null;
  try {
    bytes = readStateFileBytes(absolutePath);
  } catch (error) {
    return { kind: "refused", message: error instanceof Error ? error.message : String(error) };
  }
  if (bytes === null) return { kind: "absent" };
  const classification = classifyWorktreeStateManifest(bytes, expected);
  if (classification.kind === "refused") {
    return { kind: "refused", message: `Refusing worktree state manifest ${absolutePath}: ${classification.message}` };
  }
  return classification;
}

/** Seed-gate view of {@link readWorktreeStateManifest}. */
export function readWorktreeSeedManifestStatus(
  manifestPath: string,
  expected: WorktreeInitializationExpectation = UNCONFIRMED_INITIALIZATION,
): WorktreeSeedManifestStatus {
  const read = readWorktreeStateManifest(manifestPath, expected);
  switch (read.kind) {
    case "absent":
    case "refused":
      return read;
    case "initialization":
      return { kind: "verified" };
    case "legacy-seed":
      return isVerifiedWorktreeSeedManifest(read.manifest) ? { kind: "verified" } : { kind: "incomplete" };
  }
}

/**
 * Bounded read of a legacy (v2) seed manifest that keeps an absent manifest
 * apart from a refused one (legacy-unsafe, v3, malformed, non-regular, linked
 * state directory, unreadable).
 */
export function readLegacySeedManifest(manifestPath: string): LegacySeedManifestRead {
  const read = readWorktreeStateManifest(manifestPath, UNCONFIRMED_INITIALIZATION);
  // An unconfirmed expectation refuses every v3 manifest, so no initialization
  // manifest reaches the legacy seed path.
  return read.kind === "initialization"
    ? { kind: "refused", message: "Worktree initialization manifests are not handled by the legacy seed path." }
    : read;
}

/**
 * Bounded read of a legacy (v2) seed manifest object. Returns null when the
 * file is absent or refused, so callers treat it exactly like an unreadable
 * manifest.
 */
export function readLegacySeedManifestObject(manifestPath: string): Record<string, unknown> | null {
  const read = readLegacySeedManifest(manifestPath);
  return read.kind === "legacy-seed" ? read.manifest : null;
}
