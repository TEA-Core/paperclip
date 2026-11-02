import type { IssueExecutionStage } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginManagedResources } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import {
  type RefusalCaller,
  type RefusalIssue,
  resolveCallerSeat,
  seatAuthorityNextAction,
} from "./seat-authority-refusal.js";

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
  /**
   * Board ruling 2026-10-02 (F1): the writer and the issue as stored. When
   * present the 422 names the caller's seat and points to the owning doctrine
   * section after the unchanged message. Absent (the recovery service, or a board caller)
   * it is unchanged.
   */
  refusalContext?: { caller: RefusalCaller; issue: RefusalIssue | null };
}): void {
  const finding = findSelfSatisfyingReviewStage(input);
  if (!finding) return;
  const message = `Refusing assigneeAgentId write: ${finding.assigneeAgentId} is a participant of incomplete review stage ${finding.stageId} and the write would make the stage self-satisfiable, because it cannot be cleared without the assignee approving their own work (participants excluding the assignee: ${finding.participantsExcludingAssignee}, approvalsNeeded: ${finding.approvalsNeeded})`;
  const details: Record<string, unknown> = {
    guard: "assignee_review_gate",
    issueStageId: finding.stageId,
    stageType: finding.stageType,
    assigneeAgentId: finding.assigneeAgentId,
    participantsExcludingAssignee: finding.participantsExcludingAssignee,
    approvalsNeeded: finding.approvalsNeeded,
  };
  if (!input.refusalContext) throw unprocessable(message, details);
  const callerSeat = resolveCallerSeat(input.refusalContext.caller, input.refusalContext.issue);
  const nextAction = seatAuthorityNextAction(callerSeat);
  throw unprocessable(`${message}. ${nextAction}`, { ...details, callerSeat, nextAction });
}

export const WIKI_LLM_WIKI_PLUGIN_KEY = "paperclipai.plugin-llm-wiki" as const;
export const WIKI_MAINTAINER_AGENT_KEY = "wiki-maintainer" as const;

export function isWikiHandoffTitle(title: unknown): boolean {
  return (
    typeof title === "string" &&
    title.trim().toLowerCase().includes("handoff to wiki maintainer")
  );
}

export async function resolveCanonicalWikiMaintainerAgentId(
  db: Db,
  companyId: string,
  issue: { title?: string | null; description?: string | null } | null | undefined,
): Promise<string | null> {
  if (!issue?.title?.trim() && !issue?.description?.trim()) return null;
  if (!isWikiHandoffTitle(issue.title)) return null;
  const rows = await db
    .select({ resourceId: pluginManagedResources.resourceId })
    .from(pluginManagedResources)
    .where(
      and(
        eq(pluginManagedResources.companyId, companyId),
        eq(pluginManagedResources.pluginKey, WIKI_LLM_WIKI_PLUGIN_KEY),
        eq(pluginManagedResources.resourceKind, "agent"),
        eq(pluginManagedResources.resourceKey, WIKI_MAINTAINER_AGENT_KEY),
      ),
    )
    .then((found) => found);
  return rows[0]?.resourceId ?? null;
}

export async function assertWikiHandoffWriteIntegrity(input: {
  db: Db | { select: unknown };
  companyId: string;
  issue: {
    title?: string | null;
    description?: string | null;
    executionPolicy?: unknown;
    executionState?: unknown;
  };
  incomingAssigneeAgentId: string | null | undefined;
  checkReviewStage?: boolean;
  refusalContext?: { caller: RefusalCaller; issue: RefusalIssue | null };
}): Promise<void> {
  const canonicalMaintainerAgentId = await resolveCanonicalWikiMaintainerAgentId(
    input.db as Db,
    input.companyId,
    input.issue,
  );
  if (!canonicalMaintainerAgentId) return;
  const incoming = typeof input.incomingAssigneeAgentId === "string" && input.incomingAssigneeAgentId.length > 0
    ? input.incomingAssigneeAgentId
    : null;
  if (incoming !== canonicalMaintainerAgentId) {
    throw unprocessable(
      "Refusing assigneeAgentId write on a Wiki handoff: the resulting assignee is not the canonical Wiki Maintainer managed by plugin paperclipai.plugin-llm-wiki (resourceKey wiki-maintainer)",
      {
        guard: "assignee_review_gate",
        subGuard: "wiki_handoff",
        reason: incoming === null ? "wiki_handoff_unassigned" : "wiki_handoff_non_canonical_assignee",
        pluginKey: WIKI_LLM_WIKI_PLUGIN_KEY,
        resourceKey: WIKI_MAINTAINER_AGENT_KEY,
        canonicalMaintainerAgentId,
        assigneeAgentId: incoming,
      },
    );
  }
  if (input.checkReviewStage !== false) {
    assertAssigneeWriteDoesNotSelfSatisfyReviewStage({
      executionPolicy: input.issue.executionPolicy,
      executionState: input.issue.executionState,
      incomingAssigneeAgentId: input.incomingAssigneeAgentId,
      refusalContext: input.refusalContext,
    });
  }
}

export function wikiHandoffWriteWouldViolate(input: {
  canonicalMaintainerAgentId: string | null | undefined;
  incomingAssigneeAgentId: string | null | undefined;
  executionPolicy: unknown;
  executionState: unknown;
}): { reason: "wiki_handoff_non_canonical_assignee" | "wiki_handoff_self_satisfy" } | null {
  const canonical = typeof input.canonicalMaintainerAgentId === "string" && input.canonicalMaintainerAgentId.length > 0
    ? input.canonicalMaintainerAgentId
    : null;
  if (!canonical) return null;
  const incoming = typeof input.incomingAssigneeAgentId === "string" && input.incomingAssigneeAgentId.length > 0
    ? input.incomingAssigneeAgentId
    : null;
  if (incoming !== canonical) return { reason: "wiki_handoff_non_canonical_assignee" };
  if (
    findSelfSatisfyingReviewStage({
      executionPolicy: input.executionPolicy,
      executionState: input.executionState,
      incomingAssigneeAgentId: incoming,
    })
  ) {
    return { reason: "wiki_handoff_self_satisfy" };
  }
  return null;
}

export type WikiHandoffViolationReason =
  "wiki_handoff_non_canonical_assignee" | "wiki_handoff_self_satisfy";
