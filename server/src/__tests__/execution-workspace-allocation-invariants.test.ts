import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
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

  // The guard must not fire on the holder itself: fresh-worktree reuse and
  // branch reconciliation both re-allocate the same path for the same source
  // issue, and refusing that wedges the issue out of its own worktree.
  it("allows the holding issue to re-allocate its own held path", async () => {
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
      name: "self-reallocated-worktree",
      status: "active",
      cwd: HELD_WORKTREE_PATH,
      providerType: "git_worktree",
      providerRef: HELD_WORKTREE_PATH,
      branchName: "tsp/SUP-13445-root-cause",
    });
    expect(row?.id).toBeTruthy();
    expect(row?.cwd).toBe(HELD_WORKTREE_PATH);
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

  // SUP-15837: the ADR-083 isolated_workspace redo carrier. A parent-sourced
  // isolated_workspace row whose branch is anchored at the source's identifier
  // at depth <= 2 is inherited by a descendant child instead of declined, so
  // the child can deliver on the parent's branch. These tests exercise the real
  // issue-create inheritance gate (issues.ts), not just the provisioning
  // backstop.
  async function seedIsolatedCarrier(
    companyId: string,
    projectId: string,
    projectWorkspaceId: string,
    opts: {
      sourceIssueId: string;
      identifier: string;
      issueNumber: number;
      branchName: string;
      parentId?: string | null;
    },
  ) {
    const executionWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "carrier",
      status: "active",
      cwd: `/paperclip/worktrees/tsp/${opts.identifier}`,
      providerType: "git_worktree",
      providerRef: `/paperclip/worktrees/tsp/${opts.identifier}`,
      branchName: opts.branchName,
    });
    await db.insert(issues).values({
      id: opts.sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Carrier source",
      status: "in_progress",
      priority: "high",
      issueNumber: opts.issueNumber,
      identifier: opts.identifier,
      parentId: opts.parentId ?? null,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId: opts.sourceIssueId })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    return executionWorkspaceId;
  }

  it("inherits an isolated_workspace ADR-083 redo carrier sourced by its parent (SUP-15837)", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWorkspace(companyId);

    const sourceIssueId = randomUUID();
    const executionWorkspaceId = await seedIsolatedCarrier(companyId, projectId, projectWorkspaceId, {
      sourceIssueId,
      identifier: "SUP-15794",
      issueNumber: 15794,
      branchName: "SUP-15794-plan-deep-tools",
    });

    const child = await issuesSvc.create(companyId, {
      projectId,
      projectWorkspaceId,
      title: "Redo child on the carrier",
      status: "todo",
      priority: "high",
      parentId: sourceIssueId,
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
      executionWorkspacePreference: "reuse_existing",
    });

    expect(child.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");

    // No second execution-workspace row was created: the child sits on the
    // existing carrier row (acceptance 4).
    const rows = await db
      .select({ id: executionWorkspaces.id })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.companyId, companyId));
    expect(rows).toEqual([{ id: executionWorkspaceId }]);

    // No inheritance decline was recorded.
    const declines = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          inArray(activityLog.action, [
            "execution_workspace.inheritance_declined_branch_identity",
            "execution_workspace.inheritance_declined_cross_source",
          ]),
        ),
      );
    expect(declines).toHaveLength(0);
  });

  it("still declines an isolated_workspace row sourced by a sibling (SUP-15837)", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWorkspace(companyId);

    const grandparentId = randomUUID();
    await db.insert(issues).values({
      id: grandparentId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Plan root",
      status: "in_progress",
      priority: "high",
      issueNumber: 1,
      identifier: "SUP-1",
    });
    const siblingId = randomUUID();
    const executionWorkspaceId = await seedIsolatedCarrier(companyId, projectId, projectWorkspaceId, {
      sourceIssueId: siblingId,
      identifier: "SUP-2",
      issueNumber: 2,
      branchName: "SUP-2-plan",
      parentId: grandparentId,
    });

    const issue = await issuesSvc.create(companyId, {
      projectId,
      projectWorkspaceId,
      title: "New child (sibling of the carrier)",
      status: "todo",
      priority: "high",
      parentId: grandparentId,
      inheritExecutionWorkspaceFromIssueId: siblingId,
      executionWorkspacePreference: "reuse_existing",
    });

    expect(issue.executionWorkspaceId).toBeNull();
    expect(issue.executionWorkspacePreference).toBeNull();
    const declines = await db
      .select({ entityId: activityLog.entityId })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "execution_workspace.inheritance_declined_cross_source"),
        ),
      );
    expect(declines).toEqual([{ entityId: executionWorkspaceId }]);
  });

  it("still declines an isolated_workspace parent carrier whose branch is not anchored at the source (SUP-15837)", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWorkspace(companyId);

    const sourceIssueId = randomUUID();
    await seedIsolatedCarrier(companyId, projectId, projectWorkspaceId, {
      sourceIssueId,
      identifier: "SUP-7",
      issueNumber: 7,
      branchName: "feature/SUP-9-plan",
    });

    const child = await issuesSvc.create(companyId, {
      projectId,
      projectWorkspaceId,
      title: "Child",
      status: "todo",
      priority: "high",
      parentId: sourceIssueId,
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
      executionWorkspacePreference: "reuse_existing",
    });

    expect(child.executionWorkspaceId).toBeNull();
    expect(child.executionWorkspacePreference).toBeNull();
  });

  it("still declines an isolated_workspace parent carrier sourced deeper than depth 2 (SUP-15837)", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWorkspace(companyId);

    // Chain: SUP-1 (0) -> SUP-2 (1) -> SUP-3 (2) -> SUP-4 (3). The carrier is
    // sourced by SUP-4, the new child's parent, so SUP-4 sits at depth 3.
    const idR = randomUUID();
    const idA = randomUUID();
    const idB = randomUUID();
    const idS = randomUUID();
    await db.insert(issues).values({
      id: idR,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "R",
      status: "in_progress",
      priority: "high",
      issueNumber: 1,
      identifier: "SUP-1",
    });
    await db.insert(issues).values({
      id: idA,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "A",
      status: "in_progress",
      priority: "high",
      issueNumber: 2,
      identifier: "SUP-2",
      parentId: idR,
    });
    await db.insert(issues).values({
      id: idB,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "B",
      status: "in_progress",
      priority: "high",
      issueNumber: 3,
      identifier: "SUP-3",
      parentId: idA,
    });
    await seedIsolatedCarrier(companyId, projectId, projectWorkspaceId, {
      sourceIssueId: idS,
      identifier: "SUP-4",
      issueNumber: 4,
      branchName: "SUP-4-plan",
      parentId: idB,
    });

    const child = await issuesSvc.create(companyId, {
      projectId,
      projectWorkspaceId,
      title: "Child of SUP-4",
      status: "todo",
      priority: "high",
      parentId: idS,
      inheritExecutionWorkspaceFromIssueId: idS,
      executionWorkspacePreference: "reuse_existing",
    });

    expect(child.executionWorkspaceId).toBeNull();
    expect(child.executionWorkspacePreference).toBeNull();
  });
});
