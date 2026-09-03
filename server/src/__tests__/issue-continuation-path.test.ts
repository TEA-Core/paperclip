import { describe, expect, it } from "vitest";
import {
  buildTimerDispatchSuppressionDetails,
  evaluateIssueContinuationPath,
  IN_PROGRESS_SETTLE_WINDOW_MS,
  isTimerCandidateActionable,
  toContinuationPathDate,
  TIMER_DISPATCH_SUPPRESSED_ACTION,
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
