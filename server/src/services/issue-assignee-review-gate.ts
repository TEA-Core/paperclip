import type { IssueExecutionStage } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

export interface SelfSatisfyingReviewStageFinding {
  stageId: string;
  stageType: string;
  assigneeAgentId: string;
  participantsExcludingAssignee: number;
  approvalsNeeded: number;
}

function stageApprovalsNeeded(stage: unknown): number {
  const raw =
    stage && typeof stage === "object"
      ? (stage as { approvalsNeeded?: unknown }).approvalsNeeded
      : undefined;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

/**
 * SUP-13526 — detect an `assigneeAgentId` write that would make an incomplete
 * review stage self-satisfiable: the incoming assignee is a participant of the
 * stage and the remaining participants cannot reach `approvalsNeeded` without
 * the assignee approving their own work.
 *
 * Conditions (reject iff all hold for some stage S):
 *   1. S is a `review` stage whose id is not in `completedStageIds` nor
 *      `skippedStageIds`;
 *   2. the incoming `assigneeAgentId` is a participant of S;
 *   3. `count(S.participants excluding the incoming assignee) < S.approvalsNeeded`.
 *
 * The predicate reads the stored policy structurally instead of re-normalizing
 * it through the API input schema: the schema pins `approvalsNeeded` to the
 * literal 1 today, and the gate must keep working (and stay testable) if that
 * widens to N approvals. Stages are read as-is; a malformed row simply yields
 * no finding so a bad stored row cannot wedge the reassignment.
 *
 * Runtime stage-transition assignee writes (a review start selecting its active
 * participant) are NOT explicit assignee writes and are exempt by construction:
 * callers only invoke this for request-level `assigneeAgentId` writes and
 * recovery reassignments.
 */
export function findSelfSatisfyingReviewStage(input: {
  executionPolicy: unknown;
  executionState: unknown;
  incomingAssigneeAgentId: string | null | undefined;
}): SelfSatisfyingReviewStageFinding | null {
  const assigneeAgentId = input.incomingAssigneeAgentId;
  if (typeof assigneeAgentId !== "string" || assigneeAgentId.length === 0) return null;
  const policy = input.executionPolicy as
    | { stages?: unknown }
    | null
    | undefined;
  if (!policy || typeof policy !== "object" || !Array.isArray(policy.stages)) {
    return null;
  }
  const state = parseIssueExecutionState(input.executionState);
  const completedStageIds = new Set(state?.completedStageIds ?? []);
  const skippedStageIds = new Set(state?.skippedStageIds ?? []);
  for (const rawStage of policy.stages) {
    if (!rawStage || typeof rawStage !== "object") continue;
    const stage = rawStage as Pick<IssueExecutionStage, "id" | "type"> & {
      participants?: unknown;
    };
    if (stage.type !== "review") continue;
    if (typeof stage.id !== "string") continue;
    if (completedStageIds.has(stage.id) || skippedStageIds.has(stage.id)) continue;
    const participants = Array.isArray(stage.participants) ? stage.participants : [];
    const isParticipant = participants.some(
      (participant) =>
        participant &&
        typeof participant === "object" &&
        participant.type === "agent" &&
        participant.agentId === assigneeAgentId,
    );
    if (!isParticipant) continue;
    const participantsExcludingAssignee = participants.filter(
      (participant) =>
        !(
          participant &&
          typeof participant === "object" &&
          participant.type === "agent" &&
          participant.agentId === assigneeAgentId
        ),
    ).length;
    if (participantsExcludingAssignee < stageApprovalsNeeded(rawStage)) {
      return {
        stageId: stage.id,
        stageType: stage.type,
        assigneeAgentId,
        participantsExcludingAssignee,
        approvalsNeeded: stageApprovalsNeeded(rawStage),
      };
    }
  }
  return null;
}

/**
 * Route-level guard: throws 422 when the explicit `assigneeAgentId` write would
 * land a self-satisfiable review stage. The 422 body names the offending stage
 * id and the participant collision so the caller can act.
 */
export function assertAssigneeWriteDoesNotSelfSatisfyReviewStage(input: {
  executionPolicy: unknown;
  executionState: unknown;
  incomingAssigneeAgentId: string | null | undefined;
}): void {
  const finding = findSelfSatisfyingReviewStage(input);
  if (!finding) return;
  throw unprocessable(
    `Refusing assigneeAgentId write: ${finding.assigneeAgentId} is a participant of incomplete review stage ${finding.stageId} and the write would make the stage self-satisfiable, because it cannot be cleared without the assignee approving their own work (participants excluding the assignee: ${finding.participantsExcludingAssignee}, approvalsNeeded: ${finding.approvalsNeeded})`,
    {
      guard: "assignee_review_gate",
      issueStageId: finding.stageId,
      stageType: finding.stageType,
      assigneeAgentId: finding.assigneeAgentId,
      participantsExcludingAssignee: finding.participantsExcludingAssignee,
      approvalsNeeded: finding.approvalsNeeded,
    },
  );
}
