import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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
import {
  WORKSPACE_REUSE_REQUIRES_EXECUTION_WORKSPACE_CODE,
  WORKSPACE_REUSE_REQUIRES_EXECUTION_WORKSPACE_MESSAGE,
  WORKSPACE_REUSE_REQUIRES_EXECUTION_WORKSPACE_REMEDIATION,
} from "../services/execution-workspace-policy.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres reuse-binding tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

describeEmbeddedPostgres("reuse_existing execution workspace binding", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reuse-binding-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
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
    const executionWorkspaceId = randomUUID();
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
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Carrier worktree",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });
    return { projectId, projectWorkspaceId, executionWorkspaceId };
  }

  it("rejects create with reuse_existing and no resolvable execution workspace", async () => {
    const companyId = await seedCompany();
    const { projectId } = await seedProjectWorkspace(companyId);

    await expect(svc.create(companyId, {
      projectId,
      title: "Redeliver PR from the carrier worktree",
      status: "todo",
      priority: "high",
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    })).rejects.toMatchObject({
      status: 422,
      message: WORKSPACE_REUSE_REQUIRES_EXECUTION_WORKSPACE_MESSAGE,
      details: {
        code: WORKSPACE_REUSE_REQUIRES_EXECUTION_WORKSPACE_CODE,
        remediation: WORKSPACE_REUSE_REQUIRES_EXECUTION_WORKSPACE_REMEDIATION,
        field: "executionWorkspaceId",
      },
    });

    const persisted = await db.select({ id: issues.id }).from(issues);
    expect(persisted).toHaveLength(0);
  });

  it("keeps create with reuse_existing and an explicit workspace id unchanged", async () => {
    const companyId = await seedCompany();
    const { projectId, executionWorkspaceId } = await seedProjectWorkspace(companyId);

    const issue = await svc.create(companyId, {
      projectId,
      title: "Bound carrier issue",
      status: "todo",
      priority: "high",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    expect(issue.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(issue.executionWorkspacePreference).toBe("reuse_existing");
  });

  it("keeps create with isolated_workspace and no reuse preference unchanged", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWorkspace(companyId);

    const issue = await svc.create(companyId, {
      projectId,
      title: "Fresh isolated worktree",
      status: "todo",
      priority: "high",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    expect(issue.executionWorkspaceId).toBeNull();
    expect(issue.executionWorkspacePreference).toBeNull();
    expect(issue.projectWorkspaceId).toBe(projectWorkspaceId);
  });

  it("honours inheritExecutionWorkspaceFromIssueId when reuse_existing carries no explicit id", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId, executionWorkspaceId } = await seedProjectWorkspace(companyId);
    const sourceIssueId = randomUUID();
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Carrier issue",
      status: "in_progress",
      priority: "high",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const issue = await svc.create(companyId, {
      projectId,
      title: "Redo on the carrier worktree",
      status: "todo",
      priority: "high",
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
      executionWorkspacePreference: "reuse_existing",
    });

    expect(issue.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(issue.executionWorkspacePreference).toBe("reuse_existing");
  });

  it("declines to inherit a workspace whose owning issue has already finished", async () => {
    // SUP-11260: a worktree outlives the issue it was cut for. Binding new issues
    // to a finished issue's workspace is how single worktrees accumulated dozens
    // of unrelated issues over days, and how concurrent agents ended up in one
    // working tree destroying each other's commits.
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId, executionWorkspaceId } = await seedProjectWorkspace(companyId);
    const sourceIssueId = randomUUID();
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Carrier issue that has since finished",
      status: "done",
      priority: "high",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));

    const issue = await svc.create(companyId, {
      projectId,
      title: "Follow-up after the carrier finished",
      status: "todo",
      priority: "high",
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
      executionWorkspacePreference: "reuse_existing",
    });

    // Declined, and the bare preference cleared with it — a refused inheritance
    // must not surface as an unrealizable reuse_existing the caller cannot act on.
    expect(issue.executionWorkspaceId).toBeNull();
    expect(issue.executionWorkspacePreference).toBeNull();
  });

  it("still inherits a workspace whose owning issue is live", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId, executionWorkspaceId } = await seedProjectWorkspace(companyId);
    const sourceIssueId = randomUUID();
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Carrier issue still running",
      status: "in_progress",
      priority: "high",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));

    const issue = await svc.create(companyId, {
      projectId,
      title: "Child of a live carrier",
      status: "todo",
      priority: "high",
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
      executionWorkspacePreference: "reuse_existing",
    });

    expect(issue.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(issue.executionWorkspacePreference).toBe("reuse_existing");
  });

  it("rejects an update that would leave reuse_existing without a workspace id", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWorkspace(companyId);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Unbound issue",
      status: "todo",
      priority: "high",
      issueNumber: 1,
      identifier: "T-1",
    });

    await expect(svc.update(issueId, {
      executionWorkspacePreference: "reuse_existing",
    })).rejects.toMatchObject({
      status: 422,
      details: { code: WORKSPACE_REUSE_REQUIRES_EXECUTION_WORKSPACE_CODE },
    });

    const [after] = await db
      .select({
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(after).toEqual({ executionWorkspaceId: null, executionWorkspacePreference: null });
  });

  it("allows an update that sets reuse_existing together with a workspace id", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId, executionWorkspaceId } = await seedProjectWorkspace(companyId);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Unbound issue",
      status: "todo",
      priority: "high",
      issueNumber: 2,
      identifier: "T-2",
    });

    const updated = await svc.update(issueId, {
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });

    expect(updated?.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(updated?.executionWorkspacePreference).toBe("reuse_existing");
  });
});
