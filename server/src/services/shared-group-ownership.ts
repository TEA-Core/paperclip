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
// O_NONBLOCK keeps the open from blocking on a FIFO (named pipe): a blocking
// O_RDONLY open of a FIFO hangs until a writer connects, which would stall the
// repair and, with enough FIFOs, exhaust the libuv thread pool (SUP-14865). A
// non-blocking open of a FIFO resolves immediately; the special-file check
// below then refuses to mutate it.
const O_RDONLY_NOFOLLOW_NONBLOCK =
  fsSync.constants.O_RDONLY |
  (fsSync.constants.O_NOFOLLOW ?? 0) |
  (fsSync.constants.O_NONBLOCK ?? 0);

// File types the shared-group traversal repair must never mutate. These are
// special files (named pipes, character/block devices, sockets), not
// directories or regular files, so adding setgid/group bits to them is
// meaningless at best and a surprising side effect at worst.
const SPECIAL_FILE_TYPES = new Set<number>([
  fsSync.constants.S_IFIFO,
  fsSync.constants.S_IFCHR,
  fsSync.constants.S_IFBLK,
  fsSync.constants.S_IFSOCK,
]);

function isSpecialFileType(mode: number): boolean {
  return SPECIAL_FILE_TYPES.has(mode & fsSync.constants.S_IFMT);
}

let missingGroupWarned = false;
let chgrpFailedWarned = false;
let specialFileWarned = false;

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
 * 1. Opens the target with O_RDONLY|O_NOFOLLOW|O_NONBLOCK (leaf must not be a
 *    symlink; O_NONBLOCK keeps a FIFO/named-pipe target from blocking the open,
 *    which would otherwise hang the repair and exhaust the libuv thread pool).
 * 2. Verifies the opened fd's real path via /proc/self/fd (Linux) to catch
 *    ancestor symlinks that O_NOFOLLOW does not prevent.
 * 3. If a containmentRoot is specified, refuses mutation when the verified
 *    path escapes it.
 * 4. Checks the denied-server-owned-dirs guard against the VERIFIED (real)
 *    path, not the lexical path, and denies both ancestor and descendant
 *    relationships.
 * 5. Skips with a warning when the opened inode is a special file (FIFO,
 *    character/block device, or socket): group-ownership repair only applies
 *    to directories and regular files.
 * 6. Mutates via the file descriptor (handle.chown / handle.chmod), so the
 *    mutation targets the exact inode that was opened and verified,
 *    regardless of any subsequent path-level symlink swap.
 *
 * Fail-closed: any error (ELOOP, EACCES, ENOENT, EWOULDBLOCK/ENXIO, containment
 * violation, special-file target) results in no mutation and a warning. There
 * is no path-based fallback.
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
    handle = await fs.open(dirPath, O_RDONLY_NOFOLLOW_NONBLOCK);
  } catch (err) {
    // ELOOP: leaf is a symlink (O_NOFOLLOW rejected it).
    // EACCES/EPERM: cannot open (e.g. chmod 0o000).
    // ENOENT: path vanished between probe and repair.
    // EWOULDBLOCK/ENXIO: a special file (FIFO) whose non-blocking open cannot
    // be established on this platform — O_NONBLOCK already prevents the common
    // Linux read-open case; on any platform that still surfaces these, we skip.
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
      // /proc/self/fd is Linux-specific. On other platforms (or a container
      // without /proc) we cannot verify the post-open target. Containment can
      // then not be proven, so it is enforced below (fail-closed). The
      // denied-directory guard still has a meaningful lexical floor and runs
      // against the lexical path; O_NOFOLLOW already proved the leaf is not a
      // symlink.
      verifiedPath = null;
    }

    // Containment is fail-closed: when a containment root was requested but
    // the opened handle cannot be verified, we cannot prove the target is
    // inside it, so refuse rather than mutate. The self-repair caller always
    // passes containmentRoot; a non-Linux host is not where it runs.
    if (containmentRoot != null && verifiedPath === null) {
      warn(
        `Paperclip: refusing shared-group ownership on ${dirPath} — the opened handle could not ` +
          `be verified (no /proc/self/fd) and a containment root was required. No mutation performed.`,
      );
      return;
    }

    if (verifiedPath !== null && containmentRoot != null) {
      // Containment check: when a containment root is specified, the verified
      // path must be the root itself or within it. This catches ancestor
      // symlinks that O_NOFOLLOW does not prevent.
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

    // Denied-dir check prefers the VERIFIED (real) path; a lexical path inside
    // the worktree could resolve (via symlink) to a server-owned directory.
    // When the handle cannot be verified, fall back to the lexical path
    // instead of skipping the guard entirely.
    const deniedCheckPath = verifiedPath ?? dirPath;
    if (
      isDeniedServerOwnedDirOrAncestor(deniedCheckPath, [
        resolveMasterKeyDir,
        resolvePostgresDataDir,
        resolveDatabaseBackupDir,
      ])
    ) {
      warn(
        `Paperclip: refusing shared-group ownership on ${dirPath} — it resolves to ${deniedCheckPath}, ` +
          `which is a server-owned directory (secrets master-key, embedded-Postgres data, or ` +
          `database backup) or an ancestor/descendant of one. ` +
          `Under M1 (agent uid 1001, server uid 1000) these directories must remain owned by ` +
          `the server group, not "${groupName}".`,
      );
      return;
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
    // A special file (FIFO, character/block device, socket) is not a directory
    // or a regular file. O_NONBLOCK already kept the open from hanging on a
    // FIFO; now refuse to add setgid/group bits to it. Fail closed: no
    // mutation, no path-based fallback, one warned skip.
    if (isSpecialFileType(stat.mode)) {
      if (!specialFileWarned) {
        specialFileWarned = true;
        warn(
          `Paperclip: skipping shared-group ownership on ${dirPath} — the opened target is a ` +
            `special file (FIFO, character/block device, or socket), not a directory or regular ` +
            `file. Shared-group traversal repair applies to directories and regular files only. ` +
            `No mutation performed.`,
        );
      }
      return;
    }
    await handle.chown(stat.uid, gid);
    const currentMode = stat.mode & 0o7777;
    // Directories need setgid + group rwx for group inheritance and traversal.
    // Regular files need only group rw: adding setgid + group execute to a
    // file produces a setgid executable built from content an agent can write.
    const groupBits = stat.isDirectory() ? 0o2070 : 0o0060;
    await handle.chmod(currentMode | groupBits);
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
