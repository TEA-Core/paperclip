import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
  type Db,
} from "@paperclipai/db";
import {
  ensurePersistedExecutionWorkspaceAvailable,
  realizeExecutionWorkspace,
} from "../services/workspace-runtime.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

type CompanyScope = { companyId: string; agentId: string; projectId: string; projectWorkspaceId: string };

// SUP-24442 — base-repo hygiene must not restore (detach, or force-checkout
// main over) a primary checkout that is the live working directory of a
// project_primary execution workspace. A sibling git_worktree card's dispatch
// used to detach such a checkout at origin/main and sweep the card's edits
// into a rescue ref. With no live project_primary workspace at the checkout,
// hygiene behaves exactly as before.

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

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

async function commit(repo: string, name: string): Promise<void> {
  await fs.writeFile(path.join(repo, name), `${name}\n`);
  await git(["add", "-A"], repo);
  await git(["commit", "-qm", name], repo);
}

type Fixture = { primary: string; staleSha: string; originTip: string };

/**
 * Primary clone whose local main is stale at A while origin/main is at B: the
 * shape where a hygiene restore takes the detach arm.
 */
async function makePrimary(state: "card-branch-dirty" | "dirty-main" | "clean-main"): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sup24442-"));
  tempRoots.push(root);
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const primary = path.join(root, "primary");
  await git(["init", "-q", "--bare", "-b", "main", origin], root);
  await git(["init", "-q", "-b", "main", seed], root);
  await commit(seed, "a.txt");
  await git(["remote", "add", "origin", origin], seed);
  await git(["push", "-q", "origin", "main"], seed);
  await git(["clone", "-q", `file://${origin}`, primary], root);
  const staleSha = await git(["rev-parse", "HEAD"], primary);
  await commit(seed, "b.txt");
  await git(["push", "-q", "origin", "main"], seed);
  await git(["fetch", "-q", "origin"], primary);
  const originTip = await git(["rev-parse", "origin/main"], primary);

  if (state === "card-branch-dirty") {
    await git(["checkout", "-q", "-b", "SUP-24441-repair"], primary);
    await fs.writeFile(path.join(primary, "a.txt"), "card edit\n");
  } else if (state === "dirty-main") {
    await fs.writeFile(path.join(primary, "a.txt"), "card edit\n");
  }
  return { primary, staleSha, originTip };
}

async function headState(repo: string) {
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], repo).catch(() => null);
  return {
    branch,
    sha: await git(["rev-parse", "HEAD"], repo),
    fileA: await fs.readFile(path.join(repo, "a.txt"), "utf8"),
    rescueRefs: await git(["for-each-ref", "--format=%(refname)", "refs/paperclip/rescue/base-repo"], repo),
  };
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("base-repo hygiene: live project_primary checkout guard (SUP-24442)", () => {
  let db!: Db;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sup24442-live-primary-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function seedCompany(primary: string): Promise<CompanyScope> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Agent Tools", status: "in_progress" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: primary,
      isPrimary: true,
    });
    return { companyId, agentId, projectId, projectWorkspaceId };
  }

  async function seedPrimaryWorkspace(input: {
    scope: CompanyScope;
    cwd: string;
    issueStatus: "in_progress" | "done" | "cancelled";
    runStatus?: "queued" | "running" | "succeeded" | null;
    closed?: boolean;
    /** How the issue reaches the workspace: as its source, bound to it, or both (default). */
    link?: "both" | "source" | "bound";
  }) {
    const { companyId, agentId, projectId, projectWorkspaceId } = input.scope;
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const now = new Date();
    let runId: string | null = null;
    if (input.runStatus) {
      runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "manual",
        status: input.runStatus,
        startedAt: now,
        updatedAt: now,
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Repair on the shared checkout",
      status: input.issueStatus,
      priority: "medium",
      assigneeAgentId: agentId,
      identifier: "SUP-24441",
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: input.link === "bound" ? null : issueId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Primary",
      status: input.closed ? "archived" : "active",
      closedAt: input.closed ? now : null,
      cwd: input.cwd,
      providerType: "local_fs",
      lastUsedAt: now,
      updatedAt: now,
    });
    await db
      .update(issues)
      .set({ executionWorkspaceId: input.link === "source" ? null : workspaceId, executionRunId: runId, updatedAt: now })
      .where(eq(issues.id, issueId));
  }

  function realizeSibling(primary: string, scope: CompanyScope | null, dbOverride?: Db) {
    return realizeExecutionWorkspace({
      db: dbOverride ?? db,
      base: {
        baseCwd: primary,
        source: "project_primary",
        projectId: scope?.projectId ?? randomUUID(),
        workspaceId: null,
        repoUrl: null,
        repoRef: "main",
      },
      config: { workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}-{{slug}}" } },
      issue: { id: randomUUID(), identifier: "SUP-30001", title: "Sibling card" },
      agent: { id: scope?.agentId ?? randomUUID(), name: "Coder", companyId: scope?.companyId ?? randomUUID() },
    });
  }

  it("leaves a live card branch attached with its tracked edits when a sibling git_worktree card dispatches", async () => {
    const f = await makePrimary("card-branch-dirty");
    const scope = await seedCompany(f.primary);
    await seedPrimaryWorkspace({ scope, cwd: f.primary, issueStatus: "in_progress" });
    const before = await headState(f.primary);

    const realized = await realizeSibling(f.primary, scope);

    expect(await headState(f.primary)).toEqual(before);
    expect(before.branch).toBe("SUP-24441-repair");
    expect(before.fileA).toBe("card edit\n");
    const warning = realized.warnings.find((w) => w.includes("was not restored to origin/main"));
    expect(warning, `warnings were: ${JSON.stringify(realized.warnings)}`).toBeDefined();
    expect(warning).toContain('base repo is on "SUP-24441-repair" instead of "main"');
    expect(warning).toContain("1 live project_primary execution workspace");
    // The sibling worktree is still cut from the remote-tracking base tip.
    expect(await git(["rev-parse", "HEAD"], realized.cwd)).toBe(f.originTip);
  }, 30_000);

  it("leaves dirty main attached and its edits in place for a live primary", async () => {
    const f = await makePrimary("dirty-main");
    const scope = await seedCompany(f.primary);
    await seedPrimaryWorkspace({ scope, cwd: f.primary, issueStatus: "in_progress" });

    await realizeSibling(f.primary, scope);

    const after = await headState(f.primary);
    expect(after).toEqual({ branch: "main", sha: f.staleSha, fileA: "card edit\n", rescueRefs: "" });
  }, 30_000);

  it("treats a terminal source issue with a queued run as live", async () => {
    const f = await makePrimary("card-branch-dirty");
    const scope = await seedCompany(f.primary);
    await seedPrimaryWorkspace({ scope, cwd: f.primary, issueStatus: "done", runStatus: "queued" });

    await realizeSibling(f.primary, scope);

    expect((await headState(f.primary)).branch).toBe("SUP-24441-repair");
  }, 30_000);

  it("treats a live issue bound to a sourceless primary workspace as live", async () => {
    const f = await makePrimary("card-branch-dirty");
    const scope = await seedCompany(f.primary);
    await seedPrimaryWorkspace({ scope, cwd: f.primary, issueStatus: "in_progress", link: "bound" });

    await realizeSibling(f.primary, scope);

    expect((await headState(f.primary)).branch).toBe("SUP-24441-repair");
  }, 30_000);

  it("treats a live source issue as live even when it is no longer bound to the workspace", async () => {
    const f = await makePrimary("card-branch-dirty");
    const scope = await seedCompany(f.primary);
    await seedPrimaryWorkspace({ scope, cwd: f.primary, issueStatus: "in_progress", link: "source" });

    await realizeSibling(f.primary, scope);

    expect((await headState(f.primary)).branch).toBe("SUP-24441-repair");
  }, 30_000);

  it("guards a project_primary workspace whose cwd is a directory inside the checkout", async () => {
    const f = await makePrimary("card-branch-dirty");
    const scope = await seedCompany(f.primary);
    await seedPrimaryWorkspace({ scope, cwd: path.join(f.primary, "packages", "tools"), issueStatus: "in_progress" });

    await realizeSibling(f.primary, scope);

    expect((await headState(f.primary)).branch).toBe("SUP-24441-repair");
  }, 30_000);

  it("keeps the checkout untouched when the liveness lookup fails", async () => {
    const f = await makePrimary("card-branch-dirty");
    const before = await headState(f.primary);
    const failingDb = {
      select: () => {
        throw new Error("database unavailable");
      },
    } as unknown as Db;

    const realized = await realizeSibling(f.primary, null, failingDb);

    expect(await headState(f.primary)).toEqual(before);
    const warning = realized.warnings.find((w) => w.includes("was not restored to origin/main"));
    expect(warning, `warnings were: ${JSON.stringify(realized.warnings)}`).toContain("database unavailable");
  }, 30_000);

  it.each([
    { name: "no project_primary workspace", seed: null },
    { name: "a terminal, idle source issue", seed: { issueStatus: "done" as const, runStatus: "succeeded" as const } },
    { name: "a cancelled, idle source issue", seed: { issueStatus: "cancelled" as const, runStatus: null } },
    { name: "a closed workspace", seed: { issueStatus: "in_progress" as const, closed: true } },
  ])("still restores (detaches at origin/main) with $name", async ({ seed }) => {
    const f = await makePrimary("card-branch-dirty");
    const scope = await seedCompany(f.primary);
    if (seed) await seedPrimaryWorkspace({ scope, cwd: f.primary, ...seed });

    const realized = await realizeSibling(f.primary, scope);

    const after = await headState(f.primary);
    expect(after.branch).toBeNull();
    expect(after.sha).toBe(f.originTip);
    expect(after.fileA).toBe("a.txt\n");
    expect(after.rescueRefs).toMatch(/\/head$/m);
    expect(after.rescueRefs).toMatch(/\/worktree$/m);
    expect(realized.warnings.some((w) => w.includes("was restored to origin/main"))).toBe(true);
    expect(realized.warnings.some((w) => w.includes("was not restored"))).toBe(false);
  }, 30_000);

  it("still fast-forwards a clean main behind origin for a live primary", async () => {
    const f = await makePrimary("clean-main");
    const scope = await seedCompany(f.primary);
    await seedPrimaryWorkspace({ scope, cwd: f.primary, issueStatus: "in_progress" });

    const realized = await realizeSibling(f.primary, scope);

    const after = await headState(f.primary);
    expect(after.branch).toBe("main");
    expect(after.sha).toBe(f.originTip);
    expect(realized.warnings.some((w) => w.includes("was fast-forwarded to origin/main"))).toBe(true);
  }, 30_000);

  it.each([
    { path: "restore (worktree missing)", worktreeExists: false },
    { path: "reuse (worktree present)", worktreeExists: true },
  ])("guards the persisted git_worktree $path path too", async ({ worktreeExists }) => {
    const f = await makePrimary("card-branch-dirty");
    const scope = await seedCompany(f.primary);
    await seedPrimaryWorkspace({ scope, cwd: f.primary, issueStatus: "in_progress" });
    await git(["branch", "SUP-30002-sibling", "origin/main"], f.primary);
    const siblingWorktree = path.join(f.primary, ".paperclip", "worktrees", "SUP-30002-sibling");
    if (worktreeExists) await git(["worktree", "add", "-q", siblingWorktree, "SUP-30002-sibling"], f.primary);
    const before = await headState(f.primary);

    const realized = await ensurePersistedExecutionWorkspaceAvailable({
      db,
      base: {
        baseCwd: f.primary,
        source: "task_session",
        projectId: scope.projectId,
        workspaceId: scope.projectWorkspaceId,
        repoUrl: null,
        repoRef: "main",
      },
      workspace: {
        id: randomUUID(),
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: siblingWorktree,
        providerRef: siblingWorktree,
        projectId: scope.projectId,
        projectWorkspaceId: scope.projectWorkspaceId,
        repoUrl: null,
        baseRef: "main",
        branchName: "SUP-30002-sibling",
      },
      issue: { id: randomUUID(), identifier: "SUP-30002", title: "Sibling card" },
      agent: { id: scope.agentId, name: "Coder", companyId: scope.companyId },
    });

    expect(realized?.cwd).toBe(siblingWorktree);
    expect(await headState(f.primary)).toEqual(before);
    expect(realized?.warnings.some((w) => w.includes("was not restored to origin/main"))).toBe(true);
  }, 30_000);
});
