import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS } from "@paperclipai/shared";
import type { agents } from "@paperclipai/db";
import { asBoolean, asNumber, parseObject } from "../adapters/utils.js";

/**
 * The agent heartbeat policy, parsed from `agents.runtime_config.heartbeat`.
 *
 * This lives outside `heartbeat.ts` because callers on both sides of the
 * heartbeat/recovery import edge need it: `enqueueWakeup` applies the policy as
 * a gate, and the recovery sweeps must consult the same policy before they
 * nominate an agent for a wake (SUP-9858). Parsing is pure — an agent row in,
 * a policy out — so there is no cycle and no service to construct.
 */

const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MIN = 1;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 50;

export function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT));
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(HEARTBEAT_MAX_CONCURRENT_RUNS_MIN, Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed));
}

function normalizeOptionalNonNegativeInteger(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = Math.floor(asNumber(value, 0));
  return normalized >= 0 ? normalized : null;
}

export type HeartbeatPolicy = ReturnType<typeof parseHeartbeatPolicy>;

export function parseHeartbeatPolicy(agent: Pick<typeof agents.$inferSelect, "runtimeConfig">) {
  const runtimeConfig = parseObject(agent.runtimeConfig);
  const heartbeat = parseObject(runtimeConfig.heartbeat);

  return {
    enabled: asBoolean(heartbeat.enabled, false),
    intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
    wakeOnDemand: asBoolean(heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation, true),
    maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
    skipTimerWhenNoActionableWork: asBoolean(
      heartbeat.skipTimerWhenNoActionableWork ??
        heartbeat.requireActionableTimerWork ??
        heartbeat.issueOnlyTimer,
      false,
    ),
    maxDailyRuns: normalizeOptionalNonNegativeInteger(
      heartbeat.maxDailyRuns ?? heartbeat.dailyRunLimit ?? heartbeat.dailyRunCap ?? heartbeat.maxRunsPerDay,
    ),
    maxDailyCostCents: normalizeOptionalNonNegativeInteger(
      heartbeat.maxDailyCostCents ??
        heartbeat.dailyCostCentsLimit ??
        heartbeat.dailySpendCentsLimit ??
        heartbeat.dailyBudgetCents,
    ),
  };
}

/**
 * Upstream's narrower entry point, kept so its callers in `heartbeat.ts` and
 * `recovery/service.ts` keep resolving. It is the same value `parseHeartbeatPolicy`
 * already computes — the fallback chain below is identical — so the two APIs cannot
 * disagree about whether an agent may be woken on demand.
 */
export function isHeartbeatWakeOnDemandEnabled(agent: Pick<typeof agents.$inferSelect, "runtimeConfig">) {
  return parseHeartbeatPolicy(agent).wakeOnDemand;
}
