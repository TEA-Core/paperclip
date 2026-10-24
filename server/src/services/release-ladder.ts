import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueExecutionDecisions } from "@paperclipai/db";
import {
  evaluateStageIntegrity,
  latestDecisionPerStage,
  resolveSelfApprovalPrincipals,
  type CandidateRow,
} from "./approval-status-reconciler.js";

/**
 * Whether a card's recorded ladder really is a completed APPROVING ladder, for a board release
 * (SUP-20772). Returns null when it is, else why not.
 *
 * `evaluateStageIntegrity` (Guard B) proves each completed stage has a decision and that the one
 * principal it resolves did not decide it. It does not look at the outcome, at attribution, or at the
 * wider set of principals who authored the work, so on top of it this requires, for EVERY stage in the
 * policy, that the LATEST decision is an approval, is attributed to a principal, and is not by anyone
 * who authored the work (the union the board self-approval gate uses: return assignee, delivery
 * author, creator agent).
 *
 * `conn` is the caller's connection (the publication lock's transaction), never a second pool borrow.
 */
export async function evaluateApprovingLadder(
  conn: Db,
  row: CandidateRow,
): Promise<string | null> {
  const integrity = await evaluateStageIntegrity(conn, row);
  if (integrity) return integrity.detail;

  const policy = (row.executionPolicy && typeof row.executionPolicy === "object" ? row.executionPolicy : {}) as Record<string, unknown>;
  const state = (row.executionState && typeof row.executionState === "object" ? row.executionState : {}) as Record<string, unknown>;
  const stageIds = (Array.isArray(policy.stages) ? policy.stages : [])
    .map((stage) => (stage && typeof stage === "object" ? (stage as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string");
  if (stageIds.length === 0) return "the policy has no stages";

  const decisions = await conn
    .select({
      id: issueExecutionDecisions.id,
      stageId: issueExecutionDecisions.stageId,
      outcome: issueExecutionDecisions.outcome,
      actorAgentId: issueExecutionDecisions.actorAgentId,
      actorUserId: issueExecutionDecisions.actorUserId,
      createdAt: issueExecutionDecisions.createdAt,
    })
    .from(issueExecutionDecisions)
    .where(and(eq(issueExecutionDecisions.issueId, row.id), eq(issueExecutionDecisions.companyId, row.companyId)));
  const latest = latestDecisionPerStage(decisions);
  const authors = resolveSelfApprovalPrincipals(policy, state, row.createdByAgentId ?? null);
  for (const stageId of stageIds) {
    const decision = latest.get(stageId);
    if (!decision) return `stage ${stageId} has no decision`;
    if (decision.outcome !== "approved") {
      return `the latest decision of stage ${stageId} is ${decision.outcome}, not approved`;
    }
    if (!decision.actorAgentId && !decision.actorUserId) return `the latest decision of stage ${stageId} is not attributed to anyone`;
    if (
      (decision.actorAgentId && authors.agentIds.has(decision.actorAgentId)) ||
      (decision.actorUserId && authors.userIds.has(decision.actorUserId))
    ) {
      return `the latest decision of stage ${stageId} was made by someone who authored the work`;
    }
  }
  return null;
}
