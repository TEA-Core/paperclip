import { createHash, randomUUID } from "node:crypto";
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
 * operator to the inline warning.
 *
 * The once-per-episode guarantee is enforced by an O_EXCL claim marker under the
 * checkout's `.paperclip/` tree rather than any mutual-exclusion lock: one
 * atomic create that a single concurrent observer — across processes, not just
 * within one server — can win for a given episode. There is therefore no lock to
 * go stale, no liveness oracle, and no recovery window. It is deliberately
 * best-effort everywhere: a tracking or signal failure must never block a
 * dispatch, and a base repo that is in sync or that self-heals promptly produces
 * no signal and no residue.
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
   * emitted. Retained in the persisted shape for back-compat and observability
   * only: the once-per-episode dedup is the O_EXCL claim marker, and this field
   * is derived from marker presence — it is never an input to
   * `shouldEmitFirstClassSignal`.
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

/**
 * The once-per-episode claim is a single `O_EXCL` create, won by at most one
 * concurrent observer — across processes, not just within a server — so a
 * divergence alert fires at most once no matter how many provisioning workers
 * race to observe it.
 *
 * The marker is keyed on this stable hash of the episode's identity: the
 * canonical repo identity and the base ref it has diverged from, never a
 * timestamp. A checkout repointed at a different repo or ref hashes to a
 * different marker and therefore starts a fresh episode; two workers whose
 * clocks differ by milliseconds always agree on the same marker, so the
 * at-most-once guarantee holds at any threshold, including zero.
 */
export function divergenceAlertEpisodeHash(repoIdentity: string, baseRef: string): string {
  return createHash("sha256").update(`${repoIdentity}\u0000${baseRef}`).digest("hex").slice(0, 32);
}

export function divergenceAlertMarkerPath(repoRoot: string, repoIdentity: string, baseRef: string): string {
  return path.join(
    repoRoot,
    ".paperclip",
    `base-repo-divergence-alerted-${divergenceAlertEpisodeHash(repoIdentity, baseRef)}.marker`,
  );
}

/**
 * Atomically claim the alert for one episode by creating its marker with
 * O_EXCL. Returns `true` when this observer won the claim and `false` when the
 * marker already exists (the episode already alerted). Any other error fails
 * open and returns `true`, matching the module's best-effort posture: a
 * tracking failure must never block a dispatch.
 *
 * There is no release and no unlink anywhere reachable from an observation.
 * Removing a marker is exclusive to {@link clearDivergenceRecord} on the
 * episode-ended path, so a claim and its reset can never race for the same
 * episode.
 */
async function tryClaimDivergenceAlertEpisode(
  repoRoot: string,
  repoIdentity: string,
  baseRef: string,
): Promise<boolean> {
  const markerPath = divergenceAlertMarkerPath(repoRoot, repoIdentity, baseRef);
  try {
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
  } catch {
    // The sidecar write also creates this directory; a failure here just means
    // the open below may fail, which fails open.
  }
  try {
    const handle = await fs.open(
      markerPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o644,
    );
    await handle.close();
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST") return false;
    return true;
  }
}

/**
 * Best-effort presence check for an episode's marker. Used only to mirror claim
 * state into the persisted shape for observability — it is never an input to the
 * claim decision.
 */
async function divergenceAlertMarkerPresent(
  repoRoot: string,
  repoIdentity: string,
  baseRef: string,
): Promise<boolean> {
  try {
    await fs.access(divergenceAlertMarkerPath(repoRoot, repoIdentity, baseRef));
    return true;
  } catch {
    return false;
  }
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

/**
 * Remove the record and any alert markers under the checkout's `.paperclip/`
 * tree. Best-effort: a stale sidecar or marker must never block provisioning.
 *
 * This is the ONLY unlink reachable from the module. It runs exclusively on the
 * episode-ended path (a reset, restore, fast-forward, or in-sync base) and is
 * never called from {@link observeDivergedRefusal}, so it cannot race a claim
 * decision for the same episode.
 */
export async function clearDivergenceRecord(repoRoot: string): Promise<void> {
  try {
    await fs.rm(divergenceRecordPath(repoRoot), { force: true });
  } catch {
    // swallow: cleanup is telemetry, not correctness
  }
  try {
    const dir = path.dirname(divergenceRecordPath(repoRoot));
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      if (entry.startsWith("base-repo-divergence-alerted-") && entry.endsWith(".marker")) {
        await fs.rm(path.join(dir, entry), { force: true }).catch(() => {});
      }
    }
  } catch {
    // swallow: a missing .paperclip tree means there is nothing to clear
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
 * Kept for write economy — coalescing concurrent read-modify-writes of the
 * sidecar within one server process — and because in-process ordering is a
 * preserved behaviour. It is NO LONGER what makes the alert fire at most once
 * per episode: that guarantee now comes from the O_EXCL claim marker, which is
 * won by at most one observer even across processes. Serialization is
 * therefore not load-bearing for dedup any more.
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
 * {@link serializeObservationByKey}) for write economy, but the once-per-episode
 * guarantee no longer depends on that. It now comes from the O_EXCL claim
 * marker: when the threshold is crossed, exactly one concurrent observer —
 * across processes — can create the episode's marker, so one divergence episode
 * yields at most one first-class signal no matter how many workers race to
 * observe it.
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

  // The alert decision IS one atomic create: an O_EXCL marker for this episode.
  // It is attempted ONLY when the threshold is already crossed, so a
  // below-threshold pass leaves no residue. Exactly one concurrent observer
  // (across processes) can win; every other sees EEXIST and stays quiet.
  let shouldEmitFirstClassSignal = false;
  if (alertDue) {
    shouldEmitFirstClassSignal = await tryClaimDivergenceAlertEpisode(
      repoRoot,
      input.repoIdentity,
      input.baseRef,
    );
  }

  // Observability / back-compat only: mirror whether the episode holds its claim
  // marker. It is derived from marker presence and is never an input to
  // `shouldEmitFirstClassSignal`.
  const alertedForFirstObservedAtMs = alertDue
    ? (await divergenceAlertMarkerPresent(repoRoot, input.repoIdentity, input.baseRef)
        ? firstObservedAtMs
        : null)
    : null;

  const record: BaseRepoDivergenceRecord = {
    repoIdentity: input.repoIdentity,
    baseRef: input.baseRef,
    firstObservedAtMs,
    lastObservedAtMs: nowMs,
    aheadCount: input.aheadCount,
    behindCount: input.behindCount,
    aheadCommitSubjects: input.aheadCommitSubjects,
    alertedForFirstObservedAtMs,
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
