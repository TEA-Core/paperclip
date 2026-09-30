import { describe, expect, it, vi } from "vitest";

import {
  RUN_OOM_DETECTION_ENV_KEY,
  formatOomKillNotice,
  parseOomKillCount,
  readCgroupOomKillCount,
  resolveMemoryEventsPath,
  resolveOomDetectionEnabled,
  summarizeOomKillDelta,
} from "./oom-detection.js";

describe("resolveOomDetectionEnabled", () => {
  it("is enabled by default", () => {
    expect(resolveOomDetectionEnabled({})).toBe(true);
    expect(resolveOomDetectionEnabled({ [RUN_OOM_DETECTION_ENV_KEY]: "   " })).toBe(true);
  });

  it("disables on the documented off values", () => {
    for (const value of ["off", "false", "none", "disabled", "0", " OFF "]) {
      expect(resolveOomDetectionEnabled({ [RUN_OOM_DETECTION_ENV_KEY]: value })).toBe(false);
    }
  });

  it("stays enabled on a typo or any other value (the safe direction)", () => {
    for (const value of ["yes", "1", "true", "high", "on-ish"]) {
      expect(resolveOomDetectionEnabled({ [RUN_OOM_DETECTION_ENV_KEY]: value })).toBe(true);
    }
  });
});

describe("parseOomKillCount", () => {
  it("reads the oom_kill counter from a real memory.events body", () => {
    const body = [
      "low 0",
      "high 0",
      "max 3",
      "oom 106",
      "oom_kill 13",
      "oom_group_kill 0",
      "sock_throttled 46",
    ].join("\n");
    expect(parseOomKillCount(body)).toBe(13);
  });

  it("returns null when there is no oom_kill line (cgroup v1 / unknown kernel)", () => {
    expect(parseOomKillCount("low 0\nhigh 0\nmax 0\n")).toBeNull();
    expect(parseOomKillCount("")).toBeNull();
  });

  it("does not confuse the sibling `oom` line with `oom_kill`", () => {
    expect(parseOomKillCount("oom 106\n")).toBeNull();
  });

  it("returns null on a present but malformed value instead of a fabricated number", () => {
    expect(parseOomKillCount("oom_kill abc\n")).toBeNull();
    expect(parseOomKillCount("oom_kill 13 extra\n")).toBeNull();
  });
});

describe("resolveMemoryEventsPath", () => {
  it("pins an explicitly supplied path", async () => {
    await expect(
      resolveMemoryEventsPath({ memoryEventsPath: "/x/memory.events" }),
    ).resolves.toBe("/x/memory.events");
  });

  it("resolves a namespaced container to the cgroup root", async () => {
    await expect(
      resolveMemoryEventsPath({ readSelfCgroup: async () => "0::/\n12:cpu:/\n" }),
    ).resolves.toBe("/sys/fs/cgroup/memory.events");
  });

  it("resolves a non-namespaced container to its real cgroup path", async () => {
    await expect(
      resolveMemoryEventsPath({
        readSelfCgroup: async () => "0::/system.slice/docker-bd81.scope\n",
      }),
    ).resolves.toBe("/sys/fs/cgroup/system.slice/docker-bd81.scope/memory.events");
  });

  it("falls back to the cgroup root when /proc/self/cgroup is unreadable", async () => {
    await expect(
      resolveMemoryEventsPath({ readSelfCgroup: async () => null }),
    ).resolves.toBe("/sys/fs/cgroup/memory.events");
  });
});

describe("readCgroupOomKillCount", () => {
  it("is a no-op (null) off Linux, where there is no cgroup counter to read", async () => {
    const read = vi.fn(async () => "oom_kill 5");
    await expect(
      readCgroupOomKillCount({ platform: "darwin", readFile: read }),
    ).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("reads the counter through the resolved path on Linux", async () => {
    const read = vi.fn(async () => "low 0\noom_kill 7\n");
    await expect(
      readCgroupOomKillCount({
        platform: "linux",
        readFile: read,
        memoryEventsPath: "/sys/fs/cgroup/memory.events",
      }),
    ).resolves.toBe(7);
    expect(read).toHaveBeenCalledWith("/sys/fs/cgroup/memory.events");
  });

  it("fails open to null when the events file is unreadable", async () => {
    const read = vi.fn(
      () =>
        Promise.reject(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })),
    );
    await expect(
      readCgroupOomKillCount({
        platform: "linux",
        readFile: read,
        memoryEventsPath: "/sys/fs/cgroup/memory.events",
      }),
    ).resolves.toBeNull();
  });
});

describe("summarizeOomKillDelta", () => {
  it("reports a positive increase with its measured numbers", () => {
    expect(summarizeOomKillDelta(13, 21)).toEqual({
      kind: "cgroup_oom_kill",
      baseline: 13,
      observed: 21,
      delta: 8,
    });
  });

  it("reports a single kill", () => {
    expect(summarizeOomKillDelta(0, 1)?.delta).toBe(1);
  });

  it("reports null when the counter did not move", () => {
    expect(summarizeOomKillDelta(5, 5)).toBeNull();
    expect(summarizeOomKillDelta(5, 4)).toBeNull();
  });

  it("reports null when either side was unmeasurable", () => {
    expect(summarizeOomKillDelta(null, 5)).toBeNull();
    expect(summarizeOomKillDelta(5, null)).toBeNull();
    expect(summarizeOomKillDelta(null, null)).toBeNull();
  });
});

describe("formatOomKillNotice", () => {
  it("names the measured delta and the attribution ask, not a causal claim", () => {
    const line = formatOomKillNotice({
      kind: "cgroup_oom_kill",
      baseline: 13,
      observed: 21,
      delta: 8,
    });
    expect(line).toContain("[paperclip] cgroup OOM");
    expect(line).toContain("8 OOM kill(s)");
    expect(line).toContain("oom_kill 13 -> 21");
    expect(line).toContain("during this run");
    expect(line).toContain("re-run the failing step in isolation");
  });
});
