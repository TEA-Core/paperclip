import { describe, expect, it } from "vitest";
import {
  foldOpenCodeSessionCounters,
  mergeOpenCodeSessionCounters,
  parseOpenCodeSessionTotals,
  parseOpenCodeSessionUsageEvent,
  parseOpenCodeSessionUsagePart,
  readOpenCodeSessionCounters,
  readOpenCodeStepUsage,
  reconcileOpenCodeRunUsage,
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

describe("reconcileOpenCodeRunUsage", () => {
  const steps = { inputTokens: 5, cachedInputTokens: 1, outputTokens: 2 };

  it("reports the full cumulative usage of a fresh session as per_run", () => {
    expect(
      reconcileOpenCodeRunUsage({
        sessionUsage: totals(105, 20, 9, 0.5),
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

  it("charges a resumed session its own step sums", () => {
    expect(
      reconcileOpenCodeRunUsage({
        sessionUsage: totals(505, 41, 62, 0.06),
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
      issues: ["resumed session; this run's own step sums used"],
    });
  });

  it("charges overlapping resumed runs on one session their own steps, not each other's", () => {
    // Runs A and B both resume session S at 100/10/20. A spends 50/5/10 and B
    // 30/3/6, so S reads 180/18/36 when each finishes. Each run is charged its
    // own step sums, exactly what the step-sum reporting charged before: 80 in
    // total, never the 110 that charging each run the session's growth since it
    // started would charge.
    const after = totals(180, 18, 36, 0.18);
    const runA = reconcileOpenCodeRunUsage({
      sessionUsage: after,
      sessionUsageFinal: after,
      resumedSession: true,
      stepUsage: { inputTokens: 50, cachedInputTokens: 5, outputTokens: 10 },
      stepCostUsd: 0.05,
    });
    const runB = reconcileOpenCodeRunUsage({
      sessionUsage: after,
      sessionUsageFinal: after,
      resumedSession: true,
      stepUsage: { inputTokens: 30, cachedInputTokens: 3, outputTokens: 6 },
      stepCostUsd: 0.03,
    });
    expect(runA.usage).toEqual({ inputTokens: 50, cachedInputTokens: 5, outputTokens: 10 });
    expect(runB.usage).toEqual({ inputTokens: 30, cachedInputTokens: 3, outputTokens: 6 });
    expect(runA.usage.inputTokens + runB.usage.inputTokens).toBe(80);
    expect(runA.costUsd! + runB.costUsd!).toBeCloseTo(0.08, 10);
    expect([runA.usageBasis, runB.usageBasis]).toEqual(["per_run", "per_run"]);
  });

  it("names refused step counters on a resumed session's step sums", () => {
    const reconciled = reconcileOpenCodeRunUsage({
      sessionUsage: totals(505, 41, 62, 0.06),
      resumedSession: true,
      stepUsage: steps,
      stepCostUsd: 0.01,
      stepUsageIssues: ["step_finish #1: tokens.input refused (-5)"],
    });
    expect(reconciled.usage).toEqual(steps);
    expect(reconciled.issues).toEqual([
      "resumed session; this run's own step sums used",
      "step_finish #1: tokens.input refused (-5)",
    ]);
  });

  it("charges overlapping resumes of a zero-usage session their own steps", () => {
    // A prior run created session S and failed before any model step, so S
    // reads 0. Runs A and B both resume S at 0/0/0; A spends 50 and B 30, so S
    // reads 80 when each finishes. Each is charged its own steps (80 in total),
    // never the whole session total (160 in total).
    const after = totals(80, 0, 0, 0.08);
    const charged = [
      { inputTokens: 50, cachedInputTokens: 0, outputTokens: 0 },
      { inputTokens: 30, cachedInputTokens: 0, outputTokens: 0 },
    ].map((stepUsage) =>
      reconcileOpenCodeRunUsage({
        sessionUsage: after,
        sessionUsageFinal: after,
        resumedSession: true,
        stepUsage,
        stepCostUsd: stepUsage.inputTokens / 1000,
      }),
    );
    expect(charged.map((run) => run.usage.inputTokens)).toEqual([50, 30]);
    expect(charged.every((run) => run.source === "step_finish")).toBe(true);
  });

  it("falls back to step sums when the session reported no usage", () => {
    expect(
      reconcileOpenCodeRunUsage({
        sessionUsage: null,
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
      resumedSession: false,
      stepUsage: steps,
      stepCostUsd: 0,
    });
    expect(reconciled.costUsd).toBeNull();
    // A zero-token zero-cost session (nothing spent) is a real zero.
    expect(
      reconcileOpenCodeRunUsage({
        sessionUsage: totals(0, 0, 0, 0),
        resumedSession: false,
        stepUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        stepCostUsd: 0,
      }).costUsd,
    ).toBe(0);
    // The step_finish fallback applies the same rule.
    expect(
      reconcileOpenCodeRunUsage({
        sessionUsage: null,
        resumedSession: false,
        stepUsage: steps,
        stepCostUsd: 0,
      }).costUsd,
    ).toBeNull();
    expect(
      reconcileOpenCodeRunUsage({
        sessionUsage: null,
        resumedSession: false,
        stepUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        stepCostUsd: 0,
      }).costUsd,
    ).toBe(0);
  });

  it("does not mark a total complete when the last usage update was partial", () => {
    // A complete total of 5/1/2, then a partial update that moved only the
    // output counter to 7. Without a final record the merged total is kept
    // but flagged, and each counter takes the larger of delta and step sums.
    const reconciled = reconcileOpenCodeRunUsage({
      sessionUsage: totals(5, 1, 7, 0.001),
      sessionUsageComplete: false,
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
      sessionUsage: totals(5, 1, 7, 0.005),
      sessionUsageComplete: false,
      sessionUsageFinal: totals(9, 1, 7, 0.01),
      resumedSession: false,
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

  it("refuses a malformed tokens.cache instead of reading it as zero cache", () => {
    expect(readOpenCodeStepUsage({ tokens: { input: 5, output: 2, cache: 7 } }, "step_finish #4").issues).toEqual([
      "step_finish #4: tokens.cache refused (7)",
    ]);
  });
});

describe("malformed nested cache counters on the session path", () => {
  const malformed: unknown[] = [7, "7", [1], true];

  it("never reads a malformed tokens.cache as complete zero cache usage", () => {
    for (const cache of malformed) {
      const payload = { tokens: { input: 5, output: 2, cache }, cost: 0.01 };
      // An update that carries it is incomplete, not a complete 0-cache total.
      expect(readOpenCodeSessionCounters(payload).complete).toBe(false);
      // A final session record that carries it is unusable, so it cannot
      // mark the run's usage complete.
      expect(parseOpenCodeSessionUsageEvent(payload)).toBeNull();
      expect(parseOpenCodeSessionTotals(JSON.stringify({ data: payload }))).toBeNull();
    }
  });

  it("keeps an absent or null tokens.cache as zero cache and complete", () => {
    for (const tokens of [{ input: 5, output: 2 }, { input: 5, output: 2, cache: null }]) {
      expect(readOpenCodeSessionCounters({ tokens }).complete).toBe(true);
      expect(parseOpenCodeSessionUsageEvent({ tokens })).toEqual(totals(5, 0, 2, null));
    }
  });
});
