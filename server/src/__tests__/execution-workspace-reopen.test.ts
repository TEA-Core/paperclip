import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY,
  EXECUTION_WORKSPACE_REOPEN_FAILED_REASON,
  EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY,
  EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY,
  executionWorkspaceService,
  metadataHasReopenPendingConsumption,
  readExecutionWorkspaceLifecycleGeneration,
  readMetadataReopenPendingConsumptionSince,
} from "../services/execution-workspaces.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres reopen tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("reopen archived isolated execution workspace", () => {
  let db!: ReturnType<typeof createDb>;
  let db2!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reopen-");
    db = createDb(tempDb.connectionString);
    // A second, independent pool. A rebind driven on db2 runs on a different
    // physical connection than the reopen (which runs on db), so the two contend
    // the way two server processes would.
    db2 = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await db2.$client.end();
    await tempDb?.cleanup();
  });

  async function makeExistingDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-reopen-cwd-"));
    tempDirs.push(dir);
    return dir;
  }

  async function seedCompanyProject() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `PAP-${companyId.slice(0, 8)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Reopen project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      cwd: "/tmp/paperclip-reopen-project",
      isPrimary: true,
    });
    return { companyId, projectId, projectWorkspaceId };
  }

  async function seedClosedWorkspace(input: {
    companyId: string;
    projectId: string;
    projectWorkspaceId: string;
    cwd: string;
    status?: "archived" | "cleanup_failed" | "active";
    generation?: number;
  }) {
    const workspaceId = randomUUID();
    const closed = (input.status ?? "archived") !== "active";
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId: input.companyId,
      projectId: input.projectId,
      projectWorkspaceId: input.projectWorkspaceId,
      mode: "isolated_workspace",
      // project_primary strategy so the rebuild only checks that the directory
      // exists, with no git operation.
      strategyType: "project_primary",
      name: "reopen-workspace",
      status: input.status ?? "archived",
      providerType: "local_fs",
      cwd: input.cwd,
      closedAt: closed ? new Date() : null,
      cleanupReason: closed ? "issue_terminal" : null,
      cleanupEligibleAt: closed ? new Date() : null,
      metadata: {
        [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: input.generation ?? 1,
      },
    });
    return workspaceId;
  }

  // Seed a company and project whose primary project workspace has a null cwd.
  // This models a managed_checkout project: the base is not a local folder, so
  // the live managed checkout supplies the base path at rebuild time.
  async function seedManagedCheckoutProject() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `PAP-${companyId.slice(0, 8)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Managed checkout project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "managed_checkout",
      cwd: null,
      isPrimary: true,
    });
    return { companyId, projectId, projectWorkspaceId };
  }

  // Seed one closed isolated git_worktree row. The reaper already removed the
  // worktree directory, so cwd points at a path that is not on disk.
  async function seedClosedGitWorktreeWorkspace(input: {
    companyId: string;
    projectId: string;
    projectWorkspaceId: string;
    cwd: string;
    repoUrl: string;
    branchName: string;
  }) {
    const workspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId: input.companyId,
      projectId: input.projectId,
      projectWorkspaceId: input.projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "reopen-git-worktree",
      status: "archived",
      providerType: "local_fs",
      cwd: input.cwd,
      repoUrl: input.repoUrl,
      baseRef: null,
      branchName: input.branchName,
      closedAt: new Date(),
      cleanupReason: "issue_terminal",
      cleanupEligibleAt: new Date(),
      metadata: {
        [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 1,
      },
    });
    return workspaceId;
  }

  // Build a real git repository at the managed checkout path so
  // ensureManagedProjectWorkspace adopts it without a network clone. The repo
  // holds the branch that the archived worktree row references.
  function initManagedGitRepo(dir: string, worktreeBranch: string) {
    mkdirSync(dir, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
        stdio: "ignore",
      });
    git("init");
    writeFileSync(join(dir, "README.md"), "seed\n");
    git("add", "README.md");
    git("commit", "-m", "seed");
    git("branch", worktreeBranch);
  }

  async function seedIssue(input: {
    companyId: string;
    projectId: string;
    workspaceId: string;
    issueNumber: number;
    executionWorkspacePreference?: string | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      projectId: input.projectId,
      identifier: `PAP-${input.issueNumber}`,
      issueNumber: input.issueNumber,
      title: "Resume me",
      status: "todo",
      priority: "medium",
      executionWorkspaceId: input.workspaceId,
      executionWorkspacePreference:
        input.executionWorkspacePreference === undefined
          ? null
          : input.executionWorkspacePreference,
    });
    return issueId;
  }

  async function readWorkspace(id: string) {
    return db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, id))
      .then((rows) => rows[0] ?? null);
  }

  it("reopens the archived row in place, keeps the issue link, and raises the generation", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd, generation: 3 });
    const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4100 });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reopened).toBe(true);

    const row = await readWorkspace(workspaceId);
    expect(row?.status).toBe("active");
    expect(row?.closedAt).toBeNull();
    expect(row?.cleanupReason).toBeNull();
    expect(row?.cleanupEligibleAt).toBeNull();
    expect(readExecutionWorkspaceLifecycleGeneration(row?.metadata as Record<string, unknown> | null)).toBe(4);
    // The reopen flags the row so the terminal reaper does not archive and
    // destroy the rebuilt worktree before the caller consumes it.
    expect(metadataHasReopenPendingConsumption(row?.metadata as Record<string, unknown> | null)).toBe(true);

    // The reopen never changes the issue-to-workspace link.
    const issueRow = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issueRow?.executionWorkspaceId).toBe(workspaceId);
  });

  it("keeps access for every issue that shares the reopened row", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd });
    const firstIssueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4101 });
    const secondIssueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4102 });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: firstIssueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
    });
    expect(result.ok).toBe(true);

    const rows = await db.select().from(issues);
    for (const row of rows) {
      expect(row.executionWorkspaceId).toBe(workspaceId);
    }
    const workspace = await readWorkspace(workspaceId);
    expect(workspace?.status).toBe("active");
    expect(firstIssueId).not.toBe(secondIssueId);
  });

  it("fails closed and keeps the row closed when the rebuild fails", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    // A directory that does not exist. The project_primary rebuild returns null.
    const missingDir = join(tmpdir(), `paperclip-reopen-missing-${randomUUID()}`);
    const workspaceId = await seedClosedWorkspace({
      companyId,
      projectId,
      projectWorkspaceId,
      cwd: missingDir,
      generation: 2,
    });
    const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4103 });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("rebuild_failed");

    const row = await readWorkspace(workspaceId);
    // The row stays closed and retryable. The generation still rises so a queued
    // cleanup with the old generation does nothing.
    expect(row?.status).toBe("archived");
    expect(row?.cleanupReason).toBe(EXECUTION_WORKSPACE_REOPEN_FAILED_REASON);
    expect(row?.cleanupEligibleAt).toBeNull();
    expect(readExecutionWorkspaceLifecycleGeneration(row?.metadata as Record<string, unknown> | null)).toBe(3);

    // SUP-17623: the failed rebuild must not leave the non-terminal card pinned to
    // the closed workspace. The pointer is cleared in the same transaction as the
    // reopen-failure marker.
    const issueRow = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issueRow?.executionWorkspaceId).toBeNull();
  });

  it("clears the reuse_existing preference together with the pointer when the rebuild fails (no 422 half-state)", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    // A directory that does not exist. The project_primary rebuild returns null.
    const missingDir = join(tmpdir(), `paperclip-reopen-missing-${randomUUID()}`);
    const workspaceId = await seedClosedWorkspace({
      companyId,
      projectId,
      projectWorkspaceId,
      cwd: missingDir,
    });
    // The stranded half-state SUP-17618 describes: a non-terminal card bound to a
    // closed workspace while still carrying reuse_existing.
    const issueId = await seedIssue({
      companyId,
      projectId,
      workspaceId,
      issueNumber: 4105,
      executionWorkspacePreference: "reuse_existing",
    });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("rebuild_failed");

    // The id and the unrealizable preference are cleared together, in one write:
    // reuse_existing with a null id is the pair that would 422 the next PATCH.
    const issueRow = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issueRow?.executionWorkspaceId).toBeNull();
    expect(issueRow?.executionWorkspacePreference).toBeNull();
    // The card itself is untouched: still non-terminal, still the same row.
    expect(issueRow?.status).toBe("todo");
  });

  it("keeps a non-reuse preference when the rebuild clears the pointer", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const missingDir = join(tmpdir(), `paperclip-reopen-missing-${randomUUID()}`);
    const workspaceId = await seedClosedWorkspace({
      companyId,
      projectId,
      projectWorkspaceId,
      cwd: missingDir,
    });
    const issueId = await seedIssue({
      companyId,
      projectId,
      workspaceId,
      issueNumber: 4106,
      executionWorkspacePreference: "isolated_workspace",
    });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("rebuild_failed");

    // The dangling id is released, but the mode intent survives: isolated_workspace
    // stays meaningful without an id, and nulling it would move where the next run
    // lands.
    const issueRow = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issueRow?.executionWorkspaceId).toBeNull();
    expect(issueRow?.executionWorkspacePreference).toBe("isolated_workspace");
  });

  it("does not clear a pointer that was re-bound to another workspace while the rebuild ran", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    // A directory that does not exist. The project_primary rebuild returns null.
    const missingDir = join(tmpdir(), `paperclip-reopen-missing-${randomUUID()}`);
    const workspaceId = await seedClosedWorkspace({
      companyId,
      projectId,
      projectWorkspaceId,
      cwd: missingDir,
    });
    const issueId = await seedIssue({
      companyId,
      projectId,
      workspaceId,
      issueNumber: 4110,
      executionWorkspacePreference: "reuse_existing",
    });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
      // While the failed reopen is open at the rebuild boundary, the card is
      // re-bound to a different live workspace. Driven on the independent pool,
      // the way a different server process would rebind the card mid-rebuild.
      rebuildBarrier: async () => {
        const reboundWorkspaceId = await seedClosedWorkspace({
          companyId,
          projectId,
          projectWorkspaceId,
          cwd: await makeExistingDir(),
          status: "active",
        });
        await db2
          .update(issues)
          .set({
            executionWorkspaceId: reboundWorkspaceId,
            executionWorkspacePreference: "reuse_existing",
            updatedAt: new Date(),
          })
          .where(eq(issues.id, issueId));
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("rebuild_failed");

    // The rebind survives the failed reopen: the detach must not clobber a pointer
    // that no longer points at the failed vehicle.
    const issueRow = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issueRow?.executionWorkspaceId).not.toBeNull();
    expect(issueRow?.executionWorkspaceId).not.toBe(workspaceId);
    expect(issueRow?.executionWorkspacePreference).toBe("reuse_existing");

    // The failed vehicle stays closed and retryable.
    const row = await readWorkspace(workspaceId);
    expect(row?.status).toBe("archived");
    expect(row?.cleanupReason).toBe(EXECUTION_WORKSPACE_REOPEN_FAILED_REASON);
  });

  it("detaches every non-terminal binding on the vehicle when the rebuild fails", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    // A directory that does not exist. The project_primary rebuild returns null.
    const missingDir = join(tmpdir(), `paperclip-reopen-missing-${randomUUID()}`);
    const workspaceId = await seedClosedWorkspace({
      companyId,
      projectId,
      projectWorkspaceId,
      cwd: missingDir,
      generation: 2,
    });
    // Two non-terminal cards share the isolated vehicle with the stranded
    // half-state SUP-17618 describes, plus one terminal card on the same vehicle.
    const firstIssueId = await seedIssue({
      companyId,
      projectId,
      workspaceId,
      issueNumber: 4111,
      executionWorkspacePreference: "reuse_existing",
    });
    const secondIssueId = await seedIssue({
      companyId,
      projectId,
      workspaceId,
      issueNumber: 4112,
      executionWorkspacePreference: "reuse_existing",
    });
    const terminalIssueId = await seedIssue({
      companyId,
      projectId,
      workspaceId,
      issueNumber: 4113,
      executionWorkspacePreference: "reuse_existing",
    });
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(issues.id, terminalIssueId));

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: firstIssueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("rebuild_failed");

    // Every non-terminal binding is released in the same transaction: no dangling
    // pointer and no unrealizable reuse_existing on any of the live cards.
    const rows = await db.select().from(issues);
    const byId = new Map(rows.map((entry) => [entry.id, entry]));
    for (const id of [firstIssueId, secondIssueId]) {
      expect(byId.get(id)?.executionWorkspaceId, id).toBeNull();
      expect(byId.get(id)?.executionWorkspacePreference, id).toBeNull();
    }
    // The terminal card keeps its claim on the retryable vehicle, so the next
    // resume can reopen the same workspace.
    expect(byId.get(terminalIssueId)?.executionWorkspaceId).toBe(workspaceId);
    expect(byId.get(terminalIssueId)?.executionWorkspacePreference).toBe("reuse_existing");

    const row = await readWorkspace(workspaceId);
    expect(row?.status).toBe("archived");
    expect(row?.cleanupReason).toBe(EXECUTION_WORKSPACE_REOPEN_FAILED_REASON);
  });

  it("resolves the managed base checkout for a git_worktree row when the project workspace cwd is null", async () => {
    const previousHome = process.env.PAPERCLIP_HOME;
    const tempHome = await mkdtemp(join(tmpdir(), "paperclip-reopen-home-"));
    tempDirs.push(tempHome);
    process.env.PAPERCLIP_HOME = tempHome;
    try {
      const { companyId, projectId, projectWorkspaceId } = await seedManagedCheckoutProject();
      const repoUrl = "https://example.test/acme/widget.git";
      const branchName = "reopen-feature";
      // Build the live managed checkout that the rebuild must spawn git in.
      const managedDir = resolveManagedProjectWorkspaceDir({ companyId, projectId, repoName: "widget" });
      initManagedGitRepo(managedDir, branchName);

      // The archived worktree path. The reaper already removed it from disk.
      const deletedWorktree = join(tempHome, "worktrees", "reopen-worktree");
      const workspaceId = await seedClosedGitWorktreeWorkspace({
        companyId,
        projectId,
        projectWorkspaceId,
        cwd: deletedWorktree,
        repoUrl,
        branchName,
      });
      const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4305 });

      const svc = executionWorkspaceService(db);
      const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
        workspaceId,
        issue: { id: issueId, companyId, projectId },
        actor: { agentId: null, actorType: "user" },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reopened).toBe(true);

      const row = await readWorkspace(workspaceId);
      expect(row?.status).toBe("active");
      expect(row?.closedAt).toBeNull();
      expect(row?.cleanupReason).toBeNull();
      // The rebuild recreated the worktree at the archived path from the managed
      // base checkout.
      const worktreeStat = await stat(deletedWorktree).catch(() => null);
      expect(worktreeStat?.isDirectory()).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
    }
  });

  it("refuses to reopen a workspace in another company", async () => {
    const first = await seedCompanyProject();
    const second = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({
      companyId: first.companyId,
      projectId: first.projectId,
      projectWorkspaceId: first.projectWorkspaceId,
      cwd,
    });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      // The issue belongs to a different company than the workspace.
      issue: { id: randomUUID(), companyId: second.companyId, projectId: second.projectId },
      actor: { agentId: null, actorType: "user" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_reopenable");

    const row = await readWorkspace(workspaceId);
    expect(row?.status).toBe("archived");
  });

  it("reports success without a rebuild when the workspace is already active", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({
      companyId,
      projectId,
      projectWorkspaceId,
      cwd,
      status: "active",
      generation: 5,
    });
    const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4104 });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reopened).toBe(false);

    const row = await readWorkspace(workspaceId);
    // No reopen ran, so the generation is unchanged.
    expect(readExecutionWorkspaceLifecycleGeneration(row?.metadata as Record<string, unknown> | null)).toBe(5);
  });

  it("runs the destroy under the fence when the generation matches, and skips it after a reopen", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd, generation: 7 });

    const svc = executionWorkspaceService(db);

    // The captured generation matches, so the destroy callback runs.
    const destroyMatches = vi.fn(async () => "destroyed");
    const matched = await svc.fenceClosedWorkspaceDestruction({
      workspaceId,
      capturedGeneration: 7,
      destroy: destroyMatches,
    });
    expect(matched.skippedReopened).toBe(false);
    expect(destroyMatches).toHaveBeenCalledTimes(1);

    // Simulate a reopen: raise the generation and mark the row active.
    await db
      .update(executionWorkspaces)
      .set({
        status: "active",
        closedAt: null,
        cleanupReason: null,
        cleanupEligibleAt: null,
        metadata: { [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 8 },
      })
      .where(eq(executionWorkspaces.id, workspaceId));

    // A stale cleanup captured generation 7. The fence must skip the destroy.
    const destroyStale = vi.fn(async () => "destroyed");
    const skipped = await svc.fenceClosedWorkspaceDestruction({
      workspaceId,
      capturedGeneration: 7,
      destroy: destroyStale,
    });
    expect(skipped.skippedReopened).toBe(true);
    expect(destroyStale).not.toHaveBeenCalled();
  });

  it("clears the reopen-pending flag after an unconsumed reopen and stays idempotent", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd });
    const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4109 });

    const svc = executionWorkspaceService(db);
    // The reopen publishes the row as active and sets the reopen-pending flag.
    const reopenResult = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
    });
    expect(reopenResult.ok).toBe(true);
    if (!reopenResult.ok) throw new Error("reopen failed");
    const reopenGeneration = reopenResult.generation;
    const reopenedRow = await readWorkspace(workspaceId);
    expect(metadataHasReopenPendingConsumption(reopenedRow?.metadata as Record<string, unknown> | null)).toBe(true);
    // The reopen stamps the time it set the flag, so the reaper can age a
    // stranded flag out of the way after the grace period.
    expect(readMetadataReopenPendingConsumptionSince(reopenedRow?.metadata as Record<string, unknown> | null))
      .toBeInstanceOf(Date);

    // The caller never consumed the reopen, so clear the flag at its generation.
    const cleared = await svc.clearReopenPendingConsumptionForUnconsumedReopen({
      workspaceId,
      issue: { id: issueId, companyId },
      actor: { agentId: null, actorType: "user" },
      expectedGeneration: reopenGeneration,
    });
    expect(cleared.cleared).toBe(true);

    const clearedRow = await readWorkspace(workspaceId);
    // The flag is gone, so the terminal reaper can archive and reclaim the row.
    expect(metadataHasReopenPendingConsumption(clearedRow?.metadata as Record<string, unknown> | null)).toBe(false);
    // The clear removes the timestamp too, so no orphan key survives.
    expect((clearedRow?.metadata as Record<string, unknown> | null)?.[EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY])
      .toBeUndefined();
    // The row stays active, so a retried resume can still reuse the rebuilt worktree.
    expect(clearedRow?.status).toBe("active");

    const events = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, workspaceId));
    expect(events.some((event) => event.action === "execution_workspace.reopen_unconsumed")).toBe(true);

    // A second call finds no flag and does nothing.
    const second = await svc.clearReopenPendingConsumptionForUnconsumedReopen({
      workspaceId,
      issue: { id: issueId, companyId },
      actor: { agentId: null, actorType: "user" },
      expectedGeneration: reopenGeneration,
    });
    expect(second.cleared).toBe(false);
    const eventsAfter = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, workspaceId));
    expect(eventsAfter.filter((event) => event.action === "execution_workspace.reopen_unconsumed").length).toBe(1);
  });

  it("does not clear a newer reopen's fence when a stale request presents an old generation", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd });
    const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4115 });

    const svc = executionWorkspaceService(db);
    const reopenResult = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
    });
    expect(reopenResult.ok).toBe(true);
    if (!reopenResult.ok) throw new Error("reopen failed");
    const staleGeneration = reopenResult.generation;

    // Simulate a newer reopen that raised the generation and installed its own
    // fence with a fresh timestamp. This models two overlapping reopen requests.
    const newerGeneration = staleGeneration + 1;
    await db
      .update(executionWorkspaces)
      .set({
        metadata: {
          [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: newerGeneration,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY]: true,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY]: new Date().toISOString(),
        },
      })
      .where(eq(executionWorkspaces.id, workspaceId));

    // The stale request's response-end clear presents the old generation. It must
    // not clear the newer reopen's live fence.
    const staleClear = await svc.clearReopenPendingConsumptionForUnconsumedReopen({
      workspaceId,
      issue: { id: issueId, companyId },
      actor: { agentId: null, actorType: "user" },
      expectedGeneration: staleGeneration,
    });
    expect(staleClear.cleared).toBe(false);
    const afterStale = await readWorkspace(workspaceId);
    expect(metadataHasReopenPendingConsumption(afterStale?.metadata as Record<string, unknown> | null)).toBe(true);
    expect(readExecutionWorkspaceLifecycleGeneration(afterStale?.metadata as Record<string, unknown> | null))
      .toBe(newerGeneration);

    // The newer owner clears its own fence at the matching generation.
    const ownerClear = await svc.clearReopenPendingConsumptionForUnconsumedReopen({
      workspaceId,
      issue: { id: issueId, companyId },
      actor: { agentId: null, actorType: "user" },
      expectedGeneration: newerGeneration,
    });
    expect(ownerClear.cleared).toBe(true);
    const afterOwner = await readWorkspace(workspaceId);
    expect(metadataHasReopenPendingConsumption(afterOwner?.metadata as Record<string, unknown> | null)).toBe(false);
  });
});
