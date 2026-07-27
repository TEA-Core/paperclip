import { describe, expect, it } from "vitest";
import { parseOpenCodeJsonl, isOpenCodeUnknownSessionError } from "./parse.js";

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

  it("drops auto-compaction summaries and their continue nudge", () => {
    // OpenCode auto-compacts an overflowing session by emitting the session
    // summary as an ordinary assistant text message, then a synthetic
    // `compaction_continue` part. Neither is agent output: leaking them turns a
    // ~450B issue comment into an N-KB pile of repeated "## Objective" blocks.
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { messageID: "msg_real_1", text: "Reproduced the failure locally." },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: {
          messageID: "msg_compaction_summary",
          text: "## Objective\n- Fix the harness\n\n## Work State\n### Completed\n- (none)",
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: {
          messageID: "msg_compaction_continue",
          synthetic: true,
          metadata: { compaction_continue: true },
          text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { messageID: "msg_real_2", text: "Test passes now." },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.summary).toBe("Reproduced the failure locally.\n\nTest passes now.");
    expect(parsed.summary).not.toContain("## Objective");
    expect(parsed.summary).not.toContain("Continue if you have next steps");
  });

  it("drops a multi-part compaction summary sharing one message id", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { messageID: "msg_real_1", text: "Kept." },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { messageID: "msg_summary", text: "## Objective\n- part one" },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { messageID: "msg_summary", text: "## Work State\n- part two" },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: {
          messageID: "msg_continue",
          synthetic: true,
          metadata: { compaction_continue: true },
          text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
        },
      }),
    ].join("\n");

    expect(parseOpenCodeJsonl(stdout).summary).toBe("Kept.");
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });
});

describe("parseOpenCodeJsonl paperclip tool-call counter", () => {
  function toolEvent(tool: string, callID: string, status = "completed") {
    return JSON.stringify({
      type: "tool_use",
      sessionID: "session_123",
      part: { tool, callID, state: { status } },
    });
  }

  it("counts Paperclip tool calls and ignores every other tool", () => {
    const stdout = [
      toolEvent("paperclip_paperclipGetIssue", "call_1"),
      toolEvent("bash", "call_2"),
      toolEvent("paperclip_paperclipUpdateIssue", "call_3"),
      toolEvent("bash", "call_4"),
      toolEvent("bash", "call_5"),
      JSON.stringify({ type: "text", sessionID: "session_123", part: { text: "done" } }),
    ].join("\n");

    expect(parseOpenCodeJsonl(stdout).paperclipToolCallCount).toBe(2);
  });

  it("counts a re-emitted tool part once per call id", () => {
    const stdout = [
      toolEvent("paperclip_paperclipUpdateIssue", "call_1", "pending"),
      toolEvent("paperclip_paperclipUpdateIssue", "call_1", "running"),
      toolEvent("paperclip_paperclipUpdateIssue", "call_1", "completed"),
    ].join("\n");

    expect(parseOpenCodeJsonl(stdout).paperclipToolCallCount).toBe(1);
  });

  it("reports zero for a run that only wrote prose", () => {
    const stdout = [
      toolEvent("bash", "call_1"),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "## Blocked\n\nPlease provide the plan section." },
      }),
    ].join("\n");

    expect(parseOpenCodeJsonl(stdout).paperclipToolCallCount).toBe(0);
  });

  it("counts unprefixed camelCase Paperclip tool names and `tool` part events", () => {
    const stdout = [
      JSON.stringify({
        type: "tool",
        sessionID: "session_123",
        part: { tool: "paperclipUpdateIssue", callID: "call_1", state: { status: "completed" } },
      }),
    ].join("\n");

    expect(parseOpenCodeJsonl(stdout).paperclipToolCallCount).toBe(1);
  });
});
