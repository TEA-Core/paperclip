/**
 * OpenCode V2 session usage accounting.
 *
 * `session.usage.updated` events and the `GET /api/session/{id}` payload carry
 * the session's cumulative tokens and cost. They are the durable record of what
 * a run spent: a `step_finish` record can be dropped from the stream entirely
 * (upstream anomalyco/opencode#53207), so stdout step sums alone can
 * under-report a turn. Only a run that started its session reports the
 * session totals; a run that resumed a session which already had usage reports
 * its own validated step sums, so overlapping runs on one session are never
 * charged for each other's work. Either way the result is per-run, which is
 * what the adapter's `usageBasis: "per_run"` result promises the server.
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
  /**
   * True only when the totals come from a complete final record: the
   * post-turn `GET /api/session/{id}` reading, or a last
   * `session.usage.updated` event that carried every counter. A partial last
   * update or the step-sum fallback is reported, but never as complete.
   */
  complete: boolean;
  /** Why the usage is not complete, or which counters were refused. */
  issues: string[];
};

/**
 * The raw cumulative OpenCode counters, kept apart so a partial
 * `session.usage.updated` event can be merged field by field. An absent field
 * means "not reported yet", never zero.
 */
export type OpenCodeSessionCounters = {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
};

/** One usage record parsed field by field, with what it was missing. */
export type OpenCodeSessionCountersReading = {
  counters: OpenCodeSessionCounters;
  /** Every required counter was present and no present counter was invalid. */
  complete: boolean;
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
 * Read a usage payload field by field. Unlike `sessionTotalsFromPayload`, a
 * partial or partly invalid payload still yields the counters it did carry,
 * flagged incomplete, so a later partial update is merged instead of lost.
 */
export function readOpenCodeSessionCounters(payload: unknown): OpenCodeSessionCountersReading {
  const record = asRecord(payload);
  const tokens = record ? asRecord(record.tokens) : null;
  if (!record || !tokens) return { counters: {}, complete: false };
  const cache = asRecord(tokens.cache) ?? {};
  const counters: OpenCodeSessionCounters = {};
  let complete = true;
  const take = (
    key: keyof OpenCodeSessionCounters,
    value: unknown,
    required: boolean,
    read: (value: unknown) => number | null,
  ) => {
    if (value === undefined || value === null) {
      if (required) complete = false;
      return;
    }
    const parsed = read(value);
    if (parsed === null) {
      complete = false;
      return;
    }
    counters[key] = parsed;
  };
  take("input", tokens.input, true, asNonNegativeInteger);
  take("output", tokens.output, true, asNonNegativeInteger);
  take("reasoning", tokens.reasoning, false, asNonNegativeInteger);
  take("cacheRead", cache.read, false, asNonNegativeInteger);
  take("cacheWrite", cache.write, false, asNonNegativeInteger);
  take("cost", record.cost, false, asNonNegativeNumber);
  return { counters, complete };
}

/**
 * Merge cumulative counters field by field. Each counter only grows within a
 * session, so the larger value is the later one: a partial update never
 * overwrites a later value with an earlier one and never clears a field.
 */
export function mergeOpenCodeSessionCounters(
  previous: OpenCodeSessionCounters,
  next: OpenCodeSessionCounters,
): OpenCodeSessionCounters {
  const merged: OpenCodeSessionCounters = { ...previous };
  for (const key of Object.keys(next) as Array<keyof OpenCodeSessionCounters>) {
    const value = next[key];
    if (value === undefined) continue;
    const prior = merged[key];
    merged[key] = prior === undefined ? value : Math.max(prior, value);
  }
  return merged;
}

/**
 * Fold merged counters into session totals, the same way as a complete
 * payload: cache writes count as input and reasoning as output. A counter not
 * reported yet folds as zero; the caller keeps the completeness flag.
 */
export function foldOpenCodeSessionCounters(counters: OpenCodeSessionCounters): OpenCodeSessionTotals | null {
  const inputTokens = (counters.input ?? 0) + (counters.cacheWrite ?? 0);
  const outputTokens = (counters.output ?? 0) + (counters.reasoning ?? 0);
  const cachedInputTokens = counters.cacheRead ?? 0;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) return null;
  return {
    usage: { inputTokens, cachedInputTokens, outputTokens },
    costUsd: counters.cost ?? null,
  };
}

/**
 * Merge two readings of cumulative session totals field by field, keeping the
 * larger (later) value of each counter and the known cost over an unknown one.
 */
export function mergeOpenCodeSessionTotals(
  previous: OpenCodeSessionTotals | null,
  next: OpenCodeSessionTotals | null,
): OpenCodeSessionTotals | null {
  if (!previous) return next;
  if (!next) return previous;
  return {
    usage: {
      inputTokens: Math.max(previous.usage.inputTokens, next.usage.inputTokens),
      cachedInputTokens: Math.max(previous.usage.cachedInputTokens, next.usage.cachedInputTokens),
      outputTokens: Math.max(previous.usage.outputTokens, next.usage.outputTokens),
    },
    costUsd:
      previous.costUsd === null
        ? next.costUsd
        : next.costUsd === null
          ? previous.costUsd
          : Math.max(previous.costUsd, next.costUsd),
  };
}

/** Validated per-step usage for the V2 fallback, with the steps it refused. */
export type OpenCodeStepUsageReading = {
  usage: OpenCodeSessionUsage;
  costUsd: number;
  issues: string[];
};

/**
 * Read one `step_finish` part for the V2 fallback. A counter that is present
 * but not a non-negative safe integer (a cost that is not a non-negative
 * number) is refused and named in `issues`, never clamped or floored into the
 * total. Cache writes count as input, matching the session totals.
 */
export function readOpenCodeStepUsage(part: unknown, label: string): OpenCodeStepUsageReading {
  const record = asRecord(part) ?? {};
  const tokens = asRecord(record.tokens);
  const issues: string[] = [];
  const usage: OpenCodeSessionUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  if (!tokens) {
    issues.push(`${label}: no token counters`);
    return { usage, costUsd: 0, issues };
  }
  const cache = asRecord(tokens.cache) ?? {};
  const read = (name: string, value: unknown, required: boolean): number => {
    if (value === undefined || value === null) {
      if (required) issues.push(`${label}: ${name} missing`);
      return 0;
    }
    const parsed = asNonNegativeInteger(value);
    if (parsed === null) {
      issues.push(`${label}: ${name} refused (${JSON.stringify(value) ?? String(value)})`);
      return 0;
    }
    return parsed;
  };
  const input = read("tokens.input", tokens.input, true);
  const output = read("tokens.output", tokens.output, true);
  const reasoning = read("tokens.reasoning", tokens.reasoning, false);
  const cacheRead = read("tokens.cache.read", cache.read, false);
  const cacheWrite = read("tokens.cache.write", cache.write, false);
  usage.inputTokens = input + cacheWrite;
  usage.cachedInputTokens = cacheRead;
  usage.outputTokens = output + reasoning;
  let costUsd = 0;
  if (record.cost !== undefined && record.cost !== null) {
    const cost = asNonNegativeNumber(record.cost);
    if (cost === null) issues.push(`${label}: cost refused (${JSON.stringify(record.cost) ?? String(record.cost)})`);
    else costUsd = cost;
  }
  return { usage, costUsd, issues };
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
 * For a run that started its session (or resumed one with no usage yet) the
 * cumulative session totals minus the pre-run baseline (read from
 * `GET /api/session/{id}` before the prompt) are exactly what this run spent,
 * so the result is scoped `per_run` and the server's legacy session-delta
 * heuristic steps aside. The totals are `complete` only when a final record
 * backs them: the post-turn session reading, or a last `session.usage.updated`
 * event that carried every counter. When the last update was partial and no
 * final reading arrived, the merged totals may still miss a counter's latest
 * value, so each counter takes the larger of the session delta and the
 * validated step sums, and the result is flagged incomplete.
 *
 * Without a session reading — an older server that never emits usage events,
 * or a resume whose baseline payload lacked counters, where the cumulative
 * total would silently include prior runs — and for any run that resumed a
 * session which already had usage, the validated per-step sums stand in: a
 * sibling run on the same session can move the cumulative total, so only the
 * run's own steps are attributable to it. They cover only this run's steps, but a dropped `step_finish` can
 * under-report them, so they are never marked complete.
 *
 * A zero cost with nonzero tokens means the model is unpriced, not free: the
 * cost is reported as null so the ledger marks it unpriced instead of $0.00.
 */
export function reconcileOpenCodeRunUsage(input: {
  sessionUsage: OpenCodeSessionTotals | null;
  /** False when the last usage update was partial or unreadable. */
  sessionUsageComplete?: boolean;
  /** The post-turn `GET /api/session/{id}` reading, when one was taken. */
  sessionUsageFinal?: OpenCodeSessionTotals | null;
  sessionUsageBaseline: OpenCodeSessionTotals | null;
  resumedSession: boolean;
  stepUsage: OpenCodeSessionUsage;
  stepCostUsd: number;
  /** Step counters the fallback refused (see readOpenCodeStepUsage). */
  stepUsageIssues?: string[];
}): OpenCodeRunUsageReconciliation {
  const finalRecord = input.sessionUsageFinal ?? null;
  const cumulative = mergeOpenCodeSessionTotals(input.sessionUsage, finalRecord);
  const baseline = input.sessionUsageBaseline;
  const baselineHasUsage =
    baseline !== null &&
    (baseline.usage.inputTokens > 0 ||
      baseline.usage.cachedInputTokens > 0 ||
      baseline.usage.outputTokens > 0 ||
      (baseline.costUsd ?? 0) > 0);
  const startedSession = !input.resumedSession || (baseline !== null && !baselineHasUsage);
  const stepIssues = input.stepUsageIssues ?? [];
  if (cumulative && startedSession) {
    const delta = subtractOpenCodeSessionTotals(cumulative, baseline);
    const complete = finalRecord !== null || (input.sessionUsage !== null && input.sessionUsageComplete !== false);
    const issues: string[] = [];
    let usage = delta.usage;
    let costUsd = delta.costUsd;
    if (!complete) {
      issues.push("last session usage update was partial and no final session record was read");
      issues.push(...stepIssues);
      usage = {
        inputTokens: Math.max(usage.inputTokens, input.stepUsage.inputTokens),
        cachedInputTokens: Math.max(usage.cachedInputTokens, input.stepUsage.cachedInputTokens),
        outputTokens: Math.max(usage.outputTokens, input.stepUsage.outputTokens),
      };
      costUsd =
        costUsd === null
          ? input.stepCostUsd > 0 ? input.stepCostUsd : null
          : Math.max(costUsd, input.stepCostUsd);
    }
    const tokens = usage.inputTokens + usage.cachedInputTokens + usage.outputTokens;
    return {
      usage,
      costUsd: costUsd !== null && costUsd === 0 && tokens > 0 ? null : costUsd,
      usageBasis: "per_run",
      source: "session_usage",
      complete,
      issues,
    };
  }
  const reason = !cumulative
    ? "session reported no usage; step sums used"
    : baseline === null
      ? "resumed session has no pre-run usage baseline; step sums used"
      : "resumed session already had usage; this run's own step sums used";
  const stepTokens =
    input.stepUsage.inputTokens + input.stepUsage.cachedInputTokens + input.stepUsage.outputTokens;
  return {
    usage: input.stepUsage,
    costUsd: input.stepCostUsd === 0 && stepTokens > 0 ? null : input.stepCostUsd,
    usageBasis: "per_run",
    source: "step_finish",
    complete: false,
    issues: [reason, ...stepIssues],
  };
}
