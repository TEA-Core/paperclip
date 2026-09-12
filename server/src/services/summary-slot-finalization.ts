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
  createdAt: Date;
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
 * Whether the slot completes to `idle` or `failed` is decided by whether THIS
 * generation produced a revision — NOT merely whether a document exists.
 * `document_id` and `last_generated_at` both survive across generations
 * (`upsertSlot` never touches them), so a slot that was summarised before and is
 * then re-armed for a new, never-written generation still carries the prior
 * revision's document and timestamp. The discriminator is that the latest write
 * (`last_generated_at`, stamped only by `write()`) happened at or after this
 * generation task was created: a write can only target the currently-armed
 * generation, so any earlier timestamp belongs to a previous generation.
 *   - a generation that wrote a revision completes to `idle` (fresh content);
 *   - a generation that never wrote — even when a document is inherited from a
 *     prior generation — surfaces as `failed` so the refresh sweep regenerates.
 *
 * The status/failure_reason choice is computed in a SINGLE atomic UPDATE bound to
 * one shared predicate, so no interleaving can strand a still-terminal-linked
 * slot in `generating`: the row is read and written in one statement, and the
 * WHERE clause only matches slots still armed for this exact generation task, so
 * an already-finalized slot is never touched a second time.
 */
export async function finalizeSummarySlotsForTerminalIssue(
  dbOrTx: Pick<Db, "update">,
  issue: TerminalGenerationIssue,
) {
  if (!TERMINAL_ISSUE_STATUSES.has(issue.status)) return [];

  const now = new Date();
  const failureReason = failureReasonForIssue(issue);

  // True when THIS generation wrote a revision: the most recent write
  // (last_generated_at, stamped only by write()) happened at or after this
  // generation task was created. A write can only target the currently-armed
  // generation, so an earlier timestamp belongs to a prior generation and must
  // not mark this one as having written. Shared by both CASE branches so the
  // status and failure_reason can never disagree.
  //
  // Bound as an ISO string (not a raw Date): drizzle serializes Dates in `.set()`
  // but a Date interpolated into a raw `sql` fragment reaches the driver as a
  // Date object, which its text serializer rejects. Postgres casts the literal
  // to timestamptz for the `>=` comparison.
  const createdBeforeOrAt = new Date(issue.createdAt).toISOString();
  const wroteThisGeneration = sql`(
    ${summarySlots.lastGeneratedAt} IS NOT NULL
    AND ${summarySlots.lastGeneratedAt} >= ${createdBeforeOrAt}
  )`;

  return dbOrTx
    .update(summarySlots)
    .set({
      status: sql`CASE WHEN ${wroteThisGeneration} THEN 'idle' ELSE 'failed' END`,
      failureReason: sql`CASE WHEN ${wroteThisGeneration} THEN NULL ELSE ${failureReason} END`,
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
