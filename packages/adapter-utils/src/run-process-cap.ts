/**
 * SUP-16011 — per-run child-process cap (refuse the spawn at the limit).
 *
 * Child 2 of SUP-13952. The run-process census (SUP-16010) measures, per run,
 * the number of live members in the run's process group. This module turns that
 * measurement into a guardrail: before the single run-child seam
 * (`runChildProcess` in `server-utils.ts`) creates a run's top-level child, it
 * measures the run's existing process group and refuses the spawn when the
 * group has already reached the cap. It never signals, kills, or throttles a
 * running run — a run that hits the cap is already misbehaving, and an
 * attributable failure beats a mid-flight kill that strands partial work.
 *
 * The group-size measurement is injected rather than implemented here, so the
 * seam reuses the census-grade `/proc` walk in the server
 * (`countLiveProcessGroupMembers` in `local-service-supervisor.ts`) and no
 * second process-walking primitive is introduced. Injection also keeps this
 * module platform-agnostic: on a host with no packet the seam fails open.
 */

/** Distinct, attributable error code recorded on the run when a spawn is refused. */
export const RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE = "run_process_cap_exceeded";

/** Environment variable that overrides the derived default. */
export const RUN_PROCESS_CAP_ENV_KEY = "PAPERCLIP_RUN_PROCESS_CAP";

/**
 * Derived default cap — a census-derived safe headroom, not an incident guess.
 *
 * The number comes from the live run-process census (SUP-16010), read from
 * `GET /api/health` -> `sweepLiveness.sweeps.runProcessCensus.lastResult`. The
 * authenticated live result at derivation (lastRunAt 2026-09-16T18:55:25.397Z,
 * runs=119):
 *
 *   {"lastResult":{"max":5,"maxRunId":"1a28308f-e5ba-4d81-aac8-4fd4d17b3ec4",
 *    "p50":4,"p95":5,"p99":5,"sampleCount":9,"unreadable":0},
 *   "lastRunAt":"2026-09-16T18:55:25.397Z","runs":119}
 *
 *   percentile = p99 = 5 · sampleCount = 9 · observed max = 5
 *
 * Default = 4x p99 = 20 (which is also 4x the observed max of 5). The 4x
 * headroom keeps the cap comfortably above the observed tail of legitimate
 * per-run child counts while still bounding a runaway many orders of magnitude
 * below the 2026-08-25 incident (1,291 processes, SUP-13949). It is
 * env-overridable via PAPERCLIP_RUN_PROCESS_CAP so it can be raised, without a
 * redeploy, if the distribution shifts.
 */
export const DEFAULT_RUN_PROCESS_CAP = 20;

export type RunProcessCapExceededResultJson = {
  errorCode: typeof RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE;
  cap: number;
  current: number;
  processGroupId: number;
  runId: string;
};

/**
 * Thrown (never returned) by the seam when a run's process group has reached
 * the cap. Throwing — rather than resolving a `RunProcessResult` — is what
 * makes the refusal universal: every adapter that awaits `runChildProcess`
 * unwinds its dispatch, and the heartbeat's adapter-error handler records the
 * `code` below on the run. `resultJson` carries the measured numbers so the
 * refusal is diagnosable from the record.
 */
export class RunProcessCapExceededError extends Error {
  readonly code: typeof RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE =
    RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE;
  readonly resultJson: RunProcessCapExceededResultJson;

  constructor(input: {
    runId: string;
    cap: number;
    current: number;
    processGroupId: number;
  }) {
    const { runId, cap, current, processGroupId } = input;
    super(
      `[paperclip] run process cap exceeded: cap=${cap} current=${current} group=${processGroupId} runId=${runId}; spawn refused`,
    );
    this.name = "RunProcessCapExceededError";
    this.resultJson = {
      errorCode: RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE,
      cap,
      current,
      processGroupId,
      runId,
    };
  }
}

type RunProcessGroupCounter = (processGroupId: number) => number | null;

let injectedRunProcessGroupCounter: RunProcessGroupCounter | null = null;

/**
 * Install the server's process-group counter into the seam. Called once at
 * server startup (`startServer` in `server/src/index.ts`) with
 * `countLiveProcessGroupMembers`. Passing `null` unwires it (tests, or a host
 * that must not enforce the cap).
 */
export function registerRunProcessGroupCounter(
  counter: RunProcessGroupCounter | null,
): void {
  injectedRunProcessGroupCounter = counter;
}

export function getRunProcessGroupCounter(): RunProcessGroupCounter | null {
  return injectedRunProcessGroupCounter;
}

/**
 * Resolve the cap from the environment.
 *
 * - unset / empty / invalid -> the derived default (fail safe, never silently
 *   uncapped on a typo)
 * - `0`, `off`, `none`, `disabled` -> `null` (cap disabled; explicit escape hatch)
 * - a positive integer -> that value
 */
export function resolveRunProcessCap(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env[RUN_PROCESS_CAP_ENV_KEY];
  if (raw === undefined || raw.trim() === "") return DEFAULT_RUN_PROCESS_CAP;
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "0" ||
    normalized === "off" ||
    normalized === "none" ||
    normalized === "disabled"
  ) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_RUN_PROCESS_CAP;
  return parsed;
}

/**
 * Pure boundary decision so both sides (`cap - 1` allows, `cap` refuses) are
 * testable without spawning. An unreadable group (`current === null`) or an
 * unset cap (`null`) allows the spawn — the cap fails open rather than blocking
 * a legitimate run on a platform where the group cannot be measured.
 */
export function shouldRefuseRunProcessSpawn(input: {
  cap: number | null;
  current: number | null;
}): boolean {
  if (input.cap === null) return false;
  if (input.current === null) return false;
  return input.current >= input.cap;
}

/**
 * Single admission decision for spawning a run's top-level child.
 *
 * This is the one place that measures the run's *existing* process group and
 * decides whether the spawn is refused, so every run-child creation path
 * (the `runChildProcess` seam and the native runner) routes through identical
 * logic rather than each re-implementing the boundary. `processGroupId` is the
 * run's currently-tracked group (`null` when the run has none yet); when there
 * is no cap, no wired counter, or no measurable group, the spawn is allowed —
 * the cap fails open rather than blocking a run on an unmeasurable host.
 *
 * Returns the `RunProcessCapExceededError` to throw (never itself thrown here)
 * so each seam decides how to surface it (reject a promise vs. throw from an
 * async function) and whether to log a measure error.
 */
export function evaluateRunProcessSpawn(input: {
  runId: string;
  cap: number | null;
  counter: RunProcessGroupCounter | null;
  processGroupId: number | null;
  onMeasureError?: (error: unknown) => void;
}): RunProcessCapExceededError | null {
  const { runId, cap, counter, processGroupId } = input;
  if (
    cap === null ||
    counter === null ||
    processGroupId === null ||
    processGroupId <= 0
  ) {
    return null;
  }
  let current: number | null = null;
  try {
    current = counter(processGroupId);
  } catch (error) {
    input.onMeasureError?.(error);
    current = null;
  }
  if (current !== null && shouldRefuseRunProcessSpawn({ cap, current })) {
    return new RunProcessCapExceededError({
      runId,
      cap,
      current,
      processGroupId,
    });
  }
  return null;
}

/** Recognise a cap refusal after it has unwound through an adapter. */
export function isRunProcessCapExceededFailure(
  error: unknown,
): error is RunProcessCapExceededError {
  const maybe = error as { code?: unknown } | null;
  return Boolean(
    maybe && typeof maybe === "object" && maybe.code === RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE,
  );
}
