import { describe, expect, it } from "vitest";
import {
  createSweepLivenessTracker,
  isSweepLivenessArmed,
  armSweepLiveness,
  sweepLivenessTracker,
} from "../services/sweep-liveness.js";

type CapturedLog = { fields: Record<string, unknown>; message: string };

function tracker(now: Date = new Date("2026-08-28T00:00:00.000Z")) {
  const calls: CapturedLog[] = [];
  const t = createSweepLivenessTracker({
    now: () => now,
    log: (fields, message) => {
      calls.push({ fields, message });
    },
  });
  return { t, calls };
}

describe("createSweepLivenessTracker", () => {
  it("emits a per-run trace even for an all-zero result (the ran-idle vs dead signal)", () => {
    const { t, calls } = tracker();

    t.record("carrierPromotion", {
      candidates: 0,
      promoted: 0,
      blocked: 0,
      failed: 0,
    });

    expect(calls).toHaveLength(1);
    // The trace carries the sweep's identity + result — the all-zero result is
    // the very thing that distinguishes "ran, found nothing" from "never fired".
    expect(calls[0].fields).toMatchObject({
      sweep: "carrierPromotion",
      lastRunAt: "2026-08-28T00:00:00.000Z",
      runs: 1,
      result: { candidates: 0, promoted: 0, blocked: 0, failed: 0 },
    });
  });

  it("emits a trace for a result that dispositioned work too", () => {
    const { t, calls } = tracker();

    t.record("carrierPromotion", {
      candidates: 3,
      promoted: 2,
      blocked: 1,
      failed: 0,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].fields.result).toEqual({
      candidates: 3,
      promoted: 2,
      blocked: 1,
      failed: 0,
    });
  });

  it("monotonic run counter and lastRunAt advance per named sweep", () => {
    const t = createSweepLivenessTracker({
      now: () => new Date("2026-08-28T00:00:30.000Z"),
      log: () => {},
    });

    t.record("carrierPromotion", { candidates: 0, promoted: 0, blocked: 0, failed: 0 });
    t.record("carrierPromotion", { candidates: 1, promoted: 1, blocked: 0, failed: 0 });
    t.record("terminalWorkspace", { archived: 0, cleanupFailed: 0 });

    const snap = t.snapshot();
    expect(snap.sweeps.carrierPromotion).toEqual({
      lastRunAt: "2026-08-28T00:00:30.000Z",
      runs: 2,
      lastResult: { candidates: 1, promoted: 1, blocked: 0, failed: 0 },
    });
    // A different sweep tracks independently; carrierPromotion's count is
    // unaffected by terminalWorkspace's run.
    expect(snap.sweeps.terminalWorkspace).toEqual({
      lastRunAt: "2026-08-28T00:00:30.000Z",
      runs: 1,
      lastResult: { archived: 0, cleanupFailed: 0 },
    });
    expect(Object.keys(snap.sweeps).sort()).toEqual(
      ["carrierPromotion", "terminalWorkspace"],
    );
  });

  it("records the schedulerStopped latch so a frozen scheduler is distinguishable from ran-idle", () => {
    const { t, calls } = tracker();
    expect(t.snapshot().schedulerStopped).toBe(false);
    expect(t.snapshot().schedulerStoppedAt).toBeNull();

    t.setSchedulerStopped(true);

    const snap = t.snapshot();
    expect(snap.schedulerStopped).toBe(true);
    expect(snap.schedulerStoppedAt).toBe("2026-08-28T00:00:00.000Z");
    // A distinct trace marks the transition.
    expect(calls.some((c) => c.fields.schedulerStopped === true)).toBe(true);
  });

  it("does not re-emit a transition trace when the latch is set to its current value", () => {
    const { t, calls } = tracker();
    t.setSchedulerStopped(true);
    const afterFirst = calls.length;
    t.setSchedulerStopped(true);
    expect(calls.length).toBe(afterFirst);
  });

  it("snapshot is a copy: mutating it does not affect the tracker", () => {
    const { t } = tracker();
    t.record("carrierPromotion", { candidates: 0, promoted: 0, blocked: 0, failed: 0 });
    const snap = t.snapshot();
    snap.sweeps.carrierPromotion.runs = 999;
    expect(t.snapshot().sweeps.carrierPromotion.runs).toBe(1);
  });
});

describe("process-wide sweep liveness registry (module singleton)", () => {
  it("exposes arm/armed gating so un-armed contexts omit the /health field", () => {
    // In a fresh module registry the tracker is not armed yet. The server
    // entry (index.ts) arms it; test apps that build healthRoutes directly
    // never do, so they keep their existing /health shape.
    // We cannot reliably assert the initial false across test files because the
    // singleton is shared per module registry, so assert the toggle contract
    // itself: armed reflects the most recent arm call.
    armSweepLiveness();
    expect(isSweepLivenessArmed()).toBe(true);
    // record + snapshot still work on the default singleton once armed.
    sweepLivenessTracker.record("healthTestSweep", { ok: true });
    expect(sweepLivenessTracker.snapshot().sweeps.healthTestSweep).toEqual({
      lastRunAt: expect.any(String),
      runs: expect.any(Number),
      lastResult: { ok: true },
    });
  });
});
