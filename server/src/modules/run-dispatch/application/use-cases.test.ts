import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_EXPIRY_PAGES_PER_SWEEP,
  createCancelStaleQueuedRun,
  createDispatchResolvedInteractionIfCurrent,
  createEvaluateScheduledRetryGate,
  createExpireStaleQueuedRuns,
  createPromoteDueScheduledRetries,
  createPromoteScheduledRetry,
} from "./use-cases.js";
import type {
  DueRetryRun,
  ExpiredQueuedRunCandidate,
  QueuedRunExpiry,
  RunDispatchWriter,
  ScheduledRetryReader,
} from "./ports.js";

function fakeReader(dueRuns: DueRetryRun[] = []): ScheduledRetryReader & { evaluateCalls: unknown[] } {
  const evaluateCalls: unknown[] = [];
  return {
    evaluateCalls,
    async evaluateScheduledRetryGate(input) {
      evaluateCalls.push(input);
      return { allowed: true };
    },
    async listDueRetries() {
      return dueRuns;
    },
  };
}

function fakeWriter(overrides: Partial<RunDispatchWriter> = {}): RunDispatchWriter & {
  promoteCalls: unknown[];
  cancelCalls: unknown[];
  dispatchCalls: unknown[];
} {
  const promoteCalls: unknown[] = [];
  const cancelCalls: unknown[] = [];
  const dispatchCalls: unknown[] = [];
  return {
    promoteCalls,
    cancelCalls,
    dispatchCalls,
    async promoteOrCancelDueRetry(input) {
      promoteCalls.push(input);
      return { outcome: "promoted", postCommitEffects: [] };
    },
    async cancelStaleQueuedRun(input) {
      cancelCalls.push(input);
      return { outcome: "not_stale" };
    },
    async dispatchResolvedInteractionIfCurrent(input) {
      dispatchCalls.push(input);
      return { dispatched: true, resultPromise: input.dispatch(() => {}) };
    },
    ...overrides,
  };
}

describe("createEvaluateScheduledRetryGate", () => {
  it("maps identifiers and a default clock onto the semantic reader operation", async () => {
    const reader = fakeReader();
    const before = Date.now();
    const result = await createEvaluateScheduledRetryGate({ reader })({
      runId: "run-1",
      companyId: "company-1",
      retryReasonOverride: "max_turns_continuation",
    });

    expect(result).toEqual({ allowed: true });
    expect(reader.evaluateCalls).toHaveLength(1);
    const call = reader.evaluateCalls[0] as { now: Date };
    expect(call).toMatchObject({
      runId: "run-1",
      companyId: "company-1",
      retryReasonOverride: "max_turns_continuation",
    });
    expect(call.now.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("createPromoteScheduledRetry", () => {
  it("passes only semantic identifiers and the clock to the atomic operation", async () => {
    const writer = fakeWriter();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = await createPromoteScheduledRetry({ writer })({
      runId: "run-1",
      companyId: "company-1",
      now,
    });

    expect(result).toEqual({ outcome: "promoted", postCommitEffects: [] });
    expect(writer.promoteCalls).toEqual([{ runId: "run-1", companyId: "company-1", now }]);
  });

  it("passes a gate-suppressed outcome through without a persistence row", async () => {
    const writer = fakeWriter({
      promoteOrCancelDueRetry: vi.fn(async () => ({
        outcome: "gate_suppressed" as const,
        reason: "agent paused",
        errorCode: "agent_not_invokable" as const,
      })),
    });
    const result = await createPromoteScheduledRetry({ writer })({
      runId: "run-1",
      companyId: "company-1",
    });
    expect(result).toEqual({
      outcome: "gate_suppressed",
      reason: "agent paused",
      errorCode: "agent_not_invokable",
    });
  });
});

describe("createPromoteDueScheduledRetries", () => {
  it("keeps due order and caps a sweep at 50 runs", async () => {
    const dueRuns = Array.from({ length: 75 }, (_, i) => ({
      runId: `run-${i}`,
      companyId: "company-1",
    }));
    const reader = fakeReader(dueRuns);
    const writer = fakeWriter();
    const result = await createPromoteDueScheduledRetries({
      reader,
      promoteScheduledRetry: createPromoteScheduledRetry({ writer }),
    })({ cutoff: null });

    expect(result.promoted).toBe(50);
    expect(result.runIds).toEqual(dueRuns.slice(0, 50).map(({ runId }) => runId));
  });
});

describe("createCancelStaleQueuedRun", () => {
  it("delegates the complete read-decide-cancel operation to the writer", async () => {
    const cancelStaleQueuedRun = vi.fn(async () => ({
      outcome: "cancelled" as const,
      reason: "issue reassigned",
      errorCode: "issue_assignee_changed" as const,
      postCommitEffects: [],
    }));
    const writer = fakeWriter({
      cancelStaleQueuedRun,
    });
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = await createCancelStaleQueuedRun({ writer })({
      runId: "run-1",
      companyId: "company-1",
      expectedStatus: "queued",
      now,
    });

    expect(result.outcome).toBe("cancelled");
    expect(cancelStaleQueuedRun).toHaveBeenCalledWith({
      runId: "run-1",
      companyId: "company-1",
      expectedStatus: "queued",
      now,
    });
  });
});

describe("createDispatchResolvedInteractionIfCurrent", () => {
  it("delegates the lock, validation, cancellation, and dispatch boundary", async () => {
    const writer = fakeWriter();
    const dispatch = vi.fn(async () => "started");
    const result = await createDispatchResolvedInteractionIfCurrent({ writer })({
      runId: "run-1",
      companyId: "company-1",
      expectedStatus: "running",
      dispatch,
    });

    expect(result.dispatched).toBe(true);
    expect(writer.dispatchCalls).toHaveLength(1);
  });
});

describe("createExpireStaleQueuedRuns", () => {
  it("stops after the page cap when every page is full of runs it may not expire", { timeout: 10_000 }, async () => {
    let listCalls = 0;
    // An endless queue of old runs whose verdict is never an expiry.
    const expiry: QueuedRunExpiry = {
      async listExpiredQueuedRuns(input) {
        listCalls += 1;
        // Yield a macrotask so a sweep without a page cap fails by timeout
        // instead of starving the event loop.
        await setImmediate();
        return Array.from({ length: input.limit }, (_, i): ExpiredQueuedRunCandidate => ({
          runId: `run-${listCalls}-${i}`,
          companyId: "company-1",
          cursor: { createdAtText: `2026-01-01 00:00:00.${String(listCalls).padStart(6, "0")}+00`, runId: `run-${listCalls}-${i}` },
        }));
      },
      async expireQueuedRun() {
        return { outcome: "not_stale" };
      },
    };

    const result = await createExpireStaleQueuedRuns({ expiry })({ now: new Date("2026-01-03T00:00:00.000Z") });

    // The documented cap: 20 pages of 100 candidates per sweep.
    expect(listCalls).toBe(20);
    expect(MAX_EXPIRY_PAGES_PER_SWEEP).toBe(20);
    expect(result).toMatchObject({ expired: 0, pageCapReached: true, pagesScanned: 20 });
  });

  it("keeps committed cancellations and their effects when one candidate throws mid-sweep", async () => {
    const candidates = Array.from({ length: 100 }, (_, i): ExpiredQueuedRunCandidate => ({
      runId: `run-${i}`,
      companyId: "company-1",
      cursor: { createdAtText: `2026-01-01 00:00:00.${String(i).padStart(6, "0")}+00`, runId: `run-${i}` },
    }));
    const expiry: QueuedRunExpiry = {
      async listExpiredQueuedRuns(input) {
        return input.after ? [] : candidates;
      },
      async expireQueuedRun(input) {
        if (input.runId === "run-49") throw new Error("invalid input syntax for type uuid");
        return {
          outcome: "cancelled",
          reason: "expired",
          errorCode: "queued_run_expired",
          postCommitEffects: [{
            kind: "run_queued",
            companyId: input.companyId,
            runId: input.runId,
            agentId: "agent-1",
            invocationSource: "automation",
            triggerDetail: null,
            wakeupRequestId: null,
          }],
        };
      },
    };

    const result = await createExpireStaleQueuedRuns({ expiry })({ now: new Date("2026-01-03T00:00:00.000Z") });

    expect(result.expired).toBe(99);
    expect(result.postCommitEffects).toHaveLength(99);
    expect(result.postCommitEffects.map((effect) => effect.runId)).toEqual(
      candidates.filter((candidate) => candidate.runId !== "run-49").map((candidate) => candidate.runId),
    );
    expect(result.failures).toEqual([{ runId: "run-49", error: expect.any(Error) }]);
  });

  /** An ordered fake list that honours the keyset cursor and the page limit. */
  function orderedExpiry(
    candidates: ExpiredQueuedRunCandidate[],
    expire: QueuedRunExpiry["expireQueuedRun"],
  ): QueuedRunExpiry {
    return {
      async listExpiredQueuedRuns(input) {
        const start = input.after
          ? candidates.findIndex((candidate) => candidate.runId === input.after?.runId) + 1
          : 0;
        return candidates.slice(start, start + input.limit);
      },
      expireQueuedRun: expire,
    };
  }

  function candidateList(count: number, prefix: string): ExpiredQueuedRunCandidate[] {
    return Array.from({ length: count }, (_, i) => ({
      runId: `${prefix}-${i}`,
      companyId: "company-1",
      cursor: { createdAtText: `2026-01-01 00:00:00.${String(i).padStart(6, "0")}+00`, runId: `${prefix}-${i}` },
    }));
  }

  const cancelled = (runId: string) => ({
    outcome: "cancelled" as const,
    reason: "expired",
    errorCode: "queued_run_expired" as const,
    postCommitEffects: [{
      kind: "run_queued" as const,
      companyId: "company-1",
      runId,
      agentId: "agent-1",
      invocationSource: "automation",
      triggerDetail: null,
      wakeupRequestId: null,
    }],
  });

  it("resumes after the runs it visited, so 2,100 runs whose decision throws cannot hide a newer run", async () => {
    const candidates = [...candidateList(2_100, "throws"), ...candidateList(1, "target")];
    const expiry = orderedExpiry(candidates, async (input) => {
      if (input.runId.startsWith("throws-")) throw new Error("decision failed");
      return cancelled(input.runId);
    });
    const sweep = createExpireStaleQueuedRuns({ expiry });

    const first = await sweep({ now: new Date("2026-01-03T00:00:00.000Z") });
    expect(first).toMatchObject({ expired: 0, pageCapReached: true });
    expect(first.failures).toHaveLength(2_000);

    const second = await sweep({ now: new Date("2026-01-03T00:01:00.000Z") });
    expect(second).toMatchObject({ expired: 1, runIds: ["target-0"], pageCapReached: false });
    expect(second.failures).toHaveLength(100);

    // The end of the list was reached, so the next sweep starts at the oldest run again.
    const third = await sweep({ now: new Date("2026-01-03T00:02:00.000Z") });
    expect(third.failures.map((failure) => failure.runId)[0]).toBe("throws-0");
  });

  it("stops at exactly 100 cancellations even when one page holds more candidates", async () => {
    const candidates = candidateList(150, "run");
    const expiry: QueuedRunExpiry = {
      async listExpiredQueuedRuns(input) {
        return input.after ? [] : candidates;
      },
      async expireQueuedRun(input) {
        return cancelled(input.runId);
      },
    };

    const result = await createExpireStaleQueuedRuns({ expiry })({ now: new Date("2026-01-03T00:00:00.000Z") });

    expect(result.expired).toBe(100);
    expect(result.runIds).toEqual(candidates.slice(0, 100).map((candidate) => candidate.runId));
  });

  it("keeps the effects of committed cancellations when a later page read fails", async () => {
    const candidates = candidateList(100, "run");
    let listCalls = 0;
    const expiry: QueuedRunExpiry = {
      async listExpiredQueuedRuns() {
        listCalls += 1;
        if (listCalls === 2) throw new Error("connection reset");
        return candidates;
      },
      async expireQueuedRun(input) {
        return input.runId === "run-0" ? cancelled(input.runId) : { outcome: "not_stale" };
      },
    };

    const result = await createExpireStaleQueuedRuns({ expiry })({ now: new Date("2026-01-03T00:00:00.000Z") });

    expect(result).toMatchObject({ expired: 1, runIds: ["run-0"] });
    expect(result.postCommitEffects).toHaveLength(1);
    expect(result.failures).toEqual([{ runId: null, error: expect.any(Error) }]);
  });
});
