import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyMemberships, issueExecutionDecisions } from "@paperclipai/db";
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
  // The card's creator is an author too, whether an agent or a user.
  if (row.createdByUserId) authors.userIds.add(row.createdByUserId);
  for (const stageId of stageIds) {
    const decision = latest.get(stageId);
    if (!decision) return `stage ${stageId} has no decision`;
    // The latest decision is the newest by time. Decisions sharing that instant have no order the
    // database records (the id is random), so one that is not an approval among them wins: ties are
    // never settled in favour of the approval.
    const newest = decision.createdAt.getTime();
    const rejecting = decisions.find((d) => d.stageId === stageId && d.createdAt.getTime() === newest && d.outcome !== "approved");
    const effective = rejecting ?? decision;
    if (effective.outcome !== "approved") {
      return `the latest decision of stage ${stageId} is ${effective.outcome}, not approved`;
    }
    if (!effective.actorAgentId && !effective.actorUserId) return `the latest decision of stage ${stageId} is not attributed to anyone`;
    if (
      (effective.actorAgentId && authors.agentIds.has(effective.actorAgentId)) ||
      (effective.actorUserId && authors.userIds.has(effective.actorUserId))
    ) {
      return `the latest decision of stage ${stageId} was made by someone who authored the work`;
    }
    // The decider must still be a member of this card's company: an agent of the company that is not
    // terminated or awaiting approval, or a user with an active membership in it.
    if (effective.actorAgentId) {
      const [agent] = await conn
        .select({ companyId: agents.companyId, status: agents.status })
        .from(agents)
        .where(eq(agents.id, effective.actorAgentId));
      if (!agent || agent.companyId !== row.companyId || agent.status === "terminated" || agent.status === "pending_approval") {
        return `the latest decision of stage ${stageId} was made by an agent that is not a current agent of this company`;
      }
    }
    if (effective.actorUserId) {
      const [membership] = await conn
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(and(
          eq(companyMemberships.companyId, row.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, effective.actorUserId),
          eq(companyMemberships.status, "active"),
        ));
      if (!membership) {
        return `the latest decision of stage ${stageId} was made by a user who is not a current member of this company`;
      }
    }
  }
  return null;
}
