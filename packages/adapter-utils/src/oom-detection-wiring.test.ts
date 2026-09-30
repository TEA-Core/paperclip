// SUP-18028: wiring test for the OOM-kill attribution added to
// `runChildProcess` — the single seam where every run's top-level child is
// created. These tests prove the close-path integration end-to-end (baseline
// read at spawn -> observed read at close -> delta -> result field + transcript
// notice) using a real spawned child, while the cgroup counter itself is driven
// through a mocked `readCgroupOomKillCount`. The pure reader/parser/delta
// behaviour lives in `oom-detection.test.ts`.
//
// NOTE: this file mocks `./oom-detection.js` for the whole module graph, so it
// must not be co-mingled with the main `server-utils.test.ts` (which has its
// own `node:child_process` mock and a large suite).

import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Drives the shared-cgroup oom_kill counter: each `readCgroupOomKillCount` call
// shifts the next value off the sequence. A run reads it twice (baseline at
// spawn, observed at close). An exhausted sequence yields null (unmeasurable),
// matching the fail-open behaviour of the real reader.
const oomState = vi.hoisted(() => ({ sequence: [] as Array<number | null> }));

vi.mock("./oom-detection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./oom-detection.js")>();
  return {
    ...actual,
    readCgroupOomKillCount: vi.fn(async () => {
      const value = oomState.sequence.shift();
      return value === undefined ? null : value;
    }),
  };
});

// Import AFTER the mock is registered so `runChildProcess` sees the mocked
// reader.
const { runChildProcess } = await import("./server-utils.js");

const spawnOpts = (onLog: (stream: string, chunk: string) => Promise<void>) => ({
  cwd: process.cwd(),
  env: {} as Record<string, string>,
  timeoutSec: 15,
  graceSec: 1,
  onLog,
});

describe("runChildProcess OOM-kill detection wiring (SUP-18028)", () => {
  it("attributes an OOM-kill delta to the run and surfaces a transcript notice", async () => {
    oomState.sequence = [13, 21];
    const logs: string[] = [];
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      ["-e", "process.exit(0)"],
      spawnOpts(async (_s, chunk) => {
        logs.push(chunk);
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.oomKillEvidence).toEqual({
      kind: "cgroup_oom_kill",
      baseline: 13,
      observed: 21,
      delta: 8,
    });
    const notice = logs.find((l) => l.includes("[paperclip] cgroup OOM"));
    expect(notice).toBeTruthy();
    expect(notice).toContain("8 OOM kill(s)");
    expect(notice).toContain("oom_kill 13 -> 21");
  });

  it("reports no OOM evidence and no notice when the counter did not move", async () => {
    oomState.sequence = [5, 5];
    const logs: string[] = [];
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      ["-e", "process.exit(0)"],
      spawnOpts(async (_s, chunk) => {
        logs.push(chunk);
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.oomKillEvidence ?? null).toBeNull();
    expect(logs.some((l) => l.includes("[paperclip] cgroup OOM"))).toBe(false);
  });

  it("is a no-op when detection is disabled via PAPERCLIP_RUN_OOM_DETECTION", async () => {
    oomState.sequence = [13, 21];
    process.env.PAPERCLIP_RUN_OOM_DETECTION = "off";
    try {
      const logs: string[] = [];
      const result = await runChildProcess(
        randomUUID(),
        process.execPath,
        ["-e", "process.exit(0)"],
        spawnOpts(async (_s, chunk) => {
          logs.push(chunk);
        }),
      );
      // Baseline read is skipped, so the sequence is never consumed and no
      // evidence is produced even though the mock counter would have moved.
      expect(result.oomKillEvidence ?? null).toBeNull();
      expect(logs.some((l) => l.includes("[paperclip] cgroup OOM"))).toBe(false);
      expect(oomState.sequence).toEqual([13, 21]);
    } finally {
      delete process.env.PAPERCLIP_RUN_OOM_DETECTION;
    }
  });

  it("treats an unmeasurable counter (read returns null) as no evidence", async () => {
    oomState.sequence = [null, null];
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      ["-e", "process.exit(0)"],
      spawnOpts(async () => {}),
    );

    expect(result.oomKillEvidence ?? null).toBeNull();
  });
});
