import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HardenedGitError,
  IGNORED_ARTIFACT_DIRECTORY_NAMES,
  LEGACY_WORKTREE_GIT_OPTIONS,
  normalizeBaseBranch,
  otherCardIdentifiers,
  probeNoRepositoryWorktree,
  recheckRecordedWorktree,
  resolveTrustedGitBinary,
  runHardenedGit,
} from "./hardened-git-probe.js";

/**
 * Test seam for a mid-check swap: when `swapOnOpen` names a path, the first
 * `open` of that path runs `swap` first, so the file the probe saw as regular
 * at its `lstat` is something else by the time it opens it. Every other call
 * goes straight to the real module.
 */
const fsControl = vi.hoisted(() => ({ swapOnOpen: null as null | { path: string; swap: () => void } }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      const pending = fsControl.swapOnOpen;
      if (pending && String(args[0]) === pending.path) {
        fsControl.swapOnOpen = null;
        pending.swap();
      }
      return actual.open(...args);
    },
  };
});

// Real repositories, real git: every planted program writes a marker file, so
// "did not execute" is observed rather than assumed.

const fixtureEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: os.tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    env: fixtureEnv,
    stdio: "pipe",
  }).toString().trim();
}

// Peak growth of memory held outside the JS heap (every Buffer) while `run`
// executes, sampled between awaits: a whole file read into memory shows up as
// its size, a streamed copy as a few chunks.
async function peakBufferGrowth<T>(run: () => Promise<T>): Promise<{ result: T; growth: number }> {
  const baseline = process.memoryUsage().arrayBuffers;
  let peak = baseline;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().arrayBuffers);
  }, 1);
  try {
    const result = await run();
    return { result, growth: peak - baseline };
  } finally {
    clearInterval(sampler);
  }
}

const MIB = 1024 * 1024;

let root: string;
let marker: string;
let planted: string;

function plantProgram(name: string): string {
  const program = path.join(root, name);
  writeFileSync(program, `#!/bin/sh\necho fired >> '${marker}'\ncat\n`);
  chmodSync(program, 0o755);
  return program;
}

function makeStatDirty(file: string) {
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(file, past, past);
}

/** A standalone repository with one committed file. */
function plainRepo(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "hello\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-qm", "init");
  return dir;
}

interface ManagedLayout {
  origin: string;
  seed: string;
  repoRoot: string;
  worktree: string;
  addWorktree: (branch: string, base?: string) => string;
  input: {
    recordedWorktreePath: string;
    managedProjectRoot: string;
    issueIdentifier: string;
    projectBranches: ReadonlySet<string>;
    attributedBranches: ReadonlySet<string>;
    existingOtherCardIdentifiers: (candidates: readonly string[]) => Promise<ReadonlySet<string>>;
    countCommitsAheadOfBase: (sha: string) => Promise<number>;
  };
}

/**
 * Stands in for GitHub's compare API: commits ahead of the default branch,
 * counted in the bare "origin" repository — a repository the agent's worktree
 * cannot write. A commit origin has never seen throws, as GitHub's 404 does.
 */
function countOnOrigin(origin: string, baseBranch = "main") {
  return async (sha: string) => Number.parseInt(git(origin, "rev-list", "--count", `${baseBranch}..${sha}`), 10);
}

/**
 * The managed layout the server provisions:
 * <instance>/projects/<company>/<project>/<repo>/.paperclip/worktrees/<branch>,
 * cloned from a bare "origin", whose main branch is the base.
 */
function managedLayout(): ManagedLayout {
  const origin = path.join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const seed = plainRepo("seed");
  git(seed, "push", "-q", origin, "main");
  const managedProjectRoot = path.join(root, "instances", "default", "projects", "company-1", "project-1");
  mkdirSync(managedProjectRoot, { recursive: true });
  const repoRoot = path.join(managedProjectRoot, "paperclip");
  git(managedProjectRoot, "clone", "-q", origin, repoRoot);
  const addWorktree = (branch: string, base = "origin/main") => {
    const worktree = path.join(repoRoot, ".paperclip", "worktrees", branch);
    git(repoRoot, "worktree", "add", "-q", "-b", branch, worktree, base);
    return worktree;
  };
  const worktree = addWorktree("SUP-7-record-ruling");
  return {
    origin,
    seed,
    repoRoot,
    worktree,
    addWorktree,
    input: {
      recordedWorktreePath: worktree,
      managedProjectRoot,
      issueIdentifier: "SUP-7",
      projectBranches: new Set(["main"]),
      attributedBranches: new Set<string>(),
      existingOtherCardIdentifiers: async () => new Set<string>(),
      countCommitsAheadOfBase: countOnOrigin(origin),
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "paperclip-hardened-git-"));
  marker = path.join(root, "marker");
  planted = plantProgram("planted.sh");
});

afterEach(() => {
  fsControl.swapOnOpen = null;
  rmSync(root, { recursive: true, force: true });
});

describe("hardened git runner (SUP-22880)", () => {
  it("runs a root-owned git from a fixed system path, never a PATH lookup", async () => {
    const binary = resolveTrustedGitBinary();
    expect(binary).not.toBeNull();
    expect(path.isAbsolute(binary!)).toBe(true);

    const hostileBin = path.join(root, "bin");
    mkdirSync(hostileBin);
    writeFileSync(path.join(hostileBin, "git"), `#!/bin/sh\necho fired >> '${marker}'\n`);
    chmodSync(path.join(hostileBin, "git"), 0o755);
    const repo = plainRepo("repo");
    const previousPath = process.env.PATH;
    process.env.PATH = `${hostileBin}:${previousPath}`;
    try {
      expect((await runHardenedGit(["-C", repo, "rev-parse", "--is-inside-work-tree"], { cwd: "/" })).trim()).toBe("true");
    } finally {
      process.env.PATH = previousPath;
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("kills a git process that blocks reading repository config, instead of hanging the close", async () => {
    const repo = plainRepo("repo");
    const fifo = path.join(root, "blocking-include");
    execFileSync("mkfifo", [fifo]);
    git(repo, "config", "include.path", fifo);
    const started = Date.now();
    await expect(runHardenedGit(["-C", repo, "config", "--list"], { cwd: "/", timeoutMs: 500 }))
      .rejects.toMatchObject({ kind: "timeout" } satisfies Partial<HardenedGitError>);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  // A real process tree: whether the kernel delivered the group kill can only be
  // observed on the platform, so the check polls /proc until a short deadline.
  function isLiveProcess(pid: number): boolean {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
    } catch {
      return false;
    }
  }

  async function exitsWithin(pid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (isLiveProcess(pid)) {
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return true;
  }

  it("kills the whole process group when the timeout fires, so nothing git started outlives it", async () => {
    const repo = plainRepo("repo");
    const pidFile = path.join(root, "grandchild.pid");
    const started = Date.now();
    await expect(runHardenedGit(
      ["-C", repo, "-c", `alias.linger=!sh -c 'sleep 60 & echo $! > ${pidFile}; wait'`, "linger"],
      { cwd: "/", timeoutMs: 1_000 },
    )).rejects.toMatchObject({ kind: "timeout" } satisfies Partial<HardenedGitError>);
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    expect(Number.isInteger(pid)).toBe(true);
    expect(await exitsWithin(pid, 2_000), `grandchild ${pid} outlived the timeout`).toBe(true);
  });

  it("gives each process only the time left on a shared deadline, so spent time is not given back", async () => {
    const repo = plainRepo("repo");
    const deadline = { at: performance.now() + 60_000, expired: false };
    const args = ["-C", repo, "rev-parse", "--is-inside-work-tree"];
    expect((await runHardenedGit(args, { cwd: "/", deadline })).trim()).toBe("true");
    expect(deadline.expired).toBe(false);

    deadline.at = performance.now() - 1;
    await expect(runHardenedGit(args, { cwd: "/", deadline }))
      .rejects.toMatchObject({ kind: "timeout" } satisfies Partial<HardenedGitError>);
    expect(deadline.expired).toBe(true);
  });

  it("kills a process still running when the shared deadline passes, marking the deadline expired", async () => {
    const repo = plainRepo("repo");
    const fifo = path.join(root, "blocking-include");
    execFileSync("mkfifo", [fifo]);
    git(repo, "config", "include.path", fifo);
    const deadline = { at: performance.now() + 500, expired: false };
    await expect(runHardenedGit(["-C", repo, "config", "--list"], { cwd: "/", deadline }))
      .rejects.toMatchObject({ kind: "timeout" } satisfies Partial<HardenedGitError>);
    expect(deadline.expired).toBe(true);
  });
});

// The pre-existing repository_delivery dirty probe is `git status --porcelain`
// through this runner under the options done-transition-guard.ts runGit uses;
// the guard-level wiring is driven in done-transition-guard-legacy-worktree-probes.test.ts.
const WORKTREE_STATUS_OPTIONS = LEGACY_WORKTREE_GIT_OPTIONS;
async function worktreeStatus(repo: string): Promise<string> {
  return runHardenedGit(["-C", repo, "status", "--porcelain"], WORKTREE_STATUS_OPTIONS);
}

describe("pre-existing repository_delivery status probe under the hardened runner (SUP-22880)", () => {
  it("reports dirt without executing a planted core.fsmonitor", async () => {
    const repo = plainRepo("repo");
    git(repo, "config", "core.fsmonitor", planted);
    writeFileSync(path.join(repo, "a.txt"), "undelivered\n");
    expect(await worktreeStatus(repo)).toContain("a.txt");
    expect(existsSync(marker)).toBe(false);
  });

  it("does not execute what an include.path target configures as fsmonitor", async () => {
    const repo = plainRepo("repo");
    const included = path.join(root, "included.cfg");
    writeFileSync(included, `[core]\n\tfsmonitor = ${planted}\n`);
    git(repo, "config", "include.path", included);
    writeFileSync(path.join(repo, "b.txt"), "untracked\n");
    expect(await worktreeStatus(repo)).toContain("b.txt");
    expect(existsSync(marker)).toBe(false);
  });

  it("does not run hooks from a planted core.hooksPath", async () => {
    const repo = plainRepo("repo");
    const hooks = path.join(root, "hooks");
    mkdirSync(hooks);
    for (const hook of ["post-index-change", "reference-transaction", "pre-commit"]) {
      writeFileSync(path.join(hooks, hook), `#!/bin/sh\necho fired >> '${marker}'\n`);
      chmodSync(path.join(hooks, hook), 0o755);
    }
    git(repo, "config", "core.hooksPath", hooks);
    writeFileSync(path.join(repo, "b.txt"), "untracked\n");
    expect(await worktreeStatus(repo)).toContain("b.txt");
    expect(existsSync(marker)).toBe(false);
  });

  it("reports a clean worktree as empty output", async () => {
    expect(await worktreeStatus(plainRepo("repo"))).toBe("");
  });

  it("ignores GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE inherited by the server process", async () => {
    const dirty = plainRepo("dirty");
    writeFileSync(path.join(dirty, "a.txt"), "undelivered\n");
    const clean = plainRepo("clean");
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE, index: process.env.GIT_INDEX_FILE };
    process.env.GIT_DIR = path.join(clean, ".git");
    process.env.GIT_WORK_TREE = clean;
    process.env.GIT_INDEX_FILE = path.join(clean, ".git", "index");
    try {
      expect(await worktreeStatus(dirty)).toContain("a.txt");
    } finally {
      for (const [key, value] of [["GIT_DIR", saved.dir], ["GIT_WORK_TREE", saved.tree], ["GIT_INDEX_FILE", saved.index]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  describe("keeps the server's own git configuration, so a dubiously owned workspace is still measured", () => {
    // GIT_TEST_ASSUME_DIFFERENT_OWNER makes git treat every repository as owned
    // by another uid, the state a workspace shared across uids is in. The host's
    // own system/global git config is shut out by default: CI images ship
    // `safe.directory = *`, which would mark every repository safe.
    async function withEnv<T>(overrides: Record<string, string>, fn: () => Promise<T>): Promise<T> {
      const vars = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...overrides };
      const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
      Object.assign(process.env, vars);
      try {
        return await fn();
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }

    it("refuses to read the workspace when nothing marks it safe", async () => {
      const repo = plainRepo("repo");
      writeFileSync(path.join(repo, "a.txt"), "undelivered\n");
      await withEnv({ GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" }, async () => {
        await expect(worktreeStatus(repo)).rejects.toMatchObject({ kind: "failed" } satisfies Partial<HardenedGitError>);
      });
    });

    it("measures it when safe.directory is supplied through GIT_CONFIG_COUNT/KEY/VALUE", async () => {
      const repo = plainRepo("repo");
      writeFileSync(path.join(repo, "a.txt"), "undelivered\n");
      await withEnv(
        {
          GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "safe.directory",
          GIT_CONFIG_VALUE_0: repo,
        },
        async () => {
          expect(await worktreeStatus(repo)).toContain("a.txt");
        },
      );
    });

    it("measures it when safe.directory is supplied through global git configuration", async () => {
      const repo = plainRepo("repo");
      writeFileSync(path.join(repo, "a.txt"), "undelivered\n");
      const globalConfig = path.join(root, "global.gitconfig");
      writeFileSync(globalConfig, `[safe]\n\tdirectory = ${repo}\n`);
      await withEnv({ GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", GIT_CONFIG_GLOBAL: globalConfig }, async () => {
        expect(await worktreeStatus(repo)).toContain("a.txt");
      });
    });

    it("leaves the close-gating runner fully stripped of that inherited configuration", async () => {
      await withEnv(
        { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "/inherited/path" },
        async () => {
          expect(await runHardenedGit(["config", "--get-all", "safe.directory"], WORKTREE_STATUS_OPTIONS)).toContain("/inherited/path");
          await expect(runHardenedGit(["config", "--get-all", "safe.directory"], { cwd: "/" }))
            .rejects.toMatchObject({ kind: "failed" } satisfies Partial<HardenedGitError>);
        },
      );
    });
  });
});

describe("normalizeBaseBranch", () => {
  it.each([
    ["main", "main"],
    [" main ", "main"],
    ["origin/main", "main"],
    ["fold/tea-patches-v2026.722.0", "fold/tea-patches-v2026.722.0"],
    ["origin/fold/tea-patches-v2026.722.0", "fold/tea-patches-v2026.722.0"],
  ])("reduces %j to %j", (ref, expected) => {
    expect(normalizeBaseBranch(ref)).toBe(expected);
  });

  it.each([
    ["refs/heads/main"],
    ["refs/remotes/origin/main"],
    ["origin/refs/heads/main"],
    ["origin/refs/remotes/origin/main"],
    ["HEAD"],
    ["origin/HEAD"],
    ["origin/"],
    ["-main"],
    ["main/"],
    ["/main"],
    ["a..b"],
    ["main.lock"],
    ["ma in"],
    [""],
    [null],
    [undefined],
  ])("refuses %j", (ref) => {
    expect(normalizeBaseBranch(ref as string | null | undefined)).toBeNull();
  });
});

describe("probeNoRepositoryWorktree (SUP-22570 record_only close)", () => {
  it("accepts the issue's own clean worktree with zero commits ahead of the default branch on the remote", async () => {
    const layout = managedLayout();
    const result = await probeNoRepositoryWorktree(layout.input);
    expect(result).toMatchObject({ ok: true, branch: "SUP-7-record-ruling" });
  });

  it("keeps a record_only close available when another registered card has stashed work", async () => {
    const layout = managedLayout();
    const otherBranch = "SUP-8-other-card";
    const other = layout.addWorktree(otherBranch);
    writeFileSync(path.join(other, "a.txt"), "other card's work\n");
    git(other, "stash", "push", "-qm", "other card draft");
    const result = await probeNoRepositoryWorktree({ ...layout.input, attributedBranches: new Set([otherBranch]) });
    expect(result).toMatchObject({ ok: true, branch: "SUP-7-record-ruling" });
  });

  it("refuses this card's stash even when another card's stash is on top", async () => {
    const layout = managedLayout();
    writeFileSync(path.join(layout.worktree, "a.txt"), "this card's work\n");
    git(layout.worktree, "stash", "push", "-qm", "this card draft");
    const otherBranch = "SUP-8-other-card";
    const other = layout.addWorktree(otherBranch);
    writeFileSync(path.join(other, "a.txt"), "other card's work\n");
    git(other, "stash", "push", "-qm", "other card draft");
    expect(await probeNoRepositoryWorktree({ ...layout.input, attributedBranches: new Set([otherBranch]) })).toMatchObject({ ok: false });
  });

  // Repository-local configuration the server must never run, and must not let
  // make the form unavailable: a clean, level worktree still closes.
  it.each([
    ["core.fsmonitor", (worktree: string) => git(worktree, "config", "core.fsmonitor", planted)],
    ["core.hooksPath", (worktree: string) => {
      const hooks = path.join(root, "hooks");
      mkdirSync(hooks);
      for (const hook of ["post-index-change", "reference-transaction"]) {
        writeFileSync(path.join(hooks, hook), `#!/bin/sh\necho fired >> '${marker}'\n`);
        chmodSync(path.join(hooks, hook), 0o755);
      }
      git(worktree, "config", "core.hooksPath", hooks);
    }],
    ["filter driver", (worktree: string) => {
      writeFileSync(path.join(worktree, ".gitattributes"), "* filter=evil\n");
      git(worktree, "add", ".gitattributes");
      git(worktree, "commit", "-qm", "attributes");
      git(worktree, "push", "-q", "origin", "HEAD:main");
      git(worktree, "config", "filter.evil.clean", planted);
      git(worktree, "config", "filter.evil.process", planted);
      git(worktree, "config", "filter.evil.required", "true");
    }],
    ["include.path", (worktree: string) => {
      const included = path.join(root, "included.cfg");
      writeFileSync(included, `[core]\n\tfsmonitor = ${planted}\n[filter "evil"]\n\tclean = ${planted}\n`);
      git(worktree, "config", "include.path", included);
    }],
    ["includeIf", (worktree: string) => {
      const included = path.join(root, "included-if.cfg");
      writeFileSync(included, `[core]\n\tfsmonitor = ${planted}\n[filter "evil"]\n\tclean = ${planted}\n`);
      git(worktree, "config", `includeIf.gitdir:${root}/.path`, included);
      git(worktree, "config", "includeIf.onbranch:SUP-7**.path", included);
    }],
  ])("does not execute a planted %s, and does not make a clean worktree unclosable", async (_label, plant) => {
    const layout = managedLayout();
    plant(layout.worktree);
    makeStatDirty(path.join(layout.worktree, "a.txt"));
    const result = await probeNoRepositoryWorktree(layout.input);
    expect(result).toMatchObject({ ok: true });
    expect(existsSync(marker)).toBe(false);
  });

  // A promisor remote in the (agent-writable) repository configuration turns a
  // missing object into a fetch, and a fetch runs the configured transport
  // helper. The branch ref names an object that does not exist, so reading HEAD
  // would trigger it.
  describe("lazy fetch from a promisor remote written into the repository configuration", () => {
    const MISSING_OBJECT = "1234567890abcdef1234567890abcdef12345678";

    it.each([
      ["remote.<name>.uploadpack on a local-path remote", (layout: ManagedLayout, program: string) =>
        `[remote "evil"]\n\turl = ${layout.origin}\n\tpromisor = true\n\tuploadpack = ${program}\n`],
      ["core.sshCommand on an ssh:// remote", (_layout: ManagedLayout, program: string) =>
        `[core]\n\tsshCommand = ${program}\n[remote "evil"]\n\turl = ssh://evil.example.invalid/repo.git\n\tpromisor = true\n`],
    ])("does not run %s when the issue branch names a missing object, and refuses the close", async (_label, remoteConfig) => {
      const layout = managedLayout();
      const program = path.join(root, "planted-transport.sh");
      writeFileSync(program, `#!/bin/sh\necho fired >> '${marker}'\nexit 1\n`);
      chmodSync(program, 0o755);
      appendFileSync(
        path.join(layout.repoRoot, ".git", "config"),
        `[core]\n\trepositoryformatversion = 1\n[extensions]\n\tpartialClone = evil\n${remoteConfig(layout, program)}`,
      );
      writeFileSync(path.join(layout.repoRoot, ".git", "refs", "heads", "SUP-7-record-ruling"), `${MISSING_OBJECT}\n`);

      const result = await probeNoRepositoryWorktree(layout.input);

      expect(result).toEqual({ ok: false, reason: "the recorded worktree has no HEAD commit" });
      expect(existsSync(marker)).toBe(false);
    });
  });

  it("measures the real work tree, not the decoy a planted core.worktree points at", async () => {
    const layout = managedLayout();
    const decoy = path.join(root, "decoy");
    mkdirSync(decoy);
    writeFileSync(path.join(decoy, "a.txt"), "hello\n");
    writeFileSync(path.join(layout.worktree, "a.txt"), "undelivered\n");
    git(layout.worktree, "config", "core.worktree", decoy);
    const result = await probeNoRepositoryWorktree(layout.input);
    expect(result.ok).toBe(false);
  });

  it("refuses a bare repository at the recorded path (rev-parse exits 0 and prints false)", async () => {
    const layout = managedLayout();
    const bare = path.join(layout.repoRoot, ".paperclip", "worktrees", "SUP-7-bare");
    git(root, "init", "-q", "--bare", bare);
    const result = await probeNoRepositoryWorktree({ ...layout.input, recordedWorktreePath: bare });
    expect(result).toEqual({ ok: false, reason: "the recorded worktree is a bare repository" });
  });

  const OUTSIDE_LAYOUT = "the recorded worktree path is outside the project's managed worktree directory";
  it.each([
    ["the managed checkout's .git directory", (layout: ManagedLayout) => path.join(layout.repoRoot, ".git"), OUTSIDE_LAYOUT],
    ["a clean repository outside the managed project root", () => plainRepo("elsewhere"), OUTSIDE_LAYOUT],
    ["a non-Git directory inside the managed worktree directory", (layout: ManagedLayout) => {
      const dir = path.join(layout.repoRoot, ".paperclip", "worktrees", "SUP-7-plain-dir");
      mkdirSync(dir, { recursive: true });
      return dir;
    }, "the recorded worktree is not a Git work tree"],
    ["a symlink inside the worktree directory pointing at a clean repository elsewhere", (layout: ManagedLayout) => {
      const link = path.join(layout.repoRoot, ".paperclip", "worktrees", "SUP-7-link");
      symlinkSync(plainRepo("link-target"), link);
      return link;
    }, OUTSIDE_LAYOUT],
    ["the managed checkout itself", (layout: ManagedLayout) => layout.repoRoot, OUTSIDE_LAYOUT],
    ["a standalone clone placed in the worktree directory", (layout: ManagedLayout) => {
      const clone = path.join(layout.repoRoot, ".paperclip", "worktrees", "SUP-7-clone");
      git(root, "clone", "-q", layout.origin, clone);
      git(clone, "checkout", "-q", "-b", "SUP-7-clone");
      return clone;
    }, "the recorded worktree is not a linked worktree of the managed checkout"],
  ])("refuses a recorded path that is %s", async (_label, recordedPath, reason) => {
    const layout = managedLayout();
    const result = await probeNoRepositoryWorktree({ ...layout.input, recordedWorktreePath: recordedPath(layout) });
    expect(result).toEqual({ ok: false, reason });
  });

  // A clean linked worktree inside the managed project root but outside
  // `<repo>/.paperclip/worktrees`, while the issue's real worktree holds the
  // work on a renamed branch.
  it("refuses a clean linked worktree under the managed root whose path skips .paperclip", async () => {
    const layout = managedLayout();
    writeFileSync(path.join(layout.worktree, "a.txt"), "undelivered\n");
    git(layout.worktree, "branch", "-m", "hidden");
    const alternate = path.join(layout.repoRoot, "elsewhere", "worktrees", "SUP-7-alt");
    git(layout.repoRoot, "worktree", "add", "-q", "-b", "SUP-7-alt", alternate, "origin/main");
    const result = await probeNoRepositoryWorktree({ ...layout.input, recordedWorktreePath: alternate });
    expect(result).toEqual({ ok: false, reason: OUTSIDE_LAYOUT });
  });

  it("refuses a clean worktree of a sibling issue in the same project", async () => {
    const layout = managedLayout();
    const sibling = layout.addWorktree("SUP-71-other-card");
    const result = await probeNoRepositoryWorktree({ ...layout.input, recordedWorktreePath: sibling });
    expect(result).toEqual({ ok: false, reason: "the recorded worktree's branch does not name SUP-7" });
  });

  it("refuses skip-worktree and assume-unchanged entries that hide a modification", async () => {
    const skip = managedLayout();
    writeFileSync(path.join(skip.worktree, "a.txt"), "undelivered\n");
    git(skip.worktree, "update-index", "--skip-worktree", "a.txt");
    expect(await probeNoRepositoryWorktree(skip.input)).toEqual({
      ok: false,
      reason: "the recorded worktree has skip-worktree index entries",
    });

    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    const assume = managedLayout();
    writeFileSync(path.join(assume.worktree, "a.txt"), "undelivered\n");
    git(assume.worktree, "update-index", "--assume-unchanged", "a.txt");
    expect(await probeNoRepositoryWorktree(assume.input)).toEqual({
      ok: false,
      reason: "the recorded worktree has assume-unchanged index entries",
    });
  });

  it("refuses a worktree in the middle of a conflicted merge as unmerged, not as assume-unchanged", async () => {
    const layout = managedLayout();
    git(layout.worktree, "checkout", "-q", "-b", "other");
    writeFileSync(path.join(layout.worktree, "a.txt"), "other\n");
    git(layout.worktree, "add", "a.txt");
    git(layout.worktree, "commit", "-qm", "other");
    git(layout.worktree, "checkout", "-q", "SUP-7-record-ruling");
    writeFileSync(path.join(layout.worktree, "a.txt"), "mine\n");
    git(layout.worktree, "add", "a.txt");
    git(layout.worktree, "commit", "-qm", "mine");
    expect(() => git(layout.worktree, "merge", "other")).toThrow();
    expect(git(layout.worktree, "ls-files", "--unmerged")).not.toBe("");
    expect(await probeNoRepositoryWorktree(layout.input)).toEqual({
      ok: false,
      reason: "the recorded worktree has unmerged index entries",
    });
  });

  it("refuses unmerged index entries in another worktree naming the issue", async () => {
    const layout = managedLayout();
    // Unmerged entries without a divergent commit, so the branch stays level with
    // the base and the worktree scan, not the tip comparison, is what refuses.
    const blob = (content: string) => {
      const file = path.join(root, "blob.txt");
      writeFileSync(file, content);
      return git(layout.worktree, "hash-object", "-w", file);
    };
    git(layout.worktree, "update-index", "--force-remove", "a.txt");
    execFileSync("git", ["-C", layout.worktree, "update-index", "--index-info"], {
      env: fixtureEnv,
      input: [["1", "base"], ["2", "mine"], ["3", "other"]]
        .map(([stage, content]) => `100644 ${blob(`${content}\n`)} ${stage}\ta.txt\n`)
        .join(""),
    });
    expect(git(layout.worktree, "ls-files", "--unmerged")).not.toBe("");
    const fabricated = layout.addWorktree("SUP-7-fresh");
    expect(await probeNoRepositoryWorktree({ ...layout.input, recordedWorktreePath: fabricated })).toEqual({
      ok: false,
      reason: "another worktree on branch SUP-7-record-ruling has unmerged index entries",
    });
  });

  it.each([
    ["a modified file", (worktree: string) => writeFileSync(path.join(worktree, "a.txt"), "undelivered\n")],
    ["a staged file", (worktree: string) => {
      writeFileSync(path.join(worktree, "b.txt"), "staged\n");
      git(worktree, "add", "b.txt");
    }],
    ["an untracked file", (worktree: string) => writeFileSync(path.join(worktree, "b.txt"), "untracked\n")],
  ])("refuses %s", async (_label, dirty) => {
    const layout = managedLayout();
    dirty(layout.worktree);
    expect(await probeNoRepositoryWorktree(layout.input)).toEqual({
      ok: false,
      reason: "the recorded worktree has uncommitted changes (modified, staged or untracked)",
    });
  });

  it("refuses untracked work hidden by info/exclude rules the server did not write", async () => {
    const layout = managedLayout();
    writeFileSync(path.join(layout.repoRoot, ".git", "info", "exclude"), "/.paperclip-repositories/\nnotes/\n");
    mkdirSync(path.join(layout.worktree, "notes"));
    writeFileSync(path.join(layout.worktree, "notes", "deliverable.md"), "undelivered\n");
    expect(await probeNoRepositoryWorktree(layout.input)).toEqual({
      ok: false,
      reason: "the recorded worktree has info/exclude ignore rules the server did not write",
    });
  });

  // The managed checkout's info/exclude is shared by every linked worktree:
  // `git rev-parse --git-path info/exclude` in a worktree names the common dir's
  // file, and the heartbeat appends its line there. A line counts as written by
  // the server only when it is byte-for-byte that line.
  describe("info/exclude in the managed checkout's common dir (SUP-24849)", () => {
    const SERVER_LINE = "/.paperclip-repositories/";
    const NOT_WRITTEN = {
      ok: false,
      reason: "the recorded worktree has info/exclude ignore rules the server did not write",
    } as const;

    /** The shared exclude file, resolved the way the heartbeat resolves it. */
    function sharedExclude(layout: ManagedLayout): string {
      const file = path.resolve(layout.worktree, git(layout.worktree, "rev-parse", "--git-path", "info/exclude"));
      expect(file).toBe(path.join(layout.repoRoot, ".git", "info", "exclude"));
      return file;
    }

    it("accepts a non-shallow, clean, zero-ahead linked worktree whose shared exclude holds the server's line", async () => {
      const layout = managedLayout();
      const file = sharedExclude(layout);
      expect(readFileSync(file, "utf8")).toMatch(/^#/);
      // Two heartbeats preparing at once both miss the line and both append it.
      appendFileSync(file, `\n${SERVER_LINE}\n`);
      appendFileSync(file, `\n${SERVER_LINE}\n`);
      mkdirSync(path.join(layout.worktree, ".paperclip-repositories", "other"), { recursive: true });
      writeFileSync(path.join(layout.worktree, ".paperclip-repositories", "other", "README.md"), "a referenced repository\n");
      expect(git(layout.worktree, "rev-parse", "--is-shallow-repository")).toBe("false");
      expect(await probeNoRepositoryWorktree(layout.input)).toMatchObject({ ok: true, branch: "SUP-7-record-ruling" });
    });

    it.each([
      ["is empty", ""],
      ["holds only comments and blank lines", "# a comment\n\n#another\n"],
    ])("accepts a shared exclude that %s", async (_label, content) => {
      const layout = managedLayout();
      writeFileSync(sharedExclude(layout), content);
      expect(await probeNoRepositoryWorktree(layout.input)).toMatchObject({ ok: true });
    });

    it.each([
      ["an agent-authored rule beside the server's line", `${SERVER_LINE}\nnotes/\n`],
      ["the server's line with a trailing space", `${SERVER_LINE} \n`],
      ["the server's line in a different case", "/.Paperclip-Repositories/\n"],
      ["the server's line with an extra path segment", "/.paperclip-repositories/extra/\n"],
      ["the server's line negated", `!${SERVER_LINE}\n`],
      ["the server's line with a CRLF ending", `${SERVER_LINE}\r\n`],
      ["an indented comment, which Git reads as a rule", `${SERVER_LINE}\n  # notes/\n`],
      ["a whitespace-only line", `${SERVER_LINE}\n \t\n`],
    ])("refuses %s", async (_label, content) => {
      const layout = managedLayout();
      writeFileSync(sharedExclude(layout), content);
      expect(await probeNoRepositoryWorktree(layout.input)).toEqual(NOT_WRITTEN);
    });

    // Git keeps leading whitespace, so this is a different rule: it ignores a
    // `.paperclip-repositories` directory under a directory named by two spaces.
    // The exclude check names it before any ignored entry is looked at.
    it("refuses the server's line indented, as an exclude rule rather than as the work it ignores", async () => {
      const layout = managedLayout();
      writeFileSync(sharedExclude(layout), `  ${SERVER_LINE}\n`);
      mkdirSync(path.join(layout.worktree, "  ", ".paperclip-repositories"), { recursive: true });
      writeFileSync(path.join(layout.worktree, "  ", ".paperclip-repositories", "deliverable.md"), "undelivered\n");
      expect(git(layout.worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
      expect(await probeNoRepositoryWorktree(layout.input)).toEqual(NOT_WRITTEN);
    });

    // A live shared exclude seen in production: the git template, then rules an
    // agent harness (Claude Code's `# claude-code-runtime` block) and a person
    // appended. No Paperclip operation writes these, so the close refuses; the
    // recovery is an operator cleanup of the file, not a wider allowlist, since
    // an agent-side rule could hide undelivered work from the clean-tree check.
    it("refuses agent-harness and hand-made rules in the shared exclude, even with the server's line present", async () => {
      const layout = managedLayout();
      const file = sharedExclude(layout);
      const agentAndHandMade = [
        "# claude-code-runtime",
        "**/.claude/scheduled_tasks.lock",
        "**/.claude/scheduled_tasks.json",
        "**/.claude/routines/.state/",
        "**/.claude/worktrees/",
        "**/.claude/checkpoints/",
        "**/.claude/mailbox/",
        "**/.claude/agent-registry.json",
        "**/.claude/agent-memory-local",
        "**/.claude/first-run",
        "**/.claude/assistant-daemon-state.json",
        "node_modules.broken-nodeuser/",
      ].join("\n");
      appendFileSync(file, `${agentAndHandMade}\n`);
      mkdirSync(path.join(layout.worktree, ".claude", "worktrees"), { recursive: true });
      writeFileSync(path.join(layout.worktree, ".claude", "worktrees", "deliverable.md"), "undelivered\n");
      expect(git(layout.worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
      expect(await probeNoRepositoryWorktree(layout.input)).toEqual(NOT_WRITTEN);
      appendFileSync(file, `\n${SERVER_LINE}\n`);
      expect(await probeNoRepositoryWorktree(layout.input)).toEqual(NOT_WRITTEN);
    });
  });

  describe("ignored entries (ignored-file dirt)", () => {
    const ignoredEntry = (entry: string) => ({
      ok: false,
      reason: `the recorded worktree has an ignored entry outside the regenerated-artefact directories (${JSON.stringify(entry)})`,
    });

    function writeTree(worktree: string, relative: string, content = "x\n") {
      mkdirSync(path.dirname(path.join(worktree, relative)), { recursive: true });
      writeFileSync(path.join(worktree, relative), content);
    }

    /** Commits the ignore rules and the tracked files a real checkout has, and pushes them as the base. */
    function trackIgnoreRules(layout: ManagedLayout, rules: string, trackedFiles: string[] = []) {
      writeFileSync(path.join(layout.worktree, ".gitignore"), rules);
      for (const file of trackedFiles) writeTree(layout.worktree, file, "{}\n");
      git(layout.worktree, "add", ".gitignore", ...trackedFiles);
      git(layout.worktree, "commit", "-qm", "ignore rules");
      git(layout.worktree, "push", "-q", "origin", "HEAD:main");
    }

    it("refuses a directory whose own untracked .gitignore ignores everything, which status reads as clean", async () => {
      const layout = managedLayout();
      writeTree(layout.worktree, "hidden/.gitignore", "*\n");
      writeTree(layout.worktree, "hidden/work.txt", "undelivered\n");
      expect(git(layout.worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
      expect(await probeNoRepositoryWorktree(layout.input)).toEqual(ignoredEntry("hidden/"));
    });

    it("refuses it in another worktree naming the issue", async () => {
      const layout = managedLayout();
      writeTree(layout.worktree, "hidden/.gitignore", "*\n");
      writeTree(layout.worktree, "hidden/work.txt", "undelivered\n");
      const fabricated = layout.addWorktree("SUP-7-fresh");
      const result = await probeNoRepositoryWorktree({ ...layout.input, recordedWorktreePath: fabricated });
      expect(result).toEqual({
        ok: false,
        reason: 'another worktree on branch SUP-7-record-ruling has an ignored entry outside the regenerated-artefact directories ("hidden/")',
      });
    });

    it.each([
      ["a plain file at the root", "*.log\n", [], "debug.log", "debug.log"],
      ["a plain file at depth", "*.log\n", ["docs/notes/README.md"], "docs/notes/debug.log", "docs/notes/debug.log"],
      ["a file under a directory that is not on the list", "notes/\n", [], "notes/deliverable.md", "notes/"],
      ["a file the list's names do not cover", "build.txt\n", [], "build.txt", "build.txt"],
    ])("refuses an ignored entry that is %s", async (_label, rules, tracked, file, entry) => {
      const layout = managedLayout();
      trackIgnoreRules(layout, rules, tracked);
      writeTree(layout.worktree, file, "undelivered\n");
      expect(await probeNoRepositoryWorktree(layout.input)).toEqual(ignoredEntry(entry));
    });

    it("accepts a root node_modules with content, without inspecting it", async () => {
      const layout = managedLayout();
      trackIgnoreRules(layout, "node_modules/\n");
      writeTree(layout.worktree, "node_modules/pkg/index.js", "module.exports = 1;\n");
      writeTree(layout.worktree, "node_modules/pkg/.gitignore", "*\n");
      expect(await probeNoRepositoryWorktree(layout.input)).toMatchObject({ ok: true });
    });

    it("accepts a pnpm monorepo's installed and built tree at every depth", async () => {
      const layout = managedLayout();
      trackIgnoreRules(
        layout,
        "node_modules\n**/node_modules/\ndist/\n.paperclip/\n.paperclip-runtime/\n",
        ["server/package.json", "ui/package.json", "packages/x/package.json"],
      );
      for (const file of [
        "node_modules/.modules.yaml",
        "server/node_modules/pkg/index.js",
        "ui/node_modules/pkg/index.js",
        "packages/x/node_modules/pkg/index.js",
        "packages/x/dist/index.js",
        ".paperclip/config.json",
        ".paperclip-runtime/claude/state.json",
      ]) {
        writeTree(layout.worktree, file);
      }
      expect(await probeNoRepositoryWorktree(layout.input)).toMatchObject({ ok: true });
    });

    it("accepts the .paperclip-repositories directory the server excludes through info/exclude", async () => {
      const layout = managedLayout();
      writeFileSync(path.join(layout.repoRoot, ".git", "info", "exclude"), "/.paperclip-repositories/\n");
      writeTree(layout.worktree, ".paperclip-repositories/other/README.md", "a referenced repository\n");
      expect(await probeNoRepositoryWorktree(layout.input)).toMatchObject({ ok: true });
    });

    it.each([
      ["a symlink named node_modules at the root", "node_modules\n", (worktree: string) => {
        mkdirSync(path.join(root, "stash"));
        writeFileSync(path.join(root, "stash", "deliverable.md"), "undelivered\n");
        symlinkSync(path.join(root, "stash"), path.join(worktree, "node_modules"));
      }, "node_modules"],
      ["a nested symlinked node_modules", "node_modules\n", (worktree: string) => {
        mkdirSync(path.join(root, "stash"));
        symlinkSync(path.join(root, "stash"), path.join(worktree, "server", "node_modules"));
      }, "server/node_modules"],
    ])("refuses %s", async (_label, rules, plant, entry) => {
      const layout = managedLayout();
      trackIgnoreRules(layout, rules, ["server/package.json"]);
      plant(layout.worktree);
      expect(await probeNoRepositoryWorktree(layout.input)).toEqual(ignoredEntry(entry));
    });

    // An untracked or modified ignore file must not be what makes a listed name
    // ignored: a committed rule (or the server's exclude line) has to.
    it.each([
      ["target at the root", [], "target/.gitignore", "target/work.md", "target/"],
      [".paperclip at the root", [], ".paperclip/.gitignore", ".paperclip/work.md", ".paperclip/"],
      ["node_modules under a tracked directory", ["server/package.json"], "server/node_modules/.gitignore", "server/node_modules/work.md", "server/node_modules/"],
    ])("refuses %s that only its own untracked .gitignore ignores", async (_label, tracked, ignoreFile, work, entry) => {
      const layout = managedLayout();
      trackIgnoreRules(layout, "*.log\n", tracked);
      writeTree(layout.worktree, ignoreFile, "*\n");
      writeTree(layout.worktree, work, "undelivered\n");
      expect(git(layout.worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
      expect(await probeNoRepositoryWorktree(layout.input)).toEqual({
        ok: false,
        reason: `the recorded worktree has a regenerated-artefact directory that no committed ignore rule ignores (${JSON.stringify(entry)})`,
      });
    });

    it("pins the allowlist to exactly these thirteen names", () => {
      expect([...IGNORED_ARTIFACT_DIRECTORY_NAMES].sort()).toEqual([
        ".next", ".paperclip", ".paperclip-repositories", ".paperclip-runtime", ".pnpm-store", ".turbo", ".venv",
        "__pycache__", "build", "coverage", "dist", "node_modules", "target",
      ]);
    });

    it.each(["data", "out", "tmp", "logs"])("refuses an ignored %s directory, which is not on the list", async (name) => {
      const layout = managedLayout();
      trackIgnoreRules(layout, `${name}/\n`);
      writeTree(layout.worktree, `${name}/state.bin`, "undelivered\n");
      expect(await probeNoRepositoryWorktree(layout.input)).toEqual(ignoredEntry(`${name}/`));
    });
  });

  describe("other cards named by the recorded worktree's branch", () => {
    it.each([
      ["SUP-7-OTHER-999", "OTHER-999"],
      ["SUP-7-after-SUP-70", "SUP-70"],
      ["SUP-7-from-sup-70", "SUP-70"],
      ["SUP-7-XSUP-7", "XSUP-7"],
    ])("refuses branch %s, which also names %s", async (branch, other) => {
      const layout = managedLayout();
      const worktree = layout.addWorktree(branch);
      expect(await probeNoRepositoryWorktree({ ...layout.input, recordedWorktreePath: worktree })).toEqual({
        ok: false,
        reason: `the recorded worktree's branch ${branch} also names another card (${other})`,
      });
    });

    it("permits an explicitly authorized source card while still refusing an unrelated card", async () => {
      const layout = managedLayout();
      const branch = "SUP-7-recover-SUP-70-after-OTHER-999";
      const worktree = layout.addWorktree(branch);
      expect(await probeNoRepositoryWorktree({
        ...layout.input,
        recordedWorktreePath: worktree,
        permittedOtherCardIdentifiers: new Set(["SUP-70"]),
      })).toEqual({
        ok: false,
        reason: `the recorded worktree's branch ${branch} also names another card (OTHER-999)`,
      });
    });

    // The default branch is the identifier and the lower-cased issue title, so
    // a word-number token from a title names no card.
    it.each([
      "sup-7-notes-v2",
      "SUP-7-iso-8601-dates",
      "SUP-7-ISO-8601-dates",
      "SUP-7-decide-phase-2-scope",
      "SUP-7-sprint-12-retro",
      "SUP-7-q3-2026-planning",
      "SUP-7-upgrade-node-20",
    ])("accepts branch %s, which names only this card", async (branch) => {
      const layout = managedLayout();
      const worktree = layout.addWorktree(branch);
      expect(await probeNoRepositoryWorktree({ ...layout.input, recordedWorktreePath: worktree })).toMatchObject({ ok: true });
    });

    // A standard name is exempt except under this card's own prefix.
    it.each([
      ["ISO-7-after-iso-9", "ISO-9"],
      ["ISO-7-after-ISO-9", "ISO-9"],
    ])("refuses branch %s for card ISO-7, which names another card of the same prefix", async (branch, other) => {
      const layout = managedLayout();
      const worktree = layout.addWorktree(branch);
      expect(await probeNoRepositoryWorktree({
        ...layout.input,
        issueIdentifier: "ISO-7",
        recordedWorktreePath: worktree,
      })).toEqual({
        ok: false,
        reason: `the recorded worktree's branch ${branch} also names another card (${other})`,
      });
    });
  });

  describe("otherCardIdentifiers", () => {
    it.each([
      ["Delivered on OTHER-999-branch", ["OTHER-999"]],
      ["delivered on other-999-work", ["OTHER-999"]],
      ["Mixed Other-999 case", ["OTHER-999"]],
      ["alongside SUP-70 and XSUP-7", ["SUP-70", "XSUP-7"]],
      ["recorded with ISO-8601 timestamps, SHA-256 digests and UTF-8 text", []],
      ["the ruling for SUP-7 and sup-7", []],
      ["decided in phase-2 of sprint-12", ["PHASE-2", "SPRINT-12"]],
    ])("finds the other cards in %j", (text, expected) => {
      expect(otherCardIdentifiers(text, "SUP-7").sort()).toEqual(expected);
    });

    it("never exempts this card's own prefix as a standard name", () => {
      expect(otherCardIdentifiers("closes ISO-7 beside ISO-9, iso-9 and ISO-8601", "ISO-7").sort())
        .toEqual(["ISO-8601", "ISO-9"]);
    });
  });

  // Unattributed foreign branches refuse; branches registered to another
  // card's workspace are that card's.
  describe("local branches that are not this card's", () => {
    function branchAt(layout: ManagedLayout, name: string, ahead: boolean) {
      if (!ahead) {
        git(layout.repoRoot, "branch", name, "SUP-7-record-ruling");
        return;
      }
      const worktree = layout.addWorktree(name);
      writeFileSync(path.join(worktree, "work.md"), "SUP-7's deliverable\n");
      git(worktree, "add", "work.md");
      git(worktree, "commit", "-qm", "work");
      git(worktree, "push", "-q", "origin", name);
    }

    it.each([
      ["an ahead OTHER-999-work", "OTHER-999-work", true],
      ["an ahead lower-case other-999-work", "other-999-work", true],
      ["an ahead SUP-70-work", "SUP-70-work", true],
      ["a same-SHA OTHER-999-same", "OTHER-999-same", false],
    ] as const)("refuses %s that no card's workspace registers", async (_label, name, ahead) => {
      const layout = managedLayout();
      branchAt(layout, name, ahead);
      expect(await probeNoRepositoryWorktree(layout.input)).toEqual({
        ok: false,
        reason: `branch ${name} belongs to no card: it is not this card's, not one of the project's branches, not registered to another card's workspace, and not another card's rescue branch`,
      });
    });

    it("skips a local branch the project names and refuses it once the project does not", async () => {
      const layout = managedLayout();
      branchAt(layout, "release", false);
      expect(await probeNoRepositoryWorktree({ ...layout.input, projectBranches: new Set(["main", "release"]) }))
        .toMatchObject({ ok: true });
      expect(await probeNoRepositoryWorktree(layout.input)).toEqual({
        ok: false,
        reason: "branch release belongs to no card: it is not this card's, not one of the project's branches, not registered to another card's workspace, and not another card's rescue branch",
      });
    });

    // The server keeps `paperclip/rescue/<ISSUE-ID>/<timestamp>` branches that
    // hold a dirty-quarantined card's work; they belong to the card they name.
    describe("rescue branches", () => {
      const NO_CARD = (name: string) => ({
        ok: false,
        reason: `branch ${name} belongs to no card: it is not this card's, not one of the project's branches, not registered to another card's workspace, and not another card's rescue branch`,
      });

      it("skips another existing card's ahead rescue branch, asking once for the identifiers it names", async () => {
        const layout = managedLayout();
        branchAt(layout, "paperclip/rescue/SUP-9/20261106T000000Z", true);
        branchAt(layout, "paperclip/rescue/SUP-9/20261106T010000Z", false);
        branchAt(layout, "paperclip/rescue/SUP-11/20261106T000000Z", false);
        const asked: string[][] = [];
        const result = await probeNoRepositoryWorktree({
          ...layout.input,
          existingOtherCardIdentifiers: async (candidates) => {
            asked.push([...candidates].sort());
            return new Set(["SUP-9", "SUP-11"]);
          },
        });
        expect(result).toMatchObject({ ok: true });
        expect(asked).toEqual([["SUP-11", "SUP-9"]]);
      });

      it("refuses a rescue branch whose named card does not exist", async () => {
        const layout = managedLayout();
        branchAt(layout, "paperclip/rescue/NOPE-1/20261106T000000Z", false);
        expect(await probeNoRepositoryWorktree(layout.input)).toEqual(NO_CARD("paperclip/rescue/NOPE-1/20261106T000000Z"));
      });

      it("keeps this card's own rescue branch this card's, and refuses it when it is ahead", async () => {
        const layout = managedLayout();
        branchAt(layout, "paperclip/rescue/SUP-7/20261106T000000Z", true);
        const asked: string[][] = [];
        const result = await probeNoRepositoryWorktree({
          ...layout.input,
          existingOtherCardIdentifiers: async (candidates) => {
            asked.push([...candidates]);
            return new Set(candidates);
          },
        });
        expect(result).toEqual({
          ok: false,
          reason: "branch paperclip/rescue/SUP-7/20261106T000000Z has 1 commit(s) not on the project's default branch",
        });
        expect(asked).toEqual([]);
      });

      it.each([
        ["a branch under another prefix", "other/rescue/SUP-9/20261106T000000Z"],
        ["a rescue branch with no timestamp segment", "paperclip/rescue/SUP-9"],
      ])("does not treat %s as a rescue branch", async (_label, name) => {
        const layout = managedLayout();
        branchAt(layout, name, false);
        expect(await probeNoRepositoryWorktree({
          ...layout.input,
          existingOtherCardIdentifiers: async () => new Set(["SUP-9"]),
        })).toEqual(NO_CARD(name));
      });

      it("does not ask when no branch is rescue-shaped", async () => {
        const layout = managedLayout();
        let asked = 0;
        await probeNoRepositoryWorktree({
          ...layout.input,
          existingOtherCardIdentifiers: async () => {
            asked += 1;
            return new Set<string>();
          },
        });
        expect(asked).toBe(0);
      });
    });

    it("accepts a sibling card's ahead branch registered to its workspace, and the default branch", async () => {
      const layout = managedLayout();
      branchAt(layout, "SUP-71-sibling", true);
      expect(await probeNoRepositoryWorktree({ ...layout.input, attributedBranches: new Set(["SUP-71-sibling"]) }))
        .toMatchObject({ ok: true });
    });
  });

  function commitOnIssueBranch(layout: ManagedLayout) {
    writeFileSync(path.join(layout.worktree, "b.txt"), "committed\n");
    git(layout.worktree, "add", "b.txt");
    git(layout.worktree, "commit", "-qm", "SUP-7 undelivered");
  }

  it("counts a pushed commit that the remote's default branch lacks", async () => {
    const layout = managedLayout();
    commitOnIssueBranch(layout);
    git(layout.worktree, "push", "-q", "origin", "SUP-7-record-ruling");
    expect(await probeNoRepositoryWorktree(layout.input)).toEqual({
      ok: false,
      reason: "the recorded worktree has 1 commit(s) not on the project's default branch",
    });
  });

  // The base is measured on the remote, so nothing the agent can write in the
  // shared .git moves it: each of these makes a locally computed base level with
  // the committed tip, and the remote still has never seen the commit.
  it.each([
    ["the local base branch is moved onto it", (layout: ManagedLayout) =>
      git(layout.repoRoot, "update-ref", "refs/heads/main", "refs/heads/SUP-7-record-ruling")],
    ["refs/remotes/origin/main is moved onto it with update-ref", (layout: ManagedLayout) =>
      git(layout.repoRoot, "update-ref", "refs/remotes/origin/main", "refs/heads/SUP-7-record-ruling")],
    ["refs/remotes/origin/main is rewritten by a local fetch refspec", (layout: ManagedLayout) =>
      git(layout.repoRoot, "fetch", "-q", ".", "+refs/heads/SUP-7-record-ruling:refs/remotes/origin/main")],
  ])("refuses an unpushed committed deliverable when %s", async (_label, moveBase) => {
    const layout = managedLayout();
    commitOnIssueBranch(layout);
    moveBase(layout);
    const result = await probeNoRepositoryWorktree(layout.input);
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(
      /^the recorded worktree tip [0-9a-f]{12} could not be compared with the project's default branch on the remote$/,
    );
  });

  it("refuses when another branch naming the issue carries commits the remote default branch lacks", async () => {
    const layout = managedLayout();
    commitOnIssueBranch(layout);
    git(layout.worktree, "push", "-q", "origin", "SUP-7-record-ruling");
    const fabricated = layout.addWorktree("SUP-7-fresh");
    const result = await probeNoRepositoryWorktree({ ...layout.input, recordedWorktreePath: fabricated });
    expect(result).toEqual({
      ok: false,
      reason: "branch SUP-7-record-ruling has 1 commit(s) not on the project's default branch",
    });
  });

  describe("recheckRecordedWorktree (the close write's re-check under one shared budget)", () => {
    async function measured(layout: ManagedLayout) {
      const result = await probeNoRepositoryWorktree(layout.input);
      if (!result.ok) throw new Error(result.reason);
      return { worktreePath: result.worktreePath, commonDir: result.commonDir, branch: result.branch, headSha: result.headSha };
    }

    it("passes a clean worktree on the measured branch and commit within the normal budget", async () => {
      const layout = managedLayout();
      expect(await recheckRecordedWorktree(await measured(layout))).toEqual({ ok: true });
    });

    it("keeps the record_only write available when another registered card stashes after measurement", async () => {
      const layout = managedLayout();
      const otherBranch = "SUP-8-other-card";
      const other = layout.addWorktree(otherBranch);
      layout.input.attributedBranches = new Set([otherBranch]);
      const input = await measured(layout);
      writeFileSync(path.join(other, "a.txt"), "other card's work\n");
      git(other, "stash", "push", "-qm", "other card draft");
      expect(await recheckRecordedWorktree({ ...input, stashScope: layout.input })).toEqual({ ok: true });
    });

    it("refuses this card's stash created after record_only measurement", async () => {
      const layout = managedLayout();
      const input = await measured(layout);
      writeFileSync(path.join(layout.worktree, "a.txt"), "this card's work\n");
      git(layout.worktree, "stash", "push", "-qm", "this card draft");
      expect(await recheckRecordedWorktree({ ...input, stashScope: layout.input })).toMatchObject({ ok: false });
    });

    it("refuses with a timed-out reason, not a status one, when the shared budget is spent", async () => {
      const layout = managedLayout();
      const result = await recheckRecordedWorktree({ ...(await measured(layout)), budgetMs: 1 });
      expect(result).toEqual({
        ok: false,
        reason: "the recorded worktree could not be re-checked within 1 ms (timed out at the close write)",
      });
    });

    it("names the dirt, not a timeout, when the worktree is dirty within the budget", async () => {
      const layout = managedLayout();
      const input = await measured(layout);
      writeFileSync(path.join(layout.worktree, "late.md"), "written after the measurement\n");
      expect(await recheckRecordedWorktree(input)).toEqual({
        ok: false,
        reason: "the recorded worktree has uncommitted changes (modified, staged or untracked)",
      });
    });

    it("refuses a moved HEAD", async () => {
      const layout = managedLayout();
      const input = await measured(layout);
      git(layout.worktree, "commit", "-q", "--allow-empty", "-m", "SUP-7 moved");
      expect(await recheckRecordedWorktree(input)).toEqual({
        ok: false,
        reason: "the recorded worktree's HEAD moved after the close was measured",
      });
    });
  });

  describe("the recorded worktree moving while the probe compares its tip", () => {
    it.each([
      ["an empty commit lands on its branch", (layout: ManagedLayout) =>
        git(layout.worktree, "commit", "-q", "--allow-empty", "-m", "SUP-7 moved"), "SUP-7-record-ruling"],
      ["it switches to another issue-named branch at the same commit", (layout: ManagedLayout) =>
        git(layout.worktree, "checkout", "-q", "-b", "SUP-7-other"), "SUP-7-other"],
    ])("refuses, naming the move, when %s", async (_label, move, movedBranch) => {
      const layout = managedLayout();
      const startedAt = git(layout.worktree, "rev-parse", "HEAD");
      let moved = false;

      const result = await probeNoRepositoryWorktree({
        ...layout.input,
        countCommitsAheadOfBase: async () => {
          if (!moved) {
            moved = true;
            move(layout);
          }
          return 0;
        },
      });

      expect(moved).toBe(true);
      expect(result).toEqual({
        ok: false,
        reason:
          `the recorded worktree moved from SUP-7-record-ruling at ${startedAt.slice(0, 12)} ` +
          `to ${movedBranch} at ${git(layout.worktree, "rev-parse", "HEAD").slice(0, 12)} while it was being verified`,
      });
    });
  });

  describe("bounds the comparisons made while the close holds the issue row", () => {
    // `count` more commits land on the remote default branch; the managed
    // checkout fetches them and gets one branch naming the issue at each, so
    // every tip is a distinct historical commit level with the base.
    function issueBranchesAtHistoricalCommits(layout: ManagedLayout, count: number) {
      const shas: string[] = [];
      for (let index = 1; index <= count; index += 1) {
        writeFileSync(path.join(layout.seed, `history-${index}.txt`), `${index}\n`);
        git(layout.seed, "add", `history-${index}.txt`);
        git(layout.seed, "commit", "-qm", `history ${index}`);
        shas.push(git(layout.seed, "rev-parse", "HEAD"));
      }
      git(layout.seed, "push", "-q", layout.origin, "main");
      git(layout.repoRoot, "fetch", "-q", "origin");
      shas.forEach((sha, index) => git(layout.repoRoot, "branch", `SUP-7-tip-${index + 1}`, sha));
    }

    function countingInput(layout: ManagedLayout) {
      const compared: string[] = [];
      const countOnRemote = countOnOrigin(layout.origin);
      return {
        compared,
        input: {
          ...layout.input,
          countCommitsAheadOfBase: async (sha: string) => {
            compared.push(sha);
            return countOnRemote(sha);
          },
        },
      };
    }

    it("refuses with too_many_branch_tips when a sixth distinct tip would need comparing, after at most five comparisons", async () => {
      const layout = managedLayout();
      issueBranchesAtHistoricalCommits(layout, 5);
      const { compared, input } = countingInput(layout);

      const result = await probeNoRepositoryWorktree(input);

      expect(result).toMatchObject({ ok: false });
      expect((result as { reason: string }).reason).toMatch(/^too_many_branch_tips: /);
      expect(compared).toHaveLength(5);
      expect(new Set(compared).size).toBe(5);
    });

    it("still accepts five distinct tips: the recorded worktree's and four branches'", async () => {
      const layout = managedLayout();
      issueBranchesAtHistoricalCommits(layout, 4);
      const { compared, input } = countingInput(layout);

      const result = await probeNoRepositoryWorktree(input);

      expect(result).toMatchObject({ ok: true });
      expect(compared).toHaveLength(5);
      expect(new Set(compared).size).toBe(5);
    });
  });

  it("refuses when another worktree naming the issue holds uncommitted work", async () => {
    const layout = managedLayout();
    writeFileSync(path.join(layout.worktree, "a.txt"), "undelivered\n");
    const fabricated = layout.addWorktree("SUP-7-fresh");
    const result = await probeNoRepositoryWorktree({ ...layout.input, recordedWorktreePath: fabricated });
    expect(result).toEqual({
      ok: false,
      reason: "another worktree on branch SUP-7-record-ruling has uncommitted changes (modified, staged or untracked)",
    });
  });

  it("refuses a detached HEAD and an in-progress index lock", async () => {
    const layout = managedLayout();
    writeFileSync(
      path.join(git(layout.worktree, "rev-parse", "--absolute-git-dir"), "index.lock"),
      "",
    );
    expect(await probeNoRepositoryWorktree(layout.input)).toEqual({
      ok: false,
      reason: "the recorded worktree has a Git operation in progress (index.lock is present)",
    });
    rmSync(path.join(git(layout.worktree, "rev-parse", "--absolute-git-dir"), "index.lock"));
    git(layout.worktree, "checkout", "-q", "--detach");
    expect(await probeNoRepositoryWorktree(layout.input)).toEqual({
      ok: false,
      reason: "the recorded worktree has a detached HEAD",
    });
  });

  describe("fails closed when anything cannot be measured", () => {
    const UNMEASURED =
      /^the recorded worktree tip [0-9a-f]{12} could not be compared with the project's default branch on the remote$/;

    it.each([
      ["the remote comparison throws", async () => { throw new Error("GitHub compare API returned 500"); }],
      ["the remote comparison returns no usable count", async () => Number.NaN],
      ["the remote comparison returns a negative count", async () => -1],
    ])("refuses when %s", async (_label, countCommitsAheadOfBase) => {
      const layout = managedLayout();
      const result = await probeNoRepositoryWorktree({ ...layout.input, countCommitsAheadOfBase });
      expect(result).toMatchObject({ ok: false });
      expect((result as { reason: string }).reason).toMatch(UNMEASURED);
    });

    it("applies the 15 second default when no timeoutMs is passed, and refuses when it fires", async () => {
      const layout = managedLayout();
      const fifo = path.join(root, "blocking-include");
      execFileSync("mkfifo", [fifo]);
      git(layout.worktree, "config", "include.path", fifo);
      const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      await pause(100);
      const started = performance.now();
      let settled = false;
      const pending = probeNoRepositoryWorktree(layout.input).finally(() => {
        settled = true;
      });
      await pause(12_000);
      expect(settled, "settled before the 15 second default").toBe(false);
      const outcome = await Promise.race([pending, pause(40_000).then(() => "never settled" as const)]);
      expect(outcome).not.toBe("never settled");
      expect(performance.now() - started).toBeGreaterThanOrEqual(14_500);
      expect(outcome).toMatchObject({ ok: false });
    }, 70_000);

    // The probe itself (not git) reads info/exclude and copies the index. Both
    // live in the group-writable repository, so each is swapped for something
    // that would hang a thread or exhaust memory if it were opened naively.
    describe("repository files the probe reads itself", () => {
      const PROMPT_MS = 5_000;
      const UNVERIFIED = { ok: false, reason: "the recorded worktree status could not be verified" } as const;

      function excludeFile(layout: ManagedLayout) {
        return path.join(layout.repoRoot, ".git", "info", "exclude");
      }

      function indexFile(layout: ManagedLayout, worktree = layout.worktree) {
        return path.join(git(worktree, "rev-parse", "--absolute-git-dir"), "index");
      }

      async function probePromptly(input: ManagedLayout["input"]) {
        const started = performance.now();
        const result = await probeNoRepositoryWorktree(input);
        expect(performance.now() - started, "the probe hung on a swapped-in file").toBeLessThan(PROMPT_MS);
        return result;
      }

      it("accepts a worktree whose info/exclude is absent", async () => {
        const layout = managedLayout();
        rmSync(excludeFile(layout));
        expect(await probePromptly(layout.input)).toMatchObject({ ok: true });
      });

      it.each([
        ["a FIFO at info/exclude", (layout: ManagedLayout) => {
          rmSync(excludeFile(layout));
          execFileSync("mkfifo", [excludeFile(layout)]);
        }],
        ["a symlink to /dev/zero at info/exclude", (layout: ManagedLayout) => {
          rmSync(excludeFile(layout));
          symlinkSync("/dev/zero", excludeFile(layout));
        }],
        ["a symlink to a regular file at info/exclude", (layout: ManagedLayout) => {
          const target = path.join(root, "exclude-target");
          writeFileSync(target, "# nothing\n");
          rmSync(excludeFile(layout));
          symlinkSync(target, excludeFile(layout));
        }],
        ["an info/exclude larger than the size limit", (layout: ManagedLayout) => {
          writeFileSync(excludeFile(layout), `${"# padding\n".repeat(150_000)}`);
        }],
        ["a FIFO at the worktree's index", (layout: ManagedLayout) => {
          rmSync(indexFile(layout));
          execFileSync("mkfifo", [indexFile(layout)]);
        }],
        ["a symlink to /dev/zero at the worktree's index", (layout: ManagedLayout) => {
          const target = indexFile(layout);
          rmSync(target);
          symlinkSync("/dev/zero", target);
        }],
      ])("refuses %s promptly", async (_label, swap) => {
        const layout = managedLayout();
        swap(layout);
        expect(await probePromptly(layout.input)).toEqual(UNVERIFIED);
      });

      function sparseSharedIndex(layout: ManagedLayout, name: string, mebibytes: number) {
        const file = path.join(git(layout.worktree, "rev-parse", "--absolute-git-dir"), name);
        writeFileSync(file, "");
        truncateSync(file, mebibytes * MIB);
      }

      it("refuses promptly when the index and shared index files together exceed the combined size budget", async () => {
        const layout = managedLayout();
        sparseSharedIndex(layout, "sharedindex.one", 130);
        sparseSharedIndex(layout, "sharedindex.two", 130);
        expect(await probePromptly(layout.input)).toEqual(UNVERIFIED);
      });

      it("copies a large shared index in chunks rather than reading it into memory", async () => {
        const layout = managedLayout();
        sparseSharedIndex(layout, "sharedindex.big", 100);
        const { result, growth } = await peakBufferGrowth(() => probePromptly(layout.input));
        expect(result).toMatchObject({ ok: true });
        expect(growth, `buffers grew by ${growth} bytes`).toBeLessThan(32 * MIB);
      });

      it("refuses promptly when another worktree naming the issue has a FIFO as its index", async () => {
        const layout = managedLayout();
        const fabricated = layout.addWorktree("SUP-7-fresh");
        const index = indexFile(layout);
        rmSync(index);
        execFileSync("mkfifo", [index]);
        expect(await probePromptly({ ...layout.input, recordedWorktreePath: fabricated })).toEqual({
          ok: false,
          reason: "another worktree on branch SUP-7-record-ruling status could not be verified",
        });
      });
    });

    it("refuses when the snapshot directory cannot be created", async () => {
      const layout = managedLayout();
      const previous = process.env.TMPDIR;
      process.env.TMPDIR = path.join(root, "no-such-tmpdir");
      try {
        expect(await probeNoRepositoryWorktree(layout.input)).toEqual({
          ok: false,
          reason: "the recorded worktree status could not be verified",
        });
      } finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
      }
    });

    it("refuses when git blocks past the timeout instead of hanging the close", async () => {
      const layout = managedLayout();
      const fifo = path.join(root, "blocking-include");
      execFileSync("mkfifo", [fifo]);
      git(layout.worktree, "config", "include.path", fifo);
      const started = Date.now();
      const result = await probeNoRepositoryWorktree({ ...layout.input, timeoutMs: 500 });
      expect(result.ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(15_000);
    });
  });
});

// The record_only stash provenance rule. A stash refuses a record_only close
// only when the stash commit itself records one of this card's branches
// (`WIP on <branch>:` / `On <branch>:`). The reflog label, which
// `git stash store -m` rewrites freely, and the parents, which every card on
// the same base commit shares, are never read. Row ids follow the frozen
// grading matrix; every row also asserts that the close left the stash stack
// exactly as it found it.
describe("record_only stash provenance rule (frozen matrix)", () => {
  const OWN = "SUP-7-record-ruling";
  const SIBLING = "SUP-8-other-card";

  interface StashFixture {
    layout: ManagedLayout;
    /** The managed checkout M. */
    m: string;
    /** This card's recorded worktree X. */
    x: string;
    /** The registered sibling worktree Y, created and registered on first use. */
    y: () => string;
    registered: Set<string>;
    stashRef: string;
    stashLog: string;
    stash: (dir: string, ...args: string[]) => void;
    create: (dir: string) => string;
    store: (dir: string, label: string, commit: string) => void;
    deleted: (branch: string, commit?: boolean) => void;
    ff: (dir: string) => void;
    input: () => ManagedLayout["input"];
  }

  function stashFixture(): StashFixture {
    const layout = managedLayout();
    const m = layout.repoRoot;
    const registered = new Set<string>();
    let change = 0;
    let sibling: string | null = null;
    const touch = (dir: string) => writeFileSync(path.join(dir, "a.txt"), `change ${++change}\n`);
    const fixture: StashFixture = {
      layout,
      m,
      x: layout.worktree,
      registered,
      y: () => {
        if (sibling === null) {
          sibling = layout.addWorktree(SIBLING);
          registered.add(SIBLING);
        }
        return sibling;
      },
      stashRef: path.join(m, ".git", "refs", "stash"),
      stashLog: path.join(m, ".git", "logs", "refs", "stash"),
      stash: (dir, ...args) => {
        touch(dir);
        git(dir, "stash", "push", "-q", ...args);
      },
      create: (dir) => {
        touch(dir);
        const commit = git(dir, "stash", "create");
        git(dir, "checkout", "-q", "--", "a.txt");
        return commit;
      },
      store: (dir, label, commit) => {
        git(dir, "stash", "store", "-m", label, commit);
      },
      deleted: (branch, commit = false) => {
        git(m, "switch", "-q", "-c", branch);
        if (commit) {
          writeFileSync(path.join(m, "b.txt"), `${branch}\n`);
          git(m, "add", "b.txt");
          git(m, "commit", "-qm", `work on ${branch}`);
        }
        fixture.stash(m);
        git(m, "switch", "-q", "main");
        git(m, "branch", "-q", "-D", branch);
      },
      ff: (dir) => {
        const clone = path.join(root, `ff-${++change}`);
        git(root, "clone", "-q", layout.origin, clone);
        writeFileSync(path.join(clone, "base.txt"), `base ${change}\n`);
        git(clone, "add", "base.txt");
        git(clone, "commit", "-qm", "base moves");
        git(clone, "push", "-q", "origin", "main");
        git(dir, "fetch", "-q", "origin");
        git(dir, "merge", "-q", "--ff-only", "origin/main");
      },
      input: () => ({ ...layout.input, attributedBranches: new Set(registered) }),
    };
    return fixture;
  }

  /** Nine `git stash push -m <120 KB>` entries from `dir`: about 1.08 MB of reflog, over the old 1 MiB read bound. */
  const longMessagePushes = (f: StashFixture, dir: string, count = 9) => {
    for (let index = 0; index < count; index += 1) f.stash(dir, "-m", `${index}`.padEnd(120_000, "x"));
  };

  const REFLOG_LINE = (id: string, subject: string) =>
    `${"0".repeat(40)} ${id} t <t@example.com> 1700000000 +0000\t${subject}\n`;

  /**
   * The stash stack as git sees it (entry ids, newest first); a stack git cannot
   * read is compared by its error. One `git log -g` process and no helper: a
   * `git stash list` timeout kills only `git stash`, which leaves its `git log`
   * child blocked on a FIFO reflog after the test.
   */
  function stashList(m: string): string {
    try {
      return execFileSync("git", ["-C", m, "log", "-g", "--format=%H", "refs/stash", "--"], {
        env: fixtureEnv,
        stdio: "pipe",
        timeout: 3_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * MIB,
      }).toString();
    } catch (error) {
      return `unreadable: ${(error as { status?: number }).status ?? "timeout"}`;
    }
  }

  async function probeKeepingStash(fixture: StashFixture) {
    const before = stashList(fixture.m);
    const started = performance.now();
    const result = await probeNoRepositoryWorktree(fixture.input());
    // A FIFO or any other unreadable evidence must not hang the probe.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(stashList(fixture.m)).toBe(before);
    return result;
  }

  type Row = [id: string, setup: (fixture: StashFixture) => void];

  const refuseRows: [id: string, branch: string, setup: (fixture: StashFixture) => void][] = [
    ["ST-01 this card's stash, WIP on form", OWN, (f) => f.stash(f.x)],
    ["ST-01b this card's stash beside a sibling's corrupt stash commit", OWN, (f) => {
      f.stash(f.x);
      f.stash(f.y());
      const commit = git(f.m, "rev-parse", "refs/stash");
      const object = path.join(f.m, ".git", "objects", commit.slice(0, 2), commit.slice(2));
      chmodSync(object, 0o644);
      truncateSync(object, 20);
    }],
    ["ST-02 this card's stash, On form", OWN, (f) => f.stash(f.x, "-m", "this card draft")],
    ["ST-03 this card's entry below a sibling's tip", OWN, (f) => {
      f.stash(f.x);
      f.stash(f.y());
    }],
    ["ST-04 three-parent stash of an untracked file", OWN, (f) => {
      writeFileSync(path.join(f.x, "u.txt"), "untracked\n");
      git(f.x, "stash", "push", "-qu");
    }],
    ["ST-05 packed tip", OWN, (f) => {
      f.stash(f.x);
      git(f.m, "pack-refs", "--all");
    }],
    ["ST-05b only the packed tip names the commit (SS-PACKED)", OWN, (f) => {
      f.stash(f.x);
      git(f.m, "pack-refs", "--all");
      rmSync(f.stashLog);
    }],
    ["ST-05c the tip is read when the reflog cannot be", OWN, (f) => {
      f.stash(f.x);
      rmSync(f.stashLog);
      mkdirSync(f.stashLog);
    }],
    ["ST-06 this card's entry below a packed tip", OWN, (f) => {
      f.stash(f.x);
      f.stash(f.y());
      git(f.m, "pack-refs", "--all");
    }],
    ["ST-07a free-text reflog label (SS-UNPARSE)", OWN, (f) => f.store(f.x, "parked notes", f.create(f.x))],
    ["ST-07b a failed autostash's label", OWN, (f) => f.store(f.x, "autostash", f.create(f.x))],
    ["ST-08 relabelled as the registered sibling's, On form", OWN, (f) => {
      f.y();
      f.store(f.x, `On ${SIBLING}: draft`, f.create(f.x));
    }],
    ["ST-09 relabelled as the registered sibling's, WIP on form", OWN, (f) => {
      f.y();
      f.store(f.x, `WIP on ${SIBLING}: 1234567 init`, f.create(f.x));
    }],
    ["ST-10 relabelled as the project branch", OWN, (f) => f.store(f.x, "WIP on main: 1234567 init", f.create(f.x))],
    ["ST-11 a tip with no reflog line (SS-TIP)", OWN, (f) => {
      f.stash(f.y());
      writeFileSync(f.stashRef, `${f.create(f.x)}\n`);
    }],
    ["ST-12 no reflog; the tip names the commit", OWN, (f) => {
      f.stash(f.x);
      rmSync(f.stashLog);
    }],
    ["ST-13 no ref; the reflog names the commit", OWN, (f) => {
      f.stash(f.x);
      rmSync(f.stashRef);
    }],
    ["ST-14 own branch wins over registration (SS-OWN)", OWN, (f) => {
      f.registered.add(OWN);
      f.stash(f.x);
    }],
    ["ST-15 recorded branch carries the identifier after a rename", OWN, (f) => {
      f.stash(f.x);
      git(f.x, "branch", "-m", OWN, `${OWN}-2`);
    }],
    ["ST-16 a second unregistered worktree carrying the identifier", "SUP-7-extra", (f) => {
      f.stash(f.layout.addWorktree("SUP-7-extra"));
    }],
    ["ST-17 a deleted branch that carried the identifier", "SUP-7-scratch", (f) => f.deleted("SUP-7-scratch")],
    ["ST-18 the identifier match ignores case", "sup-7-notes", (f) => f.deleted("sup-7-notes")],
    ["ST-19 own stash, then the card fast-forwards", OWN, (f) => {
      f.stash(f.x);
      f.ff(f.x);
    }],
    ["ST-20 garbage loose ref over a packed tip; the reflog names the commit", OWN, (f) => {
      f.stash(f.x);
      git(f.m, "pack-refs", "--all");
      writeFileSync(f.stashRef, "garbage\n");
    }],
    ["ST-21 one missing object does not abort the read", OWN, (f) => {
      f.stash(f.x);
      appendFileSync(f.stashLog, REFLOG_LINE("e".repeat(40), "WIP on main: 1234567 x"));
    }],
    ["ST-23 this card's entry below nine 120 KB-message stashes (reflog over 1 MiB)", OWN, (f) => {
      f.stash(f.x);
      git(f.x, "checkout", "-q", "--detach");
      longMessagePushes(f, f.x);
      git(f.x, "checkout", "-q", OWN);
      expect(statSync(f.stashLog).size).toBeGreaterThan(MIB);
    }],
    ["ST-24 this card's entry below a registered sibling's 1 MiB of long-message stashes", OWN, (f) => {
      f.stash(f.x);
      longMessagePushes(f, f.y());
      expect(statSync(f.stashLog).size).toBeGreaterThan(MIB);
    }],
    ["ST-22 work stashed while a sibling stood on this card's branch", OWN, (f) => {
      const y = f.y();
      git(y, "switch", "-q", "--ignore-other-worktrees", OWN);
      f.stash(y);
      git(y, "switch", "-q", SIBLING);
    }],
  ];

  it.each(refuseRows)("refuses %s", async (_id, branch, setup) => {
    const fixture = stashFixture();
    setup(fixture);
    const result = await probeKeepingStash(fixture);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain(`stashed on this card's branch ${branch} `);
  });

  const admitRows: Row[] = [
    ["ST-00 no stash", () => {}],
    ["ST-30 the registered sibling's stash, WIP on form", (f) => f.stash(f.y())],
    ["ST-31 the registered sibling's stash, On form", (f) => f.stash(f.y(), "-m", "other card draft")],
    ["ST-32 a stash on the project branch", (f) => f.stash(f.m)],
    ["ST-33 a deleted branch that names no card", (f) => f.deleted("scratch")],
    ["ST-34 a deleted branch that names no card, on its own commit", (f) => f.deleted("scratch", true)],
    ["ST-35 a sibling's detached-HEAD stash", (f) => {
      const y = f.y();
      git(y, "checkout", "-q", "--detach");
      f.stash(y);
      git(y, "checkout", "-q", SIBLING);
    }],
    ["ST-36 a sibling's stash relabelled as this card's, On form", (f) => {
      f.store(f.y(), `On ${OWN}: forged`, f.create(f.y()));
    }],
    ["ST-37 a sibling's stash relabelled as this card's, WIP on form", (f) => {
      f.store(f.y(), `WIP on ${OWN}: 1234567 init`, f.create(f.y()));
    }],
    ["ST-38 a registered branch that also mentions this card", (f) => {
      const follow = "SUP-8-follow-up-for-SUP-7";
      f.registered.add(follow);
      f.stash(f.layout.addWorktree(follow));
    }],
    ["ST-39 a packed sibling stash", (f) => {
      f.stash(f.y());
      git(f.m, "pack-refs", "--all");
    }],
    ["ST-40a free-text label on a sibling's stash", (f) => f.store(f.y(), "parked notes", f.create(f.y()))],
    ["ST-40b a sibling's failed autostash", (f) => f.store(f.y(), "autostash", f.create(f.y()))],
    ["ST-41 an unreadable ref", (f) => writeFileSync(f.stashRef, "garbage\n")],
    ["ST-42 an unreadable ref over a packed sibling stash", (f) => {
      f.stash(f.y());
      git(f.m, "pack-refs", "--all");
      writeFileSync(f.stashRef, "garbage\n");
    }],
    ["ST-43 a ref naming a blob", (f) => writeFileSync(f.stashRef, `${git(f.m, "rev-parse", "HEAD:a.txt")}\n`)],
    ["ST-44 a missing object whose reflog label names this card", (f) => {
      f.stash(f.y());
      appendFileSync(f.stashLog, REFLOG_LINE("e".repeat(40), `WIP on ${OWN}: 1234567 x`));
    }],
    ["ST-45 a deleted branch carrying another card's identifier", (f) => f.deleted("SUP-9-x")],
    ["ST-46a SUP-70 is not SUP-7", (f) => f.deleted("SUP-70-x")],
    ["ST-46b xSUP-7 is not SUP-7", (f) => f.deleted("xSUP-7-y")],
    ["ST-47 a sibling's stash after this card fast-forwards", (f) => {
      f.stash(f.y());
      f.ff(f.x);
    }],
    ["ST-49 a corrupt stash commit object", (f) => {
      f.stash(f.y());
      const commit = git(f.m, "rev-parse", "refs/stash");
      const object = path.join(f.m, ".git", "objects", commit.slice(0, 2), commit.slice(2));
      chmodSync(object, 0o644);
      truncateSync(object, 20);
    }],
    ["ST-50a a reflog that is a directory", (f) => mkdirSync(f.stashLog, { recursive: true })],
    ["ST-51 only a registered sibling's stashes in a reflog over 1 MiB", (f) => {
      longMessagePushes(f, f.y());
      expect(statSync(f.stashLog).size).toBeGreaterThan(MIB);
    }],
    ["ST-50b a reflog that is a FIFO", (f) => {
      f.stash(f.y());
      rmSync(f.stashLog);
      execFileSync("mkfifo", [f.stashLog]);
    }],
    // Admitted by design: each is the same repository state as an admit row
    // above up to file contents, or a state record_only never inspects. They
    // are pinned so nobody closes them by re-introducing the wedge.
    ["HIDE-1 this card's detached-HEAD stash (same state as ST-35)", (f) => {
      git(f.x, "checkout", "-q", "--detach");
      f.stash(f.x);
      git(f.x, "checkout", "-q", OWN);
    }],
    ["HIDE-2 this card's stash on a deleted temporary branch (same state as ST-33)", (f) => {
      git(f.x, "switch", "-q", "-c", "tmp-scratch");
      f.stash(f.x);
      git(f.x, "switch", "-q", OWN);
      git(f.x, "branch", "-q", "-D", "tmp-scratch");
    }],
    ["HIDE-3 a dangling stash commit with no ref", (f) => {
      f.create(f.x);
    }],
    ["HIDE-4 work committed, then reset away", (f) => {
      writeFileSync(path.join(f.x, "a.txt"), "committed then reset\n");
      git(f.x, "commit", "-qam", "SUP-7 work");
      git(f.x, "reset", "-q", "--hard", "origin/main");
    }],
  ];

  it.each(admitRows)("admits %s", async (_id, setup) => {
    const fixture = stashFixture();
    setup(fixture);
    expect(await probeKeepingStash(fixture)).toMatchObject({ ok: true, branch: OWN });
  });

  it("ST-52 refuses a regular stash reflog over the 16 MiB bound as unverified, even with no stash of this card", async () => {
    const fixture = stashFixture();
    fixture.stash(fixture.y());
    const padding = REFLOG_LINE("0".repeat(40), "x".repeat(4_000)).repeat(Math.ceil((16 * MIB) / 4_000) + 16);
    appendFileSync(fixture.stashLog, padding);
    expect(statSync(fixture.stashLog).size).toBeGreaterThan(16 * MIB);
    const result = await probeNoRepositoryWorktree(fixture.input());
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("holds a stash reflog that could not be verified");
  });

  describe("a stash reflog that is a symbolic link", () => {
    /** Move the reflog out of the repository and leave a symlink to it in its place. */
    function symlinkReflog(fixture: StashFixture, contents?: string): string {
      const target = path.join(mkdtempSync(path.join(root, "stash-reflog-target-")), "stash");
      writeFileSync(target, contents ?? readFileSync(fixture.stashLog));
      rmSync(fixture.stashLog);
      symlinkSync(target, fixture.stashLog);
      return target;
    }

    async function refusesUnverified(fixture: StashFixture) {
      const result = await probeNoRepositoryWorktree(fixture.input());
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toContain("holds a stash reflog that could not be verified");
      expect((result as { reason: string }).reason).toContain("a symbolic link");
    }

    it("ST-53 refuses a symlinked reflog that holds this card's stash below a sibling's top", async () => {
      const fixture = stashFixture();
      fixture.stash(fixture.x);
      const own = git(fixture.m, "rev-parse", "refs/stash");
      fixture.stash(fixture.y());
      symlinkReflog(fixture);
      // Git reads through the link: this card's stash is still on the stack.
      expect(stashList(fixture.m).split("\n")).toContain(own);
      await refusesUnverified(fixture);
    });

    it("ST-54 refuses a symlinked reflog holding only a registered sibling's stash", async () => {
      const fixture = stashFixture();
      fixture.stash(fixture.y());
      symlinkReflog(fixture);
      await refusesUnverified(fixture);
    });

    it("ST-55 refuses a symlink to an empty reflog", async () => {
      const fixture = stashFixture();
      fixture.stash(fixture.y());
      symlinkReflog(fixture, "");
      await refusesUnverified(fixture);
    });

    it("ST-57 refuses a reflog that is regular at the first check and swapped to a symlink before it is read", async () => {
      const fixture = stashFixture();
      fixture.stash(fixture.x);
      const own = git(fixture.m, "rev-parse", "refs/stash");
      fixture.stash(fixture.y());
      let swapped = false;
      fsControl.swapOnOpen = {
        path: fixture.stashLog,
        swap: () => {
          symlinkReflog(fixture);
          swapped = true;
        },
      };
      const result = await probeNoRepositoryWorktree(fixture.input());
      expect(swapped).toBe(true);
      // Git still reads this card's stash through the swapped-in link.
      expect(stashList(fixture.m).split("\n")).toContain(own);
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toContain("holds a stash reflog that could not be verified");
    });

    it("ST-56 refuses a dangling reflog symlink", async () => {
      const fixture = stashFixture();
      fixture.stash(fixture.y());
      rmSync(symlinkReflog(fixture));
      await refusesUnverified(fixture);
    });
  });

  describe("at the close write", () => {
    async function measuredWithSibling() {
      const fixture = stashFixture();
      fixture.registered.add(SIBLING);
      const result = await probeNoRepositoryWorktree(fixture.input());
      if (!result.ok) throw new Error(result.reason);
      const recheck = () =>
        recheckRecordedWorktree({
          worktreePath: result.worktreePath,
          commonDir: result.commonDir,
          branch: result.branch,
          headSha: result.headSha,
          stashScope: fixture.input(),
        });
      return { fixture, recheck };
    }

    it.each([
      ["W-01 this card stashes after measurement", (f: StashFixture) => f.stash(f.x)],
      ["W-05 this card stashes after measurement on its recorded branch that is also registered to another card", (f: StashFixture) => {
        f.registered.add(OWN);
        f.stash(f.x);
      }],
      ["W-04 this card's stash relabelled as the registered sibling's", (f: StashFixture) => {
        f.y();
        f.store(f.x, `On ${SIBLING}: draft`, f.create(f.x));
      }],
    ])("refuses %s", async (_id, step) => {
      const { fixture, recheck } = await measuredWithSibling();
      step(fixture);
      const before = stashList(fixture.m);
      const result = await recheck();
      expect(stashList(fixture.m)).toBe(before);
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toContain(`stashed on this card's branch ${OWN} `);
    });

    it("W-06 refuses as timed out when the write budget runs out while the stash entries are read one by one", async () => {
      const fixture = stashFixture();
      fixture.registered.add(SIBLING);
      const measured = await probeNoRepositoryWorktree(fixture.input());
      if (!measured.ok) throw new Error(measured.reason);
      // 2,000 reflog entries that name no object, then this card's stash, then
      // a sibling's stash on top whose commit object is corrupt. The corrupt
      // object fails the batched subject read, so every entry is read on its
      // own; the budget runs out before this card's entry is reached.
      mkdirSync(path.dirname(fixture.stashLog), { recursive: true });
      const missing = Array.from({ length: 2_000 }, (_, index) =>
        REFLOG_LINE(index.toString(16).padStart(40, "d"), "WIP on main: 1234567 x"));
      writeFileSync(fixture.stashLog, missing.join(""));
      fixture.stash(fixture.x);
      fixture.stash(fixture.y());
      const commit = git(fixture.m, "rev-parse", "refs/stash");
      const object = path.join(fixture.m, ".git", "objects", commit.slice(0, 2), commit.slice(2));
      chmodSync(object, 0o644);
      truncateSync(object, 20);
      const budgetMs = 1_500;
      expect(await recheckRecordedWorktree({
        worktreePath: measured.worktreePath,
        commonDir: measured.commonDir,
        branch: measured.branch,
        headSha: measured.headSha,
        stashScope: fixture.input(),
        budgetMs,
      })).toEqual({
        ok: false,
        reason: `the recorded worktree could not be re-checked within ${budgetMs} ms (timed out at the close write)`,
      });
    });

    it.each([
      ["W-02 the registered sibling stashes after measurement", (f: StashFixture) => f.stash(f.y())],
      ["W-03 the managed checkout stashes on the project branch after measurement", (f: StashFixture) => f.stash(f.m)],
    ])("admits %s", async (_id, step) => {
      const { fixture, recheck } = await measuredWithSibling();
      step(fixture);
      const before = stashList(fixture.m);
      expect(await recheck()).toEqual({ ok: true });
      expect(stashList(fixture.m)).toBe(before);
    });
  });
});
