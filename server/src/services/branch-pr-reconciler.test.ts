import { describe, expect, it, vi } from "vitest";
import {
  createBranchPrReconcilerSweepService,
  type BranchPrReconcilerSweepResult,
} from "./branch-pr-reconciler.js";
import type { BranchMergedPrProbe } from "./done-transition-guard.js";

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type ProbeArgs = {
  hostname: string;
  owner: string;
  repo: string;
  branch: string;
  token: string;
};

interface Candidate {
  id: string;
  companyId: string;
  sourceIssueId: string | null;
  repoUrl: string | null;
  baseRef: string | null;
  branchName: string | null;
  metadata: Record<string, unknown> | null;
}

/** Fixed clock so the cooldown window is deterministic. */
const NOW = Date.parse("2026-09-04T00:00:00Z");
const nowFn = () => new Date(NOW);
/** ISO timestamp `msAgo` milliseconds before the pinned clock. */
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/**
 * Mock db matching the reconciler's two query shapes:
 * - `select(...).from().where().orderBy().limit()` → returns the next "page" of
 *   candidate rows (so successive sweeps can see a shrinking candidate set).
 * - `update(table).set(obj).where()` → captured, for asserting cooldown markers.
 */
function makeDb(pages: Candidate[][]) {
  const updates: Array<{ set: Record<string, unknown> }> = [];
  let selectCalls = 0;
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => {
              const idx = Math.min(selectCalls, pages.length - 1);
              selectCalls += 1;
              return Promise.resolve(pages[idx]);
            },
          }),
        }),
      }),
    })),
    update: vi.fn(() => ({
      set: (setObj: Record<string, unknown>) => ({
        where: () => {
          updates.push({ set: setObj });
          return Promise.resolve([]);
        },
      }),
    })),
  };
  return { db, updates };
}

function row(overrides: Partial<Candidate> & { id: string }): Candidate {
  return {
    companyId: "company-1",
    sourceIssueId: "src-1",
    repoUrl: "https://github.com/o/r",
    baseRef: "main",
    branchName: "branch-1",
    metadata: null,
    ...overrides,
  };
}

function makeProbe(impl: (args: ProbeArgs) => Promise<BranchMergedPrProbe>) {
  return vi.fn(impl);
}

const tokenOk = () =>
  ({ token: "tok", scope: "company" as const, secretName: "github_token" });

describe("createBranchPrReconcilerSweepService", () => {
  it("reports created / skipped / rate-limited as separate counters and only probes un-cooled branches", async () => {
    const probe = makeProbe(async (a) =>
      a.branch === "a-branch"
        ? { hasMergedPr: true, mergedPrNumber: 42, mergedPrRepository: "o/r" }
        : { hasMergedPr: false, mergedPrNumber: null, mergedPrRepository: null },
    );
    const recordAtOpen = vi.fn(async () => ({ writtenIssueIds: ["src-a"] }));
    const pages = [
      [
        row({ id: "w-a", sourceIssueId: "src-a", branchName: "a-branch" }),
        row({ id: "w-b", sourceIssueId: "src-b", branchName: "b-branch" }),
        // Just checked: within the cooldown window → rate-limited, no probe.
        row({ id: "w-c", sourceIssueId: "src-c", branchName: "c-branch", metadata: { branchPrReconcileCheckedAt: iso(1000) } }),
      ],
    ];
    const { db, updates } = makeDb(pages);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen,
      now: nowFn,
    });

    const result = await service.sweep();

    expect(result).toEqual<BranchPrReconcilerSweepResult>({
      candidates: 3,
      created: 1,
      skipped: 1,
      rateLimited: 1,
      failed: 0,
    });
    const probed = probe.mock.calls.map((c) => (c[0] as ProbeArgs).branch).sort();
    expect(probed).toEqual(["a-branch", "b-branch"]);
    expect(recordAtOpen).toHaveBeenCalledTimes(1);
    // Cooldown marker stamped for the two probed rows (a: created, b: skipped), not the cooled row c.
    expect(updates).toHaveLength(2);
  });

  it("keys the probe and the recorded product strictly on the workspace's own branch", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: true,
      mergedPrNumber: 42,
      mergedPrRepository: "o/r",
    }));
    const recordAtOpen = vi.fn(async () => ({ writtenIssueIds: ["src-a"] }));
    const { db } = makeDb([[row({ id: "w-a", sourceIssueId: "src-a", branchName: "a-branch" })]]);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen,
      now: nowFn,
    });

    await service.sweep();

    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "github.com", owner: "o", repo: "r", branch: "a-branch" }),
    );
    expect(recordAtOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceIssueId: "src-a",
        repository: "o/r",
        prNumber: 42,
        headRef: "a-branch",
        baseRef: "main",
        url: "https://github.com/o/r/pull/42",
      }),
    );
  });

  it("records nothing when the branch has no merged PR, and cools the row down", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: false,
      mergedPrNumber: null,
      mergedPrRepository: null,
    }));
    const recordAtOpen = vi.fn(async () => ({ writtenIssueIds: ["src-b"] }));
    const { db, updates } = makeDb([[row({ id: "w-b", sourceIssueId: "src-b", branchName: "b-branch" })]]);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen,
      now: nowFn,
    });

    const result = await service.sweep();

    expect(result).toEqual({ candidates: 1, created: 0, skipped: 1, rateLimited: 0, failed: 0 });
    expect(recordAtOpen).not.toHaveBeenCalled();
    // The cooldown marker was still stamped so the row does not re-probe every tick.
    const stamped = updates.find((u) => {
      const md = u.set.metadata as Record<string, unknown> | null;
      return typeof md?.branchPrReconcileCheckedAt === "string";
    });
    expect(stamped).toBeDefined();
  });

  it("rate-limits every candidate once its cooldown marker is within the window", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: true,
      mergedPrNumber: 42,
      mergedPrRepository: "o/r",
    }));
    const recordAtOpen = vi.fn(async () => ({ writtenIssueIds: ["src-a"] }));
    // Every row carries a fresh marker → all within the cooldown window.
    const cooled = [
      row({ id: "w-a", sourceIssueId: "src-a", branchName: "a-branch", metadata: { branchPrReconcileCheckedAt: iso(0) } }),
      row({ id: "w-b", sourceIssueId: "src-b", branchName: "b-branch", metadata: { branchPrReconcileCheckedAt: iso(0) } }),
    ];
    const { db } = makeDb([cooled]);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen,
      now: nowFn,
    });

    const result = await service.sweep();

    expect(result).toEqual({ candidates: 2, created: 0, skipped: 0, rateLimited: 2, failed:0 });
    expect(probe).not.toHaveBeenCalled();
    expect(recordAtOpen).not.toHaveBeenCalled();
  });

  it("counts a missing GitHub token as failed and does not probe", async () => {
    const probe = makeProbe(async () => ({ hasMergedPr: true, mergedPrNumber: 1, mergedPrRepository: "o/r" }));
    const recordAtOpen = vi.fn(async () => ({ writtenIssueIds: ["src-a"] }));
    const { db, updates } = makeDb([[row({ id: "w-a", sourceIssueId: "src-a", branchName: "a-branch" })]]);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => ({ token: null, reason: "No GitHub token resolvable" })),
      recordAtOpen,
      now: nowFn,
    });

    const result = await service.sweep();

    expect(result).toEqual({ candidates: 1, created: 0, skipped: 0, rateLimited: 0, failed: 1 });
    expect(probe).not.toHaveBeenCalled();
    expect(recordAtOpen).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
  });

  it("counts a throwing probe as failed without aborting the sweep", async () => {
    const probe = makeProbe(async () => {
      throw new Error("boom");
    });
    const recordAtOpen = vi.fn(async () => ({ writtenIssueIds: ["src-a"] }));
    const { db } = makeDb([
      [
        row({ id: "w-a", sourceIssueId: "src-a", branchName: "a-branch" }),
        row({ id: "w-b", sourceIssueId: "src-b", branchName: "b-branch", metadata: { branchPrReconcileCheckedAt: iso(0) } }),
      ],
    ]);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen,
      now: nowFn,
    });

    const result = await service.sweep();

    expect(result).toEqual({ candidates: 2, created: 0, skipped: 0, rateLimited: 1, failed: 1 });
    expect(recordAtOpen).not.toHaveBeenCalled();
  });

  it("is idempotent: once the product exists the workspace leaves the candidate set and is not re-recorded", async () => {
    const probe = makeProbe(async () => ({ hasMergedPr: true, mergedPrNumber: 42, mergedPrRepository: "o/r" }));
    const recordAtOpen = vi.fn(async () => ({ writtenIssueIds: ["src-a"] }));
    // First sweep sees the workspace; the second sees no candidates (the pull_request
    // product now exists, so NOT EXISTS excludes it).
    const { db } = makeDb([
      [row({ id: "w-a", sourceIssueId: "src-a", branchName: "a-branch" })],
      [],
    ]);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen,
      now: nowFn,
    });

    const first = await service.sweep();
    const second = await service.sweep();

    expect(first.created).toBe(1);
    expect(second).toEqual({ candidates: 0, created: 0, skipped: 0, rateLimited: 0, failed: 0 });
    expect(recordAtOpen).toHaveBeenCalledTimes(1);
  });
});
