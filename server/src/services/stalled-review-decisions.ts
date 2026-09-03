import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import type { StalledReviewDecisionAction } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { issueService } from "./issues.js";

export interface StalledReviewDecisionActor {
  userId: string;
  runId?: string | null;
}

export interface DecideStalledReviewInput {
  issueId: string;
  companyId: string;
  action: StalledReviewDecisionAction;
  note?: string;
  actor: StalledReviewDecisionActor;
}

// When a review escalates to a human hold, the assignment moves off the agent
// (assigneeAgentId is cleared) and the escalation preserves the agent the card
// should return to as executionState.returnAssignee. Read that agent id back out
// so a send-back can land the issue on a real assignee instead of a null one
// (SUP-14806). Returns null when there is no agent return assignee.
export function executionStateReturnAssigneeAgentId(executionState: unknown): string | null {
  const state = executionState && typeof executionState === "object" && !Array.isArray(executionState)
    ? executionState as Record<string, unknown>
    : null;
  const principal = state?.returnAssignee;
  if (!principal || typeof principal !== "object" || Array.isArray(principal)) return null;
  const record = principal as Record<string, unknown>;
  return record.type === "agent" && typeof record.agentId === "string" && record.agentId.length > 0
    ? record.agentId
    : null;
}

export function stalledReviewDecisionService(db: Db) {
  return {
    decide: async (input: DecideStalledReviewInput) => db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const lockedIssue = await tx
        .select()
        .from(issues)
        .where(and(
          eq(issues.id, input.issueId),
          eq(issues.companyId, input.companyId),
          visibleIssueCondition(),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);

      if (!lockedIssue) throw notFound("Issue not found");
      if (lockedIssue.status !== "in_review") {
        throw conflict("Issue is no longer a stalled review", {
          issueId: lockedIssue.id,
          currentStatus: lockedIssue.status,
        });
      }

      const svc = issueService(txDb);
      const reviewAttention = await svc
        .listReviewAttention(lockedIssue.companyId, [lockedIssue])
        .then((rows) => rows.get(lockedIssue.id));
      if (reviewAttention?.state !== "stalled") {
        throw conflict("Issue is no longer a stalled review", {
          issueId: lockedIssue.id,
          reviewAttentionState: reviewAttention?.state ?? "none",
        });
      }

      const comment = input.note
        ? await svc.addComment(
            lockedIssue.id,
            input.note,
            { userId: input.actor.userId, runId: input.actor.runId ?? null },
            { authorType: "user" },
            tx,
          )
        : null;
      const status = input.action === "approve" ? "done" : "todo";
      const updateData: {
        status: "done" | "todo";
        actorUserId: string;
        assigneeAgentId?: string;
        assigneeUserId?: string | null;
      } = {
        status,
        actorUserId: input.actor.userId,
      };
      // A send-back on an escalated hold has no agent assignee left (the card is
      // parked on a human). Reassign it to the agent the escalation preserved as
      // the return assignee and clear the user assignee so the "one assignee"
      // invariant holds. This gives the post-commit wake a real agent to wake and
      // lands the card in `todo` on the agent it should return to (SUP-14806).
      // Guarded to the escalated-hold shape so ordinary in_review issues with an
      // agent assignee keep their existing send-back behavior.
      if (input.action !== "approve" && !lockedIssue.assigneeAgentId && lockedIssue.assigneeUserId) {
        const returnAssigneeAgentId = executionStateReturnAssigneeAgentId(lockedIssue.executionState);
        if (returnAssigneeAgentId) {
          updateData.assigneeAgentId = returnAssigneeAgentId;
          updateData.assigneeUserId = null;
        }
      }
      const updated = await svc.update(lockedIssue.id, updateData, tx);
      if (!updated) throw notFound("Issue not found");

      if (comment) {
        await logActivity(txDb, {
          companyId: updated.companyId,
          actorType: "user",
          actorId: input.actor.userId,
          runId: input.actor.runId ?? null,
          action: "issue.comment_added",
          entityType: "issue",
          entityId: updated.id,
          issueId: updated.id,
          details: {
            commentId: comment.id,
            authorUserId: input.actor.userId,
            source: "stalled_review_decision",
          },
        });
      }
      await logActivity(txDb, {
        companyId: updated.companyId,
        actorType: "user",
        actorId: input.actor.userId,
        runId: input.actor.runId ?? null,
        action: "issue.stalled_review_decided",
        entityType: "issue",
        entityId: updated.id,
        issueId: updated.id,
        details: {
          action: input.action,
          status,
          identifier: updated.identifier,
          commentId: comment?.id ?? null,
          authorUserId: comment ? input.actor.userId : null,
          _previous: { status: lockedIssue.status },
        },
      });

      return { issue: updated, comment };
    }),
  };
}
