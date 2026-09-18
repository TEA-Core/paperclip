import { describe, expect, it } from "vitest";
import {
  applyExecutionPolicyReArm,
  applyIssueExecutionPolicyTransition,
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
    status: "pending",
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

  it("rejects removing a completed stage from the prefix (shifts the stored pointer)", () => {
    const state = activeState();
    // Remove stage1 (completed) from BEFORE the pointer. stage2 slides from
    // index 1 to index 0, so the stored currentStageIndex would no longer name
    // it — the duplicated pointer would be inconsistent. Neither C1 nor C2 sees
    // this (nothing is inserted before the pointer), so §5 must catch it.
    const removed = makePolicyWithIds([
      { id: stage2Id, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
      { id: stage3Id, type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
    ]);
    expect(() =>
      assertNoStageInsertedBehindPointer({ policy: removed, executionState: state }),
    ).toThrowError(HttpError);

    try {
      assertNoStageInsertedBehindPointer({ policy: removed, executionState: state });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as HttpError).status).toBe(422);
      expect((err as HttpError).details).toMatchObject({
        code: "execution_policy_stage_inserted_behind_pointer",
        offendingStageId: stage3Id,
        currentStageId: stage2Id,
        currentStageIndex: 1,
      });
    }
  });

  it("allows removing a stage after the pointer (stored index still names the current stage)", () => {
    const state = activeState();
    // Remove stage3 (after the pointer): stage2 stays at index 1.
    const removed = makePolicyWithIds([
      { id: stage1Id, type: "review", participants: [{ type: "agent", agentId: coderAgentId }] },
      { id: stage2Id, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
    ]);
    expect(() =>
      assertNoStageInsertedBehindPointer({ policy: removed, executionState: state }),
    ).not.toThrow();
  });

  it("rejects a write that shifts the current stage when currentStageIndex is stale", () => {
    // Stored state claims index 2 but the policy only has 2 stages — a stale /
    // duplicated pointer the pre-§5 check accepted.
    const state = {
      ...activeState(),
      currentStageId: stage2Id,
      currentStageIndex: 2,
    } as unknown as IssueExecutionState;
    expect(() =>
      assertNoStageInsertedBehindPointer({ policy: threeStagePolicy(), executionState: state }),
    ).toThrowError(HttpError);
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

  it("rejects a live pointer that is itself a completed stage (fail-closed §5)", () => {
    // The stored state points at stage1 while ALSO listing it completed. A
    // resolved stage cannot still be the stage the issue is waiting on; the old
    // C1 loop excluded currentStageId and silently accepted this.
    const state = {
      ...activeState(),
      currentStageId: stage1Id,
      currentStageIndex: 0,
      completedStageIds: [stage1Id],
    } as unknown as IssueExecutionState;
    expect(() =>
      assertNoStageInsertedBehindPointer({ policy: threeStagePolicy(), executionState: state }),
    ).toThrowError(HttpError);
    try {
      assertNoStageInsertedBehindPointer({ policy: threeStagePolicy(), executionState: state });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as HttpError).status).toBe(422);
      expect((err as HttpError).details).toMatchObject({
        code: "execution_policy_stage_inserted_behind_pointer",
        offendingStageId: stage1Id,
        currentStageId: stage1Id,
      });
    }
  });

  it("rejects a live pointer whose stored currentStageIndex is null (fail-closed §5)", () => {
    // currentStageId is non-null but the duplicated numeric half is missing, so
    // the pointer cannot be verified. Accepting it would let a later write trust
    // a numeric index that does not exist.
    const state = {
      ...activeState(),
      currentStageIndex: null,
    } as unknown as IssueExecutionState;
    expect(() =>
      assertNoStageInsertedBehindPointer({ policy: threeStagePolicy(), executionState: state }),
    ).toThrowError(HttpError);
    try {
      assertNoStageInsertedBehindPointer({ policy: threeStagePolicy(), executionState: state });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as HttpError).status).toBe(422);
      expect((err as HttpError).details).toMatchObject({
        code: "execution_policy_stage_inserted_behind_pointer",
        currentStageId: stage2Id,
        currentStageIndex: null,
      });
    }
  });

  it("rejects a live pointer whose stored currentStageIndex is absent (fail-closed §5)", () => {
    const state = {
      ...activeState(),
      currentStageIndex: undefined,
    } as unknown as IssueExecutionState;
    expect(() =>
      assertNoStageInsertedBehindPointer({ policy: threeStagePolicy(), executionState: state }),
    ).toThrowError(HttpError);
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

  it("rejects an insert behind the pointer at the resolver boundary (SUP-16525 finding 3)", () => {
    const stored = threeStagePolicy();
    const state = activeState();
    // newStage inserted before the live pointer — the assert rejects this; the
    // resolver must independently refuse to *produce* the same bad policy.
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
      resolvePatchExecutionPolicy({
        raw,
        currentPolicy: stored,
        stagesKeyAbsent: false,
        executionState: state,
      }),
    ).toThrowError(HttpError);
  });

  it("keeps the preserve-on-omit path a no-op even when armed", () => {
    const stored = threeStagePolicy();
    const state = activeState();
    const resolved = resolvePatchExecutionPolicy({
      raw: { mode: "normal", commentRequired: true },
      currentPolicy: stored,
      stagesKeyAbsent: true,
      executionState: state,
    });
    expect(resolved!.stages.map((s) => s.id)).toEqual([stage1Id, stage2Id, stage3Id]);
  });
});

/** Minimal issue shape for the re-arm / transition paths. */
function rearmIssue(executionState: IssueExecutionState) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "in_review",
    assigneeAgentId: coderAgentId,
    assigneeUserId: null,
    createdByUserId: ctoUserId,
    executionState: executionState as unknown as Record<string, unknown>,
  };
}

/**
 * The self-gated re-arm probe (SUP-16725): stage1 completed, a stale pointer on
 * the terminal approval, and the return assignee is `coderAgentId`. `rearm`
 * rewinds onto stage2, whose participant list is what the test varies.
 */
function selfGatedProbeState(): IssueExecutionState {
  return {
    ...activeState(),
    currentStageId: stage3Id,
    currentStageIndex: 2,
    currentStageType: "approval",
    currentParticipant: { type: "user", userId: ctoUserId, agentId: null },
    completedStageIds: [stage1Id],
  } as unknown as IssueExecutionState;
}

/** Three-stage policy whose re-arm target (stage2) carries `targetParticipants`. */
function selfGatedPolicy(
  targetParticipants: Array<{ type: "agent" | "user"; agentId?: string; userId?: string }>,
) {
  return makePolicyWithIds([
    { id: stage1Id, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
    { id: stage2Id, type: "review", participants: targetParticipants },
    { id: stage3Id, type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
  ]);
}

describe("applyExecutionPolicyReArm (SUP-16525 §4 persisted path)", () => {
  it("persists a re-armed pending state with a self-consistent pointer", () => {
    const state = activeState(); // stage1 completed, pointer on stage2
    const policy = threeStagePolicy();
    const result = applyExecutionPolicyReArm({
      issue: rearmIssue(state),
      policy,
      executionState: state,
    });

    expect(result.patch.status).toBe("in_review");
    const written = result.patch.executionState as IssueExecutionState;
    expect(written).toBeTruthy();
    // Both halves of the duplicated pointer agree with each other and with P'.
    expect(written.currentStageId).toBe(stage2Id);
    expect(written.currentStageIndex).toBe(1);
    expect(policy.stages[written.currentStageIndex!]!.id).toBe(written.currentStageId);
    // A re-arm is NOT a completion: the resolved sets are carried forward.
    expect(written.completedStageIds).toEqual([stage1Id]);
    expect(written.skippedStageIds).toEqual([]);
    // The re-armed stage lands in NEITHER list — the parent stays unclosable
    // until it earns a real decision row (ADR-073 D4).
    expect(written.completedStageIds).not.toContain(stage2Id);
    expect(written.skippedStageIds).not.toContain(stage2Id);
    expect(written.changesRequestedCount).toBe(0);
    expect(written.currentParticipant).toMatchObject({ type: "agent", agentId: leAgentId });
    expect(result.patch.assigneeAgentId).toBe(leAgentId);
  });

  it("re-arms onto a newly inserted stage ahead of the stale pointer", () => {
    const state = activeState();
    const policy = makePolicyWithIds([
      { id: stage1Id, type: "review", participants: [{ type: "agent", agentId: coderAgentId }] },
      { id: newStageId, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
      { id: stage2Id, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
      { id: stage3Id, type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
    ]);
    const result = applyExecutionPolicyReArm({
      issue: rearmIssue(state),
      policy,
      executionState: state,
    });
    const written = result.patch.executionState as IssueExecutionState;
    expect(written.currentStageId).toBe(newStageId);
    expect(written.currentStageIndex).toBe(1);
    expect(policy.stages[1]!.id).toBe(written.currentStageId);
    expect(written.completedStageIds).toEqual([stage1Id]);
  });

  it("returns an empty patch when every stage is already completed", () => {
    const state = {
      ...activeState(),
      completedStageIds: [stage1Id, stage2Id, stage3Id],
      currentStageId: null,
      currentStageIndex: null,
    } as unknown as IssueExecutionState;
    const result = applyExecutionPolicyReArm({
      issue: rearmIssue(state),
      policy: threeStagePolicy(),
      executionState: state,
    });
    expect(result.patch).toEqual({});
  });

  it("excludes the return assignee from the re-armed stage regardless of participant order", () => {
    // Both orderings: with `preferred` the return assignee was selected even
    // when listed second (the reported control), so `[RA, OTHER]` and
    // `[OTHER, RA]` must both land on OTHER — this is exclusion, not first-eligible.
    const orderings = [
      [{ type: "agent" as const, agentId: coderAgentId }, { type: "agent" as const, agentId: leAgentId }],
      [{ type: "agent" as const, agentId: leAgentId }, { type: "agent" as const, agentId: coderAgentId }],
    ];
    for (const participants of orderings) {
      const state = selfGatedProbeState();
      const result = applyExecutionPolicyReArm({
        issue: rearmIssue(state),
        policy: selfGatedPolicy(participants),
        executionState: state,
      });
      const written = result.patch.executionState as IssueExecutionState;
      expect(written.currentStageId).toBe(stage2Id);
      expect(written.currentParticipant).toMatchObject({ type: "agent", agentId: leAgentId });
      expect(written.currentParticipant).not.toMatchObject({ agentId: coderAgentId });
      expect(result.patch.assigneeAgentId).toBe(leAgentId);
    }
  });

  it("fails loud with execution_policy_rearm_no_participant when the return assignee is the only participant", () => {
    const state = selfGatedProbeState();
    const policy = selfGatedPolicy([{ type: "agent", agentId: coderAgentId }]);
    try {
      applyExecutionPolicyReArm({ issue: rearmIssue(state), policy, executionState: state });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const httpErr = err as HttpError;
      expect(httpErr.status).toBe(422);
      expect(httpErr.details).toMatchObject({
        code: "execution_policy_rearm_no_participant",
        stageId: stage2Id,
      });
    }
  });

  it("leaves a single-participant target stage unchanged when the return assignee is not a participant", () => {
    // SUP-16131-shaped regression: return assignee (coder) is not on stage2, so
    // the re-arm keeps stage2's own participant and mints no decision row.
    const state = activeState();
    const result = applyExecutionPolicyReArm({
      issue: rearmIssue(state),
      policy: threeStagePolicy(),
      executionState: state,
    });
    const written = result.patch.executionState as IssueExecutionState;
    expect(written.currentStageId).toBe(stage2Id);
    expect(written.currentParticipant).toMatchObject({ type: "agent", agentId: leAgentId });
    expect(result.patch.assigneeAgentId).toBe(leAgentId);
    expect(written.completedStageIds).toEqual([stage1Id]);
    expect(written.skippedStageIds).toEqual([]);
    expect(result.decision).toBeUndefined();
  });

  it("is reachable through applyIssueExecutionPolicyTransition via rearmPointer", () => {
    const state = activeState();
    const result = applyIssueExecutionPolicyTransition({
      issue: rearmIssue(state),
      policy: threeStagePolicy(),
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      rearmPointer: true,
    });
    expect(result.patch.status).toBe("in_review");
    const written = result.patch.executionState as IssueExecutionState;
    expect(written.currentStageId).toBe(stage2Id);
    expect(written.currentStageIndex).toBe(1);
  });
});

describe("INV-LADDER-1 full scenario: raw PATCH refused, §4 re-arm recovers (SUP-16525)", () => {
  it("refuses the raw prefix-removal rewrite and re-seats the pointer via the re-arm", () => {
    const stored = threeStagePolicy();
    const state = activeState();
    // Client removes the completed stage1 from the prefix. The raw rewrite is
    // refused by BOTH the assert (route boundary) and the resolver (store boundary).
    const rewrite = {
      mode: "normal",
      commentRequired: true,
      stages: [
        { id: stage2Id, type: "review", participants: [{ type: "agent", agentId: leAgentId }] },
        { id: stage3Id, type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
      ],
    };

    expect(() =>
      assertPatchableExecutionPolicyWrite({
        raw: rewrite,
        currentPolicy: stored,
        stagesExplicitlyEmpty: false,
        stagesKeyAbsent: false,
        executionState: state,
      }),
    ).toThrowError(HttpError);
    expect(() =>
      resolvePatchExecutionPolicy({
        raw: rewrite,
        currentPolicy: stored,
        stagesKeyAbsent: false,
        executionState: state,
      }),
    ).toThrowError(HttpError);

    // The sanctioned recovery: re-arm against the NEW policy. The pointer
    // re-seats on stage2 at its new index 0, completedStageIds is pruned to the
    // surviving policy (stage1 dropped), and no stage is wrongly completed.
    const newPolicy = normalizeIssueExecutionPolicy({ stages: rewrite.stages })!;
    const result = applyIssueExecutionPolicyTransition({
      issue: rearmIssue(state),
      policy: newPolicy,
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      rearmPointer: true,
    });
    const written = result.patch.executionState as IssueExecutionState;
    expect(written.currentStageId).toBe(stage2Id);
    expect(written.currentStageIndex).toBe(0);
    expect(newPolicy.stages[written.currentStageIndex!]!.id).toBe(stage2Id);
    expect(written.completedStageIds).toEqual([]);
    expect(written.skippedStageIds).toEqual([]);
    expect(result.droppedStageIds).toEqual([stage1Id]);
  });
});
