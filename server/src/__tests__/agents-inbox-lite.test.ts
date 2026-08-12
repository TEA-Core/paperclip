import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres inbox-lite route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agents inbox-lite", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-inbox-lite-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId: agentId,
      source: "agent_jwt",
    };
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "InboxLite",
      issuePrefix: `IL${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, agentId: string) {
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ReviewerAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }

  it("returns in_review issues where the agent is the currentParticipant of a pending review stage", async () => {
    const companyId = await seedCompany();
    const reviewerId = randomUUID();
    const assigneeId = randomUUID();
    const otherAgentId = randomUUID();
    await seedAgent(companyId, reviewerId);
    await seedAgent(companyId, assigneeId);
    await seedAgent(companyId, otherAgentId);

    const pendingReviewIssueId = randomUUID();
    const decidedReviewIssueId = randomUUID();
    const nonParticipantReviewIssueId = randomUUID();
    const assigneeTodoIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: pendingReviewIssueId,
        companyId,
        title: "Pending review for reviewer",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: assigneeId,
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentStageId: randomUUID(),
          currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
          lastDecisionId: null,
        },
      },
      {
        id: decidedReviewIssueId,
        companyId,
        title: "Decided review for reviewer",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: assigneeId,
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentStageId: randomUUID(),
          currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
          lastDecisionId: randomUUID(),
        },
      },
      {
        id: nonParticipantReviewIssueId,
        companyId,
        title: "Review for other agent",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: assigneeId,
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentStageId: randomUUID(),
          currentParticipant: { type: "agent", agentId: otherAgentId, userId: null },
          lastDecisionId: null,
        },
      },
      {
        id: assigneeTodoIssueId,
        companyId,
        title: "Assignee todo",
        status: "todo",
        priority: "medium",
        assigneeAgentId: reviewerId,
      },
    ]);

    const app = appFor(agentActor(companyId, reviewerId));
    const res = await request(app).get("/api/agents/me/inbox-lite");
    expect(res.status).toBe(200);
    const ids = new Set(res.body.map((i: { id: string }) => i.id));

    expect(ids).toEqual(new Set([pendingReviewIssueId, assigneeTodoIssueId]));
    expect(ids.has(decidedReviewIssueId)).toBe(false);
    expect(ids.has(nonParticipantReviewIssueId)).toBe(false);
  });

  it("does not return pending review issues for a non-participant agent", async () => {
    const companyId = await seedCompany();
    const reviewerId = randomUUID();
    const otherAgentId = randomUUID();
    await seedAgent(companyId, reviewerId);
    await seedAgent(companyId, otherAgentId);

    const pendingReviewIssueId = randomUUID();
    await db.insert(issues).values({
      id: pendingReviewIssueId,
      companyId,
      title: "Pending review for reviewer",
      status: "in_review",
      priority: "medium",
      executionState: {
        status: "pending",
        currentStageType: "review",
        currentStageId: randomUUID(),
        currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
        lastDecisionId: null,
      },
    });

    const app = appFor(agentActor(companyId, otherAgentId));
    const res = await request(app).get("/api/agents/me/inbox-lite");
    expect(res.status).toBe(200);
    const ids = new Set(res.body.map((i: { id: string }) => i.id));
    expect(ids.has(pendingReviewIssueId)).toBe(false);
  });

  it("deduplicates issues that are both assignee-scoped and review-participant", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();
    await seedAgent(companyId, agentId);

    const dualIssueId = randomUUID();
    await db.insert(issues).values({
      id: dualIssueId,
      companyId,
      title: "Dual role issue",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageType: "review",
        currentStageId: randomUUID(),
        currentParticipant: { type: "agent", agentId, userId: null },
        lastDecisionId: null,
      },
    });

    const app = appFor(agentActor(companyId, agentId));
    const res = await request(app).get("/api/agents/me/inbox-lite");
    expect(res.status).toBe(200);
    const ids = res.body.map((i: { id: string }) => i.id);
    expect(ids.filter((id: string) => id === dualIssueId)).toHaveLength(1);
  });
});
