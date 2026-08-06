import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeOpenCodeDatabaseGrowthTrip,
  measureOpenCodeDatabaseBytes,
  resolveOpenCodeDataDir,
  resolveOpenCodeDatabaseGrowthLimitBytes,
  resolveOpenCodeDatabasePath,
  resolveOpenCodeDatabasePollIntervalMs,
  startOpenCodeDatabaseGrowthGuard,
  type OpenCodeDatabaseGrowthTrip,
} from "./db-guard.js";

const emptyProcessEnv: NodeJS.ProcessEnv = {};
const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-db-guard-"));
  cleanupPaths.add(dir);
  return dir;
}

describe("resolveOpenCodeDataDir", () => {
  it("prefers XDG_DATA_HOME from the run env", () => {
    expect(
      resolveOpenCodeDataDir({ env: { XDG_DATA_HOME: "/data" }, processEnv: emptyProcessEnv }),
    ).toBe(path.join("/data", "opencode"));
  });

  it("falls back to $HOME/.local/share, which is where the incident database lived", () => {
    expect(
      resolveOpenCodeDataDir({ env: { HOME: "/paperclip" }, processEnv: emptyProcessEnv }),
    ).toBe(path.join("/paperclip", ".local", "share", "opencode"));
  });

  it("reads the process env when the run env carries neither", () => {
    expect(
      resolveOpenCodeDataDir({ env: {}, processEnv: { XDG_DATA_HOME: "/from-process" } }),
    ).toBe(path.join("/from-process", "opencode"));
  });
});

describe("resolveOpenCodeDatabasePath", () => {
  it("joins a relative database name to the data dir, matching opencode's own resolution", () => {
    expect(
      resolveOpenCodeDatabasePath({
        databaseFile: "opencode-agent-agent-1.db",
        env: { HOME: "/paperclip" },
        processEnv: emptyProcessEnv,
      }),
    ).toBe("/paperclip/.local/share/opencode/opencode-agent-agent-1.db");
  });

  it("uses an absolute database name as-is", () => {
    expect(
      resolveOpenCodeDatabasePath({
        databaseFile: "/var/lib/opencode.db",
        env: { HOME: "/paperclip" },
        processEnv: emptyProcessEnv,
      }),
    ).toBe("/var/lib/opencode.db");
  });

  it("has nothing to watch for an in-memory database", () => {
    expect(
      resolveOpenCodeDatabasePath({
        databaseFile: ":memory:",
        env: {},
        processEnv: emptyProcessEnv,
      }),
    ).toBeNull();
  });

  it("has nothing to watch when no database file was set", () => {
    expect(
      resolveOpenCodeDatabasePath({ databaseFile: null, env: {}, processEnv: emptyProcessEnv }),
    ).toBeNull();
  });
});

describe("resolveOpenCodeDatabaseGrowthLimitBytes", () => {
  it("defaults to 256 MB per run", () => {
    expect(
      resolveOpenCodeDatabaseGrowthLimitBytes({ env: {}, processEnv: emptyProcessEnv }),
    ).toBe(256 * 1024 * 1024);
  });

  it("honours an explicit megabyte budget", () => {
    expect(
      resolveOpenCodeDatabaseGrowthLimitBytes({
        env: { PAPERCLIP_OPENCODE_DB_GROWTH_LIMIT_MB: "64" },
        processEnv: emptyProcessEnv,
      }),
    ).toBe(64 * 1024 * 1024);
  });

  it("treats a non-positive budget as an explicit opt-out", () => {
    expect(
      resolveOpenCodeDatabaseGrowthLimitBytes({
        env: { PAPERCLIP_OPENCODE_DB_GROWTH_LIMIT_MB: "0" },
        processEnv: emptyProcessEnv,
      }),
    ).toBe(0);
  });

  it("disables the guard on PAPERCLIP_OPENCODE_DB_GUARD_OFF", () => {
    expect(
      resolveOpenCodeDatabaseGrowthLimitBytes({
        env: { PAPERCLIP_OPENCODE_DB_GUARD_OFF: "1" },
        processEnv: emptyProcessEnv,
      }),
    ).toBe(0);
  });

  // A typo in an operator's env must not silently remove the protection that
  // exists because one unbounded message took the whole fleet down.
  it("falls back to the default rather than disabling itself on a malformed budget", () => {
    expect(
      resolveOpenCodeDatabaseGrowthLimitBytes({
        env: { PAPERCLIP_OPENCODE_DB_GROWTH_LIMIT_MB: "lots" },
        processEnv: emptyProcessEnv,
      }),
    ).toBe(256 * 1024 * 1024);
  });
});

describe("resolveOpenCodeDatabasePollIntervalMs", () => {
  it("defaults to five seconds", () => {
    expect(resolveOpenCodeDatabasePollIntervalMs({ env: {}, processEnv: emptyProcessEnv })).toBe(
      5000,
    );
  });

  it("honours an explicit interval", () => {
    expect(
      resolveOpenCodeDatabasePollIntervalMs({
        env: { PAPERCLIP_OPENCODE_DB_GROWTH_POLL_SEC: "2" },
        processEnv: emptyProcessEnv,
      }),
    ).toBe(2000);
  });

  it("refuses a sub-second interval so the guard cannot become the load", () => {
    expect(
      resolveOpenCodeDatabasePollIntervalMs({
        env: { PAPERCLIP_OPENCODE_DB_GROWTH_POLL_SEC: "0.01" },
        processEnv: emptyProcessEnv,
      }),
    ).toBe(5000);
  });
});

describe("measureOpenCodeDatabaseBytes", () => {
  it("counts the database and its WAL together", async () => {
    const dir = await makeTempDir();
    const databasePath = path.join(dir, "opencode-agent-agent-1.db");
    await fs.writeFile(databasePath, Buffer.alloc(1024));
    await fs.writeFile(`${databasePath}-wal`, Buffer.alloc(2048));
    expect(await measureOpenCodeDatabaseBytes(databasePath)).toBe(3072);
  });

  // The database does not exist before an agent's first run, and a checkpoint
  // can remove the WAL between two samples.
  it("reports zero for a database that does not exist yet", async () => {
    const dir = await makeTempDir();
    expect(await measureOpenCodeDatabaseBytes(path.join(dir, "missing.db"))).toBe(0);
  });
});

describe("startOpenCodeDatabaseGrowthGuard", () => {
  async function waitFor(predicate: () => boolean, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return predicate();
  }

  it("trips once the database grows past the budget within a single run", async () => {
    const dir = await makeTempDir();
    const databasePath = path.join(dir, "opencode-agent-agent-1.db");
    // Pre-existing content: a long-lived agent's database is legitimately large,
    // so the guard must measure growth rather than absolute size.
    await fs.writeFile(databasePath, Buffer.alloc(8192));

    const trips: OpenCodeDatabaseGrowthTrip[] = [];
    const guard = startOpenCodeDatabaseGrowthGuard({
      databasePath,
      limitBytes: 4096,
      pollIntervalMs: 25,
      onTrip: (trip) => trips.push(trip),
    });

    try {
      // Let the baseline sample land before the runaway write.
      await waitFor(() => true, 60);
      await fs.writeFile(`${databasePath}-wal`, Buffer.alloc(16384));
      expect(await waitFor(() => trips.length > 0)).toBe(true);
    } finally {
      guard.stop();
    }

    expect(trips).toHaveLength(1);
    expect(trips[0].baselineBytes).toBe(8192);
    expect(trips[0].growthBytes).toBeGreaterThanOrEqual(16384);
    expect(trips[0].limitBytes).toBe(4096);
  });

  it("leaves a run alone when it stays inside the budget", async () => {
    const dir = await makeTempDir();
    const databasePath = path.join(dir, "opencode-agent-agent-1.db");
    await fs.writeFile(databasePath, Buffer.alloc(1024));

    const trips: OpenCodeDatabaseGrowthTrip[] = [];
    const guard = startOpenCodeDatabaseGrowthGuard({
      databasePath,
      limitBytes: 1024 * 1024,
      pollIntervalMs: 25,
      onTrip: (trip) => trips.push(trip),
    });

    try {
      await fs.writeFile(databasePath, Buffer.alloc(4096));
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      guard.stop();
    }

    expect(trips).toEqual([]);
  });

  it("trips at most once even if the database keeps growing", async () => {
    const dir = await makeTempDir();
    const databasePath = path.join(dir, "opencode-agent-agent-1.db");
    await fs.writeFile(databasePath, Buffer.alloc(0));

    const trips: OpenCodeDatabaseGrowthTrip[] = [];
    const guard = startOpenCodeDatabaseGrowthGuard({
      databasePath,
      limitBytes: 1024,
      pollIntervalMs: 20,
      onTrip: (trip) => trips.push(trip),
    });

    try {
      await fs.writeFile(databasePath, Buffer.alloc(4096));
      expect(await waitFor(() => trips.length > 0)).toBe(true);
      await fs.writeFile(databasePath, Buffer.alloc(65536));
      await new Promise((resolve) => setTimeout(resolve, 120));
    } finally {
      guard.stop();
    }

    expect(trips).toHaveLength(1);
  });

  it("does nothing at all when the budget is zero", async () => {
    const dir = await makeTempDir();
    const databasePath = path.join(dir, "opencode-agent-agent-1.db");
    await fs.writeFile(databasePath, Buffer.alloc(0));

    const trips: OpenCodeDatabaseGrowthTrip[] = [];
    const guard = startOpenCodeDatabaseGrowthGuard({
      databasePath,
      limitBytes: 0,
      pollIntervalMs: 20,
      onTrip: (trip) => trips.push(trip),
    });

    try {
      await fs.writeFile(databasePath, Buffer.alloc(1024 * 1024));
      await new Promise((resolve) => setTimeout(resolve, 120));
    } finally {
      guard.stop();
    }

    expect(trips).toEqual([]);
  });

  it("stops sampling after stop()", async () => {
    const dir = await makeTempDir();
    const databasePath = path.join(dir, "opencode-agent-agent-1.db");
    await fs.writeFile(databasePath, Buffer.alloc(0));

    const trips: OpenCodeDatabaseGrowthTrip[] = [];
    const guard = startOpenCodeDatabaseGrowthGuard({
      databasePath,
      limitBytes: 1024,
      pollIntervalMs: 20,
      onTrip: (trip) => trips.push(trip),
    });
    guard.stop();

    await fs.writeFile(databasePath, Buffer.alloc(1024 * 1024));
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(trips).toEqual([]);
  });
});

describe("describeOpenCodeDatabaseGrowthTrip", () => {
  it("names the numbers an operator needs to judge the abort", () => {
    const message = describeOpenCodeDatabaseGrowthTrip({
      databasePath: "/paperclip/.local/share/opencode/opencode-agent-agent-1.db",
      baselineBytes: 100 * 1024 * 1024,
      observedBytes: 531 * 1024 * 1024,
      growthBytes: 431 * 1024 * 1024,
      limitBytes: 256 * 1024 * 1024,
    });
    expect(message).toContain("431.0 MB");
    expect(message).toContain("256.0 MB");
    expect(message).toContain("opencode-agent-agent-1.db");
  });
});
