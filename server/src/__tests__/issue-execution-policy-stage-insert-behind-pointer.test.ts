import { describe, expect, it } from "vitest";
import {
  assertNoStageInsertedBehindPointer,
  assertPatchableExecutionPolicyWrite,
  normalizeIssueExecutionPolicy,
  rearmExecutionPolicyPointer,
  resolvePatchExecutionPolicy,
} from "../services/issue-execution-policy.ts";
import { HttpError } from "../errors.js";
import type { IssueExecutionPolicy, IssueExecutionState } from "@paperclipai/shared";

const coderAgentId = "11111111-1111-4111-8111-111111111111";
const leAgentId = "44444444-4444-4444-8444-444444444444";
const ctoUserId = "cto-user";

// Fixed stage ids for deterministic positioning.
const stage1Id = "aaaaaaaa-0000-4000-8000-000000000001";
const stage2Id = "aaaaaaaa-0000-4000-8000-000000000002";
const stage3Id = "aaaaaaaa-0000-4000-8000-000000000003";
const newStageId = "bbbbbbbb-0000-4000-8000-000000000004";

function makePolicyWithIds(
  stages: Array<{ id: string; type: "review" | "approval"; participants: Array<{ type: "agent" | "user"; agentId?: string; userId?: string }> }>,
): IssueExecutionPolicy {
  return normalizeIssueExecutionPolicy({ stages })!;
}

/** Three-stage policy: review(coder) → review(LE) → approval(CTO). */
function threeStagePolicy() {
  return makePolicyWithIds([
    { id: stage1Id, type: "review", participants: [{ type: "agent", agentId: coderAgentId }] },
    { id: stage2Id, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
    { id: stage3Id, type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
  ]);
}

/** Execution state: stage1 completed, pointer on stage2. */
function activeState(): IssueExecutionState {
  return {
    status: "in_progress",
    currentStageId: stage2Id,
    currentStageIndex: 1,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: leAgentId, userId: null },
    returnAssignee: { type: "agent", agentId: coderAgentId, userId: null },
    reviewRequest: null,
    completedStageIds: [stage1Id],
    skippedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
  } as unknown as IssueExecutionState;
}

describe("INV-LADDER-1: assertNoStageInsertedBehindPointer (SUP-16525)", () => {
  it("rejects a new unresolved stage inserted before the live pointer (C2)", () => {
    const state = activeState();
    // Insert newStage between stage1 (completed) and stage2 (current).
    const malicious = makePolicyWithIds([
      { id: stage1Id, type: "review", participants: [{ type: "agent", agentId: coderAgentId }] },
      { id: newStageId, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
      { id: stage2Id, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
      { id: stage3Id, type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
    ]);

    expect(() =>
      assertNoStageInsertedBehindPointer({ policy: malicious, executionState: state }),
    ).toThrowError(HttpError);

    try {
      assertNoStageInsertedBehindPointer({ policy: malicious, executionState: state });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const httpErr = err as HttpError;
      expect(httpErr.status).toBe(422);
      expect(httpErr.details).toMatchObject({
        code: "execution_policy_stage_inserted_behind_pointer",
        offendingStageId: newStageId,
        currentStageId: stage2Id,
      });
    }
  });

  it("rejects a completed stage moved to or after the pointer (C1)", () => {
    const state = activeState();
    // Move stage1 (completed) to a position after stage2 (current).
    const reordered = makePolicyWithIds([
      { id: stage2Id, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
      { id: stage1Id, type: "review", participants: [{ type: "agent", agentId: coderAgentId }] },
      { id: stage3Id, type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
    ]);

    expect(() =>
      assertNoStageInsertedBehindPointer({ policy: reordered, executionState: state }),
    ).toThrowError("completed or skipped stage at or after the current stage pointer");
  });

  it("allows the policy unchanged (all completed stages before pointer)", () => {
    const state = activeState();
    const same = threeStagePolicy();
    expect(() =>
      assertNoStageInsertedBehindPointer({ policy: same, executionState: state }),
    ).not.toThrow();
  });

  it("allows appending a new stage after the pointer", () => {
    const state = activeState();
    // Add a new stage at the end (after stage3).
    const appended = makePolicyWithIds([
      { id: stage1Id, type: "review", participants: [{ type: "agent", agentId: coderAgentId }] },
      { id: stage2Id, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
      { id: stage3Id, type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
      { id: newStageId, type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
    ]);
    expect(() =>
      assertNoStageInsertedBehindPointer({ policy: appended, executionState: state }),
    ).not.toThrow();
  });

  it("allows removing a completed stage from the prefix", () => {
    const state = activeState();
    // Remove stage1 (completed) from the policy.
    const removed = makePolicyWithIds([
      { id: stage2Id, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
      { id: stage3Id, type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
    ]);
    expect(() =>
      assertNoStageInsertedBehindPointer({ policy: removed, executionState: state }),
    ).not.toThrow();
  });

  it("is vacuous when currentStageId is null", () => {
    const state = { ...activeState(), currentStageId: null, currentStageIndex: null } as unknown as IssueExecutionState;
    // Insert a stage that would violate C2 if the pointer were active.
    const malicious = makePolicyWithIds([
      { id: newStageId, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
      { id: stage2Id, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
    ]);
    expect(() =>
      assertNoStageInsertedBehindPointer({ policy: malicious, executionState: state }),
    ).not.toThrow();
  });

  it("is vacuous when executionState is null", () => {
    const malicious = makePolicyWithIds([
      { id: newStageId, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
    ]);
    expect(() =>
      assertNoStageInsertedBehindPointer({ policy: malicious, executionState: null }),
    ).not.toThrow();
  });

  it("rejects removal of the current stage (dangling pointer, §5)", () => {
    const state = activeState();
    // Remove stage2 (the current stage) from the policy.
    const dangling = makePolicyWithIds([
      { id: stage1Id, type: "review", participants: [{ type: "agent", agentId: coderAgentId }] },
      { id: stage3Id, type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
    ]);
    expect(() =>
      assertNoStageInsertedBehindPointer({ policy: dangling, executionState: state }),
    ).toThrowError("current stage");

    try {
      assertNoStageInsertedBehindPointer({ policy: dangling, executionState: state });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as HttpError).status).toBe(422);
      expect((err as HttpError).details).toMatchObject({
        code: "execution_policy_current_stage_removed",
        currentStageId: stage2Id,
      });
    }
  });
});

describe("INV-LADDER-1: assertPatchableExecutionPolicyWrite with executionState (SUP-16525)", () => {
  it("rejects a stage insert behind the pointer via the full assert path", () => {
    const state = activeState();
    const stored = threeStagePolicy();

    // Client sends a 4-stage policy with newStage inserted before the pointer.
    const raw = {
      mode: "normal",
      commentRequired: true,
      stages: [
        { id: stage1Id, type: "review", participants: [{ type: "agent", agentId: coderAgentId }] },
        { id: newStageId, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
        { id: stage2Id, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
        { id: stage3Id, type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
      ],
    };

    expect(() =>
      assertPatchableExecutionPolicyWrite({
        raw,
        currentPolicy: stored,
        stagesExplicitlyEmpty: false,
        stagesKeyAbsent: false,
        executionState: state,
      }),
    ).toThrowError(HttpError);
  });

  it("allows the same insert when stagesKeyAbsent is true (preserve-on-omit skips check)", () => {
    const state = activeState();
    const stored = threeStagePolicy();

    // Omitting stages means the stored stages are preserved — no insertion possible.
    const raw = { mode: "normal", commentRequired: true };

    expect(() =>
      assertPatchableExecutionPolicyWrite({
        raw,
        currentPolicy: stored,
        stagesExplicitlyEmpty: false,
        stagesKeyAbsent: true,
        executionState: state,
      }),
    ).not.toThrow();
  });

  it("allows appending a stage after the pointer via the full assert path", () => {
    const state = activeState();
    const stored = threeStagePolicy();

    const raw = {
      mode: "normal",
      commentRequired: true,
      stages: [
        { id: stage1Id, type: "review", participants: [{ type: "agent", agentId: coderAgentId }] },
        { id: stage2Id, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
        { id: stage3Id, type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
        { id: newStageId, type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
      ],
    };

    expect(() =>
      assertPatchableExecutionPolicyWrite({
        raw,
        currentPolicy: stored,
        stagesExplicitlyEmpty: false,
        stagesKeyAbsent: false,
        executionState: state,
      }),
    ).not.toThrow();
  });

  it("allows the check when executionState is not provided (backward compat)", () => {
    const stored = threeStagePolicy();
    const raw = {
      mode: "normal",
      commentRequired: true,
      stages: [
        { id: stage1Id, type: "review", participants: [{ type: "agent", agentId: coderAgentId }] },
        { id: newStageId, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
        { id: stage2Id, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
        { id: stage3Id, type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
      ],
    };

    // No executionState → invariant is not checked (pre-SUP-16525 behavior).
    expect(() =>
      assertPatchableExecutionPolicyWrite({
        raw,
        currentPolicy: stored,
        stagesExplicitlyEmpty: false,
        stagesKeyAbsent: false,
      }),
    ).not.toThrow();
  });
});

describe("rearmExecutionPolicyPointer (SUP-16525 §4)", () => {
  it("rewinds to the first incomplete stage", () => {
    const state = activeState();
    const policy = threeStagePolicy();
    // stage1 is completed, so re-arm should point to stage2.
    const result = rearmExecutionPolicyPointer({ policy, executionState: state });
    expect(result).toEqual({ currentStageId: stage2Id, currentStageIndex: 1 });
  });

  it("rewinds further when more stages are completed", () => {
    const state = {
      ...activeState(),
      completedStageIds: [stage1Id, stage2Id],
      currentStageId: stage3Id,
      currentStageIndex: 2,
    } as unknown as IssueExecutionState;
    const policy = threeStagePolicy();
    const result = rearmExecutionPolicyPointer({ policy, executionState: state });
    expect(result).toEqual({ currentStageId: stage3Id, currentStageIndex: 2 });
  });

  it("returns null when all stages are completed", () => {
    const state = {
      ...activeState(),
      completedStageIds: [stage1Id, stage2Id, stage3Id],
      currentStageId: null,
      currentStageIndex: null,
    } as unknown as IssueExecutionState;
    const policy = threeStagePolicy();
    const result = rearmExecutionPolicyPointer({ policy, executionState: state });
    expect(result).toBeNull();
  });

  it("does not add skipped-over stages to completedStageIds", () => {
    const state = activeState();
    const policy = threeStagePolicy();
    const result = rearmExecutionPolicyPointer({ policy, executionState: state });
    // The function only returns pointer values; it never mutates state.
    expect(state.completedStageIds).toEqual([stage1Id]);
    expect(state.skippedStageIds).toEqual([]);
    expect(result?.currentStageId).toBe(stage2Id);
  });
});

describe("resolvePatchExecutionPolicy with executionState (SUP-16525 API symmetry)", () => {
  it("accepts executionState and returns the same stage structure as without it", () => {
    const stored = threeStagePolicy();
    const state = activeState();
    const raw = {
      mode: "normal",
      commentRequired: true,
      stages: [
        { id: stage1Id, type: "review", participants: [{ type: "agent", agentId: coderAgentId }] },
        { id: stage2Id, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
        { id: stage3Id, type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
      ],
    };

    const withState = resolvePatchExecutionPolicy({
      raw,
      currentPolicy: stored,
      stagesKeyAbsent: false,
      executionState: state,
    });
    const withoutState = resolvePatchExecutionPolicy({
      raw,
      currentPolicy: stored,
      stagesKeyAbsent: false,
    });

    // Participant UUIDs are randomly generated on each normalize call; compare
    // stage structure (ids, types, participant counts) instead of full equality.
    expect(withState!.stages.map((s) => s.id)).toEqual(withoutState!.stages.map((s) => s.id));
    expect(withState!.stages.map((s) => s.type)).toEqual(withoutState!.stages.map((s) => s.type));
    expect(withState!.stages.map((s) => s.participants.length)).toEqual(
      withoutState!.stages.map((s) => s.participants.length),
    );
  });
});
