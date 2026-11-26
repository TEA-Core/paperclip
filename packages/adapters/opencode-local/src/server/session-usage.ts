/**
 * OpenCode V2 session usage accounting.
 *
 * `session.usage.updated` events and the `GET /api/session/{id}` payload carry
 * the session's cumulative tokens and cost. They are the durable record of what
 * a run spent: a `step_finish` record can be dropped from the stream entirely
 * (upstream anomalyco/opencode#53207), so stdout step sums alone can
 * under-report a turn. A resumed run must subtract the pre-run snapshot so the
 * reported usage stays per-run, which is what the adapter's
 * `usageBasis: "per_run"` result promises the server.
 */
export type OpenCodeSessionUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type OpenCodeSessionTotals = {
  usage: OpenCodeSessionUsage;
  costUsd: number | null;
};

/** How the reconciled usage was derived, recorded on the run result. */
export type OpenCodeRunUsageSource = "session_usage" | "step_finish";

export type OpenCodeRunUsageReconciliation = {
  usage: OpenCodeSessionUsage;
  costUsd: number | null;
  usageBasis: "per_run";
  source: OpenCodeRunUsageSource;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Read the raw OpenCode counter names (`tokens.input/output/reasoning`,
 * `tokens.cache.read/write`, `cost`) shared by `session.usage.updated` events
 * and the session payload. Missing optional counters count as zero; a present
 * but invalid counter makes the payload untrustworthy, so the caller keeps its
 * existing accounting instead of replacing it with a synthetic value.
 */
function sessionTotalsFromPayload(payload: Record<string, unknown>): OpenCodeSessionTotals | null {
  const tokens = asRecord(payload.tokens);
  if (!tokens) return null;
  const cache = asRecord(tokens.cache) ?? {};

  const input = asNonNegativeInteger(tokens.input);
  const output = asNonNegativeInteger(tokens.output);
  if (input === null || output === null) return null;
  const reasoning = tokens.reasoning === undefined ? 0 : asNonNegativeInteger(tokens.reasoning);
  const cached = cache.read === undefined ? 0 : asNonNegativeInteger(cache.read);
  const written = cache.write === undefined ? 0 : asNonNegativeInteger(cache.write);
  if (reasoning === null || cached === null || written === null) return null;

  // OpenCode charges cache writes as fresh input and reasoning as output; the
  // adapter's UsageSummary folds both the same way.
  const inputTokens = input + written;
  const outputTokens = output + reasoning;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) return null;

  const cost = payload.cost;
  const costUsd = cost === undefined || cost === null ? null : asNonNegativeNumber(cost);
  if (costUsd === null && cost !== undefined && cost !== null) return null;

  return {
    usage: { inputTokens, cachedInputTokens: cached, outputTokens },
    costUsd,
  };
}

/**
 * Parse the `GET /api/session/{id}` payload. Returns null when the payload
 * does not carry complete token counters, so callers keep the stdout
 * accounting instead of replacing it with a synthetic value.
 */
export function parseOpenCodeSessionTotals(raw: string): OpenCodeSessionTotals | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const root = asRecord(parsed);
  if (!root) return null;
  // `opencode api` wraps responses in `{ data: ... }`; accept the bare session
  // shape too so the parser works across CLI output changes.
  const payload =
    asRecord(root.data) ??
    asRecord(root.info) ??
    asRecord(root.session) ??
    root;
  return sessionTotalsFromPayload(payload);
}

/** Parse a `session.usage.updated` event payload into session totals. */
export function parseOpenCodeSessionUsageEvent(data: unknown): OpenCodeSessionTotals | null {
  const record = asRecord(data);
  return record ? sessionTotalsFromPayload(record) : null;
}

/**
 * Parse the normalized `session-usage` part the event mapper and the transport
 * baseline line carry (`{ usage: { inputTokens, ... }, costUsd }`).
 */
export function parseOpenCodeSessionUsagePart(part: unknown): OpenCodeSessionTotals | null {
  const record = asRecord(part);
  if (!record) return null;
  const usage = asRecord(record.usage);
  if (!usage) return null;
  const inputTokens = asNonNegativeInteger(usage.inputTokens);
  const cachedInputTokens = asNonNegativeInteger(usage.cachedInputTokens);
  const outputTokens = asNonNegativeInteger(usage.outputTokens);
  if (inputTokens === null || cachedInputTokens === null || outputTokens === null) return null;
  const cost = record.costUsd;
  const costUsd = cost === undefined || cost === null ? null : asNonNegativeNumber(cost);
  if (costUsd === null && cost !== undefined && cost !== null) return null;
  return { usage: { inputTokens, cachedInputTokens, outputTokens }, costUsd };
}

/**
 * The session payload is cumulative. Subtract the pre-run snapshot to report
 * only this attempt, clamping at zero if the session was compacted or reset.
 */
export function subtractOpenCodeSessionTotals(
  after: OpenCodeSessionTotals,
  before: OpenCodeSessionTotals | null,
): OpenCodeSessionTotals {
  if (!before) return after;
  const delta = (next: number, previous: number) => Math.max(0, next - previous);
  return {
    usage: {
      inputTokens: delta(after.usage.inputTokens, before.usage.inputTokens),
      cachedInputTokens: delta(after.usage.cachedInputTokens, before.usage.cachedInputTokens),
      outputTokens: delta(after.usage.outputTokens, before.usage.outputTokens),
    },
    costUsd:
      after.costUsd === null
        ? null
        : before.costUsd === null
          ? after.costUsd
          : Math.max(0, after.costUsd - before.costUsd),
  };
}

/**
 * Reconcile this run's usage from the serve transport's durable session state.
 *
 * The cumulative `session.usage.updated` totals minus the pre-run baseline
 * (read from `GET /api/session/{id}` before the prompt) are exactly what this
 * run spent, so the result is marked `per_run` and the server's legacy
 * session-delta heuristic steps aside. Without a session reading — an older
 * server that never emits usage events, or a resume whose baseline payload
 * lacked counters, where the cumulative total would silently include prior
 * runs — the per-step stdout sums stand in (they cover only this run's steps,
 * but a dropped `step_finish` can under-report them).
 *
 * A zero cost with nonzero tokens means the model is unpriced, not free: the
 * cost is reported as null so the ledger marks it unpriced instead of $0.00.
 */
export function reconcileOpenCodeRunUsage(input: {
  sessionUsage: OpenCodeSessionTotals | null;
  sessionUsageBaseline: OpenCodeSessionTotals | null;
  resumedSession: boolean;
  stepUsage: OpenCodeSessionUsage;
  stepCostUsd: number;
}): OpenCodeRunUsageReconciliation {
  const usableSessionUsage =
    input.sessionUsage !== null && (!input.resumedSession || input.sessionUsageBaseline !== null)
      ? input.sessionUsage
      : null;
  if (usableSessionUsage) {
    const delta = subtractOpenCodeSessionTotals(usableSessionUsage, input.sessionUsageBaseline);
    const tokens = delta.usage.inputTokens + delta.usage.cachedInputTokens + delta.usage.outputTokens;
    return {
      usage: delta.usage,
      costUsd: delta.costUsd !== null && delta.costUsd === 0 && tokens > 0 ? null : delta.costUsd,
      usageBasis: "per_run",
      source: "session_usage",
    };
  }
  return {
    usage: input.stepUsage,
    costUsd: input.stepCostUsd,
    usageBasis: "per_run",
    source: "step_finish",
  };
}
