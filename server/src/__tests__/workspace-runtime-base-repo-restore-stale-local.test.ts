import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { prepareBaseRepoForWorkspace } from "../services/workspace-runtime.ts";

// SUP-22022 — base-repo hygiene "restore" must land the repo on the configured
// base ref's commit. `git checkout --force <branch>` resolves refs/heads/<branch>,
// so a same-named local branch that is stale (or diverged) must never take the
// checkout: on the managed reuse path the "base repo" can be an execution
// worktree itself, and that checkout once moved it backward off the
// remote-tracking base tip.

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv });
  return stdout.trim();
}

async function gitVoid(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd, env: gitEnv });
}

async function commit(repo: string, name: string): Promise<void> {
  await fs.writeFile(path.join(repo, name), `${name}\n`);
  await gitVoid(["add", "-A"], repo);
  await gitVoid(["commit", "-qm", name], repo);
}

type Fixture = { root: string; origin: string; seed: string; work: string };

async function makeOriginAndClone(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sup22022-"));
  tempRoots.push(root);
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");

  await gitVoid(["init", "-q", "--bare", "-b", "main", origin], root);
  await gitVoid(["init", "-q", "-b", "main", seed], root);
  await commit(seed, "c1");
  await gitVoid(["remote", "add", "origin", origin], seed);
  await gitVoid(["push", "-q", "origin", "main"], seed);
  await gitVoid(["clone", "-q", `file://${origin}`, work], root);

  return { root, origin, seed, work };
}

/** Create origin/base-branch one commit ahead of main. */
async function publishBaseBranch(f: Fixture, name: string): Promise<string> {
  await gitVoid(["checkout", "-q", "-b", "base-branch"], f.seed);
  await commit(f.seed, name);
  await gitVoid(["push", "-q", "origin", "base-branch"], f.seed);
  await gitVoid(["fetch", "-q", "origin"], f.work);
  return git(["rev-parse", "origin/base-branch"], f.work);
}

describe("restore base repo: stale same-named local branch (SUP-22022)", () => {
  it("lands the repo on the remote-tracking base tip instead of a stale local branch", async () => {
    const f = await makeOriginAndClone();

    // origin/base-branch at c2; the clone gets a local branch at the same commit.
    await gitVoid(["checkout", "-q", "-b", "base-branch"], f.seed);
    await commit(f.seed, "c2");
    await gitVoid(["push", "-q", "origin", "base-branch"], f.seed);
    await gitVoid(["fetch", "-q", "origin"], f.work);
    await gitVoid(["branch", "base-branch", "origin/base-branch"], f.work);
    const staleTip = await git(["rev-parse", "refs/heads/base-branch"], f.work);

    // origin advances; the clone refreshes the remote-tracking ref only, so the
    // same-named local branch is now stale (behind).
    await commit(f.seed, "c3");
    await gitVoid(["push", "-q", "origin", "base-branch"], f.seed);
    await gitVoid(["fetch", "-q", "origin"], f.work);
    const baseTip = await git(["rev-parse", "origin/base-branch"], f.work);
    expect(baseTip).not.toBe(staleTip);

    // Incident shape: the "base repo" sits on its own task branch, already at
    // the remote base tip, while the same-named local branch is stale.
    await gitVoid(["checkout", "-q", "-B", "SUP-22022-task", "origin/base-branch"], f.work);

    const prepared = await prepareBaseRepoForWorkspace({
      repoRoot: f.work,
      configuredBaseRef: "origin/base-branch",
    });

    // The repo never moves backward: HEAD is the configured base ref's commit.
    expect(await git(["rev-parse", "HEAD"], f.work)).toBe(baseTip);
    // The stale local branch ref is left untouched.
    expect(await git(["rev-parse", "refs/heads/base-branch"], f.work)).toBe(staleTip);
    // The detach is explained, not silent.
    const warning = prepared.warnings.find((w) => w.includes(`local branch "base-branch" is stale at`));
    expect(warning, `warnings were: ${JSON.stringify(prepared.warnings)}`).toBeDefined();
    expect(prepared.baseRefSha).toBe(baseTip);
  }, 20_000);

  it("detaches at the base tip when the same-named local branch has diverged", async () => {
    const f = await makeOriginAndClone();
    const originTip = await publishBaseBranch(f, "c2");

    // A local base-branch carrying a commit origin never saw.
    await gitVoid(["branch", "base-branch"], f.work);
    await gitVoid(["checkout", "-q", "base-branch"], f.work);
    await commit(f.work, "local-only");
    const localTip = await git(["rev-parse", "refs/heads/base-branch"], f.work);
    expect(localTip).not.toBe(originTip);

    await gitVoid(["checkout", "-q", "main"], f.work);

    await prepareBaseRepoForWorkspace({
      repoRoot: f.work,
      configuredBaseRef: "origin/base-branch",
    });

    expect(await git(["rev-parse", "HEAD"], f.work)).toBe(originTip);
    expect(await git(["rev-parse", "refs/heads/base-branch"], f.work)).toBe(localTip);
  }, 20_000);

  it("still checks out the local branch when it already points at the base tip", async () => {
    const f = await makeOriginAndClone();
    const baseTip = await publishBaseBranch(f, "c2");
    // In-sync local branch; the base repo itself is on main (wrong branch).
    await gitVoid(["branch", "base-branch", "origin/base-branch"], f.work);

    await prepareBaseRepoForWorkspace({
      repoRoot: f.work,
      configuredBaseRef: "origin/base-branch",
    });

    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], f.work)).toBe("base-branch");
    expect(await git(["rev-parse", "HEAD"], f.work)).toBe(baseTip);
  }, 20_000);

  it("creates the local branch at the remote tip when none exists locally", async () => {
    const f = await makeOriginAndClone();
    const baseTip = await publishBaseBranch(f, "c2");

    await prepareBaseRepoForWorkspace({
      repoRoot: f.work,
      configuredBaseRef: "origin/base-branch",
    });

    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], f.work)).toBe("base-branch");
    expect(await git(["rev-parse", "HEAD"], f.work)).toBe(baseTip);
  }, 20_000);
});
