import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  githubBranchHasMergedPr,
  type BranchMergedPrProbe,
} from "./done-transition-guard.js";
import { parseRepoUrl } from "./merge-arming.js";
import {
  isGitHubTokenResolution,
  resolveGitHubTokenForRepo,
  type GitHubTokenResult,
} from "./github-credential.js";
import { prDeliveryService, type PrDeliveryInput } from "./pr-delivery.js";

/**
 * WS-ARCHIVE T4 — server-side branch-to-merged-PR reconciler sweep.
 *
 * The reaper gate (`skippedUndelivered` in execution-workspaces.ts) can only
 * archive a workspace when its source issue owns a `pull_request` work product
 * with a delivery signature. A workspace whose PR was opened and merged through
 * a path that never recorded that product leaves the gate blind and the
 * workspace stuck `active` forever. This sweep fills that gap on the server.
 *
 * Candidate set: `active` execution workspaces that have a `repoUrl`, a
 * `branchName`, and a `sourceIssueId`, whose source issue does NOT yet own a
 * `pull_request` work product. For each candidate it asks GitHub, keyed STRICTLY
 * on the workspace's own branch (`head={owner}:{branchName}` — never on an issue
 * identifier, so a merged PR that landed on another card's branch is never
 * attributed here), whether a merged PR exists on that branch. When one does, it
 * records the product through `recordAtOpen` (the same delivery path T3 proves
 * works), writing it on the source issue and the carrier tree; the existing PR
 * merge-state sweep then flips it to `merged` so the delivery predicate reads
 * `merged_via_pr`.
 *
 * Rate-limited and cursor-marked so it cannot re-query the whole backlog every
 * tick: each candidate carries a cooldown marker in
 * `execution_workspaces.metadata.branchPrReconcileCheckedAt`, the same
 * cooldown-marker discipline `sweepMergeState` uses. The candidate query orders
 * by that marker (`ASC NULLS FIRST`) and is bounded by `limit`, so a fixed set
 * of unresolvable workspaces cools down instead of starving the fleet. The
 * marker is stamped on every probe outcome — including failure — so a
 * persistently-unresolvable row stops occupying a `limit` slot.
 *
 * Counters are reported as separate fields: `created` (recorded a new product),
 * `skipped` (branch checked, had no merged PR — nothing recorded), and
 * `rateLimited` (within the per-workspace cooldown window; GitHub not
 * re-queried this tick). `skipped` here is a distinct local counter and never
 * touches the reaper's `skippedUndelivered`.
 */

const COOLDOWN_KEY = "branchPrReconcileCheckedAt";
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_LIMIT = 50;

export interface BranchPrReconcilerSweepResult {
  /** Rows in the candidate set this tick (repo + branch + source, no existing pull_request product); equals rateLimited + created + skipped + failed. */
  candidates: number;
  /** New pull_request work products recorded from a merged PR on the workspace's own branch. */
  created: number;
  /** Branch checked and had no merged PR — nothing recorded. */
  skipped: number;
  /** Within the per-workspace cooldown window; GitHub not re-queried this tick. */
  rateLimited: number;
  /** Unparseable repo, no token resolvable, or probe/record error. */
  failed: number;
}

export interface BranchPrReconcilerSweepOptions {
  /** Milliseconds before a given workspace's branch is re-probed. Defaults to 5 min (matches the PR merge-state sweep). */
  cooldownMs?: number;
  /** Max candidate workspaces inspected per tick. Defaults to 50. */
  limit?: number;
  now?: () => Date;
  /** Probe a branch for a merged PR. Defaults to the widened done-transition-guard primitive. */
  probeBranchMergedPr?: (args: {
    hostname: string;
    owner: string;
    repo: string;
    branch: string;
    token: string;
  }) => Promise<BranchMergedPrProbe>;
  /** Resolve a GitHub token for a company + repo. Defaults to `resolveGitHubTokenForRepo`. */
  resolveToken?: (args: {
    companyId: string;
    owner: string;
    repo: string;
  }) => Promise<GitHubTokenResult>;
  /** Record a delivery-path pull_request work product. Defaults to `prDeliveryService(db).recordAtOpen`. */
  recordAtOpen?: (input: PrDeliveryInput) => Promise<{ writtenIssueIds: string[] }>;
}

interface CandidateRow {
  id: string;
  companyId: string;
  sourceIssueId: string | null;
  repoUrl: string | null;
  baseRef: string | null;
  branchName: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Builds the branch-to-merged-PR reconciler. `sweep` is meant to be fired by the
 * heartbeat tick; the per-workspace cooldown gate makes re-queries cheap.
 */
export function createBranchPrReconcilerSweepService(
  db: Db,
  opts: BranchPrReconcilerSweepOptions = {},
) {
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const now = opts.now ?? (() => new Date());
  const probeBranchMergedPr: (args: {
    hostname: string;
    owner: string;
    repo: string;
    branch: string;
    token: string;
  }) => Promise<BranchMergedPrProbe> =
    opts.probeBranchMergedPr ??
    ((args) =>
      githubBranchHasMergedPr(args.hostname, args.owner, args.repo, args.branch, args.token));
  const resolveToken =
    opts.resolveToken ??
    ((args: { companyId: string; owner: string; repo: string }) =>
      resolveGitHubTokenForRepo(db, args.companyId, args.owner, args.repo));
  const recordAtOpen = opts.recordAtOpen ?? prDeliveryService(db).recordAtOpen;

  /** Stamps the per-workspace cooldown marker, preserving any existing metadata. Best-effort: a marker failure must not abort the sweep. */
  async function stampCooldown(row: CandidateRow, nowMs: number): Promise<void> {
    const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
    try {
      await db
        .update(executionWorkspaces)
        .set({ metadata: { ...metadata, [COOLDOWN_KEY]: new Date(nowMs).toISOString() } })
        .where(eq(executionWorkspaces.id, row.id));
    } catch (error) {
      logger.warn(
        { err: error, workspaceId: row.id },
        "branch-to-merged-PR reconciler: failed to stamp cooldown marker; will retry next sweep",
      );
    }
  }

  async function sweep(): Promise<BranchPrReconcilerSweepResult> {
    const nowMs = now().getTime();
    const result: BranchPrReconcilerSweepResult = {
      candidates: 0,
      created: 0,
      skipped: 0,
      rateLimited: 0,
      failed: 0,
    };

    // Active workspaces that have a repo + branch + source but whose source
    // issue does not yet own a pull_request work product (idempotent when a
    // product already exists: it drops out of the candidate set entirely).
    // Ordered by the cooldown marker so the longest-un-checked workspaces are
    // probed first and never-checked ones are not starved by a fixed set of
    // unresolvable rows.
    const rows = await db
      .select({
        id: executionWorkspaces.id,
        companyId: executionWorkspaces.companyId,
        sourceIssueId: executionWorkspaces.sourceIssueId,
        repoUrl: executionWorkspaces.repoUrl,
        baseRef: executionWorkspaces.baseRef,
        branchName: executionWorkspaces.branchName,
        metadata: executionWorkspaces.metadata,
      })
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.status, "active"),
          isNotNull(executionWorkspaces.repoUrl),
          isNotNull(executionWorkspaces.branchName),
          isNotNull(executionWorkspaces.sourceIssueId),
          sql`NOT EXISTS (
            SELECT 1
            FROM issue_work_products
            WHERE issue_work_products.issue_id = ${executionWorkspaces.sourceIssueId}
              AND issue_work_products.type = 'pull_request'
          )`,
        ),
      )
      .orderBy(sql`${executionWorkspaces.metadata} ->> 'branchPrReconcileCheckedAt' ASC NULLS FIRST`)
      .limit(limit);

    for (const row of rows) {
      result.candidates += 1;

      const parsed = parseRepoUrl(row.repoUrl);
      if (!parsed || !row.branchName || !row.sourceIssueId) {
        result.failed += 1;
        await stampCooldown(row, nowMs);
        continue;
      }

      // Per-workspace cooldown: within the window, do not re-query GitHub.
      const lastCheckedAt =
        typeof row.metadata?.[COOLDOWN_KEY] === "string"
          ? Date.parse(row.metadata[COOLDOWN_KEY] as string)
          : Number.NaN;
      if (Number.isFinite(lastCheckedAt) && nowMs - lastCheckedAt < cooldownMs) {
        result.rateLimited += 1;
        continue;
      }

      const tokenResult = await resolveToken({
        companyId: row.companyId,
        owner: parsed.owner,
        repo: parsed.repo,
      });
      if (!isGitHubTokenResolution(tokenResult)) {
        logger.warn(
          { workspaceId: row.id, reason: tokenResult.reason },
          "branch-to-merged-PR reconciler: no GitHub token resolvable; will retry next sweep",
        );
        await stampCooldown(row, nowMs);
        result.failed += 1;
        continue;
      }

      let probe: BranchMergedPrProbe;
      try {
        probe = await probeBranchMergedPr({
          hostname: parsed.hostname,
          owner: parsed.owner,
          repo: parsed.repo,
          branch: row.branchName,
          token: tokenResult.token,
        });
      } catch (error) {
        logger.warn(
          { err: error, workspaceId: row.id, branch: row.branchName },
          "branch-to-merged-PR reconciler: merged-PR probe failed; will retry next sweep",
        );
        await stampCooldown(row, nowMs);
        result.failed += 1;
        continue;
      }

      if (!probe.hasMergedPr || probe.mergedPrNumber === null) {
        // The branch has no merged PR: record nothing, cool the row down.
        await stampCooldown(row, nowMs);
        result.skipped += 1;
        continue;
      }

      const repository = probe.mergedPrRepository ?? `${parsed.owner}/${parsed.repo}`;
      try {
        const recorded = await recordAtOpen({
          companyId: row.companyId,
          sourceIssueId: row.sourceIssueId,
          repository,
          prNumber: probe.mergedPrNumber,
          headRef: row.branchName,
          baseRef: row.baseRef,
          headSha: null,
          url: `https://${parsed.hostname}/${repository}/pull/${probe.mergedPrNumber}`,
        });
        await stampCooldown(row, nowMs);
        if (recorded.writtenIssueIds.length > 0) result.created += 1;
        else result.skipped += 1;
      } catch (error) {
        logger.warn(
          { err: error, workspaceId: row.id, branch: row.branchName },
          "branch-to-merged-PR reconciler: failed to record pull_request work product; will retry next sweep",
        );
        await stampCooldown(row, nowMs);
        result.failed += 1;
      }
    }

    return result;
  }

  return { sweep };
}
