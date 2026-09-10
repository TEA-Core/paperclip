import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realizeExecutionWorkspace, prepareBaseRepoForWorkspace } from "../services/workspace-runtime.ts";
import { divergenceRecordPath, readDivergenceRecord } from "../services/base-repo-divergence-alert.ts";

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

describe("stale remote tip after a failed fetch must not be trusted (SUP-14458)", () => {
  // Primary finding: resolveRemoteTrackingBaseTip discarded the failure warnings from
  // refreshRemoteTrackingBaseRef, so when a fetch fails the cached origin/<branch> ref is
  // still stale — yet it was resolved and handed back as the "verified" remote tip. When the
  // refresh cannot be completed the stale ref must NOT be promoted; the caller must refuse.

  /** Point `origin` at a nonexistent path so every fetch fails while the cached
   *  refs/remotes/origin/main ref remains resolvable locally (stale). */
  async function severOrigin(f: Fixture): Promise<void> {
    await gitVoid(["remote", "set-url", "origin", `file://${f.root}/does-not-exist.git`], f.work);
  }

  it("prepareBaseRepoForWorkspace refuses to base on the stale ref when the fetch fails", async () => {
    const f = await makeOriginAndClone();

    // Diverge: a local-only ahead commit + an origin advance so the local branch is ahead+behind.
    await commit(f.work, "only-here");
    await commit(f.seed, "c4");
    await publish(f);
    const staleTip = await git(["rev-parse", "origin/main"], f.work);

    // Break the fetch. The stale remote-tracking ref must still resolve locally.
    await severOrigin(f);
    expect(await git(["rev-parse", "origin/main"], f.work)).toBe(staleTip);

    const result = await prepareBaseRepoForWorkspace({ repoRoot: f.work, configuredBaseRef: "main" });

    // The stale ref is present but unverified: refuse to base the worktree on it.
    expect(result.localBaseUnsafe).toBe(true);
    expect(result.worktreeBaseSha).toBeNull();
    const warning = result.warnings.find((w) => w.includes("No verified remote tip could be resolved"));
    expect(warning, `warnings were: ${JSON.stringify(result.warnings)}`).toBeDefined();
    expect(warning).not.toContain(staleTip);
  });

  it("realizeExecutionWorkspace throws when the base ref resolves to a stale ref after a failed fetch", async () => {
    const f = await makeOriginAndClone();
    await commit(f.work, "only-here");
    await commit(f.seed, "c4");
    await publish(f);
    await severOrigin(f);

    // Force the remote-tracking base-ref path (repoRef "main" -> "origin/main"), where the
    // stale cached ref is present but the fetch now fails.
    await expect(
      realizeExecutionWorkspace({
        base: {
          baseCwd: f.work,
          source: "project_primary",
          projectId: "project-1",
          workspaceId: "workspace-stale",
          repoUrl: null,
          repoRef: "main",
        },
        config: {
          workspaceStrategy: {
            type: "git_worktree",
            branchTemplate: "{{issue.identifier}}-{{slug}}",
          },
        },
        issue: {
          id: "issue-stale",
          identifier: "PAP-998",
          title: "Stale Tip",
        },
      agent: {
        id: "agent-1",
        name: "Test Agent",
        companyId: "company-1",
      },
    }),
  ).rejects.toThrow(/no verified remote tip could be resolved/i);
  });
});

describe("base-repo divergence first-class signal wiring (SUP-15615)", () => {
  it("returns divergenceAlert = null and leaves no record for an in-sync base repo", async () => {
    const f = await makeOriginAndClone();
    const result = await prepareBaseRepoForWorkspace({ repoRoot: f.work, configuredBaseRef: "main" });
    expect(result.divergenceAlert).toBeNull();
    // In-sync base: nothing tracked, and any stale sidecar is cleared.
    expect(await readDivergenceRecord(f.work)).toBeNull();
  });

  it("starts tracking a diverged-refused base repo but does not alert while under the age threshold", async () => {
    const f = await makeOriginAndClone();
    await commit(f.work, "only-here");
    await commit(f.seed, "c4");
    await publish(f);

    const result = await prepareBaseRepoForWorkspace({ repoRoot: f.work, configuredBaseRef: "main" });

    expect(result.localBaseUnsafe).toBe(true);
    // A just-observed divergence is far under the 7-day threshold: no first-class
    // signal yet, but tracking has begun so the age starts accumulating.
    expect(result.divergenceAlert).toBeNull();
    expect(await readDivergenceRecord(f.work)).not.toBeNull();
  });
});

// SUP-15647 — the divergence episode must be keyed on a stable repository
// identity (the checkout's canonical fetch-remote URL), not the mutable checkout
// path. A different repository materialized at the same path must start a fresh
// episode instead of inheriting the previous one's age; an unchanged repository
// must carry its episode start forward.
describe("divergence episode keyed on canonical repo identity (SUP-15647)", () => {
  // A fixed "now" makes the age math exact: the second observation is measured
  // at NOW, and a 10-day-old episode is NOW - 10 days (the default threshold is
  // 7 days, so that old episode is over due).
  const NOW = 1700000000000;
  const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Put the base checkout into the non-resettable diverged-refused state (a
   *  unique local ahead commit plus an origin advance), so
   *  prepareBaseRepoForWorkspace reaches observeDivergedRefusal. */
  async function makeDivergedRefused(f: Fixture): Promise<void> {
    await commit(f.work, "only-here");
    await commit(f.seed, "c4");
    await publish(f);
  }

  /** Seed the sidecar through the production path, then back-date it so the
   *  episode appears to have persisted for TEN_DAYS_MS. */
  async function seedAndAgeSidecar(repoRoot: string): Promise<void> {
    await prepareBaseRepoForWorkspace({ repoRoot, configuredBaseRef: "main" });
    const seeded = await readDivergenceRecord(repoRoot);
    expect(seeded, "seed must write a divergence sidecar").not.toBeNull();
    await fs.writeFile(
      divergenceRecordPath(repoRoot),
      JSON.stringify({
        ...seeded,
        firstObservedAtMs: NOW - TEN_DAYS_MS,
        lastObservedAtMs: NOW - TEN_DAYS_MS,
      }),
      "utf8",
    );
  }

  it("starts a fresh episode when a different repository is materialized at the same path", async () => {
    const f = await makeOriginAndClone();
    await makeDivergedRefused(f);
    await seedAndAgeSidecar(f.work);

    // The seeded identity is the checkout's fetch-remote URL, not the path.
    const oldIdentity = (await readDivergenceRecord(f.work))?.repoIdentity;
    expect(oldIdentity).toBe(await git(["remote", "get-url", "origin"], f.work));

    // Replace the checkout's remote repository at the same path.
    const replacedUrl = `file://${f.root}/replaced-origin.git`;
    await gitVoid(["remote", "set-url", "origin", replacedUrl], f.work);

    const result = await prepareBaseRepoForWorkspace({ repoRoot: f.work, configuredBaseRef: "main" });
    const record = await readDivergenceRecord(f.work);

    // The episode is re-keyed to the new repository identity and starts now; it
    // did NOT inherit the 10-day-old age of the replaced repository.
    expect(record?.repoIdentity).toBe(replacedUrl);
    expect(record?.firstObservedAtMs).toBe(NOW);
    expect(record?.lastObservedAtMs).toBe(NOW);
    expect(NOW - (record?.firstObservedAtMs ?? NOW)).toBe(0); // ageMs === 0
    // The replaced repo's old age was past the 7-day threshold and would have
    // manufactured a spurious first-class signal; the fresh episode must not.
    expect(result.divergenceAlert).toBeNull();
    expect(record?.repoIdentity).not.toBe(oldIdentity);
  });

  it("carries the old episode start forward when the remote identity is unchanged", async () => {
    const f = await makeOriginAndClone();
    await makeDivergedRefused(f);
    await seedAndAgeSidecar(f.work);

    const result = await prepareBaseRepoForWorkspace({ repoRoot: f.work, configuredBaseRef: "main" });
    const record = await readDivergenceRecord(f.work);

    // Same repository (unchanged remote) at the same path: the episode start is
    // preserved, so the divergence age keeps accumulating and the over-threshold
    // episode escalates to a first-class signal.
    expect(record?.firstObservedAtMs).toBe(NOW - TEN_DAYS_MS);
    expect(result.divergenceAlert).not.toBeNull();
    expect(result.divergenceAlert?.firstObservedAtMs).toBe(NOW - TEN_DAYS_MS);
    expect(result.divergenceAlert?.divergenceAgeMs).toBe(TEN_DAYS_MS);
    expect(result.divergenceAlert?.repoIdentity).toBe(await git(["remote", "get-url", "origin"], f.work));
  });
});
