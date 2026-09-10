import { describe, expect, it } from "vitest";
import {
  buildTimerDispatchSuppressionDetails,
  evaluateIssueContinuationPath,
  IN_PROGRESS_SETTLE_WINDOW_MS,
  isTimerCandidateActionable,
  shouldEmitTimerDispatchSuppression,
  TIMER_DISPATCH_SUPPRESSED_ACTION,
  TIMER_DISPATCH_SUPPRESSED_DEDUP_WINDOW_MS,
  toContinuationPathDate,
} from "../services/issue-continuation-path.js";

// ADR-093 D1 (SUP-14880): the §2a live-continuation-path predicate moved out of
// routes/issues.ts into services/issue-continuation-path.js so the dispatch path
// (services/heartbeat.ts) can reuse it. These tests pin (a) the pure predicate's
// §2a disjunct semantics (behavior-preserving from the routes home) and (b) the
// new dispatch-path actionability combinator and observability payload.

const NOW = new Date("2026-09-03T12:00:00.000Z");
const OLD_ACTIVITY = new Date("2026-09-03T11:40:00.000Z"); // 20 min ago -> outside settle window

function emptyEvidence(overrides: Record<string, unknown> = {}) {
  return {
    activeRun: false,
    monitorNextCheckAt: null,
    watchdog: null,
    scheduledRetry: null,
    activeRecoveryAction: null,
    successfulRunHandoff: null,
    lastActivityAt: OLD_ACTIVITY,
    ...overrides,
  };
}

describe("toContinuationPathDate (moved from routes, SUP-14880)", () => {
  it("normalizes Date, ISO string, and null/invalid values", () => {
    expect(toContinuationPathDate(NOW)?.toISOString()).toBe(NOW.toISOString());
    expect(toContinuationPathDate("2026-09-03T12:00:00.000Z")?.toISOString()).toBe(
      "2026-09-03T12:00:00.000Z",
    );
    expect(toContinuationPathDate(null)).toBeNull();
    expect(toContinuationPathDate(undefined)).toBeNull();
    expect(toContinuationPathDate("not-a-date")).toBeNull();
  });
});

describe("evaluateIssueContinuationPath (§2a predicate, behavior-preserving)", () => {
  it("is not ok when no disjunct holds and activity is settled (bullet 1)", () => {
    const result = evaluateIssueContinuationPath(emptyEvidence(), { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.settledWithinWindow).toBe(false);
    expect(result.disjuncts).toEqual({
      activeRun: false,
      monitorNextCheckAtInFuture: false,
      watchdog: false,
      scheduledRetry: false,
      activeRecoveryAction: false,
      successfulRunHandoffLive: false,
    });
  });

  it("is ok via each §2a disjunct in isolation (bullet 2)", () => {
    const perDisjunct: Array<["disjunct", Record<string, unknown>]> = [
      ["activeRun", { activeRun: true }],
      [
        "monitorNextCheckAtInFuture",
        { monitorNextCheckAt: new Date(NOW.getTime() + 60_000) },
      ],
      ["watchdog", { watchdog: { id: "wd-1" } }],
      ["scheduledRetry", { scheduledRetry: { runId: "run-1" } }],
      ["activeRecoveryAction", { activeRecoveryAction: { id: "recovery-1" } }],
      ["successfulRunHandoffLive", { successfulRunHandoff: { hasLiveContinuation: true } }],
    ];
    for (const [name, override] of perDisjunct) {
      const result = evaluateIssueContinuationPath(emptyEvidence(override), { now: NOW });
      expect(result.ok, `${name} should make the path live`).toBe(true);
      const key = name as keyof typeof result.disjuncts;
      expect(result.disjuncts[key], `${name} disjunct flag`).toBe(true);
      expect(result.settledWithinWindow).toBe(false);
    }
  });

  it("is ok when lastActivityAt falls inside the settle window even with no disjunct", () => {
    const result = evaluateIssueContinuationPath(
      emptyEvidence({ lastActivityAt: new Date(NOW.getTime() - 60_000) }),
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    expect(result.settledWithinWindow).toBe(true);
  });

  it("respects the boundary: exactly at the settle window is NOT settled", () => {
    const result = evaluateIssueContinuationPath(
      emptyEvidence({ lastActivityAt: new Date(NOW.getTime() - IN_PROGRESS_SETTLE_WINDOW_MS) }),
      { now: NOW },
    );
    expect(result.settledWithinWindow).toBe(false);
    expect(result.ok).toBe(false);
  });
});

describe("isTimerCandidateActionable (ADR-093 D1 dispatch-path combinator)", () => {
  it("bullet 1: an in_progress card with no live continuation path is not actionable", () => {
    expect(isTimerCandidateActionable({ status: "in_progress", leased: false, continuationOk: false })).toBe(false);
  });

  it("an in_progress card with a live continuation path is actionable", () => {
    expect(isTimerCandidateActionable({ status: "in_progress", leased: false, continuationOk: true })).toBe(true);
  });

  it("an in_progress card with a missing continuation verdict is treated as not live", () => {
    expect(isTimerCandidateActionable({ status: "in_progress", leased: false, continuationOk: undefined })).toBe(false);
  });

  it("a lease always wins: leased in_progress/todo is not actionable", () => {
    expect(isTimerCandidateActionable({ status: "in_progress", leased: true, continuationOk: true })).toBe(false);
    expect(isTimerCandidateActionable({ status: "todo", leased: true })).toBe(false);
  });

  it("bullet 3: a todo card is always actionable (no continuation to have lost), unleased", () => {
    expect(isTimerCandidateActionable({ status: "todo", leased: false })).toBe(true);
    expect(isTimerCandidateActionable({ status: "todo", leased: false, continuationOk: false })).toBe(true);
  });
});

describe("buildTimerDispatchSuppressionDetails (ADR-093 D1/D3 observability)", () => {
  it("bullet 4: emits a stable payload naming the failing disjuncts", () => {
    const disjuncts = {
      activeRun: false,
      monitorNextCheckAtInFuture: false,
      watchdog: false,
      scheduledRetry: false,
      activeRecoveryAction: false,
      successfulRunHandoffLive: false,
    };
    const details = buildTimerDispatchSuppressionDetails({
      issueId: "issue-123",
      status: "in_progress",
      disjuncts,
      settledWithinWindow: false,
      lastActivityAt: OLD_ACTIVITY,
    });
    expect(details).toEqual({
      issueId: "issue-123",
      reason: "in_progress_without_live_continuation_path",
      status: "in_progress",
      disjuncts,
      settledWithinWindow: false,
      lastActivityAt: OLD_ACTIVITY.toISOString(),
      adr: "ADR-093-D1",
    });
    expect(TIMER_DISPATCH_SUPPRESSED_ACTION).toBe("issue.timer_dispatch_suppressed");
  });

  it("nulls out lastActivityAt when absent", () => {
    const details = buildTimerDispatchSuppressionDetails({
      issueId: "issue-9",
      status: "in_progress",
      disjuncts: {
        activeRun: true,
        monitorNextCheckAtInFuture: false,
        watchdog: false,
        scheduledRetry: false,
        activeRecoveryAction: false,
        successfulRunHandoffLive: false,
      },
      settledWithinWindow: true,
      lastActivityAt: null,
    });
    expect(details.lastActivityAt).toBeNull();
    expect(details.settledWithinWindow).toBe(true);
  });
});

// SUP-15600 regression: the exact shape of the lost-wake card SUP-15566 —
// in_progress, all five §2a disjuncts false, lastActivityAt 4h stale (far
// outside the 5-minute settle window). This is the shape that, per the
// dispatch-path combinator, is "suppressed" (not actionable), and the payload
// builder must carry the all-false disjuncts so the single suppression row is
// auditable.
describe("SUP-15566 lost-wake shape (regression)", () => {
  const FOUR_HOURS_AGO = new Date(NOW.getTime() - 4 * 60 * 60 * 1000);
  const ALL_FALSE = {
    activeRun: false,
    monitorNextCheckAtInFuture: false,
    watchdog: false,
    scheduledRetry: false,
    activeRecoveryAction: false,
    successfulRunHandoffLive: false,
  };

  it("five disjuncts false + lastActivityAt 4h stale evaluates not-ok, all disjuncts false", () => {
    const result = evaluateIssueContinuationPath(
      {
        activeRun: false,
        monitorNextCheckAt: null,
        watchdog: null,
        scheduledRetry: null,
        activeRecoveryAction: null,
        successfulRunHandoff: { hasLiveContinuation: false },
        lastActivityAt: FOUR_HOURS_AGO,
      },
      { now: NOW },
    );
    expect(result.ok).toBe(false);
    expect(result.settledWithinWindow).toBe(false);
    expect(result.disjuncts).toEqual(ALL_FALSE);
  });

  it("the dispatch-path combinator marks that card suppressed (not actionable)", () => {
    const result = evaluateIssueContinuationPath(
      {
        activeRun: false,
        monitorNextCheckAt: null,
        watchdog: null,
        scheduledRetry: null,
        activeRecoveryAction: null,
        successfulRunHandoff: null,
        lastActivityAt: FOUR_HOURS_AGO,
      },
      { now: NOW },
    );
    expect(isTimerCandidateActionable({ status: "in_progress", leased: false, continuationOk: result.ok })).toBe(false);
  });

  it("the suppression payload carries the failing disjuncts for that card", () => {
    const result = evaluateIssueContinuationPath(
      {
        activeRun: false,
        monitorNextCheckAt: null,
        watchdog: null,
        scheduledRetry: null,
        activeRecoveryAction: null,
        successfulRunHandoff: null,
        lastActivityAt: FOUR_HOURS_AGO,
      },
      { now: NOW },
    );
    const details = buildTimerDispatchSuppressionDetails({
      issueId: "sup-15566",
      status: "in_progress",
      disjuncts: result.disjuncts,
      settledWithinWindow: result.settledWithinWindow,
      lastActivityAt: result.lastActivityAt,
    });
    expect(details.status).toBe("in_progress");
    expect(details.disjuncts).toEqual(ALL_FALSE);
    expect(details.settledWithinWindow).toBe(false);
    expect(details.reason).toBe("in_progress_without_live_continuation_path");
    expect(details.lastActivityAt).toBe(FOUR_HOURS_AGO.toISOString());
  });
});

// SUP-15600 criterion 3: one row per suppression decision, not one per sweep
// pass. The dedup decision is extracted here as a pure, testable contract so the
// "at most one row per trailing window" guarantee is asserted directly rather
// than only by the DB query inside heartbeat.ts.
describe("shouldEmitTimerDispatchSuppression (one row per suppression decision)", () => {
  it("emits when the issue has no prior suppression row", () => {
    expect(shouldEmitTimerDispatchSuppression({ lastSuppressedAt: null, now: NOW })).toBe(true);
  });

  it("suppresses a second decision within the trailing window", () => {
    const lastSuppressedAt = new Date(NOW.getTime() - 5 * 60 * 1000); // 5 min ago < 10 min window
    expect(shouldEmitTimerDispatchSuppression({ lastSuppressedAt, now: NOW })).toBe(false);
  });

  it("emits again once the trailing window has elapsed", () => {
    const lastSuppressedAt = new Date(NOW.getTime() - 15 * 60 * 1000); // 15 min ago > 10 min window
    expect(shouldEmitTimerDispatchSuppression({ lastSuppressedAt, now: NOW })).toBe(true);
  });

  it("a row at exactly the window edge still counts as in-window (matches gte semantics)", () => {
    const lastSuppressedAt = new Date(NOW.getTime() - TIMER_DISPATCH_SUPPRESSED_DEDUP_WINDOW_MS);
    expect(shouldEmitTimerDispatchSuppression({ lastSuppressedAt, now: NOW })).toBe(false);
  });

  it("honors an explicitly supplied window", () => {
    const lastSuppressedAt = new Date(NOW.getTime() - 4 * 60 * 1000);
    // 5-min window: last suppression 4 min ago is inside it -> suppress (no emit).
    expect(shouldEmitTimerDispatchSuppression({ lastSuppressedAt, now: NOW, windowMs: 5 * 60 * 1000 })).toBe(false);
    // 3-min window: last suppression 4 min ago is outside it -> emit.
    expect(shouldEmitTimerDispatchSuppression({ lastSuppressedAt, now: NOW, windowMs: 3 * 60 * 1000 })).toBe(true);
  });
});
