import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * First-class signal for a project base repo that stays in the
 * non-resettable `diverged` state.
 *
 * `workspace-runtime.prepareBaseRepoForWorkspace` already classifies a base
 * repo as `diverged` and — after SUP-13858 — self-heals a fully-duplicate ahead
 * set at any behind distance. What survives that is the "diverged-refused"
 * state: genuinely-unique ahead work, or duplication that could not be proven.
 * Today that leaves only an advisory string in the workspace-ready comment, and
 * nothing escalates when a base repo has been frozen for weeks (the motivating
 * incident was found by a human reading a provisioning warning in passing).
 *
 * This module tracks, per base-repo checkout, when that state began (and when
 * it was last re-observed), and turns a divergence that has persisted past a
 * configurable age threshold into a first-class signal — a durable, board-
 * published attention row plus a distinct alert line — rather than leaving the
 * operator to the inline warning. It is deliberately best-effort everywhere:
 * a tracking or signal failure must never block a dispatch, and a base repo that
 * is in sync or that self-heals promptly produces no signal and no residue.
 */

export const DEFAULT_BASE_REPO_DIVERGENCE_ALERT_AGE_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Operator-configurable age threshold, in days, beyond which a non-resettable
 * diverged base repo emits a first-class signal. Read at call time so a new
 * value takes effect on the next provisioning pass without a restart; an
 * absent or non-positive value falls back to {@link DEFAULT_BASE_REPO_DIVERGENCE_ALERT_AGE_DAYS}.
 */
export function resolveDivergenceAlertThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PAPERCLIP_BASE_REPO_DIVERGENCE_ALERT_AGE_DAYS);
  if (Number.isFinite(raw) && raw > 0) return Math.round(raw * MS_PER_DAY);
  return DEFAULT_BASE_REPO_DIVERGENCE_ALERT_AGE_DAYS * MS_PER_DAY;
}

export interface DivergenceAgeAlertDecision {
  /** True when the diverged-refused state has persisted past the threshold. */
  alertDue: boolean;
  /** Milliseconds the state has persisted (now - first observed). */
  ageMs: number;
  thresholdMs: number;
}

/**
 * Pure, side-effect-free age/threshold decision — the unit under test. Given
 * when the diverged state began, when it is "now", and the configured
 * threshold, decide whether a first-class signal is due. A clock that runs
 * backwards (now < firstObserved) clamps age to zero rather than reporting a
 * negative age, so a skewed timestamp can never suppress a genuinely old state
 * or manufacture a negative one.
 */
export function resolveDivergenceAgeAlert(input: {
  firstObservedAtMs: number;
  nowMs: number;
  thresholdMs: number;
}): DivergenceAgeAlertDecision {
  const ageMs = Math.max(0, input.nowMs - input.firstObservedAtMs);
  return {
    alertDue: ageMs >= input.thresholdMs,
    ageMs,
    thresholdMs: input.thresholdMs,
  };
}

/** Compact human duration for alert text: "3d 4h", "5h 12m", "9m". */
export function formatDivergenceDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Durable, per-base-repo record of the diverged-refused state. */
export interface BaseRepoDivergenceRecord {
  /** Repo identity (the base-repo checkout path; the caller may carry the URL separately). */
  repoIdentity: string;
  baseRef: string;
  /** Earliest time the diverged-refused state was observed (ms since epoch). */
  firstObservedAtMs: number;
  /** Most recent time it was re-observed (ms since epoch). */
  lastObservedAtMs: number;
  aheadCount: number;
  behindCount: number;
  aheadCommitSubjects: string[];
  /**
   * The `firstObservedAtMs` for which a first-class signal has already been
   * emitted. This is the per-episode dedup: a stuck base repo is probed on every
   * worktree realization, and the alert must fire once per divergence episode,
   * not once per realization.
   */
  alertedForFirstObservedAtMs: number | null;
}

export const DIVERGENCE_RECORD_RELATIVE_PATH = path.join(".paperclip", "base-repo-divergence.json");

/**
 * The record lives in the base-repo checkout's `.paperclip/` directory — the
 * same gitignored tree the agent worktrees live under — so it is keyed
 * naturally to that base repo, outlives any individual worktree, never lands
 * in `git status`, and needs no database migration.
 */
export function divergenceRecordPath(repoRoot: string): string {
  return path.join(repoRoot, DIVERGENCE_RECORD_RELATIVE_PATH);
}

export async function readDivergenceRecord(repoRoot: string): Promise<BaseRepoDivergenceRecord | null> {
  try {
    const text = await fs.readFile(divergenceRecordPath(repoRoot), "utf8");
    const parsed = JSON.parse(text) as Partial<BaseRepoDivergenceRecord>;
    if (
      typeof parsed.firstObservedAtMs !== "number" || !Number.isFinite(parsed.firstObservedAtMs) ||
      typeof parsed.lastObservedAtMs !== "number" || !Number.isFinite(parsed.lastObservedAtMs)
    ) {
      return null;
    }
    return {
      repoIdentity: typeof parsed.repoIdentity === "string" ? parsed.repoIdentity : "",
      baseRef: typeof parsed.baseRef === "string" ? parsed.baseRef : "",
      firstObservedAtMs: parsed.firstObservedAtMs,
      lastObservedAtMs: parsed.lastObservedAtMs,
      aheadCount: typeof parsed.aheadCount === "number" ? parsed.aheadCount : 0,
      behindCount: typeof parsed.behindCount === "number" ? parsed.behindCount : 0,
      aheadCommitSubjects: Array.isArray(parsed.aheadCommitSubjects)
        ? parsed.aheadCommitSubjects.filter((s): s is string => typeof s === "string")
        : [],
      alertedForFirstObservedAtMs: typeof parsed.alertedForFirstObservedAtMs === "number"
        ? parsed.alertedForFirstObservedAtMs
        : null,
    };
  } catch {
    return null;
  }
}

/** Remove the record. Best-effort: a stale sidecar must never block provisioning. */
export async function clearDivergenceRecord(repoRoot: string): Promise<void> {
  try {
    await fs.rm(divergenceRecordPath(repoRoot), { force: true });
  } catch {
    // swallow: cleanup is telemetry, not correctness
  }
}

export interface DivergedRefusalObservationInput {
  baseRef: string;
  repoIdentity: string;
  aheadCount: number;
  behindCount: number;
  aheadCommitSubjects: string[];
  nowMs?: number;
  thresholdMs?: number;
}

export interface DivergedRefusalObservation {
  record: BaseRepoDivergenceRecord;
  ageMs: number;
  thresholdMs: number;
  alertDue: boolean;
  /** True when the threshold was crossed AND this episode has not yet alerted. */
  shouldEmitFirstClassSignal: boolean;
}

/**
 * In-process per-repo-root serialization for {@link observeDivergedRefusal}.
 * The sidecar record is the durable, cross-restart dedup key, but two
 * concurrent provisioning passes in the same server process can both read an
 * unalerted record and both emit a first-class signal for one episode. Chaining
 * the read-modify-write per checkout path closes that window so a single
 * divergence episode produces at most one signal.
 */
const observeChains = new Map<string, Promise<unknown>>();

function serializeObservationByKey<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = observeChains.get(key) ?? Promise.resolve();
  const next = prev.then(task);
  const settled = next.catch(() => {});
  observeChains.set(key, settled);
  // Drop the entry once it is the tail of the chain so a long-lived server does
  // not accumulate one entry per distinct base-repo checkout path.
  settled.then(() => {
    if (observeChains.get(key) === settled) observeChains.delete(key);
  });
  return next;
}

/**
 * Record one observation of the diverged-refused state and decide whether a
 * first-class signal is due.
 *
 * `firstObservedAtMs` preserves the EARLIEST observation seen so far, so the
 * age grows monotonically for the life of a divergence episode regardless of
 * how many times the repo is probed. `lastObservedAtMs` and the ahead/behind
 * counts/subjects are refreshed to the newest observation.
 *
 * A prior record is only reused when it was written for the SAME repo identity
 * and base ref. The record lives under the checkout path's `.paperclip/` tree,
 * so a path that now hosts a different repository or ref must not inherit an
 * old `firstObservedAtMs` — that would manufacture an instantly-old episode and
 * emit a spurious alert, breaking per-base-repo tracking and the no-noise rule.
 *
 * Observations for the same checkout path are serialized (see
 * {@link serializeObservationByKey}) so concurrent provisioning passes cannot
 * each read "not yet alerted" and both fire; combined with the persisted
 * `alertedForFirstObservedAtMs` dedup key, one episode yields at most one
 * first-class signal.
 */
export function observeDivergedRefusal(
  repoRoot: string,
  input: DivergedRefusalObservationInput,
): Promise<DivergedRefusalObservation> {
  return serializeObservationByKey(path.resolve(repoRoot), () =>
    recordDivergedRefusal(repoRoot, input),
  );
}

async function recordDivergedRefusal(
  repoRoot: string,
  input: DivergedRefusalObservationInput,
): Promise<DivergedRefusalObservation> {
  const nowMs = input.nowMs ?? Date.now();
  const thresholdMs = input.thresholdMs ?? resolveDivergenceAlertThresholdMs();
  const existing = await readDivergenceRecord(repoRoot);
  // Only trust a prior record written for the current repo identity AND base
  // ref; otherwise start a fresh episode rather than inheriting its age.
  const prior =
    existing && existing.repoIdentity === input.repoIdentity && existing.baseRef === input.baseRef
      ? existing
      : null;
  // A future-dated existing record (clock skew) must not shrink the window we
  // have already been watching; fall back to now for that episode's start.
  const firstObservedAtMs =
    prior && prior.firstObservedAtMs <= nowMs ? prior.firstObservedAtMs : nowMs;
  const ageMs = Math.max(0, nowMs - firstObservedAtMs);
  const alertDue = ageMs >= thresholdMs;
  const shouldEmitFirstClassSignal = alertDue && prior?.alertedForFirstObservedAtMs !== firstObservedAtMs;

  const record: BaseRepoDivergenceRecord = {
    repoIdentity: input.repoIdentity,
    baseRef: input.baseRef,
    firstObservedAtMs,
    lastObservedAtMs: nowMs,
    aheadCount: input.aheadCount,
    behindCount: input.behindCount,
    aheadCommitSubjects: input.aheadCommitSubjects,
    alertedForFirstObservedAtMs: shouldEmitFirstClassSignal
      ? firstObservedAtMs
      : prior?.alertedForFirstObservedAtMs ?? null,
  };
  try {
    await fs.mkdir(path.dirname(divergenceRecordPath(repoRoot)), { recursive: true });
    const target = divergenceRecordPath(repoRoot);
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
    await fs.rename(tmp, target);
  } catch {
    // Best-effort: even if the write fails the in-memory decision is still
    // returned, so a stuck base repo still alerts from memory this pass.
  }
  return { record, ageMs, thresholdMs, alertDue, shouldEmitFirstClassSignal };
}

/** The structured payload for the first-class attention row. */
export interface BaseRepoDivergenceAlert {
  repoIdentity: string;
  baseRef: string;
  aheadCount: number;
  behindCount: number;
  aheadCommitSubjects: string[];
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  divergenceAgeMs: number;
  thresholdMs: number;
}

/**
 * Build the distinct first-class alert line. Phrased deliberately differently
 * from the plain "…has diverged … Local commits preserved" advisory so a
 * reader (or a filter) can tell the escalated, threshold-breaching alert apart
 * from the routine per-realization warning. Names the repo, the base ref, the
 * ahead/behind counts, the ahead commit subjects, how long the state has
 * persisted, and the threshold it crossed.
 */
export function buildDivergenceAlertText(alert: BaseRepoDivergenceAlert): string {
  const subjects = alert.aheadCommitSubjects.length > 0
    ? alert.aheadCommitSubjects.join(", ")
    : "(no subjects)";
  const repo = alert.repoIdentity || "the base repository";
  return (
    `ALERT (first-class): base repository at ${repo} has been stuck in a non-resettable ` +
    `diverged state relative to ${alert.baseRef} for ${formatDivergenceDuration(alert.divergenceAgeMs)} ` +
    `(exceeds the ${formatDivergenceDuration(alert.thresholdMs)} threshold). ` +
    `${alert.aheadCount} ahead / ${alert.behindCount} behind. Ahead commits: ${subjects}. ` +
    `Auto-reset refused — ahead work is not provably upstream, so it did not self-heal. ` +
    `Escalated to the board event stream for manual intervention.`
  );
}
