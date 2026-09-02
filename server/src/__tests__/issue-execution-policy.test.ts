import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_REVIEW_ROUNDS, applyIssueExecutionPolicyTransition, assertPatchableExecutionPolicyWrite, buildIssueMonitorTriggeredPatch, normalizeIssueExecutionPolicy, parseIssueExecutionState, stripMonitorFromExecutionPolicy } from "../services/issue-execution-policy.ts";
import { HttpError } from "../errors.js";
import type { IssueExecutionPolicy, IssueExecutionState } from "@paperclipai/shared";

const coderAgentId = "11111111-1111-4111-8111-111111111111";
const qaAgentId = "22222222-2222-4222-8222-222222222222";
const ctoAgentId = "33333333-3333-4333-8333-333333333333";
const ctoUserId = "cto-user";
const boardUserId = "board-user";

function makePolicy(
  stages: Array<{ type: "review" | "approval"; participants: Array<{ type: "agent" | "user"; agentId?: string; userId?: string }> }>,
) {
  return normalizeIssueExecutionPolicy({ stages })!;
}

function twoStagePolicy() {
  return makePolicy([
    { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
    { type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
  ]);
}

function reviewOnlyPolicy() {
  return makePolicy([
    { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
  ]);
}

function approvalOnlyPolicy() {
  return makePolicy([
    { type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
  ]);
}

describe("normalizeIssueExecutionPolicy", () => {
  it("returns null for null/undefined input", () => {
    expect(normalizeIssueExecutionPolicy(null)).toBeNull();
    expect(normalizeIssueExecutionPolicy(undefined)).toBeNull();
  });

  it("returns null when stages are empty", () => {
    expect(normalizeIssueExecutionPolicy({ stages: [] })).toBeNull();
  });

  it("throws when all participants are invalid (missing agentId)", () => {
    expect(() =>
      normalizeIssueExecutionPolicy({
        stages: [{ type: "review", participants: [{ type: "agent" }] }],
      }),
    ).toThrow("Invalid execution policy");
  });

  it("deduplicates participants within a stage", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: qaAgentId },
          ],
        },
      ],
    });
    expect(result!.stages[0].participants).toHaveLength(1);
  });

  it("assigns UUIDs to stages and participants", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
      ],
    });
    expect(result!.stages[0].id).toBeDefined();
    expect(result!.stages[0].participants[0].id).toBeDefined();
  });

  it("always sets commentRequired to true", () => {
    const result = normalizeIssueExecutionPolicy({
      commentRequired: false,
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
      ],
    });
    expect(result!.commentRequired).toBe(true);
  });

  it("defaults mode to normal", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
      ],
    });
    expect(result!.mode).toBe("normal");
  });

  it("rejects approvalsNeeded values above 1", () => {
    expect(() =>
      normalizeIssueExecutionPolicy({
        stages: [
          {
            type: "review",
            approvalsNeeded: 2,
            participants: [{ type: "agent", agentId: qaAgentId }],
          },
        ],
      }),
    ).toThrow("Invalid execution policy");
  });

  it("throws for invalid input", () => {
    expect(() => normalizeIssueExecutionPolicy({ stages: [{ type: "invalid_type" }] })).toThrow();
  });

  it("keeps monitor-only policies", () => {
    const result = normalizeIssueExecutionPolicy({
      monitor: {
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        notes: "Check deployment",
        externalRef: "https://example.test/deploy?token=secret",
      },
      stages: [],
    });
    expect(result).toMatchObject({
      stages: [],
      monitor: {
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        notes: "Check deployment",
        scheduledBy: "assignee",
        externalRef: "[redacted]",
      },
    });
  });
});

describe("assertPatchableExecutionPolicyWrite (SUP-13634)", () => {
  const monitor = {
    nextCheckAt: "2026-04-11T12:30:00.000Z",
    notes: "Check deployment",
  };

  function assertWrite(
    input: Omit<Parameters<typeof assertPatchableExecutionPolicyWrite>[0], "stagesExplicitlyEmpty"> & {
      stagesExplicitlyEmpty?: boolean;
    },
  ) {
    return assertPatchableExecutionPolicyWrite({
      stagesExplicitlyEmpty: false,
      ...input,
    });
  }

  it("rejects an explicit empty stages array", () => {
    expect(() =>
      assertPatchableExecutionPolicyWrite({
        raw: { stages: [] },
        currentPolicy: twoStagePolicy(),
        stagesExplicitlyEmpty: true,
      }),
    ).toThrowError(HttpError);
    try {
      assertPatchableExecutionPolicyWrite({
        raw: { stages: [] },
        currentPolicy: twoStagePolicy(),
        stagesExplicitlyEmpty: true,
      });
      throw new Error("expected assert to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(422);
      expect((error as Error).message).toBe("executionPolicy.stages must not be empty");
    }
  });

  it("rejects an explicit empty stages array even when no policy is stored yet", () => {
    expect(() =>
      assertPatchableExecutionPolicyWrite({
        raw: { stages: [] },
        currentPolicy: null,
        stagesExplicitlyEmpty: true,
      }),
    ).toThrowError("executionPolicy.stages must not be empty");
  });

  it("rejects an explicit empty stages array even when other policy fields are present", () => {
    expect(() =>
      assertPatchableExecutionPolicyWrite({
        raw: { stages: [], monitor },
        currentPolicy: twoStagePolicy(),
        stagesExplicitlyEmpty: true,
      }),
    ).toThrowError("executionPolicy.stages must not be empty");
  });

  it("flags explicit-emptiness via the captured pre-default flag, not the parsed body", () => {
    const raw = { mode: "normal", commentRequired: true, stages: [], monitor };
    expect(() =>
      assertWrite({ raw, currentPolicy: twoStagePolicy() }),
    ).not.toThrow();
    expect(() =>
      assertPatchableExecutionPolicyWrite({
        raw,
        currentPolicy: twoStagePolicy(),
        stagesExplicitlyEmpty: true,
      }),
    ).toThrowError("executionPolicy.stages must not be empty");
  });

  // SUP-13925: a monitor-only watcher's stored policy is `{mode, stages: [],
  // monitor}` by design. The re-arm idiom reads that policy, edits
  // `monitor.nextCheckAt`, and writes the whole object back — which carries an
  // explicit `stages: []` and used to 422, leaving a partial `{monitor}` body
  // as the only working path.
  function monitorOnlyPolicy() {
    return normalizeIssueExecutionPolicy({ stages: [], monitor })!;
  }

  it("allows an explicit empty stages array over an already stage-less stored policy", () => {
    expect(monitorOnlyPolicy().stages).toEqual([]);
    expect(() =>
      assertPatchableExecutionPolicyWrite({
        raw: { mode: "normal", commentRequired: true, stages: [], monitor },
        currentPolicy: monitorOnlyPolicy(),
        stagesExplicitlyEmpty: true,
      }),
    ).not.toThrow();
  });

  it("allows the monitor re-arm round-trip that regressed (whole-object write with a new nextCheckAt)", () => {
    const stored = monitorOnlyPolicy();
    expect(() =>
      assertPatchableExecutionPolicyWrite({
        raw: {
          ...stored,
          monitor: { ...stored.monitor, nextCheckAt: "2026-08-26T08:00:00.000Z", maxAttempts: 100 },
        },
        currentPolicy: stored,
        stagesExplicitlyEmpty: true,
      }),
    ).not.toThrow();
  });

  it("grants no capability the partial-body path did not already have", () => {
    // The permissive branch is safe precisely because omitting `stages`
    // entirely reaches the identical stored result today. If that ever stops
    // being true, this test fails and the relaxation must be re-argued.
    const stored = monitorOnlyPolicy();
    const whole = { mode: "normal" as const, commentRequired: true, stages: [], monitor };
    expect(normalizeIssueExecutionPolicy(whole)).toEqual(
      normalizeIssueExecutionPolicy({ mode: "normal", commentRequired: true, monitor }),
    );
    expect(normalizeIssueExecutionPolicy(whole)!.stages).toEqual(stored.stages);
  });

  it("still rejects an explicit empty stages array over a policy that HAS stages", () => {
    // The ADR-029/ADR-072 case. Unchanged by SUP-13925.
    expect(() =>
      assertPatchableExecutionPolicyWrite({
        raw: { mode: "normal", commentRequired: true, stages: [], monitor },
        currentPolicy: reviewOnlyPolicy(),
        stagesExplicitlyEmpty: true,
      }),
    ).toThrowError("executionPolicy.stages must not be empty");
  });

  it("rejects an explicit null over a non-null stored policy", () => {
    expect(() =>
      assertWrite({ raw: null, currentPolicy: twoStagePolicy() }),
    ).toThrowError(
      "executionPolicy must not be set to null on an issue that currently has a policy; send the full replacement policy instead",
    );
  });

  it("allows an explicit null over a null stored policy (no-op)", () => {
    expect(() => assertWrite({ raw: null, currentPolicy: null })).not.toThrow();
  });

  it("rejects a body that normalizes to null over an issue with a close ladder", () => {
    expect(() => assertWrite({ raw: { mode: "normal" }, currentPolicy: twoStagePolicy() })).toThrowError(
      "executionPolicy must not clear the issue's existing close stages",
    );
    expect(() => assertWrite({ raw: { commentRequired: true }, currentPolicy: twoStagePolicy() })).toThrowError(
      "executionPolicy must not clear the issue's existing close stages",
    );
  });

  it("allows a body that normalizes to null over an issue with no close ladder", () => {
    const monitorOnly = normalizeIssueExecutionPolicy({ monitor, stages: [] });
    expect(monitorOnly).not.toBeNull();
    expect(() => assertWrite({ raw: { mode: "normal" }, currentPolicy: monitorOnly })).not.toThrow();
  });

  it("allows a full replacement policy over a non-null stored policy", () => {
    expect(() =>
      assertWrite({
        raw: {
          stages: [
            {
              type: "review",
              participants: [{ type: "agent", agentId: qaAgentId }],
            },
          ],
        },
        currentPolicy: twoStagePolicy(),
      }),
    ).not.toThrow();
  });

  it("allows a monitor-only policy that omits the stages field", () => {
    expect(() => assertWrite({ raw: { monitor }, currentPolicy: null })).not.toThrow();
    expect(() => assertWrite({ raw: { monitor }, currentPolicy: twoStagePolicy() })).not.toThrow();
  });

  it("leaves malformed non-object shapes to the schema", () => {
    expect(() => assertWrite({ raw: "nope", currentPolicy: twoStagePolicy() })).not.toThrow();
  });
});

describe("parseIssueExecutionState", () => {
  it("returns null for null/undefined", () => {
    expect(parseIssueExecutionState(null)).toBeNull();
    expect(parseIssueExecutionState(undefined)).toBeNull();
  });

  it("returns null for invalid shape", () => {
    expect(parseIssueExecutionState({ status: "bogus" })).toBeNull();
  });

  it("parses a valid state", () => {
    const state = parseIssueExecutionState({
      status: "pending",
      currentStageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: qaAgentId },
      returnAssignee: { type: "agent", agentId: coderAgentId },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    });
    expect(state).not.toBeNull();
    expect(state!.status).toBe("pending");
  });

  it("round-trips skippedStageIds", () => {
    // The skip marker is only useful if it survives the read back. zod strips
    // unknown keys, so a state written with skippedStageIds but parsed by a
    // schema that does not declare it would lose the one field that tells a
    // skipped stage apart from an approved one.
    const skippedStageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const state = parseIssueExecutionState({
      status: "completed",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: { type: "agent", agentId: coderAgentId },
      completedStageIds: [skippedStageId],
      skippedStageIds: [skippedStageId],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    });
    expect(state!.skippedStageIds).toEqual([skippedStageId]);
  });

  it("defaults skippedStageIds to empty for a state written before the field existed", () => {
    const state = parseIssueExecutionState({
      status: "completed",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: { type: "agent", agentId: coderAgentId },
      completedStageIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    });
    expect(state!.skippedStageIds).toEqual([]);
  });

  it("round-trips deliveryAuthor", () => {
    // The delivery author is only useful if it survives the read back. zod
    // strips unknown keys, so a state written with deliveryAuthor but parsed
    // by a schema that does not declare it would lose the one field that
    // tells a hand-PATCH delivery apart from a self-review (SUP-13899).
    const state = parseIssueExecutionState({
      status: "pending",
      currentStageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: qaAgentId },
      returnAssignee: { type: "agent", agentId: coderAgentId },
      deliveryAuthor: { type: "agent", agentId: coderAgentId },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    });
    expect(state!.deliveryAuthor).toEqual({ type: "agent", agentId: coderAgentId });
  });

  it("defaults deliveryAuthor to null for a state written before the field existed", () => {
    const state = parseIssueExecutionState({
      status: "pending",
      currentStageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: qaAgentId },
      returnAssignee: { type: "agent", agentId: coderAgentId },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    });
    expect(state!.deliveryAuthor).toBeNull();
  });
});

describe("issue execution policy transitions", () => {
  describe("happy path: executor → review → approval → done", () => {
    const policy = twoStagePolicy();

    it("routes executor completion into review", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Implemented the feature",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBe(qaAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "review",
        returnAssignee: { type: "agent", agentId: coderAgentId },
      });
      expect(result.decision).toBeUndefined();
    });

    it("carries loose review instructions on the pending handoff", () => {
      const reviewInstructions = [
        "Please focus on whether the migration path is reversible.",
        "",
        "- Check failure handling",
        "- Call out any unclear operator instructions",
      ].join("\n");

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Implemented the migration",
        reviewRequest: { instructions: reviewInstructions },
      });

      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
        reviewRequest: { instructions: reviewInstructions },
      });
    });

    it("clears loose review instructions with explicit null during a stage transition", () => {
      const reviewStageId = policy.stages[0].id;
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            reviewRequest: { instructions: "Old review request" },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_review",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Ready for review",
        reviewRequest: null,
      });

      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
        reviewRequest: null,
      });
    });

    it("reviewer approves → advances to approval stage", () => {
      const reviewStageId = policy.stages[0].id;
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "QA signoff complete",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBeNull();
      expect(result.patch.assigneeUserId).toBe(ctoUserId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "approval",
        completedStageIds: [reviewStageId],
        currentParticipant: { type: "user", userId: ctoUserId },
      });
      expect(result.decision).toMatchObject({
        stageId: reviewStageId,
        stageType: "review",
        outcome: "approved",
      });
    });

    it("lets a reviewer provide loose instructions for the next approval stage", () => {
      const reviewStageId = policy.stages[0].id;
      const approvalInstructions = "Please decide whether this is ready to ship, with any launch caveats.";
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            reviewRequest: { instructions: "Review the implementation details." },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "QA signoff complete",
        reviewRequest: { instructions: approvalInstructions },
      });

      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: ctoUserId },
        reviewRequest: { instructions: approvalInstructions },
      });
    });

    it("approver approves → marks completed (allows done)", () => {
      const reviewStageId = policy.stages[0].id;
      const approvalStageId = policy.stages[1].id;
      const result = applyIssueExecutionPolicyTransition({
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
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [reviewStageId],
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

      expect(result.patch.executionState).toMatchObject({
        status: "completed",
        completedStageIds: expect.arrayContaining([reviewStageId, approvalStageId]),
        lastDecisionOutcome: "approved",
      });
      expect(result.decision).toMatchObject({
        stageId: approvalStageId,
        stageType: "approval",
        outcome: "approved",
      });
      // status should NOT be overridden — caller can set done
      expect(result.patch.status).toBeUndefined();
    });
  });

  describe("changes requested flow", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("reviewer requests changes → returns to return assignee", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "Needs another pass on edge cases",
      });

      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.assigneeAgentId).toBe(coderAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "changes_requested",
        currentStageType: "review",
        returnAssignee: { type: "agent", agentId: coderAgentId },
        lastDecisionOutcome: "changes_requested",
      });
      expect(result.decision).toMatchObject({
        stageId: reviewStageId,
        stageType: "review",
        outcome: "changes_requested",
      });
    });

    it("executor re-submits after changes → returns to same review stage", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "changes_requested",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: "changes_requested",
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Fixed edge cases",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBe(qaAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageId: reviewStageId,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
      });
    });
  });

  describe("review-only policy (no approval stage)", () => {
    const policy = reviewOnlyPolicy();
    const reviewStageId = policy.stages[0].id;

    it("reviewer approval completes the policy", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "LGTM",
      });

      expect(result.patch.executionState).toMatchObject({
        status: "completed",
        completedStageIds: [reviewStageId],
        lastDecisionOutcome: "approved",
      });
      expect(result.decision).toMatchObject({
        stageType: "review",
        outcome: "approved",
      });
    });
  });

  describe("approval-only policy (no review stage)", () => {
    const policy = approvalOnlyPolicy();

    it("executor completion routes directly to approval", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeUserId).toBe(ctoUserId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "approval",
      });
    });
  });

  describe("access control", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("non-participant cannot advance the active stage", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: { assigneeUserId: boardUserId },
          actor: { agentId: coderAgentId },
          commentBody: "Trying to bypass review",
        }),
      ).toThrow("Only the active reviewer or approver can advance");
    });

    it("board override can cancel an active review without recording an approval decision", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "cancelled",
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
        allowBoardOverride: true,
        commentBody: "Cancelling this task",
      });

      expect(result.patch).toEqual({ executionState: null });
      expect(result.decision).toBeUndefined();
      expect(result.workflowControlledAssignment).toBeUndefined();
    });

    it("board override can cancel a drifted pending review without rebuilding the pending stage", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "blocked",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "cancelled",
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
        allowBoardOverride: true,
        commentBody: "Cancelling this drifted task",
      });

      expect(result.patch).toEqual({ executionState: null });
      expect(result.decision).toBeUndefined();
      expect(result.workflowControlledAssignment).toBeUndefined();
    });

    it("board override reassignment to an eligible participant re-pends the stage", () => {
      const multiReviewerPolicy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: ctoAgentId },
          ],
        },
      ]);
      const multiReviewerStageId = multiReviewerPolicy.stages[0].id;
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: multiReviewerPolicy,
          executionState: {
            status: "pending",
            currentStageId: multiReviewerStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy: multiReviewerPolicy,
        requestedAssigneePatch: { assigneeAgentId: ctoAgentId },
        actor: { userId: boardUserId },
        allowBoardOverride: true,
        commentBody: "Swapping the reviewer",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBe(ctoAgentId);
      expect(result.patch.assigneeUserId).toBeNull();
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageId: multiReviewerStageId,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: ctoAgentId },
        returnAssignee: { type: "agent", agentId: coderAgentId },
      });
      expect(result.decision).toBeUndefined();
    });

    it("board override reassignment to a non-participant dissolves the review", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedAssigneePatch: { assigneeAgentId: coderAgentId },
        actor: { userId: boardUserId },
        allowBoardOverride: true,
        commentBody: "Handing the task back",
      });

      expect(result.patch).toEqual({ executionState: null, status: "in_progress" });
      expect(result.decision).toBeUndefined();
      expect(result.workflowControlledAssignment).toBeUndefined();
    });

    it("board override unassignment dissolves the review instead of stranding in_review", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedAssigneePatch: { assigneeAgentId: null, assigneeUserId: null },
        actor: { userId: boardUserId },
        allowBoardOverride: true,
        commentBody: "Unassigning the reviewer",
      });

      expect(result.patch).toEqual({ executionState: null, status: "in_progress" });
      expect(result.decision).toBeUndefined();
      expect(result.workflowControlledAssignment).toBeUndefined();
    });

    it("non-participant can still post non-advancing updates", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Just a note",
      });

      // No error — just no patch modifications
      expect(result.patch).toEqual({});
    });
  });

  describe("comment requirements", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("approval without comment throws", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: "",
        }),
      ).toThrow(/Approving a review or approval stage requires a comment.*same PATCH request.*prior comments are not considered/);
    });

    it("changes requested without comment throws", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "in_progress",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: null,
        }),
      ).toThrow(/Requesting changes requires a comment.*same PATCH request.*prior comments are not considered/);
    });

    it("whitespace-only comment is treated as empty", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: "   ",
        }),
      ).toThrow("requires a comment");
    });
  });

  describe("policy removal mid-flow", () => {
    it("clears execution state when policy removed and returns to executor", () => {
      // Use a real UUID for currentStageId so parseIssueExecutionState succeeds
      const stageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: {
            status: "pending",
            currentStageId: stageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy: null,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
      });

      expect(result.patch.executionState).toBeNull();
      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.assigneeAgentId).toBe(coderAgentId);
    });

    it("clears execution state without assignee change when not in_review", () => {
      const stageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: {
            status: "changes_requested",
            currentStageId: stageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: "changes_requested",
          },
        },
        policy: null,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch.executionState).toBeNull();
      // Not in_review, so no status/assignee change
      expect(result.patch.status).toBeUndefined();
    });
  });

  describe("reopening from done/cancelled clears state", () => {
    it("reopening a done issue clears execution state", () => {
      const policy = twoStagePolicy();
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "done",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "completed",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [policy.stages[0].id, policy.stages[1].id],
            lastDecisionId: null,
            lastDecisionOutcome: "approved",
          },
        },
        policy,
        requestedStatus: "todo",
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch.executionState).toBeNull();
    });
  });

  describe("no-op transitions", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("non-done status change without review context is a no-op", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "blocked",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toEqual({});
    });

    it("coerces a malformed executor in_review patch into the first policy stage", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "in_review",
        requestedAssigneePatch: { assigneeUserId: boardUserId },
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
        },
      });
    });

    it("reasserts the active stage when issue status drifted out of in_review", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: { assigneeAgentId: coderAgentId },
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId },
        },
      });
    });

    it("no policy and no state is a no-op", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: null,
        },
        policy: null,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toEqual({});
    });

    it("does not auto-start workflow when policy is added to an already in_review issue", () => {
      const reviewOnly = reviewOnlyPolicy();
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: boardUserId,
          executionPolicy: null,
          executionState: null,
        },
        policy: reviewOnly,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch).toEqual({});
    });

    it("null policy + in_review degrades gracefully instead of throwing", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: null,
        },
        policy: null,
        requestedStatus: "in_review",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toEqual({});
    });

    it("null policy + in_review with existing state clears execution state", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: boardUserId,
          executionPolicy: null,
          executionState: {
            status: "pending",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy: null,
        requestedStatus: "in_review",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toMatchObject({
        executionState: null,
      });
    });
  });

  describe("multi-participant stages", () => {
    it("selects the preferred participant when explicitly requested", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: ctoAgentId },
          ],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: { assigneeAgentId: ctoAgentId },
        actor: { agentId: coderAgentId },
        commentBody: "Ready for review",
      });

      expect(result.patch.assigneeAgentId).toBe(ctoAgentId);
    });

    it("falls back to first participant when no preference given", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: ctoAgentId },
          ],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Ready for review",
      });

      expect(result.patch.assigneeAgentId).toBe(qaAgentId);
    });

    it("excludes the return assignee from participant selection", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: coderAgentId },
            { type: "agent", agentId: qaAgentId },
          ],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      // coderAgentId is the returnAssignee, so QA should be selected
      expect(result.patch.assigneeAgentId).toBe(qaAgentId);
    });

    it("skips a self-review-only stage and completes the workflow", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [{ type: "agent", agentId: coderAgentId }],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch).toMatchObject({
        executionState: {
          status: "completed",
          currentStageType: null,
          currentParticipant: null,
          returnAssignee: { type: "agent", agentId: coderAgentId },
          completedStageIds: [policy.stages[0].id],
          // The skip is now recorded. Without this the stage id sits in
          // completedStageIds looking exactly like an approved stage, and the
          // skip writes no decision row, so nothing afterwards can tell the
          // two apart.
          skippedStageIds: [policy.stages[0].id],
        },
      });
      expect(result.patch.status).toBeUndefined();
      expect(result.patch.assigneeAgentId).toBeUndefined();
    });

    it("refuses to route an approval stage to its own return assignee", () => {
      const policy = makePolicy([
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
        { type: "approval", participants: [{ type: "agent", agentId: coderAgentId }] },
      ]);
      const reviewStageId = policy.stages[0].id;

      // Advancing out of the review stage has to select a participant for the
      // approval stage. Its only participant IS the return assignee, so there
      // is no one eligible and the transition fails loud. Before this fix the
      // runtime fell back to the excluded principal and the coder approved its
      // own work, recorded as an ordinary `approved` decision.
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: "QA signoff complete",
        }),
      ).toThrow(/No eligible approval participant is configured/);
    });

    it("skips a self-review-only review stage and advances to approval", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [{ type: "agent", agentId: coderAgentId }],
        },
        {
          type: "approval",
          participants: [{ type: "user", userId: ctoUserId }],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: ctoUserId,
        executionState: {
          status: "pending",
          currentStageType: "approval",
          currentParticipant: { type: "user", userId: ctoUserId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
          completedStageIds: [policy.stages[0].id],
        },
      });
    });
  });

  describe("final stage completion terminates the policy (#7893)", () => {
    function threeStagePolicy() {
      return makePolicy([
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
        { type: "review", participants: [{ type: "agent", agentId: ctoAgentId }] },
        { type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
      ]);
    }

    it("final-stage approval completes even when earlier completedStageIds are stale", () => {
      const policy = threeStagePolicy();
      const approvalStageId = policy.stages[2].id;
      // completedStageIds reference stage ids from a previous version of the
      // embedded policy (stage ids regenerate when the policy is re-sent or
      // edited mid-flow); only the active final stage id still matches.
      const staleStageIds = [
        "99999999-9999-4999-8999-999999999991",
        "99999999-9999-4999-8999-999999999992",
      ];
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: ctoUserId,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: approvalStageId,
            currentStageIndex: 2,
            currentStageType: "approval",
            currentParticipant: { type: "user", userId: ctoUserId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: staleStageIds,
            lastDecisionId: null,
            lastDecisionOutcome: "approved",
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { userId: ctoUserId },
        commentBody: "Approved, ship it",
      });

      // Must terminate the policy, not wrap around to the first stage.
      // SUP-14590: the stale ids from a prior policy revision are pruned out of the
      // carried-forward completedStageIds (they are not part of this revision's
      // stages); only the current revision's final stage id survives. Termination
      // is unchanged — the final-stage approval still completes the policy.
      expect(result.patch.executionState).toMatchObject({
        status: "completed",
        completedStageIds: [approvalStageId],
        lastDecisionOutcome: "approved",
      });
      expect(result.droppedStageIds).toEqual(staleStageIds);
      expect(result.patch.status).toBeUndefined();
      expect(result.patch.assigneeAgentId).toBeUndefined();
      expect(result.decision).toMatchObject({
        stageId: approvalStageId,
        stageType: "approval",
        outcome: "approved",
      });
    });

    it("non-final stage approval still advances forward to the next stage", () => {
      const policy = threeStagePolicy();
      const firstStageId = policy.stages[0].id;
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: firstStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "QA pass",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBe(ctoAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageId: policy.stages[1].id,
        currentStageIndex: 1,
        completedStageIds: [firstStageId],
      });
    });

    it("final-stage changes requested still returns to the executor", () => {
      const policy = threeStagePolicy();
      const approvalStageId = policy.stages[2].id;
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: ctoUserId,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: approvalStageId,
            currentStageIndex: 2,
            currentStageType: "approval",
            currentParticipant: { type: "user", userId: ctoUserId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [policy.stages[0].id, policy.stages[1].id],
            lastDecisionId: null,
            lastDecisionOutcome: "approved",
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { userId: ctoUserId },
        commentBody: "Needs rework before release",
      });

      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.assigneeAgentId).toBe(coderAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "changes_requested",
        currentStageId: approvalStageId,
        lastDecisionOutcome: "changes_requested",
      });
    });

    it("a completed execution state does not restart the workflow on done", () => {
      const policy = threeStagePolicy();
      // Completed state whose stage ids no longer match the current policy
      // (e.g. policy re-sent with regenerated ids after the chain finished).
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: ctoUserId,
          executionPolicy: policy,
          executionState: {
            status: "completed",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [
              "99999999-9999-4999-8999-999999999991",
              "99999999-9999-4999-8999-999999999992",
              "99999999-9999-4999-8999-999999999993",
            ],
            lastDecisionId: null,
            lastDecisionOutcome: "approved",
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { userId: ctoUserId },
        commentBody: "Closing out",
      });

      // No rewind to the first stage — the caller's done is allowed through.
      // SUP-14590: the stale ids from a prior policy revision are pruned even on
      // this no-op transition, so the persisted state stays scoped to the
      // current policy and the drop is surfaced for the audit log.
      expect(result.droppedStageIds).toEqual([
        "99999999-9999-4999-8999-999999999991",
        "99999999-9999-4999-8999-999999999992",
        "99999999-9999-4999-8999-999999999993",
      ]);
      expect(result.patch).toEqual({
        executionState: {
          status: "completed",
          currentStageId: null,
          currentStageIndex: null,
          currentStageType: null,
          currentParticipant: null,
          returnAssignee: { type: "agent", agentId: coderAgentId },
          completedStageIds: [],
          skippedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: "approved",
        },
      });
    });
  });

  describe("changes requested with no return assignee", () => {
    it("throws when requesting changes with no return assignee", () => {
      const policy = twoStagePolicy();
      const reviewStageId = policy.stages[0].id;
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: null,
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "in_progress",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: "Changes needed",
        }),
      ).toThrow("no return assignee");
    });
  });

  describe("approval stage changes requested → bounces back to executor", () => {
    it("approver requests changes during approval stage", () => {
      const policy = twoStagePolicy();
      const reviewStageId = policy.stages[0].id;
      const approvalStageId = policy.stages[1].id;
      const result = applyIssueExecutionPolicyTransition({
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
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [reviewStageId],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { userId: ctoUserId },
        commentBody: "Not happy with the approach, needs rework",
      });

      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.assigneeAgentId).toBe(coderAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "changes_requested",
        currentStageType: "approval",
        lastDecisionOutcome: "changes_requested",
      });
      expect(result.decision).toMatchObject({
        stageId: approvalStageId,
        stageType: "approval",
        outcome: "changes_requested",
      });
    });
  });

  describe("user participants", () => {
    it("handles user-type reviewer participant correctly", () => {
      const policy = makePolicy([
        { type: "review", participants: [{ type: "user", userId: boardUserId }] },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBeNull();
      expect(result.patch.assigneeUserId).toBe(boardUserId);
    });
  });

  describe("policy edits while a stage is active", () => {
    it("clears the active execution state when its stage is removed from the policy", () => {
      const reviewAndApproval = twoStagePolicy();
      const approvalOnly = approvalOnlyPolicy();

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: reviewAndApproval,
          executionState: {
            status: "pending",
            currentStageId: reviewAndApproval.stages[0].id,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy: approvalOnly,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch).toMatchObject({
        status: "in_progress",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        executionState: null,
      });
    });

    it("reassigns the active stage when the current participant is removed", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: ctoAgentId },
          ],
        },
      ]);
      const updatedPolicy = makePolicy([
        {
          type: "review",
          participants: [{ type: "agent", agentId: ctoAgentId }],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: policy.stages[0].id,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy: {
          ...updatedPolicy,
          stages: [{ ...updatedPolicy.stages[0], id: policy.stages[0].id }],
        },
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        assigneeAgentId: ctoAgentId,
        assigneeUserId: null,
        executionState: {
          status: "pending",
          currentStageId: policy.stages[0].id,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: ctoAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
        },
      });
    });
  });

  describe("monitor policy", () => {
    it("schedules a one-shot monitor on an active agent-owned issue", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      })!;

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: null,
          monitorAttemptCount: 0,
          monitorNextCheckAt: null,
          monitorLastTriggeredAt: null,
          monitorNotes: null,
          monitorScheduledBy: null,
        },
        policy,
        previousPolicy: null,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
        monitorExplicitlyUpdated: true,
      });

      expect(result.patch.monitorNextCheckAt).toEqual(new Date("2026-04-11T12:30:00.000Z"));
      expect(result.patch.monitorScheduledBy).toBe("board");
      expect(result.patch.executionState).toMatchObject({
        status: "idle",
        monitor: {
          status: "scheduled",
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      });
    });

    it("auto-clears a scheduled monitor when the issue moves to done", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "assignee",
        },
      })!;

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "idle",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: null,
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
            monitor: {
              status: "scheduled",
              nextCheckAt: "2026-04-11T12:30:00.000Z",
              lastTriggeredAt: null,
              attemptCount: 0,
              notes: "Check deployment",
              scheduledBy: "assignee",
              clearedAt: null,
              clearReason: null,
            },
          },
          monitorAttemptCount: 0,
          monitorNextCheckAt: new Date("2026-04-11T12:30:00.000Z"),
          monitorLastTriggeredAt: null,
          monitorNotes: "Check deployment",
          monitorScheduledBy: "assignee",
        },
        policy,
        previousPolicy: policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch.executionPolicy).toEqual({
        mode: "normal",
        commentRequired: true,
        stages: [],
      });
      expect(result.patch.monitorNextCheckAt).toBeNull();
      expect(result.patch.executionState).toMatchObject({
        monitor: {
          status: "cleared",
          clearReason: "done",
        },
      });
    });

    it("auto-clears a scheduled monitor when the issue moves to cancelled", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "assignee",
        },
      })!;

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "idle",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: null,
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
            monitor: {
              status: "scheduled",
              nextCheckAt: "2026-04-11T12:30:00.000Z",
              lastTriggeredAt: null,
              attemptCount: 0,
              notes: "Check deployment",
              scheduledBy: "assignee",
              clearedAt: null,
              clearReason: null,
            },
          },
          monitorAttemptCount: 0,
          monitorNextCheckAt: new Date("2026-04-11T12:30:00.000Z"),
          monitorLastTriggeredAt: null,
          monitorNotes: "Check deployment",
          monitorScheduledBy: "assignee",
        },
        policy,
        previousPolicy: policy,
        requestedStatus: "cancelled",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch.executionPolicy).toEqual({
        mode: "normal",
        commentRequired: true,
        stages: [],
      });
      expect(result.patch.monitorNextCheckAt).toBeNull();
      expect(result.patch.executionState).toMatchObject({
        monitor: {
          status: "cleared",
          clearReason: "cancelled",
        },
      });
    });

    it("schedules a monitor on a blocked agent-owned issue", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      })!;

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "blocked",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: null,
        },
        policy,
        previousPolicy: null,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
        monitorExplicitlyUpdated: true,
      });

      expect(result.patch.monitorNextCheckAt).toEqual(new Date("2026-04-11T12:30:00.000Z"));
      expect(result.patch.monitorScheduledBy).toBe("board");
      expect(result.patch.executionState).toMatchObject({
        status: "idle",
        monitor: {
          status: "scheduled",
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      });
    });

    it("rejects explicitly scheduling a monitor on an invalid issue state", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
        },
      })!;

      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "todo",
            assigneeAgentId: coderAgentId,
            assigneeUserId: null,
            executionPolicy: null,
            executionState: null,
          },
          policy,
          previousPolicy: null,
          requestedAssigneePatch: {},
          actor: { agentId: coderAgentId },
          monitorExplicitlyUpdated: true,
        }),
      ).toThrow("Monitor can only be scheduled");
    });

    it("rejects scheduling a monitor on a backlog status regardless of monitorExplicitlyUpdated", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
        },
      })!;

      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "backlog",
            assigneeAgentId: coderAgentId,
            assigneeUserId: null,
            executionPolicy: null,
            executionState: null,
          },
          policy,
          previousPolicy: null,
          requestedAssigneePatch: {},
          actor: { agentId: coderAgentId },
          monitorExplicitlyUpdated: false,
        }),
      ).toThrow("Monitor can only be scheduled");
    });

    it("rejects scheduling a monitor on a todo status regardless of monitorExplicitlyUpdated", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
        },
      })!;

      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "todo",
            assigneeAgentId: coderAgentId,
            assigneeUserId: null,
            executionPolicy: null,
            executionState: null,
          },
          policy,
          previousPolicy: null,
          requestedAssigneePatch: {},
          actor: { agentId: coderAgentId },
          monitorExplicitlyUpdated: false,
        }),
      ).toThrow("Monitor can only be scheduled");
    });

    it("rejects a status transition that would silently clear an active monitor", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "assignee",
        },
      })!;

      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_progress",
            assigneeAgentId: coderAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "idle",
              currentStageId: null,
              currentStageIndex: null,
              currentStageType: null,
              currentParticipant: null,
              returnAssignee: null,
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
              monitor: {
                status: "scheduled",
                nextCheckAt: "2026-04-11T12:30:00.000Z",
                lastTriggeredAt: null,
                attemptCount: 0,
                notes: "Check deployment",
                scheduledBy: "assignee",
                clearedAt: null,
                clearReason: null,
              },
            },
            monitorAttemptCount: 0,
            monitorNextCheckAt: new Date("2026-04-11T12:30:00.000Z"),
            monitorLastTriggeredAt: null,
            monitorNotes: "Check deployment",
            monitorScheduledBy: "assignee",
          },
          policy,
          previousPolicy: policy,
          requestedStatus: "todo",
          requestedAssigneePatch: {},
          actor: { agentId: coderAgentId },
        }),
      ).toThrow("Monitor can only be scheduled");
    });

    it("preserves a scheduled monitor when the issue moves to blocked", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "assignee",
        },
      })!;

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "idle",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: null,
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
            monitor: {
              status: "scheduled",
              nextCheckAt: "2026-04-11T12:30:00.000Z",
              lastTriggeredAt: null,
              attemptCount: 0,
              notes: "Check deployment",
              scheduledBy: "assignee",
              clearedAt: null,
              clearReason: null,
            },
          },
          monitorAttemptCount: 0,
          monitorNextCheckAt: new Date("2026-04-11T12:30:00.000Z"),
          monitorLastTriggeredAt: null,
          monitorNotes: "Check deployment",
          monitorScheduledBy: "assignee",
        },
        policy,
        previousPolicy: policy,
        requestedStatus: "blocked",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch.monitorNextCheckAt).toEqual(new Date("2026-04-11T12:30:00.000Z"));
      expect(result.patch.monitorWakeRequestedAt).toBeNull();
      expect(result.patch.executionPolicy).toBeUndefined();
      expect(result.patch.executionState).toBeUndefined();
    });

    it("does not collapse executionPolicy to null when stripping a monitor-only policy", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2099-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "assignee",
        },
      })!;

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "idle",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: null,
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
            monitor: {
              status: "scheduled",
              nextCheckAt: "2099-04-11T12:30:00.000Z",
              lastTriggeredAt: null,
              attemptCount: 0,
              notes: "Check deployment",
              scheduledBy: "assignee",
              clearedAt: null,
              clearReason: null,
            },
          },
          monitorAttemptCount: 0,
          monitorNextCheckAt: new Date("2099-04-11T12:30:00.000Z"),
          monitorLastTriggeredAt: null,
          monitorNotes: "Check deployment",
          monitorScheduledBy: "assignee",
        },
        policy: null,
        previousPolicy: policy,
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        monitorExplicitlyUpdated: true,
      });

      expect(result.patch.executionPolicy).toEqual({
        mode: "normal",
        commentRequired: true,
        stages: [],
      });
    });

    it("rejects explicitly re-arming a monitor after max attempts are exhausted", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2099-04-11T12:30:00.000Z",
          maxAttempts: 1,
          scheduledBy: "assignee",
        },
      })!;

      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: coderAgentId,
            assigneeUserId: null,
            executionPolicy: null,
            executionState: null,
            monitorAttemptCount: 1,
            monitorNextCheckAt: null,
            monitorLastTriggeredAt: null,
            monitorNotes: null,
            monitorScheduledBy: "assignee",
          },
          policy,
          previousPolicy: null,
          requestedAssigneePatch: {},
          actor: { agentId: coderAgentId },
          monitorExplicitlyUpdated: true,
        }),
      ).toThrow("Monitor bounds are already exhausted");
    });

    describe("stripMonitorFromExecutionPolicy (SUP-14374)", () => {
      const fullPolicy = () =>
        normalizeIssueExecutionPolicy({
          stages: [],
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "assignee",
          },
          returnAssigneeAgentId: ctoAgentId,
          reviewPreset: {
            id: "low_trust_review",
            version: 1,
            rawOutputDisposition: "quarantine",
          },
          authorizationPolicy: {
            trustBoundary: {
              mode: "low_trust_review",
              allowedAgentIds: [qaAgentId],
            },
          },
          maxReviewRounds: 3,
        })!;

      it("removes only the monitor key, preserving every other policy field", () => {
        const policy = fullPolicy();
        const stripped = stripMonitorFromExecutionPolicy(policy)!;
        expect(stripped.monitor).toBeUndefined();
        expect(stripped.returnAssigneeAgentId).toBe(ctoAgentId);
        expect(stripped.reviewPreset).toEqual({
          id: "low_trust_review",
          version: 1,
          rawOutputDisposition: "quarantine",
        });
        expect(stripped.authorizationPolicy).toEqual({
          trustBoundary: {
            mode: "low_trust_review",
            allowedAgentIds: [qaAgentId],
          },
        });
        expect(stripped.maxReviewRounds).toBe(3);
        expect(stripped.mode).toBe("normal");
        expect(stripped.commentRequired).toBe(true);
        expect(stripped.stages).toEqual([]);
      });

      it("passes null through as null and returns policies without a monitor unchanged", () => {
        expect(stripMonitorFromExecutionPolicy(null)).toBeNull();
        const noMonitor = normalizeIssueExecutionPolicy({
          stages: [],
          returnAssigneeAgentId: ctoAgentId,
        })!;
        expect(stripMonitorFromExecutionPolicy(noMonitor)).toBe(noMonitor);
      });
    });

    it("monitor fire preserves executionPolicy fields (buildIssueMonitorTriggeredPatch, SUP-14374)", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          scheduledBy: "assignee",
        },
        returnAssigneeAgentId: ctoAgentId,
        reviewPreset: {
          id: "low_trust_review",
          version: 1,
          rawOutputDisposition: "quarantine",
        },
        authorizationPolicy: {
          trustBoundary: {
            mode: "low_trust_review",
            allowedAgentIds: [qaAgentId],
          },
        },
        maxReviewRounds: 2,
      })!;

      const patch = buildIssueMonitorTriggeredPatch({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
          monitorAttemptCount: 0,
          monitorNextCheckAt: new Date("2026-04-11T12:30:00.000Z"),
          monitorLastTriggeredAt: null,
          monitorNotes: null,
          monitorScheduledBy: "assignee",
        },
        policy,
        triggeredAt: new Date("2026-04-11T12:35:00.000Z"),
      });

      expect(patch.monitorLastTriggeredAt).toEqual(new Date("2026-04-11T12:35:00.000Z"));
      expect(patch.monitorAttemptCount).toBe(1);
      const firedPolicy = patch.executionPolicy as Record<string, unknown>;
      expect(firedPolicy.monitor).toBeUndefined();
      expect(firedPolicy.returnAssigneeAgentId).toBe(ctoAgentId);
      expect(firedPolicy.reviewPreset).toEqual({
        id: "low_trust_review",
        version: 1,
        rawOutputDisposition: "quarantine",
      });
      expect(firedPolicy.authorizationPolicy).toEqual({
        trustBoundary: {
          mode: "low_trust_review",
          allowedAgentIds: [qaAgentId],
        },
      });
      expect(firedPolicy.maxReviewRounds).toBe(2);
    });
  });

  describe("returnAssigneeAgentId routing", () => {
    const returnAgentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    function policyWithReturnAssignee(returnAssigneeAgentId: string) {
      return normalizeIssueExecutionPolicy({
        returnAssigneeAgentId,
        stages: [{ type: "review", participants: [{ type: "agent", agentId: qaAgentId }] }],
      })!;
    }

    it("bounces to configured returnAssigneeAgentId on changes_requested", () => {
      const policy = policyWithReturnAssignee(returnAgentId);
      const reviewStageId = policy.stages[0].id;

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "Needs fixes",
      });

      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.assigneeAgentId).toBe(returnAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "changes_requested",
        returnAssignee: { type: "agent", agentId: returnAgentId },
        lastDecisionOutcome: "changes_requested",
      });
    });

    it("falls back to legacy returnAssignee when returnAssigneeAgentId is not set", () => {
      const policy = reviewOnlyPolicy();
      const reviewStageId = policy.stages[0].id;

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "Needs fixes",
      });

      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.assigneeAgentId).toBe(coderAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "changes_requested",
        returnAssignee: { type: "agent", agentId: coderAgentId },
        lastDecisionOutcome: "changes_requested",
      });
    });
  });

  describe("a stage gated solely by its own return assignee fails loud", () => {
    it("refuses to make the approval stage pending when its sole participant is the return assignee", () => {
      const policy = makePolicy([
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
        { type: "approval", participants: [{ type: "agent", agentId: coderAgentId }] },
      ]);
      const reviewStageId = policy.stages[0].id;

      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_progress",
            assigneeAgentId: coderAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: "QA signoff complete",
        }),
      ).toThrow(/No eligible approval participant is configured/);
    });
  });
});

describe("return-assignee exclusion is absolute (reverses SUP-10602 allowSelfAsFallback)", () => {
    it("workflow-start path: the workflow starts, then refuses the self-gated approval stage", () => {
      const policy = makePolicy([
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
        { type: "approval", participants: [{ type: "agent", agentId: coderAgentId }] },
      ]);
      const reviewStageId = policy.stages[0].id;
      const approvalStageId = policy.stages[1].id;

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBe(qaAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageId: reviewStageId,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
        returnAssignee: { type: "agent", agentId: coderAgentId },
        completedStageIds: [],
      });

      // QA's approval clears the review stage, and the runtime then has to pick
      // a participant for the approval stage. Its only participant is the
      // return assignee, so there is nobody eligible. SUP-10602 made this fall
      // back to the coder and let it approve its own issue; it must fail loud.
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: result.patch.executionState,
          },
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: "QA signoff complete",
        }),
      ).toThrow(/No eligible approval participant is configured/);
      expect(approvalStageId).toBeTruthy();
    });

    // NOTE: a pending state that already names the return assignee as the stage
    // participant is now unreachable — selectStageParticipant can never emit
    // one. The decision path still honours a hand-built state, so the guard
    // lives at the point the state is CREATED, plus
    // assertIssueExecutionPolicyGatesAreEnforceable() at the write path so the
    // policy cannot be stored in the first place.
    it("active-stage path: the self-gated approval stage is never made pending", () => {
      const policy = makePolicy([
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
        { type: "approval", participants: [{ type: "agent", agentId: coderAgentId }] },
      ]);
      const reviewStageId = policy.stages[0].id;
      const approvalStageId = policy.stages[1].id;

      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: null,
            assigneeUserId: ctoUserId,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: "QA signoff complete",
        }),
      ).toThrow(/No eligible approval participant is configured/);
      expect(approvalStageId).toBeTruthy();
    });

    it("self-review protection is preserved when an alternative participant exists", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: coderAgentId },
            { type: "agent", agentId: qaAgentId },
          ],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch.assigneeAgentId).toBe(qaAgentId);
    });

    it("auto-skip of self-review-only stage is preserved", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [{ type: "agent", agentId: coderAgentId }],
        },
        {
          type: "approval",
          participants: [{ type: "user", userId: ctoUserId }],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: ctoUserId,
        executionState: {
          status: "pending",
          currentStageType: "approval",
          currentParticipant: { type: "user", userId: ctoUserId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
          completedStageIds: [policy.stages[0].id],
        },
      });
    });

    it("throw message names the stage type and id and mentions return-assignee exclusion", () => {
      // A genuinely zero-participant stage throws for the same reason a
      // self-gated one does: nobody eligible. normalizeIssueExecutionPolicy
      // strips such a stage, so the policy object is hand-built here to
      // exercise the active-stage throw site directly.
      const zeroParticipantStage = {
        id: "00000000-0000-4000-8000-000000000001",
        type: "review" as const,
        approvalsNeeded: 1 as const,
        participants: [],
      };
      const policy = {
        mode: "normal" as const,
        commentRequired: true,
        stages: [zeroParticipantStage],
      };

      const executionState = {
        status: "pending" as const,
        currentStageId: zeroParticipantStage.id,
        currentStageIndex: 0,
        currentStageType: "review" as const,
        currentParticipant: null,
        returnAssignee: { type: "agent" as const, agentId: coderAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null as null,
      };

      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_progress",
            assigneeAgentId: coderAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState,
          },
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: {},
          actor: { agentId: coderAgentId },
          commentBody: "Done",
        }),
      ).toThrow(expect.objectContaining({
        status: 422,
        message: expect.stringMatching(new RegExp(`review.*${zeroParticipantStage.id}.*return assignee`)),
      }));
    });
  });

describe("review round circuit breaker", () => {
  const policy = reviewOnlyPolicy();
  const reviewStageId = policy.stages[0].id;

  function reviewPendingIssue(overrides: Record<string, unknown> = {}, stateOverrides: Record<string, unknown> = {}) {
    return {
      status: "in_review",
      assigneeAgentId: qaAgentId,
      assigneeUserId: null,
      responsibleUserId: boardUserId,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: reviewStageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
        returnAssignee: { type: "agent", agentId: coderAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        ...stateOverrides,
      },
      ...overrides,
    };
  }

  it("counts agent-initiated changes-requested rounds on the hand-back", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: reviewPendingIssue(),
      policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: qaAgentId },
      commentBody: "Round one feedback",
    });

    expect(result.patch.status).toBe("in_progress");
    expect(result.patch.assigneeAgentId).toBe(coderAgentId);
    expect(result.patch.executionState).toMatchObject({
      status: "changes_requested",
      changesRequestedCount: 1,
    });
    // Below the cap: no escalation signal is emitted.
    expect(result.reviewEscalation).toBeUndefined();
  });

  it("carries the round count through the executor's resubmission", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        responsibleUserId: boardUserId,
        executionPolicy: policy,
        executionState: {
          status: "changes_requested",
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: "changes_requested",
          changesRequestedCount: 2,
        },
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      commentBody: "Addressed round two",
    });

    expect(result.patch.status).toBe("in_review");
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      changesRequestedCount: 2,
    });
  });

  it("escalates the pending stage to the responsible human at the round cap", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: reviewPendingIssue({}, { changesRequestedCount: 2 }),
      policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: qaAgentId },
      commentBody: "Round three feedback — still not converging",
    });

    // The decision is still recorded, but the stage stays pending with the
    // responsible human as participant instead of bouncing to the executor.
    expect(result.decision).toMatchObject({ outcome: "changes_requested" });
    expect(result.patch.status).toBe("in_review");
    expect(result.patch.assigneeAgentId).toBeNull();
    expect(result.patch.assigneeUserId).toBe(boardUserId);
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentStageId: reviewStageId,
      currentParticipant: { type: "user", userId: boardUserId },
      changesRequestedCount: 3,
    });
  });

  it("emits the reviewEscalation signal only on the round-cap escalation (SUP-14805)", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: reviewPendingIssue({}, { changesRequestedCount: 2 }),
      policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: qaAgentId },
      commentBody: "Round three feedback — still not converging",
    });

    expect(result.reviewEscalation).toMatchObject({
      escalatedToUserId: boardUserId,
      stageId: reviewStageId,
      stageType: "review",
      maxRounds: DEFAULT_MAX_REVIEW_ROUNDS,
      changesRequestedCount: 3,
      returnAssignee: { type: "agent", agentId: coderAgentId },
    });
  });

  it("honours a custom maxReviewRounds override in the escalation signal", () => {
    const strictPolicy = { ...policy, maxReviewRounds: 1 } as typeof policy;
    const result = applyIssueExecutionPolicyTransition({
      issue: reviewPendingIssue({ executionPolicy: strictPolicy }, { changesRequestedCount: 0 }),
      policy: strictPolicy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: qaAgentId },
      commentBody: "Still not converging",
    });

    expect(result.patch.assigneeUserId).toBe(boardUserId);
    expect(result.patch.assigneeAgentId).toBeNull();
    expect(result.reviewEscalation).toMatchObject({
      escalatedToUserId: boardUserId,
      maxRounds: 1,
      changesRequestedCount: 1,
    });
  });

  it("keeps the escalated hold sticky across unrelated transitions", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: reviewPendingIssue(
        { assigneeAgentId: null, assigneeUserId: boardUserId },
        {
          currentParticipant: { type: "user", userId: boardUserId },
          changesRequestedCount: 3,
        },
      ),
      policy,
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
    });

    expect(result.patch.executionState).toBeUndefined();
    expect(result.patch.assigneeAgentId).toBeUndefined();
  });

  it("rejects a non-escalated actor advancing the stage during the hold", () => {
    expect(() =>
      applyIssueExecutionPolicyTransition({
        issue: reviewPendingIssue(
          { assigneeAgentId: null, assigneeUserId: boardUserId },
          {
            currentParticipant: { type: "user", userId: boardUserId },
            changesRequestedCount: 3,
          },
        ),
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "Agent trying to close it anyway",
      }),
    ).toThrow("Only the escalated reviewer can advance the current execution stage");
  });

  it("rejects a non-escalated actor reassigning the issue during the hold", () => {
    expect(() =>
      applyIssueExecutionPolicyTransition({
        issue: reviewPendingIssue(
          { assigneeAgentId: null, assigneeUserId: boardUserId },
          {
            currentParticipant: { type: "user", userId: boardUserId },
            changesRequestedCount: 3,
          },
        ),
        policy,
        requestedAssigneePatch: { assigneeAgentId: coderAgentId },
        actor: { agentId: coderAgentId },
      }),
    ).toThrow("Only the escalated reviewer can advance the current execution stage");
  });

  it("re-asserts the hold when the assignee has drifted away from the escalated human", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: reviewPendingIssue(
        // Assignee drifted back to the agent reviewer while the state still
        // records the escalated human as participant.
        { assigneeAgentId: qaAgentId, assigneeUserId: null },
        {
          currentParticipant: { type: "user", userId: boardUserId },
          changesRequestedCount: 3,
        },
      ),
      policy,
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
    });

    expect(result.patch.status).toBe("in_review");
    expect(result.patch.assigneeAgentId).toBeNull();
    expect(result.patch.assigneeUserId).toBe(boardUserId);
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentParticipant: { type: "user", userId: boardUserId },
      changesRequestedCount: 3,
    });
    // Drift re-assertion of an existing hold is idempotent: it must NOT emit a
    // fresh escalation signal, otherwise every drift PATCH would mint a card.
    expect(result.reviewEscalation).toBeUndefined();
  });

  it("resets the counter when the escalated human requests changes", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: reviewPendingIssue(
        { assigneeAgentId: null, assigneeUserId: boardUserId },
        {
          currentParticipant: { type: "user", userId: boardUserId },
          changesRequestedCount: 3,
        },
      ),
      policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { userId: boardUserId },
      commentBody: "Human direction: do X instead",
    });

    expect(result.patch.status).toBe("in_progress");
    expect(result.patch.assigneeAgentId).toBe(coderAgentId);
    expect(result.patch.executionState).toMatchObject({
      status: "changes_requested",
      changesRequestedCount: 0,
    });
    // A human resetting the round is not an escalation: no signal.
    expect(result.reviewEscalation).toBeUndefined();
  });

  it("lets the escalated human approve the stage", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: reviewPendingIssue(
        { assigneeAgentId: null, assigneeUserId: boardUserId },
        {
          currentParticipant: { type: "user", userId: boardUserId },
          changesRequestedCount: 3,
        },
      ),
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { userId: boardUserId },
      commentBody: "Good enough — shipping",
    });

    expect(result.decision).toMatchObject({ outcome: "approved" });
    expect(result.patch.executionState).toMatchObject({
      status: "completed",
      changesRequestedCount: 0,
    });
  });

  it("keeps handing back to the executor when no responsible human exists", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: reviewPendingIssue({ responsibleUserId: null }, { changesRequestedCount: 9 }),
      policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: qaAgentId },
      commentBody: "Round ten feedback",
    });

    expect(result.patch.status).toBe("in_progress");
    expect(result.patch.assigneeAgentId).toBe(coderAgentId);
    expect(result.patch.executionState).toMatchObject({
      status: "changes_requested",
      changesRequestedCount: 10,
    });
  });

  it("honors a policy maxReviewRounds override", () => {
    const strictPolicy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: qaAgentId }] }],
      maxReviewRounds: 1,
    })!;
    const stageId = strictPolicy.stages[0].id;

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        responsibleUserId: boardUserId,
        executionPolicy: strictPolicy,
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
      policy: strictPolicy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: qaAgentId },
      commentBody: "First and only agent round",
    });

    expect(result.patch.assigneeUserId).toBe(boardUserId);
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentParticipant: { type: "user", userId: boardUserId },
      changesRequestedCount: 1,
    });
  });
});

describe("delivery author record (SUP-13899)", () => {
  it("records the delivering author distinctly from the review participant on a hand-PATCH delivery", () => {
    const policy = reviewOnlyPolicy();
    // External-lane shape: the delivery author (coder) is still the issue
    // assignee when the hand PATCH moves the issue to in_review; no explicit
    // assignee write accompanies it.
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: null,
      },
      policy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      commentBody: null,
    });

    // The recorded shape a gate reads back: the issue assignee is the review
    // participant, but the delivery author is recorded separately, so
    // participant == assignee no longer reads as a self-approved stage.
    expect(result.patch.status).toBe("in_review");
    expect(result.patch.assigneeAgentId).toBe(qaAgentId);
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentParticipant: { type: "agent", agentId: qaAgentId },
      returnAssignee: { type: "agent", agentId: coderAgentId },
      deliveryAuthor: { type: "agent", agentId: coderAgentId },
    });
  });

  it("still fails loud when the only review participant is the delivering author", () => {
    const selfGatedPolicy = makePolicy([
      { type: "review", participants: [{ type: "agent", agentId: coderAgentId }] },
    ]);
    expect(() =>
      applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: selfGatedPolicy,
          executionState: null,
        },
        policy: selfGatedPolicy,
        requestedStatus: "in_review",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: null,
      }),
    ).toThrow(/No eligible review participant/);
  });

  it("carries deliveryAuthor forward through the review decision into the completed state", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    const delivered = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: null,
      },
      policy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      commentBody: null,
    });

    const reviewed = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: delivered.patch.executionState as IssueExecutionState,
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: qaAgentId },
      commentBody: "QA signoff complete",
    });
    expect(reviewed.patch.executionState).toMatchObject({
      status: "pending",
      currentStageType: "approval",
      completedStageIds: [reviewStageId],
      deliveryAuthor: { type: "agent", agentId: coderAgentId },
    });

    const completed = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: ctoUserId,
        executionPolicy: policy,
        executionState: reviewed.patch.executionState as IssueExecutionState,
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { userId: ctoUserId },
      commentBody: "Ship it",
    });

    expect(completed.patch.executionState).toMatchObject({
      status: "completed",
      deliveryAuthor: { type: "agent", agentId: coderAgentId },
    });
  });

  it("updates deliveryAuthor on re-delivery after changes_requested", () => {
    const policy = reviewOnlyPolicy();
    const reviewStageId = policy.stages[0].id;

    const bounced = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
          deliveryAuthor: { type: "agent", agentId: coderAgentId },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
      policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: qaAgentId },
      commentBody: "Round one feedback",
    });
    expect(bounced.patch.executionState).toMatchObject({
      status: "changes_requested",
      deliveryAuthor: { type: "agent", agentId: coderAgentId },
    });

    const reDelivered = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: bounced.patch.executionState as IssueExecutionState,
      },
      policy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      commentBody: null,
    });
    expect(reDelivered.patch.executionState).toMatchObject({
      status: "pending",
      deliveryAuthor: { type: "agent", agentId: coderAgentId },
    });
  });

  it("records the assignee of record at re-delivery when the issue was handed off mid-bounce", () => {
    const policy = reviewOnlyPolicy();
    const reviewStageId = policy.stages[0].id;

    const bounced = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
          deliveryAuthor: { type: "agent", agentId: coderAgentId },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
      policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: qaAgentId },
      commentBody: "Round one feedback",
    });

    // A plain handoff (no stage transition) leaves the recorded state — and
    // its delivery author — untouched.
    const handoff = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: bounced.patch.executionState as IssueExecutionState,
      },
      policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: { assigneeAgentId: ctoAgentId },
      actor: { userId: boardUserId },
      commentBody: null,
    });
    expect(handoff.patch.executionState).toBeUndefined();

    const reDelivered = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: ctoAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: bounced.patch.executionState as IssueExecutionState,
      },
      policy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { agentId: ctoAgentId },
      commentBody: null,
    });
    // The handoff agent is now the delivery author while the return assignee
    // still points at the original author — the two are recorded distinctly.
    expect(reDelivered.patch.executionState).toMatchObject({
      status: "pending",
      deliveryAuthor: { type: "agent", agentId: ctoAgentId },
      returnAssignee: { type: "agent", agentId: coderAgentId },
    });
  });
});
