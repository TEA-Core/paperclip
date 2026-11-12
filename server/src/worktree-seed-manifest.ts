import path from "node:path";
import { readBoundedStateFile } from "@paperclipai/shared/bounded-state-file";
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

/**
 * Callers that cannot confirm a v3 target identity and destination schema
 * refuse every v3 initialization manifest.
 */
const UNCONFIRMED_INITIALIZATION: WorktreeInitializationExpectation = { targetInstanceId: null, schema: null };

/**
 * Read a worktree seed manifest through the bounded no-follow reader.
 *
 * `refused` covers legacy-unsafe `minimal-no-secrets`, unsupported or
 * unconfirmed v3 manifests, and malformed or non-regular files. Callers must
 * surface it and must not fall back to a parent source or reseed on their own.
 */
export function readWorktreeSeedManifestStatus(
  manifestPath: string,
  expected: WorktreeInitializationExpectation = UNCONFIRMED_INITIALIZATION,
): WorktreeSeedManifestStatus {
  const absolutePath = path.resolve(manifestPath);
  let bytes: Buffer | null;
  try {
    bytes = readBoundedStateFile(absolutePath);
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

export function hasVerifiedWorktreeSeedManifest(manifestPath: string): boolean {
  return readWorktreeSeedManifestStatus(manifestPath).kind === "verified";
}

/**
 * Bounded read of a legacy (v2) seed manifest object. Returns null when the
 * file is absent, refused (legacy-unsafe, v3, malformed, non-regular) or
 * unreadable, so callers treat it exactly like an unreadable manifest.
 */
export function readLegacySeedManifestObject(manifestPath: string): Record<string, unknown> | null {
  try {
    const bytes = readBoundedStateFile(path.resolve(manifestPath));
    if (bytes === null) return null;
    const classification = classifyWorktreeStateManifest(bytes, UNCONFIRMED_INITIALIZATION);
    return classification.kind === "legacy-seed" ? (classification.manifest as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
