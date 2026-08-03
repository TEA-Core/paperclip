import { describe, expect, it } from "vitest";
import {
  canDetectStillbornRun,
  isStillbornRun,
  DEFAULT_STILLBORN_RUN_TTL_MS,
  type StillbornRunCandidate,
} from "../services/run-stillborn.js";

const NOW = new Date("2026-07-30T03:10:00.000Z");

/** The SUP-9509 run: created, leased an environment, then never executed. */
function stillbornRun(overrides: Partial<StillbornRunCandidate> = {}): StillbornRunCandidate {
  return {
    status: "running",
    finishedAt: null,
    startedAt: new Date(NOW.getTime() - DEFAULT_STILLBORN_RUN_TTL_MS - 1000),
    createdAt: new Date(NOW.getTime() - DEFAULT_STILLBORN_RUN_TTL_MS - 1000),
    processPid: null,
    processGroupId: null,
    processStartedAt: null,
    lastOutputAt: null,
    lastUsefulActionAt: null,
    livenessState: null,
    logBytes: null,
    usageJson: null,
    resultJson: null,
    ...overrides,
  };
}

describe("isStillbornRun", () => {
  it("detects a run that has sat running past the TTL with zero telemetry", () => {
    expect(isStillbornRun(stillbornRun(), NOW)).toBe(true);
  });

  it("waits out the TTL before acting", () => {
    const young = stillbornRun({
      startedAt: new Date(NOW.getTime() - 60_000),
      createdAt: new Date(NOW.getTime() - 60_000),
    });
    expect(isStillbornRun(young, NOW)).toBe(false);
  });

  it("falls back to createdAt when the run never recorded a start", () => {
    expect(isStillbornRun(stillbornRun({ startedAt: null }), NOW)).toBe(true);
  });

  it("ignores runs that are not running or have already finished", () => {
    expect(isStillbornRun(stillbornRun({ status: "queued" }), NOW)).toBe(false);
    expect(isStillbornRun(stillbornRun({ status: "succeeded" }), NOW)).toBe(false);
    expect(isStillbornRun(stillbornRun({ finishedAt: NOW }), NOW)).toBe(false);
  });

  it("never touches a run that shows any sign of life", () => {
    const signsOfLife: Array<Partial<StillbornRunCandidate>> = [
      { processPid: 4242 },
      { processGroupId: 4242 },
      { processStartedAt: new Date(NOW.getTime() - 60_000) },
      { lastOutputAt: new Date(NOW.getTime() - 60_000) },
      { lastUsefulActionAt: new Date(NOW.getTime() - 60_000) },
      { livenessState: "productive" },
      { logBytes: 1 },
      { usageJson: { inputTokens: 10 } },
      { resultJson: { stopReason: "completed" } },
    ];

    for (const sign of signsOfLife) {
      expect(isStillbornRun(stillbornRun(sign), NOW)).toBe(false);
    }
  });

  it("treats zero log bytes as no output rather than as output", () => {
    expect(isStillbornRun(stillbornRun({ logBytes: 0 }), NOW)).toBe(true);
  });

  it("accepts a custom TTL", () => {
    const run = stillbornRun({
      startedAt: new Date(NOW.getTime() - 90_000),
      createdAt: new Date(NOW.getTime() - 90_000),
    });
    expect(isStillbornRun(run, NOW, 60_000)).toBe(true);
    expect(isStillbornRun(run, NOW, 120_000)).toBe(false);
  });
});

describe("canDetectStillbornRun", () => {
  it("applies to adapters that spawn a tracked local child", () => {
    for (const adapterType of ["opencode_local", "codex_local", "claude_local", "cursor"]) {
      expect(canDetectStillbornRun(adapterType)).toBe(true);
    }
  });

  it("does not apply to adapters with no local child process", () => {
    // These legitimately have no pid, and one that makes a single long upstream call writes no
    // output, usage or result until it returns — indistinguishable from a run that never began.
    for (const adapterType of ["http", "process", "openclaw_gateway", "sandbox", null, undefined]) {
      expect(canDetectStillbornRun(adapterType)).toBe(false);
    }
  });
});
