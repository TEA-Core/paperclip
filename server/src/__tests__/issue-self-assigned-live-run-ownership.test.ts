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
import { runningProcesses } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres self-assigned live-run ownership tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Route wakes are dispatched fire-and-forget after the response, so a real
// delay is the only way to observe that no run was started.
const WAKE_SETTLE_MS = 1_500;

// SUP-20121: a live run of an agent that created a card, or assigned a card to
// its own agent, must keep that card. No wake for the card may start a second
// run of the same agent while the author is live.
describeEmbeddedPostgres("SUP-20121 a self-assigning live run keeps its card", () => {
  let db!: Db;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let paperclipHome: string | null = null;

  beforeAll(async () => {
    paperclipHome = await mkdtemp(join(tmpdir(), "issue-self-assigned-live-run-home-"));
    vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
    tempDb = await startEmbeddedPostgresTestDatabase("issue-self-assigned-live-run-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    runningProcesses.clear();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.status, "running"));
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
   * The writer-Auditor shape: a heartbeat run of the writer agent whose context
   * names no card. The run is live in this process. One run slot per agent
   * unless a test raises it, so a dispatched run stays queued and no adapter
   * process starts.
   */
  async function seed(opts: { maxConcurrentRuns?: number } = {}) {
    const companyId = randomUUID();
    const writerAgentId = randomUUID();
    const peerAgentId = randomUUID();
    const writerRunId = randomUUID();
    const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
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
      runtimeConfig: {
        heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: opts.maxConcurrentRuns ?? 1 },
      },
      permissions: {},
    });
    await db.insert(agents).values([agentRow(writerAgentId, "Writer"), agentRow(peerAgentId, "Peer")]);
    await db.insert(heartbeatRuns).values({
      id: writerRunId,
      companyId,
      agentId: writerAgentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { wakeReason: "heartbeat_timer", source: "scheduler" },
      startedAt: new Date(),
    });
    runningProcesses.set(writerRunId, { child: {} as never, graceSec: 0, processGroupId: null });
    return { companyId, issuePrefix, writerAgentId, peerAgentId, writerRunId };
  }

  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
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

  /** Every run of `agentId` other than `excludeRunId` that names the card. */
  async function otherRunsForCard(issueId: string, agentId: string, excludeRunId: string) {
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    return rows.filter((row) =>
      row.id !== excludeRunId &&
      (row.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId,
    );
  }

  async function wakesForCard(issueId: string, agentId: string) {
    const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    return rows.filter((row) => (row.payload as Record<string, unknown> | null)?.issueId === issueId);
  }

  async function cardRow(issueId: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    return row!;
  }

  /** The author is the holder: no second run, every wake for the card waits behind it. */
  async function expectAuthorKeepsCard(issueId: string, agentId: string, authorRunId: string) {
    await vi.waitFor(
      async () => {
        const wakes = await wakesForCard(issueId, agentId);
        expect(wakes.length).toBeGreaterThan(0);
        expect(wakes.map((wake) => wake.status)).toEqual(wakes.map(() => "deferred_issue_execution"));
      },
      { timeout: WAKE_SETTLE_MS * 2, interval: 50 },
    );
    await sleep(WAKE_SETTLE_MS);
    expect(await otherRunsForCard(issueId, agentId, authorRunId)).toEqual([]);
    expect((await cardRow(issueId)).executionRunId).toBe(authorRunId);
  }

  it("create + self-assign by a live run: a later wake for the card waits behind the creator", async () => {
    const { companyId, writerAgentId, writerRunId } = await seed();
    const writer = appFor(agentActor(companyId, writerAgentId, writerRunId));

    const created = await request(writer)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Audit report", status: "in_progress", assigneeAgentId: writerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issueId = created.body.id as string;
    expect((await cardRow(issueId)).originRunId).toBe(writerRunId);

    // A board comment wakes the assignee. Before SUP-20121 this started a
    // second writer run that took the checkout from the creator.
    const comment = await request(appFor(boardActor(companyId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Please include the run ids." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);

    await expectAuthorKeepsCard(issueId, writerAgentId, writerRunId);

    // The creator keeps every write it needs on its own card.
    const ownComment = await request(writer).post(`/api/issues/${issueId}/comments`).send({ body: "Report" });
    expect(ownComment.status, JSON.stringify(ownComment.body)).toBe(201);
    const checkout = await request(writer)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId: writerAgentId, expectedStatuses: ["in_progress"] });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);
    expect(await cardRow(issueId)).toMatchObject({ checkoutRunId: writerRunId, executionRunId: writerRunId });
  });

  it("self-assign of a parked card from a run that holds no card: the assignment and monitor wakes wait behind it", async () => {
    const { companyId, issuePrefix, writerAgentId, writerRunId } = await seed();
    const issueId = randomUUID();
    const monitorDueAt = new Date(Date.now() - 60_000);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Parked behind a human answer",
      status: "blocked",
      priority: "medium",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      monitorNextCheckAt: monitorDueAt,
      monitorAttemptCount: 0,
    });
    const writer = appFor(agentActor(companyId, writerAgentId, writerRunId));

    // Park repair: assign to self, no status field.
    const assign = await request(writer).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: writerAgentId });
    expect(assign.status, JSON.stringify(assign.body)).toBe(200);
    expect(assign.body.status).toBe("blocked");

    // Wait for the assignment wake the PATCH dispatches after its response.
    await vi.waitFor(
      async () => {
        expect(await wakesForCard(issueId, writerAgentId)).not.toEqual([]);
      },
      { timeout: WAKE_SETTLE_MS * 2, interval: 50 },
    );

    // The card's own monitor is already due and fires now that it has an agent.
    await heartbeat.tickTimers(new Date());
    expect((await cardRow(issueId)).monitorLastTriggeredAt).not.toBeNull();

    await expectAuthorKeepsCard(issueId, writerAgentId, writerRunId);
    // The monitor wake joined the held assignment wake instead of a new run.
    const held = await wakesForCard(issueId, writerAgentId);
    expect(held).toHaveLength(1);
    expect(held[0]?.coalescedCount).toBe(1);
    expect((held[0]?.payload as Record<string, unknown>).monitorAttemptCount).toBe(1);
    expect((await cardRow(issueId)).status).toBe("blocked");

    // A status-preserving re-park from the assigning run still succeeds.
    const repark = await request(writer).patch(`/api/issues/${issueId}`).send({ status: "blocked" });
    expect(repark.status, JSON.stringify(repark.body)).toBe(200);

    // When the assigning run finishes, the held wake becomes a run: the
    // continuation is delivered after the author, not dropped.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, writerRunId));
    runningProcesses.delete(writerRunId);
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, writerRunId));
    await heartbeat.releaseIssueExecutionAndPromote(finished!, { suppressImmediateRecovery: true });
    expect(await otherRunsForCard(issueId, writerAgentId, writerRunId)).toHaveLength(1);
  });

  it("record_only card created unassigned, then claimed by PATCH: a later wake waits behind the claiming run", async () => {
    const { companyId, issuePrefix, writerAgentId, writerRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Audit record",
      status: "todo",
      priority: "medium",
      deliveryRequirement: "record_only",
      createdByAgentId: writerAgentId,
      originRunId: writerRunId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    const writer = appFor(agentActor(companyId, writerAgentId, writerRunId));

    const claim = await request(writer)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: writerAgentId, status: "in_progress", comment: "Audit report body" });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);

    const comment = await request(appFor(boardActor(companyId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Seen." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);

    await expectAuthorKeepsCard(issueId, writerAgentId, writerRunId);
    const ownComment = await request(writer).post(`/api/issues/${issueId}/comments`).send({ body: "Closing note" });
    expect(ownComment.status, JSON.stringify(ownComment.body)).toBe(201);
  });

  it("a queued run for the card is not started while the self-assigning run is live", async () => {
    const { companyId, issuePrefix, writerAgentId, writerRunId } = await seed({ maxConcurrentRuns: 2 });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Audit report",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: writerAgentId,
      originRunId: writerRunId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId: writerAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    await heartbeat.resumeQueuedRuns();

    const [queued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queuedRunId));
    expect(queued?.status).toBe("queued");
    expect(await cardRow(issueId)).toMatchObject({ executionRunId: writerRunId, checkoutRunId: null });
  });

  it("still starts a run for a different agent the card is handed to", async () => {
    const { companyId, writerAgentId, peerAgentId, writerRunId } = await seed();
    const created = await request(appFor(agentActor(companyId, writerAgentId, writerRunId)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Hand-off", status: "todo", assigneeAgentId: writerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issueId = created.body.id as string;

    const handoff = await request(appFor(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: peerAgentId });
    expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);

    await vi.waitFor(
      async () => {
        expect(await otherRunsForCard(issueId, peerAgentId, writerRunId)).toHaveLength(1);
      },
      { timeout: WAKE_SETTLE_MS * 2, interval: 50 },
    );
    const peerWakes = await wakesForCard(issueId, peerAgentId);
    expect(peerWakes.map((wake) => wake.status)).not.toContain("deferred_issue_execution");
  });

  it("does not make a run scoped to another issue the owner of a card it assigns to itself", async () => {
    // SUP-16052: a run launched for one issue cannot hold another, so the
    // assignment still dispatches the card's own run.
    const { companyId, issuePrefix, writerAgentId, writerRunId } = await seed();
    const otherIssueId = randomUUID();
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { issueId: otherIssueId, wakeReason: "issue_assigned" } })
      .where(eq(heartbeatRuns.id, writerRunId));
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Neighbour card",
      status: "todo",
      priority: "medium",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const assign = await request(appFor(agentActor(companyId, writerAgentId, writerRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: writerAgentId });
    expect(assign.status, JSON.stringify(assign.body)).toBe(200);

    await vi.waitFor(
      async () => {
        expect(await otherRunsForCard(issueId, writerAgentId, writerRunId)).toHaveLength(1);
      },
      { timeout: WAKE_SETTLE_MS * 2, interval: 50 },
    );
    expect((await cardRow(issueId)).executionRunId).not.toBe(writerRunId);
  });

  it("still starts a run once the self-assigning run has finished", async () => {
    const { companyId, writerAgentId, writerRunId } = await seed();
    const created = await request(appFor(agentActor(companyId, writerAgentId, writerRunId)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Follow-up", status: "todo", assigneeAgentId: writerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issueId = created.body.id as string;
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, writerRunId));
    runningProcesses.delete(writerRunId);

    const comment = await request(appFor(boardActor(companyId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Pick this up." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);

    await vi.waitFor(
      async () => {
        expect(await otherRunsForCard(issueId, writerAgentId, writerRunId)).toHaveLength(1);
      },
      { timeout: WAKE_SETTLE_MS * 2, interval: 50 },
    );
    expect((await cardRow(issueId)).executionRunId).not.toBe(writerRunId);
  });

  it("the orphaned_duplicate_run guard still refuses a real duplicate run of the same agent", async () => {
    const { companyId, writerAgentId, writerRunId } = await seed();
    const writer = appFor(agentActor(companyId, writerAgentId, writerRunId));
    const created = await request(writer)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Audit report", status: "in_progress", assigneeAgentId: writerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issueId = created.body.id as string;
    const checkout = await request(writer)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId: writerAgentId, expectedStatuses: ["in_progress"] });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);

    const duplicateRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: duplicateRunId,
      companyId,
      agentId: writerAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      startedAt: new Date(),
    });
    runningProcesses.set(duplicateRunId, { child: {} as never, graceSec: 0, processGroupId: null });

    const refused = await request(appFor(agentActor(companyId, writerAgentId, duplicateRunId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Duplicate write" });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.details?.code ?? refused.body.code).toBe("orphaned_duplicate_run");

    const own = await request(writer).post(`/api/issues/${issueId}/comments`).send({ body: "Report" });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(await cardRow(issueId)).toMatchObject({ checkoutRunId: writerRunId, executionRunId: writerRunId });
  });
});
