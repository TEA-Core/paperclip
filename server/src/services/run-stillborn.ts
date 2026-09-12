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

export const DEFAULT_SELF_DECLARED_RUN_TTL_MS = 15 * 60 * 1000;

export interface SelfDeclaredRunCandidate {
  invocationSource: string | null;
  updatedAt: Date | string | null;
}

export function isSelfDeclaredRunExpired(
  run: SelfDeclaredRunCandidate,
  now: Date,
  ttlMs: number = DEFAULT_SELF_DECLARED_RUN_TTL_MS,
): boolean {
  if (run.invocationSource !== "self_declared") return false;
  const refMs = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
  if (refMs === 0) return false;
  return now.getTime() - refMs >= ttlMs;
}

/**
 * SUP-15842: how long a run admitted to `running` may register neither a child process nor an
 * environment lease before the reaper treats it as never actually launched.
 *
 * The window is deliberately short (a few multiples of the 30s sweep interval) because the
 * signal is cheap to check and decisive: a healthy dispatch records its environment lease well
 * before this bound, and a run still dispatching in this process is excluded via the in-flight
 * handle, not via waiting out a threshold. The misdiagnosis this prevents (reaping as
 * `process_lost` / "server may have restarted") otherwise only surfaces after the full 5-minute
 * staleness gate.
 */
export const DEFAULT_DISPATCH_UNLAUNCHED_GRACE_MS = 30_000;

export interface DispatchUnlaunchedRunCandidate {
  status: string;
  finishedAt: Date | null;
  startedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  /** Child-process handle registered by the adapter during dispatch. */
  processPid: number | null;
  processGroupId: number | null;
  processStartedAt: Date | null;
  logBytes: number | null;
  usageJson: unknown;
  resultJson: unknown;
}

/**
 * A run admitted to `running` that is past the grace window, has registered neither a child
 * process nor an environment lease, and shows no dispatch telemetry was never actually launched:
 * the spawn went dead / gone-quiet mid-dispatch. This is distinct from a lost in-flight process
 * (`process_lost`) and from a stillborn run that did begin. Host-restart evidence and
 * self-declared runs are handled by the reaper before this predicate and never reach it.
 */
export function isDispatchUnlaunchedRun(
  run: DispatchUnlaunchedRunCandidate,
  hasActiveEnvironmentLease: boolean,
  now: Date,
  graceMs: number = DEFAULT_DISPATCH_UNLAUNCHED_GRACE_MS,
): boolean {
  if (run.status !== "running" || run.finishedAt !== null) return false;
  if (hasActiveEnvironmentLease) return false;
  if (
    run.processPid !== null ||
    run.processGroupId !== null ||
    run.processStartedAt !== null
  ) {
    return false;
  }
  if (run.logBytes !== null && run.logBytes > 0) return false;
  if (run.usageJson != null) return false;
  if (run.resultJson != null) return false;

  // Reference the run's last-progress timestamp, matching the reaper's staleness gate: a dispatch
  // that is progressing (even on another process) bumps updatedAt, while one that went dead/gone-
  // quiet right after admission does not.
  const referenceAt = run.updatedAt ?? run.startedAt ?? run.createdAt;
  if (!referenceAt) return false;

  return now.getTime() - referenceAt.getTime() >= graceMs;
}

export function buildDispatchUnlaunchedMessage(
  agentId: string | null | undefined,
  adapterType: string | null | undefined,
  graceMs: number = DEFAULT_DISPATCH_UNLAUNCHED_GRACE_MS,
): string {
  const seconds = Math.round(graceMs / 1000);
  const detail = adapterType ? ` via adapter '${adapterType}'` : "";
  return (
    `Run ${agentId ?? "?"} was admitted to running but never launched: ` +
    `no child process or environment lease was registered within ${seconds}s of admission${detail}. ` +
    `The dispatch did not start — this is a launch failure, not a server restart or a lost in-flight process.`
  );
}

/**
 * SUP-15842: bounded, non-secret root-cause evidence recorded when a run is reaped as
 * `dispatch_unlaunched`.
 *
 * The reaper only ever observes the run's end state, so "last dispatch step reached" is the
 * furthest milestone the observable row proves: admission to `running`. Nothing past it was
 * ever registered — no child handle, no active environment lease, no dispatch telemetry — which
 * is exactly the claim→launch window this defect sits in. The lease outcome is recorded
 * explicitly so a later occurrence distinguishes "the lease request never completed / was not
 * active at reap time" from "a lease existed and the child died" (the latter stays
 * `process_lost`).
 */
export interface DispatchUnlaunchedEvidence {
  /** Furthest dispatch milestone the observable row proves (admission only; nothing launched). */
  dispatchStep: "admitted_running";
  /** What the reaper observed about the environment-lease request. */
  leaseOutcome: "no_active_lease_observed" | "active_lease_present";
  /** No child-process handle (pid / group / start) was ever registered. */
  childHandleRegistered: boolean;
  /** No dispatch telemetry (log bytes / usage / result) was ever written. */
  telemetryObserved: boolean;
  adapterType: string | null;
  /** The launch-grace window (ms) in effect when the run was reaped. */
  graceMs: number;
  /** The run's last-progress timestamp as ISO-8601, or null if none was recorded. */
  lastProgressAt: string | null;
}

export function buildDispatchUnlaunchedEvidence(input: {
  adapterType?: string | null;
  graceMs: number;
  hasActiveEnvironmentLease: boolean;
  processPid: number | null;
  processGroupId: number | null;
  processStartedAt: Date | string | null;
  logBytes: number | null;
  usageJson: unknown;
  resultJson: unknown;
  lastProgressAt?: Date | string | null;
}): DispatchUnlaunchedEvidence {
  const lastProgressAt = input.lastProgressAt
    ? new Date(input.lastProgressAt).toISOString()
    : null;
  return {
    dispatchStep: "admitted_running",
    leaseOutcome: input.hasActiveEnvironmentLease ? "active_lease_present" : "no_active_lease_observed",
    childHandleRegistered:
      input.processPid !== null ||
      input.processGroupId !== null ||
      input.processStartedAt !== null,
    telemetryObserved:
      (input.logBytes ?? 0) > 0 || input.usageJson != null || input.resultJson != null,
    adapterType: typeof input.adapterType === "string" ? input.adapterType : null,
    graceMs: input.graceMs,
    lastProgressAt,
  };
}
