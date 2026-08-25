import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSharedGroupOwnership } from "./shared-group-ownership.js";

export const HEARTBEAT_RUN_SCRATCH_MARKER = ".paperclip-run-scratch.json";

export interface HeartbeatRunScratchMetadata {
  version: 1;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  createdAt: string;
}

/**
 * A scratch directory found on disk, paired with the marker that identifies the
 * run that owns it. The reaper works from these rather than from in-memory
 * state, which is the entire point: the leak that motivated SUP-13949 outlived
 * the server process that created it.
 */
export interface DiscoveredRunScratch {
  dir: string;
  metadata: HeartbeatRunScratchMetadata;
}

export interface HeartbeatRunScratch {
  dir: string;
  markerPath: string;
  metadata: HeartbeatRunScratchMetadata;
}

export interface HeartbeatRunScratchEnvResult {
  env: Record<string, string>;
  tempKeysApplied: string[];
}

export type HeartbeatRunScratchCleanupResult =
  | { removed: true; dir: string; terminatedProcessGroup?: RunScratchTerminationOutcome }
  | {
    removed: false;
    dir: string;
    reason: "missing" | "unmarked" | "owner_mismatch" | "process_group_alive" | "process_group_survived";
    terminatedProcessGroup?: RunScratchTerminationOutcome;
  };

/**
 * SUP-13949: what happened when a terminal run's process group was still alive.
 *
 * `already_gone` and `terminated` are both success — the distinction only
 * matters for telling "the run tidied up after itself" apart from "we had to".
 * A rising `terminated` rate on runs that exited cleanly is the signal that an
 * adapter is leaving background helpers behind.
 */
export type RunScratchTerminationOutcome =
  | { terminated: true; reason: "already_gone"; escalatedToKill: false }
  | { terminated: true; reason: "signalled"; escalatedToKill: boolean }
  | { terminated: false; reason: "no_group" | "survived"; escalatedToKill: boolean };

/** Time between the group SIGTERM and the SIGKILL escalation. */
export const RUN_SCRATCH_TERMINATION_GRACE_MS = 5_000;

/**
 * A scratch directory is only reaped once its owning run has been terminal for
 * this long. The window is not about the processes — it is about the *server*:
 * a run row can be terminal for a beat before the heartbeat teardown that owns
 * it reaches its own cleanup, and reaping underneath that teardown would delete
 * a directory it is still writing an event about.
 */
export const RUN_SCRATCH_REAP_MIN_AGE_MS = 10 * 60 * 1000;

const TEMP_ENV_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;
const ISSUE_SEGMENT_MAX_CHARS = 32;

function sanitizePathSegment(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ISSUE_SEGMENT_MAX_CHARS)
    .replace(/[.-]+$/g, "");
  return normalized || fallback;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readMarker(markerPath: string): Promise<HeartbeatRunScratchMetadata | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (
      rec.version !== 1 ||
      typeof rec.companyId !== "string" ||
      typeof rec.agentId !== "string" ||
      typeof rec.runId !== "string" ||
      typeof rec.createdAt !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      companyId: rec.companyId,
      agentId: rec.agentId,
      runId: rec.runId,
      issueId: typeof rec.issueId === "string" ? rec.issueId : null,
      issueIdentifier: typeof rec.issueIdentifier === "string" ? rec.issueIdentifier : null,
      createdAt: rec.createdAt,
    };
  } catch {
    return null;
  }
}

export async function prepareHeartbeatRunScratch(input: {
  companyId: string;
  agentId: string;
  runId: string;
  issueId?: string | null;
  issueIdentifier?: string | null;
  now?: Date;
}): Promise<HeartbeatRunScratch> {
  const issueSegment = sanitizePathSegment(input.issueIdentifier, "unassigned");
  const runSegment = sanitizePathSegment(input.runId.slice(0, 12), "run");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-run-${issueSegment}-${runSegment}-`));
  await ensureSharedGroupOwnership(dir);
  const markerPath = path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER);
  const metadata: HeartbeatRunScratchMetadata = {
    version: 1,
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId,
    issueId: input.issueId ?? null,
    issueIdentifier: input.issueIdentifier ?? null,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  await fs.writeFile(markerPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return { dir, markerPath, metadata };
}

export function buildHeartbeatRunScratchEnv(
  existingEnv: Record<string, unknown>,
  scratch: HeartbeatRunScratch,
): HeartbeatRunScratchEnvResult {
  const env: Record<string, string> = {
    PAPERCLIP_RUN_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_TASK_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_TMPDIR: scratch.dir,
  };
  const tempKeysApplied: string[] = [];
  for (const key of TEMP_ENV_KEYS) {
    const existing = existingEnv[key];
    if (typeof existing === "string" && existing.trim().length > 0) continue;
    env[key] = scratch.dir;
    tempKeysApplied.push(key);
  }
  return { env, tempKeysApplied };
}

/**
 * SUP-13949: terminate what a finished run left behind in its process group.
 *
 * Adapter children are spawned `detached`, so each run owns a process group.
 * `runChildProcess` signals that group on timeout, but a run whose direct child
 * simply *exits* — the normal and the crash path alike — leaves any background
 * helper the child forked still running. Those reparent to pid 1 and, because
 * nothing supervises them any more, never exit: the observed fleet state was
 * 1,291 such processes across 12 run families, the oldest 42 hours old, holding
 * 19 GB and pushing the container to 93% of its memory limit.
 *
 * They are not merely idle. 309 of them belonged to a run investigating Claude
 * OAuth and were still able to write `/paperclip/.claude/.credentials.json` a
 * day after that run ended, which made a credential failure look like
 * deliberate interference. A long-lived orphan acts.
 *
 * Only ever called once the owning run is terminal, so there is no live work in
 * the group to protect. SIGTERM first so a helper can flush, then SIGKILL after
 * the grace — the escalation is the point, since the whole failure mode is
 * processes that ignore being asked nicely.
 *
 * `kill` and `sleep` are injected so the escalation ladder is testable without
 * spawning real processes; `isProcessGroupAlive` decides liveness, and the
 * group is only ever signalled while it reports alive. That check also carries
 * the pid-reuse guard: POSIX will not recycle a pgid while its group is
 * non-empty, so a group that answers `kill(-pgid, 0)` is still the group we
 * started.
 */
export async function terminateRunScratchProcessGroup(input: {
  processGroupId: number | null | undefined;
  isProcessGroupAlive: (processGroupId: number | null | undefined) => boolean;
  kill?: (target: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  graceMs?: number;
}): Promise<RunScratchTerminationOutcome> {
  const { processGroupId } = input;
  if (
    process.platform === "win32" ||
    typeof processGroupId !== "number" ||
    !Number.isInteger(processGroupId) ||
    processGroupId <= 0
  ) {
    return { terminated: false, reason: "no_group", escalatedToKill: false };
  }
  if (!input.isProcessGroupAlive(processGroupId)) {
    return { terminated: true, reason: "already_gone", escalatedToKill: false };
  }

  const kill = input.kill ?? ((target: number, signal: NodeJS.Signals) => process.kill(target, signal));
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const graceMs = Math.max(0, input.graceMs ?? RUN_SCRATCH_TERMINATION_GRACE_MS);

  try {
    kill(-processGroupId, "SIGTERM");
  } catch {
    // ESRCH between the liveness check and the signal just means the group
    // drained on its own, which is the outcome we wanted.
    if (!input.isProcessGroupAlive(processGroupId)) {
      return { terminated: true, reason: "already_gone", escalatedToKill: false };
    }
  }

  await sleep(graceMs);
  if (!input.isProcessGroupAlive(processGroupId)) {
    return { terminated: true, reason: "signalled", escalatedToKill: false };
  }

  try {
    kill(-processGroupId, "SIGKILL");
  } catch {
    // Same race, or the signal is genuinely undeliverable. The liveness check
    // below is the arbiter either way.
  }
  if (input.isProcessGroupAlive(processGroupId)) {
    // SIGKILL cannot be caught, so a group that survives it was never sent it —
    // an unprivileged supervisor under the uid split, or a process wedged in
    // uninterruptible sleep. Report it rather than deleting the directory out
    // from under processes that are still using it.
    return { terminated: false, reason: "survived", escalatedToKill: true };
  }
  return { terminated: true, reason: "signalled", escalatedToKill: true };
}

export async function cleanupHeartbeatRunScratch(input: {
  scratch: HeartbeatRunScratch;
  processGroupId?: number | null;
  isProcessGroupAlive?: (processGroupId: number | null | undefined) => boolean;
  /**
   * SUP-13949: how to handle a process group that is still alive at cleanup.
   *
   * Omitted, the pre-SUP-13949 behaviour applies and cleanup skips with
   * `process_group_alive` — which is what leaked, because nothing ever retried.
   * Supplied, the group is terminated first and the directory is then removed.
   * Only pass this once the run is terminal.
   */
  terminateProcessGroup?: (processGroupId: number | null | undefined) => Promise<RunScratchTerminationOutcome>;
}): Promise<HeartbeatRunScratchCleanupResult> {
  const tmpRoot = path.resolve(os.tmpdir());
  const dir = path.resolve(input.scratch.dir);
  if (!isPathInside(tmpRoot, dir) || !path.basename(dir).startsWith("paperclip-run-")) {
    return { removed: false, dir, reason: "unmarked" };
  }
  try {
    const stats = await fs.stat(dir);
    if (!stats.isDirectory()) return { removed: false, dir, reason: "missing" };
  } catch {
    return { removed: false, dir, reason: "missing" };
  }

  const marker = await readMarker(path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER));
  if (!marker) return { removed: false, dir, reason: "unmarked" };
  if (
    marker.companyId !== input.scratch.metadata.companyId ||
    marker.agentId !== input.scratch.metadata.agentId ||
    marker.runId !== input.scratch.metadata.runId
  ) {
    return { removed: false, dir, reason: "owner_mismatch" };
  }
  let terminatedProcessGroup: RunScratchTerminationOutcome | undefined;
  if (input.isProcessGroupAlive?.(input.processGroupId) === true) {
    if (!input.terminateProcessGroup) {
      return { removed: false, dir, reason: "process_group_alive" };
    }
    terminatedProcessGroup = await input.terminateProcessGroup(input.processGroupId);
    if (!terminatedProcessGroup.terminated) {
      // Leave the directory in place: the survivors still hold it, and removing
      // it would strand them with a missing cwd instead of stopping them.
      return { removed: false, dir, reason: "process_group_survived", terminatedProcessGroup };
    }
  }

  await fs.rm(dir, { recursive: true, force: true });
  return terminatedProcessGroup ? { removed: true, dir, terminatedProcessGroup } : { removed: true, dir };
}

/**
 * SUP-13949: enumerate the run scratch directories present on this host.
 *
 * The in-memory handle a run holds is not enough to find its own leak. When the
 * server restarts — or crashes — every `HeartbeatRunScratch` it was holding is
 * gone while the directories and their process groups are not, and nothing ever
 * looks at them again. That is how a leaked family reached 42 hours old. This
 * reads the ground truth back off disk instead.
 *
 * Unmarked directories are skipped, not returned. `os.tmpdir()` is shared with
 * everything else on the host, and a `paperclip-run-`-prefixed name alone is
 * not proof of ownership — only the marker is.
 */
export async function discoverRunScratchDirs(input?: {
  tmpRoot?: string;
}): Promise<DiscoveredRunScratch[]> {
  const tmpRoot = path.resolve(input?.tmpRoot ?? os.tmpdir());
  let entries: Dirent[];
  try {
    entries = await fs.readdir(tmpRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: DiscoveredRunScratch[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("paperclip-run-")) continue;
    const dir = path.join(tmpRoot, entry.name);
    const metadata = await readMarker(path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER));
    if (!metadata) continue;
    found.push({ dir, metadata });
  }
  return found;
}

export type RunScratchLiveness = "active" | "finished" | "unknown";

export type RunScratchReapOutcome =
  | { dir: string; runId: string; reaped: true; terminatedProcessGroup: RunScratchTerminationOutcome }
  | {
    dir: string;
    runId: string;
    reaped: false;
    reason: "active" | "unknown" | "too_recent" | "process_group_survived" | "error";
  };

/**
 * SUP-13949: the backstop. Terminates and removes scratch directories whose
 * owning run is over, whatever happened to the server in between.
 *
 * Three refusals, and each one is load-bearing:
 *
 * - `active` — never touch a running run. Obvious, and the reason the liveness
 *   lookup is a required input rather than a heuristic on directory age.
 * - `unknown` — a run the caller cannot resolve is NOT treated as finished. A
 *   transient database error must not turn this into a fleet-wide killer of
 *   live runs; refusing to act is always the safe direction here, because the
 *   next sweep will retry with a working lookup.
 * - `too_recent` — a run row reaches a terminal status slightly before the
 *   heartbeat teardown that owns it finishes writing its cleanup event. Waiting
 *   out {@link RUN_SCRATCH_REAP_MIN_AGE_MS} keeps the sweep from racing the
 *   owner for the same directory.
 *
 * Termination comes before removal, always. `fs.rm` on a directory whose
 * processes are alive removes the path and leaves the processes — which is the
 * failure this exists to end, not a partial version of the fix.
 */
export async function reapAbandonedRunScratchDirs(input: {
  resolveLiveness: (metadata: HeartbeatRunScratchMetadata) => Promise<{
    liveness: RunScratchLiveness;
    processGroupId?: number | null;
  }>;
  terminateProcessGroup: (processGroupId: number | null | undefined) => Promise<RunScratchTerminationOutcome>;
  tmpRoot?: string;
  now?: Date;
  minAgeMs?: number;
  onError?: (err: unknown, dir: string) => void;
}): Promise<RunScratchReapOutcome[]> {
  const nowMs = (input.now ?? new Date()).getTime();
  const minAgeMs = Math.max(0, input.minAgeMs ?? RUN_SCRATCH_REAP_MIN_AGE_MS);
  const discovered = await discoverRunScratchDirs({ tmpRoot: input.tmpRoot });
  const outcomes: RunScratchReapOutcome[] = [];

  for (const { dir, metadata } of discovered) {
    const runId = metadata.runId;
    try {
      const createdMs = Date.parse(metadata.createdAt);
      // An unparseable timestamp must not read as "infinitely old". Treat it as
      // brand new so the directory is skipped rather than eagerly destroyed.
      if (!Number.isFinite(createdMs) || nowMs - createdMs < minAgeMs) {
        outcomes.push({ dir, runId, reaped: false, reason: "too_recent" });
        continue;
      }

      const { liveness, processGroupId } = await input.resolveLiveness(metadata);
      if (liveness !== "finished") {
        outcomes.push({ dir, runId, reaped: false, reason: liveness === "active" ? "active" : "unknown" });
        continue;
      }

      const terminatedProcessGroup = await input.terminateProcessGroup(processGroupId);
      if (!terminatedProcessGroup.terminated) {
        outcomes.push({ dir, runId, reaped: false, reason: "process_group_survived" });
        continue;
      }

      await fs.rm(dir, { recursive: true, force: true });
      outcomes.push({ dir, runId, reaped: true, terminatedProcessGroup });
    } catch (err) {
      input.onError?.(err, dir);
      outcomes.push({ dir, runId, reaped: false, reason: "error" });
    }
  }

  return outcomes;
}
