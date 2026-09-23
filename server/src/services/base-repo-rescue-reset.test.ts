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
  type BaseRepoResetLeaseOptions,
} from "./base-repo-reset-lease.js";
import {
  performBaseRepoRescueReset,
  prepareBaseRepoForWorkspace,
  resetBaseRepoToBaseRefWithRescue,
  resetProjectBaseRepoWithRescue,
} from "./workspace-runtime.js";

// SUP-15722 R2 / SUP-17093 ruling §5 (amended P1 acceptance):
// the P1 proof uses a deterministic CAPTURE barrier (gating `rev-parse HEAD` with
// caller identity via AsyncLocalStorage). Both authoritative captures sit inside a
// mutually exclusive lease (`base-repo-reset-lease.ts:137-153`), and the operator
// has NO pre-lease HEAD read at all (`workspace-runtime.ts:4561-4582`), so a single
// orientation can never produce two same-tipped SHAs. §5 therefore splits P1 into
// three cooperating proofs:
//
// P1-α: operator-winner — the DISTINGUISHING proof. Both real callers hold the SAME
//       stale tip at the pre-destructive boundary: the operator's in-lease capture
//       (`:4582`) and the auto's pre-lease observation (`:5262`) are both frozen at
//       `priorTip` before any pin/CAS/reset. Exactly one destructive move lands; the
//       auto is explicitly refused non-destructively and never records its in-lease
//       capture (`:4367-4369` → `:5381`).
// P1-β: auto-winner — the lease ORDERS two real captures (`auto:2 === priorTip`,
//       `operator:1 === originMain`) and exactly one destructive move lands. It can
//       prove only that ordering: the operator contributes no pre-lease SHA, so the
//       same-tip proof is P1-α's, not P1-β's.
// P1-γ: lease-disabled red — an EXECUTING test (a test-only passthrough seam over
//       `withBaseRepoResetLease`) that proves the lease is load-bearing: with the
//       lock not held, BOTH in-lease captures read `priorTip` and `pinLines` === 2.
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
    // P1-γ (SUP-17093 ruling §5): when true, the mocked withBaseRepoResetLease
    // mints a genuine lease but does NOT hold the on-disk lock during the caller's
    // fn, so two real callers enter the destructive section concurrently. Default
    // false keeps every other test on the real, exclusive lease.
    leasePassthrough: false,
    _EventEmitter: EventEmitter,
    _PassThrough: PassThrough,
    reset() {
      this.log.length = 0;
      this.holdSet = {};
      this.armedRepo = null;
      this.seqCounters = {};
      this.releases.clear();
      this.leasePassthrough = false;
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

// SUP-17093 ruling §5 (P1-γ): a test-only seam that makes the lease-disabled red
// EXECUTE without touching any production file. Only `withBaseRepoResetLease` is
// wrapped; everything else (assertLease, resolveBaseRepoResetIdentity, the
// exception classes) is the real implementation, so `assertLease` inside
// `performBaseRepoRescueReset` stays a genuine fail-closed check. By default
// (`cap.leasePassthrough === false`) this is a no-op pass-through to the real
// exclusive lease, so P1-α/P1-β/P2/P3/P4/P5 are unaffected. When P1-γ sets
// `cap.leasePassthrough === true`, the wrapper mints a genuinely branded lease via
// the real acquire+release, then runs the caller's fn WITHOUT holding the on-disk
// lock — so a second real caller is not serialized and both enter the destructive
// section at once, reproducing the pre-fix red (two same-tip captures -> two pins).
vi.mock("./base-repo-reset-lease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./base-repo-reset-lease.js")>();
  return {
    ...actual,
    withBaseRepoResetLease: async <T>(
      repoRoot: string,
      fn: (lease: BaseRepoResetLease) => Promise<T>,
      options?: BaseRepoResetLeaseOptions,
    ): Promise<T> => {
      if (cap.leasePassthrough) {
        // Mint a genuine, branded lease through the real acquire+release (the lock
        // is held only for that brief mint), then run the caller's fn WITHOUT the
        // lock held, so a second caller is not serialized behind it.
        const minted = await actual.withBaseRepoResetLease(repoRoot, (lease) =>
          Promise.resolve(lease),
        );
        return fn(minted);
      }
      return actual.withBaseRepoResetLease(repoRoot, fn, options);
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

// Wait until a line satisfying `predicate` appears in a PATH-shim argv log. This is
// the log-observable that makes P1-α deterministic: it proves a contender actually
// issued a specific git call (e.g. the auto's pre-lease `rev-list --left-right
// --count`) before we are allowed to release the winner and let it move the tip.
async function waitForLogLine(
  logFile: string,
  predicate: (line: string) => boolean,
  timeoutMs = 20000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = await readLog(logFile);
    if (lines.some(predicate)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for a matching line in ${logFile}`);
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
//
// SUP-17093 ruling §5 (amended P1 acceptance). Both authoritative captures sit inside
// a mutually exclusive lease (`base-repo-reset-lease.ts:137-153`) and the operator
// has NO pre-lease HEAD read (`workspace-runtime.ts:4561-4582`), so no single
// orientation can ever produce two same-tipped SHAs. §5 therefore splits P1 into
// three cooperating proofs: P1-α (the distinguishing operator-winner barrier), P1-β
// (the auto-winner ordering, retained from the prior delivery), and P1-γ (the
// executing lease-disabled red).

describe("P1-α — operator-winner: both real callers hold the SAME stale tip at the pre-destructive boundary (the distinguishing proof)", () => {
  it("freezes the operator's in-lease capture (:4582) and the auto's pre-lease observation (:5262) at the same priorTip; one move lands, the auto is refused", async () => {
    const f = await makeOriginAndClone("sup15722-p1a-");
    const { priorTip, originMain } = await makeAheadByDuplicates(f);

    // One recording PATH shim for the whole test, installed BEFORE the contenders
    // launch, so the frozen read and the post-settle read come from the same log.
    // The deterministic freeze is the Node-level capture barrier, not this shim.
    const shim = await installLogShim(f);
    try {
      // §5 step 1: gate the operator's in-lease capture (:4582) and the auto's
      // pre-lease observation (:5262). Do NOT arm auto:[2] — in this orientation
      // the operator moves the tip first, so the auto's in-lease upstream gate
      // (`workspace-runtime.ts:4367-4369`) reports no ahead commits and the auto
      // refuses at `:5381` before ever reaching `:5382`; arming it would hang.
      armCapture(f.work, { operator: [1], auto: [1] });

      // §5 step 2: start the operator; it acquires the lease, then freezes at its
      // in-lease capture while still holding the lock.
      const pOperator = cap.als.run("operator", () =>
        resetProjectBaseRepoWithRescue({ repoRoot: f.work, baseRef: "origin/main" }),
      );
      void pOperator.catch(() => {});
      expect(await waitForCapture("operator", 1)).toBe(priorTip);

      // §5 step 3: start the auto; it freezes at its pre-lease read, having
      // contended for the same repo.
      const pAuto = cap.als.run("auto", () =>
        prepareBaseRepoForWorkspace({ repoRoot: f.work, configuredBaseRef: "main" }),
      );
      void pAuto.catch(() => {});
      expect(await waitForCapture("auto", 1)).toBe(priorTip);

      // §5 step 4 — the frozen-window barrier: both real callers are present, their
      // identities are distinct, BOTH hold the SAME stale tip, and ZERO destructive
      // moves have landed. This is the property no pin-only barrier could prove: it
      // freezes the two callers at the moment both have observed one shared tip,
      // before either can pin, verify, CAS, or reset.
      expect(cap.log).toHaveLength(2);
      expect(new Set(cap.log.map((e) => e.identity))).toEqual(new Set(["operator", "auto"]));
      expect(cap.log.every((e) => e.sha === priorTip)).toBe(true);
      const frozen = await readLog(shim.logFile);
      expect(pinLines(frozen)).toHaveLength(0);
      expect(casLines(frozen)).toEqual([]);
      expect(resetLines(frozen)).toEqual([]);
      expect(await git(["rev-parse", "HEAD"], f.work)).toBe(priorTip);

      // §5 step 5: release the auto first. It proceeds past its pre-lease read and
      // computes its divergence against the still-stale tip. Deterministically wait
      // for that pre-lease `rev-list --left-right --count` to be logged — proof the
      // auto observed HEAD=priorTip while the operator still held the lock — before
      // releasing the operator. Only then is the operator allowed to move the tip.
      releaseCapture("auto", 1);
      await waitForLogLine(
        shim.logFile,
        (line) => line.includes("rev-list") && line.includes("--left-right") && line.includes("--count"),
      );
      releaseCapture("operator", 1);

      const [operatorResult, autoResult] = await Promise.all([pOperator, pAuto]);

      // §5 step 6 — post-settle: exactly one destructive move; the stale tip is
      // pinned, the repo ends on the upstream tip, and the stale tip stays reachable.
      const full = await readLog(shim.logFile);
      expect(pinLines(full)).toHaveLength(1);
      expect(casLines(full)).toHaveLength(1);
      expect(resetLines(full)).toHaveLength(1);
      expect(capturedTips(pinLines(full))).toEqual([priorTip]);
      expect(await git(["rev-parse", "HEAD"], f.work)).toBe(originMain);
      expect(await objectExists(f.work, priorTip)).toBe(true);

      // §5 step 7 — the operator is the winner.
      expect(operatorResult.ok).toBe(true);
      if (!operatorResult.ok) throw new Error("operator reset did not succeed");
      expect(operatorResult.alreadyAtTarget).toBe(false);
      expect(operatorResult.previousTip).toBe(priorTip);

      // §5 step 8 — the auto is the explicit, non-destructive loser. It warns "Local
      // commits preserved — no reset performed." and performs NO reset. Its in-lease
      // capture never occurs: once the operator moved the tip, the in-lease upstream
      // gate reports no ahead commits (workspace-runtime.ts:4367-4369), so the auto
      // refuses at `:5381` and never reaches the in-lease `rev-parse HEAD` at `:5382`.
      expect(autoResult.warnings.some((w) => w.includes("Local commits preserved — no reset performed."))).toBe(true);
      expect(autoResult.warnings.some((w) => w.includes(" was reset to "))).toBe(false);
      // No auto seq-2 capture exists — the in-lease capture is structurally unreachable
      // in this orientation (workspace-runtime.ts:4367-4369 → :5381).
      expect(cap.log.some((e) => e.identity === "auto" && e.seq === 2)).toBe(false);
    } finally {
      shim.restore();
    }
  });
});

describe("P1-β — auto-winner: the lease ORDERS two real captures; exactly one destructive move lands", () => {
  it("auto captures the stale tip in-lease and resets; the operator is serialized behind the lock and refused as alreadyAtTarget", async () => {
    const f = await makeOriginAndClone("sup15722-p1b-");
    const { priorTip, originMain } = await makeAheadByDuplicates(f);

    // One recording shim for the whole test, installed BEFORE the contenders are
    // launched, so the frozen read and the post-settle read come from the same
    // log. It only records argv; the deterministic freeze is the capture barrier.
    const shim = await installLogShim(f);
    try {
      // Arm the capture barrier on the auto's two captures: the pre-lease
      // observation (auto seq1, `:5262`) and the authoritative in-lease capture
      // (auto seq2, `:5382`), plus the operator's in-lease capture (operator seq1,
      // `:4582`). Note the operator has NO pre-lease HEAD read (`:4561-4582` — it
      // acquires the lock and only then reads HEAD), so this orientation cannot
      // contribute a second stale-tip SHA: the auto captures `priorTip`, the
      // operator (serialized behind it) captures the post-move `originMain`. The
      // same-tip, distinguishing proof is P1-α's, not P1-β's; P1-β proves only
      // that the lease ORDERS two real captures and lands exactly one move.
      armCapture(f.work, { auto: [2], operator: [1] });

      // Deterministic winner = the auto. It is launched first, reaches the lease
      // and is frozen at its in-lease capture while still holding the lease.
      const pAuto = cap.als.run("auto", () =>
        prepareBaseRepoForWorkspace({ repoRoot: f.work, configuredBaseRef: "main" }),
      );
      void pAuto.catch(() => {});

      // auto:1 is the pre-lease observation (`:5262`); auto:2 is the authoritative
      // in-lease capture (`:5382`). Both read the stale tip.
      const [autoPreSha, autoLeaseSha] = await Promise.all([
        waitForCapture("auto", 1),
        waitForCapture("auto", 2),
      ]);
      expect(autoPreSha).toBe(priorTip);
      expect(autoLeaseSha).toBe(priorTip);

      // Frozen state: the auto holds the lease and is frozen AFTER its
      // authoritative capture and BEFORE its pin. ZERO pins exist — neither
      // contender has entered the destructive section.
      const frozen = await readLog(shim.logFile);
      expect(pinLines(frozen)).toHaveLength(0);
      expect(casLines(frozen)).toEqual([]);
      expect(resetLines(frozen)).toEqual([]);
      expect(await git(["rev-parse", "HEAD"], f.work)).toBe(priorTip);

      // The operator now contends and is serialized behind the auto's lease: it
      // blocks at lease acquisition (`:4561`) before reaching its own capture.
      const pOperator = cap.als.run("operator", () =>
        resetProjectBaseRepoWithRescue({ repoRoot: f.work, baseRef: "origin/main" }),
      );
      void pOperator.catch(() => {});

      // Let the auto perform the ONE destructive move and release the lease.
      releaseCapture("auto", 2);

      // The operator then acquires the lease and records its OWN in-lease capture
      // (seq1, `:4582`). It observes the upstream tip because the auto already
      // moved HEAD, so it is refused as alreadyAtTarget — the complementary,
      // non-destructive loser.
      const operatorLeaseSha = await waitForCapture("operator", 1);
      expect(operatorLeaseSha).toBe(originMain);
      releaseCapture("operator", 1);

      const [autoResult, operatorResult] = await Promise.all([pAuto, pOperator]);

      // The lease ordered two real captures: the auto's in-lease capture is the
      // stale tip, the operator's in-lease capture is the post-move tip.
      expect(cap.log.some((e) => e.identity === "auto" && e.seq === 2 && e.sha === priorTip)).toBe(true);
      expect(cap.log.some((e) => e.identity === "operator" && e.seq === 1 && e.sha === originMain)).toBe(true);

      // EXACTLY ONE destructive move: one pin, one CAS, one reset, all recorded
      // by the same shim.
      const full = await readLog(shim.logFile);
      expect(pinLines(full)).toHaveLength(1);
      expect(casLines(full)).toHaveLength(1);
      expect(resetLines(full)).toHaveLength(1);

      // The pin recorded the stale prior tip.
      expect(capturedTips(pinLines(full))).toEqual([priorTip]);

      // The repo ends on the upstream tip; the stale tip is preserved.
      expect(await git(["rev-parse", "HEAD"], f.work)).toBe(originMain);
      expect(await objectExists(f.work, priorTip)).toBe(true);

      // Explicit winner/loser branches (no count-only inference): the auto
      // performed the destructive reset; the operator was refused as
      // alreadyAtTarget and moved nothing.
      const autoDidReset = autoResult.warnings.some(
        (w) => w.includes("Auto reset: Base repository") && w.includes(" was reset to "),
      );
      expect(autoDidReset).toBe(true);
      expect(operatorResult.ok).toBe(true);
      if (!operatorResult.ok) throw new Error("operator reset did not succeed");
      expect(operatorResult.alreadyAtTarget).toBe(true);
      expect(operatorResult.previousTip).toBeNull();
      expect([autoDidReset, !operatorResult.alreadyAtTarget].filter(Boolean)).toHaveLength(1);
    } finally {
      shim.restore();
    }
  });
});

describe("P1-γ — the lease-disabled red is an executing test: without the lock, both in-lease captures read the same stale tip and both pin it", () => {
  it("with the on-disk lease disabled, both in-lease captures read priorTip and pinLines === 2", async () => {
    const f = await makeOriginAndClone("sup15722-p1g-");
    const { priorTip } = await makeAheadByDuplicates(f);

    const shim = await installLogShim(f);
    try {
      // Test-only seam (SUP-17093 §5 P1-γ): mint a genuine lease but do NOT hold
      // the on-disk lock during the caller's fn, so both real callers enter the
      // destructive section concurrently — the pre-fix shape. `assertLease` stays
      // a real check because the lease object is genuinely branded and
      // repo-identical; no production file is touched.
      cap.leasePassthrough = true;

      // Gate BOTH in-lease captures: the operator's (`:4582`) and the auto's
      // (`:5382`). Neither pins until released, so the frozen window is a true
      // same-tip barrier. (The operator is frozen at `:4582`, before its CAS, so
      // the auto's in-lease upstream gate still sees the stale tip and reaches
      // `:5382`.)
      armCapture(f.work, { operator: [1], auto: [2] });

      const pOperator = cap.als.run("operator", () =>
        resetProjectBaseRepoWithRescue({ repoRoot: f.work, baseRef: "origin/main" }),
      );
      void pOperator.catch(() => {});
      const pAuto = cap.als.run("auto", () =>
        prepareBaseRepoForWorkspace({ repoRoot: f.work, configuredBaseRef: "main" }),
      );
      void pAuto.catch(() => {});

      // Both in-lease captures read the SAME stale tip, before either pin.
      expect(await waitForCapture("operator", 1)).toBe(priorTip);
      expect(await waitForCapture("auto", 2)).toBe(priorTip);

      // Frozen: two same-tip in-lease captures, ZERO pins, HEAD still the stale tip.
      const frozen = await readLog(shim.logFile);
      expect(pinLines(frozen)).toHaveLength(0);
      expect(await git(["rev-parse", "HEAD"], f.work)).toBe(priorTip);

      // Release both: both pin the SAME stale tip -> TWO pins. This is the
      // distinguishing red: without the lease, the two same-tip captures produce
      // two destructive pins, so the lease is load-bearing.
      releaseCapture("operator", 1);
      releaseCapture("auto", 2);
      await Promise.allSettled([pOperator, pAuto]);

      const full = await readLog(shim.logFile);
      expect(pinLines(full)).toHaveLength(2);
      expect(capturedTips(pinLines(full)).filter((sha) => sha === priorTip)).toHaveLength(2);
      // Both in-lease captures were recorded at the same stale tip by the barrier.
      expect(cap.log.some((e) => e.identity === "operator" && e.seq === 1 && e.sha === priorTip)).toBe(true);
      expect(cap.log.some((e) => e.identity === "auto" && e.seq === 2 && e.sha === priorTip)).toBe(true);
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

  it("P3c: a linked-worktree contender lands the single destructive move and a path alias of the same repo is refused", async () => {
    const f = await makeOriginAndClone("sup15722-p3c-");
    const { priorTip, originMain } = await makeAheadByDuplicates(f);
    // A linked worktree on its own branch, created at the same priorTip. Calling
    // the operator reset through it exercises the real linked-worktree identity
    // path (`git rev-parse --git-common-dir`), not just identity resolution.
    const wt = path.join(f.root, "linked-wt");
    await git(["worktree", "add", "-q", wt, "-b", "alias-branch"], f.work);
    expect(await git(["rev-parse", "HEAD"], wt)).toBe(priorTip);

    // The second contender addresses the SAME repo (the linked worktree) through
    // a symlink alias, so both contenders contend over the identical ref
    // (alias-branch). Exactly one destructive move can land.
    const wtLink = path.join(f.root, "linked-wt-link");
    await fs.symlink(wt, wtLink, "dir");
    expect(await git(["rev-parse", "HEAD"], wtLink)).toBe(priorTip);

    const shim = await installLogShim(f);
    try {
      // Deterministically make the linked-worktree contender the winner: gate
      // its authoritative in-lease capture (operator seq1, line 4582). The alias
      // contender is serialized behind the lease at acquisition (line 4561).
      armCapture(wt, { operator: [1] });

      const pWorktree = cap.als.run("operator", () =>
        resetProjectBaseRepoWithRescue({ repoRoot: wt, baseRef: "origin/main" }),
      );
      void pWorktree.catch(() => {});
      expect(await waitForCapture("operator", 1)).toBe(priorTip);

      // Frozen: the linked-worktree contender holds the lease with ZERO moves
      // landed; the alias contender is blocked at lease acquisition. Serialized,
      // not interleaved.
      const frozen = await readLog(shim.logFile);
      expect(pinLines(frozen)).toHaveLength(0);
      expect(casLines(frozen)).toEqual([]);
      expect(resetLines(frozen)).toEqual([]);
      expect(await git(["rev-parse", "HEAD"], wt)).toBe(priorTip);

      const pAlias = cap.als.run("operator", () =>
        resetProjectBaseRepoWithRescue({ repoRoot: wtLink, baseRef: "origin/main" }),
      );
      void pAlias.catch(() => {});

      releaseCapture("operator", 1);
      const [wtResult, aliasResult] = await Promise.all([pWorktree, pAlias]);

      // EXACTLY ONE destructive move across both contenders: one pin, one CAS,
      // one reset on the one ref both of them target.
      const full = await readLog(shim.logFile);
      expect(pinLines(full)).toHaveLength(1);
      expect(casLines(full)).toHaveLength(1);
      expect(resetLines(full)).toHaveLength(1);
      expect(capturedTips(pinLines(full))).toEqual([priorTip]);

      // Complementary results: the linked-worktree contender performed the
      // destructive reset; the alias contender was refused non-destructively.
      expect(wtResult.ok).toBe(true);
      if (!wtResult.ok) throw new Error("linked-worktree reset did not succeed");
      expect(wtResult.alreadyAtTarget).toBe(false);
      expect(wtResult.resetToSha).toBe(originMain);
      expect(wtResult.previousTip).toBe(priorTip);
      expect(aliasResult.ok).toBe(true);
      if (!aliasResult.ok) throw new Error("alias reset did not succeed");
      expect(aliasResult.alreadyAtTarget).toBe(true);
      expect(aliasResult.previousTip).toBeNull();

      // Both views of the linked worktree now sit on the upstream tip; the main
      // worktree was never touched, and the prior tip stays reachable.
      expect(await git(["rev-parse", "HEAD"], wt)).toBe(originMain);
      expect(await git(["rev-parse", "HEAD"], wtLink)).toBe(originMain);
      expect(await git(["rev-parse", "HEAD"], f.work)).toBe(priorTip);
      expect(await objectExists(wt, priorTip)).toBe(true);
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
