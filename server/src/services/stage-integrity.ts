import type { Db } from "@paperclipai/db";
import { issueExecutionDecisions } from "@paperclipai/db";
import { eq } from "drizzle-orm";

/**
 * ADR-091 D3: the ADR-073 stage-integrity record — a card whose approval
 * must be certified as a real, non-self, non-auto-skipped decision. This is
 * the single record shape both the approval-status reconciler (re-publish)
 * and the approval-arming hook in the issue routes (first publish) bind to,
 * so a future strengthening of either binds both (ADR-085: one predicate,
 * two call sites).
 */
export interface StageIntegrityRecord {
  id: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  executionState: Record<string, unknown> | null;
  executionPolicy: Record<string, unknown> | null;
}

/**
 * The verdict of the ADR-073 stage-integrity audit. `ok` means the recorded
 * approval is backed by a real, non-self decision ladder; `refused` carries a
 * stable reason code (the `guard-b:*` family) and a human-readable detail.
 *
 * Unverifiable integrity — a completed stage with no decision row, or an
 * unreadable execution state — refuses (ADR-091 D4): a first stamp is an
 * authorization and may only be issued on a verifiable record.
 */
export type StageIntegrityResult =
  | { ok: true }
  | { ok: false; reason: string; detail: string };

/**
 * ADR-073 stage-integrity audit of a recorded approval. Returns a skip
 * verdict when the "approved" record is not backed by a real, non-self
 * decision: an auto-skipped review stage writes no decision row and lands in
 * `skippedStageIds`, so it must never be treated as an approval. This is the
 * shared predicate the approval-status reconciler and the first-publish
 * arming hook both enforce — one predicate, two call sites.
 */
export async function evaluateStageIntegrity(
  db: Db,
  row: StageIntegrityRecord,
): Promise<StageIntegrityResult> {
  const state: Record<string, unknown> = row.executionState ?? {};
  const policy: Record<string, unknown> = row.executionPolicy ?? {};

  const skippedStageIds = Array.isArray(state.skippedStageIds)
    ? (state.skippedStageIds as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  if (skippedStageIds.length > 0) {
    return {
      ok: false,
      reason: "guard-b:skipped-stage",
      detail: `skipped stages present: ${skippedStageIds.join(", ")}`,
    };
  }

  const policyStageIds = new Set(
    (Array.isArray(policy.stages)
      ? (policy.stages as Array<Record<string, unknown> | null | undefined>)
      : []
    )
      .map((stage) => (stage && typeof stage.id === "string" ? stage.id : null))
      .filter((id): id is string => id !== null),
  );

  const completedStageIds = Array.isArray(state.completedStageIds)
    ? (state.completedStageIds as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  if (completedStageIds.length === 0) {
    return {
      ok: false,
      reason: "guard-b:no-completed-stage",
      detail: "no completed stages recorded in executionState",
    };
  }
  for (const stageId of completedStageIds) {
    if (!policyStageIds.has(stageId)) {
      return {
        ok: false,
        reason: "guard-b:stage-not-in-policy",
        detail: `completed stage ${stageId} is not in executionPolicy.stages`,
      };
    }
  }

  const decisions = await db
    .select({
      stageId: issueExecutionDecisions.stageId,
      actorAgentId: issueExecutionDecisions.actorAgentId,
      actorUserId: issueExecutionDecisions.actorUserId,
      createdAt: issueExecutionDecisions.createdAt,
    })
    .from(issueExecutionDecisions)
    .where(eq(issueExecutionDecisions.issueId, row.id));

  const latestByStage = new Map<string, { actorAgentId: string | null; actorUserId: string | null; createdAt: Date }>();
  for (const decision of decisions) {
    const existing = latestByStage.get(decision.stageId);
    if (!existing || decision.createdAt.getTime() >= existing.createdAt.getTime()) {
      latestByStage.set(decision.stageId, {
        actorAgentId: decision.actorAgentId,
        actorUserId: decision.actorUserId,
        createdAt: decision.createdAt,
      });
    }
  }
  for (const stageId of completedStageIds) {
    if (!latestByStage.has(stageId)) {
      return {
        ok: false,
        reason: "guard-b:stage-without-decision",
        detail: `completed stage ${stageId} has no issue_execution_decisions row`,
      };
    }
  }

  const forbiddenAgents = new Set<string>();
  const forbiddenUsers = new Set<string>();
  if (row.createdByAgentId) forbiddenAgents.add(row.createdByAgentId);
  if (row.createdByUserId) forbiddenUsers.add(row.createdByUserId);
  if (typeof policy.returnAssigneeAgentId === "string" && policy.returnAssigneeAgentId) {
    forbiddenAgents.add(policy.returnAssigneeAgentId);
  }
  const returnAssignee = state.returnAssignee as
    | { type?: unknown; agentId?: unknown; userId?: unknown }
    | null
    | undefined;
  if (returnAssignee && typeof returnAssignee === "object") {
    if (returnAssignee.type === "agent" && typeof returnAssignee.agentId === "string") {
      forbiddenAgents.add(returnAssignee.agentId);
    }
    if (returnAssignee.type === "user" && typeof returnAssignee.userId === "string") {
      forbiddenUsers.add(returnAssignee.userId);
    }
  }

  for (const stageId of completedStageIds) {
    const latest = latestByStage.get(stageId)!;
    if ((latest.actorAgentId && forbiddenAgents.has(latest.actorAgentId)) ||
        (latest.actorUserId && forbiddenUsers.has(latest.actorUserId))) {
      return {
        ok: false,
        reason: "guard-b:decision-by-author-or-return-assignee",
        detail: `stage ${stageId} decided by the card's author or returnAssignee`,
      };
    }
  }

  return { ok: true };
}
