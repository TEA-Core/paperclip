import { and, eq, isNull, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

/**
 * Converts saved text to a uuid only when it already has the canonical lowercase
 * spelling that `uuid::text` produces. Anything else yields NULL, so a malformed
 * identifier matches nothing instead of raising a cast error, and PostgreSQL's
 * wider uuid spellings (uppercase, braces, no dashes) stay unmatched exactly as
 * the text comparison they replace left them.
 */
export function canonicalExecutionUuid(text: SQL): SQL<string | null> {
  return sql<string | null>`case when ${text} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (${text})::uuid end`;
}

/**
 * A run belongs to an issue through its native binding, which takes precedence,
 * or, only when that binding is absent, through the legacy context issue id.
 *
 * This is the indexable form of
 * `coalesce(native_issue_id::text, context_snapshot->>'issueId') = <issue>`.
 * Each arm can use an existing index (the company native issue contract index and
 * the `context_snapshot->>'issueId'` expression index), where the coalesce
 * expression is covered by none and forces a read of every terminal run's JSON.
 *
 * `issue.uuid` must be a uuid-typed expression for the issue (NULL when it is not
 * canonical) and `issue.text` the same issue as text.
 */
export function runBoundToIssue(issue: { uuid: SQLWrapper; text: SQL }): SQL {
  return or(
    eq(heartbeatRuns.nativeIssueId, issue.uuid),
    and(isNull(heartbeatRuns.nativeIssueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.text}`),
  )!;
}

/** `runBoundToIssue` for an issue id supplied as text, which may not be a uuid. */
export function runBoundToIssueId(issueId: string): SQL {
  return runBoundToIssue({ uuid: canonicalExecutionUuid(sql`${issueId}::text`), text: sql`${issueId}` });
}
