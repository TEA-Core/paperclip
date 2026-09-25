import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_AGENT_OOM_SCORE_ADJ,
  deprioritizeForOom,
  resolveAgentOomScoreAdj,
} from "./oom-priority.js";

describe("resolveAgentOomScoreAdj", () => {
  it("defaults when the env var is absent or blank", () => {
    expect(resolveAgentOomScoreAdj({})).toBe(DEFAULT_AGENT_OOM_SCORE_ADJ);
    expect(resolveAgentOomScoreAdj({ PAPERCLIP_AGENT_OOM_SCORE_ADJ: "   " })).toBe(
      DEFAULT_AGENT_OOM_SCORE_ADJ,
    );
  });

  it("honours a configured value", () => {
    expect(resolveAgentOomScoreAdj({ PAPERCLIP_AGENT_OOM_SCORE_ADJ: "750" })).toBe(750);
  });

  it("clamps to the kernel's permitted range", () => {
    expect(resolveAgentOomScoreAdj({ PAPERCLIP_AGENT_OOM_SCORE_ADJ: "9999" })).toBe(1000);
    // A negative adjustment needs CAP_SYS_RESOURCE the container does not hold;
    // clamping to 0 turns it into an explicit no-op rather than a failed write.
    expect(resolveAgentOomScoreAdj({ PAPERCLIP_AGENT_OOM_SCORE_ADJ: "-500" })).toBe(0);
  });

  it("falls back to the default on an unparseable value", () => {
    expect(resolveAgentOomScoreAdj({ PAPERCLIP_AGENT_OOM_SCORE_ADJ: "high" })).toBe(
      DEFAULT_AGENT_OOM_SCORE_ADJ,
    );
  });
});

describe("deprioritizeForOom", () => {
  it("writes the adjustment to the child's proc entry", () => {
    const write = vi.fn();
    const applied = deprioritizeForOom(4242, 500, { write, platform: "linux" });

    expect(applied).toBe(500);
    expect(write).toHaveBeenCalledWith("/proc/4242/oom_score_adj", "500");
  });

  it("is a no-op off Linux, where /proc/<pid>/oom_score_adj does not exist", () => {
    const write = vi.fn();
    expect(deprioritizeForOom(4242, 500, { write, platform: "darwin" })).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("is a no-op for a missing or nonsensical pid", () => {
    const write = vi.fn();
    expect(deprioritizeForOom(undefined, 500, { write, platform: "linux" })).toBeNull();
    expect(deprioritizeForOom(0, 500, { write, platform: "linux" })).toBeNull();
    expect(deprioritizeForOom(-1, 500, { write, platform: "linux" })).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("does not write the kernel default, which would change nothing", () => {
    const write = vi.fn();
    expect(deprioritizeForOom(4242, 0, { write, platform: "linux" })).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("clamps an out-of-range adjustment instead of letting the kernel reject it", () => {
    const write = vi.fn();
    expect(deprioritizeForOom(4242, 5000, { write, platform: "linux" })).toBe(1000);
    expect(write).toHaveBeenCalledWith("/proc/4242/oom_score_adj", "1000");
  });

  /**
   * The whole point is that this is best-effort: a run must never fail because
   * the kernel would not take the hint. The child has often already exited by
   * the time the write lands, which surfaces as ENOENT.
   */
  it("never throws when the write fails, and reports the error", () => {
    const write = vi.fn(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    });
    const onError = vi.fn();

    expect(() => deprioritizeForOom(4242, 500, { write, platform: "linux", onError })).not.toThrow();
    expect(deprioritizeForOom(4242, 500, { write, platform: "linux", onError })).toBeNull();
    expect(onError).toHaveBeenCalled();
  });
});
