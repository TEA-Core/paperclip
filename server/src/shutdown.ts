type HotRestartShutdownPreparation = {
  skipDrain: boolean;
};

/**
 * SUP-10309. Docker's default stop timeout is 10s; anything the shutdown
 * handler has not finished by then is cut off by SIGKILL to PID 1. Run
 * children are spawned detached in their own process group, so they never see
 * that signal and survive the restart as orphans holding the old container's
 * mounts open. The whole handler therefore gets a budget comfortably under
 * 10s, and whatever is still alive when it runs out is killed rather than
 * awaited.
 */
export const DEFAULT_SHUTDOWN_DEADLINE_MS = 8_000;

export function resolveShutdownDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAPERCLIP_SHUTDOWN_DEADLINE_MS;
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_SHUTDOWN_DEADLINE_MS;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SHUTDOWN_DEADLINE_MS;
  return parsed;
}

export type ShutdownDeadline = {
  totalMs: number;
  remainingMs: () => number;
  expired: () => boolean;
};

export function createShutdownDeadline(
  totalMs: number,
  now: () => number = Date.now,
): ShutdownDeadline {
  const startedAt = now();
  const remainingMs = () => Math.max(0, totalMs - (now() - startedAt));
  return {
    totalMs,
    remainingMs,
    expired: () => remainingMs() <= 0,
  };
}

/**
 * Run one shutdown stage against the shared budget. A stage that outruns the
 * budget is abandoned, not cancelled -- there is no way to cancel an in-flight
 * drain -- but the handler stops waiting on it and moves on to the kill sweep.
 * Rejections are still real failures and propagate.
 */
export async function withShutdownDeadline<T>(
  work: Promise<T>,
  deadline: ShutdownDeadline,
): Promise<{ completed: true; value: T } | { completed: false }> {
  const remaining = deadline.remainingMs();
  if (remaining <= 0) return { completed: false };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<{ completed: false }>((resolveExpiry) => {
    timer = setTimeout(() => resolveExpiry({ completed: false }), remaining);
    // Never let the deadline timer be the reason the process stays up.
    timer.unref?.();
  });

  try {
    return await Promise.race([
      work.then((value) => ({ completed: true as const, value })),
      expiry,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type SweepableRunProcess = {
  child: { pid?: number | null } | null | undefined;
  processGroupId: number | null | undefined;
};

/**
 * Last resort before `process.exit`: SIGKILL the process group of every run
 * child still registered in memory. The graceful drain already tried SIGTERM
 * and a per-run grace period; anything left here either outlived that grace or
 * belongs to a run whose row is no longer `running`, which the drain does not
 * look at. Killing the group rather than the pid is what actually reaches the
 * detached `opencode run` subtree.
 *
 * Never call this on the hot-restart path -- those children are deliberately
 * left alive for the incoming server to adopt.
 */
export function sweepDetachedRunProcesses(input: {
  entries: Iterable<[string, SweepableRunProcess]>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  signal?: NodeJS.Signals;
}): { signalled: string[]; skipped: string[]; failed: string[] } {
  const kill = input.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const signal = input.signal ?? "SIGKILL";
  const signalled: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const [runId, entry] of input.entries) {
    const groupId = entry?.processGroupId;
    const childPid = entry?.child?.pid;
    const targetGroup =
      process.platform !== "win32" && typeof groupId === "number" && Number.isInteger(groupId) && groupId > 0;
    const target = targetGroup
      ? -(groupId as number)
      : typeof childPid === "number" && Number.isInteger(childPid) && childPid > 0
        ? childPid
        : null;
    if (target === null) {
      skipped.push(runId);
      continue;
    }
    try {
      kill(target, signal);
      signalled.push(runId);
    } catch {
      // ESRCH just means the drain already got it. Never let one dead entry
      // strand the entries behind it.
      failed.push(runId);
    }
  }

  return { signalled, skipped, failed };
}

type ShutdownLogger = {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

/**
 * Runs the final, ordered teardown of the server. It awaits the application
 * service cleanup first, so a live setup-token login session stops and releases
 * its sandbox lease before the database and the provider stop. The caller runs
 * `process.exit(0)` only after this helper resolves, so an orderly shutdown
 * never leaves a sandbox lease or confidential login state alive past the
 * process exit.
 *
 * A step that rejects does not stop the teardown. The helper logs the error and
 * continues to the next step. A failed setup-token lease release stays a
 * durable record for the startup reaper; the helper surfaces it in the log
 * instead of blocking the exit path.
 */
export async function finalizeServerShutdown(input: {
  signal: "SIGINT" | "SIGTERM";
  shutdownAppServices: (() => Promise<void>) | undefined;
  stopEmbeddedPostgres: (() => Promise<void>) | null;
  shutdownInstrumentation: () => Promise<void>;
  shutdownSentry: () => Promise<void>;
  log: ShutdownLogger;
}): Promise<void> {
  const { signal } = input;

  // Await the application service cleanup, so a live setup-token login session
  // releases its sandbox lease before the database and the provider stop. A
  // rejected cleanup stays durable for the reaper; it does not block the exit.
  try {
    await input.shutdownAppServices?.();
  } catch (err) {
    input.log.error({ err, signal }, "Application service shutdown failed");
  }

  if (input.stopEmbeddedPostgres) {
    input.log.info({ signal }, "Stopping embedded PostgreSQL");
    try {
      await input.stopEmbeddedPostgres();
    } catch (err) {
      input.log.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
    }
  }

  // Flush buffered OTel spans before the process goes away; without this await
  // the exporter's final batch is dropped on exit.
  await input.shutdownInstrumentation();

  // Flush buffered Sentry events before the process goes away; without this
  // await the last events are dropped on exit.
  await input.shutdownSentry();
}

const COORDINATED_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

type ShutdownSignalTarget = {
  rawListeners(eventName: string): Function[];
  removeListener(eventName: string, listener: (...args: any[]) => void): unknown;
};

/**
 * Some dependencies eagerly install process signal handlers as an import side
 * effect. Paperclip must remain the sole owner of SIGINT/SIGTERM ordering: its
 * handler first snapshots live heartbeat runs and only then stops embedded
 * infrastructure. Remove only listeners added by the supplied import, while
 * preserving every listener that was already registered.
 */
export async function loadWithoutCoordinatedShutdownSignalHooks<T>(
  load: () => Promise<T>,
  signalTarget: ShutdownSignalTarget = process,
) {
  const listenersBeforeLoad = new Map(
    COORDINATED_SHUTDOWN_SIGNALS.map((signal) => [
      signal,
      signalTarget.rawListeners(signal),
    ]),
  );

  let loaded: T;
  try {
    loaded = await load();
  } finally {
    for (const signal of COORDINATED_SHUTDOWN_SIGNALS) {
      const remainingBeforeLoad = [...(listenersBeforeLoad.get(signal) ?? [])];
      for (const listener of signalTarget.rawListeners(signal)) {
        const existingIndex = remainingBeforeLoad.indexOf(listener);
        if (existingIndex >= 0) {
          remainingBeforeLoad.splice(existingIndex, 1);
          continue;
        }
        signalTarget.removeListener(signal, listener as (...args: any[]) => void);
      }
    }
  }

  return loaded;
}

export async function coordinateHeartbeatSchedulerShutdown<
  TPreparation extends HotRestartShutdownPreparation,
>(input: {
  signal: "SIGINT" | "SIGTERM";
  prepareHotRestartShutdown: ((signal: "SIGINT" | "SIGTERM") => Promise<TPreparation>) | null;
  waitForHeartbeatSchedulerIdle: () => Promise<void>;
  deadline?: ShutdownDeadline;
}): Promise<{
  hotRestart: TPreparation | null;
  preparationError: unknown;
  waitedForSchedulerIdle: boolean;
  schedulerIdleTimedOut: boolean;
}> {
  let hotRestart: TPreparation | null = null;
  let preparationError: unknown = null;

  // The signal handler stops the scheduler before entering this coordinator.
  // Quiesce any callback that was already in flight BEFORE querying running rows
  // for the shutdown snapshot, otherwise a late queue claim can create a run that
  // is absent from both the snapshot and the selective drain set. The wait has to
  // happen here rather than after preparation, so it also covers the hot-restart
  // path -- which is why there is exactly one wait in this function.
  //
  // It is still bounded: the wait blocks on in-flight scheduler work, which
  // includes whole agent runs, and without a bound it can outlast the container's
  // stop timeout on its own before the drain has signalled anything (SUP-10309).
  let waitedForSchedulerIdle = true;
  let schedulerIdleTimedOut = false;
  if (input.deadline) {
    const idle = await withShutdownDeadline(input.waitForHeartbeatSchedulerIdle(), input.deadline);
    waitedForSchedulerIdle = idle.completed;
    schedulerIdleTimedOut = !idle.completed;
  } else {
    await input.waitForHeartbeatSchedulerIdle();
  }

  if (input.prepareHotRestartShutdown) {
    try {
      hotRestart = await input.prepareHotRestartShutdown(input.signal);
    } catch (err) {
      preparationError = err;
    }
  }

  return {
    hotRestart,
    preparationError,
    waitedForSchedulerIdle,
    schedulerIdleTimedOut,
  };
}
