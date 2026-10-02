import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_AGENT_NICE,
  deprioritizeCpu,
  isAgentSpawnShim,
  resolveAgentNice,
} from "./cpu-priority.js";

describe("resolveAgentNice", () => {
  it("defaults when the env var is absent or blank", () => {
    expect(resolveAgentNice({})).toBe(DEFAULT_AGENT_NICE);
    expect(DEFAULT_AGENT_NICE).toBe(10);
    expect(resolveAgentNice({ PAPERCLIP_AGENT_NICE: "   " })).toBe(DEFAULT_AGENT_NICE);
  });

  it("honours a configured value", () => {
    expect(resolveAgentNice({ PAPERCLIP_AGENT_NICE: "15" })).toBe(15);
    expect(resolveAgentNice({ PAPERCLIP_AGENT_NICE: "0" })).toBe(0);
  });

  it("clamps to 0..19", () => {
    expect(resolveAgentNice({ PAPERCLIP_AGENT_NICE: "25" })).toBe(19);
    // A negative step would raise agents above the server. That needs
    // CAP_SYS_NICE and is never the intent, so it means "no step".
    expect(resolveAgentNice({ PAPERCLIP_AGENT_NICE: "-5" })).toBe(0);
  });

  it("falls back to the default on an unparseable value", () => {
    for (const raw of ["high", "5.5", "10x", "0x10"]) {
      expect(resolveAgentNice({ PAPERCLIP_AGENT_NICE: raw })).toBe(DEFAULT_AGENT_NICE);
    }
  });
});

describe("deprioritizeCpu", () => {
  function fakeScheduler(server: number, child: number) {
    const priorities = new Map<number, number>([
      [0, server],
      [4242, child],
    ]);
    return {
      priorities,
      // Never read the real /proc for these fake pids.
      listThreads: (pid: number) => [pid],
      getPriority: (pid: number) => {
        const value = priorities.get(pid);
        if (value === undefined) throw new Error(`ESRCH ${pid}`);
        return value;
      },
      setPriority: vi.fn((pid: number, value: number) => {
        priorities.set(pid, value);
      }),
    };
  }

  it("puts the child the configured number of steps below the server", () => {
    const sched = fakeScheduler(0, 0);
    expect(deprioritizeCpu(4242, 10, { ...sched, platform: "linux" })).toBe(10);
    expect(sched.priorities.get(4242)).toBe(10);
  });

  it("is relative to the server's own priority", () => {
    const sched = fakeScheduler(5, 5);
    expect(deprioritizeCpu(4242, 10, { ...sched, platform: "linux" })).toBe(15);
  });

  it("caps at the kernel ceiling of 19", () => {
    const sched = fakeScheduler(15, 15);
    expect(deprioritizeCpu(4242, 10, { ...sched, platform: "linux" })).toBe(19);
  });

  it("never raises a child that already sits at or below the target", () => {
    const sched = fakeScheduler(0, 12);
    expect(deprioritizeCpu(4242, 10, { ...sched, platform: "linux" })).toBeNull();
    expect(sched.setPriority).not.toHaveBeenCalled();
    expect(sched.priorities.get(4242)).toBe(12);
  });

  it("does nothing for a step of 0", () => {
    const sched = fakeScheduler(0, 0);
    expect(deprioritizeCpu(4242, 0, { ...sched, platform: "linux" })).toBeNull();
    expect(sched.setPriority).not.toHaveBeenCalled();
  });

  it("does nothing on Windows, where priorities are classes, not nice values", () => {
    const sched = fakeScheduler(0, 0);
    expect(deprioritizeCpu(4242, 10, { ...sched, platform: "win32" })).toBeNull();
    expect(sched.setPriority).not.toHaveBeenCalled();
  });

  it("ignores a missing or invalid pid", () => {
    const sched = fakeScheduler(0, 0);
    for (const pid of [undefined, 0, -1, 1.5]) {
      expect(deprioritizeCpu(pid, 10, { ...sched, platform: "linux" })).toBeNull();
    }
    expect(sched.setPriority).not.toHaveBeenCalled();
  });

  it("never throws, and reports a failure", () => {
    const onError = vi.fn();
    const result = deprioritizeCpu(4242, 10, {
      platform: "linux",
      listThreads: () => [4242],
      getPriority: () => 0,
      setPriority: () => {
        throw new Error("EPERM");
      },
      onError,
    });
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("reports a child that exited before it could be read", () => {
    const onError = vi.fn();
    const sched = fakeScheduler(0, 0);
    expect(deprioritizeCpu(9999, 10, { ...sched, platform: "linux", onError })).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("deprioritizeCpu covers every thread", () => {
  it("lowers every listed thread, not just the main one", () => {
    // On Linux a nice value belongs to a thread. Threads the agent already
    // started would keep the server's priority if only the main one moved.
    const priorities = new Map<number, number>([
      [0, 0],
      [4242, 0],
      [4243, 0],
      [4244, 12],
    ]);
    const result = deprioritizeCpu(4242, 10, {
      platform: "linux",
      listThreads: () => [4242, 4243, 4244],
      getPriority: (pid) => priorities.get(pid)!,
      setPriority: (pid, value) => void priorities.set(pid, value),
    });
    expect(result).toBe(10);
    expect(priorities.get(4242)).toBe(10);
    expect(priorities.get(4243)).toBe(10);
    // Never raises a thread that is already lower.
    expect(priorities.get(4244)).toBe(12);
  });

  it("ignores a thread that exits between listing and setting", () => {
    const onError = vi.fn();
    const priorities = new Map<number, number>([
      [0, 0],
      [4242, 0],
    ]);
    const result = deprioritizeCpu(4242, 10, {
      platform: "linux",
      listThreads: () => [4242, 4243],
      getPriority: (pid) => {
        const value = priorities.get(pid);
        if (value === undefined) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        return value;
      },
      setPriority: (pid, value) => void priorities.set(pid, value),
      onError,
    });
    expect(result).toBe(10);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps a throwing reporter inside the best-effort boundary", () => {
    expect(() =>
      deprioritizeCpu(4242, 10, {
        platform: "linux",
        listThreads: () => [4242],
        getPriority: () => 0,
        setPriority: () => {
          throw new Error("EPERM");
        },
        onError: () => {
          throw new Error("logger down");
        },
      }),
    ).not.toThrow();
  });

  // At nice 19 there is no lower priority to step to, so nothing is observable.
  it.skipIf(process.platform !== "linux" || os.getPriority() >= 19)(
    "lowers the threads a real process already started",
    async () => {
      // A child with two worker threads, all started before the step runs.
      const child = spawn(
        process.execPath,
        [
          "-e",
          [
            "const { Worker } = require('node:worker_threads');",
            "for (let i = 0; i < 2; i++) new Worker('setTimeout(() => {}, 5000)', { eval: true });",
            "setTimeout(() => {}, 5000);",
          ].join(" "),
        ],
        { stdio: "ignore" },
      );
      try {
        const pid = child.pid!;
        // Wait until the worker threads exist, so they predate the step.
        let tids: string[] = [];
        for (let i = 0; i < 100; i++) {
          tids = await fs.readdir(`/proc/${pid}/task`);
          if (tids.length >= 9) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const target = Math.min(19, os.getPriority() + 10);
        expect(deprioritizeCpu(pid, 10)).toBe(target);

        tids = await fs.readdir(`/proc/${pid}/task`);
        const nices = await Promise.all(
          tids.map(async (tid) => {
            const stat = await fs.readFile(`/proc/${pid}/task/${tid}/stat`, "utf8");
            return Number.parseInt(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[16]!, 10);
          }),
        );
        expect(nices.length).toBeGreaterThan(1);
        expect(new Set(nices)).toEqual(new Set([target]));
      } finally {
        child.kill();
      }
    },
  );
});

describe("isAgentSpawnShim", () => {
  it("recognises the default shim path", () => {
    expect(isAgentSpawnShim("/usr/local/sbin/paperclip-spawn-agent", {})).toBe(true);
  });

  it("recognises an overridden shim path, also after normalisation", () => {
    const env = { PAPERCLIP_AGENT_SPAWN_SHIM: "/opt/shim/spawn" };
    expect(isAgentSpawnShim("/opt/shim/spawn", env)).toBe(true);
    expect(isAgentSpawnShim("/opt/shim/../shim/spawn", env)).toBe(true);
    expect(isAgentSpawnShim("/usr/local/sbin/paperclip-spawn-agent", env)).toBe(false);
  });

  it("does not match an ordinary agent command", () => {
    expect(isAgentSpawnShim("/usr/local/bin/opencode", {})).toBe(false);
    expect(isAgentSpawnShim(process.execPath, {})).toBe(false);
    expect(isAgentSpawnShim(path.basename("/usr/local/sbin/paperclip-spawn-agent"), {})).toBe(false);
  });
});
