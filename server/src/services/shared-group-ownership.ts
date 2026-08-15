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
