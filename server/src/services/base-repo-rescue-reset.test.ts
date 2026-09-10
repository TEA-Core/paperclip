import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resetBaseRepoToBaseRefWithRescue, resetProjectBaseRepoWithRescue } from "./workspace-runtime.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

let tempDirs: string[] = [];

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pc-base-repo-rescue-"));
  tempDirs.push(dir);
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "paperclip-test@example.com");
  git(dir, "config", "user.name", "Paperclip Test");
  fs.writeFileSync(path.join(dir, "a.txt"), "first\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-m", "first");
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("resetProjectBaseRepoWithRescue", () => {
  it("pins the prior tip on a rescue ref, verifies it, then resets to the target", async () => {
    const repoRoot = await makeRepo();
    const shaA = git(repoRoot, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "second\n");
    git(repoRoot, "add", "a.txt");
    git(repoRoot, "commit", "-m", "second");
    const shaB = git(repoRoot, "rev-parse", "HEAD");

    const result = await resetProjectBaseRepoWithRescue({ repoRoot, targetRef: shaA });

    expect(result.reset).toBe(true);
    expect(result.refused).toBeNull();
    expect(result.priorTip).toBe(shaB);
    expect(result.targetSha).toBe(shaA);
    expect(result.rescueRef).not.toBeNull();
    // The pin must independently resolve back to the prior tip.
    expect(git(repoRoot, "rev-parse", result.rescueRef as string)).toBe(shaB);
    // HEAD must now sit on the target.
    expect(git(repoRoot, "rev-parse", "HEAD")).toBe(shaA);
  });

  it("records no root-owned refs: the rescue ref file is owned by the running uid", async () => {
    const repoRoot = await makeRepo();
    const shaA = git(repoRoot, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "second\n");
    git(repoRoot, "add", "a.txt");
    git(repoRoot, "commit", "-m", "second");

    const result = await resetProjectBaseRepoWithRescue({ repoRoot, targetRef: shaA });

    expect(result.reset).toBe(true);
    const refFile = path.join(repoRoot, ".git", result.rescueRef as string);
    const info = await stat(refFile);
    // The server runs as the repo-owning uid; the rescue ref it writes must not
    // be owned by another user (e.g. root via a root-capable exec).
    expect(info.uid).toBe(process.getuid?.());
  });

  it("refuses a dirty worktree and moves nothing", async () => {
    const repoRoot = await makeRepo();
    const shaA = git(repoRoot, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "second\n");
    git(repoRoot, "add", "a.txt");
    git(repoRoot, "commit", "-m", "second");
    const shaB = git(repoRoot, "rev-parse", "HEAD");
    // Dirty tracked change on top of the diverged tip.
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "modified-after-commit\n");

    const result = await resetProjectBaseRepoWithRescue({ repoRoot, targetRef: shaA });

    expect(result.reset).toBe(false);
    expect(result.rescueRef).toBeNull();
    expect(result.refused).toMatch(/uncommitted tracked change/);
    expect(git(repoRoot, "rev-parse", "HEAD")).toBe(shaB);
  });

  it("refuses an already-clean head that is at the target ref", async () => {
    const repoRoot = await makeRepo();
    const shaA = git(repoRoot, "rev-parse", "HEAD");
    const result = await resetProjectBaseRepoWithRescue({ repoRoot, targetRef: "main" });
    expect(result.reset).toBe(false);
    expect(result.refused).toMatch(/already at the target ref/);
    expect(result.priorTip).toBe(shaA);
  });

  it("refuses a target ref that does not resolve to a commit", async () => {
    const repoRoot = await makeRepo();
    const before = git(repoRoot, "rev-parse", "HEAD");
    const result = await resetProjectBaseRepoWithRescue({ repoRoot, targetRef: "does-not-exist-branch" });
    expect(result.reset).toBe(false);
    expect(result.refused).toMatch(/does not resolve to a commit/);
    expect(git(repoRoot, "rev-parse", "HEAD")).toBe(before);
  });

  it("refuses a target ref that git could interpret as a flag", async () => {
    const repoRoot = await makeRepo();
    const before = git(repoRoot, "rev-parse", "HEAD");
    const result = await resetProjectBaseRepoWithRescue({ repoRoot, targetRef: "--help" });
    expect(result.reset).toBe(false);
    expect(result.refused).toMatch(/not a valid ref/);
    expect(git(repoRoot, "rev-parse", "HEAD")).toBe(before);
  });

  it("F4: refuses when the base repo has unmerged paths from a merge conflict", async () => {
    const repoRoot = await makeRepo();
    // Create a divergent branch with a conflicting change on the same file.
    git(repoRoot, "checkout", "-b", "feature");
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "feature-version\n");
    git(repoRoot, "add", "a.txt");
    git(repoRoot, "commit", "-m", "feature change");
    // Switch back to main and make a conflicting change to the same file.
    git(repoRoot, "checkout", "main");
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "main-version\n");
    git(repoRoot, "add", "a.txt");
    git(repoRoot, "commit", "-m", "main change");
    // Merge feature into main — this produces a conflict on a.txt.
    // A conflicted merge exits non-zero, so catch it.
    try {
      git(repoRoot, "merge", "feature", "--no-ff", "--no-commit");
    } catch {
      // Expected: merge conflict causes non-zero exit.
    }
    const status = git(repoRoot, "status", "--porcelain");
    expect(status).toMatch(/^(UU|AA|DD)/m);

    const shaMainBefore = git(repoRoot, "rev-parse", "HEAD");
    const result = await resetProjectBaseRepoWithRescue({ repoRoot, targetRef: "main" });
    expect(result.reset).toBe(false);
    expect(result.rescueRef).toBeNull();
    expect(result.refused).toMatch(/unmerged path/);
    // HEAD must not have moved.
    expect(git(repoRoot, "rev-parse", "HEAD")).toBe(shaMainBefore);
  });

  it("F1: CAS guard fails when HEAD changed between capture and reset", async () => {
    const repoRoot = await makeRepo();
    const shaA = git(repoRoot, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "second\n");
    git(repoRoot, "add", "a.txt");
    git(repoRoot, "commit", "-m", "second");
    const shaB = git(repoRoot, "rev-parse", "HEAD");

    // Simulate a stale priorTip: the capture said HEAD was shaA, but it's actually shaB.
    const result = await resetBaseRepoToBaseRefWithRescue({
      repoRoot,
      baseRef: "main",
      baseRefSha: shaA,
      priorTip: shaA, // stale — HEAD is actually shaB
      aheadCount: 1,
      operatorDirected: true,
    });
    expect(result.reset).toBe(false);
    // The rescue ref was created (pinned the stale tip), but the reset was refused.
    expect(result.rescueRef).not.toBeNull();
    expect(result.warnings[0]).toMatch(/changed between capture and reset/);
    // HEAD is still at shaB — nothing was reset.
    expect(git(repoRoot, "rev-parse", "HEAD")).toBe(shaB);
  });

  it("F2: two rescue resets in the same second produce distinct refs", async () => {
    const repoRoot = await makeRepo();
    const shaA = git(repoRoot, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "second\n");
    git(repoRoot, "add", "a.txt");
    git(repoRoot, "commit", "-m", "second");
    const shaB = git(repoRoot, "rev-parse", "HEAD");

    const r1 = await resetBaseRepoToBaseRefWithRescue({
      repoRoot,
      baseRef: "main",
      baseRefSha: shaA,
      priorTip: shaB,
      aheadCount: 1,
      operatorDirected: true,
    });
    expect(r1.reset).toBe(true);
    const ref1 = r1.rescueRef!;

    // Create another commit and do a second reset.
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "third\n");
    git(repoRoot, "add", "a.txt");
    git(repoRoot, "commit", "-m", "third");
    const shaC = git(repoRoot, "rev-parse", "HEAD");

    const r2 = await resetBaseRepoToBaseRefWithRescue({
      repoRoot,
      baseRef: "main",
      baseRefSha: shaA,
      priorTip: shaC,
      aheadCount: 1,
      operatorDirected: true,
    });
    expect(r2.reset).toBe(true);
    const ref2 = r2.rescueRef!;

    expect(ref1).not.toBe(ref2);
  });
});
