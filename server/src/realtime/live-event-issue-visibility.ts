import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";
import { isUuidLike, type LiveEvent, type LiveEventType } from "@paperclipai/shared";
import { authorizationService, type AuthorizationActor } from "../services/authorization.js";
import { issueAccessDecisionInput, type IssueAccessTarget } from "../services/issue-access-input.js";
import {
  isIssueDocumentEvent,
  isRecord,
  summarizedIssueIds,
  withoutUnreadableIssueContent,
} from "../services/issue-event-content.js";

/**
 * How each live event type relates to issue content. The record is exhaustive,
 * so a new event type does not compile until it is classified here.
 * - `none`: carries no issue content; every subscriber receives it.
 * - `activity`: an activity entry; issue entries lose the content the
 *   subscriber cannot read and keep their identifiers and metadata.
 * - `goal`: a runner goal projection; a subscriber that cannot read its issue
 *   receives it without the goal's objective and last reason.
 * - a field list: a heartbeat run event; a subscriber that cannot read the
 *   run's issue receives it with these output fields set to `null`.
 */
const LIVE_EVENT_ISSUE_SCOPE: Record<LiveEventType, "none" | "activity" | "goal" | readonly string[]> = {
  "heartbeat.run.queued": "none",
  "heartbeat.run.status": ["error", "finalText"],
  "heartbeat.run.progress": ["message", "lastAssistantSnippet"],
  "heartbeat.run.event": ["message", "error", "lastAssistantSnippet", "payload"],
  "heartbeat.run.log": ["chunk"],
  "agent.session.goal.changed": "goal",
  "agent.status": "none",
  "activity.logged": "activity",
  "external_object.updated": "none",
  "plugin.ui.updated": "none",
  "plugin.worker.crashed": "none",
  "plugin.worker.restarted": "none",
};

/**
 * How long one subscriber's read decision for an issue is reused. It bounds
 * the decision cost of bursts such as run log chunks; a lost grant, including
 * a removed instance-admin role, takes effect within this window.
 */
const READ_DECISION_TTL_MS = 1_000;
const READ_DECISION_CACHE_LIMIT = 512;
const RUN_ISSUE_CACHE_LIMIT = 1_024;

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
  // The bus hands every subscriber the same event object, so one lookup per
  // event and issue serves all sockets of the company.
  const issueLoads = new WeakMap<LiveEvent, Map<string, Promise<IssueAccessTarget | null>>>();
  // A run's issue does not change, so one lookup serves every event of the run.
  const runIssueLoads = new Map<string, Promise<string | null>>();

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

  /** The issue a run event concerns: its payload names it, or the run's context does. */
  function loadRunIssueId(event: LiveEvent): Promise<string | null> {
    const named = nonEmptyString(event.payload.issueId);
    if (named) return Promise.resolve(named);
    const runId = nonEmptyString(event.payload.runId);
    if (!runId || !isUuidLike(runId)) return Promise.resolve(null);
    const key = `${event.companyId}:${runId}`;
    let load = runIssueLoads.get(key);
    if (!load) {
      if (runIssueLoads.size >= RUN_ISSUE_CACHE_LIMIT) runIssueLoads.clear();
      load = db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, event.companyId)))
        .then((rows) => nonEmptyString(rows[0]?.contextSnapshot?.issueId));
      runIssueLoads.set(key, load);
      load.catch(() => runIssueLoads.delete(key));
    }
    return load;
  }

  /** The visibility filter for one subscriber, which holds its short-lived read decisions. */
  return function forRecipient(actor: AuthorizationActor) {
    const decisions = new Map<string, { allowed: Promise<boolean>; expiresAt: number }>();

    function canReadIssue(event: LiveEvent, issueId: string): Promise<boolean> {
      // The HTTP actor middleware refuses an agent key that names no
      // responsible user, so such a key can read no issue at all.
      if (actor.type === "agent" && !actor.onBehalfOfUserId) return Promise.resolve(false);
      const now = Date.now();
      const cached = decisions.get(issueId);
      if (cached && cached.expiresAt > now) return cached.allowed;
      if (decisions.size >= READ_DECISION_CACHE_LIMIT) decisions.clear();
      const allowed = loadIssue(event, issueId).then(async (issue) =>
        issue
          ? (await access.decide({ actor, ...issueAccessDecisionInput(issue, "issue:read") })).allowed
          : false,
      );
      decisions.set(issueId, { allowed, expiresAt: now + READ_DECISION_TTL_MS });
      allowed.catch(() => decisions.delete(issueId));
      return allowed;
    }

    async function visibleActivity(event: LiveEvent): Promise<LiveEvent> {
      const { entityType, entityId, details } = event.payload;
      if (entityType !== "issue" || typeof entityId !== "string" || entityId.length === 0) return event;
      // Without the issue row there is no reader to decide for, so the entry
      // keeps its identifiers and loses its details.
      if (!(await loadIssue(event, entityId))) return { ...event, payload: { ...event.payload, details: null } };
      if (!isRecord(details)) return event;
      const summarized = summarizedIssueIds(details);
      const [ownIssue, summarizedReadable] = await Promise.all([
        canReadIssue(event, entityId),
        Promise.all(summarized.map((issueId) => canReadIssue(event, issueId))),
      ]);
      const readable = new Set(summarized.filter((_, index) => summarizedReadable[index]));
      const visible = withoutUnreadableIssueContent(
        details,
        { ownIssue, summarizedIssue: (issueId) => typeof issueId === "string" && readable.has(issueId) },
        isIssueDocumentEvent(event.payload.action),
      );
      return visible === details ? event : { ...event, payload: { ...event.payload, details: visible } };
    }

    async function visibleRunEvent(event: LiveEvent, contentFields: readonly string[]): Promise<LiveEvent> {
      const present = contentFields.filter((field) => event.payload[field] != null);
      if (present.length === 0) return event;
      const issueId = await loadRunIssueId(event);
      if (!issueId || (await canReadIssue(event, issueId))) return event;
      const payload = { ...event.payload };
      for (const field of present) payload[field] = null;
      return { ...event, payload };
    }

    async function visibleGoal(event: LiveEvent): Promise<LiveEvent> {
      const { goal } = event.payload;
      const issueId = nonEmptyString(event.payload.issueId);
      if (!isRecord(goal) || !issueId || (await canReadIssue(event, issueId))) return event;
      return { ...event, payload: { ...event.payload, goal: { ...goal, objective: null, lastReason: null } } };
    }

    /** The event as this subscriber may receive it, without the issue content it may not read. */
    return async function visibleLiveEvent(event: LiveEvent): Promise<LiveEvent> {
      const scope = LIVE_EVENT_ISSUE_SCOPE[event.type];
      if (scope === "none") return event;
      if (scope === "activity") return visibleActivity(event);
      if (scope === "goal") return visibleGoal(event);
      return visibleRunEvent(event, scope);
    };
  };
}
