import { execFile } from "node:child_process";
import { access, cp, mkdir as fsMkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  findRegisteredGitWorktreeByBranch,
  inspectManagedGitWorktreeBranch,
  realizeExecutionWorkspace,
  runGit,
} from "../services/workspace-runtime.ts";

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
    "does not parse a truncated registry as not_registered for a worktree in the discarded head",
    async () => {
      const owner = await createRepo();
      // Add enough worktrees that `git worktree list --porcelain` exceeds the cap. Each entry
      // pairs a ~150-char branch with a ~300-char nested path (~560 bytes), so 520 linked
      // worktrees put the listing well past 256 KiB. The earliest worktrees sit in the head of
      // the listing, which is exactly the half truncation throws away.
      const { firstWorktree, firstBranch } = await addOverCapWorktrees(owner, 520);
      // Guard the test's own validity: the listing must actually exceed the cap, otherwise the
      // scenario does not exercise truncation at all.
      const listing = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: owner });
      expect(Buffer.byteLength(listing.stdout, "utf8")).toBeGreaterThan(OUTPUT_CAP_BYTES);

      // Target the earliest linked worktree: on a truncated listing it is in the head that
      // gets cut off. A partial list must not parse as `not_registered`. Validation no longer
      // reads the registry, so a genuinely registered checkout stays valid.
      const result = await inspectManagedGitWorktreeBranch({
        worktreePath: await realpath(firstWorktree),
        expectedBranchName: firstBranch,
        repoRoot: owner,
      });
      expect(result.reasonCode).not.toBe("not_registered");
      expect(result.reason ?? "").not.toMatch(/truncat/i);
      expect(result.valid).toBe(true);
      expect(result.actualBranchName).toBe(firstBranch);
    },
    120_000,
  );
});

async function addOverCapWorktrees(owner: string, count: number): Promise<{ firstWorktree: string; firstBranch: string }> {
  const deepDir = path.join(owner, "a".repeat(100), "c".repeat(100), "e".repeat(100));
  const firstBranch = `br-000-${"b".repeat(150)}`;
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
  return { firstWorktree, firstBranch };
}

describe("single-worktree validation does not read the registry (SUP-20435)", () => {
  it(
    "validates a registered worktree on the expected branch when porcelain exceeds the cap",
    async () => {
      const owner = await createRepo();
      const { firstWorktree, firstBranch } = await addOverCapWorktrees(owner, 520);
      const listing = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: owner });
      expect(Buffer.byteLength(listing.stdout, "utf8")).toBeGreaterThan(OUTPUT_CAP_BYTES);

      const worktreePath = await realpath(firstWorktree);
      const result = await inspectManagedGitWorktreeBranch({
        worktreePath,
        expectedBranchName: firstBranch,
        repoRoot: owner,
      });
      expect(result.valid).toBe(true);
      expect(result.reasonCode).toBeNull();
      expect(result.actualBranchName).toBe(firstBranch);
      expect(result.repoRoot).toBe(await realpath(owner));
    },
    120_000,
  );

  it(
    "still reports not_registered for a checkout that is not a linked worktree of the repo",
    async () => {
      const owner = await createRepo();
      const stray = await createRepo();
      const result = await inspectManagedGitWorktreeBranch({
        worktreePath: stray,
        expectedBranchName: null,
        repoRoot: owner,
      });
      expect(result.valid).toBe(false);
      expect(result.reasonCode).toBe("not_registered");
      expect(result.reason).toMatch(/not registered/i);
    },
  );

  it("does not accept a copied checkout whose gitdir still names a live admin entry", async () => {
    const owner = await createRepo();
    const parent = trackTempDir(await mkdtemp(path.join(os.tmpdir(), "pc-rungit-copy-")));
    const worktree = path.join(parent, "wt");
    const copy = path.join(parent, "copy");
    await git(owner, ["worktree", "add", "-b", "feature-branch", worktree]);
    await cp(worktree, copy, { recursive: true });
    await rm(worktree, { recursive: true, force: true });

    const result = await inspectManagedGitWorktreeBranch({
      worktreePath: copy,
      expectedBranchName: "feature-branch",
      repoRoot: owner,
    });
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe("not_registered");
  });

  it(
    "does not return null for a registered branch solely because porcelain exceeds 256 KiB",
    async () => {
      const owner = await createRepo();
      const { firstWorktree, firstBranch } = await addOverCapWorktrees(owner, 520);
      const listing = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: owner });
      expect(Buffer.byteLength(listing.stdout, "utf8")).toBeGreaterThan(OUTPUT_CAP_BYTES);

      const found = await findRegisteredGitWorktreeByBranch(owner, firstBranch);
      expect(found).toBe(await realpath(firstWorktree));
      await expect(findRegisteredGitWorktreeByBranch(owner, "no-such-branch")).resolves.toBeNull();
    },
    120_000,
  );
});

describe("provisionExecutionWorktree serialization (SUP-20435)", () => {
  it("runs two concurrent provisions of one worktree one after the other", async () => {
    const repoRoot = await createRepo();
    const scriptsDir = path.join(repoRoot, "scripts");
    await fsMkdir(scriptsDir, { recursive: true });
    const sentinel = path.join(repoRoot, "provision-overlap");
    const started = path.join(repoRoot, "provision-started");
    const release = path.join(repoRoot, "provision-release");
    const script = [
      "#!/bin/sh",
      "if [ -f \"$SENTINEL\" ]; then echo overlap >&2; exit 86; fi",
      "echo $$ > \"$SENTINEL\"",
      "echo $$ > \"$STARTED\"",
      "while [ ! -f \"$RELEASE\" ]; do sleep 0.05; done",
      "rm -f \"$SENTINEL\"",
    ].join("\n");
    await writeFile(path.join(scriptsDir, "provision.sh"), `${script}\n`, "utf8");
    await git(repoRoot, ["add", "scripts/provision.sh"]);
    await git(repoRoot, ["commit", "-m", "provision script"]);

    const provisionCommand = [
      `SENTINEL=${JSON.stringify(sentinel)}`,
      `STARTED=${JSON.stringify(started)}`,
      `RELEASE=${JSON.stringify(release)}`,
      "sh ./scripts/provision.sh",
    ].join(" ");
    const realize = () => realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "SUP-20435-provision-lock",
          provisionCommand,
        },
      },
      issue: {
        id: "issue-1",
        identifier: "SUP-20435",
        title: "Serialize provision",
      },
      agent: {
        id: "agent-1",
        name: "Coder",
        companyId: "company-1",
      },
    });

    const first = realize();
    const startedAt = Date.now();
    while (true) {
      try {
        await access(started);
        break;
      } catch {
        if (Date.now() - startedAt > 10_000) throw new Error("first provision never started");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const second = realize();
    await writeFile(release, "go\n", "utf8");
    const [left, right] = await Promise.all([first, second]);
    expect(left.cwd).toBe(right.cwd);
    expect(left.created).toBe(true);
    expect(right.created).toBe(false);
  }, 30_000);
});
