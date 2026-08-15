import { describe, expect, it } from "vitest";
import {
  ensureMonotonicWhen,
  MIGRATION_WHEN_MONOTONIC_BASELINE_TAG as BASELINE,
} from "./check-migration-numbering.js";

// Shape of the real 2026-08-14 fold: the fork's tip sits at when=1785930047830
// and folded upstream migrations, authored earlier, sit below it.
const FORK_TIP_WHEN = 1785930047830;
const UPSTREAM_WHEN = 1784916886226;

describe("migration journal `when` monotonicity", () => {
  it("accepts a journal whose `when` increases from the baseline onward", () => {
    expect(() =>
      ensureMonotonicWhen([
        { tag: BASELINE, when: FORK_TIP_WHEN },
        { tag: "0190_routable_blocked", when: FORK_TIP_WHEN + 1000 },
        { tag: "0191_task_watchdog_stop_snapshots", when: FORK_TIP_WHEN + 2000 },
      ]),
    ).not.toThrow();
  });

  it("rejects a folded upstream migration stamped below the fork watermark", () => {
    expect(() =>
      ensureMonotonicWhen([
        { tag: BASELINE, when: FORK_TIP_WHEN },
        { tag: "0192_task_watchdog_stop_snapshots", when: UPSTREAM_WHEN },
      ]),
    ).toThrow(/0192_task_watchdog_stop_snapshots has 1784916886226/);
  });

  it("rejects an entry that only ties the running maximum", () => {
    expect(() =>
      ensureMonotonicWhen([
        { tag: BASELINE, when: FORK_TIP_WHEN },
        { tag: "0190_routable_blocked", when: FORK_TIP_WHEN },
      ]),
    ).toThrow(/must exceed every entry before it/);
  });

  it("compares against the running maximum, not the previous entry", () => {
    expect(() =>
      ensureMonotonicWhen([
        { tag: BASELINE, when: FORK_TIP_WHEN },
        { tag: "0190_routable_blocked", when: FORK_TIP_WHEN + 2000 },
        { tag: "0191_task_watchdog_stop_snapshots", when: FORK_TIP_WHEN + 1000 },
      ]),
    ).toThrow(/but 0190_routable_blocked earlier in the journal has/);
  });

  it("tolerates the inversions inherited from upstream before the baseline", () => {
    expect(() =>
      ensureMonotonicWhen([
        { tag: "0001_first", when: 1_700_000_002_000 },
        { tag: "0002_second", when: 1_700_000_001_000 },
        { tag: BASELINE, when: FORK_TIP_WHEN },
      ]),
    ).not.toThrow();
  });

  it("requires the baseline entry to be present", () => {
    expect(() => ensureMonotonicWhen([{ tag: "0001_first", when: 1 }])).toThrow(
      /missing the "when" monotonicity baseline/,
    );
  });

  it("rejects a non-numeric `when`", () => {
    expect(() =>
      ensureMonotonicWhen([{ tag: "0001_first", when: undefined }]),
    ).toThrow(/missing a numeric "when"/);
  });
});
