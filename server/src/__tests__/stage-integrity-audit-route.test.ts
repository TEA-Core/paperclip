import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueExecutionDecisions,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { activityRoutes } from "../routes/activity.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stage-integrity audit tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", activityRoutes(db));
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

async function seedCompany(db: Db, label = "StageAudit") {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `${label} ${nonce}`,
    issuePrefix: `SA${nonce.slice(0, 4).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
  }).returning();
  return company!;
}

async function seedAgent(db: Db, companyId: string) {
  const [agent] = await db.insert(agents).values({
    companyId,
    name: `Agent ${randomUUID().slice(0, 6)}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
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
  identifier: string;
  status?: string;
  executionPolicy?: Record<string, unknown> | null;
  executionState?: Record<string, unknown> | null;
  completedAt?: Date | null;
  createdByAgentId?: string | null;
}) {
  const [issue] = await db.insert(issues).values({
    companyId: input.companyId,
    projectId: input.projectId ?? null,
    parentId: null,
    title: input.title,
    identifier: input.identifier,
    status: input.status ?? "todo",
    priority: "medium",
    assigneeAgentId: null,
    responsibleUserId: "board-user",
    executionPolicy: input.executionPolicy ?? null,
    executionState: input.executionState ?? null,
    completedAt: input.completedAt ?? null,
    createdByAgentId: input.createdByAgentId ?? null,
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

// Mirrors the retained live corpus boundary from the SUP-14923 sweep: the
// earliest issue_execution_decisions row in the company.
const T0 = new Date("2026-08-15T20:17:30Z");

function reviewPolicy(stageId: string) {
  return {
    mode: "normal",
    stages: [{ id: stageId, type: "review", participants: [], approvalsNeeded: 1 }],
    commentRequired: true,
  };
}

describeEmbeddedPostgres("stage-integrity audit route (ADR-073 D3, SUP-14923)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousAllowKeyGeneration = process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-stage-integrity-audit-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION = "1";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stage-integrity-audit-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueExecutionDecisions);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    if (previousAllowKeyGeneration === undefined) delete process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION;
    else process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION = previousAllowKeyGeneration;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCorpus(company: CompanyRow, agent: AgentRow, project: { id: string }) {
    // The only decision row in the company: it sets the pre-table boundary (T0).
    // It belongs to a clean, properly-decided issue that must NOT be flagged.
    const cleanStageId = randomUUID();
    const clean = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Clean decided close",
      identifier: "SIA-CLEAN",
      status: "done",
      executionPolicy: reviewPolicy(cleanStageId),
      executionState: { completedStageIds: [cleanStageId], skippedStageIds: [] },
      completedAt: new Date("2026-08-19T12:00:00Z"),
      createdByAgentId: agent.id,
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: clean.id,
      stageId: cleanStageId,
      stageType: "review",
      actorUserId: "board-user",
      outcome: "approved",
      body: "clean-verdict",
      createdAt: T0,
    });

    // SUP-13376 shape: a completed stage with NO decision row.
    const s13376Stage = randomUUID();
    await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Completed stage, no decision row",
      identifier: "SIA-001",
      status: "done",
      executionPolicy: reviewPolicy(s13376Stage),
      executionState: { completedStageIds: [s13376Stage], skippedStageIds: [] },
      completedAt: new Date("2026-08-19T04:27:56Z"),
      createdByAgentId: agent.id,
    });

    // Four SUP-14183/14075/14260/13793 shapes: ladder never fired.
    // AC2: null executionState and no linked PR must still be reachable.
    const ladderShapes: Array<{ identifier: string; completedAt: string }> = [
      { identifier: "SIA-002", completedAt: "2026-08-28T00:41:25Z" },
      { identifier: "SIA-003", completedAt: "2026-08-28T00:41:46Z" },
      { identifier: "SIA-004", completedAt: "2026-08-28T17:42:26Z" },
      { identifier: "SIA-005", completedAt: "2026-09-03T08:45:52Z" },
    ];
    for (const shape of ladderShapes) {
      await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: `Ladder never fired ${shape.identifier}`,
        identifier: shape.identifier,
        status: "done",
        executionPolicy: reviewPolicy(randomUUID()),
        executionState: null,
        completedAt: new Date(shape.completedAt),
        createdByAgentId: agent.id,
      });
    }

    // SUP-14273 shape: its stage is lawfully in skippedStageIds -> NOT a finding.
    const skipStage = randomUUID();
    await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Lawfully skipped stage",
      identifier: "SIA-SKIP",
      status: "done",
      executionPolicy: reviewPolicy(skipStage),
      executionState: { completedStageIds: [], skippedStageIds: [skipStage] },
      completedAt: new Date("2026-08-20T10:00:00Z"),
      createdByAgentId: agent.id,
    });

    // SUP-12881 shape: closed before T0 -> pre-table artifact, indeterminate.
    await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Pre-decision-table close",
      identifier: "SIA-PRE",
      status: "done",
      executionPolicy: reviewPolicy(randomUUID()),
      executionState: null,
      completedAt: new Date("2026-08-15T19:52:42Z"),
      createdByAgentId: agent.id,
    });

    // An empty-stages close must not even be selected as a candidate.
    await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "No policy stages",
      identifier: "SIA-NOSTAGES",
      status: "done",
      executionPolicy: { mode: "normal", stages: [] },
      executionState: null,
      completedAt: new Date("2026-08-19T13:00:00Z"),
      createdByAgentId: agent.id,
    });
  }

  it("flags exactly the unmet/completed-without-decision terminal issues and excludes lawful + pre-table closes (AC1/AC2/AC4)", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    await seedCorpus(company, agent, project);

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/companies/${company.id}/audit/stage-integrity`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const identifiers = new Set(res.body.map((row: { identifier: string }) => row.identifier));
    // AC4: exactly the five findings...
    expect([...identifiers].sort()).toEqual(["SIA-001", "SIA-002", "SIA-003", "SIA-004", "SIA-005"]);
    // ...and NOT the lawful skip, the pre-table artifact, the clean control, or the empty-stages close.
    expect(identifiers.has("SIA-SKIP")).toBe(false);
    expect(identifiers.has("SIA-PRE")).toBe(false);
    expect(identifiers.has("SIA-CLEAN")).toBe(false);
    expect(identifiers.has("SIA-NOSTAGES")).toBe(false);

    // AC1: a completed stage with no decision row is flagged as such.
    const s13376 = res.body.find((row: { identifier: string }) => row.identifier === "SIA-001");
    expect(s13376?.reason).toBe("guard-b:stage-without-decision");
    // AC2: a card with null executionState and no PR is reachable and flagged.
    const s002 = res.body.find((row: { identifier: string }) => row.identifier === "SIA-002");
    expect(s002?.reason).toBe("guard-b:no-completed-stage");
    // Every finding carries a machine-readable reason + human detail.
    for (const row of res.body as Array<{ reason: string; detail: string; id: string }>) {
      expect(typeof row.reason).toBe("string");
      expect(row.reason.length).toBeGreaterThan(0);
      expect(typeof row.detail).toBe("string");
      expect(row.id).toBeTruthy();
    }
  });

  it("reaches a no-deliverable-head card (null executionState, no PR, no approval record) that the PR-gated scan cannot (AC2)", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");

    // Boundary row so the pre-table filter has a reference and does not swallow the finding.
    const boundaryStage = randomUUID();
    const boundary = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Boundary clean close",
      identifier: "SIA-BOUNDARY",
      status: "done",
      executionPolicy: reviewPolicy(boundaryStage),
      executionState: { completedStageIds: [boundaryStage], skippedStageIds: [] },
      completedAt: new Date("2026-08-18T00:00:00Z"),
      createdByAgentId: agent.id,
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: boundary.id,
      stageId: boundaryStage,
      stageType: "review",
      actorUserId: "board-user",
      outcome: "approved",
      body: "boundary-verdict",
      createdAt: T0,
    });

    // The no-deliverable-head close: no executionState, no PR, no approval.
    await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "No-deliverable-head close",
      identifier: "SIA-NOHEAD",
      status: "done",
      executionPolicy: reviewPolicy(randomUUID()),
      executionState: null,
      completedAt: new Date("2026-09-01T00:00:00Z"),
      createdByAgentId: agent.id,
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/companies/${company.id}/audit/stage-integrity`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const identifiers = new Set(res.body.map((row: { identifier: string }) => row.identifier));
    expect(identifiers.has("SIA-NOHEAD")).toBe(true);
    expect(identifiers.has("SIA-BOUNDARY")).toBe(false);
  });

  it("excludes a close whose completedAt predates the company's first decision row (AC4 pre-table)", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");

    // First decision row at T0; the candidate closed 25 minutes earlier.
    const cleanStage = randomUUID();
    const clean = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "First-decision clean close",
      identifier: "SIA-FIRST",
      status: "done",
      executionPolicy: reviewPolicy(cleanStage),
      executionState: { completedStageIds: [cleanStage], skippedStageIds: [] },
      completedAt: new Date("2026-08-20T00:00:00Z"),
      createdByAgentId: agent.id,
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: clean.id,
      stageId: cleanStage,
      stageType: "review",
      actorUserId: "board-user",
      outcome: "approved",
      body: "first-verdict",
      createdAt: T0,
    });

    const preStage = randomUUID();
    await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Pre-table close",
      identifier: "SIA-PRE",
      status: "done",
      executionPolicy: reviewPolicy(preStage),
      executionState: null,
      completedAt: new Date("2026-08-15T19:52:42Z"),
      createdByAgentId: agent.id,
    });
    // A post-T0 unmet close in the same company must still be flagged, proving
    // the exclusion is time-scoped, not company-wide.
    const postStage = randomUUID();
    await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Post-table unmet close",
      identifier: "SIA-POST",
      status: "done",
      executionPolicy: reviewPolicy(postStage),
      executionState: null,
      completedAt: new Date("2026-08-16T00:00:00Z"),
      createdByAgentId: agent.id,
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/companies/${company.id}/audit/stage-integrity`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const identifiers = new Set(res.body.map((row: { identifier: string }) => row.identifier));
    expect(identifiers.has("SIA-PRE")).toBe(false);
    expect(identifiers.has("SIA-POST")).toBe(true);
    expect(identifiers.has("SIA-FIRST")).toBe(false);
  });

  it("returns an empty array when every terminal close is clean", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const stage = randomUUID();
    const clean = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Only clean close",
      identifier: "SIA-ONLYCLEAN",
      status: "done",
      executionPolicy: reviewPolicy(stage),
      executionState: { completedStageIds: [stage], skippedStageIds: [] },
      completedAt: new Date("2026-08-20T00:00:00Z"),
      createdByAgentId: agent.id,
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: clean.id,
      stageId: stage,
      stageType: "review",
      actorUserId: "board-user",
      outcome: "approved",
      body: "only-clean-verdict",
      createdAt: T0,
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/companies/${company.id}/audit/stage-integrity`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("refuses an agent key from another company with 403", async () => {
    const companyA = await seedCompany(db, "Company A");
    const companyB = await seedCompany(db, "Company B");
    const agentB = await seedAgent(db, companyB.id);

    const res = await request(createApp(db, agentActor(companyB, agentB, randomUUID())))
      .get(`/api/companies/${companyA.id}/audit/stage-integrity`);

    expect(res.status).toBe(403);
  });

  it("rejects an invalid limit with 400 (AC5 query params are validated + declared)", async () => {
    const company = await seedCompany(db);
    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/companies/${company.id}/audit/stage-integrity?limit=abc`);
    expect(res.status).toBe(400);
  });
});
