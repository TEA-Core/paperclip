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

/** The issue fields an `issue.deleted` activity records. */
export type DeletedIssueRecord = IssueAccessTarget & { identifier: string | null; title: string };

/**
 * The details an `issue.deleted` activity records: the issue's identifier and
 * title, and the columns its `issue:read` decision reads. Once the row is
 * gone, the live-event fan-out decides each subscriber's read from these
 * columns, so a subscriber that could read the issue still receives its title.
 */
export function deletedIssueActivityDetails(issue: DeletedIssueRecord): Record<string, unknown> {
  return {
    identifier: issue.identifier,
    title: issue.title,
    projectId: issue.projectId,
    parentId: issue.parentId,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    status: issue.status,
    createdByAgentId: issue.createdByAgentId,
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * The access target that an `issue.deleted` activity recorded (see
 * `deletedIssueActivityDetails`), or `null` when its details do not hold a
 * complete one.
 */
export function deletedIssueAccessTarget(
  details: Record<string, unknown>,
  issue: { id: string; companyId: string },
): IssueAccessTarget | null {
  const { projectId, parentId, assigneeAgentId, assigneeUserId, status, createdByAgentId } = details;
  if (
    typeof status !== "string"
    || !isNullableString(projectId)
    || !isNullableString(parentId)
    || !isNullableString(assigneeAgentId)
    || !isNullableString(assigneeUserId)
    || !isNullableString(createdByAgentId)
  ) {
    return null;
  }
  return {
    id: issue.id,
    companyId: issue.companyId,
    projectId,
    parentId,
    assigneeAgentId,
    assigneeUserId,
    status,
    createdByAgentId,
  };
}
