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

export function buildConfigurationIncompleteRecoveryNoticeSeed(): StrandedRecoveryNoticeSeed {
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
// noticeMetadataReferencesRecoveryAction, so this builder must always emit
// that row with the raw action id.
export function buildStrandedRecoveryEscalationNotice(input: {
  seed?: StrandedRecoveryNoticeSeed | null;
  fallbackBody?: string | null;
  recoveryCause?: string | null;
  recoveryActionId: string;
  recoveryOwner: { id: string; name: string | null } | null | undefined;
  sourceRun: {
    id: string;
    agentId?: string | null;
    status: string;
    errorCode?: string | null;
    errorSummary?: string | null;
  } | null | undefined;
}): StrandedRecoveryEscalationNotice {
  const fallbackBody = input.fallbackBody?.trim();
  const body = input.seed?.body ?? (fallbackBody || DEFAULT_STRANDED_RECOVERY_NOTICE_BODY);
  const title = input.seed?.title ??
    STRANDED_RECOVERY_NOTICE_TITLES_BY_CAUSE[input.recoveryCause ?? ""] ??
    DEFAULT_STRANDED_RECOVERY_NOTICE_TITLE;

  const recoveryRows: NoticeMetadataRow[] = [
    keyValueRow("Recovery action", input.recoveryActionId),
    input.recoveryOwner
      ? agentLinkRow("Recovery owner", input.recoveryOwner)
      : keyValueRow(
          "Recovery owner",
          "Board decision required",
        ),
    keyValueRow(
      "Next action",
      input.recoveryOwner
        ? "The recovery owner should either restore a live execution path or record the manual resolution on the source issue"
        : "Inspect the evidence, then retry the original owner, explicitly reassign, repair the execution path, or record an intentional resolution",
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
    presentation: systemNoticePresentation({ tone: input.seed?.tone ?? "danger", title }),
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
