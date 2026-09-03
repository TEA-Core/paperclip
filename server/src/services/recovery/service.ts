import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { and, asc, desc, eq, gte, gt, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql, count } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  PROVIDER_QUOTA_MONITOR_SERVICE_NAME,
  INTENTIONALLY_OWNERLESS_LABEL,
  ISSUE_DISPOSITION_REPAIR_RETRY_REASON,
  type IssueCommentMetadata,
  type IssueCommentPresentation,
  type IssueGraphLivenessAutoRecoveryPreview,
  type IssueGraphLivenessAutoRecoveryPreviewItem,
  type IssueRecoveryAction,
  type IssueRecoveryActionKind,
} from "@paperclipai/shared";
import {
  agents,
  agentWakeupRequests,
  approvals,
  activityLog,
  companies,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRunWatchdogDecisions,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issueApprovals,
  issueExecutionDecisions,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issueLabels,
  issues,
  labels,
  projects,
  unWakeableArchives,
} from "@paperclipai/db";
import { parseObject, asBoolean, asNumber } from "../../adapters/utils.js";
import { isPullOnlyAdapterType } from "../../adapters/builtin-adapter-types.js";
import { runningProcesses } from "../../adapters/index.js";
import { visibleIssueCondition } from "../issue-visibility.js";
import { forbidden, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { isPidAlive, isProcessGroupAlive, terminateLocalService } from "../local-service-supervisor.js";
import { redactSensitiveText } from "../../redaction.js";
import { isUniqueViolation } from "../../db-errors.js";
import { logActivity, redactActivityDetails } from "../activity-log.js";
import { budgetService } from "../budgets.js";
import { instanceSettingsService } from "../instance-settings.js";
import { authorizationService } from "../authorization.js";
import { DEFAULT_RECOVERY_ACTION_MAX_ATTEMPTS, issueRecoveryActionService } from "../issue-recovery-actions.js";
import { issueTreeControlService } from "../issue-tree-control.js";
import {
  IssueDependencyReadiness,
  TERMINAL_HEARTBEAT_RUN_STATUSES,
  issueService,
  listIssueDependencyReadinessMap,
  listPermanentlyUnfinalizableBlockers as listPermanentlyUnfinalizableBlockersFromIssues,
} from "../issues.js";
import {
  applyIssueMonitorPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "../issue-execution-policy.js";
import {
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
  buildIssueBlockersResolvedWakeIdempotencyKey,
  buildIssueBlockersResolvedWakeStateKey,
  buildIssueZeroBlockerHealWakeIdempotencyKey,
  findExistingIssueBlockersResolvedWakeForAnyKey,
  findExistingIssueBlockersResolvedWakeForReadyState,
} from "../issue-dependency-wakeups.js";
import { evaluateAgentInvokabilityFromDb, type AgentInvokability } from "../agent-invokability.js";
import { isHeartbeatWakeOnDemandEnabled, parseHeartbeatPolicy } from "../heartbeat-policy.js";
import { getRunLogStore } from "../run-log-store.js";
import {
  DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS,
  FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
  buildSuccessfulRunHandoffExhaustedNotice,
  isPluginManagedIssueLifecycle,
  noticeMetadataReferencesRecoveryAction,
  type SuccessfulRunHandoffNotice,
} from "./successful-run-handoff.js";
import {
  buildExecutionReviewParticipantRecoveryNoticeSeed,
  buildExecutionReviewParticipantUnavailableNoticeSeed,
  buildStrandedRecoveryEscalationNotice,
  type StrandedRecoveryNoticeSeed,
} from "./stranded-notice.js";
import {
  RECOVERY_ORIGIN_KINDS,
  buildIssueGraphLivenessLeafKey,
  isStrandedIssueRecoveryOriginKind,
  parseIssueGraphLivenessIncidentKey,
} from "./origins.js";
import {
  classifyIssueGraphLiveness,
  type IssueLivenessFinding,
} from "./issue-graph-liveness.js";
import {
  recoveryAssigneeAdapterOverrides,
  withRecoveryModelProfileHint,
} from "./model-profile-hint.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./pause-hold-guard.js";
import { assertAssigneeWriteDoesNotSelfSatisfyReviewStage } from "../issue-assignee-review-gate.js";
import { loadConfig } from "../../config.js";
import {
  canAgentSatisfyIssueWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
} from "../execution-workspace-policy.js";
import {
  collectDispositionRepairSourceState,
  dispositionRepairDelayMs,
  DISPOSITION_REPAIR_MAX_ATTEMPTS,
} from "./disposition-repair.js";

const EXECUTION_PATH_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
export const UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES = ["interrupted", "failed", "cancelled", "timed_out"] as const;
export const ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS = 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS = 4 * 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS = 30 * 60 * 1000;
// The evaluation path above only ever files review work; nothing in it terminates
// a process, and while the owning agent is paused nothing acts on the issue at
// all, so a child that hung after finishing its work stayed alive indefinitely
// and pinned its run at `running`. Hard-stop that case on a bounded timer, after
// the suspicion evaluation has had a chance to reach a human but well before the
// critical mark.
export const ACTIVE_RUN_NO_OUTPUT_TERMINATION_THRESHOLD_MS = 90 * 60 * 1000;
export const DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS = 60 * 60 * 1000;
const STRANDED_ISSUE_RECOVERY_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.strandedIssueRecovery;
const STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.staleActiveRunEvaluation;
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON = "execution_review_participant_recovery";
const STRANDED_BOARD_ESCALATION_POLICY = "board_escalation_no_takeover_v1";
const DISPOSITION_REPAIR_IDEMPOTENCY_INDEX = "agent_wakeup_requests_disposition_repair_idempotency_uq";
const RESOLVED_DEPENDENCY_WAKE_BACKSTOP_CANDIDATE_LIMIT = 500;
const PENDING_REVIEW_REARM_CANDIDATE_LIMIT = 500;
const PENDING_REVIEW_REARM_REASON = "execution_review_requested";
const BLOCKED_WITHOUT_BLOCKERS_CANDIDATE_LIMIT = 100;
const BLOCKED_WITHOUT_BLOCKERS_GRACE_THRESHOLD_MS = 15 * 60 * 1000;
const STILLBORN_ASSIGNED_BACKLOG_CANDIDATE_LIMIT = 100;
const STILLBORN_ASSIGNED_BACKLOG_RELOG_INTERVAL_MS = 5 * 60_000;
// SUP-14907: grace window so the detector does not fire against an issue that
// is still mid-filing (create → assign → promote sequence takes ~10–30 s).
// Observed worst-case filing duration on SUP-14873 was 9 s; 60 s gives a
// comfortable margin while keeping the stillborn-detection latency acceptable.
const STILLBORN_ASSIGNED_BACKLOG_GRACE_MS = 60_000;
const CANCELLED_ONLY_BLOCKER_DEPENDENT_SWEEP_LIMIT = 250;
const CANCELLED_ONLY_BLOCKER_DEPENDENT_RELOG_INTERVAL_MS = 5 * 60_000;
let lastStillbornAssignedBacklogLogAt: Date | null = null;
let lastCancelledOnlyBlockerDependentLogAt: Date | null = null;
const UNDISPATCHABLE_ASSIGNED_CANDIDATE_LIMIT = 100;
const UNDISPATCHABLE_ASSIGNED_RELOG_INTERVAL_MS = 5 * 60_000;
// SUP-14565: the first-class recovery action the undispatchable-assigned
// sweep opens once the condition is confirmed across two sweep cycles.
const UNDISPATCHABLE_ASSIGNEE_RECOVERY_KIND = "undispatchable_assignee" as const;
const UNDISPATCHABLE_ASSIGNEE_RECOVERY_CAUSE = "undispatchable_assignee";
// Bounded memory guard for the per-issue two-cycle confirmation counter: the
// map only ever holds cards observed with the condition true, and entries are
// deleted when a card is observed cleared or its action is resolved. A full
// reset is safe (it only delays escalation one cycle for tracked cards; open
// actions live in the DB, not here).
const UNDISPATCHABLE_ASSIGNED_SIGHT_COUNTS_LIMIT = 10_000;
let lastUndispatchableAssignedSweepLogAt: Date | null = null;
const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "kimi_local",
  "opencode_local",
  "pi_local",
]);

/**
 * SUP-14225: read the agent id recorded as the issue's execution return
 * assignee (the executor that owed the next action when it was bounced), if
 * any. Execution state is free-form jsonb, so every field is type-guarded.
 */
function readReturnAssigneeAgentId(executionState: unknown): string | null {
  if (!executionState || typeof executionState !== "object") return null;
  const returnAssignee = (executionState as Record<string, unknown>).returnAssignee;
  if (!returnAssignee || typeof returnAssignee !== "object") return null;
  const principal = returnAssignee as { type?: unknown; agentId?: unknown };
  if (principal.type !== "agent" || typeof principal.agentId !== "string") return null;
  return principal.agentId.length > 0 ? principal.agentId : null;
}

// GGU-809: when a stranded `in_progress` issue would otherwise hit the
// `isRepeatedProductiveContinuationRecovery` escalation path, exempt the
// escalation if the assignee posted a comment or attachment within this window.
// Batch workflows (e.g. Image Spec multi-frame generation) make real progress
// every heartbeat and would otherwise trigger a recovery issue after just two
// productive heartbeats. Floor the override at 60s to keep the exemption from
// being effectively disabled by misconfiguration.
export const STRANDED_RECENT_PROGRESS_EXEMPTION_MS = Math.max(
  60_000,
  Number(process.env.STRANDED_RECENT_PROGRESS_EXEMPTION_MS) || 30 * 60 * 1000,
);

export const RECOVERY_ACTION_WAKE_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.RECOVERY_ACTION_WAKE_INTERVAL_MS) || 5 * 60 * 1000,
);

const NO_LIVE_PATH_GRACE_THRESHOLD_MS = 15 * 60 * 1000;

type RecoveryWakeupOptions = {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
};

type RecoveryWakeup = (
  agentId: string,
  opts?: RecoveryWakeupOptions,
) => Promise<typeof heartbeatRuns.$inferSelect | null>;

type ResolvedDependencyWakeBackstopSource =
  | "issue_graph_liveness.backstop"
  | "workspace.finalize";

type ResolvedDependencyWakeBackstopOptions = {
  rearmWindowMs?: number;
  rearmMaxCount?: number;
  now?: Date;
  runId?: string | null;
  companyId?: string | null;
  blockerIssueId?: string | null;
  source?: ResolvedDependencyWakeBackstopSource;
};

type LatestIssueRun = Pick<
  typeof heartbeatRuns.$inferSelect,
  | "id"
  | "agentId"
  | "status"
  | "error"
  | "errorCode"
  | "contextSnapshot"
  | "livenessState"
  | "startedAt"
  | "createdAt"
> & {
  resultJson?: unknown;
} | null;
type SuccessfulLatestIssueRun = NonNullable<LatestIssueRun> & { status: "succeeded" };

type StrandedRecoveryCause =
  | "stranded_assigned_issue"
  | "deliberate_wait_without_target"
  | "process_lost"
  | "provider_quota"
  | "codex_output_inactivity_monitor"
  | "workspace_validation_failed"
  | "configuration_incomplete"
  | "execution_review_participant_recovery"
  // SUP-11280: a run killed by the opencode database growth guard. Distinct from
  // a plain stranded issue because the fix is to the command the run chose, not
  // to the runtime or the assignment.
  | "opencode_db_growth_limit"
  // SUP-14184: an assigned `backlog` card that never gained a live execution
  // path (stillborn at filing). Escalated via the same source-scoped action so
  // each card escalates at most once instead of re-logging every sweep tick.
  | "stillborn_assigned_backlog"
  | typeof SUCCESSFUL_RUN_MISSING_STATE_REASON;

type StrandedPreviousStatus = "backlog" | "todo" | "in_progress" | "in_review";

type SuccessfulRunHandoffRecoveryEvidence = {
  sourceRunId: string | null;
  correctiveRunId: string;
  missingDisposition: string;
  handoffAttempt: number;
  maxHandoffAttempts: number;
};

function compactRecoveryPresentation(title: string): IssueCommentPresentation {
  const normalizedTitle = title.trim();
  return {
    kind: "system_notice",
    tone: "warning",
    title: normalizedTitle.length > 160 ? `${normalizedTitle.slice(0, 159)}…` : normalizedTitle,
    detailsDefaultOpen: false,
    density: "compact",
  };
}

function recoveryCauseTitle(cause: StrandedRecoveryCause) {
  switch (cause) {
    case "process_lost":
      return "retries exhausted";
    case "codex_output_inactivity_monitor":
      return "output-inactivity retry exhausted";
    case "workspace_validation_failed":
      return "workspace validation failed";
    case "configuration_incomplete":
      return "configuration incomplete";
    case "execution_review_participant_recovery":
      return "reviewer recovery failed";
    case "provider_quota":
      return "provider quota unavailable";
    case SUCCESSFUL_RUN_MISSING_STATE_REASON:
      return "missing disposition recovery failed";
    default:
      return "execution path recovery failed";
  }
}

function recoveryNoticeMetadata(input: {
  cause: string;
  latestRun: LatestIssueRun;
  recoveryActionId?: string | null;
  previousStatus: string;
  recoveryOwner?: Pick<typeof agents.$inferSelect, "id" | "name"> | null;
}): IssueCommentMetadata {
  const rows: IssueCommentMetadata["sections"][number]["rows"] = [
    ...(input.recoveryActionId
      ? [{ type: "key_value" as const, label: "Recovery action", value: input.recoveryActionId }]
      : []),
    { type: "key_value", label: "Cause", value: input.cause },
    { type: "key_value", label: "Previous status", value: input.previousStatus },
    ...(input.recoveryOwner
      ? [{
          type: "agent_link" as const,
          label: "Recovery owner",
          agentId: input.recoveryOwner.id,
          name: input.recoveryOwner.name.slice(0, 160),
        }]
      : [{ type: "key_value" as const, label: "Recovery owner", value: "board" }]),
    ...(input.latestRun
      ? [{
          type: "run_link" as const,
          label: "Latest run",
          runId: input.latestRun.id,
          title: input.latestRun.status,
        }]
      : []),
  ];

  return {
    version: 1,
    sourceRunId: input.latestRun?.id ?? null,
    sections: [{ title: "Recovery", rows }],
  };
}

function readRecoveryRunErrorFamily(latestRun: LatestIssueRun) {
  const result = parseObject(latestRun?.resultJson);
  return readNonEmptyString(result.errorFamily);
}

function isProviderQuotaRecovery(latestRun: LatestIssueRun) {
  if (latestRun?.errorCode === "provider_quota") return true;
  if (readRecoveryRunErrorFamily(latestRun) === "provider_quota") return true;
  if (latestRun?.errorCode !== "adapter_failed") return false;
  return /(?:usage|rate|quota) limit|quota (?:exceeded|reset)|try again after/i.test(latestRun.error ?? "");
}

function resolveStrandedRecoveryCause(
  latestRun: LatestIssueRun,
  explicitCause?: StrandedRecoveryCause,
): StrandedRecoveryCause {
  if (explicitCause) return explicitCause;
  if (isProviderQuotaRecovery(latestRun)) return "provider_quota";
  if (latestRun?.errorCode === "process_lost") return "process_lost";
  if (latestRun?.errorCode === "codex_output_inactivity_monitor") {
    return "codex_output_inactivity_monitor";
  }
  if (latestRun?.errorCode === "opencode_db_growth_limit") {
    return "opencode_db_growth_limit";
  }
  return "stranded_assigned_issue";
}

function readWorkspaceValidationPayload(latestRun: LatestIssueRun): Record<string, unknown> | null {
  const payload = parseObject(parseObject(latestRun?.resultJson).workspaceValidation);
  return Object.keys(payload).length > 0 ? payload : null;
}

function readWorkspaceValidationFingerprint(latestRun: LatestIssueRun): string | null {
  const payload = readWorkspaceValidationPayload(latestRun);
  return readNonEmptyString(payload?.fingerprint);
}

function readConfigurationIncompleteFingerprint(latestRun: LatestIssueRun): string | null {
  const payload = parseObject(parseObject(latestRun?.resultJson).configurationIncomplete);
  return readNonEmptyString(payload?.fingerprint);
}

type WatchdogDecisionActor =
  | { type: "board"; userId?: string | null; runId?: string | null }
  | { type: "agent"; agentId?: string | null; runId?: string | null }
  | { type: "none" };

export type RunOutputSilenceSummary = {
  lastOutputAt: Date | null;
  lastOutputSeq: number;
  lastOutputStream: "stdout" | "stderr" | null;
  silenceStartedAt: Date | null;
  silenceAgeMs: number | null;
  level: "not_applicable" | "ok" | "suspicious" | "critical" | "snoozed";
  suspicionThresholdMs: number;
  criticalThresholdMs: number;
  snoozedUntil: Date | null;
  evaluationIssueId: string | null;
  evaluationIssueIdentifier: string | null;
  evaluationIssueAssigneeAgentId: string | null;
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function summarizeRunFailureForIssueComment(run: LatestIssueRun) {
  if (!run) return null;

  if (readNonEmptyString(run.error) || readNonEmptyString(run.errorCode)) {
    return " Latest retry failure details were withheld from the issue thread; inspect the linked run for evidence.";
  }
  return null;
}

/**
 * SUP-13090: the recovery action's `evidence.failureSummary` is API-readable state,
 * not issue-thread prose, and the "withheld" placeholder made every
 * `workspace_validation_failed` loop undiagnosable from the API alone — SUP-12986 and
 * SUP-12996 minted a fresh action every ~8s for hours with no readable cause anywhere.
 *
 * `resultJson.workspaceValidation` is server-authored structured state (a reason code
 * plus the provision command's own error), never agent transcript content, so surfacing
 * it here does not reopen what the placeholder was protecting. Fall back to the
 * placeholder whenever no structured payload was recorded.
 */
function summarizeRunFailureForRecoveryEvidence(
  run: LatestIssueRun,
  workspaceValidation: Record<string, unknown> | null,
) {
  const reason = readNonEmptyString(workspaceValidation?.reason);
  if (!reason) return summarizeRunFailureForIssueComment(run)?.trim() ?? null;

  const cause = readNonEmptyString(workspaceValidation?.cause);
  return cause ? `${reason}: ${cause.trim()}` : reason;
}


function didAutomaticRecoveryFail(
  latestRun: LatestIssueRun,
  expectedRetryReason: "assignment_recovery" | "issue_continuation_needed" | typeof EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
) {
  if (!latestRun) return false;

  const latestContext = parseObject(latestRun.contextSnapshot);
  const latestRetryReason = readNonEmptyString(latestContext.retryReason);
  return latestRetryReason === expectedRetryReason &&
    UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
      latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
    );
}

function isTerminalIssueRun(latestRun: LatestIssueRun) {
  if (!latestRun) return false;
  return TERMINAL_HEARTBEAT_RUN_STATUSES.has(latestRun.status);
}

const TRANSIENT_INFRA_CONTINUATION_ERROR_CODES = new Set<string>([
  "adapter_failed",
  "codex_transient_upstream",
  "codex_harness_crash",
  "claude_transient_upstream",
  "provider_quota",
  "timeout",
]);

const OPENCODE_DB_GROWTH_LIMIT_ERROR_CODE = "opencode_db_growth_limit";

const NON_RETRYABLE_CONTINUATION_ERROR_CODES = new Set<string>([
  "agent_not_invokable",
  "agent_not_found",
  "budget_blocked",
  "budget_exhausted",
  "issue_paused",
  "issue_dependencies_blocked",
  // SUP-11280: the opencode growth guard kills a run for the command it chose,
  // not for anything about the runtime. Continuing the same work re-runs the same
  // command and trips at the same place -- on 2026-08-06 two identical 250 MB
  // trips on one issue inside four minutes. Nothing retries its way out of this;
  // the command has to change first.
  OPENCODE_DB_GROWTH_LIMIT_ERROR_CODE,
  // SUP-13716: once ACP lane OAuth credentials become unrefreshable, every retry
  // burns an identical failed turn. Stop the storm and put the issue in a
  // board-visible blocked state so the operator can re-login. Both the ACP lane's
  // own code and the CLI lane's claude_auth_required (reached when a default-ACP
  // agent falls back to CLI after a prepare-time credential failure) are covered:
  // neither can refresh its way out of expired OAuth credentials.
  "acpx_auth_required",
  "claude_auth_required",
]);

// A continuation cancelled with this code is a *deliberate wait* (the latest run
// reported it was parked for review/approval), not a lost execution path. When the
// issue has a real waiting target we convert it into a normal dependency wait rather
// than escalating it as stranded.
const CONTINUATION_WAITING_ON_REVIEW_ERROR_CODE = "issue_continuation_waiting_on_review";
const INTERACTION_CONTINUATION_REQUEUE_MAX_ATTEMPTS = 3;

const CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS = 3;
const CONTINUATION_RECOVERY_DEFAULT_MAX_ATTEMPTS = 1;
const CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS = 60_000;
export const PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS = 60 * 60 * 1000;

const PROVIDER_QUOTA_ERROR_RE =
  /(?:you(?:'|’)ve hit your usage limit|usage limit(?: reached| exceeded)?|provider quota|quota (?:limit )?exceeded|model (?:is )?at capacity)/i;
const CONFIGURATION_INCOMPLETE_ERROR_RE =
  /(?:model_not_found|model [^\n]{0,120} not found|missing (?:api )?(?:key|credentials?)|credentials? (?:are |is )?missing|no (?:api )?(?:key|credentials?) (?:was |were )?(?:found|configured|provided)|api key (?:is )?(?:not set|unavailable))/i;

export type AdapterFailureRecoveryClassification =
  | { kind: "provider_quota"; retryAt: Date; parsedResetTime: boolean }
  | { kind: "configuration_incomplete" }
  | null;

function parseProviderQuotaClockReset(error: string, now: Date) {
  const match = error.match(
    /try again at\s+(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m\.?)?(?:\s*\(([^)]+)\)|\s+([A-Z]{2,5}))?/i,
  );
  if (!match) return null;

  const hourValue = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  const meridiem = (match[3] ?? "").toLowerCase();
  if (!Number.isInteger(hourValue)) return null;
  if (meridiem ? hourValue < 1 || hourValue > 12 : hourValue < 0 || hourValue > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour = meridiem ? hourValue % 12 : hourValue;
  if (meridiem === "p") hour += 12;
  const timeZone = (match[4] ?? match[5])?.trim();
  if (!timeZone) {
    const retryAt = new Date(now);
    retryAt.setUTCHours(hour, minute, 0, 0);
    if (retryAt.getTime() <= now.getTime()) retryAt.setUTCDate(retryAt.getUTCDate() + 1);
    return retryAt;
  }

  try {
    const wallClock = (date: Date) => Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).formatToParts(date).map((part) => [part.type, part.value]),
    );
    const nowParts = wallClock(now);
    const buildRetryAt = (dayOffset: number) => {
      const targetDay = new Date(Date.UTC(
        Number(nowParts.year),
        Number(nowParts.month) - 1,
        Number(nowParts.day) + dayOffset,
        hour,
        minute,
      ));
      let candidate = targetDay;
      const targetMs = targetDay.getTime();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const actual = wallClock(candidate);
        const actualMs = Date.UTC(
          Number(actual.year),
          Number(actual.month) - 1,
          Number(actual.day),
          Number(actual.hour),
          Number(actual.minute),
        );
        const adjustment = targetMs - actualMs;
        if (adjustment === 0) break;
        candidate = new Date(candidate.getTime() + adjustment);
      }
      return candidate;
    };
    const sameDay = buildRetryAt(0);
    return sameDay.getTime() > now.getTime() ? sameDay : buildRetryAt(1);
  } catch {
    return null;
  }
}

export function classifyAdapterFailureForRecovery(
  latestRun: Pick<NonNullable<LatestIssueRun>, "error" | "errorCode" | "resultJson">,
  now = new Date(),
): AdapterFailureRecoveryClassification {
  if (
    latestRun.errorCode !== "adapter_failed" &&
    latestRun.errorCode !== "provider_quota" &&
    latestRun.errorCode !== "configuration_incomplete"
  ) {
    return null;
  }
  const resultJson = parseObject(latestRun.resultJson);
  const error = [latestRun.errorCode ?? "", latestRun.error ?? "", JSON.stringify(resultJson)].join("\n");
  if (latestRun.errorCode === "configuration_incomplete" || CONFIGURATION_INCOMPLETE_ERROR_RE.test(error)) {
    return { kind: "configuration_incomplete" };
  }
  if (latestRun.errorCode !== "provider_quota" && !PROVIDER_QUOTA_ERROR_RE.test(error)) return null;

  const persistedRetryAt = readNonEmptyString(resultJson.retryNotBefore) ??
    readNonEmptyString(resultJson.transientRetryNotBefore) ??
    readNonEmptyString(resultJson.providerQuotaRetryNotBefore);
  const parsedPersistedRetryAt = persistedRetryAt ? new Date(persistedRetryAt) : null;
  if (parsedPersistedRetryAt && !Number.isNaN(parsedPersistedRetryAt.getTime()) && parsedPersistedRetryAt > now) {
    return { kind: "provider_quota", retryAt: parsedPersistedRetryAt, parsedResetTime: true };
  }

  const parsedClockReset = parseProviderQuotaClockReset(error, now);
  if (parsedClockReset) {
    return { kind: "provider_quota", retryAt: parsedClockReset, parsedResetTime: true };
  }
  return {
    kind: "provider_quota",
    retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
    parsedResetTime: false,
  };
}

type ContinuationRetryClassification = {
  kind: "transient_infra" | "non_retryable" | "deliberate_wait_without_target" | "default";
  maxAttempts: number;
  baseBackoffMs: number;
  errorCode: string | null;
};

export function classifyContinuationFailure(latestRun: LatestIssueRun): ContinuationRetryClassification {
  const errorCode = readNonEmptyString(latestRun?.errorCode);
  if (errorCode === CONTINUATION_WAITING_ON_REVIEW_ERROR_CODE) {
    return {
      kind: "deliberate_wait_without_target",
      maxAttempts: DISPOSITION_REPAIR_MAX_ATTEMPTS,
      baseBackoffMs: CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS,
      errorCode,
    };
  }
  if (errorCode && NON_RETRYABLE_CONTINUATION_ERROR_CODES.has(errorCode)) {
    return { kind: "non_retryable", maxAttempts: 0, baseBackoffMs: 0, errorCode };
  }
  if (errorCode && TRANSIENT_INFRA_CONTINUATION_ERROR_CODES.has(errorCode)) {
    return {
      kind: "transient_infra",
      maxAttempts: CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS,
      baseBackoffMs: CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS,
      errorCode,
    };
  }
  return {
    kind: "default",
    maxAttempts: CONTINUATION_RECOVERY_DEFAULT_MAX_ATTEMPTS,
    baseBackoffMs: 0,
    errorCode,
  };
}

function successfulRunHandoffRecoveryEvidence(latestRun: LatestIssueRun): SuccessfulRunHandoffRecoveryEvidence | null {
  if (!latestRun) return null;

  const context = parseObject(latestRun.contextSnapshot);
  const wakeReason = readNonEmptyString(context.wakeReason);
  const handoffReason = readNonEmptyString(context.handoffReason);
  const isSuccessfulRunHandoff =
    wakeReason === FINISH_SUCCESSFUL_RUN_HANDOFF_REASON ||
    handoffReason === SUCCESSFUL_RUN_MISSING_STATE_REASON ||
    asBoolean(context.handoffRequired, false) === true;
  if (!isSuccessfulRunHandoff) return null;

  const handoffAttempt = asNumber(context.handoffAttempt, 1);
  const maxHandoffAttempts = asNumber(
    context.maxHandoffAttempts,
    DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS,
  );
  return {
    sourceRunId: readNonEmptyString(context.sourceRunId) ?? readNonEmptyString(context.resumeFromRunId),
    correctiveRunId: latestRun.id,
    missingDisposition: readNonEmptyString(context.missingDisposition) ?? "clear_next_step",
    handoffAttempt,
    maxHandoffAttempts,
  };
}

function isExhaustedSuccessfulRunHandoff(latestRun: LatestIssueRun) {
  const evidence = successfulRunHandoffRecoveryEvidence(latestRun);
  if (!evidence) return null;
  if (evidence.handoffAttempt < evidence.maxHandoffAttempts) return { ...evidence, exhausted: false };
  return { ...evidence, exhausted: true };
}

function issueIdFromRunContext(contextSnapshot: unknown) {
  const context = parseObject(contextSnapshot);
  return readNonEmptyString(context.issueId) ?? readNonEmptyString(context.taskId);
}

function issueIdFromWakePayload(payload: unknown) {
  const parsed = parseObject(payload);
  const nestedContext = parseObject(parsed[DEFERRED_WAKE_CONTEXT_KEY]);
  return readNonEmptyString(parsed.issueId) ??
    readNonEmptyString(nestedContext.issueId) ??
    readNonEmptyString(nestedContext.taskId);
}

function issueUiLink(issue: { identifier: string | null; id: string }, prefix: string) {
  const label = issue.identifier ?? issue.id;
  return `[${label}](/${prefix}/issues/${label})`;
}

function runUiLink(run: { id: string; agentId: string }, prefix: string) {
  return `[${run.id}](/${prefix}/agents/${run.agentId}/runs/${run.id})`;
}

function agentUiLink(agent: { id: string; name: string | null } | null, prefix: string) {
  if (!agent) return "unknown";
  return `[${agent.name ?? agent.id}](/${prefix}/agents/${agent.id})`;
}

function formatDuration(ms: number | null) {
  if (ms === null) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatIssueLinksForComment(relations: Array<{ identifier?: string | null }>) {
  const identifiers = [
    ...new Set(
      relations
        .map((relation) => relation.identifier)
        .filter((identifier): identifier is string => Boolean(identifier)),
    ),
  ];
  if (identifiers.length === 0) return "another open issue";
  return identifiers
    .slice(0, 5)
    .map((identifier) => {
      const prefix = identifier.split("-")[0] || "PAP";
      return `[${identifier}](/${prefix}/issues/${identifier})`;
    })
    .join(", ");
}

function isStrandedIssueRecoveryIssue(issue: Pick<typeof issues.$inferSelect, "originKind">) {
  return isStrandedIssueRecoveryOriginKind(issue.originKind);
}

/**
 * True when the issue's latest run was cancelled by a board operator (the
 * board cancel route stamps the attribution; interrupt-by-comment uses the
 * operator_interrupted error code). While such a run is the latest activity
 * on an issue, recovery stands down entirely: the operator deliberately
 * stopped the agent, and re-waking it — or escalating "stranding" — would
 * fight the human. Any newer run or wake supersedes the exemption.
 */
function isOperatorCancelledRun(latestRun: LatestIssueRun): boolean {
  if (!latestRun || latestRun.status !== "cancelled") return false;
  if (latestRun.errorCode === "operator_interrupted") return true;
  const result = parseObject(latestRun.resultJson);
  return result.cancelledByActorType === "user" || result.cancelledByActorType === "board";
}

function isUnsuccessfulTerminalIssueRun(latestRun: LatestIssueRun) {
  return Boolean(
    latestRun &&
      UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
        latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
      ),
  );
}

function isSuccessfulInProgressContinuationRun(latestRun: LatestIssueRun): latestRun is SuccessfulLatestIssueRun {
  return latestRun?.status === "succeeded";
}

function isProductiveContinuationRun(latestRun: LatestIssueRun) {
  return latestRun?.status === "succeeded" &&
    (latestRun.livenessState === "advanced" ||
      latestRun.livenessState === "completed" ||
      latestRun.livenessState === "blocked" ||
      latestRun.livenessState === "needs_followup");
}

function isRepeatedProductiveContinuationRecovery(latestRun: SuccessfulLatestIssueRun) {
  const latestContext = parseObject(latestRun.contextSnapshot);
  return readNonEmptyString(latestContext.retryReason) === "issue_continuation_needed" &&
    readNonEmptyString(latestContext.source) === "issue.productive_terminal_continuation_recovery" &&
    isProductiveContinuationRun(latestRun);
}

function parseLivenessIncidentKey(incidentKey: string | null | undefined) {
  if (!incidentKey) return null;
  return parseIssueGraphLivenessIncidentKey(incidentKey);
}

function livenessRecoveryLeafIssueId(finding: IssueLivenessFinding) {
  return finding.recoveryIssueId;
}

function livenessRecoveryLeafFingerprint(finding: IssueLivenessFinding) {
  return buildIssueGraphLivenessLeafKey({
    companyId: finding.companyId,
    state: finding.state,
    leafIssueId: livenessRecoveryLeafIssueId(finding),
  });
}

function livenessRecoveryLeafKey(companyId: string, state: string, leafIssueId: string) {
  return buildIssueGraphLivenessLeafKey({ companyId, state, leafIssueId });
}

function isUniqueLivenessRecoveryConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: string; constraint?: string; message?: string };
  return maybe.code === "23505" &&
    (
      maybe.constraint === "issues_active_liveness_recovery_incident_uq" ||
      maybe.constraint === "issues_active_liveness_recovery_leaf_uq" ||
      typeof maybe.message === "string" &&
        (
          maybe.message.includes("issues_active_liveness_recovery_incident_uq") ||
          maybe.message.includes("issues_active_liveness_recovery_leaf_uq")
        )
    );
}

function formatDependencyPath(finding: IssueLivenessFinding) {
  return finding.dependencyPath
    .map((entry) => entry.identifier ?? entry.issueId)
    .join(" -> ");
}

function buildLivenessEscalationDescription(finding: IssueLivenessFinding) {
  const source = finding.dependencyPath[0];
  const recovery = finding.dependencyPath.find((entry) => entry.issueId === finding.recoveryIssueId);
  const selectedOwner = finding.recommendedOwnerAgentId ?? "none";

  return [
    "Paperclip detected a harness-level issue graph liveness incident.",
    "",
    "## Source",
    "",
    `- Source issue: ${source?.identifier ?? source?.issueId ?? finding.issueId}`,
    `- Recovery target issue: ${recovery?.identifier ?? recovery?.issueId ?? finding.recoveryIssueId}`,
    `- Incident key: \`${finding.incidentKey}\``,
    `- Detected invariant: \`${finding.state}\``,
    `- Dependency path: ${formatDependencyPath(finding)}`,
    `- Reason: ${finding.reason}`,
    "",
    "## Ownership",
    "",
    `- Selected owner agent: \`${selectedOwner}\``,
    `- Candidate owner agents: ${finding.recommendedOwnerCandidateAgentIds.length > 0 ? finding.recommendedOwnerCandidateAgentIds.map((id) => `\`${id}\``).join(", ") : "none"}`,
    "",
    "## Next Action",
    "",
    finding.recommendedAction,
    "",
    "Resolve the blocked chain, then mark this escalation issue done so the original issue can resume when all blockers are cleared.",
  ].join("\n");
}

function buildLivenessOriginalIssueComment(finding: IssueLivenessFinding, escalation: typeof issues.$inferSelect) {
  return [
    "Paperclip detected a harness-level liveness incident in this issue's dependency graph.",
    "",
    `- Escalation issue: ${escalation.identifier ?? escalation.id}`,
    `- Incident key: \`${finding.incidentKey}\``,
    `- Finding: \`${finding.state}\``,
    `- Dependency path: ${formatDependencyPath(finding)}`,
    `- Reason: ${finding.reason}`,
    `- Manager action requested: ${finding.recommendedAction}`,
    "",
    "This issue now keeps its existing blockers and is also blocked by the escalation issue so dependency wakeups remain explicit.",
  ].join("\n");
}

export function isBlockedWithoutBlockers(input: { status: string; blockerIssueIds: string[] }): boolean {
  return input.status === "blocked" && input.blockerIssueIds.length === 0;
}

async function unresolvedBlockerIssues(db: Db, companyId: string, issueId: string) {
  return db
    .select({ id: issueRelations.issueId, identifier: issues.identifier })
    .from(issueRelations)
    .innerJoin(
      issues,
      and(
        eq(issues.companyId, issueRelations.companyId),
        eq(issues.id, issueRelations.issueId),
      ),
    )
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.relatedIssueId, issueId),
        eq(issueRelations.type, "blocks"),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    );
}

/**
 * Write status:"blocked" with the issue's current unresolved blocker set, from one place.
 *
 * A `blocked` row with an **empty** blocker set is not stranded in this fork — it has two
 * wake paths, and which one applies depends on whether a recovery action owns it:
 *
 * - no live action → the dependency-wake backstop's zero-blocker heal (#41, SUP-10663) wakes
 *   the assignee directly; that path exists for exactly these rows.
 * - a live action → the heal defers to it (`hasActiveOrEscalatedRecoveryAction`), and the
 *   owner — or the #46 (SUP-10792) sweep when the owner stalls — re-arms the issue. Once that
 *   sweep exhausts its ceiling the action stops counting as live, so the row falls back to the
 *   zero-blocker heal above rather than deferring to a path that has given up.
 *
 * So the write always happens. Refusing it would be worse than a no-op: contained workspace
 * failures usually carry no issue-level blocker at all (the blocker is environmental), and
 * dropping the write leaves the issue `in_progress` and free to be re-dispatched onto the
 * workspace that just failed containment. See heartbeat-workspace-branch-containment.test.ts.
 *
 * The empty case is logged rather than blocked, so the heal path stays observable.
 */
export async function blockIssueWithUnresolvedBlockers(
  db: Db,
  issue: { id: string; companyId: string; identifier: string | null; status: string },
  opts: { source: string; previousStatus: string; extraUpdate?: Record<string, unknown> },
) {
  const blockedByIssueIds = (await unresolvedBlockerIssues(db, issue.companyId, issue.id)).map((row) => row.id);
  if (blockedByIssueIds.length === 0) {
    logger.info(
      { issueId: issue.id, identifier: issue.identifier, source: opts.source, previousStatus: opts.previousStatus },
      "recovery blocked-write has an empty blocker set; zero-blocker heal or recovery owner will wake it",
    );
  }
  return (await issueService(db).update(issue.id, { status: "blocked", blockedByIssueIds, ...opts.extraUpdate })) ?? null;
}

export function recoveryService(db: Db, deps: { enqueueWakeup: RecoveryWakeup }) {
  const issuesSvc = issueService(db);
  const recoveryActionsSvc = issueRecoveryActionService(db);
  const treeControlSvc = issueTreeControlService(db);
  const budgets = budgetService(db);
  const instanceSettings = instanceSettingsService(db);
  const authz = authorizationService(db);
  const runLogStore = getRunLogStore();
  let resolvedDependencyWakeBackstopCandidateCursor: string | null = null;
  let undispatchableAssignedScanCursor: string | null = null;
  // Two-cycle confirmation counter (SUP-14565): issueId -> number of sweep
  // cycles the card has been observed with the undispatchable-assigned
  // condition true. Per service instance, so a control-plane restart counts
  // first-sight again; open recovery actions themselves are persisted and
  // unaffected by the restart.
  const undispatchableAssignedSightCounts = new Map<string, number>();

  async function getAgent(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
  }

  async function getAgentInvokability(agent: typeof agents.$inferSelect | null | undefined): Promise<AgentInvokability> {
    return evaluateAgentInvokabilityFromDb(db, agent);
  }

  async function isAgentInvokable(agent: typeof agents.$inferSelect | null | undefined) {
    return (await getAgentInvokability(agent)).invokable;
  }

  async function getLatestIssueRun(companyId: string, issueId: string): Promise<LatestIssueRun> {
    return db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        livenessState: heartbeatRuns.livenessState,
        resultJson: heartbeatRuns.resultJson,
        startedAt: heartbeatRuns.startedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getLatestIssueRunForAgent(
    companyId: string,
    issueId: string,
    agentId: string,
  ): Promise<LatestIssueRun> {
    return db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        livenessState: heartbeatRuns.livenessState,
        resultJson: heartbeatRuns.resultJson,
        startedAt: heartbeatRuns.startedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function summarizeRecentContinuationRetries(
    companyId: string,
    issueId: string,
    agentId: string,
    errorCodeToMatch: string | null,
    since: Date | null = null,
  ) {
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          ...(since ? [or(gte(heartbeatRuns.createdAt, since), gte(heartbeatRuns.finishedAt, since))] : []),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(10);

    let consecutive = 0;
    let latestFinishedAt: Date | null = null;
    for (const row of rows) {
      // SUP-12466: the bound keys on *repetition of the same errorCode with zero
      // progress*, not on retryReason. The stranded recovery re-dispatch can produce
      // runs that carry no `retryReason` (source-scoped recovery wakes / assignment
      // wakes), so do not break on the retryReason stamp -- any consecutive
      // terminal-unsuccessful run with a matching errorCode counts toward the cap.
      if (
        !UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
          row.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
        )
      ) {
        break;
      }

      const rowErrorCode = readNonEmptyString(row.errorCode);
      if (errorCodeToMatch !== rowErrorCode) {
        break;
      }

      consecutive += 1;
      if (latestFinishedAt === null) latestFinishedAt = row.finishedAt ?? null;
    }
    return { consecutive, latestFinishedAt };
  }

  function hasFutureMonitorCheck(monitorNextCheckAt: string | Date | null | undefined) {
    if (!monitorNextCheckAt) return false;
    return new Date(monitorNextCheckAt).getTime() > Date.now();
  }

  async function hasActiveExecutionPath(
    companyId: string,
    issueId: string,
    agentId?: string | null,
    monitorNextCheckAt?: string | Date | null,
  ) {
    if (hasFutureMonitorCheck(monitorNextCheckAt)) return true;

    const [run, deferredWake] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
            agentId ? eq(heartbeatRuns.agentId, agentId) : sql`true`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
            agentId ? eq(agentWakeupRequests.agentId, agentId) : sql`true`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    return Boolean(run || deferredWake);
  }

  async function hasPendingWakeInteraction(companyId: string, issueId: string) {
    return db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.issueId, issueId),
          eq(issueThreadInteractions.status, "pending"),
          inArray(issueThreadInteractions.continuationPolicy, ["wake_assignee", "wake_assignee_on_accept"]),
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  // "Live" means the action can still re-arm the issue on its own. An action
  // that walked its attempt ceiling is `escalated` with `outcome:'exhausted'`:
  // the sweep has stopped re-firing it and it now waits on a board operator, so
  // it must NOT be treated as covering the issue. Counting it as live would let
  // the zero-blocker heal defer forever to a path that has already given up.
  // `outcome` is null for actions that have not concluded, so NULL counts as live.
  async function hasActiveOrEscalatedRecoveryAction(companyId: string, issueId: string) {
    return db
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
          or(
            isNull(issueRecoveryActions.outcome),
            ne(issueRecoveryActions.outcome, "exhausted"),
          ),
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function hasPersistedDurableWaitPath(issue: typeof issues.$inferSelect) {
    if (hasFutureMonitorCheck(issue.monitorNextCheckAt)) return true;

    return db
      .select({ id: issueRelations.issueId })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(
        and(
          eq(issueRelations.companyId, issue.companyId),
          eq(issueRelations.relatedIssueId, issue.id),
          eq(issueRelations.type, "blocks"),
          eq(issues.companyId, issue.companyId),
          notInArray(issues.status, ["done", "cancelled"]),
          isNull(issues.hiddenAt),
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function wasTodoHandedBackDuringOrAfterLatestRun(
    issue: typeof issues.$inferSelect,
    latestRun: LatestIssueRun,
  ) {
    if (issue.status !== "todo" || latestRun?.status !== "succeeded") return false;
    const runBeganAt = latestRun.startedAt ?? latestRun.createdAt;

    return db
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, issue.companyId),
          eq(issueRecoveryActions.sourceIssueId, issue.id),
          eq(issueRecoveryActions.status, "resolved"),
          eq(issueRecoveryActions.outcome, "handed_back"),
          gte(issueRecoveryActions.resolvedAt, runBeganAt),
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function hasQueuedIssueWake(companyId: string, issueId: string, agentId?: string | null) {
    return db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.status, "queued"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
          agentId ? eq(agentWakeupRequests.agentId, agentId) : sql`true`,
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function getLatestAcceptedContinuationInteraction(companyId: string, issueId: string) {
    return db
      .select({
        id: issueThreadInteractions.id,
        kind: issueThreadInteractions.kind,
        status: issueThreadInteractions.status,
        continuationPolicy: issueThreadInteractions.continuationPolicy,
        sourceRunId: issueThreadInteractions.sourceRunId,
        resolvedAt: issueThreadInteractions.resolvedAt,
        updatedAt: issueThreadInteractions.updatedAt,
      })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.issueId, issueId),
          eq(issueThreadInteractions.status, "accepted"),
          inArray(issueThreadInteractions.continuationPolicy, ["wake_assignee", "wake_assignee_on_accept"]),
        ),
      )
      .orderBy(desc(sql`coalesce(${issueThreadInteractions.resolvedAt}, ${issueThreadInteractions.updatedAt})`), desc(issueThreadInteractions.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function hasSuccessfulIssueRunSince(
    companyId: string,
    issueId: string,
    agentId: string,
    since: Date,
    interactionId?: string | null,
  ) {
    return db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          eq(heartbeatRuns.status, "succeeded"),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          interactionId
            ? sql`${heartbeatRuns.contextSnapshot} ->> 'interactionId' = ${interactionId}`
            : sql`true`,
          or(gte(heartbeatRuns.createdAt, since), gte(heartbeatRuns.finishedAt, since)),
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function getLatestIssueRunSince(companyId: string, issueId: string, agentId: string, since: Date): Promise<LatestIssueRun> {
    return db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        livenessState: heartbeatRuns.livenessState,
        resultJson: heartbeatRuns.resultJson,
        startedAt: heartbeatRuns.startedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          or(gte(heartbeatRuns.createdAt, since), gte(heartbeatRuns.finishedAt, since)),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  // GGU-809: visible-progress signal for stranded-recovery escalation guard.
  // Returns true if the assignee posted a comment, OR any attachment was added
  // to the issue, within `windowMs`. Used to suppress false-positive recovery
  // issues for batch workflows that genuinely advance every heartbeat.
  async function hasRecentVisibleProgress(
    companyId: string,
    issueId: string,
    assigneeAgentId: string,
    windowMs: number,
  ) {
    const since = new Date(Date.now() - windowMs);
    const [comment, attachment] = await Promise.all([
      db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            eq(issueComments.issueId, issueId),
            eq(issueComments.authorAgentId, assigneeAgentId),
            gt(issueComments.createdAt, since),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: issueAttachments.id })
        .from(issueAttachments)
        .where(
          and(
            eq(issueAttachments.companyId, companyId),
            eq(issueAttachments.issueId, issueId),
            gt(issueAttachments.createdAt, since),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(comment || attachment);
  }

  /**
   * SUP-9858. `enqueueWakeup` refuses a wake on two conditions that are pure
   * functions of state the sweeps already hold: the assignee's `wakeOnDemand`
   * policy, and whether the issue still has unresolved blockers. Neither
   * refusal is free — each writes a `skipped` row into `agent_wakeup_requests`
   * — and the sweeps re-nominate the same candidate every pass with no
   * backoff, so a single structurally-unwakeable agent produced ~6,500 rows a
   * day and buried genuine skips in noise. Ask here instead of asking the
   * wake path to say no forever.
   *
   * The dependency arm mirrors the gate's own precondition: it only refuses
   * when there is no active execution run, which every caller below has
   * already established via `hasActiveExecutionPath`.
   */
  async function staticWakeRefusalReason(issueId: string, agentId: string) {
    const agent = await getAgent(agentId);
    if (!agent) return "agent_unavailable" as const;
    if (!parseHeartbeatPolicy(agent).wakeOnDemand) return "wake_on_demand_disabled" as const;

    const readiness = await issuesSvc
      .listDependencyReadiness(agent.companyId, [issueId])
      .then((rows) => rows.get(issueId) ?? null);
    if (readiness && !readiness.isDependencyReady) return "issue_dependencies_blocked" as const;

    return null;
  }

  async function isWakeStaticallyRefused(issueId: string, agentId: string) {
    const reason = await staticWakeRefusalReason(issueId, agentId);
    if (!reason) return false;
    logger.debug(
      { issueId, agentId, reason },
      "recovery sweep skipped a wake its own gate would refuse",
    );
    return true;
  }

  async function enqueueStrandedIssueRecovery(input: {
    issueId: string;
    agentId: string;
    reason: "issue_assignment_recovery" | "issue_continuation_needed" | typeof EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON;
    retryReason: "assignment_recovery" | "issue_continuation_needed" | typeof EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON;
    source: string;
    retryOfRunId?: string | null;
    extraContext?: Record<string, unknown>;
  }) {
    if (await isWakeStaticallyRefused(input.issueId, input.agentId)) return null;

    const queued = await deps.enqueueWakeup(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: input.reason,
      payload: withRecoveryModelProfileHint({
        issueId: input.issueId,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
        ...(input.extraContext ?? {}),
      }, "normal_model"),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: input.issueId,
        taskId: input.issueId,
        wakeReason: input.reason,
        retryReason: input.retryReason,
        source: input.source,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
        ...(input.extraContext ?? {}),
      }, "normal_model"),
    });

    if (queued && input.retryOfRunId) {
      return db
        .update(heartbeatRuns)
        .set({
          retryOfRunId: input.retryOfRunId,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, queued.id))
        .returning()
        .then((rows) => rows[0] ?? queued);
    }

    return queued;
  }

  async function enqueueInitialAssignedTodoDispatch(issue: typeof issues.$inferSelect, agentId: string) {
    if (await isWakeStaticallyRefused(issue.id, agentId)) return null;

    return deps.enqueueWakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: withRecoveryModelProfileHint({
        issueId: issue.id,
        mutation: "assigned_todo_liveness_dispatch",
      }, "normal_model"),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: issue.id,
        taskId: issue.id,
        wakeReason: "issue_assigned",
        source: "issue.assigned_todo_liveness_dispatch",
      }, "normal_model"),
    });
  }

  async function isInvocationBudgetBlocked(issue: typeof issues.$inferSelect, agentId: string) {
    const budgetBlock = await budgets.getInvocationBlock(issue.companyId, agentId, {
      issueId: issue.id,
      projectId: issue.projectId,
    });
    return Boolean(budgetBlock);
  }

  async function reconcileUnassignedBlockingIssues() {
    const candidates = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        status: issues.status,
        createdByAgentId: issues.createdByAgentId,
        assigneeAgentId: issues.assigneeAgentId,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(
        and(
          eq(issueRelations.type, "blocks"),
          inArray(issues.status, ["todo", "blocked"]),
          isNull(issues.assigneeAgentId),
          isNull(issues.assigneeUserId),
          sql`${issues.createdByAgentId} is not null`,
          sql`exists (
            select 1
            from issues blocked_issue
            where blocked_issue.id = ${issueRelations.relatedIssueId}
              and blocked_issue.company_id = ${issues.companyId}
              and blocked_issue.status not in ('done', 'cancelled')
          )`,
        ),
      );

    let assigned = 0;
    let skipped = 0;
    const issueIds: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);

      const creatorAgentId = candidate.createdByAgentId;
      if (!creatorAgentId) {
        skipped += 1;
        continue;
      }

      // SUP-14225: prefer the recorded return assignee — the platform's own
      // record of the agent that owed the next action — over the creator.
      // The creator is the fallback when no usable return assignee is
      // recorded (none, not in-company, or not invokable).
      let nextAgent: typeof agents.$inferSelect | null = null;
      let reassignSource: "return_assignee" | "creator" = "creator";
      const returnAssigneeAgentId = readReturnAssigneeAgentId(candidate.executionState);
      if (returnAssigneeAgentId) {
        const returnAgent = await getAgent(returnAssigneeAgentId);
        if (returnAgent && returnAgent.companyId === candidate.companyId && (await isAgentInvokable(returnAgent))) {
          nextAgent = returnAgent;
          reassignSource = "return_assignee";
        }
      }
      if (!nextAgent) {
        const creatorAgent = await getAgent(creatorAgentId);
        if (!creatorAgent || creatorAgent.companyId !== candidate.companyId || !(await isAgentInvokable(creatorAgent))) {
          skipped += 1;
          continue;
        }
        nextAgent = creatorAgent;
      }

      const relations = await issuesSvc.getRelationSummaries(candidate.id);
      const blockingLinks = formatIssueLinksForComment(relations.blocks);
      // SUP-13526: route this recovery reassignment through the same gate as
      // the PATCH handler and the other recovery paths. A refusal keeps the
      // blocker unassigned instead of making its review stage self-satisfiable.
      const nextAssigneeAgentId = resolveRecoveryReassignedAssignee(candidate, nextAgent.id);
      if (!nextAssigneeAgentId) {
        skipped += 1;
        continue;
      }
      const updated = await issuesSvc.update(candidate.id, {
        assigneeAgentId: nextAssigneeAgentId,
        assigneeUserId: null,
      });
      if (!updated) {
        skipped += 1;
        continue;
      }

      await issuesSvc.addComment(
        candidate.id,
        [
          "## Assigned Orphan Blocker",
          "",
          `Paperclip found this issue is blocking ${blockingLinks} but had no assignee, so no heartbeat could pick it up.`,
          "",
          reassignSource === "return_assignee"
            ? "- Assigned it to the recorded return assignee (the executor that owed the next action), not to the creator."
            : "- Assigned it back to the agent that created the blocker (no usable return assignee was recorded).",
          "- Next action: resolve this blocker or reassign it to the right owner.",
        ].join("\n"),
        {},
      );

      await logActivity(db, {
        companyId: candidate.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.updated",
        entityType: "issue",
        entityId: candidate.id,
        details: {
          identifier: candidate.identifier,
          assigneeAgentId: nextAssigneeAgentId,
          reassignSource,
          source: "recovery.reconcile_unassigned_blocking_issue",
        },
      });

      const queued = await deps.enqueueWakeup(nextAssigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: withRecoveryModelProfileHint({
          issueId: candidate.id,
          mutation: "unassigned_blocker_recovery",
        }, "normal_model"),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: candidate.id,
          taskId: candidate.id,
          wakeReason: "issue_assigned",
          source: "issue.unassigned_blocker_recovery",
        }, "normal_model"),
      });

      if (queued) {
        assigned += 1;
        issueIds.push(candidate.id);
      } else {
        skipped += 1;
      }
    }

    return { assigned, skipped, issueIds };
  }

  async function getCompanyIssuePrefix(companyId: string) {
    return db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.issuePrefix ?? "PAP");
  }

  function isTerminalIssueStatus(status: string | null | undefined) {
    return status === "done" || status === "cancelled";
  }

  function silenceStartedAtForRun(run: Pick<typeof heartbeatRuns.$inferSelect, "lastOutputAt" | "processStartedAt" | "startedAt" | "createdAt">) {
    return run.lastOutputAt ?? run.processStartedAt ?? run.startedAt ?? run.createdAt ?? null;
  }

  function silenceAgeMsForRun(run: Pick<typeof heartbeatRuns.$inferSelect, "lastOutputAt" | "processStartedAt" | "startedAt" | "createdAt">, now = new Date()) {
    const startedAt = silenceStartedAtForRun(run);
    return startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : null;
  }

  async function activeOutputDecisionState(companyId: string, runId: string, now = new Date()) {
    const [quietUntilRows, dismissedRows] = await Promise.all([
      db
        .select({
          decision: heartbeatRunWatchdogDecisions.decision,
          snoozedUntil: heartbeatRunWatchdogDecisions.snoozedUntil,
        })
        .from(heartbeatRunWatchdogDecisions)
        .where(
          and(
            eq(heartbeatRunWatchdogDecisions.companyId, companyId),
            eq(heartbeatRunWatchdogDecisions.runId, runId),
            inArray(heartbeatRunWatchdogDecisions.decision, ["snooze", "continue"]),
            gt(heartbeatRunWatchdogDecisions.snoozedUntil, now),
          ),
        )
        .orderBy(desc(heartbeatRunWatchdogDecisions.createdAt))
        .limit(1),
      db
        .select({ id: heartbeatRunWatchdogDecisions.id })
        .from(heartbeatRunWatchdogDecisions)
        .where(
          and(
            eq(heartbeatRunWatchdogDecisions.companyId, companyId),
            eq(heartbeatRunWatchdogDecisions.runId, runId),
            eq(heartbeatRunWatchdogDecisions.decision, "dismissed_false_positive"),
          ),
        )
        .limit(1),
    ]);
    return {
      dismissedFalsePositive: dismissedRows.length > 0,
      quietUntilDecision: quietUntilRows[0] ?? null,
    };
  }

  async function latestActiveOutputQuietUntilDecision(companyId: string, runId: string, now = new Date()) {
    const [row] = await db
      .select()
      .from(heartbeatRunWatchdogDecisions)
      .where(
        and(
          eq(heartbeatRunWatchdogDecisions.companyId, companyId),
          eq(heartbeatRunWatchdogDecisions.runId, runId),
          inArray(heartbeatRunWatchdogDecisions.decision, ["snooze", "continue"]),
          gt(heartbeatRunWatchdogDecisions.snoozedUntil, now),
        ),
      )
      .orderBy(desc(heartbeatRunWatchdogDecisions.createdAt))
      .limit(1);
    return row ?? null;
  }

  async function findOpenStaleRunEvaluation(companyId: string, runId: string) {
    const [row] = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND),
          eq(issues.originId, runId),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function buildRunOutputSilence(
    run: Pick<
      typeof heartbeatRuns.$inferSelect,
      "id" | "companyId" | "status" | "lastOutputAt" | "lastOutputSeq" | "lastOutputStream" | "processStartedAt" | "startedAt" | "createdAt"
    >,
    now = new Date(),
  ): Promise<RunOutputSilenceSummary> {
    const [decisionState, evaluation] = await Promise.all([
      activeOutputDecisionState(run.companyId, run.id, now),
      findOpenStaleRunEvaluation(run.companyId, run.id),
    ]);
    const { dismissedFalsePositive, quietUntilDecision } = decisionState;
    const silenceStartedAt = silenceStartedAtForRun(run);
    const silenceAgeMs = run.status === "running" ? silenceAgeMsForRun(run, now) : null;
    const level = run.status !== "running"
      ? "not_applicable"
      : dismissedFalsePositive
        ? "not_applicable"
        : quietUntilDecision
          ? "snoozed"
          : (silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS
            ? "critical"
            : (silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS
              ? "suspicious"
              : "ok";
    return {
      lastOutputAt: run.lastOutputAt ?? null,
      lastOutputSeq: run.lastOutputSeq ?? 0,
      lastOutputStream: (run.lastOutputStream === "stdout" || run.lastOutputStream === "stderr")
        ? run.lastOutputStream
        : null,
      silenceStartedAt,
      silenceAgeMs,
      level,
      suspicionThresholdMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
      criticalThresholdMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
      snoozedUntil: dismissedFalsePositive ? null : quietUntilDecision?.snoozedUntil ?? null,
      evaluationIssueId: evaluation?.id ?? null,
      evaluationIssueIdentifier: evaluation?.identifier ?? null,
      evaluationIssueAssigneeAgentId: evaluation?.assigneeAgentId ?? null,
    };
  }

  async function resolveStaleRunSourceIssue(run: typeof heartbeatRuns.$inferSelect) {
    const issueId = issueIdFromRunContext(run.contextSnapshot);
    if (!issueId) return null;
    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId), visibleIssueCondition()))
      .limit(1);
    return issue ?? null;
  }

  async function latestSameRunSourceTerminalEvidence(input: {
    run: typeof heartbeatRuns.$inferSelect;
    sourceIssue: typeof issues.$inferSelect;
    evidenceAfter: Date | null;
  }) {
    if (!isTerminalIssueStatus(input.sourceIssue.status)) return null;
    const after = input.evidenceAfter ?? input.run.startedAt ?? input.run.createdAt ?? null;
    const activityPredicates = [
      eq(activityLog.companyId, input.run.companyId),
      eq(activityLog.runId, input.run.id),
      eq(activityLog.action, "issue.updated"),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.sourceIssue.id),
      sql`${activityLog.details} ->> 'status' = ${input.sourceIssue.status}`,
    ];
    if (after) {
      activityPredicates.push(gte(activityLog.createdAt, after));
    }

    const activity = await db
      .select({
        id: activityLog.id,
        createdAt: activityLog.createdAt,
        action: activityLog.action,
      })
      .from(activityLog)
      .where(and(...activityPredicates))
      .orderBy(desc(activityLog.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (activity) {
      return {
        kind: "activity" as const,
        id: activity.id,
        createdAt: activity.createdAt,
        action: activity.action,
      };
    }
    return null;
  }

  async function nextRunEventSeq(runId: string) {
    const [row] = await db
      .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    return Number(row?.maxSeq ?? 0) + 1;
  }

  async function appendRecoveryRunEvent(
    run: typeof heartbeatRuns.$inferSelect,
    event: {
      level: "info" | "warn" | "error";
      message: string;
      payload?: Record<string, unknown>;
    },
  ) {
    await db.insert(heartbeatRunEvents).values({
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      seq: await nextRunEventSeq(run.id),
      eventType: "lifecycle",
      stream: "system",
      level: event.level,
      message: event.message,
      payload: event.payload ?? null,
    });
  }

  async function cleanupSourceResolvedRunProcess(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
  }) {
    if (!SESSIONED_LOCAL_ADAPTERS.has(input.runningAgent.adapterType)) {
      return {
        attempted: false,
        outcome: "skipped_non_local_adapter",
        adapterType: input.runningAgent.adapterType,
      };
    }

    const running = runningProcesses.get(input.run.id);
    const pid = running?.child.pid ?? input.run.processPid ?? null;
    const processGroupId = running?.processGroupId ?? input.run.processGroupId ?? null;
    if (typeof pid !== "number" && typeof processGroupId !== "number") {
      return {
        attempted: false,
        outcome: "no_process_metadata",
        adapterType: input.runningAgent.adapterType,
      };
    }

    const wasAlive =
      (typeof pid === "number" && isPidAlive(pid)) ||
      (typeof processGroupId === "number" && isProcessGroupAlive(processGroupId));
    if (!wasAlive) {
      runningProcesses.delete(input.run.id);
      return {
        attempted: false,
        outcome: "not_running",
        adapterType: input.runningAgent.adapterType,
        pid,
        processGroupId,
      };
    }

    try {
      await terminateLocalService(
        {
          pid: typeof pid === "number" && Number.isInteger(pid) && pid > 0
            ? pid
            : (processGroupId ?? 0),
          processGroupId: typeof processGroupId === "number" && Number.isInteger(processGroupId) && processGroupId > 0
            ? processGroupId
            : null,
        },
        running ? { forceAfterMs: Math.max(1, running.graceSec) * 1000 } : undefined,
      );
      runningProcesses.delete(input.run.id);
      const stillAlive =
        (typeof pid === "number" && isPidAlive(pid)) ||
        (typeof processGroupId === "number" && isProcessGroupAlive(processGroupId));
      return {
        attempted: true,
        outcome: stillAlive ? "termination_sent_still_running" : "terminated",
        adapterType: input.runningAgent.adapterType,
        pid,
        processGroupId,
      };
    } catch (error) {
      return {
        attempted: true,
        outcome: "failed",
        adapterType: input.runningAgent.adapterType,
        pid,
        processGroupId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function finalizeAgentAfterSourceResolvedRun(run: typeof heartbeatRuns.$inferSelect, status: "succeeded" | "cancelled") {
    const [runningCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.status, "running")));
    const runningCount = Number(runningCountRow?.count ?? 0);
    const nextStatus = runningCount > 0 ? "running" : status === "succeeded" || status === "cancelled" ? "idle" : "error";
    await db
      .update(agents)
      .set({
        status: nextStatus,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, run.agentId), notInArray(agents.status, ["paused", "terminated"])));
  }

  async function foldSourceResolvedStaleRun(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect;
    evidence: Awaited<ReturnType<typeof latestSameRunSourceTerminalEvidence>>;
    existingEvaluation: Awaited<ReturnType<typeof findOpenStaleRunEvaluation>>;
    silenceStartedAt: Date | null;
    silenceAgeMs: number | null;
    now: Date;
  }) {
    if (!input.evidence) return { kind: "skipped" as const };
    const cleanup = await cleanupSourceResolvedRunProcess({ run: input.run, runningAgent: input.runningAgent });
    const finalRunStatus = input.sourceIssue.status === "cancelled" ? "cancelled" : "succeeded";
    const resultJson = {
      ...parseObject(input.run.resultJson),
      sourceResolvedWatchdogFold: {
        sourceIssueId: input.sourceIssue.id,
        sourceIssueIdentifier: input.sourceIssue.identifier,
        sourceIssueStatus: input.sourceIssue.status,
        sameRunEvidenceKind: input.evidence.kind,
        sameRunEvidenceId: input.evidence.id,
        sameRunEvidenceAt: input.evidence.createdAt.toISOString(),
        silenceStartedAt: input.silenceStartedAt?.toISOString() ?? null,
        silenceAgeMs: input.silenceAgeMs,
        evaluationIssueId: input.existingEvaluation?.id ?? null,
        evaluationIssueIdentifier: input.existingEvaluation?.identifier ?? null,
        cleanup,
      },
    };
    const finalizedRun = await db.transaction(async (tx) => {
      const [updatedRun] = await tx
        .update(heartbeatRuns)
        .set({
          status: finalRunStatus,
          finishedAt: input.now,
          error: null,
          errorCode: null,
          resultJson,
          updatedAt: input.now,
        })
        .where(and(eq(heartbeatRuns.id, input.run.id), eq(heartbeatRuns.companyId, input.run.companyId), eq(heartbeatRuns.status, "running")))
        .returning();
      if (!updatedRun) return null;

      if (input.run.wakeupRequestId) {
        await tx
          .update(agentWakeupRequests)
          .set({
            status: finalRunStatus === "succeeded" ? "completed" : "cancelled",
            finishedAt: input.now,
            error: null,
            updatedAt: input.now,
          })
          .where(and(eq(agentWakeupRequests.id, input.run.wakeupRequestId), eq(agentWakeupRequests.companyId, input.run.companyId)));
      }

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
            eq(issues.id, input.sourceIssue.id),
            eq(issues.companyId, input.run.companyId),
            eq(issues.executionRunId, input.run.id),
          ),
        );

      return updatedRun;
    });
    if (!finalizedRun) return { kind: "skipped" as const };

    if (input.existingEvaluation && !isTerminalIssueStatus(input.existingEvaluation.status)) {
      await issuesSvc.update(input.existingEvaluation.id, { status: "done" });
      await issuesSvc.addComment(input.existingEvaluation.id, [
        "Source-resolved watchdog fold.",
        "",
        `- Source issue: ${input.sourceIssue.identifier ?? input.sourceIssue.id}`,
        `- Run: \`${input.run.id}\``,
        `- Same-run evidence: \`${input.evidence.kind}:${input.evidence.id}\` at ${input.evidence.createdAt.toISOString()}`,
        "- Outcome: false positive; the source issue already reached a terminal disposition from this run.",
      ].join("\n"), { runId: input.run.id });
    }

    const activeRecoveryAction = await recoveryActionsSvc.getActiveForIssue(input.run.companyId, input.sourceIssue.id);
    if (activeRecoveryAction?.kind === "active_run_watchdog") {
      await recoveryActionsSvc.resolveActiveForIssue({
        companyId: input.run.companyId,
        sourceIssueId: input.sourceIssue.id,
        actionId: activeRecoveryAction.id,
        status: "resolved",
        outcome: "false_positive",
        resolutionNote: "Source issue reached a terminal disposition through durable same-run activity; watchdog folded as source-resolved.",
      });
    }

    const [decision] = await db
      .insert(heartbeatRunWatchdogDecisions)
      .values({
        companyId: input.run.companyId,
        runId: input.run.id,
        evaluationIssueId: input.existingEvaluation?.id ?? null,
        decision: "dismissed_false_positive",
        reason: "Source issue already reached a terminal disposition through durable same-run activity.",
        createdByRunId: input.run.id,
      })
      .returning();

    await appendRecoveryRunEvent(finalizedRun, {
      level: cleanup.outcome === "failed" ? "warn" : "info",
      message: "Source-resolved watchdog fold finalized stale active run",
      payload: resultJson.sourceResolvedWatchdogFold,
    });
    await logActivity(db, {
      companyId: input.run.companyId,
      actorType: "system",
      actorId: "system",
      agentId: input.run.agentId,
      runId: input.run.id,
      action: "heartbeat.output_stale_source_resolved",
      entityType: "heartbeat_run",
      entityId: input.run.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        sourceIssueId: input.sourceIssue.id,
        sourceIssueIdentifier: input.sourceIssue.identifier,
        sourceIssueStatus: input.sourceIssue.status,
        evaluationIssueId: input.existingEvaluation?.id ?? null,
        watchdogDecisionId: decision.id,
        sameRunEvidenceKind: input.evidence.kind,
        sameRunEvidenceId: input.evidence.id,
        sameRunEvidenceAt: input.evidence.createdAt.toISOString(),
        cleanup,
      },
    });
    await finalizeAgentAfterSourceResolvedRun(finalizedRun, finalRunStatus);
    return { kind: "folded" as const, evaluationIssueId: input.existingEvaluation?.id ?? null };
  }

  async function inspectSilentActiveRun(input: {
    run: typeof heartbeatRuns.$inferSelect;
    now: Date;
    dismissedFalsePositive: boolean;
  }) {
    const runningAgent = await getAgent(input.run.agentId);
    if (!runningAgent || runningAgent.companyId !== input.run.companyId) return { kind: "skipped" as const };
    const sourceIssue = await resolveStaleRunSourceIssue(input.run);
    const existing = await findOpenStaleRunEvaluation(input.run.companyId, input.run.id);
    if (
      sourceIssue &&
      Object.values(RECOVERY_ORIGIN_KINDS).includes(
        sourceIssue.originKind as typeof RECOVERY_ORIGIN_KINDS[keyof typeof RECOVERY_ORIGIN_KINDS],
      )
    ) {
      return { kind: "skipped" as const };
    }
    const silenceStartedAt = silenceStartedAtForRun(input.run);
    if (sourceIssue && isTerminalIssueStatus(sourceIssue.status)) {
      const terminalEvidence = await latestSameRunSourceTerminalEvidence({
        run: input.run,
        sourceIssue,
        evidenceAfter: silenceStartedAt,
      });
      if (terminalEvidence) {
        return foldSourceResolvedStaleRun({
          run: input.run,
          runningAgent,
          sourceIssue,
          evidence: terminalEvidence,
          existingEvaluation: existing,
          silenceStartedAt,
          silenceAgeMs: silenceAgeMsForRun(input.run, input.now),
          now: input.now,
        });
      }
    }

    // Blocked source work can be intentionally quiet. The issue state already carries
    // the durable waiting signal, so the cleanup scan has nothing to do.
    if (sourceIssue?.status === "blocked") return { kind: "skipped" as const };

    if (input.dismissedFalsePositive) {
      return { kind: "skipped" as const };
    }

    return existing
      ? { kind: "existing" as const, evaluationIssueId: existing.id }
      : { kind: "skipped" as const };
  }

  async function scanSilentActiveRuns(opts?: { now?: Date; companyId?: string; issueCreatedAtGte?: Date | null }) {
    const now = opts?.now ?? new Date();
    const suspicionBefore = new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS);
    let candidates = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          opts?.companyId ? eq(heartbeatRuns.companyId, opts.companyId) : undefined,
          eq(heartbeatRuns.status, "running"),
          sql`coalesce(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.processStartedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) <= ${suspicionBefore.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(heartbeatRuns.createdAt))
      .limit(100);

    if (opts?.issueCreatedAtGte) {
      const issueIds = [...new Set(candidates.flatMap((run) => {
        const context = parseObject(run.contextSnapshot);
        const issueId = context.issueId ?? context.taskId;
        return typeof issueId === "string" && issueId.length > 0 ? [issueId] : [];
      }))];
      const eligibleIssueIds = new Set(
        issueIds.length > 0
          ? (await db.select({ id: issues.id }).from(issues).where(and(
              inArray(issues.id, issueIds),
              gte(issues.createdAt, opts.issueCreatedAtGte),
            ))).map((issue) => issue.id)
          : [],
      );
      candidates = candidates.filter((run) => {
        const context = parseObject(run.contextSnapshot);
        const issueId = context.issueId ?? context.taskId;
        return typeof issueId === "string" && eligibleIssueIds.has(issueId);
      });
    }

    const result = {
      scanned: candidates.length,
      created: 0,
      existing: 0,
      escalated: 0,
      folded: 0,
      snoozed: 0,
      skipped: 0,
      evaluationIssueIds: [] as string[],
    };

    for (const run of candidates) {
      const decisionState = await activeOutputDecisionState(run.companyId, run.id, now);
      if (decisionState.quietUntilDecision) {
        result.snoozed += 1;
        continue;
      }
      const outcome = await inspectSilentActiveRun({
        run,
        now,
        dismissedFalsePositive: decisionState.dismissedFalsePositive,
      });
      if (outcome.kind === "existing") result.existing += 1;
      else if (outcome.kind === "folded") result.folded += 1;
      else result.skipped += 1;
      if ("evaluationIssueId" in outcome && outcome.evaluationIssueId) {
        result.evaluationIssueIds.push(outcome.evaluationIssueId);
      }
    }

    return result;
  }

  /**
   * Bounded hard-stop for a run whose child has emitted nothing at all since it
   * was spawned.
   *
   * The predicate is deliberately narrow: `lastOutputAt` before `processStartedAt`
   * (or absent) means every byte on the run belongs to Paperclip's own pre-spawn
   * banner and the child itself has said nothing. A run that is merely producing
   * output slowly always has output *after* spawn and is never a candidate here —
   * it stays with the evaluation path in `scanSilentActiveRuns`.
   *
   * Process metadata is required: with no pid or process group there is no child
   * to stop, and finalizing such a run would be a guess rather than a hard-stop.
   */
  async function scanTerminableSilentActiveRuns(opts?: { now?: Date; companyId?: string }) {
    const now = opts?.now ?? new Date();
    const terminateBefore = new Date(now.getTime() - ACTIVE_RUN_NO_OUTPUT_TERMINATION_THRESHOLD_MS);
    const candidates = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          opts?.companyId ? eq(heartbeatRuns.companyId, opts.companyId) : undefined,
          eq(heartbeatRuns.status, "running"),
          isNotNull(heartbeatRuns.processStartedAt),
          sql`(${heartbeatRuns.processPid} is not null or ${heartbeatRuns.processGroupId} is not null)`,
          sql`(${heartbeatRuns.lastOutputAt} is null or ${heartbeatRuns.lastOutputAt} < ${heartbeatRuns.processStartedAt})`,
          sql`${heartbeatRuns.processStartedAt} <= ${terminateBefore.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(heartbeatRuns.createdAt))
      .limit(100);

    const result = {
      scanned: candidates.length,
      terminated: 0,
      snoozed: 0,
      skipped: 0,
      runIds: [] as string[],
    };

    for (const run of candidates) {
      if (await latestActiveOutputQuietUntilDecision(run.companyId, run.id, now)) {
        result.snoozed += 1;
        continue;
      }
      const runningAgent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, run.agentId))
        .then((rows) => rows[0] ?? null);
      if (!runningAgent || !SESSIONED_LOCAL_ADAPTERS.has(runningAgent.adapterType)) {
        result.skipped += 1;
        continue;
      }

      const silenceAgeMs = run.processStartedAt ? now.getTime() - run.processStartedAt.getTime() : null;
      const cleanup = await cleanupSourceResolvedRunProcess({ run, runningAgent });
      const terminated = await terminateSilentActiveRun({ run, cleanup, silenceAgeMs, now });
      if (!terminated) {
        result.skipped += 1;
        continue;
      }
      result.terminated += 1;
      result.runIds.push(run.id);
    }

    return result;
  }

  async function terminateSilentActiveRun(input: {
    run: typeof heartbeatRuns.$inferSelect;
    cleanup: Awaited<ReturnType<typeof cleanupSourceResolvedRunProcess>>;
    silenceAgeMs: number | null;
    now: Date;
  }) {
    const errorMessage =
      `Child process produced no output for ${formatDuration(input.silenceAgeMs ?? 0)} after spawn and was terminated by the recovery watchdog.`;
    const resultJson = {
      ...parseObject(input.run.resultJson),
      noOutputTerminationWatchdog: {
        processStartedAt: input.run.processStartedAt?.toISOString() ?? null,
        lastOutputAt: input.run.lastOutputAt?.toISOString() ?? null,
        silenceAgeMs: input.silenceAgeMs,
        thresholdMs: ACTIVE_RUN_NO_OUTPUT_TERMINATION_THRESHOLD_MS,
        cleanup: input.cleanup,
      },
    };

    const finalizedRun = await db.transaction(async (tx) => {
      const [updatedRun] = await tx
        .update(heartbeatRuns)
        .set({
          status: "failed",
          finishedAt: input.now,
          error: errorMessage,
          errorCode: "child_no_output_timeout",
          resultJson,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(heartbeatRuns.id, input.run.id),
            eq(heartbeatRuns.companyId, input.run.companyId),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .returning();
      if (!updatedRun) return null;

      if (input.run.wakeupRequestId) {
        await tx
          .update(agentWakeupRequests)
          .set({
            status: "failed",
            finishedAt: input.now,
            error: errorMessage,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(agentWakeupRequests.id, input.run.wakeupRequestId),
              eq(agentWakeupRequests.companyId, input.run.companyId),
            ),
          );
      }

      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: input.now,
        })
        .where(and(eq(issues.companyId, input.run.companyId), eq(issues.executionRunId, input.run.id)));

      await tx.insert(heartbeatRunWatchdogDecisions).values({
        companyId: input.run.companyId,
        runId: input.run.id,
        evaluationIssueId: null,
        decision: "terminated_no_output",
        snoozedUntil: null,
        reason: errorMessage,
        createdByAgentId: null,
        createdByUserId: null,
        createdByRunId: null,
      });

      return updatedRun;
    });
    if (!finalizedRun) return false;

    await appendRecoveryRunEvent(finalizedRun, {
      level: "error",
      message: errorMessage,
      payload: { source: "recovery.no_output_termination", cleanup: input.cleanup },
    });
    await logActivity(db, {
      companyId: finalizedRun.companyId,
      actorType: "system",
      actorId: "recovery",
      agentId: finalizedRun.agentId,
      runId: finalizedRun.id,
      action: "heartbeat.run_terminated_no_output",
      entityType: "heartbeat_run",
      entityId: finalizedRun.id,
      details: {
        source: "recovery.no_output_termination",
        silenceAgeMs: input.silenceAgeMs,
        thresholdMs: ACTIVE_RUN_NO_OUTPUT_TERMINATION_THRESHOLD_MS,
        cleanup: input.cleanup,
      },
    });
    // Settle the agent back to idle rather than error: the failure is durably
    // recorded on the run, the activity log and the watchdog decision, and a
    // wedged child is not a reason to make the agent need manual clearing before
    // it can take new work. Paused/terminated agents are left as they are.
    await finalizeAgentAfterSourceResolvedRun(finalizedRun, "cancelled");
    return true;
  }

  async function recordWatchdogDecision(input: {
    runId: string;
    actor: WatchdogDecisionActor;
    decision: "snooze" | "continue" | "dismissed_false_positive";
    evaluationIssueId?: string | null;
    reason?: string | null;
    snoozedUntil?: Date | null;
    createdByRunId?: string | null;
    now?: Date;
  }) {
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .limit(1);
    if (!run) throw notFound("Heartbeat run not found");

    let evaluationIssue: {
      id: string;
      assigneeAgentId: string | null;
      companyId: string;
      originKind: string;
      originId: string | null;
      hiddenAt: Date | null;
      status: string;
    } | null = null;
    if (input.evaluationIssueId) {
      evaluationIssue = await db
        .select({
          id: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
          companyId: issues.companyId,
          originKind: issues.originKind,
          originId: issues.originId,
          hiddenAt: issues.hiddenAt,
          status: issues.status,
        })
        .from(issues)
        .where(and(eq(issues.id, input.evaluationIssueId), eq(issues.companyId, run.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!evaluationIssue) throw notFound("Evaluation issue not found");
    }

    const boardActor = input.actor.type === "board";
    const assignedRecoveryOwner =
      input.actor.type === "agent" &&
      Boolean(input.actor.agentId) &&
      evaluationIssue !== null &&
      evaluationIssue.originKind === STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND &&
      evaluationIssue.originId === run.id &&
      evaluationIssue.hiddenAt === null &&
      !["done", "cancelled"].includes(evaluationIssue.status) &&
      evaluationIssue?.assigneeAgentId === input.actor.agentId;
    if (!boardActor && !assignedRecoveryOwner) {
      throw forbidden("Only the board or the assigned recovery owner can record watchdog decisions");
    }

    if (evaluationIssue && (
      evaluationIssue.originKind !== STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND ||
      evaluationIssue.originId !== run.id
    )) {
      throw forbidden("Watchdog decision evaluation issue is not bound to the target run");
    }

    if (input.actor.type === "agent" && !evaluationIssue) {
      throw forbidden("Agent watchdog decisions require the target evaluation issue");
    }

    const createdByRunId = input.actor.type === "agent"
      ? input.actor.runId ?? input.createdByRunId ?? null
      : input.actor.type === "board"
        ? input.actor.runId ?? input.createdByRunId ?? null
        : null;
    if (createdByRunId) {
      const [creatorRun] = await db
        .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, createdByRunId))
        .limit(1);
      const sameCompany = creatorRun?.companyId === run.companyId;
      const sameAgent = input.actor.type !== "agent" || creatorRun?.agentId === input.actor.agentId;
      if (!creatorRun || !sameCompany || !sameAgent) {
        throw forbidden("createdByRunId is not valid for this watchdog decision actor");
      }
    }

    const decisionNow = input.now ?? new Date();
    const effectiveSnoozedUntil = input.decision === "snooze"
      ? input.snoozedUntil ?? null
      : input.decision === "continue"
        ? input.snoozedUntil && input.snoozedUntil > decisionNow
          ? input.snoozedUntil
          : new Date(decisionNow.getTime() + ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS)
        : null;

    const [row] = await db
      .insert(heartbeatRunWatchdogDecisions)
      .values({
        companyId: run.companyId,
        runId: run.id,
        evaluationIssueId: input.evaluationIssueId ?? null,
        decision: input.decision,
        snoozedUntil: effectiveSnoozedUntil,
        reason: input.reason ?? null,
        createdByAgentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
        createdByUserId: input.actor.type === "board" ? input.actor.userId ?? null : null,
        createdByRunId,
      })
      .returning();

    await logActivity(db, {
      companyId: run.companyId,
      actorType: input.actor.type === "agent" ? "agent" : "user",
      actorId: input.actor.type === "agent"
        ? input.actor.agentId ?? "agent"
        : input.actor.type === "board"
          ? input.actor.userId ?? "board"
          : "unknown",
      agentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
      runId: run.id,
      action: input.decision === "snooze" ? "heartbeat.watchdog_snoozed" : "heartbeat.watchdog_decision_recorded",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: {
        source: "recovery.record_watchdog_decision",
        decision: input.decision,
        evaluationIssueId: input.evaluationIssueId ?? null,
        snoozedUntil: effectiveSnoozedUntil?.toISOString() ?? null,
        reason: input.reason ?? null,
      },
    });

    return row;
  }

  function isStrandedIssueRecoveryIssue(issue: typeof issues.$inferSelect) {
    return issue.originKind === STRANDED_ISSUE_RECOVERY_ORIGIN_KIND;
  }

  async function buildNestedStrandedRecoveryLine(issue: typeof issues.$inferSelect, prefix: string) {
    const sourceIssueId = readNonEmptyString(issue.originId);
    const sourceIssue = sourceIssueId
      ? await db
        .select({ id: issues.id, identifier: issues.identifier })
        .from(issues)
        .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, sourceIssueId)))
        .then((rows) => rows[0] ?? null)
      : null;
    const sourceLine = sourceIssue
      ? `- Original source issue: ${issueUiLink(sourceIssue, prefix)}`
      : sourceIssueId
        ? `- Original source issue: \`${sourceIssueId}\``
        : "- Original source issue: unknown";

    return [
      "",
      "- Nested recovery: suppressed because this issue is already a `stranded_issue_recovery` issue.",
      sourceLine,
      "- Next action: the assigned recovery owner or board operator should fix the runtime/adapter problem, resolve or reassign the original source issue, then mark this recovery issue done or cancelled.",
    ].join("\n");
  }

  /**
   * A ladder-discovered owner and the computed return owner must be able to
   * write the source issue *as it currently stands*. The live SUP-13091 failure
   * was a full-trust exec-CTO denied `deny_missing_grant` on
   * `POST /api/issues/{id}/comments` because it was neither assignee, creator,
   * nor org-chain ancestor of the assignee. We therefore evaluate
   * `issue:comment` against the source issue's REAL current assignment, not a
   * reassigned one. This yields `allow_manager_chain` for a manager ancestor
   * and `deny_missing_grant` for a non-ancestor, which is exactly the predicate
   * `decideIssueAccess` uses for the live 403. `issue:mutate` has no
   * manager-chain allow path, so it would reject every manager.
   *
   * The one exception is `evaluateAsAssignee`, used for the owner the recovery
   * cause itself designates (`preferredOwnerAgentId`, e.g. the current
   * execution-review participant). That agent is named by the issue's own
   * execution state and the same escalation hands the issue to it
   * (`assigneeAgentId = ownerAgentId`), so the grant question for it is whether
   * it would still be denied once the issue is theirs. Policy-restricted,
   * low-trust out-of-boundary, scoped-key, and inactive candidates stay denied
   * under that evaluation; a legitimate review participant does not.
   */
  async function candidateCanWriteSourceIssue(
    issue: typeof issues.$inferSelect,
    agentId: string,
    opts?: { evaluateAsAssignee?: boolean },
  ): Promise<boolean> {
    const assigneeAgentId = opts?.evaluateAsAssignee ? agentId : issue.assigneeAgentId;
    const assigneeUserId = opts?.evaluateAsAssignee ? null : issue.assigneeUserId;
    const decision = await authz.decide({
      actor: { type: "agent", agentId, companyId: issue.companyId },
      action: "issue:comment",
      resource: {
        type: "issue",
        companyId: issue.companyId,
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId,
        assigneeUserId,
        status: issue.status,
        createdByAgentId: issue.createdByAgentId,
      },
      scope: {
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId,
        assigneeUserId,
        createdByAgentId: issue.createdByAgentId,
      },
    });
    return decision.allowed;
  }

  async function resolveStrandedIssueRecoveryOwnerAgentId(
    issue: typeof issues.$inferSelect,
    preferredOwnerAgentId?: string | null,
  ) {
    const candidateIds: string[] = [];
    if (preferredOwnerAgentId) candidateIds.push(preferredOwnerAgentId);
    if (issue.assigneeAgentId) {
      const assignee = await getAgent(issue.assigneeAgentId);
      if (assignee?.reportsTo) candidateIds.push(assignee.reportsTo);
    }
    if (issue.createdByAgentId) {
      const creator = await getAgent(issue.createdByAgentId);
      if (creator?.reportsTo) candidateIds.push(creator.reportsTo);
      candidateIds.push(issue.createdByAgentId);
    }

    const roleCandidates = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, issue.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt));
    candidateIds.push(...roleCandidates.map((agent) => agent.id));
    if (issue.assigneeAgentId) candidateIds.push(issue.assigneeAgentId);

    const projectPolicy = issue.projectId
      ? await db
          .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
          .from(projects)
          .where(and(eq(projects.id, issue.projectId), eq(projects.companyId, issue.companyId)))
          .then((rows) => rows[0]?.executionWorkspacePolicy ?? null)
      : null;
    const parsedProjectPolicy = parseProjectExecutionWorkspacePolicy(projectPolicy);

    const seen = new Set<string>();
    for (const agentId of candidateIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== issue.companyId) continue;
      const budgetBlock = await budgets.getInvocationBlock(issue.companyId, candidate.id, {
        issueId: issue.id,
        projectId: issue.projectId,
      });
      if (!canAgentSatisfyIssueWorkspaceSettings({
        issue: {
          projectId: issue.projectId,
          projectWorkspaceId: issue.projectWorkspaceId,
          executionWorkspaceId: issue.executionWorkspaceId,
          executionWorkspacePreference: issue.executionWorkspacePreference,
        },
        executionWorkspaceSettings: issue.executionWorkspaceSettings,
        projectPolicy: parsedProjectPolicy,
        agentConfig: candidate.adapterConfig,
      })) continue;
      if (
        (await isAgentInvokable(candidate)) &&
        !budgetBlock &&
        (await candidateCanWriteSourceIssue(issue, candidate.id, {
          evaluateAsAssignee: candidate.id === preferredOwnerAgentId,
        }))
      )
        return candidate.id;
    }

    return null;
  }

  async function resolveInvokableRecoveryAgentId(
    issue: typeof issues.$inferSelect,
    agentId: string | null | undefined,
  ) {
    if (!agentId) return null;
    const candidate = await getAgent(agentId);
    if (!candidate || candidate.companyId !== issue.companyId) return null;
    const budgetBlock = await budgets.getInvocationBlock(issue.companyId, candidate.id, {
      issueId: issue.id,
      projectId: issue.projectId,
    });
    return (await isAgentInvokable(candidate)) && !budgetBlock && (await candidateCanWriteSourceIssue(issue, candidate.id)) ? candidate.id : null;
  }

  async function resolveStrandedRecoveryRouting(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    recoveryCause: StrandedRecoveryCause;
    preferredOwnerAgentId?: string | null;
  }) {
    const originalAgentId = input.latestRun?.agentId ?? input.issue.assigneeAgentId;
    const returnOwnerAgentId = input.issue.assigneeAgentId ?? originalAgentId;
    const routeToOriginal = input.recoveryCause === "process_lost" ||
      input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON ||
      input.recoveryCause === "codex_output_inactivity_monitor";
    if (input.recoveryCause === "provider_quota") {
      const retryAgentId = await resolveInvokableRecoveryAgentId(input.issue, originalAgentId);
      if (!retryAgentId) {
        const ladderOwner = await resolveStrandedIssueRecoveryOwnerAgentId(input.issue);
        const computedReturnOwner = originalAgentId;
        if (computedReturnOwner && (await candidateCanWriteSourceIssue(input.issue, computedReturnOwner))) {
          return {
            ownerAgentId: ladderOwner,
            returnOwnerAgentId: computedReturnOwner,
            routingFallbackReason: "The original assignee is not invokable; quota recovery fell through to the manager ladder.",
          };
        }
        return {
          ownerAgentId: ladderOwner,
          returnOwnerAgentId: null,
          routingFallbackReason: "Computed return owner lacks a write grant on the source issue; fell through to board ownership.",
        };
      }
      return {
        ownerAgentId: null,
        returnOwnerAgentId: retryAgentId,
        routingFallbackReason: null,
      };
    }
    if (routeToOriginal) {
      const ownerAgentId = await resolveInvokableRecoveryAgentId(input.issue, originalAgentId);
      if (ownerAgentId) {
        return { ownerAgentId, returnOwnerAgentId: originalAgentId, routingFallbackReason: null };
      }
      const ladderOwner = await resolveStrandedIssueRecoveryOwnerAgentId(input.issue);
      const computedReturnOwner = originalAgentId;
      if (computedReturnOwner && (await candidateCanWriteSourceIssue(input.issue, computedReturnOwner))) {
        return {
          ownerAgentId: ladderOwner,
          returnOwnerAgentId: computedReturnOwner,
          routingFallbackReason: "The original assignee is not invokable; recovery fell through to the manager ladder.",
        };
      }
      return {
        ownerAgentId: ladderOwner,
        returnOwnerAgentId: null,
        routingFallbackReason: "Computed return owner lacks a write grant on the source issue; fell through to board ownership.",
      };
    }
    const ladderOwner = await resolveStrandedIssueRecoveryOwnerAgentId(
      input.issue,
      input.preferredOwnerAgentId,
    );
    const computedReturnOwner = returnOwnerAgentId;
    if (computedReturnOwner && (await candidateCanWriteSourceIssue(input.issue, computedReturnOwner))) {
      return {
        ownerAgentId: ladderOwner,
        returnOwnerAgentId: computedReturnOwner,
        routingFallbackReason: null,
      };
    }
    return {
      ownerAgentId: ladderOwner,
      returnOwnerAgentId: null,
      routingFallbackReason: "Computed return owner lacks a write grant on the source issue; fell through to board ownership.",
    };
  }


  function strandedRecoveryActionKind(cause: StrandedRecoveryCause) {
    return cause === SUCCESSFUL_RUN_MISSING_STATE_REASON
      ? "missing_disposition" as const
      : cause === "deliberate_wait_without_target"
        ? "deliberate_wait_without_target" as const
      : cause === "workspace_validation_failed"
        ? "workspace_validation" as const
      : cause === "configuration_incomplete"
        ? "configuration_validation" as const
      : "stranded_assigned_issue" as const;
  }

  function strandedRecoveryActionFingerprint(input: {
    issue: typeof issues.$inferSelect;
    recoveryCause: StrandedRecoveryCause;
    latestRun: LatestIssueRun;
  }) {
    if (input.recoveryCause === "workspace_validation_failed") {
      const workspaceFingerprint = readWorkspaceValidationFingerprint(input.latestRun);
      if (workspaceFingerprint) {
        return [
          "source_scoped_recovery",
          input.issue.companyId,
          input.issue.id,
          input.recoveryCause,
          workspaceFingerprint,
        ].join(":");
      }
    }
    // A configuration-incomplete failure that carries a stable identity (for
    // example an unresolved workspace base ref) dedupes per that identity, so a
    // different requested ref makes a new recovery action while the same ref
    // reuses one. Configuration gaps with no fingerprint fall back to the
    // issue-and-cause scope below.
    if (input.recoveryCause === "configuration_incomplete") {
      const configurationFingerprint = readConfigurationIncompleteFingerprint(input.latestRun);
      if (configurationFingerprint) {
        return [
          "source_scoped_recovery",
          input.issue.companyId,
          input.issue.id,
          input.recoveryCause,
          configurationFingerprint,
        ].join(":");
      }
    }
    return [
      "source_scoped_recovery",
      input.issue.companyId,
      input.issue.id,
      input.recoveryCause,
    ].join(":");
  }

  function buildStrandedRecoveryActionEvidence(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: StrandedPreviousStatus;
    recoveryCause: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
    agentInvokability?: AgentInvokability | null;
  }) {
    const context = parseObject(input.latestRun?.contextSnapshot);
    const workspaceValidation = input.recoveryCause === "workspace_validation_failed"
      ? readWorkspaceValidationPayload(input.latestRun)
      : null;
    return {
      sourceIssueId: input.issue.id,
      sourceIdentifier: input.issue.identifier,
      previousStatus: input.previousStatus,
      latestIssueStatus: input.issue.status,
      latestRunId: input.latestRun?.id ?? null,
      latestRunStatus: input.latestRun?.status ?? null,
      latestRunErrorCode: input.latestRun?.errorCode ?? null,
      retryReason: readNonEmptyString(context.retryReason) ?? null,
      recoveryCause: input.recoveryCause,
      sourceRunId: input.successfulRunHandoffEvidence?.sourceRunId ?? null,
      correctiveRunId: input.successfulRunHandoffEvidence?.correctiveRunId ?? null,
      missingDisposition: input.successfulRunHandoffEvidence?.missingDisposition ?? null,
      handoffAttempt: input.successfulRunHandoffEvidence?.handoffAttempt ?? null,
      maxHandoffAttempts: input.successfulRunHandoffEvidence?.maxHandoffAttempts ?? null,
      agentInvokable: input.agentInvokability?.invokable ?? null,
      agentInvokabilityReason: input.agentInvokability && !input.agentInvokability.invokable
        ? input.agentInvokability.reason
        : null,
      agentInvokabilityMessage: input.agentInvokability && !input.agentInvokability.invokable
        ? input.agentInvokability.message
        : null,
      ...(workspaceValidation ? { workspaceValidation } : {}),
    };
  }

  async function ensureSourceScopedStrandedRecoveryAction(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: StrandedPreviousStatus;
    recoveryCause?: StrandedRecoveryCause;
    recoveryOwnerAgentId?: string | null;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
    agentInvokability?: AgentInvokability | null;
  }) {
    const recoveryCause = resolveStrandedRecoveryCause(input.latestRun, input.recoveryCause);
    const routing = await resolveStrandedRecoveryRouting({
      issue: input.issue,
      latestRun: input.latestRun,
      recoveryCause,
      preferredOwnerAgentId: input.recoveryOwnerAgentId,
    });
    const ownerAgentId = routing.ownerAgentId;
    const now = new Date();
    const action = await recoveryActionsSvc.upsertSourceScoped({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      // A configuration-incomplete failure carries a per-identity fingerprint
      // (for example the unresolved workspace base ref). A different ref is a
      // distinct blocker, so it must get a new recovery action and notify the
      // operator, not overwrite the active action of the prior ref.
      supersedeOnIdentityChange: recoveryCause === "configuration_incomplete",
      kind: strandedRecoveryActionKind(recoveryCause),
      ownerType: recoveryCause === "provider_quota" && !ownerAgentId ? "system" : ownerAgentId ? "agent" : "board",
      ownerAgentId,
      previousOwnerAgentId: input.issue.assigneeAgentId,
      returnOwnerAgentId: routing.returnOwnerAgentId,
      cause: recoveryCause,
      fingerprint: strandedRecoveryActionFingerprint({
        issue: input.issue,
        recoveryCause,
        latestRun: input.latestRun,
      }),
      evidence: {
        ...buildStrandedRecoveryActionEvidence({
          issue: input.issue,
          latestRun: input.latestRun,
          previousStatus: input.previousStatus,
          recoveryCause,
          successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
          agentInvokability: input.agentInvokability,
        }),
        failureSummary: summarizeRunFailureForRecoveryEvidence(
          input.latestRun,
          recoveryCause === "workspace_validation_failed"
            ? readWorkspaceValidationPayload(input.latestRun)
            : null,
        ),
        routingFallbackReason: routing.routingFallbackReason,
      },
      // Stamped once, at creation, so a later upsert cannot rewrite how the
      // action was originally routed. This fork usually resolves an owner agent
      // instead, so the marker belongs only on the board fall-through -- an
      // agent takeover is not a no-takeover park. The condition mirrors the
      // `ownerType` ternary above: stamped exactly when it resolves to "board".
      evidenceOnCreate: !ownerAgentId && recoveryCause !== "provider_quota"
        ? { routingPolicy: STRANDED_BOARD_ESCALATION_POLICY }
        : {},
      nextAction: recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
        ? "Choose and record a valid issue disposition without copying transcript content."
        : recoveryCause === "process_lost"
          ? "Retry the original assignee from durable progress without redoing completed steps."
        : recoveryCause === "provider_quota"
          ? "Wait for provider quota recovery, then retry the original assignee; do not wake a takeover owner."
        : recoveryCause === "codex_output_inactivity_monitor"
          ? "Retry the same agent from durable progress after the output-inactivity termination."
        : recoveryCause === "workspace_validation_failed"
          ? readWorkspaceValidationPayload(input.latestRun)?.reason === "git_worktree_branch_incoherence"
            ? "Repair the source issue git worktree branch incoherence, or choose a new execution workspace, before resuming adapter execution."
            : readWorkspaceValidationPayload(input.latestRun)?.reason === "git_worktree_base_materialization_failed"
              ? "Repair the project workspace repository URL or clone access, or configure a local checkout cwd, before resuming adapter execution."
              : "Repair the source issue workspace link, project workspace cwd, or git checkout before resuming adapter execution."
        : recoveryCause === "configuration_incomplete"
          ? "Bind the missing secret(s) named in the run failure to the agent/project/routine env before resuming adapter execution."
        : recoveryCause === "execution_review_participant_recovery"
          ? "Repair the failed review participant path, restore the source issue to in_review with a live reviewer, or record an intentional manual resolution."
        : recoveryCause === "opencode_db_growth_limit"
          ? "Change the command whose output streamed unbounded — redirect it to a file and report a bounded tail — before resuming the same work."
        : "Restore a live execution path, fix the runtime/adapter failure, or record an intentional manual resolution.",
      wakePolicy: recoveryCause === "provider_quota" && !ownerAgentId
        ? {
          type: "monitor_only",
          reason: recoveryCause,
        }
        : recoveryCause === "configuration_incomplete"
        ? {
          type: "manual_repair_required",
          reason: recoveryCause,
          ownerAgentId,
        }
        : ownerAgentId
        ? {
          type: "wake_owner",
          reason: "source_scoped_recovery_action",
          ownerAgentId,
        }
        : {
          type: "board_escalation",
          reason: "no_invokable_recovery_owner",
        },
      monitorPolicy: recoveryCause === "provider_quota" && !ownerAgentId
        ? { type: "wait_recovery", retryAgentId: routing.returnOwnerAgentId }
        : null,
      // Left null: the backstop sweep defaults a null ceiling to
      // MAX_RECOVERY_ACTION_SWEEP_ATTEMPTS, so persisting it here would only
      // freeze the ceiling at creation time.
      maxAttempts: null,
      lastAttemptAt: now,
    });

    return action;
  }

  async function enqueueSourceScopedStrandedRecoveryWake(input: {
    action: Awaited<ReturnType<typeof recoveryActionsSvc.upsertSourceScoped>>;
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    recoveryCause: StrandedRecoveryCause;
  }) {
    if (input.recoveryCause === "provider_quota" && !input.action.ownerAgentId) return;
    if (input.recoveryCause === "configuration_incomplete") return;
    if (!input.action.ownerAgentId) return;
    await deps.enqueueWakeup(input.action.ownerAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "source_scoped_recovery_action",
      idempotencyKey: `source_scoped_recovery_action:${input.action.id}:${input.action.attemptCount}`,
      payload: withRecoveryModelProfileHint({
        issueId: input.issue.id,
        sourceIssueId: input.issue.id,
        recoveryActionId: input.action.id,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause: input.recoveryCause,
      }, "status_only"),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: input.issue.id,
        taskId: input.issue.id,
        wakeReason: "source_scoped_recovery_action",
        skipIssueComment: true,
        source: "issue_recovery_action",
        recoveryActionId: input.action.id,
        sourceIssueId: input.issue.id,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause: input.recoveryCause,
      }, "status_only"),
    });
  }

  function readProviderQuotaRetryAt(latestRun: LatestIssueRun, now: Date) {
    const result = parseObject(latestRun?.resultJson);
    const context = parseObject(latestRun?.contextSnapshot);
    const raw = result.providerQuotaRetryNotBefore ??
      result.retryNotBefore ??
      result.transientRetryNotBefore ??
      context.providerQuotaRetryNotBefore ??
      context.transientRetryNotBefore;
    if (typeof raw === "string" || typeof raw === "number" || raw instanceof Date) {
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > now.getTime()) return parsed;
    }
    return new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS);
  }

  async function ensureProviderQuotaWaitRecoveryMonitor(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    actionId: string;
    agentId: string;
  }) {
    const existing = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, input.issue.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.status, "scheduled_retry"),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issue.id}`,
      ))
      .orderBy(desc(heartbeatRuns.scheduledRetryAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    const now = new Date();
    const retryAt = readProviderQuotaRetryAt(input.latestRun, now);
    return db.transaction(async (tx) => {
      const wakeup = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId: input.issue.companyId,
          agentId: input.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "provider_quota_recovery",
          payload: withRecoveryModelProfileHint({
            issueId: input.issue.id,
            retryOfRunId: input.latestRun?.id ?? null,
            retryReason: "provider_quota_recovery",
            providerQuotaRetryNotBefore: retryAt.toISOString(),
          }, "normal_model"),
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: null,
          idempotencyKey: `provider_quota_recovery:${input.issue.id}:${retryAt.toISOString()}`,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]!);
      const scheduledRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: input.issue.companyId,
          agentId: input.agentId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "scheduled_retry",
          wakeupRequestId: wakeup.id,
          retryOfRunId: input.latestRun?.id ?? null,
          scheduledRetryAt: retryAt,
          scheduledRetryAttempt: 1,
          scheduledRetryReason: "provider_quota_recovery",
          contextSnapshot: withRecoveryModelProfileHint({
            issueId: input.issue.id,
            taskId: input.issue.id,
            wakeReason: "provider_quota_recovery",
            retryReason: "provider_quota_recovery",
            providerQuotaRetryNotBefore: retryAt.toISOString(),
          }, "normal_model"),
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]!);
      await tx
        .update(agentWakeupRequests)
        .set({ runId: scheduledRun.id, updatedAt: now })
        .where(eq(agentWakeupRequests.id, wakeup.id));
      await tx
        .update(issueRecoveryActions)
        .set({
          monitorPolicy: {
            type: "wait_recovery",
            retryAgentId: input.agentId,
            scheduledRunId: scheduledRun.id,
            retryAt: retryAt.toISOString(),
          },
          timeoutAt: retryAt,
          updatedAt: now,
        })
        .where(eq(issueRecoveryActions.id, input.actionId));
      return scheduledRun;
    });
  }

  function buildRecoveryIssueInPlaceEscalationComment(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: StrandedPreviousStatus;
    latestRun: LatestIssueRun;
    prefix: string;
  }) {
    const runLink = input.latestRun
      ? runUiLink({ id: input.latestRun.id, agentId: input.latestRun.agentId }, input.prefix)
      : "none";
    const retryReason = readNonEmptyString(parseObject(input.latestRun?.contextSnapshot)?.retryReason) ?? "none";
    const failureSummary = summarizeRunFailureForIssueComment(input.latestRun);

    return [
      "Paperclip stopped automatic stranded-work recovery for this recovery issue.",
      "",
      `- Recovery issue: ${issueUiLink({ identifier: input.issue.identifier, id: input.issue.id }, input.prefix)}`,
      `- Previous status: \`${input.previousStatus}\``,
      `- Latest run: ${runLink}`,
      `- Latest run status: \`${input.latestRun?.status ?? "unknown"}\``,
      `- Retry reason: \`${retryReason}\``,
      failureSummary ? `- Failure: ${failureSummary.trim()}` : "- Failure: none recorded",
      "- Guard: recovery issues do not create nested `stranded_issue_recovery` issues.",
      "",
      "Next action: the current recovery owner should inspect the failed run evidence, restore a live execution path or record the manual resolution, then move this recovery issue out of `blocked`.",
    ].join("\n");
  }

  async function escalateStrandedRecoveryIssueInPlace(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: StrandedPreviousStatus;
    latestRun: LatestIssueRun;
  }) {
    const updated = await blockIssueWithUnresolvedBlockers(db, input.issue, {
      source: "recovery.reconcile_stranded_recovery_issue",
      previousStatus: input.previousStatus,
    });
    if (!updated) return null;

    const prefix = await getCompanyIssuePrefix(input.issue.companyId);
    await issuesSvc.addComment(
      input.issue.id,
      buildRecoveryIssueInPlaceEscalationComment({
        issue: input.issue,
        previousStatus: input.previousStatus,
        latestRun: input.latestRun,
        prefix,
      }),
      {},
      {
        authorType: "system",
        presentation: compactRecoveryPresentation("Recovery: recovery attempt failed — remains blocked"),
        metadata: {
          version: 1,
          sourceRunId: input.latestRun?.id ?? null,
          sections: [{
            title: "Recovery",
            rows: [
              { type: "key_value", label: "Cause", value: "recovery_issue_failed" },
              { type: "key_value", label: "Previous status", value: input.previousStatus },
              ...(input.latestRun
                ? [{
                    type: "run_link" as const,
                    label: "Latest run",
                    runId: input.latestRun.id,
                    title: input.latestRun.status,
                  }]
                : []),
            ],
          }],
        },
      },
    );

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: "issue.updated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        status: "blocked",
        previousStatus: input.previousStatus,
        source: "recovery.reconcile_stranded_recovery_issue",
        latestRunId: input.latestRun?.id ?? null,
        latestRunStatus: input.latestRun?.status ?? null,
        latestRunErrorCode: input.latestRun?.errorCode ?? null,
        originKind: input.issue.originKind,
        originId: input.issue.originId,
      },
    });

    return updated;
  }

  async function existingBlockerIssueIds(companyId: string, issueId: string) {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows.map((row) => row.blockerIssueId));
  }

  async function existingUnresolvedBlockerIssues(companyId: string, issueId: string) {
    return unresolvedBlockerIssues(db, companyId, issueId);
  }

  async function existingUnresolvedBlockerIssueIds(companyId: string, issueId: string) {
    return existingUnresolvedBlockerIssues(companyId, issueId).then((rows) => rows.map((row) => row.id));
  }

  async function openChildIssues(issue: typeof issues.$inferSelect) {
    return db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, issue.companyId),
          eq(issues.parentId, issue.id),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
  }

  async function healthyOpenChildIssues(issue: typeof issues.$inferSelect) {
    const childCandidates = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, issue.companyId),
          eq(issues.parentId, issue.id),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    const openChildren = [] as Array<{ id: string; identifier: string | null }>;
    for (const child of childCandidates) {
      const childState = await collectDispositionRepairSourceState(db, { issue: child });
      if (childState.hasActiveExecutionPath || childState.hasDurableWaitingPath) {
        openChildren.push({ id: child.id, identifier: child.identifier });
      }
    }
    return openChildren;
  }

  async function resolveContinuationWaitingOnReview(issue: typeof issues.$inferSelect) {
    const [existingBlockers, openChildren] = await Promise.all([
      existingUnresolvedBlockerIssues(issue.companyId, issue.id),
      openChildIssues(issue),
    ]);
    const blockedByIssueIds = [...new Set([...existingBlockers.map((row) => row.id), ...openChildren.map((row) => row.id)])];
    if (blockedByIssueIds.length === 0) return null;

    const updated = await issuesSvc.update(issue.id, { status: "blocked", blockedByIssueIds });
    if (!updated) return null;

    const waitingOn = formatIssueLinksForComment([...openChildren, ...existingBlockers]);
    await issuesSvc.addComment(
      issue.id,
      `This task is waiting on ${waitingOn} to finish. ` +
        "It will continue automatically when that work is done — there's nothing you need to do. " +
        "(It was paused because the latest run reported it was waiting for review/approval; " +
        "Paperclip turned that into a normal dependency wait instead of flagging it as stuck.)",
      {},
      {
        authorType: "system",
        presentation: compactRecoveryPresentation("Recovery: waiting on dependencies — moved to blocked"),
        metadata: {
          version: 1,
          sections: [{
            title: "Recovery",
            rows: [
              { type: "key_value", label: "Cause", value: "continuation_waiting_on_review" },
              { type: "key_value", label: "Previous status", value: issue.status },
              {
                type: "key_value",
                label: "Blocking issues",
                value: blockedByIssueIds.join(", ").slice(0, 2000),
              },
            ],
          }],
        },
      },
    );
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        status: "blocked",
        previousStatus: issue.status,
        source: "recovery.reconcile_continuation_waiting_on_review",
        blockedByIssueIds,
      },
    });
    return updated;
  }

  /**
   * SUP-13526: recovery reassignment writes `assigneeAgentId` straight through
   * the issue service, bypassing the PATCH handler's gate. When the recovery
   * owner is a participant of an incomplete review stage that cannot be cleared
   * without their own approval, refuse the reassignment: keep the current
   * assignee (or leave the issue unassigned) and still block it.
   */
  function resolveRecoveryReassignedAssignee(
    issue: {
      id: string;
      identifier?: string | null;
      assigneeAgentId: string | null;
      executionPolicy: unknown;
      executionState: unknown;
    },
    recoveryOwnerAgentId: string | null,
    currentAssigneeAgentId?: string | null,
  ): string | null {
    const candidate = recoveryOwnerAgentId ?? issue.assigneeAgentId;
    const effectiveCurrent = currentAssigneeAgentId ?? issue.assigneeAgentId;
    if (!candidate || candidate === effectiveCurrent) return candidate;
    try {
      assertAssigneeWriteDoesNotSelfSatisfyReviewStage({
        executionPolicy: issue.executionPolicy,
        executionState: issue.executionState,
        incomingAssigneeAgentId: candidate,
      });
    } catch (error) {
      logger.warn(
        {
          issueId: issue.id,
          identifier: issue.identifier,
          refusedAssigneeAgentId: candidate,
          keptAssigneeAgentId: effectiveCurrent,
          error: error instanceof Error ? error.message : String(error),
        },
        "recovery reassignment refused: assignee write would make an incomplete review stage self-satisfiable",
      );
      return effectiveCurrent;
    }
    return candidate;
  }

  function readDispositionRepairAttempt(latestRun: LatestIssueRun) {
    if (!latestRun) return null;
    const context = parseObject(latestRun.contextSnapshot);
    if (readNonEmptyString(context.retryReason) !== ISSUE_DISPOSITION_REPAIR_RETRY_REASON) return null;
    return {
      attempt: Math.max(1, Math.floor(asNumber(context.dispositionRepairAttempt, 1))),
      fingerprint: readNonEmptyString(context.dispositionRepairFingerprint),
    };
  }

  async function resolveDispositionRepairActionAsCovered(
    issue: typeof issues.$inferSelect,
    reason: string,
  ) {
    const active = await recoveryActionsSvc.getActiveForIssue(issue.companyId, issue.id);
    if (!active || active.kind !== "deliberate_wait_without_target") return;
    await recoveryActionsSvc.resolveActiveForIssue({
      companyId: issue.companyId,
      sourceIssueId: issue.id,
      actionId: active.id,
      status: "resolved",
      outcome: "restored",
      resolutionNote: reason,
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "recovery",
      agentId: null,
      runId: null,
      action: "issue.disposition_repair_resolved",
      entityType: "issue_recovery_action",
      entityId: active.id,
      details: {
        sourceIssueId: issue.id,
        sourceIdentifier: issue.identifier,
        reason,
      },
    });
  }

  async function ensureDispositionRepairAction(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    fingerprint: string;
    attemptCount: number;
  }) {
    let active = await recoveryActionsSvc.getActiveForIssue(input.issue.companyId, input.issue.id);
    if (active && (
      active.kind !== "deliberate_wait_without_target" ||
      active.fingerprint !== input.fingerprint
    )) {
      await recoveryActionsSvc.resolveActiveForIssue({
        companyId: input.issue.companyId,
        sourceIssueId: input.issue.id,
        actionId: active.id,
        status: "cancelled",
        outcome: "cancelled",
        resolutionNote: "source_state_changed",
      });
      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: "system",
        actorId: "recovery",
        agentId: null,
        runId: input.latestRun?.id ?? null,
        action: "issue.disposition_repair_fingerprint_reset",
        entityType: "issue_recovery_action",
        entityId: active.id,
        details: {
          sourceIssueId: input.issue.id,
          previousFingerprint: active.fingerprint,
          nextFingerprint: input.fingerprint,
          terminalReason: "source_state_changed",
        },
      });
      active = null;
    }

    if (active && active.attemptCount >= input.attemptCount) return active;

    return recoveryActionsSvc.upsertSourceScoped({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      kind: "deliberate_wait_without_target",
      ownerType: "agent",
      ownerAgentId: input.issue.assigneeAgentId,
      previousOwnerAgentId: input.issue.assigneeAgentId,
      returnOwnerAgentId: input.issue.assigneeAgentId,
      cause: "deliberate_wait_without_target",
      fingerprint: input.fingerprint,
      evidence: {
        sourceIssueId: input.issue.id,
        sourceIdentifier: input.issue.identifier,
        latestRunId: input.latestRun?.id ?? null,
        latestRunStatus: input.latestRun?.status ?? null,
        latestRunErrorCode: input.latestRun?.errorCode ?? null,
        sourceStateFingerprint: input.fingerprint,
        terminalReason: null,
      },
      nextAction:
        "The original owner must replace the parked summary with a terminal, live, blocked, monitored, or typed waiting disposition.",
      wakePolicy: {
        type: "bounded_owner_disposition_repair",
        retryAgentId: input.issue.assigneeAgentId,
        attempt: input.attemptCount,
        maxAttempts: DISPOSITION_REPAIR_MAX_ATTEMPTS,
      },
      maxAttempts: DISPOSITION_REPAIR_MAX_ATTEMPTS,
      attemptCount: input.attemptCount,
      lastAttemptAt: new Date(),
    });
  }

  async function scheduleDispositionRepairAttempt(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    action: Awaited<ReturnType<typeof ensureDispositionRepairAction>>;
    fingerprint: string;
    attempt: number;
  }) {
    const agentId = input.issue.assigneeAgentId;
    if (!agentId) return null;
    const timing = dispositionRepairDelayMs(input.attempt, input.fingerprint);
    const now = new Date();
    const retryAt = new Date(now.getTime() + timing.delayMs);
    const idempotencyKey = `issue_disposition_repair:${input.issue.id}:${input.fingerprint}:${input.attempt}`;
    const context = withRecoveryModelProfileHint({
      issueId: input.issue.id,
      taskId: input.issue.id,
      wakeReason: ISSUE_DISPOSITION_REPAIR_RETRY_REASON,
      retryReason: ISSUE_DISPOSITION_REPAIR_RETRY_REASON,
      source: "issue.deliberate_wait_disposition_repair",
      retryOfRunId: input.latestRun?.id ?? null,
      recoveryActionId: input.action.id,
      dispositionRepairFingerprint: input.fingerprint,
      dispositionRepairAttempt: input.attempt,
      dispositionRepairMaxAttempts: DISPOSITION_REPAIR_MAX_ATTEMPTS,
      bypassContinuationSummaryPark: true,
      dispositionRepairInstruction:
        "Revalidate the issue and replace the invalid parked summary with a durable disposition. Continue productive work when appropriate.",
    }, "normal_model");

    const findScheduledRun = () => db
      .select({ run: heartbeatRuns })
      .from(agentWakeupRequests)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, agentWakeupRequests.runId))
      .where(and(
        eq(agentWakeupRequests.companyId, input.issue.companyId),
        eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
        sql`${agentWakeupRequests.status} <> 'skipped'`,
      ))
      .limit(1)
      .then((rows) => rows[0]?.run ?? null);

    let scheduledRun = await findScheduledRun();
    let created = false;
    if (!scheduledRun) {
      try {
        if (timing.delayMs === 0) {
          const enqueuedRun = await deps.enqueueWakeup(agentId, {
            source: "automation",
            triggerDetail: "system",
            reason: ISSUE_DISPOSITION_REPAIR_RETRY_REASON,
            idempotencyKey,
            payload: withRecoveryModelProfileHint({
              issueId: input.issue.id,
              retryOfRunId: input.latestRun?.id ?? null,
              recoveryActionId: input.action.id,
              dispositionRepairFingerprint: input.fingerprint,
              dispositionRepairAttempt: input.attempt,
              bypassContinuationSummaryPark: true,
            }, "normal_model"),
            requestedByActorType: "system",
            requestedByActorId: null,
            contextSnapshot: context,
          });
          scheduledRun = enqueuedRun ?? (await findScheduledRun());
          created = Boolean(enqueuedRun);
        } else {
          scheduledRun = await db.transaction(async (tx) => {
            const wakeup = await tx
              .insert(agentWakeupRequests)
              .values({
                companyId: input.issue.companyId,
                agentId,
                source: "automation",
                triggerDetail: "system",
                reason: ISSUE_DISPOSITION_REPAIR_RETRY_REASON,
                payload: withRecoveryModelProfileHint({
                  issueId: input.issue.id,
                  retryOfRunId: input.latestRun?.id ?? null,
                  recoveryActionId: input.action.id,
                  dispositionRepairFingerprint: input.fingerprint,
                  dispositionRepairAttempt: input.attempt,
                  bypassContinuationSummaryPark: true,
                }, "normal_model"),
                status: "queued",
                requestedByActorType: "system",
                requestedByActorId: null,
                idempotencyKey,
                updatedAt: now,
              })
              .returning()
              .then((rows) => rows[0]!);
            const run = await tx
              .insert(heartbeatRuns)
              .values({
                companyId: input.issue.companyId,
                agentId,
                invocationSource: "automation",
                triggerDetail: "system",
                status: "scheduled_retry",
                wakeupRequestId: wakeup.id,
                retryOfRunId: input.latestRun?.id ?? null,
                scheduledRetryAt: retryAt,
                scheduledRetryAttempt: input.attempt,
                scheduledRetryReason: ISSUE_DISPOSITION_REPAIR_RETRY_REASON,
                contextSnapshot: context,
                updatedAt: now,
              })
              .returning()
              .then((rows) => rows[0]!);
            await tx
              .update(agentWakeupRequests)
              .set({ runId: run.id, updatedAt: now })
              .where(eq(agentWakeupRequests.id, wakeup.id));
            return run;
          });
          created = true;
        }
      } catch (error) {
        if (!isUniqueViolation(error, DISPOSITION_REPAIR_IDEMPOTENCY_INDEX)) throw error;
        const winningRun = await findScheduledRun();
        if (!winningRun) throw error;
        scheduledRun = winningRun;
      }
    }

    if (!scheduledRun) return null;

    await db
      .update(issueRecoveryActions)
      .set({
        attemptCount: input.attempt,
        wakePolicy: {
          type: "bounded_owner_disposition_repair",
          retryAgentId: agentId,
          attempt: input.attempt,
          maxAttempts: DISPOSITION_REPAIR_MAX_ATTEMPTS,
          baseBackoffMs: timing.baseDelayMs,
          jitterMs: timing.jitterMs,
          retryAt: retryAt.toISOString(),
          scheduledRunId: scheduledRun.id,
        },
        timeoutAt: retryAt,
        lastAttemptAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(issueRecoveryActions.id, input.action.id),
        eq(issueRecoveryActions.companyId, input.issue.companyId),
      ));

    if (created) {
      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: "system",
        actorId: "recovery",
        agentId: null,
        runId: input.latestRun?.id ?? null,
        action: "issue.disposition_repair_scheduled",
        entityType: "issue_recovery_action",
        entityId: input.action.id,
        details: {
          sourceIssueId: input.issue.id,
          sourceIdentifier: input.issue.identifier,
          ownerAgentId: agentId,
          sourceStateFingerprint: input.fingerprint,
          attempt: input.attempt,
          maxAttempts: DISPOSITION_REPAIR_MAX_ATTEMPTS,
          baseBackoffMs: timing.baseDelayMs,
          jitterMs: timing.jitterMs,
          retryAt: retryAt.toISOString(),
          scheduledRunId: scheduledRun.id,
        },
      });
    }

    return scheduledRun;
  }

  async function latestRecoveryActionRun(action: typeof issueRecoveryActions.$inferSelect) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, action.companyId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId' = ${action.id}`,
      ))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function sourceHasNewPathOutsideRecoveryAction(
    action: typeof issueRecoveryActions.$inferSelect,
  ) {
    const [run, wake] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, action.companyId),
          inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
          sql`coalesce(${heartbeatRuns.contextSnapshot} ->> 'issueId', ${heartbeatRuns.contextSnapshot} ->> 'taskId') = ${action.sourceIssueId}`,
          sql`coalesce(${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId', '') <> ${action.id}`,
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, action.companyId),
          inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
          sql`coalesce(${agentWakeupRequests.payload} ->> 'issueId', ${agentWakeupRequests.payload} ->> 'taskId') = ${action.sourceIssueId}`,
          sql`coalesce(${agentWakeupRequests.payload} ->> 'recoveryActionId', '') <> ${action.id}`,
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(run || wake);
  }


  async function reconcileActiveRecoveryActions() {
    const rows = await db
      .select({ action: issueRecoveryActions, issue: issues })
      .from(issueRecoveryActions)
      .innerJoin(
        issues,
        and(
          eq(issues.id, issueRecoveryActions.sourceIssueId),
          eq(issues.companyId, issueRecoveryActions.companyId),
        ),
      )
      .where(inArray(issueRecoveryActions.status, ["active", "escalated"]));

    const result = { requeued: 0, escalated: 0, resolved: 0, skipped: 0, issueIds: [] as string[] };
    for (const { action, issue } of rows) {
      const wakePolicy = parseObject(action.wakePolicy);
      const wakePolicyType = readNonEmptyString(wakePolicy.type);
      if (
        wakePolicyType !== "bounded_recovery_owner" &&
        wakePolicyType !== "bounded_owner_disposition_repair" &&
        action.ownerType !== "board"
      ) {
        continue;
      }

      if (issue.status === "done" || issue.status === "cancelled") {
        const resolved = await recoveryActionsSvc.resolveActiveForIssue({
          companyId: action.companyId,
          sourceIssueId: action.sourceIssueId,
          actionId: action.id,
          status: "resolved",
          outcome: "restored",
          resolutionNote: "source_terminal",
        });
        if (resolved) {
          result.resolved += 1;
          result.issueIds.push(issue.id);
        }
        continue;
      }

      const [sourceState, healthyChildren, hasNewSourcePath] = await Promise.all([
        collectDispositionRepairSourceState(db, { issue }),
        healthyOpenChildIssues(issue),
        sourceHasNewPathOutsideRecoveryAction(action),
      ]);
      const durablePathRestored = action.ownerType !== "board" && sourceState.hasDurableWaitingPath;
      if (durablePathRestored || healthyChildren.length > 0 || hasNewSourcePath) {
        if (healthyChildren.length > 0 && !sourceState.hasDurableWaitingPath) {
          const blockerIds = await existingUnresolvedBlockerIssueIds(issue.companyId, issue.id);
          await issuesSvc.update(issue.id, {
            status: "blocked",
            blockedByIssueIds: [...new Set([
              ...blockerIds,
              ...healthyChildren.map((child) => child.id),
            ])],
          });
        }
        const resolved = await recoveryActionsSvc.resolveActiveForIssue({
          companyId: action.companyId,
          sourceIssueId: action.sourceIssueId,
          actionId: action.id,
          status: "resolved",
          outcome: "restored",
          resolutionNote: durablePathRestored
            ? `durable_path_restored:${sourceState.durablePathReason ?? "unknown"}`
            : healthyChildren.length > 0
              ? "durable_path_restored:healthy_child"
              : "new_source_execution_path",
        });
        if (resolved) {
          result.resolved += 1;
          result.issueIds.push(issue.id);
        }
        continue;
      }

      if (wakePolicyType === "bounded_owner_disposition_repair") {
        if (await isAutomaticRecoverySuppressedByPauseHold(
          db,
          issue.companyId,
          issue.id,
          treeControlSvc,
        )) {
          result.skipped += 1;
          continue;
        }

        const latestRun = await latestRecoveryActionRun(action);
        const persistedAttempt = Math.max(
          action.attemptCount,
          Math.max(0, Math.floor(asNumber(wakePolicy.attempt, action.attemptCount))),
        );
        const outcome = await reconcileDispositionRepair(issue, latestRun, {
          historicalAttemptCount: persistedAttempt,
        });
        if (outcome === "queued") {
          result.requeued += 1;
          result.issueIds.push(issue.id);
        } else if (outcome === "escalated") {
          result.escalated += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      if (action.ownerType === "board") continue;

      // Legacy takeover actions remain readable and resolvable, but recovery no
      // longer schedules another agent-owned wake for them.
      result.skipped += 1;
    }
    return result;
  }

  async function escalateDispositionRepair(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    fingerprint: string;
    attemptCount: number;
    terminalReason: string;
  }) {
    const action = await ensureDispositionRepairAction({
      issue: input.issue,
      latestRun: input.latestRun,
      fingerprint: input.fingerprint,
      attemptCount: input.attemptCount,
    });
    const now = new Date();
    await db
      .update(issueRecoveryActions)
      .set({
        status: "active",
        ownerType: "board",
        ownerAgentId: null,
        ownerUserId: null,
        maxAttempts: null,
        evidence: {
          ...action.evidence,
          latestRunId: input.latestRun?.id ?? null,
          latestRunStatus: input.latestRun?.status ?? null,
          latestRunErrorCode: input.latestRun?.errorCode ?? null,
          terminalReason: input.terminalReason,
          sourceAttemptCount: input.attemptCount,
          sourceMaxAttempts: DISPOSITION_REPAIR_MAX_ATTEMPTS,
          routingPolicy: STRANDED_BOARD_ESCALATION_POLICY,
        },
        nextAction:
          "Inspect the evidence and choose whether to repair, retry the original owner, explicitly reassign, or resolve the source issue.",
        wakePolicy: {
          type: "board_escalation",
          reason: input.terminalReason,
          preservesSourceAssignee: true,
        },
        timeoutAt: null,
        resolutionNote: input.terminalReason,
        updatedAt: now,
      })
      .where(and(
        eq(issueRecoveryActions.id, action.id),
        eq(issueRecoveryActions.companyId, input.issue.companyId),
      ));

    const updated = await issuesSvc.update(input.issue.id, {
      status: "blocked",
    });
    if (!updated) return null;
    const sourceAssigneePreserved =
      updated.assigneeAgentId === input.issue.assigneeAgentId &&
      updated.assigneeUserId === input.issue.assigneeUserId;

    await issuesSvc.addComment(
      input.issue.id,
      [
        "Paperclip exhausted the bounded original-owner disposition repair without a durable source-state change.",
        "",
        `- Attempts: ${input.attemptCount}/${DISPOSITION_REPAIR_MAX_ATTEMPTS}`,
        `- Terminal reason: \`${input.terminalReason}\``,
        "- Recovery owner: board",
        "- Source ownership: unchanged; reassignment requires an explicit decision or a policy-defined serious failure.",
        "",
        "Next action: repair the liveness disposition or request an explicit source-owner decision.",
      ].join("\n"),
      {},
      {
        authorType: "system",
        presentation: compactRecoveryPresentation("Recovery: disposition repair escalated — source owner preserved"),
        metadata: recoveryNoticeMetadata({
          cause: "deliberate_wait_without_target",
          latestRun: input.latestRun,
          recoveryActionId: action.id,
          previousStatus: input.issue.status,
          recoveryOwner: null,
        }),
      },
    );

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "recovery",
      agentId: null,
      runId: input.latestRun?.id ?? null,
      action: "issue.disposition_repair_escalated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        status: "blocked",
        previousStatus: input.issue.status,
        sourceStateFingerprint: input.fingerprint,
        attemptCount: input.attemptCount,
        maxAttempts: DISPOSITION_REPAIR_MAX_ATTEMPTS,
        terminalReason: input.terminalReason,
        recoveryActionId: action.id,
        recoveryOwnerAgentId: null,
        recoveryOwnerType: "board",
        routingPolicy: STRANDED_BOARD_ESCALATION_POLICY,
        sourceAssigneeBefore: {
          agentId: input.issue.assigneeAgentId,
          userId: input.issue.assigneeUserId,
        },
        sourceAssigneeAfter: {
          agentId: updated.assigneeAgentId,
          userId: updated.assigneeUserId,
        },
        sourceAssigneePreserved,
      },
    });
    if (!sourceAssigneePreserved) {
      logger.error({
        issueId: input.issue.id,
        beforeAssigneeAgentId: input.issue.assigneeAgentId,
        afterAssigneeAgentId: updated.assigneeAgentId,
        beforeAssigneeUserId: input.issue.assigneeUserId,
        afterAssigneeUserId: updated.assigneeUserId,
      }, "automatic disposition recovery observed a concurrent source-owner change");
    }
    return updated;
  }

  async function reconcileDispositionRepair(
    issue: typeof issues.$inferSelect,
    latestRun: LatestIssueRun,
    options: { historicalAttemptCount?: number } = {},
  ): Promise<"queued" | "escalated" | "covered" | "skipped"> {
    const current = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, issue.id)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!current || current.status === "done" || current.status === "cancelled") return "skipped";

    const dependencyWait = await resolveContinuationWaitingOnReview(current);
    if (dependencyWait) {
      await resolveDispositionRepairActionAsCovered(current, "dependency_wait_created");
      return "covered";
    }

    const state = await collectDispositionRepairSourceState(db, { issue: current });
    if (state.hasActiveExecutionPath) return "skipped";
    if (state.hasDurableWaitingPath) {
      await resolveDispositionRepairActionAsCovered(
        current,
        `durable_path_restored:${state.durablePathReason ?? "unknown"}`,
      );
      return "covered";
    }

    const ownerAgentId = current.assigneeAgentId;
    const ownerAgent = ownerAgentId ? await getAgent(ownerAgentId) : null;
    const ownerInvokable = ownerAgent && ownerAgent.companyId === current.companyId
      ? (await isAgentInvokable(ownerAgent)) && isHeartbeatWakeOnDemandEnabled(ownerAgent)
      : false;
    const budgetBlocked = ownerAgentId ? await isInvocationBudgetBlocked(current, ownerAgentId) : true;
    const previousAttempt = readDispositionRepairAttempt(latestRun);
    const activeRepairAction = await recoveryActionsSvc.getActiveForIssue(current.companyId, current.id);
    const runAttempt = previousAttempt?.fingerprint === state.fingerprint
      ? previousAttempt.attempt
      : 0;
    const persistedAttempt = activeRepairAction?.kind === "deliberate_wait_without_target" &&
      activeRepairAction.fingerprint === state.fingerprint
      ? activeRepairAction.attemptCount
      : 0;
    // Upgrade compatibility: pre-fingerprint continuation parks already spent
    // attempts against this unchanged source state. Seed the durable counter
    // from that consecutive legacy history instead of granting five fresh
    // attempts merely because the recovery-action row did not exist yet.
    const historicalAttempt = Math.min(
      DISPOSITION_REPAIR_MAX_ATTEMPTS,
      Math.max(0, Math.floor(options.historicalAttemptCount ?? 0)),
    );
    const sameFingerprintAttempt = Math.max(runAttempt, persistedAttempt, historicalAttempt);
    if (!ownerInvokable || budgetBlocked) {
      const escalated = await escalateDispositionRepair({
        issue: current,
        latestRun,
        fingerprint: state.fingerprint,
        attemptCount: sameFingerprintAttempt,
        terminalReason: !ownerInvokable ? "owner_not_invokable" : "owner_budget_blocked",
      });
      return escalated ? "escalated" : "skipped";
    }

    if (sameFingerprintAttempt >= DISPOSITION_REPAIR_MAX_ATTEMPTS) {
      const escalated = await escalateDispositionRepair({
        issue: current,
        latestRun,
        fingerprint: state.fingerprint,
        attemptCount: sameFingerprintAttempt,
        terminalReason: "unchanged_source_state_exhausted",
      });
      return escalated ? "escalated" : "skipped";
    }

    const nextAttempt = sameFingerprintAttempt + 1;
    const action = await ensureDispositionRepairAction({
      issue: current,
      latestRun,
      fingerprint: state.fingerprint,
      attemptCount: sameFingerprintAttempt,
    });
    const scheduled = await scheduleDispositionRepairAttempt({
      issue: current,
      latestRun,
      action,
      fingerprint: state.fingerprint,
      attempt: nextAttempt,
    });
    return scheduled ? "queued" : "skipped";
  }

  async function escalateStrandedAssignedIssue(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: StrandedPreviousStatus;
    latestRun: LatestIssueRun;
    comment?: string;
    notice?: StrandedRecoveryNoticeSeed | null;
    recoveryCause?: StrandedRecoveryCause;
    recoveryOwnerAgentId?: string | null;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
    agentInvokability?: AgentInvokability | null;
  }) {
    if (isStrandedIssueRecoveryIssue(input.issue)) {
      return escalateStrandedRecoveryIssueInPlace({
        issue: input.issue,
        previousStatus: input.previousStatus,
        latestRun: input.latestRun,
      });
    }

    const recoveryCause = resolveStrandedRecoveryCause(input.latestRun, input.recoveryCause);
    const escalationSource = input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
      ? "recovery.reconcile_successful_run_handoff_missing_state"
      : input.recoveryCause === "workspace_validation_failed"
        ? "recovery.reconcile_workspace_validation_failed"
      : input.recoveryCause === "configuration_incomplete"
        ? "recovery.reconcile_configuration_incomplete"
      : input.recoveryCause === "execution_review_participant_recovery"
        ? "recovery.reconcile_execution_review_participant"
      : input.recoveryCause === "opencode_db_growth_limit"
        ? "recovery.reconcile_opencode_db_growth_limit"
      : input.recoveryCause === "stillborn_assigned_backlog"
        ? "recovery.reconcile_stillborn_assigned_backlog"
      : "recovery.reconcile_stranded_assigned_issue";
    const recoveryAction = await ensureSourceScopedStrandedRecoveryAction({
      issue: input.issue,
      previousStatus: input.previousStatus,
      latestRun: input.latestRun,
      recoveryCause,
      recoveryOwnerAgentId: input.recoveryOwnerAgentId,
      successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
      agentInvokability: input.agentInvokability,
    });
    const isProviderQuotaWait = recoveryCause === "provider_quota" &&
      !recoveryAction.ownerAgentId &&
      Boolean(recoveryAction.returnOwnerAgentId);
    if (isProviderQuotaWait && recoveryAction.returnOwnerAgentId) {
      await ensureProviderQuotaWaitRecoveryMonitor({
        issue: input.issue,
        latestRun: input.latestRun,
        actionId: recoveryAction.id,
        agentId: recoveryAction.returnOwnerAgentId,
      });
    }
    const nextAssigneeAgentId = resolveRecoveryReassignedAssignee(input.issue, recoveryAction.ownerAgentId);
    const updated = await blockIssueWithUnresolvedBlockers(db, input.issue, {
      source: escalationSource,
      previousStatus: input.previousStatus,
      extraUpdate: { assigneeAgentId: nextAssigneeAgentId },
    });
    if (!updated) return null;
    const blockerIds = await existingUnresolvedBlockerIssueIds(input.issue.companyId, input.issue.id);
    if (isProviderQuotaWait) return updated;
    const sourceAssigneePreserved =
      updated.assigneeAgentId === input.issue.assigneeAgentId &&
      updated.assigneeUserId === input.issue.assigneeUserId;

    const recoveryOwner = recoveryAction.ownerAgentId ? await getAgent(recoveryAction.ownerAgentId) : null;
    const sourceAssignee = input.issue.assigneeAgentId ? await getAgent(input.issue.assigneeAgentId) : null;
    let notice: SuccessfulRunHandoffNotice | null = null;
    if (input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON && input.successfulRunHandoffEvidence) {
      const [sourceRun] = input.successfulRunHandoffEvidence.sourceRunId
        ? await db
          .select({
            id: heartbeatRuns.id,
            status: heartbeatRuns.status,
            agentId: heartbeatRuns.agentId,
          })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.id, input.successfulRunHandoffEvidence.sourceRunId),
            eq(heartbeatRuns.companyId, input.issue.companyId),
          ))
          .limit(1)
        : [];
      notice = buildSuccessfulRunHandoffExhaustedNotice({
        issue: input.issue,
        sourceRun: sourceRun ?? null,
        correctiveRun: input.latestRun
          ? { id: input.latestRun.id, status: input.latestRun.status, agentId: input.latestRun.agentId }
          : null,
        sourceAssignee,
        recoveryIssue: null,
        recoveryActionId: recoveryAction.id,
        recoveryOwner,
        latestIssueStatus: input.issue.status,
        latestHandoffRunStatus: input.latestRun?.status ?? "unknown",
        missingDisposition: input.successfulRunHandoffEvidence.missingDisposition,
      });
    }
    const escalationNotice = buildStrandedRecoveryEscalationNotice({
      seed: input.notice,
      fallbackBody: input.comment,
      recoveryCause,
      recoveryActionId: recoveryAction.id,
      recoveryOwner: recoveryAction.ownerAgentId && recoveryOwner
        ? { id: recoveryOwner.id, name: recoveryOwner.name }
        : null,
      sourceRun: input.latestRun
        ? {
            id: input.latestRun.id,
            agentId: input.latestRun.agentId,
            status: input.latestRun.status,
            errorCode: input.latestRun.errorCode,
            errorSummary: input.latestRun.error ? redactSensitiveText(input.latestRun.error) : null,
          }
        : null,
    });

    const shouldPostEscalationComment =
      recoveryAction.attemptCount === 1 ||
      input.recoveryCause === "workspace_validation_failed" ||
      input.recoveryCause === "configuration_incomplete";
    if (shouldPostEscalationComment) {
      const escalationCommentMarker = `Recovery action: \`${recoveryAction.id}\``;

      const hasEscalationComment = await db
        .select({ id: issueComments.id, body: issueComments.body, metadata: issueComments.metadata })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, input.issue.id),
            eq(issueComments.authorType, "system"),
          ),
        )
        .orderBy(desc(issueComments.createdAt))
        .limit(50)
        .then((rows) => rows.some((row) =>
          noticeMetadataReferencesRecoveryAction(row.metadata, recoveryAction.id) ||
          (row.body ?? "").includes(escalationCommentMarker),
        ));

      if (!hasEscalationComment) {
        if (notice) {
          await issuesSvc.addComment(input.issue.id, notice.body, {}, {
            authorType: "system",
            presentation: notice.presentation,
            metadata: notice.metadata,
          });
        } else {
          await issuesSvc.addComment(input.issue.id, escalationNotice.body, {}, {
            authorType: "system",
            presentation: escalationNotice.presentation,
            metadata: escalationNotice.metadata,
          });
        }
      }
    }

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
        ? "issue.successful_run_handoff_escalated"
        : "issue.updated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        status: "blocked",
        previousStatus: input.previousStatus,
        source: escalationSource,
        recoveryCause: input.recoveryCause ?? "stranded_assigned_issue",
        latestRunId: input.latestRun?.id ?? null,
        latestRunStatus: input.latestRun?.status ?? null,
        latestRunErrorCode: input.latestRun?.errorCode ?? null,
        recoveryActionId: recoveryAction.id,
        recoveryOwnerType: recoveryAction.ownerType,
        recoveryOwnerAgentId: recoveryAction.ownerAgentId,
        previousOwnerAgentId: recoveryAction.previousOwnerAgentId,
        returnOwnerAgentId: recoveryAction.returnOwnerAgentId,
        routingPolicy: parseObject(recoveryAction.evidence).routingPolicy ?? null,
        sourceAssigneeBefore: {
          agentId: input.issue.assigneeAgentId,
          userId: input.issue.assigneeUserId,
        },
        sourceAssigneeAfter: {
          agentId: updated.assigneeAgentId,
          userId: updated.assigneeUserId,
        },
        sourceAssigneePreserved,
        blockerIssueIds: blockerIds,
      },
    });

    await enqueueSourceScopedStrandedRecoveryWake({
      action: recoveryAction,
      issue: input.issue,
      latestRun: input.latestRun,
      recoveryCause,
    });

    if (recoveryAction.ownerAgentId && recoveryAction.ownerAgentId === input.issue.assigneeAgentId) {
      const [currentIssue] = await db
        .select({
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(eq(issues.id, input.issue.id))
        .limit(1);
      if (
        currentIssue &&
        (currentIssue.status !== "blocked" ||
          currentIssue.assigneeAgentId !== recoveryAction.ownerAgentId)
      ) {
        const reblocked = await blockIssueWithUnresolvedBlockers(db, input.issue, {
          source: escalationSource,
          previousStatus: input.previousStatus,
          extraUpdate: {
            assigneeAgentId: resolveRecoveryReassignedAssignee(
              input.issue,
              recoveryAction.ownerAgentId,
              currentIssue.assigneeAgentId,
            ),
          },
        });
        if (reblocked) return reblocked;
      }
    }

    return updated;
  }

  async function persistAdapterFailureRecoveryClassification(
    latestRun: NonNullable<LatestIssueRun>,
    classification: NonNullable<AdapterFailureRecoveryClassification>,
  ): Promise<NonNullable<LatestIssueRun>> {
    const classifiedRun = withAdapterFailureRecoveryClassification(latestRun, classification);

    await db
      .update(heartbeatRuns)
      .set({
        errorCode: classifiedRun.errorCode,
        resultJson: parseObject(classifiedRun.resultJson),
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, latestRun.id));

    return classifiedRun;
  }

  function withAdapterFailureRecoveryClassification(
    latestRun: NonNullable<LatestIssueRun>,
    classification: NonNullable<AdapterFailureRecoveryClassification>,
  ): NonNullable<LatestIssueRun> {
    const resultJson = parseObject(latestRun.resultJson);
    const providerQuotaMetadata = classification.kind === "provider_quota"
      ? {
          errorFamily: "provider_quota",
          retryNotBefore: classification.retryAt.toISOString(),
          transientRetryNotBefore: classification.retryAt.toISOString(),
          providerQuotaRetryNotBefore: classification.retryAt.toISOString(),
        }
      : { errorFamily: "configuration_incomplete" };
    const errorCode = classification.kind;

    return {
      ...latestRun,
      errorCode,
      resultJson: {
        ...resultJson,
        ...providerQuotaMetadata,
        recoveryClassification: errorCode,
      },
    };
  }

  async function scheduleProviderQuotaRecoveryMonitor(input: {
    issue: typeof issues.$inferSelect;
    latestRun: NonNullable<LatestIssueRun>;
    classification: Extract<NonNullable<AdapterFailureRecoveryClassification>, { kind: "provider_quota" }>;
  }) {
    if (input.issue.status !== "in_progress" && input.issue.status !== "in_review") return null;

    const targetAgentId = getAdapterFailureRecoveryTargetAgentId(input.issue);
    if (!targetAgentId || input.latestRun.agentId !== targetAgentId) return null;

    const previousPolicy = normalizeIssueExecutionPolicy(input.issue.executionPolicy ?? null);
    const retryTargetDescription = input.issue.status === "in_review"
      ? "the active review participant"
      : "the original assignee";
    const policy = {
      ...(previousPolicy ?? { mode: "normal" as const, commentRequired: true, stages: [] }),
      monitor: {
        nextCheckAt: input.classification.retryAt.toISOString(),
        notes: input.classification.parsedResetTime
          ? `Provider usage quota reached; retry ${retryTargetDescription} at the provider reset time.`
          : `Provider usage quota reached; retry ${retryTargetDescription} after the default recovery backoff.`,
        scheduledBy: "assignee" as const,
        kind: "external_service" as const,
        serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME,
        externalRef: input.latestRun.id,
        timeoutAt: null,
        maxAttempts: null,
        recoveryPolicy: "wake_owner" as const,
      },
    };
    const transition = applyIssueMonitorPolicyTransition({
      issue: input.issue,
      policy,
      previousPolicy,
      requestedStatus: input.issue.status,
      requestedAssigneePatch: {},
      actor: { agentId: null, userId: null },
      monitorExplicitlyUpdated: true,
    });
    const updated = await issuesSvc.update(input.issue.id, {
      ...transition.patch,
      executionPolicy: policy,
    });
    if (!updated) return null;

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "recovery",
      agentId: null,
      runId: input.latestRun.id,
      action: "issue.monitor_scheduled",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        source: "recovery.provider_quota",
        latestRunId: input.latestRun.id,
        errorCode: "provider_quota",
        nextCheckAt: input.classification.retryAt.toISOString(),
        parsedResetTime: input.classification.parsedResetTime,
        targetAgentId,
      },
    });

    return updated;
  }

  function getAdapterFailureRecoveryTargetAgentId(issue: typeof issues.$inferSelect) {
    if (issue.status !== "in_review") return issue.assigneeAgentId;

    const pendingExecutionState = parseIssueExecutionState(issue.executionState);
    const participant = pendingExecutionState?.status === "pending"
      ? pendingExecutionState.currentParticipant
      : null;
    return participant?.type === "agent" ? participant.agentId : null;
  }

  function hasPendingRecoveryMonitor(
    issue: typeof issues.$inferSelect,
    latestRun: LatestIssueRun | null,
    now: Date,
  ) {
    if (!latestRun || !issue.monitorNextCheckAt || issue.monitorNextCheckAt.getTime() <= now.getTime()) return false;
    const monitor = parseObject(parseObject(issue.executionPolicy).monitor);
    if (!monitor) return false;
    return true;
  }

  async function reconcileStrandedAssignedIssues(opts?: { issueCreatedAtGte?: Date | null }) {
    const candidates = await db
      .select()
      .from(issues)
      .where(
        and(
          isNull(issues.assigneeUserId),
          inArray(issues.status, ["todo", "in_progress", "in_review"]),
          or(
            sql`${issues.assigneeAgentId} is not null`,
            eq(issues.status, "in_review"),
            and(
              inArray(issues.status, ["todo", "in_progress"]),
              isNull(issues.assigneeAgentId),
            ),
          ),
          opts?.issueCreatedAtGte ? gte(issues.createdAt, opts.issueCreatedAtGte) : undefined,
        ),
      );

    const result = {
      assignmentDispatched: 0,
      dispatchRequeued: 0,
      continuationRequeued: 0,
      dispositionRepairRequeued: 0,
      productiveContinuationObserved: 0,
      successfulContinuationObserved: 0,
      orphanBlockersAssigned: 0,
      successfulRunHandoffEscalated: 0,
      reviewParticipantRequeued: 0,
      escalated: 0,
      waitingOnReviewResolved: 0,
      providerQuotaMonitored: 0,
      recentProgressExempted: 0,
      operatorCancelExempted: 0,
      skipped: 0,
      noLivePathUnowned: 0,
      reviewStageUnarmed: 0,
      noLivePathOwnerUnavailable: 0,
      issueIds: [] as string[],
    };

    for (const issue of candidates) {
      const now = new Date();
      const executionState = issue.status === "in_review"
        ? parseIssueExecutionState(issue.executionState)
        : null;
      const pendingExecutionState = executionState?.status === "pending" ? executionState : null;
      const currentParticipant = pendingExecutionState
        ? pendingExecutionState.currentParticipant
        : null;
      const participantAgentId = currentParticipant?.type === "agent" ? currentParticipant.agentId : null;
      const agentId = issue.status === "in_review" && participantAgentId
        ? participantAgentId
        : issue.assigneeAgentId;
      if (!agentId) {
        if (issue.status === "in_review") {
          result.skipped += 1;
          continue;
        }
        const msSinceUpdate = now.getTime() - issue.updatedAt.getTime();
        if (msSinceUpdate < NO_LIVE_PATH_GRACE_THRESHOLD_MS) {
          result.skipped += 1;
          continue;
        }
        const exemptLabel = await db
          .select({ id: labels.id })
          .from(issueLabels)
          .innerJoin(labels, eq(labels.id, issueLabels.labelId))
          .where(
            and(
              eq(issueLabels.issueId, issue.id),
              eq(labels.companyId, issue.companyId),
              eq(labels.name, INTENTIONALLY_OWNERLESS_LABEL),
            ),
          )
          .limit(1);
        if (exemptLabel.length > 0) {
          const existingAction = await recoveryActionsSvc.getActiveForIssue(issue.companyId, issue.id);
          if (existingAction?.kind === "no_live_path_unowned") {
            await recoveryActionsSvc.resolveActiveForIssue({
              companyId: issue.companyId,
              sourceIssueId: issue.id,
              actionId: existingAction.id,
              status: "resolved",
              outcome: "false_positive",
              resolutionNote:
                "Issue is marked intentionally_ownerless; no_live_path_unowned action cleared as a deliberately ownerless standing tracking issue.",
            });
          }
          result.skipped += 1;
          continue;
        }
        const existingAction = await recoveryActionsSvc.getActiveForIssue(issue.companyId, issue.id);
        if (existingAction?.kind === "no_live_path_unowned") {
          result.skipped += 1;
          continue;
        }
        await recoveryActionsSvc.upsertSourceScoped({
          companyId: issue.companyId,
          sourceIssueId: issue.id,
          kind: "no_live_path_unowned",
          ownerType: "board",
          previousOwnerAgentId: issue.assigneeAgentId ?? null,
          cause: "no_live_path_unowned",
          fingerprint: `no_live_path_unowned:${issue.companyId}:${issue.id}`,
          evidence: {
            identifier: issue.identifier,
            status: issue.status,
            msSinceUpdate,
          },
          nextAction: "Assign an owner agent or record an intentional manual resolution.",
          wakePolicy: null,
          monitorPolicy: null,
          maxAttempts: null,
          lastAttemptAt: now,
        });
        result.noLivePathUnowned += 1;
        result.issueIds.push(issue.id);
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: "issue_graph_liveness_no_live_path_unowned",
          action: "issue.no_live_path_unowned_escalated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            source: "recovery.reconcile_no_live_path_unowned",
            fingerprint: `no_live_path_unowned:${issue.companyId}:${issue.id}`,
          },
        });
        continue;
      }

      let latestRun = await getLatestIssueRun(issue.companyId, issue.id);

      const agent = await getAgent(agentId);
      const agentInvokability: AgentInvokability = agent && agent.companyId === issue.companyId
        ? await getAgentInvokability(agent)
        : {
          invokable: false,
          reason: "missing",
          message: "Agent is not assigned to this company",
          details: {},
          invalidOrgChain: false,
        };
      const agentInvokable = agentInvokability.invokable;

      const recoveryNow = new Date();
      const participantLatestRunForRecovery = issue.status === "in_review" && participantAgentId
        ? await getLatestIssueRunForAgent(issue.companyId, issue.id, participantAgentId)
        : null;
      const monitorRun = issue.status === "in_review"
        ? participantLatestRunForRecovery
        : latestRun;
      if (hasPendingRecoveryMonitor(issue, monitorRun, recoveryNow)) {
        result.skipped += 1;
        continue;
      }

      if (issue.status !== "in_review" && !agentInvokable) {
        const msSinceUpdate = now.getTime() - issue.updatedAt.getTime();
        if (msSinceUpdate < NO_LIVE_PATH_GRACE_THRESHOLD_MS) {
          result.skipped += 1;
          continue;
        }
        const existingAction = await recoveryActionsSvc.getActiveForIssue(issue.companyId, issue.id);
        if (existingAction?.kind === "no_live_path_owner_unavailable") {
          result.skipped += 1;
          continue;
        }
        await recoveryActionsSvc.upsertSourceScoped({
          companyId: issue.companyId,
          sourceIssueId: issue.id,
          kind: "no_live_path_owner_unavailable",
          ownerType: "board",
          previousOwnerAgentId: issue.assigneeAgentId ?? null,
          cause: "no_live_path_owner_unavailable",
          fingerprint: `no_live_path_owner_unavailable:${issue.companyId}:${issue.id}`,
          evidence: {
            identifier: issue.identifier,
            status: issue.status,
            agentId,
            msSinceUpdate,
            agentInvokable: agentInvokable,
            agentInvokabilityReason: agentInvokability.reason,
            agentInvokabilityMessage: agentInvokability.message,
          },
          nextAction: "Restore a live execution path, reactivate or replace the assignee, or record an intentional manual resolution.",
          wakePolicy: null,
          monitorPolicy: null,
          maxAttempts: null,
          lastAttemptAt: now,
        });
        result.noLivePathOwnerUnavailable += 1;
        result.issueIds.push(issue.id);
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: "issue_graph_liveness_no_live_path_owner_unavailable",
          action: "issue.no_live_path_owner_unavailable_escalated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            source: "recovery.reconcile_no_live_path_owner_unavailable",
            fingerprint: `no_live_path_owner_unavailable:${issue.companyId}:${issue.id}`,
          },
        });
        continue;
      }

      if (await hasActiveExecutionPath(
        issue.companyId,
        issue.id,
        issue.status === "in_review" ? agentId : null,
      )) {
        result.skipped += 1;
        continue;
      }

      if (await hasPendingWakeInteraction(issue.companyId, issue.id)) {
        result.skipped += 1;
        continue;
      }

      if (await isAutomaticRecoverySuppressedByPauseHold(db, issue.companyId, issue.id, treeControlSvc)) {
        result.skipped += 1;
        continue;
      }

      latestRun = await getLatestIssueRun(issue.companyId, issue.id);
      if (isOperatorCancelledRun(latestRun)) {
        result.operatorCancelExempted += 1;
        continue;
      }
      if (await isInvocationBudgetBlocked(issue, agentId)) {
        const budgetClassification = classifyContinuationFailure(latestRun);
        if (
          budgetClassification.kind === "deliberate_wait_without_target" ||
          readDispositionRepairAttempt(latestRun)
        ) {
          const outcome = await reconcileDispositionRepair(issue, latestRun);
          if (outcome === "escalated") {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
        } else {
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: issue.status as StrandedPreviousStatus,
            latestRun,
            recoveryCause: issue.status === "in_review"
              ? EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON
              : undefined,
            comment:
              "Paperclip cannot safely continue automatic recovery because the original recovery target is over budget. " +
              "The source assignment is unchanged and the board must choose the next action.",
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
        }
        continue;
      }
      if (latestRun?.status === "succeeded" && await hasPersistedDurableWaitPath(issue)) {
        result.skipped += 1;
        continue;
      }
      if (isStrandedIssueRecoveryIssue(issue) && isUnsuccessfulTerminalIssueRun(latestRun)) {
        const updated = await escalateStrandedRecoveryIssueInPlace({
          issue,
          previousStatus: issue.status as StrandedPreviousStatus,
          latestRun,
        });
        if (updated) {
          result.escalated += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      const adapterFailureClassification = issue.status !== "in_review" && latestRun && isUnsuccessfulTerminalIssueRun(latestRun)
        ? classifyAdapterFailureForRecovery(latestRun, recoveryNow)
        : null;
      if (latestRun && adapterFailureClassification) {
        const targetAgentId = getAdapterFailureRecoveryTargetAgentId(issue);
        if (!targetAgentId || latestRun.agentId !== targetAgentId) {
          result.skipped += 1;
          continue;
        }

        if (adapterFailureClassification.kind === "provider_quota") {
          const monitored = await scheduleProviderQuotaRecoveryMonitor({
            issue,
            latestRun,
            classification: adapterFailureClassification,
          });
          if (monitored) {
            latestRun = await persistAdapterFailureRecoveryClassification(latestRun, adapterFailureClassification);
            result.providerQuotaMonitored += 1;
            result.issueIds.push(issue.id);
            continue;
          }
          result.skipped += 1;
          continue;
        } else {
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: issue.status as StrandedPreviousStatus,
            latestRun,
            recoveryCause: "configuration_incomplete",
            comment:
              "Paperclip classified the latest adapter failure as `configuration_incomplete`. " +
              "Moving the issue to `blocked` with the configuration fix recorded instead of creating a recovery takeover.",
            agentInvokability: agentInvokability,
          });
          if (updated) {
            latestRun = await persistAdapterFailureRecoveryClassification(latestRun, adapterFailureClassification);
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }
      }

      const acceptedContinuationInteraction = await getLatestAcceptedContinuationInteraction(issue.companyId, issue.id);
      const acceptedInteractionResolvedAt = acceptedContinuationInteraction
        ? acceptedContinuationInteraction.resolvedAt ?? acceptedContinuationInteraction.updatedAt
        : null;
      if (acceptedContinuationInteraction && acceptedInteractionResolvedAt && !pendingExecutionState) {
        const legacyReviewParkAttempts = await summarizeRecentContinuationRetries(
          issue.companyId,
          issue.id,
          agentId,
          CONTINUATION_WAITING_ON_REVIEW_ERROR_CODE,
          acceptedInteractionResolvedAt,
        );
        const successfulRunSinceResolution = await hasSuccessfulIssueRunSince(
          issue.companyId,
          issue.id,
          agentId,
          acceptedInteractionResolvedAt,
          acceptedContinuationInteraction.id,
        );

        if (!successfulRunSinceResolution) {
          if (!agentInvokable) {
            result.skipped += 1;
            continue;
          }

          if (await hasQueuedIssueWake(issue.companyId, issue.id, agentId)) {
            result.skipped += 1;
            continue;
          }

          if (await isInvocationBudgetBlocked(issue, agentId)) {
            result.skipped += 1;
            continue;
          }

          const latestPostResolutionRun = await getLatestIssueRunSince(
            issue.companyId,
            issue.id,
            agentId,
            acceptedInteractionResolvedAt,
          );
          if (
            classifyContinuationFailure(latestPostResolutionRun).kind ===
            "deliberate_wait_without_target"
          ) {
            const resolved = await resolveContinuationWaitingOnReview(issue);
            if (resolved) {
              result.waitingOnReviewResolved += 1;
              result.issueIds.push(issue.id);
              continue;
            }
            const outcome = await reconcileDispositionRepair(issue, latestPostResolutionRun, {
              historicalAttemptCount: legacyReviewParkAttempts.consecutive,
            });
            if (outcome === "queued") {
              result.continuationRequeued += 1;
              result.dispositionRepairRequeued += 1;
              result.issueIds.push(issue.id);
            } else if (outcome === "escalated") {
              result.escalated += 1;
              result.issueIds.push(issue.id);
            } else {
              result.skipped += 1;
            }
            continue;
          }
          const { consecutive } = legacyReviewParkAttempts;
          if (consecutive >= INTERACTION_CONTINUATION_REQUEUE_MAX_ATTEMPTS && latestPostResolutionRun) {
            const resolved = await resolveContinuationWaitingOnReview(issue);
            if (resolved) {
              result.waitingOnReviewResolved += 1;
              result.issueIds.push(issue.id);
              continue;
            }

            const updated = await escalateStrandedAssignedIssue({
              issue,
              previousStatus: issue.status as StrandedPreviousStatus,
              latestRun: latestPostResolutionRun,
              comment:
                `Paperclip stopped requeueing accepted interaction \`${acceptedContinuationInteraction.id}\` after ` +
                `${consecutive} consecutive continuation wakes were cancelled while waiting on review. ` +
                "Moving the issue to `blocked` so the missing execution path is visible for intervention.",
              agentInvokability: agentInvokability,
            });
            if (updated) {
              result.escalated += 1;
              result.issueIds.push(issue.id);
            } else {
              result.skipped += 1;
            }
            continue;
          }

          const queued = await enqueueStrandedIssueRecovery({
            issueId: issue.id,
            agentId,
            reason: "issue_continuation_needed",
            retryReason: "issue_continuation_needed",
            source: "issue.interaction_continuation_recovery",
            retryOfRunId: latestPostResolutionRun?.id ?? acceptedContinuationInteraction.sourceRunId ?? latestRun?.id ?? null,
            extraContext: {
              mutation: "interaction",
              interactionId: acceptedContinuationInteraction.id,
              interactionKind: acceptedContinuationInteraction.kind,
              interactionStatus: acceptedContinuationInteraction.status,
              interactionContinuationPolicy: acceptedContinuationInteraction.continuationPolicy,
              interactionResolvedAt: acceptedInteractionResolvedAt.toISOString(),
            },
          });
          if (queued) {
            result.continuationRequeued += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }
      }

      if (issue.status === "in_review") {
        if (!participantAgentId || !pendingExecutionState) {
          const msSinceUpdate = now.getTime() - issue.updatedAt.getTime();
          if (msSinceUpdate < NO_LIVE_PATH_GRACE_THRESHOLD_MS) {
            result.skipped += 1;
            continue;
          }
          const existingAction = await recoveryActionsSvc.getActiveForIssue(issue.companyId, issue.id);
          if (existingAction?.kind === "review_stage_unarmed") {
            result.skipped += 1;
            continue;
          }
          await recoveryActionsSvc.upsertSourceScoped({
            companyId: issue.companyId,
            sourceIssueId: issue.id,
            kind: "review_stage_unarmed",
            ownerType: "board",
            previousOwnerAgentId: issue.assigneeAgentId ?? null,
            cause: "review_stage_unarmed",
            fingerprint: `review_stage_unarmed:${issue.companyId}:${issue.id}`,
            evidence: {
              identifier: issue.identifier,
              status: issue.status,
              msSinceUpdate,
            },
            nextAction: "Re-arm the execution review stage by setting the current participant and state, or record an intentional manual resolution.",
            wakePolicy: null,
            monitorPolicy: null,
            maxAttempts: null,
            lastAttemptAt: now,
          });
          result.reviewStageUnarmed += 1;
          result.issueIds.push(issue.id);
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: "system",
            actorId: "issue_graph_liveness_review_stage_unarmed",
            action: "issue.review_stage_unarmed_escalated",
            entityType: "issue",
            entityId: issue.id,
            details: {
              source: "recovery.reconcile_review_stage_unarmed",
              fingerprint: `review_stage_unarmed:${issue.companyId}:${issue.id}`,
            },
          });
          continue;
        }
        const participantLatestRun = participantLatestRunForRecovery;

        if (!participantLatestRun || !isTerminalIssueRun(participantLatestRun)) {
          if (!agentInvokable) {
            const updated = await escalateStrandedAssignedIssue({
              issue,
              previousStatus: "in_review",
              latestRun: participantLatestRun,
              notice: buildExecutionReviewParticipantUnavailableNoticeSeed(),
              recoveryCause: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
              recoveryOwnerAgentId: participantAgentId,
              agentInvokability: agentInvokability,
            });
            if (updated) {
              result.escalated += 1;
              result.issueIds.push(issue.id);
            } else {
              result.skipped += 1;
            }
          } else {
            result.skipped += 1;
          }
          continue;
        }

        const participantAdapterFailureClassification = isUnsuccessfulTerminalIssueRun(participantLatestRun)
          ? classifyAdapterFailureForRecovery(participantLatestRun, recoveryNow)
          : null;
        if (participantAdapterFailureClassification?.kind === "provider_quota") {
          const monitored = await scheduleProviderQuotaRecoveryMonitor({
            issue,
            latestRun: participantLatestRun,
            classification: participantAdapterFailureClassification,
          });
          if (monitored) {
            latestRun = await persistAdapterFailureRecoveryClassification(
              participantLatestRun,
              participantAdapterFailureClassification,
            );
            result.providerQuotaMonitored += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }
        if (participantAdapterFailureClassification?.kind === "configuration_incomplete") {
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "in_review",
            latestRun: participantLatestRun,
            recoveryCause: "configuration_incomplete",
            comment:
              "Paperclip classified the active review participant's latest adapter failure as " +
              "`configuration_incomplete`. Moving the issue to `blocked` with the configuration fix " +
              "recorded instead of repeatedly requeueing the reviewer.",
            agentInvokability: agentInvokability,
          });
          if (updated) {
            latestRun = await persistAdapterFailureRecoveryClassification(
              participantLatestRun,
              participantAdapterFailureClassification,
            );
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (!agentInvokable) {
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "in_review",
            latestRun: participantLatestRun,
            notice: buildExecutionReviewParticipantUnavailableNoticeSeed(),
            recoveryCause: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
            recoveryOwnerAgentId: participantAgentId,
            agentInvokability: agentInvokability,
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (didAutomaticRecoveryFail(participantLatestRun, EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON)) {
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "in_review",
            latestRun: participantLatestRun,
            notice: buildExecutionReviewParticipantRecoveryNoticeSeed(),
            recoveryCause: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
            recoveryOwnerAgentId: participantAgentId,
            agentInvokability: agentInvokability,
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (await hasQueuedIssueWake(issue.companyId, issue.id, participantAgentId)) {
          result.skipped += 1;
          continue;
        }

        if (await isInvocationBudgetBlocked(issue, participantAgentId)) {
          result.skipped += 1;
          continue;
        }

        const queued = await enqueueStrandedIssueRecovery({
          issueId: issue.id,
          agentId: participantAgentId,
          reason: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
          retryReason: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
          source: "issue.execution_review_recovery",
          retryOfRunId: participantLatestRun.id,
          extraContext: {
            currentStageId: pendingExecutionState.currentStageId ?? null,
            currentStageType: pendingExecutionState.currentStageType ?? null,
            reviewRecoveryInstruction:
              "The previous reviewer run ended while this execution-review stage was still pending. Submit the review decision now, or mark the issue blocked with the exact unblock action.",
          },
        });
        if (queued) {
          result.reviewParticipantRequeued += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      if (issue.status === "todo") {
        if (!latestRun) {
          if (await hasQueuedIssueWake(issue.companyId, issue.id)) {
            result.skipped += 1;
            continue;
          }

          if (await isInvocationBudgetBlocked(issue, agentId)) {
            result.skipped += 1;
            continue;
          }

          const queued = await enqueueInitialAssignedTodoDispatch(issue, agentId);
          if (queued) {
            result.assignmentDispatched += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (
          latestRun.status === "succeeded" &&
          !(await wasTodoHandedBackDuringOrAfterLatestRun(issue, latestRun))
        ) {
          result.skipped += 1;
          continue;
        }

        if (didAutomaticRecoveryFail(latestRun, "assignment_recovery")) {
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "todo",
            latestRun,
            notice: {
              body:
                "Paperclip automatically retried dispatch for this assigned `todo` issue after a lost wake/run, " +
                "but it still has no live execution path. " +
                "Moving it to `blocked` so it is visible for intervention.",
              title: "No live execution path",
              tone: "danger",
            },
            agentInvokability: agentInvokability,
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (await isInvocationBudgetBlocked(issue, agentId)) {
          result.skipped += 1;
          continue;
        }

        const queued = await enqueueStrandedIssueRecovery({
          issueId: issue.id,
          agentId,
          reason: "issue_assignment_recovery",
          retryReason: "assignment_recovery",
          source: "issue.assignment_recovery",
          retryOfRunId: latestRun.id,
        });
        if (queued) {
          result.dispatchRequeued += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      if (!latestRun && !issue.checkoutRunId && !issue.executionRunId) {
        result.skipped += 1;
        continue;
      }
      if (readDispositionRepairAttempt(latestRun)) {
        const outcome = await reconcileDispositionRepair(issue, latestRun);
        if (outcome === "queued") {
          result.continuationRequeued += 1;
          result.dispositionRepairRequeued += 1;
          result.issueIds.push(issue.id);
        } else if (outcome === "escalated") {
          result.escalated += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }
      const handoffEvidence = isExhaustedSuccessfulRunHandoff(latestRun);
      if (handoffEvidence) {
        if (isPluginManagedIssueLifecycle(issue)) {
          result.skipped += 1;
          continue;
        }
        if (!handoffEvidence.exhausted) {
          result.skipped += 1;
          continue;
        }

        const updated = await escalateStrandedAssignedIssue({
          issue,
          previousStatus: "in_progress",
          latestRun,
          recoveryCause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
          successfulRunHandoffEvidence: handoffEvidence,
          agentInvokability: agentInvokability,
        });
        if (updated) {
          result.successfulRunHandoffEscalated += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }
      if (isSuccessfulInProgressContinuationRun(latestRun)) {
        const successfulRun = latestRun;

        if (!isProductiveContinuationRun(successfulRun)) {
          result.successfulContinuationObserved += 1;
          result.skipped += 1;
          continue;
        }

        if (isRepeatedProductiveContinuationRecovery(successfulRun)) {
          // GGU-809: skip escalation if the assignee has shown visible progress
          // (comment or attachment) within the exemption window. Falling
          // through here lets the normal continuation-retry path enqueue the
          // next wake, which is the correct behaviour for batch workflows.
          const exempted = await hasRecentVisibleProgress(
            issue.companyId,
            issue.id,
            agentId,
            STRANDED_RECENT_PROGRESS_EXEMPTION_MS,
          );
          if (!exempted) {
            const updated = await escalateStrandedAssignedIssue({
              issue,
              previousStatus: "in_progress",
              latestRun: successfulRun,
              comment:
                "Paperclip automatically retried continuation for this assigned `in_progress` issue and the retry " +
                "made progress, but it still has no live execution path. Moving it to `blocked` so it is visible for intervention.",
              agentInvokability: agentInvokability,
            });
            if (updated) {
              result.escalated += 1;
              result.issueIds.push(issue.id);
            } else {
              result.skipped += 1;
            }
            continue;
          }
          result.recentProgressExempted += 1;
        }

        if (await isInvocationBudgetBlocked(issue, agentId)) {
          result.skipped += 1;
          continue;
        }

        const queued = await enqueueStrandedIssueRecovery({
          issueId: issue.id,
          agentId,
          reason: "issue_continuation_needed",
          retryReason: "issue_continuation_needed",
          source: "issue.productive_terminal_continuation_recovery",
          retryOfRunId: successfulRun.id,
        });
        if (queued) {
          result.continuationRequeued += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }
      if (isUnsuccessfulTerminalIssueRun(latestRun)) {
        const classification = classifyContinuationFailure(latestRun);

        if (classification.errorCode === CONTINUATION_WAITING_ON_REVIEW_ERROR_CODE) {
          const resolved = await resolveContinuationWaitingOnReview(issue);
          if (resolved) {
            result.waitingOnReviewResolved += 1;
            result.issueIds.push(issue.id);
            continue;
          }

          const outcome = await reconcileDispositionRepair(issue, latestRun);
          if (outcome === "queued") {
            result.continuationRequeued += 1;
            result.dispositionRepairRequeued += 1;
            result.issueIds.push(issue.id);
          } else if (outcome === "escalated") {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (classification.kind === "non_retryable") {
          const databaseGrowthLimit =
            classification.errorCode === OPENCODE_DB_GROWTH_LIMIT_ERROR_CODE;
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "in_progress",
            latestRun,
            ...(databaseGrowthLimit ? { recoveryCause: "opencode_db_growth_limit" as const } : {}),
            // The growth-limit case gets the remediation spelled out: without it
            // the next owner reads "non-retryable" and re-runs the same command.
            notice: databaseGrowthLimit
              ? {
                body:
                  "Paperclip terminated this issue's run because its OpenCode database grew past the " +
                  "per-run budget. That is caused by a command whose output streams faster than the " +
                  "database can absorb it — each output chunk is written as a full snapshot — so " +
                  "retrying the same work would run the same command and fail the same way. " +
                  "Moving it to `blocked` so the offending command can be " +
                  "changed before resuming: redirect long or chatty command output to a file and " +
                  "report a bounded slice of it (`cmd > /tmp/run.log 2>&1; tail -100 /tmp/run.log`).",
                title: "OpenCode database growth limit",
                tone: "danger",
              }
              : {
                body:
                  "Paperclip detected a non-retryable failure on this issue's continuation run " +
                  `(\`${classification.errorCode}\`). Skipping automatic retries and moving it to \`blocked\` ` +
                  "so it is visible for intervention.",
                title: "Continuation failed",
                tone: "danger",
              },
            agentInvokability: agentInvokability,
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        const { consecutive, latestFinishedAt } = await summarizeRecentContinuationRetries(
          issue.companyId,
          issue.id,
          agentId,
          classification.errorCode,
        );
        // SUP-12466: apply the bounded-attempt policy to ANY unsuccessful terminal
        // run whose errorCode repeats, not only to runs already stamped
        // `retryReason === "issue_continuation_needed"`. A fresh dispatch failure
        // (consecutive === 1) still gets its one free retry; once the same errorCode
        // has repeated with zero progress (consecutive >= 2) -- or the latest run was
        // already a continuation retry -- the cap applies.
        if (didAutomaticRecoveryFail(latestRun, "issue_continuation_needed") || consecutive >= 2) {
          if (consecutive >= classification.maxAttempts) {
            const attemptCopy = consecutive <= 1 ? "" : ` (${consecutive}× attempts)`;
            const updated = await escalateStrandedAssignedIssue({
              issue,
              previousStatus: "in_progress",
              latestRun,
              notice: {
                body:
                  "Paperclip automatically retried continuation for this assigned `in_progress` issue after its live " +
                  `execution disappeared, but it still has no live execution path${attemptCopy}. ` +
                  "Moving it to `blocked` so it is visible for intervention.",
                title: "No live execution path",
                tone: "danger",
              },
              agentInvokability: agentInvokability,
            });
            if (updated) {
              result.escalated += 1;
              result.issueIds.push(issue.id);
            } else {
              result.skipped += 1;
            }
            continue;
          }

          if (classification.baseBackoffMs > 0 && latestFinishedAt) {
            const elapsed = Date.now() - latestFinishedAt.getTime();
            const requiredDelay = classification.baseBackoffMs *
              Math.pow(2, Math.max(0, consecutive - 1));
            if (elapsed < requiredDelay) {
              result.skipped += 1;
              continue;
            }
          }
        }
      }

      if (await isInvocationBudgetBlocked(issue, agentId)) {
        result.skipped += 1;
        continue;
      }

      const queued = await enqueueStrandedIssueRecovery({
        issueId: issue.id,
        agentId,
        reason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
        source: "issue.continuation_recovery",
        retryOfRunId: latestRun?.id ?? issue.checkoutRunId ?? null,
      });
      if (queued) {
        result.continuationRequeued += 1;
        result.issueIds.push(issue.id);
      } else {
        result.skipped += 1;
      }
    }

    const orphanBlockerRecovery = await reconcileUnassignedBlockingIssues();
    result.orphanBlockersAssigned = orphanBlockerRecovery.assigned;
    result.skipped += orphanBlockerRecovery.skipped;
    result.issueIds.push(...orphanBlockerRecovery.issueIds);

    const activeRecovery = await reconcileActiveRecoveryActions();
    result.continuationRequeued += activeRecovery.requeued;
    result.escalated += activeRecovery.escalated;
    result.skipped += activeRecovery.skipped;
    result.issueIds.push(...activeRecovery.issueIds);
    result.issueIds = [...new Set(result.issueIds)];

    return result;
  }

  async function collectIssueGraphLivenessFindings() {
    const issueRowsPromise = Promise.resolve(db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        projectId: issues.projectId,
        goalId: issues.goalId,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        createdByAgentId: issues.createdByAgentId,
        createdByUserId: issues.createdByUserId,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        monitorAttemptCount: issues.monitorAttemptCount,
      })
      .from(issues)
      .where(
        and(
          visibleIssueCondition(),
          notInArray(issues.originKind, [RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation]),
        ),
      ));

    const [
      issueRows,
      relationRows,
      agentRows,
      activeRunRows,
      activeIssueRunRows,
      wakeRows,
      interactionRows,
      approvalRows,
      recoveryIssueRows,
      recoveryActionRows,
    ] = await Promise.all([
      issueRowsPromise,
      db
        .select({
          companyId: issueRelations.companyId,
          blockerIssueId: issueRelations.issueId,
          blockedIssueId: issueRelations.relatedIssueId,
        })
        .from(issueRelations)
        .where(eq(issueRelations.type, "blocks")),
      db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          role: agents.role,
          title: agents.title,
          status: agents.status,
          reportsTo: agents.reportsTo,
        })
        .from(agents),
      db
        .select({
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES])),
      db
        .select({
          companyId: issues.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          issueId: issues.id,
        })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(
          and(
            visibleIssueCondition(),
            notInArray(issues.originKind, [RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation]),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
          ),
        ),
      db
        .select({
          companyId: agentWakeupRequests.companyId,
          agentId: agentWakeupRequests.agentId,
          status: agentWakeupRequests.status,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .where(inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])),
      db
        .select({
          companyId: issueThreadInteractions.companyId,
          issueId: issueThreadInteractions.issueId,
          status: issueThreadInteractions.status,
        })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.status, "pending")),
      db
        .select({
          companyId: issueApprovals.companyId,
          issueId: issueApprovals.issueId,
          status: approvals.status,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(inArray(approvals.status, ["pending", "revision_requested"])),
      db
        .select({
          companyId: issues.companyId,
          id: issues.id,
          status: issues.status,
          originKind: issues.originKind,
          originId: issues.originId,
        })
        .from(issues)
        .where(
          and(
            visibleIssueCondition(),
            inArray(issues.originKind, [
              STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
              RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
            ]),
            notInArray(issues.status, ["done", "cancelled"]),
          ),
        ),
      issueRowsPromise.then((rows) => {
        const issueIdsUnderAnalysis = rows.map((row) => row.id);
        return issueIdsUnderAnalysis.length === 0
          ? []
          : db
            .select({
              id: issueRecoveryActions.id,
              companyId: issueRecoveryActions.companyId,
              issueId: issueRecoveryActions.sourceIssueId,
              status: issueRecoveryActions.status,
              ownerType: issueRecoveryActions.ownerType,
              ownerAgentId: issueRecoveryActions.ownerAgentId,
              ownerUserId: issueRecoveryActions.ownerUserId,
            })
            .from(issueRecoveryActions)
            .where(
              and(
                inArray(issueRecoveryActions.status, ["active", "escalated"]),
                inArray(issueRecoveryActions.sourceIssueId, issueIdsUnderAnalysis),
              ),
            );
      }),
    ]);

    const openRecoveryIssues = recoveryIssueRows.flatMap((row) => {
      if (row.originKind === RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation) {
        const parsed = parseIssueGraphLivenessIncidentKey(row.originId);
        if (!parsed || parsed.companyId !== row.companyId) return [];
        return [
          {
            companyId: row.companyId,
            issueId: parsed.issueId,
            status: row.status,
          },
          {
            companyId: row.companyId,
            issueId: parsed.leafIssueId,
            status: row.status,
          },
        ];
      }

      const issueId = readNonEmptyString(row.originId);
      if (!issueId) return [];
      return [{
        companyId: row.companyId,
        issueId,
        status: row.status,
      }];
    });

    const liveRecoveryActionIds = new Set<string>();
    for (const row of activeRunRows) {
      const recoveryActionId = readNonEmptyString(parseObject(row.contextSnapshot).recoveryActionId);
      if (recoveryActionId) liveRecoveryActionIds.add(recoveryActionId);
    }
    for (const row of wakeRows) {
      const recoveryActionId = readNonEmptyString(parseObject(row.payload).recoveryActionId);
      if (recoveryActionId) liveRecoveryActionIds.add(recoveryActionId);
    }
    const healthyRecoveryActions = recoveryActionRows.filter((row) =>
      (row.status === "escalated" && row.ownerType === "board") ||
      Boolean(row.ownerUserId) ||
      (Boolean(row.ownerAgentId) && liveRecoveryActionIds.has(row.id)),
    );

    return classifyIssueGraphLiveness({
      issues: issueRows,
      relations: relationRows,
      agents: agentRows,
      activeRuns: activeRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromRunContext(row.contextSnapshot),
      })).concat(activeIssueRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: row.issueId,
      }))),
      queuedWakeRequests: wakeRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromWakePayload(row.payload),
      })),
      pendingInteractions: interactionRows,
      pendingApprovals: approvalRows,
      openRecoveryIssues: openRecoveryIssues.concat(healthyRecoveryActions),
      now: new Date(),
    });
  }

  async function findOpenLivenessEscalation(companyId: string, incidentKey: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          eq(issues.originId, incidentKey),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findOpenLivenessRecoveryIssueForLeaf(finding: IssueLivenessFinding) {
    const byFingerprint = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, finding.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          eq(issues.originFingerprint, livenessRecoveryLeafFingerprint(finding)),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (byFingerprint) return byFingerprint;

    const leafIssueId = livenessRecoveryLeafIssueId(finding);
    const openRecoveries = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, finding.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    return openRecoveries.find((row) => {
      const parsed = parseLivenessIncidentKey(row.originId);
      return parsed?.state === finding.state && parsed.leafIssueId === leafIssueId;
    }) ?? null;
  }

  async function findRecentCompletedLivenessRecoveryIssue(
    finding: IssueLivenessFinding,
    now: Date,
    cooldownMs: number,
  ) {
    if (cooldownMs <= 0) return null;
    const cutoff = new Date(now.getTime() - cooldownMs);
    return db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, finding.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          or(
            eq(issues.originId, finding.incidentKey),
            eq(issues.originFingerprint, livenessRecoveryLeafFingerprint(finding)),
          ),
          visibleIssueCondition(),
          eq(issues.status, "done"),
          gte(issues.updatedAt, cutoff),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function removeRecoveryBlockerFromSource(recovery: typeof issues.$inferSelect) {
    const parsed = parseLivenessIncidentKey(recovery.originId);
    if (!parsed) return false;
    const sourceIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, recovery.companyId), eq(issues.id, parsed.issueId)))
      .then((rows) => rows[0] ?? null);
    if (!sourceIssue) return false;

    const blockerIds = await existingBlockerIssueIds(sourceIssue.companyId, sourceIssue.id);
    if (!blockerIds.includes(recovery.id)) return false;
    await issuesSvc.update(sourceIssue.id, {
      blockedByIssueIds: blockerIds.filter((blockerId) => blockerId !== recovery.id),
    });
    return true;
  }

  async function hasActiveRunForIssueId(companyId: string, issueId: string) {
    const [contextRun, issueRun] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
            sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}
              OR ${heartbeatRuns.contextSnapshot}->>'taskId' = ${issueId})`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: heartbeatRuns.id })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.id, issueId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(contextRun || issueRun);
  }

  async function retireObsoleteLivenessRecoveryIssues(findings: IssueLivenessFinding[]) {
    const currentIncidentKeys = new Set(findings.map((finding) => finding.incidentKey));
    const currentLeafKeys = new Set(
      findings.map((finding) =>
        livenessRecoveryLeafKey(
          finding.companyId,
          finding.state,
          livenessRecoveryLeafIssueId(finding),
        ),
      ),
    );
    const openRecoveries = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    const result = {
      retired: 0,
      activeSkipped: 0,
      blockerRelationsRemoved: 0,
      retiredIssueIds: [] as string[],
    };

    for (const recovery of openRecoveries) {
      if (recovery.originId && currentIncidentKeys.has(recovery.originId)) continue;
      const parsed = parseLivenessIncidentKey(recovery.originId);
      if (!parsed) continue;
      if (
        currentLeafKeys.has(
          livenessRecoveryLeafKey(parsed.companyId, parsed.state, parsed.leafIssueId),
        )
      ) {
        continue;
      }
      const sourceIssue = await db
        .select({
          id: issues.id,
          status: issues.status,
        })
        .from(issues)
        .where(and(eq(issues.companyId, parsed.companyId), eq(issues.id, parsed.issueId)))
        .then((rows) => rows[0] ?? null);
      if (sourceIssue && !["done", "cancelled"].includes(sourceIssue.status)) {
        const blockerIds = await existingBlockerIssueIds(parsed.companyId, sourceIssue.id);
        if (blockerIds.includes(recovery.id)) {
          result.activeSkipped += 1;
          continue;
        }
      }
      if (await removeRecoveryBlockerFromSource(recovery)) {
        result.blockerRelationsRemoved += 1;
      }
      if (await hasActiveRunForIssueId(recovery.companyId, recovery.id)) {
        result.activeSkipped += 1;
        continue;
      }
      await issuesSvc.update(recovery.id, { status: "cancelled" });
      result.retired += 1;
      result.retiredIssueIds.push(recovery.id);
    }

    return result;
  }

  async function retireDoneLivenessRecoveryBlockers() {
    const closedRecoveries = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          visibleIssueCondition(),
          inArray(issues.status, ["done", "cancelled"]),
        ),
      );

    let blockerRelationsRemoved = 0;
    for (const recovery of closedRecoveries) {
      if (await removeRecoveryBlockerFromSource(recovery)) {
        blockerRelationsRemoved += 1;
      }
    }

    return { blockerRelationsRemoved };
  }

  function normalizeIssueGraphLivenessAutoRecoveryLookbackHours(raw: unknown) {
    const numeric = Math.floor(asNumber(raw, DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS));
    return Math.min(
      MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
      Math.max(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS, numeric),
    );
  }

  function livenessDependencyIssueKey(companyId: string, issueId: string) {
    return `${companyId}:${issueId}`;
  }

  async function loadLivenessDependencyUpdatedAtByIssue(findings: IssueLivenessFinding[]) {
    const issueIds = [
      ...new Set(
        findings.flatMap((finding) => finding.dependencyPath.map((entry) => entry.issueId)),
      ),
    ];
    if (issueIds.length === 0) return new Map<string, Date>();
    const rows = await db
      .select({ id: issues.id, companyId: issues.companyId, updatedAt: issues.updatedAt })
      .from(issues)
      .where(inArray(issues.id, issueIds));
    return new Map(rows.map((row) => [
      livenessDependencyIssueKey(row.companyId, row.id),
      row.updatedAt,
    ]));
  }

  function latestDependencyUpdatedAtForLivenessFinding(
    finding: IssueLivenessFinding,
    updatedAtByIssueKey: Map<string, Date>,
  ) {
    const dependencyIssueIds = [...new Set(finding.dependencyPath.map((entry) => entry.issueId))];
    if (dependencyIssueIds.length === 0) return null;
    const timestamps = dependencyIssueIds.map((issueId) =>
      updatedAtByIssueKey.get(livenessDependencyIssueKey(finding.companyId, issueId)) ?? null
    );
    if (timestamps.some((timestamp) => !timestamp)) return null;
    const [firstTimestamp, ...remainingTimestamps] = timestamps as Date[];
    return remainingTimestamps.reduce((latest, updatedAt) =>
      updatedAt > latest ? updatedAt : latest,
    firstTimestamp!);
  }

  function isLivenessFindingInsideAutoRecoveryLookback(
    finding: IssueLivenessFinding,
    cutoff: Date,
    updatedAtByIssueKey: Map<string, Date>,
  ) {
    const latestUpdatedAt = latestDependencyUpdatedAtForLivenessFinding(finding, updatedAtByIssueKey);
    return Boolean(latestUpdatedAt && latestUpdatedAt >= cutoff);
  }

  async function buildIssueGraphLivenessAutoRecoveryPreview(
    opts?: { lookbackHours?: number; now?: Date },
  ): Promise<IssueGraphLivenessAutoRecoveryPreview> {
    const now = opts?.now ?? new Date();
    const lookbackHours = normalizeIssueGraphLivenessAutoRecoveryLookbackHours(opts?.lookbackHours);
    const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
    const findings = await collectIssueGraphLivenessFindings();
    const updatedAtByIssueKey = await loadLivenessDependencyUpdatedAtByIssue(findings);
    const issueIds = [...new Set(findings.map((finding) => finding.recoveryIssueId))];
    const recoveryRows = issueIds.length > 0
      ? await db
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
        .from(issues)
        .where(inArray(issues.id, issueIds))
      : [];
    const recoveryById = new Map(recoveryRows.map((row) => [row.id, row]));
    const items: IssueGraphLivenessAutoRecoveryPreviewItem[] = [];
    let skippedOutsideLookback = 0;

    for (const finding of findings) {
      const latestDependencyUpdatedAt = latestDependencyUpdatedAtForLivenessFinding(
        finding,
        updatedAtByIssueKey,
      );
      if (!latestDependencyUpdatedAt || latestDependencyUpdatedAt < cutoff) {
        skippedOutsideLookback += 1;
        continue;
      }
      const recoveryIssue = recoveryById.get(finding.recoveryIssueId);
      items.push({
        issueId: finding.issueId,
        identifier: finding.identifier,
        title: finding.dependencyPath[0]?.title ?? finding.identifier ?? finding.issueId,
        state: finding.state,
        severity: finding.severity,
        reason: finding.reason,
        recoveryIssueId: finding.recoveryIssueId,
        recoveryIdentifier: recoveryIssue?.identifier ?? null,
        recoveryTitle: recoveryIssue?.title ?? null,
        recommendedOwnerAgentId: finding.recommendedOwnerAgentId,
        incidentKey: finding.incidentKey,
        latestDependencyUpdatedAt: latestDependencyUpdatedAt.toISOString(),
        dependencyPath: finding.dependencyPath,
      });
    }

    return {
      lookbackHours,
      cutoff: cutoff.toISOString(),
      generatedAt: now.toISOString(),
      findings: findings.length,
      recoverableFindings: items.length,
      skippedOutsideLookback,
      items,
    };
  }

  async function resolveEscalationOwnerAgentId(
    finding: IssueLivenessFinding,
    issue: typeof issues.$inferSelect,
  ) {
    const detailedCandidates = finding.recommendedOwnerCandidates.length > 0
      ? finding.recommendedOwnerCandidates
      : finding.recommendedOwnerCandidateAgentIds.map((agentId) => ({
        agentId,
        reason: "ordered_invokable_fallback" as const,
        sourceIssueId: finding.recoveryIssueId,
      }));
    const seenCandidates = new Set<string>();
    const candidates = detailedCandidates.filter((candidate) => {
      if (seenCandidates.has(candidate.agentId)) return false;
      seenCandidates.add(candidate.agentId);
      return true;
    });
    const budgetBlockedCandidateAgentIds: string[] = [];
    for (const candidate of candidates) {
      const budgetBlock = await budgets.getInvocationBlock(issue.companyId, candidate.agentId, {
        issueId: issue.id,
        projectId: issue.projectId,
      });
      if (!budgetBlock) {
        return {
          agentId: candidate.agentId,
          reason: candidate.reason,
          sourceIssueId: candidate.sourceIssueId,
          candidateAgentIds: candidates.map((entry) => entry.agentId),
          candidateReasons: candidates.map((entry) => ({
            agentId: entry.agentId,
            reason: entry.reason,
            sourceIssueId: entry.sourceIssueId,
          })),
          budgetBlockedCandidateAgentIds,
        };
      }
      budgetBlockedCandidateAgentIds.push(candidate.agentId);
    }

    return null;
  }

  function shouldReuseRecoveryExecutionWorkspace(input: {
    finding: IssueLivenessFinding;
    recoveryIssue: typeof issues.$inferSelect;
    ownerAgentId: string;
  }) {
    if (input.finding.recoveryIssueId === input.finding.issueId) return false;
    return input.recoveryIssue.assigneeAgentId === input.ownerAgentId;
  }

  async function ensureIssueBlockedByEscalation(input: {
    issue: typeof issues.$inferSelect;
    escalationIssueId: string;
    finding: IssueLivenessFinding;
    runId?: string | null;
  }) {
    const blockerIds = await existingBlockerIssueIds(input.issue.companyId, input.issue.id);
    const nextBlockerIds = [...new Set([...blockerIds, input.escalationIssueId])];
    const isAlreadyBlockedByEscalation = blockerIds.includes(input.escalationIssueId);
    const isAlreadyBlocked = input.issue.status === "blocked";
    if (isAlreadyBlockedByEscalation && isAlreadyBlocked) {
      return input.issue;
    }

    const update: Partial<typeof issues.$inferInsert> & { blockedByIssueIds: string[] } = {
      blockedByIssueIds: nextBlockerIds,
    };
    if (!isAlreadyBlocked) {
      update.status = "blocked";
    }

    const updated = await issuesSvc.update(input.issue.id, update);
    if (!updated) return null;

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: input.runId ?? null,
      action: "issue.blockers.updated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        source: "recovery.reconcile_issue_graph_liveness",
        incidentKey: input.finding.incidentKey,
        findingState: input.finding.state,
        blockerIssueIds: nextBlockerIds,
        escalationIssueId: input.escalationIssueId,
        status: update.status ?? input.issue.status,
        previousStatus: input.issue.status,
      },
    });

    return updated;
  }

  async function createIssueGraphLivenessEscalation(input: {
    finding: IssueLivenessFinding;
    runId?: string | null;
    now: Date;
    reescalationCooldownMs: number;
  }) {
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, input.finding.issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue || issue.companyId !== input.finding.companyId) return { kind: "skipped" as const };
    if (await isAutomaticRecoverySuppressedByPauseHold(db, issue.companyId, issue.id, treeControlSvc)) {
      return { kind: "skipped" as const };
    }

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, input.finding.recoveryIssueId), eq(issues.companyId, issue.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!recoveryIssue) return { kind: "skipped" as const };

    const existing =
      await findOpenLivenessEscalation(issue.companyId, input.finding.incidentKey) ??
      await findOpenLivenessRecoveryIssueForLeaf(input.finding);
    if (existing) {
      await ensureIssueBlockedByEscalation({
        issue,
        escalationIssueId: existing.id,
        finding: input.finding,
        runId: input.runId ?? null,
      });
      return { kind: "existing" as const, escalationIssueId: existing.id };
    }
    if (await findRecentCompletedLivenessRecoveryIssue(
      input.finding,
      input.now,
      input.reescalationCooldownMs,
    )) {
      return { kind: "cooldown" as const };
    }

    const ownerSelection = await resolveEscalationOwnerAgentId(input.finding, recoveryIssue);
    if (!ownerSelection) return { kind: "skipped" as const };
    const reuseRecoveryExecutionWorkspace = shouldReuseRecoveryExecutionWorkspace({
      finding: input.finding,
      recoveryIssue,
      ownerAgentId: ownerSelection.agentId,
    });

    let escalation: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      escalation = await issuesSvc.create(issue.companyId, {
        title: `Unblock liveness incident for ${issue.identifier ?? issue.id}`,
        description: buildLivenessEscalationDescription(input.finding),
        status: "todo",
        priority: "high",
        parentId: recoveryIssue.id,
        projectId: recoveryIssue.projectId,
        goalId: recoveryIssue.goalId,
        assigneeAgentId: ownerSelection.agentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides("status_only"),
        originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
        originId: input.finding.incidentKey,
        originFingerprint: livenessRecoveryLeafFingerprint(input.finding),
        billingCode: recoveryIssue.billingCode,
        ...(reuseRecoveryExecutionWorkspace
          ? { inheritExecutionWorkspaceFromIssueId: recoveryIssue.id }
          : {
            executionWorkspaceId: null,
            executionWorkspacePreference: null,
            executionWorkspaceSettings: null,
          }),
      });
    } catch (error) {
      if (!isUniqueLivenessRecoveryConflict(error)) throw error;
      const raced =
        await findOpenLivenessEscalation(issue.companyId, input.finding.incidentKey) ??
        await findOpenLivenessRecoveryIssueForLeaf(input.finding);
      if (!raced) throw error;
      await ensureIssueBlockedByEscalation({
        issue,
        escalationIssueId: raced.id,
        finding: input.finding,
        runId: input.runId ?? null,
      });
      return { kind: "existing" as const, escalationIssueId: raced.id };
    }

    await ensureIssueBlockedByEscalation({
      issue,
      escalationIssueId: escalation.id,
      finding: input.finding,
      runId: input.runId ?? null,
    });

    await issuesSvc.addComment(
      issue.id,
      buildLivenessOriginalIssueComment(input.finding, escalation),
      { runId: input.runId ?? null },
    );

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: ownerSelection.agentId,
      runId: input.runId ?? null,
      action: "issue.harness_liveness_escalation_created",
      entityType: "issue",
      entityId: escalation.id,
      details: {
        source: "recovery.reconcile_issue_graph_liveness",
        incidentKey: input.finding.incidentKey,
        findingState: input.finding.state,
        sourceIssueId: issue.id,
        sourceIdentifier: issue.identifier,
        recoveryIssueId: recoveryIssue.id,
        recoveryIdentifier: recoveryIssue.identifier,
        escalationIssueId: escalation.id,
        escalationIdentifier: escalation.identifier,
        dependencyPath: input.finding.dependencyPath,
        ownerSelection: {
          selectedAgentId: ownerSelection.agentId,
          selectedReason: ownerSelection.reason,
          selectedSourceIssueId: ownerSelection.sourceIssueId,
          candidateAgentIds: ownerSelection.candidateAgentIds,
          candidateReasons: ownerSelection.candidateReasons,
          budgetBlockedCandidateAgentIds: ownerSelection.budgetBlockedCandidateAgentIds,
        },
        workspaceSelection: {
          reuseRecoveryExecutionWorkspace,
          inheritedExecutionWorkspaceFromIssueId: reuseRecoveryExecutionWorkspace ? recoveryIssue.id : null,
          projectWorkspaceSourceIssueId: recoveryIssue.id,
        },
      },
    });

    const wake = await deps.enqueueWakeup(ownerSelection.agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: withRecoveryModelProfileHint({
        issueId: escalation.id,
        sourceIssueId: issue.id,
        recoveryIssueId: recoveryIssue.id,
        incidentKey: input.finding.incidentKey,
      }, "status_only"),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: escalation.id,
        taskId: escalation.id,
        wakeReason: "issue_assigned",
        source: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
        sourceIssueId: issue.id,
        recoveryIssueId: recoveryIssue.id,
        incidentKey: input.finding.incidentKey,
      }, "status_only"),
    });

    logger.warn({
      incidentKey: input.finding.incidentKey,
      findingState: input.finding.state,
      sourceIssueId: issue.id,
      recoveryIssueId: recoveryIssue.id,
      escalationIssueId: escalation.id,
      ownerAgentId: ownerSelection.agentId,
      ownerSelectionReason: ownerSelection.reason,
      wakeupRunId: wake?.id ?? null,
    }, "created issue graph liveness escalation");

    return { kind: "created" as const, escalationIssueId: escalation.id };
  }

  const DEPENDENCY_WAKE_REARM_CAP_RELOG_INTERVAL_MS = 5 * 60_000;
  let lastDependencyWakeReArmCapActivityLogAt: Date | null = null;

  async function reconcileResolvedDependencyWakeBackstop(opts?: ResolvedDependencyWakeBackstopOptions) {
    const result = {
      checked: 0,
      healed: 0,
      existingWakeSkipped: 0,
      livePathSkipped: 0,
      interactionSkipped: 0,
      pauseHoldSkipped: 0,
      notReadySkipped: 0,
      candidateLimitSkipped: 0,
      reArmCapSkipped: 0,
      reArmCapEscalated: 0,
      reArmCapEscalatedIssueIds: [] as string[],
      deferredOrFailed: 0,
      enqueueFailed: 0,
      zeroBlockerObserved: 0,
      zeroBlockerHealed: 0,
      zeroBlockerActiveRecoverySkipped: 0,
      issueIds: [] as string[],
    };

    const source = opts?.source ?? "issue_graph_liveness.backstop";
    const requestedByActorId = source === "workspace.finalize"
      ? "heartbeat_finalize"
      : "issue_graph_liveness_backstop";
    const payloadBackstop = source === "workspace.finalize"
      ? "workspace_finalize_reconciliation"
      : "issue_graph_liveness_reconciliation";
    const useCursor = !opts?.blockerIssueId;
    const config = loadConfig();
    const windowMs = opts?.rearmWindowMs ?? config.resolvedDependencyWakeRearmWindowMs;
    const maxCount = opts?.rearmMaxCount ?? config.resolvedDependencyWakeRearmMaxCount;
    const cutoff = opts?.now ? new Date(opts.now.getTime() - windowMs) : new Date(Date.now() - windowMs);
    const reArmCapNow = opts?.now ?? new Date();
    const shouldLogReArmCap =
      !lastDependencyWakeReArmCapActivityLogAt ||
      reArmCapNow.getTime() -
        lastDependencyWakeReArmCapActivityLogAt.getTime() >=
      DEPENDENCY_WAKE_REARM_CAP_RELOG_INTERVAL_MS;

    const queryCandidates = (afterIssueId: string | null) => {
      const filters = [
        eq(issues.status, "blocked"),
        visibleIssueCondition(),
        sql`${issues.assigneeAgentId} is not null`,
      ];
      if (opts?.companyId) filters.push(eq(issues.companyId, opts.companyId));
      if (afterIssueId) filters.push(gt(issues.id, afterIssueId));

      if (opts?.blockerIssueId) {
        filters.push(
          eq(issueRelations.companyId, issues.companyId),
          eq(issueRelations.type, "blocks"),
          eq(issueRelations.issueId, opts.blockerIssueId),
          eq(issueRelations.relatedIssueId, issues.id),
        );
        return db
          .select({
            id: issues.id,
            companyId: issues.companyId,
            identifier: issues.identifier,
            assigneeAgentId: issues.assigneeAgentId,
            blockedTransitionAt: issues.blockedTransitionAt,
            totalCount: sql<number>`count(*) over()::int`,
          })
          .from(issueRelations)
          .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
          .where(and(...filters))
          .orderBy(asc(issues.id))
          .limit(RESOLVED_DEPENDENCY_WAKE_BACKSTOP_CANDIDATE_LIMIT);
      }

      return db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          assigneeAgentId: issues.assigneeAgentId,
          blockedTransitionAt: issues.blockedTransitionAt,
          totalCount: sql<number>`count(*) over()::int`,
        })
        .from(issues)
        .where(and(...filters))
        .orderBy(asc(issues.id))
        .limit(RESOLVED_DEPENDENCY_WAKE_BACKSTOP_CANDIDATE_LIMIT);
    };

    let candidateRows = await queryCandidates(useCursor ? resolvedDependencyWakeBackstopCandidateCursor : null);
    if (useCursor && candidateRows.length === 0 && resolvedDependencyWakeBackstopCandidateCursor) {
      resolvedDependencyWakeBackstopCandidateCursor = null;
      candidateRows = await queryCandidates(null);
    }
    const totalCandidateCount = candidateRows[0]?.totalCount ?? 0;
    const candidates = candidateRows.map(({ totalCount: _totalCount, ...candidate }) => candidate);
    result.checked = candidates.length;
    result.candidateLimitSkipped = Math.max(0, totalCandidateCount - candidates.length);
    const lastCandidate = candidates[candidates.length - 1] ?? null;
    if (useCursor) {
      resolvedDependencyWakeBackstopCandidateCursor =
        result.candidateLimitSkipped > 0 && lastCandidate ? lastCandidate.id : null;
    }
    if (result.candidateLimitSkipped > 0) {
      logger.warn(
        {
          processed: candidates.length,
          skipped: result.candidateLimitSkipped,
          limit: RESOLVED_DEPENDENCY_WAKE_BACKSTOP_CANDIDATE_LIMIT,
          nextCursor: useCursor ? resolvedDependencyWakeBackstopCandidateCursor : null,
          source,
          blockerIssueId: opts?.blockerIssueId ?? null,
        },
        "issue graph liveness backstop deferred resolved dependency wake candidates past page limit",
      );
    }

    const candidatesByCompany = new Map<string, typeof candidates>();

    for (const candidate of candidates) {
      const companyCandidates = candidatesByCompany.get(candidate.companyId) ?? [];
      companyCandidates.push(candidate);
      candidatesByCompany.set(candidate.companyId, companyCandidates);
    }

    for (const [companyId, companyCandidates] of candidatesByCompany.entries()) {
      const readinessMap = await issuesSvc.listDependencyReadiness(
        companyId,
        companyCandidates.map((candidate) => candidate.id),
      );

      for (const candidate of companyCandidates) {
        const agentId = candidate.assigneeAgentId;
        if (!agentId) continue;

        const readiness = readinessMap.get(candidate.id);
        const resolvedBlockerIssueId = readiness?.blockerIssueIds[0] ?? null;
        const zeroBlockerHeal =
          readiness != null &&
          readiness.isDependencyReady &&
          readiness.blockerIssueIds.length === 0;
        if (zeroBlockerHeal) {
          result.zeroBlockerObserved += 1;
        } else if (
          !readiness ||
          !readiness.isDependencyReady ||
          readiness.blockerIssueIds.length === 0 ||
          !resolvedBlockerIssueId
        ) {
          result.notReadySkipped += 1;
          continue;
        }

        // Zero-blocker heal path: a live recovery action owns the issue, so
        // waking it here would race that path and re-create the re-arm ->
        // re-dead loop. Skip and count instead. An exhausted action does not
        // count as live (see hasActiveOrEscalatedRecoveryAction), so the heal
        // still runs once the sweep has given up.
        if (zeroBlockerHeal && (await hasActiveOrEscalatedRecoveryAction(companyId, candidate.id))) {
          result.zeroBlockerActiveRecoverySkipped += 1;
          continue;
        }

        // Level-triggered dedup: key on the full blocker set (the current ready
        // state), not on any single resolved edge. An older completed per-edge
        // wake for an earlier partial resolution has a different key, so it does
        // not suppress this wake. The shared helper still suppresses a duplicate
        // wake for the SAME ready state, which bounds reconciliation.
        //
        // The zero-blocker heal has no ready state to key on (its blocker set is
        // empty, so every state key would collide), so it keeps the fork key and
        // the any-key lookup.
        const idempotencyKey = zeroBlockerHeal
          ? buildIssueZeroBlockerHealWakeIdempotencyKey({ dependentIssueId: candidate.id })
          : buildIssueBlockersResolvedWakeStateKey({
              dependentIssueId: candidate.id,
              blockerIssueIds: readiness?.blockerIssueIds ?? [],
              blockedTransitionAt: candidate.blockedTransitionAt,
            });
        // The re-arm cap below counts consumed wakes, and must count them across
        // BOTH keyings so a wake emitted before the cutover still counts.
        const idempotencyKeys = zeroBlockerHeal
          ? [idempotencyKey]
          : [
              idempotencyKey,
              ...(readiness?.blockerIssueIds ?? []).map((blockerIssueId) =>
                buildIssueBlockersResolvedWakeIdempotencyKey({
                  dependentIssueId: candidate.id,
                  resolvedBlockerIssueId: blockerIssueId,
                })
              ),
            ];
        const existingWake = zeroBlockerHeal
          ? await findExistingIssueBlockersResolvedWakeForAnyKey(db, {
              companyId,
              idempotencyKeys,
              completedRearmCutoff: cutoff,
            })
          : await findExistingIssueBlockersResolvedWakeForReadyState(db, {
              companyId,
              dependentIssueId: candidate.id,
              blockerIssueIds: readiness?.blockerIssueIds ?? [],
              blockedTransitionAt: candidate.blockedTransitionAt,
              completedRearmCutoff: cutoff,
            });
        if (existingWake) {
          result.existingWakeSkipped += 1;
          continue;
        }
        const consumedWakes = idempotencyKeys.length > 0 ? await db
          .select({ count: count() })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, companyId),
              inArray(agentWakeupRequests.idempotencyKey, idempotencyKeys),
              inArray(agentWakeupRequests.status, ["completed","failed","timed_out"]),
            ),
          )
          .then((rows) => rows[0]?.count ?? 0) : 0;
        if (consumedWakes >= maxCount) {
          if (await hasActiveOrEscalatedRecoveryAction(companyId, candidate.id)) {
            result.reArmCapSkipped += 1;
            continue;
          }
          const reArmSvc = issueRecoveryActionService(db);
          await reArmSvc.upsertSourceScoped({
            companyId,
            sourceIssueId: candidate.id,
            kind: "blocked_without_blockers",
            ownerType: "board",
            previousOwnerAgentId: candidate.assigneeAgentId ?? null,
            cause: "dependency_wake_rearm_cap_exhausted",
            fingerprint: `drearm:${companyId}:${candidate.id}`,
            evidence: {
              identifier: candidate.identifier,
              reArmCount: consumedWakes,
              reArmMax: maxCount,
            },
            nextAction:
              "This issue has been woken multiple times after its blockers resolved. Review and take action.",
            wakePolicy: null,
            monitorPolicy: null,
            maxAttempts: null,
            lastAttemptAt: new Date(),
          });
          result.reArmCapEscalated++;
          result.reArmCapEscalatedIssueIds.push(candidate.id);
          continue;
        }

        if (
          await hasActiveExecutionPath(companyId, candidate.id, agentId) ||
          await hasQueuedIssueWake(companyId, candidate.id, agentId)
        ) {
          result.livePathSkipped += 1;
          continue;
        }

        if (await hasPendingWakeInteraction(companyId, candidate.id)) {
          result.interactionSkipped += 1;
          continue;
        }

        if (await isAutomaticRecoverySuppressedByPauseHold(db, companyId, candidate.id, treeControlSvc)) {
          result.pauseHoldSkipped += 1;
          continue;
        }

        const rearmWindowMs = opts?.rearmWindowMs;
        const rearmMaxCount = opts?.rearmMaxCount;
        if (rearmWindowMs && rearmMaxCount) {
          const since = new Date(reArmCapNow.getTime() - rearmWindowMs);
          const wakeCount = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, companyId),
                eq(agentWakeupRequests.reason, ISSUE_BLOCKERS_RESOLVED_WAKE_REASON),
                sql`${agentWakeupRequests.payload} ->> 'issueId' = ${candidate.id}`,
                gte(agentWakeupRequests.requestedAt, since),
              ),
            )
            .then((rows) => rows[0]?.count ?? 0);
          if (wakeCount >= rearmMaxCount) {
            result.reArmCapSkipped += 1;
            logger.warn(
              {
                issueId: candidate.id,
                identifier: candidate.identifier,
                wakeCount,
                rearmMaxCount,
                rearmWindowMs,
              },
              "resolved dependency wake re-arm cap reached — dependent stuck, needs escalation",
            );
            if (shouldLogReArmCap) {
              await logActivity(db, {
                companyId,
                actorType: "system",
                actorId: "system",
                agentId: null,
                runId: null,
                action: "issue.dependency_wake_rearm_cap_reached",
                entityType: "issue",
                entityId: candidate.id,
                details: {
                  source,
                  identifier: candidate.identifier,
                  idempotencyKeys,
                  consumedCount: wakeCount,
                  maxCount: rearmMaxCount,
                  blockerIssueIds: readiness?.blockerIssueIds ?? [],
                },
              });
            }
            continue;
          }
        }

        try {
          const wake = await deps.enqueueWakeup(agentId, {
            source: "automation",
            triggerDetail: "system",
            reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
            payload: {
              issueId: candidate.id,
              resolvedBlockerIssueId,
              blockerIssueIds: readiness?.blockerIssueIds ?? [],
              backstop: payloadBackstop,
              ...(zeroBlockerHeal ? { zeroBlockerHeal: true } : {}),
            },
            idempotencyKey,
            requestedByActorType: "system",
            requestedByActorId,
            contextSnapshot: {
              issueId: candidate.id,
              taskId: candidate.id,
              wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
              source,
              resolvedBlockerIssueId,
              blockerIssueIds: readiness?.blockerIssueIds ?? [],
              ...(zeroBlockerHeal ? { zeroBlockerHeal: true } : {}),
            },
          });
          if (!wake) {
            // enqueueWakeup returns null for normal deferred/skipped paths
            // such as disabled wake-on-demand or concurrency gating. That is
            // not an enqueue error, but the backstop still did not heal now.
            result.deferredOrFailed += 1;
            continue;
          }

          result.healed += 1;
          if (zeroBlockerHeal) result.zeroBlockerHealed += 1;
          result.issueIds.push(candidate.id);

          await logActivity(db, {
            companyId,
            actorType: "system",
            actorId: "issue_graph_liveness_backstop",
            agentId,
            runId: opts?.runId ?? null,
            action: "issue.blockers_resolved_wake_emitted",
            entityType: "issue",
            entityId: candidate.id,
            details: {
              source,
              wakeupRunId: wake.id,
              idempotencyKey,
              resolvedBlockerIssueId,
              blockerIssueIds: readiness?.blockerIssueIds ?? [],
              ...(zeroBlockerHeal ? { zeroBlockerHeal: true } : {}),
            },
          });
        } catch (err) {
          result.deferredOrFailed += 1;
          result.enqueueFailed += 1;
          logger.warn(
            { err, issueId: candidate.id, agentId, idempotencyKey, source },
            "failed to enqueue dependency wake from issue graph liveness backstop",
          );
        }
      }
    }

    if (result.healed > 0) {
      logger.warn(
        { healed: result.healed, issueIds: result.issueIds, source, blockerIssueId: opts?.blockerIssueId ?? null },
        "issue graph liveness backstop healed resolved blocked dependency wakes",
      );
    }

    if (result.zeroBlockerObserved > 0) {
      logger.warn(
        {
          observed: result.zeroBlockerObserved,
          healed: result.zeroBlockerHealed,
          activeRecoverySkipped: result.zeroBlockerActiveRecoverySkipped,
          source,
        },
        "issue graph liveness backstop swept zero-blocker blocked issues",
      );
    }

    if (result.reArmCapSkipped > 0 && shouldLogReArmCap) {
      lastDependencyWakeReArmCapActivityLogAt = reArmCapNow;
    }

    return result;
  }

  async function reconcilePendingReviewRearm(opts?: {
    runId?: string | null;
    companyId?: string | null;
    now?: Date;
    rearmWindowMs?: number;
    rearmMaxCount?: number;
  }) {
    const result = {
      checked: 0,
      reArmed: 0,
      dependencyBlockedSkipped: 0,
      livePathSkipped: 0,
      queuedWakeSkipped: 0,
      interactionSkipped: 0,
      pauseHoldSkipped: 0,
      notReadySkipped: 0,
      candidateLimitSkipped: 0,
      reArmCapSkipped: 0,
      reArmCapExhausted: 0,
      reArmCapExhaustedIssueIds: [] as string[],
      deferredOrFailed: 0,
      enqueueFailed: 0,
      issueIds: [] as string[],
    };

    const source = "issue_graph_liveness.pending_review_rearm";
    const requestedByActorId = "issue_graph_liveness_pending_review_rearm";
    const config = loadConfig();
    const windowMs = opts?.rearmWindowMs ?? config.pendingReviewRearmWindowMs;
    const maxCount = opts?.rearmMaxCount ?? config.pendingReviewRearmMaxCount;
    const now = opts?.now ?? new Date();
    const cutoff = new Date(now.getTime() - windowMs);
    const recoveryActionsSvc = issueRecoveryActionService(db);

    const filters = [
      eq(issues.status, "in_review"),
      visibleIssueCondition(),
      sql`${issues.executionState}->>'status' = 'pending'`,
      sql`${issues.executionState}->>'currentStageType' = 'review'`,
      sql`NOT EXISTS (
        SELECT 1
        FROM ${issueExecutionDecisions}
        WHERE ${issueExecutionDecisions.issueId} = ${issues.id}
          AND ${issueExecutionDecisions.stageId}::text = ${issues.executionState}->>'currentStageId'
      )`,
      sql`${issues.executionState}->'currentParticipant'->>'type' = 'agent'`,
      sql`${issues.executionState}->'currentParticipant'->>'agentId' is not null`,
      lt(issues.updatedAt, cutoff),
    ];
    if (opts?.companyId) filters.push(eq(issues.companyId, opts.companyId));

    const rows = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        executionState: issues.executionState,
        updatedAt: issues.updatedAt,
        totalCount: sql<number>`count(*) over()::int`,
      })
      .from(issues)
      .where(and(...filters))
      .orderBy(asc(issues.id))
      .limit(PENDING_REVIEW_REARM_CANDIDATE_LIMIT);

    result.checked = rows.length;
    result.candidateLimitSkipped = Math.max(0, (rows[0]?.totalCount ?? 0) - rows.length);

    const candidates = rows.map(({ totalCount: _totalCount, ...candidate }) => candidate);
    const candidatesByCompany = new Map<string, typeof candidates>();

    for (const candidate of candidates) {
      const companyCandidates = candidatesByCompany.get(candidate.companyId) ?? [];
      companyCandidates.push(candidate);
      candidatesByCompany.set(candidate.companyId, companyCandidates);
    }

    for (const [companyId, companyCandidates] of candidatesByCompany.entries()) {
      const readinessMap = await issuesSvc.listDependencyReadiness(
        companyId,
        companyCandidates.map((candidate) => candidate.id),
      );

      for (const candidate of companyCandidates) {
        const readiness = readinessMap.get(candidate.id);
        if (!readiness?.isDependencyReady) {
          result.dependencyBlockedSkipped += 1;
          continue;
        }

        const state = parseIssueExecutionState(candidate.executionState);
        const participant = state?.currentParticipant;
        if (participant?.type !== "agent" || !participant.agentId) {
          result.notReadySkipped += 1;
          continue;
        }
        const agentId = participant.agentId;

        if (await hasActiveExecutionPath(companyId, candidate.id, agentId)) {
          result.livePathSkipped += 1;
          continue;
        }

        if (await hasQueuedIssueWake(companyId, candidate.id, agentId)) {
          result.queuedWakeSkipped += 1;
          continue;
        }

        if (await hasPendingWakeInteraction(companyId, candidate.id)) {
          result.interactionSkipped += 1;
          continue;
        }

        if (await isAutomaticRecoverySuppressedByPauseHold(db, companyId, candidate.id, treeControlSvc)) {
          result.pauseHoldSkipped += 1;
          continue;
        }

        const consumedCount = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, companyId),
              eq(agentWakeupRequests.agentId, agentId),
              eq(agentWakeupRequests.reason, PENDING_REVIEW_REARM_REASON),
              sql`${agentWakeupRequests.payload} ->> 'rearm' = 'true'`,
              sql`${agentWakeupRequests.payload} ->> 'issueId' = ${candidate.id}`,
              gte(agentWakeupRequests.requestedAt, cutoff),
              inArray(agentWakeupRequests.status, ["completed", "failed", "timed_out"]),
            ),
          )
          .then((rows) => rows[0]?.count ?? 0);

        if (consumedCount >= maxCount) {
          result.reArmCapSkipped += 1;
          if (!(await hasActiveOrEscalatedRecoveryAction(companyId, candidate.id))) {
            await recoveryActionsSvc.upsertSourceScoped({
              companyId,
              sourceIssueId: candidate.id,
              kind: "pending_review_rearm_cap_exhausted",
              ownerType: "board",
              previousOwnerAgentId: agentId,
              cause: "pending_review_rearm_cap_exhausted",
              fingerprint: `prr:${companyId}:${candidate.id}`,
              evidence: {
                identifier: candidate.identifier,
                reArmCount: consumedCount,
                reArmMax: maxCount,
                reArmWindowMs: windowMs,
              },
              nextAction:
                "This issue's pending review was re-armed repeatedly without a decision. Review and take action.",
              wakePolicy: null,
              monitorPolicy: null,
              maxAttempts: null,
              lastAttemptAt: now,
            });
            result.reArmCapExhausted += 1;
            result.reArmCapExhaustedIssueIds.push(candidate.id);
          }
          continue;
        }

        const executionStage = buildExecutionStageWakeContextFromState(state);
        if (!executionStage) {
          result.notReadySkipped += 1;
          continue;
        }

        try {
          const wake = await deps.enqueueWakeup(agentId, {
            source: "automation",
            triggerDetail: "system",
            reason: PENDING_REVIEW_REARM_REASON,
            payload: {
              issueId: candidate.id,
              mutation: "update",
              executionStage,
              rearm: true,
            },
            requestedByActorType: "system",
            requestedByActorId,
            contextSnapshot: {
              issueId: candidate.id,
              taskId: candidate.id,
              wakeReason: PENDING_REVIEW_REARM_REASON,
              source,
              executionStage,
              rearm: true,
            },
          });
          if (!wake) {
            result.deferredOrFailed += 1;
            continue;
          }

          result.reArmed += 1;
          result.issueIds.push(candidate.id);

          await logActivity(db, {
            companyId,
            actorType: "system",
            actorId: requestedByActorId,
            agentId,
            runId: opts?.runId ?? null,
            action: "issue.pending_review_rearm_wake_emitted",
            entityType: "issue",
            entityId: candidate.id,
            details: {
              source,
              wakeupRunId: wake.id,
              reArmCount: consumedCount + 1,
              reArmMax: maxCount,
            },
          });
        } catch (err) {
          result.deferredOrFailed += 1;
          result.enqueueFailed += 1;
          logger.warn(
            { err, issueId: candidate.id, agentId, source },
            "failed to enqueue pending review re-arm wake",
          );
        }
      }
    }

    if (result.reArmed > 0) {
      logger.warn(
        { reArmed: result.reArmed, issueIds: result.issueIds, source },
        "pending review re-arm sweep re-surfaced undecided review stages",
      );
    }

    return result;

    function buildExecutionStageWakeContextFromState(state: ReturnType<typeof parseIssueExecutionState>): Record<string, unknown> | null {
      if (!state) return null;
      const participant = state.currentParticipant;
      if (!participant) return null;
      return {
        wakeRole: state.currentStageType === "approval" ? "approver" : "reviewer",
        stageId: state.currentStageId,
        stageType: state.currentStageType,
        currentParticipant: participant,
        returnAssignee: state.returnAssignee,
        reviewRequest: state.reviewRequest,
        lastDecisionOutcome: state.lastDecisionOutcome,
        allowedActions: ["approve", "request_changes"],
      };
    }
  }

  async function reconcileIssueGraphLiveness(opts?: {
    runId?: string | null;
    force?: boolean;
    lookbackHours?: number;
    issueCreatedAtGte?: Date | null;
    now?: Date;
    reescalationCooldownMs?: number;
  }) {
    let findings = await collectIssueGraphLivenessFindings();
    if (opts?.issueCreatedAtGte) {
      const findingIssueIds = [...new Set(findings.map((finding) => finding.recoveryIssueId))];
      const eligibleIssueIds = new Set(
        findingIssueIds.length === 0
          ? []
          : (await db
              .select({ id: issues.id })
              .from(issues)
              .where(and(
                inArray(issues.id, findingIssueIds),
                gte(issues.createdAt, opts.issueCreatedAtGte),
              )))
              .map((issue) => issue.id),
      );
      findings = findings.filter((finding) => eligibleIssueIds.has(finding.recoveryIssueId));
    }
    const experimentalSettings = await instanceSettings.getExperimental();
    const autoRecoveryEnabled = asBoolean(
      experimentalSettings.enableIssueGraphLivenessAutoRecovery,
      true,
    ) || opts?.force === true;
    const lookbackHours = normalizeIssueGraphLivenessAutoRecoveryLookbackHours(
      opts?.lookbackHours ?? experimentalSettings.issueGraphLivenessAutoRecoveryLookbackHours,
    );
    const now = opts?.now ?? new Date();
    const reescalationCooldownMs = Math.max(
      0,
      Math.floor(asNumber(opts?.reescalationCooldownMs, DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS)),
    );
    const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
    const obsoleteRecoveryCleanup = await retireObsoleteLivenessRecoveryIssues(findings);
    const doneRecoveryBlockerCleanup = await retireDoneLivenessRecoveryBlockers();
    const updatedAtByIssueKey = await loadLivenessDependencyUpdatedAtByIssue(findings);
    const result = {
      findings: findings.length,
      autoRecoveryEnabled,
      lookbackHours,
      cutoff: cutoff.toISOString(),
      escalationsCreated: 0,
      existingEscalations: 0,
      skipped: 0,
      skippedAutoRecoveryDisabled: 0,
      skippedOutsideLookback: 0,
      skippedReescalationCooldown: 0,
      obsoleteRecoveriesRetired: obsoleteRecoveryCleanup.retired,
      obsoleteRecoveriesActiveSkipped: obsoleteRecoveryCleanup.activeSkipped,
      obsoleteRecoveryBlockerRelationsRemoved: obsoleteRecoveryCleanup.blockerRelationsRemoved,
      doneRecoveryBlockerRelationsRemoved: doneRecoveryBlockerCleanup.blockerRelationsRemoved,
      dependencyWakeBackstopChecked: 0,
      dependencyWakesHealed: 0,
      dependencyWakeExistingSkipped: 0,
      dependencyWakeLivePathSkipped: 0,
      dependencyWakeInteractionSkipped: 0,
      dependencyWakePauseHoldSkipped: 0,
      dependencyWakeNotReadySkipped: 0,
      dependencyWakeCandidateLimitSkipped: 0,
      dependencyWakeDeferredOrFailed: 0,
      dependencyWakeEnqueueFailed: 0,
      dependencyWakeZeroBlockerObserved: 0,
      dependencyWakeZeroBlockerHealed: 0,
      dependencyWakeZeroBlockerActiveRecoverySkipped: 0,
      dependencyWakeReArmCapEscalated: 0,
      dependencyWakeReArmCapEscalatedIssueIds: [] as string[],
      dependencyWakeIssueIds: [] as string[],
      blockedWithoutBlockersChecked: 0,
      blockedWithoutBlockersHealed: 0,
      blockedWithoutBlockersEscalated: 0,
      blockedWithoutBlockersLivePathSkipped: 0,
      blockedWithoutBlockersQueuedWakeSkipped: 0,
      blockedWithoutBlockersInteractionSkipped: 0,
      blockedWithoutBlockersPauseHoldSkipped: 0,
      blockedWithoutBlockersGraceThresholdSkipped: 0,
      blockedWithoutBlockersAlreadyActionedSkipped: 0,
      blockedWithoutBlockersCandidateLimitSkipped: 0,
      blockedWithoutBlockersDeadWorkspaceBindingSkipped: 0,
      blockedWithoutBlockersRearmCapExhaustedSkipped: 0,
      blockedWithoutBlockersDeadBindingsCleared: 0,
      blockedWithoutBlockersIssueIds: [] as string[],
      issueIds: [] as string[],
      escalationIssueIds: [] as string[],
      retiredRecoveryIssueIds: obsoleteRecoveryCleanup.retiredIssueIds,
    };

    const dependencyWakeBackstop = await reconcileResolvedDependencyWakeBackstop({
      runId: opts?.runId ?? null,
    });
    result.dependencyWakeBackstopChecked = dependencyWakeBackstop.checked;
    result.dependencyWakesHealed = dependencyWakeBackstop.healed;
    result.dependencyWakeExistingSkipped = dependencyWakeBackstop.existingWakeSkipped;
    result.dependencyWakeLivePathSkipped = dependencyWakeBackstop.livePathSkipped;
    result.dependencyWakeInteractionSkipped = dependencyWakeBackstop.interactionSkipped;
    result.dependencyWakePauseHoldSkipped = dependencyWakeBackstop.pauseHoldSkipped;
    result.dependencyWakeNotReadySkipped = dependencyWakeBackstop.notReadySkipped;
    result.dependencyWakeCandidateLimitSkipped = dependencyWakeBackstop.candidateLimitSkipped;
    result.dependencyWakeDeferredOrFailed = dependencyWakeBackstop.deferredOrFailed;
    result.dependencyWakeEnqueueFailed = dependencyWakeBackstop.enqueueFailed;
    result.dependencyWakeZeroBlockerObserved = dependencyWakeBackstop.zeroBlockerObserved;
    result.dependencyWakeZeroBlockerHealed = dependencyWakeBackstop.zeroBlockerHealed;
    result.dependencyWakeZeroBlockerActiveRecoverySkipped = dependencyWakeBackstop.zeroBlockerActiveRecoverySkipped;
    result.dependencyWakeReArmCapEscalated = dependencyWakeBackstop.reArmCapEscalated;
    result.dependencyWakeReArmCapEscalatedIssueIds = dependencyWakeBackstop.reArmCapEscalatedIssueIds;
    result.dependencyWakeIssueIds = dependencyWakeBackstop.issueIds;

    const blockedWithoutBlockers = await reconcileBlockedWithoutBlockers({
      runId: opts?.runId ?? null,
    });
    result.blockedWithoutBlockersChecked = blockedWithoutBlockers.checked;
    result.blockedWithoutBlockersHealed = blockedWithoutBlockers.healed;
    result.blockedWithoutBlockersEscalated = blockedWithoutBlockers.escalated;
    result.blockedWithoutBlockersLivePathSkipped = blockedWithoutBlockers.livePathSkipped;
    result.blockedWithoutBlockersQueuedWakeSkipped = blockedWithoutBlockers.queuedWakeSkipped;
    result.blockedWithoutBlockersInteractionSkipped = blockedWithoutBlockers.interactionSkipped;
    result.blockedWithoutBlockersPauseHoldSkipped = blockedWithoutBlockers.pauseHoldSkipped;
    result.blockedWithoutBlockersGraceThresholdSkipped = blockedWithoutBlockers.graceThresholdSkipped;
    result.blockedWithoutBlockersAlreadyActionedSkipped = blockedWithoutBlockers.alreadyActionedSkipped;
    result.blockedWithoutBlockersCandidateLimitSkipped = blockedWithoutBlockers.candidateLimitSkipped;
    result.blockedWithoutBlockersDeadWorkspaceBindingSkipped = blockedWithoutBlockers.deadWorkspaceBindingSkipped;
    result.blockedWithoutBlockersRearmCapExhaustedSkipped = blockedWithoutBlockers.rearmCapExhaustedSkipped;
    result.blockedWithoutBlockersDeadBindingsCleared = blockedWithoutBlockers.deadBindingsCleared;
    result.blockedWithoutBlockersIssueIds = blockedWithoutBlockers.issueIds;

    if (!autoRecoveryEnabled) {
      result.skippedAutoRecoveryDisabled = findings.length;
      return result;
    }

    for (const finding of findings) {
      if (!isLivenessFindingInsideAutoRecoveryLookback(finding, cutoff, updatedAtByIssueKey)) {
        result.skippedOutsideLookback += 1;
        result.skipped += 1;
        continue;
      }
      const escalation = await createIssueGraphLivenessEscalation({
        finding,
        runId: opts?.runId ?? null,
        now,
        reescalationCooldownMs,
      });
      if (escalation.kind === "created") {
        result.escalationsCreated += 1;
        result.issueIds.push(finding.issueId);
        result.escalationIssueIds.push(escalation.escalationIssueId);
      } else if (escalation.kind === "existing") {
        result.existingEscalations += 1;
        result.issueIds.push(finding.issueId);
        result.escalationIssueIds.push(escalation.escalationIssueId);
      } else if (escalation.kind === "cooldown") {
        result.skippedReescalationCooldown += 1;
        result.skipped += 1;
      } else {
        result.skipped += 1;
      }
    }

    return result;
  }

  function readRecoveryTimerIntervalMs(raw: unknown, fallback: number) {
    return Math.max(1, Math.floor(asNumber(raw, fallback)));
  }

  // Backstop reconciler: terminalizes a "running" run that can no longer reach a
  // terminal status on its own. The run finalizer writes the terminal status in
  // a step that is separate from the agent status=done PATCH. When the teardown
  // stops between the two steps, heartbeat_runs.status stays "running" forever.
  // The UI reads liveness from that row, so the task shows "Live" forever. This
  // function forces the run to a terminal status and records a run event, so the
  // state is auditable. It never overwrites a status that another path already
  // made terminal.
  //
  // Two independent authorities terminalize the run. Either one is enough:
  //
  // - Issue-terminal authority: the run's issue already reached a terminal
  //   status (done or cancelled), but the run row is still "running". A healthy
  //   run always terminalizes its own row before or just after the issue reaches
  //   a terminal status, so a lasting "running" row under a terminal issue is
  //   orphaned. This authority does not depend on process death. It is the only
  //   authority that catches the reuse-lease path: the release stops the sandbox
  //   but keeps the server process alive, so the in-memory handle and the
  //   recorded pid can both persist.
  // - Process-death authority: the run has no in-memory handle and its recorded
  //   process and process group are both gone. This catches a hard server crash
  //   that skipped the graceful teardown, even when the issue is not terminal.
  async function terminalizeOrphanedRunningRun(
    run: typeof heartbeatRuns.$inferSelect,
    options?: {
      // The terminal run status implied by a referencing issue. The caller
      // passes it when it already knows the issue that holds the run in a lock
      // column. It maps issue "done" to "succeeded" and issue "cancelled" to
      // "cancelled". A null value means the referencing issue is not terminal.
      referencingIssueTerminalStatus?: "succeeded" | "cancelled" | null;
      // True when an active (non-terminal) issue still holds this run in a lock
      // column. The run is live for that active issue, so the caller forbids the
      // issue-terminal authority. This flag also suppresses the context-snapshot
      // fallback below. Without it, a terminal issue named in the run context
      // snapshot would still terminalize the shared run and defeat the guard.
      runReferencedByActiveIssue?: boolean;
    },
  ): Promise<{ terminalized: boolean; status: string }> {
    // Act only on a run in "running" status. A "queued" run has no process yet,
    // and a "scheduled_retry" run has no process on purpose because it waits to
    // retry. Neither is orphaned, so this function must not terminalize them.
    if (run.status !== "running") return { terminalized: false, status: run.status };

    const pid = run.processPid ?? null;
    const processGroupId = run.processGroupId ?? null;

    // Issue-terminal authority. When the run's issue is terminal, the run row is
    // orphaned regardless of process or handle state. Prefer the referencing
    // issue status that the caller passed, because a lock column is the direct
    // link from the stuck "Live" issue to this run. Fall back to the issue id in
    // the run context snapshot when the caller passed nothing. Skip the fallback
    // when an active issue still references the run. The run is live for that
    // active issue, so a terminal issue named in the context snapshot must not
    // terminalize it.
    let issueTerminalStatus: "succeeded" | "cancelled" | null =
      options?.referencingIssueTerminalStatus ?? null;
    const issueId = issueIdFromRunContext(run.contextSnapshot);
    if (!issueTerminalStatus && !options?.runReferencedByActiveIssue && issueId) {
      const issueStatus = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]?.status ?? null);
      if (issueStatus === "done") issueTerminalStatus = "succeeded";
      else if (issueStatus === "cancelled") issueTerminalStatus = "cancelled";
    }

    // Process-death authority. The run is live only when a process still backs
    // it. Check the in-memory handle first, then the recorded pid and process
    // group. Require recorded process metadata, so this authority never fires on
    // a run that has not yet stored its pid.
    let processGone = false;
    if (!runningProcesses.get(run.id)) {
      if (typeof pid === "number" || typeof processGroupId === "number") {
        const processAlive =
          (typeof pid === "number" && isPidAlive(pid)) ||
          (typeof processGroupId === "number" && isProcessGroupAlive(processGroupId));
        processGone = !processAlive;
      }
    }

    // Neither authority applies. The run is still live, so leave it alone.
    if (!issueTerminalStatus && !processGone) {
      return { terminalized: false, status: run.status };
    }

    const authority = issueTerminalStatus ? "issue_terminal" : "process_gone";
    const terminalStatus = issueTerminalStatus ?? "interrupted";
    const errorCode = issueTerminalStatus
      ? "orphaned_running_run_issue_terminal"
      : "orphaned_running_run";
    const message =
      authority === "issue_terminal"
        ? "run terminalized by recovery backstop: issue reached a terminal status while heartbeat_runs.status stayed live"
        : "run terminalized by recovery backstop: process and sandbox gone while heartbeat_runs.status stayed live";

    const now = new Date();
    const updated = await db
      .update(heartbeatRuns)
      .set({
        status: terminalStatus,
        finishedAt: run.finishedAt ?? now,
        error: run.error ?? (terminalStatus === "interrupted" ? message : null),
        errorCode: run.errorCode ?? (terminalStatus === "interrupted" ? errorCode : null),
        updatedAt: now,
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "running")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) {
      // Another path finalized the run between the read and this write. Keep
      // that terminal outcome authoritative.
      const [current] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.id));
      return { terminalized: false, status: current?.status ?? run.status };
    }

    runningProcesses.delete(run.id);
    // The run update above already committed the terminal status. The audit
    // event is best-effort: if the insert fails, the caller must still treat
    // the run as terminalized and clear the lock in the same sweep. So catch
    // the failure, log it, and continue. A thrown error here would abort the
    // sweep and leave the stale lock in place.
    try {
      await appendRecoveryRunEvent(updated, {
        level: "warn",
        message,
        payload: {
          source: "recovery.sweep_stale_issue_locks",
          authority,
          previousStatus: run.status,
          terminalStatus,
          ...(issueId ? { issueId } : {}),
          pid,
          processGroupId,
        },
      });
    } catch (error) {
      logger.error(
        { err: error, runId: run.id, previousStatus: run.status },
        "failed to append recovery run event after terminalizing orphaned run; run stays terminal and the sweep clears the lock",
      );
    }
    logger.warn(
      { runId: run.id, authority, previousStatus: run.status, terminalStatus, issueId, pid, processGroupId },
      "terminalized orphaned running heartbeat run in stale-lock sweep",
    );
    return { terminalized: true, status: updated.status };
  }

  // Backstop sweeper: clears stale lock columns on issues whose checkoutRunId
  // or executionRunId points at a heartbeat_runs row that is either missing or
  // in a terminal status. Provides self-heal for stale locks that fell outside
  // releaseIssueExecutionAndPromote / clearCheckoutRunIfTerminal / adoption.
  // Before it evaluates cleanability, it terminalizes any referenced run that
  // still claims to be live but can no longer reach a terminal status on its
  // own, so a stuck "running" run can no longer block the sweep. Idempotent and
  // safe: clears at most one row's worth of lock columns per candidate.
  async function sweepStaleIssueLocks() {
    const result = {
      cleared: 0,
      issueIds: [] as string[],
      terminalizedRunIds: [] as string[],
    };

    const candidates = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(
        sql`(${issues.checkoutRunId} is not null or ${issues.executionRunId} is not null)`,
      );

    const referencedRunIds = [
      ...new Set(
        candidates
          .flatMap((issue) => [issue.checkoutRunId, issue.executionRunId])
          .filter((id): id is string => !!id),
      ),
    ];
    const runRows =
      referencedRunIds.length > 0
        ? await db
            .select()
            .from(heartbeatRuns)
            .where(inArray(heartbeatRuns.id, referencedRunIds))
        : [];
    const runStatusById = new Map<string, string>();
    for (const row of runRows) runStatusById.set(row.id, row.status);

    // Collect the runs that a non-terminal issue still references. Such a run is
    // the live run of an active issue. A different, terminal issue can also hold
    // the same run id in a stale lock column. The terminal reference alone must
    // not terminalize a run that an active issue still owns, so exclude these
    // runs from the issue-terminal authority below.
    const runIdsReferencedByActiveIssue = new Set<string>();
    for (const issue of candidates) {
      if (issue.status === "done" || issue.status === "cancelled") continue;
      for (const runId of [issue.checkoutRunId, issue.executionRunId]) {
        if (runId) runIdsReferencedByActiveIssue.add(runId);
      }
    }

    // Map each referenced run to the terminal run status implied by its
    // referencing issue. When a terminal issue still holds the run in a lock
    // column, that run is orphaned: the issue is the stuck "Live" task the UI
    // shows. A "done" issue implies "succeeded"; a "cancelled" issue implies
    // "cancelled". Skip a run that an active issue also references, because that
    // run is still live for the active issue.
    const issueTerminalStatusByRunId = new Map<string, "succeeded" | "cancelled">();
    for (const issue of candidates) {
      const implied =
        issue.status === "done"
          ? "succeeded"
          : issue.status === "cancelled"
            ? "cancelled"
            : null;
      if (!implied) continue;
      for (const runId of [issue.checkoutRunId, issue.executionRunId]) {
        if (runId && !runIdsReferencedByActiveIssue.has(runId)) {
          issueTerminalStatusByRunId.set(runId, implied);
        }
      }
    }

    // Pre-pass: terminalize any referenced run that still claims to be live but
    // can no longer reach a terminal status on its own. This lets the sweep
    // clear the lock in the same pass instead of waiting for the run to reach a
    // terminal status by another route.
    for (const row of runRows) {
      const outcome = await terminalizeOrphanedRunningRun(row, {
        referencingIssueTerminalStatus: issueTerminalStatusByRunId.get(row.id) ?? null,
        runReferencedByActiveIssue: runIdsReferencedByActiveIssue.has(row.id),
      });
      runStatusById.set(row.id, outcome.status);
      if (outcome.terminalized) result.terminalizedRunIds.push(row.id);
    }

    const isCleanable = (runId: string | null) => {
      if (!runId) return true;
      const status = runStatusById.get(runId);
      if (!status) return true; // missing run row → no real claim
      return TERMINAL_HEARTBEAT_RUN_STATUSES.has(status);
    };

    for (const issue of candidates) {
      if (!isCleanable(issue.checkoutRunId) || !isCleanable(issue.executionRunId)) {
        continue;
      }

      const updated = await db
        .update(issues)
        .set({
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(issues.id, issue.id),
            issue.checkoutRunId
              ? eq(issues.checkoutRunId, issue.checkoutRunId)
              : isNull(issues.checkoutRunId),
            issue.executionRunId
              ? eq(issues.executionRunId, issue.executionRunId)
              : isNull(issues.executionRunId),
          ),
        )
        .returning({ id: issues.id })
        .then((rows) => rows[0] ?? null);

      if (!updated) continue;

      result.cleared += 1;
      result.issueIds.push(updated.id);

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.stale_lock_cleared",
        entityType: "issue",
        entityId: updated.id,
        details: {
          source: "recovery.sweep_stale_issue_locks",
          clearedCheckoutRunId: issue.checkoutRunId,
          clearedExecutionRunId: issue.executionRunId,
          referencedRunStatuses: Object.fromEntries(runStatusById),
        },
      });
    }

    if (result.cleared > 0 || result.terminalizedRunIds.length > 0) {
      logger.warn(
        {
          cleared: result.cleared,
          issueIds: result.issueIds,
          terminalizedRunIds: result.terminalizedRunIds,
        },
        "swept stale issue lock columns",
      );
    }

    return result;
  }

  // SUP-14151: the sweep ceiling is the same default the upsert clamp holds a
  // minted action to, so the two can never disagree about what "exhausted" is.
  const MAX_RECOVERY_ACTION_SWEEP_ATTEMPTS = DEFAULT_RECOVERY_ACTION_MAX_ATTEMPTS;

  async function reconcileBlockedWithoutBlockers(opts?: {
    runId?: string | null;
    companyId?: string | null;
    now?: Date;
  }) {
    const result = {
      checked: 0,
      escalated: 0,
      healed: 0,
      livePathSkipped: 0,
      queuedWakeSkipped: 0,
      interactionSkipped: 0,
      pauseHoldSkipped: 0,
      graceThresholdSkipped: 0,
      alreadyActionedSkipped: 0,
      candidateLimitSkipped: 0,
      deadWorkspaceBindingSkipped: 0,
      rearmCapExhaustedSkipped: 0,
      exhaustedRecoverySuppressed: 0,
      deadBindingsCleared: 0,
      issueIds: [] as string[],
    };

    const recoveryActionsSvc = issueRecoveryActionService(db);
    const source = "issue_graph_liveness.blocked_without_blockers";
    const now = opts?.now ?? new Date();

    const filters = [
      eq(issues.status, "blocked"),
      visibleIssueCondition(),
    ];
    if (opts?.companyId) filters.push(eq(issues.companyId, opts.companyId));

    const rows = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        assigneeAgentId: issues.assigneeAgentId,
        updatedAt: issues.updatedAt,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        totalCount: sql<number>`count(*) over()::int`,
      })
      .from(issues)
      .where(and(...filters))
      .orderBy(asc(issues.id))
      .limit(BLOCKED_WITHOUT_BLOCKERS_CANDIDATE_LIMIT);

    result.checked = rows.length;
    result.candidateLimitSkipped = Math.max(0, (rows[0]?.totalCount ?? 0) - rows.length);

    const candidates = rows.map(({ totalCount: _totalCount, ...candidate }) => candidate);
    const candidatesByCompany = new Map<string, typeof candidates>();

    for (const candidate of candidates) {
      const companyCandidates = candidatesByCompany.get(candidate.companyId) ?? [];
      companyCandidates.push(candidate);
      candidatesByCompany.set(candidate.companyId, companyCandidates);
    }

    const general = await instanceSettings.getGeneral();

    for (const [companyId, companyCandidates] of candidatesByCompany.entries()) {
      const readinessMap = await issuesSvc.listDependencyReadiness(
        companyId,
        companyCandidates.map((candidate) => candidate.id),
      );

      for (const candidate of companyCandidates) {
        const readiness = readinessMap.get(candidate.id);
        if (!readiness || readiness.unresolvedBlockerCount !== 0) continue;

        const blockedAt = candidate.updatedAt ?? new Date();
        const msInViolation = now.getTime() - blockedAt.getTime();
        if (msInViolation < BLOCKED_WITHOUT_BLOCKERS_GRACE_THRESHOLD_MS) {
          result.graceThresholdSkipped++;
          continue;
        }

        if (await hasActiveExecutionPath(companyId, candidate.id, null, candidate.monitorNextCheckAt)) {
          result.livePathSkipped++;
          continue;
        }

        if (await hasQueuedIssueWake(companyId, candidate.id, candidate.assigneeAgentId)) {
          result.queuedWakeSkipped++;
          continue;
        }

        if (await hasPendingWakeInteraction(companyId, candidate.id)) {
          result.interactionSkipped++;
          continue;
        }

        if (await isAutomaticRecoverySuppressedByPauseHold(db, companyId, candidate.id, treeControlSvc)) {
          result.pauseHoldSkipped++;
          continue;
        }

        const existingAction = await recoveryActionsSvc.getActiveForIssue(companyId, candidate.id);

        // SUP-14151 — cross-fingerprint exhaustion suppression: when the
        // issue's single active/escalated recovery row is the terminal
        // `escalated` + `outcome: "exhausted"` state, recovery for the
        // underlying condition has already been handed to the board and is
        // unrepaired until a board resolution clears it. This sweep must not
        // re-dispatch the assignee into the same failure (auto-heal) nor
        // mint/duplicate a second-fingerprint board escalation for it. The
        // skip is recorded so a board triage does not have to reconstruct it
        // from repeated rows. (The upsert's no-resurrection rule already
        // refused the row write; this guard stops the redispatch and the
        // misleading re-escalation count/activity that rode along with it.)
        if (
          existingAction?.status === "escalated" &&
          (existingAction.outcome as string | null) === "exhausted"
        ) {
          result.exhaustedRecoverySuppressed++;

          // SUP-14244 — record the skip once per (issue, recovery-action) pair.
          // Nothing clears an exhausted action without board action, so the
          // candidate stays a candidate and an unconditional row would rewrite
          // the same fact on every sweep pass, forever. The counter above stays
          // per-pass; only the activity write is deduplicated. A replacement
          // suppressor (a different suppressedBy.id) has no prior row for its
          // id, so a genuinely new terminal state is still recorded.
          const alreadyRecorded = await db
            .select({ id: activityLog.id })
            .from(activityLog)
            .where(
              and(
                eq(activityLog.companyId, companyId),
                eq(activityLog.entityType, "issue"),
                eq(activityLog.entityId, candidate.id),
                eq(activityLog.action, "issue.blocked_without_blockers_suppressed"),
                sql`${activityLog.details}->'suppressedBy'->>'id' = ${existingAction.id}`,
              ),
            )
            .limit(1)
            .then((rows) => rows.length > 0);

          if (!alreadyRecorded) {
            await logActivity(db, {
              companyId,
              actorType: "system",
              actorId: "issue_graph_liveness_blocked_without_blockers",
              runId: opts?.runId ?? null,
              action: "issue.blocked_without_blockers_suppressed",
              entityType: "issue",
              entityId: candidate.id,
              details: {
                source,
                fingerprint: `bwob:${companyId}:${candidate.id}`,
                suppressedBy: {
                  id: existingAction.id,
                  kind: existingAction.kind,
                  cause: existingAction.cause,
                  fingerprint: existingAction.fingerprint,
                  outcome: existingAction.outcome,
                  attemptCount: existingAction.attemptCount,
                  maxAttempts: existingAction.maxAttempts,
                },
              },
            });
          }
          continue;
        }

        // Guard 2 — rearm-cap-exhausted: a candidate holding an active
        // `blocked_without_blockers` recovery action whose cause is
        // `dependency_wake_rearm_cap_exhausted` must not be healed. That action
        // represents a legitimately-empty blocker set that has already been
        // escalated; healing it would contend for the same shared workspace,
        // fail, and burn another attempt against reArmMax. The escalation/
        // report-only path is unchanged — only the heal-and-dispatch branch
        // skips these.
        if (
          general.enableBlockedWithoutBlockersAutoHeal &&
          candidate.assigneeAgentId &&
          existingAction?.kind === "blocked_without_blockers" &&
          existingAction?.cause === "dependency_wake_rearm_cap_exhausted"
        ) {
          result.rearmCapExhaustedSkipped++;
          continue;
        }

        // Auto-heal path — setting-gated, default OFF.
        // Evaluated BEFORE the already-actioned guard so an existing action is
        // not terminal. Bounded: if the action has already hit the sweep ceiling,
        // do NOT heal — fall through to the already-actioned guard.
        if (general.enableBlockedWithoutBlockersAutoHeal && candidate.assigneeAgentId) {
          // Guard 1 — dead workspace binding: before healing a candidate that
          // has `executionWorkspacePreference = "reuse_existing"` with a non-null
          // `executionWorkspaceId`, probe the workspace's `cwd` on disk. If the
          // path is gone (ENOENT), clear the binding before healing so the
          // dispatch does not reuse a dead worktree. If the probe cannot be
          // completed (any error other than ENOENT, or no recorded cwd), skip
          // the candidate — the "never self-heal on a stat we could not complete"
          // rule is the overriding invariant.
          if (
            candidate.executionWorkspacePreference === "reuse_existing" &&
            candidate.executionWorkspaceId
          ) {
            const workspaceRow = await db
              .select({ cwd: executionWorkspaces.cwd })
              .from(executionWorkspaces)
              .where(eq(executionWorkspaces.id, candidate.executionWorkspaceId))
              .then((rows) => rows[0] ?? null);

            if (workspaceRow?.cwd) {
              try {
                await access(workspaceRow.cwd, fsConstants.F_OK);
              } catch (err: unknown) {
                const isEnoent =
                  err instanceof Error &&
                  (err as NodeJS.ErrnoException).code === "ENOENT";
                if (isEnoent) {
                  await db
                    .update(issues)
                    .set({
                      executionWorkspaceId: null,
                      executionWorkspacePreference: null,
                      updatedAt: new Date(),
                    })
                    .where(eq(issues.id, candidate.id));
                  result.deadBindingsCleared++;
                  logger.info(
                    {
                      issueId: candidate.id,
                      identifier: candidate.identifier,
                      clearedExecutionWorkspaceId: candidate.executionWorkspaceId,
                      cwd: workspaceRow.cwd,
                    },
                    "cleared dead workspace binding before blocked_without_blockers heal",
                  );
                } else {
                  result.deadWorkspaceBindingSkipped++;
                  continue;
                }
              }
            } else {
              result.deadWorkspaceBindingSkipped++;
              continue;
            }
          }
          const existingActionIsBwob = existingAction?.kind === "blocked_without_blockers";
          const resolvedAction = existingActionIsBwob
            ? null
            : await recoveryActionsSvc.getLatestResolvedForIssue(companyId, candidate.id, "blocked_without_blockers");
          const healAttemptCount =
            (existingActionIsBwob
              ? (existingAction?.evidence?.healAttemptCount as number | undefined)
              : (resolvedAction?.evidence?.healAttemptCount as number | undefined)) ?? 0;
          const isAtCeiling = healAttemptCount >= MAX_RECOVERY_ACTION_SWEEP_ATTEMPTS;
          if (!isAtCeiling) {
            const nextHealAttemptCount = healAttemptCount + 1;
            if (existingAction?.kind === "blocked_without_blockers") {
              await recoveryActionsSvc.resolveActiveForIssue({
                companyId,
                sourceIssueId: candidate.id,
                kind: "blocked_without_blockers",
                status: "resolved",
                outcome: "false_positive",
                resolutionNote: "Auto-healed by blocked_without_blockers sweep.",
                evidence: { ...existingAction.evidence, healAttemptCount: nextHealAttemptCount },
              });
            } else {
              // No active action — persist the heal attempt count on a new action
              // so the ceiling is tracked across heal cycles.
              const resolvedHealAction = await db
                .insert(issueRecoveryActions)
                .values({
                  companyId,
                  sourceIssueId: candidate.id,
                  kind: "blocked_without_blockers",
                  status: "resolved",
                  ownerType: "board",
                  cause: "blocked_without_blockers",
                  fingerprint: `bwob:${companyId}:${candidate.id}`,
                  evidence: {
                    identifier: candidate.identifier,
                    status: "blocked",
                    blockedAt: candidate.updatedAt,
                    msInViolation,
                    healAttemptCount: nextHealAttemptCount,
                  },
                  nextAction: "Auto-healed by blocked_without_blockers sweep.",
                  wakePolicy: null,
                  monitorPolicy: null,
                  attemptCount: 0,
                  outcome: "false_positive",
                  resolutionNote: "Auto-healed by blocked_without_blockers sweep.",
                  resolvedAt: now,
                })
                .returning();
              if (!resolvedHealAction[0]) {
                throw new Error("Failed to persist blocked_without_blockers heal attempt count");
              }
            }
            await issuesSvc.update(candidate.id, { status: "todo" });
            await enqueueInitialAssignedTodoDispatch(
              { id: candidate.id, companyId: candidate.companyId, projectId: null } as typeof issues.$inferSelect,
              candidate.assigneeAgentId,
            );
            result.healed++;
            result.issueIds.push(candidate.id);
            await logActivity(db, {
              companyId,
              actorType: "system",
              actorId: "issue_graph_liveness_blocked_without_blockers",
              runId: opts?.runId ?? null,
              action: "issue.blocked_without_blockers_healed",
              entityType: "issue",
              entityId: candidate.id,
              details: { source, fingerprint: `bwob:${companyId}:${candidate.id}` },
            });
            continue;
          }
        }

        if (existingAction?.kind === "blocked_without_blockers") {
          result.alreadyActionedSkipped++;
          continue;
        }

        const resolvedAction = await recoveryActionsSvc.getLatestResolvedForIssue(
          companyId,
          candidate.id,
          "blocked_without_blockers",
        );
        const healAttemptCount =
          (resolvedAction?.evidence?.healAttemptCount as number | undefined) ?? 0;

        await recoveryActionsSvc.upsertSourceScoped({
          companyId,
          sourceIssueId: candidate.id,
          kind: "blocked_without_blockers",
          ownerType: "board",
          previousOwnerAgentId: candidate.assigneeAgentId ?? null,
          cause: "blocked_without_blockers",
          fingerprint: `bwob:${companyId}:${candidate.id}`,
          evidence: {
            identifier: candidate.identifier,
            status: "blocked",
            blockedAt: candidate.updatedAt,
            msInViolation,
            healAttemptCount,
          },
          nextAction:
            "Review this blocked issue and either (a) add valid blocker relations, (b) unblock it to resume work, or (c) close/cancel it.",
          wakePolicy: { type: "board_escalation" },
          monitorPolicy: null,
          maxAttempts: null,
          lastAttemptAt: now,
        });

        result.escalated++;
        result.issueIds.push(candidate.id);

        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: "issue_graph_liveness_blocked_without_blockers",
          runId: opts?.runId ?? null,
          action: "issue.blocked_without_blockers_escalated",
          entityType: "issue",
          entityId: candidate.id,
          details: {
            source,
            fingerprint: `bwob:${companyId}:${candidate.id}`,
          },
        });
      }
    }

    if (result.escalated > 0) {
      logger.warn(
        { escalated: result.escalated, healed: result.healed, issueIds: result.issueIds, source },
        "blocked-without-blockers escalated to board-owned recovery actions",
      );
    } else if (result.healed > 0) {
      logger.info(
        { healed: result.healed, issueIds: result.issueIds, source },
        "blocked-without-blockers auto-healed and dispatched",
      );
    }

    return result;
  }

  // Ceiling applied to source-scoped recovery actions so the level-triggered
  // backstop below cannot re-fire the same wake forever.
  // MAX_RECOVERY_ACTION_SWEEP_ATTEMPTS is declared above reconcileBlockedWithoutBlockers.
  // Per-action linear backoff: attempt N waits N * intervalMs before the next
  // re-fire, capped so a long-lived action still gets swept periodically.
  const RECOVERY_ACTION_WAKE_BACKOFF_MAX_MULTIPLIER = 6;

  function readRecoveryWakePolicyType(action: typeof issueRecoveryActions.$inferSelect) {
    return readNonEmptyString(parseObject(action.wakePolicy).type);
  }

  // Level-triggered backstop for stranded recovery actions.
  //
  // The owner wake fires exactly once, at action creation
  // (enqueueSourceScopedStrandedRecoveryWake). If that single edge is lost
  // (worker restart mid-enqueue, queue drop, owner deactivated between creation
  // and delivery) the `active` action stays in the table forever and holds its
  // source issue with no further attempts. This sweep looks at the *state* of
  // active actions instead of at events and re-drives any action whose
  // `lastAttemptAt` is older than its backoff window:
  //
  //   - terminal/missing source issues are dropped (nothing left to recover)
  //   - `monitor_only` / `manual_repair_required` policies and non-wakeable
  //     causes are skipped without burning an attempt
  //   - `board_escalation` actions are rerouted to an invokable agent owner when
  //     one can be resolved, instead of waiting on a human forever
  //   - attemptCount/lastAttemptAt are bumped under a compare-and-swap on the
  //     pre-image, so concurrent sweeps cannot double-fire
  //   - at `maxAttempts` the action is escalated to the board with a comment on
  //     the source issue, so exhaustion is visible rather than silent; the
  //     source issue is released (status untouched) rather than parked blocked
  async function reconcileStaleRecoveryActionWakes(opts?: { intervalMs?: number }) {
    const intervalMs = opts?.intervalMs ?? RECOVERY_ACTION_WAKE_INTERVAL_MS;
    const now = new Date();
    const threshold = new Date(now.getTime() - intervalMs);

    const result = {
      checked: 0,
      reFired: 0,
      rerouted: 0,
      maxAttemptsReached: 0,
      nonWakeableSkipped: 0,
      skippedTerminalSource: 0,
      skippedBackoff: 0,
      enqueueFailed: 0,
      issueIds: [] as string[],
      actionIds: [] as string[],
    };

    const candidates = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.status, "active"),
          or(
            isNull(issueRecoveryActions.lastAttemptAt),
            lt(issueRecoveryActions.lastAttemptAt, threshold),
          ),
        ),
      )
      .orderBy(asc(issueRecoveryActions.lastAttemptAt));

    result.checked = candidates.length;
    for (const candidate of candidates) {
      const effectiveMaxAttempts = candidate.maxAttempts ?? MAX_RECOVERY_ACTION_SWEEP_ATTEMPTS;

      if (candidate.attemptCount >= effectiveMaxAttempts) {
        result.maxAttemptsReached += 1;
        await escalateExhaustedRecoveryAction(candidate, effectiveMaxAttempts, now);
        continue;
      }

      const sourceIssue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, candidate.sourceIssueId))
        .then((rows) => rows[0] ?? null);

      // Nothing left to recover: the source issue is gone or already terminal.
      if (!sourceIssue || sourceIssue.status === "done" || sourceIssue.status === "cancelled") {
        result.skippedTerminalSource += 1;
        continue;
      }

      // Mirror the early-return guards in enqueueSourceScopedStrandedRecoveryWake
      // so we don't burn an attempt on actions that can never be re-fired.
      const wakePolicyType = readRecoveryWakePolicyType(candidate);
      if (wakePolicyType === "monitor_only" || wakePolicyType === "manual_repair_required") {
        result.nonWakeableSkipped += 1;
        continue;
      }
      if (candidate.cause === "configuration_incomplete") {
        result.nonWakeableSkipped += 1;
        continue;
      }
      if (candidate.cause === "provider_quota" && !candidate.ownerAgentId) {
        result.nonWakeableSkipped += 1;
        continue;
      }
      if (!candidate.ownerAgentId && wakePolicyType !== "board_escalation") {
        result.nonWakeableSkipped += 1;
        continue;
      }

      // Per-action backoff: an action that has already been re-fired several
      // times waits proportionally longer before the next attempt.
      if (candidate.lastAttemptAt) {
        const multiplier = Math.min(
          Math.max(candidate.attemptCount, 1),
          RECOVERY_ACTION_WAKE_BACKOFF_MAX_MULTIPLIER,
        );
        const backoffBefore = new Date(now.getTime() - intervalMs * multiplier);
        if (candidate.lastAttemptAt >= backoffBefore) {
          result.skippedBackoff += 1;
          continue;
        }
      }

      // `board_escalation` means action creation could not find an invokable
      // owner. Re-resolve now: an agent may have become invokable since (budget
      // unblocked, reactivated, manager assigned) and should own the recovery
      // instead of the action waiting on a human indefinitely.
      let rerouteOwnerAgentId: string | null = null;
      if (wakePolicyType === "board_escalation") {
        rerouteOwnerAgentId = await resolveStrandedIssueRecoveryOwnerAgentId(
          sourceIssue,
          candidate.previousOwnerAgentId,
        );
        if (!rerouteOwnerAgentId) {
          // Still no invokable owner: burn the attempt so the action walks
          // toward its ceiling instead of re-resolving on every sweep.
          await db
            .update(issueRecoveryActions)
            .set({
              attemptCount: candidate.attemptCount + 1,
              lastAttemptAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(issueRecoveryActions.id, candidate.id),
                eq(issueRecoveryActions.status, "active"),
                eq(issueRecoveryActions.attemptCount, candidate.attemptCount),
              ),
            );
          result.nonWakeableSkipped += 1;
          continue;
        }
      }

      // Compare-and-swap: bump attemptCount + lastAttemptAt only if the row
      // still matches the pre-image (status active + same attemptCount), so a
      // concurrent sweep or an event-triggered wake cannot double-fire.
      const [updated] = await db
        .update(issueRecoveryActions)
        .set({
          attemptCount: candidate.attemptCount + 1,
          lastAttemptAt: now,
          updatedAt: now,
          ...(rerouteOwnerAgentId
            ? {
              ownerType: "agent" as const,
              ownerAgentId: rerouteOwnerAgentId,
              wakePolicy: {
                type: "wake_owner",
                reason: "source_scoped_recovery_action",
                ownerAgentId: rerouteOwnerAgentId,
              },
            }
            : {}),
        })
        .where(
          and(
            eq(issueRecoveryActions.id, candidate.id),
            eq(issueRecoveryActions.status, "active"),
            eq(issueRecoveryActions.attemptCount, candidate.attemptCount),
          ),
        )
        .returning();

      if (!updated) continue;

      const action = updated as unknown as IssueRecoveryAction;
      const latestRun = await getLatestIssueRun(candidate.companyId, candidate.sourceIssueId);

      try {
        await enqueueSourceScopedStrandedRecoveryWake({
          action,
          issue: sourceIssue,
          latestRun,
          recoveryCause: candidate.cause as StrandedRecoveryCause,
        });
        if (rerouteOwnerAgentId) result.rerouted += 1;
        else result.reFired += 1;
        result.issueIds.push(candidate.sourceIssueId);
        result.actionIds.push(candidate.id);
      } catch (err) {
        result.enqueueFailed += 1;
        logger.warn(
          { err, recoveryActionId: candidate.id, sourceIssueId: candidate.sourceIssueId },
          "failed to re-fire stale recovery action wake",
        );
      }
    }

    if (result.reFired > 0 || result.rerouted > 0 || result.maxAttemptsReached > 0) {
      logger.warn({ ...result }, "swept stale recovery action wakes");
    }

    return result;
  }

  // At the attempt ceiling the backstop stops re-firing. Escalate the action to
  // the board (ownerType 'board', no owner agent) so exhaustion surfaces on the
  // board feed, and leave the source issue status untouched: writing
  // status:'blocked' here parked the issue permanently undispatchable with zero
  // blocker edges and no way to check it out. Does not bump attemptCount: the
  // attempt was never made.
  async function escalateExhaustedRecoveryAction(
    action: typeof issueRecoveryActions.$inferSelect,
    effectiveMaxAttempts: number,
    now: Date,
  ) {
    const [escalated] = await db
      .update(issueRecoveryActions)
      .set({
        status: "escalated",
        outcome: "exhausted",
        ownerType: "board",
        ownerAgentId: null,
        maxAttempts: effectiveMaxAttempts,
        updatedAt: now,
      })
      .where(
        and(
          eq(issueRecoveryActions.id, action.id),
          eq(issueRecoveryActions.status, "active"),
        ),
      )
      .returning();

    await logActivity(db, {
      companyId: action.companyId,
      actorType: "system",
      actorId: "recovery.sweep_stale_recovery_action_wakes",
      agentId: action.ownerAgentId,
      runId: null,
      action: "issue.recovery_action_max_attempts_reached",
      entityType: "issue",
      entityId: action.sourceIssueId,
      details: {
        source: "recovery.sweep_stale_recovery_action_wakes",
        recoveryActionId: action.id,
        attemptCount: action.attemptCount,
        maxAttempts: effectiveMaxAttempts,
        cause: action.cause,
      },
    });

    // Only the sweep that won the CAS comments on the source issue.
    if (!escalated) return;

    const sourceIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, action.sourceIssueId))
      .then((rows) => rows[0] ?? null);
    if (!sourceIssue) return;
    if (sourceIssue.status === "done" || sourceIssue.status === "cancelled") {
      return;
    }

    await issuesSvc.addComment(
      sourceIssue.id,
      `Recovery action \`${action.id}\` exhausted its attempt ceiling (${action.attemptCount}/${effectiveMaxAttempts}). ` +
        "The recovery action is escalated to the board; the source issue status was left untouched. " +
        "A board operator should assign an invokable recovery owner, fix the agent/runtime state, or record an intentional manual resolution.",
      {},
      { authorType: "system" },
    );
    await logActivity(db, {
      companyId: sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: "issue.recovery_action_exhausted",
      entityType: "issue",
      entityId: sourceIssue.id,
      details: {
        identifier: sourceIssue.identifier,
        sourceIssueStatus: sourceIssue.status,
        source: "recovery.sweep_stale_recovery_action_wakes_exhausted",
        recoveryActionId: action.id,
        attemptCount: action.attemptCount,
        maxAttempts: effectiveMaxAttempts,
      },
    });
  }

  const PERMANENTLY_UNFINALIZABLE_BLOCKERS_CANDIDATE_LIMIT = 500;
  const PERMANENTLY_UNFINALIZABLE_RELOG_INTERVAL_MS = 15 * 60_000;
  let lastPermanentlyUnfinalizableLogAt: Date | null = null;

  /**
   * Report-only sweep for issues that are gated by a permanently-unfinalizable
   * blocker — a blocker whose execution workspace has permanently failed the
   * workspace_finalize barrier (latest `workspace_operations` row for the
   * blocker's `executionWorkspaceId` IS a `workspace_finalize` attempt that did
   * NOT succeed, and no live run holds that workspace).
   *
   * This sweep does NOT heal or wake anything; it only reports via activity
   * log and logger so operators can triage permanently-stuck dependency chains.
   *
   * Returns per-workspace findings: one finding per affected execution workspace,
   * each carrying the blocker issue id, its identifier, and the list of gated
   * dependent issue ids.
   */
  async function reconcileUnfinalizableWorkspaceBarriers(opts?: {
    issueCreatedAtGte?: Date | null;
    companyId?: string | null;
  }) {
    const result = {
      reported: 0,
      skipped: 0,
      findings: [] as Array<{
        executionWorkspaceId: string;
        blockerIssueId: string;
        identifier: string | null;
        gatedDependentIssueIds: string[];
      }>,
    };

    const candidateFilters = [
      inArray(issues.status, ["todo", "blocked"]),
      visibleIssueCondition(),
      sql`${issues.assigneeAgentId} is not null`,
    ];
    if (opts?.issueCreatedAtGte) candidateFilters.push(gte(issues.createdAt, opts.issueCreatedAtGte));
    if (opts?.companyId) candidateFilters.push(eq(issues.companyId, opts.companyId));

    const candidates = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        status: issues.status,
      })
      .from(issues)
      .where(and(...candidateFilters))
      .orderBy(asc(issues.id))
      .limit(PERMANENTLY_UNFINALIZABLE_BLOCKERS_CANDIDATE_LIMIT);

    const candidateIdsByCompany = new Map<string, Set<string>>();

    for (const candidate of candidates) {
      const companySet = candidateIdsByCompany.get(candidate.companyId) ?? new Set<string>();
      companySet.add(candidate.id);
      candidateIdsByCompany.set(candidate.companyId, companySet);
    }

    const now = new Date();
    const shouldLog =
      !lastPermanentlyUnfinalizableLogAt ||
      now.getTime() - lastPermanentlyUnfinalizableLogAt.getTime() >= PERMANENTLY_UNFINALIZABLE_RELOG_INTERVAL_MS;

    for (const [companyId, candidateIds] of candidateIdsByCompany.entries()) {

      const blockers = await listPermanentlyUnfinalizableBlockersFromIssues(
        db,
        companyId,
        opts ? { issueCreatedAtGte: opts.issueCreatedAtGte } : undefined,
      );

      if (blockers.length === 0) continue;

      const blockerIds = new Set<string>();
      for (const blocker of blockers) {
        blockerIds.add(blocker.blockerIssueId);
      }

      const blockerRows = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
        })
        .from(issues)
        .where(inArray(issues.id, [...blockerIds]));
      const identifierByBlocker = new Map(blockerRows.map((row) => [row.id, row.identifier]));

      for (const blocker of blockers) {
        const gatedCandidateIds = blocker.gatedDependentIssueIds.filter((dependentId) =>
          candidateIds.has(dependentId),
        );

        if (gatedCandidateIds.length === 0) {
          result.skipped += 1;
          continue;
        }

        result.reported += 1;

        const finding = {
          executionWorkspaceId: blocker.executionWorkspaceId,
          blockerIssueId: blocker.blockerIssueId,
          identifier: identifierByBlocker.get(blocker.blockerIssueId) ?? null,
          gatedDependentIssueIds: gatedCandidateIds,
        };
        result.findings.push(finding);

        if (shouldLog) {
          await logActivity(db, {
            companyId,
            actorType: "system",
            actorId: "system",
            agentId: null,
            runId: null,
            action: "issue.unfinalizable_workspace_barrier_detected",
            entityType: "execution_workspace",
            entityId: blocker.executionWorkspaceId,
            details: {
              source: "recovery.reconcile_unfinalizable_workspace_barriers",
              blockerIssueId: blocker.blockerIssueId,
              gatedDependentIssueIds: gatedCandidateIds,
              latestOp: blocker.latestOp,
            },
          });
        }
      }
    }

    if (result.reported > 0 && shouldLog) {
      lastPermanentlyUnfinalizableLogAt = now;
      logger.warn(
        { reported: result.reported, findings: result.findings },
        "swept unfinalizable workspace barriers (report-only)",
      );
    }

    return result;
  }

  const STALE_IN_REVIEW_CHILD_RELOG_INTERVAL_MS = 5 * 60_000;
  let lastStaleInReviewChildLogAt: Date | null = null;

  async function ingestStaleInReviewChildIssues() {
    const result = {
      archived: 0,
      skippedParentNotBlocked: 0,
      manual: 0,
      issueIds: [] as string[],
    };

    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const candidates = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        companyId: issues.companyId,
        parentId: issues.parentId,
        monitorLastTriggeredAt: issues.monitorLastTriggeredAt,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(
        and(
          eq(issues.status, "in_review"),
          isNotNull(issues.parentId),
          sql`${issues.monitorLastTriggeredAt} is not null`,
          sql`${issues.monitorLastTriggeredAt} <= ${dayAgo}`,
          sql`${issues.executionState}->>'currentStageType' = 'review'`,
          sql`${issues.id} not in (select ${unWakeableArchives.issueId} from ${unWakeableArchives} where ${unWakeableArchives.policy} = 'stale_in_review_child')`,
        ),
      );
    for (const candidate of candidates) {
      const parent = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, candidate.parentId!))
        .then((rows) => rows[0] ?? null);

      if (!parent || parent.status !== "blocked") {
        result.skippedParentNotBlocked += 1;
        continue;
      }

      const state = parseIssueExecutionState(candidate.executionState);
      if (!state || state.currentStageType !== "review") {
        await db.insert(issueComments).values({
          companyId: candidate.companyId,
          issueId: candidate.id,
          authorType: "system",
          body: "Manual intervention required: stale in_review child with no matching auto-archive rule. The child is in_review but not at a review stage, so it cannot be auto-archived by this sweep.",
        });
        result.manual += 1;
        continue;
      }

      await db
        .update(issues)
        .set({ hiddenAt: new Date() })
        .where(eq(issues.id, candidate.id));

      await db.insert(unWakeableArchives).values({
        companyId: candidate.companyId,
        issueId: candidate.id,
        policy: "stale_in_review_child",
      });

      result.archived += 1;
      result.issueIds.push(candidate.id);

      await logActivity(db, {
        companyId: candidate.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.auto_archived",
        entityType: "issue",
        entityId: candidate.id,
        details: {
          source: "recovery.ingest_stale_in_review_child_issues",
          parentId: candidate.parentId,
          policy: "stale_in_review_child",
          identifier: candidate.identifier,
        },
      });
    }

    if (result.archived > 0) {
      const now = new Date();
      if (
        !lastStaleInReviewChildLogAt ||
        now.getTime() - lastStaleInReviewChildLogAt.getTime() >= STALE_IN_REVIEW_CHILD_RELOG_INTERVAL_MS
      ) {
        lastStaleInReviewChildLogAt = now;
        logger.warn(
          { archived: result.archived, skipped: result.skippedParentNotBlocked, manual: result.manual, issueIds: result.issueIds },
          "ingested stale in_review child issues",
        );
      }
    }

    return result;
  }

  // SUP-14539: edge-trigger gate shared by the report-only recovery sweeps.
  // A sweep writes one detection row when an (issue, condition) pair enters the
  // reported set, or when its `details` payload changes materially — never on a
  // timer. The state-change check is derived from the durable record: the most
  // recent activity row for this entityId + action. When that row's details are
  // equivalent to the would-be details, the condition is unchanged and no row
  // is written. Because the check reads the activity_log table instead of
  // in-memory state, a control-plane restart cannot reset it.
  function stableSweepDetailsKey(value: unknown): string {
    if (value === null || value === undefined) return "null";
    if (Array.isArray(value)) return `[${value.map((v) => stableSweepDetailsKey(v)).join(",")}]`;
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSweepDetailsKey(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  }

  async function emitSweepDetectionRowIfChanged(params: {
    companyId: string;
    entityId: string;
    action: string;
    details: Record<string, unknown>;
  }): Promise<boolean> {
    // Compare against the value that will actually be stored: logActivity
    // redacts details before persisting, so the durable row is the redacted
    // form and the comparison must be too.
    const redactedDetails = await redactActivityDetails(db, params.details);
    const [latest] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, params.entityId),
          eq(activityLog.action, params.action),
        ),
      )
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(1);
    if (latest && stableSweepDetailsKey(latest.details) === stableSweepDetailsKey(redactedDetails)) {
      return false;
    }
    await logActivity(db, {
      companyId: params.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: params.action,
      entityType: "issue",
      entityId: params.entityId,
      details: params.details,
    });
    return true;
  }

  async function reconcileCancelledOnlyBlockerDependents(opts?: { issueCreatedAtGte?: Date | null; limit?: number }) {
    const result = { reported: 0, skipped: 0, issueIds: [] as string[] };
    const seen = new Set<string>();

    const candidates = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.status, "blocked"),
          visibleIssueCondition(),
          ...(opts?.issueCreatedAtGte ? [gte(issues.createdAt, opts.issueCreatedAtGte)] : []),
          sql`exists (
            select 1 from ${issueRelations}
            where ${issueRelations.companyId} = ${issues.companyId}
              and ${issueRelations.relatedIssueId} = ${issues.id}
              and ${issueRelations.type} = 'blocks'
          )`,
        ),
      )
      .orderBy(asc(issues.id))
      .limit(opts?.limit ?? CANCELLED_ONLY_BLOCKER_DEPENDENT_SWEEP_LIMIT);

    for (const candidate of candidates) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      const blockerIds = await db
        .select({ blockerId: issueRelations.issueId })
        .from(issueRelations)
        .where(
          and(
            eq(issueRelations.companyId, candidate.companyId),
            eq(issueRelations.relatedIssueId, candidate.id),
            eq(issueRelations.type, "blocks"),
          ),
        )
        .then((rows) => rows.map((r) => r.blockerId));

      if (blockerIds.length === 0) {
        result.skipped += 1;
        continue;
      }

      const readiness = (await listIssueDependencyReadinessMap(db, candidate.companyId, [candidate.id])).get(
        candidate.id,
      );
      if (!readiness) {
        result.skipped += 1;
        continue;
      }

      if (readiness.unresolvedBlockerCount === 0) {
        result.skipped += 1;
        continue;
      }

      if (readiness.pendingFinalizeBlockerIssueIds.length > 0) {
        result.skipped += 1;
        continue;
      }

      const unresolvedStatuses = await db
        .select({ id: issues.id, status: issues.status })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, candidate.companyId),
            inArray(issues.id, readiness.unresolvedBlockerIssueIds),
          ),
        )
        .then((rows) => new Map(rows.map((r) => [r.id, r.status])));

      const allCancelled =
        readiness.unresolvedBlockerIssueIds.length > 0 &&
        readiness.unresolvedBlockerIssueIds.every((blockerId) => unresolvedStatuses.get(blockerId) === "cancelled");
      if (!allCancelled) {
        result.skipped += 1;
        continue;
      }

      if (await isAutomaticRecoverySuppressedByPauseHold(db, candidate.companyId, candidate.id, treeControlSvc)) {
        result.skipped += 1;
        continue;
      }

      if (await hasActiveExecutionPath(candidate.companyId, candidate.id, candidate.assigneeAgentId)) {
        result.skipped += 1;
        continue;
      }

      if (await hasPendingWakeInteraction(candidate.companyId, candidate.id)) {
        result.skipped += 1;
        continue;
      }

      result.reported += 1;
      result.issueIds.push(candidate.id);

      await emitSweepDetectionRowIfChanged({
        companyId: candidate.companyId,
        entityId: candidate.id,
        action: "issue.cancelled_blocker_dependent_detected",
        details: {
          identifier: candidate.identifier,
          source: "recovery.reconcile_cancelled_only_blocker_dependents",
        },
      });
    }

    const shouldLog =
      result.reported > 0 &&
      (!lastCancelledOnlyBlockerDependentLogAt ||
        Date.now() - lastCancelledOnlyBlockerDependentLogAt.getTime() >= CANCELLED_ONLY_BLOCKER_DEPENDENT_RELOG_INTERVAL_MS);
    if (shouldLog) {
      logger.warn(
        { reported: result.reported, skipped: result.skipped, issueIds: result.issueIds },
        "reconcileCancelledOnlyBlockerDependents: detected blocked issues with only cancelled blockers",
      );
      lastCancelledOnlyBlockerDependentLogAt = new Date();
    }

    return result;
  }

  async function reconcileStillbornAssignedBacklog(opts?: { issueCreatedAtGte?: Date | null }) {
    const result = { reported: 0, skipped: 0, issueIds: [] as string[] };

    // SUP-14907: exclude issues younger than the grace window so the detector
    // does not fire against cards still being filed (create → assign → promote).
    const graceCutoff = new Date(Date.now() - STILLBORN_ASSIGNED_BACKLOG_GRACE_MS);

    const candidates = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.status, "backlog"),
          sql`${issues.assigneeAgentId} is not null`,
          visibleIssueCondition(),
          opts?.issueCreatedAtGte ? gte(issues.createdAt, opts.issueCreatedAtGte) : undefined,
          lt(issues.createdAt, graceCutoff),
        ),
      )
      .orderBy(asc(issues.id))
      .limit(STILLBORN_ASSIGNED_BACKLOG_CANDIDATE_LIMIT);

    for (const candidate of candidates) {
      if (await hasActiveExecutionPath(candidate.companyId, candidate.id, candidate.assigneeAgentId)) {
        result.skipped += 1;
        continue;
      }

      if (await hasPendingWakeInteraction(candidate.companyId, candidate.id)) {
        result.skipped += 1;
        continue;
      }

      if (await isAutomaticRecoverySuppressedByPauseHold(db, candidate.companyId, candidate.id, treeControlSvc)) {
        result.skipped += 1;
        continue;
      }

      const updated = await escalateStrandedAssignedIssue({
        issue: candidate,
        previousStatus: "backlog",
        latestRun: null,
        recoveryCause: "stillborn_assigned_backlog",
        comment:
          "Paperclip found this issue parked in `backlog` with an assignee but no live execution path, no pending " +
          "wake interaction, and no recorded recovery. Moving it to `blocked` so a human or the assignee rules on it " +
          "instead of leaving it invisible in `backlog`.",
      });
      if (!updated) {
        result.skipped += 1;
        continue;
      }

      result.reported += 1;
      result.issueIds.push(candidate.id);

      // SUP-14184: the escalation above already records an `issue.updated`
      // activity row, so the sweep's own detection row is emitted only when the
      // (issue, condition) pair enters the reported set or its details change
      // materially (SUP-14539 edge trigger). The durable record is the most
      // recent detection row, so repeated detections and control-plane
      // restarts cannot re-arm it; a replaced recovery action is a material
      // details change and re-emits.
      const action = await recoveryActionsSvc.getActiveForIssue(candidate.companyId, candidate.id);
      await emitSweepDetectionRowIfChanged({
        companyId: candidate.companyId,
        entityId: candidate.id,
        action: "issue.stillborn_assigned_backlog_detected",
        details: {
          source: "recovery.reconcile_stillborn_assigned_backlog",
          identifier: candidate.identifier,
          assigneeAgentId: candidate.assigneeAgentId,
          recoveryActionId: action?.id ?? null,
        },
      });
    }

    const shouldLog =
      result.reported > 0 &&
      (!lastStillbornAssignedBacklogLogAt ||
        Date.now() - lastStillbornAssignedBacklogLogAt.getTime() >= STILLBORN_ASSIGNED_BACKLOG_RELOG_INTERVAL_MS);
    if (shouldLog) {
      logger.warn(
        { reported: result.reported, skipped: result.skipped, issueIds: result.issueIds },
        "stillborn assigned backlog sweep reported issues",
      );
      lastStillbornAssignedBacklogLogAt = new Date();
    }

    return result;
  }

  // SUP-14281: a pull-only assignee is never dispatched, so a todo/in_progress
  // card with no live continuation path will never wake on its own.
  // Report-only: detection row emitted edge-triggered (on entry into the
  // reported set or a material details change — SUP-14539), never on a timer;
  // no status writes, no reassignment.
  // The candidate window rotates with a keyset cursor (same pattern as the
  // resolved-dependency-wake backstop): report-only cards stay perpetually
  // eligible, so a fixed limit on asc(id) would permanently starve any stranded
  // card whose id sorts past the first window.
  async function reconcileUndispatchableAssignedIssues(opts?: { issueCreatedAtGte?: Date | null }) {
    const result = { reported: 0, skipped: 0, scanned: 0, escalated: 0, resolved: 0, issueIds: [] as string[] };

    // Backstop: resolve open undispatchable-assignee actions whose condition
    // has since cleared (assignee re-assigned to a dispatchable agent or a
    // user, card left todo/in_progress, or source issue gone). Driven by the
    // persisted action rows — not the in-memory sight counter — so it
    // survives control-plane restarts and also covers cards that fell outside
    // the candidate window below. Exhausted (terminal) rows are left alone:
    // only an explicit board resolution may clear those.
    const openUndispatchableActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.kind, UNDISPATCHABLE_ASSIGNEE_RECOVERY_KIND),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
        ),
      );
    for (const action of openUndispatchableActions) {
      const [source] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, action.sourceIssueId));
      let resolutionNote: string | null = null;
      if (!source) {
        resolutionNote = "Recovery action became stale because the source issue no longer exists.";
      } else if (source.status !== "todo" && source.status !== "in_progress") {
        resolutionNote = `Recovery action became stale because the source issue left the stranded set and is now ${source.status}.`;
      } else if (!source.assigneeAgentId) {
        resolutionNote = "Recovery action became stale because the source issue no longer has an agent assignee.";
      } else {
        const [assignee] = await db
          .select({ adapterType: agents.adapterType })
          .from(agents)
          .where(eq(agents.id, source.assigneeAgentId));
        if (!assignee || !isPullOnlyAdapterType(assignee.adapterType)) {
          resolutionNote = "Recovery action became stale because the source issue assignee is no longer a pull-only adapter agent.";
        }
      }
      if (!resolutionNote) continue;
      const resolvedAction = await recoveryActionsSvc.resolveActiveForIssue({
        companyId: action.companyId,
        sourceIssueId: action.sourceIssueId,
        actionId: action.id,
        status: "resolved",
        outcome: "restored",
        resolutionNote,
      });
      if (resolvedAction) {
        result.resolved += 1;
        undispatchableAssignedSightCounts.delete(action.sourceIssueId);
      }
    }

    const queryCandidates = (afterIssueId: string | null) => {
      const filters = [
        inArray(issues.status, ["todo", "in_progress"]),
        sql`${issues.assigneeAgentId} is not null`,
        visibleIssueCondition(),
      ];
      if (afterIssueId) filters.push(gt(issues.id, afterIssueId));
      if (opts?.issueCreatedAtGte) filters.push(gte(issues.createdAt, opts.issueCreatedAtGte));

      return db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          monitorNextCheckAt: issues.monitorNextCheckAt,
          assigneeAdapterType: agents.adapterType,
          totalCount: sql<number>`count(*) over()::int`,
        })
        .from(issues)
        .innerJoin(
          agents,
          and(eq(agents.id, issues.assigneeAgentId), eq(agents.companyId, issues.companyId)),
        )
        .where(and(...filters))
        .orderBy(asc(issues.id))
        .limit(UNDISPATCHABLE_ASSIGNED_CANDIDATE_LIMIT);
    };

    let candidateRows = await queryCandidates(undispatchableAssignedScanCursor);
    if (candidateRows.length === 0 && undispatchableAssignedScanCursor) {
      undispatchableAssignedScanCursor = null;
      candidateRows = await queryCandidates(null);
    }
    const totalCandidateCount = candidateRows[0]?.totalCount ?? 0;
    const candidates = candidateRows.map(({ totalCount: _totalCount, ...candidate }) => candidate);
    const lastCandidate = candidates[candidates.length - 1] ?? null;
    undispatchableAssignedScanCursor =
      candidates.length < totalCandidateCount && lastCandidate ? lastCandidate.id : null;
    result.scanned = candidates.length;

    for (const candidate of candidates) {
      // Every guard that clears the condition also resets the confirmation
      // counter, so a card that recovers between cycles counts first-sight
      // again from the next confirmed cycle.
      if (!isPullOnlyAdapterType(candidate.assigneeAdapterType)) {
        undispatchableAssignedSightCounts.delete(candidate.id);
        result.skipped += 1;
        continue;
      }

      if (
        await hasActiveExecutionPath(
          candidate.companyId,
          candidate.id,
          candidate.assigneeAgentId,
          candidate.monitorNextCheckAt,
        )
      ) {
        undispatchableAssignedSightCounts.delete(candidate.id);
        result.skipped += 1;
        continue;
      }

      if (await hasPendingWakeInteraction(candidate.companyId, candidate.id)) {
        undispatchableAssignedSightCounts.delete(candidate.id);
        result.skipped += 1;
        continue;
      }

      if (await isAutomaticRecoverySuppressedByPauseHold(db, candidate.companyId, candidate.id, treeControlSvc)) {
        undispatchableAssignedSightCounts.delete(candidate.id);
        result.skipped += 1;
        continue;
      }

      result.reported += 1;
      result.issueIds.push(candidate.id);

      await emitSweepDetectionRowIfChanged({
        companyId: candidate.companyId,
        entityId: candidate.id,
        action: "issue.undispatchable_assignee_detected",
        details: {
          source: "recovery.reconcile_undispatchable_assigned",
          identifier: candidate.identifier,
          assigneeAgentId: candidate.assigneeAgentId,
          status: candidate.status,
        },
      });

      // Two-cycle confirmation: the condition must hold on this sweep AND on
      // a prior one before the sweep escalates. First sight stays report-only
      // so a card mid-reassignment (assignee just set, dispatch state not yet
      // settled) cannot trip the escalation. From the second confirmed
      // cycle on, the card owns a first-class board recovery action instead
      // of being re-reported forever with activeRecoveryAction null.
      let confirmedCycles = (undispatchableAssignedSightCounts.get(candidate.id) ?? 0) + 1;
      if (confirmedCycles === 1 && undispatchableAssignedSightCounts.size >= UNDISPATCHABLE_ASSIGNED_SIGHT_COUNTS_LIMIT) {
        // Bounded-memory reset: only un-escalated cards are affected, and it
        // just delays their escalation one cycle (open actions are persisted
        // in the DB and re-confirmed idempotently, not via this counter).
        undispatchableAssignedSightCounts.clear();
      }
      undispatchableAssignedSightCounts.set(candidate.id, confirmedCycles);
      if (confirmedCycles < 2) continue;

      const openAction = await recoveryActionsSvc.getActiveForIssue(candidate.companyId, candidate.id);
      if (openAction) {
        if (openAction.kind === UNDISPATCHABLE_ASSIGNEE_RECOVERY_KIND) {
          // Idempotent: this sweep already owns an open (or terminal
          // escalated) action for the same condition. Re-confirmation must
          // not mint a second one or bump its attempt budget.
          continue;
        }
        if (openAction.status === "escalated" && (openAction.outcome as string | null) === "exhausted") {
          // A terminal action for a different condition blocks a new mint on
          // the same source (platform invariant). Board must resolve it first.
          continue;
        }
      }

      // Durable suppressor (SUP-14699): when the board has ruled this alarm
      // structurally invalid for the current assignee, it is recorded as a
      // resolved `false_positive` of this kind. The mint path above reads only
      // the currently-open action, so without this check the next tick re-mints
      // the alarm ~12s after the board resolved it — a ratified ruling surviving
      // exactly one sweep interval. Keying on `false_positive` (not any
      // resolution) preserves the sweep's real purpose: `restored` means the
      // condition cleared and must keep re-detecting; only a ruling-invalid
      // alarm goes quiet. Reading the persisted row — not the in-memory sight
      // counter — means the ruling survives a control-plane restart. A change of
      // assignee re-arms, because a different agent is a different claim.
      const ruledInvalid = await recoveryActionsSvc.getLatestResolvedForIssue(
        candidate.companyId,
        candidate.id,
        UNDISPATCHABLE_ASSIGNEE_RECOVERY_KIND,
      );
      if (
        ruledInvalid?.outcome === "false_positive" &&
        (ruledInvalid.evidence?.assigneeAgentId as string | null | undefined) === candidate.assigneeAgentId
      ) {
        continue;
      }

      const escalatedAction = await recoveryActionsSvc.upsertSourceScoped({
        companyId: candidate.companyId,
        sourceIssueId: candidate.id,
        kind: UNDISPATCHABLE_ASSIGNEE_RECOVERY_KIND,
        ownerType: "board",
        ownerAgentId: null,
        previousOwnerAgentId: candidate.assigneeAgentId,
        cause: UNDISPATCHABLE_ASSIGNEE_RECOVERY_CAUSE,
        fingerprint: `undispatchable_assignee:${candidate.companyId}:${candidate.id}`,
        evidence: {
          source: "recovery.reconcile_undispatchable_assigned",
          identifier: candidate.identifier,
          assigneeAgentId: candidate.assigneeAgentId,
          assigneeAdapterType: candidate.assigneeAdapterType,
          status: candidate.status,
        },
        nextAction:
          "Reassign the card to a dispatchable agent or a human owner: the current assignee is a pull-only (process) adapter agent that can never be woken, so the card has no wake path.",
        wakePolicy: null,
        monitorPolicy: null,
        maxAttempts: null,
      });
      if (escalatedAction.kind !== UNDISPATCHABLE_ASSIGNEE_RECOVERY_KIND) continue;
      result.escalated += 1;

      await logActivity(db, {
        companyId: candidate.companyId,
        actorType: "system",
        actorId: "recovery.reconcile_undispatchable_assigned",
        agentId: null,
        runId: null,
        action: "issue.undispatchable_assignee_escalated",
        entityType: "issue",
        entityId: candidate.id,
        details: {
          source: "recovery.reconcile_undispatchable_assigned",
          identifier: candidate.identifier,
          assigneeAgentId: candidate.assigneeAgentId,
          recoveryActionId: escalatedAction.id,
        },
      });
    }

    const shouldLog =
      result.reported > 0 &&
      (!lastUndispatchableAssignedSweepLogAt ||
        Date.now() - lastUndispatchableAssignedSweepLogAt.getTime() >= UNDISPATCHABLE_ASSIGNED_RELOG_INTERVAL_MS);
    if (shouldLog) {
      logger.warn(
        {
          reported: result.reported,
          skipped: result.skipped,
          scanned: result.scanned,
          escalated: result.escalated,
          resolved: result.resolved,
          issueIds: result.issueIds,
        },
        "undispatchable-assigned sweep reported issues",
      );
      lastUndispatchableAssignedSweepLogAt = new Date();
    }

    return result;
  }

  return {
    buildRunOutputSilence,
    escalateStrandedRecoveryIssueInPlace,
    escalateStrandedAssignedIssue,
    recordWatchdogDecision,
    scanSilentActiveRuns,
    scanTerminableSilentActiveRuns,
    reconcileStrandedAssignedIssues,
    sweepStaleIssueLocks,
    reconcileBlockedWithoutBlockers,
    reconcilePendingReviewRearm,
    reconcileStaleRecoveryActionWakes,
    reconcileUnfinalizableWorkspaceBarriers,
    ingestStaleInReviewChildIssues,
    buildIssueGraphLivenessAutoRecoveryPreview,
    reconcileResolvedDependencyWakeBackstop,
    reconcileIssueGraphLiveness,
    readRecoveryTimerIntervalMs,
    reconcileStillbornAssignedBacklog,
    reconcileCancelledOnlyBlockerDependents,
    reconcileUndispatchableAssignedIssues,
  };
}
