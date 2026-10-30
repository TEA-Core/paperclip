import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping creator-assignee PATCH route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Seeded = {
  companyId: string;
  agentId: string;
  issueId: string;
  identifier: string;
};

describeEmbeddedPostgres("creator-assignee issue PATCH route with real authorization", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let currentActor!: Express.Request["actor"];
  let previousSchedulingSuppression: string | undefined;

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = currentActor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  beforeAll(async () => {
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-creator-assignee-patch-");
    db = createDb(tempDb.connectionString);
    app = createApp();
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousSchedulingSuppression === undefined) {
      delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    } else {
      process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = previousSchedulingSuppression;
    }
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  async function seedUser(userId: string) {
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: `User ${userId}`,
      email: `${userId}@example.com`,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async function seedResponsibleMembership(companyId: string, userId: string, role: string) {
    await seedUser(userId);
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: role,
    });
  }

  async function seedCreatorAssigneeIssue(responsibleUserId: string): Promise<Seeded> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();
    const identifier = `CA${randomUUID().slice(0, 4).toUpperCase()}-1`;

    await db.insert(companies).values({
      id: companyId,
      name: "Creator Assignee Patch",
      issuePrefix: "CA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Creator Assignee",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await seedResponsibleMembership(companyId, responsibleUserId, "operator");
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier,
      title: "Creator-assignee real authorization regression",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByAgentId: agentId,
    });
    return { companyId, agentId, issueId, identifier };
  }

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

  function agentActor(
    companyId: string,
    agentId: string,
    runId: string,
    responsibleUserId: string,
    role: string,
  ): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      source: "agent_jwt",
      runId,
      onBehalfOfUserId: responsibleUserId,
      onBehalfOfMemberships: [{
        companyId,
        status: "active",
        membershipRole: role,
      }],
    };
  }

  it("allows the creator-assignee to PATCH against the real authorization service", async () => {
    const responsibleUserId = `user-${randomUUID()}`;
    const seed = await seedCreatorAssigneeIssue(responsibleUserId);
    const runId = await seedRun(seed.companyId, seed.agentId, seed.issueId);
    currentActor = agentActor(seed.companyId, seed.agentId, runId, responsibleUserId, "operator");

    const res = await request(app)
      .patch(`/api/issues/${seed.identifier}`)
      .send({ priority: "low" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: seed.issueId,
      priority: "low",
      assigneeAgentId: seed.agentId,
      createdByAgentId: seed.agentId,
    });
    const [persisted] = await db.select({ priority: issues.priority })
      .from(issues)
      .where(eq(issues.id, seed.issueId));
    expect(persisted?.priority).toBe("low");
  });

  it("names the responsible-user ceiling when the ceiling denies the creator-assignee", async () => {
    const responsibleUserId = `user-${randomUUID()}`;
    const seed = await seedCreatorAssigneeIssue(responsibleUserId);
    await db.update(companyMemberships)
      .set({ membershipRole: "viewer" })
      .where(eq(companyMemberships.principalId, responsibleUserId));
    const runId = await seedRun(seed.companyId, seed.agentId, seed.issueId);
    currentActor = agentActor(seed.companyId, seed.agentId, runId, responsibleUserId, "viewer");

    const res = await request(app)
      .patch(`/api/issues/${seed.identifier}`)
      .send({ priority: "low" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details?.code).toBe("RESPONSIBLE_USER_UNAUTHORIZED");
    expect(res.body.details?.code).not.toBe("issue_write_no_grant");
    expect(res.body.error).toContain("Responsible user");
    const [persisted] = await db.select({ priority: issues.priority })
      .from(issues)
      .where(eq(issues.id, seed.issueId));
    expect(persisted?.priority).toBe("medium");
  });
});
