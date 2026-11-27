import { describe, expect, it } from "vitest";
import {
  createOpenCodeSessionChargeLedger,
  foldOpenCodeSessionCounters,
  mergeOpenCodeSessionCounters,
  parseOpenCodeSessionTotals,
  parseOpenCodeSessionUsageEvent,
  parseOpenCodeSessionUsagePart,
  readOpenCodeSessionCounters,
  readOpenCodeStepUsage,
  reconcileOpenCodeRunUsage,
  subtractOpenCodeSessionTotals,
  type OpenCodeSessionChargeLease,
  type OpenCodeSessionTotals,
} from "./session-usage.js";

const totals = (inputTokens: number, cachedInputTokens: number, outputTokens: number, costUsd: number | null): OpenCodeSessionTotals => ({
  usage: { inputTokens, cachedInputTokens, outputTokens },
  costUsd,
});

describe("parseOpenCodeSessionTotals", () => {
  it("reads the wrapped session payload with cache writes and reasoning folded in", () => {
    const raw = JSON.stringify({
      data: { id: "ses_1", tokens: { input: 100, output: 7, reasoning: 2, cache: { read: 20, write: 5 } }, cost: 0.5 },
    });
    expect(parseOpenCodeSessionTotals(raw)).toEqual(totals(105, 20, 9, 0.5));
  });

  it("accepts the data, info, session, and bare payload wrappers", () => {
    const payload = { tokens: { input: 1, output: 2 }, cost: 0 };
    for (const wrapper of ["data", "info", "session"]) {
      expect(parseOpenCodeSessionTotals(JSON.stringify({ [wrapper]: payload }))).toEqual(totals(1, 0, 2, 0));
    }
    expect(parseOpenCodeSessionTotals(JSON.stringify(payload))).toEqual(totals(1, 0, 2, 0));
  });

  it("returns null when the payload has no complete counters", () => {
    expect(parseOpenCodeSessionTotals("")).toBeNull();
    expect(parseOpenCodeSessionTotals("not json")).toBeNull();
    expect(parseOpenCodeSessionTotals("[]")).toBeNull();
    expect(parseOpenCodeSessionTotals(JSON.stringify({ data: { id: "ses_1" } }))).toBeNull();
    expect(parseOpenCodeSessionTotals(JSON.stringify({ data: { tokens: { input: 1 } } }))).toBeNull();
    // A present but invalid counter means the payload is not trustworthy.
    expect(parseOpenCodeSessionTotals(JSON.stringify({ data: { tokens: { input: 1, output: -1 } } }))).toBeNull();
    expect(parseOpenCodeSessionTotals(JSON.stringify({ data: { tokens: { input: 1, output: 2 }, cost: "free" } }))).toBeNull();
  });

  it("treats an absent cost as null and missing optional counters as zero", () => {
    expect(parseOpenCodeSessionTotals(JSON.stringify({ data: { tokens: { input: 3, output: 4 } } }))).toEqual(totals(3, 0, 4, null));
  });
});

describe("parseOpenCodeSessionUsageEvent", () => {
  it("reads the session.usage.updated payload shape", () => {
    expect(
      parseOpenCodeSessionUsageEvent({ sessionID: "ses_1", cost: 0.25, tokens: { input: 10, output: 3, cache: { read: 2, write: 1 } } }),
    ).toEqual(totals(11, 2, 3, 0.25));
  });

  it("returns null for non-objects or unusable counters", () => {
    expect(parseOpenCodeSessionUsageEvent(null)).toBeNull();
    expect(parseOpenCodeSessionUsageEvent("nope")).toBeNull();
    expect(parseOpenCodeSessionUsageEvent({ tokens: {} })).toBeNull();
  });
});

describe("parseOpenCodeSessionUsagePart", () => {
  it("reads the normalized session-usage part", () => {
    expect(parseOpenCodeSessionUsagePart({ type: "session-usage", usage: { inputTokens: 9, cachedInputTokens: 2, outputTokens: 4 }, costUsd: 0.1 })).toEqual(
      totals(9, 2, 4, 0.1),
    );
    expect(parseOpenCodeSessionUsagePart({ usage: { inputTokens: 9, cachedInputTokens: 2, outputTokens: 4 } })).toEqual(totals(9, 2, 4, null));
  });

  it("returns null for incomplete or invalid parts", () => {
    expect(parseOpenCodeSessionUsagePart(null)).toBeNull();
    expect(parseOpenCodeSessionUsagePart({})).toBeNull();
    expect(parseOpenCodeSessionUsagePart({ usage: { inputTokens: 1, cachedInputTokens: 0 } })).toBeNull();
    expect(parseOpenCodeSessionUsagePart({ usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2.5 } })).toBeNull();
  });
});

describe("subtractOpenCodeSessionTotals", () => {
  it("subtracts the baseline and clamps at zero", () => {
    expect(subtractOpenCodeSessionTotals(totals(105, 20, 9, 0.5), totals(100, 20, 7, 0.5))).toEqual(totals(5, 0, 2, 0));
    // A compacted or reset session cannot go negative.
    expect(subtractOpenCodeSessionTotals(totals(10, 0, 1, 0.2), totals(100, 20, 7, 0.5))).toEqual(totals(0, 0, 0, 0));
  });

  it("keeps the after cost when the baseline cost is unknown", () => {
    expect(subtractOpenCodeSessionTotals(totals(10, 0, 1, 0.2), totals(5, 0, 0, null))).toEqual(totals(5, 0, 1, 0.2));
    expect(subtractOpenCodeSessionTotals(totals(10, 0, 1, null), totals(5, 0, 0, 0.1)).costUsd).toBeNull();
  });

  it("returns the totals unchanged without a baseline", () => {
    expect(subtractOpenCodeSessionTotals(totals(10, 0, 1, 0.2), null)).toEqual(totals(10, 0, 1, 0.2));
  });
});

describe("reconcileOpenCodeRunUsage", () => {
  const steps = { inputTokens: 5, cachedInputTokens: 1, outputTokens: 2 };

  it("reports the full cumulative usage of a fresh session as per_run", () => {
    expect(
      reconcileOpenCodeRunUsage({
        sessionUsage: totals(105, 20, 9, 0.5),
        sessionUsageBaseline: null,
        resumedSession: false,
        stepUsage: steps,
        stepCostUsd: 0,
      }),
    ).toEqual({
      usage: { inputTokens: 105, cachedInputTokens: 20, outputTokens: 9 },
      costUsd: 0.5,
      usageBasis: "per_run",
      source: "session_usage",
      complete: true,
      issues: [],
    });
  });

  it("subtracts the pre-run baseline on a resumed session", () => {
    expect(
      reconcileOpenCodeRunUsage({
        sessionUsage: totals(505, 41, 62, 0.06),
        sessionUsageBaseline: totals(500, 40, 60, 0.05),
        resumedSession: true,
        stepUsage: steps,
        stepCostUsd: 0,
      }),
    ).toEqual(
      expect.objectContaining({ usage: { inputTokens: 5, cachedInputTokens: 1, outputTokens: 2 }, usageBasis: "per_run", source: "session_usage", costUsd: expect.closeTo(0.01, 10) }),
    );
  });

  it("falls back to step sums when a resumed session has no baseline", () => {
    // Without a baseline the cumulative total includes prior runs; reporting it
    // as per_run would over-count, so the per-step sums stand in.
    expect(
      reconcileOpenCodeRunUsage({
        sessionUsage: totals(505, 41, 62, 0.06),
        sessionUsageBaseline: null,
        resumedSession: true,
        stepUsage: steps,
        stepCostUsd: 0.01,
      }),
    ).toEqual({
      usage: steps,
      costUsd: 0.01,
      usageBasis: "per_run",
      source: "step_finish",
      complete: false,
      issues: ["resumed session has no pre-run usage baseline; step sums used"],
    });
  });

  it("falls back to step sums when the session reported no usage", () => {
    expect(
      reconcileOpenCodeRunUsage({
        sessionUsage: null,
        sessionUsageBaseline: totals(500, 40, 60, 0.05),
        resumedSession: true,
        stepUsage: steps,
        stepCostUsd: 0.01,
      }),
    ).toEqual({
      usage: steps,
      costUsd: 0.01,
      usageBasis: "per_run",
      source: "step_finish",
      complete: false,
      issues: ["session reported no usage; step sums used"],
    });
  });

  it("marks a zero cost with tokens as unpriced, not free", () => {
    const reconciled = reconcileOpenCodeRunUsage({
      sessionUsage: totals(105, 20, 9, 0),
      sessionUsageBaseline: null,
      resumedSession: false,
      stepUsage: steps,
      stepCostUsd: 0,
    });
    expect(reconciled.costUsd).toBeNull();
    // A zero-token zero-cost session (nothing spent) is a real zero.
    expect(
      reconcileOpenCodeRunUsage({
        sessionUsage: totals(0, 0, 0, 0),
        sessionUsageBaseline: null,
        resumedSession: false,
        stepUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        stepCostUsd: 0,
      }).costUsd,
    ).toBe(0);
    // The step_finish fallback applies the same rule.
    expect(
      reconcileOpenCodeRunUsage({
        sessionUsage: null,
        sessionUsageBaseline: null,
        resumedSession: false,
        stepUsage: steps,
        stepCostUsd: 0,
      }).costUsd,
    ).toBeNull();
    expect(
      reconcileOpenCodeRunUsage({
        sessionUsage: null,
        sessionUsageBaseline: null,
        resumedSession: false,
        stepUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        stepCostUsd: 0,
      }).costUsd,
    ).toBe(0);
  });

  it("keeps the after cost when the baseline cost is unknown", () => {
    expect(
      reconcileOpenCodeRunUsage({
        sessionUsage: totals(105, 20, 9, 0.5),
        sessionUsageBaseline: totals(100, 20, 7, null),
        resumedSession: true,
        stepUsage: steps,
        stepCostUsd: 0,
      }).costUsd,
    ).toBe(0.5);
  });

  it("does not mark a total complete when the last usage update was partial", () => {
    // A complete total of 5/1/2, then a partial update that moved only the
    // output counter to 7. Without a final record the merged total is kept
    // but flagged, and each counter takes the larger of delta and step sums.
    const reconciled = reconcileOpenCodeRunUsage({
      sessionUsage: totals(5, 1, 7, 0.001),
      sessionUsageComplete: false,
      sessionUsageBaseline: null,
      resumedSession: false,
      stepUsage: { inputTokens: 9, cachedInputTokens: 1, outputTokens: 2 },
      stepCostUsd: 0.002,
    });
    expect(reconciled.complete).toBe(false);
    expect(reconciled.usage).toEqual({ inputTokens: 9, cachedInputTokens: 1, outputTokens: 7 });
    expect(reconciled.costUsd).toBe(0.002);
    expect(reconciled.issues).toEqual(["last session usage update was partial and no final session record was read"]);
  });

  it("marks the usage complete from the final session record after a partial update", () => {
    const reconciled = reconcileOpenCodeRunUsage({
      sessionUsage: totals(505, 41, 67, 0.05),
      sessionUsageComplete: false,
      sessionUsageFinal: totals(509, 41, 67, 0.06),
      sessionUsageBaseline: totals(500, 40, 60, 0.05),
      resumedSession: true,
      stepUsage: steps,
      stepCostUsd: 0,
    });
    expect(reconciled.complete).toBe(true);
    expect(reconciled.issues).toEqual([]);
    expect(reconciled.usage).toEqual({ inputTokens: 9, cachedInputTokens: 1, outputTokens: 7 });
    expect(reconciled.costUsd).toBeCloseTo(0.01, 10);
  });

  it("never lets an earlier final reading lower a later event total", () => {
    const reconciled = reconcileOpenCodeRunUsage({
      sessionUsage: totals(20, 2, 8, 0.2),
      sessionUsageFinal: totals(10, 2, 8, 0.1),
      sessionUsageBaseline: null,
      resumedSession: false,
      stepUsage: steps,
      stepCostUsd: 0,
    });
    expect(reconciled.usage).toEqual({ inputTokens: 20, cachedInputTokens: 2, outputTokens: 8 });
    expect(reconciled.costUsd).toBe(0.2);
  });

  it("names refused step counters when the step sums stand in", () => {
    const reconciled = reconcileOpenCodeRunUsage({
      sessionUsage: null,
      sessionUsageBaseline: null,
      resumedSession: false,
      stepUsage: steps,
      stepCostUsd: 0,
      stepUsageIssues: ["step_finish #1: tokens.input refused (-5)"],
    });
    expect(reconciled.complete).toBe(false);
    expect(reconciled.issues).toEqual([
      "session reported no usage; step sums used",
      "step_finish #1: tokens.input refused (-5)",
    ]);
  });

  it("keeps a run with no usage evidence at all incomplete, charged zero, and says so", () => {
    const reconciled = reconcileOpenCodeRunUsage({
      sessionUsage: null,
      sessionUsageBaseline: totals(500, 40, 60, 0.05),
      resumedSession: true,
      stepUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      stepCostUsd: 0,
    });
    expect(reconciled.usage).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    expect(reconciled.costUsd).toBe(0);
    expect(reconciled.complete).toBe(false);
    expect(reconciled.issues).toEqual([
      "session reported no usage; step sums used",
      "no usage was reported by the session or its steps; the run is charged zero",
    ]);
  });
});

describe("reconcileOpenCodeRunUsage with overlapping runs on one session", () => {
  const noSteps = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  const resumed = (lease: OpenCodeSessionChargeLease, final: OpenCodeSessionTotals) =>
    reconcileOpenCodeRunUsage({
      sessionUsage: final,
      sessionUsageFinal: final,
      sessionUsageBaseline: totals(100, 10, 20, 1),
      resumedSession: true,
      stepUsage: noSteps,
      stepCostUsd: 0,
      chargeLease: lease,
    });

  it("charges a session increase both runs see exactly once", () => {
    const ledger = createOpenCodeSessionChargeLedger();
    // Both runs read the same 100/10/20 $1.00 baseline, and both read the
    // session at 120/12/24 $1.20 afterwards: a 20-token, $0.20 increase in all.
    const first = ledger.open("ses_shared");
    const second = ledger.open("ses_shared");
    const a = resumed(first, totals(120, 12, 24, 1.2));
    const b = resumed(second, totals(120, 12, 24, 1.2));

    expect(a.usage).toEqual({ inputTokens: 20, cachedInputTokens: 2, outputTokens: 4 });
    expect(a.costUsd).toBeCloseTo(0.2, 10);
    expect(a.issues).toEqual([]);
    expect(b.usage).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    expect(b.costUsd).toBeCloseTo(0, 10);
    expect(b.complete).toBe(true);
    expect(b.issues).toEqual(["session usage already charged to an overlapping run on this session was not charged again"]);
  });

  it("charges a later run only the growth beyond what an overlapping run was charged", () => {
    const ledger = createOpenCodeSessionChargeLedger();
    const first = ledger.open("ses_shared");
    const second = ledger.open("ses_shared");
    const a = resumed(first, totals(120, 12, 24, 1.2));
    first.release();
    const b = resumed(second, totals(130, 13, 26, 1.3));

    expect(a.usage).toEqual({ inputTokens: 20, cachedInputTokens: 2, outputTokens: 4 });
    expect(b.usage).toEqual({ inputTokens: 10, cachedInputTokens: 1, outputTokens: 2 });
    expect((a.costUsd ?? 0) + (b.costUsd ?? 0)).toBeCloseTo(0.3, 10);
  });

  it("does not let a step-sum fallback charge growth an overlapping run already paid for", () => {
    const ledger = createOpenCodeSessionChargeLedger();
    const first = ledger.open("ses_shared");
    const second = ledger.open("ses_shared");
    // The first run's session reading already includes the second run's
    // 10/1/2 steps; the second run then has only its own step sums.
    resumed(first, totals(120, 12, 24, 1.2));
    const b = reconcileOpenCodeRunUsage({
      sessionUsage: null,
      sessionUsageBaseline: totals(100, 10, 20, 1),
      resumedSession: true,
      stepUsage: { inputTokens: 10, cachedInputTokens: 1, outputTokens: 2 },
      stepCostUsd: 0.1,
      chargeLease: second,
    });

    expect(b.source).toBe("step_finish");
    expect(b.usage).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    expect(b.complete).toBe(false);
  });

  it("forgets a session's record once its last overlapping run ends", () => {
    const ledger = createOpenCodeSessionChargeLedger();
    const first = ledger.open("ses_shared");
    resumed(first, totals(120, 12, 24, 1.2));
    first.release();
    // A later, non-overlapping run on a session whose usage was reset below
    // the old record still charges its own growth.
    const later = ledger.open("ses_shared");
    const reconciled = reconcileOpenCodeRunUsage({
      sessionUsage: totals(60, 5, 10, 0.6),
      sessionUsageFinal: totals(60, 5, 10, 0.6),
      sessionUsageBaseline: totals(50, 4, 8, 0.5),
      resumedSession: true,
      stepUsage: noSteps,
      stepCostUsd: 0,
      chargeLease: later,
    });
    later.release();

    expect(reconciled.usage).toEqual({ inputTokens: 10, cachedInputTokens: 1, outputTokens: 2 });
    expect(reconciled.issues).toEqual([]);
  });
});

describe("readOpenCodeSessionCounters / mergeOpenCodeSessionCounters", () => {
  it("keeps the counters a partial update carried and flags it incomplete", () => {
    expect(readOpenCodeSessionCounters({ tokens: { output: 7 } })).toEqual({ counters: { output: 7 }, complete: false });
    expect(readOpenCodeSessionCounters({ tokens: { input: 1, output: -1 }, cost: 0.1 })).toEqual({
      counters: { input: 1, cost: 0.1 },
      complete: false,
    });
    expect(readOpenCodeSessionCounters({ sessionID: "ses_1" })).toEqual({ counters: {}, complete: false });
    expect(
      readOpenCodeSessionCounters({ tokens: { input: 3, output: 4, reasoning: 1, cache: { read: 2, write: 5 } }, cost: 0.5 }),
    ).toEqual({ counters: { input: 3, output: 4, reasoning: 1, cacheRead: 2, cacheWrite: 5, cost: 0.5 }, complete: true });
  });

  it("merges field by field without lowering or clearing a counter", () => {
    const earlier = { input: 5, output: 2, cacheRead: 1, cost: 0.01 };
    expect(mergeOpenCodeSessionCounters(earlier, { output: 7 })).toEqual({ input: 5, output: 7, cacheRead: 1, cost: 0.01 });
    // An out-of-order earlier value never overwrites the later one.
    expect(mergeOpenCodeSessionCounters(earlier, { input: 3, output: 9 })).toEqual({ input: 5, output: 9, cacheRead: 1, cost: 0.01 });
  });

  it("folds cache writes into input and reasoning into output", () => {
    expect(foldOpenCodeSessionCounters({ input: 3, output: 4, reasoning: 1, cacheRead: 2, cacheWrite: 5 })).toEqual(totals(8, 2, 5, null));
  });
});

describe("readOpenCodeStepUsage", () => {
  it("counts cache writes as input and reasoning as output", () => {
    expect(
      readOpenCodeStepUsage({ tokens: { input: 10, output: 3, reasoning: 1, cache: { read: 4, write: 6 } }, cost: 0.02 }, "step_finish #1"),
    ).toEqual({ usage: { inputTokens: 16, cachedInputTokens: 4, outputTokens: 4 }, costUsd: 0.02, issues: [] });
  });

  it("refuses negative, fractional, unsafe and non-numeric counters and names them", () => {
    const reading = readOpenCodeStepUsage(
      { tokens: { input: -5, output: 2.5, reasoning: 2 ** 53, cache: { read: "4", write: 1 } }, cost: -1 },
      "step_finish #2",
    );
    expect(reading.usage).toEqual({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 });
    expect(reading.costUsd).toBe(0);
    expect(reading.issues).toEqual([
      "step_finish #2: tokens.input refused (-5)",
      "step_finish #2: tokens.output refused (2.5)",
      `step_finish #2: tokens.reasoning refused (${2 ** 53})`,
      'step_finish #2: tokens.cache.read refused ("4")',
      "step_finish #2: cost refused (-1)",
    ]);
  });

  it("flags a step without token counters", () => {
    expect(readOpenCodeStepUsage({ reason: "stop" }, "step_finish #3")).toEqual({
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      issues: ["step_finish #3: no token counters"],
    });
  });
});
