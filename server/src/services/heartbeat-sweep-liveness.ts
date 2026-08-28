import { logger } from "../middleware/logger.js";

/**
 * Heartbeat sweep liveness (SUP-14227).
 *
 * The periodic scheduler sweeps (carrier promotion, merged-PR confirmation,
 * terminal workspace reaper, opencode log rotation, done-close landing
 * backstop, external object refresh) are invisible when idle: a sweep that
 * ran and found nothing, a sweep that never fires, and a stopped scheduler
 * all look like silence. This module keeps the per-sweep last-run state in
 * memory (no table, no migration) and emits one debug trace line per run —
 * including all-zero results — so "ran and found nothing" is observable both
 * in the log and via the dedicated `GET /api/health/sweeps` endpoint without
 * log access.
 *
 * It is fed from the single `trackHeartbeatSchedulerWork` wrapper in
 * `index.ts`: every named sweep it wraps gets the same per-run trace, so the
 * six sweeps share one instrumentation point instead of six conditionals.
 */

export interface SweepLivenessEntry {
  name: string;
  /** ISO timestamp of the most recent settled run, or null when never run. */
  lastFinishedAt: string | null;
  lastOutcome: "ok" | "error" | null;
  totalRuns: number;
  lastResult: unknown;
}

/** Per-sweep view for redacted callers: when/whether, not the raw result. */
export interface RedactedSweepLivenessEntry {
  name: string;
  lastFinishedAt: string | null;
  lastOutcome: "ok" | "error" | null;
  totalRuns: number;
}

export interface HeartbeatSweepLivenessSnapshot {
  schedulerStopped: boolean;
  schedulerStoppedAt: string | null;
  sweeps: Record<string, SweepLivenessEntry>;
}

export interface RedactedHeartbeatSweepLivenessSnapshot {
  schedulerStopped: boolean;
  schedulerStoppedAt: string | null;
  sweeps: Record<string, RedactedSweepLivenessEntry>;
}

export interface HeartbeatSweepLiveness {
  /** Records a settled successful run and emits its debug trace line. */
  recordRun(name: string, result: unknown): void;
  /** Records a settled failed run and emits its debug trace line. */
  recordError(name: string, err: unknown): void;
  /** Mirrors the `heartbeatSchedulerStopped` latch for the health surface. */
  setSchedulerStopped(stopped: boolean): void;
  /** Point-in-time full snapshot (includes per-sweep `lastResult`). */
  snapshot(): HeartbeatSweepLivenessSnapshot;
  /**
   * Point-in-time snapshot for callers without full-health access. Omits each
   * sweep's `lastResult` (which can carry paths or counts) but keeps the
   * when/whether answer intact.
   */
  redactedSnapshot(): RedactedHeartbeatSweepLivenessSnapshot;
}

export interface HeartbeatSweepLivenessOptions {
  /** Injectable logger for tests; defaults to the shared pino logger. */
  logger?: Pick<typeof logger, "debug">;
}

/**
 * The six periodic scheduler sweeps monitored by this module. Pre-registered at
 * construction so a fresh process reports each entry with `lastFinishedAt:
 * null` instead of an empty map: "monitored but never fired" then stays
 * distinguishable from "not monitored at all".
 */
export const HEARTBEAT_SWEEP_NAMES = [
  "openCodeLogRotation",
  "externalObjectRefresh",
  "carrierPromotion",
  "doneCloseLandingBackstop",
  "mergedPullRequestConfirmation",
  "terminalWorkspace",
] as const;

export function createHeartbeatSweepLiveness(
  options: HeartbeatSweepLivenessOptions = {},
): HeartbeatSweepLiveness {
  const log = options.logger ?? logger;
  // Full-server tests stub the shared logger with a subset of pino's methods
  // (no `debug`), so the trace call is optional-chained: the real pino logger
  // always exposes `debug`, the stub simply does not record it. The method
  // form (not a bare function reference) keeps pino's `this` binding intact.
  const trace = (fields: Record<string, unknown>, message: string) => {
    log.debug?.(fields, message);
  };
  const sweeps = new Map<string, SweepLivenessEntry>();
  let schedulerStopped = false;
  let schedulerStoppedAt: string | null = null;

  const entryFor = (name: string): SweepLivenessEntry => {
    let entry = sweeps.get(name);
    if (!entry) {
      entry = { name, lastFinishedAt: null, lastOutcome: null, totalRuns: 0, lastResult: null };
      sweeps.set(name, entry);
    }
    return entry;
  };

  for (const name of HEARTBEAT_SWEEP_NAMES) {
    entryFor(name);
  }

  return {
    recordRun(name, result) {
      const entry = entryFor(name);
      entry.lastFinishedAt = new Date().toISOString();
      entry.lastOutcome = "ok";
      entry.totalRuns += 1;
      entry.lastResult = result === undefined ? null : result;
      trace({ name, result: entry.lastResult }, "heartbeat sweep trace: run finished");
    },
    recordError(name, err) {
      const entry = entryFor(name);
      entry.lastFinishedAt = new Date().toISOString();
      entry.lastOutcome = "error";
      entry.totalRuns += 1;
      const errorMessage = err instanceof Error ? err.message : String(err);
      entry.lastResult = { error: errorMessage };
      trace({ name, error: errorMessage }, "heartbeat sweep trace: run failed");
    },
    setSchedulerStopped(stopped) {
      if (stopped && !schedulerStopped) {
        schedulerStoppedAt = new Date().toISOString();
      }
      schedulerStopped = stopped;
    },
    snapshot() {
      return {
        schedulerStopped,
        schedulerStoppedAt,
        sweeps: Object.fromEntries(sweeps),
      };
    },
    redactedSnapshot() {
      const redacted: Record<string, RedactedSweepLivenessEntry> = {};
      for (const [name, entry] of sweeps) {
        redacted[name] = {
          name: entry.name,
          lastFinishedAt: entry.lastFinishedAt,
          lastOutcome: entry.lastOutcome,
          totalRuns: entry.totalRuns,
        };
      }
      return { schedulerStopped, schedulerStoppedAt, sweeps: redacted };
    },
  };
}

/** Process-wide instance shared by the scheduler wrapper and the health route. */
export const heartbeatSweepLiveness = createHeartbeatSweepLiveness();
