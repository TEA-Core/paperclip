import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueDocuments,
  issuePlanDecompositions,
  issueThreadInteractions,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution-policy seat-rule tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * Board ruling 2026-11-27: an issue's creator and assignee never hold one of
 * its reviewer or approver seats, on every write path, and an agent that
 * calls the API directly with its key cannot skip the rule. Route tests on
 * purpose: only a route test proves each write path is wired to the shared
 * validator.
 */
describeEmbeddedPostgres("execution policy seat rules on every write path", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousSchedulingSuppression: string | undefined;
  let currentActor!: Express.Request["actor"];

  const BOARD_USER = "seat-rules-board-user";

  beforeAll(async () => {
    // Seeded assigned issues are dispatchable work; keep the scheduler from
    // picking them up and racing the database teardown.
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-seat-rules-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousSchedulingSuppression === undefined) {
      delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    } else {
      process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = previousSchedulingSuppression;
    }
  });

  const heartbeatStub = {
    requestWakeup: async () => null,
    enqueueWakeup: async () => null,
    wakeup: async () => null,
  } as any;

  function app() {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = currentActor;
      next();
    });
    instance.use("/api", issueRoutes(db, heartbeatStub));
    instance.use(errorHandler);
    return instance;
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: BOARD_USER,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  /** An agent calling the API directly with its own key: no tool in between. */
  function agentKeyActor(companyId: string, agentId: string, runId?: string): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, source: "agent_key", ...(runId ? { runId } : {}) };
  }

  /** A live run for the agent anchored on the issue, which issue mutations by an agent require. */
  async function seedRun(companyId: string, agentId: string, issueId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId },
    });
    return runId;
  }

  async function seed() {
    const companyId = randomUUID();
    const executorId = randomUUID();
    const reviewerId = randomUUID();
    const approverId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: BOARD_USER,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    for (const [id, name] of [
      [executorId, "coder-BE"],
      [reviewerId, "support-CR"],
      [approverId, "exec-CTO"],
    ] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "agent",
        principalId: id,
        status: "active",
        membershipRole: "member",
        updatedAt: new Date(),
      });
    }
    currentActor = boardActor(companyId);
    return { companyId, executorId, reviewerId, approverId };
  }

  const agentStage = (type: "review" | "approval", ...agentIds: string[]) => ({
    type,
    approvalsNeeded: 1,
    participants: agentIds.map((agentId) => ({ type: "agent", agentId })),
  });
  const userStage = (type: "review" | "approval", userId: string) => ({
    type,
    approvalsNeeded: 1,
    participants: [{ type: "user", userId }],
  });
  const policy = (...stages: unknown[]) => ({ mode: "normal", commentRequired: true, stages });

  async function insertIssue(input: {
    companyId: string;
    assigneeAgentId?: string | null;
    createdByAgentId?: string | null;
    createdByUserId?: string | null;
    status?: string;
    executionPolicy?: unknown;
  }) {
    const [row] = await db.insert(issues).values({
      companyId: input.companyId,
      title: "Seat rule fixture",
      status: input.status ?? "todo",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
      createdByUserId: input.createdByUserId ?? null,
      deliveryRequirement: "record_only",
      executionPolicy: (input.executionPolicy ?? null) as Record<string, unknown> | null,
    }).returning();
    return row;
  }

  function expectSeatConflict(
    res: request.Response,
    expected: { seat: "reviewer" | "approver"; participantId: string; conflictingRole: "creator" | "assignee" },
  ) {
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe("execution_policy_seat_conflict");
    expect(res.body.details).toMatchObject({
      code: "execution_policy_seat_conflict",
      seat: expected.seat,
      participantId: expected.participantId,
      conflictingRole: expected.conflictingRole,
    });
  }

  // ---------------------------------------------------------------- create

  it("create: does not judge user seats, so the creating board user may approve", async () => {
    const { companyId, executorId } = await seed();
    const res = await request(app())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Board approves the card it filed",
        status: "todo",
        assigneeAgentId: executorId,
        deliveryRequirement: "record_only",
        executionPolicy: policy(userStage("approval", BOARD_USER)),
      });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
  });

  it("create: refuses the assignee as an approver even beside another approver", async () => {
    const { companyId, executorId, approverId } = await seed();
    const res = await request(app())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Assignee approves its own card",
        status: "todo",
        assigneeAgentId: executorId,
        deliveryRequirement: "record_only",
        executionPolicy: policy(agentStage("approval", approverId, executorId)),
      });
    expectSeatConflict(res, { seat: "approver", participantId: executorId, conflictingRole: "assignee" });
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);
  });

  it("create: refuses an inherited project default that seats the assignee", async () => {
    const { companyId, reviewerId } = await seed();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Default ladder",
      status: "in_progress",
      defaultExecutionPolicy: policy(agentStage("review", reviewerId)) as unknown as Record<string, unknown>,
    });
    const res = await request(app())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Reviewer assigned under its own default ladder",
        status: "todo",
        projectId,
        assigneeAgentId: reviewerId,
        deliveryRequirement: "record_only",
      });
    expectSeatConflict(res, { seat: "reviewer", participantId: reviewerId, conflictingRole: "assignee" });
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);
  });

  it("create: accepts a lawful policy", async () => {
    const { companyId, executorId, reviewerId, approverId } = await seed();
    const res = await request(app())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Lawful ladder",
        status: "todo",
        assigneeAgentId: executorId,
        deliveryRequirement: "record_only",
        executionPolicy: policy(agentStage("review", reviewerId), agentStage("approval", approverId)),
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.executionPolicy.stages).toHaveLength(2);
  });

  it("create: refuses an agent key that seats its own creator as reviewer", async () => {
    const { companyId, executorId } = await seed();
    currentActor = agentKeyActor(companyId, executorId);
    const res = await request(app())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Agent reviews the card it filed",
        status: "todo",
        deliveryRequirement: "record_only",
        executionPolicy: policy(agentStage("review", executorId)),
      });
    expectSeatConflict(res, { seat: "reviewer", participantId: executorId, conflictingRole: "creator" });
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);
  });

  it("create: records the creating agent from the authenticated key; a body cannot name the creator", async () => {
    const { companyId, executorId, reviewerId, approverId } = await seed();
    currentActor = agentKeyActor(companyId, executorId);

    // A body that names another agent as creator never reaches the write: the
    // create schema has no createdByAgentId, so the field is refused outright.
    const spoofedAgent = await request(app())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Spoofed creator, self-seated reviewer",
        status: "todo",
        deliveryRequirement: "record_only",
        createdByAgentId: approverId,
        executionPolicy: policy(agentStage("review", executorId)),
      });
    expect(spoofedAgent.status, JSON.stringify(spoofedAgent.body)).toBe(400);
    expect(JSON.stringify(spoofedAgent.body)).toContain("createdByAgentId");

    // A user creator named by an agent is stripped, so the self-seat is still
    // judged against the authenticated agent and refused.
    const spoofedUser = await request(app())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "User-attributed, self-seated reviewer",
        status: "todo",
        deliveryRequirement: "record_only",
        createdByUserId: BOARD_USER,
        executionPolicy: policy(agentStage("review", executorId)),
      });
    expectSeatConflict(spoofedUser, { seat: "reviewer", participantId: executorId, conflictingRole: "creator" });
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);

    // A lawful create is stored under the authenticated agent, not the body.
    const accepted = await request(app())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Lawful ladder",
        status: "todo",
        deliveryRequirement: "record_only",
        createdByUserId: BOARD_USER,
        executionPolicy: policy(agentStage("review", reviewerId)),
      });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    const [stored] = await db.select().from(issues).where(eq(issues.id, accepted.body.id));
    expect(stored.createdByAgentId).toBe(executorId);
    expect(stored.createdByUserId).toBeNull();

    // The stored creator then governs later writes: seating it is refused.
    currentActor = boardActor(companyId);
    const reseat = await request(app())
      .patch(`/api/issues/${stored.id}`)
      .send({ executionPolicy: policy(agentStage("review", reviewerId), agentStage("approval", executorId)) });
    expectSeatConflict(reseat, { seat: "approver", participantId: executorId, conflictingRole: "creator" });
  });

  // ----------------------------------------------------------- child create

  it("child create: does not judge user seats, so the creating board user may review", async () => {
    const { companyId, executorId, reviewerId } = await seed();
    const parent = await insertIssue({ companyId, createdByUserId: BOARD_USER });
    const res = await request(app())
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Child reviewed by the board user who filed it",
        status: "todo",
        assigneeAgentId: executorId,
        deliveryRequirement: "record_only",
        executionPolicy: policy(agentStage("review", reviewerId), userStage("review", BOARD_USER)),
      });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(await db.select().from(issues).where(eq(issues.parentId, parent.id))).toHaveLength(1);
  });

  it("child create: an agent key that names another creator is still judged as the creator", async () => {
    const { companyId, executorId, approverId } = await seed();
    const parent = await insertIssue({ companyId, createdByUserId: BOARD_USER, assigneeAgentId: executorId, status: "in_progress" });
    currentActor = agentKeyActor(companyId, executorId, await seedRun(companyId, executorId, parent.id));
    const res = await request(app())
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Child the agent reviews itself",
        status: "todo",
        deliveryRequirement: "record_only",
        createdByUserId: BOARD_USER,
        executionPolicy: policy(agentStage("review", executorId)),
      });
    expectSeatConflict(res, { seat: "reviewer", participantId: executorId, conflictingRole: "creator" });
    expect(await db.select().from(issues).where(eq(issues.parentId, parent.id))).toHaveLength(0);

    const spoofedAgent = await request(app())
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Child with a named creator",
        status: "todo",
        deliveryRequirement: "record_only",
        createdByAgentId: approverId,
        executionPolicy: policy(agentStage("review", executorId)),
      });
    expect(spoofedAgent.status, JSON.stringify(spoofedAgent.body)).toBe(400);
    expect(await db.select().from(issues).where(eq(issues.parentId, parent.id))).toHaveLength(0);
  });

  it("child create: accepts a lawful policy", async () => {
    const { companyId, executorId, reviewerId } = await seed();
    const parent = await insertIssue({ companyId, createdByUserId: BOARD_USER });
    const res = await request(app())
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Lawful child",
        status: "todo",
        assigneeAgentId: executorId,
        deliveryRequirement: "record_only",
        executionPolicy: policy(agentStage("review", reviewerId)),
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  // ------------------------------------------------ accepted-plan decomposition

  async function seedAcceptedPlan(companyId: string, sourceIssueId: string) {
    const planDocumentId = randomUUID();
    const acceptedPlanRevisionId = randomUUID();
    await db.insert(documents).values({
      id: planDocumentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "Plan body",
      latestRevisionId: acceptedPlanRevisionId,
      latestRevisionNumber: 1,
      createdByUserId: BOARD_USER,
      updatedByUserId: BOARD_USER,
    });
    await db.insert(documentRevisions).values({
      id: acceptedPlanRevisionId,
      companyId,
      documentId: planDocumentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "Plan body",
      createdByUserId: BOARD_USER,
    });
    await db.insert(issueDocuments).values({ companyId, issueId: sourceIssueId, documentId: planDocumentId, key: "plan" });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: sourceIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Approve this plan?",
        target: {
          type: "issue_document",
          issueId: sourceIssueId,
          documentId: planDocumentId,
          key: "plan",
          revisionId: acceptedPlanRevisionId,
          revisionNumber: 1,
        },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedAt: new Date(),
      createdByUserId: BOARD_USER,
      resolvedByUserId: BOARD_USER,
    });
    return acceptedPlanRevisionId;
  }

  it("decomposition: refuses the whole batch before any child exists when one child seats its assignee", async () => {
    const { companyId, executorId, reviewerId } = await seed();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Default ladder",
      status: "in_progress",
      defaultExecutionPolicy: policy(agentStage("review", reviewerId)) as unknown as Record<string, unknown>,
    });
    const source = await insertIssue({ companyId, assigneeAgentId: executorId, createdByUserId: BOARD_USER, status: "in_progress" });
    await db.update(issues).set({ workMode: "planning", projectId }).where(eq(issues.id, source.id));
    const acceptedPlanRevisionId = await seedAcceptedPlan(companyId, source.id);

    const res = await request(app())
      .post(`/api/issues/${source.id}/accepted-plan-decompositions`)
      .send({
        acceptedPlanRevisionId,
        children: [
          { title: "Lawful child", assigneeAgentId: executorId, deliveryRequirement: "record_only" },
          // No policy of its own: it inherits the project default, which seats its assignee.
          { title: "Reviewer works under its own ladder", assigneeAgentId: reviewerId, deliveryRequirement: "record_only" },
        ],
      });
    expectSeatConflict(res, { seat: "reviewer", participantId: reviewerId, conflictingRole: "assignee" });
    expect(await db.select().from(issues).where(eq(issues.parentId, source.id))).toHaveLength(0);
    expect(await db.select().from(issuePlanDecompositions).where(eq(issuePlanDecompositions.sourceIssueId, source.id)))
      .toHaveLength(0);
  });

  it("decomposition: refuses an explicit child policy that seats the creating agent, and accepts a lawful batch", async () => {
    const { companyId, executorId, reviewerId } = await seed();
    const source = await insertIssue({ companyId, assigneeAgentId: executorId, createdByUserId: BOARD_USER, status: "in_progress" });
    await db.update(issues).set({ workMode: "planning" }).where(eq(issues.id, source.id));
    const acceptedPlanRevisionId = await seedAcceptedPlan(companyId, source.id);

    currentActor = agentKeyActor(companyId, executorId, await seedRun(companyId, executorId, source.id));
    const refused = await request(app())
      .post(`/api/issues/${source.id}/accepted-plan-decompositions`)
      .send({
        acceptedPlanRevisionId,
        children: [{
          title: "Creating agent approves its own child",
          deliveryRequirement: "record_only",
          executionPolicy: policy(agentStage("approval", executorId)),
        }],
      });
    expectSeatConflict(refused, { seat: "approver", participantId: executorId, conflictingRole: "creator" });
    expect(await db.select().from(issues).where(eq(issues.parentId, source.id))).toHaveLength(0);
    currentActor = boardActor(companyId);

    const accepted = await request(app())
      .post(`/api/issues/${source.id}/accepted-plan-decompositions`)
      .send({
        acceptedPlanRevisionId,
        children: [{
          title: "Lawful child",
          assigneeAgentId: executorId,
          deliveryRequirement: "record_only",
          executionPolicy: policy(agentStage("review", reviewerId)),
        }],
      });
    expect(accepted.status, JSON.stringify(accepted.body)).toBeLessThan(300);
    expect(await db.select().from(issues).where(eq(issues.parentId, source.id))).toHaveLength(1);
  });

  it("decomposition: an explicitly empty child policy is judged against the default it will inherit", async () => {
    const { companyId, executorId, reviewerId } = await seed();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Default ladder",
      status: "in_progress",
      defaultExecutionPolicy: policy(agentStage("review", reviewerId)) as unknown as Record<string, unknown>,
    });
    const source = await insertIssue({ companyId, assigneeAgentId: executorId, createdByUserId: BOARD_USER, status: "in_progress" });
    await db.update(issues).set({ workMode: "planning", projectId }).where(eq(issues.id, source.id));
    const acceptedPlanRevisionId = await seedAcceptedPlan(companyId, source.id);
    const childInput = (title: string, assigneeAgentId: string, executionPolicy?: Record<string, unknown>) => ({
      title,
      assigneeAgentId,
      deliveryRequirement: "record_only" as const,
      createdByUserId: BOARD_USER,
      enforceExecutionPolicySeatRules: true,
      ...(executionPolicy ? { executionPolicy } : {}),
    });

    let error: unknown = null;
    try {
      await issueService(db).decomposeAcceptedPlan(source.id, {
        acceptedPlanRevisionId,
        actorUserId: BOARD_USER,
        children: [
          childInput("Lawful child", executorId),
          // Normalized to no policy, so create() inherits the default that seats this assignee.
          childInput("Reviewer works under its own ladder", reviewerId, { mode: "normal", stages: [] }),
        ],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      status: 422,
      details: { code: "execution_policy_seat_conflict", participantId: reviewerId, conflictingRole: "assignee" },
    });
    expect(await db.select().from(issues).where(eq(issues.parentId, source.id))).toHaveLength(0);
  });

  // ------------------------------------------------------------------ PATCH

  it("PATCH reassign: refuses moving the assignee into an existing reviewer seat", async () => {
    const { companyId, executorId, reviewerId, approverId } = await seed();
    const issue = await insertIssue({
      companyId,
      assigneeAgentId: executorId,
      createdByUserId: BOARD_USER,
      executionPolicy: policy(agentStage("review", reviewerId, approverId)),
    });
    const res = await request(app()).patch(`/api/issues/${issue.id}`).send({ assigneeAgentId: reviewerId });
    expectSeatConflict(res, { seat: "reviewer", participantId: reviewerId, conflictingRole: "assignee" });
    const [after] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(after.assigneeAgentId).toBe(executorId);
  });

  it("PATCH policy replace: refuses seating the assignee as approver", async () => {
    const { companyId, executorId, reviewerId, approverId } = await seed();
    const issue = await insertIssue({
      companyId,
      assigneeAgentId: executorId,
      createdByUserId: BOARD_USER,
      executionPolicy: policy(agentStage("review", reviewerId)),
    });
    const res = await request(app())
      .patch(`/api/issues/${issue.id}`)
      .send({ executionPolicy: policy(agentStage("review", reviewerId), agentStage("approval", approverId, executorId)) });
    expectSeatConflict(res, { seat: "approver", participantId: executorId, conflictingRole: "assignee" });
  });

  it("PATCH policy + assignee together: judges the resulting assignee", async () => {
    const { companyId, executorId, reviewerId, approverId } = await seed();
    const issue = await insertIssue({
      companyId,
      assigneeAgentId: executorId,
      createdByUserId: BOARD_USER,
      executionPolicy: policy(agentStage("review", reviewerId)),
    });
    const refused = await request(app())
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: approverId, executionPolicy: policy(agentStage("approval", approverId, reviewerId)) });
    expectSeatConflict(refused, { seat: "approver", participantId: approverId, conflictingRole: "assignee" });

    // The same body that moves the assignee OFF the seat it adds is lawful.
    const accepted = await request(app())
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: executorId, executionPolicy: policy(agentStage("approval", approverId)) });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  });

  it("PATCH policy replace: refuses seating an agent creator", async () => {
    const { companyId, executorId, reviewerId, approverId } = await seed();
    const issue = await insertIssue({
      companyId,
      assigneeAgentId: executorId,
      createdByAgentId: approverId,
      executionPolicy: policy(agentStage("review", reviewerId)),
    });
    const res = await request(app())
      .patch(`/api/issues/${issue.id}`)
      .send({ executionPolicy: policy(agentStage("review", reviewerId), agentStage("approval", approverId)) });
    expectSeatConflict(res, { seat: "approver", participantId: approverId, conflictingRole: "creator" });
  });

  it("PATCH policy replace: accepts a lawful policy", async () => {
    const { companyId, executorId, reviewerId, approverId } = await seed();
    const issue = await insertIssue({
      companyId,
      assigneeAgentId: executorId,
      createdByUserId: BOARD_USER,
      executionPolicy: policy(agentStage("review", reviewerId)),
    });
    const res = await request(app())
      .patch(`/api/issues/${issue.id}`)
      .send({ executionPolicy: policy(agentStage("review", reviewerId), agentStage("approval", approverId)) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.executionPolicy.stages).toHaveLength(2);
  });

  it("PATCH: an agent key cannot seat itself as reviewer of the card it holds", async () => {
    const { companyId, executorId, reviewerId } = await seed();
    const issue = await insertIssue({
      companyId,
      assigneeAgentId: executorId,
      createdByUserId: BOARD_USER,
      status: "in_progress",
      executionPolicy: policy(agentStage("review", reviewerId)),
    });
    currentActor = agentKeyActor(companyId, executorId, await seedRun(companyId, executorId, issue.id));
    const res = await request(app())
      .patch(`/api/issues/${issue.id}`)
      .send({ executionPolicy: policy(agentStage("review", reviewerId, executorId)) });
    expectSeatConflict(res, { seat: "reviewer", participantId: executorId, conflictingRole: "assignee" });
    const [after] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect((after.executionPolicy as { stages: unknown[] }).stages).toHaveLength(1);
  });

  it("PATCH: keeps a stored card that already breaks the rule repairable", async () => {
    const { companyId, executorId, reviewerId } = await seed();
    // A legacy row: the creator already holds the review seat. It is not
    // migrated, and a write that seats nobody new is not refused for it.
    const issue = await insertIssue({
      companyId,
      assigneeAgentId: executorId,
      createdByAgentId: reviewerId,
      executionPolicy: policy(agentStage("review", reviewerId)),
    });
    const res = await request(app())
      .patch(`/api/issues/${issue.id}`)
      .send({ title: "Retitled legacy card", executionPolicy: { mode: "normal", commentRequired: true } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("PATCH: an in_review card's seated assignee does not block a policy write", async () => {
    const { companyId, executorId, reviewerId, approverId } = await seed();
    // While a stage is active the runtime assigns the card to the seated
    // reviewer; a policy write that leaves the assignee alone is lawful.
    const issue = await insertIssue({
      companyId,
      assigneeAgentId: reviewerId,
      createdByUserId: BOARD_USER,
      status: "in_review",
      executionPolicy: { ...policy(agentStage("review", reviewerId)), returnAssigneeAgentId: executorId },
    });
    const res = await request(app())
      .patch(`/api/issues/${issue.id}`)
      .send({
        executionPolicy: {
          ...policy(agentStage("review", reviewerId), agentStage("approval", approverId)),
          returnAssigneeAgentId: executorId,
        },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.assigneeAgentId).toBe(reviewerId);
  });

  it("PATCH: a card blocked mid-review keeps its seated assignee writable, but not a reassign into another stage's seat", async () => {
    const { companyId, executorId, reviewerId, approverId } = await seed();
    const reviewStage = { id: randomUUID(), ...agentStage("review", reviewerId) };
    const issue = await insertIssue({
      companyId,
      assigneeAgentId: reviewerId,
      createdByUserId: BOARD_USER,
      status: "blocked",
      executionPolicy: { ...policy(reviewStage), returnAssigneeAgentId: executorId },
    });
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: reviewStage.id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerId },
        returnAssignee: { type: "agent", agentId: executorId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, issue.id));

    const kept = await request(app())
      .patch(`/api/issues/${issue.id}`)
      .send({ executionPolicy: { mode: "normal", commentRequired: true, returnAssigneeAgentId: executorId } });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.assigneeAgentId).toBe(reviewerId);

    // A reassign may hand the active stage to another of its participants,
    // never move the card onto a seat of another stage.
    const moved = await request(app())
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: approverId, executionPolicy: { ...policy(reviewStage, agentStage("approval", approverId)), returnAssigneeAgentId: executorId } });
    expectSeatConflict(moved, { seat: "approver", participantId: approverId, conflictingRole: "assignee" });
  });

  // --------------------------------------------------------------- checkout

  it("checkout: refuses a seated agent taking an unassigned card", async () => {
    const { companyId, reviewerId } = await seed();
    const issue = await insertIssue({
      companyId,
      createdByUserId: BOARD_USER,
      executionPolicy: policy(agentStage("review", reviewerId)),
    });
    currentActor = agentKeyActor(companyId, reviewerId, await seedRun(companyId, reviewerId, issue.id));
    const res = await request(app())
      .post(`/api/issues/${issue.id}/checkout`)
      .send({ agentId: reviewerId, expectedStatuses: ["todo"] });
    expectSeatConflict(res, { seat: "reviewer", participantId: reviewerId, conflictingRole: "assignee" });
    const [after] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(after.assigneeAgentId).toBeNull();
  });
});
