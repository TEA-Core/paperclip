import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LiveEvent, SummarySlotIssueRef } from "@paperclipai/shared";

import type { RunLogChunk } from "@/adapters";
import { heartbeatsApi } from "@/api/heartbeats";
import { useCompanyLiveEvent } from "@/context/LiveUpdatesProvider";
import { queryKeys } from "@/lib/queryKeys";
import {
  mergeRunLogChunks,
  parsePersistedLogContent,
  readChunkSeq,
  type ChunkMergeRefs,
  type IncomingRunLogChunk,
} from "@/lib/run-log-chunks";
import {
  closeDanglingCodeFence,
  extractAssistantOutputText,
  parseSummaryDraftStream,
} from "@/lib/summary-draft-stream";

const LOG_POLL_INTERVAL_MS = 1500;
const LOG_READ_LIMIT_BYTES = 256_000;
const MAX_CHUNKS = 400;

/** Run statuses that end a generation and stop its draft stream. */
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "interrupted", "failed", "cancelled", "timed_out"]);

function isTerminalRunStatus(value: unknown): boolean {
  return typeof value === "string" && TERMINAL_RUN_STATUSES.has(value);
}

export interface SummaryDraftStream {
  /** The generation run id, once learned from a live event or the fallback. */
  runId: string | null;
  /** Latest `STATUS:` line streamed by the Summarizer (prefix stripped). */
  statusLine: string | null;
  /** Accumulating draft Markdown (fence-guarded while still streaming). */
  draft: string | null;
  /** True once the closing draft sentinel has arrived. */
  draftClosed: boolean;
  /** Whether any protocol output (status line or draft) has streamed yet. */
  hasStream: boolean;
}

function freshMergeRefs(): ChunkMergeRefs {
  return { seenChunkKeys: new Set<string>(), trimmedSeqFloorByRun: new Map<string, number>() };
}

function readPayloadString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Token-streamed draft for a generating summary slot.
 *
 * Learns the generation run's id from `heartbeat.run.progress` /
 * `heartbeat.run.queued` events (matched by `issueId`), falling back to the
 * issue's active-run endpoint after a page refresh. It then merges the run's
 * assistant `acpx.text_delta` output from both the persisted run-log poller and
 * the live company-events socket (reusing the shared chunk-merge/seq-dedupe
 * util) and parses the STATUS lines + sentinel-wrapped draft out of that stream.
 *
 * Lifecycle-bounded: the tracked run is ended either by its terminal
 * `heartbeat.run.status` event (fast path) or, when that event is missed, by the
 * active-run endpoint continuing to be checked while a run is tracked — a fresh
 * result reporting no current run (or a different later run) clears the run id,
 * discards its accumulated draft, and stops the persisted-log poller, so a
 * finished run can't linger or pollute a later resubmit. A later run for the
 * same issue is rediscovered (active-run poll or a queued/progress event) and
 * streams from a clean slate; finished run ids are poisoned so the endpoint or a
 * stray event can't re-adopt them.
 *
 * Degrades gracefully: no run id / no deltas (WS down, non-ACP adapter, model
 * skipped the protocol) simply yields an empty stream and the card keeps its
 * spinner.
 */
export function useSummaryDraftStream(
  companyId: string | null | undefined,
  generatingIssue: SummarySlotIssueRef | null,
): SummaryDraftStream {
  const issueId = generatingIssue?.id ?? null;
  const [runId, setRunId] = useState<string | null>(null);
  const [chunks, setChunks] = useState<RunLogChunk[]>([]);

  const mergeRefs = useRef<ChunkMergeRefs>(freshMergeRefs());
  const pendingLogRowsRef = useRef(new Map<string, string>());
  const logOffsetRef = useRef(0);
  // Run ids that already reached a terminal status while this slot was tracking
  // them. Poisoned so the active-run endpoint or a stray live event can't
  // re-adopt a finished run and re-stream its draft.
  const finishedRunIdsRef = useRef(new Set<string>());
  // dataUpdatedAt of the active-run result that adopted the currently tracked
  // run. A fresh endpoint result may only finish/supersede that run once it is
  // strictly newer than this, so the (possibly stale, cached) result that
  // adopted the run is never read as its completion.
  const trackingSinceRef = useRef(0);
  // Mirrors activeRunQuery.dataUpdatedAt so the live-event handlers can record
  // the adoption watermark without re-subscribing to the query.
  const activeRunDataUpdatedAtRef = useRef(0);

  const resetStreamState = useCallback(() => {
    setChunks([]);
    mergeRefs.current = freshMergeRefs();
    pendingLogRowsRef.current = new Map();
    logOffsetRef.current = 0;
  }, []);

  // Reset all stream state whenever the tracked generation changes — including
  // a superseded generation (new issue id) or generation ending (null).
  useEffect(() => {
    finishedRunIdsRef.current.clear();
    setRunId(null);
    resetStreamState();
  }, [issueId, resetStreamState]);

  // Clear accumulated chunks/dedupe state whenever the tracked run id changes —
  // to a new run, or to none when the current run finishes — so a finished run's
  // draft is discarded and the next run starts from a clean slate.
  useEffect(() => {
    resetStreamState();
  }, [runId, resetStreamState]);

  const appendChunks = useCallback((incoming: IncomingRunLogChunk[]) => {
    if (incoming.length === 0) return;
    setChunks((prev) => {
      const { chunks: merged, changed } = mergeRunLogChunks(
        "summary-draft",
        prev,
        incoming,
        mergeRefs.current,
        MAX_CHUNKS,
      );
      return changed ? merged : prev;
    });
  }, []);

  // Record that the tracked run finished: poison it and clear the run id. The
  // cleared run id tears down the log poller (its effect early-returns) and the
  // [runId] effect above discards the accumulated draft.
  const finishRun = useCallback((finishedRunId: string) => {
    finishedRunIdsRef.current.add(finishedRunId);
    setRunId((current) => (current === finishedRunId ? null : current));
  }, []);

  // Learn the generation run id from live progress/queued events for the issue.
  // Ignore run ids we already saw finish, so a stray event can't resurrect a
  // finished run's stream.
  useCompanyLiveEvent((event: LiveEvent) => {
    if (!issueId) return;
    if (event.type !== "heartbeat.run.progress" && event.type !== "heartbeat.run.queued") return;
    const payload = event.payload ?? {};
    if (payload.issueId !== issueId) return;
    const nextRunId = readPayloadString(payload.runId);
    if (!nextRunId) return;
    if (finishedRunIdsRef.current.has(nextRunId)) return;
    trackingSinceRef.current = activeRunDataUpdatedAtRef.current;
    setRunId((current) => (current === nextRunId ? current : nextRunId));
  });

  // Finish the stream when the tracked run reaches a terminal status. The
  // payload carries only the run id (no issueId), so match it against the run we
  // are currently tracking.
  useCompanyLiveEvent((event: LiveEvent) => {
    if (!runId) return;
    if (event.type !== "heartbeat.run.status") return;
    const payload = event.payload ?? {};
    const nextRunId = readPayloadString(payload.runId);
    if (!nextRunId || nextRunId !== runId) return;
    if (isTerminalRunStatus(payload.status)) finishRun(nextRunId);
  });

  // The issue's active run. This stays enabled and refetching for the whole
  // tracked generation — not just before a run is adopted. Before a run is known
  // it is discovery (a refresh mid-generation adopts the endpoint's current
  // run); while a run IS tracked it is the lifecycle check that proves the
  // tracked run is still current. A fresh result that no longer reports the
  // tracked run (null, or a different later run) is the signal to finish/reset
  // it — even if its `heartbeat.run.status` event was missed during a reconnect
  // or delivery gap — and resume same-issue discovery instead of keeping a dead
  // run's persisted-log poller alive indefinitely.
  const activeRunQuery = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId ?? "__none__"),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId!),
    enabled: Boolean(companyId) && Boolean(issueId),
    retry: false,
    refetchInterval: 4000,
  });
  activeRunDataUpdatedAtRef.current = activeRunQuery.dataUpdatedAt;

  // Drive run adoption and finish from each fresh active-run result. The result
  // that adopted the current run — and any stale/cached value older than it — is
  // never read as a completion: only a strictly newer result may finish or
  // supersede the tracked run.
  const activeRunId = activeRunQuery.data?.id ?? null;
  useEffect(() => {
    if (runId === null) {
      // Discovery: adopt the endpoint's current run unless it already finished.
      if (activeRunId && !finishedRunIdsRef.current.has(activeRunId)) {
        trackingSinceRef.current = activeRunQuery.dataUpdatedAt;
        setRunId(activeRunId);
      }
      return;
    }
    if (activeRunQuery.dataUpdatedAt <= trackingSinceRef.current) return;
    if (activeRunId === runId) return; // endpoint still reports this run — keep it.
    // Endpoint reports no current run (null) or a different later run: clear the
    // tracked run (tearing down its log poller and discarding its draft) and, if
    // it is a new run, adopt it from a clean slate.
    finishRun(runId);
    if (activeRunId && !finishedRunIdsRef.current.has(activeRunId)) {
      trackingSinceRef.current = activeRunQuery.dataUpdatedAt;
      setRunId(activeRunId);
    }
  }, [activeRunQuery.dataUpdatedAt, activeRunId, runId, finishRun, setRunId]);

  // Live token deltas over the shared company-events socket.
  useCompanyLiveEvent((event: LiveEvent) => {
    if (!runId) return;
    if (event.type !== "heartbeat.run.log") return;
    const payload = event.payload ?? {};
    if (payload.runId !== runId) return;
    const chunk = readPayloadString(payload.chunk);
    if (!chunk) return;
    const ts = readPayloadString(payload.ts) ?? event.createdAt;
    const stream =
      payload.stream === "stderr" ? "stderr" : payload.stream === "system" ? "system" : "stdout";
    appendChunks([
      { ts, stream, chunk, seq: readChunkSeq(payload.seq), dedupeKey: `log:${runId}:${ts}:${stream}:${chunk}` },
    ]);
  });

  // Hydrate already-emitted output and fill any gaps from the persisted run log.
  // The interval is torn down (cleanup) the moment the run id clears, so a
  // finished run no longer drives persisted-log reads.
  useEffect(() => {
    if (!runId) return;
    logOffsetRef.current = 0;
    pendingLogRowsRef.current = new Map();

    let cancelled = false;
    const read = async () => {
      try {
        const result = await heartbeatsApi.log(runId, logOffsetRef.current, LOG_READ_LIMIT_BYTES);
        if (cancelled) return;
        appendChunks(parsePersistedLogContent(runId, result.content, pendingLogRowsRef.current));
        if (result.nextOffset !== undefined) {
          logOffsetRef.current = result.nextOffset;
        } else if (result.content.length > 0) {
          logOffsetRef.current += result.content.length;
        }
      } catch {
        // Ignore transient/404 reads (log not yet flushed, run just started).
      }
    };

    void read();
    const interval = window.setInterval(() => void read(), LOG_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [runId, appendChunks]);

  const parse = useMemo(() => parseSummaryDraftStream(extractAssistantOutputText(chunks)), [chunks]);

  const draft = parse.draft !== null && !parse.draftClosed
    ? closeDanglingCodeFence(parse.draft)
    : parse.draft;

  return {
    runId,
    statusLine: parse.statusLine,
    draft,
    draftClosed: parse.draftClosed,
    hasStream: parse.draft !== null || parse.statusLine !== null,
  };
}
