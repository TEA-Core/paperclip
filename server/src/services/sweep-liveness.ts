import { logger } from "../middleware/logger.js";

/**
 * SUP-14227 — idle-liveness signal for the heartbeat-tick sweeps.
 *
 * Six sweeps wrapped by `trackHeartbeatSchedulerWork` in `server/src/index.ts`
 * (carrierPromotion, doneCloseLandingBackstop, mergedPullRequestConfirmation,
 * terminalWorkspace, openCodeLogRotation, externalObjectRefresh) shared one
 * fault: a run that dispositions nothing left no observable trace, so "ran,
 * found nothing" was observationally identical to "never fired." The wrapper is
 * the single seam that reaches every sweep, so this module gives it two things
 * one place to do:
 *
 *  - emit a per-run trace carrying the sweep's identity + result, INCLUDING an
 *    all-zero result (that is the signal that distinguishes ran-idle from dead),
 *  - keep a last-run-per-sweep timestamp + monotonic counter that an operator
 *    can read without log access, so "when did sweep X last run?" stays
 *    answerable after the log window has rotated,
 * and it surfaces the `heartbeatSchedulerStopped` latch, which short-circuits
 * every sweep before the wrapper is reached — a wrongly-set latch silences all
 * six at once and today its only symptom is an absence.
 *
 * Observability only: no sweep behaviour, cadence, or promotion-predicate
 * changes. See the lead card SUP-14227 (board decision: option A, the wrapper).
 */

export type SweepLivenessEntry = {
  /** ISO timestamp of the most recent completed run of this sweep. */
  lastRunAt: string;
  /** Monotonic count of completed runs since process start. */
  runs: number;
  /** The result object the sweep resolved with on its most recent run. */
  lastResult: unknown;
};

export type SweepLivenessSnapshot = {
  /**
   * True when the `heartbeatSchedulerStopped` latch is set. While true, every
   * sweep short-circuits before the wrapper is reached, so all six stop
   * running at once; a reader can tell that state apart from "ran, found
   * nothing" (which only freezes one sweep's lastRunAt).
   */
  schedulerStopped: boolean;
  /** ISO timestamp the latch was set, or null when the latch is clear. */
  schedulerStoppedAt: string | null;
  sweeps: Record<string, SweepLivenessEntry>;
};

type LogFn = (fields: Record<string, unknown>, message: string) => void;

export function createSweepLivenessTracker(opts: {
  now?: () => Date;
  log?: LogFn;
} = {}) {
  const now = opts.now ?? (() => new Date());
  // The per-run trace defaults to `debug`: at the 30s tick cadence an
  // all-zero run would be noisy at `info` on stdout, but the debug target
  // still writes it to the log file, so it is reachable without a redeploy
  // or a code change. The sweep's own `info`/`warn` line remains the signal
  // that something was actually dispositioned.
  const log: LogFn =
    opts.log ??
    ((fields, message) => {
      logger.debug(fields, message);
    });

  const registry = new Map<string, SweepLivenessEntry>();
  let schedulerStopped = false;
  let schedulerStoppedAt: string | null = null;

  function record(name: string, result: unknown, at: Date = now()) {
    const prev = registry.get(name);
    const entry: SweepLivenessEntry = {
      lastRunAt: at.toISOString(),
      runs: (prev?.runs ?? 0) + 1,
      lastResult: result,
    };
    registry.set(name, entry);
    log(
      { sweep: name, lastRunAt: entry.lastRunAt, runs: entry.runs, result },
      "heartbeat sweep ran",
    );
  }

  function setSchedulerStopped(stopped: boolean, at: Date = now()) {
    if (stopped === schedulerStopped) return;
    schedulerStopped = stopped;
    schedulerStoppedAt = stopped ? at.toISOString() : null;
    log(
      { schedulerStopped, schedulerStoppedAt },
      stopped
        ? "heartbeat scheduler liveness: scheduler stopped (sweeps will not run)"
        : "heartbeat scheduler liveness: scheduler resumed",
    );
  }

  function snapshot(): SweepLivenessSnapshot {
    const sweeps: Record<string, SweepLivenessEntry> = {};
    for (const [name, entry] of registry) {
      // Defensive copy per entry so a reader mutating the snapshot (e.g. a
      // health response builder) cannot corrupt the tracker's state.
      sweeps[name] = { ...entry };
    }
    return {
      schedulerStopped,
      schedulerStoppedAt,
      sweeps,
    };
  }

  return { record, setSchedulerStopped, snapshot };
}

/**
 * Process-wide liveness registry. Written by the server entry (the
 * `trackHeartbeatSchedulerWork` seam in `server/src/index.ts`) and read by the
 * `/health` route so an operator can answer "when did sweep X last run?" without
 * a log window. Both import the same module instance in one process.
 */
const sweepLivenessTracker = createSweepLivenessTracker();

/**
 * The tracker is not "armed" until the server entry opts in. `/health` omits
 * the `sweepLiveness` field until armed, so test apps and non-heartbeat
 * contexts keep their existing response shape byte-identical.
 */
let sweepLivenessArmed = false;

export function armSweepLiveness(): void {
  sweepLivenessArmed = true;
}

export function isSweepLivenessArmed(): boolean {
  return sweepLivenessArmed;
}

export { sweepLivenessTracker };
