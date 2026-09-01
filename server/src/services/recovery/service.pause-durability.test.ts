import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "./service.js";

const run = (errorCode: string | null) =>
  ({ errorCode } as unknown as Parameters<typeof classifyContinuationFailure>[0]);

describe("pause durability: continuation retry classification", () => {
  it("agent_paused is retryable so work resumes (Option A: Resume Continues Work)", () => {
    // Pause still emits errorCode agent_paused for observability, but it is NOT
    // non-retryable. On resume the agent becomes invokable again and this classifies
    // as default/retryable, so the continuation re-enqueues and the issue continues
    // rather than escalating to blocked. Durability is guaranteed separately by the
    // execution-start guard (Change B), not by this classification.
    const c = classifyContinuationFailure(run("agent_paused"));
    expect(c.kind).toBe("default");
    expect(c.maxAttempts).toBeGreaterThan(0);
  });

  it("agent_not_invokable (execution-start abort) is non-retryable", () => {
    expect(classifyContinuationFailure(run("agent_not_invokable")).kind).toBe("non_retryable");
  });

  it("timed_out (timeout) still retries as transient infra", () => {
    const c = classifyContinuationFailure(run("timeout"));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBeGreaterThan(0);
  });

  it("codex harness crashes retry as transient infra", () => {
    const c = classifyContinuationFailure(run("codex_harness_crash"));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBeGreaterThan(0);
  });

  it("generic cancelled (non-pause cancellation) is NOT non-retryable", () => {
    // non-pause cancellations (the internal invokability cancel and budget pause) keep errorCode "cancelled" -> default branch
    expect(classifyContinuationFailure(run("cancelled")).kind).toBe("default");
  });

  it("genuine failure with no/unknown code retries via default branch", () => {
    expect(classifyContinuationFailure(run(null)).kind).toBe("default");
    expect(classifyContinuationFailure(run("some_adapter_error")).kind).toBe("default");
  });

  // SUP-11280: the opencode growth guard kills a run for the command it chose.
  // A retry runs the same command and trips at the same place, so there is no
  // attempt count that helps -- the command has to change first.
  it("opencode_db_growth_limit is non-retryable with no attempts left", () => {
    const c = classifyContinuationFailure(run("opencode_db_growth_limit"));
    expect(c.kind).toBe("non_retryable");
    expect(c.maxAttempts).toBe(0);
  });

  // SUP-13716: once Claude OAuth credentials are unrefreshable, no retry
  // recovers -- the operator has to re-login. Both the ACP lane's own code and
  // the CLI lane's code (default-ACP agents fall back to CLI on a
  // prepare-time credential failure) must stop the retry storm.
  it("acpx_auth_required is non-retryable with no attempts left", () => {
    const c = classifyContinuationFailure(run("acpx_auth_required"));
    expect(c.kind).toBe("non_retryable");
    expect(c.maxAttempts).toBe(0);
  });

  it("claude_auth_required is non-retryable with no attempts left", () => {
    const c = classifyContinuationFailure(run("claude_auth_required"));
    expect(c.kind).toBe("non_retryable");
    expect(c.maxAttempts).toBe(0);
  });
});
