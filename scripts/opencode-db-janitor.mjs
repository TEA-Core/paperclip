#!/usr/bin/env node
// SUP-10914 — host-side janitor for the opencode SQLite databases.
//
// Two defects behind the 2026-08-04 fleet outage live inside the opencode
// binary and cannot be fixed from this repo:
//
//   * opencode rewrites an assistant message's whole row per stream delta and
//     emits a full-snapshot event alongside it, so write cost is quadratic in
//     message size (one message reached 431 MB; its session wrote 3.9 GB of
//     events).
//   * opencode's connection never sets `journal_size_limit`, so the WAL is
//     never truncated after a checkpoint — it only grows. That pragma is
//     per-connection, so it cannot be set from outside.
//
// Per-agent databases (SUP-10914 item 2) stop one bad run failing OTHER agents,
// and the adapter's growth guard stops a runaway run mid-flight. Neither
// reclaims anything: NOTHING anywhere deletes rows from these databases. The
// shared database was observed at 45.4 GB with `auto_vacuum = 0` and
// `freelist_count = 0` — no row had ever been deleted. Per-agent databases have
// the same property, just independently.
//
// This script is the containment: prune old sessions, truncate the WAL, and
// reclaim free pages. It is deliberately a separate cron-able process, not
// something a run does, because VACUUM takes an exclusive lock — running it
// inside a run would reproduce the very lock starvation this issue is about.
//
// Usage:
//   node scripts/opencode-db-janitor.mjs                  # dry run, reports only
//   node scripts/opencode-db-janitor.mjs --apply
//   node scripts/opencode-db-janitor.mjs --apply --older-than-days 3
//   node scripts/opencode-db-janitor.mjs --apply --data-dir /paperclip/.local/share/opencode

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BYTES_PER_MB = 1024 * 1024;

export const DEFAULTS = {
  olderThanDays: 7,
  // Skip any database touched more recently than this: a live run holds it, and
  // an exclusive VACUUM against a running agent is exactly the failure mode
  // this script exists to prevent.
  idleMinutes: 10,
  // Only VACUUM when there is enough dead space to be worth an exclusive lock.
  vacuumMinFreeMb: 256,
  vacuumMinFreeRatio: 0.25,
  busyTimeoutMs: 2000,
};

/** Session-scoped tables all cascade from `session`, so deleting the session
 * row is enough. Listed here only so `--verbose` can report what went. */
export const SESSION_CASCADE_TABLES = [
  "message",
  "part",
  "session_message",
  "session_input",
  "todo",
  "session_context_epoch",
  "session_share",
];

export function parseJanitorArgs(argv) {
  const args = {
    apply: false,
    verbose: false,
    dataDir: "",
    olderThanDays: DEFAULTS.olderThanDays,
    idleMinutes: DEFAULTS.idleMinutes,
    vacuumMinFreeMb: DEFAULTS.vacuumMinFreeMb,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const readNumber = (name) => {
      const raw = argv[++i];
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${name} needs a non-negative number, got ${JSON.stringify(raw)}`);
      }
      return value;
    };
    switch (arg) {
      case "--apply":
        args.apply = true;
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--data-dir":
        args.dataDir = argv[++i] ?? "";
        break;
      case "--older-than-days":
        args.olderThanDays = readNumber(arg);
        break;
      case "--idle-minutes":
        args.idleMinutes = readNumber(arg);
        break;
      case "--vacuum-min-free-mb":
        args.vacuumMinFreeMb = readNumber(arg);
        break;
      default:
        throw new Error(`Unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return args;
}

/** Mirrors opencode's own data-dir resolution, and the adapter's. */
export function resolveOpenCodeDataDir(env = process.env) {
  const xdg = (env.XDG_DATA_HOME ?? "").trim();
  if (xdg) return path.join(xdg, "opencode");
  const home = (env.HOME ?? "").trim() || os.homedir();
  return path.join(home, ".local", "share", "opencode");
}

/** Every SQLite database in the data dir: the per-agent ones the adapter now
 * creates, plus the shared database that predates them. */
export function listOpenCodeDatabases(dataDir, readdir = fs.readdirSync) {
  let entries;
  try {
    entries = readdir(dataDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".db"))
    .filter((name) => name === "opencode.db" || name.startsWith("opencode-"))
    .sort()
    .map((name) => path.join(dataDir, name));
}

/**
 * opencode stores `time_created` as an integer, and the column type does not
 * say whether that is seconds or milliseconds. Guessing wrong by 1000x would
 * make every row look older than the cutoff and delete the entire history, so
 * the unit is detected from the data instead of assumed.
 *
 * Returns null when there is nothing to detect from, which callers must treat
 * as "prune nothing".
 */
export function detectTimeUnit(maxTimeCreated) {
  if (typeof maxTimeCreated !== "number" || !Number.isFinite(maxTimeCreated) || maxTimeCreated <= 0) {
    return null;
  }
  // 1e12 ms ≈ 2001-09; 1e12 s is far beyond any plausible timestamp.
  return maxTimeCreated > 1e12 ? "ms" : "s";
}

export function resolveCutoff({ unit, nowMs, olderThanDays }) {
  if (!unit) return null;
  const cutoffMs = nowMs - olderThanDays * 24 * 60 * 60 * 1000;
  return unit === "ms" ? cutoffMs : Math.floor(cutoffMs / 1000);
}

export function shouldVacuum({ freelistCount, pageCount, pageSize, minFreeMb, minFreeRatio = DEFAULTS.vacuumMinFreeRatio }) {
  if (!pageCount || !pageSize) return false;
  const freeBytes = freelistCount * pageSize;
  if (freeBytes < minFreeMb * BYTES_PER_MB) return false;
  return freelistCount / pageCount >= minFreeRatio;
}

/**
 * A database whose files were touched inside the idle window is assumed to be
 * held by a live run.
 */
export function isDatabaseIdle({ databasePath, nowMs, idleMinutes, stat = fs.statSync }) {
  if (idleMinutes <= 0) return true;
  const thresholdMs = nowMs - idleMinutes * 60 * 1000;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const info = stat(`${databasePath}${suffix}`);
      if (info.mtimeMs > thresholdMs) return false;
    } catch {
      // Missing sidecar: nothing to learn from it.
    }
  }
  return true;
}

export function formatBytes(bytes) {
  if (bytes < BYTES_PER_MB) return `${bytes} B`;
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

function fileBytes(databasePath) {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += fs.statSync(`${databasePath}${suffix}`).size;
    } catch {
      // Not there; contributes nothing.
    }
  }
  return total;
}

/**
 * Prune, checkpoint and (when it is worth it) vacuum one database.
 *
 * `DatabaseSync` is injected so the tests can drive a real SQLite file without
 * this module reaching for globals.
 */
export function janitorRunDatabase({
  databasePath,
  DatabaseSync,
  apply,
  olderThanDays,
  nowMs,
  busyTimeoutMs = DEFAULTS.busyTimeoutMs,
  vacuumMinFreeMb = DEFAULTS.vacuumMinFreeMb,
}) {
  const report = {
    databasePath,
    bytesBefore: fileBytes(databasePath),
    bytesAfter: null,
    sessionsPruned: 0,
    eventSequencesPruned: 0,
    walTruncated: false,
    vacuumed: false,
    skipped: null,
  };

  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.floor(busyTimeoutMs)}`);
    // Off by default on every new connection, and the whole prune depends on it:
    // without it, deleting a session would orphan its messages and parts instead
    // of removing them.
    db.exec("PRAGMA foreign_keys = ON");

    const maxTimeCreated = db.prepare("SELECT MAX(time_created) AS max FROM session").get()?.max;
    const unit = detectTimeUnit(typeof maxTimeCreated === "bigint" ? Number(maxTimeCreated) : maxTimeCreated);
    const cutoff = resolveCutoff({ unit, nowMs, olderThanDays });

    if (cutoff === null) {
      report.skipped = "no sessions to date-check";
    } else {
      const doomed = db
        .prepare("SELECT id FROM session WHERE time_created < ?")
        .all(cutoff)
        .map((row) => row.id);
      report.sessionsPruned = doomed.length;

      if (doomed.length > 0 && apply) {
        db.exec("BEGIN");
        try {
          const deleteSession = db.prepare("DELETE FROM session WHERE id = ?");
          // `event` cascades from `event_sequence`, not from `session`, so the
          // event rows — 33% of all event data in the incident database — are
          // only reclaimed by deleting the sequence rows too. Scoping this to
          // the ids we just deleted means that if `aggregate_id` is not a
          // session id at all, this is a no-op rather than a wrong delete.
          const deleteEventSequence = db.prepare("DELETE FROM event_sequence WHERE aggregate_id = ?");
          for (const id of doomed) {
            deleteSession.run(id);
            const result = deleteEventSequence.run(id);
            report.eventSequencesPruned += Number(result?.changes ?? 0);
          }
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      }
    }

    if (apply) {
      // TRUNCATE, not PASSIVE: opencode already runs PASSIVE checkpoints, and
      // without `journal_size_limit` those leave the WAL file at its high-water
      // mark. This is the only thing that gives the disk back.
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      report.walTruncated = true;
    }

    const freelistCount = Number(db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0);
    const pageCount = Number(db.prepare("PRAGMA page_count").get()?.page_count ?? 0);
    const pageSize = Number(db.prepare("PRAGMA page_size").get()?.page_size ?? 0);
    const wantsVacuum = shouldVacuum({
      freelistCount,
      pageCount,
      pageSize,
      minFreeMb: vacuumMinFreeMb,
    });
    if (wantsVacuum && apply) {
      db.exec("VACUUM");
      report.vacuumed = true;
    } else if (wantsVacuum) {
      report.vacuumed = "would vacuum";
    }
  } finally {
    db.close();
  }

  report.bytesAfter = fileBytes(databasePath);
  return report;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseJanitorArgs(argv);
  const log = deps.log ?? console.log;
  const nowMs = deps.nowMs ?? Date.now();
  const { DatabaseSync } = deps.DatabaseSync
    ? { DatabaseSync: deps.DatabaseSync }
    : await import("node:sqlite");

  const dataDir = args.dataDir || resolveOpenCodeDataDir();
  const databases = listOpenCodeDatabases(dataDir);
  if (databases.length === 0) {
    log(`No opencode databases found in ${dataDir}`);
    return 0;
  }

  log(
    `${args.apply ? "Pruning" : "Dry run over"} ${databases.length} database(s) in ${dataDir} ` +
      `(sessions older than ${args.olderThanDays}d)`,
  );

  let reclaimed = 0;
  for (const databasePath of databases) {
    if (!isDatabaseIdle({ databasePath, nowMs, idleMinutes: args.idleMinutes })) {
      log(`  skip ${path.basename(databasePath)} — in use within the last ${args.idleMinutes}m`);
      continue;
    }
    try {
      const report = janitorRunDatabase({
        databasePath,
        DatabaseSync,
        apply: args.apply,
        olderThanDays: args.olderThanDays,
        nowMs,
        vacuumMinFreeMb: args.vacuumMinFreeMb,
      });
      reclaimed += Math.max(0, report.bytesBefore - report.bytesAfter);
      log(
        `  ${path.basename(databasePath)}: ${report.sessionsPruned} session(s)` +
          `${report.eventSequencesPruned ? `, ${report.eventSequencesPruned} event stream(s)` : ""}` +
          `${report.vacuumed === true ? ", vacuumed" : report.vacuumed ? ", vacuum pending" : ""}` +
          ` — ${formatBytes(report.bytesBefore)} → ${formatBytes(report.bytesAfter)}` +
          `${report.skipped ? ` (${report.skipped})` : ""}`,
      );
      if (args.verbose) {
        log(`    cascades: ${SESSION_CASCADE_TABLES.join(", ")}`);
      }
    } catch (err) {
      // One unhealthy or locked database must not stop the sweep.
      log(`  ${path.basename(databasePath)}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!args.apply) {
    log("Dry run: nothing was deleted. Re-run with --apply.");
  } else {
    log(`Reclaimed ${formatBytes(reclaimed)}.`);
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
