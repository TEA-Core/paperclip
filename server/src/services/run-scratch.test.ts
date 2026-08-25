import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_RUN_SCRATCH_MARKER,
  buildHeartbeatRunScratchEnv,
  cleanupHeartbeatRunScratch,
  discoverRunScratchDirs,
  prepareHeartbeatRunScratch,
  reapAbandonedRunScratchDirs,
  terminateRunScratchProcessGroup,
  type HeartbeatRunScratch,
} from "./run-scratch.js";

const cleanupDirs = new Set<string>();

async function trackScratch(scratch: HeartbeatRunScratch) {
  cleanupDirs.add(scratch.dir);
  return scratch;
}

afterEach(async () => {
  await Promise.all(
    Array.from(cleanupDirs, (dir) =>
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
  cleanupDirs.clear();
});

describe("heartbeat run scratch cleanup", () => {
  it("removes only a marked run-owned scratch directory", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      issueId: "issue-1",
      issueIdentifier: "PAP-13071",
      now: new Date("2026-07-08T00:00:00.000Z"),
    }));
    await fs.writeFile(path.join(scratch.dir, "tool-cache.txt"), "cache");

    const result = await cleanupHeartbeatRunScratch({ scratch });

    expect(result).toEqual({ removed: true, dir: scratch.dir });
    await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves paperclip-named directories without the ownership marker", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-unmarked-"));
    cleanupDirs.add(dir);
    const scratch: HeartbeatRunScratch = {
      dir,
      markerPath: path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER),
      metadata: {
        version: 1,
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: null,
        issueIdentifier: null,
        createdAt: new Date("2026-07-08T00:00:00.000Z").toISOString(),
      },
    };

    const result = await cleanupHeartbeatRunScratch({ scratch });

    expect(result).toEqual({ removed: false, dir, reason: "unmarked" });
    await expect(fs.stat(dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("preserves marked scratch when the marker owner does not match the run", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));
    const mismatched = {
      ...scratch,
      metadata: {
        ...scratch.metadata,
        runId: "run-2",
      },
    };

    const result = await cleanupHeartbeatRunScratch({ scratch: mismatched });

    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "owner_mismatch" });
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("skips cleanup while the run process group is still alive", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));

    const result = await cleanupHeartbeatRunScratch({
      scratch,
      processGroupId: 123,
      isProcessGroupAlive: () => true,
    });

    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "process_group_alive" });
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("builds explicit scratch env without clobbering configured temp dirs", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));

    const result = buildHeartbeatRunScratchEnv({ TMPDIR: "/custom/tmp" }, scratch);

    expect(result.env.PAPERCLIP_RUN_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_TASK_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_TMPDIR).toBe(scratch.dir);
    expect(result.env.TMPDIR).toBeUndefined();
    expect(result.env.TEMP).toBe(scratch.dir);
    expect(result.env.TMP).toBe(scratch.dir);
    expect(result.tempKeysApplied).toEqual(["TEMP", "TMP"]);
  });
});

describe("run scratch process group termination (SUP-13949)", () => {
  const noopSleep = async () => undefined;

  it("reports no_group rather than signalling when there is no process group", async () => {
    const kill = vi.fn();
    const result = await terminateRunScratchProcessGroup({
      processGroupId: null,
      isProcessGroupAlive: () => true,
      kill,
      sleep: noopSleep,
    });
    expect(result).toEqual({ terminated: false, reason: "no_group", escalatedToKill: false });
    expect(kill).not.toHaveBeenCalled();
  });

  it("never signals a group that is already gone", async () => {
    const kill = vi.fn();
    const result = await terminateRunScratchProcessGroup({
      processGroupId: 4242,
      isProcessGroupAlive: () => false,
      kill,
      sleep: noopSleep,
    });
    expect(result).toEqual({ terminated: true, reason: "already_gone", escalatedToKill: false });
    // The liveness gate is also the pid-reuse guard: signalling a pgid that no
    // longer names a group can reach an unrelated process.
    expect(kill).not.toHaveBeenCalled();
  });

  it("stops at SIGTERM when the group exits within the grace period", async () => {
    const kill = vi.fn();
    let alive = true;
    const result = await terminateRunScratchProcessGroup({
      processGroupId: 4242,
      isProcessGroupAlive: () => alive,
      kill: (target, signal) => {
        kill(target, signal);
        if (signal === "SIGTERM") alive = false;
      },
      sleep: noopSleep,
    });
    expect(result).toEqual({ terminated: true, reason: "signalled", escalatedToKill: false });
    expect(kill.mock.calls).toEqual([[-4242, "SIGTERM"]]);
  });

  it("escalates to SIGKILL on the whole group when SIGTERM is ignored", async () => {
    const kill = vi.fn();
    let alive = true;
    const result = await terminateRunScratchProcessGroup({
      processGroupId: 4242,
      isProcessGroupAlive: () => alive,
      kill: (target, signal) => {
        kill(target, signal);
        if (signal === "SIGKILL") alive = false;
      },
      sleep: noopSleep,
    });
    expect(result).toEqual({ terminated: true, reason: "signalled", escalatedToKill: true });
    // Negative pid both times: killing the leader's pid alone is what left the
    // grandchildren behind in the first place.
    expect(kill.mock.calls).toEqual([[-4242, "SIGTERM"], [-4242, "SIGKILL"]]);
  });

  it("reports survived when even SIGKILL does not clear the group", async () => {
    const result = await terminateRunScratchProcessGroup({
      processGroupId: 4242,
      isProcessGroupAlive: () => true,
      kill: () => undefined,
      sleep: noopSleep,
    });
    expect(result).toEqual({ terminated: false, reason: "survived", escalatedToKill: true });
  });

  it("treats an ESRCH from the signal as the group having drained", async () => {
    let alive = true;
    const result = await terminateRunScratchProcessGroup({
      processGroupId: 4242,
      isProcessGroupAlive: () => alive,
      kill: () => {
        alive = false;
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      },
      sleep: noopSleep,
    });
    expect(result).toEqual({ terminated: true, reason: "already_gone", escalatedToKill: false });
  });
});

describe("run scratch cleanup with process group termination (SUP-13949)", () => {
  it("terminates a live group and then removes the directory", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));

    const terminateProcessGroup = vi.fn(async () => ({
      terminated: true as const,
      reason: "signalled" as const,
      escalatedToKill: true,
    }));
    const result = await cleanupHeartbeatRunScratch({
      scratch,
      processGroupId: 4242,
      isProcessGroupAlive: () => true,
      terminateProcessGroup,
    });

    expect(terminateProcessGroup).toHaveBeenCalledWith(4242);
    expect(result).toMatchObject({ removed: true, dir: scratch.dir });
    await expect(fs.stat(scratch.dir)).rejects.toThrow();
  });

  it("keeps the directory when the group survives termination", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));

    const result = await cleanupHeartbeatRunScratch({
      scratch,
      processGroupId: 4242,
      isProcessGroupAlive: () => true,
      terminateProcessGroup: async () => ({
        terminated: false as const,
        reason: "survived" as const,
        escalatedToKill: true,
      }),
    });

    // Removing the path would leave the survivors running with a missing cwd,
    // which is strictly worse than leaving the evidence in place.
    expect(result).toMatchObject({ removed: false, reason: "process_group_survived" });
    await expect(fs.stat(scratch.dir)).resolves.toBeTruthy();
  });

  it("still terminates nothing when the group is already dead", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));
    const terminateProcessGroup = vi.fn();

    const result = await cleanupHeartbeatRunScratch({
      scratch,
      processGroupId: 4242,
      isProcessGroupAlive: () => false,
      terminateProcessGroup,
    });

    expect(terminateProcessGroup).not.toHaveBeenCalled();
    expect(result).toEqual({ removed: true, dir: scratch.dir });
  });
});

describe("abandoned run scratch reaper (SUP-13949)", () => {
  async function makeTmpRoot() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-scratch-reaper-test-"));
    cleanupDirs.add(root);
    return root;
  }

  async function seedScratch(root: string, runId: string, createdAt: string) {
    const dir = await fs.mkdtemp(path.join(root, `paperclip-run-pap-1-${runId}-`));
    await fs.writeFile(
      path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER),
      JSON.stringify({
        version: 1,
        companyId: "company-1",
        agentId: "agent-1",
        runId,
        issueId: null,
        issueIdentifier: null,
        createdAt,
      }),
    );
    return dir;
  }

  const old = "2026-08-23T00:00:00.000Z";
  const now = new Date("2026-08-25T00:00:00.000Z");
  const terminated = async () => ({
    terminated: true as const,
    reason: "signalled" as const,
    escalatedToKill: false,
  });

  it("discovers only marked directories", async () => {
    const root = await makeTmpRoot();
    const marked = await seedScratch(root, "run-1", old);
    await fs.mkdir(path.join(root, "paperclip-run-not-ours-abcdef"));
    await fs.mkdir(path.join(root, "some-other-tool-dir"));

    const found = await discoverRunScratchDirs({ tmpRoot: root });
    // os.tmpdir() is shared with the rest of the host; the name prefix alone is
    // not proof of ownership, so an unmarked directory is never a candidate.
    expect(found.map((f) => f.dir)).toEqual([marked]);
  });

  it("terminates the group and removes the directory of a finished run", async () => {
    const root = await makeTmpRoot();
    const dir = await seedScratch(root, "run-1", old);
    const terminateProcessGroup = vi.fn(terminated);

    const outcomes = await reapAbandonedRunScratchDirs({
      tmpRoot: root,
      now,
      resolveLiveness: async () => ({ liveness: "finished" as const, processGroupId: 4242 }),
      terminateProcessGroup,
    });

    expect(terminateProcessGroup).toHaveBeenCalledWith(4242);
    expect(outcomes).toMatchObject([{ dir, runId: "run-1", reaped: true }]);
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  it("never touches a directory whose run is still active", async () => {
    const root = await makeTmpRoot();
    const dir = await seedScratch(root, "run-1", old);
    const terminateProcessGroup = vi.fn(terminated);

    const outcomes = await reapAbandonedRunScratchDirs({
      tmpRoot: root,
      now,
      resolveLiveness: async () => ({ liveness: "active" as const }),
      terminateProcessGroup,
    });

    expect(terminateProcessGroup).not.toHaveBeenCalled();
    expect(outcomes).toMatchObject([{ reaped: false, reason: "active" }]);
    await expect(fs.stat(dir)).resolves.toBeTruthy();
  });

  it("refuses to act when liveness cannot be resolved", async () => {
    const root = await makeTmpRoot();
    const dir = await seedScratch(root, "run-1", old);
    const terminateProcessGroup = vi.fn(terminated);

    const outcomes = await reapAbandonedRunScratchDirs({
      tmpRoot: root,
      now,
      resolveLiveness: async () => ({ liveness: "unknown" as const }),
      terminateProcessGroup,
    });

    // A database blip must not turn the backstop into a killer of live runs.
    expect(terminateProcessGroup).not.toHaveBeenCalled();
    expect(outcomes).toMatchObject([{ reaped: false, reason: "unknown" }]);
    await expect(fs.stat(dir)).resolves.toBeTruthy();
  });

  it("leaves a freshly created directory alone even if its run reads finished", async () => {
    const root = await makeTmpRoot();
    const dir = await seedScratch(root, "run-1", "2026-08-24T23:59:00.000Z");

    const outcomes = await reapAbandonedRunScratchDirs({
      tmpRoot: root,
      now,
      resolveLiveness: async () => ({ liveness: "finished" as const, processGroupId: 4242 }),
      terminateProcessGroup: terminated,
    });

    // The teardown that owns this directory may still be writing its cleanup
    // event; the sweep must not race it for the same path.
    expect(outcomes).toMatchObject([{ reaped: false, reason: "too_recent" }]);
    await expect(fs.stat(dir)).resolves.toBeTruthy();
  });

  it("treats an unparseable createdAt as brand new rather than infinitely old", async () => {
    const root = await makeTmpRoot();
    const dir = await fs.mkdtemp(path.join(root, "paperclip-run-pap-1-run-9-"));
    await fs.writeFile(
      path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER),
      JSON.stringify({
        version: 1,
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-9",
        issueId: null,
        issueIdentifier: null,
        createdAt: "not-a-date",
      }),
    );

    const outcomes = await reapAbandonedRunScratchDirs({
      tmpRoot: root,
      now,
      resolveLiveness: async () => ({ liveness: "finished" as const, processGroupId: 4242 }),
      terminateProcessGroup: terminated,
    });

    expect(outcomes).toMatchObject([{ reaped: false, reason: "too_recent" }]);
    await expect(fs.stat(dir)).resolves.toBeTruthy();
  });

  it("keeps the directory when the group survives, and reports it", async () => {
    const root = await makeTmpRoot();
    const dir = await seedScratch(root, "run-1", old);

    const outcomes = await reapAbandonedRunScratchDirs({
      tmpRoot: root,
      now,
      resolveLiveness: async () => ({ liveness: "finished" as const, processGroupId: 4242 }),
      terminateProcessGroup: async () => ({
        terminated: false as const,
        reason: "survived" as const,
        escalatedToKill: true,
      }),
    });

    expect(outcomes).toMatchObject([{ reaped: false, reason: "process_group_survived" }]);
    await expect(fs.stat(dir)).resolves.toBeTruthy();
  });

  it("does not let one failing directory strand the ones behind it", async () => {
    const root = await makeTmpRoot();
    const bad = await seedScratch(root, "run-bad", old);
    const good = await seedScratch(root, "run-good", old);
    const onError = vi.fn();

    const outcomes = await reapAbandonedRunScratchDirs({
      tmpRoot: root,
      now,
      onError,
      resolveLiveness: async (metadata) => {
        if (metadata.runId === "run-bad") throw new Error("lookup exploded");
        return { liveness: "finished" as const, processGroupId: 4242 };
      },
      terminateProcessGroup: terminated,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.find((o) => o.runId === "run-bad")).toMatchObject({ reaped: false, reason: "error" });
    expect(outcomes.find((o) => o.runId === "run-good")).toMatchObject({ reaped: true });
    await expect(fs.stat(bad)).resolves.toBeTruthy();
    await expect(fs.stat(good)).rejects.toThrow();
  });

  it("returns nothing when the temp root does not exist", async () => {
    const outcomes = await reapAbandonedRunScratchDirs({
      tmpRoot: path.join(os.tmpdir(), "run-scratch-reaper-absent-root"),
      now,
      resolveLiveness: async () => ({ liveness: "finished" as const }),
      terminateProcessGroup: terminated,
    });
    expect(outcomes).toEqual([]);
  });
});
