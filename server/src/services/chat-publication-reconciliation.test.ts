import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createCoalescedAsyncTrigger,
  isChatPublicationCommitSignal,
  publishChatPublicationCommitSignal,
} from "./chat-publication-reconciliation.js";
import {
  publishGlobalLiveEvent,
  publishLiveEvent,
  subscribeAllCompanyLiveEvents,
  subscribeCompanyLiveEvents,
  subscribeGlobalLiveEvents,
} from "./live-events.js";
import { SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPES } from "./safe-native-chat-progress.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

// Index of the `}` that closes the `{` at openIndex, or -1. appendRunEvent's body
// is a plain brace block, so brace depth locates its end without a parser.
function matchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

// Locates appendRunEvent's durable write and live emit in the heartbeat source.
// Callers assert the emit index is below appendRunEventEnd: an unbounded
// `indexOf("publishLiveEvent({", persistedEvent)` matches a later function's
// emit, so the ordering assertion could pass with appendRunEvent emitting
// nothing (SUP-16564).
function locateAppendRunEventOrder(source: string) {
  const appendRunEventStart = source.indexOf("async function appendRunEvent(");
  const bodyOpen =
    appendRunEventStart === -1 ? -1 : source.indexOf("{", appendRunEventStart);
  const appendRunEventEnd =
    bodyOpen === -1 ? -1 : matchingBrace(source, bodyOpen);
  const persistedEvent = source.indexOf(
    "await db.insert(heartbeatRunEvents).values(insertValues)",
    appendRunEventStart,
  );
  const emittedEvent = source.indexOf("publishLiveEvent({", persistedEvent);
  return {
    appendRunEventStart,
    appendRunEventEnd,
    persistedEvent,
    emittedEvent,
  };
}

describe("createCoalescedAsyncTrigger", () => {
  it("coalesces notifications received before the scheduled pass starts", async () => {
    const run = vi.fn(async () => undefined);
    const onError = vi.fn();
    const trigger = createCoalescedAsyncTrigger({
      run,
      onError,
      minimumSpacingMs: 0,
    });

    trigger.notify();
    trigger.notify();
    trigger.notify();
    await trigger.drain();

    expect(run).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("records one dirty follow-up when notifications arrive in flight", async () => {
    const started = deferred();
    const release = deferred();
    const run = vi
      .fn(async () => undefined)
      .mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
      });
    const trigger = createCoalescedAsyncTrigger({
      run,
      onError: vi.fn(),
      minimumSpacingMs: 0,
    });

    trigger.notify();
    await started.promise;
    trigger.notify();
    trigger.notify();
    trigger.notify();
    release.resolve();
    await trigger.drain();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not turn periodic recovery polls into dirty follow-ups", async () => {
    const started = deferred();
    const release = deferred();
    const run = vi.fn(async () => {
      started.resolve();
      await release.promise;
    });
    const trigger = createCoalescedAsyncTrigger({
      run,
      onError: vi.fn(),
      minimumSpacingMs: 0,
    });

    trigger.poll();
    await started.promise;
    trigger.poll();
    trigger.poll();
    release.resolve();
    await trigger.drain();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("contains an error and remains available to the recovery poll", async () => {
    const failure = new Error("publication scan failed");
    const run = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(failure);
    const onError = vi.fn();
    const trigger = createCoalescedAsyncTrigger({
      run,
      onError,
      minimumSpacingMs: 0,
    });

    trigger.notify();
    await trigger.drain();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);

    trigger.poll();
    await trigger.drain();
    expect(run).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("joins current work at shutdown and discards only its recoverable dirty bit", async () => {
    const started = deferred();
    const release = deferred();
    const run = vi.fn(async () => {
      started.resolve();
      await release.promise;
    });
    const trigger = createCoalescedAsyncTrigger({
      run,
      onError: vi.fn(),
      minimumSpacingMs: 0,
    });

    trigger.notify();
    await started.promise;
    trigger.notify();
    trigger.stop();
    let drained = false;
    const draining = trigger.drain().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    release.resolve();
    await draining;
    trigger.notify();
    trigger.poll();
    await trigger.drain();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("caps sustained notifications without overlap or losing the last wake", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
    let active = 0;
    let maxActive = 0;
    const run = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
    });
    const trigger = createCoalescedAsyncTrigger({
      run,
      onError: vi.fn(),
      minimumSpacingMs: 100,
    });
    try {
      trigger.notify();
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(1);

      for (let index = 0; index < 9; index += 1) {
        await vi.advanceTimersByTimeAsync(10);
        trigger.notify();
      }
      expect(run).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10);
      expect(run).toHaveBeenCalledTimes(2);

      // A new event immediately after the capped pass is not lost, but it
      // cannot create another scan until the next minimum-spacing boundary.
      trigger.notify();
      await vi.advanceTimersByTimeAsync(99);
      expect(run).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(3);
      expect(maxActive).toBe(1);
      await trigger.drain();
    } finally {
      trigger.stop();
      vi.useRealTimers();
    }
  });

  it("cancels a not-yet-started paced pass during shutdown", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
    const run = vi.fn(async () => undefined);
    const trigger = createCoalescedAsyncTrigger({
      run,
      onError: vi.fn(),
      minimumSpacingMs: 100,
    });
    try {
      trigger.notify();
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-09-08T00:00:00.010Z"));
      trigger.notify();
      trigger.stop();
      await trigger.drain();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      trigger.stop();
      vi.useRealTimers();
    }
  });
});

describe("chat publication commit signals", () => {
  it("emits the accepted signals only after their durable source writes", () => {
    const heartbeatSource = readFileSync(
      new URL("./heartbeat.ts", import.meta.url),
      "utf8",
    );
    // Fork divergence (heartbeat_run_events error column, slice 2c): upstream
    // 51ad751e0 (#12616) routes appendRunEvent's write through the shared
    // `appendHeartbeatRunEvent` helper, and 889947c23 (#13038) pins that literal
    // here. The fork's appendRunEvent keeps the allocate+insert shape instead —
    // `allocateHeartbeatRunEventSeq` + `buildRunEventInsertValues` + a direct
    // insert — because `AppendHeartbeatRunEventInput` has no `error` field and
    // the helper would drop the driver error the fork stores in that column
    // (#565, migration 0245; kept over upstream's helper by the slice 2b fold
    // e5d442a8b). Only the literal changes: this still asserts the durable
    // heartbeat_run_events write lands before the live emit.
    const {
      appendRunEventStart,
      appendRunEventEnd,
      persistedEvent,
      emittedEvent,
    } = locateAppendRunEventOrder(heartbeatSource);
    expect(appendRunEventStart).toBeGreaterThanOrEqual(0);
    expect(appendRunEventEnd).toBeGreaterThan(appendRunEventStart);
    expect(persistedEvent).toBeGreaterThan(appendRunEventStart);
    expect(emittedEvent).toBeGreaterThan(persistedEvent);
    // Fork divergence (ordering bound, SUP-16564): the emit must sit inside
    // appendRunEvent's body, not merely somewhere later in the file. Without
    // this bound the check passes when the emit is moved into another function.
    expect(emittedEvent).toBeLessThan(appendRunEventEnd);

    const presentationMarker = heartbeatSource.indexOf(
      'eventType: "run.presentation.resolved"',
    );
    const committedComment = heartbeatSource.lastIndexOf(
      "await issuesSvc.addComment",
      presentationMarker,
    );
    expect(presentationMarker).toBeGreaterThanOrEqual(0);
    expect(committedComment).toBeGreaterThanOrEqual(0);
    expect(presentationMarker).toBeGreaterThan(committedComment);
  });

  it("rejects an emit that is ordered after the insert but outside appendRunEvent", () => {
    // Same durable write, same emit, same relative order — but the emit sits in
    // a later function. The bare ordering comparison still holds, so only the
    // appendRunEvent bound rejects the layout: that is what makes it strict
    // (SUP-16564).
    const movedEmit = [
      "async function appendRunEvent(run, event) {",
      "  await db.insert(heartbeatRunEvents).values(insertValues);",
      "}",
      "function emitElsewhere(run, event) {",
      "  publishLiveEvent({",
      '    type: "heartbeat.run.event",',
      "  });",
      "}",
    ].join("\n");

    const {
      appendRunEventStart,
      appendRunEventEnd,
      persistedEvent,
      emittedEvent,
    } = locateAppendRunEventOrder(movedEmit);

    expect(appendRunEventStart).toBeGreaterThanOrEqual(0);
    expect(persistedEvent).toBeGreaterThan(appendRunEventStart);
    expect(emittedEvent).toBeGreaterThan(persistedEvent);
    expect(emittedEvent).toBeGreaterThan(appendRunEventEnd);
  });

  it("accepts only the closed durable progress and final-presentation event types", () => {
    for (const eventType of SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPES) {
      expect(
        isChatPublicationCommitSignal({
          type: "heartbeat.run.event",
          payload: { eventType },
        }),
      ).toBe(true);
    }
    expect(
      isChatPublicationCommitSignal({
        type: "heartbeat.run.event",
        payload: { eventType: "run.presentation.resolved" },
      }),
    ).toBe(true);
    expect(
      isChatPublicationCommitSignal({
        type: "heartbeat.run.event",
        payload: { eventType: "lifecycle" },
      }),
    ).toBe(false);
    expect(
      isChatPublicationCommitSignal({
        type: "heartbeat.run.status",
        payload: { eventType: "run.presentation.resolved" },
      }),
    ).toBe(false);
    expect(
      isChatPublicationCommitSignal({
        type: "heartbeat.run.event",
        payload: { eventType: "tool.execution.future_event" },
      }),
    ).toBe(false);
  });

  it("observes company events without changing the public global event stream", () => {
    const observed: string[] = [];
    const globallyObserved: string[] = [];
    const unsubscribe = subscribeAllCompanyLiveEvents((event) => {
      observed.push(`${event.companyId}:${event.type}`);
    });
    const unsubscribeGlobal = subscribeGlobalLiveEvents((event) => {
      globallyObserved.push(`${event.companyId}:${event.type}`);
    });
    try {
      expect(publishChatPublicationCommitSignal({
        companyId: "publication-signal-company",
        issueId: "publication-signal-issue",
        runId: "publication-signal-run",
        agentId: "publication-signal-agent",
        seq: 7,
        eventType: "tool.execution.started",
      })).toBe(true);
      expect(publishChatPublicationCommitSignal({
        companyId: "publication-signal-company",
        issueId: "publication-signal-issue",
        runId: "publication-signal-run",
        agentId: "publication-signal-agent",
        seq: 8,
        eventType: "provider.notice",
      })).toBe(false);
      publishLiveEvent({
        companyId: "publication-signal-company",
        type: "heartbeat.run.status",
        payload: {},
      });
      publishGlobalLiveEvent({
        type: "plugin.ui.updated",
        payload: {},
      });
    } finally {
      unsubscribe();
      unsubscribeGlobal();
    }

    expect(observed).toEqual([
      "publication-signal-company:heartbeat.run.event",
      "publication-signal-company:heartbeat.run.status",
    ]);
    expect(globallyObserved).toEqual(["*:plugin.ui.updated"]);
  });

  it("contains a live subscriber failure after the durable source committed", () => {
    const unsubscribe = subscribeCompanyLiveEvents(
      "publication-signal-listener-failure",
      () => {
        throw new Error("simulated_live_listener_failure");
      },
    );
    try {
      expect(publishChatPublicationCommitSignal({
        companyId: "publication-signal-listener-failure",
        issueId: "publication-signal-issue",
        runId: "publication-signal-run",
        agentId: "publication-signal-agent",
        eventType: "run.presentation.resolved",
      })).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it("ignores pre-publication lifecycle events and wakes only after the commit marker", async () => {
    let publicationCommitted = false;
    const run = vi.fn(async () => {
      expect(publicationCommitted).toBe(true);
    });
    const trigger = createCoalescedAsyncTrigger({
      run,
      onError: vi.fn(),
      minimumSpacingMs: 0,
    });
    const unsubscribe = subscribeAllCompanyLiveEvents((event) => {
      if (isChatPublicationCommitSignal(event)) trigger.notify();
    });
    try {
      // Status/lifecycle events may be emitted before a publication transaction
      // commits or after it rolls back. They must leave recovery to polling.
      publishLiveEvent({
        companyId: "publication-commit-boundary-company",
        type: "heartbeat.run.event",
        payload: { eventType: "lifecycle" },
      });
      await trigger.drain();
      expect(run).not.toHaveBeenCalled();

      publicationCommitted = true;
      publishLiveEvent({
        companyId: "publication-commit-boundary-company",
        type: "heartbeat.run.event",
        payload: { eventType: "run.presentation.resolved" },
      });
      await trigger.drain();
      expect(run).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      trigger.stop();
      await trigger.drain();
    }
  });
});
