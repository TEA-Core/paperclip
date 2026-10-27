import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
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
    await db.delete(agentApiKeys);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
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

  async function endDb(database: Db) {
    const client: unknown = database.$client;
    if (!client || typeof client !== "object" || !("end" in client)) return;
    const end = client.end;
    if (typeof end !== "function") return;
    await end.call(client);
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

  it("finishes two agent comment patches on a one-connection pool", async () => {
    const narrow = createDb(tempDb!.connectionString, { maxConnections: 1 });
    try {
      const { company, agent, issue, run } = await seed({ assignee: true });
      const actor: Express.Request["actor"] = {
        type: "agent",
        agentId: agent!.id,
        companyId: company.id,
        runId: run!.id,
        source: "agent_jwt",
      };
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = actor;
        next();
      });
      const { issueRoutes } = await import("../routes/issues.js");
      app.use("/api", issueRoutes(narrow, {} as never));
      app.use(errorHandler);
      const [left, right] = await Promise.all([
        request(app).patch(`/api/issues/${issue.id}`).send({ comment: "left note" }),
        request(app).patch(`/api/issues/${issue.id}`).send({ comment: "right note" }),
      ]);
      expect([left.status, right.status], JSON.stringify({ left: left.body, right: right.body })).toEqual([200, 200]);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(2);
    } finally {
      await endDb(narrow);
    }
  }, 20_000);

  it("finishes ten agent comment patches on the default pool", async () => {
    const pool = createDb(tempDb!.connectionString, { maxConnections: 10 });
    try {
      const { company, agent, issue, run } = await seed({ assignee: true });
      const actor: Express.Request["actor"] = {
        type: "agent",
        agentId: agent!.id,
        companyId: company.id,
        runId: run!.id,
        source: "agent_jwt",
      };
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = actor;
        next();
      });
      const { issueRoutes } = await import("../routes/issues.js");
      app.use("/api", issueRoutes(pool, {} as never));
      app.use(errorHandler);
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          request(app).patch(`/api/issues/${issue.id}`).send({ comment: `note ${index}` }),
        ),
      );
      expect(responses.map((res) => res.status), JSON.stringify(responses.map((res) => res.body))).toEqual(
        Array.from({ length: 10 }, () => 200),
      );
    } finally {
      await endDb(pool);
    }
  }, 30_000);

  it("does not return a comment token for fields that lost a write between the commits", async () => {
    const { createRequire } = await import("node:module");
    const requireFromDb = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
    const postgres = requireFromDb("postgres") as (url: string, options: { max: number }) => {
      listen: (channel: string, callback: (payload: string) => void) => Promise<unknown>;
      unsafe: (query: string) => Promise<unknown>;
      end: (options?: { timeout?: number }) => Promise<unknown>;
    };
    const { issue, userId, company } = await seed();
    const actor = boardActor(company.id, userId);
    const seen = await wireUpdatedAt(actor, issue.id);
    const barrierLock = 9141009;
    const listener = postgres(tempDb!.connectionString, { max: 1 });
    const locker = postgres(tempDb!.connectionString, { max: 1 });
    const fieldCommitted = (Promise as PromiseConstructor & {
      withResolvers: <T>() => { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void };
    }).withResolvers<string>();
    try {
      await locker.unsafe(`
        CREATE OR REPLACE FUNCTION paperclip_mention_barrier() RETURNS trigger AS $$
        BEGIN
          PERFORM set_config('statement_timeout', '15000', true);
          PERFORM pg_advisory_lock(${barrierLock});
          PERFORM pg_advisory_unlock(${barrierLock});
          RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;
        DROP TRIGGER IF EXISTS paperclip_mention_barrier ON issue_reference_mentions;
        CREATE TRIGGER paperclip_mention_barrier
        BEFORE DELETE ON issue_reference_mentions
        FOR EACH STATEMENT
        EXECUTE FUNCTION paperclip_mention_barrier();
        CREATE OR REPLACE FUNCTION paperclip_field_commit_notify() RETURNS trigger AS $$
        BEGIN
          IF NEW.title = 'First write' AND OLD.title IS DISTINCT FROM NEW.title THEN
            PERFORM pg_notify('paperclip_field_commit', NEW.id::text);
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        DROP TRIGGER IF EXISTS paperclip_field_commit_notify ON issues;
        CREATE TRIGGER paperclip_field_commit_notify
        AFTER UPDATE ON issues
        FOR EACH ROW
        EXECUTE FUNCTION paperclip_field_commit_notify()
      `);
      await listener.listen("paperclip_field_commit", (payload) => {
        fieldCommitted.resolve(payload);
      });
      const triggers = await locker.unsafe(`SELECT tgname FROM pg_trigger WHERE tgname IN ('paperclip_mention_barrier', 'paperclip_field_commit_notify')`);
      expect(triggers).toHaveLength(2);
      const app = await appFor(actor);
      const pending = request(app)
        .patch(`/api/issues/${issue.id}`)
        .send({ title: "First write", comment: "note", expectedUpdatedAt: seen });
      const outcome = await Promise.race([
        fieldCommitted.promise.then((id) => ({ kind: "committed" as const, id })),
        pending.then((res) => ({ kind: "response" as const, status: res.status, body: res.body })),
      ]);
      expect(outcome.kind, JSON.stringify(outcome)).toBe("committed");
      if (outcome.kind !== "committed") return;
      expect(outcome.id).toBe(issue.id);
      await db.update(issues).set({
        title: "Concurrent write",
        updatedAt: new Date(),
      }).where(eq(issues.id, issue.id));
      await locker.unsafe(`SELECT pg_advisory_unlock(${barrierLock})`);
      const res = await pending;
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const chained = await request(app)
        .patch(`/api/issues/${issue.id}`)
        .send({ title: res.body.title, expectedUpdatedAt: res.body.updatedAt });
      expect(chained.status, JSON.stringify(chained.body)).toBe(409);
      expect(chained.body.code).toBe("issue_version_conflict");
      expect((await storedTitle(issue.id)).title).toBe("Concurrent write");
    } finally {
      await locker.end({ timeout: 1 }).catch(() => undefined);
      await listener.end({ timeout: 1 }).catch(() => undefined);
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS paperclip_mention_barrier ON issue_reference_mentions;
        DROP TRIGGER IF EXISTS paperclip_field_commit_notify ON issues;
        DROP FUNCTION IF EXISTS paperclip_mention_barrier();
        DROP FUNCTION IF EXISTS paperclip_field_commit_notify()
      `)).catch(() => undefined);
    }
  }, 30_000);

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

  describe("rejects expectedUpdatedAt up front when the request has a pre-write side effect", () => {
    async function seedActiveRun() {
      const seeded = await seed({ assignee: true });
      await db.update(issues).set({
        status: "in_progress",
        executionRunId: seeded.run!.id,
        checkoutRunId: seeded.run!.id,
      }).where(eq(issues.id, seeded.issue.id));
      const actor = boardActor(seeded.company.id, seeded.userId);
      const seen = await wireUpdatedAt(actor, seeded.issue.id);
      return { ...seeded, actor, seen };
    }

    async function expectNothingPersisted(
      seeded: Awaited<ReturnType<typeof seedActiveRun>>,
      res: request.Response,
    ) {
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.code).toBe("expected_updated_at_unsupported_with_side_effects");
      const run = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, seeded.run!.id)).then((rows) => rows[0]!);
      expect(run.status).toBe("running");
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "heartbeat.cancelled"))).toEqual([]);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issue.id))).toEqual([]);
      const row = await db.select({
        updatedAt: issues.updatedAt,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      }).from(issues).where(eq(issues.id, seeded.issue.id)).then((rows) => rows[0]!);
      expect(row.updatedAt.toISOString()).toBe(seeded.seen);
      expect(row.status).toBe("in_progress");
      expect(row.assigneeAgentId).toBe(seeded.agent!.id);
    }

    it("interrupt cancel", async () => {
      const seeded = await seedActiveRun();
      const res = await request(await appFor(seeded.actor))
        .patch(`/api/issues/${seeded.issue.id}`)
        .send({ comment: "stop", interrupt: true, expectedUpdatedAt: seeded.seen });
      await expectNothingPersisted(seeded, res);
    });

    it("reassignment cancel", async () => {
      const seeded = await seedActiveRun();
      const other = await db.insert(agents).values({
        companyId: seeded.company.id,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      }).returning().then((rows) => rows[0]!);
      const res = await request(await appFor(seeded.actor))
        .patch(`/api/issues/${seeded.issue.id}`)
        .send({ assigneeAgentId: other.id, expectedUpdatedAt: seeded.seen });
      await expectNothingPersisted(seeded, res);
    });

    it("terminalization cancel", async () => {
      const seeded = await seedActiveRun();
      const res = await request(await appFor(seeded.actor))
        .patch(`/api/issues/${seeded.issue.id}`)
        .send({ status: "cancelled", expectedUpdatedAt: seeded.seen });
      await expectNothingPersisted(seeded, res);
    });

    it("still returns 409 with no write for a stale field-only token on an active-run card", async () => {
      const seeded = await seedActiveRun();
      await db.update(issues).set({ updatedAt: new Date("2024-03-03T00:00:00.000Z") })
        .where(eq(issues.id, seeded.issue.id));
      const res = await request(await appFor(seeded.actor))
        .patch(`/api/issues/${seeded.issue.id}`)
        .send({ priority: "high", expectedUpdatedAt: seeded.seen });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe("issue_version_conflict");
      expect(await storedTitle(seeded.issue.id)).toMatchObject({ priority: "medium" });
    });
  });

  describe("authorization never writes when expectedUpdatedAt is present", () => {
    async function seedStaleCheckout() {
      const seeded = await seed({ assignee: true });
      const staleRun = await db.insert(heartbeatRuns).values({
        companyId: seeded.company.id,
        agentId: seeded.agent!.id,
        status: "failed",
        contextSnapshot: { issueId: seeded.issue.id },
      }).returning().then((rows) => rows[0]!);
      await db.update(issues).set({
        status: "in_progress",
        checkoutRunId: staleRun.id,
        executionRunId: staleRun.id,
      }).where(eq(issues.id, seeded.issue.id));
      const actor: Express.Request["actor"] = {
        type: "agent",
        agentId: seeded.agent!.id,
        companyId: seeded.company.id,
        runId: seeded.run!.id,
        source: "agent_jwt",
      };
      const seen = await wireUpdatedAt(actor, seeded.issue.id);
      return { ...seeded, staleRun, actor, seen };
    }

    async function lockState(issueId: string) {
      return db.select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        updatedAt: issues.updatedAt,
        priority: issues.priority,
      }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    }

    async function adoptionActivity(issueId: string) {
      return (await db.select().from(activityLog).where(eq(activityLog.entityId, issueId)))
        .filter((row) => row.action === "issue.checkout_lock_adopted");
    }

    it("returns 409 checkout_adoption_required with no adoption, activity row or updatedAt bump", async () => {
      const seeded = await seedStaleCheckout();
      const res = await request(await appFor(seeded.actor))
        .patch(`/api/issues/${seeded.issue.id}`)
        .send({ priority: "high", expectedUpdatedAt: seeded.seen });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe("checkout_adoption_required");
      expect(res.body.details).toMatchObject({ retryable: true, updatedAt: seeded.seen });
      const state = await lockState(seeded.issue.id);
      expect(state.checkoutRunId).toBe(seeded.staleRun.id);
      expect(state.executionRunId).toBe(seeded.staleRun.id);
      expect(state.updatedAt.toISOString()).toBe(seeded.seen);
      expect(state.priority).toBe("medium");
      expect(await adoptionActivity(seeded.issue.id)).toEqual([]);
    });

    it("still adopts as before when expectedUpdatedAt is absent", async () => {
      const seeded = await seedStaleCheckout();
      const res = await request(await appFor(seeded.actor))
        .patch(`/api/issues/${seeded.issue.id}`)
        .send({ priority: "high" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const state = await lockState(seeded.issue.id);
      expect(state.checkoutRunId).toBe(seeded.run!.id);
      expect(state.priority).toBe("high");
    });

    it("succeeds on retry with the fresh token after a normal checkout", async () => {
      const seeded = await seedStaleCheckout();
      const app = await appFor(seeded.actor);
      const refused = await request(app)
        .patch(`/api/issues/${seeded.issue.id}`)
        .send({ priority: "high", expectedUpdatedAt: seeded.seen });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      const checkout = await request(app)
        .post(`/api/issues/${seeded.issue.id}/checkout`)
        .send({ agentId: seeded.agent!.id, expectedStatuses: ["in_progress"] });
      expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);
      const fresh = await wireUpdatedAt(seeded.actor, seeded.issue.id);
      const retried = await request(app)
        .patch(`/api/issues/${seeded.issue.id}`)
        .send({ priority: "high", expectedUpdatedAt: fresh });
      expect(retried.status, JSON.stringify(retried.body)).toBe(200);
      expect(retried.body.priority).toBe("high");
    });

    it("lets the lock holder write with a fresh token without adoption", async () => {
      const seeded = await seed({ assignee: true });
      await db.update(issues).set({
        status: "in_progress",
        checkoutRunId: seeded.run!.id,
        executionRunId: seeded.run!.id,
      }).where(eq(issues.id, seeded.issue.id));
      const actor: Express.Request["actor"] = {
        type: "agent",
        agentId: seeded.agent!.id,
        companyId: seeded.company.id,
        runId: seeded.run!.id,
        source: "agent_jwt",
      };
      const seen = await wireUpdatedAt(actor, seeded.issue.id);
      const res = await request(await appFor(actor))
        .patch(`/api/issues/${seeded.issue.id}`)
        .send({ priority: "high", expectedUpdatedAt: seen });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await adoptionActivity(seeded.issue.id)).toEqual([]);
    });
  });

  it("done refusal persists no audit", async () => {
    const seeded = await seed({ assignee: true });
    await db.update(issues).set({
      status: "in_progress",
      executionRunId: seeded.run!.id,
      checkoutRunId: seeded.run!.id,
    }).where(eq(issues.id, seeded.issue.id));
    const actor = boardActor(seeded.company.id, seeded.userId);
    const seen = await wireUpdatedAt(actor, seeded.issue.id);
    const res = await request(await appFor(actor))
      .patch(`/api/issues/${seeded.issue.id}`)
      .send({ status: "done", expectedUpdatedAt: seen });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe("expected_updated_at_unsupported_with_side_effects");
    const audit = await db.select().from(activityLog).where(eq(activityLog.entityId, seeded.issue.id));
    expect(audit.filter((row) => row.action === "issue.done_tier_declaration_skipped")).toEqual([]);
    const run = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.run!.id)).then((rows) => rows[0]!);
    expect(run.status).toBe("running");
    expect((await storedTitle(seeded.issue.id)).updatedAt.toISOString()).toBe(seen);
  });

  it("comment response updatedAt chains", async () => {
    const { company, issue, userId } = await seed();
    const actor = boardActor(company.id, userId);
    const seen = await wireUpdatedAt(actor, issue.id);
    const app = await appFor(actor);
    const commented = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ comment: "chain me", expectedUpdatedAt: seen });
    expect(commented.status, JSON.stringify(commented.body)).toBe(200);
    const stored = await storedTitle(issue.id);
    expect(commented.body.updatedAt).toBe(stored.updatedAt.toISOString());
    expect(commented.body.updatedAt).not.toBe(seen);
    const chained = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ title: "Chained", expectedUpdatedAt: commented.body.updatedAt });
    expect(chained.status, JSON.stringify(chained.body)).toBe(200);
    expect(chained.body.title).toBe("Chained");
  });

  it("accepts an equivalent offset", async () => {
    const { company, issue, userId } = await seed();
    await db.update(issues).set({ updatedAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(issues.id, issue.id));
    const res = await request(await appFor(boardActor(company.id, userId)))
      .patch(`/api/issues/${issue.id}`)
      .send({ title: "Offset", expectedUpdatedAt: "2020-01-01T00:00:00.000+00:00" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await storedTitle(issue.id)).toMatchObject({ title: "Offset" });
  });

  it("same millisecond bucket matches and the next millisecond does not", async () => {
    const { company, issue, userId } = await seed();
    const actor = boardActor(company.id, userId);
    await db.update(issues).set({ updatedAt: new Date("2020-01-01T00:00:00.123Z") })
      .where(eq(issues.id, issue.id));
    const sameBucket = await request(await appFor(actor))
      .patch(`/api/issues/${issue.id}`)
      .send({ title: "Bucket", expectedUpdatedAt: "2020-01-01T00:00:00.123999Z" });
    expect(sameBucket.status, JSON.stringify(sameBucket.body)).toBe(200);
    await db.update(issues).set({
      title: "Original title",
      updatedAt: new Date("2020-01-01T00:00:00.123Z"),
    }).where(eq(issues.id, issue.id));
    const nextMillisecond = await request(await appFor(actor))
      .patch(`/api/issues/${issue.id}`)
      .send({ title: "Too new", expectedUpdatedAt: "2020-01-01T00:00:00.124000Z" });
    expect(nextMillisecond.status, JSON.stringify(nextMillisecond.body)).toBe(409);
    expect(nextMillisecond.body.code).toBe("issue_version_conflict");
    expect(await storedTitle(issue.id)).toMatchObject({ title: "Original title" });
  });

  it("service rejects a future expectedUpdatedAt", async () => {
    const { issue } = await seed();
    const stored = await storedTitle(issue.id);
    const svc = issueService(db);
    await expect(svc.update(issue.id, {
      title: "Future",
      expectedUpdatedAt: new Date(stored.updatedAt.getTime() + 60_000),
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "issue_version_conflict" },
    });
    expect(await storedTitle(issue.id)).toMatchObject({ title: "Original title" });
  });

  it("produces exactly one success for five concurrent patches with the same expected value", async () => {
    const { company, issue, userId } = await seed();
    const actor = boardActor(company.id, userId);
    const seen = await wireUpdatedAt(actor, issue.id);
    const app = await appFor(actor);
    const titles = ["One", "Two", "Three", "Four", "Five"];
    const results = await Promise.all(titles.map((title) =>
      request(app).patch(`/api/issues/${issue.id}`).send({ title, expectedUpdatedAt: seen }),
    ));
    const winners = results.filter((res) => res.status === 200);
    const losers = results.filter((res) => res.status === 409);
    expect(winners, JSON.stringify(results.map((res) => res.status))).toHaveLength(1);
    expect(losers).toHaveLength(4);
    expect(losers.every((res) => res.body.code === "issue_version_conflict")).toBe(true);
    expect((await storedTitle(issue.id)).title).toBe(winners[0]!.body.title);
  });

  it("rejects null and empty expectedUpdatedAt before any write", async () => {
    const { company, issue, userId } = await seed();
    const actor = boardActor(company.id, userId);
    for (const expectedUpdatedAt of [null, ""]) {
      const res = await request(await appFor(actor))
        .patch(`/api/issues/${issue.id}`)
        .send({ title: "Nope", expectedUpdatedAt });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
    }
    expect(await storedTitle(issue.id)).toMatchObject({ title: "Original title" });
  });

  it("rejects a non-assignee agent before comparing a stale token", async () => {
    const seeded = await seed({ assignee: true });
    const other = await db.insert(agents).values({
      companyId: seeded.company.id,
      name: "Other",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning().then((rows) => rows[0]!);
    const otherRun = await db.insert(heartbeatRuns).values({
      companyId: seeded.company.id,
      agentId: other.id,
      status: "running",
      contextSnapshot: { issueId: seeded.issue.id },
    }).returning().then((rows) => rows[0]!);
    await db.update(issues).set({ updatedAt: new Date("2024-04-04T00:00:00.000Z") })
      .where(eq(issues.id, seeded.issue.id));
    const actor: Express.Request["actor"] = {
      type: "agent",
      agentId: other.id,
      companyId: seeded.company.id,
      runId: otherRun.id,
      source: "agent_jwt",
    };
    const res = await request(await appFor(actor))
      .patch(`/api/issues/${seeded.issue.id}`)
      .send({ title: "Stolen", expectedUpdatedAt: "2020-01-01T00:00:00.000Z" });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).not.toBe("issue_version_conflict");
    expect(await storedTitle(seeded.issue.id)).toMatchObject({ title: "Original title" });
  });

  it("scheduled retry comment rejects expectedUpdatedAt before cancelling the retry", async () => {
    const seeded = await seed({ assignee: true });
    const retry = await db.insert(heartbeatRuns).values({
      companyId: seeded.company.id,
      agentId: seeded.agent!.id,
      status: "scheduled_retry",
      scheduledRetryAt: new Date("2026-05-06T19:00:00.000Z"),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: { issueId: seeded.issue.id },
    }).returning().then((rows) => rows[0]!);
    await db.update(issues).set({
      status: "in_progress",
      assigneeAgentId: seeded.agent!.id,
    }).where(eq(issues.id, seeded.issue.id));
    const actor = boardActor(seeded.company.id, seeded.userId);
    const seen = await wireUpdatedAt(actor, seeded.issue.id);
    const res = await request(await appFor(actor))
      .patch(`/api/issues/${seeded.issue.id}`)
      .send({ comment: "take over", expectedUpdatedAt: seen });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe("expected_updated_at_unsupported_with_side_effects");
    const storedRetry = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retry.id)).then((rows) => rows[0]!);
    expect(storedRetry.status).toBe("scheduled_retry");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issue.id))).toEqual([]);
  });

  describe("closed isolated workspace", () => {
    async function seedClosedWorkspace() {
      const seeded = await seed();
      const project = await db.insert(projects).values({
        companyId: seeded.company.id,
        name: "Closed workspace project",
      }).returning().then((rows) => rows[0]!);
      const workspace = await db.insert(executionWorkspaces).values({
        companyId: seeded.company.id,
        projectId: project.id,
        sourceIssueId: seeded.issue.id,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Closed workspace",
        status: "archived",
        closedAt: new Date(),
      }).returning().then((rows) => rows[0]!);
      await db.update(issues).set({
        projectId: project.id,
        executionWorkspaceId: workspace.id,
      }).where(eq(issues.id, seeded.issue.id));
      const actor = boardActor(seeded.company.id, seeded.userId);
      const seen = await wireUpdatedAt(actor, seeded.issue.id);
      return { ...seeded, workspace, actor, seen };
    }

    it("rejects a comment with a token before any write, without reopening", async () => {
      const seeded = await seedClosedWorkspace();
      const res = await request(await appFor(seeded.actor))
        .patch(`/api/issues/${seeded.issue.id}`)
        .send({ title: "Changed", comment: "hello", expectedUpdatedAt: seeded.seen });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe("workspace_reopen_required");
      expect(res.body.details).toMatchObject({ updatedAt: seeded.seen });
      const row = await storedTitle(seeded.issue.id);
      expect(row.title).toBe("Original title");
      expect(row.updatedAt.toISOString()).toBe(seeded.seen);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issue.id))).toEqual([]);
      expect(await db.select().from(activityLog)).toEqual([]);
      const workspace = await db.select({ status: executionWorkspaces.status }).from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, seeded.workspace.id)).then((rows) => rows[0]!);
      expect(workspace.status).toBe("archived");
    });

    it("still allows a board field-only write with a token", async () => {
      const seeded = await seedClosedWorkspace();
      const res = await request(await appFor(seeded.actor))
        .patch(`/api/issues/${seeded.issue.id}`)
        .send({ priority: "high", expectedUpdatedAt: seeded.seen });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await storedTitle(seeded.issue.id)).priority).toBe("high");
    });
  });
});
