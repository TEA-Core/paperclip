import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildOpenCodeDatabaseJanitorArgs,
  OPENCODE_DB_JANITOR_SCRIPT,
  startOpenCodeDatabaseJanitor,
} from "../services/opencode-db-janitor.js";

describe("opencode database janitor scheduler", () => {
  // A scheduler pointed at a path that is not shipped is the failure this whole
  // issue is a monument to: the old host pruner ran green for two weeks against
  // a file that had stopped being the live database.
  it("points at a script that exists in the tree", () => {
    expect(existsSync(OPENCODE_DB_JANITOR_SCRIPT)).toBe(true);
  });

  it("sweeps with --apply and passes the configured retention window", () => {
    const args = buildOpenCodeDatabaseJanitorArgs({
      retentionDays: 3,
      vacuum: false,
    });
    expect(args[0]).toBe(OPENCODE_DB_JANITOR_SCRIPT);
    expect(args).toContain("--apply");
    expect(args.slice(args.indexOf("--older-than-days"))).toEqual(
      expect.arrayContaining(["--older-than-days", "3"]),
    );
  });

  // VACUUM holds an exclusive lock for a full-file rewrite. The scheduled sweep
  // must not take one unless an operator asked for it.
  it("suppresses the vacuum unless it is explicitly enabled", () => {
    expect(buildOpenCodeDatabaseJanitorArgs({ retentionDays: 7, vacuum: false })).toContain(
      "--no-vacuum",
    );
    expect(buildOpenCodeDatabaseJanitorArgs({ retentionDays: 7, vacuum: true })).not.toContain(
      "--no-vacuum",
    );
  });

  it("runs a first sweep without waiting a whole interval", async () => {
    vi.useFakeTimers();
    try {
      const runSweep = vi.fn(async () => {});
      const stop = startOpenCodeDatabaseJanitor({
        intervalMs: 24 * 60 * 60 * 1000,
        retentionDays: 7,
        vacuum: false,
        initialDelayMs: 1_000,
        runSweep,
      });
      expect(runSweep).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runSweep).toHaveBeenCalledTimes(1);
      expect(runSweep).toHaveBeenCalledWith({
        retentionDays: 7,
        vacuum: false,
      });
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // A sweep over a large backlog can outlast its own interval. Queueing a
  // second one behind it puts two writers on the same databases, which is the
  // starvation this issue exists to prevent.
  it("never starts a second sweep while one is still running", async () => {
    vi.useFakeTimers();
    try {
      let release: () => void = () => {};
      const runSweep = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const stop = startOpenCodeDatabaseJanitor({
        intervalMs: 1_000,
        retentionDays: 7,
        vacuum: false,
        initialDelayMs: 1_000,
        runSweep,
      });
      await vi.advanceTimersByTimeAsync(3_500);
      expect(runSweep).toHaveBeenCalledTimes(1);
      release();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runSweep).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops sweeping once it is stopped", async () => {
    vi.useFakeTimers();
    try {
      const runSweep = vi.fn(async () => {});
      const stop = startOpenCodeDatabaseJanitor({
        intervalMs: 1_000,
        retentionDays: 7,
        vacuum: false,
        initialDelayMs: 1_000,
        runSweep,
      });
      stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(runSweep).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // A sweep that throws must not take the interval down with it.
  it("keeps sweeping after a sweep fails", async () => {
    vi.useFakeTimers();
    try {
      const runSweep = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue(undefined);
      const stop = startOpenCodeDatabaseJanitor({
        intervalMs: 1_000,
        retentionDays: 7,
        vacuum: false,
        initialDelayMs: 500,
        runSweep,
      });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(runSweep).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
