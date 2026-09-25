import { randomUUID } from "node:crypto";
import { issues, issueExecutionDecisions, type Db } from "@paperclipai/db";
import type { IssueExecutionDecisionOutcome } from "@paperclipai/shared";
import {
  applyIssueExecutionPolicyTransition,
  isReviewChangesRequestedTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";
import { resolveSummaryGenerationReturnAssignee } from "./summary-slots.js";
import { issueService } from "./index.js";
import { publishActivity, type ActivityPublication } from "./activity-log.js";
import { executeIssuePostCommitActions, type IssuePostCommitAction } from "./issues.js";

export type ReviewEscalationDecisionIssue = {
  id: string;
  companyId: string;
  status: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  responsibleUserId?: string | null;
  createdByUserId?: string | null;
  executionPolicy?: Record<string, unknown> | null;
  executionState?: Record<string, unknown> | null;
};

/**
 * Record a review/approval stage decision the way the execution-policy ladder
 * requires: run the pure transition as the deciding principal, mint a decision
 * id, stamp it onto the patched state, then in one transaction insert the
 * `issue_execution_decisions` row and apply the issue patch.
 *
 * This is the single source of truth for "decide a live pending stage as the
 * current participant" so that two surfaces that must both record the stage
 * decision can share the exact same engine path:
 *   - SUP-14919: a round-cap review escalation is resolved on an interaction
 *     (accept or reject) rather than through a PATCH, but the stage's decision
 *     still has to be recorded and the card handed to its return assignee.
 *     Without this the confirmation resolves in a void: no decision row is
 *     written, `assigneeAgentId` stays null, and the card strands permanently.
 *   - SUP-17080: the board's stalled-review Approve / Send back buttons used to
 *     skip the ladder entirely — a raw status update that left
 *     `executionState.status: "pending"` with the final stage still in flight
 *     and no decision row (ADR-073). They now route through this same helper.
 *
 * `db` may be the pool (route path — a fresh transaction is opened here) or an
 * already-open transaction client (the stalled-review path — this then opens a
 * savepoint on the same connection). Either way the decision row and the issue
 * patch commit or roll back together.
 *
 * For a final-stage approval the engine completes every stage without touching
 * the issue status, so the card is routed back to its return assignee in_progress
 * — matching what a changes-requested hand-back produces and what the issue's
 * continuation wake expects. The escalation-accept door overrides that with
 * `finalStageDisposition: "done"` (SUP-17552): the reviewer-approval path closes
 * the card on its final stage, and this door must render the same `done` close
 * instead of stranding the card in_progress with a completed execution state.
 * Returns `null` when the issue carries no resolvable execution policy/state, or
 * when the transition records no decision for this shape (in which case the
 * caller keeps its own fallback).
 */
export async function applyReviewEscalationDecision(args: {
  db: Db;
  issue: ReviewEscalationDecisionIssue;
  requestedStatus: "done" | "in_progress";
  decisionBody: string;
  actor: { agentId: string | null; userId: string | null; runId: string | null };
  // SUP-17552: how a final-stage approval (the ladder completed) lands the card.
  // "handback" (default) keeps the return-assignee in_progress hand-back; "done"
  // renders the final-stage `done` close. The caller is responsible for running
  // the done-transition guard before choosing "done" — this helper only writes
  // the status, so a refused close must never reach it.
  finalStageDisposition?: "handback" | "done";
}): Promise<{
  id: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  decisionId: string;
  stageId: string;
  stageType: string;
  outcome: IssueExecutionDecisionOutcome;
  issue: typeof issues.$inferSelect;
} | null> {
  const { db, issue, requestedStatus, decisionBody, actor } = args;
  const finalStageDisposition = args.finalStageDisposition ?? "handback";
  const policy = normalizeIssueExecutionPolicy(issue.executionPolicy ?? null);
  const existingState = parseIssueExecutionState(issue.executionState);
  if (!policy || !existingState) return null;

  // Re-opening an escalated review bounces the summary-generation task back to
  // the Summarizer, never to a policy `returnAssigneeAgentId` (SUP-15768).
  // Resolve it only when this decision is a pending review changes_requested
  // bounce, so unrelated decisions never trigger the summary-slot lookup.
  const summaryForcedReturnAssignee = isReviewChangesRequestedTransition({
    policy,
    executionState: existingState,
    requestedStatus,
  })
    ? await resolveSummaryGenerationReturnAssignee(db, issue)
    : null;
  const transition = applyIssueExecutionPolicyTransition({
    issue,
    policy,
    previousPolicy: policy,
    requestedStatus,
    requestedAssigneePatch: {},
    actor,
    commentBody: decisionBody,
    forcedReturnAssignee: summaryForcedReturnAssignee,
  });
  const decision = transition.decision;
  if (!decision) return null;
  const decisionId = randomUUID();
  const nextExecutionState = transition.patch.executionState;
  if (!nextExecutionState || typeof nextExecutionState !== "object") {
    throw new Error("Review escalation decision patch is missing executionState");
  }
  const updateFields: Record<string, unknown> = {
    ...transition.patch,
    executionState: {
      ...(nextExecutionState as Record<string, unknown>),
      lastDecisionId: decisionId,
    },
  };
  // A final-stage approval completes every execution stage; the engine leaves the
  // issue status untouched. SUP-17552: the escalation-accept door renders the
  // reviewer-approval path's `done` close here (the caller already ran the shared
  // done-transition guard); every other door keeps the return-assignee hand-back.
  if (requestedStatus === "done" && updateFields.status === undefined) {
    if (finalStageDisposition === "done") {
      updateFields.status = "done";
    } else {
      // A summary-generation card's approval hand-back must land on the Summarizer
      // (the only writer of its slot), never on a policy `returnAssigneeAgentId`
      // (SUP-15768). Ordinary issues resolve to null here, so they keep routing to
      // their stored return assignee.
      const returnAssignee =
        (await resolveSummaryGenerationReturnAssignee(db, issue)) ??
        existingState.returnAssignee ??
        null;
      updateFields.status = "in_progress";
      if (returnAssignee?.type === "agent") {
        updateFields.assigneeAgentId = returnAssignee.agentId ?? null;
        updateFields.assigneeUserId = null;
      } else if (returnAssignee?.type === "user") {
        updateFields.assigneeAgentId = null;
        updateFields.assigneeUserId = returnAssignee.userId ?? null;
      }
    }
  }
  updateFields.actorAgentId = actor.agentId ?? null;
  updateFields.actorUserId = actor.userId ?? null;

  // The `done` close writes into the same transaction as the decision row, so the
  // update needs a post-commit queue: issue-service refuses a human completion in
  // an external transaction without one (issues.ts). Drain both queues only after
  // the transaction commits.
  const activityPublications: ActivityPublication[] = [];
  const postCommitActions: IssuePostCommitAction[] = [];
  const updatedIssue = await db.transaction(async (tx) => {
    await tx.insert(issueExecutionDecisions).values({
      id: decisionId,
      companyId: issue.companyId,
      issueId: issue.id,
      stageId: decision.stageId,
      stageType: decision.stageType,
      actorAgentId: actor.agentId ?? null,
      actorUserId: actor.userId ?? null,
      outcome: decision.outcome,
      body: decision.body,
      createdByRunId: actor.runId ?? null,
    });
    return issueService(db).update(
      issue.id,
      updateFields,
      tx,
      activityPublications,
      postCommitActions,
    );
  });
  for (const publication of activityPublications) publishActivity(publication);
  await executeIssuePostCommitActions(db, postCommitActions);
  if (!updatedIssue) {
    throw new Error("Failed to update issue after review escalation decision");
  }

  return {
    id: issue.id,
    status: updateFields.status as string,
    assigneeAgentId: (updateFields.assigneeAgentId as string | null) ?? null,
    assigneeUserId: (updateFields.assigneeUserId as string | null) ?? null,
    decisionId,
    stageId: decision.stageId,
    stageType: decision.stageType,
    outcome: decision.outcome,
    issue: updatedIssue,
  };
}
