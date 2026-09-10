import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resetProjectBaseRepoWithRescue } from "./workspace-runtime.js";

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
});
