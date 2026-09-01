import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, issues } from "@paperclipai/db";
import {
  createPullRequestMergeDetailsResolver,
  type GitHubPullRequestReference,
  type PullRequestMergeDetailsResolver,
} from "./github-pull-request-merge.js";
import { logActivity, logActivityInTransaction } from "./activity-log.js";
import type { LogActivityInput } from "./activity-log.js";

/**
 * Produce-side of the delivery-path PR work product (SUP-14645).
 *
 * There is no server-side PR-open: `deliver.sh` opens the PR and the delivery
 * path records it through the generic work-products write. This service is the
 * server-side counterpart that makes that record correct and complete:
 *
 * - `recordAtOpen` writes one `pull_request` work product (status
 *   `ready_for_review`, metadata carrying prNumber/repository/headRef/baseRef/
 *   headSha) on EVERY issue whose work rides the shared carrier branch — the
 *   carrier source issue plus its descendant tree. The row on the carrier's
 *   `sourceIssueId` is load-bearing for the delivery-state predicate; the
 *   sibling rows satisfy the "one row per issue" fan-out requirement.
 * - `refreshMergeState` re-resolves the live GitHub PR and, once merged, flips
 *   each of those rows to `status: merged` and stamps `metadata.mergedAt` and
 *   `metadata.mergeCommitSha` sourced from GitHub. That pair is what the
 *   tightened delivery predicate (SUP-14644) consumes to report
 *   `merged_via_pr`.
 *
 * Both writes are idempotent (keyed on issue + type + externalId) so the
 * delivery path and the one-shot backfill can re-run safely.
 */
export type PrDeliveryInput = {
  companyId: string;
  /** Carrier source issue; the fan-out tree is rooted here. */
  sourceIssueId: string;
  /** `owner/repo`. */
  repository: string;
  prNumber: number;
  headRef: string | null;
  baseRef: string | null;
  headSha: string | null;
  url: string;
};

export type PrRecordResult = {
  writtenIssueIds: string[];
  externalId: string;
  status: "ready_for_review";
  metadata: Record<string, unknown>;
};

export type PrRefreshRow = {
  issueId: string;
  found: boolean;
  status: string | null;
  mergedAt: string | null;
};

export type PrRefreshResult = {
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  externalId: string;
  rows: PrRefreshRow[];
};

/**
 * Live delivery-path fan-out (SUP-14645). When the delivery path records a
 * carrier PR on the source issue, the same row is written on every descendant
 * in the carrier tree so each issue owns its own `pull_request` work product.
 * The source row is written by the delivery path itself (createForIssue); this
 * mirrors it onto the descendants only.
 */
export type PrCarrierFanOutInput = {
  companyId: string;
  sourceIssueId: string;
  externalId: string;
  url: string | null;
  title: string | null;
  status: string;
  reviewState: string;
  metadata: Record<string, unknown> | null;
};

export type PrCarrierFanOutResult = {
  writtenIssueIds: string[];
  externalId: string;
};

export type PrSweepResult = {
  checked: number;
  flipped: number;
};

function referenceFromRepository(repository: string, number: number): GitHubPullRequestReference {
  const slash = repository.lastIndexOf("/");
  const owner = slash > 0 ? repository.slice(0, slash) : repository;
  const repo = slash > 0 ? repository.slice(slash + 1) : "";
  return { host: "github.com", owner, repo, number };
}

function referenceFor(input: PrDeliveryInput): GitHubPullRequestReference {
  return referenceFromRepository(input.repository, input.prNumber);
}

/**
 * Rebuild a live GitHub reference from a stored delivery row so the merge
 * sweep can re-resolve it. Prefers the delivery metadata, then the PR URL;
 * returns null when neither is usable (the row is not a resolvable PR).
 */
function referenceFromRow(row: {
  url: string | null;
  metadata: Record<string, unknown> | null;
}): GitHubPullRequestReference | null {
  const metadata = row.metadata ?? {};
  const repository =
    typeof metadata.repository === "string" && metadata.repository ? metadata.repository : null;
  const prNumber =
    typeof metadata.prNumber === "number" && Number.isInteger(metadata.prNumber)
      ? metadata.prNumber
      : null;
  if (repository && prNumber) return referenceFromRepository(repository, prNumber);
  const match = (row.url ?? "").match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (match) return referenceFromRepository(match[1], Number(match[2]));
  return null;
}

function externalIdFor(input: PrDeliveryInput): string {
  return `${input.repository}#${input.prNumber}`;
}

function openMetadata(input: PrDeliveryInput): Record<string, unknown> {
  return {
    prNumber: input.prNumber,
    repository: input.repository,
    ...(input.headRef ? { headRef: input.headRef } : {}),
    ...(input.baseRef ? { baseRef: input.baseRef } : {}),
    ...(input.headSha ? { headSha: input.headSha } : {}),
  };
}

// The merge sweep re-resolves open delivery PRs against GitHub on the heartbeat
// tick (30s cadence). This cooldown caps the live re-resolution to once per row
// in the window, so a long-open PR does not hammer the GitHub API every tick.
const PR_MERGE_SWEEP_COOLDOWN_MS = 5 * 60 * 1000;
const PR_MERGE_SWEEP_DEFAULT_LIMIT = 100;

/**
 * Build the audit entry for a pr-delivery mutation of a `pull_request` work
 * product. These writes are system-driven (the scheduled merge sweep, the
 * carrier fan-out mirror, and the one-shot backfill — none run under a request
 * actor), so they are logged under a stable `pr-delivery` system actor. The
 * entry names the affected issue (entity + issueId) so the activity feed
 * attributes the mutation to the right thread (AGENTS.md: write activity-log
 * entries for mutations).
 */
function prDeliveryActivity(
  companyId: string,
  issueId: string,
  action: string,
  details: Record<string, unknown>,
): LogActivityInput {
  return {
    companyId,
    actorType: "system",
    actorId: "pr-delivery",
    agentId: null,
    runId: null,
    action,
    entityType: "issue",
    entityId: issueId,
    issueId,
    details,
  };
}

export function prDeliveryService(
  db: Db,
  opts: { resolvePullRequestDetails?: PullRequestMergeDetailsResolver } = {},
) {
  const resolvePullRequestDetails =
    opts.resolvePullRequestDetails ?? createPullRequestMergeDetailsResolver(db);

  /**
   * Carrier delivery tree: the source issue plus every descendant, matching
   * the recursive query the delivery-state resolver uses to decide the
   * subtree-terminal gate.
   */
  async function listCarrierIssueIds(companyId: string, sourceIssueId: string): Promise<string[]> {
    if (!sourceIssueId) return [];
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          sql<boolean>`
            ${issues.id} IN (
              WITH RECURSIVE issue_tree(id) AS (
                SELECT ${issues.id}
                FROM ${issues}
                 WHERE ${issues.companyId} = ${companyId}
                   AND ${issues.id} = ${sourceIssueId}
                 UNION
                 SELECT child.id
                FROM ${issues} child
                JOIN issue_tree parent ON child.parent_id = parent.id
                WHERE child.company_id = ${companyId}
              )
              SELECT id FROM issue_tree
            )
          `,
        ),
      );
    return rows.map((row) => row.id);
  }

  async function findExistingRow(
    dbLike: Pick<Db, "select">,
    issueId: string,
    externalId: string,
  ) {
    const rows = await dbLike
      .select({
        id: issueWorkProducts.id,
        status: issueWorkProducts.status,
        metadata: issueWorkProducts.metadata,
      })
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.issueId, issueId),
          eq(issueWorkProducts.type, "pull_request"),
          eq(issueWorkProducts.externalId, externalId),
        ),
      );
    return rows[0] ?? null;
  }

  async function recordAtOpen(input: PrDeliveryInput): Promise<PrRecordResult> {
    const issueIds = await listCarrierIssueIds(input.companyId, input.sourceIssueId);
    const metadata = openMetadata(input);
    const externalId = externalIdFor(input);
    const writtenIssueIds: string[] = [];

    await db.transaction(async (tx) => {
      for (const issueId of issueIds) {
        const existing = await findExistingRow(tx, issueId, externalId);
        if (existing) {
          // A re-delivery must not downgrade a recorded merge: resetting a
          // merged row to ready_for_review would transiently flip the delivery
          // predicate from merged_via_pr back to unknown (SUP-14645). Preserve
          // merged rows; only refresh rows that are not yet merged.
          if (existing.status !== "merged") {
            await tx
              .update(issueWorkProducts)
              .set({
                status: "ready_for_review",
                url: input.url,
                metadata,
                updatedAt: new Date(),
              })
              .where(eq(issueWorkProducts.id, existing.id));
            await logActivityInTransaction(
              tx as unknown as Db,
              prDeliveryActivity(input.companyId, issueId, "issue.work_product_updated", {
                workProductId: existing.id,
                type: "pull_request",
                provider: "github",
                externalId,
                prNumber: input.prNumber,
                status: "ready_for_review",
              }),
            );
          }
        } else {
          const [inserted] = await tx
            .insert(issueWorkProducts)
            .values({
              companyId: input.companyId,
              issueId,
              type: "pull_request",
              provider: "github",
              externalId,
              title: `PR #${input.prNumber} ${input.repository}`,
              url: input.url,
              status: "ready_for_review",
              reviewState: "none",
              isPrimary: true,
              healthStatus: "unknown",
              metadata,
            })
            .returning({ id: issueWorkProducts.id });
          await logActivityInTransaction(
            tx as unknown as Db,
            prDeliveryActivity(input.companyId, issueId, "issue.work_product_created", {
              workProductId: inserted.id,
              type: "pull_request",
              provider: "github",
              externalId,
              prNumber: input.prNumber,
              status: "ready_for_review",
            }),
          );
        }
        writtenIssueIds.push(issueId);
      }
    });

    return { writtenIssueIds, externalId, status: "ready_for_review", metadata };
  }

  async function refreshMergeState(input: PrDeliveryInput): Promise<PrRefreshResult> {
    const details = await resolvePullRequestDetails(input.companyId, referenceFor(input));
    const merged = details.state === "merged";
    const mergedAt = merged ? (details.mergedAt ?? null) : null;
    const mergeCommitSha = merged ? (details.mergeCommitSha ?? null) : null;
    const externalId = externalIdFor(input);
    const issueIds = await listCarrierIssueIds(input.companyId, input.sourceIssueId);
    const rows: PrRefreshRow[] = [];

    await db.transaction(async (tx) => {
      for (const issueId of issueIds) {
        const existing = await findExistingRow(tx, issueId, externalId);
        if (!existing) {
          rows.push({ issueId, found: false, status: null, mergedAt: null });
          continue;
        }
        if (merged) {
          const nextMetadata: Record<string, unknown> = {
            prNumber: input.prNumber,
            repository: input.repository,
            ...((existing.metadata as Record<string, unknown> | null) ?? {}),
            ...(mergedAt ? { mergedAt } : {}),
            ...(mergeCommitSha ? { mergeCommitSha } : {}),
          };
          await tx
            .update(issueWorkProducts)
            .set({ status: "merged", metadata: nextMetadata, updatedAt: new Date() })
            .where(eq(issueWorkProducts.id, existing.id));
          await logActivityInTransaction(
            tx as unknown as Db,
            prDeliveryActivity(input.companyId, issueId, "issue.work_product_updated", {
              workProductId: existing.id,
              type: "pull_request",
              provider: "github",
              externalId,
              prNumber: input.prNumber,
              status: "merged",
              mergedAt,
              mergeCommitSha,
            }),
          );
        }
        rows.push({
          issueId,
          found: true,
          status: merged ? "merged" : existing.status,
          mergedAt: merged ? mergedAt : null,
        });
      }
    });

    return { merged, mergedAt, mergeCommitSha, externalId, rows };
  }

  /**
   * Live delivery-path carrier fan-out. Mirrors the source issue's delivery
   * `pull_request` row onto every descendant in the carrier tree (the source
   * row is written by the delivery path via createForIssue, not here).
   *
   * Each descendant row is secondary (isPrimary false) so recording a carrier
   * delivery does not demote a descendant's existing primary of the same type.
   * Idempotent on (issue, type, externalId) — re-delivery updates the existing
   * row instead of duplicating it.
   */
  async function recordCarrierFanOut(input: PrCarrierFanOutInput): Promise<PrCarrierFanOutResult> {
    const tree = await listCarrierIssueIds(input.companyId, input.sourceIssueId);
    const descendants = tree.filter((issueId) => issueId !== input.sourceIssueId);
    const metadata = input.metadata ?? {};
    const title = input.title ?? `PR ${input.externalId}`;
    const writtenIssueIds: string[] = [];

    await db.transaction(async (tx) => {
      for (const issueId of descendants) {
        const existing = await findExistingRow(tx, issueId, input.externalId);
        if (existing) {
          // Never downgrade a descendant's recorded merge on a re-fan (same
          // rationale as recordAtOpen: a merged row must stay merged, not reset
          // to the open-time status). Only refresh non-merged rows.
          if (existing.status !== "merged") {
            await tx
              .update(issueWorkProducts)
              .set({
                status: input.status,
                url: input.url,
                metadata,
                updatedAt: new Date(),
              })
              .where(eq(issueWorkProducts.id, existing.id));
            await logActivityInTransaction(
              tx as unknown as Db,
              prDeliveryActivity(input.companyId, issueId, "issue.work_product_updated", {
                workProductId: existing.id,
                type: "pull_request",
                provider: "github",
                externalId: input.externalId,
                status: input.status,
                carrierFanOut: true,
              }),
            );
          }
        } else {
          const [inserted] = await tx
            .insert(issueWorkProducts)
            .values({
              companyId: input.companyId,
              issueId,
              type: "pull_request",
              provider: "github",
              externalId: input.externalId,
              title,
              url: input.url,
              status: input.status,
              reviewState: input.reviewState,
              isPrimary: false,
              healthStatus: "unknown",
              metadata,
            })
            .returning({ id: issueWorkProducts.id });
          await logActivityInTransaction(
            tx as unknown as Db,
            prDeliveryActivity(input.companyId, issueId, "issue.work_product_created", {
              workProductId: inserted.id,
              type: "pull_request",
              provider: "github",
              externalId: input.externalId,
              status: input.status,
              carrierFanOut: true,
            }),
          );
        }
        writtenIssueIds.push(issueId);
      }
    });

    return { writtenIssueIds, externalId: input.externalId };
  }

  /**
   * Scheduled merge-state refresh. Re-resolves every non-merged GitHub
   * `pull_request` row that carries a delivery signature against live GitHub
   * and flips it to `status: merged` (stamping `metadata.mergedAt` and
   * `metadata.mergeCommitSha`) once GitHub reports it merged. That recorded
   * marker is what the delivery-state predicate (SUP-14644) reads to report
   * `merged_via_pr`.
   *
   * Rows are cooled down via `metadata.mergeStateCheckedAt` so an open PR is
   * re-resolved at most once per cooldown window. The scan is bounded by
   * `limit` per tick; merged rows drop out of the query entirely.
   */
  async function sweepMergeState(opts: { limit?: number } = {}): Promise<PrSweepResult> {
    const limit = opts.limit ?? PR_MERGE_SWEEP_DEFAULT_LIMIT;
    const now = Date.now();
    const rows = await db
      .select({
        id: issueWorkProducts.id,
        companyId: issueWorkProducts.companyId,
        issueId: issueWorkProducts.issueId,
        url: issueWorkProducts.url,
        metadata: issueWorkProducts.metadata,
      })
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.type, "pull_request"),
          eq(issueWorkProducts.provider, "github"),
          ne(issueWorkProducts.status, "merged"),
        ),
      )
      // Resolve the longest-un-checked rows first (mergeStateCheckedAt lives in
      // the metadata JSON; never-checked rows are NULL and sort first) so a
      // fixed set of unresolvable rows cannot occupy the `limit` slot every
      // tick and starve the rest of the fleet (SUP-14645).
      .orderBy(sql`${issueWorkProducts.metadata} ->> 'mergeStateCheckedAt' ASC NULLS FIRST`)
      .limit(limit);

    let checked = 0;
    let flipped = 0;
    for (const row of rows) {
      const reference = referenceFromRow(row);
      if (!reference) {
        // Not a resolvable PR (no repository/prNumber metadata and no usable
        // URL): stamp a check marker so it stops occupying a `limit` slot every
        // tick and the rest of the fleet keeps making progress (SUP-14645).
        await db
          .update(issueWorkProducts)
          .set({
            metadata: {
              ...((row.metadata as Record<string, unknown> | null) ?? {}),
              mergeStateCheckedAt: new Date(now).toISOString(),
            },
          })
          .where(eq(issueWorkProducts.id, row.id));
        continue;
      }

      const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
      const lastCheckedAt =
        typeof metadata.mergeStateCheckedAt === "string" ? Date.parse(metadata.mergeStateCheckedAt) : Number.NaN;
      if (Number.isFinite(lastCheckedAt) && now - lastCheckedAt < PR_MERGE_SWEEP_COOLDOWN_MS) {
        continue;
      }

      checked += 1;
      try {
        const details = await resolvePullRequestDetails(row.companyId, reference);
        const nextMetadata: Record<string, unknown> = {
          ...metadata,
          mergeStateCheckedAt: new Date(now).toISOString(),
        };
        if (details.state === "merged") {
          if (details.mergedAt) nextMetadata.mergedAt = details.mergedAt;
          if (details.mergeCommitSha) nextMetadata.mergeCommitSha = details.mergeCommitSha;
          await db
            .update(issueWorkProducts)
            .set({ status: "merged", metadata: nextMetadata, updatedAt: new Date(now) })
            .where(eq(issueWorkProducts.id, row.id));
          flipped += 1;
          await logActivity(
            db,
            prDeliveryActivity(row.companyId, row.issueId, "issue.work_product_updated", {
              workProductId: row.id,
              type: "pull_request",
              provider: "github",
              externalId: `${reference.owner}/${reference.repo}#${reference.number}`,
              status: "merged",
              mergedAt: details.mergedAt ?? null,
              mergeCommitSha: details.mergeCommitSha ?? null,
            }),
          );
        } else {
          await db
            .update(issueWorkProducts)
            .set({ metadata: nextMetadata })
            .where(eq(issueWorkProducts.id, row.id));
        }
      } catch (error) {
        // One row failing to resolve must not abort the sweep: log it and keep
        // processing the remaining rows this tick so later rows are not
        // stranded until the next heartbeat (SUP-14645).
        console.warn(
          `[pr-delivery] sweep: failed to resolve PR for work product ${row.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        // Stamp the cooldown marker even on failure, so a persistently-failing
        // row cools down instead of being re-selected every tick under
        // `NULLS FIRST` and starving the rest of the fleet (SUP-14645).
        // Best-effort: a marker failure must not abort the sweep either.
        try {
          await db
            .update(issueWorkProducts)
            .set({
              metadata: { ...metadata, mergeStateCheckedAt: new Date(now).toISOString() },
            })
            .where(eq(issueWorkProducts.id, row.id));
        } catch (stampError) {
          console.warn(
            `[pr-delivery] sweep: failed to stamp cooldown marker for work product ${row.id}: ${
              stampError instanceof Error ? stampError.message : String(stampError)
            }`,
          );
        }
      }
    }

    return { checked, flipped };
  }

  return { recordAtOpen, refreshMergeState, recordCarrierFanOut, sweepMergeState, listCarrierIssueIds };
}
