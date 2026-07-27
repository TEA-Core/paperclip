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

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
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
