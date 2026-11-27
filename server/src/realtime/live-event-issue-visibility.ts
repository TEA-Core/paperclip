import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { isUuidLike, type LiveEvent } from "@paperclipai/shared";
import { authorizationService, type AuthorizationActor } from "../services/authorization.js";
import { issueAccessDecisionInput, type IssueAccessTarget } from "../services/issue-access-input.js";

/** The issue an `activity.logged` event describes, when it describes one. */
function activityIssueId(event: LiveEvent): string | null {
  if (event.type !== "activity.logged") return null;
  const { entityType, entityId } = event.payload;
  return entityType === "issue" && typeof entityId === "string" && entityId.length > 0 ? entityId : null;
}

/**
 * Per-recipient visibility for issue activity on the company live-events bus.
 *
 * An issue's activity details carry its content (an `issue.created` entry
 * holds the title and description). A subscriber receives such an event only
 * when `GET /issues/:id` would let the same actor read that issue; the check
 * is the route's own `issue:read` decision. When the issue row cannot be
 * found (for example after a delete) the event keeps its identifiers but loses
 * its details, so no reader decision is needed to deliver it.
 */
export function createLiveEventIssueVisibility(db: Db) {
  const access = authorizationService(db);
  // The bus hands every subscriber the same event object, so one lookup per
  // event serves all sockets of the company.
  const issueLoads = new WeakMap<LiveEvent, Promise<IssueAccessTarget | null>>();

  function loadIssue(event: LiveEvent, issueId: string) {
    let load = issueLoads.get(event);
    if (!load) {
      load = db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          parentId: issues.parentId,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          status: issues.status,
          createdByAgentId: issues.createdByAgentId,
        })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, event.companyId)))
        .then((rows) => rows[0] ?? null);
      issueLoads.set(event, load);
    }
    return load;
  }

  /** The event as `actor` may receive it, or `null` when it must be withheld. */
  return async function visibleLiveEvent(actor: AuthorizationActor, event: LiveEvent): Promise<LiveEvent | null> {
    const issueId = activityIssueId(event);
    if (!issueId) return event;
    // The HTTP actor middleware refuses an agent key that names no
    // responsible user, so such a key can read no issue at all.
    if (actor.type === "agent" && !actor.onBehalfOfUserId) return null;
    const issue = isUuidLike(issueId) ? await loadIssue(event, issueId) : null;
    if (!issue) return { ...event, payload: { ...event.payload, details: null } };
    const decision = await access.decide({ actor, ...issueAccessDecisionInput(issue, "issue:read") });
    return decision.allowed ? event : null;
  };
}
