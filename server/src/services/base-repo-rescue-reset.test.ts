import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
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

// SUP-15722 R2 (finding: base-repo-contention-proof-not-distinguishing):
// the P1 proof now uses a deterministic CAPTURE barrier (gating `rev-parse HEAD`
// with caller identity via AsyncLocalStorage) instead of a pin-barrier that does
// not distinguish "the lease prevented the second capture" from "the second
// contender had not reached the pin yet." The capture barrier freezes each
// contender at the exact point it records the tip, making the pre-fix red
// (both contenders capture + pin the SAME stale tip) deterministic.
//
// P1: operator reset and auto self-heal contend on one repo. The capture barrier
//     records the tip each contender captured at the `rev-parse HEAD` point.
//     Post-fix the on-disk lease admits exactly one contender into the
//     destructive section; the auto is refused after the operator moves the tip.
//     Pre-fix (lease serialization disabled) BOTH contenders capture the SAME
//     stale tip and BOTH pin it: `pinLines` => 2. The exact pre-fix red command
//     + raw output is in the SUP-16430 delivery comment.
// P2: the same serialization holds for two auto self-heals (pin-barrier).
// P3: path aliases (symlink, relative, linked worktree) converge on one lease
//     identity and serialize. P3c proves a linked-worktree contender performs a
//     real destructive reset, not just an identity resolution.
// P4: the destructive primitive cannot run without a lease.
// P5: forced identity-resolution failure refuses and moves nothing.

const cap = vi.hoisted(() => {
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const { AsyncLocalStorage } = require("node:async_hooks");
  const als: import("node:async_hooks").AsyncLocalStorage<string | undefined> =
    new AsyncLocalStorage();
  return {
    als,
    log: [] as Array<{ identity: string; seq: number; sha: string }>,
    holdSet: {} as Record<string, Set<number>>,
    armedRepo: null as string | null,
    seqCounters: {} as Record<string, number>,
    releases: new Map<string, { promise: Promise<void>; resolve: () => void }>(),
    _EventEmitter: EventEmitter,
    _PassThrough: PassThrough,
    reset() {
      this.log.length = 0;
      this.holdSet = {};
      this.armedRepo = null;
      this.seqCounters = {};
      this.releases.clear();
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn(command: string, args: readonly string[] | undefined, options: any) {
      if (!cap.armedRepo) return original.spawn(command, args, options);
      const identity = cap.als.getStore();
      if (
        (identity === "operator" || identity === "auto") &&
        Array.isArray(args) &&
        args.length === 2 &&
        args[0] === "rev-parse" &&
        args[1] === "HEAD" &&
        options?.cwd &&
        path.resolve(options.cwd) === cap.armedRepo
      ) {
        const seq = (cap.seqCounters[identity] ?? 0) + 1;
        cap.seqCounters[identity] = seq;
        const realChild = original.spawn(command, args as string[], options);
        const shaPromise = new Promise<string>((resolve, reject) => {
          let data = "";
          realChild.stdout?.on("data", (chunk: any) => {
            data += String(chunk);
          });
          realChild.on("close", (code: number | null) => {
            if (code === 0) resolve(data.trim());
            else reject(new Error(`git rev-parse HEAD exited ${code}`));
          });
          realChild.on("error", reject);
        });
        const shouldHold = cap.holdSet[identity]?.has(seq) ?? false;
        if (shouldHold) {
          const fake = new cap._EventEmitter() as any;
          const stdoutStream = new cap._PassThrough();
          const stderrStream = new cap._PassThrough();
          fake.stdout = stdoutStream;
          fake.stderr = stderrStream;
          fake.pid = -1;
          const releaseKey = `${identity}:${seq}`;
          shaPromise.then(async (sha) => {
            cap.log.push({ identity, seq, sha });
            let releasePromise: Promise<void> | undefined;
            {
              const existing = cap.releases.get(releaseKey);
              if (existing) {
                releasePromise = existing.promise;
              } else {
                releasePromise = new Promise<void>((r) => {
                  cap.releases.set(releaseKey, { promise: releasePromise!, resolve: r });
                });
              }
            }
            await releasePromise;
            stdoutStream.write(sha + "\n");
            stdoutStream.end();
            fake.emit("close", 0);
          });
          return fake;
        }
        shaPromise.then((sha) => {
          cap.log.push({ identity, seq, sha });
        });
        return realChild;
      }
      return original.spawn(command, args, options);
    },
  };
});

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  cap.reset();
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

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
 * Leave `work` ahead of `origin/main` by commits whose file content is
 * byte-identical at the upstream tip. This is the shape both the operator
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

// A recording-only PATH shim: it logs every git argv for the whole test but
// never gates a call. P1 installs it once, before launching the contenders, and
// reads the SAME log before and after the release, so the frozen and post-settle
// observations cannot drift apart. (The deterministic freeze is the Node-level
// capture barrier, not this shim.)
async function installLogShim(f: Fixture): Promise<{ logFile: string; restore: () => void }> {
  const binDir = path.join(f.root, "log-shim");
  const logFile = path.join(f.root, "git-argv.log");
  await fs.mkdir(binDir, { recursive: true });
  const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}`,
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

async function readLog(logFile: string): Promise<string[]> {
  const raw = await fs.readFile(logFile, "utf8").catch(() => "");
  return raw.split("\n").filter((line) => line.length > 0);
}

type IdShim = {
  logFile: string;
  restore: () => void;
};

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

const ALL_ZEROS = "0000000000000000000000000000000000000000";
const pinLines = (lines: string[]) =>
  lines.filter((l) => l.includes("refs/paperclip/rescue/base-repo") && l.includes(ALL_ZEROS));
const casLines = (lines: string[]) => lines.filter((l) => l.startsWith("update-ref HEAD"));
const resetLines = (lines: string[]) => lines.filter((l) => l.startsWith("reset --hard"));

const capturedTips = (lines: string[]): string[] =>
  lines
    .map((line) => line.split(/\s+/))
    .filter((t) => t[0] === "update-ref" && t[3] === ALL_ZEROS && t[2]?.length === 40)
    .map((t) => t[2] as string);

async function waitForFile(file: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await delay(20);
  }
}

async function objectExists(repo: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["cat-file", "-e", sha], { cwd: repo, env: GIT_ENV });
    return true;
  } catch {
    return false;
  }
}

async function snapshotHeadAndRefs(repo: string): Promise<{ head: string; refs: string }> {
  return {
    head: await git(["rev-parse", "HEAD"], repo),
    refs: await git(["for-each-ref", "--format=%(refname) %(objectname)"], repo),
  };
}

// --- Capture barrier helpers (Node-level spawn mock + ALS) ---

function armCapture(repoRoot: string, holdSet: Record<string, number[]>): void {
  cap.armedRepo = path.resolve(repoRoot);
  cap.holdSet = {};
  for (const [identity, seqs] of Object.entries(holdSet)) {
    cap.holdSet[identity] = new Set(seqs);
  }
}

function releaseCapture(identity: string, seq: number): void {
  const key = `${identity}:${seq}`;
  const entry = cap.releases.get(key);
  if (entry) entry.resolve();
}

function waitForCapture(identity: string, seq: number, timeoutMs = 12000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<string>((resolve, reject) => {
    const check = async (): Promise<void> => {
      const entry = cap.log.find((e) => e.identity === identity && e.seq === seq);
      if (entry) {
        resolve(entry.sha);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for capture ${identity}:${seq}`));
        return;
      }
      await delay(10);
      await check();
    };
    void check();
  });
}

// --- P1 ---

describe("P1 — operator reset and auto self-heal contend on the lease", () => {
  it("capture barrier: exactly one contender captures and performs a destructive move", async () => {
    const f = await makeOriginAndClone("sup15722-p1-");
    const { priorTip, originMain } = await makeAheadByDuplicates(f);

    // One recording shim for the whole test, installed BEFORE the contenders are
    // launched, so the frozen read and the post-settle read come from the same
    // log. It only records argv; the deterministic freeze is the capture barrier.
    const shim = await installLogShim(f);
    try {
      // Arm the capture barrier: gate the operator's in-lease capture (seq1) and
      // the auto's in-lease capture (seq2). In GREEN the auto's seq2 is
      // unreachable (refused at the allUpstream check before it can capture); in
      // RED (lease passthrough) both contenders are held at their own capture.
      armCapture(f.work, { operator: [1], auto: [2] });

      const pOperator = cap.als.run("operator", () =>
        resetProjectBaseRepoWithRescue({ repoRoot: f.work, baseRef: "origin/main" }),
      );
      const pAuto = cap.als.run("auto", () =>
        prepareBaseRepoForWorkspace({ repoRoot: f.work, configuredBaseRef: "main" }),
      );
      void pOperator.catch(() => {});
      void pAuto.catch(() => {});

      // Wait for the operator's gated in-lease capture (seq1, line 4582) and the
      // auto's pre-lease observation (seq1, line 5262, passes through).
      const [opSha, autoPreSha] = await Promise.all([
        waitForCapture("operator", 1),
        waitForCapture("auto", 1),
      ]);

      // Both contenders observed the SAME stale prior tip.
      expect(opSha).toBe(priorTip);
      expect(autoPreSha).toBe(priorTip);

      // Frozen state: the operator holds the lease and is frozen BEFORE its pin;
      // the auto is blocked at the on-disk lease lock. NO pin, CAS, or reset has
      // occurred. This is the distinguishing assertion: the old pin-barrier test
      // asserted pinLines(frozen) === 1 (one pin reached the gate), which does
      // NOT prove the second contender was prevented from capturing. Here, ZERO
      // pins exist because neither contender has passed the capture point yet.
      const frozen = await readLog(shim.logFile);
      expect(pinLines(frozen)).toHaveLength(0);
      expect(casLines(frozen)).toEqual([]);
      expect(resetLines(frozen)).toEqual([]);
      expect(await git(["rev-parse", "HEAD"], f.work)).toBe(priorTip);

      // The auto never reached its own in-lease capture: the lease serialized it
      // behind the operator, and by the time it re-acquires the lease HEAD is the
      // upstream tip, so it is refused before capturing (and before pinning).
      expect(cap.log.some((e) => e.identity === "auto" && e.seq === 2)).toBe(false);

      // Release the operator's gated capture. The operator now pins, CASes,
      // resets, and releases the lease. The auto (unblocked) acquires the lease,
      // re-checks aheadCount (= 0, since HEAD is now originMain), and refuses.
      releaseCapture("operator", 1);
      const [operatorResult, autoResult] = await Promise.all([pOperator, pAuto]);

      // EXACTLY ONE destructive move: one pin, one CAS, one reset, all recorded
      // by the same shim. Pre-fix (lease passthrough) both contenders capture
      // and pin the same priorTip: pinLines would be 2 — the distinguishing red.
      const full = await readLog(shim.logFile);
      expect(pinLines(full)).toHaveLength(1);
      expect(casLines(full)).toHaveLength(1);
      expect(resetLines(full)).toHaveLength(1);

      // The pin recorded the stale prior tip.
      expect(capturedTips(pinLines(full))).toEqual([priorTip]);

      // The repo ends on the upstream tip; the stale tip is preserved.
      expect(await git(["rev-parse", "HEAD"], f.work)).toBe(originMain);
      expect(await objectExists(f.work, priorTip)).toBe(true);

      // Explicit winner/loser branches (no count-only inference): exactly one
      // contender performed a destructive reset; the other was refused.
      expect(operatorResult.ok).toBe(true);
      if (!operatorResult.ok) throw new Error("operator reset did not succeed");
      const autoDidReset = autoResult.warnings.some(
        (w) => w.includes("Auto reset: Base repository") && w.includes(" was reset to "),
      );
      const operatorDidReset = !operatorResult.alreadyAtTarget;
      expect([operatorDidReset, autoDidReset].filter(Boolean)).toHaveLength(1);
      if (operatorDidReset) {
        expect(operatorResult.resetToSha).toBe(originMain);
        expect(operatorResult.previousTip).toBe(priorTip);
        expect(autoDidReset).toBe(false);
      } else {
        expect(operatorResult.alreadyAtTarget).toBe(true);
        expect(autoDidReset).toBe(true);
      }
    } finally {
      shim.restore();
    }
  });
});

// --- P2 ---

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
      const frozen = await readLog(shim.logFile);
      expect(pinLines(frozen)).toHaveLength(1);
      expect(casLines(frozen)).toEqual([]);

      await shim.release();
      await Promise.all([p1, p2]);
      expect(await git(["rev-parse", "HEAD"], f.work)).toBe(await git(["rev-parse", "origin/main"], f.work));
      const full = await readLog(shim.logFile);
      expect(pinLines(full)).toHaveLength(1);
      expect(casLines(full)).toHaveLength(1);
      expect(resetLines(full)).toHaveLength(1);
    } finally {
      shim.restore();
    }
  });
});

// --- P3 ---

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

  it("P3c: a linked-worktree contender performs a real destructive reset alongside the main-branch contender", async () => {
    const f = await makeOriginAndClone("sup15722-p3c-");
    const { priorTip, originMain } = await makeAheadByDuplicates(f);
    // Create a linked worktree on a different branch, at the same priorTip.
    const wt = path.join(f.root, "linked-wt");
    await git(["worktree", "add", "-q", wt, "-b", "alias-branch"], f.work);
    // The linked worktree is at the same commit as main (priorTip).
    expect(await git(["rev-parse", "HEAD"], wt)).toBe(priorTip);

    const shim = await installBarrierShim(f);
    try {
      // Contender A: operator reset through the linked worktree (alias-branch).
      const pWorktree = resetProjectBaseRepoWithRescue({ repoRoot: wt, baseRef: "origin/main" });
      // Contender B: operator reset through the main branch (absolute path).
      const pMain = resetProjectBaseRepoWithRescue({ repoRoot: f.work, baseRef: "origin/main" });
      void pWorktree.catch(() => {});
      void pMain.catch(() => {});

      await waitForFile(shim.frozenMarker);
      const frozen = await readLog(shim.logFile);
      // Serialization: exactly one pin in-flight at the frozen moment.
      expect(pinLines(frozen)).toHaveLength(1);
      expect(casLines(frozen)).toEqual([]);

      await shim.release();
      const [wtResult, mainResult] = await Promise.all([pWorktree, pMain]);

      // Both contenders performed a destructive reset on their respective branches.
      expect(wtResult.ok).toBe(true);
      expect(mainResult.ok).toBe(true);
      if (wtResult.ok && !wtResult.alreadyAtTarget) {
        expect(wtResult.resetToSha).toBe(originMain);
        expect(wtResult.previousTip).toBe(priorTip);
      }
      if (mainResult.ok && !mainResult.alreadyAtTarget) {
        expect(mainResult.resetToSha).toBe(originMain);
        expect(mainResult.previousTip).toBe(priorTip);
      }

      // Both branches now point to originMain.
      expect(await git(["rev-parse", "HEAD"], f.work)).toBe(originMain);
      expect(await git(["rev-parse", "HEAD"], wt)).toBe(originMain);

      // The prior tip is still a live, reachable object.
      expect(await objectExists(f.work, priorTip)).toBe(true);
    } finally {
      shim.restore();
    }
  });
});

// --- P4 ---

describe("P4 — the destructive primitive requires a real lease", () => {
  it("is a compile error to call the primitive without a lease", () => {
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
      expect(statuses).toEqual(["fulfilled", "rejected"]);
      expect(await git(["rev-parse", "HEAD"], f.work)).toBe(originMain);
    } finally {
      shim.restore();
    }
  });
});

// --- P5 ---

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
      expect(outcome).toBeDefined();

      const after = await snapshotHeadAndRefs(f.work);
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
