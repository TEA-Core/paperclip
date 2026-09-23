import type { IssueCommentMetadata, IssueCommentPresentation } from "@paperclipai/shared";
import {
  agentLinkRow,
  keyValueRow,
  runLinkRow,
  systemNoticePresentation,
  type NoticeMetadataRow,
  type NoticeMetadataSection,
} from "./notice-format.js";
import type { ContinuationPathDisjuncts } from "../issue-continuation-path.js";

// Short human-readable body plus the presentation header for one recovery
// family. The escalation path merges in the metadata rows only it knows
// (recovery action, owner, source run) via buildStrandedRecoveryEscalationNotice.
export type StrandedRecoveryNoticeSeed = {
  body: string;
  title: string;
  tone: IssueCommentPresentation["tone"];
  nextAction?: string;
};

export type StrandedRecoveryEscalationNotice = {
  body: string;
  presentation: IssueCommentPresentation;
  metadata: IssueCommentMetadata;
};

export const DEFAULT_STRANDED_RECOVERY_NOTICE_BODY =
  "Paperclip could not restore a live execution path for this issue automatically. " +
  "Moving it to `blocked` so it is visible for intervention.";

const DEFAULT_STRANDED_RECOVERY_NOTICE_TITLE = "Automatic recovery blocked";

const STRANDED_RECOVERY_NOTICE_TITLES_BY_CAUSE: Record<string, string> = {
  workspace_validation_failed: "Workspace validation failed",
  configuration_incomplete: "Configuration incomplete",
  execution_review_participant_recovery: "Review recovery stalled",
};

// Titles keyed by the source run's classified error code. The raw failure text
// never reaches the issue thread (summarizeRunFailureForIssueComment withholds
// it), so the classified code is the only safe, specific cause the collapsed
// notice row can lead with. A mapped code outranks the seed titles because the
// seeds describe the recovery family ("No live execution path"), not the cause.
const STRANDED_RECOVERY_NOTICE_TITLES_BY_RUN_ERROR_CODE: Record<string, string> = {
  provider_quota: "Error: usage limit reached",
  claude_auth_required: "Error: not logged in to Claude",
  acpx_auth_required: "Error: agent login required",
};

const WORKSPACE_SCAN_NOTICES: Record<string, { title: string; nextAction: string }> = {
  workspace_git_scan_timeout: { title: "Workspace scan timed out", nextAction: "Check repository access and server load, then retry the task." },
  workspace_git_scan_saturated: { title: "Workspace scan queue is full", nextAction: "Check server load and the workspace scan queue, then retry the task." },
  workspace_git_scan_output_limit: { title: "Workspace scan exceeded its limit", nextAction: "Check the repository size and workspace scan output limit before retrying the task." },
  workspace_git_scan_failed: { title: "Workspace scan failed", nextAction: "Inspect the failed run and check repository access and integrity before retrying the task." },
  workspace_git_scan_cancelled: { title: "Workspace scan was cancelled", nextAction: "Inspect why workspace preparation was cancelled before retrying the task." },
};

export function buildImmediateExecutionPathRecoveryNoticeSeed(input: {
  status: "todo" | "in_progress";
}): StrandedRecoveryNoticeSeed {
  const retryDescription = input.status === "todo"
    ? "Paperclip automatically retried dispatch for this assigned `todo` issue during terminal run recovery"
    : "Paperclip automatically retried continuation for this assigned `in_progress` issue during terminal run recovery";
  return {
    body:
      `${retryDescription}, but it still has no live execution path. ` +
      "Moving it to `blocked` so it is visible for intervention.",
    title: "No live execution path",
    tone: "danger",
  };
}

export function buildWorkspaceValidationRecoveryNoticeSeed(): StrandedRecoveryNoticeSeed {
  return {
    body:
      "Paperclip stopped before launching the local adapter because the issue workspace failed validation. " +
      "Moving it to `blocked` so the workspace link, cwd, or git checkout can be repaired before resuming.",
    title: "Workspace validation failed",
    tone: "danger",
  };
}

export const SANDBOX_PROVIDER_PLUGIN_NOT_READY_REASON = "sandbox_provider_plugin_not_ready";

function readNonEmptyStringField(payload: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * What the operator must do to bring a sandbox provider plugin back to
 * `ready`, by the status the run observed. Enabling an `upgrade_pending`
 * plugin also approves the capabilities the upgrade added, so that case asks
 * for a review first.
 */
export function sandboxProviderPluginRemedy(pluginStatus: string): string {
  switch (pluginStatus) {
    case "upgrade_pending":
      return "review and approve the upgraded plugin's capabilities, then enable it (Plugins → Enable)";
    case "disabled":
      return "enable the plugin again (Plugins → Enable); an operator disabled it";
    default:
      return "enable the plugin (Plugins → Enable); a server restart also re-activates a bundled plugin";
  }
}

/**
 * Seed for a `configuration_incomplete` escalation. `configurationIncomplete`
 * is the structured payload the failed run recorded in `resultJson`; the body
 * names the specific gap for the reasons this notice knows, and falls back to
 * the secret/env-binding wording (the original and most common reason).
 */
export function buildConfigurationIncompleteRecoveryNoticeSeed(
  configurationIncomplete?: Record<string, unknown> | null,
): StrandedRecoveryNoticeSeed {
  if (readNonEmptyStringField(configurationIncomplete, "reason") === "ai_connection_unavailable") {
    return {
      title: "AI connection needs attention",
      body: "This task paused because its selected AI account is unavailable. Reconnect the account or choose an available connection to continue.",
      nextAction: "Reconnect the selected AI account or choose an available connection, then continue the task.",
      tone: "danger",
    };
  }
  if (readNonEmptyStringField(configurationIncomplete, "reason") === SANDBOX_PROVIDER_PLUGIN_NOT_READY_REASON) {
    const pluginKey = readNonEmptyStringField(configurationIncomplete, "pluginKey") ?? "the sandbox provider plugin";
    const pluginStatus = readNonEmptyStringField(configurationIncomplete, "pluginStatus") ?? "not ready";
    return {
      body:
        `Paperclip stopped before dispatching the adapter because the sandbox provider plugin \`${pluginKey}\` ` +
        `is in status \`${pluginStatus}\` and cannot lease a sandbox. Runs will keep failing the same way until the ` +
        `plugin is \`ready\` again. Moving it to \`blocked\` so an operator can ${sandboxProviderPluginRemedy(pluginStatus)} ` +
        "before resuming.",
      title: "Configuration incomplete",
      tone: "danger",
    };
  }
  return {
    body:
      "Paperclip stopped before dispatching the adapter because required secret/env bindings are missing. " +
      "Moving it to `blocked` so an operator can bind the missing secret(s) before resuming.",
    title: "Configuration incomplete",
    tone: "danger",
  };
}

export function buildExecutionReviewParticipantRecoveryNoticeSeed(): StrandedRecoveryNoticeSeed {
  return {
    body:
      "Paperclip retried the pending execution-review participant once, but the review stage still has no " +
      "completed decision or live reviewer run. Moving it to `blocked` so the board can inspect the evidence, repair the " +
      "reviewer runtime, restore the review stage, or record an intentional manual resolution.",
    title: "Review recovery stalled",
    tone: "danger",
  };
}

export function buildExecutionReviewParticipantUnavailableNoticeSeed(): StrandedRecoveryNoticeSeed {
  return {
    body:
      "Paperclip cannot continue the pending execution-review participant because the participant is not " +
      "invokable and the review stage has no completed decision or live reviewer run. Moving it to `blocked` " +
      "so the board can inspect the evidence, repair the reviewer runtime, restore the review stage, or record an " +
      "intentional manual resolution.",
    title: "Review recovery stalled",
    tone: "danger",
  };
}

// Escalation dedupe matches the `Recovery action` key_value row via
// noticeMetadataReferencesRecoveryAction, so a caller that has a real recovery
// action must pass its raw id. A caller with no real row (the strand sweeps,
// SUP-16559) passes null/omits it and the row is dropped entirely rather than
// showing a synthetic id; those callers dedupe on `sourceRunId` instead.
export function buildStrandedRecoveryEscalationNotice(input: {
  seed?: StrandedRecoveryNoticeSeed | null;
  fallbackBody?: string | null;
  recoveryCause?: string | null;
  recoveryActionId?: string | null;
  recoveryOwner: { id: string; name: string | null } | null | undefined;
  sourceRun: {
    id: string;
    agentId?: string | null;
    status: string;
    errorCode?: string | null;
    errorSummary?: string | null;
  } | null | undefined;
}): StrandedRecoveryEscalationNotice {
  const workspaceScan = WORKSPACE_SCAN_NOTICES[input.sourceRun?.errorCode ?? ""];
  const seed = workspaceScan ? {
    ...workspaceScan,
    body: `Paperclip could not prepare the workspace before the agent started. Automatic recovery could not continue. ${workspaceScan.nextAction}`,
    tone: "danger" as const,
  } : input.seed;
  const fallbackBody = input.fallbackBody?.trim();
  const body = seed?.body ?? (fallbackBody || DEFAULT_STRANDED_RECOVERY_NOTICE_BODY);
  const title =
    STRANDED_RECOVERY_NOTICE_TITLES_BY_RUN_ERROR_CODE[input.sourceRun?.errorCode?.trim() ?? ""] ??
    seed?.title ??
    STRANDED_RECOVERY_NOTICE_TITLES_BY_CAUSE[input.recoveryCause ?? ""] ??
    DEFAULT_STRANDED_RECOVERY_NOTICE_TITLE;

  const recoveryRows: NoticeMetadataRow[] = [
    ...(input.recoveryActionId ? [keyValueRow("Recovery action", input.recoveryActionId)] : []),
    input.recoveryOwner
      ? agentLinkRow("Recovery owner", input.recoveryOwner)
      : keyValueRow(
          "Recovery owner",
          "Board decision required",
        ),
    keyValueRow(
      "Next action",
      seed?.nextAction ?? (input.recoveryOwner
        ? "The recovery owner should either restore a live execution path or record the manual resolution on the source issue"
        : "Inspect the evidence, then retry the original owner, explicitly reassign, repair the execution path, or record an intentional resolution"),
    ),
  ];

  const runRows: NoticeMetadataRow[] = [];
  if (input.sourceRun) {
    runRows.push(runLinkRow("Source run", input.sourceRun));
    const failureCode = input.sourceRun.errorCode?.trim();
    if (failureCode) runRows.push(keyValueRow("Failure code", failureCode));
    const failureSummary = input.sourceRun.errorSummary?.trim();
    if (failureSummary) runRows.push(keyValueRow("Failure summary", failureSummary));
  }

  const sections: NoticeMetadataSection[] = [
    { title: "Recovery", rows: recoveryRows },
    ...(runRows.length > 0 ? [{ title: "Run evidence", rows: runRows }] : []),
  ];

  return {
    body,
    presentation: systemNoticePresentation({ tone: seed?.tone ?? "danger", title }),
    metadata: {
      version: 1,
      sourceRunId: input.sourceRun?.id ?? null,
      sections,
    },
  };
}

export type DispatchSuppressionParkNotice = {
  body: string;
  presentation: IssueCommentPresentation;
  metadata: IssueCommentMetadata;
};

// §2a disjunct labels, keyed off the D1 suppression row's `disjuncts` payload
// (shape fixed by SUP-14880). Only the disjuncts that are NOT live are named in
// the notice, so the board sees exactly what is missing and what to restore.
const DISPATCH_SUPPRESSED_DISJUNCT_LABELS: Array<{
  key: keyof ContinuationPathDisjuncts;
  label: string;
}> = [
  { key: "activeRun", label: "no active or queued run" },
  { key: "monitorNextCheckAtInFuture", label: "no monitor with a future next check" },
  { key: "watchdog", label: "no live task watchdog" },
  { key: "scheduledRetry", label: "no scheduled retry" },
  { key: "activeRecoveryAction", label: "no live recovery action" },
  { key: "successfulRunHandoffLive", label: "no live successful-run handoff" },
];

// ADR-093 D3 (SUP-14881) — the board-visible notice posted when a persistently
// dispatch-suppressed in_progress card is parked onto the
// blocked_without_blockers surface. Names the failing §2a disjuncts (from the
// D1 suppression row) and a concrete unblock action, so the board gets something
// actionable — the defect that left SUP-14761's escalation untellable.
export function buildDispatchSuppressionParkNotice(input: {
  disjuncts: ContinuationPathDisjuncts;
  identifier: string | null;
  assignee: { id: string; name: string | null } | null;
}): DispatchSuppressionParkNotice {
  const failing = DISPATCH_SUPPRESSED_DISJUNCT_LABELS.filter(
    ({ key }) => input.disjuncts[key] !== true,
  );
  const disjunctSummary =
    failing.length > 0
      ? failing.map((entry) => entry.label).join("; ")
      : "none detected (unexpected)";
  const cardRef = input.identifier ? ` \`${input.identifier}\`` : "";

  const body =
    `Paperclip stopped dispatching timer runs for this${cardRef} ` +
    "`in_progress` card because no live continuation path remains. " +
    `Missing §2a disjuncts: ${disjunctSummary}. ` +
    "The card has been parked on the blocked_without_blockers surface and will stay there until a live path returns. " +
    "Unblock it by re-arming a monitor next check, restoring a watchdog, reassigning it to a live run, " +
    "or recording the intended resolution.";

  const disjunctRows: NoticeMetadataRow[] =
    failing.length > 0
      ? failing.map((entry) => keyValueRow(entry.label, "absent"))
      : [keyValueRow("Continuation path", "unexpectedly live")];

  const actionRows: NoticeMetadataRow[] = [
    input.assignee
      ? agentLinkRow("Unblock owner", input.assignee)
      : keyValueRow("Unblock owner", "Board decision required"),
    keyValueRow(
      "Next action",
      "Restore a live continuation path (monitor next check, watchdog, live run, or recovery action), add valid blockers, or record the intended resolution",
    ),
  ];

  const sections: NoticeMetadataSection[] = [
    { title: "Missing continuation", rows: disjunctRows },
    { title: "Action", rows: actionRows },
  ];

  return {
    body,
    presentation: systemNoticePresentation({ tone: "danger", title: "Dispatch suppressed — parked" }),
    metadata: {
      version: 1,
      sourceRunId: null,
      sections,
    },
  };
}

// ADR-093 D2 (SUP-15553) — the board-visible notice posted when a stranded
// assigned `todo` card is parked onto the blocked_without_blockers surface.
// Mirrors buildDispatchSuppressionParkNotice for the `todo` arm: names the
// assignee to unblock and a concrete next action, since no in_progress
// reconciler ever surfaced these cards before.
export type TodoStrandedParkNotice = {
  body: string;
  presentation: IssueCommentPresentation;
  metadata: IssueCommentMetadata;
};

export function buildTodoStrandedParkNotice(input: {
  identifier: string | null;
  assignee: { id: string; name: string | null } | null;
}): TodoStrandedParkNotice {
  const cardRef = input.identifier ? ` \`${input.identifier}\`` : "";
  const body =
    `Paperclip found this${cardRef} \`todo\` card with an assigned agent that has had no wake or run ` +
    "and no live continuation path for the liveness window. The card was parked on the " +
    "blocked_without_blockers surface so the board can reassign it, re-arm a monitor, or record " +
    "the intended resolution.";

  const actionRows: NoticeMetadataRow[] = [
    input.assignee
      ? agentLinkRow("Unblock owner", input.assignee)
      : keyValueRow("Unblock owner", "Board decision required"),
    keyValueRow(
      "Next action",
      "Reassign to a live agent, re-arm a monitor next check, or record the intended resolution",
    ),
  ];

  return {
    body,
    presentation: systemNoticePresentation({ tone: "danger", title: "Stranded assigned todo — parked" }),
    metadata: {
      version: 1,
      sourceRunId: null,
      sections: [{ title: "Action", rows: actionRows }],
    },
  };
}
