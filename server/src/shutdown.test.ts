import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SHUTDOWN_DEADLINE_MS,
  coordinateHeartbeatSchedulerShutdown,
  createShutdownDeadline,
  loadWithoutCoordinatedShutdownSignalHooks,
  resolveShutdownDeadlineMs,
  sweepDetachedRunProcesses,
  withShutdownDeadline,
} from "./shutdown.js";

describe("loadWithoutCoordinatedShutdownSignalHooks", () => {
  it("removes the eager signal handlers from the real embedded-postgres import", async () => {
    const before = {
      SIGINT: process.rawListeners("SIGINT"),
      SIGTERM: process.rawListeners("SIGTERM"),
    };
    const moduleName = "embedded-postgres";

    await loadWithoutCoordinatedShutdownSignalHooks(() => import(moduleName));

    expect(process.rawListeners("SIGINT")).toEqual(before.SIGINT);
    expect(process.rawListeners("SIGTERM")).toEqual(before.SIGTERM);
  });

  it("keeps the database available for a marker-backed SIGTERM snapshot", async () => {
    const signalTarget = new EventEmitter();
    const preexistingSignalListener = vi.fn();
    signalTarget.on("SIGTERM", preexistingSignalListener);

    let databaseAvailable = true;
    const embeddedPostgresExitHook = vi.fn(() => {
      databaseAvailable = false;
    });
    await loadWithoutCoordinatedShutdownSignalHooks(
      async () => {
        signalTarget.on("SIGINT", embeddedPostgresExitHook);
        signalTarget.on("SIGTERM", embeddedPostgresExitHook);
        return { default: class EmbeddedPostgres {} };
      },
      signalTarget,
    );

    let shutdown: Promise<unknown> | null = null;
    let snapshotCaptured = false;
    signalTarget.once("SIGTERM", () => {
      shutdown = coordinateHeartbeatSchedulerShutdown({
        signal: "SIGTERM",
        prepareHotRestartShutdown: async () => {
          // This models the real failure path: a valid intent exists, and the
          // snapshot must query embedded PostgreSQL after SIGTERM is delivered.
          expect(databaseAvailable).toBe(true);
          snapshotCaptured = true;
          return { mode: "hot_restart" as const, skipDrain: true };
        },
        waitForHeartbeatSchedulerIdle: vi.fn(async () => undefined),
      });
    });

    signalTarget.emit("SIGTERM");
    await shutdown;

    expect(preexistingSignalListener).toHaveBeenCalledOnce();
    expect(embeddedPostgresExitHook).not.toHaveBeenCalled();
    expect(snapshotCaptured).toBe(true);
  });
});

describe("coordinateHeartbeatSchedulerShutdown", () => {
  it("quiesces active scheduler work before capturing a hot-restart snapshot", async () => {
    let snapshotCaptured = false;
    let releaseScheduler!: () => void;
    const schedulerIdle = new Promise<void>((resolve) => {
      releaseScheduler = resolve;
    });
    const waitForHeartbeatSchedulerIdle = vi.fn(() => schedulerIdle);

    const shutdown = coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => {
        snapshotCaptured = true;
        return { mode: "prepared" as const, skipDrain: true };
      }),
      waitForHeartbeatSchedulerIdle,
    });

    await vi.waitFor(() => expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce());
    expect(snapshotCaptured).toBe(false);
    releaseScheduler();

    const result = await shutdown;
    expect(snapshotCaptured).toBe(true);
    expect(result).toEqual({
      hotRestart: { mode: "prepared", skipDrain: true },
      preparationError: null,
      waitedForSchedulerIdle: true,
      schedulerIdleTimedOut: false,
    });
  });

  it("quiesces scheduler work before selecting server-stdio runs to drain", async () => {
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => ({
        mode: "acp_drain_required" as const,
        skipDrain: false,
        drainRunIds: ["acp-run"],
      })),
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: {
        mode: "acp_drain_required",
        skipDrain: false,
        drainRunIds: ["acp-run"],
      },
      preparationError: null,
      waitedForSchedulerIdle: true,
      schedulerIdleTimedOut: false,
    });
  });

  it("preserves the scheduler idle wait for normal graceful shutdown", async () => {
    let releaseScheduler!: () => void;
    const schedulerIdle = new Promise<void>((resolve) => {
      releaseScheduler = resolve;
    });
    const waitForHeartbeatSchedulerIdle = vi.fn(() => schedulerIdle);
    let settled = false;

    const shutdown = coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => ({
        mode: "not_requested" as const,
        skipDrain: false,
      })),
      waitForHeartbeatSchedulerIdle,
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    releaseScheduler();

    await expect(shutdown).resolves.toEqual({
      hotRestart: { mode: "not_requested", skipDrain: false },
      preparationError: null,
      waitedForSchedulerIdle: true,
      schedulerIdleTimedOut: false,
    });
  });

  it("waits for scheduler idle when hot-restart preparation is unavailable", async () => {
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: null,
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: null,
      preparationError: null,
      waitedForSchedulerIdle: true,
      schedulerIdleTimedOut: false,
    });
  });

  it("falls back to the scheduler idle wait when hot-restart preparation fails", async () => {
    const preparationError = new Error("snapshot failed");
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => {
        throw preparationError;
      }),
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: null,
      preparationError,
      waitedForSchedulerIdle: true,
      schedulerIdleTimedOut: false,
    });
  });
});

// SUP-10309. The shutdown handler used to have no upper bound at all: the
// scheduler idle wait blocks on in-flight agent runs, and the drain that
// follows it waits `graceSec` (20s by default) per run, sequentially. Docker's
// default stop timeout is 10s, so a single running run was enough for the
// container to be SIGKILLed mid-drain -- and because run children are spawned
// detached in their own process group they never see the container's signal,
// so they survive the restart as orphans holding the old mounts open.
describe("shutdown deadline", () => {
  it("defaults to a budget that fits inside Docker's 10s stop timeout", () => {
    expect(DEFAULT_SHUTDOWN_DEADLINE_MS).toBeLessThan(10_000);
    expect(resolveShutdownDeadlineMs({})).toBe(DEFAULT_SHUTDOWN_DEADLINE_MS);
  });

  it("reads an explicit budget from the environment and rejects nonsense values", () => {
    expect(resolveShutdownDeadlineMs({ PAPERCLIP_SHUTDOWN_DEADLINE_MS: "2500" })).toBe(2500);
    expect(resolveShutdownDeadlineMs({ PAPERCLIP_SHUTDOWN_DEADLINE_MS: "0" })).toBe(
      DEFAULT_SHUTDOWN_DEADLINE_MS,
    );
    expect(resolveShutdownDeadlineMs({ PAPERCLIP_SHUTDOWN_DEADLINE_MS: "-1" })).toBe(
      DEFAULT_SHUTDOWN_DEADLINE_MS,
    );
    expect(resolveShutdownDeadlineMs({ PAPERCLIP_SHUTDOWN_DEADLINE_MS: "soon" })).toBe(
      DEFAULT_SHUTDOWN_DEADLINE_MS,
    );
  });

  it("spends down the remaining budget as stages run", () => {
    let clock = 1_000;
    const deadline = createShutdownDeadline(5_000, () => clock);
    expect(deadline.remainingMs()).toBe(5_000);
    expect(deadline.expired()).toBe(false);
    clock += 3_000;
    expect(deadline.remainingMs()).toBe(2_000);
    clock += 9_000;
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.expired()).toBe(true);
  });

  it("abandons a stage that outlives the deadline instead of blocking shutdown", async () => {
    const deadline = createShutdownDeadline(25);
    const neverSettles = new Promise<string>(() => undefined);

    await expect(withShutdownDeadline(neverSettles, deadline)).resolves.toEqual({
      completed: false,
    });
  });

  it("returns the stage value when it finishes inside the deadline", async () => {
    const deadline = createShutdownDeadline(5_000);

    await expect(withShutdownDeadline(Promise.resolve("drained"), deadline)).resolves.toEqual({
      completed: true,
      value: "drained",
    });
  });

  it("surfaces a stage rejection rather than swallowing it as a timeout", async () => {
    const deadline = createShutdownDeadline(5_000);
    const failure = new Error("drain exploded");

    await expect(withShutdownDeadline(Promise.reject(failure), deadline)).rejects.toBe(failure);
  });

  it("stops waiting for scheduler idle once the deadline expires", async () => {
    const deadline = createShutdownDeadline(25);
    const waitForHeartbeatSchedulerIdle = vi.fn(() => new Promise<void>(() => undefined));

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: null,
      waitForHeartbeatSchedulerIdle,
      deadline,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: null,
      preparationError: null,
      waitedForSchedulerIdle: false,
      schedulerIdleTimedOut: true,
    });
  });
});

describe("sweepDetachedRunProcesses", () => {
  it("kills the whole process group of every surviving run", () => {
    const kill = vi.fn();

    const result = sweepDetachedRunProcesses({
      entries: [
        ["run-a", { child: { pid: 4242 }, processGroupId: 4242 }],
        ["run-b", { child: { pid: 5150 }, processGroupId: 5150 }],
      ],
      kill,
    });

    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(kill).toHaveBeenCalledWith(-5150, "SIGKILL");
    expect(result).toEqual({ signalled: ["run-a", "run-b"], skipped: [], failed: [] });
  });

  // A run that lost its group id can still be killed directly; a run with
  // neither is not a live child and must not turn into a stray `kill(0)`.
  it("falls back to the direct child pid and skips entries with no target", () => {
    const kill = vi.fn();

    const result = sweepDetachedRunProcesses({
      entries: [
        ["run-no-group", { child: { pid: 777 }, processGroupId: null }],
        ["run-no-pid", { child: { pid: undefined }, processGroupId: null }],
        ["run-no-child", { child: null, processGroupId: 0 }],
      ],
      kill,
    });

    expect(kill).toHaveBeenCalledExactlyOnceWith(777, "SIGKILL");
    expect(result).toEqual({
      signalled: ["run-no-group"],
      skipped: ["run-no-pid", "run-no-child"],
      failed: [],
    });
  });

  // An already-dead group throws ESRCH. That is the common case during a
  // normal drain and must never abort the sweep for the runs behind it.
  it("keeps sweeping when an entry is already gone", () => {
    const kill = vi.fn((pid: number) => {
      if (pid === -1) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });

    const result = sweepDetachedRunProcesses({
      entries: [
        ["run-dead", { child: { pid: 1 }, processGroupId: 1 }],
        ["run-alive", { child: { pid: 2 }, processGroupId: 2 }],
      ],
      kill,
    });

    expect(kill).toHaveBeenCalledWith(-2, "SIGKILL");
    expect(result).toEqual({ signalled: ["run-alive"], skipped: [], failed: ["run-dead"] });
  });

  it.runIf(process.platform !== "win32")(
    "terminates a real detached child that ignored SIGTERM",
    async () => {
      // Mirrors how run children are spawned (detached, own process group) and
      // how they misbehave: this one traps SIGTERM and keeps running, which is
      // exactly the case that used to outlive the server.
      const child = spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');",
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      child.unref();
      // Wait for the handler to actually be installed. The `spawn` event only
      // means exec() succeeded; signalling before the script runs would hit
      // node's default SIGTERM disposition and prove nothing.
      await new Promise<void>((resolveReady, rejectReady) => {
        child.stdout!.once("data", () => resolveReady());
        child.once("error", rejectReady);
        child.once("exit", () => rejectReady(new Error("child exited before it was ready")));
      });
      const pid = child.pid!;
      expect(pid).toBeGreaterThan(0);

      try {
        process.kill(pid, "SIGTERM");
        await new Promise((r) => setTimeout(r, 200));
        expect(() => process.kill(pid, 0)).not.toThrow();

        const result = sweepDetachedRunProcesses({
          entries: [["run-stubborn", { child, processGroupId: pid }]],
        });
        expect(result.signalled).toEqual(["run-stubborn"]);

        await vi.waitFor(() => {
          expect(() => process.kill(pid, 0)).toThrow();
        });
      } finally {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // already reaped
        }
      }
    },
  );
});
