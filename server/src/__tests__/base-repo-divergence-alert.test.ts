import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_REPO_DIVERGENCE_ALERT_AGE_DAYS,
  buildDivergenceAlertText,
  clearDivergenceRecord,
  divergenceRecordPath,
  formatDivergenceDuration,
  observeDivergedRefusal,
  readDivergenceRecord,
  resolveDivergenceAgeAlert,
  resolveDivergenceAlertThresholdMs,
  type BaseRepoDivergenceAlert,
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
