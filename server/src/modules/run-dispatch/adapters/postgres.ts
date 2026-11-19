import { hasConversationContinuationPolicy } from "../../../services/conversation-continuation.js";
import { getExecutionBlocker } from "../../../services/execution-blocker.js";
import { getNativeReviewAssignment } from "../../../services/native-runtime/native-review-participant.js";
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  issueApprovals,
  issueThreadInteractions,
  heartbeatRuns,
  issueRecoveryActions,
  issueComments,
  issues,
} from "@paperclipai/db";
import { ISSUE_DISPOSITION_REPAIR_RETRY_REASON } from "@paperclipai/shared";
import { parseObject } from "../../../adapters/utils.js";
import { evaluateAgentInvokabilityFromDb } from "../../../services/agent-invokability.js";
import { budgetService } from "../../../services/budgets.js";
import { isCompletedOnboardingHandoffWake } from "../../../services/chat-completion-delivery.js";
import { isHeartbeatWakeOnDemandEnabled } from "../../../services/heartbeat-policy.js";
import { collectDispositionRepairSourceState } from "../../../services/recovery/disposition-repair.js";
import { legacyDispositionEpisode, legacyDispositionFingerprint } from "../../../services/recovery/legacy-continuation.js";
import { appendHeartbeatRunEvent } from "../../../services/heartbeat-run-events.js";
import { emitAgentTaskRun } from "../../../services/agent-task-run-telemetry.js";
import {
  logActivityInTransaction,
  publishActivity,
  type ActivityPublication,
} from "../../../services/activity-log.js";
import { issueService } from "../../../services/issues.js";
import {
  issueTreeControlService,
  isVerifiedIssueTreeControlInteractionWake,
  ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS,
} from "../../../services/issue-tree-control.js";
import {
  continuationSummaryParksExecutor,
  getIssueContinuationSummaryDocument,
} from "../../../services/issue-continuation-summary.js";
import { parseIssueExecutionState } from "../../../services/issue-execution-policy.js";
import { resolveLiveExecutionLeases } from "../../../services/issue-execution-lease.js";
import {
  MAX_QUEUED_ISSUE_RUN_AGE_MS,
  decideQueuedRunStaleness,
  decideScheduledRetryGate,
} from "../domain/policy.js";
import type {
  QueuedRunFacts,
  QueuedRunStalenessErrorCode,
  ReviewParticipantFacts,
  RetryReasonKind,
  ScheduledRetryFacts,
} from "../domain/policy.js";
import {
  MAX_TURN_CONTINUATION_RETRY_REASON,
  allowsIssueInteractionWake,
  deriveCommentId,
  isNonAssigneeWorkspaceBusyRetry,
  isResolvedInteractionContinuationWakeContext,
} from "../domain/wake-context.js";
import type {
  CancelStaleQueuedRunInput,
  DispatchResolvedInteractionInput,
  DispatchResolvedInteractionOutcome,
  DueRetryRun,
  EvaluateScheduledRetryGateInput,
  ExpireQueuedRunInput,
  ListDueRetriesInput,
  ListExpiredQueuedRunsInput,
  ExpiredQueuedRunCandidate,
  PromoteOrCancelDueRetryInput,
  QueuedRunExpiry,
  RunDispatchWriter,
  ScheduledRetryReader,
} from "../application/ports.js";
import type {
  CancelStaleQueuedRunOutcome,
  PostCommitEffect,
  PromoteScheduledRetryOutcome,
} from "../application/types.js";
import { RunDispatchApplicationError } from "../application/types.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

/**
 * Staleness verdicts the queued-run age sweep may apply on its own: the age
 * bound itself and the two verdicts the policy reaches before it. None of them
 * needs a replacement wake, so a sweep can apply them outside the claim path.
 */
const QUEUED_RUN_EXPIRY_ERROR_CODES: Partial<Record<QueuedRunStalenessErrorCode, true>> = {
  queued_run_expired: true,
  issue_not_found: true,
  execution_reconciliation_required: true,
};

/**
 * The canonical form of a UUID. The expiry list query only takes an issueId in
 * exactly this form; a number, padded text, or any other string cannot name an
 * issue row there.
 */
const ISSUE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalizes an id read from run context before it reaches a uuid comparison.
 * Postgres also accepts a UUID in braces, in upper case, or without hyphens,
 * so those forms keep naming their row; any other value returns null instead
 * of making the query throw `invalid input syntax for type uuid`.
 */
function canonicalUuid(value: string | null): string | null {
  if (!value) return null;
  const unbraced = value.startsWith("{") && value.endsWith("}") ? value.slice(1, -1) : value;
  const hex = unbraced.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type LoadGateFactsInput = {
  conversationContinuation: boolean;
  runId: string;
  companyId: string;
  agentId: string;
  contextSnapshot: Record<string, unknown>;
  scheduledRetryReason: string | null;
  retryReasonOverride?: string | null;
  retryIsAlreadyScheduled?: boolean;
  wakeupRequestId: string | null;
};
type LoadGateFactsResult =
  | { agentFound: true; facts: ScheduledRetryFacts }
  | { agentFound: false; issueId: string | null };
type LoadStalenessFactsInput = {
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string;
  runStatus: string;
  scheduledRetryAt: Date | null;
  contextSnapshot: Record<string, unknown>;
  scheduledRetryReason: string | null;
  runCreatedAt?: Date | null;
  worktreeExecutionCutoff?: Date | null;
};
type CancelSuppressedRetryInput = {
  runId: string;
  companyId: string;
  now: Date;
  reason: string;
  errorCode: string;
  issueId: string | null;
  details: Record<string, unknown>;
};
type CancelSuppressedRetryResult = { applied: true; run: HeartbeatRun } | { applied: false };

const NO_REVIEW_PARTICIPANT: ReviewParticipantFacts = {
  isInReview: false,
  hasParticipant: false,
  participantIsAgent: false,
  participantAgentId: null,
  currentStageType: null,
  currentParticipant: null,
};

async function readNativeReviewParticipantFacts(db: Db, input: {
  companyId: string; issueId: string; agentId: string; contextSnapshot: unknown;
}): Promise<ReviewParticipantFacts | null> {
  const review = await getNativeReviewAssignment(db, input);
  return review ? {
    isInReview: true, hasParticipant: true, participantIsAgent: true,
    participantAgentId: input.agentId, currentStageType: "native_completion_review",
    currentParticipant: { type: "agent", agentId: input.agentId, interactionId: review.interaction.id },
  } : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function classifyRetryReasonKind(retryReason: string | null): RetryReasonKind {
  if (retryReason === MAX_TURN_CONTINUATION_RETRY_REASON) return "max_turn_continuation";
  if (retryReason === ISSUE_DISPOSITION_REPAIR_RETRY_REASON) return "disposition_repair";
  if ((retryReason === "ai_connection_busy" || retryReason === "ai_connection_pool_wait")) return "ai_connection_wait";
  if (retryReason === "native_safe_replacement" || retryReason === "native_provider_overloaded") return "native_safe_replacement";
  return "other";
}

function buildReviewParticipantFacts(input: {
  isInReview: boolean;
  executionState: ReturnType<typeof parseIssueExecutionState>;
}): ReviewParticipantFacts {
  const currentParticipant = input.executionState?.currentParticipant ?? null;
  return {
    isInReview: input.isInReview,
    hasParticipant: currentParticipant !== null,
    participantIsAgent: currentParticipant?.type === "agent",
    participantAgentId:
      currentParticipant?.type === "agent" ? (currentParticipant.agentId ?? null) : null,
    currentStageType: input.executionState?.currentStageType ?? null,
    currentParticipant: currentParticipant as Record<string, unknown> | null,
  };
}

function queuedEffect(run: HeartbeatRun): PostCommitEffect {
  return {
    kind: "run_queued",
    companyId: run.companyId,
    runId: run.id,
    agentId: run.agentId,
    invocationSource: run.invocationSource,
    triggerDetail: run.triggerDetail,
    wakeupRequestId: run.wakeupRequestId,
  };
}

function statusEffect(run: HeartbeatRun, previousStatus: string | null): PostCommitEffect {
  return {
    kind: "run_status_published",
    companyId: run.companyId,
    runId: run.id,
    agentId: run.agentId,
    status: run.status,
    invocationSource: run.invocationSource,
    triggerDetail: run.triggerDetail,
    error: run.error,
    errorCode: run.errorCode,
    contextSource: readNonEmptyString(parseObject(run.contextSnapshot).source),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    result: parseObject(run.resultJson),
    issueId: readNonEmptyString(parseObject(run.contextSnapshot).issueId),
    previousStatus,
  };
}

export function createPostgresRunDispatchAdapter(
  db: Db,
): ScheduledRetryReader & RunDispatchWriter & QueuedRunExpiry {
  const budgets = budgetService(db);
  const treeControlSvc = issueTreeControlService(db);
  const issuesSvc = issueService(db);

  async function withIssueThenRunLocks<T>(
    input: { runId: string; companyId: string },
    onMissing: () => T,
    operation: (tx: Db, run: HeartbeatRun) => Promise<T>,
    lockCheckoutIssue = false,
  ): Promise<T> {
    // Queue editing and claiming already use issue -> wake -> run. Read the
    // immutable issue reference without a lock first, then acquire issue ->
    // run here as well. Locking the run first can deadlock with a claimant
    // that owns the issue lock and is waiting for the run.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const hint = await db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!hint) return onMissing();
      const hintedContext = parseObject(hint.contextSnapshot);
      const hintedIssueId = readNonEmptyString(hintedContext.issueId);
      const hintedTaskKey = readNonEmptyString(hintedContext.taskKey) ??
        readNonEmptyString(hintedContext.taskId) ??
        hintedIssueId;

      const result: { kind: "missing" | "retry" } | { kind: "value"; value: T } =
        await db.transaction(async (tx) => {
          const typedTx = tx as unknown as Db;
          // A malformed issueId names no issue row; locking by it would throw.
          const lockableIssueId = canonicalUuid(hintedIssueId);
          if (lockableIssueId || lockCheckoutIssue) {
            await typedTx
              .select({ id: issues.id })
              .from(issues)
              .where(
                and(
                  eq(issues.companyId, input.companyId),
                  or(
                    lockableIssueId ? eq(issues.id, lockableIssueId) : undefined,
                    lockCheckoutIssue ? eq(issues.checkoutRunId, input.runId) : undefined,
                  ),
                ),
              )
              .orderBy(asc(issues.id))
              .for("update");
          } else if (hintedTaskKey) {
            await typedTx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${`heartbeat-retry:${input.companyId}:${hintedTaskKey}`}, 0))`,
            );
          }

          const run = await typedTx

            .select()
            .from(heartbeatRuns)
            .where(
              and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)),
            )
            // Keep the run status stable through the semantic decision and any
            // resulting mutation and synchronous dispatch handoff. Never await
            // adapter-owned work while this transaction holds the row locks.
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!run) return { kind: "missing" as const };

          const lockedIssueId = readNonEmptyString(parseObject(run.contextSnapshot).issueId);
          const lockedTaskKey = readNonEmptyString(parseObject(run.contextSnapshot).taskKey) ??
            readNonEmptyString(parseObject(run.contextSnapshot).taskId) ??
            lockedIssueId;
          if (lockedIssueId !== hintedIssueId || lockedTaskKey !== hintedTaskKey) return { kind: "retry" as const };
          return { kind: "value" as const, value: await operation(typedTx, run) };
        });

      if (result.kind === "missing") return onMissing();
      if (result.kind === "value") return result.value;
    }

    throw new Error(
      `run-dispatch: run ${input.runId} changed issue context repeatedly while acquiring locks`,
    );
  }

  async function loadGateFacts(
    input: LoadGateFactsInput,
    now: Date,
    tx?: unknown,
  ): Promise<LoadGateFactsResult> {
    // Semantic adapter operations pass their transaction here so the fact
    // read and the state transition share one unit of work. This helper is
    // deliberately not exposed through the module's public API.
    const dbOrTx = (tx as Db | undefined) ?? db;
    const budgetsForRead = tx ? budgetService(dbOrTx) : budgets;
    const treeControlForRead = tx ? issueTreeControlService(dbOrTx) : treeControlSvc;
    const issuesSvcForRead = tx ? issueService(dbOrTx) : issuesSvc;

    const agent = await dbOrTx
      .select()
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) {
      return { agentFound: false, issueId: readNonEmptyString(input.contextSnapshot.issueId) };
    }

    const retryReason =
      input.retryReasonOverride ??
      readNonEmptyString(input.contextSnapshot.retryReason) ??
      input.scheduledRetryReason ??
      null;
    const issueId = readNonEmptyString(input.contextSnapshot.issueId);
    const retryReasonKind = classifyRetryReasonKind(retryReason);

    // Facts fill in through the same rule order `decideScheduledRetryGate`
    // evaluates. A field still awaiting its own read keeps a value that
    // rule never blocks on, EXCEPT `issueFound`, which starts unresolved
    // and gets an explicit early check once the issue read lands — a
    // false default there would look exactly like "the issue is gone" the
    // moment `issueId` is set, before the read that would prove it. Once a
    // group of fields is real, this calls the gate on the facts gathered
    // so far, so a rule an earlier read already decided stops the run
    // before it pays for a later, unrelated read — a sweep of many due
    // retries must not query pause holds or dependencies for a retry a
    // budget block or a stale assignment already suppresses.
    const facts: ScheduledRetryFacts = {
      runId: input.runId,
      runAgentId: input.agentId,
      issueId,
      retryReasonKind,
      enforceIssueExecutionLock:
        retryReasonKind === "max_turn_continuation" || retryReasonKind === "ai_connection_wait",
      retryIsAlreadyScheduled: input.retryIsAlreadyScheduled,
      isNonAssigneeWorkspaceBusyRetry: isNonAssigneeWorkspaceBusyRetry(retryReason, input.contextSnapshot),
      budgetBlock: null,
      agentInvokable: true,
      agentInvokabilityDetails: {},
      agentInvokabilityInvalidOrgChain: false,
      heartbeatWakeOnDemandEnabled: true,
      issueFound: false,
      issueStatus: null,
      issueAssigneeAgentId: null,
      issueExecutionRunId: null,
      reviewParticipant: NO_REVIEW_PARTICIPANT,
      activePauseHold: null,
      dependenciesBlocked: null,
      dispositionRepair: null,
    };
    const isBlocked = () => !decideScheduledRetryGate(facts, now).allowed;

    const budgetBlock = await budgetsForRead.getInvocationBlock(input.companyId, input.agentId, {
      issueId,
      projectId: readNonEmptyString(input.contextSnapshot.projectId),
    });
    facts.budgetBlock = budgetBlock
      ? { reason: budgetBlock.reason, scopeType: budgetBlock.scopeType, scopeId: budgetBlock.scopeId }
      : null;
    if (facts.budgetBlock) return { agentFound: true, facts };

    const agentInvokability = await evaluateAgentInvokabilityFromDb(dbOrTx, agent);
    facts.agentInvokable = agentInvokability.invokable;
    facts.agentInvokabilityDetails = agentInvokability.invokable ? {} : agentInvokability.details;
    facts.agentInvokabilityInvalidOrgChain = agentInvokability.invokable
      ? false
      : agentInvokability.invalidOrgChain;
    if (!facts.agentInvokable) return { agentFound: true, facts };

    facts.heartbeatWakeOnDemandEnabled = isHeartbeatWakeOnDemandEnabled(agent);
    if (!facts.heartbeatWakeOnDemandEnabled) return { agentFound: true, facts };

    if (!issueId) return { agentFound: true, facts };

    const issueQuery = dbOrTx
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
        monitorNextCheckAt: issues.monitorNextCheckAt,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)));
    // Locking the row here, only when a caller opened a transaction for the
    // promote-or-cancel write, is what makes that write's decision hold: a
    // concurrent reassignment, pause, or status change blocks on this lock
    // instead of landing between this read and that write.
    const issue = await (tx ? issueQuery.for("update") : issueQuery).then(
      (rows) => rows[0] ?? null,
    );

    facts.issueFound = issue !== null;
    if (!facts.issueFound) return { agentFound: true, facts };

    facts.issueStatus = issue.status;
    facts.issueAssigneeAgentId = issue.assigneeAgentId;
    facts.issueExecutionRunId = issue.executionRunId;
    facts.issueCheckoutRunId = issue.checkoutRunId;
    if (input.conversationContinuation) {
      const [interactions, linkedApprovals] = await Promise.all([
        dbOrTx.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
          eq(issueThreadInteractions.companyId, input.companyId),
          eq(issueThreadInteractions.issueId, issueId), eq(issueThreadInteractions.status, "pending"),
        )).limit(1),
        dbOrTx.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals, and(
          eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, issueApprovals.companyId),
        )).where(and(
          eq(issueApprovals.companyId, input.companyId), eq(issueApprovals.issueId, issueId),
          inArray(approvals.status, ["pending", "revision_requested"]),
        )).limit(1),
      ]);
      facts.pendingResponse = interactions.length > 0 ? "interaction" : linkedApprovals.length > 0 ? "approval" : null;
    }
    facts.reviewParticipant = await readNativeReviewParticipantFacts(dbOrTx, {
      companyId: input.companyId, issueId, agentId: input.agentId,
      contextSnapshot: input.contextSnapshot,
    }) ?? buildReviewParticipantFacts({
      isInReview: issue.status === "in_review",
      executionState: parseIssueExecutionState(issue.executionState),
    });

    // The gate checks a disposition repair's own supersession before it
    // checks ownership or status, so this read must land before the next
    // isBlocked() call — checking isBlocked() first would report the wrong
    // suppression reason for a superseded repair.
    if (retryReasonKind === "disposition_repair") {
      const expectedFingerprint = readNonEmptyString(input.contextSnapshot.dispositionRepairFingerprint);
      const sourceState = await collectDispositionRepairSourceState(dbOrTx, {
        issue,
        excludeRunId: input.runId,
        excludeWakeupRequestId: input.wakeupRequestId,
      });
      let currentFingerprint = sourceState.fingerprint;
      let validSource = true;
      if (readNonEmptyString(parseObject(input.contextSnapshot.legacyDispositionEpisode).id)) {
        // Legacy repair reserves a slot in a persisted episode. Its fingerprint
        // identifies that episode, not the older parked-summary state snapshot.
        // Still recheck every active/wait/ownership gate before promotion.
        const episode = legacyDispositionEpisode({ id: input.runId, contextSnapshot: input.contextSnapshot });
        const sourceId = readNonEmptyString(input.contextSnapshot.dispositionRepairSourceRunId)
          ?? readNonEmptyString(input.contextSnapshot.retryOfRunId);
        const source = sourceId ? await dbOrTx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, sourceId), eq(heartbeatRuns.companyId, input.companyId),
        )).limit(1).then(rows => rows[0]) : null;
        validSource = Boolean(source && source.status === "succeeded" && source.agentId === input.agentId
          && (source.contextSnapshot?.issueId ?? source.contextSnapshot?.taskId) === issueId
          && legacyDispositionEpisode(source).id === episode.id
          && episode.attempt >= 1 && episode.attempt <= episode.maxAttempts);
        currentFingerprint = legacyDispositionFingerprint(input.companyId, issueId, input.agentId, episode.id);
      }
      facts.dispositionRepair = {
        expectedFingerprintPresent: expectedFingerprint !== null,
        fingerprintMatches: validSource && currentFingerprint === expectedFingerprint,
        hasActiveExecutionPath: sourceState.hasActiveExecutionPath,
        hasDurableWaitingPath: sourceState.hasDurableWaitingPath,
        expectedFingerprint,
        currentFingerprint,
        durablePathReason: sourceState.durablePathReason,
      };
    }
    if (isBlocked()) return { agentFound: true, facts };

    const activePauseHold = await treeControlForRead.getActivePauseHoldGate(input.companyId, issueId);
    facts.activePauseHold = activePauseHold
      ? { holdId: activePauseHold.holdId, rootIssueId: activePauseHold.rootIssueId }
      : null;
    if (isBlocked()) return { agentFound: true, facts };

    const dependencyReadiness = await issuesSvcForRead.listDependencyReadiness(input.companyId, [issueId]);
    const readiness = dependencyReadiness.get(issueId);
    facts.dependenciesBlocked =
      readiness && !readiness.isDependencyReady
        ? {
            unresolvedBlockerIssueIds: readiness.unresolvedBlockerIssueIds,
            unresolvedBlockerCount: readiness.unresolvedBlockerCount,
          }
        : null;

    return { agentFound: true, facts };
  }

  async function evaluateScheduledRetryGate(input: EvaluateScheduledRetryGateInput) {
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!run) {
      throw new RunDispatchApplicationError(
        "run_not_found",
        `run-dispatch: run ${input.runId} was not found while evaluating retry eligibility`,
      );
    }
    const factsResult = await loadGateFacts(
      {
        runId: run.id,
        companyId: run.companyId,
        agentId: run.agentId,
        conversationContinuation: run.runtimeMode === "legacy" && hasConversationContinuationPolicy(run.resultJson),
        contextSnapshot: parseObject(run.contextSnapshot),
        scheduledRetryReason: run.scheduledRetryReason,
        retryReasonOverride: input.retryReasonOverride,
        wakeupRequestId: run.wakeupRequestId,
      },
      input.now,
    );
    if (!factsResult.agentFound) {
      return {
        allowed: false as const,
        reason: "Scheduled retry suppressed because the agent no longer exists",
        errorCode: "agent_not_invokable" as const,
        issueId: factsResult.issueId,
        details: { agentId: run.agentId },
      };
    }
    return decideScheduledRetryGate(factsResult.facts, input.now);
  }

  async function listDueRetries(input: ListDueRetriesInput): Promise<DueRetryRun[]> {
    const rows = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.status, "scheduled_retry"),
          lte(heartbeatRuns.scheduledRetryAt, input.now),
          input.cutoff ? gte(heartbeatRuns.createdAt, input.cutoff) : undefined,
        ),
      )
      .orderBy(
        asc(heartbeatRuns.scheduledRetryAt),
        asc(heartbeatRuns.createdAt),
        asc(heartbeatRuns.id),
      )
      .limit(input.limit);

    return rows.map((row) => ({
      runId: row.id,
      companyId: row.companyId,
    }));
  }

  async function loadStalenessFacts(
    input: LoadStalenessFactsInput,
    _now: Date,
    tx?: unknown,
  ): Promise<QueuedRunFacts> {
    const dbOrTx = (tx as Db | undefined) ?? db;
    const issueId = input.issueId;
    const context = input.contextSnapshot;

    const issueQuery = dbOrTx
      .select({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)));
    const issue = await (tx ? issueQuery.for("update") : issueQuery).then(
      (rows) => rows[0] ?? null,
    );

    const wakeCommentId = deriveCommentId(context);
    const isInteractionWake = allowsIssueInteractionWake(
      context,
      ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS,
    );
    const resumeIntent = context.resumeIntent === true || context.followUpRequested === true;
    const wakeReason = readNonEmptyString(context.wakeReason);
    const retryReason =
      readNonEmptyString(context.retryReason) ?? input.scheduledRetryReason ?? null;
    const interactionResolvedAt = readNonEmptyString(context.interactionResolvedAt);
    const hasResolvedInteractionEvidence =
      interactionResolvedAt !== null && !Number.isNaN(Date.parse(interactionResolvedAt));
    const isResolvedInteractionContinuation = isResolvedInteractionContinuationWakeContext(context);

    const continuationParkApplies = Boolean(
      issue &&
        issue.status === "in_progress" &&
        !wakeCommentId &&
        !hasResolvedInteractionEvidence &&
        (wakeReason === "issue_continuation_needed" || retryReason === "issue_continuation_needed"),
    );
    let continuationSummaryBody: string | null = null;
    let continuationParksExecutor = false;
    if (continuationParkApplies) {
      const queuedWake = parseObject(context.paperclipWake);
      const queuedContinuationSummary =
        readNonEmptyString(parseObject(context.paperclipContinuationSummary).body) ??
        readNonEmptyString(parseObject(queuedWake.continuationSummary).body);
      const currentContinuationSummary = queuedContinuationSummary
        ? null
        : await getIssueContinuationSummaryDocument(dbOrTx, issueId);
      continuationSummaryBody = queuedContinuationSummary ?? currentContinuationSummary?.body ?? null;
      continuationParksExecutor = continuationSummaryParksExecutor(continuationSummaryBody);
    }

    // A malformed recovery action id names no action; comparing it would throw.
    const recoveryActionId = canonicalUuid(readNonEmptyString(context.recoveryActionId));
    const isAuthorizedSourceScopedRecovery =
      issue && wakeReason === "source_scoped_recovery_action" && recoveryActionId
        ? await dbOrTx
            .select({ id: issueRecoveryActions.id })
            .from(issueRecoveryActions)
            .where(
              and(
                eq(issueRecoveryActions.id, recoveryActionId),
                eq(issueRecoveryActions.companyId, input.companyId),
                eq(issueRecoveryActions.sourceIssueId, issue.id),
                eq(issueRecoveryActions.ownerAgentId, input.agentId),
                inArray(issueRecoveryActions.status, ["active", "escalated"]),
              ),
            )
            .limit(1)
            .then((rows) => Boolean(rows[0]))
        : false;

    const retryReasonKind = classifyRetryReasonKind(retryReason);
    // Dependency edges can change after scheduled promotion without changing
    // the displayed status. Read them again under the queued/final issue lock.
    const readiness = issue && retryReasonKind === "native_safe_replacement"
      ? (await issueService(dbOrTx).listDependencyReadiness(input.companyId, [issueId])).get(issueId)
      : null;
    const liveLease = issue
      ? (await resolveLiveExecutionLeases(dbOrTx, input.companyId, [issueId], { excludeRunId: input.runId })).get(issueId)
      : undefined;
    return {
      runId: input.runId,
      runStatus: input.runStatus,
      scheduledRetryAt: input.scheduledRetryAt,
      runAgentId: input.agentId,
      issueId,
      runCreatedAt: input.runCreatedAt ?? null,
      worktreeExecutionCutoff: input.worktreeExecutionCutoff ?? null,
      hasActiveExecutionLease: Boolean(liveLease && issue?.executionRunId === liveLease.runId),
      hasActiveCheckoutLease: Boolean(liveLease && issue?.checkoutRunId === liveLease.runId),
      retryReasonKind,
      dependenciesBlocked: readiness && !readiness.isDependencyReady ? {
        unresolvedBlockerIssueIds: readiness.unresolvedBlockerIssueIds,
        unresolvedBlockerCount: readiness.unresolvedBlockerCount,
      } : null,
      issueFound: issue !== null,
      issueStatus: issue?.status ?? null,
      issueAssigneeAgentId: issue?.assigneeAgentId ?? null,
      issueExecutionRunId: issue?.executionRunId ?? null,
      issueCheckoutRunId: issue?.checkoutRunId ?? null,
      isResolvedInteractionContinuation,
      isConnectionContinuation: (isResolvedInteractionContinuation && context.interactionKind === "connection_intent")
        || context.source === "connection_tools.refreshed",
      isInteractionWake,
      isAuthorizedSourceScopedRecovery,
      isNonAssigneeWorkspaceBusyRetry: isNonAssigneeWorkspaceBusyRetry(retryReason, context),
      resumeIntent,
      wakeCommentIdPresent: Boolean(wakeCommentId),
      isCompletedOnboardingHandoffWake: await isCompletedOnboardingHandoffWake(dbOrTx, {
        companyId: input.companyId, issueId, agentId: input.agentId,
        reason: wakeReason, contextSnapshot: context,
      }),
      continuationParkApplies,
      continuationParksExecutor,
      continuationSummaryBody,
      wakeReason,
      retryReason,
      reviewParticipant: issue
        ? await readNativeReviewParticipantFacts(dbOrTx, {
            companyId: input.companyId, issueId, agentId: input.agentId,
            contextSnapshot: context,
          }) ?? buildReviewParticipantFacts({
            isInReview: issue.status === "in_review",
            executionState: issue.status === "in_review" ? parseIssueExecutionState(issue.executionState) : null,
          })
        : NO_REVIEW_PARTICIPANT,
    };
  }

  async function promoteDueRetryInTx(
    tx: Db,
    input: PromoteOrCancelDueRetryInput,
  ): Promise<
    | { applied: true; run: HeartbeatRun; postCommitEffects: PostCommitEffect[] }
    | { applied: false }
  > {
    const [row] = await tx
      .update(heartbeatRuns)
      .set({ status: "queued", updatedAt: input.now })
      .where(
        and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.status, "scheduled_retry"),
          lte(heartbeatRuns.scheduledRetryAt, input.now),
        ),
      )
      .returning();
    if (!row) return { applied: false };

    await appendHeartbeatRunEvent(tx as unknown as Db, {
      companyId: row.companyId,
      runId: row.id,
      agentId: row.agentId,
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "Scheduled retry became due and was promoted to the queued run pool",
      payload: {
        scheduledRetryAttempt: row.scheduledRetryAttempt,
        scheduledRetryAt: row.scheduledRetryAt ? new Date(row.scheduledRetryAt).toISOString() : null,
        scheduledRetryReason: row.scheduledRetryReason,
      },
    });

    return { applied: true as const, run: row, postCommitEffects: [queuedEffect(row)] };
  }

  async function cancelSuppressedRetryInTx(
    tx: Db,
    input: CancelSuppressedRetryInput,
  ): Promise<CancelSuppressedRetryResult> {
    const [row] = await tx
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: input.now,
        error: input.reason,
        errorCode: input.errorCode,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.status, "scheduled_retry"),
          lte(heartbeatRuns.scheduledRetryAt, input.now),
        ),
      )
      .returning();
    if (!row) return { applied: false };

    if (row.wakeupRequestId) {
      await tx
        .update(agentWakeupRequests)
        .set({ status: "cancelled", finishedAt: input.now, error: input.reason, updatedAt: input.now })
        .where(
          and(
            eq(agentWakeupRequests.id, row.wakeupRequestId),
            eq(agentWakeupRequests.companyId, row.companyId),
          ),
        );
    }

    if (input.issueId) {
      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(issues.companyId, row.companyId),
            eq(issues.id, input.issueId),
            eq(issues.executionRunId, row.id),
          ),
        );
    }

    await appendHeartbeatRunEvent(tx as unknown as Db, {
      companyId: row.companyId,
      runId: row.id,
      agentId: row.agentId,
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: input.reason,
      payload: {
        ...input.details,
        scheduledRetryAttempt: row.scheduledRetryAttempt,
        scheduledRetryAt: row.scheduledRetryAt ? new Date(row.scheduledRetryAt).toISOString() : null,
        scheduledRetryReason: row.scheduledRetryReason,
      },
    });

    return { applied: true, run: row };
  }

  async function promoteOrCancelDueRetry(
    input: PromoteOrCancelDueRetryInput,
  ): Promise<PromoteScheduledRetryOutcome> {
    const now = input.now;

    const promoteLockedRun = async (tx: Db, run: HeartbeatRun) => {
      if (
        run.status !== "scheduled_retry" ||
        !run.scheduledRetryAt ||
        new Date(run.scheduledRetryAt).getTime() > now.getTime()
      ) {
        return { outcome: { outcome: "not_promoted" as const }, telemetryRun: null };
      }
      const factsResult = await loadGateFacts(
        {
          runId: run.id,
          companyId: run.companyId,
          agentId: run.agentId,
          conversationContinuation: run.runtimeMode === "legacy" && hasConversationContinuationPolicy(run.resultJson),
          contextSnapshot: parseObject(run.contextSnapshot),
          scheduledRetryReason: run.scheduledRetryReason,
          retryReasonOverride: run.scheduledRetryReason,
          retryIsAlreadyScheduled: true,
          wakeupRequestId: run.wakeupRequestId,
        },
        now,
        tx,
      );

      if (!factsResult.agentFound) {
        const cancelled = await cancelSuppressedRetryInTx(tx as unknown as Db, {
          runId: input.runId,
          companyId: input.companyId,
          now,
          reason: "Scheduled retry suppressed because the agent no longer exists",
          errorCode: "agent_not_invokable",
          issueId: factsResult.issueId,
          details: { agentId: run.agentId },
        });
        return cancelled.applied
          ? {
              outcome: {
                outcome: "gate_suppressed" as const,
                reason: "Scheduled retry suppressed because the agent no longer exists",
                errorCode: "agent_not_invokable" as const,
              },
              telemetryRun: cancelled.run,
            }
          : { outcome: { outcome: "not_promoted" as const }, telemetryRun: null };
      }

      const gate = decideScheduledRetryGate(factsResult.facts, now);

      // Preserve legacy transient retry behavior for runs that only carry a
      // loose task context rather than a persisted issue row: a missing
      // issue suppresses a max-turn continuation, but every other retry
      // reason proceeds to promotion anyway.
      const isLegacyMissingIssueException =
        !hasConversationContinuationPolicy(run.resultJson) &&
        !gate.allowed &&
        gate.errorCode === "issue_not_found" &&
        factsResult.facts.retryReasonKind !== "max_turn_continuation" &&
        factsResult.facts.retryReasonKind !== "native_safe_replacement";

      if (!gate.allowed && !isLegacyMissingIssueException) {
        const cancelled = await cancelSuppressedRetryInTx(tx as unknown as Db, {
          runId: input.runId,
          companyId: input.companyId,
          now,
          reason: gate.reason,
          errorCode: gate.errorCode,
          issueId: gate.issueId,
          details: gate.details,
        });
        return cancelled.applied
          ? {
              outcome: {
                outcome: "gate_suppressed" as const,
                reason: gate.reason,
                errorCode: gate.errorCode,
              },
              telemetryRun: cancelled.run,
            }
          : { outcome: { outcome: "not_promoted" as const }, telemetryRun: null };
      }

      const promoted = await promoteDueRetryInTx(tx as unknown as Db, {
        runId: input.runId,
        companyId: input.companyId,
        now,
      });
      return promoted.applied
        ? {
            outcome: {
              outcome: "promoted" as const,
              postCommitEffects: promoted.postCommitEffects,
            },
            telemetryRun: null,
          }
        : { outcome: { outcome: "not_promoted" as const }, telemetryRun: null };
    };
    const transactionResult = await withIssueThenRunLocks(
      input,
      () => ({ outcome: { outcome: "not_promoted" as const }, telemetryRun: null }),
      promoteLockedRun,
    );

    // Telemetry is best-effort background work; fire it only after the
    // transaction above has committed, so a suppressed retry is never
    // published before its cancellation is durable, and never published at
    // all if the transaction rolled back.
    if (transactionResult.telemetryRun) {
      void emitAgentTaskRun(db, transactionResult.telemetryRun);
    }

    return transactionResult.outcome;
  }

  async function cancelStaleRunInTx(
    tx: Db,
    run: HeartbeatRun,
    decision: Extract<ReturnType<typeof decideQueuedRunStaleness>, { stale: true }>,
    expectedStatus: "queued" | "running",
    now: Date,
    resultPatch: Record<string, unknown> = {},
  ): Promise<CancelStaleQueuedRunOutcome> {
      const [row] = await tx
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: decision.reason,
          errorCode: decision.errorCode,
          resultJson: {
            ...parseObject(run.resultJson),
            stopReason: decision.errorCode,
            ...(decision.errorCode === "execution_reconciliation_required"
              ? { executionWait: decision.details }
              : {}),
            effectiveTimeoutSec: 0,
            timeoutConfigured: false,
            timeoutSource: "stale_queued_run_gate",
            timeoutFired: false,
            ...resultPatch,
          },
          updatedAt: now,
        })
        .where(
          and(
            eq(heartbeatRuns.id, run.id),
            eq(heartbeatRuns.companyId, run.companyId),
            eq(heartbeatRuns.status, expectedStatus),
          ),
        )
        .returning();
      // A concurrent claimant or canceller already moved the run off
      // `expectedStatus`: the caller's staleness decision lost the race, so
      // this write must not overwrite whatever status won it.
      if (!row) return { outcome: "lost_race" };

      if (row.wakeupRequestId) {
        await tx
          .update(agentWakeupRequests)
          .set({ status: "skipped", finishedAt: now, error: decision.reason, updatedAt: now })
          .where(
            and(
              eq(agentWakeupRequests.id, row.wakeupRequestId),
              eq(agentWakeupRequests.companyId, row.companyId),
            ),
          );
      }

      // Release every execution lock that names this run. Matching on the run
      // id, not the context issueId, also covers a run whose context issue
      // reference is malformed or written in a non-canonical form.
      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(issues.companyId, row.companyId),
            eq(issues.executionRunId, row.id),
          ),
        );

      await tx
        .update(issues)
        .set({ checkoutRunId: null, updatedAt: now })
        .where(
          and(
            eq(issues.companyId, row.companyId),
            eq(issues.checkoutRunId, row.id),
          ),
        );

      await appendHeartbeatRunEvent(tx as unknown as Db, {
        companyId: row.companyId,
        runId: row.id,
        agentId: row.agentId,
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: decision.reason,
        payload: decision.details,
      });

      return {
        outcome: "cancelled",
        reason: decision.reason,
        errorCode: decision.errorCode,
        postCommitEffects: [statusEffect(row, expectedStatus)],
      };
  }

  async function decideCurrentRunStaleness(
    tx: Db,
    run: HeartbeatRun,
    now: Date,
    worktreeExecutionCutoff?: Date | null,
  ) {
    const contextSnapshot = parseObject(run.contextSnapshot);
    const rawIssueId = readNonEmptyString(contextSnapshot.issueId);
    const issueId = canonicalUuid(rawIssueId);
    if (!rawIssueId) {
      const predatesCutoff =
        worktreeExecutionCutoff && run.createdAt && run.createdAt.getTime() < worktreeExecutionCutoff.getTime();
      return {
        issueId: null,
        facts: null,
        decision: predatesCutoff
          ? {
              stale: true as const,
              errorCode: "execution_reconciliation_required" as const,
              reason:
                "Cancelled because the queued run predates the armed worktree execution cutoff and has no valid issue reference",
              details: {
                createdAt: run.createdAt.toISOString(),
                cutoff: worktreeExecutionCutoff.toISOString(),
                issueId: null,
              },
            }
          : { stale: false as const },
      };
    }
    if (!issueId) {
      return {
        issueId: null,
        facts: null,
        decision: {
          stale: true as const,
          errorCode: "issue_not_found" as const,
          reason: "Cancelled because the run's issue reference is not a valid issue id",
          details: { issueId: rawIssueId },
        },
      };
    }
    const recovery = await getExecutionBlocker(tx, run.companyId, issueId, { conversationResetCommentId: deriveCommentId(contextSnapshot) });
    if (recovery) return { issueId, facts: null, decision: { stale: true as const,
      errorCode: "execution_reconciliation_required" as const, reason: recovery.nextAction,
      details: { issueId, recoveryActionId: recovery.recoveryActionId },
    } };
    const facts = await loadStalenessFacts(
      {
        runId: run.id,
        companyId: run.companyId,
        agentId: run.agentId,
        issueId,
        runStatus: run.status,
        scheduledRetryAt: run.scheduledRetryAt,
        contextSnapshot,
        scheduledRetryReason: run.scheduledRetryReason,
        runCreatedAt: run.createdAt,
        worktreeExecutionCutoff,
      },
      now,
      tx,
    );
    return { issueId, facts, decision: decideQueuedRunStaleness(facts, now) };
  }

  async function cancelStaleQueuedRun(
    input: CancelStaleQueuedRunInput,
  ): Promise<CancelStaleQueuedRunOutcome> {
    const cancelLockedRun = async (tx: Db, run: HeartbeatRun) => {
      if (run.status !== input.expectedStatus) return { outcome: "lost_race" as const };
      const { issueId, facts, decision } = await decideCurrentRunStaleness(
        tx,
        run,
        input.now,
        input.worktreeExecutionCutoff,
      );
      if (!decision.stale) {
        if (input.expectedStatus === "queued" && facts?.isInteractionWake) {
          // Preserve the authority accepted under the issue/run locks. Later
          // preflight reads can observe a reassignment; they must not turn an
          // assignee comment into a non-assignee subscription-wait exception.
          await tx.update(heartbeatRuns).set({
            runnerProfileJson: {
              ...parseObject(run.runnerProfileJson),
              aiConnectionNonAssigneeCommentWake: facts.issueAssigneeAgentId !== run.agentId,
            },
          }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
        }
        return { outcome: "not_stale" as const };
      }
      return cancelStaleRunInTx(tx, run, decision, input.expectedStatus, input.now);
    };

    return withIssueThenRunLocks(
      input,
      () => {
        throw new RunDispatchApplicationError(
          "run_not_found",
          `run-dispatch: run ${input.runId} disappeared during stale-run validation`,
        );
      },
      cancelLockedRun,
      true,
    );
  }

  async function dispatchResolvedInteractionIfCurrent<T>(
    input: DispatchResolvedInteractionInput<T>,
  ): Promise<DispatchResolvedInteractionOutcome<T>> {
    const dispatchLockedRun = async (tx: Db, run: HeartbeatRun) => {
      if (run.status !== input.expectedStatus) {
        return { dispatched: false as const, cancellation: { outcome: "lost_race" as const } };
      }
      const { issueId, decision: initialDecision } = await decideCurrentRunStaleness(
        tx,
        run,
        input.now,
      );
      const decision =
        !initialDecision.stale && issueId
          ? await tx
              .select({ executionRunId: issues.executionRunId })
              .from(issues)
              .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
              .then((rows) => rows[0] ?? null)
              .then((issue) =>
                issue?.executionRunId === run.id
                  ? initialDecision
                  : {
                      stale: true as const,
                      errorCode: "issue_execution_lock_changed" as const,
                      reason:
                        "Cancelled because continuation no longer owns the issue execution lock before adapter dispatch",
                      details: {
                        issueId,
                        expectedExecutionRunId: run.id,
                        currentExecutionRunId: issue?.executionRunId ?? null,
                      },
                    },
              )
          : initialDecision;

      // A stale run with no valid issue id (malformed reference) must not dispatch either.
      if (decision.stale) {
        const cancellation = await cancelStaleRunInTx(
          tx,
          run,
          decision,
          input.expectedStatus,
          input.now,
        );
        return { dispatched: false as const, cancellation };
      }

      // Hand off while ownership is still locked, but do not await the provider
      // promise. Bootstrap and failure finalization can update these same rows;
      // the transaction must commit independently of either callback completing.
      const resultPromise = input.dispatch(() => {});
      // A synchronous rejection can precede the commit response. Observe it
      // immediately while preserving the original promise for the caller.
      void resultPromise.catch(() => {});
      return { dispatched: true as const, resultPromise };
    };

    return withIssueThenRunLocks(
      input,
      () => {
        throw new RunDispatchApplicationError(
          "run_not_found",
          `run-dispatch: run ${input.runId} disappeared before resolved-interaction dispatch`,
        );
      },
      dispatchLockedRun,
    );

  }

  async function listExpiredQueuedRuns(input: ListExpiredQueuedRunsInput): Promise<ExpiredQueuedRunCandidate[]> {
    // Issue-bound queued runs only: those are the runs that hold an issue
    // execution lock. Only a canonical UUID issueId can name an issue row; a
    // numeric or otherwise malformed issueId would never expire and would fill
    // the pages, so such rows are not listed. Companies that are not active
    // dispatch nothing, so their queue is left alone, matching resumeQueuedRuns.
    //
    // The last two predicates mirror the age rule's refusals in
    // decideQueuedRunStaleness (retry alarm not yet due; issue held by another
    // running run, as resolveLiveExecutionLeases reads it), so runs the policy
    // will not expire never use the page budget and cannot hide newer stuck
    // runs. The policy decision inside expireQueuedRun stays the authority.
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        createdAtText: sql<string>`${heartbeatRuns.createdAt}::text`,
      })
      .from(heartbeatRuns)
      .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
      .where(
        and(
          eq(heartbeatRuns.status, "queued"),
          eq(companies.status, "active"),
          lte(heartbeatRuns.createdAt, input.createdAtOrBefore),
          input.after
            ? sql`(${heartbeatRuns.createdAt}, ${heartbeatRuns.id}) > (${input.after.createdAtText}::timestamptz, ${input.after.runId}::uuid)`
            : undefined,
          sql`jsonb_typeof(${heartbeatRuns.contextSnapshot} -> 'issueId') = 'string'`,
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' ~* ${ISSUE_ID_PATTERN.source}`,
          or(isNull(heartbeatRuns.scheduledRetryAt), lte(heartbeatRuns.scheduledRetryAt, input.now)),
          sql`not exists (
            select 1
            from issues lease_issue
            join heartbeat_runs lease_holder
              on lease_holder.company_id = lease_issue.company_id
             and lease_holder.status = 'running'
             and lease_holder.id in (lease_issue.execution_run_id, lease_issue.checkout_run_id)
            where lease_issue.company_id = ${heartbeatRuns.companyId}
              and lease_issue.id::text = lower(${heartbeatRuns.contextSnapshot} ->> 'issueId')
              and lease_holder.id <> ${heartbeatRuns.id}
          )`,
        ),
      )
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(input.limit);
    return rows.map((row) => ({
      runId: row.id,
      companyId: row.companyId,
      cursor: { createdAtText: row.createdAtText, runId: row.id },
    }));
  }

  async function expireQueuedRun(input: ExpireQueuedRunInput): Promise<CancelStaleQueuedRunOutcome> {
    const publications: ActivityPublication[] = [];
    const outcome = await withIssueThenRunLocks(
      input,
      () => ({ outcome: "lost_race" as const }),
      async (tx, run): Promise<CancelStaleQueuedRunOutcome> => {
        if (run.status !== "queued") return { outcome: "lost_race" };
        // The company can be paused after the list query read it as active.
        const [company] = await tx
          .select({ status: companies.status })
          .from(companies)
          .where(eq(companies.id, run.companyId));
        if (company?.status !== "active") return { outcome: "not_stale" };
        const { issueId, decision } = await decideCurrentRunStaleness(tx, run, input.now);
        // The age bound decides; the two verdicts the policy reaches before it
        // (issue gone, issue under a recovery hold) also mean the run can never
        // start. Every other verdict carries a handoff the claim gate owns.
        if (!decision.stale || !QUEUED_RUN_EXPIRY_ERROR_CODES[decision.errorCode]) {
          return { outcome: "not_stale" };
        }
        // Same receipt the generic cancel path records for a never-started
        // legacy queued run: without it stranded-work recovery reads the
        // expired run as an uncertain provider execution and parks the issue
        // behind a board reconciliation hold instead of re-dispatching it.
        const neverStarted = run.runtimeMode !== "native" && !run.startedAt && !run.processPid;
        const cancelled = await cancelStaleRunInTx(
          tx,
          run,
          decision,
          "queued",
          input.now,
          neverStarted ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } : {},
        );
        if (cancelled.outcome !== "cancelled") return cancelled;
        await logActivityInTransaction(
          tx,
          {
            companyId: run.companyId,
            actorType: "system",
            actorId: "heartbeat",
            agentId: run.agentId,
            runId: run.id,
            action: "heartbeat.queued_run_expired",
            entityType: "heartbeat_run",
            entityId: run.id,
            issueId,
            details: {
              ...decision.details,
              source: "heartbeat.expire_stale_queued_runs",
              errorCode: decision.errorCode,
              reason: decision.reason,
              runCreatedAt: run.createdAt.toISOString(),
              maxQueuedAgeMs: MAX_QUEUED_ISSUE_RUN_AGE_MS,
            },
          },
          publications,
        );
        return cancelled;
      },
      true,
    );
    for (const publication of publications) publishActivity(publication);
    return outcome;
  }

  return {
    evaluateScheduledRetryGate,
    listDueRetries,
    cancelStaleQueuedRun,
    dispatchResolvedInteractionIfCurrent,
    promoteOrCancelDueRetry,
    listExpiredQueuedRuns,
    expireQueuedRun,
  };
}
