import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueRecoveryActions } from "@paperclipai/db";
import type {
  IssueRecoveryAction,
  IssueRecoveryActionKind,
  IssueRecoveryActionOwnerType,
  IssueRecoveryActionOutcome,
  IssueRecoveryActionStatus,
} from "@paperclipai/shared";

const ACTIVE_RECOVERY_ACTION_STATUSES = ["active", "escalated"] as const satisfies readonly IssueRecoveryActionStatus[];
const MAX_UPSERT_RETRIES = 3;

/**
 * The attempt ceiling the stale-wake sweep applies to recovery actions that
 * carry no explicit `maxAttempts`
 * (`candidate.maxAttempts ?? DEFAULT_RECOVERY_ACTION_MAX_ATTEMPTS`).
 *
 * SUP-14151: also the ceiling a minted/re-minted `attemptCount` is clamped to,
 * so a successor can never be minted past the budget the sweep will hold it to.
 * Exported so the sweep's default ceiling and the upsert clamp share one
 * source of truth instead of drifting apart.
 */
export const DEFAULT_RECOVERY_ACTION_MAX_ATTEMPTS = 5;

type IssueRecoveryActionRow = typeof issueRecoveryActions.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;

function asDatabaseDate(value: string | Date | null) {
  return typeof value === "string" ? new Date(value) : value;
}

function isRecoveryBudgetExhausted(evidence: Record<string, unknown>) {
  const budget = evidence.recoveryBudget;
  return Boolean(
    budget &&
      typeof budget === "object" &&
      !Array.isArray(budget) &&
      (budget as Record<string, unknown>).state === "exhausted",
  );
}

export type UpsertIssueRecoveryActionInput = {
  companyId: string;
  sourceIssueId: string;
  recoveryIssueId?: string | null;
  kind: IssueRecoveryActionKind;
  ownerType?: IssueRecoveryActionOwnerType;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
  previousOwnerAgentId?: string | null;
  returnOwnerAgentId?: string | null;
  cause: string;
  fingerprint: string;
  evidence?: Record<string, unknown>;
  /** Evidence written only when this upsert creates a new action row. */
  evidenceOnCreate?: Record<string, unknown>;
  nextAction: string;
  wakePolicy?: Record<string, unknown> | null;
  monitorPolicy?: Record<string, unknown> | null;
  maxAttempts?: number | null;
  timeoutAt?: Date | null;
  lastAttemptAt?: Date | null;
  attemptCount?: number;
  // When true, a change of (cause, fingerprint) does not overwrite the active
  // action in place. The service resolves the prior action and inserts a new
  // one. The new failure then gets a distinct recovery identity and a fresh
  // operator notice, and the prior identity stays as a resolved record.
  supersedeOnIdentityChange?: boolean;
  // Rollout compatibility for active pre-policy actions. Refresh their
  // evidence/attempt metadata without silently changing the recorded owner or
  // the wake/monitor contract that made that owner authoritative.
  preserveExistingOwner?: boolean;
};

export type ResolveIssueRecoveryActionInput = {
  companyId: string;
  sourceIssueId: string;
  actionId?: string | null;
  kind?: IssueRecoveryActionKind | null;
  cause?: string | null;
  fingerprint?: string | null;
  status: Extract<IssueRecoveryActionStatus, "resolved" | "cancelled">;
  outcome: IssueRecoveryActionOutcome;
  resolutionNote?: string | null;
  evidence?: Record<string, unknown>;
  /**
   * An action the sweep escalated at its attempt ceiling
   * (`escalated` + `outcome: "exhausted"`) is terminal: it may only be
   * cleared by an explicit board/operator resolution. Ordinary callers
   * (source revalidation, sweep folds) must leave this unset so
   * exhaustion cannot be silently erased and re-minted as a fresh
   * post-ceiling action on the next upsert. (SUP-13698)
   */
  boardResolution?: boolean;
};

function toReadModel(row: IssueRecoveryActionRow): IssueRecoveryAction {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceIssueId: row.sourceIssueId,
    recoveryIssueId: row.recoveryIssueId,
    kind: row.kind as IssueRecoveryAction["kind"],
    status: row.status as IssueRecoveryAction["status"],
    ownerType: row.ownerType as IssueRecoveryAction["ownerType"],
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
    previousOwnerAgentId: row.previousOwnerAgentId,
    returnOwnerAgentId: row.returnOwnerAgentId,
    cause: row.cause,
    fingerprint: row.fingerprint,
    evidence: row.evidence,
    nextAction: row.nextAction,
    wakePolicy: row.wakePolicy,
    monitorPolicy: row.monitorPolicy,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    timeoutAt: row.timeoutAt,
    lastAttemptAt: row.lastAttemptAt,
    outcome: row.outcome as IssueRecoveryAction["outcome"],
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isUniqueRecoveryActionConflict(error: unknown) {
  const maybe = error as { code?: string; constraint?: string; message?: string } | null;
  return Boolean(
    maybe &&
      maybe.code === "23505" &&
      (
        maybe.constraint === "issue_recovery_actions_active_source_uq" ||
        maybe.constraint === "issue_recovery_actions_active_fingerprint_uq" ||
        typeof maybe.message === "string" && (
          maybe.message.includes("issue_recovery_actions_active_source_uq") ||
          maybe.message.includes("issue_recovery_actions_active_fingerprint_uq")
        )
      ),
  );
}

export function issueRecoveryActionService(db: Db) {
  const upsertQueues = new Map<string, Promise<void>>();

  async function runExclusiveUpsert<T>(
    input: UpsertIssueRecoveryActionInput,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = `${input.companyId}:${input.sourceIssueId}`;
    const previous = upsertQueues.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    upsertQueues.set(key, next);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (upsertQueues.get(key) === next) {
        upsertQueues.delete(key);
      }
    }
  }

  async function getActiveForIssue(
    companyId: string,
    sourceIssueId: string,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction | null> {
    const row = await dbOrTx
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row ? toReadModel(row) : null;
  }

  // ADR-093 D2: `getActiveForIssue` counts BOTH `active` and `escalated` rows
  // because the re-entrancy guard, attempt-ceiling lookups, and the board sweep
  // all need to see an escalated action (it is still "in flight" for those
  // purposes). The continuation-path disjunct, however, asks a different
  // question: "is there a *live* recovery ladder that will actually run?" An
  // action that has exhausted its handoff ceiling and escalated to the board
  // (`status: 'escalated'`, `ownerType: 'board'`, `ownerAgentId: null`) is the
  // opposite of live — the ladder is dead and parked on a human. Filtering on
  // `active` only is what keeps an escalated action from masquerading as a live
  // continuation path (the SUP-14761 defect). This reader is deliberately a
  // second reader, not a narrowing of `ACTIVE_RECOVERY_ACTION_STATUSES`, so the
  // write-path guard and sweep keep seeing escalated rows.
  async function getLiveContinuationForIssue(
    companyId: string,
    sourceIssueId: string,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction | null> {
    const row = await dbOrTx
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
          eq(issueRecoveryActions.status, "active"),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row ? toReadModel(row) : null;
  }

  async function getLatestResolvedForIssue(
    companyId: string,
    sourceIssueId: string,
    kind?: IssueRecoveryActionKind,
  ): Promise<IssueRecoveryAction | null> {
    const predicates = [
      eq(issueRecoveryActions.companyId, companyId),
      eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
      eq(issueRecoveryActions.status, "resolved"),
    ];
    if (kind) predicates.push(eq(issueRecoveryActions.kind, kind));
    const row = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(...predicates))
      .orderBy(desc(issueRecoveryActions.resolvedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row ? toReadModel(row) : null;
  }

  async function getLatestForFingerprint(
    companyId: string,
    sourceIssueId: string,
    fingerprint: string,
  ): Promise<IssueRecoveryAction | null> {
    const row = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
          eq(issueRecoveryActions.fingerprint, fingerprint),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row ? toReadModel(row) : null;
  }

  // SUP-15847: `attemptCount` is per-row, so a re-mint that only looked at the
  // most recently updated row could restart at a lower count whenever a newer
  // row for the same fingerprint existed with a small count (the SUP-15825
  // "5, then 1, then 2" reading). `max(attemptCount)` is a high-water mark, not
  // the cumulative total: a board reset mints a low-count successor after a
  // high-count predecessor, so the high-water understates the true cost the
  // fingerprint has already incurred. The cumulative depth is a property of the
  // fingerprint, not of any one row, so read every row in chronological order
  // and fold it.
  //
  // The fold `depth = max(depth + 1, row.attemptCount)`:
  //   - a row whose internal counter exceeds the running total (a carried, not
  //     reset, counter) advances depth to that counter, so a continuation never
  //     double-counts the attempts it already carried;
  //   - a row carrying a smaller counter (a reset successor) contributes one
  //     more attempt, so a reset -> re-park cycle can never restart the depth
  //     below the cost already paid.
  // For a monotonic no-reset history the fold equals the high-water mark, so
  // existing carry-forward and ceiling behavior is unchanged; it only diverges
  // (upward) when reset rows are present.
  async function getFingerprintHistory(
    companyId: string,
    sourceIssueId: string,
    fingerprint: string,
    dbOrTx: DbOrTransaction = db,
  ): Promise<{ latest: IssueRecoveryAction | null; cumulativeDepth: number }> {
    const rows = await dbOrTx
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
          eq(issueRecoveryActions.fingerprint, fingerprint),
        ),
      )
      .orderBy(asc(issueRecoveryActions.createdAt), asc(issueRecoveryActions.id));
    if (rows.length === 0) return { latest: null, cumulativeDepth: 0 };
    // SUP-15847 (round 2): fold only the rows since the most recent board-reset
    // boundary. Rows before it belong to a lineage a board resolution already
    // closed and paid out, so counting them again would blow the fresh attempt
    // budget the board granted on the successor's next re-park.
    let boundaryIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rowHasLineageResetBoundary(rows[i]!)) boundaryIndex = i;
    }
    const foldStart = boundaryIndex >= 0 ? boundaryIndex : 0;
    let cumulativeDepth = 0;
    for (let i = foldStart; i < rows.length; i++) {
      const row = rows[i]!;
      cumulativeDepth = Math.max(cumulativeDepth + 1, row.attemptCount);
    }
    let latest = rows[0]!;
    for (const row of rows) {
      if (row.updatedAt.getTime() > latest.updatedAt.getTime()) latest = row;
    }
    return { latest: toReadModel(latest), cumulativeDepth };
  }

  async function getFingerprintAttemptTotals(
    companyId: string,
    sourceIssueId: string,
  ): Promise<Record<string, number>> {
    const rows = await db
      .select({
        fingerprint: issueRecoveryActions.fingerprint,
        attemptCount: issueRecoveryActions.attemptCount,
        evidence: issueRecoveryActions.evidence,
      })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
        ),
      )
      .orderBy(asc(issueRecoveryActions.createdAt), asc(issueRecoveryActions.id));
    // SUP-15847: same durable cumulative depth as `getFingerprintHistory`,
    // exposed per fingerprint for the read route. A `max(attemptCount)`
    // projection understates the true cost whenever reset rows exist. Round 2:
    // honor the board-reset boundary so a resolved predecessor's spent history
    // is not re-counted into the fresh successor's budget.
    const lastBoundaryByFingerprint = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (rowHasLineageResetBoundary(row)) lastBoundaryByFingerprint.set(row.fingerprint, i);
    }
    const depths = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const boundary = lastBoundaryByFingerprint.get(row.fingerprint) ?? -1;
      if (i < boundary) continue;
      const depth = Math.max((depths.get(row.fingerprint) ?? 0) + 1, row.attemptCount);
      depths.set(row.fingerprint, depth);
    }
    const totals: Record<string, number> = {};
    for (const [fingerprint, depth] of depths) {
      totals[fingerprint] = depth;
    }
    return totals;
  }

  // SUP-15847: the latest recorded run for the issue, used to decide whether a
  // re-park's `evidence.latestRunId` has actually advanced. Mirrors
  // `recovery.getLatestIssueRun` so the "is there a newer run?" question is
  // answered the same way the reconciler answers it.
  async function getLatestIssueRunId(companyId: string, sourceIssueId: string): Promise<string | null> {
    const row = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${sourceIssueId}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row?.id ?? null;
  }

  function readEvidenceRunId(evidence: Record<string, unknown> | null | undefined): string | null {
    const value = evidence?.latestRunId;
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  // SUP-15847: the predecessor is a resolved row and the incoming evidence
  // cites the exact run that row was resolved on. That is a re-park on stale
  // evidence, not a new failure.
  function isStaleReparkEvidence(
    prev: IssueRecoveryAction | null,
    input: UpsertIssueRecoveryActionInput,
  ): boolean {
    if (!prev || prev.status !== "resolved") return false;
    const priorRunId = readEvidenceRunId(prev.evidence);
    const incomingRunId = readEvidenceRunId(input.evidence);
    return priorRunId != null && incomingRunId != null && priorRunId === incomingRunId;
  }

  // SUP-15847 (round 2): a board reset — an exhausted predecessor explicitly
  // resolved and re-minted at attempt 1 — closes the attempt lineage that
  // precedes it. The fresh successor starts an independent attempt budget. This
  // marker is stamped on the boundary row at mint time so the cumulative-depth
  // fold (below) stops counting at the most recent reset instead of resurrecting
  // the old exhausted history on the next re-park, which is what re-escalated
  // a fresh board-reset budget on its very next stale re-park.
  const LINEAGE_RESET_EVIDENCE_KEY = "lineageReset" as const;

  function rowHasLineageResetBoundary(row: { evidence: unknown }): boolean {
    const marker = (row.evidence as Record<string, unknown> | null)?.[LINEAGE_RESET_EVIDENCE_KEY];
    return Boolean(marker && typeof marker === "object" && !Array.isArray(marker));
  }

  // A fresh-budget successor keeps its boundary across in-place evidence
  // rewrites (sweep bumps, reconciler re-upserts): if the incoming evidence does
  // not already carry the marker and the existing row does, carry it forward so
  // the fold still starts at this row.
  function carryLineageResetBoundary(
    existingEvidence: Record<string, unknown> | undefined,
    nextEvidence: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = nextEvidence ?? {};
    if (base[LINEAGE_RESET_EVIDENCE_KEY]) return base;
    const inherited = existingEvidence?.[LINEAGE_RESET_EVIDENCE_KEY];
    if (inherited && typeof inherited === "object" && !Array.isArray(inherited)) {
      return { ...base, [LINEAGE_RESET_EVIDENCE_KEY]: inherited };
    }
    return base;
  }

  async function listActiveForIssues(companyId: string, sourceIssueIds: string[]) {
    if (sourceIssueIds.length === 0) return new Map<string, IssueRecoveryAction>();
    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          inArray(issueRecoveryActions.sourceIssueId, [...new Set(sourceIssueIds)]),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt));
    const result = new Map<string, IssueRecoveryAction>();
    for (const row of rows) {
      if (!result.has(row.sourceIssueId)) result.set(row.sourceIssueId, toReadModel(row));
    }
    return result;
  }

  async function listAllForIssue(companyId: string, sourceIssueId: string): Promise<IssueRecoveryAction[]> {
    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt));
    return rows.map(toReadModel);
  }

  async function retryUpsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
    retryCount: number,
    error?: unknown,
  ): Promise<IssueRecoveryAction> {
    if (retryCount >= MAX_UPSERT_RETRIES) {
      if (error) throw error;
      throw new Error(
        `Failed to upsert active recovery action for issue ${input.sourceIssueId} after ${MAX_UPSERT_RETRIES} retries`,
      );
    }
    return upsertSourceScopedUnlocked(input, retryCount + 1);
  }

  function buildInsertValues(
    input: UpsertIssueRecoveryActionInput,
    ownerType: IssueRecoveryActionOwnerType,
    now: Date,
    // SUP-13698/SUP-14151: the fresh-mint path carries (and clamps) the
    // predecessor's attempt budget forward. Defaulting to `input.attemptCount`
    // here would reset every re-mint to 1, so the sweep ceiling is never
    // reachable and an exhausted action is re-escalated forever.
    attemptCountOverride?: number,
    // SUP-15847: extra evidence merged last, used to type a below-ceiling stale
    // re-park distinctly (`staleRepark`) without changing any other caller.
    evidenceExtra?: Record<string, unknown>,
  ) {
    return {
      companyId: input.companyId,
      sourceIssueId: input.sourceIssueId,
      recoveryIssueId: input.recoveryIssueId ?? null,
      kind: input.kind,
      status: "active" as const,
      ownerType,
      ownerAgentId: input.ownerAgentId ?? null,
      ownerUserId: input.ownerUserId ?? null,
      previousOwnerAgentId: input.previousOwnerAgentId ?? null,
      returnOwnerAgentId: input.returnOwnerAgentId ?? null,
      cause: input.cause,
      fingerprint: input.fingerprint,
      evidence: {
        ...(input.evidence ?? {}),
        ...(input.evidenceOnCreate ?? {}),
        ...(evidenceExtra ?? {}),
      },
      nextAction: input.nextAction,
      wakePolicy: input.wakePolicy ?? null,
      monitorPolicy: input.monitorPolicy ?? null,
      attemptCount: attemptCountOverride ?? input.attemptCount ?? 1,
      maxAttempts: input.maxAttempts ?? null,
      timeoutAt: input.timeoutAt ?? null,
      lastAttemptAt: input.lastAttemptAt ?? now,
    };
  }

  // Resolve the prior active action, then insert a new one in one transaction.
  // The prior identity stays as a cancelled record and the new failure gets a
  // fresh action row with its own id. The partial unique index on the active
  // status stays satisfied because only the new row is active at commit.
  async function supersedePriorAndInsert(
    input: UpsertIssueRecoveryActionInput,
    priorActionId: string,
    ownerType: IssueRecoveryActionOwnerType,
    now: Date,
    retryCount: number,
  ): Promise<IssueRecoveryAction> {
    try {
      const created = await db.transaction(async (tx) => {
        const [superseded] = await tx
          .update(issueRecoveryActions)
          .set({
            status: "cancelled",
            outcome: "cancelled",
            resolutionNote: "A new failure with a different identity superseded this recovery action.",
            resolvedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(issueRecoveryActions.id, priorActionId),
              inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
            ),
          )
          .returning();
        // Another writer resolved the prior action first. Abort and retry the
        // whole upsert so the retry reads the current active state.
        if (!superseded) return null;
        const [row] = await tx
          .insert(issueRecoveryActions)
          .values(buildInsertValues(input, ownerType, now))
          .returning();
        return row ?? null;
      });
      if (!created) return retryUpsertSourceScoped(input, retryCount);
      return toReadModel(created);
    } catch (error) {
      if (!isUniqueRecoveryActionConflict(error)) throw error;
      return retryUpsertSourceScoped(input, retryCount, error);
    }
  }

  async function upsertSourceScopedUnlocked(
    input: UpsertIssueRecoveryActionInput,
    retryCount = 0,
  ): Promise<IssueRecoveryAction> {
    const existing = await getActiveForIssue(input.companyId, input.sourceIssueId);
    const now = new Date();
    const ownerType = input.ownerType ?? (input.ownerAgentId ? "agent" : "board");
    if (existing) {
      // A distinct failure identity must not overwrite the active action of a
      // prior identity. Resolve the prior action and insert a new one, so the
      // operator gets a new notice for the new failure.
      if (
        input.supersedeOnIdentityChange &&
        (existing.cause !== input.cause || existing.fingerprint !== input.fingerprint)
      ) {
        return supersedePriorAndInsert(input, existing.id, ownerType, now, retryCount);
      }
      // An action the sweep already escalated at its attempt ceiling
      // (`escalated` + `outcome: "exhausted"`) is terminal until a board
      // resolution or a genuinely new action supersedes it. Returning it as-is
      // refuses to resurrect it to `active`, bump `attemptCount` past the
      // ceiling, or erase its exhaustion record — which is what re-triggered the
      // per-sweep exhaustion comment forever.
      if (existing.status === "escalated" && (existing.outcome as string | null) === "exhausted") {
        return existing;
      }
      // `maxAttempts` is an execution budget, not display metadata. Once the
      // same recovery identity consumes it, retain one inspectable board-owned
      // action but remove every automatic wake/monitor path. Repeated sweep or
      // finalizer writes then become idempotent instead of silently advancing
      // beyond the advertised cap. A distinct identity can still supersede the
      // exhausted action through the branch above.
      if (isRecoveryBudgetExhausted(existing.evidence ?? {})) {
        return existing;
      }
      const nextAttemptCount =
        input.attemptCount ?? existing.attemptCount + 1;
      const effectiveMaxAttempts = input.preserveExistingOwner
        ? existing.maxAttempts
        : input.maxAttempts === undefined
          ? existing.maxAttempts
          : input.maxAttempts;
      // Upstream escalates in place once the budget is consumed. SUP-14151 requires
      // that a re-upsert which asserts NO budget of its own must never bump an active
      // row past the ceiling nor escalate it — the sweep owns that transition. So the
      // in-place escalation fires only when this call actually carries `maxAttempts`.
      if (
        input.maxAttempts !== undefined &&
        effectiveMaxAttempts !== null &&
        nextAttemptCount >= effectiveMaxAttempts
      ) {
        const attemptsUsed = Math.max(
          existing.attemptCount,
          Math.min(nextAttemptCount, effectiveMaxAttempts),
        );
        const [exhausted] = await db
          .update(issueRecoveryActions)
          .set({
            status: "escalated",
            ownerType: "board",
            ownerAgentId: null,
            ownerUserId: null,
            previousOwnerAgentId:
              existing.ownerAgentId ?? existing.previousOwnerAgentId,
            returnOwnerAgentId:
              input.returnOwnerAgentId ??
              existing.returnOwnerAgentId ??
              existing.ownerAgentId,
            evidence: {
              ...(existing.evidence ?? {}),
              ...(input.evidence ?? {}),
              recoveryBudget: {
                state: "exhausted",
                attemptsUsed,
                maxAttempts: effectiveMaxAttempts,
                exhaustedAt: now.toISOString(),
                cause: existing.cause,
                fingerprint: existing.fingerprint,
              },
            },
            nextAction:
              `Automatic recovery exhausted after ${attemptsUsed}/${effectiveMaxAttempts} attempts. ` +
              "Review the infrastructure failure and explicitly choose a replacement run or provider configuration.",
            wakePolicy: null,
            monitorPolicy: null,
            attemptCount: attemptsUsed,
            maxAttempts: effectiveMaxAttempts,
            timeoutAt: null,
            lastAttemptAt: input.lastAttemptAt ?? now,
            outcome: "escalated",
            resolutionNote: null,
            resolvedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(issueRecoveryActions.id, existing.id),
              inArray(issueRecoveryActions.status, [
                ...ACTIVE_RECOVERY_ACTION_STATUSES,
              ]),
            ),
          )
          .returning();
        if (!exhausted) {
          return retryUpsertSourceScoped(input, retryCount);
        }
        return toReadModel(exhausted);
      }
      const [updated] = await db
        .update(issueRecoveryActions)
        .set({
          recoveryIssueId: input.preserveExistingOwner
            ? existing.recoveryIssueId
            : input.recoveryIssueId ?? null,
          kind: input.preserveExistingOwner ? existing.kind : input.kind,
          status: input.preserveExistingOwner ? existing.status : "active",
          ownerType: input.preserveExistingOwner ? existing.ownerType : ownerType,
          ownerAgentId: input.preserveExistingOwner
            ? existing.ownerAgentId
            : input.ownerAgentId ?? null,
          ownerUserId: input.preserveExistingOwner
            ? existing.ownerUserId
            : input.ownerUserId ?? null,
          previousOwnerAgentId: input.preserveExistingOwner
            ? existing.previousOwnerAgentId
            : input.previousOwnerAgentId ?? existing.previousOwnerAgentId,
          returnOwnerAgentId: input.preserveExistingOwner
            ? existing.returnOwnerAgentId
            : input.returnOwnerAgentId ?? existing.returnOwnerAgentId,
          cause: input.preserveExistingOwner ? existing.cause : input.cause,
          fingerprint: input.preserveExistingOwner ? existing.fingerprint : input.fingerprint,
          evidence: input.preserveExistingOwner
            ? carryLineageResetBoundary(
                existing.evidence,
                {
                  ...(existing.evidence ?? {}),
                  ...(input.evidence ?? {}),
                },
              )
            : carryLineageResetBoundary(
                existing.evidence,
                input.evidence ?? existing.evidence,
              ),
          nextAction: input.preserveExistingOwner ? existing.nextAction : input.nextAction,
          wakePolicy: input.preserveExistingOwner
            ? existing.wakePolicy
            : input.wakePolicy ?? null,
          monitorPolicy: input.preserveExistingOwner
            ? existing.monitorPolicy
            : input.monitorPolicy ?? null,
          // SUP-14151: never bump past the effective ceiling -- the sweep holds this
          // row to `maxAttempts ?? DEFAULT_RECOVERY_ACTION_MAX_ATTEMPTS`, so a
          // post-ceiling count would escalate on the very next pass.
          attemptCount: input.attemptCount ?? Math.min(
            existing.attemptCount + 1,
            input.maxAttempts ?? existing.maxAttempts ?? DEFAULT_RECOVERY_ACTION_MAX_ATTEMPTS,
          ),
          maxAttempts: input.preserveExistingOwner
            ? existing.maxAttempts
            : input.maxAttempts === undefined
              ? existing.maxAttempts
              : input.maxAttempts,
          timeoutAt: input.preserveExistingOwner
            ? asDatabaseDate(existing.timeoutAt)
            : input.timeoutAt ?? null,
          lastAttemptAt: input.preserveExistingOwner
            ? asDatabaseDate(existing.lastAttemptAt)
            : input.lastAttemptAt ?? now,
          outcome: input.preserveExistingOwner ? existing.outcome : null,
          resolutionNote: input.preserveExistingOwner ? existing.resolutionNote : null,
          resolvedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(issueRecoveryActions.id, existing.id),
            inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
          ),
        )
        .returning();
      if (!updated) {
        return retryUpsertSourceScoped(input, retryCount);
      }
      return toReadModel(updated!);
    }

    try {
      const { latest: prev, cumulativeDepth } = await getFingerprintHistory(
        input.companyId,
        input.sourceIssueId,
        input.fingerprint,
      );
      // SUP-13698: when the latest action for this fingerprint already consumed
      // its full sweep budget (attemptCount >= maxAttempts, stamped by the
      // escalation), start a fresh attempt budget instead of carrying the
      // post-ceiling count forward. Carrying it would mint a new action
      // already past its ceiling, which the next sweep re-escalates and
      // re-comments on immediately. This is the deliberate board-resolution
      // reset, so it must keep winning over the cumulative depth.
      const predecessorBudgetExhausted =
        prev != null && prev.maxAttempts != null && prev.attemptCount >= prev.maxAttempts;
      // SUP-15847: carry the fingerprint's durable cumulative depth forward,
      // not the high-water `max(attemptCount)`. A resolve -> re-park cycle
      // previously read a low per-row count (or the high-water of a reset
      // predecessor) and restarted the ladder, defeating the ceiling.
      const carriedAttemptCount = predecessorBudgetExhausted ? 1 : cumulativeDepth + 1;
      const effectiveMaxAttempts = input.maxAttempts ?? DEFAULT_RECOVERY_ACTION_MAX_ATTEMPTS;
      // SUP-14151: clamp the carried count to the effective ceiling. The
      // predecessor-budget reset above only fires when the predecessor carries
      // a non-null maxAttempts; where it was null the count carried forward
      // unbounded and the successor was minted already past a ceiling it later
      // acquired (the `attemptCount 18 > maxAttempts 5` reading from SUP-14139).
      // An explicit `attemptCount` is authoritative: the bounded disposition
      // repair is the one caller that supplies it, and it has already resolved
      // the true count for this fingerprint (run stamp, persisted action, or
      // legacy park history). Every carry-forward caller above passes none, so
      // the SUP-13698/SUP-14151 clamp still governs each of them.
      const nextAttemptCount = input.attemptCount ??
        (predecessorBudgetExhausted ? 1 : Math.min(carriedAttemptCount, effectiveMaxAttempts));
      // SUP-15847: a re-park whose evidence has not advanced past the row that
      // was just resolved is a stale re-park -- it is driven by an unchanged
      // `latestRunId`, not a new failure.
      const staleRepark = isStaleReparkEvidence(prev, input);
      const staleReparkEvidence = staleRepark
        ? { staleRepark: { detected: true, latestRunId: readEvidenceRunId(input.evidence) } }
        : undefined;
      // SUP-15847 (round 2): a board reset mints a fresh attempt-1 successor
      // after an exhausted predecessor was explicitly resolved. Stamp the
      // boundary on that row so the durable-depth fold and the read projection
      // stop counting the closed lineage it just replaced. Only the reset path
      // itself stamps it — a caller that supplies an explicit `attemptCount` is
      // setting the authoritative count and is not starting a fresh lineage.
      const resetRemint = predecessorBudgetExhausted && input.attemptCount === undefined;
      const insertEvidenceExtra: Record<string, unknown> = {
        ...(staleReparkEvidence ?? {}),
        ...(resetRemint
          ? { [LINEAGE_RESET_EVIDENCE_KEY]: { inheritedDepthBefore: cumulativeDepth } }
          : {}),
      };
      // Once the fingerprint has consumed its cumulative budget, mint the
      // successor directly as the board-facing exhausted action instead of an
      // active row the sweep would only re-escalate on the next pass.
      if (
        input.attemptCount === undefined &&
        !predecessorBudgetExhausted &&
        carriedAttemptCount > effectiveMaxAttempts &&
        staleRepark
      ) {
        const staleRunId = readEvidenceRunId(prev!.evidence)!;
        const latestIssueRunId = await getLatestIssueRunId(input.companyId, input.sourceIssueId);
        // Only suppress when the cited run really is the issue's latest run, so
        // a genuinely newer failure still gets a normal active action.
        if (latestIssueRunId != null && latestIssueRunId === staleRunId) {
          const [escalated] = await db
            .insert(issueRecoveryActions)
            .values({
              ...buildInsertValues(input, "board", now, effectiveMaxAttempts),
              status: "escalated" as const,
              ownerType: "board" as const,
              ownerAgentId: null,
              ownerUserId: null,
              previousOwnerAgentId: prev!.ownerAgentId ?? input.previousOwnerAgentId ?? null,
              returnOwnerAgentId: prev!.ownerAgentId ?? input.returnOwnerAgentId ?? null,
              evidence: {
                ...(input.evidence ?? {}),
                recoveryBudget: {
                  state: "exhausted",
                  attemptsUsed: effectiveMaxAttempts,
                  maxAttempts: effectiveMaxAttempts,
                  exhaustedAt: now.toISOString(),
                  cause: input.cause,
                  fingerprint: input.fingerprint,
                  suppressedStaleRepark: true,
                },
              },
              nextAction:
                `Automatic recovery exhausted after ${effectiveMaxAttempts}/${effectiveMaxAttempts} attempts on an unchanged run ` +
                `(${staleRunId}). Dispatch a new run or choose a replacement configuration; the same stale evidence will not re-park.`,
              wakePolicy: null,
              monitorPolicy: null,
              attemptCount: effectiveMaxAttempts,
              maxAttempts: effectiveMaxAttempts,
              // DB-level terminal sentinel (`escalated` + `outcome: "exhausted"`),
              // matching the sweep. Ordinary callers cannot clear it without a
              // board resolution, so the stale loop cannot restart.
              outcome: "exhausted",
              resolutionNote: null,
              resolvedAt: null,
            })
            .returning();
          return toReadModel(escalated!);
        }
      }
      const [created] = await db
        .insert(issueRecoveryActions)
        .values(buildInsertValues(input, ownerType, now, nextAttemptCount, insertEvidenceExtra))
        .returning();
      return toReadModel(created!);
    } catch (error) {
      if (!isUniqueRecoveryActionConflict(error)) throw error;
      return retryUpsertSourceScoped(input, retryCount, error);
    }
  }

  async function upsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
  ): Promise<IssueRecoveryAction> {
    return runExclusiveUpsert(input, () => upsertSourceScopedUnlocked(input));
  }

  async function resolveActiveForIssue(
    input: ResolveIssueRecoveryActionInput,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction | null> {
    const now = new Date();
    const predicates = [
      eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.sourceIssueId, input.sourceIssueId),
      inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
    ];
    if (input.actionId) {
      predicates.push(eq(issueRecoveryActions.id, input.actionId));
    }
    if (input.kind) {
      predicates.push(eq(issueRecoveryActions.kind, input.kind));
    }
    if (input.cause) {
      predicates.push(eq(issueRecoveryActions.cause, input.cause));
    }
    if (input.fingerprint) {
      predicates.push(eq(issueRecoveryActions.fingerprint, input.fingerprint));
    }
    if (!input.boardResolution) {
      // SUP-13698: a sweep-escalated action that exhausted its attempt ceiling
      // (`escalated` + `outcome: "exhausted"`) is terminal until an explicit
      // board resolution. Ordinary callers must not erase it: clearing it
      // re-mints a new action carrying a post-ceiling attemptCount, which the
      // next sweep re-escalates and re-comments on, forever.
      predicates.push(
        or(
          ne(issueRecoveryActions.status, "escalated"),
          ne(issueRecoveryActions.outcome, "exhausted"),
          isNull(issueRecoveryActions.outcome),
        )!,
      );
    }

    const [updated] = await dbOrTx
      .update(issueRecoveryActions)
      .set({
        status: input.status,
        outcome: input.outcome,
        resolutionNote: input.resolutionNote ?? null,
        resolvedAt: now,
        updatedAt: now,
        ...(input.evidence ? { evidence: input.evidence } : {}),
      })
      .where(and(...predicates))
      .returning();

    return updated ? toReadModel(updated) : null;
  }

  return {
    getActiveForIssue,
    getLiveContinuationForIssue,
    getLatestResolvedForIssue,
    getLatestForFingerprint,
    getFingerprintAttemptTotals,
    listActiveForIssues,
    listAllForIssue,
    resolveActiveForIssue,
    upsertSourceScoped,
  };
}
