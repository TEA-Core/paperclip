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

// SUP-15903: the shared-group self-repair previously latched three
// process-lifetime booleans `true` on the first failure anywhere and silently
// suppressed every later cross-uid repair failure for the whole life of the
// server. That is exactly why the uid-split bug recurred with no trail: after
// the first EPERM anywhere, no second offending path ever produced a diagnostic.
// Diagnostics are now deduped per (reason, path): a second DISTINCT offending
// path in a later provisioning attempt produces its own diagnostic, while the
// same (reason, path) pair is not re-warned on every attempt. The set is capped
// so it cannot grow without bound.
const warnedKeys = new Set<string>();
const WARNED_KEYS_CAP = 4096;

/**
 * Record that `reason` was diagnosed for `dirPath`. Returns true when this is
 * the first time this (reason, path) pair has been seen (the caller should
 * emit its diagnostic), false when it was already reported for this pair.
 */
function shouldWarn(reason: string, dirPath: string): boolean {
  const key = `${reason}\u0000${dirPath}`;
  if (warnedKeys.has(key)) return false;
  warnedKeys.add(key);
  if (warnedKeys.size > WARNED_KEYS_CAP) {
    warnedKeys.clear();
    warnedKeys.add(key);
  }
  return true;
}

export type SharedGroupRepairReason =
  | "cannot-open"
  | "unverifiable"
  | "outside-containment"
  | "denied-server-owned"
  | "missing-group"
  | "special-file"
  | "chown-refused";

/**
 * The outcome of a single `ensureSharedGroupOwnership` repair attempt.
 *
 * The repair no longer returns `void` in all three of "mutated", "already
 * correct", and "could not mutate" — the caller (worktree self-repair) now
 * distinguishes them, so it can stop claiming a self-repair ran when the OS
 * actually refused it.
 */
export interface SharedGroupRepairOutcome {
  /**
   * - "repaired"    — a chown/chmod mutation was applied.
   * - "not-needed"  — the target already carried the shared group + group bits;
   *                   no mutation was required or performed.
   * - "could-not"   — the repair could not be performed (open refused, group
   *                   missing, a guard fired, or the OS refused the chown/chmod).
   */
  result: "repaired" | "not-needed" | "could-not";
  /** True only when a chown/chmod mutation was actually applied. */
  repaired: boolean;
  /** Machine-readable reason within the "could-not" class. */
  reason?: SharedGroupRepairReason;
  /** OS errno (e.g. "EPERM", "EACCES", "ELOOP") when a syscall was refused. */
  errno?: string;
  /** Owner uid of the target, when the inode was opened and stat'd. */
  ownerUid?: number;
}

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
): Promise<SharedGroupRepairOutcome> {
  const groupName = opts.groupName ?? DEFAULT_SHARED_GROUP_NAME;
  const resolveGid = opts.resolveGid ?? defaultResolveGid;
  const resolveMasterKeyDir = opts.resolveMasterKeyDir ?? resolveDefaultMasterKeyDir;
  const resolvePostgresDataDir = opts.resolvePostgresDataDir ?? resolveDefaultPostgresDataDir;
  const resolveDatabaseBackupDir = opts.resolveDatabaseBackupDir ?? resolveDefaultDatabaseBackupDir;
  const warn = opts.warn ?? console.warn.bind(console);
  const containmentRoot =
    opts.containmentRoot != null ? path.resolve(opts.containmentRoot) : null;
  // The server uid, used to classify a cross-uid chown refusal (the M1 split:
  // server uid 1000 cannot chgrp a file owned by the agent uid 1001).
  const serverUid = typeof process.getuid === "function" ? process.getuid() : null;

  const errnoOf = (err: unknown): string | undefined =>
    err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string"
      ? (err as NodeJS.ErrnoException).code
      : undefined;

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
    // All fail-closed: no mutation, no path-based fallback. The repair could
    // not even open the target, so it could not have repaired it.
    const errno = errnoOf(err);
    if (shouldWarn("cannot-open", dirPath)) {
      warn(
        `Paperclip: cannot open ${dirPath} for shared-group ownership repair: ` +
          `${err instanceof Error ? err.message : String(err)}${errno ? ` (errno ${errno})` : ""}. ` +
          `The repair could not even open the target, so it could not be repaired by the server user. ` +
          `No path-based mutation performed.`,
      );
    }
    return { result: "could-not", reason: "cannot-open", errno, repaired: false };
  }

  let ownerUid: number | undefined;

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
      if (shouldWarn("unverifiable", dirPath)) {
        warn(
          `Paperclip: refusing shared-group ownership on ${dirPath} — the opened handle could not ` +
            `be verified (no /proc/self/fd) and a containment root was required. No mutation performed.`,
        );
      }
      return { result: "could-not", reason: "unverifiable", repaired: false };
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
        if (shouldWarn("outside-containment", dirPath)) {
          warn(
            `Paperclip: refusing shared-group ownership on ${dirPath} — the resolved target ` +
              `${verifiedPath} is outside the containment root ${resolvedRoot}. ` +
              `This may indicate a concurrent symlink swap (TOCTOU). No mutation performed.`,
          );
        }
        return { result: "could-not", reason: "outside-containment", repaired: false };
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
      if (shouldWarn("denied-server-owned", dirPath)) {
        warn(
          `Paperclip: refusing shared-group ownership on ${dirPath} — it resolves to ${deniedCheckPath}, ` +
            `which is a server-owned directory (secrets master-key, embedded-Postgres data, or ` +
            `database backup) or an ancestor/descendant of one. ` +
            `Under M1 (agent uid 1001, server uid 1000) these directories must remain owned by ` +
            `the server group, not "${groupName}".`,
        );
      }
      return { result: "could-not", reason: "denied-server-owned", repaired: false };
    }

    const gid = await resolveGid(groupName);
    if (gid == null) {
      if (shouldWarn("missing-group", dirPath)) {
        warn(
          `Paperclip: group "${groupName}" not found; skipping shared-group ownership for ${dirPath}. ` +
            `Under M1 (agent uid 1001, server uid 1000) this group is required for cross-uid write access.`,
        );
      }
      return { result: "could-not", reason: "missing-group", repaired: false };
    }

    // Hardlink note: chown/chmod via fd targets the inode, so a concurrent
    // hardlink rename cannot redirect the mutation. The only residual risk is
    // a hardlink to a sensitive file that was opened before the check — this
    // is not exploitable in practice because the caller (worktree self-repair)
    // only operates on git-tracked paths within the containment root.
    const stat = await handle.stat();
    ownerUid = stat.uid;
    // A special file (FIFO, character/block device, socket) is not a directory
    // or a regular file. O_NONBLOCK already kept the open from hanging on a
    // FIFO; now refuse to add setgid/group bits to it. Fail closed: no
    // mutation, no path-based fallback, one warned skip.
    if (isSpecialFileType(stat.mode)) {
      if (shouldWarn("special-file", dirPath)) {
        warn(
          `Paperclip: skipping shared-group ownership on ${dirPath} — the opened target is a ` +
            `special file (FIFO, character/block device, or socket), not a directory or regular ` +
            `file. Shared-group traversal repair applies to directories and regular files only. ` +
            `No mutation performed.`,
        );
      }
      return {
        result: "could-not",
        reason: "special-file",
        repaired: false,
        ownerUid: stat.uid,
      };
    }

    const currentMode = stat.mode & 0o7777;
    // Directories need setgid + group rwx for group inheritance and traversal.
    // Regular files need only group rw: adding setgid + group execute to a
    // file produces a setgid executable built from content an agent can write.
    const groupBits = stat.isDirectory() ? 0o2070 : 0o0060;

    // Already correct? If the target already carries the shared group and the
    // required group bits, the repair would be a no-op — skip the mutation
    // rather than issuing a chown that a cross-uid target would refuse anyway.
    // (In the M1 uid split the owning uid is the agent, not the server, so an
    // unnecessary chown is exactly what turns into a spurious EPERM.)
    const groupAlreadyCorrect = stat.gid === gid;
    const bitsAlreadyCorrect = (currentMode & groupBits) === groupBits;
    if (groupAlreadyCorrect && bitsAlreadyCorrect) {
      return { result: "not-needed", repaired: false, ownerUid: stat.uid };
    }

    await handle.chown(stat.uid, gid);
    await handle.chmod(currentMode | groupBits);
    return {
      result: "repaired",
      repaired: true,
      ownerUid: stat.uid,
    };
  } catch (err) {
    const errno = errnoOf(err);
    // A cross-uid refusal: POSIX permits chown/chgrp only for the file's owner
    // or root. When the server uid opened a file owned by another uid (the M1
    // split: server 1000 vs. agent 1001), the chown below is refused with
    // EPERM and mutates nothing. Say so explicitly instead of a generic
    // "chgrp failed", which the caller previously read as "repaired but
    // genuinely unfixable".
    const crossUid =
      ownerUid != null && serverUid != null && ownerUid !== serverUid;
    if (shouldWarn("chown-refused", dirPath)) {
      const detail =
        errno === "EPERM"
          ? `The server user${serverUid != null ? ` (uid ${serverUid})` : ""} does not own this file ` +
            `${crossUid ? `(owned by uid ${ownerUid})` : ""} and cannot change its group — chown/chgrp is ` +
            `permitted only for the file's owner or root. Its owner can run: chgrp ${groupName} <path>.`
          : `The "${groupName}" group (gid resolved) is present but chgrp/chmod via handle failed`;
      warn(
        `Paperclip: could not repair shared-group ownership on ${dirPath}: ` +
          `${err instanceof Error ? err.message : String(err)}${errno ? ` (errno ${errno})` : ""}. ` +
          `${detail}`,
      );
    }
    return {
      result: "could-not",
      reason: "chown-refused",
      errno,
      repaired: false,
      ownerUid,
    };
  } finally {
    try {
      await handle.close();
    } catch {
      // Ignore close errors; the OS reclaims the fd on process exit.
    }
  }
}
