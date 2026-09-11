import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { summarySlots } from "@paperclipai/db";
import type { IssueStatus } from "@paperclipai/shared";

const TERMINAL_ISSUE_STATUSES = new Set<IssueStatus>(["done", "cancelled"]);

interface TerminalGenerationIssue {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
}

function failureReasonForIssue(issue: TerminalGenerationIssue) {
  const label = issue.identifier ? `${issue.identifier}: ${issue.title}` : issue.title;
  return issue.status === "cancelled"
    ? `Summary generation task ${label} was cancelled before writing a summary.`
    : `Summary generation task ${label} finished without writing a summary.`;
}

/**
 * Releases a generation slot's link when its generation task reaches a terminal
 * status (done/cancelled). The link is cleared exactly once, here, so a terminal
 * task can no longer write to the slot (SUP-15773).
 *
 * The status/failure_reason choice is computed in a SINGLE atomic UPDATE. Both
 * values are bound to the same `document_id` read inside a row-level CASE, so no
 * interleaving between two statements can strand a still-terminal-linked slot in
 * `generating`: the row is read and written in one statement, and the WHERE clause
 * only matches slots that are still armed for this exact generation task, so an
 * already-finalized slot is never touched a second time.
 *   - a slot that holds a written summary completes to `idle` (the last written
 *     revision is the content to show);
 *   - a slot that never produced a revision surfaces as `failed` so the refresh
 *     sweep can regenerate it.
 */
export async function finalizeSummarySlotsForTerminalIssue(
  dbOrTx: Pick<Db, "update">,
  issue: TerminalGenerationIssue,
) {
  if (!TERMINAL_ISSUE_STATUSES.has(issue.status)) return [];

  const now = new Date();
  const failureReason = failureReasonForIssue(issue);

  return dbOrTx
    .update(summarySlots)
    .set({
      status: sql`CASE WHEN ${summarySlots.documentId} IS NOT NULL THEN 'idle' ELSE 'failed' END`,
      failureReason: sql`CASE WHEN ${summarySlots.documentId} IS NOT NULL THEN NULL ELSE ${failureReason} END`,
      generatingIssueId: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(summarySlots.companyId, issue.companyId),
        eq(summarySlots.generatingIssueId, issue.id),
        eq(summarySlots.status, "generating"),
      ),
    )
    .returning({ id: summarySlots.id });
}
