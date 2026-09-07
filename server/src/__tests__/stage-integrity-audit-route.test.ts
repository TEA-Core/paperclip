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

function twoStagePolicy(stageA: string, stageB: string) {
  return {
    mode: "normal",
    stages: [
      { id: stageA, type: "review", participants: [], approvalsNeeded: 1 },
      { id: stageB, type: "approval", participants: [], approvalsNeeded: 1 },
    ],
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

  it("flags an approved decision whose stage is in policy but in neither completedStageIds nor skippedStageIds (SUP-15212 inverse guard)", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");

    // Pre-table boundary: the earliest decision in the company sits at T0 so the
    // time-scoped exclusion has a reference and does not swallow the findings.
    const boundaryStage = randomUUID();
    const boundary = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Boundary clean close",
      identifier: "SIA-ORPH-BOUNDARY",
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
      body: "orphan-boundary-verdict",
      createdAt: T0,
    });

    // Orphaned verdict: stage A completed + decided (clean); stage B has a durable
    // `approved` decision but is in NEITHER completedStageIds NOR skippedStageIds.
    const stageA = randomUUID();
    const stageB = randomUUID();
    const orphan = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Orphaned decision",
      identifier: "SIA-ORPHAN",
      status: "done",
      executionPolicy: twoStagePolicy(stageA, stageB),
      executionState: { completedStageIds: [stageA], skippedStageIds: [] },
      completedAt: new Date("2026-09-05T05:00:00Z"),
      createdByAgentId: agent.id,
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: orphan.id,
      stageId: stageA,
      stageType: "review",
      actorUserId: "board-user",
      outcome: "approved",
      body: "orphan-A-verdict",
      createdAt: new Date("2026-09-05T04:00:00Z"),
    });
    const orphanB = await seedDecision(db, {
      companyId: company.id,
      issueId: orphan.id,
      stageId: stageB,
      stageType: "approval",
      actorUserId: "board-user",
      outcome: "approved",
      body: "orphan-B-verdict",
      createdAt: new Date("2026-09-05T04:18:44Z"),
    });

    // Same ladder, but stage B lawfully sits in skippedStageIds -> not a finding.
    const skipA = randomUUID();
    const skipB = randomUUID();
    const skippedOrphan = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Orphaned decision (stage lawfully skipped)",
      identifier: "SIA-ORPHAN-SKIP",
      status: "done",
      executionPolicy: twoStagePolicy(skipA, skipB),
      executionState: { completedStageIds: [skipA], skippedStageIds: [skipB] },
      completedAt: new Date("2026-09-05T06:00:00Z"),
      createdByAgentId: agent.id,
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: skippedOrphan.id,
      stageId: skipA,
      stageType: "review",
      actorUserId: "board-user",
      outcome: "approved",
      body: "orphan-skip-A-verdict",
      createdAt: new Date("2026-09-05T05:30:00Z"),
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: skippedOrphan.id,
      stageId: skipB,
      stageType: "approval",
      actorUserId: "board-user",
      outcome: "approved",
      body: "orphan-skip-B-verdict",
      createdAt: new Date("2026-09-05T05:31:00Z"),
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/companies/${company.id}/audit/stage-integrity`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const identifiers = new Set(res.body.map((row: { identifier: string }) => row.identifier));

    // The orphaned verdict is flagged with the inverse reason...
    const orphanRow = res.body.find((row: { identifier: string }) => row.identifier === "SIA-ORPHAN");
    expect(orphanRow?.reason).toBe("guard-b:decision-without-completed-stage");
    // ...naming the orphaned decision id, its stage, and its decision timestamp.
    expect(orphanRow?.detail).toContain(orphanB.id);
    expect(orphanRow?.detail).toContain(stageB);
    expect(orphanRow?.detail).toContain("2026-09-05T04:18:44");
    // The clean control and the lawfully-skipped variant are NOT flagged.
    expect(identifiers.has("SIA-ORPHAN-SKIP")).toBe(false);
    expect(identifiers.has("SIA-ORPH-BOUNDARY")).toBe(false);
  });

  it("surfaces a later guard hidden by a skipped stage, and leaves a skip-only card clean (SUP-15236)", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");

    // Pre-table boundary: the earliest decision in the company pins the time-scoped
    // exclusion so none of the cards below are treated as pre-decision-table.
    const boundaryStage = randomUUID();
    const boundary = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Boundary clean close",
      identifier: "SIA-15236-BND",
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

    // AC1: a lawfully-skipped stage plus an orphaned approved decision on a
    // DIFFERENT (in-policy, non-completed, non-skipped) stage. Pre-fix the skip
    // short-circuited the cascade and this card emitted nothing; post-fix the
    // orphaned-decision inverse guard is reached and reported.
    const orpA = randomUUID();
    const orpB = randomUUID();
    const orpOrphan = randomUUID();
    const skipOrphan = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Skip + orphaned decision",
      identifier: "SIA-SKIP-ORPHAN",
      status: "done",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          { id: orpA, type: "review", participants: [], approvalsNeeded: 1 },
          { id: orpB, type: "approval", participants: [], approvalsNeeded: 1 },
          { id: orpOrphan, type: "review", participants: [], approvalsNeeded: 1 },
        ],
      },
      executionState: { completedStageIds: [orpA], skippedStageIds: [orpB] },
      completedAt: new Date("2026-09-05T05:00:00Z"),
      createdByAgentId: agent.id,
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: skipOrphan.id,
      stageId: orpA,
      stageType: "review",
      actorUserId: "board-user",
      outcome: "approved",
      body: "skip-orphan-A-verdict",
      createdAt: new Date("2026-09-05T04:00:00Z"),
    });
    const skipOrphanB = await seedDecision(db, {
      companyId: company.id,
      issueId: skipOrphan.id,
      stageId: orpOrphan,
      stageType: "review",
      actorUserId: "board-user",
      outcome: "approved",
      body: "skip-orphan-orphan-verdict",
      createdAt: new Date("2026-09-05T04:18:44Z"),
    });

    // AC2: a card whose ONLY integrity-relevant fact is a lawfully-skipped stage.
    // Every policy stage is accounted for (completed or skipped) with decisions,
    // so continuing past the skip must find nothing and drop the card.
    const onlyA = randomUUID();
    const onlyB = randomUUID();
    const skipOnly = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Skip only (clean)",
      identifier: "SIA-SKIP-ONLY",
      status: "done",
      executionPolicy: twoStagePolicy(onlyA, onlyB),
      executionState: { completedStageIds: [onlyA], skippedStageIds: [onlyB] },
      completedAt: new Date("2026-09-05T06:00:00Z"),
      createdByAgentId: agent.id,
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: skipOnly.id,
      stageId: onlyA,
      stageType: "review",
      actorUserId: "board-user",
      outcome: "approved",
      body: "skip-only-A-verdict",
      createdAt: new Date("2026-09-05T05:00:00Z"),
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: skipOnly.id,
      stageId: onlyB,
      stageType: "approval",
      actorUserId: "board-user",
      outcome: "approved",
      body: "skip-only-B-verdict",
      createdAt: new Date("2026-09-05T05:01:00Z"),
    });

    // AC4: a pre-existing finding type (completed stage with no decision row) must
    // still surface — the continue-past-skip change must not drop earlier guards.
    const unmetStage = randomUUID();
    await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Completed stage, no decision row",
      identifier: "SIA-15236-UNMET",
      status: "done",
      executionPolicy: reviewPolicy(unmetStage),
      executionState: { completedStageIds: [unmetStage], skippedStageIds: [] },
      completedAt: new Date("2026-09-05T07:00:00Z"),
      createdByAgentId: agent.id,
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/companies/${company.id}/audit/stage-integrity`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body as Array<{ identifier: string; reason: string; detail: string; id: string }>;
    const byIdentifier = new Map(rows.map((row) => [row.identifier, row]));
    const identifiers = new Set(rows.map((row) => row.identifier));

    // AC1: the orphaned decision is no longer hidden by the skip.
    const skipOrphanRow = byIdentifier.get("SIA-SKIP-ORPHAN");
    expect(skipOrphanRow?.reason).toBe("guard-b:decision-without-completed-stage");
    expect(skipOrphanRow?.detail).toContain(orpOrphan);
    expect(skipOrphanRow?.detail).toContain(skipOrphanB.id);

    // AC2: the skip-only card produces no row.
    expect(identifiers.has("SIA-SKIP-ONLY")).toBe(false);

    // AC4: the pre-existing unmet finding still appears.
    const unmetRow = byIdentifier.get("SIA-15236-UNMET");
    expect(unmetRow?.reason).toBe("guard-b:stage-without-decision");

    // The boundary control is not flagged.
    expect(identifiers.has("SIA-15236-BND")).toBe(false);
  });

  it("admits in_review and blocked cards carrying a live ladder, and still excludes cancelled (SUP-15212 selector widening)", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");

    // in_review card with a live ladder and an orphaned verdict -> admitted + flagged.
    const inA = randomUUID();
    const inB = randomUUID();
    const inReview = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Live ladder (in_review)",
      identifier: "SIA-LIVE-REVIEW",
      status: "in_review",
      executionPolicy: twoStagePolicy(inA, inB),
      executionState: { completedStageIds: [inA], skippedStageIds: [] },
      completedAt: null,
      createdByAgentId: agent.id,
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: inReview.id,
      stageId: inA,
      stageType: "review",
      actorUserId: "board-user",
      outcome: "approved",
      body: "live-review-A-verdict",
      createdAt: new Date("2026-09-05T04:00:00Z"),
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: inReview.id,
      stageId: inB,
      stageType: "approval",
      actorUserId: "board-user",
      outcome: "approved",
      body: "live-review-B-verdict",
      createdAt: new Date("2026-09-05T04:18:44Z"),
    });

    // blocked card with a live ladder + an orphaned approved verdict ->
    // admitted and flagged decision-without-completed-stage (the close-presupposing
    // no-completed-stage must NOT fire on a live card with an empty completedStageIds).
    const blockedStage = randomUUID();
    const blocked = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Live ladder (blocked)",
      identifier: "SIA-LIVE-BLOCKED",
      status: "blocked",
      executionPolicy: reviewPolicy(blockedStage),
      executionState: { completedStageIds: [], skippedStageIds: [] },
      completedAt: null,
      createdByAgentId: agent.id,
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: blocked.id,
      stageId: blockedStage,
      stageType: "review",
      actorUserId: "board-user",
      outcome: "approved",
      body: "live-blocked-verdict",
      createdAt: new Date("2026-09-05T03:00:00Z"),
    });

    // blocked card whose only verdict is changes_requested (not a durable approval)
    // and whose ladder has completed no stage -> admitted but NOT flagged. This is
    // the regression the round-1 review required: pre-fix, `no-completed-stage`
    // fired on the empty completedStageIds and shadowed every later guard; post-fix
    // the close-presupposing guard is suppressed for a live card and the inverse
    // (orphaned-decision) guard only fires on a durable approved verdict, so a
    // changes_requested verdict is not a defect.
    const parkedStage = randomUUID();
    const parked = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Live ladder (blocked, changes requested)",
      identifier: "SIA-LIVE-PARKED",
      status: "blocked",
      executionPolicy: reviewPolicy(parkedStage),
      executionState: { completedStageIds: [], skippedStageIds: [] },
      completedAt: null,
      createdByAgentId: agent.id,
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: parked.id,
      stageId: parkedStage,
      stageType: "review",
      actorUserId: "board-user",
      outcome: "changes_requested",
      body: "live-parked-changes-requested",
      createdAt: new Date("2026-09-05T03:30:00Z"),
    });

    // cancelled card that would otherwise be a live-ladder finding -> excluded.
    const cxA = randomUUID();
    const cxB = randomUUID();
    const cancelled = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Cancelled ladder",
      identifier: "SIA-CANCELLED",
      status: "cancelled",
      executionPolicy: twoStagePolicy(cxA, cxB),
      executionState: { completedStageIds: [cxA], skippedStageIds: [] },
      completedAt: null,
      createdByAgentId: agent.id,
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: cancelled.id,
      stageId: cxA,
      stageType: "review",
      actorUserId: "board-user",
      outcome: "approved",
      body: "cancelled-A-verdict",
      createdAt: new Date("2026-09-05T02:00:00Z"),
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: cancelled.id,
      stageId: cxB,
      stageType: "approval",
      actorUserId: "board-user",
      outcome: "approved",
      body: "cancelled-B-verdict",
      createdAt: new Date("2026-09-05T02:18:44Z"),
    });

    // A live card with no decision has no ladder to audit -> not admitted.
    const noDecisionStage = randomUUID();
    await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Live card, never decided",
      identifier: "SIA-LIVE-NODEC",
      status: "in_review",
      executionPolicy: reviewPolicy(noDecisionStage),
      executionState: { completedStageIds: [], skippedStageIds: [] },
      completedAt: null,
      createdByAgentId: agent.id,
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/companies/${company.id}/audit/stage-integrity`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const identifiers = new Set(res.body.map((row: { identifier: string }) => row.identifier));
    // in_review and blocked ladders are now admitted...
    expect(identifiers.has("SIA-LIVE-REVIEW")).toBe(true);
    expect(identifiers.has("SIA-LIVE-BLOCKED")).toBe(true);
    // ...a cancelled card is still excluded...
    expect(identifiers.has("SIA-CANCELLED")).toBe(false);
    // ...and a live card that never decided anything is not admitted.
    expect(identifiers.has("SIA-LIVE-NODEC")).toBe(false);
    // ...and a live card with a non-approving verdict and an empty ladder is
    // admitted but produces no finding (no close-presupposing false positive).
    expect(identifiers.has("SIA-LIVE-PARKED")).toBe(false);

    const reviewRow = res.body.find((row: { identifier: string }) => row.identifier === "SIA-LIVE-REVIEW");
    expect(reviewRow?.reason).toBe("guard-b:decision-without-completed-stage");
    const blockedRow = res.body.find((row: { identifier: string }) => row.identifier === "SIA-LIVE-BLOCKED");
    // Round-1 fix: a live (blocked) card with an orphaned approved verdict is
    // flagged by the inverse guard, not the terminal-only no-completed-stage.
    expect(blockedRow?.reason).toBe("guard-b:decision-without-completed-stage");
  });

  it("replays the live SUP-15120 orphan (decision f643c6e6 / stage 17763832) and flags it with the inverse reason", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");

    // The exact live ids from the defect (TEA-Core/paperclip, SUP-15120 / 838433b7).
    // At the moment the ticket observed it, stage 17763832 held a durable approved
    // verdict (decision f643c6e6) but the completion projection had NOT advanced
    // completedStageIds past 5d2dc845 — an orphaned decision. The card was live
    // (in_review), which the widened selector now admits.
    const STAGE_5D2D = "5d2dc845-fa9d-4bf9-9e47-c4a3d4300c30";
    const STAGE_1776 = "17763832-ec0f-415b-9e01-99ed991e9487";
    const STAGE_A85E = "a85e93d4-5a36-4a08-b4e9-9c84d5e1d9cd";
    const STAGE_1FDC = "1fdc01b8-c9b0-456f-a57c-c1396367a4da";
    const ISSUE_15120 = "838433b7-b66f-46f2-8d57-28591ef397e1";
    const DECISION_F643 = "f643c6e6-c4de-4a6e-bc37-efdc6e5bf156";

    const policy = {
      mode: "normal",
      commentRequired: true,
      returnAssigneeAgentId: "14293690-7ce0-456d-88c7-86b35a08c059",
      stages: [STAGE_5D2D, STAGE_1776, STAGE_A85E, STAGE_1FDC].map((id) => ({
        id,
        type: "approval",
        participants: [],
        approvalsNeeded: 1,
      })),
    };

    await db.insert(issues).values({
      id: ISSUE_15120,
      companyId: company.id,
      projectId: project.id,
      parentId: null,
      title: "Repro: SUP-15120 orphan replay",
      identifier: "SUP-15120",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: null,
      responsibleUserId: "board-user",
      executionPolicy: policy,
      executionState: { completedStageIds: [STAGE_5D2D], skippedStageIds: [] },
      completedAt: null,
      createdByAgentId: agent.id,
    });

    // 5d2dc845 is completed AND decided (clean) — its verdict is by an agent that
    // is NOT the return assignee (14293690...), so the return-assignee guard does
    // not fire. The scratch company's own agent is used for the FK.
    await db.insert(issueExecutionDecisions).values({
      id: "8dd2e5c6-6567-40f8-bdfd-5cd57a997eee",
      companyId: company.id,
      issueId: ISSUE_15120,
      stageId: STAGE_5D2D,
      stageType: "approval",
      actorAgentId: agent.id,
      actorUserId: null,
      outcome: "approved",
      body: "repro-5d2d-verdict",
      createdByRunId: null,
      createdAt: new Date("2026-09-06T04:15:06.268Z"),
    });
    // 17763832: the durable approved verdict the projection dropped (the orphan).
    await db.insert(issueExecutionDecisions).values({
      id: DECISION_F643,
      companyId: company.id,
      issueId: ISSUE_15120,
      stageId: STAGE_1776,
      stageType: "approval",
      actorAgentId: agent.id,
      actorUserId: null,
      outcome: "approved",
      body: "repro-1776-verdict",
      createdByRunId: null,
      createdAt: new Date("2026-09-06T04:18:44.968Z"),
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/companies/${company.id}/audit/stage-integrity`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = res.body.find((r: { identifier: string }) => r.identifier === "SUP-15120");
    expect(row, JSON.stringify(res.body)).toBeDefined();
    expect(row?.reason).toBe("guard-b:decision-without-completed-stage");
    // Cite the live decision id, its stage, and its decision timestamp.
    expect(row?.id).toBe(ISSUE_15120);
    expect(row?.detail).toContain(DECISION_F643);
    expect(row?.detail).toContain(STAGE_1776);
    expect(row?.detail).toContain("2026-09-06T04:18:44.968Z");
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
