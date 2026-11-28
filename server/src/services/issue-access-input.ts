import type { AuthorizationResource } from "./authorization.js";

export type IssueAccessAction = "issue:comment" | "issue:read" | "issue:mutate";

/** The issue columns an issue-scoped authorization decision reads. */
export type IssueAccessTarget = {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  status: string;
  createdByAgentId: string | null;
};

/**
 * The resource and scope for an issue-scoped `authorization.decide()` call.
 *
 * The issue routes and the live-event fan-out both build their issue decisions
 * here, so a broadcast recipient is judged by exactly the check that
 * `GET /issues/:id` applies to the same actor.
 */
export function issueAccessDecisionInput(
  issue: IssueAccessTarget,
  action: IssueAccessAction,
  options: { allowCreatorDocumentWrite?: boolean } = {},
): { action: IssueAccessAction; resource: AuthorizationResource; scope: Record<string, unknown> } {
  return {
    action,
    resource: {
      type: "issue",
      companyId: issue.companyId,
      issueId: issue.id,
      projectId: issue.projectId,
      parentIssueId: issue.parentId,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      status: issue.status,
      createdByAgentId: issue.createdByAgentId,
    },
    scope: {
      issueId: issue.id,
      projectId: issue.projectId,
      parentIssueId: issue.parentId,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      createdByAgentId: issue.createdByAgentId,
      ...(options.allowCreatorDocumentWrite ? { issueDocumentWrite: true } : {}),
    },
  };
}
