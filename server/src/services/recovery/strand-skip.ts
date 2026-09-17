import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  approvals,
  issueApprovals,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  routines,
} from "@paperclipai/db";
import { isExternalPullAgent } from "../agent-work-delivery.js";
import { parseIssueExecutionState } from "../issue-execution-policy.js";
import { visibleIssueCondition } from "../issue-visibility.js";
import { RECOVERY_ORIGIN_KINDS } from "./origins.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./pause-hold-guard.js";

// One shared skip predicate for the recovery strand sweeps (completed-run and
// host-restart). Both sweeps post a "likely stranded" notice; neither may post
// one on a card that a valid path already owns, or the notice duplicates a
// resolution already on the board (the SUP-16504 incident: the sweep escalated a
// card that already carried an escalated `missing_disposition` recovery action).
//
// The hold set mirrors the valid-path skips in `decideSuccessfulRunHandoff`
// (see successful-run-handoff.ts) plus one row the handoff does not check: an
// open `issue_recovery_actions` row on the source issue. Keep this as the single
// copy — the drift between the handoff's list and a hand-copied sweep list is
// what caused the bug.

export interface StrandSkipFacts {
  /**
   * A live execution-policy path owns the next action — for the completed-run
   * sweep, any non-null `issue.executionState` (mirrors the handoff's
   * `if (issue.executionState)`); for the host-restart sweep, a live review/
   * approval stage (see `hasActiveReviewStageExecutionState`), because that
   * sweep consumes the monitor dimension of `executionState` itself and a
   * monitor-only state must not suppress an exhausted-monitor escalation.
   */
  hasExecutionState: boolean;
  /** `issue.originKind` starts with `plugin:` — a plugin owns the lifecycle. */
  pluginManagedLifecycle: boolean;
  /** An `active`/`escalated` `issue_recovery_actions` row exists for this issue. */
  hasOpenRecoveryAction: boolean;
  /** An `active` routine has this issue as its `parentIssueId`. */
  hasActiveRoutineContinuation: boolean;
  /** The assignee agent receives its work out of band (`external_pull`). */
  isExternalPullAssignee: boolean;
  /** A queued/deferred/claimed `agent_wakeup_requests` row targets this issue. */
  hasPendingWake: boolean;
  /** A pending thread interaction, or a pending/revision_requested approval. */
  hasPendingInteractionOrApproval: boolean;
  /** This issue blocks an open (non-terminal, visible) issue. */
  hasExplicitBlockerPath: boolean;
  /** An open recovery issue (origin is this issue's recovery) already exists. */
  hasOpenRecoveryIssue: boolean;
  /** The issue is under an active issue-tree pause hold. */
  hasPauseHold: boolean;
}

export type StrandSkipDecision =
  | { skip: false }
  | { skip: true; reason: string };

// Reason strings align with the corresponding `decideSuccessfulRunHandoff` skip
// reasons wherever the two predicates share a hold, so parity tests can compare
// them directly.
export const STRAND_SKIP_REASONS = {
  executionState: "issue has execution policy state",
  pluginManagedLifecycle: "issue lifecycle is owned by a plugin",
  openRecoveryAction: "open recovery action owns the ambiguity",
  activeRoutineContinuation: "active routine continuation owns the next action",
  externalPull: "agent receives work out of band and cannot be judged by its run process",
  pendingWake: "issue already has a queued or deferred wake",
  pendingInteractionOrApproval: "pending interaction or approval owns the next action",
  explicitBlockerPath: "explicit blocker path owns the next action",
  openRecoveryIssue: "open recovery issue owns the ambiguity",
  pauseHold: "issue is under an active pause hold",
} as const;

// Re-exported so callers that already speak the handoff's vocabulary can reuse
// the exact string without importing successful-run-handoff.ts.
export const STRAND_EXTERNAL_PULL_SKIP_REASON = STRAND_SKIP_REASONS.externalPull;

// True when the persisted execution state has a stage in flight (a review or
// approval stage currently owns the next action). Deliberately narrower than
// `Boolean(executionState)`: a monitor-only state is not a valid path for these
// sweeps — they own monitor recovery themselves — so only a live stage is the
// "executionState review stage" hold the sweeps must honour. The host-restart
// sweep feeds this signal (see its `defaultGatherStrandSkipFacts`) so an
// exhausted monitor still escalates while a card parked in a review stage does
// not.
export function hasActiveReviewStageExecutionState(executionState: unknown): boolean {
  return parseIssueExecutionState(executionState)?.currentStageId != null;
}

// Pure. Given the gathered facts, decide whether a valid path already owns the
// card's next action. Any single true hold is enough to skip.
export function evaluateStrandSkipFacts(facts: StrandSkipFacts): StrandSkipDecision {
  if (facts.hasExecutionState) return { skip: true, reason: STRAND_SKIP_REASONS.executionState };
  if (facts.pluginManagedLifecycle) return { skip: true, reason: STRAND_SKIP_REASONS.pluginManagedLifecycle };
  if (facts.hasOpenRecoveryAction) return { skip: true, reason: STRAND_SKIP_REASONS.openRecoveryAction };
  if (facts.hasActiveRoutineContinuation) return { skip: true, reason: STRAND_SKIP_REASONS.activeRoutineContinuation };
  if (facts.isExternalPullAssignee) return { skip: true, reason: STRAND_SKIP_REASONS.externalPull };
  if (facts.hasPendingWake) return { skip: true, reason: STRAND_SKIP_REASONS.pendingWake };
  if (facts.hasPendingInteractionOrApproval) return { skip: true, reason: STRAND_SKIP_REASONS.pendingInteractionOrApproval };
  if (facts.hasExplicitBlockerPath) return { skip: true, reason: STRAND_SKIP_REASONS.explicitBlockerPath };
  if (facts.hasOpenRecoveryIssue) return { skip: true, reason: STRAND_SKIP_REASONS.openRecoveryIssue };
  if (facts.hasPauseHold) return { skip: true, reason: STRAND_SKIP_REASONS.pauseHold };
  return { skip: false };
}

export interface CollectStrandSkipFactsInput {
  companyId: string;
  issueId: string;
  assigneeAgentId: string | null;
  /** `issue.executionState`; passed through from the candidate row. */
  executionState: unknown;
  /** `issue.originKind`; passed through from the candidate row. */
  originKind: string | null;
}

// Gather every hold for one card. Runs only the queries the sweeps do not
// already run, and only when the cheap decision would otherwise escalate (the
// sweeps gate the call). Kept as plain `select`s (no joins) so the two sweeps
// can share it and the sweep tests' fake Db can answer it.
export async function collectStrandSkipFacts(
  db: Db,
  input: CollectStrandSkipFactsInput,
): Promise<StrandSkipFacts> {
  const { companyId, issueId, assigneeAgentId, executionState, originKind } = input;

  const [
    hasActiveRoutine,
    assignee,
    hasPendingWake,
    hasPendingInteraction,
    linkedApprovalIds,
    hasExplicitBlockerPath,
    hasOpenRecoveryIssue,
    hasOpenRecoveryAction,
    hasPauseHold,
  ] = await Promise.all([
    db
      .select({ id: routines.id })
      .from(routines)
      .where(
        and(
          eq(routines.companyId, companyId),
          eq(routines.parentIssueId, issueId),
          eq(routines.status, "active"),
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0),
    assigneeAgentId
      ? db
          .select({ runtimeConfig: agents.runtimeConfig })
          .from(agents)
          .where(eq(agents.id, assigneeAgentId))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed"]),
          sql`(
            ${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}
            or ${agentWakeupRequests.payload} ->> 'taskId' = ${issueId}
            or ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId' = ${issueId}
            or ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'taskId' = ${issueId}
          )`,
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0),
    db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.issueId, issueId),
          eq(issueThreadInteractions.status, "pending"),
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0),
    db
      .select({ approvalId: issueApprovals.approvalId })
      .from(issueApprovals)
      .where(and(eq(issueApprovals.companyId, companyId), eq(issueApprovals.issueId, issueId)))
      .then((rows) => rows.map((row) => row.approvalId)),
    db
      .select({ id: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
          sql`exists (
            select 1
            from issues blocker
            where blocker.id = ${issueRelations.issueId}
              and blocker.company_id = ${companyId}
              and blocker.status not in ('done', 'cancelled')
              and blocker.hidden_at is null
          )`,
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0),
    db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          inArray(issues.originKind, [
            RECOVERY_ORIGIN_KINDS.strandedIssueRecovery,
            RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
          ]),
          eq(issues.originId, issueId),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0),
    db
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0),
    isAutomaticRecoverySuppressedByPauseHold(db, companyId, issueId),
  ]);

  const hasPendingApproval =
    linkedApprovalIds.length > 0
      ? (
          await db
            .select({ id: approvals.id })
            .from(approvals)
            .where(
              and(
                inArray(approvals.id, linkedApprovalIds),
                inArray(approvals.status, ["pending", "revision_requested"]),
              ),
            )
            .limit(1)
        ).length > 0
      : false;

  return {
    hasExecutionState: Boolean(executionState),
    pluginManagedLifecycle: Boolean(originKind?.startsWith("plugin:")),
    hasOpenRecoveryAction,
    hasActiveRoutineContinuation: hasActiveRoutine,
    isExternalPullAssignee: assignee ? isExternalPullAgent(assignee) : false,
    hasPendingWake,
    hasPendingInteractionOrApproval: hasPendingInteraction || hasPendingApproval,
    hasExplicitBlockerPath,
    hasOpenRecoveryIssue,
    hasPauseHold,
  };
}
