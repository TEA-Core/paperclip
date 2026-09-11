import { and, eq, isNull, isNotNull } from "drizzle-orm";
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
 * Releases a generation slot's link when its generation task reaches a
 * terminal status (done/cancelled). The link is cleared exactly once, here, so
 * a terminal task can no longer write to the slot (SUP-15773). The resulting
 * status reflects whether a usable summary already exists:
 *   - a slot that holds a written summary completes to `idle` (the last
 *     written revision is the content to show);
 *   - a slot that never produced a revision surfaces as `failed` so the
 *     refresh sweep can regenerate it.
 */
export async function finalizeSummarySlotsForTerminalIssue(
  dbOrTx: Pick<Db, "update">,
  issue: TerminalGenerationIssue,
) {
  if (!TERMINAL_ISSUE_STATUSES.has(issue.status)) return [];

  const now = new Date();

  const withDocument = await dbOrTx
    .update(summarySlots)
    .set({ status: "idle", failureReason: null, generatingIssueId: null, updatedAt: now })
    .where(
      and(
        eq(summarySlots.companyId, issue.companyId),
        eq(summarySlots.generatingIssueId, issue.id),
        eq(summarySlots.status, "generating"),
        isNotNull(summarySlots.documentId),
      ),
    )
    .returning({ id: summarySlots.id });

  const withoutDocument = await dbOrTx
    .update(summarySlots)
    .set({
      status: "failed",
      failureReason: failureReasonForIssue(issue),
      generatingIssueId: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(summarySlots.companyId, issue.companyId),
        eq(summarySlots.generatingIssueId, issue.id),
        eq(summarySlots.status, "generating"),
        isNull(summarySlots.documentId),
      ),
    )
    .returning({ id: summarySlots.id });

  return [...withDocument, ...withoutDocument];
}
