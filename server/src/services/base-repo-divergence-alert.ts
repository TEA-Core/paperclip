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
 * operator to the inline warning. The per-episode dedup is made atomic across
 * processes — not just within one — by an exclusive claim lock scoped to the
 * base-repo checkout, so two concurrent server workers can never both emit the
 * first-class signal for one divergence episode.
 *
 * The claim lock carries an owner token plus the owning process id, so ownership
 * is provable rather than positional: stale recovery may only remove a lock whose
 * recorded owner process is no longer live (a slow-but-alive owner keeps its
 * lock), and release is token-checked — a holder only unlinks the lock still
 * owned by the exact token it acquired, so a stale-recovered successor can never
 * be deleted by an old holder's trailing release. It is deliberately best-effort
 * everywhere: a tracking or signal failure must never block a dispatch, and a
 * base repo that is in sync or that self-heals promptly produces no signal and
 * no residue.
 */

export const DEFAULT_BASE_REPO_DIVERGENCE_ALERT_AGE_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Cross-process claim tuning. A crash must never permanently block alerting: a
 * lock left behind by a dead owner is recovered once it outlives
 * {@link CLAIM_LOCK_STALE_MS}, and a live contender stops waiting (and defers the
 * signal to the current holder) after {@link CLAIM_ACQUIRE_TIMEOUT_MS} rather than
 * blocking provisioning.
 *
 * Stale recovery is deliberately conservative: a lock whose mtime is older than
 * {@link CLAIM_LOCK_STALE_MS} is only removed when its recorded owner process is
 * not live (see {@link isDivergenceClaimOwnerLive}). A merely-slow owner is still
 * a legitimate owner, so an aged lock is never taken from a live process.
 */
const CLAIM_LOCK_STALE_MS = 60_000;
const CLAIM_ACQUIRE_TIMEOUT_MS = 5_000;
const CLAIM_POLL_INTERVAL_MS = 50;

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

export const DIVERGENCE_CLAIM_LOCK_RELATIVE_PATH = path.join(".paperclip", "base-repo-divergence-claim.lock");

/**
 * The cross-process claim lock, scoped to this base-repo checkout's `.paperclip/`
 * tree (next to the durable sidecar). Only one process may hold it at a time; the
 * sidecar's read-modify-write is performed under it so two concurrent
 * provisioning workers cannot both read an unalerted record and both emit a
 * first-class signal for one divergence episode.
 */
export function divergenceClaimLockPath(repoRoot: string): string {
  return path.join(repoRoot, DIVERGENCE_CLAIM_LOCK_RELATIVE_PATH);
}

/**
 * The owner metadata persisted inside the claim lock. It is what makes ownership
 * provable across processes:
 * - `token` is a per-acquisition unique value; release only unlinks the lock
 *   still bearing the exact token the caller acquired, so an old holder can never
 *   delete a successor's lock.
 * - `ownerPid` records the process that acquired the claim; stale recovery uses it
 *   to decide whether the owner is still live before it is allowed to remove the
 *   lock (a slow owner must keep its lock).
 * - `acquiredAtMs` is written at acquisition for diagnostics; the stale decision
 *   keys off the file's mtime so an externally-placed or back-dated lock is aged
 *   correctly too.
 */
export interface DivergenceClaimLock {
  ownerPid: number;
  token: string;
  acquiredAtMs: number;
}

/** Read and parse the claim lock. Returns null when absent or malformed. */
export async function readDivergenceClaimLock(repoRoot: string): Promise<DivergenceClaimLock | null> {
  try {
    const text = await fs.readFile(divergenceClaimLockPath(repoRoot), "utf8");
    const parsed = JSON.parse(text) as Partial<DivergenceClaimLock> | null;
    if (!parsed || typeof parsed.ownerPid !== "number" || typeof parsed.token !== "string") {
      return null;
    }
    return {
      ownerPid: parsed.ownerPid,
      token: parsed.token,
      acquiredAtMs: typeof parsed.acquiredAtMs === "number" ? parsed.acquiredAtMs : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Is the process that recorded this claim lock still alive? Stale recovery relies
 * on it so it never removes a lock whose owner is merely slow. A pid that can be
 * signalled (or that yields EPERM — it exists but is not ours to signal) counts as
 * live; a pid that yields ESRCH (or is not a positive integer) counts as gone.
 */
export function isDivergenceClaimOwnerLive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM: the process exists but we lack permission to signal it — it is live.
    return code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * Cross-process counterpart to {@link serializeObservationByKey}. The in-process
 * chain only serializes within one server process; distinct processes each hold
 * their own chain, so two workers can still race the sidecar. This claim is a
 * plain O_EXCL file scoped to the resolved repo root: the create is atomic at
 * the filesystem level, so exactly one process wins.
 *
 * Ownership is token-safe:
 * - On success the winner writes its own {@link DivergenceClaimLock} and returns
 *   the `token` it now owns, so the holder can prove ownership at release time.
 * - Stale recovery removes a lock only when its mtime is older than
 *   {@link CLAIM_LOCK_STALE_MS} AND its recorded `ownerPid` is not a live
 *   process. A merely-slow owner keeps its lock, so a contender can never take a
 *   lock from an original holder that is still running.
 * - When the recorded owner metadata is unreadable (corrupt/legacy lock), the
 *   decision falls back to mtime alone, bounded by the stale window.
 *
 * @returns the owner token this process now holds, or `null` when a live holder
 * still owns the lock at {@link CLAIM_ACQUIRE_TIMEOUT_MS} and the caller should
 * defer. A non-contention create failure fails open (returns a token) so
 * provisioning is never blocked; that holder's token-checked release is then a
 * no-op and the durable sidecar dedup key is the fallback.
 */
export async function acquireDivergenceClaim(repoRoot: string): Promise<string | null> {
  const lockPath = divergenceClaimLockPath(repoRoot);
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + CLAIM_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      const handle = await fs.open(
        lockPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o644,
      );
      try {
        const lock: DivergenceClaimLock = { ownerPid: process.pid, token, acquiredAtMs: Date.now() };
        await handle.writeFile(JSON.stringify(lock, null, 2) + "\n");
      } finally {
        await handle.close();
      }
      return token;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // A non-contention create failure (permissions, etc.): fail open. We never
        // wrote a matching lock, so our token-checked release is a no-op and the
        // durable sidecar dedup key is the fallback.
        return token;
      }
      // EEXIST: someone holds the lock. Decide whether it is safe to take over.
      let recoverable = false;
      try {
        const stat = await fs.stat(lockPath);
        const owner = await readDivergenceClaimLock(repoRoot);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs >= CLAIM_LOCK_STALE_MS) {
          // Stale by age. Only recover a genuinely-dead owner; a live owner (or an
          // unreadable lock, bounded by the stale window) is not taken.
          recoverable = owner === null ? true : !isDivergenceClaimOwnerLive(owner.ownerPid);
        }
      } catch {
        // The lock vanished between open and stat (the holder released it): retry.
        continue;
      }
      if (recoverable) {
        try {
          await fs.rm(lockPath, { force: true });
        } catch {
          // Best-effort: if the rm loses a race, the next O_EXCL will EEXIST and we
          // will re-evaluate against the surviving lock.
        }
        continue;
      }
      // A live (or fresh) holder owns it. Yield until it releases, or give up and
      // defer rather than block provisioning (fail-open).
      if (Date.now() >= deadline) return null;
      await sleep(CLAIM_POLL_INTERVAL_MS);
    }
  }
}

/**
 * Release the cross-process claim. Token-checked: read the lock currently at the
 * path and unlink it ONLY when it still bears the exact `token` this invocation
 * acquired. If the lock is absent, or is now owned by a different token (a
 * stale-recovered successor took over), this is a no-op — the old holder must
 * never delete a lock it does not own. Best-effort: never throws.
 */
export async function releaseDivergenceClaim(repoRoot: string, token: string | null): Promise<void> {
  if (!token) return;
  try {
    const lock = await readDivergenceClaimLock(repoRoot);
    if (lock && lock.token === token) {
      await fs.rm(divergenceClaimLockPath(repoRoot), { force: true });
    }
    // Absent or different token: leave the lock alone. We no longer own it.
  } catch {
    // swallow: cleanup is telemetry, not correctness
  }
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
 * Observations for the same checkout path are serialized both within a process
 * (see {@link serializeObservationByKey}) and across processes (see
 * {@link acquireDivergenceClaim}), so neither two provisioning passes in one
 * worker nor two distinct workers can each read "not yet alerted" and both fire.
 * Combined with the persisted `alertedForFirstObservedAtMs` dedup key, one
 * episode yields at most one first-class signal: the claimer that performs the
 * read-modify-write returns the real decision, and any process that finds the
 * claim held re-reads the sidecar and returns `shouldEmitFirstClassSignal: false`.
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

  // Cross-process exclusive claim (complementing the in-process chain that
  // observeDivergedRefusal applies). The durable sidecar's
  // `alertedForFirstObservedAtMs` is the dedup key, but the read-modify-write
  // must be serialized ACROSS processes so two workers cannot both read "not yet
  // alerted" and both fire. The claim returns the owner token this process holds
  // (or null when a live holder owns it), which is carried to release so an old
  // holder can never unlink a successor's lock.
  const claim = await acquireDivergenceClaim(repoRoot);
  try {
    if (claim !== null) {
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
      const shouldEmitFirstClassSignal =
        alertDue && prior?.alertedForFirstObservedAtMs !== firstObservedAtMs;

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
      await writeDivergenceRecordBestEffort(repoRoot, record);
      return { record, ageMs, thresholdMs, alertDue, shouldEmitFirstClassSignal };
    }

    // A live process holds the cross-process claim and is performing the
    // read-modify-write for this episode. We are not the claimer: re-read the
    // durable sidecar and defer the first-class signal to the claimer. Never
    // write here, so we cannot clobber the claimer's dedup key or manufacture a
    // second signal.
    const reread = await readDivergenceRecord(repoRoot);
    const prior =
      reread && reread.repoIdentity === input.repoIdentity && reread.baseRef === input.baseRef
        ? reread
        : null;
    const firstObservedAtMs =
      prior && prior.firstObservedAtMs <= nowMs ? prior.firstObservedAtMs : nowMs;
    const ageMs = Math.max(0, nowMs - firstObservedAtMs);
    const alertDue = ageMs >= thresholdMs;
    const record: BaseRepoDivergenceRecord =
      prior ??
      ({
        repoIdentity: input.repoIdentity,
        baseRef: input.baseRef,
        firstObservedAtMs,
        lastObservedAtMs: nowMs,
        aheadCount: input.aheadCount,
        behindCount: input.behindCount,
        aheadCommitSubjects: input.aheadCommitSubjects,
        alertedForFirstObservedAtMs: null,
      });
    return { record, ageMs, thresholdMs, alertDue, shouldEmitFirstClassSignal: false };
  } finally {
    // Token-checked: only unlinks the lock still owned by the token we acquired.
    // A successor that took over (only possible if our owner was no longer live)
    // is left in place.
    await releaseDivergenceClaim(repoRoot, claim);
  }
}

/** Best-effort sidecar write: an atomic tmp+rename that never blocks a dispatch. */
async function writeDivergenceRecordBestEffort(
  repoRoot: string,
  record: BaseRepoDivergenceRecord,
): Promise<void> {
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
