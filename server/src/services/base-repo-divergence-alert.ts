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
 * Two primitives, each a single atomic operation with no mutual-exclusion lock:
 *
 *  - The once-per-episode alert is an O_EXCL claim marker under the checkout's
 *    `.paperclip/` tree, keyed on a stable hash of the episode's identity (the
 *    canonical repo identity and the base ref), never a timestamp. One
 *    concurrent observer — across processes, not just within one server — can
 *    win it, so a divergence alerts at most once per episode. There is therefore
 *    no lock to go stale, no liveness oracle, and no recovery window.
 *  - The observation state (when the episode began and was last seen) is
 *    append-only per writer: each process publishes its own entry under
 *    `.paperclip/base-repo-divergence-obs-<h>/`, and every read re-merges all
 *    entries with the convergent sidecar summary — `min` over the starts, `max`
 *    over the ends. Because each entry path has exactly one writer for the life
 *    of a process, the earliest start is preserved across processes without a
 *    lock and without a lost read→derive→rename.
 *
 * It is deliberately best-effort everywhere: a tracking or signal failure must
 * never block a dispatch, and a base repo that is in sync or that self-heals
 * promptly produces no signal and no residue.
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
 * The sidecar lives in the base-repo checkout's `.paperclip/` directory — the
 * same gitignored tree the agent worktrees live under — so it is keyed
 * naturally to that base repo, outlives any individual worktree, never lands
 * in `git status`, and needs no database migration.
 */
export function divergenceRecordPath(repoRoot: string): string {
  return path.join(repoRoot, DIVERGENCE_RECORD_RELATIVE_PATH);
}

/**
 * The stable episode key: a hash of the canonical repo identity and the base
 * ref it has diverged from, never a timestamp. It keys both the O_EXCL claim
 * marker and the per-writer observation entries, so a checkout repointed at a
 * different repo or ref both starts a fresh alert episode and a fresh entry
 * directory; two workers whose clocks differ by milliseconds always agree on
 * the same key, so the at-most-once guarantee holds at any threshold,
 * including zero.
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
 * One process-level identity, generated once per process load. Combined with
 * the pid it names a single writer for the life of the process, so pid reuse
 * across a restart can never collide with a previous process's observation
 * entry.
 */
const PROCESS_INSTANCE_ID = randomUUID();

/**
 * The observation entries for one episode live under the checkout's
 * `.paperclip/` tree, keyed on the same episode hash as the claim marker.
 */
function divergenceObservationEntryDir(repoRoot: string, repoIdentity: string, baseRef: string): string {
  return path.join(
    repoRoot,
    ".paperclip",
    `base-repo-divergence-obs-${divergenceAlertEpisodeHash(repoIdentity, baseRef)}`,
  );
}

/** This process's single-writer observation entry for one episode. */
function processObservationEntryPath(repoRoot: string, repoIdentity: string, baseRef: string): string {
  return path.join(
    divergenceObservationEntryDir(repoRoot, repoIdentity, baseRef),
    `entry-${process.pid}-${PROCESS_INSTANCE_ID}.json`,
  );
}

interface ObservationEntry {
  firstObservedAtMs: number;
  lastObservedAtMs: number;
}

/**
 * Read every observation entry for an episode. Unparseable files and in-flight
 * `*.tmp` files are skipped silently (fail-open); a missing directory yields no
 * entries. Never throws.
 */
async function readObservationEntries(
  repoRoot: string,
  repoIdentity: string,
  baseRef: string,
): Promise<ObservationEntry[]> {
  const dir = divergenceObservationEntryDir(repoRoot, repoIdentity, baseRef);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: ObservationEntry[] = [];
  for (const name of names) {
    if (name.endsWith(".tmp")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    const rec = parsed as Partial<ObservationEntry>;
    if (
      typeof rec.firstObservedAtMs === "number" && Number.isFinite(rec.firstObservedAtMs) &&
      typeof rec.lastObservedAtMs === "number" && Number.isFinite(rec.lastObservedAtMs)
    ) {
      out.push({ firstObservedAtMs: rec.firstObservedAtMs, lastObservedAtMs: rec.lastObservedAtMs });
    }
  }
  return out;
}

/**
 * Pure fold of the candidate observation times into the merged start/end.
 * `bound` is the clock-skew guard: a start candidate strictly after `bound` is
 * dropped (the effect of today's `prior.firstObservedAtMs <= nowMs`), applied
 * uniformly to every candidate. The end is an unfiltered max. `fallbackFirst`
 * stands in when the guard empties the start candidates (the public read path;
 * the decision path always seeds the fresh `nowMs`).
 */
function foldObservation(
  firstCandidates: number[],
  lastCandidates: number[],
  bound: number,
  fallbackFirst: number,
): { firstObservedAtMs: number; lastObservedAtMs: number } {
  let first = fallbackFirst;
  let sawStart = false;
  for (const v of firstCandidates) {
    if (v > bound) continue;
    if (!sawStart || v < first) first = v;
    sawStart = true;
  }
  let last = -Infinity;
  for (const v of lastCandidates) {
    if (v > last) last = v;
  }
  return {
    firstObservedAtMs: first,
    lastObservedAtMs: Number.isFinite(last) ? last : fallbackFirst,
  };
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

/**
 * Read the raw convergent sidecar without merging the per-writer entries.
 * Returns the parsed, validated record or null when absent or malformed. This
 * is the cache half of the observation state; the authoritative merge is done
 * by {@link readDivergenceRecord} and the decision path.
 */
async function readRawSidecar(repoRoot: string): Promise<BaseRepoDivergenceRecord | null> {
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
 * Public read of the episode's observation state: the sidecar's convergent
 * summary merged with every per-writer entry (`min` over the starts, `max` over
 * the ends). The signature is unchanged — no identity argument; the episode key
 * is derived from the sidecar's OWN identity + ref. Absent or malformed
 * sidecar -> null, unchanged.
 */
export async function readDivergenceRecord(repoRoot: string): Promise<BaseRepoDivergenceRecord | null> {
  const sidecar = await readRawSidecar(repoRoot);
  if (!sidecar) return null;
  const entries = await readObservationEntries(repoRoot, sidecar.repoIdentity, sidecar.baseRef);
  const lastCandidates: number[] = [sidecar.lastObservedAtMs];
  for (const e of entries) lastCandidates.push(e.lastObservedAtMs);
  const bound = lastCandidates.reduce((m, v) => Math.max(m, v), sidecar.lastObservedAtMs);
  const firstCandidates: number[] = [sidecar.firstObservedAtMs];
  for (const e of entries) firstCandidates.push(e.firstObservedAtMs);
  const merged = foldObservation(firstCandidates, lastCandidates, bound, sidecar.firstObservedAtMs);
  return {
    ...sidecar,
    firstObservedAtMs: merged.firstObservedAtMs,
    lastObservedAtMs: merged.lastObservedAtMs,
    // Derived from marker presence, never trusted from the persisted shape: the
    // summary is last-writer-wins and can be clobbered by a concurrent writer,
    // but dedup is the O_EXCL marker, so a stale summary can no longer break it.
    alertedForFirstObservedAtMs: (await divergenceAlertMarkerPresent(
      repoRoot,
      sidecar.repoIdentity,
      sidecar.baseRef,
    ))
      ? merged.firstObservedAtMs
      : null,
  };
}

/**
 * Remove the record, the alert markers, and every observation entry directory
 * under the checkout's `.paperclip/` tree. Best-effort: a stale artifact must
 * never block provisioning.
 *
 * This is the ONLY unlink reachable from the module. It runs exclusively on the
 * episode-ended path (a reset, restore, fast-forward, or in-sync base) and is
 * never called from {@link observeDivergedRefusal}, so it cannot race a claim
 * decision or an in-flight entry write for the same episode.
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
      } else if (entry.startsWith("base-repo-divergence-obs-")) {
        await fs.rm(path.join(dir, entry), { recursive: true, force: true }).catch(() => {});
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
 * It is load-bearing for a NARROWER property than the module claims elsewhere:
 * it keeps THIS process's own observation entry (and its sidecar summary) a
 * single-writer path when two provisioning passes for the same checkout overlap
 * in-process, so one pass's read→fold→rename cannot interleave with the
 * other's. It is NOT what makes the alert fire at most once per episode — that
 * guarantee comes from the O_EXCL claim marker, which is won by at most one
 * observer even across processes.
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
 * The observation state is merged on read: this process reads the convergent
 * sidecar (trusted only when it was written for the SAME repo identity + base
 * ref) and every per-writer entry, folds them to `firstObservedAtMs = min(...)`
 * and `lastObservedAtMs = max(...)` — the clock-skew guard drops any start after
 * `nowMs` — then republishes both its sidecar summary and its own single-writer
 * entry. Because each entry path has exactly one writer for the life of the
 * process, the fold preserves the earliest start even when many processes
 * observe the same episode concurrently, with no lost update and no lock. An
 * in-flight observer whose entry is not yet written may still return a start
 * later than the eventual global min; that is inherent, fail-late (never a
 * spurious early alert), and self-heals on the next pass.
 *
 * A path that now hosts a different repository or base ref starts a fresh
 * episode (a new hash, an empty entry directory) rather than inheriting an old
 * start, so it cannot manufacture an instantly-old episode or a spurious alert.
 *
 * The once-per-episode guarantee is the O_EXCL claim marker: when the threshold
 * is crossed, exactly one concurrent observer — across processes — can create
 * the episode's marker, so one divergence episode yields at most one
 * first-class signal no matter how many workers race to observe it.
 */
export function observeDivergedRefusal(
  repoRoot: string,
  input: DivergedRefusalObservationInput,
): Promise<DivergedRefusalObservation> {
  return serializeObservationByKey(path.resolve(repoRoot), () =>
    recordDivergedRefusal(repoRoot, input),
  );
}

/**
 * Test-only synchronization seam on the observe/claim path. Inert in production
 * and in every test that does not install a hook: when unset it is a no-op. The
 * multi-process crash test installs a hook that reports it has been reached and
 * then blocks, so a forked worker can be SIGKILLed deterministically after the
 * observation has decided the age but before the O_EXCL claim — proving a
 * mid-observe crash cannot wedge the episode. This adds no lock and no
 * dependency; it is a no-op on the real path.
 */
let observeSeamHook: (() => void | Promise<void>) | null = null;

/** Install (or clear with `null`) the observe/claim seam hook. Test-only. */
export function _installDivergenceObserveSeam(hook: (() => void | Promise<void>) | null): void {
  observeSeamHook = hook;
}

async function recordDivergedRefusal(
  repoRoot: string,
  input: DivergedRefusalObservationInput,
): Promise<DivergedRefusalObservation> {
  const nowMs = input.nowMs ?? Date.now();
  const thresholdMs = input.thresholdMs ?? resolveDivergenceAlertThresholdMs();

  // Merge on read: fold the sidecar (trusted only when it matches this input's
  // identity + ref) and every per-writer entry with the fresh observation.
  const sidecar = await readRawSidecar(repoRoot);
  const sidecarMatches =
    sidecar !== null && sidecar.repoIdentity === input.repoIdentity && sidecar.baseRef === input.baseRef;
  const entries = await readObservationEntries(repoRoot, input.repoIdentity, input.baseRef);

  const firstCandidates: number[] = [nowMs];
  if (sidecarMatches && sidecar!.firstObservedAtMs <= nowMs) firstCandidates.push(sidecar!.firstObservedAtMs);
  for (const e of entries) if (e.firstObservedAtMs <= nowMs) firstCandidates.push(e.firstObservedAtMs);
  const lastCandidates: number[] = [nowMs];
  if (sidecarMatches) lastCandidates.push(sidecar!.lastObservedAtMs);
  for (const e of entries) lastCandidates.push(e.lastObservedAtMs);

  const { firstObservedAtMs, lastObservedAtMs } = foldObservation(firstCandidates, lastCandidates, nowMs, nowMs);
  const ageMs = Math.max(0, nowMs - firstObservedAtMs);
  const alertDue = ageMs >= thresholdMs;

  // Test-only seam: reached now that the observation has folded the state and
  // decided the age, before the O_EXCL claim. No hook is installed in production,
  // so this is a no-op on the real path; the crash test installs one to pause a
  // forked worker here so a SIGKILL cannot have created the episode's marker.
  if (observeSeamHook) await observeSeamHook();

  // The alert decision IS one atomic create: an O_EXCL marker for this episode.
  // Attempted ONLY when the threshold is already crossed, so a below-threshold
  // pass claims nothing. Exactly one concurrent observer (across processes) can
  // win; every other sees EEXIST and stays quiet.
  let shouldEmitFirstClassSignal = false;
  if (alertDue) {
    shouldEmitFirstClassSignal = await tryClaimDivergenceAlertEpisode(
      repoRoot,
      input.repoIdentity,
      input.baseRef,
    );
  }

  // Observability / back-compat only: mirror whether the episode holds its claim
  // marker. Derived from marker presence and never an input to
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
    lastObservedAtMs,
    aheadCount: input.aheadCount,
    behindCount: input.behindCount,
    aheadCommitSubjects: input.aheadCommitSubjects,
    alertedForFirstObservedAtMs,
  };

  // The sidecar stays as a convergent, last-writer-wins summary/cache.
  await writeRecordSidecar(repoRoot, record);

  // This process's own single-writer entry is the durable per-writer record.
  await writeProcessObservationEntry(repoRoot, input.repoIdentity, input.baseRef, nowMs);

  return { record, ageMs, thresholdMs, alertDue, shouldEmitFirstClassSignal };
}

/** Best-effort tmp+rename publish of the convergent sidecar summary. */
async function writeRecordSidecar(repoRoot: string, record: BaseRepoDivergenceRecord): Promise<void> {
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
}

/**
 * Publish this process's running start/end for the episode to its single-writer
 * entry (tmp+rename, tmp inside the entry dir, name carrying pid + uuid). One
 * writer per path for the life of the process, so an entry write can never lose
 * another writer's update under any interleaving. Best-effort: a failure never
 * blocks a dispatch.
 */
async function writeProcessObservationEntry(
  repoRoot: string,
  repoIdentity: string,
  baseRef: string,
  nowMs: number,
): Promise<void> {
  try {
    const dir = divergenceObservationEntryDir(repoRoot, repoIdentity, baseRef);
    const target = processObservationEntryPath(repoRoot, repoIdentity, baseRef);
    await fs.mkdir(dir, { recursive: true });
    // This process is the sole writer of its own entry; fold this observation
    // into its running min/max so a repeated probe preserves the earliest start.
    let first = nowMs;
    let last = nowMs;
    try {
      const prev = JSON.parse(await fs.readFile(target, "utf8")) as Partial<ObservationEntry>;
      if (typeof prev.firstObservedAtMs === "number" && Number.isFinite(prev.firstObservedAtMs)) {
        first = Math.min(first, prev.firstObservedAtMs);
      }
      if (typeof prev.lastObservedAtMs === "number" && Number.isFinite(prev.lastObservedAtMs)) {
        last = Math.max(last, prev.lastObservedAtMs);
      }
    } catch {
      // First observation for this process, or unreadable: start fresh from now.
    }
    const tmp = path.join(dir, `entry-${process.pid}-${randomUUID()}.tmp`);
    await fs.writeFile(tmp, JSON.stringify({ firstObservedAtMs: first, lastObservedAtMs: last }, null, 2), "utf8");
    await fs.rename(tmp, target);
  } catch {
    // Best-effort: a failed entry write never blocks a dispatch.
  }
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
