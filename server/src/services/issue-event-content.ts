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
 * Metadata keys whose scalar values a recipient that cannot read the issue may
 * still receive: identifiers, states, enums, counters and timestamps. Every
 * other key is withheld.
 */
const METADATA_KEYS = new Set([
  "id",
  "identifier",
  "status",
  "previousStatus",
  "priority",
  "kind",
  "action",
  "type",
  "source",
  "outcome",
  "format",
  "key",
  "revision",
  "revisionNumber",
  "seq",
  "ts",
  "truncated",
  "phase",
  "stream",
  "level",
  "color",
  "eventType",
  "errorCode",
  "invocationSource",
  "triggerDetail",
  "currentToolName",
  "interactionKind",
  "interactionStatus",
  "prState",
  "provider",
  "adapterType",
  "headSha",
  "workingNow",
]);

/** Identifier, key, timestamp and counter keys (`agentId`, `labelIds`, `childIdentifiers`, `documentKey`, `updatedAt`, `attemptCount`). */
const METADATA_KEY_PATTERN = /(?:Id|Ids|Identifier|Identifiers|Key|At|Count)$/;

type MetadataScope = { topLevel: boolean; underMetadataKey: boolean };

const TOP_LEVEL: MetadataScope = { topLevel: true, underMetadataKey: false };
const NESTED: MetadataScope = { topLevel: false, underMetadataKey: false };
const NOTHING_READABLE: SummarizedIssueReadable = () => false;

/** Whether the recipient may read the issue a summary entry names. */
export type SummarizedIssueReadable = (issueId: unknown) => boolean;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
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
    const metadataKey = METADATA_KEYS.has(key)
      || METADATA_KEY_PATTERN.test(key)
      || (scope.topLevel && key === "title")
      || (scope.underMetadataKey && (key === "from" || key === "to"));
    if (key === "_previous" && isRecord(value)) {
      const previous = metadataOnly(value, summarizedIssue, TOP_LEVEL);
      if (Object.keys(previous).length > 0) visible[key] = previous;
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
 * An issue event payload for a recipient that cannot read the issue. Only
 * metadata passes (identifiers, states, enums, counters, timestamps, and the
 * top-level title); every other field is withheld, including the content of
 * nested objects, whose own metadata keys are kept. Summary entries keep their
 * id and identifier, and their title only when the recipient can read the
 * issue they name.
 */
export function issueEventMetadata(
  record: Record<string, unknown>,
  summarizedIssue: SummarizedIssueReadable,
): Record<string, unknown> {
  return metadataOnly(record, summarizedIssue, TOP_LEVEL);
}
