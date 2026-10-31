import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeOpenCodeDatabaseGrowthSpare,
  describeOpenCodeDatabaseGrowthTrip,
  measureOpenCodeDatabaseBytes,
  measureOpenCodeSessionBytes,
  readOpenCodeSessionIdFromChunk,
  resolveOpenCodeDataDir,
  resolveOpenCodeDatabaseGrowthLimitBytes,
  resolveOpenCodeDatabasePath,
  resolveOpenCodeDatabasePollIntervalMs,
  startOpenCodeDatabaseGrowthGuard,
  type OpenCodeDatabaseGrowthSpare,
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
      attribution: null,
      sparedTrips: 0,
    });
    expect(message).toContain("431.0 MB");
    expect(message).toContain("256.0 MB");
    expect(message).toContain("opencode-agent-agent-1.db");
  });

  // SUP-11268: the message must say what was measured and how it was attributed,
  // not assert the SUP-10914 runaway-message cause, which is only one of the ways
  // a run can get here.
  it("states the attribution basis rather than asserting a cause", () => {
    const message = describeOpenCodeDatabaseGrowthTrip({
      databasePath: "/paperclip/.local/share/opencode/opencode-agent-agent-1.db",
      baselineBytes: 0,
      observedBytes: 300 * 1024 * 1024,
      growthBytes: 300 * 1024 * 1024,
      limitBytes: 256 * 1024 * 1024,
      attribution: null,
      sparedTrips: 0,
    });
    expect(message).toContain("Attribution basis");
    expect(message).toContain("per-session");
    expect(message).not.toContain("runaway-message signature from SUP-10914");
    expect(message).not.toContain("terminated before it could bloat");
  });

  // An operator reading the failure has to be able to tell "this run did it"
  // from "the guard could not tell whose writes these were".
  it("names the owning session when the growth was attributed", () => {
    const message = describeOpenCodeDatabaseGrowthTrip({
      databasePath: "/paperclip/.local/share/opencode/opencode-agent-agent-1.db",
      baselineBytes: 412 * 1024 * 1024,
      observedBytes: 678 * 1024 * 1024,
      growthBytes: 266 * 1024 * 1024,
      limitBytes: 256 * 1024 * 1024,
      attribution: {
        sessionId: "ses_027959870ffe2fTMGMts4UU288",
        baselineBytes: 0,
        observedBytes: 247 * 1024 * 1024,
        growthBytes: 247 * 1024 * 1024,
      },
      sparedTrips: 0,
    });
    expect(message).toContain("ses_027959870ffe2fTMGMts4UU288");
    expect(message).toContain("247.0 MB");
  });

  it("says so when the growth could not be attributed", () => {
    const message = describeOpenCodeDatabaseGrowthTrip({
      databasePath: "/db.db",
      baselineBytes: 0,
      observedBytes: 300 * 1024 * 1024,
      growthBytes: 300 * 1024 * 1024,
      limitBytes: 256 * 1024 * 1024,
      attribution: null,
      sparedTrips: 0,
    });
    expect(message).toContain("could not be attributed");
  });
});

// Exercises the real sqlite path, not the injected seam: the SQL has to match
// opencode's actual schema (`event.aggregate_id`, `part.session_id`) or the
// guard silently attributes nothing and kills innocent runs again.
describe("measureOpenCodeSessionBytes", () => {
  async function makeOpenCodeDatabase() {
    const { DatabaseSync } = await import("node:sqlite");
    const dir = await makeTempDir();
    const databasePath = path.join(dir, "opencode-agent-agent-1.db");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE event (
        id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL,
        type text NOT NULL, data text NOT NULL
      );
      CREATE TABLE part (
        id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
        time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
      );
      INSERT INTO event VALUES ('e1', 'ses_noisy', 1, 'message.part.updated.1', '${"x".repeat(1000)}');
      INSERT INTO event VALUES ('e2', 'ses_noisy', 2, 'message.part.updated.1', '${"x".repeat(500)}');
      INSERT INTO event VALUES ('e3', 'ses_quiet', 1, 'message.part.updated.1', '${"x".repeat(7)}');
      INSERT INTO part VALUES ('p1', 'm1', 'ses_noisy', 0, 0, '${"x".repeat(300)}');
      INSERT INTO part VALUES ('p2', 'm2', 'ses_quiet', 0, 0, '${"x".repeat(3)}');
    `);
    db.close();
    return databasePath;
  }

  it("sums the events and parts of one session only", async () => {
    const databasePath = await makeOpenCodeDatabase();
    expect(await measureOpenCodeSessionBytes(databasePath, "ses_noisy")).toBe(1800);
    expect(await measureOpenCodeSessionBytes(databasePath, "ses_quiet")).toBe(10);
  });

  it("reports zero for a session that has written nothing", async () => {
    const databasePath = await makeOpenCodeDatabase();
    expect(await measureOpenCodeSessionBytes(databasePath, "ses_absent")).toBe(0);
  });

  // Anything the guard cannot answer must be null, so the caller falls back to
  // terminating rather than to a wrong number.
  it("returns null rather than guessing when the database is unreadable", async () => {
    const dir = await makeTempDir();
    expect(await measureOpenCodeSessionBytes(path.join(dir, "missing.db"), "ses_x")).toBeNull();
  });

  it("returns null for an empty session id", async () => {
    const databasePath = await makeOpenCodeDatabase();
    expect(await measureOpenCodeSessionBytes(databasePath, "  ")).toBeNull();
  });
});

describe("readOpenCodeSessionIdFromChunk", () => {
  it("reads the session id opencode stamps on its JSONL events", () => {
    expect(
      readOpenCodeSessionIdFromChunk(
        '{"type":"text","sessionID":"ses_027959870ffe2fTMGMts4UU288","part":{}}\n',
      ),
    ).toBe("ses_027959870ffe2fTMGMts4UU288");
  });

  it("returns null for output that carries no session", () => {
    expect(readOpenCodeSessionIdFromChunk("building...\n")).toBeNull();
  });
});

// SUP-11280: the database is per AGENT and the guard is per RUN. On 2026-08-06
// two coder-LE runs were SIGTERMed for a sibling run's 247 MB; one of them had
// written 203 events. Attribution is what stops that.
describe("startOpenCodeDatabaseGrowthGuard session attribution", () => {
  async function waitFor(predicate: () => boolean, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return predicate();
  }

  async function makeDatabase(initialBytes: number) {
    const dir = await makeTempDir();
    const databasePath = path.join(dir, "opencode-agent-agent-1.db");
    await fs.writeFile(databasePath, Buffer.alloc(initialBytes));
    return databasePath;
  }

  it("spares a run whose own session owns a minority of the growth", async () => {
    const databasePath = await makeDatabase(1024);
    const trips: OpenCodeDatabaseGrowthTrip[] = [];
    const spares: OpenCodeDatabaseGrowthSpare[] = [];
    let sessionBytes = 0;

    const guard = startOpenCodeDatabaseGrowthGuard({
      databasePath,
      limitBytes: 4096,
      pollIntervalMs: 20,
      sessionId: "ses_innocent",
      measureSessionBytes: async () => sessionBytes,
      onTrip: (trip) => trips.push(trip),
      onSpare: (spare) => spares.push(spare),
    });

    try {
      await waitFor(() => false, 60);
      // This run wrote 100 bytes; the 16 KB belongs to a sibling run.
      sessionBytes = 100;
      await fs.writeFile(`${databasePath}-wal`, Buffer.alloc(16384));
      expect(await waitFor(() => spares.length > 0)).toBe(true);
    } finally {
      guard.stop();
    }

    expect(trips).toEqual([]);
    expect(spares[0].attribution.sessionId).toBe("ses_innocent");
    expect(spares[0].attribution.growthBytes).toBe(100);
    expect(describeOpenCodeDatabaseGrowthSpare(spares[0])).toContain("ses_innocent");
  });

  it("terminates the run whose own session owns the growth", async () => {
    const databasePath = await makeDatabase(1024);
    const trips: OpenCodeDatabaseGrowthTrip[] = [];
    const spares: OpenCodeDatabaseGrowthSpare[] = [];
    let sessionBytes = 0;

    const guard = startOpenCodeDatabaseGrowthGuard({
      databasePath,
      limitBytes: 4096,
      pollIntervalMs: 20,
      sessionId: "ses_culprit",
      measureSessionBytes: async () => sessionBytes,
      onTrip: (trip) => trips.push(trip),
      onSpare: (spare) => spares.push(spare),
    });

    try {
      await waitFor(() => false, 60);
      sessionBytes = 16384;
      await fs.writeFile(`${databasePath}-wal`, Buffer.alloc(16384));
      expect(await waitFor(() => trips.length > 0)).toBe(true);
    } finally {
      guard.stop();
    }

    expect(spares).toEqual([]);
    expect(trips[0].attribution?.sessionId).toBe("ses_culprit");
  });

  // A sibling that is already dead will never be killed by its own guard, so
  // sparing cannot be unbounded or the database grows forever.
  it("stops sparing after the bound and terminates anyway", async () => {
    const databasePath = await makeDatabase(0);
    const trips: OpenCodeDatabaseGrowthTrip[] = [];
    const spares: OpenCodeDatabaseGrowthSpare[] = [];
    let walBytes = 0;

    const guard = startOpenCodeDatabaseGrowthGuard({
      databasePath,
      limitBytes: 4096,
      pollIntervalMs: 20,
      sessionId: "ses_innocent",
      maxSparedTrips: 2,
      measureSessionBytes: async () => 0,
      onTrip: (trip) => trips.push(trip),
      onSpare: (spare) => spares.push(spare),
    });

    try {
      // Keep a foreign writer growing the file past the budget every pass.
      const grow = setInterval(() => {
        walBytes += 8192;
        void fs.writeFile(`${databasePath}-wal`, Buffer.alloc(walBytes));
      }, 25);
      try {
        expect(await waitFor(() => trips.length > 0)).toBe(true);
      } finally {
        clearInterval(grow);
      }
    } finally {
      guard.stop();
    }

    expect(spares).toHaveLength(2);
    expect(trips[0].sparedTrips).toBe(2);
  });

  // A resumed session's pre-existing rows are not this run's doing.
  it("charges a resumed run only for what it added to its session", async () => {
    const databasePath = await makeDatabase(1024);
    const trips: OpenCodeDatabaseGrowthTrip[] = [];
    const spares: OpenCodeDatabaseGrowthSpare[] = [];
    let sessionBytes = 500_000;

    const guard = startOpenCodeDatabaseGrowthGuard({
      databasePath,
      limitBytes: 4096,
      pollIntervalMs: 20,
      sessionId: "ses_resumed",
      measureSessionBytes: async () => sessionBytes,
      onTrip: (trip) => trips.push(trip),
      onSpare: (spare) => spares.push(spare),
    });

    try {
      await waitFor(() => false, 60);
      sessionBytes = 500_100;
      await fs.writeFile(`${databasePath}-wal`, Buffer.alloc(16384));
      expect(await waitFor(() => spares.length > 0)).toBe(true);
    } finally {
      guard.stop();
    }

    expect(trips).toEqual([]);
    expect(spares[0].attribution.growthBytes).toBe(100);
  });

  // Without a session id there is nothing to attribute to, and the guard must
  // behave exactly as it did before attribution existed.
  it("terminates on the file total when the session is unknown", async () => {
    const databasePath = await makeDatabase(1024);
    const trips: OpenCodeDatabaseGrowthTrip[] = [];

    const guard = startOpenCodeDatabaseGrowthGuard({
      databasePath,
      limitBytes: 4096,
      pollIntervalMs: 20,
      measureSessionBytes: async () => 0,
      onTrip: (trip) => trips.push(trip),
    });

    try {
      await waitFor(() => false, 60);
      await fs.writeFile(`${databasePath}-wal`, Buffer.alloc(16384));
      expect(await waitFor(() => trips.length > 0)).toBe(true);
    } finally {
      guard.stop();
    }

    expect(trips[0].attribution).toBeNull();
  });

  // A read-only query that cannot answer must not become a licence to keep
  // writing; the guard falls back to terminating.
  it("terminates when the session bytes cannot be read", async () => {
    const databasePath = await makeDatabase(1024);
    const trips: OpenCodeDatabaseGrowthTrip[] = [];

    const guard = startOpenCodeDatabaseGrowthGuard({
      databasePath,
      limitBytes: 4096,
      pollIntervalMs: 20,
      sessionId: "ses_unreadable",
      measureSessionBytes: async () => null,
      onTrip: (trip) => trips.push(trip),
    });

    try {
      await waitFor(() => false, 60);
      await fs.writeFile(`${databasePath}-wal`, Buffer.alloc(16384));
      expect(await waitFor(() => trips.length > 0)).toBe(true);
    } finally {
      guard.stop();
    }

    expect(trips[0].attribution).toBeNull();
  });

  it("learns the session id from the run's stdout", async () => {
    const databasePath = await makeDatabase(1024);
    const trips: OpenCodeDatabaseGrowthTrip[] = [];
    const spares: OpenCodeDatabaseGrowthSpare[] = [];
    const asked: string[] = [];

    const guard = startOpenCodeDatabaseGrowthGuard({
      databasePath,
      limitBytes: 4096,
      pollIntervalMs: 20,
      measureSessionBytes: async (_path, sessionId) => {
        asked.push(sessionId);
        return 100;
      },
      onTrip: (trip) => trips.push(trip),
      onSpare: (spare) => spares.push(spare),
    });

    try {
      guard.noteSessionId(
        readOpenCodeSessionIdFromChunk('{"sessionID":"ses_fromstdout","type":"text"}'),
      );
      // A later, different session id must not overwrite the first.
      guard.noteSessionId("ses_later");
      await waitFor(() => asked.length > 0);
      await fs.writeFile(`${databasePath}-wal`, Buffer.alloc(16384));
      expect(await waitFor(() => spares.length > 0)).toBe(true);
    } finally {
      guard.stop();
    }

    expect(new Set(asked)).toEqual(new Set(["ses_fromstdout"]));
    expect(spares[0].attribution.sessionId).toBe("ses_fromstdout");
    expect(trips).toEqual([]);
  });
});
