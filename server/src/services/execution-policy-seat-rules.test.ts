import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import {
  EXECUTION_POLICY_SEAT_CONFLICT_CODE,
  assertExecutionPolicySeatsLawful,
  executionPolicySeatsChanged,
  findExecutionPolicySeatConflicts,
  activeExecutionStageId,
  stageHoldsAssignee,
} from "./execution-policy-seat-rules.js";

const CREATOR = "11111111-1111-4111-8111-111111111111";
const ASSIGNEE = "22222222-2222-4222-8222-222222222222";
const REVIEWER = "33333333-3333-4333-8333-333333333333";
const APPROVER = "44444444-4444-4444-8444-444444444444";

const stage = (type: "review" | "approval", ...agentIds: string[]) => ({
  id: `${type}-${agentIds.join("-")}`,
  type,
  participants: agentIds.map((agentId) => ({ type: "agent", agentId })),
});
const policy = (...stages: unknown[]) => ({ mode: "normal", stages });
const all = { judgeCreator: true, judgeAssignee: true };

function refusal(fn: () => void): HttpError {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("execution policy seat rules", () => {
  it("accepts a ladder whose seats differ from the creator and the assignee", () => {
    expect(findExecutionPolicySeatConflicts({
      executionPolicy: policy(stage("review", REVIEWER), stage("approval", APPROVER)),
      creator: { agentId: CREATOR },
      assignee: { agentId: ASSIGNEE },
      ...all,
    })).toEqual([]);
  });

  it("refuses the creator as reviewer and the assignee as approver, naming seat, id and role", () => {
    const conflicts = findExecutionPolicySeatConflicts({
      executionPolicy: policy(stage("review", REVIEWER, CREATOR), stage("approval", APPROVER, ASSIGNEE)),
      creator: { agentId: CREATOR },
      assignee: { agentId: ASSIGNEE },
      ...all,
    });
    expect(conflicts).toEqual([
      expect.objectContaining({ stageIndex: 0, seat: "reviewer", participantId: CREATOR, conflictingRole: "creator" }),
      expect.objectContaining({ stageIndex: 1, seat: "approver", participantId: ASSIGNEE, conflictingRole: "assignee" }),
    ]);
  });

  it("does not judge user seats, matching the tool-side rule", () => {
    const boardPolicy = policy({ type: "approval", participants: [{ type: "user", userId: "board-user" }] });
    expect(findExecutionPolicySeatConflicts({
      executionPolicy: boardPolicy,
      creator: { agentId: CREATOR },
      assignee: { agentId: ASSIGNEE },
      ...all,
    })).toEqual([]);
    expect(stageHoldsAssignee({
      status: "blocked",
      executionState: { status: "pending", currentStageId: "s", currentParticipant: { type: "user", userId: "board-user" } },
      assigneeAgentId: ASSIGNEE,
    })).toBe(false);
  });

  it("compares ids, never names, and ignores id case", () => {
    expect(findExecutionPolicySeatConflicts({
      executionPolicy: policy(stage("review", ASSIGNEE.toUpperCase())),
      creator: {},
      assignee: { agentId: ASSIGNEE },
      ...all,
    })).toHaveLength(1);
    // A user id that happens to equal an agent id is a different principal.
    expect(findExecutionPolicySeatConflicts({
      executionPolicy: policy({ type: "review", participants: [{ type: "user", userId: ASSIGNEE }] }),
      creator: {},
      assignee: { agentId: ASSIGNEE },
      ...all,
    })).toEqual([]);
  });

  it("skips the creator when the write keeps the seats (a legacy card stays repairable)", () => {
    expect(findExecutionPolicySeatConflicts({
      executionPolicy: policy(stage("review", CREATOR)),
      creator: { agentId: CREATOR },
      assignee: { agentId: ASSIGNEE },
      judgeCreator: false,
      judgeAssignee: true,
    })).toEqual([]);
  });

  it("skips the assignee while a stage holds an in_review card", () => {
    expect(findExecutionPolicySeatConflicts({
      executionPolicy: policy(stage("review", REVIEWER)),
      creator: { agentId: CREATOR },
      assignee: { agentId: REVIEWER },
      judgeCreator: true,
      judgeAssignee: false,
    })).toEqual([]);
  });

  it("reads a malformed stored policy without throwing", () => {
    for (const executionPolicy of [null, "x", { stages: "x" }, { stages: [null, { type: "review", participants: [null, {}] }] }]) {
      expect(findExecutionPolicySeatConflicts({
        executionPolicy,
        creator: { agentId: CREATOR },
        assignee: { agentId: ASSIGNEE },
        ...all,
      })).toEqual([]);
    }
  });

  it("refuses with a 422 carrying the stable code and never strips the seat", () => {
    const input = {
      executionPolicy: policy(stage("approval", APPROVER, ASSIGNEE)),
      creator: { agentId: CREATOR },
      assignee: { agentId: ASSIGNEE },
      ...all,
    };
    const before = JSON.stringify(input.executionPolicy);
    const error = refusal(() => assertExecutionPolicySeatsLawful(input));
    expect(error.status).toBe(422);
    expect(error.details).toMatchObject({
      code: EXECUTION_POLICY_SEAT_CONFLICT_CODE,
      seat: "approver",
      participantId: ASSIGNEE,
      conflictingRole: "assignee",
    });
    expect(JSON.stringify(input.executionPolicy)).toBe(before);
  });

  it("treats a resend of the same seats without ids as unchanged", () => {
    const stored = policy(stage("review", REVIEWER), stage("approval", APPROVER));
    const resent = policy(
      { type: "review", participants: [{ type: "agent", agentId: REVIEWER }] },
      { type: "approval", participants: [{ type: "agent", agentId: APPROVER }] },
    );
    expect(executionPolicySeatsChanged(stored, resent)).toBe(false);
    expect(executionPolicySeatsChanged(stored, policy(stage("review", REVIEWER)))).toBe(true);
    expect(executionPolicySeatsChanged(stored, policy(stage("review", APPROVER), stage("approval", REVIEWER)))).toBe(true);
  });

  it("knows when an active stage holds the assignee", () => {
    const pending = {
      status: "pending",
      currentStageId: "stage-1",
      currentParticipant: { type: "agent", agentId: REVIEWER },
    };
    expect(stageHoldsAssignee({ status: "in_review", assigneeAgentId: ASSIGNEE })).toBe(true);
    expect(stageHoldsAssignee({ status: "blocked", executionState: pending, assigneeAgentId: REVIEWER })).toBe(true);
    expect(stageHoldsAssignee({ status: "blocked", executionState: pending, assigneeAgentId: ASSIGNEE })).toBe(false);
    expect(stageHoldsAssignee({ status: "blocked", executionState: { ...pending, status: "idle" }, assigneeAgentId: REVIEWER }))
      .toBe(false);
    expect(stageHoldsAssignee({ status: "todo", executionState: null, assigneeAgentId: REVIEWER })).toBe(false);
  });

  it("lets the assignee be a participant of the active stage only", () => {
    const review = stage("review", REVIEWER, APPROVER);
    const approval = stage("approval", APPROVER);
    const input = {
      executionPolicy: policy(review, approval),
      creator: { agentId: CREATOR },
      assignee: { agentId: APPROVER },
      ...all,
    };
    // Reassigned within the active review stage: the approval seat still conflicts.
    expect(findExecutionPolicySeatConflicts({ ...input, assigneeMayHoldStageId: review.id })).toEqual([
      expect.objectContaining({ stageIndex: 1, seat: "approver", conflictingRole: "assignee" }),
    ]);
    expect(findExecutionPolicySeatConflicts({ ...input, assigneeMayHoldStageId: null })).toHaveLength(2);
    expect(activeExecutionStageId({ executionState: { status: "pending", currentStageId: review.id } })).toBe(review.id);
    expect(activeExecutionStageId({ executionState: { status: "idle", currentStageId: review.id } })).toBeNull();
  });
});
