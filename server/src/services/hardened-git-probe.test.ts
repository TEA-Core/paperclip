import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HardenedGitError,
  LEGACY_WORKTREE_GIT_OPTIONS,
  normalizeBaseBranch,
  probeNoRepositoryWorktree,
  readWorktreeHeadFromFiles,
  resolveTrustedGitBinary,
  runHardenedGit,
} from "./hardened-git-probe.js";

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

    it("accepts a branch that names only this card, in any case and with a suffix", async () => {
      const layout = managedLayout();
      const worktree = layout.addWorktree("sup-7-notes-v2");
      expect(await probeNoRepositoryWorktree({ ...layout.input, recordedWorktreePath: worktree })).toMatchObject({ ok: true });
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

// The status write re-reads the worktree's HEAD from its ref files while it
// holds the issue row, where no Git process may run.
describe("readWorktreeHeadFromFiles", () => {
  it.each([
    ["a loose ref", (_layout: ManagedLayout) => {}],
    ["a packed ref", (layout: ManagedLayout) => git(layout.repoRoot, "pack-refs", "--all")],
  ])("reads the branch and commit of a worktree whose branch is %s", async (_label, store) => {
    const layout = managedLayout();
    store(layout);
    const probe = await probeNoRepositoryWorktree(layout.input);
    expect(probe.ok).toBe(true);
    const { gitDir, commonDir, headSha } = probe as Extract<typeof probe, { ok: true }>;
    expect(await readWorktreeHeadFromFiles(gitDir, commonDir)).toEqual({ branch: "SUP-7-record-ruling", sha: headSha });
  });

  it("returns null when HEAD is detached or a FIFO", async () => {
    const layout = managedLayout();
    const gitDir = git(layout.worktree, "rev-parse", "--absolute-git-dir");
    const commonDir = path.join(layout.repoRoot, ".git");
    git(layout.worktree, "checkout", "-q", "--detach");
    expect(await readWorktreeHeadFromFiles(gitDir, commonDir)).toBeNull();
    rmSync(path.join(gitDir, "HEAD"));
    execFileSync("mkfifo", [path.join(gitDir, "HEAD")]);
    expect(await readWorktreeHeadFromFiles(gitDir, commonDir)).toBeNull();
  });
});
