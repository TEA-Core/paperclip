import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isTruthyEnvFlag } from "./models.js";

// SUP-10914: opencode rewrites an assistant message's entire row on every stream
// delta and emits a full-snapshot event alongside it, so the write cost is
// quadratic in message size. On 2026-08-04 one message reached 431 MB and its
// session alone wrote 3.9 GB of events, holding the SQLite write lock long
// enough to fail every other agent's write.
//
// The real fix is inside opencode (bound the row, emit deltas instead of
// snapshots) and is not reachable from this repo. Per-agent databases already
// keep a runaway run from failing OTHER agents; this guard keeps it from
// destroying its OWN database. We cannot see message rows from out here, but a
// runaway is unmistakable in the only thing we can see: the database and its
// WAL grow by hundreds of megabytes inside a single run.
//
// Growth, not absolute size, is the signal. Nothing anywhere deletes rows, so a
// long-lived agent's database is legitimately large; what is never legitimate is
// a single run adding a quarter of a gigabyte to it.

const DEFAULT_GROWTH_LIMIT_MB = 256;
const DEFAULT_POLL_INTERVAL_SEC = 5;
const MIN_POLL_INTERVAL_SEC = 1;
const BYTES_PER_MB = 1024 * 1024;

/** Files SQLite keeps for one database. `-shm` is bounded and tiny, but reading
 * it costs nothing and keeps the accounting honest. */
const SQLITE_SIDECAR_SUFFIXES = ["", "-wal", "-shm"] as const;

export type OpenCodeDatabaseGrowthTrip = {
  databasePath: string;
  baselineBytes: number;
  observedBytes: number;
  growthBytes: number;
  limitBytes: number;
};

function readEnvValue(
  name: string,
  env: Record<string, string>,
  processEnv: NodeJS.ProcessEnv,
): string {
  const fromEnv = env[name];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  const fromProcess = processEnv[name];
  if (typeof fromProcess === "string" && fromProcess.trim().length > 0) return fromProcess.trim();
  return "";
}

/**
 * Where opencode keeps its data directory: `XDG_DATA_HOME/opencode`, else
 * `$HOME/.local/share/opencode`. This mirrors opencode's own resolution — a
 * RELATIVE `OPENCODE_DB` (which is what we set per agent) is joined to it.
 */
export function resolveOpenCodeDataDir(input: {
  env: Record<string, string>;
  processEnv?: NodeJS.ProcessEnv;
}): string {
  const processEnv = input.processEnv ?? process.env;
  const xdgDataHome = readEnvValue("XDG_DATA_HOME", input.env, processEnv);
  if (xdgDataHome) return path.join(xdgDataHome, "opencode");
  const home = readEnvValue("HOME", input.env, processEnv) || os.homedir();
  return path.join(home, ".local", "share", "opencode");
}

/**
 * Absolute path of the database file the run will write. `databaseFile` is the
 * value we put in `OPENCODE_DB`; opencode treats an absolute value as-is and
 * joins a relative one to its data dir.
 */
export function resolveOpenCodeDatabasePath(input: {
  databaseFile: string | null;
  env: Record<string, string>;
  processEnv?: NodeJS.ProcessEnv;
}): string | null {
  const databaseFile = (input.databaseFile ?? "").trim();
  if (databaseFile.length === 0) return null;
  // opencode's own special case; there is no file to watch.
  if (databaseFile === ":memory:") return null;
  if (path.isAbsolute(databaseFile)) return databaseFile;
  return path.join(
    resolveOpenCodeDataDir({ env: input.env, processEnv: input.processEnv }),
    databaseFile,
  );
}

/**
 * Per-run growth budget in bytes. `PAPERCLIP_OPENCODE_DB_GROWTH_LIMIT_MB=0`
 * (or any non-positive value) disables the guard, as does
 * `PAPERCLIP_OPENCODE_DB_GUARD_OFF`.
 */
export function resolveOpenCodeDatabaseGrowthLimitBytes(input: {
  env: Record<string, string>;
  processEnv?: NodeJS.ProcessEnv;
}): number {
  const processEnv = input.processEnv ?? process.env;
  if (isTruthyEnvFlag(readEnvValue("PAPERCLIP_OPENCODE_DB_GUARD_OFF", input.env, processEnv))) {
    return 0;
  }
  const raw = readEnvValue("PAPERCLIP_OPENCODE_DB_GROWTH_LIMIT_MB", input.env, processEnv);
  if (raw.length === 0) return DEFAULT_GROWTH_LIMIT_MB * BYTES_PER_MB;
  const parsed = Number(raw);
  // A malformed value must not silently disable the guard.
  if (!Number.isFinite(parsed)) return DEFAULT_GROWTH_LIMIT_MB * BYTES_PER_MB;
  if (parsed <= 0) return 0;
  return Math.floor(parsed * BYTES_PER_MB);
}

export function resolveOpenCodeDatabasePollIntervalMs(input: {
  env: Record<string, string>;
  processEnv?: NodeJS.ProcessEnv;
}): number {
  const raw = readEnvValue(
    "PAPERCLIP_OPENCODE_DB_GROWTH_POLL_SEC",
    input.env,
    input.processEnv ?? process.env,
  );
  const parsed = raw.length > 0 ? Number(raw) : NaN;
  const seconds =
    Number.isFinite(parsed) && parsed >= MIN_POLL_INTERVAL_SEC ? parsed : DEFAULT_POLL_INTERVAL_SEC;
  return Math.floor(seconds * 1000);
}

/**
 * Total on-disk bytes of the database and its SQLite sidecars. Missing files
 * count as zero: the database does not exist before an agent's first run, and a
 * checkpoint can remove the WAL between samples.
 */
export async function measureOpenCodeDatabaseBytes(databasePath: string): Promise<number> {
  const sizes = await Promise.all(
    SQLITE_SIDECAR_SUFFIXES.map(async (suffix) => {
      try {
        const stat = await fs.stat(`${databasePath}${suffix}`);
        return stat.isFile() ? stat.size : 0;
      } catch {
        return 0;
      }
    }),
  );
  return sizes.reduce((total, size) => total + size, 0);
}

export function formatBytes(bytes: number): string {
  if (bytes < BYTES_PER_MB) return `${bytes} B`;
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

export function describeOpenCodeDatabaseGrowthTrip(trip: OpenCodeDatabaseGrowthTrip): string {
  return (
    `OpenCode database grew ${formatBytes(trip.growthBytes)} during this run ` +
    `(limit ${formatBytes(trip.limitBytes)}, ${formatBytes(trip.baselineBytes)} → ` +
    `${formatBytes(trip.observedBytes)} at ${trip.databasePath}). This is the runaway-message ` +
    `signature from SUP-10914; the run was terminated before it could bloat the database further.`
  );
}

export type OpenCodeDatabaseGrowthGuard = {
  /** Stop polling. Safe to call more than once. */
  stop: () => void;
};

/**
 * Poll the database's on-disk size for the life of a run and invoke `onTrip`
 * once if it grows past `limitBytes`. The caller decides what to do about it
 * (in practice: terminate the run).
 *
 * The baseline is sampled asynchronously after start, so a run that goes
 * runaway in its first few seconds is measured against a slightly later
 * baseline — which only ever makes the guard more conservative.
 */
export function startOpenCodeDatabaseGrowthGuard(input: {
  databasePath: string;
  limitBytes: number;
  pollIntervalMs: number;
  onTrip: (trip: OpenCodeDatabaseGrowthTrip) => void;
  onError?: (err: unknown) => void;
}): OpenCodeDatabaseGrowthGuard {
  if (input.limitBytes <= 0) {
    return { stop: () => {} };
  }

  let stopped = false;
  let tripped = false;
  let baselineBytes: number | null = null;
  let timer: NodeJS.Timeout | null = null;

  const stop = () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const sample = async () => {
    if (stopped || tripped) return;
    try {
      const observedBytes = await measureOpenCodeDatabaseBytes(input.databasePath);
      if (stopped || tripped) return;
      if (baselineBytes === null) {
        baselineBytes = observedBytes;
        return;
      }
      const growthBytes = observedBytes - baselineBytes;
      if (growthBytes < input.limitBytes) return;
      tripped = true;
      stop();
      input.onTrip({
        databasePath: input.databasePath,
        baselineBytes,
        observedBytes,
        growthBytes,
        limitBytes: input.limitBytes,
      });
    } catch (err) {
      // A guard that throws must never take down the run it is protecting.
      input.onError?.(err);
    }
  };

  void sample();
  timer = setInterval(() => void sample(), input.pollIntervalMs);
  // Never hold the process open on the guard's account.
  timer.unref?.();

  return { stop };
}
