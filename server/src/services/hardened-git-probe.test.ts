import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HardenedGitError,
  normalizeBaseBranch,
  probeNoRepositoryWorktree,
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
});

// The pre-existing repository_delivery dirty probe is `git status --porcelain`
// through this runner in its inherit-environment mode (done-transition-guard.ts runGit).
const WORKTREE_STATUS_OPTIONS = { cwd: "/", inheritEnvironment: true } as const;
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
    // by another uid, the state a workspace shared across uids is in.
    async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
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

  it("is unmeasured (rejects) rather than clean when git blocks past the timeout", async () => {
    const repo = plainRepo("repo");
    const fifo = path.join(root, "blocking-include");
    execFileSync("mkfifo", [fifo]);
    git(repo, "config", "include.path", fifo);
    await expect(runHardenedGit(["-C", repo, "status", "--porcelain"], { ...WORKTREE_STATUS_OPTIONS, timeoutMs: 500 }))
      .rejects.toMatchObject({ kind: "timeout" } satisfies Partial<HardenedGitError>);
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

  describe("untracked ignore files (ignored-file dirt)", () => {
    const HIDDEN = "the recorded worktree has untracked ignore files that hide uncommitted content";

    function hideDeliverable(worktree: string) {
      mkdirSync(path.join(worktree, "hidden"));
      writeFileSync(path.join(worktree, "hidden", ".gitignore"), "*\n");
      writeFileSync(path.join(worktree, "hidden", "work.txt"), "undelivered\n");
    }

    function trackIgnoreRules(layout: ManagedLayout, rules: string) {
      writeFileSync(path.join(layout.worktree, ".gitignore"), rules);
      git(layout.worktree, "add", ".gitignore");
      git(layout.worktree, "commit", "-qm", "ignore rules");
      git(layout.worktree, "push", "-q", "origin", "HEAD:main");
    }

    it("refuses a directory whose own untracked .gitignore ignores everything, which status reads as clean", async () => {
      const layout = managedLayout();
      hideDeliverable(layout.worktree);
      expect(git(layout.worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
      expect(await probeNoRepositoryWorktree(layout.input)).toEqual({ ok: false, reason: HIDDEN });
    });

    it("refuses it in another worktree naming the issue", async () => {
      const layout = managedLayout();
      hideDeliverable(layout.worktree);
      const fabricated = layout.addWorktree("SUP-7-fresh");
      const result = await probeNoRepositoryWorktree({ ...layout.input, recordedWorktreePath: fabricated });
      expect(result).toEqual({
        ok: false,
        reason: "another worktree on branch SUP-7-record-ruling has untracked ignore files that hide uncommitted content",
      });
    });

    it("allows an ignored node_modules, including untracked ignore files shipped inside it", async () => {
      const layout = managedLayout();
      trackIgnoreRules(layout, "node_modules/\n");
      const pkg = path.join(layout.worktree, "node_modules", "pkg");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(path.join(pkg, "index.js"), "module.exports = 1;\n");
      writeFileSync(path.join(pkg, ".gitignore"), "*\n");
      expect(await probeNoRepositoryWorktree(layout.input)).toMatchObject({ ok: true });
    });

    it("allows a tracked .gitignore and the build output it ignores", async () => {
      const layout = managedLayout();
      trackIgnoreRules(layout, "*.log\ndist/\n");
      writeFileSync(path.join(layout.worktree, "debug.log"), "noise\n");
      mkdirSync(path.join(layout.worktree, "dist"));
      writeFileSync(path.join(layout.worktree, "dist", "bundle.js"), "built\n");
      expect(await probeNoRepositoryWorktree(layout.input)).toMatchObject({ ok: true });
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
