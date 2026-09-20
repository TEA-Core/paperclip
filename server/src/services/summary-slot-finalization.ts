import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  documents,
  documentRevisions,
  heartbeatRuns,
  summarySlots,
} from "@paperclipai/db";
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
 * The generation-identity discriminator shared by the terminal finalizer and the
 * dead-binding reclaim (SUP-16945): true when THIS generation issue is the one
 * that wrote the slot's current (surviving) revision — the slot's document's
 * latest revision was created by a run whose context snapshot names this issue.
 * It does not compare timestamps, so a prior write and a later unwritten
 * generation that share a normalized millisecond cannot masquerade as a
 * current-generation write (`last_generated_at` surviving across generations is
 * NOT the discriminator). The dual-key match (issueId, or nested
 * paperclipIssue.id) mirrors run-secret-redaction's run-set resolution. A slot
 * with no document, a bare document with no revision, a revision with no writing
 * run, or a run that does not name this issue all resolve to NOT written ->
 * `failed` (fail closed: regenerate).
 *
 * The identity chain is:
 *   summary_slots.document_id
 *     -> documents.latest_revision_id          (the surviving/successful revision)
 *     -> document_revisions.created_by_run_id
 *     -> heartbeat_runs.context_snapshot       (issueId / paperclipIssue.id)
 * A write can only land while the slot is armed for that generation (the write
 * guard binds the writing run to the armed issue's checkout/execution run), so
 * the surviving revision's writing run always belongs to a single generation.
 * Tracing it back to this issue therefore proves THIS generation produced the
 * current content:
 *   - a generation whose write survived completes to `idle` (fresh content);
 *   - a generation that never wrote — even when a document is inherited from a
 *     prior generation, a bare document has no revision, or the revision's
 *     writing run belongs to a different issue — surfaces as `failed` so the
 *     refresh sweep regenerates. Failing closed (regenerate) is the safe side:
 *     it can never strand a slot that was actually written.
 *
 * Correlated on summary_slots.document_id so each slot checks its OWN document
 * (a generation task can arm more than one slot). Postgres resolves the
 * target-table reference to its pre-UPDATE value; document_id is not modified
 * here, so that is exactly the value we want.
 */
function generationWroteSlotSql(companyId: string, issueId: string) {
  return sql`(
    EXISTS (
      SELECT 1
      FROM ${documents} AS doc
      JOIN ${documentRevisions} AS rev ON rev.id = doc.latest_revision_id
      JOIN ${heartbeatRuns} AS hr ON hr.id = rev.created_by_run_id
      WHERE doc.id = ${summarySlots.documentId}
        AND hr.company_id = ${companyId}
        AND (
          hr.context_snapshot ->> 'issueId' = ${issueId}
          OR (hr.context_snapshot -> 'paperclipIssue') ->> 'id' = ${issueId}
        )
    )
  )`;
}

/**
 * Releases a summary slot's generation binding: clears `generating_issue_id` and
 * completes the slot to `idle` when this generation wrote the surviving revision,
 * otherwise `failed` so the refresh sweep regenerates. The status/failure_reason
 * choice is computed in a SINGLE atomic UPDATE bound to one shared predicate, so
 * no interleaving can strand a still-linked slot in `generating`: the row is read
 * and written in one statement, and the WHERE clause only matches slots still
 * armed for this exact generation task, so an already-released slot is never
 * touched a second time.
 *
 * Shared by the terminal-transition finalizer
 * ({@link finalizeSummarySlotsForTerminalIssue}) and the dead-binding reclaim in
 * `summary-slots.ts` (SUP-16945) so both decide idle/failed by the same
 * generation identity.
 */
export async function releaseSummarySlotBinding(
  dbOrTx: Pick<Db, "update">,
  issue: Pick<TerminalGenerationIssue, "id" | "companyId">,
  failureReason: string,
  now: Date = new Date(),
): Promise<typeof summarySlots.$inferSelect[]> {
  const wroteThisGeneration = generationWroteSlotSql(issue.companyId, issue.id);
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
    .returning();
}

/**
 * Releases a generation slot's link when its generation task reaches a terminal
 * status (done/cancelled). The link is cleared exactly once, here, so a terminal
 * task can no longer write to the slot (SUP-15773).
 */
export async function finalizeSummarySlotsForTerminalIssue(
  dbOrTx: Pick<Db, "update">,
  issue: TerminalGenerationIssue,
) {
  if (!TERMINAL_ISSUE_STATUSES.has(issue.status)) return [];
  const rows = await releaseSummarySlotBinding(dbOrTx, issue, failureReasonForIssue(issue));
  return rows.map((row) => ({ id: row.id }));
}
