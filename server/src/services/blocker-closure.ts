import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, executionWorkspaces, issueRelations, issues } from "@paperclipai/db";
import type { LogActivityInput } from "./activity-log.js";

/**
 * SUP-15381 (ADR-091 D1): the shared-carrier prefix-predicate marker.
 *
 * The ONLY merge-arming path that emits this exact substring is the ADR-091 D1
 * shared-workspace narrowing (`notDeliveredReasonForPr` in merge-arming.ts),
 * which fires only when a card shares its execution-workspace branch with a
 * sibling and the head ref fails the card-identifier prefix test. An ordinary
 * single-card arming refusal (`head_unresolvable`, repo mismatch, exact-branch
 * mismatch) never carries this marker. Keying on it lets the done-close landing
 * monitor tell a structurally-unlandable shared-carrier child apart from an
 * ordinary arming-refusal card WITHOUT re-deriving delivery identity here (which
 * would duplicate the D1 rule that ADR-091 forbids a second copy of).
 */
export const SHARED_CARRIER_REFUSAL_MARKER =
  "does not carry this card's identifier prefix";

export function isSharedCarrierRefusal(
  reason: string | null | undefined,
): boolean {
  return typeof reason === "string" && reason.includes(SHARED_CARRIER_REFUSAL_MARKER);
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["done", "cancelled"]);

function isTerminal(status: string | null | undefined): boolean {
  return status != null && TERMINAL_STATUSES.has(status);
}

export interface RootCauseBlocker {
  id: string;
  identifier: string | null;
  status: string;
}

export interface BlockerClosureOptions {
  /** Max hops out of the root before the walk stops. Default 8. */
  maxDepth?: number;
}

export interface BlockerFetchers {
  /** For each issue id, the list of issue ids it is blocked by (`type=blocks`). */
  fetchBlockersFor(ids: string[]): Promise<Map<string, string[]>>;
  /** For each issue id, its `{ status, identifier }`. */
  fetchIssues(
    ids: string[],
  ): Promise<Map<string, { status: string; identifier: string | null }>>;
}

interface WalkResult {
  /** Every issue reached from the root (excluding the root itself). */
  reachable: Set<string>;
  /** id -> raw `blockedBy` list (before any terminal filtering). */
  children: Map<string, string[]>;
  /** id -> status for every visited issue (including terminal ones). */
  statusById: Map<string, string>;
  identifierById: Map<string, string | null>;
}

/**
 * Forward BFS over the `blockedBy` relation graph. Terminal (done/cancelled)
 * nodes are dead-ends: the obligation flowing through them is not live, so the
 * walk never descends past one. Cycle-safe via the visited set.
 */
async function walkBlockerGraph(
  rootIssueId: string,
  fetchers: BlockerFetchers,
  opts: BlockerClosureOptions = {},
): Promise<WalkResult> {
  const maxDepth = opts.maxDepth ?? 8;
  const statusById = new Map<string, string>();
  const identifierById = new Map<string, string | null>();
  const children = new Map<string, string[]>();
  const visited = new Set<string>([rootIssueId]);
  let frontier = [rootIssueId];
  let depth = 0;
  while (frontier.length > 0 && depth < maxDepth) {
    const blockers = await fetchers.fetchBlockersFor(frontier);
    const newlyDiscovered: string[] = [];
    for (const id of frontier) {
      const blockedBy = blockers.get(id) ?? [];
      children.set(id, blockedBy);
      for (const blocker of blockedBy) {
        if (!visited.has(blocker)) {
          visited.add(blocker);
          newlyDiscovered.push(blocker);
        }
      }
    }
    if (newlyDiscovered.length > 0) {
      const found = await fetchers.fetchIssues(newlyDiscovered);
      for (const [id, info] of found) {
        statusById.set(id, info.status);
        identifierById.set(id, info.identifier);
      }
      frontier = newlyDiscovered.filter((id) => !isTerminal(statusById.get(id)));
    } else {
      frontier = [];
    }
    depth += 1;
  }
  const reachable = new Set<string>();
  for (const id of visited) {
    if (id !== rootIssueId) reachable.add(id);
  }
  return { reachable, children, statusById, identifierById };
}

/**
 * AC4 report surface: the non-terminal LEAF blockers reachable from
 * `rootIssueId` — the root-cause set an operator must actually act on. A leaf is
 * a reachable non-terminal issue with no non-terminal blocker of its own; an
 * intermediate non-terminal blocker is NOT a root cause because something
 * upstream of it is the live strand.
 */
export async function listNonTerminalRootCauseBlockersPure(
  rootIssueId: string,
  fetchers: BlockerFetchers,
  opts?: BlockerClosureOptions,
): Promise<RootCauseBlocker[]> {
  const { reachable, children, statusById, identifierById } = await walkBlockerGraph(
    rootIssueId,
    fetchers,
    opts,
  );
  const result: RootCauseBlocker[] = [];
  for (const id of reachable) {
    if (isTerminal(statusById.get(id))) continue;
    const blockedBy = children.get(id) ?? [];
    const hasLiveBlocker = blockedBy.some((b) => !isTerminal(statusById.get(b)));
    if (hasLiveBlocker) continue;
    result.push({
      id,
      identifier: identifierById.get(id) ?? null,
      status: statusById.get(id) ?? "unknown",
    });
  }
  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

/**
 * Is `targetIssueId` reachable from `rootIssueId` by following `blockedBy` edges
 * (skipping terminal nodes)? This is the exact predicate that detects the
 * SUP-15098/SUP-15126/SUP-15203 deadlock: a shared-carrier child whose landing
 * obligation has been attributed to its carrier owner, where that child also
 * sits inside the carrier owner's own blocker closure — so no agent has a
 * concrete action and the only unblock is manual board intervention.
 */
export async function issueInBlockerClosurePure(
  rootIssueId: string,
  targetIssueId: string,
  fetchers: BlockerFetchers,
  opts?: BlockerClosureOptions,
): Promise<boolean> {
  if (rootIssueId === targetIssueId) return true;
  const { reachable } = await walkBlockerGraph(rootIssueId, fetchers, opts);
  return reachable.has(targetIssueId);
}

/** drizzle-backed fetchers, company-scoped. */
export function createDbBlockerFetchers(db: Db, companyId: string): BlockerFetchers {
  return {
    async fetchBlockersFor(ids) {
      if (ids.length === 0) return new Map();
      const rows = await db
        .select({
          blockerId: issueRelations.issueId,
          blockedId: issueRelations.relatedIssueId,
        })
        .from(issueRelations)
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, ids),
          ),
        );
      const map = new Map<string, string[]>();
      for (const row of rows) {
        let list = map.get(row.blockedId);
        if (!list) {
          list = [];
          map.set(row.blockedId, list);
        }
        list.push(row.blockerId);
      }
      return map;
    },
    async fetchIssues(ids) {
      if (ids.length === 0) return new Map();
      const rows = await db
        .select({
          id: issues.id,
          status: issues.status,
          identifier: issues.identifier,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids)));
      const map = new Map<string, { status: string; identifier: string | null }>();
      for (const row of rows) {
        map.set(row.id, { status: row.status, identifier: row.identifier });
      }
      return map;
    },
  };
}

export async function listNonTerminalRootCauseBlockers(
  db: Db,
  companyId: string,
  rootIssueId: string,
  opts?: BlockerClosureOptions,
): Promise<RootCauseBlocker[]> {
  return listNonTerminalRootCauseBlockersPure(
    rootIssueId,
    createDbBlockerFetchers(db, companyId),
    opts,
  );
}

export async function issueInBlockerClosure(
  db: Db,
  companyId: string,
  rootIssueId: string,
  targetIssueId: string,
  opts?: BlockerClosureOptions,
): Promise<boolean> {
  return issueInBlockerClosurePure(
    rootIssueId,
    targetIssueId,
    createDbBlockerFetchers(db, companyId),
    opts,
  );
}

/**
 * Resolve the card that owns a shared-carrier child's execution-workspace branch
 * (ADR-091 D1). A `shared_workspace` row belongs to the parent issue and carries
 * exactly one `branch_name`; every other issue on that row is a sibling child.
 * Returns the owning (carrier) issue id + identifier, or `null` when the card
 * owns its own workspace row (single-card, not shared) or ownership cannot be
 * resolved — in which case the caller must fall back to its prior behavior.
 */
export async function resolveCarrierOwner(
  db: Db,
  companyId: string,
  cardIssueId: string,
): Promise<{ ownerId: string; identifier: string | null } | null> {
  const cardRow = await db
    .select({ executionWorkspaceId: issues.executionWorkspaceId })
    .from(issues)
    .where(and(eq(issues.id, cardIssueId), eq(issues.companyId, companyId)));
  const workspaceId = cardRow[0]?.executionWorkspaceId;
  if (!workspaceId) return null;

  const workspaceRow = await db
    .select({ sourceIssueId: executionWorkspaces.sourceIssueId })
    .from(executionWorkspaces)
    .where(eq(executionWorkspaces.id, workspaceId));
  const ownerId = workspaceRow[0]?.sourceIssueId ?? null;
  if (!ownerId || ownerId === cardIssueId) return null;

  const ownerRow = await db
    .select({ id: issues.id, identifier: issues.identifier })
    .from(issues)
    .where(and(eq(issues.id, ownerId), eq(issues.companyId, companyId)));
  if (!ownerRow[0]) return null;
  return { ownerId, identifier: ownerRow[0].identifier };
}

/**
 * SUP-17092/A (ADR-091 D1): the audit action written when a dependency wake is
 * WITHHELD because the resolved blocker's landing was attributed away to a shared
 * carrier. Durable operator surface: an issue that is `done` but whose PR can never
 * carry its own identifier prefix must not fire a phantom `issue_blockers_resolved`
 * cascade into the cards blocked on it; this row is the only record that the
 * cascade was intentionally suppressed and why.
 */
export const DEPENDENCY_WAKE_WITHHELD_ACTION = "issue.dependency_wake_withheld";

// Must stay in lockstep with `DONE_CLOSE_LANDING_ATTRIBUTED_ACTION` in
// done-close-landing-backstop.ts (SUP-15381). It is a local literal here (not an
// import) to keep blocker-closure a leaf module: done-close-landing-backstop.ts
// already imports from this file, so importing it back would create a cycle.
const ATTRIBUTED_LANDING_ACTION = "issue.done_close_landing_attributed";

export type AttributedLandingDischargeSource =
  | "attribution_row"
  | "publish_skipped";

/**
 * SUP-17092/A consume-contract (ADR-091 D1). Discriminated on `attributed`.
 * The `attributed: true` variant additionally carries the `pr` and `deadlocked`
 * fields read verbatim from the attribution row (present only for
 * `source: "attribution_row"`; null for `publish_skipped`).
 */
export type AttributedLandingDischarge =
  | {
      attributed: true;
      /** Which clause satisfied the predicate. */
      source: AttributedLandingDischargeSource;
      /** The verbatim landing-refusal reason, for the withheld-wake audit row. */
      reason: string | null;
      /** The carrier card's identifier, when resolvable from the attribution row. */
      carrierIdentifier: string | null;
      /** The PR key, when resolvable from the attribution row. */
      pr: string | null;
      /** Whether the card sits inside the carrier's own blocker closure (from the row). */
      deadlocked: boolean | null;
    }
  | {
      attributed: false;
      source: null;
      reason: null;
      carrierIdentifier: null;
      pr: null;
      deadlocked: null;
    };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function readApprovalStatus(
  executionState: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!executionState || typeof executionState !== "object") return null;
  const approvalStatus = (executionState as Record<string, unknown>).approvalStatus;
  return approvalStatus && typeof approvalStatus === "object"
    ? (approvalStatus as Record<string, unknown>)
    : null;
}

function readPublishSkippedReason(
  approvalStatus: Record<string, unknown> | null,
): string | null {
  if (!approvalStatus) return null;
  const publishSkipped = asRecord(approvalStatus.publishSkipped);
  const reason = publishSkipped.reason;
  return typeof reason === "string" ? reason : null;
}

/**
 * SUP-17092/A: is this `done` card's landing attributed away to a shared carrier,
 * such that its `issue_blockers_resolved` dependent wake must be withheld?
 *
 * Two independent, level-triggered clauses — OR-composed, clause 1 prioritized for
 * the richer `carrierIdentifier`:
 *
 *   1. `attribution_row` — the done-close landing backstop (SUP-15381) has already
 *      written an `issue.done_close_landing_attributed` activity row for this card.
 *      Durable: survives past the grace window and across reconciler cycles.
 *
 *   2. `publish_skipped` — the LIVE
 *      `executionState.approvalStatus.publishSkipped.reason` carries the ADR-091 D1
 *      shared-carrier marker. This is the grace-window incident: the card is already
 *      `done` but the landing backstop has not swept it yet, so no attribution row
 *      exists. Clause 2 is MANDATORY — without it the wake fires in that window.
 *
 * The marker ({@link SHARED_CARRIER_REFUSAL_MARKER}) is the only key. Delivery
 * identity is never re-derived here: ADR-091 forbids a second copy of the D1
 * prefix-predicate rule, and this is that rule's consumer, not its re-implementation.
 *
 * Level-triggered, not a permanent drop: clause 2 reads live `executionState`, so a
 * later republish that clears `publishSkipped` (and sets `publishedHeadSha`) makes the
 * predicate return `attributed: false` and the next reconciliation pass emits the
 * wake normally.
 */
export async function readAttributedLandingDischarge(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<AttributedLandingDischarge> {
  // Clause 1 (prioritized): the latest durable attribution row for this card.
  const attributionRow = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issueId),
        eq(activityLog.action, ATTRIBUTED_LANDING_ACTION),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (attributionRow) {
    const details = asRecord(attributionRow.details);
    return {
      attributed: true,
      source: "attribution_row",
      reason:
        typeof details.skipReason === "string" ? details.skipReason : null,
      carrierIdentifier:
        typeof details.carrierIdentifier === "string"
          ? details.carrierIdentifier
          : typeof details.carrierOwnerId === "string"
            ? details.carrierOwnerId
            : null,
      pr: typeof details.pr === "string" ? details.pr : null,
      deadlocked:
        typeof details.deadlocked === "boolean" ? details.deadlocked : null,
    };
  }

  // Clause 2: live publishSkipped refusal carrying the shared-carrier marker.
  const issueRow = await db
    .select({ executionState: issues.executionState })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const publishSkippedReason = readPublishSkippedReason(
    readApprovalStatus(issueRow?.executionState),
  );
  if (isSharedCarrierRefusal(publishSkippedReason)) {
    return {
      attributed: true,
      source: "publish_skipped",
      reason: publishSkippedReason,
      carrierIdentifier: null,
      pr: null,
      deadlocked: null,
    };
  }

  return {
    attributed: false,
    source: null,
    reason: null,
    carrierIdentifier: null,
    pr: null,
    deadlocked: null,
  };
}

/**
 * SUP-17092/A: build the durable audit row for a withheld dependency wake. The
 * `entityId`/`issueId` is the DEPENDENT (the would-be wake target), so the row sits
 * on the card that was never woken. Callers write it through their own mechanism
 * (best-effort `logActivity` on the route paths, `persistActivity` + `publications`
 * inside the native status-decision transaction).
 */
export function buildDependencyWakeWithheldActivity(input: {
  companyId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
  dependentIssueId: string;
  resolvedBlockerIssueId: string;
  blockerIssueIds: string[];
  /** Which producer withheld the wake (audit provenance only). */
  producer: string;
  discharge: AttributedLandingDischarge;
}): LogActivityInput {
  return {
    companyId: input.companyId,
    actorType: "system",
    actorId: "dependency_wake_withheld",
    agentId: input.agentId,
    runId: input.runId,
    agentApiKeyId: input.agentApiKeyId,
    action: DEPENDENCY_WAKE_WITHHELD_ACTION,
    entityType: "issue",
    entityId: input.dependentIssueId,
    issueId: input.dependentIssueId,
    details: {
      wakeReason: "issue_blockers_resolved",
      dependentIssueId: input.dependentIssueId,
      resolvedBlockerIssueId: input.resolvedBlockerIssueId,
      blockerIssueIds: input.blockerIssueIds,
      producer: input.producer,
      attributionSource: input.discharge.source,
      refusalReason: input.discharge.reason,
      carrierIdentifier: input.discharge.carrierIdentifier,
      pr: input.discharge.pr,
      deadlocked: input.discharge.deadlocked,
    },
  };
}
