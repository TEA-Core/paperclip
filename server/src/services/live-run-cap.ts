/**
 * SUP-24563. Global live-run cap.
 *
 * An admission-only ceiling on how many counted heartbeat runs may be
 * `running` instance-wide. It is consulted in exactly one place:
 * `startNextQueuedRunForAgent`, before `claimQueuedRun`. A run that does not
 * fit stays `queued`; nothing here ever signals, cancels, pauses or releases a
 * run that is already running, so lowering the cap below the live count only
 * stops new starts until enough runs finish on their own.
 *
 * Effective cap:
 *
 *   setting S  = instance general setting `liveRunCap` (null = gate off)
 *   signal  R  = each fresh lower-only signal (today: the router `/api/runcap`)
 *   effective  = min(S, max(R, LIVE_RUN_CAP_SIGNAL_FLOOR)) over fresh signals
 *              = S when no signal is fresh (unreachable, stale, invalid, unset)
 *
 * A signal can only lower the cap, never above S (itself at most
 * `LIVE_RUN_CAP_CEILING`), and never below the floor, so one slow router
 * sample cannot pin the fleet at 1. `LIVE_RUN_CAP_RESERVED_SLOTS` of the
 * effective cap are usable only by human/board and review/recovery work; an
 * operator cap below 3 shrinks the reserve so general work keeps one slot.
 *
 * Phase-2 seam: a router-plugin advice value is a second lower-only signal
 * (`setLiveRunCapSignal({ source: "advice", ... })`); `computeEffectiveLiveRunCap`
 * already folds any number of signals with the same floor and staleness rules.
 *
 * State is a module singleton, like `dispatchQuiesce`: `heartbeatService(db)`
 * is constructed by many routes and services, and a per-instance counter would
 * let them each admit up to the cap. The server is one process; a second
 * process would need `pg_advisory_xact_lock` around count-and-reserve instead
 * of the in-process lock below.
 */
import type { agents } from "@paperclipai/db";
import { LIVE_RUN_CAP_CEILING } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { isExternalPullAgent } from "./agent-work-delivery.js";
import { RECOVERY_ORIGIN_KINDS } from "./recovery/origins.js";

export { LIVE_RUN_CAP_CEILING };

/** Slots of the effective cap that only human/board and review/recovery work may use. */
export const LIVE_RUN_CAP_RESERVED_SLOTS = 2;

/**
 * The lowest effective cap a lower-only signal can impose: 6 in total, which
 * leaves 4 general slots plus the 2 reserved ones (owner ruling, reading A).
 * Reading B (6 general slots) would set this to 8.
 */
export const LIVE_RUN_CAP_SIGNAL_FLOOR = 6;

/** A signal sample older than this is ignored, so the cap falls back to the setting. */
export const LIVE_RUN_CAP_SIGNAL_STALE_MS = 60_000;

export const LIVE_RUN_CAP_ROUTER_POLL_INTERVAL_MS = 15_000;
export const LIVE_RUN_CAP_ROUTER_TIMEOUT_MS = 2_000;

/** How long admission reuses a setting read; the settings PATCH route invalidates it at once. */
const LIVE_RUN_CAP_SETTING_TTL_MS = 2_000;

// ─── Which runs count ─────────────────────────────────────────────────────────

/**
 * Adapters whose session runs outside Paperclip: a doorbell command, a webhook,
 * or a remote gateway. Their runs neither count toward the cap nor wait on it.
 */
export const LIVE_RUN_CAP_EXEMPT_ADAPTER_TYPES: ReadonlySet<string> = new Set([
  "process",
  "http",
  "hermes_gateway",
  "openclaw_gateway",
]);

type LiveRunCapAgentInput = Pick<typeof agents.$inferSelect, "adapterType" | "runtimeConfig">;

/**
 * External agent sessions: an exempt adapter type, or an agent declared as an
 * external pull seat (`runtimeConfig.workDelivery = "external_pull"`).
 */
export function isLiveRunCapExemptAgent(agent: LiveRunCapAgentInput) {
  return LIVE_RUN_CAP_EXEMPT_ADAPTER_TYPES.has(agent.adapterType) || isExternalPullAgent(agent);
}

// ─── Admission order ──────────────────────────────────────────────────────────

/** Admission classes, first in line first. */
export const LIVE_RUN_CAP_CLASSES = ["human_board", "review_recovery", "general"] as const;
export type LiveRunCapClass = (typeof LIVE_RUN_CAP_CLASSES)[number];

/**
 * Review and recovery reasons, honoured only on a wake the server recorded as
 * `requested_by_actor_type = 'system'` (recovery sweeps, review dispatch and
 * other server paths). The wake routes accept any reason string from an agent
 * key, so an agent-requested (or unrecorded) wake never reaches this list.
 */
const REVIEW_RECOVERY_WAKE_REASONS: ReadonlySet<string> = new Set([
  "execution_review_requested",
  "execution_approval_requested",
  "execution_review_participant_recovery",
  "native_completion_review",
  "issue_review_path_lost",
  "source_scoped_recovery_action",
  "issue_recovery_action_restored",
  "exhausted_recovery_issue",
  "issue_monitor_recovery",
  "issue_monitor_recovery_issue",
]);
const RECOVERY_ISSUE_ORIGIN_KINDS: ReadonlySet<string> = new Set(Object.values(RECOVERY_ORIGIN_KINDS));

/**
 * The admission class of a queued run, from facts the caller of a wake
 * cannot set:
 * - `requestedByActorType` and `requestReason` come from the run's own wake
 *   request row. The server records the actor type from the authenticated
 *   actor, and a coalesced wake never rewrites that row (unlike the run's
 *   merged `contextSnapshot.wakeReason`, which is never read here).
 * - `issueStatus` and `issueOriginKind` come from the issue row; the issue
 *   API does not accept an origin kind.
 */
export function classifyLiveRunCapRun(input: {
  requestedByActorType: string | null | undefined;
  requestReason: string | null | undefined;
  issueStatus: string | null | undefined;
  issueOriginKind: string | null | undefined;
}): LiveRunCapClass {
  if (input.requestedByActorType === "user") return "human_board";
  if (
    input.issueStatus === "in_review" ||
    (input.issueOriginKind && RECOVERY_ISSUE_ORIGIN_KINDS.has(input.issueOriginKind)) ||
    (input.requestedByActorType === "system" &&
      input.requestReason &&
      REVIEW_RECOVERY_WAKE_REASONS.has(input.requestReason))
  ) {
    return "review_recovery";
  }
  return "general";
}

export function liveRunCapClassRank(runClass: LiveRunCapClass) {
  return LIVE_RUN_CAP_CLASSES.indexOf(runClass);
}

export interface LiveRunCapQueueEntry {
  runId: string;
  agentId: string;
  runClass: LiveRunCapClass;
  createdAtMs: number;
}

/** Global admission order: class, then oldest first; run id breaks exact ties. */
export function compareLiveRunCapPrecedence(left: LiveRunCapQueueEntry, right: LiveRunCapQueueEntry) {
  return (
    liveRunCapClassRank(left.runClass) - liveRunCapClassRank(right.runClass) ||
    left.createdAtMs - right.createdAtMs ||
    (left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0)
  );
}

// ─── Effective cap ────────────────────────────────────────────────────────────

/** A lower-only input to the effective cap. */
export interface LiveRunCapSignal {
  source: string;
  cap: number;
  observedAtMs: number;
}

export interface EffectiveLiveRunCap {
  /** The operator setting after the ceiling. */
  setting: number;
  /** Total counted runs that may be running. Human/board and review/recovery may use all of it. */
  effectiveCap: number;
  /** Total counted runs that may be running before general work must wait. */
  generalCap: number;
  appliedSignals: LiveRunCapSignal[];
}

export function isFreshLiveRunCapSignal(signal: LiveRunCapSignal, nowMs: number) {
  const ageMs = nowMs - signal.observedAtMs;
  return Number.isInteger(signal.cap) && signal.cap >= 0 && ageMs >= 0 && ageMs <= LIVE_RUN_CAP_SIGNAL_STALE_MS;
}

/** null when the gate is off. */
export function computeEffectiveLiveRunCap(input: {
  setting: number | null;
  signals: readonly LiveRunCapSignal[];
  nowMs: number;
}): EffectiveLiveRunCap | null {
  if (input.setting === null) return null;
  const setting = Math.min(LIVE_RUN_CAP_CEILING, Math.max(1, Math.trunc(input.setting)));
  let effectiveCap = setting;
  const appliedSignals: LiveRunCapSignal[] = [];
  for (const signal of input.signals) {
    if (!isFreshLiveRunCapSignal(signal, input.nowMs)) continue;
    effectiveCap = Math.min(effectiveCap, Math.max(LIVE_RUN_CAP_SIGNAL_FLOOR, signal.cap));
    appliedSignals.push(signal);
  }
  return {
    setting,
    effectiveCap,
    // An operator cap below 3 shrinks the reserve: general work always keeps
    // at least one slot, so a small cap slows it down but never starves it.
    generalCap: effectiveCap - Math.min(LIVE_RUN_CAP_RESERVED_SLOTS, effectiveCap - 1),
    appliedSignals,
  };
}

export type LiveRunCapAdmissionDecision =
  | { admit: true }
  | { admit: false; reason: "cap_full" | "behind_earlier_waiters" };

/**
 * `occupied` = counted running runs plus admissions still claiming.
 * `aheadCount` = cap-waiters of other agents with an earlier place in line.
 */
export function decideLiveRunCapAdmission(input: {
  cap: EffectiveLiveRunCap;
  occupied: number;
  runClass: LiveRunCapClass;
  aheadCount: number;
}): LiveRunCapAdmissionDecision {
  const limit = input.runClass === "general" ? input.cap.generalCap : input.cap.effectiveCap;
  const free = limit - input.occupied;
  if (free <= 0) return { admit: false, reason: "cap_full" };
  if (input.aheadCount >= free) return { admit: false, reason: "behind_earlier_waiters" };
  return { admit: true };
}

// ─── Signals (router poll; phase-2 advice later) ──────────────────────────────

const liveRunCapSignals = new Map<string, LiveRunCapSignal>();

export function setLiveRunCapSignal(signal: LiveRunCapSignal) {
  liveRunCapSignals.set(signal.source, signal);
}

export function clearLiveRunCapSignal(source: string) {
  liveRunCapSignals.delete(source);
}

export function listLiveRunCapSignals(): LiveRunCapSignal[] {
  return [...liveRunCapSignals.values()];
}

export const LIVE_RUN_CAP_ROUTER_SIGNAL_SOURCE = "router";

/** The router answers `{ "cap": <integer >= 0>, ... }`; anything else is a failed poll. */
export function parseRouterRunCapResponse(body: unknown): number | null {
  if (!body || typeof body !== "object" || !("cap" in body)) return null;
  const cap = body.cap;
  return typeof cap === "number" && Number.isInteger(cap) && cap >= 0 ? cap : null;
}

export interface LiveRunCapRouterPollerOptions {
  url: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
  /** Called when the router's contribution to the cap went up (a higher value, or its sample went stale). */
  onRaise?: () => void;
}

export interface LiveRunCapRouterPoller {
  /** One poll; never throws. Resolves true when a valid sample was stored. */
  pollNow: () => Promise<boolean>;
  stop: () => void;
}

let routerPollerConfigured = false;

export function isLiveRunCapRouterConfigured() {
  return routerPollerConfigured;
}

/** One router poll, never throwing. Resolves true when a valid sample was stored. */
export function createLiveRunCapRouterPoll(options: LiveRunCapRouterPollerOptions): () => Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? LIVE_RUN_CAP_ROUTER_TIMEOUT_MS;
  let failing = false;
  // What the router allows on top of the setting: its floored cap while fresh,
  // unlimited while absent or stale. A rise in this value can raise the cap.
  const contribution = () => {
    const signal = liveRunCapSignals.get(LIVE_RUN_CAP_ROUTER_SIGNAL_SOURCE);
    return signal && isFreshLiveRunCapSignal(signal, now())
      ? Math.max(LIVE_RUN_CAP_SIGNAL_FLOOR, signal.cap)
      : Number.POSITIVE_INFINITY;
  };
  let lastContribution = contribution();

  const pollNow = async () => {
    let cap: number | null = null;
    try {
      const response = await fetchImpl(options.url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      cap = response.ok ? parseRouterRunCapResponse(await response.json()) : null;
    } catch {
      cap = null;
    }
    if (cap !== null) {
      setLiveRunCapSignal({ source: LIVE_RUN_CAP_ROUTER_SIGNAL_SOURCE, cap, observedAtMs: now() });
      if (failing) logger.info({ cap }, "live-run cap router poll recovered");
      failing = false;
    } else if (!failing) {
      failing = true;
      logger.warn(
        { staleAfterMs: LIVE_RUN_CAP_SIGNAL_STALE_MS },
        "live-run cap router poll failed; keeping the last sample until it goes stale, then the cap falls back to the setting",
      );
    }
    const next = contribution();
    if (next > lastContribution) options.onRaise?.();
    lastContribution = next;
    return cap !== null;
  };

  return pollNow;
}

/** Starts the background router poll. Admission never awaits it; it reads the cached sample. */
export function startLiveRunCapRouterPoller(options: LiveRunCapRouterPollerOptions): LiveRunCapRouterPoller {
  const pollNow = createLiveRunCapRouterPoll(options);
  routerPollerConfigured = true;
  let inFlight = false;
  const tick = () => {
    if (inFlight) return;
    inFlight = true;
    void pollNow().finally(() => {
      inFlight = false;
    });
  };
  const interval = setInterval(tick, options.intervalMs ?? LIVE_RUN_CAP_ROUTER_POLL_INTERVAL_MS);
  interval.unref?.();
  tick();
  return {
    pollNow,
    stop: () => {
      clearInterval(interval);
      routerPollerConfigured = false;
      clearLiveRunCapSignal(LIVE_RUN_CAP_ROUTER_SIGNAL_SOURCE);
    },
  };
}

// ─── Setting cache ────────────────────────────────────────────────────────────

let settingCache: { value: number | null; atMs: number } | null = null;

/**
 * Reads the `liveRunCap` setting through a short cache. A read failure keeps
 * the last good value; with none, the gate stays off (today's behaviour),
 * never a cap of 0.
 */
export async function readLiveRunCapSetting(load: () => Promise<number | null>, nowMs = Date.now()) {
  if (settingCache && nowMs - settingCache.atMs < LIVE_RUN_CAP_SETTING_TTL_MS) return settingCache.value;
  try {
    const value = await load();
    settingCache = { value, atMs: nowMs };
    if (value === null) liveRunCapAdmission.clearWaiters();
    return value;
  } catch (err) {
    logger.warn({ err }, "failed to read the live-run cap setting; keeping the last value");
    return settingCache?.value ?? null;
  }
}

export function invalidateLiveRunCapSettingCache() {
  settingCache = null;
}

// ─── Admission state ──────────────────────────────────────────────────────────

const waiters = new Map<string, LiveRunCapQueueEntry>();
let admissionsInFlight = 0;
let admissionLock: Promise<void> = Promise.resolve();
const drainState: { running: Promise<void> | null; rerun: boolean } = { running: null, rerun: false };

export const liveRunCapAdmission = {
  /**
   * Serializes count-and-reserve across agents. Holders must not call
   * `claimQueuedRun` or `startNextQueuedRunForAgent` inside it.
   */
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const turn = admissionLock.then(fn);
    admissionLock = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  },
  inFlight() {
    return admissionsInFlight;
  },
  /** Takes one slot for a run about to be claimed. The release is idempotent. */
  reserve(runId: string) {
    waiters.delete(runId);
    admissionsInFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      admissionsInFlight -= 1;
    };
  },
  registerWaiter(entry: LiveRunCapQueueEntry) {
    waiters.set(entry.runId, entry);
  },
  removeWaiter(runId: string) {
    waiters.delete(runId);
  },
  /**
   * Runs one admission evaluation of an agent, under its start lock. However
   * it ends (claims, early return, throw), the agent's cap-waiters are then
   * exactly the runs this evaluation deferred, so a waiter is never staler
   * than its agent's latest evaluation and an agent that can no longer start
   * (not invokable, no per-agent slot) stops holding a place in line.
   */
  async evaluateAgent<T>(agentId: string, deferred: readonly LiveRunCapQueueEntry[], fn: () => Promise<T>) {
    try {
      return await fn();
    } finally {
      for (const [runId, entry] of waiters) {
        if (entry.agentId === agentId) waiters.delete(runId);
      }
      for (const entry of deferred) waiters.set(entry.runId, entry);
    }
  },
  clearWaiters() {
    waiters.clear();
  },
  waiterCount() {
    return waiters.size;
  },
  listWaiters(): LiveRunCapQueueEntry[] {
    return [...waiters.values()].sort(compareLiveRunCapPrecedence);
  },
  /**
   * Single-flight drain. A request while a drain runs makes it run one more
   * pass, so a slot freed mid-pass is not missed. Returns null when it only
   * flagged the running drain.
   */
  scheduleDrain(run: () => Promise<void>): Promise<void> | null {
    if (drainState.running) {
      drainState.rerun = true;
      return null;
    }
    const loop = (async () => {
      do {
        drainState.rerun = false;
        await run();
      } while (drainState.rerun);
    })().finally(() => {
      drainState.running = null;
    });
    drainState.running = loop;
    return loop;
  },
};
