import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BASE_REPO_DIVERGENCE_ALERT_AGE_DAYS,
  buildDivergenceAlertText,
  clearDivergenceRecord,
  divergenceAlertEpisodeHash,
  divergenceAlertMarkerPath,
  divergenceRecordPath,
  formatDivergenceDuration,
  observeDivergedRefusal,
  readDivergenceRecord,
  resolveDivergenceAgeAlert,
  resolveDivergenceAlertThresholdMs,
  type BaseRepoDivergenceAlert,
} from "../services/base-repo-divergence-alert.ts";

// SUP-15615 / SUP-15700 — a project base repo that stays in the non-resettable
// `diverged` state should emit a first-class signal once it has persisted past a
// configurable age threshold, deduplicated to fire once per episode. The
// once-per-episode guarantee is an O_EXCL claim marker under `.paperclip/` (not a
// mutual-exclusion lock), and the observation state is append-only per writer —
// each process publishes its own entry and every read re-merges them (min over
// the starts, max over the ends) with the convergent sidecar. These tests cover:
// the pure age/threshold decision, the per-base-repo sidecar record, the alert
// text, the marker keying, and — behaviorally — the real multi-process claim,
// cross-process observation convergence, the no-unlink invariant, crash
// resilience, fail-open, idempotence, and the export surface.

const DAY = 24 * 60 * 60 * 1000;
const tempRoots: string[] = [];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const servicePath = fileURLToPath(new URL("../services/base-repo-divergence-alert.ts", import.meta.url));

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

/** The exact marker path(s) for the given episode(s), if on disk. */
async function listAlertMarkers(repoRoot: string): Promise<string[]> {
  const dir = path.join(repoRoot, ".paperclip");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.startsWith("base-repo-divergence-alerted-") && e.endsWith(".marker"))
    .map((e) => path.join(dir, e));
}

/**
 * Every `base-repo-divergence*` artifact name under the checkout's `.paperclip/`
 * tree (sidecar, alert markers, and observation entry directories) — the full
 * residue surface that {@link clearDivergenceRecord} must remove on reset.
 */
async function listDivergenceArtifacts(repoRoot: string): Promise<string[]> {
  const dir = path.join(repoRoot, ".paperclip");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((e) => e.startsWith("base-repo-divergence"));
}

/** Seed an over-threshold sidecar (same identity+ref) with NO marker on disk. */
async function seedOverThresholdSidecar(repoRoot: string, nowMs: number): Promise<void> {
  await fs.mkdir(path.join(repoRoot, ".paperclip"), { recursive: true });
  const record = {
    repoIdentity: repoRoot,
    baseRef: "main",
    firstObservedAtMs: nowMs - 10 * DAY,
    lastObservedAtMs: nowMs - 10 * DAY,
    aheadCount: 3,
    behindCount: 1,
    aheadCommitSubjects: ["a", "b", "c"],
    alertedForFirstObservedAtMs: null,
  };
  await fs.writeFile(divergenceRecordPath(repoRoot), JSON.stringify(record, null, 2), "utf8");
}

// --- Real multi-process probes (run under tsx in spawned node children) -------

/** T1: N children barrier on N ready-files, then each calls observeDivergedRefusal. */
const PROBE_RACE = `
import { pathToFileURL } from "node:url";
import fsSync from "node:fs";
import path from "node:path";
const [repoRoot, baseRef, nowMs, thresholdMs, N, readyDir] = process.argv.slice(2);
fsSync.writeFileSync(path.join(readyDir, "ready-" + process.pid), "1");
const deadline = Date.now() + 8000;
(async () => {
  for (;;) {
    let n = 0;
    try { n = fsSync.readdirSync(readyDir).filter((f) => f.startsWith("ready-")).length; } catch {}
    if (n >= Number(N) || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  try {
    const m = await import(pathToFileURL(process.env.SUP15700_SVC).href);
    const obs = await m.observeDivergedRefusal(repoRoot, {
      baseRef, repoIdentity: repoRoot, aheadCount: 3, behindCount: 1,
      aheadCommitSubjects: ["a"], nowMs: Number(nowMs), thresholdMs: Number(thresholdMs),
    });
    process.stdout.write(JSON.stringify({ shouldEmit: obs.shouldEmitFirstClassSignal }) + "\\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String(e) }) + "\\n");
  }
})();
`;

/** T3: child imports the service, installs a blocking seam hook, and enters
 *  observeDivergedRefusal. When it reaches the observe/claim seam (after the age
 *  has been decided, before the O_EXCL create) it reports `seam-<pid>` and blocks;
 *  the parent SIGKILLs it there, so the create never runs and no marker can exist.
 *  This is a real mid-observe crash, not a pre-observe sleep. */
const PROBE_KILL = `
import { pathToFileURL } from "node:url";
import fsSync from "node:fs";
import path from "node:path";
const [repoRoot, baseRef, nowMs, thresholdMs, readyDir] = process.argv.slice(2);
(async () => {
  const m = await import(pathToFileURL(process.env.SUP15700_SVC).href);
  // Deterministic mid-observe pause: report the seam, then block until a "go"
  // marker appears (the parent never writes one; it SIGKILLs us instead).
  m._installDivergenceObserveSeam(async () => {
    fsSync.writeFileSync(path.join(readyDir, "seam-" + process.pid), "1");
    for (;;) {
      let go = false;
      try {
        go = fsSync.existsSync(path.join(readyDir, "go"));
      } catch {}
      if (go) break;
      await new Promise((r) => setTimeout(r, 25));
    }
  });
  const obs = await m.observeDivergedRefusal(repoRoot, {
    baseRef, repoIdentity: repoRoot, aheadCount: 3, behindCount: 1,
    aheadCommitSubjects: ["a"], nowMs: Number(nowMs), thresholdMs: Number(thresholdMs),
  });
  // Unreachable in the crash test: we are killed at the seam before this runs.
  process.stdout.write(JSON.stringify({ reached: true, shouldEmit: obs.shouldEmitFirstClassSignal }) + "\\n");
})().catch((e) => process.stdout.write(JSON.stringify({ error: String(e) }) + "\\n"));
`;

/** Resolve the tsx CLI so a child node process can load the TS service. */
async function findTsxCli(): Promise<string> {
  const pnpm = path.join(repoRoot, "node_modules", ".pnpm");
  const entries = await fs.readdir(pnpm);
  const tsxDir = entries.find((e) => e.startsWith("tsx@"));
  if (!tsxDir) throw new Error(`tsx not found under ${pnpm}`);
  return path.join(pnpm, tsxDir, "node_modules", "tsx", "dist", "cli.mjs");
}

// Detached so each probe is its own process-group leader: tsx re-execs into a
// grandchild that inherits our stdio pipes, so killing only the direct child
// orphans the grandchild and leaves the pipes open (close never fires). Group
// kill (`process.kill(-pid)`) takes the whole tree down.
function spawnProbe(probeFile: string, args: string[], tsxCli: string): ChildProcess {
  return spawn(process.execPath, [tsxCli, probeFile, ...args], {
    env: { ...process.env, SUP15700_SVC: servicePath },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

/** SIGKILL the probe's whole process group (direct child + tsx grandchild). */
function killProbeGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function runToCompletion(child: ChildProcess): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    child.stdout?.on("data", (d) => {
      out += String(d);
    });
    child.on("close", (code) => resolve({ code, out }));
  });
}

async function waitForFile(dir: string, prefix: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      // directory not yet created
    }
    if (entries.some((e) => e.startsWith(prefix))) return;
    if (Date.now() >= deadline) throw new Error(`no ${prefix}* file appeared within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
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

describe("divergenceAlertEpisodeHash / divergenceAlertMarkerPath", () => {
  it("is stable for a fixed identity+ref and distinct for a different ref or identity", () => {
    const h = divergenceAlertEpisodeHash("/repo", "main");
    expect(h).toBe(divergenceAlertEpisodeHash("/repo", "main"));
    expect(h).toHaveLength(32);
    expect(divergenceAlertEpisodeHash("/repo", "release")).not.toBe(h);
    expect(divergenceAlertEpisodeHash("/other", "main")).not.toBe(h);
  });

  it("keys the marker on episode identity inside the .paperclip tree, never a timestamp", () => {
    expect(divergenceAlertMarkerPath("/repo", "/repo", "main")).toBe(
      path.join("/repo", ".paperclip", `base-repo-divergence-alerted-${divergenceAlertEpisodeHash("/repo", "main")}.marker`),
    );
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
    // No residue: a below-threshold pass creates no claim marker.
    expect(await listAlertMarkers(repoRoot)).toEqual([]);
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

    // A further probe of the same episode must not re-emit (marker already present).
    const third = await observeDivergedRefusal(repoRoot, { ...base, repoIdentity: repoRoot, nowMs: now + DAY, thresholdMs: 7 * DAY });
    expect(third.record.firstObservedAtMs).toBe(now - 10 * DAY);
    expect(third.alertDue).toBe(true);
    expect(third.shouldEmitFirstClassSignal).toBe(false);
    expect(await listAlertMarkers(repoRoot)).toHaveLength(1);
  });

  it("persists the record on disk and mirrors the claim into alertedForFirstObservedAtMs", async () => {
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
    // one may claim the alert (win the O_EXCL marker); the rest observe it claimed.
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
    expect(await listAlertMarkers(repoRoot)).toHaveLength(1);
    const onDisk = await readDivergenceRecord(repoRoot);
    expect(onDisk?.alertedForFirstObservedAtMs).toBe(now - 10 * DAY);
  });
});

describe("multi-process claim (T1)", () => {
  it("exactly one of N>=8 concurrent processes claims the alert and one marker lands on disk", async () => {
    const root = await makeRepoRoot();
    const now = 1_700_000_000_000;
    const N = 8;
    await seedOverThresholdSidecar(root, now);

    const readyDir = await fs.mkdtemp(path.join(os.tmpdir(), "sup15700-ready-"));
    tempRoots.push(readyDir);
    const tsxCli = await findTsxCli();
    const probeFile = path.join(root, "__probe-race.ts");
    await fs.writeFile(probeFile, PROBE_RACE, "utf8");

    const children = Array.from({ length: N }, () =>
      spawnProbe(probeFile, [root, "main", String(now), String(7 * DAY), String(N), readyDir], tsxCli),
    );
    const results = await Promise.all(children.map((c) => runToCompletion(c)));

    const verdicts = results.map((r) => JSON.parse(r.out.trim()) as { shouldEmit?: boolean; error?: string });
    expect(verdicts, `children: ${JSON.stringify(results)}`).toHaveLength(N);
    expect(verdicts.filter((v) => v.error), `errors: ${JSON.stringify(verdicts)}`).toEqual([]);
    expect(verdicts.filter((v) => v.shouldEmit === true).length, "exactly one winner").toBe(1);

    // Exactly one marker on disk, at the exact path for this episode.
    expect(await listAlertMarkers(root)).toEqual([divergenceAlertMarkerPath(root, root, "main")]);
  }, 90_000);
});

describe("cross-process observation convergence (T7)", () => {
  // The unseeded first-observation race: independent processes with DIFFERENT
  // observation times, no prior sidecar. This is what T1 (which seeds a shared
  // start) does not cover. With no lock, the only thing that preserves the
  // earliest start is the per-writer entry + merge-on-read.
  it("N children with distinct nowMs converge to min/max start/end and alert exactly once", async () => {
    const root = await makeRepoRoot();
    const N = 8;
    const base = 1_700_000_000_000;
    const step = 37_000;
    const nowMsList = Array.from({ length: N }, (_, i) => base + i * step);
    const minNow = nowMsList[0];
    const maxNow = nowMsList[N - 1];

    // NO seeded sidecar: the first-observation race is what this covers. Each
    // child is injected a distinct nowMs and thresholdMs: 0 (the hardest P4
    // setting; nowMs is already an input, so no fake timers are needed).
    const readyDir = await fs.mkdtemp(path.join(os.tmpdir(), "sup15700-ready-"));
    tempRoots.push(readyDir);
    const tsxCli = await findTsxCli();
    const probeFile = path.join(root, "__probe-race.ts");
    await fs.writeFile(probeFile, PROBE_RACE, "utf8");

    const children = nowMsList.map((nowMs) =>
      spawnProbe(probeFile, [root, "main", String(nowMs), "0", String(N), readyDir], tsxCli),
    );
    const results = await Promise.all(children.map((c) => runToCompletion(c)));

    const verdicts = results.map((r) => JSON.parse(r.out.trim()) as { shouldEmit?: boolean; error?: string });
    expect(verdicts, `children: ${JSON.stringify(results)}`).toHaveLength(N);
    expect(verdicts.filter((v) => v.error), `errors: ${JSON.stringify(verdicts)}`).toEqual([]);
    // The marker is keyed on h, never a timestamp, so exactly one child wins it.
    expect(verdicts.filter((v) => v.shouldEmit === true).length, "exactly one winner").toBe(1);
    expect(await listAlertMarkers(root)).toHaveLength(1);

    // Post-join, EVERY subsequent read yields exactly min/max over all
    // observations. (Deliberately NOT asserting any racing child's own returned
    // firstObservedAtMs — an observation not yet written cannot be known, and
    // that in-flight skew is fail-late and self-heals next pass.)
    const merged = await readDivergenceRecord(root);
    expect(merged?.firstObservedAtMs).toBe(minNow);
    expect(merged?.lastObservedAtMs).toBe(maxNow);

    // A follow-up observation at max(nowMs) republishes the merge; the RAW
    // sidecar now carries exactly that min/max (convergence, independent of
    // which process won).
    await observeDivergedRefusal(root, {
      baseRef: "main",
      repoIdentity: root,
      aheadCount: 3,
      behindCount: 1,
      aheadCommitSubjects: ["a"],
      nowMs: maxNow,
      thresholdMs: 0,
    });
    const rawSidecar = JSON.parse(
      await fs.readFile(divergenceRecordPath(root), "utf8"),
    ) as { firstObservedAtMs?: number; lastObservedAtMs?: number };
    expect(rawSidecar.firstObservedAtMs).toBe(minNow);
    expect(rawSidecar.lastObservedAtMs).toBe(maxNow);
  }, 90_000);
});

describe("no-unlink invariant (T2)", () => {
  it("never unlinks on the observe path, while clearDivergenceRecord is the only unlink", async () => {
    const rmSpy = vi.spyOn(fs, "rm");
    const unlinkSpy = vi.spyOn(fs, "unlink");
    try {
      const root = await makeRepoRoot();
      const now = 1_700_000_000_000;
      // Below threshold, then at/over threshold (creates the marker), then already-alerted.
      await observeDivergedRefusal(root, { baseRef: "main", repoIdentity: root, aheadCount: 1, behindCount: 1, aheadCommitSubjects: ["a"], nowMs: now, thresholdMs: 7 * DAY });
      await observeDivergedRefusal(root, { baseRef: "main", repoIdentity: root, aheadCount: 3, behindCount: 1, aheadCommitSubjects: ["a"], nowMs: now + 8 * DAY, thresholdMs: 7 * DAY });
      await observeDivergedRefusal(root, { baseRef: "main", repoIdentity: root, aheadCount: 3, behindCount: 1, aheadCommitSubjects: ["a"], nowMs: now + 9 * DAY, thresholdMs: 7 * DAY });

      const afterObserve = rmSpy.mock.calls.length;
      expect(afterObserve, "the full observe cycle must not unlink").toBe(0);
      expect(fs.unlink).not.toHaveBeenCalled();

      // Control: clearing the episode DOES unlink (proving the spy is wired to the
      // same object the service uses, so the zero above is meaningful).
      await clearDivergenceRecord(root);
      expect(rmSpy.mock.calls.length, "clearing the episode unlinks").toBeGreaterThan(0);
    } finally {
      rmSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
  });
});

describe("crash resilience (T3)", () => {
  it("a SIGKILLed mid-observe worker leaves no marker, so a subsequent observe still claims the alert", async () => {
    const root = await makeRepoRoot();
    const now = 1_700_000_000_000;
    await seedOverThresholdSidecar(root, now);

    const readyDir = await fs.mkdtemp(path.join(os.tmpdir(), "sup15700-ready-"));
    tempRoots.push(readyDir);
    const tsxCli = await findTsxCli();
    const probeFile = path.join(root, "__probe-kill.ts");
    await fs.writeFile(probeFile, PROBE_KILL, "utf8");

    const child = spawnProbe(probeFile, [root, "main", String(now), String(7 * DAY), readyDir], tsxCli);
    // The child has entered observeDivergedRefusal and reached the observe/claim
    // seam: the age is decided, but the O_EXCL create has NOT run yet.
    await waitForFile(readyDir, "seam-", 8000);
    expect(await listAlertMarkers(root), "no marker may exist while paused pre-claim").toEqual([]);

    // Kill the whole process group mid-observe (direct child + tsx grandchild).
    killProbeGroup(child);
    await new Promise<void>((resolve) => child.on("close", () => resolve()));

    // The killed worker never reached the O_EXCL create, so no marker exists.
    expect(await listAlertMarkers(root), "a killed mid-observe worker must leave no marker").toEqual([]);

    // A subsequent observation still returns a decision and claims the alert.
    const obs = await observeDivergedRefusal(root, {
      baseRef: "main",
      repoIdentity: root,
      aheadCount: 3,
      behindCount: 1,
      aheadCommitSubjects: ["a"],
      nowMs: now,
      thresholdMs: 7 * DAY,
    });
    expect(obs.alertDue).toBe(true);
    expect(obs.shouldEmitFirstClassSignal).toBe(true);
    expect(await listAlertMarkers(root)).toEqual([divergenceAlertMarkerPath(root, root, "main")]);
  }, 90_000);
});

describe("fail-open (T4)", () => {
  it("resolves and does not block when the .paperclip tree is unwritable", async () => {
    const root = await makeRepoRoot();
    const now = 1_700_000_000_000;
    await seedOverThresholdSidecar(root, now);
    const paperclipDir = path.join(root, ".paperclip");
    await fs.chmod(paperclipDir, 0o555);
    try {
      const started = Date.now();
      const obs = await observeDivergedRefusal(root, {
        baseRef: "main",
        repoIdentity: root,
        aheadCount: 3,
        behindCount: 1,
        aheadCommitSubjects: ["a"],
        nowMs: now,
        thresholdMs: 7 * DAY,
      });
      // Never threw, never blocked.
      expect(obs).toBeDefined();
      expect(obs.alertDue).toBe(true);
      // Any errno other than EEXIST fails open: a tracking failure must not
      // suppress the alert this pass.
      expect(obs.shouldEmitFirstClassSignal).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await fs.chmod(paperclipDir, 0o755);
    }
  }, 90_000);
});

describe("idempotence and no-noise (T5)", () => {
  it("below-threshold writes an entry (residue) but no marker; an alerted episode stays quiet; a new episode alerts once; clear removes every artifact", async () => {
    const root = await makeRepoRoot();
    const now = 1_700_000_000_000;

    // Below threshold -> an observation entry is written (expected residue), but
    // NO claim marker.
    const below = await observeDivergedRefusal(root, {
      baseRef: "main",
      repoIdentity: root,
      aheadCount: 1,
      behindCount: 1,
      aheadCommitSubjects: ["a"],
      nowMs: now,
      thresholdMs: 7 * DAY,
    });
    expect(below.shouldEmitFirstClassSignal).toBe(false);
    expect(await listAlertMarkers(root)).toEqual([]);
    expect((await listDivergenceArtifacts(root)).some((e) => e.startsWith("base-repo-divergence-obs-"))).toBe(true);

    // Cross the threshold -> alert once, exactly one marker.
    const at = await observeDivergedRefusal(root, {
      baseRef: "main",
      repoIdentity: root,
      aheadCount: 3,
      behindCount: 1,
      aheadCommitSubjects: ["a"],
      nowMs: now + 8 * DAY,
      thresholdMs: 7 * DAY,
    });
    expect(at.shouldEmitFirstClassSignal).toBe(true);

    // Already alerted -> false on every later pass; marker count stays one.
    const again1 = await observeDivergedRefusal(root, {
      baseRef: "main",
      repoIdentity: root,
      aheadCount: 3,
      behindCount: 1,
      aheadCommitSubjects: ["a"],
      nowMs: now + 9 * DAY,
      thresholdMs: 7 * DAY,
    });
    const again2 = await observeDivergedRefusal(root, {
      baseRef: "main",
      repoIdentity: root,
      aheadCount: 3,
      behindCount: 1,
      aheadCommitSubjects: ["a"],
      nowMs: now + 10 * DAY,
      thresholdMs: 7 * DAY,
    });
    expect(again1.shouldEmitFirstClassSignal).toBe(false);
    expect(again2.shouldEmitFirstClassSignal).toBe(false);
    expect(await listAlertMarkers(root)).toEqual([divergenceAlertMarkerPath(root, root, "main")]);

    // Identity/ref change -> a new episode (new h). It starts now (age 0), so it
    // does not alert yet, but it does not reuse the "main" marker either.
    const newEp = await observeDivergedRefusal(root, {
      baseRef: "release",
      repoIdentity: root,
      aheadCount: 2,
      behindCount: 2,
      aheadCommitSubjects: ["b"],
      nowMs: now + 12 * DAY,
      thresholdMs: 7 * DAY,
    });
    expect(newEp.shouldEmitFirstClassSignal).toBe(false);

    // Age the new episode past the threshold -> it alerts exactly once for the new h.
    const newEpOver = await observeDivergedRefusal(root, {
      baseRef: "release",
      repoIdentity: root,
      aheadCount: 2,
      behindCount: 2,
      aheadCommitSubjects: ["b"],
      nowMs: now + 19 * DAY,
      thresholdMs: 7 * DAY,
    });
    expect(newEpOver.shouldEmitFirstClassSignal).toBe(true);

    const markers = (await listAlertMarkers(root)).sort();
    expect(markers).toEqual(
      [divergenceAlertMarkerPath(root, root, "main"), divergenceAlertMarkerPath(root, root, "release")].sort(),
    );

    // After reset, NO base-repo-divergence* path remains under .paperclip/ — the
    // sidecar, both markers, and both observation entry directories.
    await clearDivergenceRecord(root);
    expect(await listDivergenceArtifacts(root)).toEqual([]);
  });
});

describe("clearDivergenceRecord / readDivergenceRecord", () => {
  it("reads null when no record exists and removes the record AND alert markers on clear", async () => {
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
    await observeDivergedRefusal(repoRoot, {
      baseRef: "main",
      repoIdentity: repoRoot,
      aheadCount: 1,
      behindCount: 1,
      aheadCommitSubjects: ["a"],
      nowMs: now + 8 * DAY,
      thresholdMs: 7 * DAY,
    });
    expect(await readDivergenceRecord(repoRoot)).not.toBeNull();
    expect(await listAlertMarkers(repoRoot)).toHaveLength(1);

    await clearDivergenceRecord(repoRoot);
    expect(await readDivergenceRecord(repoRoot)).toBeNull();
    // The marker is cleared too, so a fresh episode could alert again.
    expect(await listAlertMarkers(repoRoot)).toEqual([]);
    // So are the sidecar and the observation entry directories: no
    // base-repo-divergence* artifact remains under .paperclip/.
    expect(await listDivergenceArtifacts(repoRoot)).toEqual([]);

    // Clearing a path with no record is a no-op, not an error.
    await expect(clearDivergenceRecord(repoRoot)).resolves.toBeUndefined();
  });
});

describe("export surface (T6)", () => {
  it("exports no acquire/release claim lock", async () => {
    const mod = (await import("../services/base-repo-divergence-alert.ts")) as Record<string, unknown>;
    expect(mod.acquireDivergenceClaim).toBeUndefined();
    expect(mod.releaseDivergenceClaim).toBeUndefined();
    expect(mod.readDivergenceClaimLock).toBeUndefined();
    expect(mod.isDivergenceClaimOwnerLive).toBeUndefined();
    // The O_EXCL marker primitive (and its helpers) IS the exported surface.
    expect(typeof mod.observeDivergedRefusal).toBe("function");
    expect(typeof mod.divergenceAlertMarkerPath).toBe("function");
    expect(typeof mod.divergenceAlertEpisodeHash).toBe("function");
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
