import { describe, expect, it, vi } from "vitest";
import type { PrRecordResult, PrRefreshResult } from "../server/src/services/pr-delivery.js";

import {
  formatRecord,
  formatSummary,
  parseBatchInput,
  resolveExitCode,
  runBatch,
  type BatchDeps,
  type BatchRecord,
  type BatchSummary,
} from "./backfill-pr-merge-state-batch.js";

const REPO = "TEA-Core/Trading-Signal-Platform";
const PR = 3417;
const EXTERNAL_ID = `${REPO}#${PR}`;
const URL = `https://github.com/${REPO}/pull/${PR}`;
const SRC = "d380faef-c7b1-48cd-82f2-b875e43996d1";
const SRC_B = "11111111-2222-3333-4444-555555555555";

function record(over: Partial<BatchRecord> = {}): BatchRecord {
  return { sourceIssueId: SRC, repository: REPO, prNumber: PR, url: URL, ...over };
}

function mergedRefresh(): PrRefreshResult {
  return {
    merged: true,
    mergedAt: "2026-08-31T17:26:58Z",
    mergeCommitSha: "3fc37fe91c6190ab695a651224ad057db0a38aba",
    externalId: EXTERNAL_ID,
    rows: [{ issueId: SRC, found: true, status: "merged", mergedAt: "2026-08-31T17:26:58Z" }],
  };
}

function recordedOn(ids: string[]): PrRecordResult {
  return { writtenIssueIds: ids, externalId: EXTERNAL_ID, status: "ready_for_review", metadata: {} };
}

type SpyDeps = BatchDeps & {
  resolveCompanyId: ReturnType<typeof vi.fn>;
  listCarrierIssueIds: ReturnType<typeof vi.fn>;
  recordAtOpen: ReturnType<typeof vi.fn>;
  refreshMergeState: ReturnType<typeof vi.fn>;
  existingMergedOnSource: ReturnType<typeof vi.fn>;
};

function mockDeps(over: Partial<SpyDeps> = {}): SpyDeps {
  return {
    resolveCompanyId: vi.fn(async () => "company-1"),
    listCarrierIssueIds: vi.fn(async () => [SRC]),
    recordAtOpen: vi.fn(async () => recordedOn([SRC])),
    refreshMergeState: vi.fn(async () => mergedRefresh()),
    existingMergedOnSource: vi.fn(async () => false),
    ...over,
  };
}

describe("parseBatchInput", () => {
  it("accepts a JSON array of records and normalizes them", () => {
    const result = parseBatchInput(JSON.stringify([record()]));
    if ("fatal" in result) throw new Error(`unexpected fatal: ${result.fatal}`);
    expect(result.invalid).toHaveLength(0);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ sourceIssueId: SRC, repository: REPO, prNumber: PR, url: URL });
  });

  it("accepts an object with a records array", () => {
    const result = parseBatchInput(
      JSON.stringify({ records: [record(), record({ sourceIssueId: SRC_B, prNumber: 42, url: "https://github.com/o/r/pull/42" })] }),
    );
    if ("fatal" in result) throw new Error(`unexpected fatal: ${result.fatal}`);
    expect(result.records).toHaveLength(2);
  });

  it("is fatal on non-JSON input", () => {
    expect(parseBatchInput("not json")).toMatchObject({ fatal: expect.stringContaining("not valid JSON") });
  });

  it("is fatal on an object without a records array", () => {
    expect(parseBatchInput(JSON.stringify({ foo: 1 }))).toMatchObject({ fatal: expect.any(String) });
  });

  it("is fatal on an empty batch", () => {
    expect(parseBatchInput("[]")).toMatchObject({ fatal: expect.any(String) });
  });

  it("keeps valid records and reports invalid ones by index", () => {
    const result = parseBatchInput(
      JSON.stringify([record(), { sourceIssueId: SRC, repository: "no-slash", prNumber: PR, url: URL }]),
    );
    if ("fatal" in result) throw new Error(`unexpected fatal: ${result.fatal}`);
    expect(result.records).toHaveLength(1);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].index).toBe(1);
    expect(result.invalid[0].reason).toMatch(/repository must be owner\/repo/);
  });

  it("rejects a non-integer prNumber", () => {
    const result = parseBatchInput(JSON.stringify([{ ...record(), prNumber: "3417" }] as unknown as string));
    if ("fatal" in result) throw new Error(`unexpected fatal: ${result.fatal}`);
    expect(result.records).toHaveLength(0);
    expect(result.invalid[0].reason).toMatch(/prNumber/);
  });

  it("rejects a non-UUID sourceIssueId", () => {
    const result = parseBatchInput(JSON.stringify([{ ...record(), sourceIssueId: "not-a-uuid" }]));
    if ("fatal" in result) throw new Error(`unexpected fatal: ${result.fatal}`);
    expect(result.records).toHaveLength(0);
    expect(result.invalid[0].reason).toMatch(/UUID/);
  });
});

describe("runBatch", () => {
  it("processes every record in one run and classifies fresh records as created", async () => {
    const deps = mockDeps();
    const { results, summary } = await runBatch([record(), record({ sourceIssueId: SRC_B, label: "b" })], deps);
    expect(deps.recordAtOpen).toHaveBeenCalledTimes(2);
    expect(deps.refreshMergeState).toHaveBeenCalledTimes(2);
    expect(results.every((r) => r.outcome === "created")).toBe(true);
    expect(summary.created).toBe(2);
    expect(summary.alreadyPresent).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.unexpectedFailure).toBe(false);
    expect(results[0].externalId).toBe(EXTERNAL_ID);
  });

  it("classifies records whose merged marker already exists as already_present and exits 0 (idempotent re-run)", async () => {
    const deps = mockDeps({ existingMergedOnSource: vi.fn(async () => true) });
    const { results, summary } = await runBatch([record()], deps);
    expect(results[0].outcome).toBe("already_present");
    expect(summary.alreadyPresent).toBe(1);
    expect(summary.created).toBe(0);
    expect(resolveExitCode(summary)).toBe(0);
  });

  it("marks a PR GitHub reports as not-merged as failed but not an unexpected failure (exit 0)", async () => {
    const deps = mockDeps({
      refreshMergeState: vi.fn(async (): Promise<PrRefreshResult> => ({ merged: false, mergedAt: null, mergeCommitSha: null, externalId: EXTERNAL_ID, rows: [] })),
    });
    const { results, summary } = await runBatch([record()], deps);
    expect(results[0].outcome).toBe("failed");
    expect(results[0].reason).toBe("pr_not_merged");
    expect(summary.failed).toBe(1);
    expect(summary.unexpectedFailure).toBe(false);
    expect(resolveExitCode(summary)).toBe(0);
  });

  it("marks a missing source issue as failed but not an unexpected failure (exit 0)", async () => {
    const deps = mockDeps({ resolveCompanyId: vi.fn(async () => null) });
    const { results, summary } = await runBatch([record()], deps);
    expect(results[0].outcome).toBe("failed");
    expect(results[0].reason).toBe("source_issue_not_found");
    expect(deps.recordAtOpen).not.toHaveBeenCalled();
    expect(summary.failed).toBe(1);
    expect(summary.unexpectedFailure).toBe(false);
    expect(resolveExitCode(summary)).toBe(0);
  });

  it("marks a throwing service call as an unexpected failure (exit 1) but keeps processing later records", async () => {
    let calls = 0;
    const deps = mockDeps({
      refreshMergeState: vi.fn(async (): Promise<PrRefreshResult> => {
        calls += 1;
        if (calls === 1) throw new Error("transient GitHub API failure");
        return mergedRefresh();
      }),
    });
    const { results, summary } = await runBatch([record(), record({ sourceIssueId: SRC_B })], deps);
    expect(results[0].outcome).toBe("failed");
    expect(results[0].reason).toMatch(/^error:/);
    expect(results[1].outcome).toBe("created");
    expect(summary.failed).toBe(1);
    expect(summary.created).toBe(1);
    expect(summary.unexpectedFailure).toBe(true);
    expect(resolveExitCode(summary)).toBe(1);
  });

  it("dry-run reports intended writes without calling any write/refresh path", async () => {
    const deps = mockDeps({ listCarrierIssueIds: vi.fn(async () => [SRC, "child-id"]) });
    const { results, summary } = await runBatch([record()], deps, { dryRun: true });
    expect(results[0].outcome).toBe("planned");
    expect(results[0].carrierIssueCount).toBe(2);
    expect(deps.recordAtOpen).not.toHaveBeenCalled();
    expect(deps.refreshMergeState).not.toHaveBeenCalled();
    expect(summary.dryRun).toBe(true);
    expect(summary.planned).toBe(1);
    expect(summary.created).toBe(0);
    expect(resolveExitCode(summary)).toBe(0);
  });
});

describe("resolveExitCode", () => {
  function mk(over: Partial<BatchSummary> = {}): BatchSummary {
    return { total: 1, created: 0, alreadyPresent: 0, failed: 1, planned: 0, dryRun: false, unexpectedFailure: false, ...over };
  }
  it("returns 0 when only expected data outcomes failed", () => {
    expect(resolveExitCode(mk({ unexpectedFailure: false }))).toBe(0);
  });
  it("returns 1 on an unexpected failure", () => {
    expect(resolveExitCode(mk({ unexpectedFailure: true }))).toBe(1);
  });
});

describe("formatRecord / formatSummary (shape smoke)", () => {
  // Guard against regressions where a record with no detail still prints a
  // readable line.
  it("renders a failed line with its reason", () => {
    const line = formatRecord({ sourceIssueId: SRC, externalId: EXTERNAL_ID, outcome: "failed", reason: "pr_not_merged" });
    expect(line).toContain("failed");
    expect(line).toContain("pr_not_merged");
    expect(formatSummary({ total: 1, created: 0, alreadyPresent: 0, failed: 1, planned: 0, dryRun: false, unexpectedFailure: false })).toContain("failed: 1");
  });
});
