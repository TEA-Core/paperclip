import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runChildProcess, runningProcesses, signalRunningProcess } from "./server-utils.js";

/**
 * The supervisor spawns agents at a different uid than it runs at, so the OS is
 * entitled to refuse every signal it sends them. These cover what happens when
 * it does.
 */

function eperm(message = "kill EPERM"): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(message);
  err.code = "EPERM";
  return err;
}

/** Minimal stand-in for the parts of ChildProcess signalRunningProcess reads. */
function fakeChild(overrides: Partial<ChildProcess> & { kill?: () => boolean }) {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, { exitCode: null, signalCode: null, killed: false }, overrides);
  return child;
}

async function waitForRegisteredChild(runId: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = runningProcesses.get(runId);
    if (running) return running.child;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`child for ${runId} never registered`);
}

describe("signalRunningProcess delivery reporting", () => {
  it("reports a signal the OS refused to deliver", () => {
    const child = fakeChild({ kill: () => false });
    expect(signalRunningProcess({ child, processGroupId: null }, "SIGKILL")).toEqual({
      delivered: false,
      errorCode: null,
    });
  });

  it("carries the errno from a failed process-group signal", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw eperm();
    });
    try {
      const child = fakeChild({ pid: 424242, kill: () => false });
      expect(signalRunningProcess({ child, processGroupId: 424242 }, "SIGKILL")).toEqual({
        delivered: false,
        errorCode: "EPERM",
      });
    } finally {
      killSpy.mockRestore();
    }
  });

  it("reports delivery when the direct child signal is accepted", () => {
    const child = fakeChild({ kill: () => true });
    expect(signalRunningProcess({ child, processGroupId: null }, "SIGTERM")).toEqual({
      delivered: true,
      errorCode: null,
    });
  });

  it("treats an already-exited child as nothing left to deliver", () => {
    const kill = vi.fn(() => false);
    const child = fakeChild({ exitCode: 0, kill });
    expect(signalRunningProcess({ child, processGroupId: null }, "SIGKILL")).toEqual({
      delivered: true,
      errorCode: null,
    });
    // Signalling a dead child is not a failure, and must not be attempted.
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("runChildProcess when the supervisor cannot signal its own child", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length) cleanup.pop()?.();
    vi.restoreAllMocks();
  });

  it.skipIf(process.platform === "win32")(
    "reports the timeout and the orphan instead of failing the run as unstartable",
    async () => {
      const runId = randomUUID();
      const logs: string[] = [];
      const realKill = process.kill.bind(process);

      // Reproduce the uid boundary: every signal to the process GROUP is
      // refused, which is what a supervisor without CAP_KILL gets back for a
      // child it spawned through the setuid shim.
      vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
        if (pid < 0) throw eperm();
        return realKill(pid, signal as never);
      }) as typeof process.kill);

      const promise = runChildProcess(
        runId,
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        { cwd: process.cwd(), env: {}, timeoutSec: 1, graceSec: 1, onLog: async (_s, c) => { logs.push(c); } },
      );

      const child = await waitForRegisteredChild(runId);
      // Node's own failure shape: kill() returns false and separately emits
      // 'error' on the child carrying the errno.
      child.kill = ((): boolean => {
        queueMicrotask(() => child.emit("error", eperm()));
        return false;
      }) as ChildProcess["kill"];

      const realPid = child.pid;
      cleanup.push(() => {
        if (typeof realPid === "number") {
          try {
            realKill(realPid, "SIGKILL");
          } catch {
            // already gone
          }
        }
        runningProcesses.delete(runId);
      });

      const result = await promise;

      // The whole point: this is a timeout, not a start failure.
      expect(result.timedOut).toBe(true);
      expect(result.orphanedProcess).toMatchObject({
        kind: "orphaned_process",
        signal: "SIGKILL",
        errorCode: "EPERM",
      });
      expect(logs.join("")).toContain("could not be delivered");
      // Still addressable by runId, so a supervisor that regains the privilege
      // can finish the job.
      expect(runningProcesses.get(runId)?.child).toBe(child);
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "does not fail a live run because a signal to it could not be delivered",
    async () => {
      const runId = randomUUID();
      const promise = runChildProcess(
        runId,
        process.execPath,
        ["-e", "setTimeout(() => process.stdout.write('done'), 250);"],
        { cwd: process.cwd(), env: {}, timeoutSec: 30, graceSec: 1, onLog: async () => {} },
      );

      const child = await waitForRegisteredChild(runId);
      // A failed kill(2) arrives on the same event as a failed spawn. It must
      // not be mistaken for one: this process started fine and is still working.
      child.emit("error", eperm());

      const result = await promise;
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("done");
      expect(result.timedOut).toBe(false);
      expect(result.orphanedProcess ?? null).toBeNull();
    },
    15_000,
  );

  it("still fails a run whose command never started", async () => {
    await expect(
      runChildProcess(randomUUID(), "paperclip-command-that-does-not-exist", [], {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 30,
        graceSec: 1,
        onLog: async () => {},
      }),
    ).rejects.toThrow(/Command not found in PATH|Failed to start command/);
  });
});
