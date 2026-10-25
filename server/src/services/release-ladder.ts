import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, authUsers, companyMemberships, issueExecutionDecisions } from "@paperclipai/db";
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

  const decisions = await loadDecisions(conn, row);
  const latest = latestDecisionPerStage(decisions);
  const authors = workAuthors(row, policy, state);
  for (const stageId of stageIds) {
    const decision = latest.get(stageId);
    if (!decision) return `stage ${stageId} has no decision`;
    // The latest decision is the newest by time. Decisions sharing that instant have no order the
    // database records (the id is random), and the id is never used to order them: every decision at
    // that instant must be an eligible approval, so a rejection or an ineligible decider among them
    // refuses, whichever of them a tie-break on the id would have picked.
    const newest = decision.createdAt.getTime();
    const tied = decisions.filter((d) => d.stageId === stageId && d.createdAt.getTime() === newest);
    for (const d of tied) {
      const problem = await decisionProblem(conn, row, authors, d);
      if (problem) return `the latest decision of stage ${stageId}: ${problem}`;
    }
  }
  return null;
}

/**
 * Whether the decision a card's certified final delivery names was a genuine approval: the same
 * outcome, attribution, authorship and current-membership rules the ladder applies, so a certificate
 * minted by a decider who has since left (or by an author) is not a stand-in for the review.
 */
export async function evaluateCertificateProvenance(
  conn: Db,
  row: CandidateRow,
  decisionId: string,
): Promise<string | null> {
  const policy = (row.executionPolicy && typeof row.executionPolicy === "object" ? row.executionPolicy : {}) as Record<string, unknown>;
  const state = (row.executionState && typeof row.executionState === "object" ? row.executionState : {}) as Record<string, unknown>;
  const decision = (await loadDecisions(conn, row)).find((d) => d.id === decisionId);
  if (!decision) return "the certified delivery's decision does not exist on this card";
  const problem = await decisionProblem(conn, row, workAuthors(row, policy, state), decision);
  return problem ? `the certified delivery's decision: ${problem}` : null;
}

function loadDecisions(conn: Db, row: CandidateRow) {
  return conn
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
}

function workAuthors(row: CandidateRow, policy: Record<string, unknown>, state: Record<string, unknown>) {
  const authors = resolveSelfApprovalPrincipals(policy, state, row.createdByAgentId ?? null);
  // The card's creator is an author too, whether an agent or a user.
  if (row.createdByUserId) authors.userIds.add(row.createdByUserId);
  return authors;
}

type LoadedDecision = Awaited<ReturnType<typeof loadDecisions>>[number];

/** Why one decision is not an eligible approval of this card, or null when it is. */
async function decisionProblem(
  conn: Db,
  row: CandidateRow,
  authors: ReturnType<typeof workAuthors>,
  decision: LoadedDecision,
): Promise<string | null> {
  if (decision.outcome !== "approved") return `${decision.outcome}, not approved`;
  if (!decision.actorAgentId && !decision.actorUserId) return "not attributed to anyone";
  if (
    (decision.actorAgentId && authors.agentIds.has(decision.actorAgentId)) ||
    (decision.actorUserId && authors.userIds.has(decision.actorUserId))
  ) {
    return "made by someone who authored the work";
  }
  // The decider must still be eligible in this card's company: an agent of the company that is not
  // terminated or awaiting approval, or a user who still exists and has an active membership in it.
  if (decision.actorAgentId) {
    const [agent] = await conn
      .select({ companyId: agents.companyId, status: agents.status })
      .from(agents)
      .where(eq(agents.id, decision.actorAgentId));
    if (!agent || agent.companyId !== row.companyId || agent.status === "terminated" || agent.status === "pending_approval") {
      return "made by an agent that is not a current agent of this company";
    }
  }
  if (decision.actorUserId) {
    const [member] = await conn
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
      .where(and(
        eq(companyMemberships.companyId, row.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, decision.actorUserId),
        eq(companyMemberships.status, "active"),
      ));
    if (!member) return "made by a user who does not exist or is not an active member of this company";
  }
  return null;
}
