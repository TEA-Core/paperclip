import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { isUuidLike, type LiveEvent, type LiveEventType } from "@paperclipai/shared";
import { authorizationService, type AuthorizationActor } from "../services/authorization.js";
import { issueAccessDecisionInput, type IssueAccessTarget } from "../services/issue-access-input.js";
import {
  isRecord,
  issueEventMetadata,
  summarizedIssueIds,
  withoutUnreadableSummaryTitles,
} from "../services/issue-event-content.js";
import { createRunIssueLookup } from "../services/run-issue-lookup.js";

/**
 * How each live event type relates to issue content. The record is exhaustive,
 * so a new event type does not compile until it is classified here.
 * - `none`: carries no issue content; every subscriber receives it.
 * - `activity`: an activity entry; only one about an issue is filtered.
 * - `run`: a heartbeat run event about the run's issue.
 * - `goal`: a runner goal projection about its `issueId`.
 *
 * A subscriber that cannot read the event's issue receives only its metadata
 * (see `issueEventMetadata`). A run or goal event whose issue cannot be
 * resolved goes in full only to a subscriber with company-wide read
 * (`company_scope:read`, the check run telemetry applies), and as metadata
 * otherwise. Activity about other entities goes to every subscriber unchanged.
 */
const LIVE_EVENT_ISSUE_SCOPE: Record<LiveEventType, "none" | "activity" | "run" | "goal"> = {
  "heartbeat.run.queued": "none",
  "heartbeat.run.status": "run",
  "heartbeat.run.progress": "run",
  "heartbeat.run.event": "run",
  "heartbeat.run.log": "run",
  "agent.session.goal.changed": "goal",
  "agent.status": "none",
  "activity.logged": "activity",
  "external_object.updated": "none",
  "plugin.ui.updated": "none",
  "plugin.worker.crashed": "none",
  "plugin.worker.restarted": "none",
};

/**
 * How long one subscriber's read decision is reused. It bounds the decision
 * cost of bursts such as run log chunks; a lost grant, including a removed
 * instance-admin role, takes effect within this window.
 */
const READ_DECISION_TTL_MS = 1_000;
const READ_DECISION_CACHE_LIMIT = 512;
/** Decision-cache key of the company-wide read; never an issue id. */
const COMPANY_SCOPE = "company_scope";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Per-recipient issue visibility on the company live-events bus.
 *
 * A subscriber receives issue content only when `GET /issues/:id` would let
 * the same actor read that issue; the check is the route's own `issue:read`
 * decision, made again for every event (see `READ_DECISION_TTL_MS`).
 */
export function createLiveEventIssueVisibility(db: Db) {
  const access = authorizationService(db);
  const runIssueId = createRunIssueLookup(db);
  // The bus hands every subscriber the same event object, so one lookup per
  // event and issue serves all sockets of the company.
  const issueLoads = new WeakMap<LiveEvent, Map<string, Promise<IssueAccessTarget | null>>>();

  function loadIssue(event: LiveEvent, issueId: string) {
    let loads = issueLoads.get(event);
    if (!loads) {
      loads = new Map();
      issueLoads.set(event, loads);
    }
    let load = loads.get(issueId);
    if (!load) {
      load = isUuidLike(issueId)
        ? db
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
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null);
      loads.set(issueId, load);
    }
    return load;
  }

  /** The visibility filter for one subscriber, which holds its short-lived read decisions. */
  return function forRecipient(actor: AuthorizationActor) {
    const decisions = new Map<string, { allowed: Promise<boolean>; expiresAt: number }>();

    function cachedDecision(key: string, decide: () => Promise<boolean>): Promise<boolean> {
      // The HTTP actor middleware refuses an agent key that names no
      // responsible user, so such a key can read nothing at all.
      if (actor.type === "agent" && !actor.onBehalfOfUserId) return Promise.resolve(false);
      const now = Date.now();
      const cached = decisions.get(key);
      if (cached && cached.expiresAt > now) return cached.allowed;
      if (decisions.size >= READ_DECISION_CACHE_LIMIT) decisions.clear();
      const allowed = decide();
      decisions.set(key, { allowed, expiresAt: now + READ_DECISION_TTL_MS });
      allowed.catch(() => decisions.delete(key));
      return allowed;
    }

    function canReadIssue(event: LiveEvent, issueId: string): Promise<boolean> {
      return cachedDecision(issueId, () =>
        loadIssue(event, issueId).then(async (issue) =>
          issue
            ? (await access.decide({ actor, ...issueAccessDecisionInput(issue, "issue:read") })).allowed
            : false,
        ),
      );
    }

    function canReadCompany(event: LiveEvent): Promise<boolean> {
      return cachedDecision(COMPANY_SCOPE, async () =>
        (await access.decide({
          actor,
          action: "company_scope:read",
          resource: { type: "company", companyId: event.companyId },
        })).allowed,
      );
    }

    /** Whether the subscriber may receive the full event about `issueId`, or about no known issue. */
    function canReadEventIssue(event: LiveEvent, issueId: string | null): Promise<boolean> {
      return issueId ? canReadIssue(event, issueId) : canReadCompany(event);
    }

    async function visibleActivity(event: LiveEvent): Promise<LiveEvent> {
      const { entityType, entityId, details } = event.payload;
      if (!isRecord(details)) return event;
      if (entityType !== "issue" || typeof entityId !== "string" || entityId.length === 0) return event;
      // Without the issue row there is no reader to decide for, so the entry
      // keeps its identifiers and loses its details.
      if (!(await loadIssue(event, entityId))) return { ...event, payload: { ...event.payload, details: null } };
      const summarized = summarizedIssueIds(details);
      const [ownIssue, summarizedReadable] = await Promise.all([
        canReadIssue(event, entityId),
        Promise.all(summarized.map((issueId) => canReadIssue(event, issueId))),
      ]);
      const readable = new Set(summarized.filter((_, index) => summarizedReadable[index]));
      const summarizedIssue = (issueId: unknown) => typeof issueId === "string" && readable.has(issueId);
      const visible = ownIssue
        ? withoutUnreadableSummaryTitles(details, summarizedIssue)
        : issueEventMetadata(details, summarizedIssue);
      return visible === details ? event : { ...event, payload: { ...event.payload, details: visible } };
    }

    async function visibleRunOrGoal(event: LiveEvent, issueId: Promise<string | null>): Promise<LiveEvent> {
      if (await canReadEventIssue(event, await issueId)) return event;
      return { ...event, payload: issueEventMetadata(event.payload, () => false) };
    }

    /** The event as this subscriber may receive it, without the issue content it may not read. */
    return async function visibleLiveEvent(event: LiveEvent): Promise<LiveEvent> {
      switch (LIVE_EVENT_ISSUE_SCOPE[event.type]) {
        case "none":
          return event;
        case "activity":
          return visibleActivity(event);
        case "run":
          return visibleRunOrGoal(event, runIssueId(event.companyId, event.payload));
        case "goal":
          return visibleRunOrGoal(event, Promise.resolve(nonEmptyString(event.payload.issueId)));
        default:
          return { ...event, payload: {} };
      }
    };
  };
}
