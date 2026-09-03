// ADR-074 D1 / ADR-093 D1 — the §2a "live continuation path" predicate.
//
// This module is the single canonical home for the continuation-path predicate
// that was cut in ADR-074 D1 (SUP-14030, "re-cut the in_progress guard with the
// §2a continuation-path predicate") and re-homed here by ADR-093 D1 (SUP-14880)
// so the DISPATCH path (`services/heartbeat.ts`) can reuse it. `services/`
// importing from `routes/` is a layering inversion, so the pure predicate moves
// down; `routes/issues.ts` imports and re-exports it so its existing callers
// and tests are untouched.
//
// "no activeRun" is NOT "no continuation path". An issue remains live while any
// one of the four §2a disjuncts holds — activeRun (queued|running), a monitor
// with a future nextCheckAt, a live watchdog/scheduledRetry/activeRecoveryAction,
// or a successfulRunHandoff preserving progress (hasLiveContinuation) — and an
// issue whose lastActivityAt falls inside the settle window is not a ghost even
// when none of (1)-(4) are present (run stamping and status commit are not
// simultaneous).

export const IN_PROGRESS_SETTLE_WINDOW_MS = 5 * 60 * 1000;

export function toContinuationPathDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface ContinuationPathEvidence {
  activeRun: boolean;
  monitorNextCheckAt: Date | string | null | undefined;
  watchdog: unknown;
  scheduledRetry: unknown;
  activeRecoveryAction: unknown;
  successfulRunHandoff: { hasLiveContinuation?: boolean | null } | null | undefined;
  lastActivityAt: Date | string | null | undefined;
}

export interface ContinuationPathDisjuncts {
  activeRun: boolean;
  monitorNextCheckAtInFuture: boolean;
  watchdog: boolean;
  scheduledRetry: boolean;
  activeRecoveryAction: boolean;
  successfulRunHandoffLive: boolean;
}

export interface ContinuationPathResult {
  ok: boolean;
  disjuncts: ContinuationPathDisjuncts;
  settledWithinWindow: boolean;
  lastActivityAt: Date | null;
}

export function evaluateIssueContinuationPath(
  evidence: ContinuationPathEvidence,
  options: { now?: Date; settleWindowMs?: number } = {},
): ContinuationPathResult {
  const now = options.now ?? new Date();
  const settleWindowMs = options.settleWindowMs ?? IN_PROGRESS_SETTLE_WINDOW_MS;
  const monitorNextCheckAt = toContinuationPathDate(evidence.monitorNextCheckAt);
  const lastActivityAt = toContinuationPathDate(evidence.lastActivityAt);
  const disjuncts: ContinuationPathDisjuncts = {
    activeRun: evidence.activeRun === true,
    monitorNextCheckAtInFuture:
      monitorNextCheckAt !== null && monitorNextCheckAt.getTime() > now.getTime(),
    watchdog: evidence.watchdog !== null && evidence.watchdog !== undefined,
    scheduledRetry: evidence.scheduledRetry !== null && evidence.scheduledRetry !== undefined,
    activeRecoveryAction:
      evidence.activeRecoveryAction !== null && evidence.activeRecoveryAction !== undefined,
    successfulRunHandoffLive: evidence.successfulRunHandoff?.hasLiveContinuation === true,
  };
  const settledWithinWindow =
    lastActivityAt !== null && now.getTime() - lastActivityAt.getTime() < settleWindowMs;
  return {
    ok: Object.values(disjuncts).some(Boolean) || settledWithinWindow,
    disjuncts,
    settledWithinWindow,
    lastActivityAt,
  };
}

// ADR-093 D1 — dispatch-path actionability combinator.
//
// A timer wake is agent-scoped and carries no issueId; the agent's actionable
// work is resolved after dispatch. So the gate lives in `timerWorkLeaseState`:
// an assigned candidate only counts as actionable when it is NOT held by a live
// execution lease AND, for an `in_progress` card, when it still has a live
// continuation path. A `todo` card has no continuation to have lost, so it is
// always actionable (subject to the lease). This is the term that keeps an
// `in_progress` card with `executionRunId: null`, no lease and no live
// disjunct from qualifying forever (the SUP-14761 burn).
export function isTimerCandidateActionable(input: {
  status: string;
  leased: boolean;
  continuationOk?: boolean;
}): boolean {
  if (input.leased) return false;
  if (input.status === "in_progress") return input.continuationOk === true;
  return true;
}

// ADR-093 D1 / D3 — observability for a dispatch-suppressed candidate. Every
// suppressed in_progress candidate writes exactly one activity row naming the
// failing disjuncts, so a suppressed card is auditable even before the D3
// board-visible park lands.
export const TIMER_DISPATCH_SUPPRESSED_ACTION = "issue.timer_dispatch_suppressed";

export function buildTimerDispatchSuppressionDetails(input: {
  issueId: string;
  status: string;
  disjuncts: ContinuationPathDisjuncts;
  settledWithinWindow: boolean;
  lastActivityAt: Date | null;
}): Record<string, unknown> {
  return {
    issueId: input.issueId,
    reason: "in_progress_without_live_continuation_path",
    status: input.status,
    disjuncts: input.disjuncts,
    settledWithinWindow: input.settledWithinWindow,
    lastActivityAt: input.lastActivityAt ? input.lastActivityAt.toISOString() : null,
    adr: "ADR-093-D1",
  };
}
