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
 * Releases a generation slot's link when its generation task reaches a terminal
 * status (done/cancelled). The link is cleared exactly once, here, so a terminal
 * task can no longer write to the slot (SUP-15773).
 *
 * Whether the slot completes to `idle` or `failed` is decided by GENERATION
 * IDENTITY — whether THIS generation issue is the one that wrote the slot's
 * current revision — NOT by a timestamp. `document_id` and `last_generated_at`
 * both survive across generations (`upsertSlot` never touches them), so a slot
 * that was summarised before and is then re-armed for a new, never-written
 * generation still carries the prior revision's document. A write at or before
 * this generation's creation instant can share a normalized millisecond with it,
 * so a `last_generated_at > created_at` test cannot tell an inherited prior write
 * from this generation's own write. Identity can: the slot's current revision is
 * created by a run, and that run's context snapshot names the issue that drove
 * it.
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
 * `last_generated_at` remains stamped by `write()` and is retained as a
 * supplementary signal only; it is NOT the discriminator.
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

  // True when THIS generation issue is the one that wrote the slot's current
  // (surviving) revision — i.e. the slot's document's latest revision was created
  // by a run whose context snapshot names this issue. This is the
  // generation-identity discriminator: it does not compare timestamps, so a prior
  // write and a later unwritten generation that share a normalized millisecond
  // cannot masquerade as a current-generation write. The dual-key match
  // (issueId, or nested paperclipIssue.id) mirrors run-secret-redaction's
  // run-set resolution. A slot with no document, a bare document with no
  // revision, a revision with no writing run, or a run that does not name this
  // issue all resolve to NOT written -> `failed`. Shared by both CASE branches
  // so status and failure_reason can never disagree.
  //
  // Correlated on summary_slots.document_id so each slot checks its OWN document
  // (a generation task can arm more than one slot). Postgres resolves the
  // target-table reference to its pre-UPDATE value; document_id is not modified
  // here, so that is exactly the value we want.
  const wroteThisGeneration = sql`(
    EXISTS (
      SELECT 1
      FROM ${documents} AS doc
      JOIN ${documentRevisions} AS rev ON rev.id = doc.latest_revision_id
      JOIN ${heartbeatRuns} AS hr ON hr.id = rev.created_by_run_id
      WHERE doc.id = ${summarySlots.documentId}
        AND hr.company_id = ${issue.companyId}
        AND (
          hr.context_snapshot ->> 'issueId' = ${issue.id}
          OR (hr.context_snapshot -> 'paperclipIssue') ->> 'id' = ${issue.id}
        )
    )
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
