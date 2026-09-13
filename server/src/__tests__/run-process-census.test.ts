import { describe, expect, it } from "vitest";
import { runningProcesses } from "../adapters/index.js";
import { countLiveProcessGroupMembers } from "../services/local-service-supervisor.js";
import {
  censusRunProcessGroups,
  runProcessCensusSweep,
  summarizeRunProcessCounts,
} from "../services/run-process-census.js";

type Entry = readonly [string, { processGroupId: number | null }];

/**
 * A synthetic process table: maps a process-group id to the number of live
 * processes a read would see, and records which groups were read so the test
 * can prove the census asked about each tracked run's own group.
 */
function syntheticProcessTable(countsByGroup: Record<number, number>) {
  const read: number[] = [];
  return {
    read,
    count: (processGroupId: number) => {
      read.push(processGroupId);
      return countsByGroup[processGroupId] ?? 0;
    },
  };
}

describe("summarizeRunProcessCounts", () => {
  it("reduces a synthetic process table to the published distribution", () => {
    const table = syntheticProcessTable({ 100: 3, 200: 1, 300: 8, 400: 5, 500: 2 });
    const entries: Entry[] = [
      ["run-a", { processGroupId: 100 }],
      ["run-b", { processGroupId: 200 }],
      ["run-c", { processGroupId: 300 }],
      ["run-d", { processGroupId: 400 }],
      ["run-e", { processGroupId: 500 }],
    ];

    const result = censusRunProcessGroups({
      entries,
      countLiveProcessGroupMembers: table.count,
    });

    // counts [1,2,3,5,8]; nearest-rank: p50 -> 3rd value (3), p95/p99 -> 5th (8).
    expect(result).toEqual({
      sampleCount: 5,
      max: 8,
      p50: 3,
      p95: 8,
      p99: 8,
      maxRunId: "run-c",
      unreadable: 0,
    });
    // Each run's OWN process group was read, in run order.
    expect(table.read).toEqual([100, 200, 300, 400, 500]);
  });

  it("records sampleCount 0 for the empty-sample case instead of erroring", () => {
    expect(summarizeRunProcessCounts([])).toEqual({
      sampleCount: 0,
      max: null,
      p50: null,
      p95: null,
      p99: null,
      maxRunId: null,
    });
  });

  it("reports no distribution when there are no tracked runs at all", () => {
    expect(censusRunProcessGroups({ entries: [] })).toEqual({
      sampleCount: 0,
      max: null,
      p50: null,
      p95: null,
      p99: null,
      maxRunId: null,
      unreadable: 0,
    });
  });

  it("resolves nearest-rank percentiles across a 1..100 fan-out", () => {
    const samples = Array.from({ length: 100 }, (_, index) => ({
      runId: `run-${index + 1}`,
      liveProcesses: index + 1,
    }));

    expect(summarizeRunProcessCounts(samples)).toEqual({
      sampleCount: 100,
      max: 100,
      p50: 50,
      p95: 95,
      p99: 99,
      maxRunId: "run-100",
    });
  });

  it("resolves a max tie to the first run encountered", () => {
    expect(
      summarizeRunProcessCounts([
        { runId: "run-a", liveProcesses: 3 },
        { runId: "run-b", liveProcesses: 7 },
        { runId: "run-c", liveProcesses: 7 },
      ]),
    ).toMatchObject({ max: 7, maxRunId: "run-b" });
  });

  it("samples a readable-but-empty group as 0 rather than unreadable", () => {
    const result = censusRunProcessGroups({
      entries: [["run-dead", { processGroupId: 42 }]],
      countLiveProcessGroupMembers: () => 0,
    });

    expect(result).toEqual({
      sampleCount: 1,
      max: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      maxRunId: "run-dead",
      unreadable: 0,
    });
  });
});

describe("censusRunProcessGroups — unreadable groups", () => {
  it("skips a run with no tracked process group and counts it unreadable", () => {
    const table = syntheticProcessTable({ 100: 4 });
    const result = censusRunProcessGroups({
      entries: [
        ["run-good", { processGroupId: 100 }],
        ["run-untracked", { processGroupId: null }],
      ],
      countLiveProcessGroupMembers: table.count,
    });

    expect(result).toEqual({
      sampleCount: 1,
      max: 4,
      p50: 4,
      p95: 4,
      p99: 4,
      maxRunId: "run-good",
      unreadable: 1,
    });
  });

  it("degrades one unreadable run without failing the pass", () => {
    const table = syntheticProcessTable({ 100: 2, 300: 6 });
    const result = censusRunProcessGroups({
      entries: [
        ["run-1", { processGroupId: 100 }],
        ["run-2", { processGroupId: 200 }],
        ["run-3", { processGroupId: 300 }],
      ],
      countLiveProcessGroupMembers: (processGroupId) =>
        processGroupId === 200 ? null : table.count(processGroupId),
    });

    // run-2's group is unreadable; run-1 and run-3 still form the sample.
    expect(result).toEqual({
      sampleCount: 2,
      max: 6,
      p50: 2,
      p95: 6,
      p99: 6,
      maxRunId: "run-3",
      unreadable: 1,
    });
  });

  it("counts a throwing read as unreadable and still resolves", () => {
    const result = censusRunProcessGroups({
      entries: [["run-x", { processGroupId: 7 }]],
      countLiveProcessGroupMembers: () => {
        throw new Error("procfs unavailable");
      },
    });

    expect(result).toEqual({
      sampleCount: 0,
      max: null,
      p50: null,
      p95: null,
      p99: null,
      maxRunId: null,
      unreadable: 1,
    });
  });
});

describe("countLiveProcessGroupMembers", () => {
  it("returns null for an untracked or invalid process group", () => {
    expect(countLiveProcessGroupMembers(null)).toBeNull();
    expect(countLiveProcessGroupMembers(undefined)).toBeNull();
    expect(countLiveProcessGroupMembers(0)).toBeNull();
    expect(countLiveProcessGroupMembers(-1)).toBeNull();
    expect(countLiveProcessGroupMembers(1.5)).toBeNull();
  });
});

describe("runProcessCensusSweep", () => {
  it("samples the in-memory run registry and resolves a pass", async () => {
    runningProcesses.clear();

    await expect(runProcessCensusSweep()).resolves.toEqual({
      sampleCount: 0,
      max: null,
      p50: null,
      p95: null,
      p99: null,
      maxRunId: null,
      unreadable: 0,
    });
  });
});
