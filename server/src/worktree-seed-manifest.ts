import path from "node:path";
import { readBoundedStateFile, resolveWorktreeStateRoot } from "@paperclipai/shared/bounded-state-file";
import {
  classifyWorktreeStateManifest,
  isVerifiedWorktreeSeedManifest,
  type WorktreeInitializationExpectation,
} from "@paperclipai/shared/worktree-initialization-manifest";

export type WorktreeSeedManifestStatus =
  | { kind: "absent" }
  | { kind: "verified" }
  | { kind: "incomplete" }
  | { kind: "refused"; message: string };

export type LegacySeedManifestRead =
  | { kind: "absent" }
  | { kind: "legacy-seed"; manifest: Record<string, unknown> }
  | { kind: "refused"; message: string };

/**
 * Callers that cannot confirm a v3 target identity and destination schema
 * refuse every v3 initialization manifest.
 */
const UNCONFIRMED_INITIALIZATION: WorktreeInitializationExpectation = { targetInstanceId: null, schema: null };

/**
 * Bounded read of a manifest in a worktree state directory. The directory that
 * holds `.paperclip` is the trusted root, so a `.paperclip` or `uid-<uid>` link
 * to another instance's state is refused rather than followed.
 */
function readSeedManifestBytes(absolutePath: string): Buffer | null {
  return readBoundedStateFile(absolutePath, { trustedRoot: resolveWorktreeStateRoot(absolutePath) });
}

/**
 * Read a worktree seed manifest through the bounded no-follow reader.
 *
 * `refused` covers legacy-unsafe `minimal-no-secrets`, unsupported or
 * unconfirmed v3 manifests, malformed or non-regular files, and a state
 * directory that is a link. Callers must surface it and must not fall back to a
 * parent source or reseed on their own.
 */
export function readWorktreeSeedManifestStatus(
  manifestPath: string,
  expected: WorktreeInitializationExpectation = UNCONFIRMED_INITIALIZATION,
): WorktreeSeedManifestStatus {
  const absolutePath = path.resolve(manifestPath);
  let bytes: Buffer | null;
  try {
    bytes = readSeedManifestBytes(absolutePath);
  } catch (error) {
    return { kind: "refused", message: error instanceof Error ? error.message : String(error) };
  }
  if (bytes === null) return { kind: "absent" };
  const classification = classifyWorktreeStateManifest(bytes, expected);
  if (classification.kind === "refused") {
    return { kind: "refused", message: `Refusing worktree state manifest ${absolutePath}: ${classification.message}` };
  }
  if (classification.kind === "initialization") return { kind: "verified" };
  return isVerifiedWorktreeSeedManifest(classification.manifest) ? { kind: "verified" } : { kind: "incomplete" };
}

/**
 * Bounded read of a legacy (v2) seed manifest that keeps an absent manifest
 * apart from a refused one (legacy-unsafe, v3, malformed, non-regular, linked
 * state directory, unreadable).
 */
export function readLegacySeedManifest(manifestPath: string): LegacySeedManifestRead {
  const absolutePath = path.resolve(manifestPath);
  let bytes: Buffer | null;
  try {
    bytes = readSeedManifestBytes(absolutePath);
  } catch (error) {
    return { kind: "refused", message: error instanceof Error ? error.message : String(error) };
  }
  if (bytes === null) return { kind: "absent" };
  const classification = classifyWorktreeStateManifest(bytes, UNCONFIRMED_INITIALIZATION);
  if (classification.kind === "legacy-seed") {
    return { kind: "legacy-seed", manifest: classification.manifest as Record<string, unknown> };
  }
  const reason = classification.kind === "refused"
    ? classification.message
    : "Worktree initialization manifests are not handled by the legacy seed path.";
  return { kind: "refused", message: `Refusing worktree state manifest ${absolutePath}: ${reason}` };
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
