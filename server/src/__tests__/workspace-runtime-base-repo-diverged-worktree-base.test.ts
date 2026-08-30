import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { realizeExecutionWorkspace, prepareBaseRepoForWorkspace } from "../services/workspace-runtime.ts";

// SUP-14458 — when base-repo hygiene ends in diverged-without-reset or indeterminate,
// the worktree must be based on the verified remote-tracking tip, never on the local
// branch that carries unpushed commits. If the remote tip cannot be resolved, the
// checkout must fail with an explicit reason.

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  return stdout.trim();
}

async function gitVoid(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

async function commit(repo: string, name: string, message?: string): Promise<void> {
  await fs.writeFile(path.join(repo, name), `${name}\n`);
  await gitVoid(["add", "-A"], repo);
  await gitVoid(["commit", "-qm", message ?? name], repo);
}

type Fixture = { root: string; origin: string; seed: string; work: string };

async function makeOriginAndClone(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sup14458-"));
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

/** Advance origin, then refresh the clone's remote-tracking ref. */
async function publish(f: Fixture): Promise<void> {
  await gitVoid(["push", "-q", "origin", "main"], f.seed);
  await gitVoid(["fetch", "-q", "origin", "main"], f.work);
}

function realizeWorktree(repoRoot: string) {
  return realizeExecutionWorkspace({
    base: {
      baseCwd: repoRoot,
      source: "project_primary",
      projectId: "project-1",
      workspaceId: "workspace-1",
      repoUrl: null,
      repoRef: null,
    },
    config: {
      workspaceStrategy: {
        type: "git_worktree",
        branchTemplate: "{{issue.identifier}}-{{slug}}",
      },
    },
    issue: {
      id: "issue-1",
      identifier: "PAP-999",
      title: "Test Diverged Base",
    },
    agent: {
      id: "agent-1",
      name: "Test Agent",
      companyId: "company-1",
    },
  });
}

describe("diverged base repo: worktree branches from remote tip, not local (SUP-14458)", () => {
  it("bases the worktree on the remote-tracking tip when the local branch has a unique ahead commit", async () => {
    const f = await makeOriginAndClone();

    // Local main: one unique commit that is NOT upstream by patch-id.
    await commit(f.work, "only-here");
    const localTip = await git(["rev-parse", "HEAD"], f.work);

    // Origin main: one new commit (so the local branch is behind).
    await commit(f.seed, "c4");
    await publish(f);
    const originTip = await git(["rev-parse", "origin/main"], f.work);

    expect(localTip).not.toBe(originTip);

    const workspace = await realizeWorktree(f.work);

    // Acceptance 1: the worktree HEAD equals the remote-tracking tip.
    const worktreeHead = await git(["rev-parse", "HEAD"], workspace.worktreePath!);
    expect(worktreeHead).toBe(originTip);

    // The worktree does NOT contain the local-only commit.
    const log = await git(["log", "--format=%s", "--oneline"], workspace.worktreePath!);
    expect(log).not.toContain("only-here");

    // Acceptance 2: the local ahead commit remains reachable in the base repo.
    expect(await git(["rev-parse", "HEAD"], f.work)).toBe(localTip);

    // Acceptance 4: the hygiene warning names the sha the worktree was based on.
    const warning = workspace.warnings.find((w) => w.includes("has diverged from"));
    expect(warning, `warnings were: ${JSON.stringify(workspace.warnings)}`).toBeDefined();
    expect(warning).toContain(originTip.slice(0, 12));
    expect(warning).toContain("verified remote tip");
  });

  it("prepareBaseRepoForWorkspace returns worktreeBaseSha = remote tip and localBaseUnsafe = true", async () => {
    const f = await makeOriginAndClone();
    await commit(f.work, "only-here");
    await commit(f.seed, "c4");
    await publish(f);
    const originTip = await git(["rev-parse", "origin/main"], f.work);

    const result = await prepareBaseRepoForWorkspace({ repoRoot: f.work, configuredBaseRef: "main" });

    expect(result.localBaseUnsafe).toBe(true);
    expect(result.worktreeBaseSha).toBe(originTip);
    expect(result.worktreeBaseRef).toBe("origin/main");
  });
});

describe("diverged base repo with unresolvable remote tip: checkout is refused (SUP-14458)", () => {
  it("realizeExecutionWorkspace throws when no remote tip can be resolved", async () => {
    const f = await makeOriginAndClone();

    // Create a shallow clone to sever ancestry (indeterminate path).
    const shallowWork = path.join(f.root, "shallow-work");
    await gitVoid(["clone", "-q", "--depth", "1", `file://${f.origin}`, shallowWork], f.root);

    // Remove the origin remote and the remote-tracking ref so no remote tip is resolvable.
    await gitVoid(["remote", "remove", "origin"], shallowWork);
    await gitVoid(["update-ref", "-d", "refs/remotes/origin/main"], shallowWork);

    // Add a unique commit to local main so it is genuinely ahead of (the now-gone) upstream.
    await commit(shallowWork, "local-only-commit");

    // Verify: no origin remote, no origin/main ref.
    await expect(git(["remote", "-v"], shallowWork)).resolves.toBe("");
    await expect(git(["rev-parse", "--verify", "refs/remotes/origin/main"], shallowWork))
      .rejects.toThrow();

    await expect(realizeWorktree(shallowWork)).rejects.toThrow(
      /no verified remote tip could be resolved/i,
    );
  });

  it("prepareBaseRepoForWorkspace returns worktreeBaseSha = null when remote tip is unresolvable", async () => {
    const f = await makeOriginAndClone();
    const shallowWork = path.join(f.root, "shallow-work2");
    await gitVoid(["clone", "-q", "--depth", "1", `file://${f.origin}`, shallowWork], f.root);
    await gitVoid(["remote", "remove", "origin"], shallowWork);
    await gitVoid(["update-ref", "-d", "refs/remotes/origin/main"], shallowWork);

    const result = await prepareBaseRepoForWorkspace({ repoRoot: shallowWork, configuredBaseRef: "main" });

    expect(result.localBaseUnsafe).toBe(true);
    expect(result.worktreeBaseSha).toBeNull();
    const warning = result.warnings.find((w) => w.includes("indeterminate"));
    expect(warning, `warnings were: ${JSON.stringify(result.warnings)}`).toBeDefined();
    expect(warning).toContain("No verified remote tip could be resolved");
  });
});
