import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres self-claim wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// The PATCH dispatches its wakes in a fire-and-forget task after the response
// and exposes no completion signal, so a real delay is the only way to observe
// that a wake was NOT dispatched. A dispatched assignment wake lands well
// inside this window (the positive cells wait on the same bound).
const WAKE_SETTLE_MS = 1_500;

describeEmbeddedPostgres("SUP-24209 self-claim PATCH does not dispatch a duplicate session", () => {
  let db!: Db;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let paperclipHome: string | null = null;

  beforeAll(async () => {
    paperclipHome = await mkdtemp(join(tmpdir(), "issue-self-claim-wake-home-"));
    vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
    tempDb = await startEmbeddedPostgresTestDatabase("issue-self-claim-wake-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    if (db && heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
    if (paperclipHome) await rm(paperclipHome, { recursive: true, force: true });
  });

  /**
   * The SUP-24204 shape: a timer run of the writer agent, whose context names
   * no issue, created an unassigned `todo` card. One slot per agent keeps any
   * dispatched run queued so no adapter process starts in this database.
   */
  async function seed() {
    const companyId = randomUUID();
    const writerAgentId = randomUUID();
    const peerAgentId = randomUUID();
    const writerRunId = randomUUID();
    const peerRunId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    const agentRow = (id: string, name: string) => ({
      id,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(agents).values([agentRow(writerAgentId, "Writer"), agentRow(peerAgentId, "Peer")]);
    const timerRun = (id: string, agentId: string) => ({
      id,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { wakeReason: "heartbeat_timer", source: "scheduler" },
      startedAt: new Date(),
    });
    await db.insert(heartbeatRuns).values([timerRun(writerRunId, writerAgentId), timerRun(peerRunId, peerAgentId)]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Wake audit card",
      status: "todo",
      priority: "medium",
      createdByAgentId: writerAgentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { companyId, writerAgentId, peerAgentId, writerRunId, peerRunId, issueId };
  }

  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    // These routes do not touch attachment storage.
    app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1], {}));
    app.use(errorHandler);
    return app;
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return { type: "agent", companyId, agentId, runId };
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: true,
      source: "local_implicit",
    };
  }

  async function assignmentWakes(issueId: string, agentId: string) {
    const rows = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, "issue_assigned")));
    return rows.filter((row) => (row.payload as Record<string, unknown> | null)?.issueId === issueId);
  }

  async function issueRuns(issueId: string, agentId: string) {
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    return rows.filter((row) => (row.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId);
  }

  async function expectAssignmentWake(issueId: string, agentId: string) {
    await vi.waitFor(
      async () => {
        expect(await assignmentWakes(issueId, agentId)).toHaveLength(1);
      },
      { timeout: WAKE_SETTLE_MS, interval: 50 },
    );
  }

  async function expectNoAssignmentWake(issueId: string, agentId: string) {
    await sleep(WAKE_SETTLE_MS);
    expect(await assignmentWakes(issueId, agentId)).toEqual([]);
    expect(await issueRuns(issueId, agentId)).toEqual([]);
  }

  it("does not wake a second session when the assignee's own live run claims the issue", async () => {
    const { companyId, writerAgentId, writerRunId, issueId } = await seed();
    const app = appFor(agentActor(companyId, writerAgentId, writerRunId));

    const claim = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", assigneeAgentId: writerAgentId });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);

    await expectNoAssignmentWake(issueId, writerAgentId);
    const live = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, writerAgentId), eq(heartbeatRuns.status, "running")));
    expect(live).toEqual([{ id: writerRunId }]);

    // The claiming run keeps its card: the comment and checkout that answered
    // 409 to it in SUP-24204 succeed, and the checkout is its own.
    const comment = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Audit evidence" });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    const checkout = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId: writerAgentId, expectedStatuses: ["in_progress"] });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);
    const [after] = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(after).toEqual({ checkoutRunId: writerRunId, executionRunId: writerRunId });
  });

  it("still wakes the assignee when the board claims the issue for it", async () => {
    const { companyId, writerAgentId, issueId } = await seed();

    const claim = await request(appFor(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", assigneeAgentId: writerAgentId });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);

    await expectAssignmentWake(issueId, writerAgentId);
  });

  it("still wakes a different assignee when another agent's live run assigns the issue", async () => {
    const { companyId, writerAgentId, peerAgentId, peerRunId, issueId } = await seed();

    const claim = await request(appFor(agentActor(companyId, peerAgentId, peerRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", assigneeAgentId: writerAgentId });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);

    await expectAssignmentWake(issueId, writerAgentId);
  });

  it("still wakes the assignee when its claiming run is no longer running", async () => {
    const { companyId, writerAgentId, writerRunId, issueId } = await seed();
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, writerRunId));

    const claim = await request(appFor(agentActor(companyId, writerAgentId, writerRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", assigneeAgentId: writerAgentId });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);

    await expectAssignmentWake(issueId, writerAgentId);
  });

  it("does not wake a second session when the claiming run is already scoped to this issue", async () => {
    const { companyId, writerAgentId, writerRunId, issueId } = await seed();
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_comment_mentioned" } })
      .where(eq(heartbeatRuns.id, writerRunId));

    const claim = await request(appFor(agentActor(companyId, writerAgentId, writerRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", assigneeAgentId: writerAgentId });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);

    await sleep(WAKE_SETTLE_MS);
    expect(await assignmentWakes(issueId, writerAgentId)).toEqual([]);
    expect((await issueRuns(issueId, writerAgentId)).map((run) => run.id)).toEqual([writerRunId]);
  });

  it("still wakes the assignee when its claiming run is scoped to another issue", async () => {
    // That run cannot adopt this issue (SUP-16052), so it is not the run
    // that would execute the claim.
    const { companyId, writerAgentId, writerRunId, issueId } = await seed();
    const otherIssueId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId: otherIssueId, taskId: otherIssueId, wakeReason: "issue_assigned" } })
      .where(eq(heartbeatRuns.id, writerRunId));

    const claim = await request(appFor(agentActor(companyId, writerAgentId, writerRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", assigneeAgentId: writerAgentId });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);

    await expectAssignmentWake(issueId, writerAgentId);
  });

  it("still wakes the assignee when its live run assigns itself without claiming", async () => {
    const { companyId, writerAgentId, writerRunId, issueId } = await seed();

    const assign = await request(appFor(agentActor(companyId, writerAgentId, writerRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: writerAgentId });
    expect(assign.status, JSON.stringify(assign.body)).toBe(200);

    await expectAssignmentWake(issueId, writerAgentId);
  });
});
