import { execSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertLease,
  BaseRepoIdentityUnresolved,
  BaseRepoResetLeaseMismatch,
  BaseRepoResetLeaseTimeout,
  baseRepoResetLockFilePath,
  resolveBaseRepoResetIdentity,
  withBaseRepoResetLease,
} from "./base-repo-reset-lease.js";
import type { BaseRepoResetLease } from "./base-repo-reset-lease.js";

/**
 * Acceptance suite for the cross-process, on-disk, fail-closed base-repo reset
 * lease (SUP-15721). Every test uses real temp git repos (init/commit,
 * symlink alias, relative path, linked worktree) — no mocking of git.
 */

const tempRoots: string[] = [];

function newTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "base-repo-lease-test-"));
  tempRoots.push(root);
  return root;
}

function gitExec(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: "pipe" });
}

function makeRepo(baseDir: string, name: string): string {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  gitExec(dir, "init");
  gitExec(dir, "config user.email paperclip-lease-test@example.com");
  gitExec(dir, "config user.name 'Paperclip Lease Test'");
  gitExec(dir, 'commit --allow-empty -m init');
  return dir;
}

/** Return the pid of a process that has already exited (guaranteed dead). */
function deadPid(): number {
  const res = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return res.pid;
}

/** Write a lease lockfile in the module's on-disk format (test-only). */
function writeRawLock(lockPath: string, pid: number, token: string, acquiredAtMs: number): void {
  const fd = fs.openSync(lockPath, "wx", 0o600);
  fs.writeFileSync(fd, `${JSON.stringify({ version: 1, pid, token, acquiredAtMs })}\n`);
  fs.closeSync(fd);
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      return;
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for ${file}`);
}

afterAll(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("withBaseRepoResetLease", () => {
  it("serializes two in-process holders on the same repo; distinct repos do not block", async () => {
    const root = newTempRoot();
    const repoA = makeRepo(root, "repo-a");
    const repoB = makeRepo(root, "repo-b");

    // Same repo: two concurrent holders must never overlap.
    let active = 0;
    let maxActive = 0;
    const holdA = () =>
      withBaseRepoResetLease(repoA, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(60);
        active -= 1;
      });
    await Promise.all([holdA(), holdA()]);
    expect(maxActive).toBe(1);

    // Distinct repo: while A is held, B acquires immediately (no block).
    let releaseA!: () => void;
    const aGate = new Promise<void>((res) => {
      releaseA = res;
    });
    let holdingA = false;
    const aHandle = withBaseRepoResetLease(repoA, async () => {
      holdingA = true;
      await aGate;
    });
    // Wait until A has acquired.
    while (!holdingA) {
      await delay(5);
    }
    const startB = Date.now();
    const bValue = await withBaseRepoResetLease(repoB, async () => "b-ok", { timeoutMs: 2000 });
    const bMs = Date.now() - startB;
    expect(bValue).toBe("b-ok");
    expect(bMs).toBeLessThan(1000); // B was not blocked by A
    releaseA();
    await aHandle;
  });

  it("converges a symlink alias, a relative path, and a linked worktree onto one lease", async () => {
    const root = newTempRoot();
    const repo = makeRepo(root, "repo-x");

    // Symlink alias of the main repo.
    const alias = path.join(root, "repo-x-alias");
    fs.symlinkSync(repo, alias, "dir");

    // Relative path (relative to the process cwd) to the main repo.
    const relative = path.relative(process.cwd(), repo);

    // Linked worktree sharing the same git common dir.
    const worktree = path.join(root, "repo-x-wt");
    gitExec(repo, `worktree add --detach "${worktree}" HEAD`);

    const mainId = await resolveBaseRepoResetIdentity(repo);
    expect(path.basename(mainId)).toBe(".git"); // sanity: it is the git dir

    await expect(resolveBaseRepoResetIdentity(alias)).resolves.toBe(mainId);
    await expect(resolveBaseRepoResetIdentity(relative)).resolves.toBe(mainId);
    await expect(resolveBaseRepoResetIdentity(worktree)).resolves.toBe(mainId);

    // Behavioral proof they share ONE on-disk lease: holding the main repo
    // blocks an acquisition via the linked worktree.
    let releaseMain!: () => void;
    const mainGate = new Promise<void>((res) => {
      releaseMain = res;
    });
    const mainHandle = withBaseRepoResetLease(repo, async () => {
      await mainGate;
    });
    await delay(40); // let main acquire
    await expect(
      withBaseRepoResetLease(worktree, async () => "should not run", { timeoutMs: 400 }),
    ).rejects.toBeInstanceOf(BaseRepoResetLeaseTimeout);
    releaseMain();
    await mainHandle;
  });

  it("blocks an in-process acquisition while a second OS process holds the lock", async () => {
    const root = newTempRoot();
    const repo = makeRepo(root, "repo-cp");
    const lockDir = await resolveBaseRepoResetIdentity(repo);
    const lockPath = baseRepoResetLockFilePath(lockDir);
    const readyPath = path.join(root, "cp-ready");

    // A separate node process creates the O_EXCL lockfile directly, holds it,
    // then releases it — simulating another OS actor that won the lease.
    const script = [
      'const fs = require("node:fs");',
      "const lockPath = process.argv[1];",
      "const readyPath = process.argv[2];",
      "const holdMs = Number(process.argv[3]);",
      'const token = "external-" + process.pid;',
      'const fd = fs.openSync(lockPath, "wx", 0o600);',
      'fs.writeFileSync(fd, JSON.stringify({ version: 1, pid: process.pid, token, acquiredAtMs: Date.now() }) + "\\n");',
      "fs.closeSync(fd);",
      'fs.writeFileSync(readyPath, "ready\\n");',
      "setTimeout(() => { try { fs.unlinkSync(lockPath); } catch (e) {} process.exit(0); }, holdMs);",
    ].join("\n");

    const child = spawn(process.execPath, ["-e", script, lockPath, readyPath, "1000"], {
      stdio: "ignore",
    });

    try {
      await waitForFile(readyPath, 3000);
      // The lock is now held by a live, external pid. An in-process acquisition
      // must NOT steal it (staleMs is high) and must time out.
      await expect(
        withBaseRepoResetLease(repo, async () => "should not run", {
          timeoutMs: 400,
          staleMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(BaseRepoResetLeaseTimeout);
    } finally {
      await new Promise<void>((res) => child.once("exit", () => res()));
    }

    // Once the external process releases, the lease is acquirable.
    const holder = await withBaseRepoResetLease(repo, async (lease) => lease.holderId, {
      timeoutMs: 2000,
    });
    expect(typeof holder).toBe("string");
    expect(holder.startsWith(`${process.pid}-`)).toBe(true);
  });

  it("throws BaseRepoIdentityUnresolved and leaves no lockfile when identity cannot be resolved", async () => {
    const root = newTempRoot();

    // Empty directory under /tmp: `git rev-parse --git-common-dir` walks up,
    // finds no .git, and exits non-zero -> fail-closed identity error.
    const notARepo = path.join(root, "not-a-git-repo");
    fs.mkdirSync(notARepo);
    await expect(
      withBaseRepoResetLease(notARepo, async () => "nope"),
    ).rejects.toBeInstanceOf(BaseRepoIdentityUnresolved);
    expect(fs.readdirSync(notARepo)).toEqual([]); // nothing was created

    // A nonexistent path also fails closed before any lockfile is written.
    const missing = path.join(root, "does-not-exist");
    await expect(
      withBaseRepoResetLease(missing, async () => "nope"),
    ).rejects.toBeInstanceOf(BaseRepoIdentityUnresolved);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("recovers a stale lock held by a dead pid, and does not steal a live fresh lock", async () => {
    // (a) Dead pid: the lock is recovered and the caller takes over.
    const rootA = newTempRoot();
    const repoA = makeRepo(rootA, "stale");
    const lockDirA = await resolveBaseRepoResetIdentity(repoA);
    const lockPathA = baseRepoResetLockFilePath(lockDirA);
    writeRawLock(lockPathA, deadPid(), "dead-token", Date.now());
    let sawOwnLock = false;
    await withBaseRepoResetLease(
      repoA,
      async () => {
        const owner = JSON.parse(fs.readFileSync(lockPathA, "utf8")) as { pid: number };
        sawOwnLock = owner.pid === process.pid;
      },
      { timeoutMs: 2000 },
    );
    expect(sawOwnLock).toBe(true); // we replaced the dead holder
    expect(fs.existsSync(lockPathA)).toBe(false); // released on exit

    // (b) Live, fresh pid: the lock is NOT stolen; acquisition times out.
    const rootB = newTempRoot();
    const repoB = makeRepo(rootB, "live");
    const lockDirB = await resolveBaseRepoResetIdentity(repoB);
    const lockPathB = baseRepoResetLockFilePath(lockDirB);
    writeRawLock(lockPathB, process.pid, "foreign-live-token", Date.now());
    let stole = false;
    await expect(
      withBaseRepoResetLease(repoB, async () => {
        stole = true;
      }, { timeoutMs: 500, staleMs: 60_000 }),
    ).rejects.toBeInstanceOf(BaseRepoResetLeaseTimeout);
    expect(stole).toBe(false);
    const surviving = JSON.parse(fs.readFileSync(lockPathB, "utf8")) as { token: string };
    expect(surviving.token).toBe("foreign-live-token"); // untouched
  });

  it("recovers an unreadable (corrupt-owner) lock once it has aged, and never steals a fresh one", async () => {
    const root = newTempRoot();
    const repo = makeRepo(root, "corrupt");
    const lockDir = await resolveBaseRepoResetIdentity(repo);
    const lockPath = baseRepoResetLockFilePath(lockDir);

    // (a) Fresh corrupt lock: owner unparseable, mtime ~now. With a large
    //     staleMs the (mtime-derived) age is below the threshold, so the lock
    //     is treated as "held by an unknown, possibly-alive holder": we wait,
    //     and time out without touching it.
    fs.writeFileSync(lockPath, "not-valid-json", "utf8");
    let tookFresh = false;
    await expect(
      withBaseRepoResetLease(
        repo,
        async () => {
          tookFresh = true;
        },
        { timeoutMs: 300, staleMs: 60_000 },
      ),
    ).rejects.toBeInstanceOf(BaseRepoResetLeaseTimeout);
    expect(tookFresh).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true); // we never stole it

    // (b) The same corrupt lock, backdated well past staleMs: now it is safe
    //     to recover, and the caller takes it over.
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lockPath, old, old);
    const holder = await withBaseRepoResetLease(
      repo,
      async (lease) => lease.holderId,
      { timeoutMs: 2000, staleMs: 60_000 },
    );
    expect(holder.startsWith(`${process.pid}-`)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false); // released on exit
  });
});

describe("assertLease", () => {
  it("passes for a genuine lease covering the target repo, and rejects mismatches", async () => {
    const root = newTempRoot();
    const repo = makeRepo(root, "assert-repo");
    const other = makeRepo(root, "assert-other");

    const lease = await withBaseRepoResetLease(repo, async (l) => {
      // While we hold it, the lease covers `repo`.
      expect(() => assertLease(l, repo)).not.toThrow();
      // But not a different repository.
      expect(() => assertLease(l, other)).toThrow(BaseRepoResetLeaseMismatch);
      return l;
    });
    expect(lease.repoLockDir).toBe(await resolveBaseRepoResetIdentity(repo));
  });

  it("rejects a value that is not a BaseRepoResetLease (brand check, before any git call)", async () => {
    // The brand symbol is module-private, so this literal cannot satisfy the
    // type at compile time:
    // @ts-expect-error — missing the private brand key; not constructible outside the module
    const forged: BaseRepoResetLease = { repoLockDir: "/tmp/forged", holderId: "forged" };
    // And it is rejected at runtime before any git subprocess runs.
    expect(() => assertLease(forged, "/tmp/forged")).toThrow(BaseRepoResetLeaseMismatch);
  });
});
