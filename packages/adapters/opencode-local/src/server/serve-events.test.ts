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
});
