import { describe, expect, it } from "vitest";

import {
  RUNNING_TIMEOUT_VERDICTS,
  attachEvidenceOrRethrow,
  buildRunningTimeoutEvidence,
  classifyRunningTimeout,
  createStatusFrameCollector,
  validateLiveRuns,
} from "./composer-stop-evidence.js";

describe("composer stop evidence", () => {
  it("ignores unowned and non-JSON websocket frames", () => {
    const collector = createStatusFrameCollector("company-1");

    collector.ingest("not json");
    collector.ingest(JSON.stringify({ companyId: "company-2", type: "heartbeat.run.status" }));
    collector.ingest(JSON.stringify({ companyId: "company-1", type: "other" }));

    expect(collector.entries).toEqual([]);
    expect(collector.instrumentationFailures).toEqual([]);
  });

  it("records instrumentation only for an owned status frame with malformed payload", () => {
    const collector = createStatusFrameCollector("company-1");

    collector.ingest(JSON.stringify({
      companyId: "company-1",
      type: "heartbeat.run.status",
      payload: null,
    }));

    expect(collector.entries).toEqual([]);
    expect(collector.instrumentationFailures).toHaveLength(1);
    expect(collector.instrumentationFailures[0].stage).toBe("websocket-status-frame");
  });

  it("does not carry global frame failures into a later poll window", () => {
    const collector = createStatusFrameCollector("company-1");
    collector.instrumentationFailures.push({
      atIso: "2026-01-01T00:00:00.000Z",
      stage: "old-window",
      message: "old",
    });

    const evidence = buildRunningTimeoutEvidence({
      issueId: "issue-1",
      adapter: "paperclip_runner",
      companyId: "company-1",
      pollWindowStartMs: Date.parse("2026-01-01T00:01:00.000Z"),
      pollWindowEndMs: Date.parse("2026-01-01T00:02:00.000Z"),
      originalRunIds: ["run-1"],
      observedRunRows: [{ id: "run-1", status: "running", observedAtIso: "2026-01-01T00:01:30.000Z" }],
      finalLiveRuns: [{ id: "run-1", status: "running" }],
      apiErrorsDuringWindow: [],
      instrumentationFailures: collector.instrumentationFailures,
      statusMetadata: [],
      finalSnapshots: [],
      finalIssueState: { status: "in_progress", executionRunId: "run-1" },
      finalContinuationDelivery: null,
      hasResolveEvidence: false,
      recoveryActionPresentAtResolve: null,
      settledActionFoundAtResolve: null,
      originalProviderAliveAtResolve: null,
      resolveCompletedAtIso: null,
      resumeInitiatedAtIso: "2026-01-01T00:01:00.000Z",
    });

    expect(evidence.instrumentationFailures).toEqual([]);
    expect(evidence.verdict).toBe(RUNNING_TIMEOUT_VERDICTS.NO_TRANSITION);
  });

  it("treats a malformed live-runs row as an observation failure without counting the poll", () => {
    expect(validateLiveRuns([{ status: "running" }])).toMatchObject({ valid: false });
    expect(validateLiveRuns([{ id: "run-1", status: 42 }])).toMatchObject({ valid: false });

    expect(classifyRunningTimeout({
      adapter: "paperclip_runner",
      apiErrorsDuringWindow: [],
      instrumentationFailures: [],
      observedRunRows: [],
      successfulPollCount: 0,
      finalNewRunIds: [],
      anyNewRunRunning: false,
      finalIssueStatus: "in_progress",
      finalContinuationDelivery: null,
      hasResolveEvidence: false,
      recoveryActionPresentAtResolve: null,
      settledActionFoundAtResolve: null,
      finalSnapshotFailure: null,
    }).verdict).toBe(RUNNING_TIMEOUT_VERDICTS.OBSERVATION_FAILURE);
  });

  it("classifies a successor found only in the final snapshot as late", () => {
    expect(classifyRunningTimeout({
      adapter: "paperclip_runner",
      apiErrorsDuringWindow: [],
      instrumentationFailures: [],
      observedRunRows: [],
      successfulPollCount: 2,
      finalNewRunIds: ["successor"],
      anyNewRunRunning: false,
      finalIssueStatus: "in_progress",
      finalContinuationDelivery: null,
      hasResolveEvidence: false,
      recoveryActionPresentAtResolve: null,
      settledActionFoundAtResolve: null,
      finalSnapshotFailure: null,
    }).verdict).toBe(RUNNING_TIMEOUT_VERDICTS.LATE_TRANSITION);
  });

  it("keeps the precedence order explicit", () => {
    const input = {
      adapter: "paperclip_runner" as const,
      apiErrorsDuringWindow: [{ atIso: "now", url: "/live-runs", message: "failed" }],
      instrumentationFailures: [{ atIso: "now", stage: "attachment", message: "failed" }],
      observedRunRows: [],
      successfulPollCount: 0,
      finalNewRunIds: ["successor"],
      anyNewRunRunning: true,
      finalIssueStatus: "cancelled",
      finalContinuationDelivery: null,
      hasResolveEvidence: false,
      recoveryActionPresentAtResolve: null,
      settledActionFoundAtResolve: null,
      finalSnapshotFailure: "failed",
    };
    expect(classifyRunningTimeout(input).verdict).toBe(RUNNING_TIMEOUT_VERDICTS.INSTRUMENTATION_FAILURE);
    expect(classifyRunningTimeout({ ...input, instrumentationFailures: [] }).verdict).toBe(RUNNING_TIMEOUT_VERDICTS.OBSERVATION_FAILURE);
    expect(classifyRunningTimeout({ ...input, instrumentationFailures: [], apiErrorsDuringWindow: [], finalSnapshotFailure: null, successfulPollCount: 1, anyNewRunRunning: false }).verdict).toBe(RUNNING_TIMEOUT_VERDICTS.LATE_TRANSITION);
    expect(classifyRunningTimeout({ ...input, instrumentationFailures: [], apiErrorsDuringWindow: [], finalSnapshotFailure: null, successfulPollCount: 1, finalNewRunIds: [], anyNewRunRunning: true }).verdict).toBe(RUNNING_TIMEOUT_VERDICTS.RESUME_TRANSITION_OBSERVED);
    expect(classifyRunningTimeout({ ...input, instrumentationFailures: [], apiErrorsDuringWindow: [], finalSnapshotFailure: null, successfulPollCount: 1, finalNewRunIds: [], anyNewRunRunning: false }).verdict).toBe(RUNNING_TIMEOUT_VERDICTS.NO_TRANSITION);
  });

  it("records attachment failure and rethrows the original timeout unchanged", async () => {
    const timeout = new Error("timeout");
    const failures: { atIso: string; stage: string; message: string }[] = [];

    await expect(attachEvidenceOrRethrow(
      async () => {
        throw new Error("attachment failed");
      },
      {},
      failures,
      "attachment",
      timeout,
    )).rejects.toBe(timeout);
    expect(failures).toHaveLength(1);
    expect(failures[0].stage).toBe("attachment");
  });

  it("shapes observed and final evidence without stringifying malformed rows", () => {
    const evidence = buildRunningTimeoutEvidence({
      issueId: "issue-1",
      adapter: "paperclip_runner",
      companyId: "company-1",
      pollWindowStartMs: 1000,
      pollWindowEndMs: 2000,
      originalRunIds: ["run-1"],
      observedRunRows: [{ id: "run-1", status: "running", observedAtIso: "1970-01-01T00:00:01.500Z" }],
      finalLiveRuns: [{ id: "run-1", status: "running" }],
      apiErrorsDuringWindow: [],
      instrumentationFailures: [],
      statusMetadata: [
        { issueId: "issue-1", status: "running", eventCreatedAt: "1970-01-01T00:00:01.500Z" },
        { issueId: "issue-1", status: "cancelled", eventCreatedAt: "1970-01-01T00:00:03.000Z" },
      ],
      finalSnapshots: [],
      finalIssueState: { status: "in_progress", executionRunId: "run-1" },
      finalContinuationDelivery: null,
      hasResolveEvidence: false,
      recoveryActionPresentAtResolve: null,
      settledActionFoundAtResolve: null,
      originalProviderAliveAtResolve: null,
      resolveCompletedAtIso: null,
      resumeInitiatedAtIso: "1970-01-01T00:00:01.000Z",
    });

    expect(evidence.statusFramesDuringWindow).toHaveLength(1);
    expect(evidence.observedRunRows).toEqual([{ id: "run-1", status: "running", observedAtIso: "1970-01-01T00:00:01.500Z" }]);
    expect(evidence.verdict).toBe(RUNNING_TIMEOUT_VERDICTS.NO_TRANSITION);
  });
});
