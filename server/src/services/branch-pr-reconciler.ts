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
 * The marker alone bounds only per-TICK work, never the steady-state query rate.
 * Observed on a production instance, 2026-09-25: 653 candidates, `limit` 50, a sweep every 30s —
 * so a full cycle took ~6.5 min against a flat 5 min cooldown. Every row was
 * therefore always due again by the time its turn came round: `rateLimited` was 0
 * on 120 consecutive sweeps and the reconciler sustained ~6,000 GitHub calls an
 * hour, above GitHub's 5,000/hr authenticated ceiling, with nothing ever leaving
 * the candidate set (a branch with no merged PR records nothing, so it stays a
 * candidate forever).
 *
 * So the cooldown is per-row and EXPONENTIAL, keyed on
 * `metadata.branchPrReconcileMissStreak`: the base window doubles with each
 * consecutive unproductive outcome and is capped at 24h, and the streak resets to
 * 0 the moment a product is recorded. Rows that will never resolve become
 * geometrically cheaper to carry while a branch whose PR merges later is still
 * picked up within a day. Because the marker is stamped on every outcome, a
 * backed-off row also sorts to the BACK of the `ASC NULLS FIRST` cursor, so it
 * stops consuming a `limit` slot ahead of genuinely due rows.
 *
 * Counters are reported as separate fields: `created` (recorded a new product),
 * `skipped` (branch checked, had no merged PR — nothing recorded), and
 * `rateLimited` (within the per-workspace cooldown window; GitHub not
 * re-queried this tick). `skipped` here is a distinct local counter and never
 * touches the reaper's `skippedUndelivered`.
 */

const COOLDOWN_KEY = "branchPrReconcileCheckedAt";
const MISS_STREAK_KEY = "branchPrReconcileMissStreak";
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_LIMIT = 50;
/**
 * Ceiling on the backed-off window. A row is never abandoned: however many times
 * it has come back unproductive, it is re-probed at least once a day, so a branch
 * whose PR is merged long after the fact is still picked up.
 */
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Guard against `2 ** streak` overflowing to Infinity on a corrupt/absurd counter. */
const MAX_BACKOFF_EXPONENT = 32;

/** Consecutive unproductive outcomes recorded on a row, or 0 when absent/corrupt. */
function readMissStreak(metadata: Record<string, unknown> | null): number {
  const raw = metadata?.[MISS_STREAK_KEY];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

/**
 * Effective cooldown for a row: the base window doubled once per consecutive
 * unproductive outcome, capped at `MAX_COOLDOWN_MS`.
 *
 * A FLAT cooldown only bounds per-tick work, never the steady-state query rate:
 * once the candidate backlog is large enough that a full cycle takes longer than
 * the window, every row is always due again when its turn comes and the sweep
 * probes at full rate forever. Backoff bounds the rate instead, because the rows
 * that will never resolve become geometrically cheaper to carry.
 */
function effectiveCooldownMs(baseCooldownMs: number, missStreak: number): number {
  const exponent = Math.min(missStreak, MAX_BACKOFF_EXPONENT);
  return Math.min(baseCooldownMs * 2 ** exponent, MAX_COOLDOWN_MS);
}

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

  /**
   * Stamps the per-workspace cooldown marker and the consecutive-miss counter that
   * drives the backoff, preserving any existing metadata. Best-effort: a marker
   * failure must not abort the sweep.
   *
   * `nextMissStreak` is 0 on a productive outcome (a product was recorded) and the
   * incremented streak on every unproductive one (no merged PR, no token, probe or
   * record error) — those are exactly the outcomes that must get cheaper to retry.
   */
  async function stampCooldown(row: CandidateRow, nowMs: number, nextMissStreak: number): Promise<void> {
    const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
    try {
      await db
        .update(executionWorkspaces)
        .set({
          metadata: {
            ...metadata,
            [COOLDOWN_KEY]: new Date(nowMs).toISOString(),
            [MISS_STREAK_KEY]: nextMissStreak,
          },
        })
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
        await stampCooldown(row, nowMs, readMissStreak(row.metadata) + 1);
        continue;
      }

      // Per-workspace cooldown: within the window, do not re-query GitHub. The
      // window widens with the row's consecutive-miss streak, so a backlog of
      // permanently unresolvable rows cannot pin the sweep at full query rate.
      const missStreak = readMissStreak(row.metadata);
      const rowCooldownMs = effectiveCooldownMs(cooldownMs, missStreak);
      const lastCheckedAt =
        typeof row.metadata?.[COOLDOWN_KEY] === "string"
          ? Date.parse(row.metadata[COOLDOWN_KEY] as string)
          : Number.NaN;
      if (Number.isFinite(lastCheckedAt) && nowMs - lastCheckedAt < rowCooldownMs) {
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
        await stampCooldown(row, nowMs, missStreak + 1);
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
        await stampCooldown(row, nowMs, missStreak + 1);
        result.failed += 1;
        continue;
      }

      if (!probe.hasMergedPr || probe.mergedPrNumber === null) {
        // The branch has no merged PR: record nothing, cool the row down and widen
        // its window, since this is the outcome that repeats forever on a row whose
        // branch will never carry a merged PR.
        await stampCooldown(row, nowMs, missStreak + 1);
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
        // Productive outcome: clear the streak so a healed row returns to the base cadence.
        await stampCooldown(row, nowMs, 0);
        if (recorded.writtenIssueIds.length > 0) result.created += 1;
        else result.skipped += 1;
      } catch (error) {
        logger.warn(
          { err: error, workspaceId: row.id, branch: row.branchName },
          "branch-to-merged-PR reconciler: failed to record pull_request work product; will retry next sweep",
        );
        await stampCooldown(row, nowMs, missStreak + 1);
        result.failed += 1;
      }
    }

    return result;
  }

  return { sweep };
}
