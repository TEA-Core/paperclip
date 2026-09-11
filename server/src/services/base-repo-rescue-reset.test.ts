import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  BaseRepoIdentityUnresolved,
  BaseRepoResetLeaseMismatch,
  assertLease,
  resolveBaseRepoResetIdentity,
  withBaseRepoResetLease,
  type BaseRepoResetLease,
} from "./base-repo-reset-lease.js";
import {
  performBaseRepoRescueReset,
  prepareBaseRepoForWorkspace,
  resetBaseRepoToBaseRefWithRescue,
  resetProjectBaseRepoWithRescue,
} from "./workspace-runtime.js";

// SUP-15722 — re-seat the base-repo rescue reset onto the SUP-15721 cross-process
// lease, and prove the operator path and the auto self-heal contend correctly.
//
// P1: the operator reset and the auto `prepareBaseRepoForWorkspace` self-heal
//     contend on one repo; the on-disk lease serializes them — exactly one enters
//     the destructive section at a time — and the repo ends on the upstream tip.
// P2: the same serialization holds for two auto self-heals. This assertion is RED
//     against the pre-fix tree (no lease => both enter the section at once); the
//     captured pre-fix failure is cited in the delivery comment.
// P3: path aliases (a symlink and a linked worktree) of one repo converge on one
//     lease identity and serialize.
// P4: the destructive primitive cannot run without a lease — a direct call fails
//     to compile, a forged (non-branded) lease is refused before any git runs and
//     moves nothing, and the standalone wrapper serializes.
// P5: on a REAL, populated repo with a forced `rev-parse --git-common-dir`
//     failure, BOTH the operator and the auto self-heal refuse to move anything —
//     HEAD and every ref unchanged, zero pin/CAS/reset — and the lease refuses
//     before it creates any lockfile.

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// Deliberately captures the ambient PATH at module load so the test's own git
// calls use the REAL git even while a PATH shim is installed for the production
// code under test.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

async function commitFile(repo: string, name: string, message = name): Promise<void> {
  await fs.writeFile(path.join(repo, name), `${name}\n`);
  await git(["add", "-A"], repo);
  await git(["commit", "-qm", message], repo);
}

type Fixture = { root: string; origin: string; seed: string; work: string };

async function makeOriginAndClone(prefix: string): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");

  await git(["init", "-q", "--bare", "-b", "main", origin], root);
  await git(["init", "-q", "-b", "main", seed], root);
  for (const n of ["c1", "c2", "c3"]) await commitFile(seed, n);
  await git(["remote", "add", "origin", origin], seed);
  await git(["push", "-q", "origin", "main"], seed);
  await git(["clone", "-q", `file://${origin}`, work], root);

  return { root, origin, seed, work };
}

/**
 * Leave `work` ahead of `origin/main` by commits whose resulting file content is
 * already byte-identical at the upstream tip. This is the shape both the operator
 * reset and the auto self-heal will reset over.
 */
async function makeAheadByDuplicates(f: Fixture, count = 2): Promise<{ priorTip: string; originMain: string }> {
  const names: string[] = [];
  for (let i = 1; i <= count; i++) names.push(`dup${i}`);
  for (const name of names) await commitFile(f.work, name, `local ${name}`);
  for (const name of names) await commitFile(f.seed, name, `upstream ${name}`);
  await commitFile(f.seed, "c4");
  await git(["push", "-q", "origin", "main"], f.seed);
  await git(["fetch", "-q", "origin", "main"], f.work);
  return {
    priorTip: await git(["rev-parse", "HEAD"], f.work),
    originMain: await git(["rev-parse", "origin/main"], f.work),
  };
}

type Shim = {
  logFile: string;
  frozenMarker: string;
  release: () => Promise<void>;
  restore: () => void;
};

/**
 * Replace `git` on PATH with a shim that (1) logs every argv in order and
 * (2) BLOCKS the first destructive pin (`update-ref refs/paperclip/rescue/
 * base-repo/...`) until `release()` creates a gate file. The gate is a real
 * filesystem event, not a sleep: it freezes whichever contender reaches the
 * destructive section first while it holds the lease, so the test can observe
 * that the OTHER contender is blocked at the lock and has touched no git at all.
 */
async function installBarrierShim(f: Fixture): Promise<Shim> {
  const binDir = path.join(f.root, "shim");
  const logFile = path.join(f.root, "git-argv.log");
  const frozenMarker = path.join(f.root, "frozen");
  const gateFile = path.join(f.root, "gate");

  await fs.mkdir(binDir, { recursive: true });
  const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}`,
    "case \"$*\" in",
    "  *\"update-ref refs/paperclip/rescue/base-repo\"*)",
    `    if [ ! -f ${JSON.stringify(gateFile)} ]; then`,
    `      touch ${JSON.stringify(frozenMarker)}`,
    "      n=0",
    `      while [ ! -f ${JSON.stringify(gateFile)} ] && [ $n -lt 1200 ]; do sleep 0.05; n=$((n+1)); done`,
    "    fi",
    "    ;;",
    "esac",
    `exec ${JSON.stringify(realGit)} "$@"`,
    "",
  ].join("\n");
  await fs.writeFile(path.join(binDir, "git"), script);
  await fs.chmod(path.join(binDir, "git"), 0o755);

  const priorPath = process.env.PATH;
  process.env.PATH = `${binDir}:${priorPath ?? ""}`;
  return {
    logFile,
    frozenMarker,
    release: async () => {
      await fs.writeFile(gateFile, "go\n");
    },
    restore: () => {
      process.env.PATH = priorPath;
    },
  };
}

async function readLog(logFile: string): Promise<string[]> {
  const raw = await fs.readFile(logFile, "utf8").catch(() => "");
  return raw.split("\n").filter((line) => line.length > 0);
}

type IdShim = {
  logFile: string;
  restore: () => void;
};

/**
 * Replace `git` on PATH with a shim that fails ONLY `rev-parse
 * --git-common-dir` (exit 128, non-zero) and passes every other git invocation
 * through to the real git. That is exactly what the fail-closed lease keys on
 * (`resolveBaseRepoResetIdentity` -> `git rev-parse --git-common-dir`), so this
 * forces a genuine identity-resolution failure on a REAL, populated repository —
 * not an empty temp dir — while leaving all the other git the destructive paths
 * need (status, rev-parse HEAD, rev-list, for-each-ref) working. The operator and
 * auto paths must both refuse to move anything when identity cannot be resolved.
 */
async function installIdentityFailShim(f: Fixture): Promise<IdShim> {
  const binDir = path.join(f.root, "shim");
  const logFile = path.join(f.root, "git-argv.log");
  await fs.mkdir(binDir, { recursive: true });
  const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}`,
    "case \"$*\" in",
    "  *\"rev-parse --git-common-dir\"*)",
    "    echo \"fatal: [shim] forced identity-resolution failure\" >&2",
    "    exit 128",
    "    ;;",
    "esac",
    `exec ${JSON.stringify(realGit)} "$@"`,
    "",
  ].join("\n");
  await fs.writeFile(path.join(binDir, "git"), script);
  await fs.chmod(path.join(binDir, "git"), 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${binDir}:${priorPath ?? ""}`;
  return {
    logFile,
    restore: () => {
      process.env.PATH = priorPath;
    },
  };
}

// A pin is the atomic CREATE of a base-repo rescue ref, whose old value is the
// all-zeros constant. Requiring that constant in the match excludes a
// `update-ref -d` delete (prune housekeeping) and the `update-ref HEAD` CAS, so
// "exactly one pin" below is unambiguous — it counts only destructive tip pins.
const ALL_ZEROS = "0000000000000000000000000000000000000000";
const pinLines = (lines: string[]) =>
  lines.filter((l) => l.includes("refs/paperclip/rescue/base-repo") && l.includes(ALL_ZEROS));
const casLines = (lines: string[]) => lines.filter((l) => l.startsWith("update-ref HEAD"));
const resetLines = (lines: string[]) => lines.filter((l) => l.startsWith("reset --hard"));

async function waitForFile(file: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await delay(20);
  }
}

// Does a git object exist? Used to prove a prior tip was never made unreachable.
async function objectExists(repo: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["cat-file", "-e", sha], { cwd: repo, env: GIT_ENV });
    return true;
  } catch {
    return false;
  }
}

// Snapshot HEAD and every ref under refs/ so a test can assert nothing was moved.
async function snapshotHeadAndRefs(repo: string): Promise<{ head: string; refs: string }> {
  return {
    head: await git(["rev-parse", "HEAD"], repo),
    refs: await git(["for-each-ref", "--format=%(refname) %(objectname)"], repo),
  };
}

describe("P1 — operator reset and auto self-heal contend on the lease", () => {
  it("forces both contenders to the same pre-reset tip and proves exactly one destructive move lands", async () => {
    const f = await makeOriginAndClone("sup15722-p1-");
    const { priorTip, originMain } = await makeAheadByDuplicates(f);
    const shim = await installBarrierShim(f);
    try {
      const pOperator = resetProjectBaseRepoWithRescue({ repoRoot: f.work, baseRef: "origin/main" });
      const pAuto = prepareBaseRepoForWorkspace({ repoRoot: f.work, configuredBaseRef: "main" });
      void pOperator.catch(() => {});
      void pAuto.catch(() => {});

      // Deterministic barrier around capture: freeze whichever contender reaches
      // its destructive pin first. It holds the lease; the other is blocked at the
      // on-disk lease lock, so it has captured nothing, pinned nothing, and moved
      // nothing. At the frozen moment there is exactly one pin in flight and the
      // tip is still where it started.
      await waitForFile(shim.frozenMarker);
      const frozen = await readLog(shim.logFile);
      expect(pinLines(frozen)).toHaveLength(1);
      expect(casLines(frozen)).toEqual([]);
      expect(resetLines(frozen)).toEqual([]);
      expect(await git(["rev-parse", "HEAD"], f.work)).toBe(priorTip);

      await shim.release();
      const [operatorResult, autoResult] = await Promise.all([pOperator, pAuto]);

      // EXACTLY ONE destructive move happened across both contenders: one tip pin,
      // one CAS tip move, one reset --hard. This is the property the lease
      // changes. Pre-fix (no on-disk lease) both the operator and the auto path
      // capture the same tip and both pin/attempt-CAS/reset, so pinLines would be
      // 2 — the raw pre-fix red is cited in the delivery comment.
      const full = await readLog(shim.logFile);
      expect(pinLines(full)).toHaveLength(1);
      expect(casLines(full)).toHaveLength(1);
      expect(resetLines(full)).toHaveLength(1);

      // The repo ends on the upstream tip, and the newer tip is still reachable:
      // it is pinned by the single rescue ref and is a real git object — it was
      // never made unreachable.
      expect(await git(["rev-parse", "HEAD"], f.work)).toBe(originMain);
      expect(await objectExists(f.work, priorTip)).toBe(true);
      const pinnedRefs = (
        await git(["for-each-ref", "--format=%(objectname)", "refs/paperclip/rescue/base-repo"], f.work)
      ).split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      expect(pinnedRefs).toContain(priorTip);

      // Loser side-effects: whichever path lost the lease performed no destructive
      // move of its own — the winner either reset (operator: resetToSha) or, when
      // the auto won, saw the operator already at target. Exactly-one above proves
      // the loser touched nothing.
      expect(autoResult).toBeDefined();
      if (operatorResult.ok && !operatorResult.alreadyAtTarget) {
        expect(operatorResult.resetToSha).toBe(originMain);
        expect(operatorResult.previousTip).toBe(priorTip);
      }
    } finally {
      shim.restore();
    }
  });
});

describe("P2 — two auto self-heals serialize (pre-fix red, now green)", () => {
  it("serializes two concurrent prepareBaseRepoForWorkspace self-heals", async () => {
    const f = await makeOriginAndClone("sup15722-p2-");
    await makeAheadByDuplicates(f);
    const shim = await installBarrierShim(f);
    try {
      const p1 = prepareBaseRepoForWorkspace({ repoRoot: f.work, configuredBaseRef: "main" });
      const p2 = prepareBaseRepoForWorkspace({ repoRoot: f.work, configuredBaseRef: "main" });
      void p1.catch(() => {});
      void p2.catch(() => {});

      await waitForFile(shim.frozenMarker);
      // Pre-fix (no lease) both self-heals reach the pin at once and this count is
      // 2 — see the captured red in the SUP-15722 delivery comment. With the lease
      // exactly one is in the destructive section; the other waits at the lock.
      const frozen = await readLog(shim.logFile);
      expect(pinLines(frozen)).toHaveLength(1);
      expect(casLines(frozen)).toEqual([]);

      await shim.release();
      await Promise.all([p1, p2]);
      expect(await git(["rev-parse", "HEAD"], f.work)).toBe(await git(["rev-parse", "origin/main"], f.work));
      // Exactly one destructive move total: the winner pinned/moved/reset once and
      // the loser, re-reading state after the winner, saw it already self-healed.
      const full = await readLog(shim.logFile);
      expect(pinLines(full)).toHaveLength(1);
      expect(casLines(full)).toHaveLength(1);
      expect(resetLines(full)).toHaveLength(1);
    } finally {
      shim.restore();
    }
  });
});

describe("P3 — path aliases converge on one lease identity", () => {
  it("resolves a symlink alias, a relative path, and a linked worktree to the same lock identity", async () => {
    const f = await makeOriginAndClone("sup15722-p3a-");
    const link = path.join(f.root, "work-link");
    await fs.symlink(f.work, link, "dir");
    const wt = path.join(f.root, "linked-wt");
    await git(["worktree", "add", "-q", wt, "-b", "alias-branch"], f.work);

    const idWork = await resolveBaseRepoResetIdentity(f.work);
    expect(await resolveBaseRepoResetIdentity(link)).toBe(idWork);
    const rel = path.relative(process.cwd(), f.work);
    expect(await resolveBaseRepoResetIdentity(rel)).toBe(idWork);
    expect(await resolveBaseRepoResetIdentity(wt)).toBe(idWork);
  });

  it("serializes three operator resets issued through absolute, relative, and symlink aliases of one repo", async () => {
    const f = await makeOriginAndClone("sup15722-p3b-");
    await makeAheadByDuplicates(f);
    const link = path.join(f.root, "work-link");
    await fs.symlink(f.work, link, "dir");
    const rel = path.relative(process.cwd(), f.work);

    const shim = await installBarrierShim(f);
    try {
      const contenders = [f.work, rel, link].map((repoRoot) => {
        const p = resetProjectBaseRepoWithRescue({ repoRoot, baseRef: "origin/main" });
        void p.catch(() => {});
        return p;
      });

      await waitForFile(shim.frozenMarker);
      const frozen = await readLog(shim.logFile);
      expect(pinLines(frozen)).toHaveLength(1);
      expect(casLines(frozen)).toEqual([]);

      await shim.release();
      await Promise.all(contenders);
      expect(await git(["rev-parse", "HEAD"], f.work)).toBe(await git(["rev-parse", "origin/main"], f.work));
    } finally {
      shim.restore();
    }
  });
});

describe("P4 — the destructive primitive requires a real lease", () => {
  it("is a compile error to call the primitive without a lease", () => {
    // Never invoked: this exists only so the type checker proves the primitive
    // cannot be called without a `BaseRepoResetLease` it is unable to mint.
    const compileOnly = () => {
      // @ts-expect-error — `lease` is required; the destructive primitive cannot mint one.
      return performBaseRepoRescueReset({ repoRoot: "/nope", baseRef: "main", baseRefSha: "0".repeat(40), priorTip: "0".repeat(40), aheadCount: 0, operatorDirected: true });
    };
    expect(compileOnly).toBeTypeOf("function");
  });

  it("refuses a forged (non-branded) lease before any git runs and moves nothing", async () => {
    const f = await makeOriginAndClone("sup15722-p4b-");
    const { priorTip } = await makeAheadByDuplicates(f);
    const forged = { repoLockDir: "/tmp/whatever", holderId: "forged" } as unknown as BaseRepoResetLease;

    expect(() => assertLease(forged, f.work)).toThrow(BaseRepoResetLeaseMismatch);
    await expect(
      performBaseRepoRescueReset({
        repoRoot: f.work,
        baseRef: "origin/main",
        baseRefSha: priorTip,
        priorTip,
        aheadCount: 0,
        operatorDirected: true,
        lease: forged,
      }),
    ).rejects.toBeInstanceOf(BaseRepoResetLeaseMismatch);

    expect(await git(["rev-parse", "HEAD"], f.work)).toBe(priorTip);
    expect(await git(["for-each-ref", "refs/paperclip/rescue"], f.work)).toBe("");
  });

  it("serializes the standalone wrapper, and the stale second caller's CAS is refused", async () => {
    const f = await makeOriginAndClone("sup15722-p4c-");
    const { priorTip, originMain } = await makeAheadByDuplicates(f);
    const shim = await installBarrierShim(f);
    try {
      const call = () =>
        resetBaseRepoToBaseRefWithRescue({
          repoRoot: f.work,
          baseRef: "origin/main",
          baseRefSha: originMain,
          priorTip,
          aheadCount: 2,
        });
      const p1 = call();
      const p2 = call();
      void p1.catch(() => {});
      void p2.catch(() => {});

      await waitForFile(shim.frozenMarker);
      const frozen = await readLog(shim.logFile);
      expect(pinLines(frozen)).toHaveLength(1);
      expect(casLines(frozen)).toEqual([]);

      await shim.release();
      const settled = await Promise.allSettled([p1, p2]);
      const statuses = settled.map((s) => s.status).sort();
      // Exactly one reset landed; the stale caller's `update-ref HEAD` CAS lost and
      // was refused — the no-lost-update property the lease + CAS exist to give.
      expect(statuses).toEqual(["fulfilled", "rejected"]);
      expect(await git(["rev-parse", "HEAD"], f.work)).toBe(originMain);
    } finally {
      shim.restore();
    }
  });
});

describe("P5 — a forced identity-resolution failure refuses and moves nothing", () => {
  it("operator path on a real repo: reports identity_unresolved; HEAD and all refs unchanged, zero pin/CAS/reset", async () => {
    const f = await makeOriginAndClone("sup15722-p5a-");
    const { priorTip } = await makeAheadByDuplicates(f);
    const before = await snapshotHeadAndRefs(f.work);
    const shim = await installIdentityFailShim(f);
    try {
      const result = await resetProjectBaseRepoWithRescue({ repoRoot: f.work, baseRef: "origin/main" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("identity_unresolved");

      const after = await snapshotHeadAndRefs(f.work);
      expect(after.head).toBe(before.head);
      expect(after.refs).toBe(before.refs);
      expect(await git(["for-each-ref", "refs/paperclip/rescue"], f.work)).toBe("");

      const full = await readLog(shim.logFile);
      expect(pinLines(full)).toHaveLength(0);
      expect(casLines(full)).toHaveLength(0);
      expect(resetLines(full)).toHaveLength(0);
      // The prior tip is still a live object — nothing was orphaned.
      expect(await objectExists(f.work, priorTip)).toBe(true);
    } finally {
      shim.restore();
    }
  });

  it("auto path on a real repo: self-heal fails closed, preserves the repo; zero pin/CAS/reset", async () => {
    const f = await makeOriginAndClone("sup15722-p5b-");
    const { priorTip } = await makeAheadByDuplicates(f);
    const before = await snapshotHeadAndRefs(f.work);
    const shim = await installIdentityFailShim(f);
    try {
      const outcome = await prepareBaseRepoForWorkspace({ repoRoot: f.work, configuredBaseRef: "main" });
      // The auto path never throws out of the self-heal; it fails closed to the
      // "warn, preserve" path. Either way it must not have performed a reset.
      expect(outcome).toBeDefined();

      const after = await snapshotHeadAndRefs(f.work);
      // No destructive move: the tip is exactly where it was (the local branch is
      // untouched and no rescue ref was created). A successful self-heal would have
      // moved HEAD to origin/main and pinned the prior tip; neither happened.
      expect(after.head).toBe(priorTip);
      expect(after.refs).toBe(before.refs);
      expect(await git(["for-each-ref", "refs/paperclip/rescue"], f.work)).toBe("");

      const full = await readLog(shim.logFile);
      expect(pinLines(full)).toHaveLength(0);
      expect(casLines(full)).toHaveLength(0);
      expect(resetLines(full)).toHaveLength(0);
    } finally {
      shim.restore();
    }
  });

  it("withBaseRepoResetLease refuses before creating any lockfile", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sup15722-p5c-"));
    tempRoots.push(dir);
    let ran = false;
    await expect(
      withBaseRepoResetLease(dir, async () => {
        ran = true;
        return "unreachable";
      }),
    ).rejects.toBeInstanceOf(BaseRepoIdentityUnresolved);
    expect(ran).toBe(false);
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
