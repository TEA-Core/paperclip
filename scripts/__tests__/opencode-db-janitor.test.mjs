import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  detectTimeUnit,
  isDatabaseIdle,
  janitorRunDatabase,
  listOpenCodeDatabases,
  parseJanitorArgs,
  resolveCutoff,
  resolveOpenCodeDataDir,
  shouldVacuum,
} from "../opencode-db-janitor.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = 1_770_000_000_000;

// Copied from a real opencode 1.17.9 database (`sqlite_master`), trimmed to the
// tables the janitor touches. The ON DELETE CASCADE constraints are the point:
// the prune deletes `session` rows and relies on them for everything else.
const SCHEMA = `
CREATE TABLE project (id text PRIMARY KEY);
CREATE TABLE session (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  CONSTRAINT fk_session_project FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE TABLE message (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  time_created integer NOT NULL,
  data text NOT NULL,
  CONSTRAINT fk_message_session FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);
CREATE TABLE part (
  id text PRIMARY KEY,
  message_id text NOT NULL,
  session_id text NOT NULL,
  data text NOT NULL,
  CONSTRAINT fk_part_message FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
);
CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL);
CREATE TABLE event (
  id text PRIMARY KEY,
  aggregate_id text NOT NULL,
  seq integer NOT NULL,
  type text NOT NULL,
  data text NOT NULL,
  CONSTRAINT fk_event_sequence FOREIGN KEY (aggregate_id) REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE
);
`;

function makeDatabase({ sessions, unit = "ms" }) {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-db-janitor-test-"));
  const databasePath = path.join(dir, "opencode-agent-agent-1.db");
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare("INSERT INTO project (id) VALUES (?)").run("prj_1");
  for (const [index, ageDays] of sessions.entries()) {
    const createdMs = NOW_MS - ageDays * DAY_MS;
    const created = unit === "ms" ? createdMs : Math.floor(createdMs / 1000);
    const sessionId = `ses_${index}`;
    db.prepare(
      "INSERT INTO session (id, project_id, time_created, time_updated) VALUES (?, ?, ?, ?)",
    ).run(sessionId, "prj_1", created, created);
    db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
      `msg_${index}`,
      sessionId,
      created,
      "x".repeat(64),
    );
    db.prepare("INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)").run(
      `prt_${index}`,
      `msg_${index}`,
      sessionId,
      "x".repeat(64),
    );
    db.prepare("INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, ?)").run(sessionId, 1);
    db.prepare("INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)").run(
      `evt_${index}`,
      sessionId,
      1,
      "message.updated",
      "x".repeat(64),
    );
  }
  db.close();
  return { dir, databasePath };
}

function counts(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const read = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  const result = {
    session: read("session"),
    message: read("message"),
    part: read("part"),
    event: read("event"),
    event_sequence: read("event_sequence"),
  };
  db.close();
  return result;
}

test("parseJanitorArgs defaults to a dry run", () => {
  const args = parseJanitorArgs([]);
  assert.equal(args.apply, false);
  assert.equal(args.olderThanDays, 7);
});

test("parseJanitorArgs reads the destructive flags", () => {
  const args = parseJanitorArgs(["--apply", "--older-than-days", "3", "--data-dir", "/d"]);
  assert.equal(args.apply, true);
  assert.equal(args.olderThanDays, 3);
  assert.equal(args.dataDir, "/d");
});

test("parseJanitorArgs rejects an unknown flag rather than ignoring it", () => {
  assert.throws(() => parseJanitorArgs(["--delete-everything"]), /Unknown argument/);
});

test("parseJanitorArgs rejects a non-numeric retention window", () => {
  assert.throws(() => parseJanitorArgs(["--older-than-days", "soon"]), /non-negative number/);
});

test("resolveOpenCodeDataDir matches opencode's own resolution", () => {
  assert.equal(
    resolveOpenCodeDataDir({ HOME: "/paperclip" }),
    "/paperclip/.local/share/opencode",
  );
  assert.equal(resolveOpenCodeDataDir({ XDG_DATA_HOME: "/d", HOME: "/paperclip" }), "/d/opencode");
});

test("listOpenCodeDatabases finds the per-agent and shared databases only", () => {
  const found = listOpenCodeDatabases("/data", () => [
    "opencode.db",
    "opencode.db-wal",
    "opencode-agent-a.db",
    "opencode-agent-b.db",
    "auth.json",
    "something-else.db",
  ]);
  assert.deepEqual(found, [
    "/data/opencode-agent-a.db",
    "/data/opencode-agent-b.db",
    "/data/opencode.db",
  ]);
});

// Reading the unit wrong by 1000x would make every row look older than the
// cutoff and delete the entire history, so it is detected, never assumed.
test("detectTimeUnit distinguishes millisecond from second timestamps", () => {
  assert.equal(detectTimeUnit(NOW_MS), "ms");
  assert.equal(detectTimeUnit(Math.floor(NOW_MS / 1000)), "s");
});

test("detectTimeUnit refuses to guess from an empty table", () => {
  assert.equal(detectTimeUnit(null), null);
  assert.equal(detectTimeUnit(0), null);
  assert.equal(detectTimeUnit(undefined), null);
});

test("resolveCutoff prunes nothing when the unit is unknown", () => {
  assert.equal(resolveCutoff({ unit: null, nowMs: NOW_MS, olderThanDays: 7 }), null);
});

test("resolveCutoff scales the cutoff to the detected unit", () => {
  assert.equal(resolveCutoff({ unit: "ms", nowMs: NOW_MS, olderThanDays: 7 }), NOW_MS - 7 * DAY_MS);
  assert.equal(
    resolveCutoff({ unit: "s", nowMs: NOW_MS, olderThanDays: 7 }),
    Math.floor((NOW_MS - 7 * DAY_MS) / 1000),
  );
});

test("shouldVacuum holds off until the dead space is worth an exclusive lock", () => {
  const pageSize = 4096;
  // 99.99% free, which is what the shared database actually looked like.
  assert.equal(
    shouldVacuum({ freelistCount: 1_764_237, pageCount: 1_764_330, pageSize, minFreeMb: 256 }),
    true,
  );
  // Plenty free in absolute terms, but a small share of the file.
  assert.equal(
    shouldVacuum({ freelistCount: 100_000, pageCount: 10_000_000, pageSize, minFreeMb: 256 }),
    false,
  );
  // Mostly free, but too small to bother.
  assert.equal(shouldVacuum({ freelistCount: 100, pageCount: 110, pageSize, minFreeMb: 256 }), false);
});

test("isDatabaseIdle treats a recently written database as in use", () => {
  const { dir, databasePath } = makeDatabase({ sessions: [1] });
  try {
    assert.equal(isDatabaseIdle({ databasePath, nowMs: Date.now(), idleMinutes: 10 }), false);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(databasePath, old, old);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        utimesSync(`${databasePath}${suffix}`, old, old);
      } catch {
        // Sidecar may not exist after close.
      }
    }
    assert.equal(isDatabaseIdle({ databasePath, nowMs: Date.now(), idleMinutes: 10 }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dry run reports what it would prune and deletes nothing", () => {
  const { dir, databasePath } = makeDatabase({ sessions: [30, 1] });
  try {
    const report = janitorRunDatabase({
      databasePath,
      DatabaseSync,
      apply: false,
      olderThanDays: 7,
      nowMs: NOW_MS,
    });
    assert.equal(report.sessionsPruned, 1);
    assert.deepEqual(counts(databasePath), {
      session: 2,
      message: 2,
      part: 2,
      event: 2,
      event_sequence: 2,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--apply prunes old sessions and cascades to their messages and parts", () => {
  const { dir, databasePath } = makeDatabase({ sessions: [30, 20, 1] });
  try {
    const report = janitorRunDatabase({
      databasePath,
      DatabaseSync,
      apply: true,
      olderThanDays: 7,
      nowMs: NOW_MS,
    });
    assert.equal(report.sessionsPruned, 2);
    assert.deepEqual(counts(databasePath), {
      session: 1,
      message: 1,
      part: 1,
      event: 1,
      event_sequence: 1,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 175 event rows held 11.9 GB — 33% of all event data — in the incident
// database. They cascade from `event_sequence`, not from `session`, so pruning
// sessions alone would leave every byte of that behind.
test("--apply reclaims the event stream of a pruned session", () => {
  const { dir, databasePath } = makeDatabase({ sessions: [30] });
  try {
    const report = janitorRunDatabase({
      databasePath,
      DatabaseSync,
      apply: true,
      olderThanDays: 7,
      nowMs: NOW_MS,
    });
    assert.equal(report.eventSequencesPruned, 1);
    assert.equal(counts(databasePath).event, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--apply keeps sessions inside the retention window", () => {
  const { dir, databasePath } = makeDatabase({ sessions: [1, 2, 3] });
  try {
    const report = janitorRunDatabase({
      databasePath,
      DatabaseSync,
      apply: true,
      olderThanDays: 7,
      nowMs: NOW_MS,
    });
    assert.equal(report.sessionsPruned, 0);
    assert.equal(counts(databasePath).session, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("second-resolution timestamps prune the same rows as millisecond ones", () => {
  const { dir, databasePath } = makeDatabase({ sessions: [30, 1], unit: "s" });
  try {
    const report = janitorRunDatabase({
      databasePath,
      DatabaseSync,
      apply: true,
      olderThanDays: 7,
      nowMs: NOW_MS,
    });
    assert.equal(report.sessionsPruned, 1);
    assert.equal(counts(databasePath).session, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty database is left alone rather than date-guessed", () => {
  const { dir, databasePath } = makeDatabase({ sessions: [] });
  try {
    const report = janitorRunDatabase({
      databasePath,
      DatabaseSync,
      apply: true,
      olderThanDays: 7,
      nowMs: NOW_MS,
    });
    assert.equal(report.sessionsPruned, 0);
    assert.match(report.skipped, /no sessions/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// opencode only ever runs PASSIVE checkpoints and never sets
// `journal_size_limit`, so the WAL file stays at its high-water mark. TRUNCATE
// is the only thing that gives the disk back.
test("--apply truncates the WAL instead of leaving it at its high-water mark", () => {
  const { dir, databasePath } = makeDatabase({ sessions: [30, 29, 28] });
  try {
    // Held open on purpose: closing the last connection checkpoints and removes
    // the WAL, which would make this pass without the janitor doing anything.
    const writer = new DatabaseSync(databasePath);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec("BEGIN");
    const insert = writer.prepare("INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, ?)");
    for (let i = 0; i < 4000; i++) insert.run(`agg_${i}`, i);
    writer.exec("COMMIT");

    try {
      const walBefore = statSync(`${databasePath}-wal`).size;
      assert.ok(walBefore > 0, "fixture should leave a non-empty WAL");

      const report = janitorRunDatabase({
        databasePath,
        DatabaseSync,
        apply: true,
        olderThanDays: 7,
        nowMs: NOW_MS,
      });
      assert.equal(report.walTruncated, true);
      assert.equal(statSync(`${databasePath}-wal`).size, 0);
    } finally {
      writer.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt database fails that database without throwing out of the run", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-db-janitor-test-"));
  try {
    const databasePath = path.join(dir, "opencode-agent-broken.db");
    writeFileSync(databasePath, "this is not a database");
    assert.throws(() =>
      janitorRunDatabase({
        databasePath,
        DatabaseSync,
        apply: true,
        olderThanDays: 7,
        nowMs: NOW_MS,
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
