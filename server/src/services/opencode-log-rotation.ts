import fs from "node:fs/promises";
import path from "node:path";
import { resolveHomeAwarePath } from "../home-paths.js";

// SUP-13970. opencode's own log (`<storage>/log/opencode.log`) is a single
// unrotated file: it reached 1 GB on the paperclip host, on the same volume as
// the worktrees, with nothing to bound it.
//
// The sweep is size-triggered: when the live log exceeds `maxSizeBytes`, its
// most recent `retainedTailBytes` are copied to a numbered archive and the
// live file is truncated in place. Copy-truncate, not unlink: opencode may
// hold the log open with an append descriptor, and renaming or unlinking it
// would leave that writer on an orphaned inode. The archive is written before
// the truncate so a crash between the two leaves the log oversized but the
// retained bytes archived.

export const OPENCODE_LOG_BASENAME = "opencode.log";
export const OPENCODE_LOG_DIR_NAME = "log";

/** Default opencode storage root, matching the resolution in feedback.ts. */
export const DEFAULT_OPENCODE_STORAGE_DIR = "~/.local/share/opencode";

/** Rotate when the live log exceeds this. 512 MiB. */
export const DEFAULT_OPENCODE_LOG_MAX_SIZE_BYTES = 512 * 1024 * 1024;

/** Number of rotated archives to keep. Worst-case archive footprint is
 *  retainedArchives x retainedTailBytes. */
export const DEFAULT_OPENCODE_LOG_RETAINED_ARCHIVES = 5;

/** Trailing bytes of the live log retained into each archive. 32 MiB. */
export const DEFAULT_OPENCODE_LOG_RETAINED_TAIL_BYTES = 32 * 1024 * 1024;

/**
 * Resolve the opencode storage root the way the feedback bundle does:
 * `$PAPERCLIP_OPENCODE_STORAGE_DIR` first, then the shared default. The env
 * var is read at call time so the resolution stays testable. Empty or
 * whitespace-only values fall back to the default: a misconfigured empty var
 * must not resolve the log to `log/opencode.log` under the server's cwd.
 */
export function resolveOpenCodeStorageDir(storageDirOverride?: string): string {
  const candidate =
    storageDirOverride?.trim() ||
    process.env.PAPERCLIP_OPENCODE_STORAGE_DIR?.trim() ||
    DEFAULT_OPENCODE_STORAGE_DIR;
  return resolveHomeAwarePath(candidate);
}

export function resolveOpenCodeLogPath(storageDirOverride?: string): string {
  return path.join(resolveOpenCodeStorageDir(storageDirOverride), OPENCODE_LOG_DIR_NAME, OPENCODE_LOG_BASENAME);
}

export function openCodeLogArchivePath(logPath: string, index: number): string {
  return `${logPath}.${index}`;
}

export interface OpenCodeLogRotationOptions {
  /** opencode storage root (the dir containing `log/`); default from PAPERCLIP_OPENCODE_STORAGE_DIR. */
  storageDir?: string;
  /** Rotate when the live log exceeds this many bytes. */
  maxSizeBytes?: number;
  /** Number of rotated archives to retain; 0 truncates without keeping an archive. */
  retainedArchives?: number;
  /** How many trailing bytes of the live log survive into each archive. */
  retainedTailBytes?: number;
  /** Diagnostics hook; a failing sweep must not propagate to the scheduler. */
  onError?: (err: unknown) => void;
}

export type OpenCodeLogRotationOutcome =
  | {
      rotated: true;
      logPath: string;
      sizeBeforeBytes: number;
      sizeAfterBytes: number;
      archivedBytes: number;
      prunedArchives: number;
    }
  | {
      rotated: false;
      logPath: string;
      reason: "missing" | "not_a_file" | "below_threshold" | "error";
      sizeBeforeBytes?: number;
    };

async function isRegularFile(candidatePath: string): Promise<boolean> {
  try {
    return (await fs.stat(candidatePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * One sweep. Safe no-op when the log (or its directory) does not exist, which
 * is the normal state on hosts that do not run opencode_local.
 */
export async function rotateOpenCodeLog(
  options: OpenCodeLogRotationOptions = {},
): Promise<OpenCodeLogRotationOutcome> {
  const logPath = resolveOpenCodeLogPath(options.storageDir);
  const maxSizeBytes = Math.max(0, options.maxSizeBytes ?? DEFAULT_OPENCODE_LOG_MAX_SIZE_BYTES);
  const retainedArchives = Math.max(
    0,
    Math.floor(options.retainedArchives ?? DEFAULT_OPENCODE_LOG_RETAINED_ARCHIVES),
  );
  const retainedTailBytes = Math.max(
    0,
    options.retainedTailBytes ?? DEFAULT_OPENCODE_LOG_RETAINED_TAIL_BYTES,
  );

  const stats = await fs.stat(logPath).catch(() => null);
  if (stats === null) {
    return { rotated: false, logPath, reason: "missing" };
  }
  if (!stats.isFile()) {
    return { rotated: false, logPath, reason: "not_a_file" };
  }
  const sizeBeforeBytes = stats.size;
  if (sizeBeforeBytes <= maxSizeBytes) {
    return { rotated: false, logPath, reason: "below_threshold", sizeBeforeBytes: sizeBeforeBytes };
  }

  try {
    // Shift existing archives toward the oldest slot, pruning it. `.1` is
    // always the newest archive after the sweep.
    let prunedArchives = 0;
    for (let index = retainedArchives; index >= 1; index -= 1) {
      const source = openCodeLogArchivePath(logPath, index);
      if (!(await isRegularFile(source))) continue;
      if (index === retainedArchives) {
        await fs.rm(source, { force: true });
        prunedArchives += 1;
        continue;
      }
      await fs.rename(source, openCodeLogArchivePath(logPath, index + 1));
    }

    // Retain the tail into `.1`, written atomically: a crash mid-copy leaves a
    // `.1.tmp` that the next sweep clears before writing its own archive.
    let archivedBytes = 0;
    if (retainedArchives > 0) {
      const tmpPath = `${openCodeLogArchivePath(logPath, 1)}.tmp`;
      await fs.rm(tmpPath, { force: true });
      const handle = await fs.open(logPath, "r");
      try {
        // Re-stat: the log is being appended to; seeking past the current EOF
        // would read nothing.
        const current = await fs.stat(logPath);
        const tailBytes = Math.min(Math.max(current.size, 0), retainedTailBytes);
        const position = Math.max(0, current.size - tailBytes);
        const buffer = Buffer.alloc(tailBytes);
        const { bytesRead } = await handle.read(buffer, 0, tailBytes, position);
        await fs.writeFile(tmpPath, buffer.subarray(0, bytesRead));
        archivedBytes = bytesRead;
      } finally {
        await handle.close();
      }
      await fs.rename(tmpPath, openCodeLogArchivePath(logPath, 1));
    }

    // In-place truncate on the same inode: a writer holding an append
    // descriptor keeps writing the live path.
    await fs.truncate(logPath, 0);
    const after = await fs.stat(logPath).catch(() => null);
    return {
      rotated: true,
      logPath,
      sizeBeforeBytes,
      sizeAfterBytes: after ? after.size : 0,
      archivedBytes,
      prunedArchives,
    };
  } catch (err) {
    options.onError?.(err);
    return { rotated: false, logPath, reason: "error", sizeBeforeBytes: sizeBeforeBytes };
  }
}
