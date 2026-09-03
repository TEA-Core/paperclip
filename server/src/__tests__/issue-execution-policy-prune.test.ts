import { describe, expect, it } from "vitest";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  pruneExecutionStateForStages,
} from "../services/issue-execution-policy.ts";
import type { IssueExecutionPolicy, IssueExecutionState } from "@paperclipai/shared";

const qaAgentId = "22222222-2222-4222-8222-222222222222";
const ctoUserId = "cto-user";
const orphanStageId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function twoStagePolicy() {
  return normalizeIssueExecutionPolicy({
    stages: [
      { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
      { type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
    ],
  })!;
}

function baseState(overrides: Partial<IssueExecutionState>): IssueExecutionState {
  return {
    status: "pending",
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: null,
    reviewRequest: null,
    completedStageIds: [],
    skippedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    ...overrides,
  };
}

describe("pruneExecutionStateForStages (SUP-14590)", () => {
  it("returns null state and no drops for null input", () => {
    expect(pruneExecutionStateForStages(null, ["a"])).toEqual({ state: null, droppedStageIds: [] });
  });

  it("returns the same state reference when nothing is orphaned", () => {
    const state = baseState({ completedStageIds: ["a", "b"], skippedStageIds: [] });
    const result = pruneExecutionStateForStages(state, ["a", "b"]);
    expect(result.state).toBe(state);
    expect(result.droppedStageIds).toEqual([]);
  });

  it("drops completed ids absent from the surviving stages and preserves order", () => {
    const state = baseState({ completedStageIds: [orphanStageId, "b", "a"], skippedStageIds: ["a"] });
    const result = pruneExecutionStateForStages(state, ["a", "b"]);
    expect(result.state?.completedStageIds).toEqual(["b", "a"]);
    expect(result.state?.skippedStageIds).toEqual(["a"]);
    expect(result.droppedStageIds).toEqual([orphanStageId]);
  });

  it("drops skipped ids absent from the surviving stages", () => {
    const state = baseState({ completedStageIds: ["a"], skippedStageIds: ["a", orphanStageId] });
    const result = pruneExecutionStateForStages(state, ["a"]);
    expect(result.state?.skippedStageIds).toEqual(["a"]);
    expect(result.state?.completedStageIds).toEqual(["a"]);
    expect(result.droppedStageIds).toEqual([orphanStageId]);
  });

  it("drops every id when the policy has no surviving stages", () => {
    const state = baseState({ completedStageIds: ["a", "b"], skippedStageIds: ["b"] });
    const result = pruneExecutionStateForStages(state, []);
    expect(result.state?.completedStageIds).toEqual([]);
    expect(result.state?.skippedStageIds).toEqual([]);
    expect(result.droppedStageIds).toEqual(["a", "b"]);
  });
});

describe("applyIssueExecutionPolicyTransition prune (SUP-14590)", () => {
  function runApprovalDone(policy: IssueExecutionPolicy, completedStageIds: string[]) {
    const reviewStageId = policy.stages[0].id;
    const approvalStageId = policy.stages[1].id;
    return applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: ctoUserId,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: approvalStageId,
          currentStageIndex: 1,
          currentStageType: "approval",
          currentParticipant: { type: "user", userId: ctoUserId },
          returnAssignee: null,
          completedStageIds,
          skippedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { userId: ctoUserId },
      commentBody: "Approved, ship it",
    });
  }

  it("drops orphan completed ids across a policy revision on done and surfaces droppedStageIds", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;
    const approvalStageId = policy.stages[1].id;
    const result = runApprovalDone(policy, [reviewStageId, orphanStageId]);

    expect(result.patch.executionState).toMatchObject({
      status: "completed",
      completedStageIds: [reviewStageId, approvalStageId],
    });
    expect(result.droppedStageIds).toEqual([orphanStageId]);
    const surviving = new Set(policy.stages.map((stage) => stage.id));
    for (const id of (result.patch.executionState as { completedStageIds: string[] }).completedStageIds) {
      expect(surviving.has(id)).toBe(true);
    }
  });

  it("does not drop ids that belong to the current revision (no spurious audit)", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;
    const approvalStageId = policy.stages[1].id;
    const result = runApprovalDone(policy, [reviewStageId]);

    expect(result.patch.executionState).toMatchObject({
      completedStageIds: [reviewStageId, approvalStageId],
    });
    expect(result.droppedStageIds).toBeUndefined();
  });
});
