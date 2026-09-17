import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issueCreateIdempotencyKeys,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent_default/projectWorkspaceId pair tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * SUP-16608: the create path must never persist the pair
 * (`executionWorkspacePreference: "agent_default"` + non-null `projectWorkspaceId`),
 * which the issues PATCH refuses for the card's whole lifetime. Read the fetched
 * row directly so the assertion is about what was actually stored, not the echo.
 */
describeEmbeddedPostgres("issue create agent_default / projectWorkspaceId pair", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-default-pair-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    return companyId;
  }

  async function seedProjectWithWorkspace(companyId: string) {
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Platform", status: "in_progress" });
    const projectWorkspaceId = randomUUID();
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "primary",
      isPrimary: true,
    });
    const executionWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });
    return { projectId, projectWorkspaceId, executionWorkspaceId };
  }

  async function seedOpenBlocker(companyId: string) {
    const [blocker] = await db
      .insert(issues)
      .values({ companyId, title: "Open blocker", status: "todo", priority: "medium" })
      .returning();
    return blocker;
  }

  async function seedAgentWithKey(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const token = `sup16608-${randomUUID()}`;
    const responsibleUserId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({
      id: responsibleUserId,
      name: "Operator",
      email: `${responsibleUserId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(agentApiKeys).values({
      agentId,
      companyId,
      name: "sup-16608-key",
      keyHash: createHash("sha256").update(token).digest("hex"),
      responsibleUserId,
    });
    return { agentId, token };
  }

  async function seedWedgedCard(input: {
    companyId: string;
    projectId: string;
    projectWorkspaceId: string;
    executionWorkspaceId: string;
    agentId: string;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "running",
    });
    const wedgedId = randomUUID();
    await db.insert(issues).values({
      id: wedgedId,
      companyId: input.companyId,
      projectId: input.projectId,
      projectWorkspaceId: input.projectWorkspaceId,
      executionWorkspaceId: input.executionWorkspaceId,
      executionWorkspacePreference: "agent_default",
      executionRunId: runId,
      assigneeAgentId: input.agentId,
      title: "Wedged card",
      status: "in_progress",
      priority: "medium",
    });
    return { wedgedId, runId };
  }

  it("stores a valid pair when agent_default arrives with an explicit projectWorkspaceId (create + bare blocked PATCH succeeds)", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId } = await seedProjectWithWorkspace(companyId);
    const blocker = await seedOpenBlocker(companyId);
    const app = createApp();

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Recovered card",
        status: "todo",
        projectId,
        projectWorkspaceId,
        executionWorkspacePreference: "agent_default",
        blockedByIssueIds: [blocker.id],
      });

    expect(createRes.status).toBe(201);

    const [stored] = await db.select().from(issues).where(eq(issues.id, createRes.body.id));
    expect(stored.executionWorkspacePreference).toBe("agent_default");
    expect(stored.projectWorkspaceId).toBeNull();

    const patchRes = await request(app)
      .patch(`/api/issues/${createRes.body.id}`)
      .send({ status: "blocked" });

    expect(patchRes.status).toBe(200);

    const [repaired] = await db.select().from(issues).where(eq(issues.id, createRes.body.id));
    expect(repaired.status).toBe("blocked");
  });

  it("does not let the project-default auto-fill mint the invalid pair (agent_default + projectId only)", async () => {
    const companyId = await seedCompany();
    const { projectId } = await seedProjectWithWorkspace(companyId);
    const app = createApp();

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Agent home issue",
        status: "todo",
        projectId,
        executionWorkspacePreference: "agent_default",
      });

    expect(createRes.status).toBe(201);

    const [stored] = await db.select().from(issues).where(eq(issues.id, createRes.body.id));
    expect(stored.executionWorkspacePreference).toBe("agent_default");
    // The project has a primary workspace, so the resolver would otherwise
    // auto-fill it and store the unpatchable pair.
    expect(stored.projectWorkspaceId).toBeNull();
  });

  it("leaves an already-wedged card repairable by its own assignee while a run is active", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId, executionWorkspaceId } =
      await seedProjectWithWorkspace(companyId);
    const blocker = await seedOpenBlocker(companyId);
    const { agentId, token } = await seedAgentWithKey(companyId, "coder-be");
    const { wedgedId, runId } = await seedWedgedCard({
      companyId,
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      agentId,
    });

    const app = createApp();
    const repairRes = await request(app)
      .patch(`/api/issues/${wedgedId}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ status: "blocked", projectWorkspaceId: null, blockedByIssueIds: [blocker.id] });

    expect(repairRes.status).toBe(200);

    const [stored] = await db.select().from(issues).where(eq(issues.id, wedgedId));
    expect(stored.status).toBe("blocked");
    expect(stored.projectWorkspaceId).toBeNull();
  });

  it("refuses the preference-clearing re-provision while a run is active (why clearing projectWorkspaceId is the reachable repair)", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId, executionWorkspaceId } =
      await seedProjectWithWorkspace(companyId);
    const { agentId } = await seedAgentWithKey(companyId, "coder-be");
    const { wedgedId } = await seedWedgedCard({
      companyId,
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      agentId,
    });

    const app = createApp();
    const res = await request(app)
      .patch(`/api/issues/${wedgedId}`)
      .send({ projectWorkspaceId: null, executionWorkspacePreference: null });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("issue_workspace_reprovision_run_active");
  });
});