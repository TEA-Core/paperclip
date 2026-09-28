import { describe, expect, it } from "vitest";
import {
  RECOVERY_BOUNCE_CONSECUTIVE_WAKE_FAILURES,
  hasConsecutiveWakeFailures,
  isRecoveryBounceTargetLive,
  recoveryBounceStatusRank,
  decideRecoveryReassignment,
} from "./service.js";

describe("SUP-17884: recovery bounce eligibility (pure helpers)", () => {
  describe("RECOVERY_BOUNCE_CONSECUTIVE_WAKE_FAILURES", () => {
    it("is at least 3 so a single transient failure does not kill an agent", () => {
      expect(RECOVERY_BOUNCE_CONSECUTIVE_WAKE_FAILURES).toBeGreaterThanOrEqual(3);
    });
  });

  describe("hasConsecutiveWakeFailures", () => {
    it("returns true when the K most-recent wake requests all failed", () => {
      expect(hasConsecutiveWakeFailures(["failed", "failed", "failed"], 3)).toBe(true);
    });

    it("returns true for a longer all-failed tail (most-recent-first)", () => {
      expect(hasConsecutiveWakeFailures(["failed", "failed", "failed", "failed"], 3)).toBe(true);
    });

    it("returns false when fewer than K wake requests exist", () => {
      expect(hasConsecutiveWakeFailures(["failed", "failed"], 3)).toBe(false);
    });

    it("returns false when the streak is broken by a non-failed outcome within K", () => {
      // most-recent-first: a success three back breaks the all-failed run
      expect(hasConsecutiveWakeFailures(["failed", "succeeded", "failed", "failed"], 3)).toBe(false);
    });

    it("returns false when a non-terminal status is the most recent", () => {
      expect(hasConsecutiveWakeFailures(["queued", "failed", "failed", "failed"], 3)).toBe(false);
    });

    it("returns false for empty / null / undefined history", () => {
      expect(hasConsecutiveWakeFailures([], 3)).toBe(false);
      expect(hasConsecutiveWakeFailures(null, 3)).toBe(false);
      expect(hasConsecutiveWakeFailures(undefined, 3)).toBe(false);
    });

    it("treats a single failure as not-dead at K=3", () => {
      expect(hasConsecutiveWakeFailures(["failed"], 3)).toBe(false);
    });
  });

  describe("recoveryBounceStatusRank (C3 ordering)", () => {
    it("ranks idle/active/running as the best (0)", () => {
      expect(recoveryBounceStatusRank("idle")).toBe(0);
      expect(recoveryBounceStatusRank("active")).toBe(0);
      expect(recoveryBounceStatusRank("running")).toBe(0);
    });

    it("demotes error below idle but not out of the set (1)", () => {
      expect(recoveryBounceStatusRank("error")).toBe(1);
    });

    it("ranks unknown statuses lowest (2)", () => {
      expect(recoveryBounceStatusRank("archived")).toBe(2);
      expect(recoveryBounceStatusRank(null)).toBe(2);
      expect(recoveryBounceStatusRank(undefined)).toBe(2);
    });

    it("prefers idle ahead of error", () => {
      expect(recoveryBounceStatusRank("idle")).toBeLessThan(recoveryBounceStatusRank("error"));
    });
  });

  describe("isRecoveryBounceTargetLive (C2 liveness)", () => {
    it("keeps a plain `error` agent live when its wake history is clean (no stripping of error)", () => {
      // A5 §0 guard: an error status alone must NOT make the agent undispatchable.
      expect(isRecoveryBounceTargetLive("error", null)).toBe(true);
      expect(isRecoveryBounceTargetLive("error", ["failed"])).toBe(true);
    });

    it("marks a dead agent (K consecutive failed wakes) not live even when status is error", () => {
      expect(
        isRecoveryBounceTargetLive("error", ["failed", "failed", "failed"], RECOVERY_BOUNCE_CONSECUTIVE_WAKE_FAILURES),
      ).toBe(false);
    });

    it("marks a dead agent not live even when its status is idle", () => {
      expect(
        isRecoveryBounceTargetLive("idle", ["failed", "failed", "failed"], RECOVERY_BOUNCE_CONSECUTIVE_WAKE_FAILURES),
      ).toBe(false);
    });

    it("keeps an idle agent with a clean wake history live", () => {
      expect(isRecoveryBounceTargetLive("idle", null)).toBe(true);
      expect(isRecoveryBounceTargetLive("idle", ["succeeded", "failed", "failed"])).toBe(true);
    });

    it("rejects a non-invokable status regardless of wake history", () => {
      expect(isRecoveryBounceTargetLive("archived", null)).toBe(false);
    });
  });

  describe("decideRecoveryReassignment (C1 refusal)", () => {
    it("fast-paths when the recovery owner is the same as the current assignee", () => {
      const decision = decideRecoveryReassignment({
        currentAssigneeAgentId: "agent-1",
        recoveryOwnerAgentId: "agent-1",
        reviewStageSelfSatisfies: false,
        recoveryOwnerLive: true,
      });
      expect(decision).toMatchObject({ assigneeAgentId: "agent-1", refused: false, refusalReason: null });
    });

    it("keeps the current assignee when the recovery owner is null", () => {
      const decision = decideRecoveryReassignment({
        currentAssigneeAgentId: "agent-1",
        recoveryOwnerAgentId: null,
        reviewStageSelfSatisfies: false,
        recoveryOwnerLive: true,
      });
      expect(decision.assigneeAgentId).toBe("agent-1");
      expect(decision.refused).toBe(false);
    });

    it("assigns the recovery owner when it is live and the review stage is clear", () => {
      const decision = decideRecoveryReassignment({
        currentAssigneeAgentId: "agent-1",
        recoveryOwnerAgentId: "agent-2",
        reviewStageSelfSatisfies: false,
        recoveryOwnerLive: true,
      });
      expect(decision).toMatchObject({
        assigneeAgentId: "agent-2",
        refused: false,
        refusalReason: null,
        refusedAssigneeAgentId: null,
        keptAssigneeAgentId: null,
      });
    });

    it("refuses and keeps the current assignee when the recovery owner cannot start a run (A4)", () => {
      const decision = decideRecoveryReassignment({
        currentAssigneeAgentId: "agent-1",
        recoveryOwnerAgentId: "agent-2",
        reviewStageSelfSatisfies: false,
        recoveryOwnerLive: false,
      });
      expect(decision).toMatchObject({
        assigneeAgentId: "agent-1",
        refused: true,
        refusalReason: "reassignment_target_not_live",
      });
      // A3 evidence shape
      expect(decision.refusedAssigneeAgentId).toBe("agent-2");
      expect(decision.keptAssigneeAgentId).toBe("agent-1");
    });

    it("refuses when the write would make an incomplete review stage self-satisfiable (SUP-13526)", () => {
      const decision = decideRecoveryReassignment({
        currentAssigneeAgentId: "agent-1",
        recoveryOwnerAgentId: "agent-2",
        reviewStageSelfSatisfies: true,
        recoveryOwnerLive: true,
      });
      expect(decision).toMatchObject({
        assigneeAgentId: "agent-1",
        refused: true,
        refusalReason: "review_stage_self_satisfy",
      });
      expect(decision.refusedAssigneeAgentId).toBe("agent-2");
      expect(decision.keptAssigneeAgentId).toBe("agent-1");
    });

    it("prefers the review-stage refusal when both predicates hold", () => {
      const decision = decideRecoveryReassignment({
        currentAssigneeAgentId: "agent-1",
        recoveryOwnerAgentId: "agent-2",
        reviewStageSelfSatisfies: true,
        recoveryOwnerLive: false,
      });
      expect(decision.refusalReason).toBe("review_stage_self_satisfy");
    });

    it("keeps the card unassigned when refusing and there is no current assignee", () => {
      const decision = decideRecoveryReassignment({
        currentAssigneeAgentId: null,
        recoveryOwnerAgentId: "agent-2",
        reviewStageSelfSatisfies: false,
        recoveryOwnerLive: false,
      });
      expect(decision.assigneeAgentId).toBe(null);
      expect(decision.refused).toBe(true);
      expect(decision.keptAssigneeAgentId).toBe(null);
    });
  });
});
