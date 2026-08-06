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
//
// SUP-11280: the file is per AGENT, but the guard is per RUN, and one agent runs
// several issues at once. On 2026-08-06 two coder-LE runs were killed for a
// third run's writes -- one of them had written 203 events (0 MB) and died for a
// sibling's 247 MB. So before terminating, attribute the growth: opencode's own
// `event` and `part` rows carry the session id, and a read-only query answers
// "how much of this is mine?" in one statement. A run that owns a minority of
// the growth, and less than the budget on its own, is spared and re-baselined;
// the run that actually owns the writes is killed by its own guard.

const DEFAULT_GROWTH_LIMIT_MB = 256;
const DEFAULT_POLL_INTERVAL_SEC = 5;
const MIN_POLL_INTERVAL_SEC = 1;
const BYTES_PER_MB = 1024 * 1024;

/**
 * How many times a run may be spared before the guard stops asking. A spared
 * trip means "someone else is writing"; if the owner is a session whose run is
 * already gone, nobody will ever kill it, and the database would grow without
 * bound. After this many passes the guard falls back to its original behaviour
 * and terminates the run it is attached to.
 */
const DEFAULT_MAX_SPARED_TRIPS = 3;

/** Matches the session id opencode stamps on every JSONL event it prints. */
const OPENCODE_SESSION_ID_PATTERN = /"sessionID"\s*:\s*"(ses_[A-Za-z0-9]+)"/;

/** Files SQLite keeps for one database. `-shm` is bounded and tiny, but reading
 * it costs nothing and keeps the accounting honest. */
const SQLITE_SIDECAR_SUFFIXES = ["", "-wal", "-shm"] as const;

/**
 * What the run's own opencode session accounts for, when the guard was able to
 * ask. `null` everywhere the question could not be answered: the session id was
 * never seen, or the read-only query failed.
 */
export type OpenCodeDatabaseGrowthAttribution = {
  sessionId: string;
  /** The session's rows when the guard learned the id. */
  baselineBytes: number;
  observedBytes: number;
  growthBytes: number;
};

export type OpenCodeDatabaseGrowthTrip = {
  databasePath: string;
  baselineBytes: number;
  observedBytes: number;
  growthBytes: number;
  limitBytes: number;
  attribution: OpenCodeDatabaseGrowthAttribution | null;
  /** How many times this run was spared before the guard gave up sparing it. */
  sparedTrips: number;
};

/** A trip the guard decided was somebody else's writes. The run keeps going. */
export type OpenCodeDatabaseGrowthSpare = {
  databasePath: string;
  growthBytes: number;
  limitBytes: number;
  attribution: OpenCodeDatabaseGrowthAttribution;
  sparedTrips: number;
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

/** Pull the opencode session id out of a chunk of the run's JSONL stdout. */
export function readOpenCodeSessionIdFromChunk(chunk: string): string | null {
  return OPENCODE_SESSION_ID_PATTERN.exec(chunk)?.[1] ?? null;
}

/**
 * On-disk bytes one opencode session accounts for: its event stream plus its
 * message parts. `event.aggregate_id` is the session id, and events are where
 * the runaway lives -- in the 2026-08-06 incident database they were 622 MB of
 * 650 MB, one full snapshot per stream chunk.
 *
 * Read-only, and deliberately tolerant: a schema that does not match, a database
 * the connection cannot open, or a driver that is not there all return null, and
 * the caller falls back to the unattributed behaviour rather than to a wrong
 * number.
 */
export async function measureOpenCodeSessionBytes(
  databasePath: string,
  sessionId: string,
): Promise<number | null> {
  if (sessionId.trim().length === 0) return null;
  try {
    const sqlite = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (
        path: string,
        options?: { readOnly?: boolean },
      ) => {
        prepare: (sql: string) => { get: (...params: unknown[]) => Record<string, unknown> | undefined };
        close: () => void;
      };
    };
    const db = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      const readSum = (sql: string) => {
        const row = db.prepare(sql).get(sessionId);
        const value = row?.bytes;
        if (typeof value === "bigint") return Number(value);
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
      };
      return (
        readSum("SELECT SUM(LENGTH(data)) AS bytes FROM event WHERE aggregate_id = ?") +
        readSum("SELECT SUM(LENGTH(data)) AS bytes FROM part WHERE session_id = ?")
      );
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < BYTES_PER_MB) return `${bytes} B`;
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

function describeAttribution(attribution: OpenCodeDatabaseGrowthAttribution | null): string {
  if (!attribution) {
    return " The growth could not be attributed to a session, so the run was terminated on the file total alone.";
  }
  return (
    ` This run's own session ${attribution.sessionId} accounts for ` +
    `${formatBytes(attribution.growthBytes)} of it.`
  );
}

export function describeOpenCodeDatabaseGrowthTrip(trip: OpenCodeDatabaseGrowthTrip): string {
  return (
    `OpenCode database grew ${formatBytes(trip.growthBytes)} during this run ` +
    `(limit ${formatBytes(trip.limitBytes)}, ${formatBytes(trip.baselineBytes)} → ` +
    `${formatBytes(trip.observedBytes)} at ${trip.databasePath}). This is the runaway-message ` +
    `signature from SUP-10914; the run was terminated before it could bloat the database further.` +
    describeAttribution(trip.attribution) +
    (trip.sparedTrips > 0
      ? ` The run was spared ${trip.sparedTrips} earlier trip(s) attributed to another session.`
      : "")
  );
}

export function describeOpenCodeDatabaseGrowthSpare(spare: OpenCodeDatabaseGrowthSpare): string {
  return (
    `OpenCode database grew ${formatBytes(spare.growthBytes)} (limit ` +
    `${formatBytes(spare.limitBytes)}) at ${spare.databasePath}, but this run's own session ` +
    `${spare.attribution.sessionId} accounts for only ` +
    `${formatBytes(spare.attribution.growthBytes)} of it. Another run on this agent owns those ` +
    `writes and its own guard will handle it; this run continues (spare ${spare.sparedTrips}).`
  );
}

export type OpenCodeDatabaseGrowthGuard = {
  /** Stop polling. Safe to call more than once. */
  stop: () => void;
  /**
   * Tell the guard which opencode session this run is writing to. Call it with
   * every stdout chunk; the first session id wins and the rest are ignored.
   * Until this lands the guard cannot attribute growth and behaves exactly as
   * it did before SUP-11280 — terminate on the file total.
   */
  noteSessionId: (sessionId: string | null | undefined) => void;
};

/**
 * Poll the database's on-disk size for the life of a run and invoke `onTrip`
 * once if it grows past `limitBytes`. The caller decides what to do about it
 * (in practice: terminate the run).
 *
 * The baseline is sampled asynchronously after start, so a run that goes
 * runaway in its first few seconds is measured against a slightly later
 * baseline — which only ever makes the guard more conservative.
 *
 * When the run's session id is known, a trip is attributed before it is acted
 * on: a run that owns a minority of the growth and less than the whole budget
 * on its own is spared, the file baseline is reset, and polling continues.
 */
export function startOpenCodeDatabaseGrowthGuard(input: {
  databasePath: string;
  limitBytes: number;
  pollIntervalMs: number;
  onTrip: (trip: OpenCodeDatabaseGrowthTrip) => void;
  onSpare?: (spare: OpenCodeDatabaseGrowthSpare) => void;
  onError?: (err: unknown) => void;
  /** Known upfront when the run resumes an existing session. */
  sessionId?: string | null;
  maxSparedTrips?: number;
  /** Seam for tests; defaults to the read-only sqlite query. */
  measureSessionBytes?: (databasePath: string, sessionId: string) => Promise<number | null>;
}): OpenCodeDatabaseGrowthGuard {
  if (input.limitBytes <= 0) {
    return { stop: () => {}, noteSessionId: () => {} };
  }

  const measureSessionBytes = input.measureSessionBytes ?? measureOpenCodeSessionBytes;
  const maxSparedTrips = Math.max(0, Math.floor(input.maxSparedTrips ?? DEFAULT_MAX_SPARED_TRIPS));

  let stopped = false;
  let tripped = false;
  let baselineBytes: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let sessionId: string | null = input.sessionId?.trim() || null;
  // Sampled when the session id is learned, so a resumed session's pre-existing
  // rows are not charged to this run.
  let sessionBaselineBytes: number | null = null;
  let sparedTrips = 0;

  const stop = () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const captureSessionBaseline = async (id: string) => {
    try {
      const bytes = await measureSessionBytes(input.databasePath, id);
      // Only the first answer counts: a later one would already include this
      // run's own writes and would understate what the run is responsible for.
      if (sessionBaselineBytes === null && bytes !== null) sessionBaselineBytes = bytes;
    } catch (err) {
      input.onError?.(err);
    }
  };

  const noteSessionId = (value: string | null | undefined) => {
    const next = value?.trim();
    if (!next || sessionId) return;
    sessionId = next;
    void captureSessionBaseline(next);
  };

  if (sessionId) void captureSessionBaseline(sessionId);

  const attribute = async (): Promise<OpenCodeDatabaseGrowthAttribution | null> => {
    if (!sessionId) return null;
    const observedBytes = await measureSessionBytes(input.databasePath, sessionId);
    if (observedBytes === null) return null;
    // A session baseline we never managed to take is treated as zero, which
    // charges this run for everything its session holds. That errs towards
    // terminating, which is the safe direction for a guard.
    const baseline = sessionBaselineBytes ?? 0;
    return {
      sessionId,
      baselineBytes: baseline,
      observedBytes,
      growthBytes: Math.max(0, observedBytes - baseline),
    };
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

      const attribution = await attribute();
      if (stopped || tripped) return;

      // Spare the run only when it is demonstrably not the writer: it owns a
      // minority of the growth AND has not burned the budget on its own.
      if (
        attribution &&
        attribution.growthBytes < input.limitBytes &&
        attribution.growthBytes * 2 < growthBytes &&
        sparedTrips < maxSparedTrips
      ) {
        sparedTrips += 1;
        // Re-baseline so this run is measured on what happens next, not on a
        // sibling's writes it has already been forgiven for.
        baselineBytes = observedBytes;
        input.onSpare?.({
          databasePath: input.databasePath,
          growthBytes,
          limitBytes: input.limitBytes,
          attribution,
          sparedTrips,
        });
        return;
      }

      tripped = true;
      stop();
      input.onTrip({
        databasePath: input.databasePath,
        baselineBytes,
        observedBytes,
        growthBytes,
        limitBytes: input.limitBytes,
        attribution,
        sparedTrips,
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

  return { stop, noteSessionId };
}
