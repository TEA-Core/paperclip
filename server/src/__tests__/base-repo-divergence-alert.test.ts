import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_REPO_DIVERGENCE_ALERT_AGE_DAYS,
  acquireDivergenceClaim,
  buildDivergenceAlertText,
  clearDivergenceRecord,
  divergenceClaimLockPath,
  divergenceRecordPath,
  formatDivergenceDuration,
  isDivergenceClaimOwnerLive,
  observeDivergedRefusal,
  readDivergenceClaimLock,
  readDivergenceRecord,
  releaseDivergenceClaim,
  resolveDivergenceAgeAlert,
  resolveDivergenceAlertThresholdMs,
  type BaseRepoDivergenceAlert,
  type DivergenceClaimLock,
} from "../services/base-repo-divergence-alert.ts";

// SUP-15615 — a project base repo that stays in the non-resettable `diverged`
// state should emit a first-class signal once it has persisted past a
// configurable age threshold, deduplicated to fire once per episode. These
// tests cover the pure age/threshold decision, the per-base-repo sidecar
// record (read/write/clear + episode dedup), and the alert text.

const DAY = 24 * 60 * 60 * 1000;
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeRepoRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sup15615-"));
  tempRoots.push(root);
  return root;
}

describe("resolveDivergenceAlertThresholdMs", () => {
  it("defaults to 7 days when the env var is absent", () => {
    expect(resolveDivergenceAlertThresholdMs({})).toBe(DEFAULT_BASE_REPO_DIVERGENCE_ALERT_AGE_DAYS * DAY);
  });

  it("honors a positive operator override in days", () => {
    expect(resolveDivergenceAlertThresholdMs({ PAPERCLIP_BASE_REPO_DIVERGENCE_ALERT_AGE_DAYS: "3" })).toBe(3 * DAY);
    expect(resolveDivergenceAlertThresholdMs({ PAPERCLIP_BASE_REPO_DIVERGENCE_ALERT_AGE_DAYS: "0.5" })).toBe(
      Math.round(0.5 * DAY),
    );
  });

  it("falls back to the default for non-positive or non-numeric values", () => {
    const fallback = DEFAULT_BASE_REPO_DIVERGENCE_ALERT_AGE_DAYS * DAY;
    expect(resolveDivergenceAlertThresholdMs({ PAPERCLIP_BASE_REPO_DIVERGENCE_ALERT_AGE_DAYS: "0" })).toBe(fallback);
    expect(resolveDivergenceAlertThresholdMs({ PAPERCLIP_BASE_REPO_DIVERGENCE_ALERT_AGE_DAYS: "-4" })).toBe(fallback);
    expect(resolveDivergenceAlertThresholdMs({ PAPERCLIP_BASE_REPO_DIVERGENCE_ALERT_AGE_DAYS: "abc" })).toBe(fallback);
  });
});

describe("resolveDivergenceAgeAlert", () => {
  it("is due at exactly the threshold", () => {
    expect(resolveDivergenceAgeAlert({ firstObservedAtMs: 0, nowMs: 7 * DAY, thresholdMs: 7 * DAY })).toEqual({
      alertDue: true,
      ageMs: 7 * DAY,
      thresholdMs: 7 * DAY,
    });
  });

  it("is not due just below the threshold", () => {
    expect(resolveDivergenceAgeAlert({ firstObservedAtMs: 0, nowMs: 7 * DAY - 1, thresholdMs: 7 * DAY }).alertDue).toBe(
      false,
    );
  });

  it("clamps a backwards clock to a zero age instead of a negative one", () => {
    const decision = resolveDivergenceAgeAlert({ firstObservedAtMs: 100, nowMs: 50, thresholdMs: 10 });
    expect(decision.ageMs).toBe(0);
    expect(decision.alertDue).toBe(false);
  });
});

describe("formatDivergenceDuration", () => {
  it("renders days and hours when at least a day old", () => {
    expect(formatDivergenceDuration(3 * DAY + 4 * 3_600_000)).toBe("3d 4h");
  });

  it("renders hours and minutes when under a day", () => {
    expect(formatDivergenceDuration(5 * 3_600_000 + 12 * 60_000)).toBe("5h 12m");
  });

  it("renders minutes for sub-hour ages and clamps non-positive values", () => {
    expect(formatDivergenceDuration(9 * 60_000)).toBe("9m");
    expect(formatDivergenceDuration(0)).toBe("0m");
    expect(formatDivergenceDuration(-5)).toBe("0m");
  });
});

describe("divergenceRecordPath", () => {
  it("lives under the gitignored .paperclip/ tree of the base-repo checkout", () => {
    expect(divergenceRecordPath("/repo")).toBe(path.join("/repo", ".paperclip", "base-repo-divergence.json"));
  });
});

describe("observeDivergedRefusal", () => {
  const base = { baseRef: "main", aheadCount: 3, behindCount: 1, aheadCommitSubjects: ["a", "b", "c"] };

  it("seeds firstObservedAtMs on the first observation and does not alert a fresh divergence", async () => {
    const repoRoot = await makeRepoRoot();
    const now = 1_700_000_000_000;
    const first = await observeDivergedRefusal(repoRoot, {
      ...base,
      repoIdentity: repoRoot,
      nowMs: now - 10 * DAY,
      thresholdMs: 7 * DAY,
    });
    expect(first.record.firstObservedAtMs).toBe(now - 10 * DAY);
    expect(first.record.lastObservedAtMs).toBe(now - 10 * DAY);
    expect(first.ageMs).toBe(0);
    expect(first.shouldEmitFirstClassSignal).toBe(false);
  });

  it("preserves the earliest start, crosses the threshold, and dedupes to a single signal per episode", async () => {
    const repoRoot = await makeRepoRoot();
    const now = 1_700_000_000_000;
    // Seed the episode start 10 days ago.
    await observeDivergedRefusal(repoRoot, { ...base, repoIdentity: repoRoot, nowMs: now - 10 * DAY, thresholdMs: 7 * DAY });

    // Re-observe now: the state has persisted 10 days, past the 7-day threshold.
    const second = await observeDivergedRefusal(repoRoot, { ...base, repoIdentity: repoRoot, nowMs: now, thresholdMs: 7 * DAY });
    expect(second.record.firstObservedAtMs).toBe(now - 10 * DAY);
    expect(second.record.lastObservedAtMs).toBe(now);
    expect(second.ageMs).toBe(10 * DAY);
    expect(second.alertDue).toBe(true);
    expect(second.shouldEmitFirstClassSignal).toBe(true);

    // A further probe of the same episode must not re-emit.
    const third = await observeDivergedRefusal(repoRoot, { ...base, repoIdentity: repoRoot, nowMs: now + DAY, thresholdMs: 7 * DAY });
    expect(third.record.firstObservedAtMs).toBe(now - 10 * DAY);
    expect(third.alertDue).toBe(true);
    expect(third.shouldEmitFirstClassSignal).toBe(false);
  });

  it("persists the record on disk and marks the alerted episode", async () => {
    const repoRoot = await makeRepoRoot();
    const now = 1_700_000_000_000;
    await observeDivergedRefusal(repoRoot, { ...base, repoIdentity: repoRoot, nowMs: now - 10 * DAY, thresholdMs: 7 * DAY });
    await observeDivergedRefusal(repoRoot, { ...base, repoIdentity: repoRoot, nowMs: now, thresholdMs: 7 * DAY });

    const onDisk = await readDivergenceRecord(repoRoot);
    expect(onDisk).not.toBeNull();
    expect(onDisk?.alertedForFirstObservedAtMs).toBe(now - 10 * DAY);
    expect(onDisk?.aheadCommitSubjects).toEqual(["a", "b", "c"]);
  });

  it("refreshes ahead/behind counts to the newest observation", async () => {
    const repoRoot = await makeRepoRoot();
    const now = 1_700_000_000_000;
    await observeDivergedRefusal(repoRoot, { ...base, repoIdentity: repoRoot, aheadCount: 1, behindCount: 2, aheadCommitSubjects: ["a"], nowMs: now - DAY, thresholdMs: 7 * DAY });
    const obs = await observeDivergedRefusal(repoRoot, { ...base, repoIdentity: repoRoot, nowMs: now, thresholdMs: 7 * DAY });
    expect(obs.record.aheadCount).toBe(3);
    expect(obs.record.behindCount).toBe(1);
    expect(obs.record.aheadCommitSubjects).toEqual(["a", "b", "c"]);
    // Episode start is preserved even though the observation is newer.
    expect(obs.record.firstObservedAtMs).toBe(now - DAY);
  });

  it("does not shrink the watched window for a future-dated existing record (clock skew)", async () => {
    const repoRoot = await makeRepoRoot();
    const now = 1_700_000_000_000;
    // A record that claims a start in the future (skewed) must not be trusted to push the
    // episode start ahead of "now".
    await observeDivergedRefusal(repoRoot, { ...base, repoIdentity: repoRoot, nowMs: now + DAY, thresholdMs: 7 * DAY });
    const obs = await observeDivergedRefusal(repoRoot, { ...base, repoIdentity: repoRoot, nowMs: now, thresholdMs: 7 * DAY });
    expect(obs.record.firstObservedAtMs).toBe(now);
    expect(obs.ageMs).toBe(0);
  });

  it("does not inherit a stale episode when the base ref changes on the same checkout path", async () => {
    const repoRoot = await makeRepoRoot();
    const now = 1_700_000_000_000;
    // An old episode started 10 days ago under base ref "main".
    await observeDivergedRefusal(repoRoot, {
      ...base,
      baseRef: "main",
      repoIdentity: repoRoot,
      nowMs: now - 10 * DAY,
      thresholdMs: 7 * DAY,
    });

    // The same checkout path now tracks a different base ref. The old start must
    // not leak in: the new episode begins now, reports zero age, does not alert,
    // and clears the stale dedup key.
    const obs = await observeDivergedRefusal(repoRoot, {
      ...base,
      baseRef: "release",
      repoIdentity: repoRoot,
      nowMs: now,
      thresholdMs: 7 * DAY,
    });
    expect(obs.record.baseRef).toBe("release");
    expect(obs.record.firstObservedAtMs).toBe(now);
    expect(obs.record.lastObservedAtMs).toBe(now);
    expect(obs.ageMs).toBe(0);
    expect(obs.alertDue).toBe(false);
    expect(obs.shouldEmitFirstClassSignal).toBe(false);
    expect(obs.record.alertedForFirstObservedAtMs).toBeNull();

    // The persisted record reflects the current episode, not the stale one.
    const onDisk = await readDivergenceRecord(repoRoot);
    expect(onDisk?.baseRef).toBe("release");
    expect(onDisk?.firstObservedAtMs).toBe(now);
  });

  it("does not inherit a stale episode when the repo identity changes", async () => {
    const repoRoot = await makeRepoRoot();
    const now = 1_700_000_000_000;
    // Simulate the checkout path being reused for a different repository.
    await observeDivergedRefusal(repoRoot, {
      ...base,
      repoIdentity: "/old/repo",
      nowMs: now - 10 * DAY,
      thresholdMs: 7 * DAY,
    });
    const obs = await observeDivergedRefusal(repoRoot, {
      ...base,
      repoIdentity: repoRoot,
      nowMs: now,
      thresholdMs: 7 * DAY,
    });
    expect(obs.record.repoIdentity).toBe(repoRoot);
    expect(obs.record.firstObservedAtMs).toBe(now);
    expect(obs.ageMs).toBe(0);
    expect(obs.alertDue).toBe(false);
    expect(obs.shouldEmitFirstClassSignal).toBe(false);
  });

  it("carries the episode forward when identity and base ref are unchanged", async () => {
    const repoRoot = await makeRepoRoot();
    const now = 1_700_000_000_000;
    await observeDivergedRefusal(repoRoot, {
      ...base,
      repoIdentity: repoRoot,
      nowMs: now - 10 * DAY,
      thresholdMs: 7 * DAY,
    });
    const obs = await observeDivergedRefusal(repoRoot, {
      ...base,
      repoIdentity: repoRoot,
      nowMs: now,
      thresholdMs: 7 * DAY,
    });
    // Same repo + ref => the episode start is preserved, not reset.
    expect(obs.record.firstObservedAtMs).toBe(now - 10 * DAY);
    expect(obs.ageMs).toBe(10 * DAY);
    expect(obs.alertDue).toBe(true);
  });

  it("emits the first-class signal exactly once when many probes race on one episode", async () => {
    const repoRoot = await makeRepoRoot();
    const now = 1_700_000_000_000;
    // Seed the episode start 10 days ago so it is already past the threshold.
    await observeDivergedRefusal(repoRoot, {
      ...base,
      repoIdentity: repoRoot,
      nowMs: now - 10 * DAY,
      thresholdMs: 7 * DAY,
    });

    // Eight concurrent provisioning passes of the same stuck episode: exactly
    // one may claim the alert; the rest must observe it already claimed.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        observeDivergedRefusal(repoRoot, {
          ...base,
          repoIdentity: repoRoot,
          nowMs: now,
          thresholdMs: 7 * DAY,
        }),
      ),
    );
    expect(results.every((r) => r.alertDue)).toBe(true);
    expect(results.filter((r) => r.shouldEmitFirstClassSignal).length).toBe(1);

    const winner = results.find((r) => r.shouldEmitFirstClassSignal)!;
    expect(winner.record.firstObservedAtMs).toBe(now - 10 * DAY);
    expect(winner.ageMs).toBe(10 * DAY);

    // A follow-up probe after the race still sees the single-claimed episode.
    const followUp = await observeDivergedRefusal(repoRoot, {
      ...base,
      repoIdentity: repoRoot,
      nowMs: now + DAY,
      thresholdMs: 7 * DAY,
    });
    expect(followUp.shouldEmitFirstClassSignal).toBe(false);
    const onDisk = await readDivergenceRecord(repoRoot);
    expect(onDisk?.alertedForFirstObservedAtMs).toBe(now - 10 * DAY);
  });
});

// SUP-15691 — the cross-process divergence-alert claim must be token-safe. An
// original holder's lock may never be taken while its recorded owner process is
// still live, and a holder's release must only unlink the lock it actually owns,
// so an old holder can never delete a successor's lock (which would reopen the
// claim window and reintroduce duplicate first-class signals). The independent
// two-process exactly-one-claim regression is retained.
const execFileAsync = promisify(execFile);
const SERVICE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../services/base-repo-divergence-alert.ts",
);

/**
 * A worker that runs in its OWN Node process (spawned under the same runtime,
 * type-stripping this `.ts` service). The action decides what it does:
 * - "observe": run a single observation and report the decision.
 * - "acquire": attempt the cross-process claim and report whether it won (and
 *   release immediately when it did, so a blocked check is left undisturbed).
 * Running in a distinct process — rather than a `Promise.all` inside this Vitest
 * process — is what proves the cross-process claim: the in-process
 * `observeChains` map cannot span two processes, so only the exclusive claim
 * lock can serialise them.
 */
const WORKER = `
import { observeDivergedRefusal, acquireDivergenceClaim, releaseDivergenceClaim } from ${JSON.stringify(SERVICE_PATH)};
const [action, outPath, repoRoot, baseRef, repoIdentity, nowMs, thresholdMs] = process.argv.slice(2);
(async () => {
  const fs = await import("node:fs/promises");
  try {
    if (action === "observe") {
      const res = await observeDivergedRefusal(repoRoot, {
        baseRef,
        repoIdentity,
        aheadCount: 3,
        behindCount: 1,
        aheadCommitSubjects: ["a", "b", "c"],
        nowMs: Number(nowMs),
        thresholdMs: Number(thresholdMs),
      });
      await fs.writeFile(outPath, JSON.stringify({
        shouldEmit: res.shouldEmitFirstClassSignal,
        alertDue: res.alertDue,
        ageMs: res.ageMs,
        firstObservedAtMs: res.record.firstObservedAtMs,
      }));
    } else if (action === "acquire") {
      const token = await acquireDivergenceClaim(repoRoot);
      const acquired = token !== null;
      if (token !== null) await releaseDivergenceClaim(repoRoot, token);
      await fs.writeFile(outPath, JSON.stringify({ acquired }));
    } else {
      await fs.writeFile(outPath, JSON.stringify({ error: "unknown action: " + action }));
    }
  } catch (err) {
    await fs.writeFile(outPath, JSON.stringify({ error: String(err) }));
  }
})();
`;

async function writeWorker(dir: string): Promise<string> {
  const script = path.join(dir, "divergence-claim-worker.ts");
  await fs.writeFile(script, WORKER);
  return script;
}

/** Spawn one independent process to run a claim action; resolve its result. */
async function runWorkerInProcess(
  dir: string,
  script: string,
  action: "observe" | "acquire",
  args: [repoRoot: string, baseRef: string, repoIdentity: string, nowMs: number, thresholdMs: number],
): Promise<Record<string, unknown>> {
  const outPath = path.join(dir, `result-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  await execFileAsync(
    process.execPath,
    [script, action, outPath, args[0], args[1], args[2], String(args[3]), String(args[4])],
    { timeout: 30_000 },
  );
  const parsed = JSON.parse(await fs.readFile(outPath, "utf8")) as Record<string, unknown>;
  if (typeof parsed.error === "string") throw new Error(`worker failed: ${parsed.error}`);
  return parsed;
}

describe("cross-process atomic claim — token-safe (SUP-15691)", () => {
  const now = 1_700_000_000_000;
  // A pid that is not in use: pids are far below this on Linux, so the owner is
  // verifiably gone (ESRCH) and its lock is recoverable.
  const DEAD_PID = 2_000_000_000;

  // Seed the durable sidecar in the exact state two concurrent provisioning
  // workers would both read: an episode already past the threshold, not alerted.
  async function seedOverThresholdEpisode(repoRoot: string): Promise<void> {
    await fs.mkdir(path.dirname(divergenceRecordPath(repoRoot)), { recursive: true });
    await fs.writeFile(
      divergenceRecordPath(repoRoot),
      JSON.stringify(
        {
          repoIdentity: repoRoot,
          baseRef: "main",
          firstObservedAtMs: now - 10 * DAY,
          lastObservedAtMs: now - 10 * DAY,
          aheadCount: 3,
          behindCount: 1,
          aheadCommitSubjects: ["a", "b", "c"],
          alertedForFirstObservedAtMs: null,
        },
        null,
        2,
      ),
    );
  }

  async function writeClaimLock(repoRoot: string, lock: DivergenceClaimLock, ageMs = 0): Promise<void> {
    const lockPath = divergenceClaimLockPath(repoRoot);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
    if (ageMs > 0) {
      const aged = new Date(Date.now() - ageMs);
      await fs.utimes(lockPath, aged, aged);
    }
  }

  it("lets exactly one of two independent Node processes claim the episode", async () => {
    const repoRoot = await makeRepoRoot();
    await seedOverThresholdEpisode(repoRoot);
    const worker = await writeWorker(repoRoot);

    // Two genuinely separate processes (not a Promise.all inside this process),
    // same repo, seeded unalerted & over the threshold. Each imports the service
    // fresh; only the one that atomically wins the cross-process claim may emit.
    const [a, b] = await Promise.all([
      runWorkerInProcess(repoRoot, worker, "observe", [repoRoot, "main", repoRoot, now, 7 * DAY]),
      runWorkerInProcess(repoRoot, worker, "observe", [repoRoot, "main", repoRoot, now, 7 * DAY]),
    ]);

    const claims = [a, b].filter((r) => r.shouldEmit === true).length;
    expect(claims).toBe(1);
    // Both genuinely saw the episode as due; only one claimed the signal.
    expect([a.alertDue, b.alertDue]).toEqual([true, true]);
    expect([a.firstObservedAtMs, b.firstObservedAtMs]).toEqual([now - 10 * DAY, now - 10 * DAY]);

    // The durable sidecar carries a single alerted episode key, not a clobber.
    const onDisk = await readDivergenceRecord(repoRoot);
    expect(onDisk?.alertedForFirstObservedAtMs).toBe(now - 10 * DAY);

    // No stray claim lock is left behind by the two processes.
    await expect(fs.access(divergenceClaimLockPath(repoRoot))).rejects.toThrow();
  }, 30_000);

  it("recovers a stale claim lock whose recorded owner process is gone", async () => {
    const repoRoot = await makeRepoRoot();
    await seedOverThresholdEpisode(repoRoot);
    const worker = await writeWorker(repoRoot);

    // A crashed owner: its recorded pid is not a live process, and its lock is old.
    expect(isDivergenceClaimOwnerLive(DEAD_PID)).toBe(false);
    await writeClaimLock(
      repoRoot,
      { ownerPid: DEAD_PID, token: `${DEAD_PID}:dead`, acquiredAtMs: now - 600_000 },
      90_000,
    );

    const res = await runWorkerInProcess(repoRoot, worker, "observe", [repoRoot, "main", repoRoot, now, 7 * DAY]);

    // The stale lock did not block: the process recovered it, claimed, and emitted.
    expect(res.shouldEmit).toBe(true);
    expect(res.firstObservedAtMs).toBe(now - 10 * DAY);
    const onDisk = await readDivergenceRecord(repoRoot);
    expect(onDisk?.alertedForFirstObservedAtMs).toBe(now - 10 * DAY);

    // The recovered lock was released, not left as a permanent blocker.
    await expect(fs.access(divergenceClaimLockPath(repoRoot))).rejects.toThrow();
  }, 30_000);

  it("never takes an aged lock while its recorded owner process is still live", async () => {
    // THE regression for the CR finding: the prior implementation recovered on
    // mtime alone, so a contender could delete an original holder's lock past the
    // stale interval even though the holder was still running.
    const repoRoot = await makeRepoRoot();
    await seedOverThresholdEpisode(repoRoot);
    const worker = await writeWorker(repoRoot);

    // The owner pid is THIS live test process; the lock is well past the stale
    // window, so an mtime-only recovery would have removed it.
    expect(isDivergenceClaimOwnerLive(process.pid)).toBe(true);
    await writeClaimLock(
      repoRoot,
      { ownerPid: process.pid, token: `${process.pid}:holder`, acquiredAtMs: now - 600_000 },
      90_000,
    );

    const res = await runWorkerInProcess(repoRoot, worker, "observe", [repoRoot, "main", repoRoot, now, 7 * DAY]);

    // The live owner kept its lock: the contender deferred instead of recovering,
    // so it neither emitted a second signal nor deleted the live lock.
    expect(res.shouldEmit).toBe(false);
    const lock = await readDivergenceClaimLock(repoRoot);
    expect(lock?.token).toBe(`${process.pid}:holder`);

    await fs.rm(divergenceClaimLockPath(repoRoot), { force: true });
  }, 30_000);

  it("defers to a live holder with a fresh lock rather than emitting a second signal", async () => {
    const repoRoot = await makeRepoRoot();
    await seedOverThresholdEpisode(repoRoot);
    const worker = await writeWorker(repoRoot);

    // A fresh (non-stale) lock with a live owner: the contender times out and defers.
    await writeClaimLock(repoRoot, { ownerPid: process.pid, token: `${process.pid}:live`, acquiredAtMs: now });

    const res = await runWorkerInProcess(repoRoot, worker, "observe", [repoRoot, "main", repoRoot, now, 7 * DAY]);
    expect(res.shouldEmit).toBe(false);
    await fs.rm(divergenceClaimLockPath(repoRoot), { force: true });
  }, 30_000);
});

describe("token-checked claim release — overlap regression (SUP-15691)", () => {
  const now = 1_700_000_000_000;

  it("does not delete a successor's lock, holds the gate until it releases, and keeps one episode key", async () => {
    const repoRoot = await makeRepoRoot();
    const lockPath = divergenceClaimLockPath(repoRoot);
    const originalToken = "original:token-A";
    const successorToken = "successor:token-B";

    // Seed the durable sidecar as the successor left it: a single alerted episode.
    await fs.mkdir(path.dirname(divergenceRecordPath(repoRoot)), { recursive: true });
    await fs.writeFile(
      divergenceRecordPath(repoRoot),
      JSON.stringify(
        {
          repoIdentity: repoRoot,
          baseRef: "main",
          firstObservedAtMs: now - 10 * DAY,
          lastObservedAtMs: now,
          aheadCount: 3,
          behindCount: 1,
          aheadCommitSubjects: ["a", "b", "c"],
          alertedForFirstObservedAtMs: now - 10 * DAY,
        },
        null,
        2,
      ),
    );
    // The successor (only able to take over once the original owner was gone) now
    // owns the path under a live pid and its own token.
    await fs.writeFile(
      lockPath,
      JSON.stringify({ ownerPid: process.pid, token: successorToken, acquiredAtMs: now }, null, 2) + "\n",
    );

    // The original holder runs its trailing release with the OLD token.
    await releaseDivergenceClaim(repoRoot, originalToken);

    // The successor's lock survives: an old holder may not delete a successor lock.
    expect((await readDivergenceClaimLock(repoRoot))?.token).toBe(successorToken);

    // A third contender cannot enter the read/decision/write critical section
    // while the successor's live lock is held.
    expect(await acquireDivergenceClaim(repoRoot)).toBeNull();
    expect((await readDivergenceClaimLock(repoRoot))?.token).toBe(successorToken);

    // Only once the successor releases with ITS token does the gate open.
    await releaseDivergenceClaim(repoRoot, successorToken);
    await expect(fs.access(lockPath)).rejects.toThrow();
    const entered = await acquireDivergenceClaim(repoRoot);
    expect(typeof entered).toBe("string");
    await releaseDivergenceClaim(repoRoot, entered);
    await expect(fs.access(lockPath)).rejects.toThrow();

    // Exactly one alerted episode key persisted through the whole overlap.
    const onDisk = await readDivergenceRecord(repoRoot);
    expect(onDisk?.alertedForFirstObservedAtMs).toBe(now - 10 * DAY);
  }, 30_000);

  it("removes the lock only when the releasing token still owns it", async () => {
    const repoRoot = await makeRepoRoot();
    const token = await acquireDivergenceClaim(repoRoot);
    expect(typeof token).toBe("string");
    expect((await readDivergenceClaimLock(repoRoot))?.token).toBe(token);

    // A foreign token cannot remove our lock.
    await releaseDivergenceClaim(repoRoot, "someone-else");
    expect(await readDivergenceClaimLock(repoRoot)).not.toBeNull();

    // Our own token can.
    await releaseDivergenceClaim(repoRoot, token);
    expect(await readDivergenceClaimLock(repoRoot)).toBeNull();
  }, 30_000);

  it("recovers a stale lock whose recorded owner is dead, then releases it", async () => {
    const repoRoot = await makeRepoRoot();
    const lockPath = divergenceClaimLockPath(repoRoot);
    const deadPid = 2_000_000_000;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({ ownerPid: deadPid, token: `${deadPid}:dead`, acquiredAtMs: now }, null, 2) + "\n",
    );
    const aged = new Date(Date.now() - 90_000);
    await fs.utimes(lockPath, aged, aged);

    const token = await acquireDivergenceClaim(repoRoot);
    expect(typeof token).toBe("string");
    expect(token).not.toBe(`${deadPid}:dead`);

    await releaseDivergenceClaim(repoRoot, token);
    await expect(fs.access(lockPath)).rejects.toThrow();
  }, 30_000);
});

describe("clearDivergenceRecord / readDivergenceRecord", () => {
  it("reads null when no record exists and removes it on clear", async () => {
    const repoRoot = await makeRepoRoot();
    expect(await readDivergenceRecord(repoRoot)).toBeNull();

    const now = 1_700_000_000_000;
    await observeDivergedRefusal(repoRoot, {
      baseRef: "main",
      repoIdentity: repoRoot,
      aheadCount: 1,
      behindCount: 1,
      aheadCommitSubjects: ["a"],
      nowMs: now,
      thresholdMs: 7 * DAY,
    });
    expect(await readDivergenceRecord(repoRoot)).not.toBeNull();

    await clearDivergenceRecord(repoRoot);
    expect(await readDivergenceRecord(repoRoot)).toBeNull();

    // Clearing a path with no record is a no-op, not an error.
    await expect(clearDivergenceRecord(repoRoot)).resolves.toBeUndefined();
  });
});

describe("buildDivergenceAlertText", () => {
  it("names the repo, base ref, counts, subjects, elapsed time, and threshold", () => {
    const now = 1_700_000_000_000;
    const alert: BaseRepoDivergenceAlert = {
      repoIdentity: "/repo",
      baseRef: "main",
      aheadCount: 3,
      behindCount: 1,
      aheadCommitSubjects: ["a", "b"],
      firstObservedAtMs: now - 10 * DAY,
      lastObservedAtMs: now,
      divergenceAgeMs: 10 * DAY,
      thresholdMs: 7 * DAY,
    };
    const text = buildDivergenceAlertText(alert);
    expect(text).toContain("ALERT (first-class)");
    expect(text).toContain("/repo");
    expect(text).toContain("main");
    expect(text).toContain("3 ahead / 1 behind");
    expect(text).toContain("a, b");
    expect(text).toContain("threshold");
    // Deliberately distinct from the routine per-realization advisory.
    expect(text).not.toMatch(/Local commits preserved/);
  });

  it("renders a placeholder for an empty subject list", () => {
    const now = 1_700_000_000_000;
    const text = buildDivergenceAlertText({
      repoIdentity: "/repo",
      baseRef: "main",
      aheadCount: 2,
      behindCount: 0,
      aheadCommitSubjects: [],
      firstObservedAtMs: now - DAY,
      lastObservedAtMs: now,
      divergenceAgeMs: DAY,
      thresholdMs: 7 * DAY,
    });
    expect(text).toContain("(no subjects)");
  });
});
