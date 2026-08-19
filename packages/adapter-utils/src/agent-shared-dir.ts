import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_SHARED_GROUP_NAME = "agents";

/**
 * Make a server-created directory usable by the agent principal (SUP-13484).
 *
 * Under M1 (SUP-12472/12531) the control-plane server runs as uid 1000 and every
 * adapter child is exec'd through the setuid shim at uid 1001, so a directory the
 * server creates is only reachable by the child through the shared `agents` group.
 * `server/src/services/shared-group-ownership.ts` already does this for worktrees
 * and run scratch — but it lives under `server/`, which adapter packages cannot
 * import, so every `mkdtemp` in `packages/adapters/**` was left uncovered.
 *
 * That gap is not cosmetic, because **`mkdtemp` is immune to umask**: POSIX fixes
 * the new directory at `0700`, so the server's `umask 0002` (SUP-12529) — the thing
 * that makes every *other* server-created directory group-writable — does nothing
 * here. The result is a `0700 node:node` directory handed to a uid-1001 child, and
 * the kernel checks parent-directory permission before it checks existence, so the
 * child's first write inside it fails with EACCES (not EEXIST/ENOENT) even for a
 * path the server already created. That is the fleet outage: `XDG_CONFIG_HOME`
 * pointed at such a directory and every `opencode_local` agent died on dispatch
 * with `EACCES: permission denied, mkdir '<tmp>/opencode'`.
 *
 * Fail-soft by design. This runs on developer laptops and non-container hosts where
 * the `agents` group does not exist and no uid drop happens; there the child shares
 * the server's uid and already has access, so a missing group or a failed chown is
 * not an error — it is the ungated configuration. Never throw from here: throwing
 * would convert "no uid gate" into a hard adapter failure, which is the same class
 * of outage in the opposite direction.
 */

let cachedGid: number | null | undefined;
let missingGroupWarned = false;
let chgrpFailedWarned = false;

async function resolveSharedGid(groupName: string): Promise<number | null> {
  if (cachedGid !== undefined) return cachedGid;

  const fromEnv = process.env.PAPERCLIP_AGENTS_GID?.trim();
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      cachedGid = parsed;
      return cachedGid;
    }
  }

  try {
    const { stdout } = await execFileAsync("getent", ["group", groupName], {
      timeout: 5000,
      maxBuffer: 4096,
    });
    const parts = stdout.trim().split(":");
    if (parts.length >= 3) {
      const parsed = Number.parseInt(parts[2], 10);
      if (Number.isInteger(parsed)) {
        cachedGid = parsed;
        return cachedGid;
      }
    }
  } catch {
    // getent absent (macOS/Windows/slim images) or the group does not exist.
  }

  cachedGid = null;
  return cachedGid;
}

export interface EnsureAgentAccessibleDirOptions {
  groupName?: string;
  warn?: (message: string) => void;
}

/**
 * chgrp the directory to the shared agent group and add setgid + group rwx,
 * so a child at the agent uid can traverse and write inside it.
 *
 * The setgid bit (`0o2000`) matters as much as the group bits: without it, files
 * and subdirectories the *child* creates inside would take the child's own primary
 * gid, and the server (uid 1000) would then be unable to read back or clean up what
 * it staged. Existing mode bits are preserved — this only ever widens to the group,
 * never to other.
 */
export async function ensureAgentAccessibleDir(
  dirPath: string,
  opts: EnsureAgentAccessibleDirOptions = {},
): Promise<void> {
  if (process.platform === "win32") return;

  const groupName = opts.groupName ?? DEFAULT_SHARED_GROUP_NAME;
  const warn = opts.warn ?? console.warn.bind(console);

  const gid = await resolveSharedGid(groupName);
  if (gid == null) {
    if (!missingGroupWarned) {
      missingGroupWarned = true;
      warn(
        `Paperclip: group "${groupName}" not found; leaving ${dirPath} at its default ownership. ` +
          `This is expected when agent runs share the server's uid; under M1 (agent uid 1001, ` +
          `server uid 1000) the group is required for the child to write inside it.`,
      );
    }
    return;
  }

  try {
    const stat = await fs.stat(dirPath);
    await fs.chown(dirPath, stat.uid, gid);
    await fs.chmod(dirPath, (stat.mode & 0o7777) | 0o2070);
  } catch (err) {
    if (!chgrpFailedWarned) {
      chgrpFailedWarned = true;
      warn(
        `Paperclip: failed to grant "${groupName}" access to ${dirPath}: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `An agent child running at a different uid will fail with EACCES inside it.`,
      );
    }
  }
}

/**
 * Recursive variant, for a directory whose *contents* the child must also read.
 *
 * Marking the directory alone is not enough when files are copied into it: `fs.cp`
 * preserves the source mode, so a `0600` file staged from the operator's own config
 * (`auth.json` is the one that matters) stays unreadable to the child even though it
 * now carries the shared gid. Directories get setgid + group rwx, files get group rw
 * — the child refreshes credentials in place, so read-only is not sufficient.
 *
 * Group here means the agent principal, which is the intended reader of a config we
 * are staging *for* it; this widens nothing to `other`.
 */
export async function ensureAgentAccessibleTree(
  dirPath: string,
  opts: EnsureAgentAccessibleDirOptions = {},
): Promise<void> {
  if (process.platform === "win32") return;
  const gid = await resolveSharedGid(opts.groupName ?? DEFAULT_SHARED_GROUP_NAME);
  if (gid == null) return;

  await ensureAgentAccessibleDir(dirPath, opts);

  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const child = path.join(dirPath, entry.name);
    // Never follow symlinks: a link in the staged tree could otherwise redirect the
    // chown/chmod onto an arbitrary server-owned path.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await ensureAgentAccessibleTree(child, opts);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = await fs.stat(child);
      await fs.chown(child, stat.uid, gid);
      await fs.chmod(child, (stat.mode & 0o7777) | 0o0060);
    } catch {
      // Fail-soft, same rationale as ensureAgentAccessibleDir.
    }
  }
}

/** Test-only: drop the memoised gid lookup. */
export function resetAgentSharedGidCacheForTests(): void {
  cachedGid = undefined;
  missingGroupWarned = false;
  chgrpFailedWarned = false;
}
