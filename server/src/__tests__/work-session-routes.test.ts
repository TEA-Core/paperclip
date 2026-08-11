import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { workSessionRoutes } from "../routes/work-sessions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("work-session routes", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase(
      "work-session-routes",
    );
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedExternalPullAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const projectId = randomUUID();
    const identifier = `WS${companyId.slice(0, 7).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Work session test",
      issuePrefix: identifier,
      status: "active",
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Work session project",
      status: "active",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ExternalPullAgent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { workDelivery: "external_pull" },
      permissions: {},
      status: "idle",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier,
      projectId,
      title: "Work session test issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "test-user",
      createdByUserId: "cloud-user-1",
    });

    return { companyId, agentId, issueId, identifier };
  }

  async function seedPlatformManagedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const projectId = randomUUID();
    const identifier = `PM${companyId.slice(0, 7).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Platform managed test",
      issuePrefix: identifier,
      status: "active",
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Platform managed project",
      status: "active",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "PlatformManagedAgent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { workDelivery: "platform_managed" },
      permissions: {},
      status: "idle",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier,
      projectId,
      title: "Platform managed test issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "cloud-user-1",
    });

    return { companyId, agentId, issueId, identifier };
  }

  function createApp(agentId: string, companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId,
        companyId,
        source: "agent_jwt",
      };
      next();
    });
    app.use("/api", workSessionRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("external pull agent opens a self-declared run", async () => {
    const fixture = await seedExternalPullAgent();
    const app = createApp(fixture.agentId, fixture.companyId);

    const res = await request(app).post(
      `/api/issues/${fixture.issueId}/work-session`,
    );
    expect(res.status).toBe(201);
    expect(res.body.runId).toBeTruthy();
    expect(res.body.issueId).toBe(fixture.issueId);
    expect(res.body.status).toBe("running");
    expect(res.body.workspace).toHaveProperty("strategy");
    expect(res.body.workspace).toHaveProperty("cwd");
    expect(res.body.workspace).toHaveProperty("branchName");
    expect(res.body.workspace).toHaveProperty("worktreePath");
    expect(res.body.workspace).toHaveProperty("executionWorkspaceId");

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, res.body.runId))
      .then((rows) => rows[0]);
    expect(run).toBeTruthy();
    expect(run.status).toBe("running");
    expect(run.invocationSource).toBe("self_declared");
    expect(run.agentId).toBe(fixture.agentId);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, fixture.issueId))
      .then((rows) => rows[0]);
    expect(issue.status).toBe("in_progress");
    expect(issue.executionRunId).toBe(res.body.runId);
  });

  it("run is never queued", async () => {
    const fixture = await seedExternalPullAgent();
    const app = createApp(fixture.agentId, fixture.companyId);

    const res = await request(app).post(
      `/api/issues/${fixture.issueId}/work-session`,
    );
    expect(res.status).toBe(201);

    const allRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, fixture.agentId));
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0].status).toBe("running");
    expect(allRuns[0].invocationSource).toBe("self_declared");
  });

  it("non-external-pull agent gets 403", async () => {
    const fixture = await seedPlatformManagedAgent();
    const app = createApp(fixture.agentId, fixture.companyId);

    const res = await request(app).post(
      `/api/issues/${fixture.issueId}/work-session`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent is not an external pull agent");
  });

  it("different agent gets 403", async () => {
    const fixture = await seedExternalPullAgent();
    const otherAgentId = randomUUID();
    const otherCompanyId = fixture.companyId;

    await db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompanyId,
      name: "OtherExternalPullAgent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { workDelivery: "external_pull" },
      permissions: {},
      status: "idle",
    });

    const app = createApp(otherAgentId, otherCompanyId);
    const res = await request(app).post(
      `/api/issues/${fixture.issueId}/work-session`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent is not assigned to this issue");
  });

  it("keepalive bumps updatedAt and returns expiresAt", async () => {
    const fixture = await seedExternalPullAgent();
    const app = createApp(fixture.agentId, fixture.companyId);

    const openRes = await request(app).post(
      `/api/issues/${fixture.issueId}/work-session`,
    );
    expect(openRes.status).toBe(201);
    const runId = openRes.body.runId;

    await new Promise((r) => setTimeout(r, 1100));

    const hbRes = await request(app)
      .post(`/api/issues/${fixture.issueId}/work-session/heartbeat`)
      .send({ runId });
    expect(hbRes.status).toBe(200);
    expect(hbRes.body.runId).toBe(runId);
    expect(hbRes.body.expiresAt).toBeTruthy();

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(new Date(run.updatedAt).getTime()).toBeGreaterThan(
      new Date(openRes.body.runId ? run.startedAt : 0).getTime(),
    );
  });

  it("keepalive for run owned by different agent gets 403", async () => {
    const fixture = await seedExternalPullAgent();
    const app = createApp(fixture.agentId, fixture.companyId);

    const openRes = await request(app).post(
      `/api/issues/${fixture.issueId}/work-session`,
    );
    expect(openRes.status).toBe(201);

    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: fixture.companyId,
      name: "OtherAgent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { workDelivery: "external_pull" },
      permissions: {},
      status: "idle",
    });

    const otherApp = createApp(otherAgentId, fixture.companyId);
    const hbRes = await request(otherApp)
      .post(`/api/issues/${fixture.issueId}/work-session/heartbeat`)
      .send({ runId: openRes.body.runId });
    expect(hbRes.status).toBe(403);
    expect(hbRes.body.error).toBe("Run does not belong to calling agent");
  });

  it("close finalizes run and releases lock", async () => {
    const fixture = await seedExternalPullAgent();
    const app = createApp(fixture.agentId, fixture.companyId);

    const openRes = await request(app).post(
      `/api/issues/${fixture.issueId}/work-session`,
    );
    expect(openRes.status).toBe(201);
    const runId = openRes.body.runId;

    const closeRes = await request(app)
      .post(`/api/issues/${fixture.issueId}/work-session/close`)
      .send({ runId, outcome: "succeeded", summary: "work complete" });
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.runId).toBe(runId);
    expect(closeRes.body.status).toBe("succeeded");

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(run.status).toBe("succeeded");
    expect(run.finishedAt).toBeTruthy();

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, fixture.issueId))
      .then((rows) => rows[0]);
    expect(issue.executionRunId).toBeNull();
    expect(issue.checkoutRunId).toBeNull();
  });

  it("close with invalid outcome gets 400", async () => {
    const fixture = await seedExternalPullAgent();
    const app = createApp(fixture.agentId, fixture.companyId);

    const openRes = await request(app).post(
      `/api/issues/${fixture.issueId}/work-session`,
    );
    expect(openRes.status).toBe(201);

    const closeRes = await request(app).post(
      `/api/issues/${fixture.issueId}/work-session/close`,
      {
        runId: openRes.body.runId,
        outcome: "bogus",
      },
    );
    expect(closeRes.status).toBe(400);
  });

  it("close for run owned by different agent gets 403", async () => {
    const fixture = await seedExternalPullAgent();
    const app = createApp(fixture.agentId, fixture.companyId);

    const openRes = await request(app).post(
      `/api/issues/${fixture.issueId}/work-session`,
    );
    expect(openRes.status).toBe(201);

    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: fixture.companyId,
      name: "OtherAgent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { workDelivery: "external_pull" },
      permissions: {},
      status: "idle",
    });

    const otherApp = createApp(otherAgentId, fixture.companyId);
    const closeRes = await request(otherApp)
      .post(`/api/issues/${fixture.issueId}/work-session/close`)
      .send({ runId: openRes.body.runId, outcome: "succeeded" });
    expect(closeRes.status).toBe(403);
  });

  it("keepalive with runId from different issue gets 403", async () => {
    const fixture1 = await seedExternalPullAgent();
    const fixture2 = await seedExternalPullAgent();
    const app1 = createApp(fixture1.agentId, fixture1.companyId);

    const openRes = await request(app1).post(
      `/api/issues/${fixture1.issueId}/work-session`,
    );
    expect(openRes.status).toBe(201);
    const runId = openRes.body.runId;

    const app2 = createApp(fixture1.agentId, fixture1.companyId);
    const hbRes = await request(app2)
      .post(`/api/issues/${fixture2.issueId}/work-session/heartbeat`)
      .send({ runId });
    expect(hbRes.status).toBe(403);
    expect(hbRes.body.error).toBe("Run does not belong to this issue");
  });

  it("close with runId from different issue gets 403", async () => {
    const fixture1 = await seedExternalPullAgent();
    const fixture2 = await seedExternalPullAgent();
    const app1 = createApp(fixture1.agentId, fixture1.companyId);

    const openRes = await request(app1).post(
      `/api/issues/${fixture1.issueId}/work-session`,
    );
    expect(openRes.status).toBe(201);
    const runId = openRes.body.runId;

    const app2 = createApp(fixture1.agentId, fixture1.companyId);
    const closeRes = await request(app2)
      .post(`/api/issues/${fixture2.issueId}/work-session/close`)
      .send({ runId, outcome: "succeeded" });
    expect(closeRes.status).toBe(403);
    expect(closeRes.body.error).toBe("Run does not belong to this issue");
  });

  it("keepalive with invalid runId gets 400", async () => {
    const fixture = await seedExternalPullAgent();
    const app = createApp(fixture.agentId, fixture.companyId);

    const hbRes = await request(app)
      .post(`/api/issues/${fixture.issueId}/work-session/heartbeat`)
      .send({ runId: "not-a-uuid" });
    expect(hbRes.status).toBe(400);
  });

  it("close with invalid runId gets 400", async () => {
    const fixture = await seedExternalPullAgent();
    const app = createApp(fixture.agentId, fixture.companyId);

    const closeRes = await request(app)
      .post(`/api/issues/${fixture.issueId}/work-session/close`)
      .send({ runId: "not-a-uuid", outcome: "succeeded" });
    expect(closeRes.status).toBe(400);
  });

  it("non-agent actor gets 403", async () => {
    const fixture = await seedExternalPullAgent();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit" };
      next();
    });
    app.use("/api", workSessionRoutes(db));
    app.use(errorHandler);

    const res = await request(app).post(
      `/api/issues/${fixture.issueId}/work-session`,
    );
    expect(res.status).toBe(403);
  });

  it("close with failed outcome releases the execution lock without creating an automation run for external pull agents", async () => {
    const fixture = await seedExternalPullAgent();
    const app = createApp(fixture.agentId, fixture.companyId);

    const openRes = await request(app).post(
      `/api/issues/${fixture.issueId}/work-session`,
    );
    expect(openRes.status).toBe(201);
    const runId = openRes.body.runId;

    const closeRes = await request(app)
      .post(`/api/issues/${fixture.issueId}/work-session/close`)
      .send({ runId, outcome: "failed", summary: "simulated reaper force-fail" });
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.status).toBe("failed");

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, fixture.agentId));
    const selfDeclaredRuns = runs.filter((r) => r.invocationSource === "self_declared");
    const automationRuns = runs.filter((r) => r.invocationSource === "automation");
    expect(selfDeclaredRuns).toHaveLength(1);
    expect(automationRuns).toHaveLength(0);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, fixture.issueId))
      .then((rows) => rows[0]);
    expect(issue.executionRunId).toBeNull();
    expect(issue.executionLockedAt).toBeNull();
    expect(issue.checkoutRunId).toBeNull();
  });
});
