/** Content of the event's own issue that only a reader of that issue may receive. */
const OWN_ISSUE_CONTENT_FIELDS = ["description", "bodySnippet", "quote"] as const;

/** Issue document events also carry the document's own `title`. */
const ISSUE_DOCUMENT_CONTENT_FIELDS = [...OWN_ISSUE_CONTENT_FIELDS, "title"] as const;

/** Lists of other-issue summaries; each entry carries that issue's `title`. */
const ISSUE_SUMMARY_LIST_FIELDS = [
  "addedReferencedIssues",
  "removedReferencedIssues",
  "currentReferencedIssues",
  "blockedByIssues",
  "addedBlockedByIssues",
  "removedBlockedByIssues",
] as const;

export interface IssueContentReadability {
  /** Whether the recipient may read the issue the event is about. */
  ownIssue: boolean;
  /** Whether the recipient may read the issue a summary entry names. */
  summarizedIssue: (issueId: unknown) => boolean;
}

/**
 * Whether an activity action (`issue.document_created`) or plugin event type
 * (`issue.document.created`) describes an issue document, whose `title` is
 * document content rather than the issue's own title.
 */
export function isIssueDocumentEvent(action: unknown): boolean {
  return typeof action === "string" && action.replaceAll(".", "_").startsWith("issue_document_");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/**
 * An issue event payload without the issue content its recipient may not read:
 * the own issue's description, comment snippet and document quote (and, on a
 * document event, the document title) when the own issue is unreadable, and
 * the title of each summarized issue that is unreadable.
 * Identifiers and other metadata stay. Returns `record` itself when nothing is
 * removed.
 */
export function withoutUnreadableIssueContent(
  record: Record<string, unknown>,
  readable: IssueContentReadability,
  documentEvent: boolean,
): Record<string, unknown> {
  let next: Record<string, unknown> | null = null;
  const edit = () => (next ??= { ...record });
  if (!readable.ownIssue) {
    for (const field of documentEvent ? ISSUE_DOCUMENT_CONTENT_FIELDS : OWN_ISSUE_CONTENT_FIELDS) {
      if (field in record) delete edit()[field];
    }
  }
  for (const field of ISSUE_SUMMARY_LIST_FIELDS) {
    const list = record[field];
    if (!Array.isArray(list)) continue;
    let changed = false;
    const visible = list.map((entry) => {
      if (!isRecord(entry) || !("title" in entry) || readable.summarizedIssue(entry.id)) return entry;
      changed = true;
      const { title: _title, ...rest } = entry;
      return rest;
    });
    if (changed) edit()[field] = visible;
  }
  if (isRecord(record._previous)) {
    const previous = withoutUnreadableIssueContent(record._previous, readable, documentEvent);
    if (previous !== record._previous) edit()._previous = previous;
  }
  return next ?? record;
}
