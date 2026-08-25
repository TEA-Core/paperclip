import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir,
  resolveSecretsKeyDir,
} from "../home-paths.js";

const execFileAsync = promisify(execFile);

const DEFAULT_SHARED_GROUP_NAME = "agents";

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

function isDeniedServerOwnedDirOrAncestor(
  dirPath: string,
  deniedDirResolvers: Array<() => string>,
): boolean {
  const target = path.resolve(dirPath);
  return deniedDirResolvers.some((resolveDenied) => {
    const denied = path.resolve(resolveDenied());
    return target === denied || denied.startsWith(target + path.sep);
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

  // A configured worktreeParentDir may point outside the repo entirely.
  // "Walk up to stopAt" is only meaningful when the leaf is actually beneath
  // it; otherwise the loop would climb all the way to the filesystem root.
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
    if (parent === current) break; // defensive: hit the filesystem root
    current = parent;
  }

  // Top-down. An interrupted walk must never leave a traversable leaf sitting
  // behind an untraversable ancestor, which reads as repaired but still
  // returns EACCES.
  chain.reverse();
  for (const dir of chain) {
    await ensureSharedGroupOwnership(dir, opts);
  }
}

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

  if (
    isDeniedServerOwnedDirOrAncestor(dirPath, [
      resolveMasterKeyDir,
      resolvePostgresDataDir,
      resolveDatabaseBackupDir,
    ])
  ) {
    warn(
      `Paperclip: refusing shared-group ownership on ${dirPath} — it is a server-owned directory ` +
        `(secrets master-key, embedded-Postgres data, or database backup) or an ancestor of one. ` +
        `Under M1 (agent uid 1001, server uid 1000) these directories must remain owned by the server group, not "${groupName}".`,
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

  try {
    const stat = await fs.stat(dirPath);
    await fs.chown(dirPath, stat.uid, gid);
    const currentMode = stat.mode & 0o7777;
    await fs.chmod(dirPath, currentMode | 0o2070);
  } catch (err) {
    if (!chgrpFailedWarned) {
      chgrpFailedWarned = true;
      warn(
        `Paperclip: failed to set shared-group ownership on ${dirPath}: ${err instanceof Error ? err.message : String(err)}. ` +
          `The "${groupName}" group (gid ${gid}) is present but chgrp/chmod failed.`,
      );
    }
  }
}
