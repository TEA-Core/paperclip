import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISPATCH_QUIESCE_TTL_MS,
  MAX_DISPATCH_QUIESCE_TTL_MS,
  createDispatchQuiesceController,
  dispatchQuiesce,
  resolveDispatchQuiesceTtlMs,
} from "./dispatch-quiesce.js";

// SUP-9857. `deploy-image.sh` quiesced dispatch by pausing every agent, and
// `POST /agents/:id/pause` calls `cancelActiveForAgent`, which cancels every
// `queued`/`running`/`scheduled_retry` run and SIGTERMs its process group. The
// drain that followed therefore always measured zero in flight and reported
// success after 0s. Quiescing must gate *new* dispatch and leave running runs
// alone, so that the drain has something real to wait on.
describe("dispatch quiesce controller", () => {
  it("starts released", () => {
    const controller = createDispatchQuiesceController(() => 1_000);

    expect(controller.isQuiesced()).toBe(false);
    expect(controller.current()).toEqual({
      quiesced: false,
      reason: null,
      engagedAt: null,
      expiresAt: null,
    });
  });

  it("engages with a reason and an expiry derived from the ttl", () => {
    let clock = 1_700_000_000_000;
    const controller = createDispatchQuiesceController(() => clock);

    const engaged = controller.engage({ reason: "deploy-image.sh", ttlMs: 60_000 });

    expect(engaged).toEqual({
      quiesced: true,
      reason: "deploy-image.sh",
      engagedAt: new Date(1_700_000_000_000).toISOString(),
      expiresAt: new Date(1_700_000_060_000).toISOString(),
    });
    expect(controller.isQuiesced()).toBe(true);
    expect(controller.current()).toEqual(engaged);
  });

  // A deploy that dies between engage and release must not leave the fleet
  // silently quiesced forever -- that is the SUP-9733 stall shape with a
  // different cause.
  it("expires on its own once the ttl elapses", () => {
    let clock = 0;
    const controller = createDispatchQuiesceController(() => clock);
    controller.engage({ reason: "deploy", ttlMs: 30_000 });

    clock = 29_999;
    expect(controller.isQuiesced()).toBe(true);

    clock = 30_000;
    expect(controller.isQuiesced()).toBe(false);
    expect(controller.current()).toEqual({
      quiesced: false,
      reason: null,
      engagedAt: null,
      expiresAt: null,
    });
  });

  it("releases explicitly and reports whether anything was engaged", () => {
    let clock = 5_000;
    const controller = createDispatchQuiesceController(() => clock);
    const engaged = controller.engage({ reason: "deploy", ttlMs: 60_000 });

    expect(controller.release()).toEqual({ released: true, previous: engaged });
    expect(controller.isQuiesced()).toBe(false);
    expect(controller.release()).toEqual({
      released: false,
      previous: { quiesced: false, reason: null, engagedAt: null, expiresAt: null },
    });
  });

  it("re-engaging extends the window rather than stacking", () => {
    let clock = 0;
    const controller = createDispatchQuiesceController(() => clock);
    controller.engage({ reason: "first", ttlMs: 10_000 });

    clock = 5_000;
    const second = controller.engage({ reason: "second", ttlMs: 10_000 });

    expect(second.reason).toBe("second");
    expect(second.expiresAt).toBe(new Date(15_000).toISOString());
    // The original engagement time is what an operator needs to see; extending
    // the window must not make the quiesce look younger than it is.
    expect(second.engagedAt).toBe(new Date(0).toISOString());

    // A single release clears it, however many times it was engaged.
    expect(controller.release().released).toBe(true);
    expect(controller.isQuiesced()).toBe(false);
  });

  it("exposes a process-wide singleton", () => {
    // `heartbeatService(db)` is constructed 15 times across routes and
    // services, so the flag cannot live in one service closure.
    expect(dispatchQuiesce.isQuiesced()).toBe(false);
    dispatchQuiesce.engage({ reason: "singleton check", ttlMs: 1_000 });
    try {
      expect(dispatchQuiesce.isQuiesced()).toBe(true);
    } finally {
      dispatchQuiesce.release();
    }
    expect(dispatchQuiesce.isQuiesced()).toBe(false);
  });
});

describe("resolveDispatchQuiesceTtlMs", () => {
  it("defaults when no ttl is supplied", () => {
    expect(resolveDispatchQuiesceTtlMs(undefined)).toBe(DEFAULT_DISPATCH_QUIESCE_TTL_MS);
    expect(resolveDispatchQuiesceTtlMs(null)).toBe(DEFAULT_DISPATCH_QUIESCE_TTL_MS);
  });

  it("converts seconds to milliseconds", () => {
    expect(resolveDispatchQuiesceTtlMs(120)).toBe(120_000);
  });

  it("clamps out-of-range and nonsense values instead of trusting them", () => {
    expect(resolveDispatchQuiesceTtlMs(0)).toBe(DEFAULT_DISPATCH_QUIESCE_TTL_MS);
    expect(resolveDispatchQuiesceTtlMs(-30)).toBe(DEFAULT_DISPATCH_QUIESCE_TTL_MS);
    expect(resolveDispatchQuiesceTtlMs(Number.NaN)).toBe(DEFAULT_DISPATCH_QUIESCE_TTL_MS);
    // An unbounded ttl would let one bad deploy park the fleet indefinitely.
    expect(resolveDispatchQuiesceTtlMs(MAX_DISPATCH_QUIESCE_TTL_MS / 1000 + 3_600)).toBe(
      MAX_DISPATCH_QUIESCE_TTL_MS,
    );
  });
});
