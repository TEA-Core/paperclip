import { describe, expect, it } from "vitest";
import {
  applyBoardStageDecision,
  BoardStageNoUndecidedStageError,
  BoardStageSelfApprovalError,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "../services/issue-execution-policy.ts";
import { HttpError } from "../errors.js";

const coderAgentId = "11111111-1111-4111-8111-111111111111";
const qaAgentId = "22222222-2222-4222-8222-222222222222";
const ctoUserId = "cto-user";

function makePolicy(
  stages: Array<{
    type: "review" | "approval";
    participants: Array<{ type: "agent" | "user"; agentId?: string; userId?: string }>;
  }>,
  extra?: Record<string, unknown>,
) {
  return normalizeIssueExecutionPolicy({ ...extra, stages })!;
}

function twoStagePolicy() {
  return makePolicy([
    { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
    { type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
  ]);
}

function reviewOnlyPolicy(extra?: Record<string, unknown>) {
  return makePolicy([{ type: "review", participants: [{ type: "agent", agentId: qaAgentId }] }], extra);
}

describe("applyBoardStageDecision (SUP-15805)", () => {
  it("approves an active pending review stage and re-pends the next stage", () => {
    const policy = twoStagePolicy();
    const reviewStage = policy.stages[0];
    const approvalStage = policy.stages[1];

    const result = applyBoardStageDecision({
      issue: {
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: reviewStage.id,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
          returnAssignee: { type: "agent", agentId: coderAgentId, userId: null },
          deliveryAuthor: null,
          completedStageIds: [],
          skippedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          changesRequestedCount: 0,
        },
      },
      policy,
      decision: "approved",
      commentBody: "  Board: looks good, ship it  ",
    });

    expect(result.decision).toEqual({
      stageId: reviewStage.id,
      stageType: "review",
      outcome: "approved",
      body: "Board: looks good, ship it",
    });
    expect(result.targetStage.id).toBe(reviewStage.id);
    expect(result.displacedParticipant).toEqual({ type: "agent", agentId: qaAgentId, userId: null });
    expect(result.workflowControlledAssignment).toBe(true);
    // The next (approval) stage is re-pended to its user participant.
    expect(result.patch.status).toBe("in_review");
    expect(result.patch.assigneeUserId).toBe(ctoUserId);
    expect(result.patch.assigneeAgentId).toBeNull();
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentStageId: approvalStage.id,
      currentStageType: "approval",
      currentParticipant: { type: "user", userId: ctoUserId, agentId: null },
      completedStageIds: [reviewStage.id],
      returnAssignee: { type: "agent", agentId: coderAgentId, userId: null },
    });
  });

  it("completes a final stage and hands the card back to the return assignee", () => {
    const policy = reviewOnlyPolicy({ returnAssigneeAgentId: coderAgentId });
    const reviewStage = policy.stages[0];

    const result = applyBoardStageDecision({
      issue: {
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: reviewStage.id,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
          returnAssignee: { type: "agent", agentId: coderAgentId, userId: null },
          deliveryAuthor: null,
          completedStageIds: [],
          skippedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          changesRequestedCount: 0,
        },
      },
      policy,
      decision: "approved",
      commentBody: "final stage approved by board",
    });

    expect(result.decision.outcome).toBe("approved");
    expect(result.targetStage.id).toBe(reviewStage.id);
    // Final-stage approval hands the completed card back to its return assignee
    // in_progress — never done — so it is not left in_review with a completed
    // state and no reviewer (the SUP-10525 no-review-path state).
    expect(result.patch.status).toBe("in_progress");
    expect(result.patch.assigneeAgentId).toBe(coderAgentId);
    expect(result.patch.assigneeUserId).toBeNull();
    expect(result.patch.executionState).toMatchObject({
      status: "completed",
      currentStageId: null,
      currentStageType: null,
      completedStageIds: [reviewStage.id],
      lastDecisionOutcome: "approved",
    });
  });

  it("requests changes back to the return assignee and resets the round counter", () => {
    const policy = reviewOnlyPolicy({ returnAssigneeAgentId: coderAgentId });
    const reviewStage = policy.stages[0];

    const result = applyBoardStageDecision({
      issue: {
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: reviewStage.id,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
          returnAssignee: { type: "agent", agentId: coderAgentId, userId: null },
          deliveryAuthor: null,
          completedStageIds: [],
          skippedStageIds: [],
          lastDecisionId: "00000000-0000-0000-0000-000000000000",
          lastDecisionOutcome: "approved",
          changesRequestedCount: 2,
        },
      },
      policy,
      decision: "changes_requested",
      commentBody: "board: needs more error handling",
    });

    expect(result.decision.outcome).toBe("changes_requested");
    // Land in `todo`, not `in_progress`: a board hand-back cannot assume a wake
    // path (the live stuck cards return to an external-pull agent that cannot be
    // woken), so the card is queued rather than stranded mid-flight.
    expect(result.patch.status).toBe("todo");
    expect(result.patch.assigneeAgentId).toBe(coderAgentId);
    expect(result.patch.assigneeUserId).toBeNull();
    expect(result.patch.executionState).toMatchObject({
      status: "changes_requested",
      currentStageId: reviewStage.id,
      currentStageType: "review",
      returnAssignee: { type: "agent", agentId: coderAgentId, userId: null },
      lastDecisionOutcome: "changes_requested",
      changesRequestedCount: 0,
    });
  });

  it("resolves a target stage and returns a schema-valid state when executionState is null (stuck card)", () => {
    const policy = reviewOnlyPolicy({ returnAssigneeAgentId: coderAgentId });
    const reviewStage = policy.stages[0];

    const result = applyBoardStageDecision({
      issue: {
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: null,
      },
      policy,
      decision: "changes_requested",
      commentBody: "board: stuck card, kick it back to the implementer",
    });

    expect(result.targetStage.id).toBe(reviewStage.id);
    expect(result.displacedParticipant).toEqual({ type: "agent", agentId: qaAgentId, userId: null });
    expect(result.patch.status).toBe("todo");
    expect(result.patch.assigneeAgentId).toBe(coderAgentId);
    // The null-previous shape must still produce a fully-formed state.
    const state = result.patch.executionState as Record<string, unknown>;
    expect(state).toMatchObject({
      status: "changes_requested",
      currentStageId: reviewStage.id,
      currentStageType: "review",
      currentStageIndex: null,
      currentParticipant: null,
      returnAssignee: { type: "agent", agentId: coderAgentId, userId: null },
      completedStageIds: [],
      skippedStageIds: [],
      lastDecisionId: null,
      changesRequestedCount: 0,
      lastDecisionOutcome: "changes_requested",
    });
    // Round-trips through the shared state schema (proves no required field is missing).
    expect(parseIssueExecutionState(state)).not.toBeNull();
  });

  it("decides the live stuck-card shape (changes_requested, non-zero round counter)", () => {
    // The exact shape of the three stuck cards SUP-15547 / 13951 / 15638: a
    // changes_requested state whose current participant is the (absent) support
    // reviewer and whose round counter is non-zero. No active *pending* stage
    // exists, so target selection must fall through to the first undecided stage.
    const policy = twoStagePolicy();
    const reviewStage = policy.stages[0];
    const approvalStage = policy.stages[1];
    const supportCrAgentId = qaAgentId;

    const result = applyBoardStageDecision({
      issue: {
        status: "blocked",
        assigneeAgentId: supportCrAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "changes_requested",
          currentStageId: reviewStage.id,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: supportCrAgentId, userId: null },
          returnAssignee: { type: "agent", agentId: coderAgentId, userId: null },
          deliveryAuthor: null,
          completedStageIds: [],
          skippedStageIds: [],
          lastDecisionId: "00000000-0000-0000-0000-000000000001",
          lastDecisionOutcome: "changes_requested",
          changesRequestedCount: 1,
        },
      },
      policy,
      decision: "approved",
      commentBody: "board: reviewer absent, accepting this stage",
    });

    expect(result.targetStage.id).toBe(reviewStage.id);
    expect(result.displacedParticipant).toEqual({ type: "agent", agentId: supportCrAgentId, userId: null });
    // Advanced to the next (approval) stage, never closed.
    expect(result.patch.status).toBe("in_review");
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentStageId: approvalStage.id,
      completedStageIds: [reviewStage.id],
    });
  });

  it("refuses a board approval when the board user is the return assignee (self-approval)", () => {
    const policy = reviewOnlyPolicy();
    const reviewStage = policy.stages[0];
    const makeIssue = () => ({
      status: "in_review",
      assigneeAgentId: qaAgentId,
      assigneeUserId: null,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: reviewStage.id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
        returnAssignee: { type: "user", agentId: null, userId: ctoUserId },
        deliveryAuthor: null,
        completedStageIds: [],
        skippedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        changesRequestedCount: 0,
      },
    });

    // The board user IS the return assignee: approving would satisfy the user's
    // own delivery (the shape the agent-path Guard B rejects).
    expect(() =>
      applyBoardStageDecision({
        issue: makeIssue(),
        policy,
        decision: "approved",
        commentBody: "board: approving my own delivery",
        actorUserId: ctoUserId,
      }),
    ).toThrowError(BoardStageSelfApprovalError);

    // A different board user may approve the same stage.
    expect(() =>
      applyBoardStageDecision({
        issue: makeIssue(),
        policy,
        decision: "approved",
        commentBody: "board: approving someone else's delivery",
        actorUserId: "a-different-board-user",
      }),
    ).not.toThrow();
  });

  it("refuses a board approval when the board user is the delivery author and no return assignee is set", () => {
    const policy = reviewOnlyPolicy();
    const reviewStage = policy.stages[0];
    const makeIssue = () => ({
      status: "in_review",
      assigneeAgentId: qaAgentId,
      assigneeUserId: null,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: reviewStage.id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
        returnAssignee: null,
        deliveryAuthor: { type: "user", agentId: null, userId: ctoUserId },
        completedStageIds: [],
        skippedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        changesRequestedCount: 0,
      },
    });

    // With no `returnAssignee`, only `deliveryAuthor` records who the delivery
    // belongs to. The old return-assignee-only guard left this shape unrefused:
    // the board user could approve their own delivery. The canonical resolver
    // falls back to `deliveryAuthor` and refuses it.
    expect(() =>
      applyBoardStageDecision({
        issue: makeIssue(),
        policy,
        decision: "approved",
        commentBody: "board: approving my own delivery",
        actorUserId: ctoUserId,
      }),
    ).toThrowError(BoardStageSelfApprovalError);

    // A different board user may still approve it.
    expect(() =>
      applyBoardStageDecision({
        issue: makeIssue(),
        policy,
        decision: "approved",
        commentBody: "board: approving someone else's delivery",
        actorUserId: "a-different-board-user",
      }),
    ).not.toThrow();
  });

  it("skips a stage carrying a durable approved row even when its projection was cleared", () => {
    const policy = twoStagePolicy();
    const reviewStage = policy.stages[0];
    const approvalStage = policy.stages[1];

    const result = applyBoardStageDecision({
      issue: {
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: reviewStage.id,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
          returnAssignee: { type: "agent", agentId: coderAgentId, userId: null },
          deliveryAuthor: null,
          completedStageIds: [],
          skippedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          changesRequestedCount: 0,
        },
      },
      policy,
      decision: "approved",
      commentBody: "board: re-approving after a cleared projection",
      decidedStageIds: [reviewStage.id],
    });

    // S1's projection is empty but it carries a durable approved row: the board
    // acts on the next undecided stage instead of silently superseding it. The
    // completed projection must also carry the durably-decided S1 id — otherwise
    // the cleared projection would let a later decision re-target and supersede
    // it (SUP-15805 addendum item 3 regression).
    expect(result.targetStage.id).toBe(approvalStage.id);
    expect(result.patch.status).toBe("in_progress");
    expect(result.patch.executionState).toMatchObject({
      status: "completed",
      completedStageIds: [reviewStage.id, approvalStage.id],
    });
  });

  it("clears a workflow-controlled assignee when the final stage has no return assignee", () => {
    const policy = reviewOnlyPolicy();
    const reviewStage = policy.stages[0];

    const result = applyBoardStageDecision({
      issue: {
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: reviewStage.id,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
          returnAssignee: null,
          deliveryAuthor: null,
          completedStageIds: [],
          skippedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          changesRequestedCount: 0,
        },
      },
      policy,
      decision: "approved",
      commentBody: "board: final stage approved, no return assignee recorded",
    });

    // The ladder completed with no return assignee. The card cannot go
    // `in_progress` (that requires an assignee) and must not be left assigned to
    // the reviewer the board just decided against, so it is queued (`todo`) with
    // the assignee explicitly cleared, mirroring the changes-requested hand-back.
    expect(result.patch.status).toBe("todo");
    expect(result.patch.assigneeAgentId).toBeNull();
    expect(result.patch.assigneeUserId).toBeNull();
  });

  it("throws BoardStageNoUndecidedStageError when every stage is completed", () => {
    const policy = reviewOnlyPolicy();
    const reviewStage = policy.stages[0];

    expect(() =>
      applyBoardStageDecision({
        issue: {
          status: "done",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "completed",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: null,
            deliveryAuthor: null,
            completedStageIds: [reviewStage.id],
            skippedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: "approved",
            changesRequestedCount: 0,
          },
        },
        policy,
        decision: "approved",
        commentBody: "nothing left to approve",
      }),
    ).toThrowError(BoardStageNoUndecidedStageError);

    try {
      applyBoardStageDecision({
        issue: {
          status: "done",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "completed",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: null,
            deliveryAuthor: null,
            completedStageIds: [reviewStage.id],
            skippedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: "approved",
            changesRequestedCount: 0,
          },
        },
        policy,
        decision: "approved",
        commentBody: "nothing left to approve",
      });
      throw new Error("expected applyBoardStageDecision to throw");
    } catch (err) {
      expect((err as BoardStageNoUndecidedStageError).reason).toBe("no_undecided_stage");
    }
  });

  it("throws a 422 when a changes_requested decision has no return assignee", () => {
    const policy = reviewOnlyPolicy();
    const reviewStage = policy.stages[0];

    expect(() =>
      applyBoardStageDecision({
        issue: {
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStage.id,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
            returnAssignee: null,
            deliveryAuthor: null,
            completedStageIds: [],
            skippedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
            changesRequestedCount: 0,
          },
        },
        policy,
        decision: "changes_requested",
        commentBody: "board: kick back, but no one owns this card",
      }),
    ).toThrowError(HttpError);
  });

  it("refuses a board approval when the return assignee is an agent and the delivery author is the board user (union guard)", () => {
    const policy = reviewOnlyPolicy({ returnAssigneeAgentId: coderAgentId });
    const reviewStage = policy.stages[0];
    const makeIssue = () => ({
      status: "in_review",
      assigneeAgentId: qaAgentId,
      assigneeUserId: null,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: reviewStage.id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: coderAgentId, userId: null },
        deliveryAuthor: { type: "user", agentId: null, userId: ctoUserId },
        completedStageIds: [],
        skippedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        changesRequestedCount: 0,
      },
    });

    // `returnAssignee` resolves to an AGENT. Guard B's first-match cascade
    // (resolveGatedPrincipal) stops there and never consults the delivery-author
    // user, which would leave the board user free to approve their own delivery.
    // The union guard must still refuse the delivery-author board user.
    expect(() =>
      applyBoardStageDecision({
        issue: makeIssue(),
        policy,
        decision: "approved",
        commentBody: "board: approving my own delivery via the delivery author",
        actorUserId: ctoUserId,
      }),
    ).toThrowError(BoardStageSelfApprovalError);

    // A different board user is not the delivery author and may approve.
    expect(() =>
      applyBoardStageDecision({
        issue: makeIssue(),
        policy,
        decision: "approved",
        commentBody: "board: approving someone else's delivery",
        actorUserId: "a-different-board-user",
      }),
    ).not.toThrow();
  });

  it("[regression guard] does not restore a durably-bounced stage into completedStageIds when the board approves the next stage", () => {
    // Regression guard for the original board-decision projection hardening
    // (a06c3983e / 446842e79); green against the preceding source. It is NOT
    // evidence for the carrier's bea526711 fix (A1/A2/B1/C1).
    const policy = twoStagePolicy();
    const reviewStage = policy.stages[0];
    const approvalStage = policy.stages[1];

    // The review stage was approved then bounced; its LATEST verdict is not an
    // approval, so the route excludes it from decidedStageIds. The board approves
    // the (final) approval stage; the bounced review stage must NOT be restored
    // into completedStageIds by the projection restoration.
    const result = applyBoardStageDecision({
      issue: {
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: approvalStage.id,
          currentStageIndex: 1,
          currentStageType: "approval",
          currentParticipant: { type: "user", userId: ctoUserId, agentId: null },
          returnAssignee: { type: "agent", agentId: coderAgentId, userId: null },
          deliveryAuthor: null,
          completedStageIds: [],
          skippedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          changesRequestedCount: 0,
        },
      },
      policy,
      decision: "approved",
      commentBody: "board: approve the approval stage",
      // reviewStage is deliberately NOT passed in decidedStageIds.
      decidedStageIds: [],
    });

    expect(result.targetStage.id).toBe(approvalStage.id);
    const completed = (result.patch.executionState as Record<string, unknown>).completedStageIds as string[];
    expect(completed).toContain(approvalStage.id);
    expect(completed).not.toContain(reviewStage.id);
  });

  it("[regression guard] re-decides a stage not marked durably decided even after a prior approval", () => {
    // Regression guard for the original "a durable non-approval row must not
    // freeze a stage" behavior (a06c3983e / 446842e79); green against the
    // preceding source. Not evidence for the carrier's bea526711 fix.
    const policy = reviewOnlyPolicy({ returnAssigneeAgentId: coderAgentId });
    const reviewStage = policy.stages[0];

    // The stage's latest verdict is changes_requested (a prior approval was
    // bounced), so it is NOT in decidedStageIds and must remain targetable — the
    // inverse of the "skips a stage carrying a durable approved row" case.
    const result = applyBoardStageDecision({
      issue: {
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: reviewStage.id,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
          returnAssignee: { type: "agent", agentId: coderAgentId, userId: null },
          deliveryAuthor: null,
          completedStageIds: [],
          skippedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: "changes_requested",
          changesRequestedCount: 1,
        },
      },
      policy,
      decision: "approved",
      commentBody: "board: the latest verdict is changes_requested, so this stage is re-decidable",
      // decidedStageIds omits the stage (its latest verdict is not an approval).
    });

    expect(result.targetStage.id).toBe(reviewStage.id);
    expect(result.patch.executionState).toMatchObject({
      status: "completed",
      completedStageIds: [reviewStage.id],
    });
  });

  it("[regression guard] hands the final-stage card back in_progress with the same agent when the card was blocked", () => {
    // Regression guard for the SUP-15547 blocked-card hand-back; green against
    // the preceding source. Not evidence for the carrier's bea526711 fix.
    const policy = reviewOnlyPolicy({ returnAssigneeAgentId: coderAgentId });
    const reviewStage = policy.stages[0];

    // The SUP-15547 shape: the card is blocked and ALREADY assigned to the return
    // assignee. The board's final-stage approval hands it back to the same agent
    // (assignee unchanged) while the status moves blocked -> in_progress. This is
    // the service-side precondition for the route's status-only wake gate.
    const result = applyBoardStageDecision({
      issue: {
        status: "blocked",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: reviewStage.id,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
          returnAssignee: { type: "agent", agentId: coderAgentId, userId: null },
          deliveryAuthor: null,
          completedStageIds: [],
          skippedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          changesRequestedCount: 0,
        },
      },
      policy,
      decision: "approved",
      commentBody: "board: final stage approved on a blocked card",
    });

    // Status changes (blocked -> in_progress) but the agent assignee is unchanged
    // (already the return assignee).
    expect(result.patch.status).toBe("in_progress");
    expect(result.patch.assigneeAgentId).toBe(coderAgentId);
    expect(result.patch.executionState).toMatchObject({ status: "completed" });
  });
});
