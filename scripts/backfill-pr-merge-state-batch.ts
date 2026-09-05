import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type {
  PrDeliveryInput,
  PrRecordResult,
  PrRefreshResult,
} from "../server/src/services/pr-delivery.js";

/**
 * Batch backfill of `pull_request` work products for already-merged PRs
 * (WS-ARCHIVE T3).
 *
 * Generalizes the one-pair SUP-14605 backfill into a driver over a BATCH of
 * "workspace source issue -> merged PR" pairs. Each record carries the
 * workspace's source issue — the id the terminal-workspace reaper reads its
 * `pull_request` work product from (execution-workspaces.ts:1490) — plus the
 * `owner/repo`, PR number, and URL of a genuinely merged PR.
 *
 * For every record the driver drives `prDeliveryService.recordAtOpen` (writes
 * the `pull_request` work product on the source issue and its carrier
 * descendants) then `refreshMergeState` (stamps `status: "merged"` and
 * `metadata.mergedAt` / `metadata.mergeCommitSha` sourced from GitHub). That
 * merged marker is the sole input to the reaper's `merged_via_pr` verdict, so
 * after a run the reaper's `sweepTerminalWorkspaces` can archive these
 * workspaces on a later tick.
 *
 * Idempotent: both service writes are keyed on (issue, type, externalId), so a
 * second run over the same input refreshes the same rows and creates no
 * duplicates (exit 0).
 *
 * Out of scope here (see the issue envelope): auto-discovering the pairs from
 * GitHub (T4), the reaper gate, and deliver.sh (T2).
 *
 * Exit codes: 0 when the batch runs to completion (a per-record data outcome —
 * not-yet-merged PR, missing source issue, invalid record — is reported in the
 * summary but is not itself a failure of the run); 1 only on an unexpected
 * failure (unreadable/unparseable input, infra-level error, or a record whose
 * service call threw).
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-pr-merge-state-batch.ts --input <batch.json> [--dry-run]
 *
 * The input file is a JSON array of records (or `{ "records": [...] }`):
 *   [ { "sourceIssueId": "<uuid>", "repository": "owner/repo",
 *       "prNumber": 3417, "url": "https://github.com/owner/repo/pull/3417" } ]
 */

export type BatchRecord = {
  sourceIssueId: string;
  repository: string;
  prNumber: number;
  url: string;
  headRef?: string | null;
  baseRef?: string | null;
  headSha?: string | null;
  label?: string;
};

export type BatchParseFailure = { index: number; reason: string };
export type BatchParseResult =
  | { fatal: string }
  | { records: BatchRecord[]; invalid: BatchParseFailure[] };

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function externalIdFor(repository: string, prNumber: number): string {
  return `${repository}#${prNumber}`;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalRef(value: unknown): string | null {
  return isNonBlankString(value) ? value.trim() : null;
}

function normalizeRecord(
  item: unknown,
  index: number,
): { ok: true; record: BatchRecord } | { ok: false; reason: string } {
  if (typeof item !== "object" || item === null) {
    return { ok: false, reason: `record ${index} is not an object` };
  }
  const record = item as Record<string, unknown>;
  if (!isNonBlankString(record.sourceIssueId)) {
    return { ok: false, reason: `record ${index}: sourceIssueId must be a non-empty string` };
  }
  const sourceIssueId = record.sourceIssueId.trim();
  if (!UUID_PATTERN.test(sourceIssueId)) {
    return { ok: false, reason: `record ${index}: sourceIssueId must be a UUID, got: ${sourceIssueId}` };
  }
  const repository = isNonBlankString(record.repository) ? record.repository.trim() : "";
  if (!REPOSITORY_PATTERN.test(repository)) {
    return { ok: false, reason: `record ${index}: repository must be owner/repo, got: ${String(record.repository ?? "")}` };
  }
  const prNumber = record.prNumber;
  if (typeof prNumber !== "number" || !Number.isInteger(prNumber) || prNumber <= 0) {
    return { ok: false, reason: `record ${index}: prNumber must be a positive integer, got: ${String(prNumber)}` };
  }
  if (!isNonBlankString(record.url)) {
    return { ok: false, reason: `record ${index}: url must be a non-empty string` };
  }
  return {
    ok: true,
    record: {
      sourceIssueId,
      repository,
      prNumber,
      url: record.url.trim(),
      headRef: optionalRef(record.headRef),
      baseRef: optionalRef(record.baseRef),
      headSha: optionalRef(record.headSha),
      label: isNonBlankString(record.label) ? record.label.trim() : undefined,
    },
  };
}

export function parseBatchInput(text: string): BatchParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { fatal: `input is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  let items: unknown[];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (
    typeof parsed === "object" &&
    parsed !== null &&
    Array.isArray((parsed as Record<string, unknown>).records)
  ) {
    items = (parsed as Record<string, unknown>).records as unknown[];
  } else {
    return { fatal: 'input must be a JSON array of records, or an object with a "records" array' };
  }
  if (items.length === 0) {
    return { fatal: "input contains no records" };
  }
  const records: BatchRecord[] = [];
  const invalid: BatchParseFailure[] = [];
  items.forEach((item, index) => {
    const result = normalizeRecord(item, index);
    if (result.ok) records.push(result.record);
    else invalid.push({ index, reason: result.reason });
  });
  return { records, invalid };
}

export type BatchOutcome = "created" | "already_present" | "failed" | "planned";

export type BatchRecordResult = {
  sourceIssueId: string;
  label?: string;
  externalId: string;
  outcome: BatchOutcome;
  reason?: string;
  carrierIssueCount?: number;
  writtenIssueIds?: string[];
  merged?: boolean;
  mergedAt?: string | null;
};

export type BatchSummary = {
  total: number;
  created: number;
  alreadyPresent: number;
  failed: number;
  planned: number;
  dryRun: boolean;
  unexpectedFailure: boolean;
};

export type BatchDeps = {
  resolveCompanyId: (sourceIssueId: string) => Promise<string | null>;
  listCarrierIssueIds: (companyId: string, sourceIssueId: string) => Promise<string[]>;
  recordAtOpen: (input: PrDeliveryInput) => Promise<PrRecordResult>;
  refreshMergeState: (input: PrDeliveryInput) => Promise<PrRefreshResult>;
  existingMergedOnSource: (companyId: string, sourceIssueId: string, externalId: string) => Promise<boolean>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runBatch(
  records: BatchRecord[],
  deps: BatchDeps,
  options: { dryRun?: boolean } = {},
): Promise<{ results: BatchRecordResult[]; summary: BatchSummary }> {
  const dryRun = options.dryRun ?? false;
  const results: BatchRecordResult[] = [];
  const summary: BatchSummary = {
    total: records.length,
    created: 0,
    alreadyPresent: 0,
    failed: 0,
    planned: 0,
    dryRun,
    unexpectedFailure: false,
  };

  for (const record of records) {
    const externalId = externalIdFor(record.repository, record.prNumber);
    let companyId: string | null;
    try {
      companyId = await deps.resolveCompanyId(record.sourceIssueId);
    } catch {
      companyId = null;
    }
    if (!companyId) {
      results.push({ sourceIssueId: record.sourceIssueId, label: record.label, externalId, outcome: "failed", reason: "source_issue_not_found" });
      summary.failed += 1;
      continue;
    }

    let hadMerged = false;
    try {
      hadMerged = await deps.existingMergedOnSource(companyId, record.sourceIssueId, externalId);
    } catch {
      // A pre-check read failure is not fatal to the write path; treat as
      // "unknown whether present" and let the real run decide the outcome.
      hadMerged = false;
    }

    if (dryRun) {
      let carrierIssueCount: number;
      try {
        carrierIssueCount = (await deps.listCarrierIssueIds(companyId, record.sourceIssueId)).length;
      } catch (error) {
        results.push({ sourceIssueId: record.sourceIssueId, label: record.label, externalId, outcome: "failed", reason: `error: ${messageOf(error)}`, merged: false });
        summary.failed += 1;
        summary.unexpectedFailure = true;
        continue;
      }
      results.push({ sourceIssueId: record.sourceIssueId, label: record.label, externalId, outcome: "planned", carrierIssueCount, merged: hadMerged });
      summary.planned += 1;
      continue;
    }

    try {
      const input: PrDeliveryInput = {
        companyId,
        sourceIssueId: record.sourceIssueId,
        repository: record.repository,
        prNumber: record.prNumber,
        headRef: record.headRef ?? null,
        baseRef: record.baseRef ?? null,
        headSha: record.headSha ?? null,
        url: record.url,
      };
      const recorded = await deps.recordAtOpen(input);
      const refreshed = await deps.refreshMergeState(input);
      if (!refreshed.merged) {
        results.push({ sourceIssueId: record.sourceIssueId, label: record.label, externalId, outcome: "failed", reason: "pr_not_merged", writtenIssueIds: recorded.writtenIssueIds, merged: false, mergedAt: refreshed.mergedAt });
        summary.failed += 1;
      } else if (hadMerged) {
        results.push({ sourceIssueId: record.sourceIssueId, label: record.label, externalId, outcome: "already_present", writtenIssueIds: recorded.writtenIssueIds, merged: true, mergedAt: refreshed.mergedAt });
        summary.alreadyPresent += 1;
      } else {
        results.push({ sourceIssueId: record.sourceIssueId, label: record.label, externalId, outcome: "created", writtenIssueIds: recorded.writtenIssueIds, merged: true, mergedAt: refreshed.mergedAt });
        summary.created += 1;
      }
    } catch (error) {
      results.push({ sourceIssueId: record.sourceIssueId, label: record.label, externalId, outcome: "failed", reason: `error: ${messageOf(error)}`, merged: false });
      summary.failed += 1;
      summary.unexpectedFailure = true;
    }
  }

  return { results, summary };
}

export function resolveExitCode(summary: BatchSummary): number {
  return summary.unexpectedFailure ? 1 : 0;
}

export function formatSummary(summary: BatchSummary): string {
  const lines: string[] = [];
  lines.push(summary.dryRun ? "Dry run: no writes performed." : "Backfill run complete.");
  lines.push(`  total: ${summary.total}`);
  if (summary.dryRun) {
    lines.push(`  planned: ${summary.planned}`);
  } else {
    lines.push(`  created: ${summary.created}`);
    lines.push(`  already-present: ${summary.alreadyPresent}`);
  }
  lines.push(`  failed: ${summary.failed}`);
  if (summary.unexpectedFailure) lines.push("  unexpected failure: yes (exit 1)");
  return lines.join("\n");
}

export function formatRecord(result: BatchRecordResult): string {
  const tag = result.label ? `${result.label} ` : "";
  let detail = "";
  if (result.outcome === "planned") {
    detail = `would write/refresh on ${result.carrierIssueCount ?? 0} carrier issue(s), ${result.merged ? "marker already present" : "would add merged marker"}`;
  } else if (result.outcome === "created") {
    detail = `created on ${result.writtenIssueIds?.length ?? 0} issue(s)`;
  } else if (result.outcome === "already_present") {
    detail = "merged marker already present";
  } else if (result.outcome === "failed") {
    detail = `failed (${result.reason})`;
  }
  return `${tag}${result.sourceIssueId} ${result.externalId}: ${result.outcome}${detail ? ` — ${detail}` : ""}`;
}

function printHelp(): void {
  console.log(
    [
      "Usage: backfill-pr-merge-state-batch.ts --input <batch.json> [--dry-run]",
      "",
      "Records the merged `pull_request` work product on a batch of already-merged PRs",
      "so the terminal-workspace reaper can archive their execution workspaces.",
      "",
      "  --input <file>   JSON array of records, or { \"records\": [...] }",
      "                   each: { sourceIssueId, repository, prNumber, url",
      "                           [headRef, baseRef, headSha, label] }",
      "  --dry-run        report intended writes without writing",
      "  --help           show this help",
      "",
      "A single already-known pair is just a one-record array.",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): { inputPath: string | null; dryRun: boolean; help: boolean } {
  const help = argv.includes("--help") || argv.includes("-h");
  const dryRun = argv.includes("--dry-run");
  const inputIndex = argv.indexOf("--input");
  if (inputIndex < 0) return { inputPath: null, dryRun, help };
  const inputPath = argv[inputIndex + 1] ?? null;
  if (!inputPath || inputPath.startsWith("--")) {
    throw new Error("--input must be followed by a file path");
  }
  return { inputPath, dryRun, help };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.inputPath) {
    console.error("Missing --input <batch.json>. Run with --help for usage.");
    process.exitCode = 1;
    return;
  }

  let text: string;
  try {
    text = await readFile(args.inputPath, "utf8");
  } catch (error) {
    console.error(`Could not read input file ${args.inputPath}: ${messageOf(error)}`);
    process.exitCode = 1;
    return;
  }

  const parsed = parseBatchInput(text);
  if ("fatal" in parsed) {
    console.error(parsed.fatal);
    process.exitCode = 1;
    return;
  }
  for (const entry of parsed.invalid) {
    console.error(`  skipping ${entry.reason}`);
  }
  if (parsed.records.length === 0) {
    console.error(`No valid records to process (${parsed.invalid.length} invalid).`);
    process.exitCode = 1;
    return;
  }

  // Heavy deps are loaded lazily so the pure orchestration above can be unit
  // tested without pulling drizzle/postgres/the @paperclipai graph into the
  // import (those are only reachable under `pnpm exec tsx` from the repo root).
  const { loadConfig } = await import("../server/src/config.js");
  const { createDb, issueWorkProducts, issues } = await import("../packages/db/src/index.js");
  const { prDeliveryService } = await import("../server/src/services/pr-delivery.js");
  const { and, eq } = await import("drizzle-orm");

  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  try {
    const service = prDeliveryService(db);
    const companyIdCache = new Map<string, string | null>();
    const deps: BatchDeps = {
      resolveCompanyId: async (sourceIssueId) => {
        const cached = companyIdCache.get(sourceIssueId);
        if (cached !== undefined) return cached;
        const [issue] = await db
          .select({ companyId: issues.companyId })
          .from(issues)
          .where(eq(issues.id, sourceIssueId));
        const value = issue ? issue.companyId : null;
        companyIdCache.set(sourceIssueId, value);
        return value;
      },
      listCarrierIssueIds: (companyId, sourceIssueId) => service.listCarrierIssueIds(companyId, sourceIssueId),
      recordAtOpen: (input) => service.recordAtOpen(input),
      refreshMergeState: (input) => service.refreshMergeState(input),
      existingMergedOnSource: async (companyId, sourceIssueId, externalId) => {
        const rows = await db
          .select({ status: issueWorkProducts.status, metadata: issueWorkProducts.metadata })
          .from(issueWorkProducts)
          .where(
            and(
              eq(issueWorkProducts.companyId, companyId),
              eq(issueWorkProducts.issueId, sourceIssueId),
              eq(issueWorkProducts.type, "pull_request"),
              eq(issueWorkProducts.externalId, externalId),
            ),
          );
        return rows.some((row) => row.status === "merged" && isNonBlankString(row.metadata?.mergedAt));
      },
    };

    const { results, summary } = await runBatch(parsed.records, deps, { dryRun: args.dryRun });
    for (const result of results) {
      console.log(formatRecord(result));
    }
    console.log("");
    console.log(formatSummary(summary));
    process.exitCode = resolveExitCode(summary);
  } finally {
    await db.$client.end();
  }
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  process.argv[1].length > 0 &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  void main().catch((error) => {
    console.error(`PR merge-state batch backfill failed: ${messageOf(error)}`);
    process.exitCode = 1;
  });
}
