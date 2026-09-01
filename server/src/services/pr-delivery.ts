import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, issues } from "@paperclipai/db";
import {
  createPullRequestMergeDetailsResolver,
  type GitHubPullRequestReference,
  type PullRequestMergeDetailsResolver,
} from "./github-pull-request-merge.js";

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

function referenceFor(input: PrDeliveryInput): GitHubPullRequestReference {
  const slash = input.repository.lastIndexOf("/");
  const owner = slash > 0 ? input.repository.slice(0, slash) : input.repository;
  const repo = slash > 0 ? input.repository.slice(slash + 1) : "";
  return { host: "github.com", owner, repo, number: input.prNumber };
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
                UNION ALL
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
          await tx
            .update(issueWorkProducts)
            .set({
              status: "ready_for_review",
              url: input.url,
              metadata,
              updatedAt: new Date(),
            })
            .where(eq(issueWorkProducts.id, existing.id));
        } else {
          await tx.insert(issueWorkProducts).values({
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
          });
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

  return { recordAtOpen, refreshMergeState, listCarrierIssueIds };
}
