import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { worktreeHasUncommittedContent } from "./done-transition-guard.js";
import {
  HardenedGitError,
  probeNoRepositoryWorktree,
  resolveTrustedGitBinary,
  runHardenedGit,
} from "./hardened-git-probe.js";

// A host with no root-owned git at any fixed system path: the candidates are
// hidden from the module's stat calls, everything else is the real filesystem.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const hidden = new Set(["/usr/bin/git", "/usr/local/bin/git", "/bin/git"]);
  return {
    ...actual,
    statSync: ((target: Parameters<typeof actual.statSync>[0], ...rest: unknown[]) => {
      if (typeof target === "string" && hidden.has(target)) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return (actual.statSync as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof actual.statSync,
  };
});

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

function plainRepo(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "hello\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-qm", "init");
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "paperclip-untrusted-git-host-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a host with no root-owned git binary (SUP-22880 / SUP-22570)", () => {
  it("has no trusted git binary", () => {
    expect(resolveTrustedGitBinary()).toBeNull();
  });

  it("rejects as unavailable by default, so a gating probe cannot run on an untrusted binary", async () => {
    const repo = plainRepo("repo");
    await expect(runHardenedGit(["-C", repo, "status", "--porcelain"], { cwd: "/" }))
      .rejects.toMatchObject({ kind: "unavailable" } satisfies Partial<HardenedGitError>);
  });

  it("measures with the prior PATH lookup when the caller opts into the inherited environment, still ignoring inherited GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE", async () => {
    const dirty = plainRepo("dirty");
    writeFileSync(path.join(dirty, "a.txt"), "undelivered\n");
    const clean = plainRepo("clean");
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE, index: process.env.GIT_INDEX_FILE };
    process.env.GIT_DIR = path.join(clean, ".git");
    process.env.GIT_WORK_TREE = clean;
    process.env.GIT_INDEX_FILE = path.join(clean, ".git", "index");
    try {
      const out = await runHardenedGit(["-C", dirty, "status", "--porcelain"], { cwd: "/", inheritEnvironment: true });
      expect(out).toContain("a.txt");
    } finally {
      for (const [key, value] of [["GIT_DIR", saved.dir], ["GIT_WORK_TREE", saved.tree], ["GIT_INDEX_FILE", saved.index]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("lets a legacy probe run past 15 seconds and still report the dirty worktree, instead of timing out into a fail-open", async () => {
    const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
    const slowBin = path.join(root, "slow-bin");
    mkdirSync(slowBin);
    writeFileSync(path.join(slowBin, "git"), `#!/bin/sh\nsleep 16\nexec ${realGit} "$@"\n`);
    chmodSync(path.join(slowBin, "git"), 0o755);
    const dirty = plainRepo("dirty");
    writeFileSync(path.join(dirty, "a.txt"), "undelivered\n");
    const previousPath = process.env.PATH;
    process.env.PATH = `${slowBin}:${previousPath}`;
    try {
      expect(await worktreeHasUncommittedContent(dirty)).toBe(true);
    } finally {
      process.env.PATH = previousPath;
    }
  }, 60_000);

  it("refuses the record_only probe without measuring anything", async () => {
    const countCommitsAheadOfBase = vi.fn(async () => 0);
    const result = await probeNoRepositoryWorktree({
      recordedWorktreePath: plainRepo("repo"),
      managedProjectRoot: root,
      issueIdentifier: "SUP-7",
      defaultBranch: "main",
      attributedBranches: new Set(),
      countCommitsAheadOfBase,
    });
    expect(result).toEqual({ ok: false, reason: "no root-owned git binary is installed at a fixed system path" });
    expect(countCommitsAheadOfBase).not.toHaveBeenCalled();
  });
});
