import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createOpenCodeServeEventState,
  mapOpenCodeServeEvent,
  parseOpenCodeJsonl,
  type OpenCodeServeTurnOutcome,
} from "./parse.js";

// Streams recorded from `opencode serve` 2.2.4 (GET /api/event) against a local
// OpenAI-compatible fixture model; only session.* events are kept.
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function replay(name: string) {
  const state = createOpenCodeServeEventState();
  const lines: string[] = [];
  let outcome: OpenCodeServeTurnOutcome | null = null;
  for (const raw of fs.readFileSync(path.join(fixtureDir, `opencode-2.2.4-serve-${name}.jsonl`), "utf8").trim().split("\n")) {
    const mapped = mapOpenCodeServeEvent(JSON.parse(raw), state);
    lines.push(...mapped.lines);
    if (mapped.outcome) outcome = mapped.outcome;
  }
  return { lines, outcome, parsed: parseOpenCodeJsonl(lines.join("\n")) };
}

describe("mapOpenCodeServeEvent (recorded 2.2.4 streams)", () => {
  it("maps a text turn to the run-format result", () => {
    const { parsed, outcome } = replay("text");
    expect(outcome).toBe("succeeded");
    expect(parsed.summary).toBe("fixture response");
    expect(parsed.finalStepReason).toBe("stop");
    expect(parsed.usage).toEqual({ inputTokens: 100, cachedInputTokens: 20, outputTokens: 7 });
    expect(parsed.sessionId).toMatch(/^ses_/);
    expect(parsed.errorMessage).toBeNull();
  });

  it("sums every step of a tool turn and names the tool", () => {
    const { lines, parsed, outcome } = replay("shell");
    expect(outcome).toBe("succeeded");
    const tools = lines.map((line) => JSON.parse(line)).filter((event) => event.type === "tool_use");
    expect(tools).toHaveLength(1);
    expect(tools[0].part).toMatchObject({ tool: "shell", callID: "call_1", state: { status: "completed", input: { command: "echo hi" }, output: "hi\n" } });
    expect(parsed.usage.inputTokens).toBe(200);
    expect(parsed.finalStepReason).toBe("stop");
    expect(parsed.summary).toBe("fixture response");
  });

  it("reports an exhausted output cap as a failed turn that names output-limit", () => {
    const { lines, parsed, outcome } = replay("length");
    expect(outcome).toBe("failed");
    expect(parsed.finalStepReason).toBe("length");
    expect(parsed.errorMessage).toContain("Response still truncated after two output token limit continuations");
    const error = lines.map((line) => JSON.parse(line)).find((event) => event.type === "error");
    expect(error.error.type).toBe("output-limit");
  });

  it("reports an unroutable model as a failed turn with its message", () => {
    const { parsed, outcome } = replay("badmodel");
    expect(outcome).toBe("failed");
    expect(parsed.errorMessage).toBe("Model unavailable: fx/nope");
  });

  it("reports an interrupted turn without inventing an error", () => {
    const { parsed, outcome } = replay("cancel");
    expect(outcome).toBe("interrupted");
    expect(parsed.errorMessage).toBeNull();
  });

  it("counts a Paperclip MCP tool call once", () => {
    const state = createOpenCodeServeEventState();
    const base = { sessionID: "ses_1", assistantMessageID: "msg_1" };
    const lines = [
      { type: "session.tool.input.started", data: { ...base, id: "call_9", name: "paperclip_paperclipUpdateIssue" } },
      { type: "session.tool.called", data: { ...base, id: "call_9", input: { status: "done" } } },
      { type: "session.tool.success", data: { ...base, id: "call_9", content: [{ type: "text", text: "ok" }] } },
    ].flatMap((envelope) => mapOpenCodeServeEvent(envelope, state).lines);
    expect(parseOpenCodeJsonl(lines.join("\n")).paperclipToolCallCount).toBe(1);
  });

  it("ignores events that are not session results", () => {
    const state = createOpenCodeServeEventState();
    expect(mapOpenCodeServeEvent({ type: "mcp.status.changed", data: { server: "x" } }, state)).toEqual({ lines: [], outcome: null });
    expect(mapOpenCodeServeEvent({ type: "session.inbox.enqueued", data: { sessionID: "ses_1" } }, state)).toEqual({ lines: [], outcome: null });
  });

  it("captures the session's cumulative usage, last event winning", () => {
    // The recorded streams emit one cumulative session.usage.updated per step:
    // text=100/7/20, shell=100->200, length=100->200->300.
    expect(replay("text").parsed.sessionUsage).toEqual({
      usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 7 },
      costUsd: 0,
    });
    expect(replay("shell").parsed.sessionUsage).toEqual({
      usage: { inputTokens: 200, cachedInputTokens: 40, outputTokens: 14 },
      costUsd: 0,
    });
    expect(replay("length").parsed.sessionUsage).toEqual({
      usage: { inputTokens: 300, cachedInputTokens: 60, outputTokens: 21 },
      costUsd: 0,
    });
  });

  it("maps a session.usage.updated event onto a session_usage line", () => {
    const state = createOpenCodeServeEventState();
    const mapped = mapOpenCodeServeEvent(
      {
        type: "session.usage.updated",
        data: { sessionID: "ses_1", cost: 0.25, tokens: { input: 120, output: 9, reasoning: 2, cache: { read: 30, write: 5 } } },
      },
      state,
    );
    expect(mapped.outcome).toBeNull();
    expect(JSON.parse(mapped.lines[0])).toEqual({
      type: "session_usage",
      sessionID: "ses_1",
      part: { type: "session-usage", usage: { inputTokens: 125, cachedInputTokens: 30, outputTokens: 11 }, costUsd: 0.25, complete: true },
    });
  });

  it("marks a session.usage.updated event with unusable counters incomplete", () => {
    const state = createOpenCodeServeEventState();
    const unusable = mapOpenCodeServeEvent({ type: "session.usage.updated", data: { sessionID: "ses_1", tokens: { input: "lots" } } }, state);
    expect(unusable.outcome).toBeNull();
    expect(JSON.parse(unusable.lines[0])).toEqual({ type: "session_usage", sessionID: "ses_1", part: { type: "session-usage", complete: false } });
    const empty = mapOpenCodeServeEvent({ type: "session.usage.updated", data: { sessionID: "ses_1" } }, state);
    expect(JSON.parse(empty.lines[0]).part).toEqual({ type: "session-usage", complete: false });
    // An unreadable update means usage moved on unrecorded: never complete.
    expect(parseOpenCodeJsonl([...unusable.lines, ...empty.lines].join("\n"))).toMatchObject({ sessionUsage: null, sessionUsageComplete: false });
  });

  it("merges a partial later update field by field and does not mark it complete", () => {
    const state = createOpenCodeServeEventState();
    const lines = [
      ...mapOpenCodeServeEvent(
        { type: "session.usage.updated", data: { sessionID: "ses_1", cost: 0.01, tokens: { input: 5, output: 2, cache: { read: 1, write: 0 } } } },
        state,
      ).lines,
      // More model work, reported by a partial update that carries only output.
      ...mapOpenCodeServeEvent({ type: "session.usage.updated", data: { sessionID: "ses_1", tokens: { output: 7 } } }, state).lines,
    ];
    expect(JSON.parse(lines[1]).part).toEqual({
      type: "session-usage",
      usage: { inputTokens: 5, cachedInputTokens: 1, outputTokens: 7 },
      costUsd: 0.01,
      complete: false,
    });
    const parsed = parseOpenCodeJsonl(lines.join("\n"));
    expect(parsed.sessionUsage).toEqual({ usage: { inputTokens: 5, cachedInputTokens: 1, outputTokens: 7 }, costUsd: 0.01 });
    expect(parsed.sessionUsageComplete).toBe(false);
    // A later complete update restores completeness.
    const next = mapOpenCodeServeEvent(
      { type: "session.usage.updated", data: { sessionID: "ses_1", cost: 0.02, tokens: { input: 9, output: 7, cache: { read: 1 } } } },
      state,
    ).lines;
    expect(parseOpenCodeJsonl([...lines, ...next].join("\n"))).toMatchObject({
      sessionUsage: { usage: { inputTokens: 9, cachedInputTokens: 1, outputTokens: 7 }, costUsd: 0.02 },
      sessionUsageComplete: true,
    });
  });

  it("reads the transport's final session record", () => {
    const parsed = parseOpenCodeJsonl(
      JSON.stringify({ type: "session_usage_final", sessionID: "ses_1", part: { type: "session-usage", usage: { inputTokens: 9, cachedInputTokens: 1, outputTokens: 7 }, costUsd: 0.02 } }),
    );
    expect(parsed.sessionUsageFinal).toEqual({ usage: { inputTokens: 9, cachedInputTokens: 1, outputTokens: 7 }, costUsd: 0.02 });
    expect(parsed.sessionUsage).toBeNull();
  });

  it("validates fallback step counters and counts cache writes, leaving the V1 step sums unchanged", () => {
    const stream = [
      JSON.stringify({ type: "step_finish", part: { reason: "tool-calls", tokens: { input: 10, output: 3, cache: { read: 2, write: 4 } }, cost: 0.01 } }),
      JSON.stringify({ type: "step_finish", part: { reason: "stop", tokens: { input: -5, output: 1.5, cache: { read: 1, write: 0 } }, cost: 0.02 } }),
    ].join("\n");
    const parsed = parseOpenCodeJsonl(stream);
    // The V2 fallback refuses the negative and fractional counters and adds
    // the cache write to input.
    expect(parsed.stepUsage).toEqual({ inputTokens: 14, cachedInputTokens: 3, outputTokens: 3 });
    expect(parsed.stepCostUsd).toBeCloseTo(0.03, 10);
    expect(parsed.stepUsageIssues).toEqual([
      "step_finish #2: tokens.input refused (-5)",
      "step_finish #2: tokens.output refused (1.5)",
    ]);
    // The legacy sums the V1 CLI reports are exactly as before.
    expect(parsed.usage).toEqual({ inputTokens: 5, cachedInputTokens: 3, outputTokens: 4.5 });
  });

  it("keeps the last session_usage line and ignores malformed ones", () => {
    const stream = [
      JSON.stringify({ type: "session_usage", sessionID: "ses_1", part: { type: "session-usage", usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2 }, costUsd: 0.01 } }),
      JSON.stringify({ type: "session_usage", sessionID: "ses_1", part: { type: "session-usage", usage: { inputTokens: "no" }, costUsd: 0 } }),
      JSON.stringify({ type: "session_usage", sessionID: "ses_1", part: { type: "session-usage", usage: { inputTokens: 30, cachedInputTokens: 4, outputTokens: 6 }, costUsd: 0.02 } }),
    ].join("\n");
    const parsed = parseOpenCodeJsonl(stream);
    expect(parsed.sessionUsage).toEqual({ usage: { inputTokens: 30, cachedInputTokens: 4, outputTokens: 6 }, costUsd: 0.02 });
  });
});
