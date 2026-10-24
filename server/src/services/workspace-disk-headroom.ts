import fs from "node:fs/promises";

/**
 * SUP-20840: refuse to create a new git worktree when the data volume is
 * already nearly full.
 *
 * Provisioning a worktree materializes a full `node_modules` tree, which is
 * several GB per worktree. On 2026-10-22 a burst of provisions filled the
 * volume to 100% and the instance crash-looped, so provisioning must stop well
 * before the volume is exhausted. The threshold is percent used of the
 * filesystem that holds the worktree parent directory.
 *
 * The check only guards creating a worktree. Reusing an existing worktree adds
 * no meaningful data and must keep working so in-flight issues can finish.
 */

export const WORKSPACE_DISK_MAX_USED_PERCENT_ENV = "PAPERCLIP_WORKSPACE_PROVISION_MAX_DISK_USED_PERCENT";
export const DEFAULT_WORKSPACE_DISK_MAX_USED_PERCENT = 80;

type StatFs = (path: string) => Promise<{ blocks: number; bfree: number; bavail: number }>;

/**
 * Threshold in percent used, or null when the guard is disabled. Only `0` turns
 * it off; an unset or unparseable value falls back to the default so a typo
 * cannot silently disable the guard.
 */
export function resolveWorkspaceDiskMaxUsedPercent(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[WORKSPACE_DISK_MAX_USED_PERCENT_ENV]?.trim();
  if (!raw) return DEFAULT_WORKSPACE_DISK_MAX_USED_PERCENT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) return DEFAULT_WORKSPACE_DISK_MAX_USED_PERCENT;
  return value === 0 ? null : value;
}

/** Percent used the way `df` reports it: used / (used + space available to unprivileged users). */
export function diskUsedPercent(stat: { blocks: number; bfree: number; bavail: number }): number {
  const used = stat.blocks - stat.bfree;
  const total = used + stat.bavail;
  return total > 0 ? (used / total) * 100 : 0;
}

/**
 * Returns the refusal (message and error details for a WorkspaceGitScanError) when
 * the volume holding `path` is at or above the limit, otherwise null.
 */
export async function checkWorkspaceDiskHeadroom(input: {
  /** Any existing path on the volume that will receive the worktree. */
  path: string;
  env?: NodeJS.ProcessEnv;
  statfs?: StatFs;
}): Promise<{ message: string; details: Record<string, unknown> } | null> {
  const maxUsedPercent = resolveWorkspaceDiskMaxUsedPercent(input.env);
  if (maxUsedPercent === null) return null;
  let usedPercent: number;
  try {
    usedPercent = diskUsedPercent(await (input.statfs ?? fs.statfs)(input.path));
  } catch {
    // shortcut: an unreadable volume is not proof it is full, so fail open; upgrade if a platform without statfs ever needs the guard.
    return null;
  }
  if (usedPercent < maxUsedPercent) return null;
  return {
    message:
      `Refusing to provision a new worktree: the volume holding "${input.path}" is ${usedPercent.toFixed(1)}% used, `
      + `at or above the ${maxUsedPercent}% limit. Free disk space (remove stale worktrees or old logs), `
      + `or raise ${WORKSPACE_DISK_MAX_USED_PERCENT_ENV} (0 disables the guard), then retry.`,
    details: {
      path: input.path,
      usedPercent: Number(usedPercent.toFixed(1)),
      maxUsedPercent,
      envVar: WORKSPACE_DISK_MAX_USED_PERCENT_ENV,
    },
  };
}
