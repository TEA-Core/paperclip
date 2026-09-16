import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import {
  DEFAULT_RUN_PROCESS_CAP,
  RUN_PROCESS_CAP_ENV_KEY,
  RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE,
  RunProcessCapExceededError,
  evaluateRunProcessSpawn,
  isRunProcessCapExceededFailure,
  registerRunProcessGroupCounter,
  resolveRunProcessCap,
  shouldRefuseRunProcessSpawn,
} from "./run-process-cap.js";
import { runningProcesses, runChildProcess } from "./server-utils.js";

const originalCapEnv = process.env[RUN_PROCESS_CAP_ENV_KEY];

afterEach(() => {
  registerRunProcessGroupCounter(null);
  if (originalCapEnv === undefined) {
    delete process.env[RUN_PROCESS_CAP_ENV_KEY];
  } else {
    process.env[RUN_PROCESS_CAP_ENV_KEY] = originalCapEnv;
  }
  for (const runId of ["cap-allow", "cap-refuse", "cap-unwired"]) {
    runningProcesses.delete(runId);
  }
});

describe("resolveRunProcessCap", () => {
  it("falls back to the derived default when the env var is unset", () => {
    expect(resolveRunProcessCap({})).toBe(DEFAULT_RUN_PROCESS_CAP);
  });

  it("reads an explicit positive integer", () => {
    expect(resolveRunProcessCap({ [RUN_PROCESS_CAP_ENV_KEY]: "37" })).toBe(37);
  });

  it("treats invalid values as the safe default, never silently uncapped", () => {
    expect(resolveRunProcessCap({ [RUN_PROCESS_CAP_ENV_KEY]: "nope" })).toBe(
      DEFAULT_RUN_PROCESS_CAP,
    );
    expect(resolveRunProcessCap({ [RUN_PROCESS_CAP_ENV_KEY]: "-4" })).toBe(
      DEFAULT_RUN_PROCESS_CAP,
    );
  });

  it("allows an explicit disable", () => {
    expect(resolveRunProcessCap({ [RUN_PROCESS_CAP_ENV_KEY]: "0" })).toBeNull();
    expect(
      resolveRunProcessCap({ [RUN_PROCESS_CAP_ENV_KEY]: "off" }),
    ).toBeNull();
  });
});

describe("DEFAULT_RUN_PROCESS_CAP (census-derived, SUP-16010)", () => {
  // Live run-process census (SUP-16010), GET /api/health ->
  // sweepLiveness.sweeps.runProcessCensus.lastResult (authenticated result at
  // lastRunAt 2026-09-16T18:55:25.397Z, runs=119):
  const CENSUS = {
    sampleCount: 9,
    p50: 4,
    p95: 5,
    p99: 5,
    max: 5,
    unreadable: 0,
  };
  const HEADROOM_MULTIPLE = 4;

  it("equals the documented census derivation (p99 x headroom)", () => {
    // Distinguishing assertion: the default is a census-derived safe headroom
    // over p99, not the old incident-derived constant.
    expect(DEFAULT_RUN_PROCESS_CAP).toBe(CENSUS.p99 * HEADROOM_MULTIPLE);
    expect(DEFAULT_RUN_PROCESS_CAP).toBe(CENSUS.max * HEADROOM_MULTIPLE);
    expect(DEFAULT_RUN_PROCESS_CAP).toBe(20);
  });

  it("rejects the old incident-derived value as the source", () => {
    expect(DEFAULT_RUN_PROCESS_CAP).not.toBe(512);
  });
});

describe("shouldRefuseRunProcessSpawn (boundary)", () => {
  it("allows a run at cap - 1", () => {
    expect(shouldRefuseRunProcessSpawn({ cap: 5, current: 4 })).toBe(false);
  });

  it("refuses a run at cap", () => {
    expect(shouldRefuseRunProcessSpawn({ cap: 5, current: 5 })).toBe(true);
  });

  it("refuses a run above cap", () => {
    expect(shouldRefuseRunProcessSpawn({ cap: 5, current: 9 })).toBe(true);
  });

  it("fails open when the cap is disabled or the group is unreadable", () => {
    expect(shouldRefuseRunProcessSpawn({ cap: null, current: 999 })).toBe(false);
    expect(shouldRefuseRunProcessSpawn({ cap: 5, current: null })).toBe(false);
  });
});

describe("evaluateRunProcessSpawn (shared seam admission)", () => {
  it("allows a run at cap - 1", () => {
    const refusal = evaluateRunProcessSpawn({
      runId: "run-x",
      cap: 5,
      counter: () => 4,
      processGroupId: 100,
    });
    expect(refusal).toBeNull();
  });

  it("refuses a run at the cap with the named code and the measured numbers", () => {
    const refusal = evaluateRunProcessSpawn({
      runId: "run-x",
      cap: 5,
      counter: () => 5,
      processGroupId: 100,
    });
    expect(refusal?.code).toBe(RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE);
    expect(refusal?.resultJson).toEqual({
      errorCode: RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE,
      cap: 5,
      current: 5,
      processGroupId: 100,
      runId: "run-x",
    });
  });

  it("fails open when the cap is disabled, the counter is unwired, or the group is missing", () => {
    expect(
      evaluateRunProcessSpawn({
        runId: "r",
        cap: null,
        counter: () => 99,
        processGroupId: 1,
      }),
    ).toBeNull();
    expect(
      evaluateRunProcessSpawn({
        runId: "r",
        cap: 5,
        counter: null,
        processGroupId: 1,
      }),
    ).toBeNull();
    expect(
      evaluateRunProcessSpawn({
        runId: "r",
        cap: 5,
        counter: () => 99,
        processGroupId: null,
      }),
    ).toBeNull();
  });

  it("reports a measure error and fails open when the counter throws", () => {
    const onMeasureError = vi.fn();
    const refusal = evaluateRunProcessSpawn({
      runId: "r",
      cap: 5,
      counter: () => {
        throw new Error("no such process group");
      },
      processGroupId: 1,
      onMeasureError,
    });
    expect(refusal).toBeNull();
    expect(onMeasureError).toHaveBeenCalledTimes(1);
  });
});

describe("RunProcessCapExceededError", () => {
  it("carries the named code and the measured numbers", () => {
    const error = new RunProcessCapExceededError({
      runId: "run-1",
      cap: 512,
      current: 512,
      processGroupId: 4242,
    });
    expect(error.code).toBe(RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE);
    expect(error.message).toContain("run process cap exceeded");
    expect(error.resultJson).toEqual({
      errorCode: RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE,
      cap: 512,
      current: 512,
      processGroupId: 4242,
      runId: "run-1",
    });
    expect(isRunProcessCapExceededFailure(error)).toBe(true);
    expect(isRunProcessCapExceededFailure(new Error("other"))).toBe(false);
    expect(isRunProcessCapExceededFailure(null)).toBe(false);
  });
});

describe("runChildProcess seam (per-run process cap)", () => {
  const spawnLikeOpts = (runId: string) => ({
    cwd: os.tmpdir(),
    env: {},
    timeoutSec: 10,
    graceSec: 1,
    onLog: async () => {},
  });

  // A run whose existing group is at cap - 1 must still spawn.
  it("spawns normally at cap - 1", async () => {
    const runId = "cap-allow";
    process.env[RUN_PROCESS_CAP_ENV_KEY] = "5";
    const counter = vi.fn().mockReturnValue(4);
    registerRunProcessGroupCounter(counter);
    runningProcesses.set(runId, {
      child: { pid: 999_999 } as never,
      graceSec: 1,
      processGroupId: 12345,
    });

    const result = await runChildProcess(
      runId,
      process.execPath,
      ["-e", "process.exit(0)"],
      spawnLikeOpts(runId),
    );

    expect(counter).toHaveBeenCalledWith(12345);
    expect(result.errorCode ?? null).not.toBe(RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  // A run whose group has reached the cap must be refused, and no child spawned.
  it("refuses at the cap with the named error code and does not spawn", async () => {
    const runId = "cap-refuse";
    process.env[RUN_PROCESS_CAP_ENV_KEY] = "5";
    const counter = vi.fn().mockReturnValue(5);
    registerRunProcessGroupCounter(counter);
    const seededChild = { pid: 999_998 };
    runningProcesses.set(runId, {
      child: seededChild as never,
      graceSec: 1,
      processGroupId: 54321,
    });

    await expect(
      runChildProcess(runId, process.execPath, ["-e", "process.exit(0)"], spawnLikeOpts(runId)),
    ).rejects.toMatchObject({
      code: RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE,
      resultJson: {
        errorCode: RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE,
        cap: 5,
        current: 5,
        processGroupId: 54321,
        runId,
      },
    });

    expect(counter).toHaveBeenCalledWith(54321);
    // No spawn: the seeded entry was never replaced.
    expect(runningProcesses.get(runId)?.child).toBe(seededChild);
  });

  // With the counter unwired the cap fails open, so a first spawn proceeds.
  it("fails open when no counter is wired", async () => {
    const runId = "cap-unwired";
    process.env[RUN_PROCESS_CAP_ENV_KEY] = "1";
    registerRunProcessGroupCounter(null);
    runningProcesses.set(runId, {
      child: { pid: 999_997 } as never,
      graceSec: 1,
      processGroupId: 111,
    });

    const result = await runChildProcess(
      runId,
      process.execPath,
      ["-e", "process.exit(0)"],
      spawnLikeOpts(runId),
    );
    expect(result.errorCode ?? null).not.toBe(RUN_PROCESS_CAP_EXCEEDED_ERROR_CODE);
    expect(result.exitCode).toBe(0);
  });
});
