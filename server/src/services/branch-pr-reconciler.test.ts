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
});
