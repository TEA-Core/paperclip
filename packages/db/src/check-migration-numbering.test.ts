import { describe, expect, it } from "vitest";
import {
  ensureMonotonicWhen,
  ensureSnapshotChain,
  MIGRATION_WHEN_MONOTONIC_BASELINE_TAG as BASELINE,
} from "./check-migration-numbering.js";

function errorMessage(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw, but it did not");
}

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

// Shape of the real 2026-10-20 fold tip: 0231 and 0238 both claimed the id of
// 0230 as their prevId, so drizzle-kit saw two children for one snapshot.
const SHARED_PREV_ID = "1366d67d-ba52-463f-b04a-fab71aaab3ac";

describe("snapshot prevId/id integrity", () => {
  it("accepts a chain where every prevId is claimed by exactly one snapshot", () => {
    expect(() =>
      ensureSnapshotChain([
        { file: "0230_snapshot.json", id: SHARED_PREV_ID, prevId: "id-0229" },
        { file: "0231_snapshot.json", id: "id-0231", prevId: SHARED_PREV_ID },
        { file: "0237_snapshot.json", id: "id-0237", prevId: "id-0236" },
        { file: "0238_snapshot.json", id: "id-0238", prevId: "id-0237" },
      ]),
    ).not.toThrow();
  });

  it("rejects two snapshots claiming the same prevId, naming both files", () => {
    const message = errorMessage(() =>
      ensureSnapshotChain([
        { file: "0231_snapshot.json", id: "id-0231", prevId: SHARED_PREV_ID },
        { file: "0238_snapshot.json", id: "id-0238", prevId: SHARED_PREV_ID },
      ]),
    );

    expect(message).toContain("0231_snapshot.json");
    expect(message).toContain("0238_snapshot.json");
    expect(message).toMatch(/collision/i);
    expect(message).toMatch(/drizzle-kit/);
    expect(message).toMatch(/exits 0/);
  });

  it("rejects two snapshots sharing an id, naming both files", () => {
    const message = errorMessage(() =>
      ensureSnapshotChain([
        { file: "0231_snapshot.json", id: "id-0231", prevId: "id-0230" },
        { file: "0238_snapshot.json", id: "id-0231", prevId: "id-0237" },
      ]),
    );

    expect(message).toContain("0231_snapshot.json");
    expect(message).toContain("0238_snapshot.json");
    expect(message).toMatch(/duplicate snapshot id/i);
  });

  it("accepts a sparse chain whose prevId is dangling", () => {
    expect(() =>
      ensureSnapshotChain([
        { file: "0027_snapshot.json", id: "id-0027", prevId: "id-of-a-dropped-snapshot" },
        { file: "0238_snapshot.json", id: "id-0238", prevId: "id-0237" },
      ]),
    ).not.toThrow();
  });
});
