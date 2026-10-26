import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { HttpError } from "../errors.js";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

function boardActor(companyId: string, userId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId,
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

describeEmbeddedPostgres("PATCH /api/issues/:id expectedUpdatedAt", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-expected-updated-at-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seed(opts: { assignee?: boolean } = {}) {
    const company = await db.insert(companies).values({
      name: "Version Company",
      issuePrefix: `V${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const agent = opts.assignee
      ? await db.insert(agents).values({
          companyId: company.id,
          name: "Assignee",
          role: "engineer",
          status: "active",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
        }).returning().then((rows) => rows[0]!)
      : null;
    const issue = await db.insert(issues).values({
      companyId: company.id,
      title: "Original title",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agent?.id ?? null,
      deliveryRequirement: "repository_delivery",
    }).returning().then((rows) => rows[0]!);
    const run = agent
      ? await db.insert(heartbeatRuns).values({
          companyId: company.id,
          agentId: agent.id,
          status: "running",
          contextSnapshot: { issueId: issue.id },
        }).returning().then((rows) => rows[0]!)
      : null;
    const userId = `board-${randomUUID()}`;
    return { company, agent, issue, run, userId };
  }

  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    return import("../routes/issues.js").then(({ issueRoutes }) => {
      app.use("/api", issueRoutes(db, {} as never));
      app.use(errorHandler);
      return app;
    });
  }

  async function wireUpdatedAt(actor: Express.Request["actor"], issueId: string) {
    const app = await appFor(actor);
    const res = await request(app).get(`/api/issues/${issueId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(typeof res.body.updatedAt).toBe("string");
    return res.body.updatedAt as string;
  }

  async function storedTitle(issueId: string) {
    const row = await db.select({
      title: issues.title,
      priority: issues.priority,
      deliveryRequirement: issues.deliveryRequirement,
      updatedAt: issues.updatedAt,
    }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    return row;
  }

  it("rejects a stale expectedUpdatedAt with 409 and writes nothing", async () => {
    const { company, issue, userId } = await seed();
    const actor = boardActor(company.id, userId);
    const seen = await wireUpdatedAt(actor, issue.id);
    await db.update(issues).set({
      title: "Changed by someone else",
      updatedAt: new Date("2024-02-02T00:00:00.000Z"),
    }).where(eq(issues.id, issue.id));

    const res = await request(await appFor(actor))
      .patch(`/api/issues/${issue.id}`)
      .send({ title: "Must not land", comment: "Must not land", expectedUpdatedAt: seen });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe("issue_version_conflict");
    expect(res.body.details).toMatchObject({
      code: "issue_version_conflict",
      updatedAt: "2024-02-02T00:00:00.000Z",
    });
    expect(await storedTitle(issue.id)).toMatchObject({ title: "Changed by someone else" });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toEqual([]);
  });

  it("accepts a fresh expectedUpdatedAt from the issue read", async () => {
    const { company, issue, userId } = await seed();
    const actor = boardActor(company.id, userId);
    const seen = await wireUpdatedAt(actor, issue.id);

    const res = await request(await appFor(actor))
      .patch(`/api/issues/${issue.id}`)
      .send({ title: "Fresh write", expectedUpdatedAt: seen });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe("Fresh write");
    expect(await storedTitle(issue.id)).toMatchObject({ title: "Fresh write" });
  });

  it("keeps an absent expectedUpdatedAt unconditional", async () => {
    const { company, issue, userId } = await seed();
    const actor = boardActor(company.id, userId);
    const app = await appFor(actor);
    const first = await request(app).patch(`/api/issues/${issue.id}`).send({ title: "First" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await request(app).patch(`/api/issues/${issue.id}`).send({ title: "Second" });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(await storedTitle(issue.id)).toMatchObject({ title: "Second" });
  });

  it("lets an assignee agent use a fresh token and still refuses record_only", async () => {
    const { company, agent, issue, run } = await seed({ assignee: true });
    const actor: Express.Request["actor"] = {
      type: "agent",
      agentId: agent!.id,
      companyId: company.id,
      runId: run!.id,
      source: "agent_jwt",
    };
    const seen = await wireUpdatedAt(actor, issue.id);
    const app = await appFor(actor);

    const fresh = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ priority: "high", expectedUpdatedAt: seen });
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body.priority).toBe("high");

    const current = fresh.body.updatedAt as string;
    const denied = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ deliveryRequirement: "record_only", expectedUpdatedAt: current });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(await storedTitle(issue.id)).toMatchObject({
      deliveryRequirement: "repository_delivery",
      priority: "high",
    });
  });

  it("lets a non-assignee board user set record_only with a fresh token", async () => {
    const { company, issue, userId } = await seed();
    const actor = boardActor(company.id, userId);
    const seen = await wireUpdatedAt(actor, issue.id);
    const res = await request(await appFor(actor))
      .patch(`/api/issues/${issue.id}`)
      .send({ deliveryRequirement: "record_only", expectedUpdatedAt: seen });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await storedTitle(issue.id)).toMatchObject({ deliveryRequirement: "record_only" });
  });

  it("rejects a non-timestamp expectedUpdatedAt before any write", async () => {
    const { company, issue, userId } = await seed();
    const res = await request(await appFor(boardActor(company.id, userId)))
      .patch(`/api/issues/${issue.id}`)
      .send({ title: "Nope", expectedUpdatedAt: "not-a-timestamp" });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(await storedTitle(issue.id)).toMatchObject({ title: "Original title" });
  });

  it("produces exactly one success for two concurrent patches with the same expected value", async () => {
    const { company, issue, userId } = await seed();
    const actor = boardActor(company.id, userId);
    const seen = await wireUpdatedAt(actor, issue.id);
    const app = await appFor(actor);
    const [left, right] = await Promise.all([
      request(app).patch(`/api/issues/${issue.id}`).send({ title: "Left", expectedUpdatedAt: seen }),
      request(app).patch(`/api/issues/${issue.id}`).send({ title: "Right", expectedUpdatedAt: seen }),
    ]);
    const statuses = [left.status, right.status].sort();
    expect(statuses, JSON.stringify({ left: left.body, right: right.body })).toEqual([200, 409]);
    const winner = left.status === 200 ? left : right;
    const loser = left.status === 409 ? left : right;
    expect(loser.body.code).toBe("issue_version_conflict");
    const stored = await storedTitle(issue.id);
    expect(stored.title).toBe(winner.body.title);
    expect([left.body.title, right.body.title].filter((title) => title === stored.title)).toHaveLength(1);
  });

  it("fails closed in SQL when two updates share one expectedUpdatedAt", async () => {
    const { issue } = await seed();
    const expected = new Date("2020-01-01T00:00:00.000Z");
    await db.update(issues).set({ updatedAt: expected }).where(eq(issues.id, issue.id));
    const svc = issueService(db);
    const settled = await Promise.allSettled([
      svc.update(issue.id, { title: "Service left", expectedUpdatedAt: expected }),
      svc.update(issue.id, { title: "Service right", expectedUpdatedAt: expected }),
    ]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const failure = rejected[0]?.status === "rejected" ? rejected[0].reason : null;
    expect(failure).toBeInstanceOf(HttpError);
    expect(failure).toMatchObject({
      status: 409,
      details: { code: "issue_version_conflict" },
    });
    const stored = await storedTitle(issue.id);
    const winnerTitle = fulfilled[0]?.status === "fulfilled" ? fulfilled[0].value?.title : null;
    expect(stored.title).toBe(winnerTitle);
    expect(stored.title === "Service left" || stored.title === "Service right").toBe(true);
  });
});
