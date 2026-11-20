/**
 * SUP-24563. Global live-run cap.
 *
 * An admission-only ceiling on how many counted heartbeat runs may be
 * `running` instance-wide. Every claim of a queued run passes it: the claim
 * loop of `startNextQueuedRunForAgent` and `executeRun`'s claim of a run that
 * is still queued. A run that does not fit stays `queued`; nothing here ever
 * signals, cancels, pauses or releases a run that is already running, so
 * lowering the cap below the live count only stops new starts until enough
 * runs finish on their own.
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
 * effective cap are usable only by human/board and review/recovery work.
 * Those priority runs fill the reserve first and hold general slots only
 * beyond it (`liveRunCapFreeSlots`). A priority stream still goes first for a
 * freed general slot, but a general run that has waited
 * `LIVE_RUN_CAP_AGING_MS` is ordered with it and, being older, takes the next
 * general slot that frees. An operator cap below 3 shrinks the reserve so
 * general work keeps one slot.
 *
 * Phase-2 seam: a router-plugin advice value is a second lower-only signal
 * (`setLiveRunCapSignal({ source: "advice", ... })`); `computeEffectiveLiveRunCap`
 * already folds any number of signals with the same floor and staleness rules.
 *
 * State is a module singleton, like `dispatchQuiesce`: `heartbeatService(db)`
 * is constructed by many routes and services, and a per-instance counter would
 * let them each admit up to the cap. The cap therefore holds within ONE server
 * process, which is a hard deployment limit while the cap is on: a second
 * process sharing the database (for example both sides of a rolling deploy)
 * keeps its own count of claims in flight and can over-admit until one exits.
 * Making it multi-process needs `pg_advisory_xact_lock` around count and claim.
 */
import type { agents } from "@paperclipai/db";
import { ISSUE_EXECUTION_STAGE_TYPES, LIVE_RUN_CAP_CEILING } from "@paperclipai/shared";
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
/** The router answers a few dozen bytes; a larger body is refused unread. */
export const LIVE_RUN_CAP_ROUTER_MAX_BODY_BYTES = 4_096;

/**
 * A general run waiting at least this long is ordered with review/recovery
 * work, so a long review/recovery burst cannot hold it back for the whole
 * burst. Ordering only: it still never uses the reserved slots, and human and
 * board work still goes first (owner ruling).
 */
export const LIVE_RUN_CAP_AGING_MS = 30 * 60_000;

/**
 * The longest one count-and-reserve may hold the admission lock. A holder that
 * overruns (a hung database read) is refused and the lock passes on, so one
 * stuck admission cannot freeze every later one.
 */
export const LIVE_RUN_CAP_LOCK_TIMEOUT_MS = 10_000;

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

const RECOVERY_ISSUE_ORIGIN_KINDS: ReadonlySet<string> = new Set(Object.values(RECOVERY_ORIGIN_KINDS));
const REVIEW_STAGE_TYPES: ReadonlySet<string> = new Set(ISSUE_EXECUTION_STAGE_TYPES);

type LiveRunCapPrincipal = { type: "agent"; agentId: string } | { type: "user"; userId: string };

function readPrincipal(value: unknown): LiveRunCapPrincipal | null {
  if (!value || typeof value !== "object") return null;
  const principal = value as { type?: unknown; agentId?: unknown; userId?: unknown };
  if (principal.type === "agent" && typeof principal.agentId === "string" && principal.agentId) {
    return { type: "agent", agentId: principal.agentId };
  }
  if (principal.type === "user" && typeof principal.userId === "string" && principal.userId) {
    return { type: "user", userId: principal.userId };
  }
  return null;
}

function isAgentPrincipal(principal: LiveRunCapPrincipal | null, agentId: string) {
  return principal?.type === "agent" && principal.agentId === agentId;
}

/**
 * True when the issue's execution state has a review or approval stage
 * pending in front of this agent that someone else put there for someone
 * else's work, as the execution-policy engine recorded it:
 * - the agent is the current participant;
 * - the delivery author (the assignee when the work was delivered) is known
 *   and is not this agent;
 * - the engine's seat record names this agent, seated by a board user or by a
 *   different agent (a participant that seated itself does not count).
 * The engine is the only writer of `execution_state`: no issue or wake API
 * accepts it, a plugin issue create that carries it is refused, and a plugin
 * issue update never writes it. A state without a seat record (written before
 * the engine recorded seats) does not count.
 */
function isSeatedReviewParticipant(executionState: unknown, agentId: string) {
  if (!executionState || typeof executionState !== "object") return false;
  const state = executionState as Record<string, unknown>;
  if (state.status !== "pending") return false;
  if (typeof state.currentStageType !== "string" || !REVIEW_STAGE_TYPES.has(state.currentStageType)) return false;
  if (!isAgentPrincipal(readPrincipal(state.currentParticipant), agentId)) return false;
  const deliveryAuthor = readPrincipal(state.deliveryAuthor);
  if (!deliveryAuthor || isAgentPrincipal(deliveryAuthor, agentId)) return false;
  const seat = state.participantSeat;
  if (!seat || typeof seat !== "object") return false;
  const { participant, seatedBy } = seat as { participant?: unknown; seatedBy?: unknown };
  if (!isAgentPrincipal(readPrincipal(participant), agentId)) return false;
  const seater = readPrincipal(seatedBy);
  return seater !== null && !isAgentPrincipal(seater, agentId);
}

/**
 * The admission class of a run, only from facts the server records and no
 * caller-supplied field can set:
 * - human/board: the run's own wake request row was recorded with a `user`
 *   actor (the wake routes take the actor type from the authenticated caller)
 *   and was not relayed by a plugin (the plugin host stamps its plugin id on
 *   the wake request payload of every human action it relays).
 * - review/recovery: the run's issue row has a recovery origin kind (the issue
 *   API does not accept an origin kind; plugins are confined to `plugin:*`),
 *   or a review/approval stage is pending in front of this agent, seated by
 *   someone else on someone else's delivery (`isSeatedReviewParticipant`).
 * A wake reason is never read, whoever wrote the row (agent, board, plugin or
 * server), and neither is the issue status: a caller can create or set an
 * issue `in_review` without any review stage.
 */
export function classifyLiveRunCapRun(input: {
  agentId: string;
  requestedByActorType: string | null | undefined;
  wakePluginId: string | null | undefined;
  issueOriginKind: string | null | undefined;
  issueExecutionState: unknown;
}): LiveRunCapClass {
  if (input.requestedByActorType === "user" && !input.wakePluginId) return "human_board";
  if (
    (input.issueOriginKind && RECOVERY_ISSUE_ORIGIN_KINDS.has(input.issueOriginKind)) ||
    isSeatedReviewParticipant(input.issueExecutionState, input.agentId)
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

/**
 * The rank a waiting run is ordered by: its class, except that a general run
 * waiting at least `LIVE_RUN_CAP_AGING_MS` is ordered with review/recovery.
 */
export function liveRunCapOrderRank(entry: LiveRunCapQueueEntry, nowMs: number) {
  if (entry.runClass === "general" && nowMs - entry.createdAtMs >= LIVE_RUN_CAP_AGING_MS) {
    return liveRunCapClassRank("review_recovery");
  }
  return liveRunCapClassRank(entry.runClass);
}

/** Global admission order: rank (class with aging), then oldest first; run id breaks exact ties. */
export function compareLiveRunCapPrecedence(
  left: LiveRunCapQueueEntry,
  right: LiveRunCapQueueEntry,
  nowMs: number,
) {
  return (
    liveRunCapOrderRank(left, nowMs) - liveRunCapOrderRank(right, nowMs) ||
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

/**
 * Live runs counted toward the cap: `total` running (plus claiming), of which
 * `reservedClass` are human/board or review/recovery runs.
 */
export interface LiveRunCapOccupancy {
  total: number;
  reservedClass: number;
}

/**
 * Free slots now. Priority runs (human/board, review/recovery) fill the
 * reserve first; only priority runs beyond the reserve hold general slots.
 * So a priority stream holds general slots only while it runs beyond the
 * reserve, and a general slot that frees is open to general work again.
 */
export function liveRunCapFreeSlots(cap: EffectiveLiveRunCap, occupancy: LiveRunCapOccupancy) {
  const reserve = cap.effectiveCap - cap.generalCap;
  const any = Math.max(0, cap.effectiveCap - occupancy.total);
  const generalOccupied = occupancy.total - Math.min(occupancy.reservedClass, reserve);
  return { any, general: Math.max(0, Math.min(any, cap.generalCap - generalOccupied)) };
}

export type LiveRunCapAdmissionDecision =
  | { admit: true }
  | { admit: false; reason: "cap_full" | "behind_earlier_waiters" };

/**
 * `occupancy` = counted running runs plus admissions still claiming.
 * `aheadCount` = cap-waiters of other agents with an earlier place in line
 * that could take one of the slots this run could take.
 */
export function decideLiveRunCapAdmission(input: {
  cap: EffectiveLiveRunCap;
  occupancy: LiveRunCapOccupancy;
  runClass: LiveRunCapClass;
  aheadCount: number;
}): LiveRunCapAdmissionDecision {
  const free = liveRunCapFreeSlots(input.cap, input.occupancy);
  const room = input.runClass === "general" ? free.general : free.any;
  if (room <= 0) return { admit: false, reason: "cap_full" };
  if (input.aheadCount >= room) return { admit: false, reason: "behind_earlier_waiters" };
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

/**
 * Reads at most `maxBytes` of the body and parses it as JSON. A larger body
 * (declared or streamed) or one that is not JSON reads as `undefined`.
 */
async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
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

/**
 * One router poll, never throwing. Resolves true when a valid sample was
 * stored. Calls while a poll is in flight share it, so a hung router never
 * piles up requests. A redirect, a non-2xx answer, a body over
 * `LIVE_RUN_CAP_ROUTER_MAX_BODY_BYTES` or a timeout is a failed poll.
 */
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

  const pollOnce = async () => {
    let cap: number | null = null;
    try {
      const response = await fetchImpl(options.url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        cap = parseRouterRunCapResponse(await readBoundedJson(response, LIVE_RUN_CAP_ROUTER_MAX_BODY_BYTES));
      } else {
        await response.body?.cancel();
      }
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

  let inFlight: Promise<boolean> | null = null;
  return () => {
    inFlight ??= pollOnce().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/** Starts the background router poll. Admission never awaits it; it reads the cached sample. */
export function startLiveRunCapRouterPoller(options: LiveRunCapRouterPollerOptions): LiveRunCapRouterPoller {
  const pollNow = createLiveRunCapRouterPoll(options);
  routerPollerConfigured = true;
  const tick = () => {
    void pollNow();
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

// ─── Setting reader ───────────────────────────────────────────────────────────

/** The stored setting as the cap reads it (see `readStoredLiveRunCap` in instance-settings). */
export type LiveRunCapStoredSetting = { kind: "off" } | { kind: "cap"; value: number } | { kind: "invalid" };

/**
 * Reads the `liveRunCap` setting through a short cache, failing closed:
 * - off (absent or null) turns the gate off;
 * - an invalid stored value keeps the last valid cap this process read, so an
 *   operator cap below 15 is not loosened, or the ceiling when it read none;
 * - a failed read keeps the last value this process read (off included), or
 *   the ceiling when it read none. Never a cap of 0, never off by accident.
 */
export function createLiveRunCapSettingReader() {
  let cache: { value: number | null; atMs: number } | null = null;
  // undefined until this process has read the setting once.
  let lastKnown: number | null | undefined;
  return {
    async read(load: () => Promise<LiveRunCapStoredSetting>, nowMs = Date.now()): Promise<number | null> {
      if (cache && nowMs - cache.atMs < LIVE_RUN_CAP_SETTING_TTL_MS) return cache.value;
      let value: number | null;
      try {
        const stored = await load();
        if (stored.kind === "cap") {
          value = stored.value;
          lastKnown = value;
        } else if (stored.kind === "off") {
          value = null;
          lastKnown = null;
        } else {
          value = typeof lastKnown === "number" ? lastKnown : LIVE_RUN_CAP_CEILING;
          logger.warn({ cap: value }, "stored live-run cap setting is invalid; failing closed");
        }
      } catch (err) {
        value = lastKnown === undefined ? LIVE_RUN_CAP_CEILING : lastKnown;
        logger.warn({ err, cap: value }, "failed to read the live-run cap setting; keeping the last value, else the ceiling");
        return value;
      }
      cache = { value, atMs: nowMs };
      if (value === null) liveRunCapAdmission.clearWaiters();
      return value;
    },
    invalidate() {
      cache = null;
    },
  };
}

const liveRunCapSettingReader = createLiveRunCapSettingReader();

export function readLiveRunCapSetting(load: () => Promise<LiveRunCapStoredSetting>, nowMs = Date.now()) {
  return liveRunCapSettingReader.read(load, nowMs);
}

export function invalidateLiveRunCapSettingCache() {
  liveRunCapSettingReader.invalidate();
}

// ─── Admission state ──────────────────────────────────────────────────────────

const waiters = new Map<string, LiveRunCapQueueEntry>();
const admissionsInFlight: LiveRunCapOccupancy = { total: 0, reservedClass: 0 };
let admissionLock: Promise<void> = Promise.resolve();
const drainState: { running: Promise<void> | null; rerun: boolean } = { running: null, rerun: false };

/**
 * Handed to an admission-lock holder. Reservations and waiter records go
 * through it, so a holder that overran its deadline (the lock already moved
 * on) can do neither: `reserve` returns null and `registerWaiter` is ignored.
 */
export interface LiveRunCapLockLease {
  expired(): boolean;
  /** Takes one slot for a run about to be claimed; null once expired. The release is idempotent. */
  reserve(runId: string, runClass: LiveRunCapClass): (() => void) | null;
  /** Records a cap-waiter; ignored once expired. */
  registerWaiter(entry: LiveRunCapQueueEntry): void;
}

export type LiveRunCapAdmissionResult =
  | { admitted: true; release: () => void }
  | { admitted: false; timedOut: boolean };

function reserveSlot(runId: string, runClass: LiveRunCapClass) {
  waiters.delete(runId);
  const reservedClass = runClass === "general" ? 0 : 1;
  admissionsInFlight.total += 1;
  admissionsInFlight.reservedClass += reservedClass;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    admissionsInFlight.total -= 1;
    admissionsInFlight.reservedClass -= reservedClass;
  };
}

export const liveRunCapAdmission = {
  /**
   * Serializes count-and-reserve across agents. Holders must not call
   * `claimQueuedRun` or `startNextQueuedRunForAgent` inside it.
   *
   * Each holder gets `timeoutMs`. A holder that overruns resolves to
   * `onTimeout` (callers pass a refusal), the lock passes to the next holder,
   * and the overrun holder's lease refuses any later reservation or waiter.
   */
  async withLock<T>(
    fn: (lease: LiveRunCapLockLease) => Promise<T>,
    onTimeout: T,
    timeoutMs = LIVE_RUN_CAP_LOCK_TIMEOUT_MS,
  ): Promise<T> {
    const previous = admissionLock;
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    admissionLock = previous.then(() => turn);
    await previous;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        logger.warn({ timeoutMs }, "live-run cap admission overran the lock deadline; refusing it and passing the lock on");
        resolve(onTimeout);
      }, timeoutMs);
      timer.unref?.();
    });
    const lease: LiveRunCapLockLease = {
      expired: () => expired,
      reserve: (runId, runClass) => (expired ? null : reserveSlot(runId, runClass)),
      registerWaiter: (entry) => {
        if (!expired) waiters.set(entry.runId, entry);
      },
    };
    try {
      return await Promise.race([fn(lease), deadline]);
    } finally {
      clearTimeout(timer);
      releaseTurn();
    }
  },
  /**
   * Count-and-reserve for one queued run, before it is claimed. `countLive`
   * reads the counted running runs; admissions still claiming are added here.
   * `countAhead` counts other agents' waiters ahead in line that could take
   * one of the free slots. A run that does not fit is recorded as a waiter; a
   * decision that overruns the lock deadline is refused and records nothing.
   */
  async admit(input: {
    entry: LiveRunCapQueueEntry;
    cap: EffectiveLiveRunCap;
    countLive: () => Promise<LiveRunCapOccupancy>;
    countAhead: (free: { any: number; general: number }) => Promise<number>;
    timeoutMs?: number;
  }): Promise<LiveRunCapAdmissionResult> {
    return liveRunCapAdmission.withLock<LiveRunCapAdmissionResult>(
      async (lease) => {
        const live = await input.countLive();
        const occupancy: LiveRunCapOccupancy = {
          total: live.total + admissionsInFlight.total,
          reservedClass: live.reservedClass + admissionsInFlight.reservedClass,
        };
        const runClass = input.entry.runClass;
        let decision = decideLiveRunCapAdmission({ cap: input.cap, occupancy, runClass, aheadCount: 0 });
        if (decision.admit) {
          const aheadCount = await input.countAhead(liveRunCapFreeSlots(input.cap, occupancy));
          decision = decideLiveRunCapAdmission({ cap: input.cap, occupancy, runClass, aheadCount });
        }
        if (!decision.admit) {
          lease.registerWaiter(input.entry);
          return { admitted: false, timedOut: false };
        }
        const release = lease.reserve(input.entry.runId, runClass);
        return release ? { admitted: true, release } : { admitted: false, timedOut: true };
      },
      { admitted: false, timedOut: true },
      input.timeoutMs,
    );
  },
  inFlight() {
    return admissionsInFlight.total;
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
  listWaiters(nowMs = Date.now()): LiveRunCapQueueEntry[] {
    return [...waiters.values()].sort((left, right) => compareLiveRunCapPrecedence(left, right, nowMs));
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
