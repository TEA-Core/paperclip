/** Lists of other-issue summaries; each entry carries that issue's `title`. */
const ISSUE_SUMMARY_LIST_FIELDS = new Set([
  "addedReferencedIssues",
  "removedReferencedIssues",
  "currentReferencedIssues",
  "blockedByIssues",
  "addedBlockedByIssues",
  "removedBlockedByIssues",
]);

/**
 * The explicit allow-list of metadata keys whose scalar values a recipient
 * that cannot read an issue may still receive: identifiers, states, enums,
 * counters and timestamps of issue events, issue rows, comments, document
 * summaries, activity entries and runs. A key not listed here is withheld,
 * whatever its name looks like; add a key only after checking that its values
 * never carry free-form text.
 */
export const ISSUE_METADATA_KEYS: ReadonlySet<string> = new Set([
  // states, enums and revisions
  "action", "actorType", "adapterType", "allowed", "authorType", "color", "currentToolName", "decision",
  "deletedByType", "entityType", "errorCode", "eventType", "format", "headSha", "id", "identifier",
  "interactionKind", "interactionStatus", "invocationSource", "issueNumber", "key", "kind",
  "latestRevisionNumber", "level", "originKind", "outcome", "parentLinkKind", "phase", "prState",
  "previousStatus", "priority", "provider", "requestDepth", "revision", "revisionNumber", "seq", "source",
  "status", "stream", "triggerDetail", "truncated", "ts", "type", "workMode", "workingNow",
  // identifiers and keys
  "acceptedPlanRevisionId", "actionId", "actionRequestId", "activeRunId", "actorAgentId", "actorId",
  "actorUserId", "addedBlockedByIssueIds", "addresseeAgentId", "addresseeUserId", "agentId",
  "ancestorIssueId", "applicationId", "approvalId", "arbiterAgentId", "assigneeAgentId", "assigneeUserId",
  "attachmentId", "attachmentIds", "authorAgentId", "authorUserId", "baseRevisionId", "blockedByIssueIds",
  "blockerIssueId", "blockerIssueIds", "boardApiKeyId", "boundaryCommentId", "cancelledIssueIds",
  "cancelledRunId", "catalogEntryId", "checkoutRunId", "childIdentifier", "childIssueId", "childIssueIds",
  "ciRunIds", "clearedCheckoutRunId", "clearedExecutionRunId", "commentId", "companyId", "completedStageIds",
  "completionContractId", "connectionId", "continuationIdentityContextId", "conversationAgentId",
  "conversationBoundaryCommentId", "conversationId", "conversationUserId", "correctiveRunId",
  "createdByAgentId", "createdByRunId", "createdByUserId", "currentChildIssueId", "currentStageId",
  "decisionId", "decisionInteractionId", "decompositionId", "defaultParentId", "defaultSelectedOptionIds",
  "deferredRunId", "deletedAnnotationCommentIds", "deletedByAgentId", "deletedByRunId", "deletedByUserId",
  "derivedAuthorAgentId", "derivedCreatedByRunId", "documentId", "documentKey", "droppedStageIds",
  "endpointId", "entityId", "entryRulingRevisionId", "environmentId", "eventId", "excludedChildIdentifiers",
  "executionHoldRecoveryActionId", "executionRunId", "executionWorkspaceId", "expectedExecutionWorkspaceId",
  "expiredInteractionIds", "gatedDependentIssueIds", "goalId", "hasBlockedByIssueIds", "holdId",
  "holderRunId", "inheritExecutionWorkspaceFromIssueId", "inheritedExecutionWorkspaceFromIssueId",
  "interactionId", "interruptedRunId", "invocationId", "issueCommentId", "issueId", "issueIdentifier",
  "labelId", "labelIds", "ladderedChildIdentifiers", "lastDecisionId", "lastStatusDecisionId",
  "latestRevisionId", "latestRunId", "leaseId", "lockedByAgentId", "lockedByUserId", "nativeResultId",
  "newlyCreatedChildIssueIds", "onBehalfOfUserId", "optionIds", "orderedCommentIds", "originId",
  "originIdentityContextId", "originRunId", "ownerAgentId", "ownerUserId", "parentId", "parentIdentifier",
  "parentIssueId", "prevCheckoutRunId", "prevExecutionRunId", "previousAssigneeAgentId",
  "previousBlockedByIssueIds", "previousCheckoutRunId", "previousOwnerAgentId", "previousRunIds",
  "projectId", "projectWorkspaceId", "promotedWorkProductId", "proposalId", "providerMessageId",
  "publicationId", "questionId", "queueId", "queueTargetRunId", "raAgentId", "receiptId",
  "reclassificationActivityId", "recoveryActionId", "recoveryActionIds", "recoveryIdentifier",
  "recoveryIssueId", "recoveryOwnerAgentId", "recoveryRunId", "relatedIssueId", "releasedCancelHoldIds",
  "removedBlockedByIssueIds", "requestId", "requestingAgentId", "resolvedAnnotationThreadIds",
  "resolvedBlockerIssueId", "resolvedByAgentId", "resolvedByRunId", "resolvedByUserId", "responseCommentId",
  "responseUserId", "responsibleUserId", "restoredFromRevisionId", "restoredIssueIds", "resultId",
  "retryRunId", "returnAssigneeAgentId", "returnOwnerAgentId", "reviewInteractionId", "revisionId",
  "rootIssueId", "runId", "runtimeRequestId", "sampleIssueIdentifier", "scheduledRunId", "selectedOptionIds",
  "sessionId", "skillId", "skippedStageIds", "snapshotId", "sourceAttachmentId", "sourceCommentId",
  "sourceIdentifier", "sourceIssueId", "sourceRunId", "stageId", "supersededByIdentifier",
  "supersededByInteractionId", "supersededByIssueId", "targetAgentId", "targetId", "targetIssueId",
  "targetRunId", "threadId", "toAgentId", "turnId", "updatedByAgentId", "updatedByUserId", "userId",
  "wakeupRunId", "watchdogAgentId", "watchdogId", "watchdogIssueId", "watchdogParentIssueId",
  "workProductId",
  // timestamps
  "archivedAt", "blockedOwnerNotifiedAt", "blockedTransitionAt", "boardMonitorNextCheckAt", "cancelledAt",
  "clearedAt", "completedAt", "createdAt", "deletedAt", "executionLockedAt", "expiresAt", "finishedAt",
  "handedOffAt", "hiddenAt", "holderStartedAt", "lastAttemptAt", "lastEventAt", "lastReadAt",
  "lastRealActivityAt", "lastTriggeredAt", "lockedAt", "monitorLastTriggeredAt", "monitorNextCheckAt",
  "monitorWakeRequestedAt", "nextCheckAt", "observedAt", "previousNextCheckAt", "resolvedAt", "retryAt",
  "startedAt", "stoppedSinceAt", "timeoutAt", "updatedAt",
  // counters
  "answeredQuestionCount", "attemptCount", "cancelledIssueCount", "changesRequestedCount", "commitCount",
  "consumedCount", "ladderedChildCount", "liveDescendantCount", "maxCount", "memberCount",
  "monitorAttemptCount", "reArmCount", "requestedChildCount", "restoredIssueCount",
]);

type MetadataScope = { topLevel: boolean; underMetadataKey: boolean };

const TOP_LEVEL: MetadataScope = { topLevel: true, underMetadataKey: false };
const NESTED: MetadataScope = { topLevel: false, underMetadataKey: false };
const NOTHING_READABLE: SummarizedIssueReadable = () => false;

/** Whether the recipient may read the issue a summary entry names. */
export type SummarizedIssueReadable = (issueId: unknown) => boolean;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A value a metadata key may carry as is; database rows carry timestamps as `Date`. */
function isScalar(value: unknown): value is string | number | boolean | null | Date {
  return value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
    || value instanceof Date;
}

/** The ids of the issues that summary lists in `record` (and its `_previous`) name. */
export function summarizedIssueIds(record: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const field of ISSUE_SUMMARY_LIST_FIELDS) {
    const list = record[field];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (isRecord(entry) && typeof entry.id === "string" && entry.id.length > 0) ids.add(entry.id);
    }
  }
  if (isRecord(record._previous)) for (const id of summarizedIssueIds(record._previous)) ids.add(id);
  return [...ids];
}

function summaryEntry(entry: unknown, summarizedIssue: SummarizedIssueReadable): unknown {
  if (!isRecord(entry) || !("title" in entry) || summarizedIssue(entry.id)) return entry;
  const { title: _title, ...rest } = entry;
  return rest;
}

/**
 * An issue event payload for a recipient that can read the issue: unchanged,
 * except that a summary entry loses its `title` when the recipient cannot read
 * the issue it names. Returns `record` itself when nothing is removed.
 */
export function withoutUnreadableSummaryTitles(
  record: Record<string, unknown>,
  summarizedIssue: SummarizedIssueReadable,
): Record<string, unknown> {
  let next: Record<string, unknown> | null = null;
  for (const field of ISSUE_SUMMARY_LIST_FIELDS) {
    const list = record[field];
    if (!Array.isArray(list)) continue;
    const visible = list.map((entry) => summaryEntry(entry, summarizedIssue));
    if (visible.some((entry, index) => entry !== list[index])) (next ??= { ...record })[field] = visible;
  }
  if (isRecord(record._previous)) {
    const previous = withoutUnreadableSummaryTitles(record._previous, summarizedIssue);
    if (previous !== record._previous) (next ??= { ...record })._previous = previous;
  }
  return next ?? record;
}

function metadataOnly(
  record: Record<string, unknown>,
  summarizedIssue: SummarizedIssueReadable,
  scope: MetadataScope,
): Record<string, unknown> {
  const visible: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (ISSUE_SUMMARY_LIST_FIELDS.has(key) && Array.isArray(value)) {
      // A summary names another issue: its title passes only when the
      // recipient can read that issue.
      visible[key] = value.filter(isRecord).map((entry) => {
        const summary = metadataOnly(entry, NOTHING_READABLE, NESTED);
        return typeof entry.title === "string" && summarizedIssue(entry.id) ? { ...summary, title: entry.title } : summary;
      });
      continue;
    }
    const metadataKey = ISSUE_METADATA_KEYS.has(key)
      || (scope.topLevel && key === "title")
      || (scope.underMetadataKey && (key === "from" || key === "to"));
    if (key === "_previous" && isRecord(value)) {
      const previous = metadataOnly(value, summarizedIssue, TOP_LEVEL);
      if (Object.keys(previous).length > 0) visible[key] = previous;
    } else if (value instanceof Date) {
      if (metadataKey) visible[key] = value;
    } else if (isRecord(value)) {
      // A nested value under a metadata key (`changes.status`) keeps its
      // `from`/`to`; under any other key only nested metadata keys remain.
      const nested = metadataOnly(value, NOTHING_READABLE, { topLevel: false, underMetadataKey: metadataKey });
      if (Object.keys(nested).length > 0) visible[key] = nested;
    } else if (Array.isArray(value)) {
      if (metadataKey && value.every(isScalar)) {
        visible[key] = value;
      } else {
        const entries = value
          .filter(isRecord)
          .map((entry) => metadataOnly(entry, NOTHING_READABLE, NESTED))
          .filter((entry) => Object.keys(entry).length > 0);
        if (entries.length > 0) visible[key] = entries;
      }
    } else if (metadataKey && isScalar(value)) {
      visible[key] = value;
    }
  }
  return visible;
}

/**
 * An issue event payload, or an issue, comment, document or activity row, for
 * a recipient that cannot read the issue. Only keys in `ISSUE_METADATA_KEYS`
 * and the top-level title pass; every other field is withheld, including the
 * content of nested objects, whose own allow-listed keys are kept. Summary
 * entries keep their id and identifier, and their title only when the
 * recipient can read the issue they name.
 */
export function issueEventMetadata(
  record: Record<string, unknown>,
  summarizedIssue: SummarizedIssueReadable,
): Record<string, unknown> {
  return metadataOnly(record, summarizedIssue, TOP_LEVEL);
}
