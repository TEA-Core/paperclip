/**
 * Execution-policy seat rules: an issue's creator and its assignee never hold
 * one of its reviewer or approver seats.
 *
 * Board ruling 2026-11-27. The agent tools enforce the same rule before they
 * write (`exec_policy.assert_lawful_seats` / `assert_lawful_write` in
 * paperclip-agent-tools). An agent that calls the API directly skips those
 * tools, so the server enforces the rule itself. Every caller-driven create
 * and update path refuses through one of two shared entry points:
 *   - a new issue: `newIssueSeatRuleInput`, judged inside `issueService.create`
 *     on the policy the issue will carry (its own or the inherited project or
 *     company default). Issue create, child create, accepted-plan
 *     decomposition, suggest_tasks accept, the runner `create_task` tool,
 *     manual and API routine runs, decision and delegation effects
 *     (including the delegated issue a status decision creates) and the
 *     plugin host `issues.create` all reach it.
 *   - an existing issue: `assertIssueUpdateSeatsLawful`, called by PATCH
 *     (policy, assignee, or both, including a whole-policy replace and a
 *     monitor-alias write), checkout, the runner `reassign_task` tool, the
 *     decision `assign_issue` effect and the plugin host `issues.update`.
 * Routine create, update and revision restore apply the rule to the routine's
 * policy and assignee, since every issue the routine dispatches carries them.
 *
 * Platform producers that warn instead (create with
 * `executionPolicySeatRules: "warn"`, which logs the conflict): scheduled and
 * webhook routine dispatch, pipeline stage-entry automation routine runs,
 * inbound email, inbound chat, external-service monitor recovery,
 * exhausted-recovery escalation, task-watchdog review, the agent chat
 * conversation, and the hidden bookkeeping issues (status card compile and
 * refresh, summary-slot generation, the company-skills test harness issue,
 * and the onboarding seed task).
 * Platform updates exempt by design (not judged): stage-machine seating of the
 * active participant, recovery reassignment (behind the self-satisfying
 * review-stage gate), task-watchdog reopen, interaction hand-backs, and
 * auto-checkout with an unchanged assignee.
 *
 * The rule compares agent ids only, never names: every `review` or
 * `approval` stage participant of type `agent` must differ from
 * `createdByAgentId` and `assigneeAgentId`. User participants are not judged,
 * matching the tool-side rule.
 *
 * It is evaluated against the issue AS IT WILL BE after the write. Two
 * scoping rules keep it the same as the tool-side rule, and keep stored cards
 * that already break it repairable (they are not migrated):
 *   - `judgeCreator`: the creator is compared with the seats only when the
 *     write changes the seats (a create always does). The creator never
 *     changes, so a write that keeps the stored seats seats nobody new.
 *   - `judgeAssignee`: the assignee is compared with the seats unless the
 *     write leaves the assignee alone while a stage holds the issue
 *     (`stageHoldsAssignee`): the issue is `in_review`, or its execution state
 *     has a pending stage whose current participant is the assignee. While a
 *     stage is active the runtime assigns the issue to the seated participant
 *     by design, and a card blocked mid-review keeps that assignee. A write
 *     that moves the assignee may move it to another participant of the
 *     active stage (`assigneeMayHoldStageId`), never into another stage.
 *
 * The module is pure: no DB, no route imports.
 */
import { unprocessable } from "../errors.js";

export const EXECUTION_POLICY_SEAT_CONFLICT_CODE = "execution_policy_seat_conflict";

export type ExecutionPolicySeat = "reviewer" | "approver";
export type ExecutionPolicySeatConflictingRole = "creator" | "assignee";

export interface ExecutionPolicySeatPrincipals {
  agentId?: string | null;
}

export interface ExecutionPolicySeatConflict {
  stageIndex: number;
  stageId: string | null;
  stageType: "review" | "approval";
  seat: ExecutionPolicySeat;
  participantType: "agent";
  participantId: string;
  conflictingRole: ExecutionPolicySeatConflictingRole;
}

export interface ExecutionPolicySeatRuleInput {
  /** The execution policy the issue will carry after the write. */
  executionPolicy: unknown;
  /** The issue's creator (on create: the caller that files it). */
  creator: ExecutionPolicySeatPrincipals;
  /** The issue's assignee after the write. */
  assignee: ExecutionPolicySeatPrincipals;
  /** Compare the creator with the seats (true when the write changes the seats). */
  judgeCreator: boolean;
  /** Compare the assignee with the seats (false only while a stage holds the issue). */
  judgeAssignee: boolean;
  /**
   * The stage that holds the issue now (`activeExecutionStageId`). Its own
   * participants may hold the issue as assignee: the runtime seats the
   * current participant there, and a board reassign within the active stage
   * hands the review to another of its participants. Seats in every other
   * stage still conflict with the assignee.
   */
  assigneeMayHoldStageId?: string | null;
}

function nonEmptyId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sameId(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && left.toLowerCase() === right.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Every seat the policy gives to the issue's creator or assignee. Reads the
 * policy structurally, so a malformed stored row yields no finding rather than
 * a throw.
 */
export function findExecutionPolicySeatConflicts(
  input: ExecutionPolicySeatRuleInput,
): ExecutionPolicySeatConflict[] {
  if (!input.judgeCreator && !input.judgeAssignee) return [];
  const policy = input.executionPolicy;
  if (!isRecord(policy) || !Array.isArray(policy.stages)) return [];

  const roles: Array<{ role: ExecutionPolicySeatConflictingRole; agentId: string | null }> = [];
  if (input.judgeCreator) {
    roles.push({ role: "creator", agentId: nonEmptyId(input.creator.agentId) });
  }
  if (input.judgeAssignee) {
    roles.push({ role: "assignee", agentId: nonEmptyId(input.assignee.agentId) });
  }

  const conflicts: ExecutionPolicySeatConflict[] = [];
  policy.stages.forEach((rawStage, stageIndex) => {
    if (!isRecord(rawStage)) return;
    const stageType = rawStage.type;
    if (stageType !== "review" && stageType !== "approval") return;
    const participants = Array.isArray(rawStage.participants) ? rawStage.participants : [];
    for (const rawParticipant of participants) {
      if (!isRecord(rawParticipant)) continue;
      if (rawParticipant.type !== "agent") continue;
      const participantId = nonEmptyId(rawParticipant.agentId);
      if (!participantId) continue;
      for (const principal of roles) {
        if (!sameId(participantId, principal.agentId)) continue;
        if (
          principal.role === "assignee"
          && sameId(nonEmptyId(rawStage.id), nonEmptyId(input.assigneeMayHoldStageId))
        ) continue;
        conflicts.push({
          stageIndex,
          stageId: nonEmptyId(rawStage.id),
          stageType,
          seat: stageType === "review" ? "reviewer" : "approver",
          participantType: "agent",
          participantId,
          conflictingRole: principal.role,
        });
      }
    }
  });
  return conflicts;
}

/**
 * Refuses the write with a 422 `execution_policy_seat_conflict` when the
 * resulting policy seats the issue's creator or assignee. The refusal names
 * the seat, the participant id and the conflicting role of the first
 * conflict, and lists every conflict in `details.conflicts`. It never strips
 * a seat.
 */
export function assertExecutionPolicySeatsLawful(input: ExecutionPolicySeatRuleInput): void {
  const conflicts = findExecutionPolicySeatConflicts(input);
  if (conflicts.length === 0) return;
  const [first] = conflicts;
  throw unprocessable(
    `Execution policy seat conflict: stage ${first.stageIndex} (${first.stageType}) seats the issue's `
      + `${first.conflictingRole} ${first.participantType} ${first.participantId} as ${first.seat}; `
      + "a reviewer or approver must differ from the issue's creator and its assignee. "
      + "Seat a different participant, or assign the issue to someone who holds no seat.",
    {
      code: EXECUTION_POLICY_SEAT_CONFLICT_CODE,
      seat: first.seat,
      stageIndex: first.stageIndex,
      stageId: first.stageId,
      stageType: first.stageType,
      participantType: first.participantType,
      participantId: first.participantId,
      conflictingRole: first.conflictingRole,
      conflicts,
    },
  );
}

/**
 * The seats of a policy without stage or participant ids, which a client may
 * omit and normalization then regenerates. Two policies with the same
 * signature seat the same principals in the same stages.
 */
export function executionPolicySeatSignature(policy: unknown): string {
  if (!isRecord(policy) || !Array.isArray(policy.stages)) return "[]";
  return JSON.stringify(
    policy.stages.map((rawStage) => {
      if (!isRecord(rawStage)) return null;
      const participants = Array.isArray(rawStage.participants) ? rawStage.participants : [];
      return [
        rawStage.type ?? null,
        participants.map((rawParticipant) =>
          isRecord(rawParticipant)
            ? [
              rawParticipant.type ?? null,
              nonEmptyId(rawParticipant.agentId)?.toLowerCase() ?? null,
              nonEmptyId(rawParticipant.userId)?.toLowerCase() ?? null,
            ]
            : null,
        ),
      ];
    }),
  );
}

/** True when the write changes which principals hold which seats. */
export function executionPolicySeatsChanged(previous: unknown, next: unknown): boolean {
  return executionPolicySeatSignature(previous) !== executionPolicySeatSignature(next);
}

/**
 * The id of the stage that holds the issue now: its execution state has a
 * pending stage. Null when no stage is active.
 */
export function activeExecutionStageId(issue: { executionState?: unknown }): string | null {
  const state = issue.executionState;
  if (!isRecord(state) || state.status !== "pending") return null;
  return nonEmptyId(state.currentStageId);
}

/**
 * True while an active stage holds the issue: it is `in_review`, or its
 * execution state has a pending stage whose current participant is the
 * issue's assignee (a card blocked mid-review keeps the seated assignee).
 * Then the assignee is a seat holder by design, not a conflict.
 */
export function stageHoldsAssignee(issue: {
  status?: string | null;
  executionState?: unknown;
  assigneeAgentId?: string | null;
}): boolean {
  if (issue.status === "in_review") return true;
  const state = issue.executionState;
  if (!isRecord(state) || state.status !== "pending" || !nonEmptyId(state.currentStageId)) return false;
  const participant = state.currentParticipant;
  if (!isRecord(participant) || participant.type !== "agent") return false;
  return sameId(nonEmptyId(participant.agentId), nonEmptyId(issue.assigneeAgentId));
}

/**
 * The seat-rule input for a new issue: the creator and the assignee are both
 * judged against the policy it will carry.
 */
export function newIssueSeatRuleInput(issue: {
  executionPolicy?: unknown;
  createdByAgentId?: string | null;
  assigneeAgentId?: string | null;
}): ExecutionPolicySeatRuleInput {
  return {
    executionPolicy: issue.executionPolicy ?? null,
    creator: { agentId: issue.createdByAgentId ?? null },
    assignee: { agentId: issue.assigneeAgentId ?? null },
    judgeCreator: true,
    judgeAssignee: true,
  };
}

export interface ExecutionPolicySeatRuleIssueRow {
  createdByAgentId: string | null;
  assigneeAgentId: string | null;
  status: string;
  executionState: unknown;
  executionPolicy: unknown;
}

/**
 * The seat-rule input for a write to an existing issue. `write` holds only the
 * fields the write sets: an `undefined` policy or assignee is left alone, and
 * an assignee equal to the stored one counts as left alone.
 *   - The creator never changes, so it is judged only when the write changes
 *     the seats.
 *   - The assignee is judged when the write moves it, or when the write sets
 *     the policy while no stage holds the issue.
 *   - A move within the active stage hands the issue to another participant
 *     of that stage, which is lawful; any other seat conflicts.
 */
export function issueUpdateSeatRuleInput(
  row: ExecutionPolicySeatRuleIssueRow,
  write: { executionPolicy?: unknown; assigneeAgentId?: string | null },
): ExecutionPolicySeatRuleInput {
  const policyWritten = write.executionPolicy !== undefined;
  const assigneeMoved = write.assigneeAgentId !== undefined && write.assigneeAgentId !== row.assigneeAgentId;
  const rowPolicy = row.executionPolicy ?? null;
  const resultingPolicy = policyWritten ? write.executionPolicy : rowPolicy;
  return {
    executionPolicy: resultingPolicy,
    creator: { agentId: row.createdByAgentId },
    assignee: { agentId: assigneeMoved ? write.assigneeAgentId : row.assigneeAgentId },
    judgeCreator: policyWritten && executionPolicySeatsChanged(rowPolicy, resultingPolicy),
    judgeAssignee: assigneeMoved || (policyWritten && !stageHoldsAssignee(row)),
    assigneeMayHoldStageId: activeExecutionStageId(row),
  };
}

/** Refuses a write to an existing issue that seats its creator or assignee. */
export function assertIssueUpdateSeatsLawful(
  row: ExecutionPolicySeatRuleIssueRow,
  write: { executionPolicy?: unknown; assigneeAgentId?: string | null },
): void {
  assertExecutionPolicySeatsLawful(issueUpdateSeatRuleInput(row, write));
}
