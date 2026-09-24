import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { inspectManagedGitWorktreeBranch } from "../services/workspace-runtime.ts";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

function trackTempDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createGitRepo(): Promise<string> {
  const repoRoot = trackTempDir(await mkdtemp(path.join(os.tmpdir(), "pc-wt-list-")));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip-test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await writeFile(path.join(repoRoot, "README.md"), "worktree list failure test\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

describe("inspectManagedGitWorktreeBranch worktree-list triage (SUP-17380)", () => {
  it("reports worktree_list_failed — not not_registered — when `git worktree list` rejects", async () => {
    // A directory that exists but is not a git checkout: `git worktree list --porcelain`
    // exits non-zero with `cwd` here, so `listLinkedGitWorktreePaths` rejects. This is the
    // same shape as a `safe.directory` / dubious-ownership refusal observed in production.
    const notAGitRepo = trackTempDir(await mkdtemp(path.join(os.tmpdir(), "pc-wt-notrepo-")));
    const result = await inspectManagedGitWorktreeBranch({
      worktreePath: notAGitRepo,
      expectedBranchName: "some-branch",
      repoRoot: notAGitRepo,
    });
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe("worktree_list_failed");
    expect(result.reasonCode).not.toBe("not_registered");
    // The swallowed git error must surface, not be discarded into a false "not registered".
    expect(result.reason).toMatch(/git worktree list failed:/i);
    expect(result.reason).toMatch(/fatal|not a git repository/i);
    expect(result.reason).not.toMatch(/not registered/i);
  });

  it("still reports not_registered when the listing succeeds and the path is genuinely absent", async () => {
    const owner = await createGitRepo();
    // A standalone git checkout that is not a worktree of `owner`: the listing succeeds and
    // simply does not contain it, so `not_registered` remains the honest outcome.
    const stray = await createGitRepo();
    const result = await inspectManagedGitWorktreeBranch({
      worktreePath: stray,
      expectedBranchName: null,
      repoRoot: owner,
    });
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe("not_registered");
    expect(result.reason).toMatch(/not registered/i);
  });

  it("reports a registered, branch-matching worktree as valid", async () => {
    const owner = await createGitRepo();
    const parentDir = trackTempDir(await mkdtemp(path.join(os.tmpdir(), "pc-wt-parent-")));
    const worktree = path.join(parentDir, "wt");
    await runGit(owner, ["worktree", "add", "-b", "feature-branch", worktree]);
    const result = await inspectManagedGitWorktreeBranch({
      worktreePath: worktree,
      expectedBranchName: "feature-branch",
      repoRoot: owner,
    });
    expect(result.valid).toBe(true);
    expect(result.reasonCode).toBeNull();
    expect(result.actualBranchName).toBe("feature-branch");
  });
});
