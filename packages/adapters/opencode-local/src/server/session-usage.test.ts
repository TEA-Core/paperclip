import { describe, expect, it } from "vitest";
import {
  parseOpenCodeSessionTotals,
  parseOpenCodeSessionUsageEvent,
  parseOpenCodeSessionUsagePart,
  reconcileOpenCodeRunUsage,
  subtractOpenCodeSessionTotals,
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
    ).toEqual({ usage: { inputTokens: 105, cachedInputTokens: 20, outputTokens: 9 }, costUsd: 0.5, usageBasis: "per_run", source: "session_usage" });
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
    ).toEqual({ usage: steps, costUsd: 0.01, usageBasis: "per_run", source: "step_finish" });
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
    ).toEqual({ usage: steps, costUsd: 0.01, usageBasis: "per_run", source: "step_finish" });
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
});
