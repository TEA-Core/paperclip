import { describe, expect, it } from "vitest";
import { ensureMonotonicWhen } from "./check-migration-numbering.js";
import { type Journal, planFoldRestamp } from "./fold-restamp-migrations.js";

// Shape of the real 2026-08-14 fold: the fork line ends at 0189 /
// when=1785930047830 (the watermark the deployed database has applied) and the
// folded upstream migrations were authored earlier, so their `when` is lower.
const FORK_TIP_WHEN = 1785930047830;

function journal(entries: Array<{ tag: string; when: number }>): Journal {
  return {
    version: "7",
    dialect: "postgresql",
    entries: entries.map((entry, idx) => ({ idx, version: "7", breakpoints: true, ...entry })),
  };
}

const baseJournal = journal([
  { tag: "0187_deploy_slot_locks", when: FORK_TIP_WHEN - 2000 },
  { tag: "0188_run_budget_snapshot", when: FORK_TIP_WHEN - 1000 },
  { tag: "0189_merge_arming_enabled", when: FORK_TIP_WHEN },
]);

// A fold merged as-is: upstream files land by filename order, keeping the
// `when` values upstream generated.
const foldedJournal = journal([
  { tag: "0184_routable_blocked", when: 1784916880226 },
  { tag: "0187_deploy_slot_locks", when: FORK_TIP_WHEN - 2000 },
  { tag: "0188_run_budget_snapshot", when: FORK_TIP_WHEN - 1000 },
  { tag: "0189_merge_arming_enabled", when: FORK_TIP_WHEN },
  { tag: "0192_task_watchdog_stop_snapshots", when: 1784916886226 },
]);

describe("fold re-stamp plan", () => {
  it("is needed: an unrepaired fold journal is rejected by the numbering check", () => {
    expect(() => ensureMonotonicWhen(foldedJournal.entries)).toThrow(
      /0192_task_watchdog_stop_snapshots would be SKIPPED/,
    );
  });

  it("renumbers and re-stamps folded migrations above the fork line", () => {
    const plan = planFoldRestamp(foldedJournal, baseJournal)!;

    expect(plan.maxNumber).toBe(189);
    expect(plan.maxWhen).toBe(FORK_TIP_WHEN);
    expect(plan.restamped).toEqual([
      expect.objectContaining({ tag: "0190_routable_blocked", when: FORK_TIP_WHEN + 1000 }),
      expect.objectContaining({
        tag: "0191_task_watchdog_stop_snapshots",
        when: FORK_TIP_WHEN + 2000,
      }),
    ]);
    expect(plan.renames).toEqual([
      { from: "0184_routable_blocked.sql", to: "0190_routable_blocked.sql", when: FORK_TIP_WHEN + 1000 },
      {
        from: "0192_task_watchdog_stop_snapshots.sql",
        to: "0191_task_watchdog_stop_snapshots.sql",
        when: FORK_TIP_WHEN + 2000,
      },
    ]);
  });

  it("produces a journal the numbering check accepts", () => {
    const plan = planFoldRestamp(foldedJournal, baseJournal)!;

    expect(() => ensureMonotonicWhen(plan.journal.entries)).not.toThrow();
    expect(plan.journal.entries.map((entry) => entry.idx)).toEqual([0, 1, 2, 3, 4]);
    expect(plan.journal.entries.map((entry) => entry.tag)).toEqual([
      "0187_deploy_slot_locks",
      "0188_run_budget_snapshot",
      "0189_merge_arming_enabled",
      "0190_routable_blocked",
      "0191_task_watchdog_stop_snapshots",
    ]);
  });

  it("never changes the fork's own `when` values, which are already applied", () => {
    const plan = planFoldRestamp(foldedJournal, baseJournal)!;

    for (const entry of baseJournal.entries) {
      const after = plan.journal.entries.find((candidate) => candidate.tag === entry.tag);
      expect(after?.when).toBe(entry.when);
    }
  });

  // drizzle-orm/migrator.js walks `journal.entries` with a plain
  // `for (const journalEntry of journal.entries)` and never sorts, so the ARRAY
  // is what decides the order migrations are applied in; `when` only gates
  // whether an entry runs at all against the single newest `created_at`. That
  // makes upstream's array order the order upstream itself applies them in, and
  // it is the only ordering the re-stamp is allowed to preserve. Upstream's
  // `when` values are NOT monotonic against that array — in the 2026-08-14 fold,
  // 0194_company_skill_releases carried a lower `when` than the
  // 0193_document_memberships preceding it — so sorting by `when` would reorder
  // upstream's migrations against each other and against their dependencies.
  it("keeps upstream's journal array order even when `when` sorts the other way", () => {
    const plan = planFoldRestamp(
      journal([
        ...baseJournal.entries,
        { tag: "0190_applied_first", when: 1784916886226 },
        { tag: "0191_applied_second", when: 1784916880226 },
      ]),
      baseJournal,
    )!;

    expect(plan.restamped.map((entry) => entry.tag)).toEqual([
      "0190_applied_first",
      "0191_applied_second",
    ]);
    // And the re-stamped `when` values are monotonic in that same order, so the
    // watermark can never skip the second one.
    expect(plan.restamped[0].when).toBeLessThan(plan.restamped[1].when);
  });

  it("returns null when the journal holds no newly folded migrations", () => {
    expect(planFoldRestamp(baseJournal, baseJournal)).toBeNull();
  });

  it("refuses a base journal that shares no entries with the current one", () => {
    expect(() => planFoldRestamp(foldedJournal, journal([{ tag: "0001_unrelated", when: 1 }]))).toThrow(
      /shares no entries with the base journal/,
    );
  });
});
