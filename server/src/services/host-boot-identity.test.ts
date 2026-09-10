import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import {
  HOST_BOOT_ID_CONTEXT_KEY,
  buildHostRestartMessage,
  deriveUptimeBootIdentity,
  detectHostRestart,
  readHostRestartMarker,
  resolveHostBootId,
  resolveHostBootIdWithReaders,
  withHostBootIdInRunContext,
  __resetHostBootIdCacheForTests,
} from "./host-boot-identity.js";

const mockReadFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readFileSync: mockReadFileSync };
});

beforeEach(() => {
  mockReadFileSync.mockReset();
  __resetHostBootIdCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetHostBootIdCacheForTests();
});

describe("resolveHostBootIdWithReaders", () => {
  it("returns the trimmed /proc boot_id when readable", async () => {
    const bootId = await resolveHostBootIdWithReaders({
      readBootIdFile: () => "  123e4567-e89b-12d3-a456-426614174000\n",
      readUptimeSeconds: () => 5,
    });
    expect(bootId).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("falls back to a boot-wall-clock identity when the boot_id file is empty", async () => {
    const bootId = await resolveHostBootIdWithReaders({
      readBootIdFile: () => "   ",
      readUptimeSeconds: () => 90,
      nowMs: () => 1_750_000_000_000,
    });
    expect(bootId).toBe(`boot-wall-clock:${new Date(1_750_000_000_000 - 90 * 1000).toISOString()}`);
  });

  it("falls back to a boot-wall-clock identity when the boot_id file is missing", async () => {
    const bootId = await resolveHostBootIdWithReaders({
      readBootIdFile: () => null,
      readUptimeSeconds: () => 90,
      nowMs: () => 1_750_000_000_000,
    });
    expect(bootId).toBe(`boot-wall-clock:${new Date(1_750_000_000_000 - 90 * 1000).toISOString()}`);
  });

  it("never throws when the boot_id reader rejects and still falls back to uptime", async () => {
    const bootId = await resolveHostBootIdWithReaders({
      readBootIdFile: () => Promise.reject(new Error("EACCES")),
      readUptimeSeconds: () => 90,
      nowMs: () => 1_750_000_000_000,
    });
    expect(bootId).toBe(`boot-wall-clock:${new Date(1_750_000_000_000 - 90 * 1000).toISOString()}`);
  });

  it("returns null when neither boot_id nor uptime is available", async () => {
    const bootId = await resolveHostBootIdWithReaders({
      readBootIdFile: () => null,
      readUptimeSeconds: () => Number.NaN,
    });
    expect(bootId).toBeNull();
  });

  it("returns null when the uptime reader throws", async () => {
    const bootId = await resolveHostBootIdWithReaders({
      readBootIdFile: () => null,
      readUptimeSeconds: () => {
        throw new Error("no uptime");
      },
    });
    expect(bootId).toBeNull();
  });
});

describe("deriveUptimeBootIdentity", () => {
  it("derives a stable boot-wall-clock identity rounded to the second", () => {
    const nowMs = 1_750_000_000_000;
    const uptimeSeconds = 120;
    const a = deriveUptimeBootIdentity(uptimeSeconds, nowMs);
    const b = deriveUptimeBootIdentity(uptimeSeconds, nowMs);
    expect(a).toBe(b);
    // Independent computation: boot wall-clock = now - uptime, rounded to the second.
    const expected = `boot-wall-clock:${new Date(nowMs - uptimeSeconds * 1000).toISOString()}`;
    expect(a).toBe(expected);
    expect(a).toMatch(/^boot-wall-clock:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
  });

  it("returns null for non-finite uptime", () => {
    expect(deriveUptimeBootIdentity(Number.NaN, 1_750_000_000_000)).toBeNull();
  });

  it("returns null for negative uptime", () => {
    expect(deriveUptimeBootIdentity(-1, 1_750_000_000_000)).toBeNull();
  });
});

describe("resolveHostBootId", () => {
  it("resolves the /proc boot_id and caches it per process", async () => {
    mockReadFileSync.mockImplementation((path: string | unknown) => {
      if (path === "/proc/sys/kernel/random/boot_id") return "deadbeef-1234\n";
      throw new Error(`unexpected path ${String(path)}`);
    });
    const first = await resolveHostBootId();
    const second = await resolveHostBootId();
    expect(first).toBe("deadbeef-1234");
    expect(second).toBe(first);
    const bootPathCalls = mockReadFileSync.mock.calls.filter(
      (args) => args[0] === "/proc/sys/kernel/random/boot_id",
    );
    expect(bootPathCalls).toHaveLength(1);
  });

  it("resolves a real (non-null) boot id on this host", async () => {
    mockReadFileSync.mockImplementation((path: string | unknown) => {
      if (path === "/proc/sys/kernel/random/boot_id") {
        try {
          return fs.readFileSync(path as string, "utf8");
        } catch {
          return "";
        }
      }
      throw new Error(`unexpected path ${String(path)}`);
    });
    const bootId = await resolveHostBootId();
    expect(typeof bootId).toBe("string");
    expect(bootId).not.toBeNull();
    expect(bootId!.length).toBeGreaterThan(0);
  });
});

describe("readHostRestartMarker", () => {
  it("parses a valid marker", () => {
    const marker = readHostRestartMarker({
      stopReason: "process_lost",
      hostRestart: {
        detected: true,
        runBootId: "old-boot",
        currentBootId: "new-boot",
        detectedAt: "2026-09-10T05:00:00.000Z",
      },
    });
    expect(marker).toEqual({
      detected: true,
      runBootId: "old-boot",
      currentBootId: "new-boot",
      detectedAt: "2026-09-10T05:00:00.000Z",
    });
  });

  it("returns null when hostRestart is absent", () => {
    expect(readHostRestartMarker({ stopReason: "process_lost" })).toBeNull();
    expect(readHostRestartMarker(null)).toBeNull();
    expect(readHostRestartMarker(undefined)).toBeNull();
  });

  it("returns null when detected is not true", () => {
    expect(
      readHostRestartMarker({
        hostRestart: { detected: false, runBootId: "a", currentBootId: "b", detectedAt: "x" },
      }),
    ).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    expect(
      readHostRestartMarker({
        hostRestart: { detected: true, runBootId: "old", detectedAt: "2026-09-10T05:00:00.000Z" },
      }),
    ).toBeNull();
  });
});

describe("detectHostRestart", () => {
  it("detects a mismatch and carries both boot ids plus an ISO timestamp", () => {
    const marker = detectHostRestart({
      recordedBootId: "old-boot",
      currentBootId: "new-boot",
      detectedAt: "2026-09-10T05:00:00.000Z",
    });
    expect(marker).toEqual({
      detected: true,
      runBootId: "old-boot",
      currentBootId: "new-boot",
      detectedAt: "2026-09-10T05:00:00.000Z",
    });
  });

  it("returns null when the recorded and current boot ids match", () => {
    expect(detectHostRestart({ recordedBootId: "same", currentBootId: "same" })).toBeNull();
  });

  it("returns null when the recorded boot id is unknown", () => {
    expect(detectHostRestart({ recordedBootId: null, currentBootId: "new-boot" })).toBeNull();
    expect(detectHostRestart({ recordedBootId: "", currentBootId: "new-boot" })).toBeNull();
  });

  it("returns null when the current boot id is unknown", () => {
    expect(detectHostRestart({ recordedBootId: "old-boot", currentBootId: null })).toBeNull();
  });

  it("stamps a default detectedAt when none is provided", () => {
    const marker = detectHostRestart({ recordedBootId: "old-boot", currentBootId: "new-boot" });
    expect(marker).not.toBeNull();
    expect(new Date(marker!.detectedAt).toISOString()).toBe(marker!.detectedAt);
  });
});

describe("buildHostRestartMessage", () => {
  it("names both boot ids", () => {
    const msg = buildHostRestartMessage({
      detected: true,
      runBootId: "old-boot",
      currentBootId: "new-boot",
      detectedAt: "2026-09-10T05:00:00.000Z",
    });
    expect(msg).toContain("old-boot");
    expect(msg).toContain("new-boot");
    expect(msg).toContain("Host restart detected");
  });
});

describe("withHostBootIdInRunContext", () => {
  it("stamps the boot id under hostBootId when present", () => {
    const ctx = withHostBootIdInRunContext({ issueId: "abc" }, "boot-1");
    expect(ctx).toEqual({ issueId: "abc", [HOST_BOOT_ID_CONTEXT_KEY]: "boot-1" });
  });

  it("omits the key when the boot id is null", () => {
    const ctx = withHostBootIdInRunContext({ issueId: "abc" }, null);
    expect(ctx).toEqual({ issueId: "abc" });
    expect(HOST_BOOT_ID_CONTEXT_KEY in ctx).toBe(false);
  });

  it("does not mutate the input context", () => {
    const original = { issueId: "abc" };
    withHostBootIdInRunContext(original, "boot-1");
    expect(original).toEqual({ issueId: "abc" });
    expect(HOST_BOOT_ID_CONTEXT_KEY in original).toBe(false);
  });
});
