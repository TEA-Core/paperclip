// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanyLiveEventHandler } from "@/context/LiveUpdatesProvider";
import type { LiveEvent, SummarySlotIssueRef } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __liveUpdatesTestUtils } from "@/context/LiveUpdatesProvider";
import { useSummaryDraftStream } from "./useSummaryDraftStream";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { LiveEventSubscriptionContext, dispatchLiveEventToSubscribers } = __liveUpdatesTestUtils;

const mockHeartbeatsApi = vi.hoisted(() => ({ log: vi.fn(), activeRunForIssue: vi.fn() }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: mockHeartbeatsApi }));

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushQueries() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function issue(id: string): SummarySlotIssueRef {
  return { id, identifier: `PAP-${id}`, title: "Summarize project", status: "in_progress" };
}

function progressEvent(issueId: string, runId: string): LiveEvent {
  return {
    id: 1,
    companyId: "company-1",
    type: "heartbeat.run.progress",
    createdAt: "2026-07-15T00:00:00.000Z",
    payload: { issueId, runId },
  };
}

function logEvent(runId: string, seq: number, text: string): LiveEvent {
  return {
    id: seq,
    companyId: "company-1",
    type: "heartbeat.run.log",
    createdAt: `2026-07-15T00:00:0${seq}.000Z`,
    payload: {
      runId,
      seq,
      ts: `2026-07-15T00:00:0${seq}.000Z`,
      stream: "stdout",
      chunk: JSON.stringify({ type: "acpx.text_delta", text, channel: "output" }),
    },
  };
}

function statusEvent(runId: string, status: string): LiveEvent {
  return {
    id: 999,
    companyId: "company-1",
    type: "heartbeat.run.status",
    createdAt: "2026-07-15T00:01:00.000Z",
    payload: { runId, status },
  };
}

// Fake-timer-friendly settle: advance zero-ms timers + flush microtasks so the
// react-query fetches and the persisted-log reads resolve. (The real-timer
// `flushQueries` above deadlocks under fake timers.)
async function settleNow() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

// Advance the persisted-log poller (1500ms interval) forward and flush follow-ups.
async function advanceTimers(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

interface Captured {
  runId: string | null;
  statusLine: string | null;
  draft: string | null;
  draftClosed: boolean;
  hasStream: boolean;
}

const captured: { current: Captured | null } = { current: null };

function Harness({ generatingIssue }: { generatingIssue: SummarySlotIssueRef | null }) {
  const stream = useSummaryDraftStream("company-1", generatingIssue);
  captured.current = stream;
  return null;
}

function renderHarness(
  generatingIssue: SummarySlotIssueRef | null,
  subscribers: Set<CompanyLiveEventHandler>,
): { root: Root; rerender: (next: SummarySlotIssueRef | null) => void } {
  const container = document.createElement("div");
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const subscription = {
    subscribe: (fn: CompanyLiveEventHandler) => {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
  const render = (next: SummarySlotIssueRef | null) => {
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <LiveEventSubscriptionContext.Provider value={subscription}>
            <Harness generatingIssue={next} />
          </LiveEventSubscriptionContext.Provider>
        </QueryClientProvider>,
      );
    });
  };
  render(generatingIssue);
  return { root, rerender: render };
}

// Full protocol output split into tiny slices to simulate token streaming with
// markers landing mid-slice.
const PROTOCOL = [
  "STATUS: reading the slot…",
  "STATUS: writing the summary…",
  "<<<SUMMARY-DRAFT>>>",
  "## Needs you",
  "- Approve the launch",
  "<<<END-SUMMARY-DRAFT>>>",
].join("\n");

function sliceEvents(runId: string, text: string, size: number): LiveEvent[] {
  const events: LiveEvent[] = [];
  let seq = 1;
  for (let i = 0; i < text.length; i += size) {
    events.push(logEvent(runId, seq, text.slice(i, i + size)));
    seq += 1;
  }
  return events;
}

describe("useSummaryDraftStream", () => {
  let root: Root | null = null;

  beforeEach(() => {
    captured.current = null;
    mockHeartbeatsApi.log.mockResolvedValue({ runId: "run-1", store: "s", logRef: "r", content: "", nextOffset: 0 });
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(null);
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("streams status line and draft from markers split across delta boundaries", async () => {
    const subscribers = new Set<CompanyLiveEventHandler>();
    ({ root } = renderHarness(issue("1"), subscribers));
    await flushQueries();

    // Learn the run id from a progress event.
    await act(async () => {
      dispatchLiveEventToSubscribers(subscribers, "company-1", progressEvent("1", "run-1"));
    });
    await flushQueries();
    expect(captured.current?.runId).toBe("run-1");

    // Stream the whole protocol in 4-char slices.
    await act(async () => {
      for (const event of sliceEvents("run-1", PROTOCOL, 4)) {
        dispatchLiveEventToSubscribers(subscribers, "company-1", event);
      }
    });
    await flushQueries();

    expect(captured.current?.statusLine).toBe("writing the summary…");
    expect(captured.current?.draft).toBe("## Needs you\n- Approve the launch");
    expect(captured.current?.draftClosed).toBe(true);
    expect(captured.current?.hasStream).toBe(true);
  });

  it("shows a partial draft and typing state before the closing sentinel", async () => {
    const subscribers = new Set<CompanyLiveEventHandler>();
    ({ root } = renderHarness(issue("1"), subscribers));
    await flushQueries();
    await act(async () => {
      dispatchLiveEventToSubscribers(subscribers, "company-1", progressEvent("1", "run-1"));
    });

    const partial = "<<<SUMMARY-DRAFT>>>\n## Needs you\n- Approve";
    await act(async () => {
      dispatchLiveEventToSubscribers(subscribers, "company-1", logEvent("run-1", 1, partial));
    });
    await flushQueries();

    expect(captured.current?.draft).toBe("## Needs you\n- Approve");
    expect(captured.current?.draftClosed).toBe(false);
  });

  it("falls back to spinner state when the model skips the markers", async () => {
    const subscribers = new Set<CompanyLiveEventHandler>();
    ({ root } = renderHarness(issue("1"), subscribers));
    await flushQueries();
    await act(async () => {
      dispatchLiveEventToSubscribers(subscribers, "company-1", progressEvent("1", "run-1"));
    });

    await act(async () => {
      dispatchLiveEventToSubscribers(subscribers, "company-1", logEvent("run-1", 1, "just prose, no markers here"));
    });
    await flushQueries();

    expect(captured.current?.draft).toBeNull();
    expect(captured.current?.draftClosed).toBe(false);
    expect(captured.current?.hasStream).toBe(false);
  });

  it("ignores log events for a different run", async () => {
    const subscribers = new Set<CompanyLiveEventHandler>();
    ({ root } = renderHarness(issue("1"), subscribers));
    await flushQueries();
    await act(async () => {
      dispatchLiveEventToSubscribers(subscribers, "company-1", progressEvent("1", "run-1"));
    });

    await act(async () => {
      dispatchLiveEventToSubscribers(subscribers, "company-1", logEvent("run-999", 1, "<<<SUMMARY-DRAFT>>>\nleak"));
    });
    await flushQueries();

    expect(captured.current?.draft).toBeNull();
  });

  it("resets state when the tracked generation is superseded", async () => {
    const subscribers = new Set<CompanyLiveEventHandler>();
    let rerender: (next: SummarySlotIssueRef | null) => void;
    ({ root, rerender } = renderHarness(issue("1"), subscribers));
    await flushQueries();
    await act(async () => {
      dispatchLiveEventToSubscribers(subscribers, "company-1", progressEvent("1", "run-1"));
    });
    await flushQueries();
    await act(async () => {
      dispatchLiveEventToSubscribers(
        subscribers,
        "company-1",
        logEvent("run-1", 1, "<<<SUMMARY-DRAFT>>>\nold draft\n<<<END-SUMMARY-DRAFT>>>"),
      );
    });
    await flushQueries();
    expect(captured.current?.draft).toBe("old draft");

    // A new generation issue supersedes the old one → everything resets.
    await act(async () => {
      rerender(issue("2"));
    });
    await flushQueries();
    expect(captured.current?.runId).toBeNull();
    expect(captured.current?.draft).toBeNull();
    expect(captured.current?.hasStream).toBe(false);
  });

  it("rehydrates the draft from the persisted run log after a refresh", async () => {
    // Simulate a page refresh mid-generation: no live event has run id yet, so
    // the hook resolves it from the active-run endpoint and reads the log.
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue({ id: "run-1", adapterType: "claude-local" });
    const persistedRows =
      [
        "STATUS: writing the summary…",
        "<<<SUMMARY-DRAFT>>>",
        "## Needs you",
        "Recovered after refresh.",
        "<<<END-SUMMARY-DRAFT>>>",
      ]
        .map((line, index) =>
          JSON.stringify({
            ts: `t${index}`,
            stream: "stdout",
            seq: index + 1,
            chunk: JSON.stringify({ type: "acpx.text_delta", text: `${line}\n`, channel: "output" }),
          }),
        )
        .join("\n") + "\n";
    mockHeartbeatsApi.log.mockResolvedValue({
      runId: "run-1",
      store: "s",
      logRef: "r",
      content: persistedRows,
      nextOffset: persistedRows.length,
    });

    const subscribers = new Set<CompanyLiveEventHandler>();
    ({ root } = renderHarness(issue("1"), subscribers));
    await flushQueries();

    expect(captured.current?.runId).toBe("run-1");
    expect(captured.current?.draft).toBe("## Needs you\nRecovered after refresh.");
    expect(captured.current?.draftClosed).toBe(true);
  });

  it("stops persisted-log polling and clears the draft when the tracked run finishes", async () => {
    vi.useFakeTimers();
    const subscribers = new Set<CompanyLiveEventHandler>();
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(null);
    ({ root } = renderHarness(issue("1"), subscribers));
    await settleNow();

    // Learn the run and stream a closed draft.
    await act(async () => {
      dispatchLiveEventToSubscribers(subscribers, "company-1", progressEvent("1", "run-1"));
    });
    await settleNow();
    await act(async () => {
      dispatchLiveEventToSubscribers(
        subscribers,
        "company-1",
        logEvent("run-1", 1, "<<<SUMMARY-DRAFT>>>\nold draft\n<<<END-SUMMARY-DRAFT>>>"),
      );
    });
    await settleNow();
    expect(captured.current?.runId).toBe("run-1");
    expect(captured.current?.draft).toBe("old draft");

    // The persisted-log poller is live: advancing time reads more log.
    const readsBefore = mockHeartbeatsApi.log.mock.calls.length;
    await advanceTimers(1500 * 3);
    expect(mockHeartbeatsApi.log.mock.calls.length).toBeGreaterThan(readsBefore);

    // The run reaches a terminal status → stop polling + clear the draft.
    await act(async () => {
      dispatchLiveEventToSubscribers(subscribers, "company-1", statusEvent("run-1", "succeeded"));
    });
    await settleNow();
    expect(captured.current?.runId).toBeNull();
    expect(captured.current?.draft).toBeNull();
    expect(captured.current?.hasStream).toBe(false);

    // No more log reads: the poller is torn down when the run id clears.
    const readsAfterFinish = mockHeartbeatsApi.log.mock.calls.length;
    await advanceTimers(1500 * 3);
    await settleNow();
    expect(mockHeartbeatsApi.log.mock.calls.length).toBe(readsAfterFinish);
  });

  it("rediscovers a later run for the same issue and streams a fresh draft", async () => {
    vi.useFakeTimers();
    const subscribers = new Set<CompanyLiveEventHandler>();
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(null);
    ({ root } = renderHarness(issue("1"), subscribers));
    await settleNow();

    // First run streams a closed draft.
    await act(async () => {
      dispatchLiveEventToSubscribers(subscribers, "company-1", progressEvent("1", "run-1"));
    });
    await settleNow();
    await act(async () => {
      dispatchLiveEventToSubscribers(
        subscribers,
        "company-1",
        logEvent("run-1", 1, "<<<SUMMARY-DRAFT>>>\nfirst\n<<<END-SUMMARY-DRAFT>>>"),
      );
    });
    await settleNow();
    expect(captured.current?.draft).toBe("first");

    // The first run finishes → draft is cleared.
    await act(async () => {
      dispatchLiveEventToSubscribers(subscribers, "company-1", statusEvent("run-1", "succeeded"));
    });
    await settleNow();
    expect(captured.current?.runId).toBeNull();
    expect(captured.current?.draft).toBeNull();

    // A later run for the SAME issue is discovered and starts from a clean slate.
    await act(async () => {
      dispatchLiveEventToSubscribers(subscribers, "company-1", progressEvent("1", "run-2"));
    });
    await settleNow();
    expect(captured.current?.runId).toBe("run-2");
    expect(captured.current?.draft).toBeNull();

    await act(async () => {
      dispatchLiveEventToSubscribers(
        subscribers,
        "company-1",
        logEvent("run-2", 1, "<<<SUMMARY-DRAFT>>>\nsecond\n<<<END-SUMMARY-DRAFT>>>"),
      );
    });
    await settleNow();
    expect(captured.current?.draft).toBe("second");
  });

  it("resets when the active-run endpoint loses the tracked run, then rediscovers a later one", async () => {
    vi.useFakeTimers();
    const subscribers = new Set<CompanyLiveEventHandler>();
    // Endpoint reports run-1 as the issue's active run; the hook adopts it.
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue({ id: "run-1", adapterType: "claude-local" });
    ({ root } = renderHarness(issue("1"), subscribers));
    await settleNow();
    expect(captured.current?.runId).toBe("run-1");

    // Stream a closed draft for the tracked run.
    await act(async () => {
      dispatchLiveEventToSubscribers(
        subscribers,
        "company-1",
        logEvent("run-1", 1, "<<<SUMMARY-DRAFT>>>\nold\n<<<END-SUMMARY-DRAFT>>>"),
      );
    });
    await settleNow();
    expect(captured.current?.draft).toBe("old");

    // The endpoint loses the run (its terminal event was missed). A fresh 4s poll
    // must stop the log poller and clear the run id + draft. Advance well past one
    // discovery interval so a refetch is guaranteed to fire and land.
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(null);
    await advanceTimers(4000 * 2);
    await settleNow();
    expect(captured.current?.runId).toBeNull();
    expect(captured.current?.draft).toBeNull();
    expect(captured.current?.hasStream).toBe(false);

    // Poller is torn down: more time passes without any further persisted-log reads.
    const readsAfterReset = mockHeartbeatsApi.log.mock.calls.length;
    await advanceTimers(4000 * 2);
    await settleNow();
    expect(mockHeartbeatsApi.log.mock.calls.length).toBe(readsAfterReset);

    // A later run for the same issue is rediscovered and starts from a clean slate.
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue({ id: "run-2", adapterType: "claude-local" });
    await advanceTimers(4000 * 2);
    await settleNow();
    expect(captured.current?.runId).toBe("run-2");
    expect(captured.current?.draft).toBeNull();
    expect(captured.current?.hasStream).toBe(false);
  });
});
