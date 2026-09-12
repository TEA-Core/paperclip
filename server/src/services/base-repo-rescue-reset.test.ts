import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resetBaseRepoToBaseRefWithRescue, resetProjectBaseRepoWithRescue, withBaseRepoResetLock } from "./workspace-runtime.js";

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

  it("operator vs auto: concurrent resets on the same tip fail closed — one wins, no tip discarded", async () => {
    const repoRoot = await makeRepo();
    const shaA = git(repoRoot, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "second\n");
    git(repoRoot, "add", "a.txt");
    git(repoRoot, "commit", "-m", "second");
    const shaB = git(repoRoot, "rev-parse", "HEAD");

    // An operator reset and an auto-reset content-proof reset race to move the same
    // base repo from tip shaB to target shaA. Both now funnel through the single
    // lock-protected entry point, so the destructive sequence is serialized on one
    // canonical (common-root) key and the compare-and-swap fails closed. Whatever
    // the scheduler order, exactly one reset may succeed; the tip the winner
    // discards must survive on a rescue ref; and the repo must end on the target.
    // These invariants hold deterministically, so no reliance on when the two
    // calls happen to interleave.
    const [operator, auto] = await Promise.all([
      resetProjectBaseRepoWithRescue({ repoRoot, targetRef: shaA }),
      resetBaseRepoToBaseRefWithRescue({
        repoRoot,
        baseRef: "main",
        baseRefSha: shaA,
        priorTip: shaB,
        aheadCount: 1,
        operatorDirected: false,
      }),
    ]);

    const winners = [operator, auto].filter((r) => r.reset);
    expect(winners.length).toBe(1);

    const winner = winners[0];
    expect(winner.rescueRef).not.toBeNull();
    const loser = operator.reset ? auto : operator;
    expect(loser.reset).toBe(false);

    // No tip was discarded: the winner pinned the prior tip on a rescue ref that
    // still resolves to shaB.
    expect(git(repoRoot, "rev-parse", winner.rescueRef as string)).toBe(shaB);
    // The repo ends on the target.
    expect(git(repoRoot, "rev-parse", "HEAD")).toBe(shaA);
  });

  it("pins the newest tip when a newer commit lands before the reset", async () => {
    const repoRoot = await makeRepo();
    const shaA = git(repoRoot, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "second\n");
    git(repoRoot, "add", "a.txt");
    git(repoRoot, "commit", "-m", "second");
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "third\n");
    git(repoRoot, "add", "a.txt");
    git(repoRoot, "commit", "-m", "third");
    const shaC = git(repoRoot, "rev-parse", "HEAD");

    // The prior tip is the newest commit shaC. A reset to shaA must pin that newest
    // tip on the rescue ref, not an older one, so no unshipped commit is lost.
    const result = await resetBaseRepoToBaseRefWithRescue({
      repoRoot,
      baseRef: "main",
      baseRefSha: shaA,
      priorTip: shaC,
      aheadCount: 2,
      operatorDirected: true,
    });
    expect(result.reset).toBe(true);
    expect(git(repoRoot, "rev-parse", result.rescueRef as string)).toBe(shaC);
    expect(git(repoRoot, "rev-parse", "HEAD")).toBe(shaA);
  });
});

describe("withBaseRepoResetLock", () => {
  it("serializes concurrent holders for the same repo root", async () => {
    let active = 0;
    let maxSimultaneous = 0;
    const work = () =>
      withBaseRepoResetLock("/tmp/same-repo", async () => {
        active += 1;
        maxSimultaneous = Math.max(maxSimultaneous, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
      });
    await Promise.all([work(), work(), work()]);
    // Same repo root, three racers: never more than one holder runs at once.
    expect(maxSimultaneous).toBe(1);
  });

  it("does not serialize distinct repo roots against each other", async () => {
    let active = 0;
    let maxSimultaneous = 0;
    const work = (repoRoot: string) =>
      withBaseRepoResetLock(repoRoot, async () => {
        active += 1;
        maxSimultaneous = Math.max(maxSimultaneous, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
      });
    await Promise.all([work("/tmp/repo-a"), work("/tmp/repo-b")]);
    // Different repos take different locks and run together.
    expect(maxSimultaneous).toBe(2);
  });

  it("serializes two alias paths to the same physical repo (canonical key)", async () => {
    const repoRoot = await makeRepo();
    const aliasPath = `${repoRoot}-alias`;
    fs.symlinkSync(repoRoot, aliasPath, "dir");
    tempDirs.push(aliasPath);
    let active = 0;
    let maxSimultaneous = 0;
    const touch = (p: string) =>
      withBaseRepoResetLock(p, async () => {
        active += 1;
        maxSimultaneous = Math.max(maxSimultaneous, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
      });
    await Promise.all([touch(repoRoot), touch(aliasPath)]);
    // The alias is a symlink to the same physical repo. The old path.resolve key
    // treated the two distinct strings as two repos and let them race; the
    // realpath-collapsed canonical key makes them share one lock.
    expect(maxSimultaneous).toBe(1);
  });

  it("serializes the owner repo and a linked worktree of it (same common root)", async () => {
    const repoRoot = await makeRepo();
    const wtPath = `${repoRoot}-worktree`;
    git(repoRoot, "worktree", "add", "--detach", wtPath);
    tempDirs.push(wtPath);
    let active = 0;
    let maxSimultaneous = 0;
    const touch = (p: string) =>
      withBaseRepoResetLock(p, async () => {
        active += 1;
        maxSimultaneous = Math.max(maxSimultaneous, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
      });
    await Promise.all([touch(repoRoot), touch(wtPath)]);
    // A linked worktree's --git-common-dir is the owner's .git, so the operator and
    // auto paths reached through different checkouts of one repo must collapse onto
    // a single lock. Without common-root canonicalization the two strings resolve to
    // different keys and the destructive reset races.
    expect(maxSimultaneous).toBe(1);
  });

  it("does not wedge the queue when a holder rejects", async () => {
    await expect(
      withBaseRepoResetLock("/tmp/wedge-repo", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A later holder on the same repo still runs to completion.
    await expect(
      withBaseRepoResetLock("/tmp/wedge-repo", async () => "recovered"),
    ).resolves.toBe("recovered");
  });
});
