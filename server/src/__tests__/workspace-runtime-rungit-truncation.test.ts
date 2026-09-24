import { execFile } from "node:child_process";
import { mkdir as fsMkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { inspectManagedGitWorktreeBranch, runGit } from "../services/workspace-runtime.ts";

const execFileAsync = promisify(execFile);

// `executeProcess` caps stdout at this value and keeps only the LAST bytes, so a git result
// larger than this is truncated and flagged `stdoutTruncated`. runGit must refuse to return
// the truncated string as if it were complete.
const OUTPUT_CAP_BYTES = 256 * 1024;

const tempDirs: string[] = [];

function trackTempDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createRepo(): Promise<string> {
  const repoRoot = trackTempDir(await mkdtemp(path.join(os.tmpdir(), "pc-rungit-trunc-")));
  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.email", "paperclip-test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await git(repoRoot, ["commit", "--allow-empty", "-m", "initial"]);
  return repoRoot;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

describe("runGit stdout truncation guard (SUP-17416)", () => {
  it("fails closed instead of returning a truncated stdout as complete", async () => {
    const repoRoot = await createRepo();
    // A commit message far above the cap, read from a file (a 300 KB message as a CLI arg
    // would hit E2BIG). `git log` then emits more than OUTPUT_CAP_BYTES, so executeProcess
    // truncates and flags stdoutTruncated. Red on current code, which returns the truncated
    // string as if complete.
    const bigMessage = "x".repeat(300 * 1024);
    const messagePath = path.join(repoRoot, ".trunc-msg");
    await writeFile(messagePath, bigMessage, "utf8");
    await git(repoRoot, ["commit", "--allow-empty", "-F", messagePath]);
    await expect(runGit(["log", "-1", "--format=%B"], repoRoot)).rejects.toThrow(/truncat/i);
  });

  it("does not throw for output under the cap (non-truncated behavior unchanged)", async () => {
    const repoRoot = await createRepo();
    const sha = await runGit(["rev-parse", "HEAD"], repoRoot);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("inspectManagedGitWorktreeBranch truncation triage (SUP-17416)", () => {
  it(
    "reports worktree_list_failed — not a silently-partial registration set — when `worktree list` truncates",
    async () => {
      const owner = await createRepo();
      // Add enough worktrees that `git worktree list --porcelain` exceeds the cap. Each entry
      // pairs a ~150-char branch with a ~300-char nested path (~560 bytes), so 520 linked
      // worktrees put the listing well past 256 KiB. The earliest worktrees sit in the head of
      // the listing, which is exactly the half truncation throws away.
      const deepDir = path.join(owner, "a".repeat(100), "c".repeat(100), "e".repeat(100));
      const count = 520;
      const firstWorktree = path.join(deepDir, "w000", "wt");
      for (let i = 0; i < count; i++) {
        const dir = path.join(deepDir, `w${String(i).padStart(3, "0")}`);
        await fsMkdir(dir, { recursive: true });
        await git(owner, [
          "worktree",
          "add",
          "-q",
          "-b",
          `br-${String(i).padStart(3, "0")}-${"b".repeat(150)}`,
          path.join(dir, "wt"),
        ]);
      }
      // Guard the test's own validity: the listing must actually exceed the cap, otherwise the
      // scenario does not exercise truncation at all.
      const listing = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: owner });
      expect(Buffer.byteLength(listing.stdout, "utf8")).toBeGreaterThan(OUTPUT_CAP_BYTES);

      // Target the earliest linked worktree: on a truncated listing it is in the head that
      // gets cut off. Before the guard this read as `not_registered` (a silently-partial set);
      // after it, the whole listing is refused and reported as a list failure.
      const result = await inspectManagedGitWorktreeBranch({
        worktreePath: await realpath(firstWorktree),
        expectedBranchName: null,
        repoRoot: owner,
      });
      expect(result.valid).toBe(false);
      expect(result.reasonCode).toBe("worktree_list_failed");
      expect(result.reasonCode).not.toBe("not_registered");
      expect(result.reason).toMatch(/git worktree list failed/i);
      expect(result.reason).toMatch(/truncat/i);
    },
    120_000,
  );
});
