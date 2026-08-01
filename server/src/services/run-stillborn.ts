/**
 * Detection of stillborn runs — run rows created and marked `running` that never executed.
 *
 * The orphan reaper skips any run the current process still tracks in memory, on the assumption
 * that a tracked run is a live one. A run that was created, took an environment lease, and then
 * never started is tracked but not live, and because it never wrote a `resultJson` no timeout was
 * ever armed for it either. Nothing in the system ends it, and while it lasts its issue's
 * `executionRunId` points at it, so every status mutation on that issue conflicts.
 *
 * The signature is narrow on purpose: *no* telemetry of any kind, and no process ever spawned. A
 * run that is merely slow still writes log bytes, records output, or has a pid, so it is excluded.
 */

export const STILLBORN_RUN_ERROR_CODE = "stillborn_run";

/**
 * Adapters that run the agent as a tracked local child process.
 *
 * Only for these does "no pid and no process start" prove nothing was ever launched. A gateway or
 * HTTP-backed adapter legitimately has no pid, and one that makes a single long upstream call
 * writes no output, usage or result until it returns — so the signature below cannot tell it apart
 * from a run that never began, and must not be applied to it.
 *
 * Kept in this leaf module so the reaper and the lock-adoption path share one definition; both
 * would otherwise drift, and they must agree on which runs can be declared dead.
 */
export const LOCAL_CHILD_PROCESS_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
]);

export function canDetectStillbornRun(adapterType: string | null | undefined): boolean {
  return typeof adapterType === "string" && LOCAL_CHILD_PROCESS_ADAPTER_TYPES.has(adapterType);
}

/** How long a run may sit `running` with zero telemetry before it is force-failed. */
export const DEFAULT_STILLBORN_RUN_TTL_MS = 15 * 60 * 1000;

export interface StillbornRunCandidate {
  status: string;
  finishedAt: Date | string | null;
  startedAt: Date | string | null;
  createdAt: Date | string;
  processPid: number | null;
  processGroupId: number | null;
  processStartedAt: Date | string | null;
  lastOutputAt: Date | string | null;
  lastUsefulActionAt: Date | string | null;
  livenessState: string | null;
  logBytes: number | null;
  usageJson: unknown;
  resultJson: unknown;
}

function toMillis(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function isStillbornRun(
  run: StillbornRunCandidate,
  now: Date,
  ttlMs: number = DEFAULT_STILLBORN_RUN_TTL_MS,
): boolean {
  if (run.status !== "running") return false;
  if (run.finishedAt) return false;

  // Any sign the run ever did anything disqualifies it — this must never race a live run.
  if (run.processPid || run.processGroupId || run.processStartedAt) return false;
  if (run.lastOutputAt || run.lastUsefulActionAt || run.livenessState) return false;
  if ((run.logBytes ?? 0) > 0) return false;
  if (run.usageJson || run.resultJson) return false;

  const startedMs = toMillis(run.startedAt) ?? toMillis(run.createdAt);
  if (startedMs == null) return false;
  return now.getTime() - startedMs >= ttlMs;
}

export function buildStillbornRunMessage(run: { id: string }, ttlMs: number): string {
  const minutes = Math.round(ttlMs / 60_000);
  return (
    `Run ${run.id} was marked running but produced no output, usage, liveness or process for ` +
    `${minutes}m, so it never executed. Force-failing it to release its environment lease and its ` +
    "issue's execution lock."
  );
}
