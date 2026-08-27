import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  instanceSettings,
  issueComments,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { issueService } from "../services/issues.ts";
import { executionWorkspaceService } from "../services/execution-workspaces.ts";
import {
  WORKSPACE_CROSS_SOURCE_BINDING_CODE,
  WORKSPACE_PATH_HELD_CODE,
} from "../services/execution-workspace-policy.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres allocation-invariant tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const HELD_WORKTREE_PATH = "/paperclip/worktrees/tsp/SUP-13445-root-cause";

describeEmbeddedPostgres("execution workspace allocation invariants (SUP-14139)", () => {
  let db!: ReturnType<typeof createDb>;
  let issuesSvc!: ReturnType<typeof issueService>;
  let workspacesSvc!: ReturnType<typeof executionWorkspaceService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-allocation-invariants-");
    db = createDb(tempDb.connectionString);
    issuesSvc = issueService(db);
    workspacesSvc = executionWorkspaceService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    return companyId;
  }

  async function seedProjectWorkspace(companyId: string) {
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });
    return { projectId, projectWorkspaceId };
  }

  // The exact incident shape: issue A holds live worktree row W.
  async function seedHeldWorktree(companyId: string, projectId: string, projectWorkspaceId: string) {
    const sourceIssueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "holding-worktree",
      status: "active",
      cwd: HELD_WORKTREE_PATH,
      providerType: "git_worktree",
      providerRef: HELD_WORKTREE_PATH,
      branchName: "tsp/SUP-13445-root-cause",
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Holding issue",
      status: "in_progress",
      priority: "high",
      issueNumber: 1,
      identifier: "T-1",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    return { sourceIssueId, executionWorkspaceId };
  }

  it("refuses to allocate a second live row over a held worktree path", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWorkspace(companyId);
    const { sourceIssueId, executionWorkspaceId } = await seedHeldWorktree(companyId, projectId, projectWorkspaceId);

    const secondSourceIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondSourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Second issue",
      status: "todo",
      priority: "high",
      issueNumber: 2,
      identifier: "T-2",
    });

    const error = await workspacesSvc.create({
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: secondSourceIssueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "second-worktree",
      status: "active",
      cwd: HELD_WORKTREE_PATH,
      providerType: "git_worktree",
      providerRef: HELD_WORKTREE_PATH,
      branchName: "tsp/sup-14124-followup",
    }).then(
      () => null,
      (thrown: Error) => thrown,
    );
    expect(error).toMatchObject({
      status: 409,
      details: {
        code: WORKSPACE_PATH_HELD_CODE,
        holdingWorkspaceId: executionWorkspaceId,
        holdingIssueId: sourceIssueId,
        holdingIssueIdentifier: "T-1",
        cwd: HELD_WORKTREE_PATH,
      },
    });
    expect(error?.message).toContain(HELD_WORKTREE_PATH);
    expect(error?.message).toContain("T-1");

    const rowsOverHeldPath = await db
      .select({ id: executionWorkspaces.id })
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.companyId, companyId),
          eq(executionWorkspaces.projectWorkspaceId, projectWorkspaceId),
          eq(executionWorkspaces.cwd, HELD_WORKTREE_PATH),
        ),
      );
    expect(rowsOverHeldPath).toHaveLength(1);
  });

  it("allows a second row over a different worktree path", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWorkspace(companyId);
    const { sourceIssueId } = await seedHeldWorktree(companyId, projectId, projectWorkspaceId);

    const row = await workspacesSvc.create({
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "different-path",
      status: "active",
      cwd: `${HELD_WORKTREE_PATH}-other`,
      providerType: "git_worktree",
      providerRef: `${HELD_WORKTREE_PATH}-other`,
    });
    expect(row?.id).toBeTruthy();
  });

  it("allows allocation once the holding row is no longer live", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWorkspace(companyId);
    const { executionWorkspaceId } = await seedHeldWorktree(companyId, projectId, projectWorkspaceId);

    await db
      .update(executionWorkspaces)
      .set({ status: "archived", closedAt: new Date() })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));

    const row = await workspacesSvc.create({
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: null,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "reallocated",
      status: "active",
      cwd: HELD_WORKTREE_PATH,
      providerType: "git_worktree",
      providerRef: HELD_WORKTREE_PATH,
    });
    expect(row?.id).toBeTruthy();
  });

  it("allows a non-worktree strategy over a held path", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWorkspace(companyId);

    await seedHeldWorktree(companyId, projectId, projectWorkspaceId);

    const row = await workspacesSvc.create({
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: null,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "shared-primary",
      status: "active",
      cwd: HELD_WORKTREE_PATH,
      providerType: "local_fs",
    });
    expect(row?.id).toBeTruthy();
  });

  it("refuses an explicit cross-source executionWorkspaceId at create", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWorkspace(companyId);
    const { sourceIssueId, executionWorkspaceId } = await seedHeldWorktree(companyId, projectId, projectWorkspaceId);

    await expect(
      issuesSvc.create(companyId, {
        projectId,
        projectWorkspaceId,
        title: "Explicit cross-source bind",
        status: "todo",
        priority: "high",
        executionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: WORKSPACE_CROSS_SOURCE_BINDING_CODE,
        sourceIssueId,
        sourceIssueIdentifier: "T-1",
        executionWorkspaceId,
        field: "executionWorkspaceId",
      },
    });

    const persisted = await db.select({ id: issues.id }).from(issues).where(eq(issues.identifier, "T-2"));
    expect(persisted).toHaveLength(0);
  });

  it("refuses an update that binds an issue to another issue's sourced workspace", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWorkspace(companyId);
    const { sourceIssueId, executionWorkspaceId } = await seedHeldWorktree(companyId, projectId, projectWorkspaceId);

    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Unbound issue",
      status: "todo",
      priority: "high",
      issueNumber: 2,
      identifier: "T-2",
    });

    await expect(
      issuesSvc.update(otherIssueId, {
        executionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: WORKSPACE_CROSS_SOURCE_BINDING_CODE, sourceIssueId },
    });

    const [after] = await db
      .select({ executionWorkspaceId: issues.executionWorkspaceId })
      .from(issues)
      .where(eq(issues.id, otherIssueId));
    expect(after.executionWorkspaceId).toBeNull();
  });

  it("lets an issue rebind the workspace it sources", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWorkspace(companyId);
    const { sourceIssueId, executionWorkspaceId } = await seedHeldWorktree(companyId, projectId, projectWorkspaceId);

    await issuesSvc.update(sourceIssueId, { executionWorkspaceId: null, executionWorkspacePreference: null });
    const rebound = await issuesSvc.update(sourceIssueId, {
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });
    expect(rebound?.executionWorkspaceId).toBe(executionWorkspaceId);
  });

  it("declines cross-source inheritance and records the decline", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWorkspace(companyId);
    const { sourceIssueId, executionWorkspaceId } = await seedHeldWorktree(companyId, projectId, projectWorkspaceId);

    const issue = await issuesSvc.create(companyId, {
      projectId,
      projectWorkspaceId,
      title: "Child of a live carrier",
      status: "todo",
      priority: "high",
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
      executionWorkspacePreference: "reuse_existing",
    });

    expect(issue.executionWorkspaceId).toBeNull();
    expect(issue.executionWorkspacePreference).toBeNull();

    const declineLog = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "execution_workspace.inheritance_declined_cross_source"),
        ),
      );
    expect(declineLog).toEqual([{ action: "execution_workspace.inheritance_declined_cross_source", entityId: executionWorkspaceId }]);
  });
});
