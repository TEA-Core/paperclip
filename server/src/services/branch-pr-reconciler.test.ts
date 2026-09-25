import { readFile } from "node:fs/promises";

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
  const requestedLimits: number[] = [];
  let selectCalls = 0;
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            // Honour the requested limit. Ignoring it would let a test pass while
            // the sweep asked for the wrong number of rows, which is exactly the
            // bound the probe budget depends on.
            limit: (requestedLimit: number) => {
              const idx = Math.min(selectCalls, pages.length - 1);
              selectCalls += 1;
              const page = pages[idx];
              requestedLimits.push(requestedLimit);
              return Promise.resolve(
                typeof requestedLimit === "number" ? page.slice(0, requestedLimit) : page,
              );
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
  return { db, updates, requestedLimits };
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

  /**
   * Production defect (2026-09-25): the candidate set held 653 rows and the
   * sweep fired every 30s with limit 50, so a full cycle took ~6.5 min — LONGER than
   * the flat 5 min cooldown. Every row was therefore always out of cooldown when it
   * came round again: `rateLimited` was 0 on 120/120 sweeps and the reconciler issued
   * a steady 6,000 GitHub calls/hour, above GitHub's 5,000/hr authenticated ceiling.
   * A flat cooldown cannot bound the steady-state rate when the backlog outgrows it;
   * only a per-row backoff can, because it makes an unproductive row cheaper over time.
   */
  it("backs a persistently unproductive row off exponentially so a large backlog cannot outrun the cooldown", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: false,
      mergedPrNumber: null,
      mergedPrRepository: null,
    }));
    // Marker is 6 minutes old: outside the 5 min BASE cooldown, but the row has already
    // come back "no merged PR" four times, so its effective window is 5 * 2^4 = 80 min.
    const backedOff = [
      row({
        id: "w-a",
        sourceIssueId: "src-a",
        branchName: "a-branch",
        metadata: { branchPrReconcileCheckedAt: iso(6 * 60 * 1000), branchPrReconcileMissStreak: 4 },
      }),
    ];
    const { db } = makeDb([backedOff]);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen: vi.fn(async () => ({ writtenIssueIds: [] })),
      now: nowFn,
    });

    const result = await service.sweep();

    expect(result).toEqual({ candidates: 1, created: 0, skipped: 0, rateLimited: 1, failed: 0 });
    expect(probe).not.toHaveBeenCalled();
  });

  it("increments the miss streak when a probed branch has no merged PR", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: false,
      mergedPrNumber: null,
      mergedPrRepository: null,
    }));
    const pages = [[row({ id: "w-a", sourceIssueId: "src-a", branchName: "a-branch", metadata: { branchPrReconcileMissStreak: 2 } })]];
    const { db, updates } = makeDb(pages);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen: vi.fn(async () => ({ writtenIssueIds: [] })),
      now: nowFn,
    });

    const result = await service.sweep();

    expect(result.skipped).toBe(1);
    expect(updates).toHaveLength(1);
    const metadata = updates[0].set.metadata as Record<string, unknown>;
    expect(metadata.branchPrReconcileMissStreak).toBe(3);
  });

  it("resets the miss streak once a merged PR is recorded, so a healed row returns to the base cadence", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: true,
      mergedPrNumber: 42,
      mergedPrRepository: "o/r",
    }));
    const pages = [[row({ id: "w-a", sourceIssueId: "src-a", branchName: "a-branch", metadata: { branchPrReconcileMissStreak: 7 } })]];
    const { db, updates } = makeDb(pages);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen: vi.fn(async () => ({ writtenIssueIds: ["src-a"] })),
      now: nowFn,
    });

    const result = await service.sweep();

    expect(result.created).toBe(1);
    const metadata = updates[0].set.metadata as Record<string, unknown>;
    expect(metadata.branchPrReconcileMissStreak).toBe(0);
  });

  it("caps the backoff so a row is still re-probed eventually rather than being abandoned", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: false,
      mergedPrNumber: null,
      mergedPrRepository: null,
    }));
    // A huge streak must not produce an unbounded (effectively infinite) window: the
    // cap is 24h, so a marker older than that is probed again.
    const ancient = [
      row({
        id: "w-a",
        sourceIssueId: "src-a",
        branchName: "a-branch",
        metadata: { branchPrReconcileCheckedAt: iso(25 * 60 * 60 * 1000), branchPrReconcileMissStreak: 999 },
      }),
    ];
    const { db } = makeDb([ancient]);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen: vi.fn(async () => ({ writtenIssueIds: [] })),
      now: nowFn,
    });

    const result = await service.sweep();

    // Probed (not rate-limited), and the branch still has no merged PR → skipped.
    expect(result).toEqual({ candidates: 1, created: 0, skipped: 1, rateLimited: 0, failed: 0 });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  /**
   * Regression for probe-slot starvation, fixed at its root.
   *
   * Ordering by the CHECKED-AT marker is only correct while every row shares one
   * cooldown. With per-row backoff a heavily backed-off row can hold an older
   * marker than a row checked recently with a short window, and a rate-limited row
   * is never re-stamped (that would restart its clock), so it stays at the FRONT
   * of the cursor ahead of rows that are genuinely due.
   *
   * The fix is the precomputed `branchPrReconcileNextDueAt`, which the query both
   * filters and orders by. This asserts the stamp carries a due time consistent
   * with the row's backoff, which is what makes that SQL ordering correct.
   */
  it("stamps a due time that reflects the row's backoff, so the cursor can order by due-ness", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: false,
      mergedPrNumber: null,
      mergedPrRepository: null,
    }));
    // Streak 3 -> this miss makes it 4 -> window is 5min * 2^4 = 80 min.
    const pages = [[
      row({
        id: "w-a",
        sourceIssueId: "src-a",
        branchName: "a-branch",
        metadata: { branchPrReconcileMissStreak: 3 },
      }),
    ]];
    const { db, updates } = makeDb(pages);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen: vi.fn(async () => ({ writtenIssueIds: [] })),
      now: nowFn,
    });

    await service.sweep();

    const metadata = updates[0].set.metadata as Record<string, unknown>;
    expect(metadata.branchPrReconcileMissStreak).toBe(4);
    const dueAt = Date.parse(metadata.branchPrReconcileNextDueAt as string);
    expect(dueAt).toBe(NOW + 80 * 60 * 1000);
    // Written as ISO-8601 UTC, because the query compares it as TEXT rather than
    // casting to timestamptz — a malformed row must not throw for the whole sweep.
    expect(metadata.branchPrReconcileNextDueAt).toBe(new Date(NOW + 80 * 60 * 1000).toISOString());
  });

  it("clears the due time back to the base window when a merged PR is recorded", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: true,
      mergedPrNumber: 42,
      mergedPrRepository: "o/r",
    }));
    const pages = [[row({ id: "w-a", sourceIssueId: "src-a", branchName: "a-branch", metadata: { branchPrReconcileMissStreak: 9 } })]];
    const { db, updates } = makeDb(pages);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen: vi.fn(async () => ({ writtenIssueIds: ["src-a"] })),
      now: nowFn,
    });

    await service.sweep();

    const metadata = updates[0].set.metadata as Record<string, unknown>;
    expect(metadata.branchPrReconcileMissStreak).toBe(0);
    expect(Date.parse(metadata.branchPrReconcileNextDueAt as string)).toBe(NOW + 5 * 60 * 1000);
  });

  /**
   * An unparseable `repoUrl` used to be charged a probe slot and re-stamped on
   * EVERY sweep, because the cooldown gate sat after the parse check. Its miss
   * streak grew without ever reducing its cost, so the rows least able to make
   * progress were the most expensive to carry.
   */
  it("applies the cooldown to a malformed repo URL instead of re-charging it every sweep", async () => {
    const probe = makeProbe(async () => ({ hasMergedPr: false, mergedPrNumber: null, mergedPrRepository: null }));
    const pages = [[
      row({
        id: "w-bad",
        sourceIssueId: "src-bad",
        branchName: "b",
        repoUrl: "not a url",
        metadata: {
          branchPrReconcileCheckedAt: iso(60 * 1000),
          branchPrReconcileMissStreak: 5,
        },
      }),
    ]];
    const { db, updates } = makeDb(pages);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen: vi.fn(async () => ({ writtenIssueIds: [] })),
      now: nowFn,
    });

    const result = await service.sweep();

    // Cooled: counted as rate-limited, NOT failed, and not re-stamped.
    expect(result).toEqual({ candidates: 1, created: 0, skipped: 0, rateLimited: 1, failed: 0 });
    expect(updates).toHaveLength(0);
  });

  it("asks the cursor for no more rows than the probe budget", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: false,
      mergedPrNumber: null,
      mergedPrRepository: null,
    }));
    // 30 rows, all due (no marker at all), against a probe budget of 3.
    const allDue = Array.from({ length: 30 }, (_unused, n) =>
      row({ id: `w-${n}`, sourceIssueId: `src-${n}`, branchName: `b-${n}` }),
    );
    const { db, requestedLimits } = makeDb([allDue]);
    const service = createBranchPrReconcilerSweepService(db as never, {
      limit: 3,
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen: vi.fn(async () => ({ writtenIssueIds: [] })),
      now: nowFn,
    });

    const result = await service.sweep();

    // The query is bounded by `limit`: the sweep must not read rows it could never
    // probe, now that the due-ness filter lives in SQL.
    expect(requestedLimits).toEqual([3]);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(result.candidates).toBe(3);
    expect(result.skipped).toBe(3);
  });

  /**
   * The SQL predicate selects on the STORED `branchPrReconcileNextDueAt`, so the
   * in-process backstop must read the same value rather than re-deriving a window
   * from the checked-at marker. If it re-derived, a change to the configured base
   * cooldown would make the two disagree: rows stamped under the old base would be
   * selected as due by the query and then rejected here, burning a probe slot every
   * sweep without ever being re-stamped — the exact starvation the stored due time
   * exists to prevent.
   */
  it("honours the stored due time over a reconfigured base cooldown", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: false,
      mergedPrNumber: null,
      mergedPrRepository: null,
    }));
    // Stored due time has passed, so the row IS due. A re-derived window would
    // disagree: checked 10 min ago, streak 3, against a raised 1h base cooldown.
    const pages = [[
      row({
        id: "w-a",
        sourceIssueId: "src-a",
        branchName: "a-branch",
        metadata: {
          branchPrReconcileCheckedAt: iso(10 * 60 * 1000),
          branchPrReconcileMissStreak: 3,
          branchPrReconcileNextDueAt: iso(60 * 1000),
        },
      }),
    ]];
    const { db } = makeDb(pages);
    const service = createBranchPrReconcilerSweepService(db as never, {
      cooldownMs: 60 * 60 * 1000,
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen: vi.fn(async () => ({ writtenIssueIds: [] })),
      now: nowFn,
    });

    const result = await service.sweep();

    expect(result.rateLimited).toBe(0);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("still rate-limits a row whose stored due time is in the future", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: false,
      mergedPrNumber: null,
      mergedPrRepository: null,
    }));
    const pages = [[
      row({
        id: "w-a",
        sourceIssueId: "src-a",
        branchName: "a-branch",
        metadata: {
          branchPrReconcileCheckedAt: iso(10 * 60 * 60 * 1000),
          branchPrReconcileMissStreak: 0,
          branchPrReconcileNextDueAt: new Date(NOW + 30 * 60 * 1000).toISOString(),
        },
      }),
    ]];
    const { db } = makeDb(pages);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen: vi.fn(async () => ({ writtenIssueIds: [] })),
      now: nowFn,
    });

    const result = await service.sweep();

    expect(result.rateLimited).toBe(1);
    expect(probe).not.toHaveBeenCalled();
  });

  it("treats an unparseable stored due time as due, so a corrupt row self-heals", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: false,
      mergedPrNumber: null,
      mergedPrRepository: null,
    }));
    const pages = [[
      row({
        id: "w-a",
        sourceIssueId: "src-a",
        branchName: "a-branch",
        metadata: { branchPrReconcileNextDueAt: "not-a-timestamp" },
      }),
    ]];
    const { db, updates } = makeDb(pages);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen: vi.fn(async () => ({ writtenIssueIds: [] })),
      now: nowFn,
    });

    const result = await service.sweep();

    expect(result.skipped).toBe(1);
    // Re-stamped with a well-formed ISO value.
    const metadata = updates[0].set.metadata as Record<string, unknown>;
    expect(Number.isFinite(Date.parse(metadata.branchPrReconcileNextDueAt as string))).toBe(true);
  });

  /**
   * A parseable but NON-canonical due time (seconds precision, no milliseconds)
   * must be treated as due, not honoured.
   *
   * The SQL predicate selects it, because it selects everything that is not
   * canonical so malformed values get repaired rather than stranded. If this gate
   * honoured it instead, the row would deadlock: selected by the query every
   * sweep, rejected here as a future time, never re-stamped — occupying a probe
   * slot forever. The two rules have to agree on what "canonical" means.
   */
  it("repairs a parseable but non-canonical due time instead of honouring it", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: false,
      mergedPrNumber: null,
      mergedPrRepository: null,
    }));
    const pages = [[
      row({
        id: "w-a",
        sourceIssueId: "src-a",
        branchName: "a-branch",
        // Valid to Date.parse, far in the future, but not toISOString() output.
        metadata: { branchPrReconcileNextDueAt: "2026-12-01T10:00:00Z" },
      }),
    ]];
    const { db, updates } = makeDb(pages);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen: vi.fn(async () => ({ writtenIssueIds: [] })),
      now: nowFn,
    });

    const result = await service.sweep();

    expect(result.rateLimited).toBe(0);
    expect(probe).toHaveBeenCalledTimes(1);
    // Rewritten in canonical form, so the next sweep can trust it.
    const metadata = updates[0].set.metadata as Record<string, unknown>;
    expect(metadata.branchPrReconcileNextDueAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it("still honours a canonical future due time", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: false,
      mergedPrNumber: null,
      mergedPrRepository: null,
    }));
    const pages = [[
      row({
        id: "w-a",
        sourceIssueId: "src-a",
        branchName: "a-branch",
        metadata: { branchPrReconcileNextDueAt: new Date(NOW + 30 * 60 * 1000).toISOString() },
      }),
    ]];
    const { db } = makeDb(pages);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen: vi.fn(async () => ({ writtenIssueIds: [] })),
      now: nowFn,
    });

    expect((await service.sweep()).rateLimited).toBe(1);
    expect(probe).not.toHaveBeenCalled();
  });

  /**
   * The canonical-form rule is written twice: once as a TypeScript regex for
   * `isDue`, once as a POSIX regex inside the sweep's SQL predicate. They are a
   * matched pair — the query selects everything the shape rejects so it can be
   * repaired, and `isDue` treats the same values as due so the repair happens.
   *
   * If they drift apart the failure is silent and permanent in one direction
   * (a value the query never selects is never repaired) and a per-sweep leak in
   * the other (a value the query always selects but the gate always rejects
   * occupies a probe slot forever). Neither shows up as a test failure anywhere
   * else, so the agreement is asserted directly.
   */
  it("keeps the TypeScript and SQL canonical-form rules in agreement", async () => {
    const source = await readFile(
      new URL("./branch-pr-reconciler.ts", import.meta.url),
      "utf8",
    );

    const tsMatch = source.match(/const CANONICAL_ISO_UTC = \/(.+?)\/;/);
    expect(tsMatch, "CANONICAL_ISO_UTC literal not found").not.toBeNull();
    const tsRe = new RegExp(tsMatch![1]);

    const sqlMatch = source.match(/!~ '(\^.+?\$)'/);
    expect(sqlMatch, "SQL canonical-form regex not found").not.toBeNull();
    // POSIX bracket forms -> JS equivalents; the shapes are otherwise identical.
    const sqlRe = new RegExp(sqlMatch![1].replace(/\[\.\]/g, "\\."));

    // Chosen to DISCRIMINATE, not merely to pass: each near-miss differs from
    // canonical in exactly one component, so a loosened quantifier or a dropped
    // anchor on either side shows up as a disagreement.
    const samples = [
      new Date(NOW).toISOString(),
      "2026-09-25T10:00:00.000Z",
      "2026-12-01T10:00:00Z",
      "2026-09-25T10:00:00.0Z",
      "2026-09-25T10:00:00.00Z",
      "2026-09-25T10:00:00.0000Z",
      "2026-09-25T10:00:00.000z",
      "2026-13-01T00:00:00.000Z",
      "2026-00-01T00:00:00.000Z",
      "2026-09-32T00:00:00.000Z",
      "2026-09-00T00:00:00.000Z",
      "2026-09-25T25:00:00.000Z",
      "2026-09-25T24:00:00.000Z",
      "2026-09-25T10:60:00.000Z",
      "2026-09-25T10:00:60.000Z",
      "2026-09-25T10:00:00.000",
      " 2026-09-25T10:00:00.000Z",
      "2026-09-25T10:00:00.000Z ",
      "x2026-09-25T10:00:00.000Z",
      "2026-09-25T10:00:00.000Zx",
      "2026-09-25 10:00:00.000Z",
      "20260925T100000.000Z",
      "not-a-timestamp",
      "",
      "12345",
      "2026-09-25T10:00:00.000+02:00",
      "2026-9-25T10:00:00.000Z",
    ];
    for (const sample of samples) {
      expect(sqlRe.test(sample), `disagreement on ${JSON.stringify(sample)}`).toBe(
        tsRe.test(sample),
      );
    }
    // Sanity: the pair actually discriminates rather than matching everything.
    expect(tsRe.test(new Date(NOW).toISOString())).toBe(true);
    expect(tsRe.test("2026-12-01T10:00:00Z")).toBe(false);
  });

  it("keeps backing off when the record path writes nothing", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: true,
      mergedPrNumber: 42,
      mergedPrRepository: "o/r",
    }));
    // A merged PR is found, but nothing is written. The row stays a candidate, so
    // resetting its streak here would return it to the base cadence forever.
    const pages = [[row({ id: "w-a", sourceIssueId: "src-a", branchName: "a-branch", metadata: { branchPrReconcileMissStreak: 4 } })]];
    const { db, updates } = makeDb(pages);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen: vi.fn(async () => ({ writtenIssueIds: [] })),
      now: nowFn,
    });

    const result = await service.sweep();

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    const metadata = updates[0].set.metadata as Record<string, unknown>;
    expect(metadata.branchPrReconcileMissStreak).toBe(5);
  });

  it("repairs a non-string stored due time instead of rate-limiting it", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: false,
      mergedPrNumber: null,
      mergedPrRepository: null,
    }));
    // A JSON number sorts BEFORE any ISO timestamp, so it occupies the front of the
    // page. Falling back to the checked-at window would rate-limit it without ever
    // re-stamping, and it would hold that slot until the derived window expired.
    const pages = [[
      row({
        id: "w-a",
        sourceIssueId: "src-a",
        branchName: "a-branch",
        metadata: {
          branchPrReconcileNextDueAt: 12345,
          branchPrReconcileCheckedAt: iso(1000),
          branchPrReconcileMissStreak: 2,
        },
      }),
    ]];
    const { db, updates } = makeDb(pages);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen: vi.fn(async () => ({ writtenIssueIds: [] })),
      now: nowFn,
    });

    const result = await service.sweep();

    expect(result.rateLimited).toBe(0);
    expect(probe).toHaveBeenCalledTimes(1);
    const metadata = updates[0].set.metadata as Record<string, unknown>;
    expect(metadata.branchPrReconcileNextDueAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  /**
   * A shape check cannot validate a calendar. "2026-13-01T00:00:00.000Z" passes the
   * canonical regex, is not a real instant, and as text sorts after the deadline —
   * so a shape-only rule would never select it and the row would be stranded.
   */
  it("repairs a shape-valid but calendar-invalid due time", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: false,
      mergedPrNumber: null,
      mergedPrRepository: null,
    }));
    const pages = [[
      row({
        id: "w-a",
        sourceIssueId: "src-a",
        branchName: "a-branch",
        metadata: { branchPrReconcileNextDueAt: "2026-13-01T00:00:00.000Z" },
      }),
    ]];
    const { db, updates } = makeDb(pages);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen: vi.fn(async () => ({ writtenIssueIds: [] })),
      now: nowFn,
    });

    expect((await service.sweep()).rateLimited).toBe(0);
    expect(probe).toHaveBeenCalledTimes(1);
    const metadata = updates[0].set.metadata as Record<string, unknown>;
    expect(Date.parse(metadata.branchPrReconcileNextDueAt as string)).toBeGreaterThan(NOW);
  });

  it("repairs a due time further ahead than this sweep could ever have written", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: false,
      mergedPrNumber: null,
      mergedPrRepository: null,
    }));
    // Canonical and parseable, but 30 days out. The cap is 24h, so this cannot
    // have come from stampCooldown and must not be honoured.
    const pages = [[
      row({
        id: "w-a",
        sourceIssueId: "src-a",
        branchName: "a-branch",
        metadata: {
          branchPrReconcileNextDueAt: new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString(),
        },
      }),
    ]];
    const { db } = makeDb(pages);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen: vi.fn(async () => ({ writtenIssueIds: [] })),
      now: nowFn,
    });

    expect((await service.sweep()).rateLimited).toBe(0);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("still honours a due time exactly at the ceiling", async () => {
    const probe = makeProbe(async () => ({
      hasMergedPr: false,
      mergedPrNumber: null,
      mergedPrRepository: null,
    }));
    const pages = [[
      row({
        id: "w-a",
        sourceIssueId: "src-a",
        branchName: "a-branch",
        metadata: {
          branchPrReconcileNextDueAt: new Date(NOW + 24 * 60 * 60 * 1000).toISOString(),
        },
      }),
    ]];
    const { db } = makeDb(pages);
    const service = createBranchPrReconcilerSweepService(db as never, {
      probeBranchMergedPr: probe,
      resolveToken: vi.fn(async () => tokenOk()),
      recordAtOpen: vi.fn(async () => ({ writtenIssueIds: [] })),
      now: nowFn,
    });

    expect((await service.sweep()).rateLimited).toBe(1);
    expect(probe).not.toHaveBeenCalled();
  });

  /**
   * Selection semantics of the SQL predicate, evaluated deterministically.
   *
   * The sweep tests above run against a mock that ignores `WHERE`, so nothing
   * here executes the predicate — yet it is where the correctness of the whole
   * backoff lives. This reconstructs it from the REAL regex in the source and
   * applies the same four arms Postgres does, with string comparison standing in
   * for Postgres TEXT comparison (both are byte-order on these ASCII values).
   *
   * It is written as a table because the failure it guards against is semantic,
   * not structural: an earlier revision had a ceiling arm and a digit-count shape
   * check and still stranded "2026-09-25T25:00:00.000Z", which is shape-valid and
   * sorts BETWEEN the deadline and the ceiling. Only running the predicate over
   * real values surfaced that. Every row below was confirmed against Postgres.
   */
  it("selects exactly the due and the bogus rows, and nothing else", async () => {
    const source = await readFile(
      new URL("./branch-pr-reconciler.ts", import.meta.url),
      "utf8",
    );
    const sqlShape = source.match(/!~ '(\^.+?\$)'/);
    expect(sqlShape, "SQL canonical-form regex not found").not.toBeNull();
    const shapeRe = new RegExp(sqlShape![1].replace(/\[\.\]/g, "\\."));

    const nowIso = new Date(NOW).toISOString();
    const ceilingIso = new Date(NOW + 24 * 60 * 60 * 1000).toISOString();

    // The predicate, arm for arm. `raw` is what Postgres `->>` yields, so a JSON
    // number and object arrive as their text forms.
    const selects = (raw: string | null) =>
      raw === null || raw <= nowIso || !shapeRe.test(raw) || raw > ceilingIso;

    const cases: Array<[string, string | null, boolean]> = [
      ["missing key",            null,                          true],
      ["due in the past",        "2026-09-03T10:00:00.000Z",    true],
      ["future within window",   new Date(NOW + 3600_000).toISOString(),            false],
      ["exactly at ceiling",     ceilingIso,                    false],
      ["beyond the ceiling",     new Date(NOW + 30 * 86400_000).toISOString(),      true],
      ["invalid month",          "2026-13-01T00:00:00.000Z",    true],
      ["invalid day",            "2026-09-32T00:00:00.000Z",    true],
      ["invalid hour",           "2026-09-04T25:00:00.000Z",    true],
      ["invalid minute",         "2026-09-04T10:60:00.000Z",    true],
      ["invalid second",         "2026-09-04T10:00:60.000Z",    true],
      ["seconds precision",      "2026-12-01T10:00:00Z",        true],
      ["json number as text",    "12345",                       true],
      ["json object as text",    '{"a": 1}',                    true],
      ["non-timestamp string",   "not-a-timestamp",             true],
      ["empty string",           "",                            true],
    ];

    for (const [label, raw, expected] of cases) {
      expect(selects(raw), `${label}: ${JSON.stringify(raw)}`).toBe(expected);
    }
  });
});
