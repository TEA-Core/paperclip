import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const execFileAsync = promisify(execFile);

/**
 * base-repo-reset-lease.ts
 *
 * A cross-process, on-disk, fail-closed advisory lease that serializes every
 * actor that may rewrite a project base repository's reflog/history. The
 * serialization domain is the repository on disk — NOT the process heap.
 * Two actors that reach the same physical repository through different paths
 * (a symlink alias, a relative path, or a linked worktree of the same repo)
 * are forced onto a single lock, because the lease is keyed on the canonical
 * Git identity of the repo: the realpath'd output of
 * `git rev-parse --git-common-dir`.
 *
 * This is the mutex-identity module. It is intentionally DISTINCT from
 * `resolveCanonicalBaseRepoIdentity` (see below), which is the fail-OPEN
 * remote-URL "episode" identity used by the base-repo reset episode
 * bookkeeping. This module is fail-CLOSED: if the canonical identity cannot
 * be established, it throws `BaseRepoIdentityUnresolved` and acquires nothing
 * (no lockfile is written). Never fall back to a lexical `path.resolve`
 * here — that is exactly the bug that let R1 and R2 reset the wrong ref.
 *
 * Cross-reference (in the other direction, the "fail-open episode identity"):
 *   server/src/services/workspace-runtime.ts -> resolveCanonicalBaseRepoIdentity
 *   That function is keyed on the base remote's URL and is fail-open by design
 *   for episode bookkeeping. Do not route destructive reflog rewrites through
 *   it; route them through this lease, which is keyed on the physical repo and
 *   is fail-closed.
 */

const LEASE_LOCK_FILENAME = "paperclip-base-repo-reset.lease.lock";
const RECOVER_TOKEN_FILENAME = "paperclip-base-repo-reset.lease.lock.recover";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 20;
const DEFAULT_STALE_MS = 5 * 60_000;

const BASE_REPO_RESET_LEASE_BRAND: unique symbol = Symbol("BaseRepoResetLease");

/**
 * A held base-repo reset lease. The `readonly [BASE_REPO_RESET_LEASE_BRAND]`
 * key is typed by a module-private `unique symbol`, so an object literal in
 * another module can never satisfy this type — a destructive caller that does
 * not hold a real lease cannot construct one. The only way to obtain a value
 * of this type is for `withBaseRepoResetLease` to hand it to `fn`.
 */
export type BaseRepoResetLease = {
  /**
   * The canonical identity this lease covers: the realpath'd Git common
   * directory (`git rev-parse --git-common-dir`). Every alias/relative/
   * worktree path that resolves to this directory maps to the same lease.
   */
  readonly repoLockDir: string;
  /** Opaque holder id (`<pid>-<uuid>`) that minted this lease. */
  readonly holderId: string;
  readonly [BASE_REPO_RESET_LEASE_BRAND]: true;
};

export interface BaseRepoResetLeaseOptions {
  /**
   * How long to wait for the lease before throwing `BaseRepoResetLeaseTimeout`
   * (default 120000). The on-disk lock is the source of truth; this is only a
   * bound on how long one caller is willing to wait for others to release.
   */
  timeoutMs?: number;
  /** How often to poll a held lock (default 20ms). */
  pollMs?: number;
  /**
   * How old a lock must be (or how dead its pid must be) before it is
   * considered stale and recoverable (default 5 minutes). A live, fresh lock
   * is never stolen.
   */
  staleMs?: number;
}

/** Thrown when the fail-closed canonical identity cannot be established. */
export class BaseRepoIdentityUnresolved extends Error {
  readonly repoRoot: string;
  readonly detail: string;
  constructor(repoRoot: string, detail: string) {
    super(
      `base-repo-reset-lease: cannot establish fail-closed canonical identity for ` +
        `"${repoRoot}" — ${detail}. Nothing was locked.`,
    );
    this.name = "BaseRepoIdentityUnresolved";
    this.repoRoot = repoRoot;
    this.detail = detail;
  }
}

/** Thrown by `assertLease` when the lease does not cover the target repo. */
export class BaseRepoResetLeaseMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaseRepoResetLeaseMismatch";
  }
}

/** Thrown when a caller exhausts `timeoutMs` without acquiring the lease. */
export class BaseRepoResetLeaseTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaseRepoResetLeaseTimeout";
  }
}

type LockOwner = {
  pid: number;
  token: string;
  acquiredAtMs: number;
};

type ResolvedOptions = {
  timeoutMs: number;
  pollMs: number;
  staleMs: number;
};

/**
 * Acquire the cross-process base-repo reset lease for the repository at
 * `repoRoot`, run `fn` while holding it, then release it.
 *
 * The lease is keyed on the fail-closed canonical identity (realpath'd
 * `git rev-parse --git-common-dir`). Two in-process calls to the same repo
 * serialize; distinct repos do not block each other; a second OS process that
 * already holds the lockfile blocks this caller until it releases.
 *
 * The returned value is `fn`'s. The lease is guaranteed to be released in a
 * `finally`, even if `fn` throws.
 */
export async function withBaseRepoResetLease<T>(
  repoRoot: string,
  fn: (lease: BaseRepoResetLease) => Promise<T>,
  options?: BaseRepoResetLeaseOptions,
): Promise<T> {
  const resolved = normalizeOptions(options);
  // Fail-closed: this throws before ANY lockfile is created when the
  // canonical identity cannot be established.
  const repoLockDir = await resolveIdentityAsync(repoRoot);
  const token = await acquireLeaseLock(repoLockDir, resolved);
  const lease = mintLease(repoLockDir, token);
  try {
    return await fn(lease);
  } finally {
    releaseLeaseLock(repoLockDir, token);
  }
}

/**
 * Synchronously verify that `lease` is a genuine, non-forged
 * `BaseRepoResetLease` AND that it covers the repository at `repoRoot`.
 *
 * This is the fail-closed guard a destructive reflog-rewriting primitive
 * (e.g. a `reset --hard` + `reflog expire` + `gc`) must call before acting.
 * It throws `BaseRepoResetLeaseMismatch` for a non-branded value or a lease
 * that covers a different repository; it throws `BaseRepoIdentityUnresolved`
 * when `repoRoot`'s identity cannot be established.
 *
 * NOTE: this performs a synchronous `git rev-parse` so it can be called from
 * a synchronous destructive path. That is a deliberate, bounded cost.
 */
export function assertLease(lease: BaseRepoResetLease, repoRoot: string): void {
  if (!isBrandedLease(lease)) {
    throw new BaseRepoResetLeaseMismatch(
      "assertLease: value is not a BaseRepoResetLease (brand check failed). " +
        "A destructive caller must hold a lease minted by withBaseRepoResetLease.",
    );
  }
  let target: string;
  try {
    target = resolveIdentitySync(repoRoot);
  } catch (error) {
    if (error instanceof BaseRepoIdentityUnresolved) {
      throw error;
    }
    throw new BaseRepoIdentityUnresolved(repoRoot, describeError(error));
  }
  if (target !== lease.repoLockDir) {
    throw new BaseRepoResetLeaseMismatch(
      `assertLease: lease covers "${lease.repoLockDir}" but "${repoRoot}" resolves to ` +
        `"${target}"; refusing to apply this lease to a different repository.`,
    );
  }
}

/** Resolve the fail-closed canonical identity of a repo (async form). */
export async function resolveBaseRepoResetIdentity(repoRoot: string): Promise<string> {
  return resolveIdentityAsync(repoRoot);
}

/** The on-disk lockfile path for a given canonical identity directory. */
export function baseRepoResetLockFilePath(repoLockDir: string): string {
  return path.join(repoLockDir, LEASE_LOCK_FILENAME);
}

// ---------------------------------------------------------------------------
// Identity resolution (fail-closed)
// ---------------------------------------------------------------------------

function normalizeOptions(options?: BaseRepoResetLeaseOptions): ResolvedOptions {
  return {
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    pollMs: Math.max(1, Math.min(options?.pollMs ?? DEFAULT_POLL_MS, 60_000)),
    staleMs: Math.max(1, options?.staleMs ?? DEFAULT_STALE_MS),
  };
}

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
}

async function resolveIdentityAsync(repoRoot: string): Promise<string> {
  let startDir: string;
  try {
    startDir = await fs.promises.realpath(path.resolve(repoRoot));
  } catch (error) {
    throw new BaseRepoIdentityUnresolved(
      repoRoot,
      `cannot resolve "${repoRoot}": ${describeError(error)}`,
    );
  }
  let raw: string;
  try {
    const result = await execFileAsync("git", ["rev-parse", "--git-common-dir"], {
      cwd: startDir,
      env: gitEnv(),
      encoding: "utf8",
    });
    raw = result.stdout;
  } catch (error) {
    throw new BaseRepoIdentityUnresolved(
      repoRoot,
      `git rev-parse --git-common-dir failed: ${describeError(error)}`,
    );
  }
  return finalizeCommonDir(repoRoot, startDir, raw);
}

function resolveIdentitySync(repoRoot: string): string {
  let startDir: string;
  try {
    startDir = fs.realpathSync(path.resolve(repoRoot));
  } catch (error) {
    throw new BaseRepoIdentityUnresolved(
      repoRoot,
      `cannot resolve "${repoRoot}": ${describeError(error)}`,
    );
  }
  let raw: string;
  try {
    raw = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: startDir,
      env: gitEnv(),
      encoding: "utf8",
    });
  } catch (error) {
    throw new BaseRepoIdentityUnresolved(
      repoRoot,
      `git rev-parse --git-common-dir failed: ${describeError(error)}`,
    );
  }
  return finalizeCommonDir(repoRoot, startDir, raw);
}

function finalizeCommonDir(repoRoot: string, startDir: string, raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new BaseRepoIdentityUnresolved(
      repoRoot,
      "git returned an empty --git-common-dir",
    );
  }
  // `git rev-parse --git-common-dir` returns a path relative to the CWD it was
  // run in (the `-C` dir) for normal repos/worktrees, or an absolute path for
  // linked worktrees. Resolve against startDir (the cwd we ran git in), then
  // realpath so all alias/relative/worktree forms converge to one directory.
  const absolute = path.isAbsolute(trimmed) ? trimmed : path.resolve(startDir, trimmed);
  let commonDir: string;
  try {
    commonDir = fs.realpathSync(absolute);
  } catch (error) {
    throw new BaseRepoIdentityUnresolved(
      repoRoot,
      `git common dir "${absolute}" does not resolve: ${describeError(error)}`,
    );
  }
  let isDir = false;
  try {
    isDir = fs.statSync(commonDir).isDirectory();
  } catch (error) {
    throw new BaseRepoIdentityUnresolved(
      repoRoot,
      `git common dir "${commonDir}" cannot be stat'ed: ${describeError(error)}`,
    );
  }
  if (!isDir) {
    throw new BaseRepoIdentityUnresolved(
      repoRoot,
      `git common dir "${commonDir}" is not a directory`,
    );
  }
  return commonDir;
}

// ---------------------------------------------------------------------------
// Lease token / brand
// ---------------------------------------------------------------------------

function makeToken(): string {
  return `${process.pid}-${randomUUID()}`;
}

function mintLease(repoLockDir: string, holderId: string): BaseRepoResetLease {
  return {
    repoLockDir,
    holderId,
    [BASE_REPO_RESET_LEASE_BRAND]: true,
  };
}

function isBrandedLease(value: unknown): value is BaseRepoResetLease {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<PropertyKey, unknown>;
  return candidate[BASE_REPO_RESET_LEASE_BRAND] === true;
}

// ---------------------------------------------------------------------------
// On-disk lock (O_EXCL) + stale recovery
// ---------------------------------------------------------------------------

function lockPathFor(lockDir: string): string {
  return path.join(lockDir, LEASE_LOCK_FILENAME);
}

function recoverPathFor(lockDir: string): string {
  return path.join(lockDir, RECOVER_TOKEN_FILENAME);
}

function lockPayload(token: string): string {
  return `${JSON.stringify({
    version: 1,
    pid: process.pid,
    token,
    acquiredAtMs: Date.now(),
  })}\n`;
}

/** Atomically create the lockfile. Returns true on success, false on EEXIST. */
function tryCreateLock(lockPath: string, token: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (isEExist(error)) {
      return false;
    }
    throw error;
  }
  try {
    fs.writeFileSync(fd, lockPayload(token));
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    // We created the file but could not write a valid owner record; remove it
    // so it is not mistaken for a readable lock by a later reader.
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
    throw error;
  }
  try {
    fs.closeSync(fd);
  } catch {
    /* ignore */
  }
  return true;
}

function readLockOwner(lockPath: string): LockOwner | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const pid = obj.pid;
  const token = obj.token;
  const acquiredAtMs = obj.acquiredAtMs;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  return {
    pid,
    token,
    acquiredAtMs:
      typeof acquiredAtMs === "number" && Number.isFinite(acquiredAtMs) ? acquiredAtMs : NaN,
  };
}

function lockAgeMs(lockPath: string, owner: LockOwner | null): number {
  const now = Date.now();
  if (owner && Number.isFinite(owner.acquiredAtMs)) {
    return Math.max(0, now - owner.acquiredAtMs);
  }
  // Fall back to the file's mtime when the owner record is unreadable.
  return Math.max(0, now - fs.statSync(lockPath).mtimeMs);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH => no such process (dead). EPERM => exists but not ours (alive).
    return !isEsrch(error);
  }
}

function isStale(owner: LockOwner | null, ageMs: number, staleMs: number): boolean {
  if (owner) {
    // A live, fresh lock is never stale.
    if (isProcessAlive(owner.pid) && ageMs < staleMs) {
      return false;
    }
    // Dead pid, or old enough (or both) => stale.
    return true;
  }
  // Unreadable lock: only safe to recover once it has aged past the threshold,
  // so a live holder that has not finished writing is never stolen.
  return ageMs >= staleMs;
}

async function acquireLeaseLock(
  lockDir: string,
  options: ResolvedOptions,
): Promise<string> {
  const lockPath = lockPathFor(lockDir);
  const recoverPath = recoverPathFor(lockDir);
  const deadline = Date.now() + options.timeoutMs;
  const token = makeToken();
  for (;;) {
    // 1) Fast path: atomically create the lock.
    if (tryCreateLock(lockPath, token)) {
      return token;
    }
    // 2) EEXIST: inspect the existing lock.
    let owner: LockOwner | null = null;
    try {
      owner = readLockOwner(lockPath);
    } catch {
      owner = null;
    }
    let ageMs = Number.POSITIVE_INFINITY;
    try {
      ageMs = lockAgeMs(lockPath, owner);
    } catch {
      // The lock vanished between EEXIST and stat — loop and create again.
      continue;
    }
    if (!isStale(owner, ageMs, options.staleMs)) {
      // Held by a live, fresh holder (or unreadable-but-fresh): wait.
      if (Date.now() >= deadline) {
        throw new BaseRepoResetLeaseTimeout(
          `Timed out after ${options.timeoutMs}ms waiting for base-repo reset lease on "${lockDir}".`,
        );
      }
      await sleep(options.pollMs);
      continue;
    }
    // 3) Stale (dead pid / too old / aged-unreadable): recover, arbitrated.
    if (await recoverStaleLock(lockPath, recoverPath, token, options.staleMs)) {
      return token;
    }
    if (Date.now() >= deadline) {
      throw new BaseRepoResetLeaseTimeout(
        `Timed out after ${options.timeoutMs}ms recovering a stale base-repo reset lease on "${lockDir}".`,
      );
    }
    await sleep(options.pollMs);
  }
}

/**
 * Reclaim a stale lock. A second O_EXCL "recover token" file serializes the
 * recovery so two processes cannot both replace the same stale lock. Before
 * clobbering, the stale state is re-confirmed so a live, fresh holder that
 * appeared between the caller's EEXIST and now is never stolen.
 */
async function recoverStaleLock(
  lockPath: string,
  recoverPath: string,
  token: string,
  staleMs: number,
): Promise<boolean> {
  let fd: number;
  try {
    fd = fs.openSync(recoverPath, "wx", 0o600);
  } catch (error) {
    if (!isEExist(error)) {
      throw error;
    }
    // Someone else is (or just was) recovering. If the recover token is fresh,
    // back off and let that process win; if it has aged, it is an orphan and
    // may be reclaimed.
    let recoverAge = Number.POSITIVE_INFINITY;
    try {
      recoverAge = Date.now() - fs.statSync(recoverPath).mtimeMs;
    } catch {
      return false; // it vanished; caller will retry
    }
    if (recoverAge < staleMs) {
      return false;
    }
    try {
      fs.unlinkSync(recoverPath);
    } catch {
      /* another process reclaimed it first */
    }
    try {
      fd = fs.openSync(recoverPath, "wx", 0o600);
    } catch {
      return false;
    }
  }
  try {
    fs.closeSync(fd);
  } catch {
    /* ignore */
  }

  try {
    // Re-confirm the lock is still the same stale one we saw.
    let owner: LockOwner | null = null;
    try {
      owner = readLockOwner(lockPath);
    } catch {
      owner = null;
    }
    let ageMs = Number.POSITIVE_INFINITY;
    try {
      ageMs = lockAgeMs(lockPath, owner);
    } catch {
      ageMs = Number.POSITIVE_INFINITY; // lock vanished; create fresh below
    }
    if (owner && isProcessAlive(owner.pid) && ageMs < staleMs) {
      return false; // a live, fresh holder appeared — do not steal it
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
    return tryCreateLock(lockPath, token);
  } finally {
    try {
      fs.unlinkSync(recoverPath);
    } catch {
      /* ignore */
    }
  }
}

function releaseLeaseLock(lockDir: string, token: string): void {
  const lockPath = lockPathFor(lockDir);
  try {
    const owner = readLockOwner(lockPath);
    if (!owner || owner.token !== token) {
      // Not ours (e.g. we lost the lock to recovery and it was re-acquired):
      // never remove someone else's lock.
      return;
    }
    fs.unlinkSync(lockPath);
  } catch {
    // Best effort. A leftover lock is reclaimed by stale recovery.
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function isEExist(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isEsrch(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code =
      "code" in error ? String((error as { code?: unknown }).code) : undefined;
    return code ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}
