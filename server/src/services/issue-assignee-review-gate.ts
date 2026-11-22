import { normalizeAgentUrlKey, type IssueExecutionStage } from "@paperclipai/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, pluginEntities, pluginManagedResources, plugins } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import {
  type RefusalCaller,
  type RefusalIssue,
  resolveCallerSeat,
  seatAuthorityNextAction,
} from "./seat-authority-refusal.js";

export interface SelfSatisfyingReviewStageFinding {
  stageId: string;
  stageType: string;
  assigneeAgentId: string;
  participantsExcludingAssignee: number;
  approvalsNeeded: number;
}

function stageApprovalsNeeded(stage: unknown): number {
  const raw =
    stage && typeof stage === "object"
      ? (stage as { approvalsNeeded?: unknown }).approvalsNeeded
      : undefined;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

/**
 * SUP-13526 — detect an `assigneeAgentId` write that would make an incomplete
 * review stage self-satisfiable: the incoming assignee is a participant of the
 * stage and the remaining participants cannot reach `approvalsNeeded` without
 * the assignee approving their own work.
 *
 * Conditions (reject iff all hold for some stage S):
 *   1. S is a `review` stage whose id is not in `completedStageIds` nor
 *      `skippedStageIds`;
 *   2. the incoming `assigneeAgentId` is a participant of S;
 *   3. `count(S.participants excluding the incoming assignee) < S.approvalsNeeded`.
 *
 * The predicate reads the stored policy structurally instead of re-normalizing
 * it through the API input schema: the schema pins `approvalsNeeded` to the
 * literal 1 today, and the gate must keep working (and stay testable) if that
 * widens to N approvals. Stages are read as-is; a malformed row simply yields
 * no finding so a bad stored row cannot wedge the reassignment.
 *
 * Runtime stage-transition assignee writes (a review start selecting its active
 * participant) are NOT explicit assignee writes and are exempt by construction:
 * callers only invoke this for request-level `assigneeAgentId` writes and
 * recovery reassignments.
 */
export function findSelfSatisfyingReviewStage(input: {
  executionPolicy: unknown;
  executionState: unknown;
  incomingAssigneeAgentId: string | null | undefined;
}): SelfSatisfyingReviewStageFinding | null {
  const assigneeAgentId = input.incomingAssigneeAgentId;
  if (typeof assigneeAgentId !== "string" || assigneeAgentId.length === 0) return null;
  const policy = input.executionPolicy as
    | { stages?: unknown }
    | null
    | undefined;
  if (!policy || typeof policy !== "object" || !Array.isArray(policy.stages)) {
    return null;
  }
  const state = parseIssueExecutionState(input.executionState);
  const completedStageIds = new Set(state?.completedStageIds ?? []);
  const skippedStageIds = new Set(state?.skippedStageIds ?? []);
  for (const rawStage of policy.stages) {
    if (!rawStage || typeof rawStage !== "object") continue;
    const stage = rawStage as Pick<IssueExecutionStage, "id" | "type"> & {
      participants?: unknown;
    };
    if (stage.type !== "review") continue;
    if (typeof stage.id !== "string") continue;
    if (completedStageIds.has(stage.id) || skippedStageIds.has(stage.id)) continue;
    const participants = Array.isArray(stage.participants) ? stage.participants : [];
    const isParticipant = participants.some(
      (participant) =>
        participant &&
        typeof participant === "object" &&
        participant.type === "agent" &&
        participant.agentId === assigneeAgentId,
    );
    if (!isParticipant) continue;
    const participantsExcludingAssignee = participants.filter(
      (participant) =>
        !(
          participant &&
          typeof participant === "object" &&
          participant.type === "agent" &&
          participant.agentId === assigneeAgentId
        ),
    ).length;
    if (participantsExcludingAssignee < stageApprovalsNeeded(rawStage)) {
      return {
        stageId: stage.id,
        stageType: stage.type,
        assigneeAgentId,
        participantsExcludingAssignee,
        approvalsNeeded: stageApprovalsNeeded(rawStage),
      };
    }
  }
  return null;
}

/**
 * Route-level guard: throws 422 when the explicit `assigneeAgentId` write would
 * land a self-satisfiable review stage. The 422 body names the offending stage
 * id and the participant collision so the caller can act.
 */
export function assertAssigneeWriteDoesNotSelfSatisfyReviewStage(input: {
  executionPolicy: unknown;
  executionState: unknown;
  incomingAssigneeAgentId: string | null | undefined;
  /**
   * Board ruling 2026-10-02 (F1): the writer and the issue as stored. When
   * present the 422 names the caller's seat and points to the owning doctrine
   * section after the unchanged message. Absent (the recovery service, or a board caller)
   * it is unchanged.
   */
  refusalContext?: { caller: RefusalCaller; issue: RefusalIssue | null };
}): void {
  const finding = findSelfSatisfyingReviewStage(input);
  if (!finding) return;
  const message = `Refusing assigneeAgentId write: ${finding.assigneeAgentId} is a participant of incomplete review stage ${finding.stageId} and the write would make the stage self-satisfiable, because it cannot be cleared without the assignee approving their own work (participants excluding the assignee: ${finding.participantsExcludingAssignee}, approvalsNeeded: ${finding.approvalsNeeded})`;
  const details: Record<string, unknown> = {
    guard: "assignee_review_gate",
    issueStageId: finding.stageId,
    stageType: finding.stageType,
    assigneeAgentId: finding.assigneeAgentId,
    participantsExcludingAssignee: finding.participantsExcludingAssignee,
    approvalsNeeded: finding.approvalsNeeded,
  };
  if (!input.refusalContext) throw unprocessable(message, details);
  const callerSeat = resolveCallerSeat(input.refusalContext.caller, input.refusalContext.issue);
  const nextAction = seatAuthorityNextAction(callerSeat);
  throw unprocessable(`${message}. ${nextAction}`, { ...details, callerSeat, nextAction });
}

export const WIKI_LLM_WIKI_PLUGIN_KEY = "paperclipai.plugin-llm-wiki" as const;
export const WIKI_MAINTAINER_AGENT_KEY = "wiki-maintainer" as const;

export function isWikiHandoffTitle(title: unknown): boolean {
  return (
    typeof title === "string" &&
    title.trim().toLowerCase().includes("handoff to wiki maintainer")
  );
}

const WIKI_MAINTAINER_QUALIFIED_RESOURCE_KEY =
  `${WIKI_LLM_WIKI_PLUGIN_KEY}:agent:${WIKI_MAINTAINER_AGENT_KEY}` as const;

export const AMBIGUOUS_WIKI_MAINTAINER_AGENT_ID = "ambiguous-wiki-maintainer" as const;
const UNRESOLVED_WIKI_MAINTAINER_AGENT_ID = "unresolved-wiki-maintainer";

function metadataMarksWikiMaintainer(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  return [record.paperclipManagedResource, record.pluginManagedAgent].some((marker) => {
    if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
    const row = marker as Record<string, unknown>;
    const agentKey = row.agentKey ?? row.resourceKey;
    const resourceKind = row.resourceKind;
    return (
      row.pluginKey === WIKI_LLM_WIKI_PLUGIN_KEY &&
      agentKey === WIKI_MAINTAINER_AGENT_KEY &&
      (resourceKind === undefined || resourceKind === "agent")
    );
  });
}

/**
 * Row locks cannot cover an agent that does not exist yet. The metadata
 * fallback therefore takes this company-scoped advisory lock (shared) before
 * it scans agents. Every agent creation, and every agent update that changes
 * `metadata.pluginManagedAgent`, takes it (exclusive) before writing. No new candidate
 * can appear before the guarded issue UPDATE commits. Acquire it before any
 * agent row lock so all writers share one lock order.
 */
export async function lockWikiMaintainerResolution(
  db: Db,
  companyId: string,
  mode: "shared" | "exclusive",
): Promise<void> {
  const key = `wiki-maintainer-resolution:${companyId}`;
  await db.execute(
    mode === "shared"
      ? sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`
      : sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

function bindingAgentId(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.pluginKey !== undefined && record.pluginKey !== WIKI_LLM_WIKI_PLUGIN_KEY) return null;
  if (record.resourceKey !== undefined && record.resourceKey !== WIKI_MAINTAINER_AGENT_KEY) return null;
  return typeof record.agentId === "string" && record.agentId.length > 0 ? record.agentId : null;
}

export async function resolveCanonicalWikiMaintainerAgentId(
  db: Db,
  companyId: string,
  issue: { title?: string | null; description?: string | null } | null | undefined,
  options?: { lockRows?: boolean; requireAvailable?: boolean },
): Promise<string | null> {
  if (!issue?.title?.trim() && !issue?.description?.trim()) return null;
  if (!isWikiHandoffTitle(issue.title)) return null;
  // The service guard holds these locks on its issue-update transaction.
  // Preflight callers do not lock; the service repeats their check at commit.
  const resourceQuery = db
    .select({
      resourceKey: pluginManagedResources.resourceKey,
      resourceId: pluginManagedResources.resourceId,
    })
    .from(pluginManagedResources)
    .where(and(
      eq(pluginManagedResources.companyId, companyId),
      eq(pluginManagedResources.pluginKey, WIKI_LLM_WIKI_PLUGIN_KEY),
      eq(pluginManagedResources.resourceKind, "agent"),
      inArray(pluginManagedResources.resourceKey, [
        WIKI_MAINTAINER_AGENT_KEY,
        WIKI_MAINTAINER_QUALIFIED_RESOURCE_KEY,
      ]),
    ));
  const bindingQuery = db
    .select({ data: pluginEntities.data })
    .from(pluginEntities)
    .innerJoin(plugins, eq(pluginEntities.pluginId, plugins.id))
    .where(and(
      eq(pluginEntities.companyId, companyId),
      eq(pluginEntities.entityType, "managed_agent"),
      eq(pluginEntities.externalId, `managed:agent:${companyId}:${WIKI_MAINTAINER_AGENT_KEY}`),
      eq(plugins.pluginKey, WIKI_LLM_WIKI_PLUGIN_KEY),
    ));
  const [resourceRows, bindings] = await Promise.all([
    options?.lockRows ? resourceQuery.for("share") : resourceQuery,
    options?.lockRows ? bindingQuery.for("share") : bindingQuery,
  ]);
  const resourceId = resourceRows.find((row) => row.resourceKey === WIKI_MAINTAINER_AGENT_KEY)?.resourceId
    ?? resourceRows[0]?.resourceId
    ?? null;
  const boundIds = bindings.map((row) => bindingAgentId(row.data)).filter((id): id is string => id !== null);
  const candidateIds = [resourceId, ...boundIds].filter((id): id is string => id !== null);
  const candidateQuery = db
    .select({ id: agents.id, metadata: agents.metadata, status: agents.status })
    .from(agents)
    .where(and(
      eq(agents.companyId, companyId),
      ne(agents.status, "terminated"),
      inArray(agents.id, candidateIds),
    ));
  const liveCandidates = candidateIds.length === 0
    ? []
    : await (options?.lockRows ? candidateQuery.for("share") : candidateQuery);
  const isAvailable = (status: string) => !options?.requireAvailable || status !== "paused";
  if (liveCandidates.length > 0) {
    const markedById = new Map(liveCandidates
      .filter((agent) => metadataMarksWikiMaintainer(agent.metadata))
      .map((agent) => [agent.id, agent]));
    const resolved = candidateIds.map((id) => markedById.get(id)).find((agent) => agent !== undefined);
    if (resolved && isAvailable(resolved.status)) return resolved.id;
    return UNRESOLVED_WIKI_MAINTAINER_AGENT_ID;
  }
  if (options?.lockRows) await lockWikiMaintainerResolution(db, companyId, "shared");
  const fallbackQuery = db
    .select({ id: agents.id, metadata: agents.metadata, status: agents.status })
    .from(agents)
    .where(and(
      eq(agents.companyId, companyId),
      ne(agents.status, "terminated"),
    ));
  const liveAgents = await (options?.lockRows ? fallbackQuery.for("share") : fallbackQuery);
  const marked = liveAgents.filter((agent) => metadataMarksWikiMaintainer(agent.metadata));
  if (marked.length === 1) {
    return isAvailable(marked[0]!.status) ? marked[0]!.id : UNRESOLVED_WIKI_MAINTAINER_AGENT_ID;
  }
  if (marked.length > 1) return AMBIGUOUS_WIKI_MAINTAINER_AGENT_ID;
  return candidateIds.length > 0 ? UNRESOLVED_WIKI_MAINTAINER_AGENT_ID : null;
}

type WikiHandoffSource = {
  title?: string | null;
  description?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
};

async function isReporterHandoffSource(
  db: Db,
  companyId: string,
  issue: WikiHandoffSource | null | undefined,
  lockRows = false,
): Promise<boolean> {
  if (
    !issue?.createdByAgentId ||
    issue.createdByUserId != null ||
    !isWikiHandoffTitle(issue.title)
  ) return false;
  // Legacy Reporter handoffs have manual origins. Resolve the stored creator,
  // not a caller's title or a hardcoded instance-specific agent id.
  const query = db.select({ name: agents.name }).from(agents).where(and(
    eq(agents.companyId, companyId),
    eq(agents.id, issue.createdByAgentId),
    eq(agents.role, "pm"),
  )).limit(1);
  const [creator] = await (lockRows ? query.for("share") : query);
  return normalizeAgentUrlKey(creator?.name) === "writer-reporter";
}

/**
 * Adoption requires a recognized Reporter-created handoff and a marked,
 * non-paused live Maintainer. Sentinels must never become an assignee id.
 */
export async function resolveLiveCanonicalWikiMaintainerAgentId(
  db: Db,
  companyId: string,
  issue: WikiHandoffSource | null | undefined,
): Promise<string | null> {
  if (!await isReporterHandoffSource(db, companyId, issue)) return null;
  const resolved = await resolveCanonicalWikiMaintainerAgentId(db, companyId, issue, { requireAvailable: true });
  if (
    !resolved ||
    resolved === AMBIGUOUS_WIKI_MAINTAINER_AGENT_ID ||
    resolved === UNRESOLVED_WIKI_MAINTAINER_AGENT_ID
  ) return null;
  return resolved;
}

function isWorkflowControlledPendingReviewParticipant(input: {
  executionPolicy: unknown;
  executionState: unknown;
  incomingAssigneeAgentId: string | null;
  workflowControlledAssignment?: boolean;
}): boolean {
  if (input.workflowControlledAssignment !== true) return false;
  const state = parseIssueExecutionState(input.executionState);
  if (
    state?.status !== "pending" ||
    typeof state.currentStageIndex !== "number" ||
    state.currentStageType !== "review"
  ) return false;
  const currentParticipant = state.currentParticipant;
  if (currentParticipant?.type === "agent") {
    if (currentParticipant.agentId !== input.incomingAssigneeAgentId) return false;
  } else if (currentParticipant?.type === "user") {
    if (input.incomingAssigneeAgentId !== null) return false;
  } else {
    return false;
  }
  const policy = input.executionPolicy as { stages?: unknown } | null | undefined;
  if (!policy || typeof policy !== "object" || !Array.isArray(policy.stages)) return false;
  const rawStage = policy.stages[state.currentStageIndex];
  if (!rawStage || typeof rawStage !== "object") return false;
  const stage = rawStage as Pick<IssueExecutionStage, "id" | "type"> & { participants?: unknown };
  if (
    stage.type !== "review" ||
    stage.id !== state.currentStageId ||
    state.completedStageIds.includes(stage.id) ||
    state.skippedStageIds?.includes(stage.id)
  ) return false;
  return Array.isArray(stage.participants) && stage.participants.some((participant) => {
    if (!participant || typeof participant !== "object") return false;
    if (currentParticipant.type === "agent") {
      return participant.type === "agent" && participant.agentId === currentParticipant.agentId;
    }
    return participant.type === "user" && participant.userId === currentParticipant.userId;
  });
}

/**
 * SUP-24280: the one write the Wiki handoff guard admits without the canonical
 * Maintainer as the resulting assignee. The emitter must be able to cancel a
 * half-emitted handoff stub that nobody owns, and the cancellation must leave
 * the row unowned. All conditions hold together:
 * - the write persists status `cancelled`;
 * - the write carries no assignee field (`assigneeAgentId`/`assigneeUserId`),
 *   including one a workflow transition adds;
 * - the stored row has no agent and no user assignee (both exactly null).
 * With no assignee field written, the resulting row keeps the stored null
 * assignees. Any assignee write, any other status, any owned row, and any
 * unknown (undefined) stored assignee stay guarded.
 */
export function isUnassignedWikiHandoffCancellation(input: {
  requestedStatus: unknown;
  assigneeFieldWritten: boolean;
  currentAssigneeAgentId: string | null | undefined;
  currentAssigneeUserId: string | null | undefined;
}): boolean {
  return (
    input.requestedStatus === "cancelled" &&
    input.assigneeFieldWritten === false &&
    input.currentAssigneeAgentId === null &&
    input.currentAssigneeUserId === null
  );
}

// Request attribution an issue write carries without setting an issue field.
const ISSUE_WRITE_ATTRIBUTION_KEYS: ReadonlySet<string> = new Set([
  "actorAgentId",
  "actorRunId",
  "actorRunStopId",
  "actorUserId",
  "boardApiKeyId",
  "expectedUpdatedAt",
]);

/**
 * SUP-24762: true when an issue write sets no issue field: every present key
 * is undefined or request attribution. A comment-only PATCH is such a write.
 * It cannot change who holds a Wiki handoff or what the handoff is, so the
 * Wiki handoff guard must not judge the stored assignee as if it were written
 * (a human reviewer's seat stores assigneeAgentId null). A write with any
 * other key, including null values and bookkeeping keys, is not field-less.
 */
export function isFieldlessIssueWrite(data: Record<string, unknown>): boolean {
  return Object.entries(data).every(
    ([key, value]) => value === undefined || ISSUE_WRITE_ATTRIBUTION_KEYS.has(key),
  );
}

/**
 * SUP-24632: the second and only other write the Wiki handoff guard admits
 * without the canonical Maintainer as the resulting assignee. The board stage
 * decision (`POST /issues/:id/execution-stage/board-decision`) closing the final
 * stage of an unowned handoff hands the card back to a null return-to; nobody is
 * assigned before or after. All conditions hold together:
 * - the caller marks the write as that route's decision (the guard's
 *   `boardStageDecision` input, fed by an internal field no request schema accepts);
 * - the write carries no assignee field (`assigneeAgentId`/`assigneeUserId`);
 * - the stored row has no agent and no user assignee (both exactly null).
 * With no assignee field written, the row keeps its stored null assignees, so
 * the exemption can only leave an unassigned handoff unassigned. Any assignee
 * write, any owned row, and any unknown (undefined) stored assignee stay guarded.
 */
export function isUnassignedWikiHandoffBoardStageDecision(input: {
  assigneeFieldWritten: boolean;
  currentAssigneeAgentId: string | null | undefined;
  currentAssigneeUserId: string | null | undefined;
}): boolean {
  return (
    input.assigneeFieldWritten === false &&
    input.currentAssigneeAgentId === null &&
    input.currentAssigneeUserId === null
  );
}

function wikiReviewKeepsCanonicalReturnAssignee(input: {
  canonical: string;
  executionState: unknown;
  workflowControlledAssignment?: boolean;
}): boolean {
  if (input.workflowControlledAssignment !== true) return false;
  const state = parseIssueExecutionState(input.executionState);
  if (state?.currentParticipant?.type !== "user") return false;
  return state.returnAssignee?.type === "agent" && state.returnAssignee.agentId === input.canonical;
}

export async function assertWikiHandoffWriteIntegrity(input: {
  db: Db | { select: unknown };
  companyId: string;
  issue: {
    title?: string | null;
    description?: string | null;
    executionPolicy?: unknown;
    executionState?: unknown;
  };
  incomingAssigneeAgentId: string | null | undefined;
  actorAgentId?: string | null;
  currentAssigneeAgentId?: string | null;
  checkReviewStage?: boolean;
  workflowControlledAssignment?: boolean;
  /** Only set on the transaction that will persist the guarded issue write. */
  lockCanonicalResolution?: boolean;
  requireAvailableCanonical?: boolean;
  /** Persisted pre-write identity, never the caller's proposed fields. */
  autoAdoptionSource?: WikiHandoffSource;
  /**
   * SUP-24280: the persisted status and assignee shape of this write, so the
   * guard can admit an unassigned-stub cancellation. Omit it at doors that
   * cannot cancel; without it the exemption never applies.
   */
  cancellation?: {
    requestedStatus: unknown;
    assigneeFieldWritten: boolean;
    currentAssigneeUserId: string | null | undefined;
  };
  /**
   * SUP-24632: the board stage decision's marker and assignee shape, so the
   * guard can admit a final-stage close of an unassigned handoff. Omit it at
   * doors that cannot be that decision; without it the exemption never applies.
   */
  boardStageDecision?: {
    assigneeFieldWritten: boolean;
    currentAssigneeUserId: string | null | undefined;
  };
  refusalContext?: { caller: RefusalCaller; issue: RefusalIssue | null };
}): Promise<void> {
  // An auto-adopted assignee was chosen from a Maintainer that the route saw
  // earlier. If the locked resolution no longer finds one, the adopted id is
  // stale: fail closed. Ordinary writes keep the no-canonical exception.
  if (input.lockCanonicalResolution) await lockWikiMaintainerResolution(input.db as Db, input.companyId, "shared");
  const adoptionSourceValid = !input.requireAvailableCanonical ||
    await isReporterHandoffSource(
      input.db as Db,
      input.companyId,
      input.autoAdoptionSource,
      input.lockCanonicalResolution,
    );
  const canonicalMaintainerAgentId = adoptionSourceValid
    ? (await resolveCanonicalWikiMaintainerAgentId(
        input.db as Db,
        input.companyId,
        input.issue,
        {
          lockRows: input.lockCanonicalResolution,
          requireAvailable: input.requireAvailableCanonical,
        },
      )) ?? (input.requireAvailableCanonical ? UNRESOLVED_WIKI_MAINTAINER_AGENT_ID : null)
    : UNRESOLVED_WIKI_MAINTAINER_AGENT_ID;
  if (!canonicalMaintainerAgentId) return;
  const incoming = typeof input.incomingAssigneeAgentId === "string" && input.incomingAssigneeAgentId.length > 0
    ? input.incomingAssigneeAgentId
    : null;
  const violation = wikiHandoffWriteWouldViolate({
    canonicalMaintainerAgentId,
    incomingAssigneeAgentId: incoming,
    actorAgentId: input.actorAgentId,
    currentAssigneeAgentId: input.currentAssigneeAgentId,
    executionPolicy: input.issue.executionPolicy,
    executionState: input.issue.executionState,
    checkReviewStage: input.checkReviewStage,
    workflowControlledAssignment: input.workflowControlledAssignment,
  });
  if (!violation) return;
  if (
    input.cancellation &&
    isUnassignedWikiHandoffCancellation({
      requestedStatus: input.cancellation.requestedStatus,
      assigneeFieldWritten: input.cancellation.assigneeFieldWritten,
      currentAssigneeAgentId: input.currentAssigneeAgentId,
      currentAssigneeUserId: input.cancellation.currentAssigneeUserId,
    })
  ) return;
  if (
    input.boardStageDecision &&
    isUnassignedWikiHandoffBoardStageDecision({
      assigneeFieldWritten: input.boardStageDecision.assigneeFieldWritten,
      currentAssigneeAgentId: input.currentAssigneeAgentId,
      currentAssigneeUserId: input.boardStageDecision.currentAssigneeUserId,
    })
  ) return;
  if (
    violation.reason === "wiki_handoff_self_satisfy" &&
    input.workflowControlledAssignment !== true &&
    input.checkReviewStage !== false
  ) {
    assertAssigneeWriteDoesNotSelfSatisfyReviewStage({
      executionPolicy: input.issue.executionPolicy,
      executionState: input.issue.executionState,
      incomingAssigneeAgentId: incoming,
      refusalContext: input.refusalContext,
    });
    return;
  }
  throw unprocessable(
    violation.reason === "wiki_handoff_self_satisfy"
      ? "Refusing assigneeAgentId write on a Wiki handoff: the canonical Wiki Maintainer cannot be the only participant able to clear the pending review stage"
      : "Refusing assigneeAgentId write on a Wiki handoff: the resulting assignee is not the canonical Wiki Maintainer managed by plugin paperclipai.plugin-llm-wiki (resourceKey wiki-maintainer)",
    {
      guard: "assignee_review_gate",
      subGuard: "wiki_handoff",
      reason: incoming === null ? "wiki_handoff_unassigned" : violation.reason,
      pluginKey: WIKI_LLM_WIKI_PLUGIN_KEY,
      resourceKey: WIKI_MAINTAINER_AGENT_KEY,
      canonicalMaintainerAgentId,
      assigneeAgentId: incoming,
    },
  );
}

export function wikiHandoffWriteWouldViolate(input: {
  canonicalMaintainerAgentId: string | null | undefined;
  incomingAssigneeAgentId: string | null | undefined;
  actorAgentId?: string | null;
  currentAssigneeAgentId?: string | null;
  executionPolicy: unknown;
  executionState: unknown;
  checkReviewStage?: boolean;
  workflowControlledAssignment?: boolean;
}): { reason: "wiki_handoff_non_canonical_assignee" | "wiki_handoff_self_satisfy" } | null {
  const canonical = typeof input.canonicalMaintainerAgentId === "string" && input.canonicalMaintainerAgentId.length > 0
    ? input.canonicalMaintainerAgentId
    : null;
  if (!canonical) return null;
  const incoming = typeof input.incomingAssigneeAgentId === "string" && input.incomingAssigneeAgentId.length > 0
    ? input.incomingAssigneeAgentId
    : null;
  if (incoming !== canonical) {
    if (
      incoming === null &&
      wikiReviewKeepsCanonicalReturnAssignee({
        canonical,
        executionState: input.executionState,
        workflowControlledAssignment: input.workflowControlledAssignment,
      })
    ) return null;
    if (
      (incoming !== null || (
        input.actorAgentId === canonical &&
        input.currentAssigneeAgentId === canonical
      )) &&
      isWorkflowControlledPendingReviewParticipant({
        executionPolicy: input.executionPolicy,
        executionState: input.executionState,
        incomingAssigneeAgentId: incoming,
        workflowControlledAssignment: input.workflowControlledAssignment,
      })
    ) return null;
    return { reason: "wiki_handoff_non_canonical_assignee" };
  }
  if (input.checkReviewStage === false && input.workflowControlledAssignment !== true) return null;
  if (
    findSelfSatisfyingReviewStage({
      executionPolicy: input.executionPolicy,
      executionState: input.executionState,
      incomingAssigneeAgentId: incoming,
    })
  ) {
    return { reason: "wiki_handoff_self_satisfy" };
  }
  return null;
}

export type WikiHandoffViolationReason =
  "wiki_handoff_non_canonical_assignee" | "wiki_handoff_self_satisfy";
