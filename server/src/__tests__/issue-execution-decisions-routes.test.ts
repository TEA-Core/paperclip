import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueExecutionDecisions,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution-decisions route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

const CONTRACT_FIELDS = [
  "id",
  "issueId",
  "stageId",
  "stageType",
  "actorAgentId",
  "actorUserId",
  "outcome",
  "body",
  "createdByRunId",
  "createdAt",
] as const;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(company: CompanyRow): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [company.id],
    memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function agentActor(company: CompanyRow, agent: AgentRow, runId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: agent.id,
    companyId: company.id,
    runId,
    source: "agent_jwt",
  };
}

async function seedCompany(db: Db, label = "Decisions") {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `${label} ${nonce}`,
    issuePrefix: `DC${nonce.slice(0, 4).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
  }).returning();
  return company!;
}

async function seedAgent(db: Db, companyId: string, permissions: Record<string, unknown> = {}) {
  const [agent] = await db.insert(agents).values({
    companyId,
    name: `Agent ${randomUUID().slice(0, 6)}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions,
  }).returning();
  return agent!;
}

async function seedProject(db: Db, companyId: string, name: string) {
  const [project] = await db.insert(projects).values({
    companyId,
    name,
    status: "in_progress",
  }).returning();
  return project!;
}

async function seedIssue(db: Db, input: {
  companyId: string;
  projectId?: string | null;
  title: string;
  status?: string;
  executionPolicy?: Record<string, unknown>;
}) {
  const [issue] = await db.insert(issues).values({
    companyId: input.companyId,
    projectId: input.projectId ?? null,
    parentId: null,
    title: input.title,
    status: input.status ?? "todo",
    priority: "medium",
    assigneeAgentId: null,
    responsibleUserId: "board-user",
    executionPolicy: input.executionPolicy ?? null,
  }).returning();
  return issue!;
}

async function seedDecision(db: Db, input: {
  companyId: string;
  issueId: string;
  stageId: string;
  stageType: string;
  actorAgentId?: string | null;
  actorUserId?: string | null;
  outcome: string;
  body: string;
  createdAt: Date;
}) {
  const [row] = await db.insert(issueExecutionDecisions).values({
    companyId: input.companyId,
    issueId: input.issueId,
    stageId: input.stageId,
    stageType: input.stageType,
    actorAgentId: input.actorAgentId ?? null,
    actorUserId: input.actorUserId ?? null,
    outcome: input.outcome,
    body: input.body,
    createdByRunId: null,
    createdAt: input.createdAt,
  }).returning();
  return row!;
}

describeEmbeddedPostgres("issue execution-decisions read route (ADR-073 D4)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-execution-decisions-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueExecutionDecisions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns every decision for a 3-stage ladder, ordered createdAt ascending, with the ten contract fields", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Ladder parent",
      status: "done",
    });

    const stageIds = [randomUUID(), randomUUID(), randomUUID()];
    const t1 = new Date("2026-08-20T10:00:00Z");
    const t2 = new Date("2026-08-20T11:00:00Z");
    const t3 = new Date("2026-08-20T12:00:00Z");
    // Insert out of chronological order to prove ordering comes from the query.
    await seedDecision(db, {
      companyId: company.id,
      issueId: issue.id,
      stageId: stageIds[2],
      stageType: "approval",
      actorUserId: "board-user",
      outcome: "approved",
      body: "stage-3-verdict",
      createdAt: t3,
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: issue.id,
      stageId: stageIds[0],
      stageType: "review",
      actorAgentId: agent.id,
      outcome: "approved",
      body: "stage-1-verdict",
      createdAt: t1,
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: issue.id,
      stageId: stageIds[1],
      stageType: "review",
      actorAgentId: agent.id,
      outcome: "changes_requested",
      body: "stage-2-verdict",
      createdAt: t2,
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/execution-decisions`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
    for (const row of res.body) {
      expect(Object.keys(row)).toEqual([...CONTRACT_FIELDS]);
    }
    expect(res.body.map((row: { stageId: string; stageType: string; outcome: string; body: string; createdAt: string }) => [row.stageId, row.stageType, row.outcome, row.body])).toEqual([
      [stageIds[0], "review", "approved", "stage-1-verdict"],
      [stageIds[1], "review", "changes_requested", "stage-2-verdict"],
      [stageIds[2], "approval", "approved", "stage-3-verdict"],
    ]);
    expect(res.body[0].issueId).toBe(issue.id);
    expect(res.body[0].actorAgentId).toBe(agent.id);
    expect(res.body[0].actorUserId).toBeNull();
    expect(res.body[2].actorAgentId).toBeNull();
    expect(res.body[2].actorUserId).toBe("board-user");
    expect(res.body[0].createdByRunId).toBeNull();
    expect(res.body[0].createdAt).toBe(t1.toISOString());
    expect(res.body[1].createdAt).toBe(t2.toISOString());
    expect(res.body[2].createdAt).toBe(t3.toISOString());
  });

  it("refuses an unauthorized caller with the same outcome as GET /api/issues/:id", async () => {
    const companyA = await seedCompany(db, "Company A");
    const companyB = await seedCompany(db, "Company B");
    const agentB = await seedAgent(db, companyB.id);
    const projectA = await seedProject(db, companyA.id, "A");
    const issueA = await seedIssue(db, {
      companyId: companyA.id,
      projectId: projectA.id,
      title: "Company A issue",
      status: "done",
    });
    await seedDecision(db, {
      companyId: companyA.id,
      issueId: issueA.id,
      stageId: randomUUID(),
      stageType: "review",
      outcome: "approved",
      body: "company-a-verdict",
      createdAt: new Date("2026-08-20T10:00:00Z"),
    });

    const app = createApp(db, agentActor(companyB, agentB, randomUUID()));

    const decisionsRes = await request(app).get(`/api/issues/${issueA.id}/execution-decisions`);
    const issueRes = await request(app).get(`/api/issues/${issueA.id}`);

    expect(decisionsRes.status).toBe(404);
    expect(decisionsRes.body.error).toBe("Issue not found");
    // Same authorization scope as the issue read itself.
    expect(decisionsRes.status).toBe(issueRes.status);
    expect(JSON.stringify(decisionsRes.body)).not.toContain("company-a-verdict");
  });

  it("returns 200 with an empty array for an issue that has no decisions", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "No decisions yet",
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/execution-decisions`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns a decision row whose stageId is no longer in executionPolicy.stages (orphaned completed stage)", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const currentStageId = randomUUID();
    const orphanStageId = randomUUID();
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Policy rewritten after stage completion",
      status: "done",
      // Only one stage in the live policy; the orphan row's stageId is not in it.
      executionPolicy: {
        mode: "normal",
        stages: [{ id: currentStageId, type: "review", participants: [], approvalsNeeded: 1 }],
        commentRequired: true,
      },
    });

    await seedDecision(db, {
      companyId: company.id,
      issueId: issue.id,
      stageId: orphanStageId,
      stageType: "review",
      actorUserId: "board-user",
      outcome: "approved",
      body: "orphan-stage-verdict",
      createdAt: new Date("2026-08-19T09:00:00Z"),
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: issue.id,
      stageId: currentStageId,
      stageType: "review",
      actorUserId: "board-user",
      outcome: "approved",
      body: "current-stage-verdict",
      createdAt: new Date("2026-08-19T10:00:00Z"),
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/execution-decisions`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((row: { stageId: string; body: string }) => [row.stageId, row.body])).toEqual([
      [orphanStageId, "orphan-stage-verdict"],
      [currentStageId, "current-stage-verdict"],
    ]);
  });

  it("returns 404 for a missing issue id", async () => {
    const company = await seedCompany(db);

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${randomUUID()}/execution-decisions`);

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toBe("Issue not found");
  });
});
