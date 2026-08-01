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
  const messages: string[] = [];
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
      const text = asString(part.text, "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event.part);
      // Last one wins: the terminal step is the one that says how the turn ended.
      finalStepReason = asString(part.reason, "").trim().toLowerCase();
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      continue;
    }

    if (type === "tool_use") {
      const part = parseObject(event.part);
      const state = parseObject(part.state);
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
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    toolErrors,
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
