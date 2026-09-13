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
 * Derived default cap.
 *
 * PROVISIONAL pending live-census confirmation. The consume-contract for the
 * census is `GET /api/health` ->
 * `sweepLiveness.sweeps.runProcessCensus.lastResult` (`sampleCount`, `max`,
 * `p50`, `p95`, `p99`, `maxRunId`). At the time this shipped the census was
 * merged but had not yet been sampled by a live control plane, so the cap is
 * derived from the one real distribution anchor available — the 2026-08-25
 * incident where a single leaked run reached 1,291 processes (SUP-13949) — with
 * deliberate headroom: 512 is ~40% of that runaway and comfortably above any
 * expected legitimate per-run child count (a healthy agent CLI and its tool
 * subprocesses sit in the single digits to low tens). It is env-overridable so
 * it can be raised, without a redeploy, once the live census p99 is published.
 */
export const DEFAULT_RUN_PROCESS_CAP = 512;

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
 * server startup (`server/src/adapters/utils.ts`) with
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

/** Recognise a cap refusal after it has unwound through an adapter. */
export function isRunProcessCapExceededFailure(
  error: unknown,
): error is RunProcessCapExceededError {
  const maybe = error as { code?: unknown } | null;
  return Boolean(
    maybe && typeof maybe === "object" && maybe.code === RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE,
  );
}
