import { describe, expect, it } from "vitest";
import {
  parseOpenCodeJsonl,
  isOpenCodeUnknownSessionError,
  describeIncompleteOpenCodeStream,
} from "./parse.js";

describe("parseOpenCodeJsonl", () => {
  it("parses assistant text, usage, cost, and errors", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Hello from OpenCode" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: {
          reason: "done",
          cost: 0.0025,
          tokens: {
            input: 120,
            output: 40,
            reasoning: 10,
            cache: { read: 20, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "model unavailable" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Hello from OpenCode");
    expect(parsed.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0025, 6);
    expect(parsed.errorMessage).toContain("model unavailable");
    expect(parsed.toolErrors).toEqual([]);
  });

  it("keeps failed tool calls separate from fatal run errors", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          state: {
            status: "error",
            error: "File not found: e2b-adapter-result.txt",
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Recovered and completed the task" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Recovered and completed the task");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrors).toEqual(["File not found: e2b-adapter-result.txt"]);
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });
});

describe("incomplete OpenCode streams", () => {
  const streamEndingWith = (part: Record<string, unknown>) =>
    [
      JSON.stringify({ type: "step_start", sessionID: "session_trunc" }),
      JSON.stringify({ type: "step_finish", sessionID: "session_trunc", part }),
    ].join("\n");

  it("surfaces a truncated stream that exited cleanly with no error", () => {
    // The observed shape: a bare step_start, then minutes later a bare finish with no
    // closing text and no tool call. Exit code 0, no error event -> currently `succeeded`.
    const parsed = parseOpenCodeJsonl(
      streamEndingWith({ reason: "unknown", tokens: { input: 0, output: 0 } }),
    );

    expect(parsed.finalStepReason).toBe("unknown");
    expect(parsed.errorMessage).toBeNull();
    expect(describeIncompleteOpenCodeStream(parsed.finalStepReason)).toMatch(/incomplete/);
  });

  it("surfaces a run that hit the output-token cap mid-step", () => {
    const parsed = parseOpenCodeJsonl(
      streamEndingWith({ reason: "length", tokens: { input: 900, output: 8000 } }),
    );

    expect(parsed.finalStepReason).toBe("length");
    expect(describeIncompleteOpenCodeStream(parsed.finalStepReason)).toMatch(/output-token cap/);
  });

  it("leaves a healthy multi-step run alone", () => {
    const stdout = [
      JSON.stringify({ type: "step_finish", part: { reason: "tool-calls", tokens: { input: 10, output: 5 } } }),
      JSON.stringify({ type: "step_finish", part: { reason: "stop", tokens: { input: 10, output: 5 } } }),
    ].join("\n");
    const parsed = parseOpenCodeJsonl(stdout);

    expect(parsed.finalStepReason).toBe("stop");
    expect(describeIncompleteOpenCodeStream(parsed.finalStepReason)).toBeNull();
  });

  it("does not fail closed on an unrecognised terminal reason", () => {
    // "done" is emitted by real runs; an allowlist of known-bad reasons must ignore it.
    expect(describeIncompleteOpenCodeStream("done")).toBeNull();
    expect(describeIncompleteOpenCodeStream("")).toBeNull();
    expect(describeIncompleteOpenCodeStream(null)).toBeNull();
  });

  it("reports no reason when the adapter emits no step_finish at all", () => {
    const parsed = parseOpenCodeJsonl(JSON.stringify({ type: "text", part: { text: "hi" } }));

    expect(parsed.finalStepReason).toBeNull();
    expect(describeIncompleteOpenCodeStream(parsed.finalStepReason)).toBeNull();
  });
});
