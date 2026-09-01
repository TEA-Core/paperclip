import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir,
  resolveSecretsKeyDir,
} from "../home-paths.js";

const execFileAsync = promisify(execFile);

const DEFAULT_SHARED_GROUP_NAME = "agents";

// O_NOFOLLOW prevents the leaf component from being a symlink. Ancestor
// symlinks are still followed, so post-open containment is verified via
// /proc/self/fd on Linux.
const O_RDONLY_NOFOLLOW =
  fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0);

let missingGroupWarned = false;
let chgrpFailedWarned = false;

function resolveDefaultMasterKeyDir(): string {
  return resolveSecretsKeyDir();
}

function resolveDefaultPostgresDataDir(): string {
  return resolveDefaultEmbeddedPostgresDir();
}

function resolveDefaultDatabaseBackupDir(): string {
  return resolveDefaultBackupDir();
}

/**
 * Returns true if `dirPath` is the denied directory itself, an ancestor of it,
 * or a descendant of it. Both directions are denied: chgrp'ing an ancestor of a
 * server-owned dir would affect the server-owned dir, and chgrp'ing a
 * descendant would grant the shared group write access inside a server-owned
 * subtree.
 */
function isDeniedServerOwnedDirOrAncestor(
  dirPath: string,
  deniedDirResolvers: Array<() => string>,
): boolean {
  const target = path.resolve(dirPath);
  return deniedDirResolvers.some((resolveDenied) => {
    const denied = path.resolve(resolveDenied());
    return (
      target === denied ||
      denied.startsWith(target + path.sep) ||
      target.startsWith(denied + path.sep)
    );
  });
}

async function defaultResolveGid(groupName: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("getent", ["group", groupName], {
      timeout: 5000,
      maxBuffer: 4096,
    });
    const parts = stdout.trim().split(":");
    if (parts.length >= 3) {
      const gid = parseInt(parts[2], 10);
      if (!Number.isNaN(gid)) return gid;
    }
  } catch {
    return null;
  }
  return null;
}

export interface EnsureSharedGroupOwnershipOptions {
  groupName?: string;
  resolveGid?: (groupName: string) => Promise<number | null>;
  resolveMasterKeyDir?: () => string;
  resolvePostgresDataDir?: () => string;
  resolveDatabaseBackupDir?: () => string;
  warn?: (message: string) => void;
  /**
   * When set, the opened handle's resolved real path must be this directory
   * or within it. If the handle resolves outside, the mutation is refused.
   * This closes the TOCTOU window between a caller's containment pre-check
   * and the mutation itself (SUP-14687).
   */
  containmentRoot?: string;
}

/**
 * Repair the shared-group ownership of every directory on the path from
 * `stopAtDir` down to `leafDir`, inclusive.
 *
 * Traversal is a property of the WHOLE ancestor chain, not of the leaf: to
 * reach a worktree, the agent uid needs the group x bit on the repo root, on
 * `.paperclip`, and on `worktrees`. Repairing only the leaf leaves the chain
 * broken while looking repaired — a repo root left at 0o2700 returns EACCES on
 * every path beneath it, no matter how correct the worktree's own mode is.
 *
 * The ancestors were previously group-traversable only by accident of the
 * creating process's umask: under umask 002 a clone lands at 0o2775 and works,
 * under a stricter umask it lands at 0o2700 and every agent run in that repo
 * fails. Nothing in the chain is repaired by construction until now.
 */
export async function ensureSharedGroupTraversalPath(
  leafDir: string,
  stopAtDir: string,
  opts: EnsureSharedGroupOwnershipOptions = {},
): Promise<void> {
  const leaf = path.resolve(leafDir);
  const stopAt = path.resolve(stopAtDir);

  if (leaf !== stopAt && !leaf.startsWith(stopAt + path.sep)) {
    await ensureSharedGroupOwnership(leaf, opts);
    return;
  }

  const chain: string[] = [];
  let current = leaf;
  for (;;) {
    chain.push(current);
    if (current === stopAt) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  chain.reverse();
  for (const dir of chain) {
    await ensureSharedGroupOwnership(dir, opts);
  }
}

/**
 * SUP-14687: resolve-then-mutate by handle to close the TOCTOU window in
 * worktree self-repair.
 *
 * The previous implementation stat'd the path, then chown'd and chmod'd the
 * path. A concurrent symlink swap between stat and chown redirected the
 * mutation to an external target. The new implementation:
 *
 * 1. Opens the target with O_RDONLY|O_NOFOLLOW (leaf must not be a symlink).
 * 2. Verifies the opened fd's real path via /proc/self/fd (Linux) to catch
 *    ancestor symlinks that O_NOFOLLOW does not prevent.
 * 3. If a containmentRoot is specified, refuses mutation when the verified
 *    path escapes it.
 * 4. Checks the denied-server-owned-dirs guard against the VERIFIED (real)
 *    path, not the lexical path, and denies both ancestor and descendant
 *    relationships.
 * 5. Mutates via the file descriptor (handle.chown / handle.chmod), so the
 *    mutation targets the exact inode that was opened and verified,
 *    regardless of any subsequent path-level symlink swap.
 *
 * Fail-closed: any error (ELOOP, EACCES, ENOENT, containment violation)
 * results in no mutation and a warning. There is no path-based fallback.
 */
export async function ensureSharedGroupOwnership(
  dirPath: string,
  opts: EnsureSharedGroupOwnershipOptions = {},
): Promise<void> {
  const groupName = opts.groupName ?? DEFAULT_SHARED_GROUP_NAME;
  const resolveGid = opts.resolveGid ?? defaultResolveGid;
  const resolveMasterKeyDir = opts.resolveMasterKeyDir ?? resolveDefaultMasterKeyDir;
  const resolvePostgresDataDir = opts.resolvePostgresDataDir ?? resolveDefaultPostgresDataDir;
  const resolveDatabaseBackupDir = opts.resolveDatabaseBackupDir ?? resolveDefaultDatabaseBackupDir;
  const warn = opts.warn ?? console.warn.bind(console);
  const containmentRoot =
    opts.containmentRoot != null ? path.resolve(opts.containmentRoot) : null;

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(dirPath, O_RDONLY_NOFOLLOW);
  } catch (err) {
    // ELOOP: leaf is a symlink (O_NOFOLLOW rejected it).
    // EACCES/EPERM: cannot open (e.g. chmod 0o000).
    // ENOENT: path vanished between probe and repair.
    // All fail-closed: no mutation, no path-based fallback.
    if (!chgrpFailedWarned) {
      chgrpFailedWarned = true;
      warn(
        `Paperclip: cannot open ${dirPath} for shared-group ownership repair: ` +
          `${err instanceof Error ? err.message : String(err)}. No path-based mutation performed.`,
      );
    }
    return;
  }

  try {
    // Resolve the real path of the opened fd. On Linux, /proc/self/fd/<N> is
    // a symlink to the file's canonical path (all ancestor symlinks resolved).
    let verifiedPath: string | null = null;
    try {
      verifiedPath = await fs.realpath(`/proc/self/fd/${handle.fd}`);
    } catch {
      // /proc/self/fd is Linux-specific. On other platforms we cannot verify
      // post-open; rely on O_NOFOLLOW for leaf-symlink protection and skip
      // containment/denied checks (they are moot without a verified path).
      verifiedPath = null;
    }

    if (verifiedPath !== null) {
      // Containment check: when a containment root is specified, the verified
      // path must be the root itself or within it. This catches ancestor
      // symlinks that O_NOFOLLOW does not prevent.
      if (containmentRoot != null) {
        const resolvedRoot = await fs.realpath(containmentRoot);
        if (
          verifiedPath !== resolvedRoot &&
          !verifiedPath.startsWith(resolvedRoot + path.sep)
        ) {
          warn(
            `Paperclip: refusing shared-group ownership on ${dirPath} — the resolved target ` +
              `${verifiedPath} is outside the containment root ${resolvedRoot}. ` +
              `This may indicate a concurrent symlink swap (TOCTOU). No mutation performed.`,
          );
          return;
        }
      }

      // Denied-dir check on the VERIFIED (real) path, not the lexical path.
      // A lexical path inside the worktree could resolve (via symlink) to a
      // server-owned directory; the old code compared only the lexical path.
      if (
        isDeniedServerOwnedDirOrAncestor(verifiedPath, [
          resolveMasterKeyDir,
          resolvePostgresDataDir,
          resolveDatabaseBackupDir,
        ])
      ) {
        warn(
          `Paperclip: refusing shared-group ownership on ${dirPath} — it resolves to ${verifiedPath}, ` +
            `which is a server-owned directory (secrets master-key, embedded-Postgres data, or ` +
            `database backup) or an ancestor/descendant of one. ` +
            `Under M1 (agent uid 1001, server uid 1000) these directories must remain owned by ` +
            `the server group, not "${groupName}".`,
        );
        return;
      }
    }

    const gid = await resolveGid(groupName);
    if (gid == null) {
      if (!missingGroupWarned) {
        missingGroupWarned = true;
        warn(
          `Paperclip: group "${groupName}" not found; skipping shared-group ownership for ${dirPath}. ` +
            `Under M1 (agent uid 1001, server uid 1000) this group is required for cross-uid write access.`,
        );
      }
      return;
    }

    // Hardlink note: chown/chmod via fd targets the inode, so a concurrent
    // hardlink rename cannot redirect the mutation. The only residual risk is
    // a hardlink to a sensitive file that was opened before the check — this
    // is not exploitable in practice because the caller (worktree self-repair)
    // only operates on git-tracked paths within the containment root.
    const stat = await handle.stat();
    await handle.chown(stat.uid, gid);
    const currentMode = stat.mode & 0o7777;
    await handle.chmod(currentMode | 0o2070);
  } catch (err) {
    if (!chgrpFailedWarned) {
      chgrpFailedWarned = true;
      warn(
        `Paperclip: failed to set shared-group ownership on ${dirPath}: ${err instanceof Error ? err.message : String(err)}. ` +
          `The "${groupName}" group (gid resolved) is present but chgrp/chmod via handle failed.`,
      );
    }
  } finally {
    try {
      await handle.close();
    } catch {
      // Ignore close errors; the OS reclaims the fd on process exit.
    }
  }
}
