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
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { reportUnexpectedRouteError } from "./helpers/report-unexpected-route-error.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres implicit-collision tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * The write-path guard has to resolve the return assignee the way the RUNTIME does.
 *
 * `resolveReturnAssignee()` seeds the excluded principal from the issue's own assignee
 * when the policy declares no `returnAssigneeAgentId` — and that is the MAJORITY shape:
 * 33 of the 40 collisions measured on 2026-08-19 declared nothing. A guard keyed on the
 * declared field alone lets every one of them through, and with `allowSelfAsFallback`
 * gone they no longer self-approve, they 422 at stage advance instead. That is the
 * SUP-10602 deadlock re-opened for the common case.
 *
 * These are ROUTE tests on purpose. The unit tests prove the predicate; only a route
 * test proves the assignee is actually WIRED from the request body into the guard, which
 * is the half that was missing.
 */
describeEmbeddedPostgres("execution policy — implicit return-assignee collision at the write path", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousSchedulingSuppression: string | undefined;

  beforeAll(async () => {
    // Suppress heartbeat dispatch for the lifetime of this suite.
    //
    // Most embedded-Postgres suites do not need this and do not set it -- they
    // never seed anything the scheduler will pick up. The handful that do seed
    // dispatchable work (done-transition-guard-decision-routes,
    // activity-log-best-effort-routes) all set it. This suite seeds companies,
    // agents and assigned issues, so it belongs in the second group and was
    // missing it.
    //
    // These are route tests: they drive the write path and assert on responses.
    // They inject a heartbeat stub for the wake calls the routes make directly,
    // but that stub does not reach the SCHEDULER. Left dispatching, the real
    // service picks the seeded issues up, and executeRun keeps issuing queries
    // (wakeups, environment-lease release, run bookkeeping) after the last
    // assertion has returned.
    //
    // Those queries then race `tempDb.cleanup()`. The failure does not look like
    // a failing test, because it is not one -- all five pass. The postgres driver
    // takes a queued write off setImmediate after teardown has already nulled the
    // socket:
    //
    //   TypeError: Cannot read properties of null (reading 'write')
    //     at Immediate.nextWrite (postgres/src/connection.js:255)
    //
    // That is an uncaught EXCEPTION inside the driver, not a rejection, so no
    // .catch() on any call site can absorb it. Vitest reports "Errors 1 error"
    // and exits non-zero on a suite whose tests all passed.
    //
    // The flag gates new dispatch and never cancels anything already running
    // (see getHeartbeatSchedulingSuppression), so it removes the background work
    // rather than papering over the symptom.
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-implicit-collision-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

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

  function createApp(companyId: string, membershipRole: "owner" | "viewer" = "owner") {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole, status: "active" }],
        isInstanceAdmin: false,
        source: "session",
      };
      next();
    });
    app.use("/api", issueRoutes(db, heartbeatStub));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithAgents() {
    const companyId = randomUUID();
    const closerAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    for (const [id, name] of [[closerAgentId, "exec-CTO"], [reviewerAgentId, "support-QAE"]] as const) {
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
    }
    return { companyId, closerAgentId, reviewerAgentId };
  }

  const stageGatedBy = (type: string, agentId: string) => ({
    type,
    approvalsNeeded: 1,
    participants: [{ type: "agent", agentId }],
  });

  it("refuses a create whose stage is gated solely by the issue's own assignee", async () => {
    const { companyId, closerAgentId } = await seedCompanyWithAgents();

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Self-gated close",
        status: "todo",
        assigneeAgentId: closerAgentId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [stageGatedBy("approval", closerAgentId)],
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toMatch(/gated solely by its own return assignee/);
    expect(res.body.details?.returnAssigneeSource).toBe("assigneeAgentId");
    // Board ruling 2026-10-02 (F1): caller-aware. On create nothing has run, so
    // the attach-time remedy is the one lawful payload fix and stays verbatim.
    expect(res.body.details?.ladderHasRun).toBe(false);
    expect(typeof res.body.details?.callerSeat).toBe("string");
    expect(res.body.details?.nextAction).toMatch(/^Give the stage a participant that is not the return assignee/);
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);
  });

  it("accepts a board create with record-only delivery", async () => {
    const { companyId, closerAgentId } = await seedCompanyWithAgents();

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Record-only board issue",
        status: "todo",
        assigneeAgentId: closerAgentId,
        deliveryRequirement: "record_only",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.deliveryRequirement).toBe("record_only");
  });

  // SUP-22098: a project default exists so these tests prove the collision —
  // before the fix an explicit `stages: []` collapsed to null at the route and
  // the default injected a review ladder the caller expressly declined
  // (SUP-22093).
  async function seedProjectWithDefaultPolicy(companyId: string, reviewerAgentId: string) {
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Default-injecting project",
      status: "in_progress",
      defaultExecutionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [stageGatedBy("review", reviewerAgentId)],
      } as unknown as Record<string, unknown>,
    });
    return projectId;
  }

  it("persists an explicit empty executionPolicy.stages on a record-only public create", async () => {
    const { companyId, closerAgentId, reviewerAgentId } = await seedCompanyWithAgents();
    const projectId = await seedProjectWithDefaultPolicy(companyId, reviewerAgentId);

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "No ladder, on purpose",
        status: "todo",
        assigneeAgentId: closerAgentId,
        projectId,
        deliveryRequirement: "record_only",
        executionPolicy: { mode: "normal", commentRequired: true, stages: [] },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.deliveryRequirement).toBe("record_only");
    expect(res.body.executionPolicy).toMatchObject({ mode: "normal", stages: [] });

    const stored = await db.select().from(issues).where(eq(issues.id, res.body.id));
    const storedPolicy = stored[0]?.executionPolicy as { stages?: unknown[] } | null;
    expect(storedPolicy).toMatchObject({ mode: "normal" });
    expect(storedPolicy?.stages).toEqual([]);
  });

  it("still injects the project default executionPolicy when the create omits one", async () => {
    const { companyId, closerAgentId, reviewerAgentId } = await seedCompanyWithAgents();
    const projectId = await seedProjectWithDefaultPolicy(companyId, reviewerAgentId);

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Omitted policy inherits the default",
        status: "todo",
        assigneeAgentId: closerAgentId,
        projectId,
        deliveryRequirement: "record_only",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.executionPolicy?.stages).toEqual([
      expect.objectContaining({
        type: "review",
        participants: [expect.objectContaining({ type: "agent", agentId: reviewerAgentId })],
      }),
    ]);

    const stored = await db.select().from(issues).where(eq(issues.id, res.body.id));
    const storedPolicy = stored[0]?.executionPolicy as { stages?: { participants?: { agentId?: string }[] }[] } | null;
    expect(storedPolicy?.stages?.[0]?.participants?.[0]?.agentId).toBe(reviewerAgentId);
  });

  it("inherits the project default when executionPolicy omits stages", async () => {
    const { companyId, closerAgentId, reviewerAgentId } = await seedCompanyWithAgents();
    const projectId = await seedProjectWithDefaultPolicy(companyId, reviewerAgentId);

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Partial policy inherits the default",
        status: "todo",
        assigneeAgentId: closerAgentId,
        projectId,
        deliveryRequirement: "record_only",
        executionPolicy: { mode: "normal" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.executionPolicy?.stages).toEqual([
      expect.objectContaining({
        type: "review",
        participants: [expect.objectContaining({ type: "agent", agentId: reviewerAgentId })],
      }),
    ]);
  });

  it("accepts a board PATCH that changes delivery classification", async () => {
    const { companyId, closerAgentId } = await seedCompanyWithAgents();
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Classifiable issue", status: "todo", assigneeAgentId: closerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const patched = await request(createApp(companyId))
      .patch(`/api/issues/${created.body.id}`)
      .send({ deliveryRequirement: "record_only" });

    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.deliveryRequirement).toBe("record_only");
  });

  it("allows an assigned agent to update an issue that is already record-only", async () => {
    const { companyId, closerAgentId } = await seedCompanyWithAgents();
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Already record-only",
        status: "todo",
        assigneeAgentId: closerAgentId,
        deliveryRequirement: "record_only",
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const runId = randomUUID();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: closerAgentId,
        companyId,
        companyIds: [companyId],
        memberships: [],
        isInstanceAdmin: false,
        source: "session",
        runId,
      };
      next();
    });
    app.use("/api", issueRoutes(db, heartbeatStub));
    app.use(reportUnexpectedRouteError("issue-execution-policy-implicit-collision-routes"));
    app.use(errorHandler);

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: closerAgentId,
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId: created.body.id },
    });
    const patched = await request(app)
      .patch(`/api/issues/${created.body.id}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ description: "Updated by assigned agent" });

    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.description).toBe("Updated by assigned agent");
  });

  it("rejects an assigned agent selecting record-only delivery", async () => {
    const { companyId, closerAgentId } = await seedCompanyWithAgents();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: closerAgentId,
        companyId,
        companyIds: [companyId],
        memberships: [],
        isInstanceAdmin: false,
        source: "session",
      };
      next();
    });
    app.use("/api", issueRoutes(db, heartbeatStub));
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Agent record-only issue",
        assigneeAgentId: closerAgentId,
        deliveryRequirement: "record_only",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toMatch(/authorized non-assignee/);
  });

  it("accepts an authorized non-assignee agent selecting record-only delivery", async () => {
    const { companyId, closerAgentId, reviewerAgentId } = await seedCompanyWithAgents();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: reviewerAgentId,
        companyId,
        companyIds: [companyId],
        memberships: [],
        isInstanceAdmin: false,
        source: "session",
      };
      next();
    });
    app.use("/api", issueRoutes(db, heartbeatStub));
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Reviewer record-only issue",
        assigneeAgentId: closerAgentId,
        deliveryRequirement: "record_only",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.deliveryRequirement).toBe("record_only");
  });

  it("rejects an assigned agent selecting record-only while reassigning the issue", async () => {
    const { companyId, closerAgentId, reviewerAgentId } = await seedCompanyWithAgents();
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Agent reassignment bypass", status: "todo", assigneeAgentId: closerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: closerAgentId,
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId: created.body.id },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: closerAgentId,
        companyId,
        companyIds: [companyId],
        memberships: [],
        isInstanceAdmin: false,
        source: "session",
        runId,
      };
      next();
    });
    app.use("/api", issueRoutes(db, heartbeatStub));
    app.use(errorHandler);

    const patched = await request(app)
      .patch(`/api/issues/${created.body.id}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ deliveryRequirement: "record_only", assigneeAgentId: reviewerAgentId });

    expect(patched.status, JSON.stringify(patched.body)).toBe(403);
    expect(patched.body.details?.reason).toBe("record_only_self_assignee");
    expect(patched.body.error).toMatch(/authorized non-assignee/);

    const stored = await db.select().from(issues).where(eq(issues.id, created.body.id));
    expect(stored[0]?.deliveryRequirement).toBe("repository_delivery");
    expect(stored[0]?.assigneeAgentId).toBe(closerAgentId);
  });

  it("reports a distinct reason when a non-assignee lacks mutation authority", async () => {
    const { companyId, closerAgentId, reviewerAgentId } = await seedCompanyWithAgents();
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Other agent's issue", status: "todo", assigneeAgentId: closerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: reviewerAgentId,
        companyId,
        companyIds: [companyId],
        memberships: [],
        isInstanceAdmin: false,
        source: "session",
      };
      next();
    });
    app.use("/api", issueRoutes(db, heartbeatStub));
    app.use(errorHandler);

    const patched = await request(app)
      .patch(`/api/issues/${created.body.id}`)
      .send({ deliveryRequirement: "record_only" });

    expect(patched.status, JSON.stringify(patched.body)).toBe(403);
    expect(patched.body.details?.reason).toBe("record_only_not_authorized");
    const stored = await db.select().from(issues).where(eq(issues.id, created.body.id));
    expect(stored[0]?.deliveryRequirement).toBe("repository_delivery");
  });

  function createAgentApp(companyId: string, agentId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId,
        companyId,
        companyIds: [companyId],
        memberships: [],
        isInstanceAdmin: false,
        source: "session",
      };
      next();
    });
    app.use("/api", issueRoutes(db, heartbeatStub));
    app.use(errorHandler);
    return app;
  }

  it("rejects a non-assignee agent selecting record-only while assigning the issue to itself", async () => {
    const { companyId, reviewerAgentId } = await seedCompanyWithAgents();
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Human-action card", status: "todo", assigneeUserId: "board-user" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const patched = await request(createAgentApp(companyId, reviewerAgentId))
      .patch(`/api/issues/${created.body.id}`)
      .send({ deliveryRequirement: "record_only", assigneeAgentId: reviewerAgentId });

    expect(patched.status, JSON.stringify(patched.body)).toBe(403);
    expect(patched.body.details?.reason).toBe("record_only_self_assignee");

    const stored = await db.select().from(issues).where(eq(issues.id, created.body.id));
    expect(stored[0]?.deliveryRequirement).toBe("repository_delivery");
    expect(stored[0]?.assigneeAgentId).toBeNull();
    expect(stored[0]?.assigneeUserId).toBe("board-user");
  });

  it("reports the record-only reason when an org-chain ancestor selects it through the escape hatch", async () => {
    const { companyId, closerAgentId, reviewerAgentId } = await seedCompanyWithAgents();
    await db.update(agents).set({ reportsTo: reviewerAgentId }).where(eq(agents.id, closerAgentId));
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Report's issue", status: "todo", assigneeAgentId: closerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const patched = await request(createAgentApp(companyId, reviewerAgentId))
      .patch(`/api/issues/${created.body.id}`)
      .send({ deliveryRequirement: "record_only" });

    expect(patched.status, JSON.stringify(patched.body)).toBe(403);
    expect(patched.body.details?.forbiddenFields).toEqual(["deliveryRequirement"]);
    expect(patched.body.details?.reason).toBe("record_only_not_authorized");
    const stored = await db.select().from(issues).where(eq(issues.id, created.body.id));
    expect(stored[0]?.deliveryRequirement).toBe("repository_delivery");
  });

  it("allows the board assignee to select record-only delivery without reassignment", async () => {
    const { companyId } = await seedCompanyWithAgents();
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "User record-only bypass",
        status: "todo",
        assigneeUserId: "board-user",
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const patched = await request(createApp(companyId))
      .patch(`/api/issues/${created.body.id}`)
      .send({ deliveryRequirement: "record_only" });

    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.deliveryRequirement).toBe("record_only");

    const stored = await db.select().from(issues).where(eq(issues.id, created.body.id));
    expect(stored[0]?.deliveryRequirement).toBe("record_only");
    expect(stored[0]?.assigneeUserId).toBe("board-user");
  });

  it("refuses a viewer selecting record-only on their own assigned issue", async () => {
    const { companyId } = await seedCompanyWithAgents();
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Viewer-owned delivery", status: "todo", assigneeUserId: "board-user" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    await db.update(companyMemberships)
      .set({ membershipRole: "viewer" })
      .where(eq(companyMemberships.companyId, companyId));

    const patched = await request(createApp(companyId, "viewer"))
      .patch(`/api/issues/${created.body.id}`)
      .send({ deliveryRequirement: "record_only" });

    expect(patched.status, JSON.stringify(patched.body)).toBe(403);
    expect(patched.body.error).toBe("Viewer access is read-only");
    expect(patched.body.details?.reason).toBe("record_only_not_authorized");
    const stored = await db.select().from(issues).where(eq(issues.id, created.body.id));
    expect(stored[0]?.deliveryRequirement).toBe("repository_delivery");
    expect(stored[0]?.assigneeUserId).toBe("board-user");
  });

  it("repairs a drifted pending review stage when the board classifies delivery", async () => {
    const { companyId, reviewerAgentId } = await seedCompanyWithAgents();
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Pending human-action review",
        status: "todo",
        assigneeUserId: "board-user",
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [stageGatedBy("review", reviewerAgentId)],
        },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const stageId = created.body.executionPolicy.stages[0].id as string;
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
        returnAssignee: { type: "user", agentId: null, userId: "board-user" },
        completedStageIds: [],
        skippedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, created.body.id));

    const patched = await request(createApp(companyId))
      .patch(`/api/issues/${created.body.id}`)
      .send({ deliveryRequirement: "record_only" });

    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body).toMatchObject({
      deliveryRequirement: "record_only",
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      assigneeUserId: null,
      executionState: { status: "pending", currentStageId: stageId },
    });
    const stored = await db.select().from(issues).where(eq(issues.id, created.body.id));
    expect(stored[0]).toMatchObject({
      deliveryRequirement: "record_only",
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      assigneeUserId: null,
    });
  });

  it("accepts a create where the assignee is not the sole participant", async () => {
    const { companyId, closerAgentId, reviewerAgentId } = await seedCompanyWithAgents();

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Real gate",
        status: "todo",
        assigneeAgentId: closerAgentId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [stageGatedBy("review", reviewerAgentId)],
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("refuses a PATCH that writes a policy gated solely by the issue's current assignee", async () => {
    const { companyId, closerAgentId, reviewerAgentId } = await seedCompanyWithAgents();
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Drifts onto its own approver",
        status: "todo",
        assigneeAgentId: closerAgentId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [stageGatedBy("review", reviewerAgentId)],
        },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const patched = await request(createApp(companyId))
      .patch(`/api/issues/${created.body.id}`)
      .send({
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [stageGatedBy("approval", closerAgentId)],
        },
      });

    expect(patched.status, JSON.stringify(patched.body)).toBe(422);
    expect(patched.body.error).toMatch(/gated solely by its own return assignee/);
    // The stored issue's ladder never ran, so this is still the attach-time payload error.
    expect(patched.body.details?.ladderHasRun).toBe(false);
    expect(typeof patched.body.details?.callerSeat).toBe("string");
  });

  it("a board rearm on a ladder that has run keeps the payload-fix remedy (the rearm is the board's lever)", async () => {
    // Re-audit 2026-10-02: ladderHasRun is read from the stored (pre-rearm)
    // executionState, so a board rearmExecutionPolicy over a ladder that has run
    // used to be told that fixing its payload "games the gate" and to "ask the
    // board". For the board the payload fix is lawful.
    const { companyId, closerAgentId, reviewerAgentId } = await seedCompanyWithAgents();
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Board re-arms a ladder that has run",
        status: "todo",
        assigneeAgentId: closerAgentId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          returnAssigneeAgentId: closerAgentId,
          stages: [stageGatedBy("review", reviewerAgentId)],
        },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const stageId = created.body.executionPolicy.stages[0].id as string;
    await db
      .update(issues)
      .set({
        status: "in_review",
        assigneeAgentId: reviewerAgentId,
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
          returnAssignee: { type: "agent", agentId: closerAgentId, userId: null },
          completedStageIds: [],
          skippedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      })
      .where(eq(issues.id, created.body.id));

    const rearm = await request(createApp(companyId))
      .patch(`/api/issues/${created.body.id}`)
      .send({
        rearmExecutionPolicy: true,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          returnAssigneeAgentId: closerAgentId,
          stages: [stageGatedBy("approval", closerAgentId)],
        },
      });

    expect(rearm.status, JSON.stringify(rearm.body)).toBe(422);
    expect(rearm.body.error).toMatch(/gated solely by its own return assignee/);
    expect(rearm.body.details?.ladderHasRun).toBe(true);
    expect(rearm.body.details?.nextAction).toBe(
      "Give the stage a participant that is not the return assignee, or change the return assignee. Never drop the stage to make this pass.",
    );
    expect(rearm.body.error).not.toContain("seat-authority refusal");
  });

  it("accepts a PATCH that moves the assignee off the collision in the same body", async () => {
    // The guard resolves against the assignee AFTER the patch, so the repair is a single
    // request. If it keyed on the stored assignee instead, this would be unrepairable.
    const { companyId, closerAgentId, reviewerAgentId } = await seedCompanyWithAgents();
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Repairable in one PATCH",
        status: "todo",
        assigneeAgentId: closerAgentId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [stageGatedBy("review", reviewerAgentId)],
        },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const patched = await request(createApp(companyId))
      .patch(`/api/issues/${created.body.id}`)
      .send({
        assigneeAgentId: reviewerAgentId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [stageGatedBy("approval", closerAgentId)],
        },
      });

    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  });

  it("leaves a PATCH that does not touch the policy alone, so a colliding issue stays repairable", async () => {
    // ADR-073 D2: the guard must never fire on a stored policy. The ~39 issues that
    // already carry a collision have to stay mutable — refusing every PATCH to them is
    // the fleet-halt this placement exists to avoid.
    const { companyId, closerAgentId, reviewerAgentId } = await seedCompanyWithAgents();
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Already colliding",
        status: "todo",
        assigneeAgentId: reviewerAgentId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [stageGatedBy("approval", closerAgentId)],
        },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    // Drift the assignee onto the approver WITHOUT sending a policy: this is the
    // post-fire reassignment the create-time guards cannot see by construction.
    const drifted = await request(createApp(companyId))
      .patch(`/api/issues/${created.body.id}`)
      .send({ assigneeAgentId: closerAgentId });
    expect(drifted.status, JSON.stringify(drifted.body)).toBe(200);

    // And the repair PATCH still goes through.
    const repaired = await request(createApp(companyId))
      .patch(`/api/issues/${created.body.id}`)
      .send({ assigneeAgentId: reviewerAgentId, description: "repaired" });
    expect(repaired.status, JSON.stringify(repaired.body)).toBe(200);
  });
});
