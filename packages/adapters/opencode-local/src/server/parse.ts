import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

// OpenCode exposes MCP tools as "<serverName>_<toolName>", so the Paperclip MCP
// server surfaces as `paperclip_paperclipUpdateIssue` and friends. Some clients
// pass the bare camelCase tool name through instead, so accept both spellings.
const PAPERCLIP_TOOL_NAME_PATTERN = /^paperclip_|^paperclip[A-Z]/;

/**
 * Final `step_finish` reasons that mean the stream stopped early rather than finishing.
 *
 * OpenCode reports a terminal reason on the last `step_finish` event. Two values mean the
 * model never got to the end of its turn:
 *   - "length"  the output-token cap was hit mid-step
 *   - "unknown" the stream ended without a terminal step at all (truncated)
 *
 * Deliberately a narrow allowlist of KNOWN-BAD reasons rather than "anything that is not
 * a known-good reason": OpenCode emits several healthy terminal reasons in the wild
 * ("stop", "done", ...) and treating an unrecognised one as a failure would fail closed
 * on working runs.
 */
const INCOMPLETE_FINAL_STEP_REASONS: Record<string, string> = {
  length:
    'OpenCode hit the model output-token cap before finishing (step_finish reason="length"); the run is incomplete.',
  unknown:
    'OpenCode\'s stream ended without a terminal step (step_finish reason="unknown"); the run is incomplete.',
};

/**
 * Describe why a stream is incomplete, or null when the final step looks healthy.
 * `null`/empty input is treated as healthy so adapters that emit no `step_finish` are unaffected.
 */
export function describeIncompleteOpenCodeStream(finalStepReason: string | null | undefined): string | null {
  if (!finalStepReason) return null;
  return INCOMPLETE_FINAL_STEP_REASONS[finalStepReason] ?? null;
}

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  let finalStepReason: string | null = null;
  // Distinct Paperclip tool invocations. A run that made zero of these cannot
  // have recorded an issue disposition, however confident its prose sounds --
  // the successful-run handoff decision keys off this (Mode A, 2026-07-27).
  const paperclipToolCallIds = new Set<string>();
  let paperclipToolCallIndex = 0;
  // Text parts are held with their owning message id so an auto-compaction
  // summary can be retracted once the compaction is confirmed (see below).
  const messages: { messageId: string; text: string }[] = [];
  const errors: string[] = [];
  const toolErrors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const currentSessionId = asString(event.sessionID, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event.type, "");

    if (type === "text") {
      const part = parseObject(event.part);
      const metadata = parseObject(part.metadata);

      // OpenCode auto-compacts an overflowing session by emitting the session
      // summary as an ordinary assistant text message, immediately followed by
      // this synthetic "continue" part. The summary carries no marker of its
      // own, so the nudge is the only signal that the preceding message was a
      // compaction artifact rather than agent output — retract it here.
      // Without this, every compaction leaks a full "## Objective / Work State"
      // document into the issue comment body.
      if (part.synthetic === true && metadata.compaction_continue === true) {
        const summaryMessageId = messages.at(-1)?.messageId;
        if (summaryMessageId !== undefined) {
          while (messages.at(-1)?.messageId === summaryMessageId) messages.pop();
        }
        continue;
      }

      const text = asString(part.text, "").trim();
      if (text) messages.push({ messageId: asString(part.messageID, ""), text });
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event.part);
      // Last one wins: the terminal step is the one that says how the turn ended.
      finalStepReason = asString(part.reason, "").trim().toLowerCase() || null;
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      continue;
    }

    if (type === "tool_use" || type === "tool") {
      const part = parseObject(event.part);
      const state = parseObject(part.state);
      const toolName = asString(part.tool, "").trim();
      if (PAPERCLIP_TOOL_NAME_PATTERN.test(toolName)) {
        // The same tool part is re-emitted as its state advances
        // (pending -> running -> completed); key on the call id so one
        // invocation counts once.
        const callId = asString(part.callID, "").trim() || asString(part.id, "").trim();
        paperclipToolCallIds.add(callId || `__anonymous_${paperclipToolCallIndex++}`);
      }
      if (asString(state.status, "") === "error") {
        const text = asString(state.error, "").trim();
        if (text) toolErrors.push(text);
      }
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message).trim();
      if (text) errors.push(text);
      continue;
    }
  }

  return {
    sessionId,
    finalStepReason,
    summary: messages.map((m) => m.text).join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    toolErrors,
    paperclipToolCallCount: paperclipToolCallIds.size,
  };
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}

/**
 * Detect terminal provider billing/usage-limit errors in the stderr log stream.
 *
 * These are errors where the provider (OpenAI, Anthropic, Google, etc.) refuses
 * to serve the request because of a billing/quota condition that cannot be
 * resolved by retrying. Burning the full run timeout on these is wasteful, so
 * the adapter aborts early.
 *
 * Only stderr is scanned: stdout carries the agent JSONL stream (text, tool_use,
 * step_finish events) where error-shaped strings can appear as ordinary
 * content — scanning it would produce false-positive kills of healthy runs.
 *
 * Returns the matched error message (trimmed) when a terminal billing error is
 * detected, or null otherwise.
 */
export function isOpenCodeTerminalBillingError(stdout: string, stderr: string): string | null {
  void stdout;
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const patterns: RegExp[] = [
    /insufficient\s+quota/i,
    /quota\s+(?:exhausted|exceeded|reached|limit)/i,
    /usage\s+limit/i,
    /billing\s+(?:required|not\s+configured|issue|account)/i,
    /payment\s+(?:required|method|needed)/i,
    /credit\s+(?:balance|exhausted|expired|required)/i,
    /spend\s+limit/i,
    /budget\s+(?:exceeded|limit|reached)/i,
    /unpaid\s+balance/i,
    /account\s+(?:suspended|disabled|deactivated|not\s+active)/i,
    /token\s+limit\s+reached/i,
    /maximum\s+spend/i,
    /plan\s+(?:required|upgrade|exceeded)/i,
    /subscription\s+(?:required|expired|inactive)/i,
    /trial\s+(?:expired|ended|not\s+available)/i,
    /trial\s+period\s+(?:has\s+)?(?:ended|expired)/i,
    /no\s+available\s+(?:models|providers)/i,
  ];

  for (const line of lines) {
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        return line;
      }
    }
  }

  return null;
}

export function isOpenCodeTransientStatementError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return lower.includes("failed to execute statement") || lower.includes("unexpected server error");
}

/**
 * Terminal outcome of one `opencode serve` turn, from the `session.execution.*` events.
 */
export type OpenCodeServeTurnOutcome = "succeeded" | "failed" | "interrupted";

/** Per-turn state the event mapper needs to stitch a tool call back together. */
export interface OpenCodeServeEventState {
  toolNames: Map<string, string>;
  toolInputs: Map<string, unknown>;
}

export function createOpenCodeServeEventState(): OpenCodeServeEventState {
  return { toolNames: new Map(), toolInputs: new Map() };
}

function serveToolErrorText(data: Record<string, unknown>): string {
  const text = errorText(data.error ?? data.message).trim();
  return text || "Tool call failed";
}

/**
 * Map one `GET /api/event` envelope from an OpenCode V2 server (`{ type, data }`)
 * onto the JSONL lines `opencode run --format json` prints, so the one parser
 * (`parseOpenCodeJsonl`) and every consumer of the run stdout keep a single
 * contract on both transports.
 *
 * Events for other sessions and event types that carry no run result (inbox,
 * instructions, project/provider/mcp updates, deltas) map to nothing.
 */
export function mapOpenCodeServeEvent(
  envelope: unknown,
  state: OpenCodeServeEventState,
): { lines: string[]; outcome: OpenCodeServeTurnOutcome | null } {
  const event = parseObject(envelope);
  const type = asString(event.type, "");
  const data = parseObject(event.data);
  const sessionID = asString(data.sessionID, "");
  const messageID = asString(data.assistantMessageID, "");
  const line = (value: Record<string, unknown>) => JSON.stringify({ ...value, sessionID });
  const none = { lines: [] as string[], outcome: null };

  if (!type.startsWith("session.") || !sessionID) return none;

  switch (type) {
    case "session.step.started":
      return { lines: [line({ type: "step_start", part: { type: "step-start", messageID } })], outcome: null };
    case "session.text.ended": {
      const ordinal = asNumber(data.ordinal, 0);
      return {
        lines: [line({
          type: "text",
          part: { type: "text", id: `${messageID}:${ordinal}`, messageID, text: asString(data.text, "") },
        })],
        outcome: null,
      };
    }
    case "session.tool.input.started": {
      const id = asString(data.id, "");
      if (id) state.toolNames.set(id, asString(data.name, ""));
      return none;
    }
    case "session.tool.called": {
      const id = asString(data.id, "");
      if (id) state.toolInputs.set(id, data.input);
      return none;
    }
    case "session.tool.success":
    case "session.tool.failed": {
      const id = asString(data.id, "");
      const failed = type === "session.tool.failed";
      const content = Array.isArray(data.content) ? data.content : [];
      const output = content
        .map((item) => asString(parseObject(item).text, ""))
        .filter(Boolean)
        .join("\n");
      return {
        lines: [line({
          type: "tool_use",
          part: {
            type: "tool",
            tool: state.toolNames.get(id) ?? "",
            callID: id,
            messageID,
            state: failed
              ? { status: "error", input: state.toolInputs.get(id), error: serveToolErrorText(data) }
              : { status: "completed", input: state.toolInputs.get(id), output },
          },
        })],
        outcome: null,
      };
    }
    case "session.step.ended":
      return {
        lines: [line({
          type: "step_finish",
          part: {
            type: "step-finish",
            messageID,
            reason: asString(data.finish, ""),
            tokens: data.tokens,
            cost: asNumber(data.cost, 0),
          },
        })],
        outcome: null,
      };
    case "session.execution.failed":
      return {
        lines: [line({ type: "error", error: parseObject(data.error) })],
        outcome: "failed",
      };
    case "session.execution.succeeded":
      return { lines: [], outcome: "succeeded" };
    case "session.execution.interrupted":
      return { lines: [], outcome: "interrupted" };
    default:
      return none;
  }
}
