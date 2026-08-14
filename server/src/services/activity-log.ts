import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentApiKeys, companies, heartbeatRuns, issues } from "@paperclipai/db";
import { isUuidLike, PLUGIN_EVENT_TYPES, type PluginEventType } from "@paperclipai/shared";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { publishLiveEvent } from "./live-events.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { sanitizeRecord } from "../redaction.js";
import { logger } from "../middleware/logger.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { instanceSettingsService } from "./instance-settings.js";

const PLUGIN_EVENT_SET: ReadonlySet<string> = new Set(PLUGIN_EVENT_TYPES);
const ACTIVITY_ACTION_TO_PLUGIN_EVENT: Readonly<Record<string, PluginEventType>> = {
  issue_comment_added: "issue.comment.created",
  issue_comment_created: "issue.comment.created",
  issue_document_created: "issue.document.created",
  issue_document_updated: "issue.document.updated",
  issue_document_deleted: "issue.document.deleted",
  issue_blockers_updated: "issue.relations.updated",
  issue_dependency_wake_rearm_cap_reached: "issue.dependency_wake_rearm_cap_reached",
  approval_approved: "approval.decided",
  approval_rejected: "approval.decided",
  approval_revision_requested: "approval.decided",
  budget_soft_threshold_crossed: "budget.incident.opened",
  budget_hard_threshold_crossed: "budget.incident.opened",
  budget_incident_resolved: "budget.incident.resolved",
};

let _pluginEventBus: PluginEventBus | null = null;

/** Wire the plugin event bus so domain events are forwarded to plugins. */
export function setPluginEventBus(bus: PluginEventBus): void {
  if (_pluginEventBus) {
    logger.warn("setPluginEventBus called more than once, replacing existing bus");
  }
  _pluginEventBus = bus;
}

/**
 * Resolve the plugin event type an activity-log `action` should be forwarded as, or `null`
 * when the action has no plugin-facing event. Actions that already name a plugin event pass
 * through; the rest are looked up in `ACTIVITY_ACTION_TO_PLUGIN_EVENT` in underscore form.
 */
export function eventTypeForActivityAction(action: string): PluginEventType | null {
  if (PLUGIN_EVENT_SET.has(action)) return action as PluginEventType;
  return ACTIVITY_ACTION_TO_PLUGIN_EVENT[action.replaceAll(".", "_")] ?? null;
}

export function publishPluginDomainEvent(event: PluginEvent): void {
  if (!_pluginEventBus) return;
  void _pluginEventBus.emit(event).then(({ errors }) => {
    for (const { pluginId, error } of errors) {
      logger.warn({ pluginId, eventType: event.eventType, err: error }, "plugin event handler failed");
    }
  }).catch(() => {});
}

export interface LogActivityInput {
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId?: string | null;
  runId?: string | null;
  agentApiKeyId?: string | null;
  issueId?: string | null;
  details?: Record<string, unknown> | null;
  responsibleUserIdOverride?: string | null;
}

export async function createActivityDetailsRedactor(db: Db) {
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  };
  return (details: Record<string, unknown> | null) => (
    details ? redactCurrentUserValue(sanitizeRecord(details), currentUserRedactionOptions) : null
  );
}

export async function redactActivityDetails(db: Db, details: Record<string, unknown> | null) {
  if (!details) return null;
  return (await createActivityDetailsRedactor(db))(details);
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Look up the run row `input.runId` points at, if any. Returns `null` when there is no
 * usable run id, and `{ row: null }` when the id is well-formed but no such run exists in
 * this database (which is what an `x-paperclip-run-id` minted against another instance
 * looks like — and what would otherwise blow up the `activity_log.run_id` foreign key).
 */
async function lookupActivityRun(db: Db, input: LogActivityInput) {
  const runId = readNonEmptyString(input.runId);
  if (!runId || !isUuidLike(runId)) return null;
  const row = await db
    .select({ responsibleUserId: heartbeatRuns.responsibleUserId })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, runId)))
    .then((rows) => rows[0] ?? null);
  return { runId, row };
}

async function resolveResponsibleUserIdWithRun(
  db: Db,
  input: LogActivityInput,
  run: Awaited<ReturnType<typeof lookupActivityRun>>,
) {
  const runResponsibleUserId = readNonEmptyString(run?.row?.responsibleUserId);
  if (runResponsibleUserId) return runResponsibleUserId;

  const issueIdCandidate = readNonEmptyString(input.issueId)
    ?? (input.entityType === "issue" ? readNonEmptyString(input.entityId) : null);
  const issueId = isUuidLike(issueIdCandidate) ? issueIdCandidate : null;
  if (issueId) {
    const issue = await db
      .select({
        responsibleUserId: issues.responsibleUserId,
        createdByUserId: issues.createdByUserId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, issueId)))
      .then((rows) => rows[0] ?? null);
    const issueResponsibleUserId = readNonEmptyString(issue?.responsibleUserId)
      ?? readNonEmptyString(issue?.createdByUserId);
    if (issueResponsibleUserId) return issueResponsibleUserId;
  }

  const agentApiKeyId = readNonEmptyString(input.agentApiKeyId);
  const agentId = readNonEmptyString(input.agentId);
  if (agentApiKeyId && isUuidLike(agentApiKeyId)) {
    const apiKey = await db
      .select({ responsibleUserId: agentApiKeys.responsibleUserId })
      .from(agentApiKeys)
      .where(and(
        eq(agentApiKeys.companyId, input.companyId),
        eq(agentApiKeys.id, agentApiKeyId),
        ...(agentId && isUuidLike(agentId) ? [eq(agentApiKeys.agentId, agentId)] : []),
      ))
      .then((rows) => rows[0] ?? null);
    const apiKeyResponsibleUserId = readNonEmptyString(apiKey?.responsibleUserId);
    if (apiKeyResponsibleUserId) return apiKeyResponsibleUserId;
  }

  const company = await db
    .select({ defaultResponsibleUserId: companies.defaultResponsibleUserId })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .then((rows) => rows[0] ?? null);
  return readNonEmptyString(company?.defaultResponsibleUserId);
}

export async function resolveResponsibleUserIdForActivity(db: Db, input: LogActivityInput) {
  if (input.responsibleUserIdOverride !== undefined) {
    return readNonEmptyString(input.responsibleUserIdOverride);
  }
  if (input.actorType === "user") return readNonEmptyString(input.actorId);
  return resolveResponsibleUserIdWithRun(db, input, await lookupActivityRun(db, input));
}

async function writeActivity(db: Db, input: LogActivityInput) {
  const redactedDetails = await redactActivityDetails(db, input.details ?? null);
  const run = await lookupActivityRun(db, input);
  const responsibleUserId = input.responsibleUserIdOverride !== undefined
    ? readNonEmptyString(input.responsibleUserIdOverride)
    : input.actorType === "user"
      ? readNonEmptyString(input.actorId)
      : await resolveResponsibleUserIdWithRun(db, input, run);
  // Only stamp run_id when the run actually exists here; a dangling reference would trip the
  // `activity_log_run_id_heartbeat_runs_id_fk` foreign key and cost us the whole audit row.
  const runId = run?.row ? run.runId : null;
  if (run && !run.row) {
    logger.warn(
      {
        companyId: input.companyId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        runId: run.runId,
      },
      "activity log references an unknown run; recording the entry without a run id",
    );
  }
  const [activity] = await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    runId,
    responsibleUserId,
    details: redactedDetails,
  }).returning({ id: activityLog.id });

  publishLiveEvent({
    companyId: input.companyId,
    type: "activity.logged",
    payload: {
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      agentId: input.agentId ?? null,
      runId,
      responsibleUserId,
      details: redactedDetails,
    },
  });

  const pluginEventType = eventTypeForActivityAction(input.action);
  if (pluginEventType) {
    const event: PluginEvent = {
      eventId: randomUUID(),
      eventType: pluginEventType,
      occurredAt: new Date().toISOString(),
      actorId: input.actorId,
      actorType: input.actorType,
      entityId: input.entityId,
      entityType: input.entityType,
      companyId: input.companyId,
      payload: {
        ...redactedDetails,
        agentId: input.agentId ?? null,
        runId,
        responsibleUserId,
      },
    };
    publishPluginDomainEvent(event);
  }

  return activity;
}

/**
 * Record an audit entry. Best-effort by design: nearly every caller runs *after* its mutation
 * has already committed, so letting an audit failure propagate would turn a successful write
 * into an HTTP 500 — and a client that correctly retries on 500 then double-posts. A failed
 * audit write is logged with the entity it belonged to instead (SUP-9856).
 *
 * Callers running inside a transaction must use {@link logActivityInTransaction}.
 */
export async function logActivity(db: Db, input: LogActivityInput) {
  try {
    return await writeActivity(db, input);
  } catch (err) {
    logger.error(
      {
        err,
        companyId: input.companyId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        issueId: input.issueId ?? null,
        actorType: input.actorType,
        actorId: input.actorId,
        agentId: input.agentId ?? null,
        runId: input.runId ?? null,
      },
      "activity log write failed; the audited mutation is unaffected",
    );
  }
}

/**
 * Transaction-scoped variant that propagates failures. Swallowing an error inside a
 * transaction is not an option: Postgres marks the transaction aborted, so every later
 * statement fails anyway with a far less useful error. Here the audit entry and the mutation
 * share a fate, which is exactly the guarantee a caller opens a transaction for.
 */
export async function logActivityInTransaction(tx: Db, input: LogActivityInput) {
  return writeActivity(tx, input);
}
