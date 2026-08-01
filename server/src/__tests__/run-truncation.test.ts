import { describe, it, expect } from "vitest";
import {
  classifyRunTruncation,
  missingExitCodeVerdict,
  resolveAdapterRunOutcome,
  MISSING_EXIT_CODE_ERROR_CODE,
  OUTPUT_CAP_REACHED_ERROR_CODE,
  TRUNCATED_MID_STEP_ERROR_CODE,
} from "../services/run-truncation.js";

describe("classifyRunTruncation", () => {
  it("treats a truncated mid-step stream as a failure", () => {
    expect(classifyRunTruncation({ finishReason: "unknown", outputTokens: 0 })).toMatchObject({
      errorCode: TRUNCATED_MID_STEP_ERROR_CODE,
    });
  });

  it("treats an output-token cap as a failure even with non-zero output", () => {
    expect(classifyRunTruncation({ finishReason: "length", outputTokens: 4321 })).toMatchObject({
      errorCode: OUTPUT_CAP_REACHED_ERROR_CODE,
    });
  });

  it("leaves a pull-agent no-op run alone: zero tokens with no step stream is not truncation", () => {
    expect(classifyRunTruncation({ outputTokens: 0 })).toBeNull();
    expect(classifyRunTruncation({ finishReason: null, outputTokens: 0 })).toBeNull();
    expect(classifyRunTruncation({ finishReason: "  ", outputTokens: 0 })).toBeNull();
  });

  it("leaves a normal completion alone", () => {
    expect(classifyRunTruncation({ finishReason: "stop", outputTokens: 1200 })).toBeNull();
    expect(classifyRunTruncation({ finishReason: "tool_calls", outputTokens: 90 })).toBeNull();
  });

  it("does not fail an `unknown` step that still produced output", () => {
    expect(classifyRunTruncation({ finishReason: "unknown", outputTokens: 12 })).toBeNull();
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(classifyRunTruncation({ finishReason: " LENGTH ", outputTokens: 0 })).toMatchObject({
      errorCode: OUTPUT_CAP_REACHED_ERROR_CODE,
    });
  });

  it("names the missing exit code so it is distinguishable from adapter_failed", () => {
    expect(missingExitCodeVerdict().errorCode).toBe(MISSING_EXIT_CODE_ERROR_CODE);
  });
});

describe("resolveAdapterRunOutcome", () => {
  const clean = { timedOut: false, exitCode: 0, errorMessage: null };

  it("keeps a pull-agent no-op wake successful", () => {
    // exec-Cowork and coder-Claude-code run `/bin/echo`: exit 0, zero tokens, no step stream.
    expect(resolveAdapterRunOutcome({ ...clean, outputTokens: 0 })).toEqual({
      outcome: "succeeded",
      verdict: null,
    });
  });

  it("keeps a normal completion successful", () => {
    expect(resolveAdapterRunOutcome({ ...clean, finishReason: "stop", outputTokens: 8000 })).toEqual({
      outcome: "succeeded",
      verdict: null,
    });
  });

  it("fails a run truncated mid-step despite the clean exit", () => {
    const resolved = resolveAdapterRunOutcome({ ...clean, finishReason: "unknown", outputTokens: 0 });
    expect(resolved.outcome).toBe("failed");
    expect(resolved.verdict?.errorCode).toBe(TRUNCATED_MID_STEP_ERROR_CODE);
  });

  it("fails a run that hit the output cap, including with non-zero output", () => {
    const resolved = resolveAdapterRunOutcome({ ...clean, finishReason: "length", outputTokens: 32000 });
    expect(resolved.outcome).toBe("failed");
    expect(resolved.verdict?.errorCode).toBe(OUTPUT_CAP_REACHED_ERROR_CODE);
  });

  it("fails closed when the adapter reports no exit code", () => {
    for (const exitCode of [null, undefined]) {
      const resolved = resolveAdapterRunOutcome({ timedOut: false, exitCode, outputTokens: 100 });
      expect(resolved.outcome).toBe("failed");
      expect(resolved.verdict?.errorCode).toBe(MISSING_EXIT_CODE_ERROR_CODE);
    }
  });

  it("still reports timeouts and reported errors first", () => {
    expect(resolveAdapterRunOutcome({ timedOut: true, exitCode: null }).outcome).toBe("timed_out");
    expect(resolveAdapterRunOutcome({ ...clean, exitCode: 1 }).outcome).toBe("failed");
    // An adapter-reported error keeps its own errorCode rather than a truncation code.
    expect(resolveAdapterRunOutcome({ ...clean, errorMessage: "boom" })).toEqual({
      outcome: "failed",
      verdict: null,
    });
  });
});

describe("resolveAdapterRunOutcome with an adapter that already synthesized a failure", () => {
  it("keeps the specific truncation code when the adapter also reported the stream as an error", () => {
    // opencode-local turns a truncated stream into exit 1 + a descriptive message. Without the
    // finish reason being read first, that would flatten to a generic `adapter_failed`.
    const resolved = resolveAdapterRunOutcome({
      timedOut: false,
      exitCode: 1,
      errorMessage: 'OpenCode\'s stream ended without a terminal step (step_finish reason="unknown")',
      finishReason: "unknown",
      outputTokens: 0,
    });
    expect(resolved.outcome).toBe("failed");
    expect(resolved.verdict?.errorCode).toBe(TRUNCATED_MID_STEP_ERROR_CODE);
  });

  it("leaves an ordinary adapter failure without a truncation code", () => {
    const resolved = resolveAdapterRunOutcome({
      timedOut: false,
      exitCode: 1,
      errorMessage: "model unavailable",
      finishReason: "stop",
      outputTokens: 40,
    });
    expect(resolved).toEqual({ outcome: "failed", verdict: null });
  });
});
