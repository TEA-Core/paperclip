import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../middleware/logger.js";

// SUP-10914. opencode never deletes a row and never truncates its WAL, so every
// database it writes grows forever: the shared one reached 51 GB with a 954 MB
// WAL before anyone looked. Per-agent databases and the adapter's growth guard
// bound the blast radius of a single bad run; neither reclaims anything.
//
// `scripts/opencode-db-janitor.mjs` is the reclaim, and it was delivered without
// anything to run it — leaving the "size and WAL stay bounded over a multi-day
// window WITHOUT manual intervention" acceptance line resting on a cron entry
// nobody had written. This is that scheduler.
//
// It runs the janitor as a CHILD PROCESS, not in-process. The janitor is
// synchronous `node:sqlite` and deliberately sleeps between delete batches to
// yield the write lock; doing that on the server's event loop would stall every
// request for the length of the sweep.

const serviceDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(serviceDir, "../../..");

export const OPENCODE_DB_JANITOR_SCRIPT = path.join(repoRoot, "scripts", "opencode-db-janitor.mjs");

export type OpenCodeDatabaseJanitorOptions = {
  retentionDays: number;
  /**
   * VACUUM rewrites the whole file under an exclusive lock. Off by default: the
   * prune and the WAL truncate are what keep growth bounded, and they take only
   * brief ordinary write locks, whereas a multi-GB VACUUM against a fleet that
   * is not as idle as it looks is the outage this issue is about. Operators who
   * want the file to give its high-water mark back opt in explicitly.
   */
  vacuum: boolean;
};

export function buildOpenCodeDatabaseJanitorArgs(
  options: OpenCodeDatabaseJanitorOptions,
): string[] {
  const args = [
    OPENCODE_DB_JANITOR_SCRIPT,
    "--apply",
    "--older-than-days",
    String(options.retentionDays),
  ];
  if (!options.vacuum) args.push("--no-vacuum");
  return args;
}

/**
 * Run one sweep and resolve with its exit code. Never rejects: a janitor that
 * cannot run must not be able to take the server down with it.
 */
export function runOpenCodeDatabaseJanitorSweep(
  options: OpenCodeDatabaseJanitorOptions,
): Promise<number | null> {
  return new Promise((resolve) => {
    const args = buildOpenCodeDatabaseJanitorArgs(options);
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: string[] = [];
    const collect = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim().length > 0) output.push(line);
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (err) => {
      logger.warn(
        { err, script: OPENCODE_DB_JANITOR_SCRIPT },
        "opencode database janitor failed to start",
      );
      resolve(null);
    });
    child.on("close", (code) => {
      // The script's own exit code is the only signal that distinguishes "swept
      // cleanly" from "every database failed", which is why it has one.
      if (code === 0) {
        logger.debug({ output }, "opencode database janitor sweep finished");
      } else {
        logger.warn(
          { exitCode: code, output },
          "opencode database janitor sweep reported failures",
        );
      }
      resolve(code);
    });
  });
}

export type OpenCodeDatabaseJanitorSchedule = OpenCodeDatabaseJanitorOptions & {
  intervalMs: number;
  /**
   * Delay before the first sweep. Not zero, so a restart does not add a
   * database sweep to the boot path; not the whole interval either, because a
   * server that restarts more often than the interval would then never sweep
   * at all — which is how retention silently stops.
   */
  initialDelayMs?: number;
  /** Seam for tests. */
  runSweep?: (options: OpenCodeDatabaseJanitorOptions) => Promise<unknown>;
};

const DEFAULT_INITIAL_DELAY_MS = 5 * 60 * 1000;

/**
 * Start the periodic sweep. Returns a stop function.
 *
 * Overlapping sweeps are refused here as well as by the janitor's own lock
 * file: the lock protects against a sweep started from anywhere (a host cron,
 * another container), while this keeps a slow sweep from queueing behind
 * itself in the common case.
 */
export function startOpenCodeDatabaseJanitor(
  schedule: OpenCodeDatabaseJanitorSchedule,
): () => void {
  const runSweep = schedule.runSweep ?? runOpenCodeDatabaseJanitorSweep;
  const options: OpenCodeDatabaseJanitorOptions = {
    retentionDays: schedule.retentionDays,
    vacuum: schedule.vacuum,
  };
  let inFlight = false;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    if (inFlight) {
      logger.info("opencode database janitor sweep still running; skipping this tick");
      return;
    }
    inFlight = true;
    void Promise.resolve(runSweep(options))
      .catch((err) => {
        logger.warn({ err }, "opencode database janitor sweep threw");
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const initialTimer = setTimeout(tick, schedule.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
  initialTimer.unref?.();
  const timer = setInterval(tick, schedule.intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearTimeout(initialTimer);
    clearInterval(timer);
  };
}
