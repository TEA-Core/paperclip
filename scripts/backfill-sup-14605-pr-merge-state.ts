import { eq } from "drizzle-orm";
import { createDb, issues } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { prDeliveryService } from "../server/src/services/pr-delivery.js";

/**
 * One-shot backfill for the SUP-14605 four-child single-carrier fixture
 * (SUP-14645).
 *
 * The PR-CARRIER-6b fixture's delivery PR (TEA-Core/Trading-Signal-Platform#
 * 3417) was merged by hand, but `deliver.sh` never wrote the `pull_request`
 * work product, so the five carrier issues (SUP-14605 + its four children)
 * sat at `unmerged` with zero work products. This records the merged delivery
 * row on every issue in the carrier tree, sourcing `mergedAt` and the merge
 * commit SHA live from GitHub, so the tightened delivery predicate (SUP-14644)
 * can read `merged_via_pr` on each.
 *
 * Idempotent: re-running re-resolves and re-stamps the same rows.
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-sup-14605-pr-merge-state.ts \
 *     [--source-issue <uuid>] [--repository <owner/repo>] [--pr-number <n>] \
 *     [--head-ref <ref>] [--base-ref <ref>] [--head-sha <sha>] [--url <url>] \
 *     [--dry-run]
 */

const SUP_14605 = "d380faef-c7b1-48cd-82f2-b875e43996d1";
const PR_URL = "https://github.com/TEA-Core/Trading-Signal-Platform/pull/3417";

function parseFlag(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

async function main() {
  const sourceIssueId = parseFlag("--source-issue", SUP_14605)!;
  const repository = parseFlag("--repository", "TEA-Core/Trading-Signal-Platform")!;
  const prNumber = Number(parseFlag("--pr-number", "3417")!);
  const headRef = parseFlag("--head-ref", null);
  const baseRef = parseFlag("--base-ref", null);
  const headSha = parseFlag("--head-sha", null);
  const url = parseFlag("--url", PR_URL)!;
  const dryRun = process.argv.includes("--dry-run");

  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  const [sourceIssue] = await db
    .select({ companyId: issues.companyId, title: issues.title })
    .from(issues)
    .where(eq(issues.id, sourceIssueId));
  if (!sourceIssue) {
    console.error(`Source issue not found: ${sourceIssueId}`);
    process.exitCode = 1;
    return;
  }
  const companyId = sourceIssue.companyId;
  const service = prDeliveryService(db);

  const tree = await service.listCarrierIssueIds(companyId, sourceIssueId);
  console.log(`Carrier ${repository}#${prNumber}`);
  console.log(`Company: ${companyId}`);
  console.log(`Carrier tree (${tree.length} issues): ${tree.join(", ")}`);

  if (dryRun) {
    console.log("Dry run: no writes performed.");
    return;
  }

  const input = { companyId, sourceIssueId, repository, prNumber, headRef, baseRef, headSha, url };
  const recorded = await service.recordAtOpen(input);
  console.log(`Recorded ready_for_review rows on ${recorded.writtenIssueIds.length} issues.`);

  const refreshed = await service.refreshMergeState(input);
  console.log(
    `Merge state: ${refreshed.merged ? "merged" : "NOT merged"} ` +
    `(mergedAt=${refreshed.mergedAt ?? "n/a"}, mergeCommitSha=${refreshed.mergeCommitSha ?? "n/a"})`,
  );
  for (const row of refreshed.rows) {
    console.log(`  ${row.issueId}: found=${row.found} status=${row.status ?? "n/a"}`);
  }

  if (!refreshed.merged) {
    console.error("PR did not resolve as merged; rows were left untouched. Nothing stamped.");
    process.exitCode = 1;
    return;
  }
  console.log("Backfill complete.");
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`SUP-14605 PR merge-state backfill failed: ${message}`);
  process.exitCode = 1;
});
