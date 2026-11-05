import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hardenedWorktreeHasUncommittedContent,
  HardenedGitError,
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
  input: { recordedWorktreePath: string; managedProjectRoot: string; issueIdentifier: string; baseBranch: string };
}

/**
 * The managed layout the server provisions:
 * <instance>/projects/<company>/<project>/<repo>/.paperclip/worktrees/<branch>,
 * cloned from a bare "origin" so refs/remotes/origin/main is the base.
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
      baseBranch: "main",
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

describe("hardenedWorktreeHasUncommittedContent (pre-existing repository_delivery status probe)", () => {
  it("does not execute a planted core.fsmonitor and still reports the dirty tree", async () => {
    const repo = plainRepo("repo");
    git(repo, "config", "core.fsmonitor", planted);
    writeFileSync(path.join(repo, "a.txt"), "undelivered\n");
    expect(await hardenedWorktreeHasUncommittedContent(repo)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("does not execute a planted clean/process filter driver, and compares content without it", async () => {
    const repo = plainRepo("repo");
    writeFileSync(path.join(repo, ".gitattributes"), "* filter=evil\n");
    git(repo, "add", ".gitattributes");
    git(repo, "commit", "-qm", "attributes");
    git(repo, "config", "filter.evil.clean", planted);
    git(repo, "config", "filter.evil.process", planted);
    git(repo, "config", "filter.evil.required", "true");
    makeStatDirty(path.join(repo, "a.txt"));
    expect(await hardenedWorktreeHasUncommittedContent(repo)).toBe(false);
    writeFileSync(path.join(repo, "a.txt"), "undelivered\n");
    expect(await hardenedWorktreeHasUncommittedContent(repo)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("does not execute what an include.path target configures", async () => {
    const repo = plainRepo("repo");
    const included = path.join(root, "included.cfg");
    writeFileSync(included, `[core]\n\tfsmonitor = ${planted}\n[filter "evil"]\n\tclean = ${planted}\n`);
    writeFileSync(path.join(repo, ".gitattributes"), "* filter=evil\n");
    git(repo, "config", "include.path", included);
    makeStatDirty(path.join(repo, "a.txt"));
    expect(await hardenedWorktreeHasUncommittedContent(repo)).toBe(true);
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
    expect(await hardenedWorktreeHasUncommittedContent(repo)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("measures the probed path, not the decoy a planted core.worktree points at", async () => {
    const repo = plainRepo("repo");
    const decoy = path.join(root, "decoy");
    mkdirSync(decoy);
    writeFileSync(path.join(decoy, "a.txt"), "hello\n");
    writeFileSync(path.join(repo, "a.txt"), "undelivered\n");
    git(repo, "config", "core.worktree", decoy);
    expect(await hardenedWorktreeHasUncommittedContent(repo)).toBe(true);
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
      expect(await hardenedWorktreeHasUncommittedContent(dirty)).toBe(true);
    } finally {
      for (const [key, value] of [["GIT_DIR", saved.dir], ["GIT_WORK_TREE", saved.tree], ["GIT_INDEX_FILE", saved.index]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("keeps reporting dirt inside a populated submodule, without running the submodule's configured filter", async () => {
    const library = plainRepo("library");
    const repo = plainRepo("repo");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "lib");
    git(repo, "commit", "-qm", "submodule");
    const submodule = path.join(repo, "lib");
    git(submodule, "config", "filter.evil.clean", planted);
    writeFileSync(path.join(submodule, ".gitattributes"), "* filter=evil\n");
    expect(await hardenedWorktreeHasUncommittedContent(repo)).toBe(true);
    rmSync(path.join(submodule, ".gitattributes"));
    expect(await hardenedWorktreeHasUncommittedContent(repo)).toBe(false);
    writeFileSync(path.join(submodule, "a.txt"), "undelivered\n");
    expect(await hardenedWorktreeHasUncommittedContent(repo)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("probeNoRepositoryWorktree (SUP-22570 record_only close)", () => {
  it("accepts the issue's own clean worktree with zero commits ahead of the remote-tracking base", async () => {
    const layout = managedLayout();
    const result = await probeNoRepositoryWorktree(layout.input);
    expect(result).toMatchObject({ ok: true, branch: "SUP-7-record-ruling" });
  });

  it.each([
    ["core.fsmonitor", (worktree: string) => git(worktree, "config", "core.fsmonitor", planted)],
    ["core.hooksPath", (worktree: string) => git(worktree, "config", "core.hooksPath", root)],
    ["filter driver", (worktree: string) => {
      git(worktree, "config", "filter.evil.clean", planted);
      writeFileSync(path.join(worktree, ".gitattributes"), "* filter=evil\n");
    }],
    ["include.path", (worktree: string) => {
      const included = path.join(root, "included.cfg");
      writeFileSync(included, `[core]\n\tfsmonitor = ${planted}\n`);
      git(worktree, "config", "include.path", included);
    }],
    ["core.worktree", (worktree: string) => git(worktree, "config", "core.worktree", root)],
  ])("refuses a worktree whose repository config plants %s, without executing it", async (_label, plant) => {
    const layout = managedLayout();
    plant(layout.worktree);
    makeStatDirty(path.join(layout.worktree, "a.txt"));
    const result = await probeNoRepositoryWorktree(layout.input);
    expect(result.ok).toBe(false);
    expect(existsSync(marker)).toBe(false);
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

  it("refuses a committed change even when the local base branch was moved onto it", async () => {
    const layout = managedLayout();
    writeFileSync(path.join(layout.worktree, "b.txt"), "committed\n");
    git(layout.worktree, "add", "b.txt");
    git(layout.worktree, "commit", "-qm", "SUP-7 undelivered");
    git(layout.repoRoot, "update-ref", "refs/heads/main", "refs/heads/SUP-7-record-ruling");
    expect(await probeNoRepositoryWorktree(layout.input)).toEqual({
      ok: false,
      reason: "the recorded worktree has 1 commit(s) not on refs/remotes/origin/main",
    });
  });

  it("refuses when another branch naming the issue carries commits not on the base", async () => {
    const layout = managedLayout();
    writeFileSync(path.join(layout.worktree, "b.txt"), "committed\n");
    git(layout.worktree, "add", "b.txt");
    git(layout.worktree, "commit", "-qm", "real work");
    const fabricated = layout.addWorktree("SUP-7-fresh");
    const result = await probeNoRepositoryWorktree({ ...layout.input, recordedWorktreePath: fabricated });
    expect(result).toEqual({
      ok: false,
      reason: "branch SUP-7-record-ruling has 1 commit(s) not on refs/remotes/origin/main",
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

  it("refuses when the control-plane base does not resolve", async () => {
    const layout = managedLayout();
    const result = await probeNoRepositoryWorktree({ ...layout.input, baseBranch: "release" });
    expect(result).toEqual({
      ok: false,
      reason: "the control-plane base refs/remotes/origin/release does not resolve in the managed checkout",
    });
  });
});
