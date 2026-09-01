import { describe, expect, it } from "vitest";
import {
  ISSUE_REWAKE_BASE_COOLDOWN_MS,
  ISSUE_REWAKE_MAX_COOLDOWN_MS,
  ISSUE_REWAKE_NO_PROGRESS_THRESHOLD,
  ISSUE_REWAKE_PROMOTION_BASE_COOLDOWN_MS,
  ISSUE_STATE_PROGRESS_ACTIVITY_ACTIONS,
  computeIssueRewakeCooldownMs,
  evaluateIssueRewakeThrottle,
  isThrottleCandidateIssueRewake,
} from "../services/issue-rewake-throttle.ts";

const NOW = new Date("2026-07-12T18:14:00.000Z");

function runSample(input: {
  id: string;
  status?: string;
  finishedSecondsAgo: number;
}) {
  return {
    id: input.id,
    status: input.status ?? "succeeded",
    finishedAt: new Date(NOW.getTime() - input.finishedSecondsAgo * 1000),
  };
}

describe("isThrottleCandidateIssueRewake", () => {
  const base = {
    reason: "issue_assigned",
    wakeCommentId: null,
    requestedByActorType: "system" as const,
    forceFreshSession: false,
    hasExplicitResume: false,
  };

  it("throttles state-poll reasons and reason-less invokes", () => {
    expect(isThrottleCandidateIssueRewake(base)).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: null })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "issue_continuation_needed" })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "issue_assignment_recovery" })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "issue_graph_liveness_backstop" })).toBe(true);
  });

  it("keeps agent comments throttle-eligible without granting human comment privileges", () => {
    expect(isThrottleCandidateIssueRewake({
      ...base,
      reason: "issue_commented",
      wakeCommentId: "comment-1",
      requestedByActorType: "agent",
    })).toBe(true);
    expect(isThrottleCandidateIssueRewake({
      ...base,
      reason: "issue_commented",
      wakeCommentId: "comment-1",
      requestedByActorType: "user",
    })).toBe(false);
  });

  it("never throttles trusted explicit escalation wakes", () => {
    expect(isThrottleCandidateIssueRewake({ ...base, forceFreshSession: true })).toBe(false);
    expect(isThrottleCandidateIssueRewake({ ...base, hasExplicitResume: true })).toBe(false);
  });

  it("keeps agent-authored explicit resume comments throttle-eligible", () => {
    expect(isThrottleCandidateIssueRewake({
      ...base,
      reason: "issue_reopened_via_comment",
      wakeCommentId: "comment-1",
      requestedByActorType: "agent",
      hasExplicitResume: true,
    })).toBe(true);
  });

  it("passes event-shaped wake reasons through", () => {
    for (const reason of [
      "issue_commented",
      "issue_comment_mentioned",
      "issue_blockers_resolved",
      "issue_children_completed",
      "issue_monitor_due",
      "process_lost_retry",
      "run_liveness_continuation",
    ]) {
      expect(isThrottleCandidateIssueRewake({ ...base, reason })).toBe(false);
    }
  });
});

describe("computeIssueRewakeCooldownMs", () => {
  it("starts at the base cooldown and doubles per extra no-progress run, capped", () => {
    expect(computeIssueRewakeCooldownMs(ISSUE_REWAKE_NO_PROGRESS_THRESHOLD)).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS);
    expect(computeIssueRewakeCooldownMs(ISSUE_REWAKE_NO_PROGRESS_THRESHOLD + 1)).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS * 2);
    expect(computeIssueRewakeCooldownMs(ISSUE_REWAKE_NO_PROGRESS_THRESHOLD + 3)).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS * 8);
    expect(computeIssueRewakeCooldownMs(100)).toBe(ISSUE_REWAKE_MAX_COOLDOWN_MS);
  });
});

describe("evaluateIssueRewakeThrottle", () => {
  it("allows when there is no run history", () => {
    expect(
      evaluateIssueRewakeThrottle({
        now: NOW,
        recentTerminalRuns: [],
        runIdsWithIssueProgress: new Set(),
        hasNewIssueInputSinceLastRun: false,
      }),
    ).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("allows below the no-progress threshold", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [runSample({ id: "r1", finishedSecondsAgo: 10 })],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 1 });
  });

  it("blocks inside the cooldown once the streak reaches the threshold", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.noProgressStreak).toBe(2);
      expect(decision.cooldownMs).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS);
      expect(decision.nextAllowedAt.getTime()).toBe(
        NOW.getTime() - 10_000 + ISSUE_REWAKE_BASE_COOLDOWN_MS,
      );
    }
  });

  it("allows again after the cooldown elapses", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: ISSUE_REWAKE_BASE_COOLDOWN_MS / 1000 + 1 }),
        runSample({ id: "r1", finishedSecondsAgo: ISSUE_REWAKE_BASE_COOLDOWN_MS / 1000 + 30 }),
      ],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 2 });
  });

  it("escalates the cooldown as the streak grows", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r4", finishedSecondsAgo: 10 }),
        runSample({ id: "r3", finishedSecondsAgo: 30 }),
        runSample({ id: "r2", finishedSecondsAgo: 60 }),
        runSample({ id: "r1", finishedSecondsAgo: 90 }),
      ],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.noProgressStreak).toBe(4);
      expect(decision.cooldownMs).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS * 4);
    }
  });

  it("honors the promotion base cooldown, which is well above run duration", () => {
    expect(ISSUE_REWAKE_PROMOTION_BASE_COOLDOWN_MS).toBeGreaterThan(ISSUE_REWAKE_BASE_COOLDOWN_MS);
    // A typical no-progress support run is 60-84s; the promotion base must clear it.
    expect(ISSUE_REWAKE_PROMOTION_BASE_COOLDOWN_MS).toBeGreaterThan(84_000);

    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
      baseCooldownMs: ISSUE_REWAKE_PROMOTION_BASE_COOLDOWN_MS,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.cooldownMs).toBe(ISSUE_REWAKE_PROMOTION_BASE_COOLDOWN_MS);
      expect(decision.nextAllowedAt.getTime()).toBe(
        NOW.getTime() - 10_000 + ISSUE_REWAKE_PROMOTION_BASE_COOLDOWN_MS,
      );
    }
  });

  it("honors the promotion base cooldown when the streak escalates", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r3", finishedSecondsAgo: 10 }),
        runSample({ id: "r2", finishedSecondsAgo: 30 }),
        runSample({ id: "r1", finishedSecondsAgo: 50 }),
      ],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
      baseCooldownMs: ISSUE_REWAKE_PROMOTION_BASE_COOLDOWN_MS,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.noProgressStreak).toBe(3);
      expect(decision.cooldownMs).toBe(ISSUE_REWAKE_PROMOTION_BASE_COOLDOWN_MS * 2);
    }
  });

  it("resets at the most recent run with issue-visible progress", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r3", finishedSecondsAgo: 10 }),
        runSample({ id: "r2", finishedSecondsAgo: 40 }),
        runSample({ id: "r1", finishedSecondsAgo: 70 }),
      ],
      runIdsWithIssueProgress: new Set(["r2"]),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 1 });
  });

  it("does not delay recovery after a failed run", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", status: "failed", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("allows when new issue input landed after the last run", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: true,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });
});

describe("ISSUE_STATE_PROGRESS_ACTIVITY_ACTIONS (SUP-14737)", () => {
  it("treats status/ownership/structure changes as progress", () => {
    for (const action of [
      "issue.updated",
      "issue.assigned",
      "issue.child_created",
      "issue.blockers_updated",
      "issue.monitor_scheduled",
      "issue.approval_linked",
    ]) {
      expect(ISSUE_STATE_PROGRESS_ACTIVITY_ACTIONS).toContain(action);
    }
  });

  it("does NOT treat restating the card (comments/docs/work products/attachments) as progress", () => {
    for (const action of [
      "issue.comment_added",
      "issue.document_upserted",
      "issue.work_product_created",
      "issue.attachment_added",
    ]) {
      expect(ISSUE_STATE_PROGRESS_ACTIVITY_ACTIONS).not.toContain(action);
    }
  });
});
