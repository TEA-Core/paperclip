import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agentWakeupRequests,
  agents,
  authUsers,
  boardApiKeys,
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
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { actorMiddleware } from "../middleware/auth.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { findLiveIssueExecutionHolder, findReleasedSilentAuthorRunId, listUnlockedIssuesWithDeferredWakesForRun } from "../services/issue-execution-lease.ts";
import { persistActivity } from "../services/activity-log.js";
import { issueService } from "../services/issues.js";

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

  function appFor(
    actor: Express.Request["actor"],
    options: Parameters<typeof issueRoutes>[2] = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1], options));
    app.use(errorHandler);
    return app;
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    // An authenticated run: an agent JWT is minted for one run.
    return { type: "agent", companyId, agentId, runId, source: "agent_jwt" };
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
    let originalWakeIds: string[] = [];
    await vi.waitFor(
      async () => {
        const wakes = await wakesForCard(issueId, agentId);
        expect(wakes.length).toBeGreaterThan(0);
        expect(wakes.map((wake) => wake.status)).toEqual(wakes.map(() => "deferred_issue_execution"));
        originalWakeIds = wakes.map((wake) => wake.id);
      },
      { timeout: WAKE_SETTLE_MS * 2, interval: 50 },
    );
    await sleep(WAKE_SETTLE_MS);
    const settledWakes = await wakesForCard(issueId, agentId);
    for (const wakeId of originalWakeIds) {
      expect(settledWakes.find((wake) => wake.id === wakeId))
        .toMatchObject({ status: "deferred_issue_execution" });
    }
    expect(await otherRunsForCard(issueId, agentId, authorRunId)).toEqual([]);
    expect((await cardRow(issueId)).executionRunId).toBe(authorRunId);
  }

  it("concurrent keyed creators preserve one held comment wake and one successor", async () => {
    const { companyId, writerAgentId, writerRunId } = await seed();
    const writer = appFor(agentActor(companyId, writerAgentId, writerRunId));
    const body = { title: "Concurrent author card", status: "in_progress", assigneeAgentId: writerAgentId, idempotencyKey: "concurrent-author" };
    const responses = await Promise.all([
      request(writer).post(`/api/companies/${companyId}/issues`).send(body),
      request(writer).post(`/api/companies/${companyId}/issues`).send(body),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(responses[0]!.body.id).toBe(responses[1]!.body.id);
    const issueId = responses[0]!.body.id as string;
    const comment = await request(appFor(boardActor(companyId))).post(`/api/issues/${issueId}/comments`).send({ body: "Follow-up." });
    expect(comment.status).toBe(201);
    await expectAuthorKeepsCard(issueId, writerAgentId, writerRunId);
    const heldWakes = await wakesForCard(issueId, writerAgentId);
    expect(heldWakes).toHaveLength(1);
    runningProcesses.delete(writerRunId);
    const [finished] = await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, writerRunId)).returning();
    await heartbeat.releaseIssueExecutionAndPromote(finished!, { suppressImmediateRecovery: true });
    await expectWakePromoted(issueId, writerAgentId, writerRunId, heldWakes[0]!.id);
  });

  it("a finish promotion racing the stale-lock sweep claims the held wake once", async () => {
    const { writerAgentId, writerRunId, issueId, wakeId } = await seedHeldCard({ authorStatus: "failed" });
    runningProcesses.delete(writerRunId);
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, writerRunId));
    await Promise.all([
      heartbeat.releaseIssueExecutionAndPromote(finished!, { suppressImmediateRecovery: true }),
      heartbeat.sweepStaleIssueLocks(),
    ]);
    await expectWakePromoted(issueId, writerAgentId, writerRunId, wakeId);
    const wakes = await wakesForCard(issueId, writerAgentId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.id).toBe(wakeId);
  });

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

  it("a second run of the same agent cannot check out a card the live author holds (R6)", async () => {
    const { companyId, writerAgentId, writerRunId } = await seed();
    const writer = appFor(agentActor(companyId, writerAgentId, writerRunId));
    const created = await request(writer)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Held checkout", status: "in_progress", assigneeAgentId: writerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issueId = created.body.id as string;
    await request(appFor(boardActor(companyId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Wake." });
    await expectAuthorKeepsCard(issueId, writerAgentId, writerRunId);

    // Base returned 200: no lock was stamped, so the second run adopted the
    // card and locked the author out. The 409 is the hold. The author's own
    // checkout stays 200 (covered above).
    const intruderRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: intruderRunId,
      companyId,
      agentId: writerAgentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId, wakeReason: "issue_comment_mentioned" },
      startedAt: new Date(),
    });
    const intruder = appFor(agentActor(companyId, writerAgentId, intruderRunId));
    const stolen = await request(intruder)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId: writerAgentId, expectedStatuses: ["in_progress", "todo"] });
    expect(stolen.status, JSON.stringify(stolen.body)).toBe(409);
    expect((await cardRow(issueId)).checkoutRunId).not.toBe(intruderRunId);
    expect((await cardRow(issueId)).executionRunId).toBe(writerRunId);
  });

  it("a hook-less release promotes a held wake on an open card and not on a closed one (J3)", async () => {
    const open = await seedHeldCard({ authorStatus: "succeeded" });
    runningProcesses.delete(open.writerRunId);
    const released = await issueService(db).release(open.issueId);
    expect(released?.status).toBe("todo");
    await expectWakePromoted(open.issueId, open.writerAgentId, open.writerRunId, open.wakeId);

    const closed = await seedHeldCard({ authorStatus: "succeeded" });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, closed.issueId));
    runningProcesses.delete(closed.writerRunId);
    const closedRelease = await issueService(db).release(closed.issueId);
    expect(closedRelease?.status).toBe("done");
    expect(await otherRunsForCard(closed.issueId, closed.writerAgentId, closed.writerRunId)).toHaveLength(0);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, closed.wakeId));
    expect(wake?.status).toBe("deferred_issue_execution");
  });

  it("a 1-slot lapse admits the promoted successor while the silent author is still running", async () => {
    const { writerAgentId, writerRunId, issueId } = await seedHeldCard({ authorStatus: "running" });
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.update(heartbeatRuns)
      .set({ startedAt: staleAt, createdAt: staleAt, lastOutputAt: null })
      .where(eq(heartbeatRuns.id, writerRunId));
    runningProcesses.delete(writerRunId);
    await db.update(agents).set({
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    }).where(eq(agents.id, writerAgentId));

    const result = await heartbeat.sweepStaleIssueLocks({ now: new Date() });
    expect(result.cleared).toBeGreaterThan(0);
    const successors = await otherRunsForCard(issueId, writerAgentId, writerRunId);
    expect(successors).toHaveLength(1);
    // The lapsed author is still status=running. It must not keep the only
    // slot, or the promoted successor stays queued behind it.
    await heartbeat.drainActiveRunExecutions();
    expect(await heartbeat.getRun(successors[0]!.id)).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, writerRunId)))[0]?.status).toBe("running");
  });

  it("an old issue-less running run that did not author a card still occupies the only slot", async () => {
    const { companyId, issuePrefix, writerAgentId, writerRunId } = await seed();
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.update(heartbeatRuns)
      .set({ startedAt: staleAt, createdAt: staleAt, lastOutputAt: null })
      .where(eq(heartbeatRuns.id, writerRunId));
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Board-assigned card behind a busy slot",
      status: "todo",
      priority: "medium",
      assigneeAgentId: writerAgentId,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });

    const woken = await heartbeat.wakeup(writerAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, source: "issue.update" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    // A silent issue-less run occupies a dispatch slot unless the sweep has
    // already released that run's own authored hold. A busy-slot fixture is
    // not an author, so the wake must stay queued.
    expect(woken?.status).toBe("queued");
    const running = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, writerAgentId), eq(heartbeatRuns.status, "running")));
    expect(running.map((row) => row.id)).toEqual([writerRunId]);
  });

  it("a chatty author with an old start still occupies the only dispatch slot (M24b)", async () => {
    const { companyId, writerAgentId, writerRunId } = await seed();
    const authoredIssueId = randomUUID();
    const otherIssueId = randomUUID();
    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await db.update(heartbeatRuns).set({ startedAt, createdAt: startedAt, lastOutputAt: new Date() })
      .where(eq(heartbeatRuns.id, writerRunId));
    await db.insert(issues).values([
      { id: authoredIssueId, companyId, title: "Active authored card", status: "todo", assigneeAgentId: writerAgentId, originRunId: writerRunId },
      { id: otherIssueId, companyId, title: "Other queued card", status: "todo", assigneeAgentId: writerAgentId },
    ]);
    const woken = await heartbeat.wakeup(writerAgentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: otherIssueId },
      contextSnapshot: { issueId: otherIssueId, source: "issue.update" },
      requestedByActorType: "user", requestedByActorId: "local-board",
    });
    expect(woken?.status).toBe("queued");
    await heartbeat.drainActiveRunExecutions();
    const otherRuns = await otherRunsForCard(otherIssueId, writerAgentId, writerRunId);
    expect(otherRuns.map((row) => row.status)).toEqual(["queued"]);
    const running = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, writerAgentId), eq(heartbeatRuns.status, "running")));
    expect(running.map((row) => row.id)).toEqual([writerRunId]);
    expect((await cardRow(otherIssueId)).executionRunId).toBeNull();
  });

  it("a silent author of a done card still occupies the only slot", async () => {
    const { companyId, issuePrefix, writerAgentId, writerRunId } = await seed();
    const doneIssueId = randomUUID();
    const otherIssueId = randomUUID();
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.update(heartbeatRuns)
      .set({ startedAt: staleAt, createdAt: staleAt, lastOutputAt: null })
      .where(eq(heartbeatRuns.id, writerRunId));
    await db.insert(issues).values([
      {
        id: doneIssueId,
        companyId,
        title: "Closed card the author created",
        status: "done",
        priority: "medium",
        assigneeAgentId: writerAgentId,
        originRunId: writerRunId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Different card",
        status: "todo",
        priority: "medium",
        assigneeAgentId: writerAgentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    const woken = await heartbeat.wakeup(writerAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: otherIssueId },
      contextSnapshot: { issueId: otherIssueId, source: "issue.update" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    // A running author still occupies its slot after the card it created is
    // done. The slot exclusion is only for an open card whose hold the sweep
    // released so that card's successor can start.
    expect(woken?.status).toBe("queued");
    const running = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, writerAgentId), eq(heartbeatRuns.status, "running")));
    expect(running.map((row) => row.id)).toEqual([writerRunId]);
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

  it.each(["issueId", "paperclipIssue.id"])("does not make a run scoped through %s to another issue the owner of a card it assigns to itself", async (scope) => {
    // SUP-16052: a run launched for one issue cannot hold another, so the
    // assignment still dispatches the card's own run.
    const { companyId, issuePrefix, writerAgentId, writerRunId } = await seed();
    const otherIssueId = randomUUID();
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: scope === "issueId"
        ? { issueId: otherIssueId, wakeReason: "issue_assigned" }
        : { paperclipIssue: { id: otherIssueId }, wakeReason: "issue_assigned" } })
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

  it("keeps an author whose legacy nested issue scope matches its card", async () => {
    const { companyId, writerRunId, issueId } = await seedHeldCard({ authorStatus: "running", stampLock: false });
    await db.update(heartbeatRuns).set({ contextSnapshot: { paperclipIssue: { id: issueId } } })
      .where(eq(heartbeatRuns.id, writerRunId));
    expect(await findLiveIssueExecutionHolder(db, companyId, issueId)).toMatchObject({ runId: writerRunId });
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

  it("an echo-assignee PATCH by a board-assigned agent does not create the hold", async () => {
    const { companyId, issuePrefix, writerAgentId, writerRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Board-assigned card",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: writerAgentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    const writer = appFor(agentActor(companyId, writerAgentId, writerRunId));

    // The assignee field is present but equal to the current assignee: the
    // PATCH changed no assignee, so it must not prove this run assigned the card.
    const echo = await request(writer).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: writerAgentId });
    expect(echo.status, JSON.stringify(echo.body)).toBe(200);

    await heartbeat.wakeup(writerAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "board_wake",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "board_wake" },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });

    await vi.waitFor(
      async () => {
        expect(await wakesForCard(issueId, writerAgentId)).not.toEqual([]);
      },
      { timeout: WAKE_SETTLE_MS * 2, interval: 50 },
    );
    await sleep(WAKE_SETTLE_MS);
    const wakes = await wakesForCard(issueId, writerAgentId);
    expect(wakes.map((wake) => wake.status)).not.toContain("deferred_issue_execution");
    expect((await cardRow(issueId)).executionRunId).not.toBe(writerRunId);
  });

  it("a silent author past the output bound does not hold the card", async () => {
    const { companyId, writerAgentId, writerRunId } = await seed();
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.update(heartbeatRuns)
      .set({ startedAt: staleAt, createdAt: staleAt, lastOutputAt: null })
      .where(eq(heartbeatRuns.id, writerRunId));
    const created = await request(appFor(agentActor(companyId, writerAgentId, writerRunId)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Stale author card", status: "in_progress", assigneeAgentId: writerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issueId = created.body.id as string;

    const comment = await request(appFor(boardActor(companyId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Board wake." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);

    await vi.waitFor(
      async () => {
        expect(await otherRunsForCard(issueId, writerAgentId, writerRunId)).toHaveLength(1);
      },
      { timeout: WAKE_SETTLE_MS * 2, interval: 50 },
    );
    expect((await cardRow(issueId)).executionRunId).not.toBe(writerRunId);
  });

  async function seedHeldCard(opts: { authorStatus: string; stampLock?: boolean }) {
    const seeded = await seed();
    const { companyId, issuePrefix, writerAgentId, writerRunId } = seeded;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Held card",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: writerAgentId,
      originRunId: writerRunId,
      executionRunId: opts.stampLock === false ? null : writerRunId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.update(heartbeatRuns)
      .set({ status: opts.authorStatus, finishedAt: opts.authorStatus === "running" ? null : new Date() })
      .where(eq(heartbeatRuns.id, writerRunId));
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId: writerAgentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      payload: { issueId },
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
    return { ...seeded, issueId, wakeId };
  }

  it("a board decision promotes the original held wake after committing the cleared lock", async () => {
    const { companyId, writerAgentId, writerRunId, peerAgentId, issueId, wakeId } =
      await seedHeldCard({ authorStatus: "succeeded" });
    runningProcesses.delete(writerRunId);
    const firstStageId = randomUUID();
    const secondStageId = randomUUID();
    const participant = { type: "agent", agentId: writerAgentId, userId: null };
    await db.update(issues).set({
      status: "in_review",
      deliveryRequirement: "record_only",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          { id: firstStageId, type: "review", approvalsNeeded: 1, participants: [participant] },
          { id: secondStageId, type: "approval", approvalsNeeded: 1, participants: [participant] },
        ],
        returnAssigneeAgentId: peerAgentId,
      },
      executionState: {
        status: "pending", currentStageId: firstStageId, currentStageIndex: 0,
        currentStageType: "review", currentParticipant: participant,
        returnAssignee: { type: "agent", agentId: peerAgentId, userId: null },
        completedStageIds: [], changesRequestedCount: 0,
        reviewRequest: null, lastDecisionId: null, lastDecisionOutcome: null, monitor: null,
      },
    }).where(eq(issues.id, issueId));
    const originalFlag = process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE;
    process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE = "true";
    try {
      const board = appFor(boardActor(companyId), {
        // An independent stage notification failure must not strand an existing
        // comment wake whose execution lock this decision already cleared.
        executionStageWakeupEnqueue: async () => { throw new Error("stage notification unavailable"); },
      });
      const response = await request(board)
        .post(`/api/issues/${issueId}/execution-stage/board-decision`)
        .send({ decision: "approved", comment: "Advance to approval.", displacementReason: "Board advances the stage for the pending reviewer." });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(await cardRow(issueId)).toMatchObject({
        executionState: { currentStageId: secondStageId },
      });
      await expectWakePromoted(issueId, writerAgentId, writerRunId, wakeId);
    } finally {
      if (originalFlag === undefined) delete process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE;
      else process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE = originalFlag;
    }
  });

  it("a locked reassignment invalidates origin proof despite an earlier echo-assignee read", async () => {
    const { companyId, issuePrefix, writerAgentId, peerAgentId, writerRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Interleaved assignment", status: "todo",
      assigneeAgentId: writerAgentId, issueNumber: 1, identifier: `${issuePrefix}-1`,
    });
    const realTransaction = db.transaction.bind(db);
    let interleaved = false;
    const transaction = vi.spyOn(db, "transaction").mockImplementation((async (work, config) => {
      if (!interleaved) {
        interleaved = true;
        // Model a legacy/import writer committing after the service pre-read.
        // No service result is mocked: PostgreSQL supplies the locked receipt.
        await db.update(issues).set({ assigneeAgentId: peerAgentId, originRunId: writerRunId })
          .where(eq(issues.id, issueId));
      }
      return realTransaction(work, config);
    }) as typeof db.transaction);
    try {
      await issueService(db).update(issueId, { assigneeAgentId: writerAgentId });
      expect(interleaved).toBe(true);
      expect(await cardRow(issueId)).toMatchObject({ assigneeAgentId: writerAgentId, originRunId: null });
      expect(await findLiveIssueExecutionHolder(db, companyId, issueId)).toBeNull();
    } finally {
      transaction.mockRestore();
    }
  });

  it("the stale-lock sweep promotes the held wake when it clears the lock", async () => {
    const { writerAgentId, writerRunId, issueId, wakeId } = await seedHeldCard({ authorStatus: "failed" });
    runningProcesses.delete(writerRunId);

    const result = await heartbeat.sweepStaleIssueLocks();
    expect(result.cleared).toBe(1);

    const successors = await otherRunsForCard(issueId, writerAgentId, writerRunId);
    expect(successors).toHaveLength(1);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(wake?.status).not.toBe("deferred_issue_execution");
    expect(wake?.runId).toBe(successors[0]!.id);
  });

  it("a promoted successor uses the card's responsible user, not the departing run's", async () => {
    const { writerRunId, issueId } = await seedHeldCard({ authorStatus: "failed" });
    await db.update(heartbeatRuns).set({ responsibleUserId: "author-user" }).where(eq(heartbeatRuns.id, writerRunId));
    await db.update(issues).set({ responsibleUserId: "card-user" }).where(eq(issues.id, issueId));
    runningProcesses.delete(writerRunId);

    const result = await heartbeat.sweepStaleIssueLocks();
    expect(result.cleared).toBe(1);
    const successors = await otherRunsForCard(issueId, (await cardRow(issueId)).assigneeAgentId!, writerRunId);
    expect(successors).toHaveLength(1);
    expect(successors[0]?.responsibleUserId).toBe("card-user");
  });

  it("fresh output after the sweep read keeps the silent author's lock", async () => {
    const { writerRunId, issueId } = await seedHeldCard({ authorStatus: "running" });
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.update(heartbeatRuns).set({
      startedAt: staleAt,
      createdAt: staleAt,
      lastOutputAt: null,
    }).where(eq(heartbeatRuns.id, writerRunId));
    runningProcesses.delete(writerRunId);
    const swept = await heartbeat.sweepStaleIssueLocks({
      now: new Date(),
      beforeSilentLockClear: async () => {
        await db.update(heartbeatRuns).set({ lastOutputAt: new Date() }).where(eq(heartbeatRuns.id, writerRunId));
      },
    });
    expect(swept.issueIds).not.toContain(issueId);
    expect((await cardRow(issueId)).executionRunId).toBe(writerRunId);
  });

  it("a released silent author is the workspace fence key, and a holder is not", async () => {
    const { writerAgentId, writerRunId, issueId } = await seedHeldCard({ authorStatus: "running" });
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.update(heartbeatRuns).set({
      startedAt: staleAt,
      createdAt: staleAt,
      lastOutputAt: null,
    }).where(eq(heartbeatRuns.id, writerRunId));
    expect(await findReleasedSilentAuthorRunId(db, writerAgentId)).toBeNull();
    runningProcesses.delete(writerRunId);
    await heartbeat.sweepStaleIssueLocks({ now: new Date() });
    expect((await cardRow(issueId)).executionRunId).not.toBe(writerRunId);
    expect(await findReleasedSilentAuthorRunId(db, writerAgentId)).toBe(writerRunId);
  });

  it("the silent-run hard-stop promotes the held wake when it clears the lock", async () => {
    const { companyId, writerAgentId, writerRunId, issueId, wakeId } = await seedHeldCard({ authorStatus: "running" });
    await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, writerAgentId));
    const startedAt = new Date(Date.now() - 91 * 60 * 1000);
    await db.update(heartbeatRuns)
      .set({ processStartedAt: startedAt, processPid: 2_000_000_000, lastOutputAt: null, startedAt })
      .where(eq(heartbeatRuns.id, writerRunId));
    runningProcesses.delete(writerRunId);

    const result = await heartbeat.scanTerminableSilentActiveRuns({ now: new Date(), companyId });
    expect(result.terminated).toBe(1);

    const successors = await otherRunsForCard(issueId, writerAgentId, writerRunId);
    expect(successors).toHaveLength(1);
    expect((await cardRow(issueId)).executionRunId).toBe(successors[0]!.id);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(wake?.status).not.toBe("deferred_issue_execution");
    expect(wake?.runId).toBe(successors[0]!.id);
  });

  async function expectWakePromoted(issueId: string, agentId: string, authorRunId: string, wakeId: string) {
    const successors = await otherRunsForCard(issueId, agentId, authorRunId);
    expect(successors).toHaveLength(1);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(wake?.status).not.toBe("deferred_issue_execution");
    expect(wake?.runId).toBe(successors[0]!.id);
  }

  it("the silent-run hard-stop promotes a held wake on a card whose lock is not stamped", async () => {
    const { companyId, writerAgentId, writerRunId, issueId, wakeId } = await seedHeldCard({ authorStatus: "running", stampLock: false });
    await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, writerAgentId));
    const startedAt = new Date(Date.now() - 91 * 60 * 1000);
    await db.update(heartbeatRuns)
      .set({ processStartedAt: startedAt, processPid: 2_000_000_000, lastOutputAt: null, startedAt })
      .where(eq(heartbeatRuns.id, writerRunId));
    runningProcesses.delete(writerRunId);
    expect((await cardRow(issueId)).executionRunId).toBeNull();

    const result = await heartbeat.scanTerminableSilentActiveRuns({ now: new Date(), companyId });
    expect(result.terminated).toBe(1);
    await expectWakePromoted(issueId, writerAgentId, writerRunId, wakeId);
  });

  it("a refused checkout that clears a terminal author's lock promotes the held wake", async () => {
    const { companyId, writerAgentId, peerAgentId, writerRunId, issueId, wakeId } = await seedHeldCard({ authorStatus: "failed" });
    runningProcesses.delete(writerRunId);
    const peerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: peerRunId,
      companyId,
      agentId: peerAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { wakeReason: "heartbeat_timer" },
      startedAt: new Date(),
    });
    runningProcesses.set(peerRunId, { child: {} as never, graceSec: 0, processGroupId: null });

    const res = await request(appFor(agentActor(companyId, peerAgentId, peerRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId: peerAgentId, expectedStatuses: ["in_progress"] });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    await expectWakePromoted(issueId, writerAgentId, writerRunId, wakeId);
  });

  it("releasing a terminal author's lock promotes the held wake", async () => {
    const { companyId, writerAgentId, writerRunId, issueId, wakeId } = await seedHeldCard({ authorStatus: "failed" });
    runningProcesses.delete(writerRunId);

    const res = await request(appFor(boardActor(companyId))).post(`/api/issues/${issueId}/release`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectWakePromoted(issueId, writerAgentId, writerRunId, wakeId);
  });

  it("an admin force-release of a terminal author's lock promotes the held wake", async () => {
    const { companyId, writerAgentId, writerRunId, issueId, wakeId } = await seedHeldCard({ authorStatus: "failed" });
    runningProcesses.delete(writerRunId);

    const res = await request(appFor(boardActor(companyId))).post(`/api/issues/${issueId}/admin/force-release`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectWakePromoted(issueId, writerAgentId, writerRunId, wakeId);
  });

  it("the stale-lock sweep lapses a stamped hold whose author has been silent past the bound", async () => {
    const { writerAgentId, writerRunId, issueId, wakeId } = await seedHeldCard({ authorStatus: "running" });
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.update(heartbeatRuns)
      .set({ startedAt: staleAt, createdAt: staleAt, lastOutputAt: null })
      .where(eq(heartbeatRuns.id, writerRunId));
    // The author still has a live in-memory handle; silence alone lapses the hold.
    expect(runningProcesses.has(writerRunId)).toBe(true);

    const result = await heartbeat.sweepStaleIssueLocks();
    expect(result.cleared).toBe(1);
    await expectWakePromoted(issueId, writerAgentId, writerRunId, wakeId);
  });

  function authApp(opts: Parameters<typeof actorMiddleware>[1]) {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, opts));
    app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1], {}));
    app.use(errorHandler);
    return app;
  }

  it("an API-key run header cannot release an adopted author hold (DOOR-release)", async () => {
    const { companyId, writerAgentId, writerRunId, issueId } = await seedHeldCard({ authorStatus: "running" });
    const token = `release-test-${randomUUID()}`;
    await db.insert(authUsers).values({
      id: "responsible-user",
      name: "Responsible",
      email: "responsible@example.com",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "responsible-user",
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(agentApiKeys).values({
      companyId,
      agentId: writerAgentId,
      name: "release-test",
      keyHash: createHash("sha256").update(token).digest("hex"),
      responsibleUserId: "responsible-user",
    });
    const rejected = await request(authApp({ deploymentMode: "authenticated", resolveSession: async () => null }))
      .post(`/api/issues/${issueId}/release`)
      .set("authorization", `Bearer ${token}`)
      .set("x-paperclip-run-id", writerRunId)
      .send({});
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(403);
    expect(await cardRow(issueId)).toMatchObject({
      assigneeAgentId: writerAgentId,
      executionRunId: writerRunId,
    });

    const released = await request(appFor(agentActor(companyId, writerAgentId, writerRunId)))
      .post(`/api/issues/${issueId}/release`)
      .send({});
    expect(released.status, JSON.stringify(released.body)).toBe(200);
  });

  async function seedForgedHeaderCard() {
    const seeded = await seed();
    const { companyId, issuePrefix, writerAgentId, writerRunId } = seeded;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Forged header card",
      status: "blocked",
      priority: "medium",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { ...seeded, issueId, forgedRunId: writerRunId };
  }

  async function expectNoForgedHolder(companyId: string, issueId: string, forgedRunId: string) {
    expect(await findLiveIssueExecutionHolder(db, companyId, issueId)).toBeNull();
    // The ownership proof reads issue.updated rows; none may carry the forged run.
    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    const proofRows = rows.filter((row) => row.action === "issue.updated");
    expect(proofRows.length).toBeGreaterThan(0);
    expect(proofRows.map((row) => row.runId)).not.toContain(forgedRunId);
  }

  it("an agent API key naming another running run of the same agent does not forge the proof", async () => {
    const { companyId, writerAgentId, issueId, forgedRunId } = await seedForgedHeaderCard();
    const token = `forge-test-${randomUUID()}`;
    await db.insert(authUsers).values({
      id: "responsible-user",
      name: "Responsible",
      email: "responsible@example.com",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "responsible-user",
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(agentApiKeys).values({
      companyId,
      agentId: writerAgentId,
      name: "forge-test",
      keyHash: createHash("sha256").update(token).digest("hex"),
      responsibleUserId: "responsible-user",
    });

    const res = await request(authApp({ deploymentMode: "authenticated", resolveSession: async () => null }))
      .patch(`/api/issues/${issueId}`)
      .set("authorization", `Bearer ${token}`)
      .set("x-paperclip-run-id", forgedRunId)
      .send({ assigneeAgentId: writerAgentId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectNoForgedHolder(companyId, issueId, forgedRunId);
  });

  it("an authenticated board session naming a hung run of another agent does not forge the proof", async () => {
    const { companyId, writerAgentId, issueId, forgedRunId } = await seedForgedHeaderCard();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "operator",
    });

    const res = await request(authApp({
      deploymentMode: "authenticated",
      resolveSession: async () => ({
        session: { id: "session-1", userId: "board-user" },
        user: { id: "board-user", name: "Board", email: "board@example.com" },
      }),
    }))
      .patch(`/api/issues/${issueId}`)
      .set("x-paperclip-run-id", forgedRunId)
      .send({ assigneeAgentId: writerAgentId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectNoForgedHolder(companyId, issueId, forgedRunId);
  });

  it.each(["done", "cancelled"] as const)("a held board comment is not promoted onto a card that reaches a terminal status (%s)", async (terminalStatus) => {
    const { companyId, writerAgentId, writerRunId } = await seed();
    const writer = appFor(agentActor(companyId, writerAgentId, writerRunId));
    const created = await request(writer)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Close with held comment", status: "in_progress", assigneeAgentId: writerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issueId = created.body.id as string;

    const comment = await request(appFor(boardActor(companyId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Board follow-up." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    await expectAuthorKeepsCard(issueId, writerAgentId, writerRunId);
    const held = await wakesForCard(issueId, writerAgentId);
    expect(held).toHaveLength(1);

    // The author cancels its own card; a board user closes it (the done-tier
    // guard needs a repository fixture this suite does not build). Closing
    // must not promote the held wake: that promotion reopens the card to todo.
    // On the base the card stays closed, because no promotion path visits a
    // card the author never held by pointer or context.
    const close = terminalStatus === "done"
      ? await request(appFor(boardActor(companyId))).patch(`/api/issues/${issueId}`).send({ status: terminalStatus, comment: "Closing." })
      : await request(writer).patch(`/api/issues/${issueId}`).send({ status: terminalStatus });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    await sleep(WAKE_SETTLE_MS);

    expect((await cardRow(issueId)).status).toBe(terminalStatus);
    expect(await otherRunsForCard(issueId, writerAgentId, writerRunId)).toHaveLength(0);
    const wakes = await wakesForCard(issueId, writerAgentId);
    expect(wakes.map((wake) => wake.status)).toContain("deferred_issue_execution");
  });

  it("a held wake on a card closed outside the update route stays deferred when the author finishes", async () => {
    const { companyId, writerAgentId, writerRunId } = await seed();
    const writer = appFor(agentActor(companyId, writerAgentId, writerRunId));
    const created = await request(writer)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Closed outside route", status: "in_progress", assigneeAgentId: writerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issueId = created.body.id as string;
    const comment = await request(appFor(boardActor(companyId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Board follow-up." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    await expectAuthorKeepsCard(issueId, writerAgentId, writerRunId);

    // The card reaches done without the route update promotion (a direct write).
    // The author-finish path must not visit it: promoting the held wake would
    // reopen the closed card.
    await db.update(issues)
      .set({ status: "done", executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
      .where(eq(issues.id, issueId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, writerRunId));
    runningProcesses.delete(writerRunId);
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, writerRunId));
    await heartbeat.releaseIssueExecutionAndPromote(finished!, { suppressImmediateRecovery: true });

    expect((await cardRow(issueId)).status).toBe("done");
    expect(await otherRunsForCard(issueId, writerAgentId, writerRunId)).toHaveLength(0);
    const wakes = await wakesForCard(issueId, writerAgentId);
    expect(wakes.map((wake) => wake.status)).toContain("deferred_issue_execution");
  });

  it("a held wake is not promoted onto a board-closed card when the author finishes (J11)", async () => {
    const { companyId, writerAgentId, writerRunId } = await seed();
    const writer = appFor(agentActor(companyId, writerAgentId, writerRunId));
    const created = await request(writer)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Closed while held", status: "in_progress", assigneeAgentId: writerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issueId = created.body.id as string;
    const comment = await request(appFor(boardActor(companyId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Board follow-up." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    await expectAuthorKeepsCard(issueId, writerAgentId, writerRunId);

    // The board closes the card while the author run is still live; the
    // author then finishes. The held wake must not reopen the closed card:
    // on the base the card simply stays closed, because no promotion path
    // visits a card its author never held by pointer or context.
    await db.update(issues)
      .set({ status: "done", executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
      .where(eq(issues.id, issueId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, writerRunId));
    runningProcesses.delete(writerRunId);
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, writerRunId));
    await heartbeat.releaseIssueExecutionAndPromote(finished!, { suppressImmediateRecovery: true });

    expect((await cardRow(issueId)).status).toBe("done");
    expect(await otherRunsForCard(issueId, writerAgentId, writerRunId)).toHaveLength(0);
    const wakes = await wakesForCard(issueId, writerAgentId);
    expect(wakes.map((wake) => wake.status)).toContain("deferred_issue_execution");
  });

  it("the stale-lock sweep promotes wakes on unlocked authored cards when it terminalizes a dead author", async () => {
    const { companyId, issuePrefix, writerAgentId, writerRunId, issueId, wakeId } = await seedHeldCard({ authorStatus: "running", stampLock: false });
    // A second card still stamps the dead author, so the sweep pre-pass sees it.
    const lockerId = randomUUID();
    await db.insert(issues).values({
      id: lockerId,
      companyId,
      title: "Locking card",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: writerAgentId,
      executionRunId: writerRunId,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.update(heartbeatRuns)
      .set({ processPid: 2_000_000_000, processStartedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(heartbeatRuns.id, writerRunId));
    runningProcesses.delete(writerRunId);
    expect((await cardRow(issueId)).executionRunId).toBeNull();

    const result = await heartbeat.sweepStaleIssueLocks();
    expect(result.terminalizedRunIds).toContain(writerRunId);
    await expectWakePromoted(issueId, writerAgentId, writerRunId, wakeId);
  });

  async function seedCreateDoor() {
    const seeded = await seed();
    await db.insert(companyMemberships).values({
      companyId: seeded.companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "operator",
    });
    return seeded;
  }

  async function expectNoCreatedHolder(companyId: string, issueId: string, forgedRunId: string) {
    const [card] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(card!.originRunId).not.toBe(forgedRunId);
    expect(await findLiveIssueExecutionHolder(db, companyId, issueId)).toBeNull();
  }

  it("a board session create naming a hung victim run does not forge the origin proof", async () => {
    const { companyId, writerAgentId, writerRunId } = await seedCreateDoor();
    const res = await request(authApp({
      deploymentMode: "authenticated",
      resolveSession: async () => ({
        session: { id: "session-1", userId: "board-user" },
        user: { id: "board-user", name: "Board", email: "board@example.com" },
      }),
    }))
      .post(`/api/companies/${companyId}/issues`)
      .set("x-paperclip-run-id", writerRunId)
      .send({ title: "Forged create", status: "in_progress", assigneeAgentId: writerAgentId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await expectNoCreatedHolder(companyId, res.body.id as string, writerRunId);
  });

  it("a local_trusted create naming a hung victim run does not forge the origin proof", async () => {
    const { companyId, writerAgentId, writerRunId } = await seedCreateDoor();
    const res = await request(authApp({ deploymentMode: "local_trusted" }))
      .post(`/api/companies/${companyId}/issues`)
      .set("x-paperclip-run-id", writerRunId)
      .send({ title: "Forged create", status: "in_progress", assigneeAgentId: writerAgentId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await expectNoCreatedHolder(companyId, res.body.id as string, writerRunId);
  });

  it("a board API key create naming a hung victim run does not forge the origin proof", async () => {
    const { companyId, writerAgentId, writerRunId } = await seedCreateDoor();
    await db.insert(authUsers).values({
      id: "board-key-user", name: "Board Key", email: "key@example.com", createdAt: new Date(), updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "board-key-user", status: "active", membershipRole: "operator",
    });
    const token = `board-key-${randomUUID()}`;
    await db.insert(boardApiKeys).values({
      userId: "board-key-user",
      name: "forge-test",
      keyHash: createHash("sha256").update(token).digest("hex"),
    });
    const res = await request(authApp({ deploymentMode: "authenticated", resolveSession: async () => null }))
      .post(`/api/companies/${companyId}/issues`)
      .set("authorization", `Bearer ${token}`)
      .set("x-paperclip-run-id", writerRunId)
      .send({ title: "Forged create", status: "in_progress", assigneeAgentId: writerAgentId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await expectNoCreatedHolder(companyId, res.body.id as string, writerRunId);
  });

  it("an agent API key create naming another running run of the same agent does not forge the origin proof", async () => {
    const { companyId, writerAgentId, writerRunId } = await seedCreateDoor();
    await db.insert(authUsers).values({
      id: "responsible-user", name: "Responsible", email: "responsible@example.com", createdAt: new Date(), updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "operator",
    });
    const token = `forge-test-${randomUUID()}`;
    await db.insert(agentApiKeys).values({
      companyId,
      agentId: writerAgentId,
      name: "forge-test",
      keyHash: createHash("sha256").update(token).digest("hex"),
      responsibleUserId: "responsible-user",
    });
    const res = await request(authApp({ deploymentMode: "authenticated", resolveSession: async () => null }))
      .post(`/api/companies/${companyId}/issues`)
      .set("authorization", `Bearer ${token}`)
      .set("x-paperclip-run-id", writerRunId)
      .send({ title: "Forged create", status: "in_progress", assigneeAgentId: writerAgentId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await expectNoCreatedHolder(companyId, res.body.id as string, writerRunId);
  });

  it.each(["direct", "company"] as const)(
    "%s service update rejects caller-supplied origin provenance at runtime",
    async (surface) => {
      const { companyId, writerAgentId, writerRunId, issueId } = await seedForgedHeaderCard();
      const service = issueService(db);
      expectTypeOf<Parameters<typeof service.update>[1]["originRunId"]>().toBeUndefined();
      expectTypeOf<Parameters<typeof service.updateForCompany>[2]["originRunId"]>().toBeUndefined();
      // Deliberately model an untyped in-process caller, not a validated HTTP body.
      const patch = {
        title: "Uncommitted service title",
        assigneeAgentId: writerAgentId,
        originRunId: writerRunId,
      } as unknown as Parameters<typeof service.update>[1];
      const update = surface === "direct"
        ? service.update(issueId, patch)
        : service.updateForCompany(issueId, companyId, patch);
      await expect(update).rejects.toMatchObject({
        status: 400,
        details: { code: "issue_origin_run_id_immutable" },
      });
      expect(await cardRow(issueId)).toMatchObject({
        title: "Forged header card",
        assigneeAgentId: null,
        originRunId: null,
        executionRunId: null,
      });
      expect(await findLiveIssueExecutionHolder(db, companyId, issueId)).toBeNull();
    },
  );

  it.each([
    ["board", "create"],
    ["board", "child"],
    ["board", "update"],
    ["agent", "create"],
    ["agent", "child"],
    ["agent", "update"],
  ] as const)(
    "%s %s request bodies cannot supply creation origin",
    async (principal, surface) => {
      const { companyId, writerAgentId, writerRunId, issueId } = await seedForgedHeaderCard();
      const app = appFor(principal === "board"
        ? boardActor(companyId)
        : agentActor(companyId, writerAgentId, writerRunId));
      const createBody = {
        title: "Caller-supplied origin",
        status: "todo",
        assigneeAgentId: writerAgentId,
        originRunId: writerRunId,
      };
      const response = surface === "update"
        ? await request(app).patch(`/api/issues/${issueId}`).send({
          title: "Uncommitted title",
          assigneeAgentId: writerAgentId,
          originRunId: writerRunId,
        })
        : await request(app).post(surface === "create"
          ? `/api/companies/${companyId}/issues`
          : `/api/issues/${issueId}/children`).send(createBody);
      expect(response.status, JSON.stringify(response.body)).toBe(400);
      const stored = await db.select().from(issues).where(eq(issues.companyId, companyId));
      expect(stored.map((row) => row.id)).toEqual([issueId]);
      expect(stored[0]).toMatchObject({
        title: "Forged header card",
        assigneeAgentId: null,
        originRunId: null,
        executionRunId: null,
      });
      expect(await findLiveIssueExecutionHolder(db, companyId, issueId)).toBeNull();
    },
  );

  it("a board round trip away and back does not revive the origin proof", async () => {
    const { companyId, writerAgentId, peerAgentId, writerRunId } = await seed();
    const writer = appFor(agentActor(companyId, writerAgentId, writerRunId));
    const created = await request(writer)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Round trip card", status: "in_progress", assigneeAgentId: writerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issueId = created.body.id as string;
    const board = appFor(boardActor(companyId));
    const away = await request(board).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: peerAgentId });
    expect(away.status, JSON.stringify(away.body)).toBe(200);
    await heartbeat.drainActiveRunExecutions();
    const back = await request(board).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: writerAgentId });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    await heartbeat.drainActiveRunExecutions();
    expect((await cardRow(issueId)).originRunId).toBeNull();

    const woken = await heartbeat.wakeup(writerAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "board_wake",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "board_wake" },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
    expect(woken?.status).toBe("queued");
    expect(woken?.id).not.toBe(writerRunId);
    expect(woken?.contextSnapshot?.issueId).toBe(issueId);
    expect((await cardRow(issueId)).executionRunId).not.toBe(writerRunId);
  });

  it("an old self-assign row does not revive the hold after a board round trip (N7c)", async () => {
    const { companyId, issuePrefix, writerAgentId, writerRunId } = await seed();
    const issueId = randomUUID();
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Round trip after self-assign",
      status: "todo",
      priority: "medium",
      assigneeAgentId: writerAgentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "agent",
        actorId: writerAgentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        agentId: writerAgentId,
        runId: writerRunId,
        createdAt: older,
        details: { changes: { assigneeAgentId: { from: null, to: writerAgentId } } },
      },
      {
        companyId,
        actorType: "user",
        actorId: "board-user",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        createdAt: newer,
        details: { changes: { assigneeAgentId: { from: writerAgentId, to: writerAgentId } } },
      },
    ]);

    const holder = await findLiveIssueExecutionHolder(db, companyId, issueId);
    expect(holder?.runId ?? null).not.toBe(writerRunId);
  });

  it("a proof row from another run does not make this run the holder (M2)", async () => {
    const { companyId, issuePrefix, writerAgentId, writerRunId, peerAgentId } = await seed();
    const otherRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId: peerAgentId,
      invocationSource: "timer",
      status: "succeeded",
      contextSnapshot: { wakeReason: "heartbeat_timer" },
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Other run's proof",
      status: "todo",
      priority: "medium",
      assigneeAgentId: writerAgentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: peerAgentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      agentId: peerAgentId,
      runId: otherRunId,
      details: { changes: { assigneeAgentId: { from: null, to: writerAgentId } } },
    });
    expect((await findLiveIssueExecutionHolder(db, companyId, issueId))?.runId ?? null).not.toBe(writerRunId);
  });

  it("a chatty author with an old start still holds the card (M4)", async () => {
    const { companyId, issuePrefix, writerAgentId, writerRunId } = await seed();
    const issueId = randomUUID();
    await db.update(heartbeatRuns).set({
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      lastOutputAt: new Date(),
    }).where(eq(heartbeatRuns.id, writerRunId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Chatty author",
      status: "todo",
      priority: "medium",
      assigneeAgentId: writerAgentId,
      originRunId: writerRunId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    expect((await findLiveIssueExecutionHolder(db, companyId, issueId))?.runId).toBe(writerRunId);
  });

  it("a checkout-only stale lock still promotes the held wake (M8)", async () => {
    const { writerAgentId, writerRunId, issueId, wakeId } = await seedHeldCard({ authorStatus: "failed" });
    await db.update(issues).set({ executionRunId: null, checkoutRunId: writerRunId }).where(eq(issues.id, issueId));
    runningProcesses.delete(writerRunId);
    const swept = await heartbeat.sweepStaleIssueLocks();
    expect(swept.cleared).toBe(1);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(wake?.status).not.toBe("deferred_issue_execution");
    expect(await otherRunsForCard(issueId, writerAgentId, writerRunId)).toHaveLength(1);
  });

  it("an unlocked card assigned to someone else is not this run's promotion list (M10)", async () => {
    const { companyId, issuePrefix, writerAgentId, peerAgentId, writerRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Peer assigned",
      status: "todo",
      priority: "medium",
      assigneeAgentId: peerAgentId,
      originRunId: writerRunId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: writerAgentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      payload: { issueId },
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
    expect(await listUnlockedIssuesWithDeferredWakesForRun(db, {
      companyId,
      runId: writerRunId,
      agentId: writerAgentId,
    })).toEqual([]);
  });

  it("a lock-clear hook is called when the update has no post-commit queue (M16)", async () => {
    const { companyId, writerAgentId, writerRunId, issueId } = await seedHeldCard({ authorStatus: "failed" });
    runningProcesses.delete(writerRunId);
    const seen: string[] = [];
    const hooked = issueService(db, {
      onExecutionLockCleared: async ({ run }) => { seen.push(run.id); },
    });
    await hooked.update(issueId, { status: "todo", actorAgentId: writerAgentId });
    expect(seen).toEqual([writerRunId]);
  });

  it("the silence lapse does not clear a hold that has no waiting work (M23)", async () => {
    const { writerRunId, issueId } = await seedHeldCard({ authorStatus: "running" });
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.update(heartbeatRuns).set({ startedAt: staleAt, createdAt: staleAt, lastOutputAt: null }).where(eq(heartbeatRuns.id, writerRunId));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.payload, sql`jsonb_build_object('issueId', ${issueId}::text)`));
    await db.delete(agentWakeupRequests);
    runningProcesses.delete(writerRunId);
    const swept = await heartbeat.sweepStaleIssueLocks({ now: new Date() });
    expect(swept.issueIds).not.toContain(issueId);
  });

  it("recent output keeps a stamped hold even when the run started long ago (M24b)", async () => {
    const { companyId, writerAgentId, writerRunId, issueId, wakeId } = await seedHeldCard({ authorStatus: "running" });
    await db.update(heartbeatRuns).set({
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      lastOutputAt: new Date(),
    }).where(eq(heartbeatRuns.id, writerRunId));
    runningProcesses.delete(writerRunId);
    const swept = await heartbeat.sweepStaleIssueLocks({ now: new Date() });
    expect(swept.issueIds).not.toContain(issueId);
    expect((await cardRow(issueId)).executionRunId).toBe(writerRunId);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(wake?.status).toBe("deferred_issue_execution");
    expect(wake?.runId).toBeNull();
    expect(await otherRunsForCard(issueId, writerAgentId, writerRunId)).toEqual([]);
    const author = appFor(agentActor(companyId, writerAgentId, writerRunId));
    const patched = await request(author).patch(`/api/issues/${issueId}`).send({ title: "Author still owns this card" });
    expect(patched.status).toBe(200);
    const checkedOut = await request(author).post(`/api/issues/${issueId}/checkout`)
      .send({ agentId: writerAgentId, expectedStatuses: ["in_progress"] });
    expect(checkedOut.status).toBe(200);
  });

  it("a non-proof action keeps a user-supplied run id (M30)", async () => {
    const { companyId, writerRunId } = await seed();
    const { activity } = await persistActivity(db, {
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.commented",
      entityType: "issue",
      entityId: randomUUID(),
      runId: writerRunId,
      details: { body: "note" },
    });
    const [row] = await db.select().from(activityLog).where(eq(activityLog.id, activity.id));
    expect(row?.runId).toBe(writerRunId);
  });

  it("an unknown run header is not stamped on the activity row (M31)", async () => {
    const { companyId } = await seed();
    const missingRunId = randomUUID();
    const { activity } = await persistActivity(db, {
      companyId,
      actorType: "agent",
      actorId: randomUUID(),
      action: "issue.commented",
      entityType: "issue",
      entityId: randomUUID(),
      runId: missingRunId,
      details: { body: "note" },
    });
    const [row] = await db.select().from(activityLog).where(eq(activityLog.id, activity.id));
    expect(row?.runId).toBeNull();
  });

  it("a comment-joined non-terminal status update promotes the held wake when it clears the lock", async () => {
    const { companyId, writerAgentId, writerRunId } = await seed();
    const writer = appFor(agentActor(companyId, writerAgentId, writerRunId));
    const created = await request(writer)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Comment-joined clear", status: "in_progress", assigneeAgentId: writerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issueId = created.body.id as string;
    const comment = await request(appFor(boardActor(companyId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Board follow-up." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    await expectAuthorKeepsCard(issueId, writerAgentId, writerRunId);
    await db.execute(sql`CREATE TABLE test_comment_lock_transitions (
      transition_order bigint GENERATED ALWAYS AS IDENTITY, run_id uuid
    )`);
    await db.execute(sql`CREATE FUNCTION test_capture_comment_lock_transition()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO test_comment_lock_transitions (run_id) VALUES (NEW.execution_run_id);
        RETURN NEW;
      END;
      $$`);
    await db.execute(sql`CREATE TRIGGER test_capture_comment_lock_transition
      AFTER UPDATE OF execution_run_id ON issues FOR EACH ROW
      WHEN (OLD.execution_run_id IS DISTINCT FROM NEW.execution_run_id)
      EXECUTE FUNCTION test_capture_comment_lock_transition()`);
    try {
      const patch = await request(writer).patch(`/api/issues/${issueId}`).send({ status: "todo", comment: "Parking this card." });
      expect(patch.status, JSON.stringify(patch.body)).toBe(200);
      // Observe the real clear followed by promotion's restoration, not a
      // timestamp refresh by the request's earlier ownership check.
      await vi.waitFor(
        async () => {
          expect((await cardRow(issueId)).executionRunId).toBe(writerRunId);
          const transitions = Array.from(await db.execute(sql`
            SELECT run_id FROM test_comment_lock_transitions ORDER BY transition_order
          `));
          expect(transitions.map((row) => row.run_id)).toEqual([null, writerRunId]);
        },
        { timeout: WAKE_SETTLE_MS * 2, interval: 50 },
      );

      // After the author goes silent past the bound, the sweep lapses the stamp
      // and promotes the wake instead of stranding it.
      const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await db.update(heartbeatRuns)
        .set({ startedAt: staleAt, createdAt: staleAt, lastOutputAt: null })
        .where(eq(heartbeatRuns.id, writerRunId));
      const swept = await heartbeat.sweepStaleIssueLocks();
      expect(swept.cleared).toBe(1);
      expect(await otherRunsForCard(issueId, writerAgentId, writerRunId)).toHaveLength(1);
      const wakes = await wakesForCard(issueId, writerAgentId);
      expect(wakes.map((wake) => wake.status)).not.toContain("deferred_issue_execution");
    } finally {
      await db.execute(sql`DROP TRIGGER test_capture_comment_lock_transition ON issues`);
      await db.execute(sql`DROP FUNCTION test_capture_comment_lock_transition()`);
      await db.execute(sql`DROP TABLE test_comment_lock_transitions`);
    }
  });

  it("a board reassign does not cancel the adopted issue-less author run", async () => {
    const { companyId, writerAgentId, peerAgentId, writerRunId } = await seed();
    const writer = appFor(agentActor(companyId, writerAgentId, writerRunId));
    const created = await request(writer)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Adopted stamp card", status: "in_progress", assigneeAgentId: writerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issueId = created.body.id as string;
    const comment = await request(appFor(boardActor(companyId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Board follow-up." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    await expectAuthorKeepsCard(issueId, writerAgentId, writerRunId);

    const reassign = await request(appFor(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: peerAgentId });
    expect(reassign.status, JSON.stringify(reassign.body)).toBe(200);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, writerRunId));
    expect(run!.status).toBe("running");
  });

  it("the author's own cancel does not cancel the adopted issue-less author run", async () => {
    const { companyId, writerAgentId, writerRunId } = await seed();
    const writer = appFor(agentActor(companyId, writerAgentId, writerRunId));
    const created = await request(writer)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Adopted stamp cancel", status: "in_progress", assigneeAgentId: writerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issueId = created.body.id as string;
    const comment = await request(appFor(boardActor(companyId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Board follow-up." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    await expectAuthorKeepsCard(issueId, writerAgentId, writerRunId);

    const cancel = await request(writer).patch(`/api/issues/${issueId}`).send({ status: "cancelled" });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, writerRunId));
    expect(run!.status).toBe("running");
  });

  it("a board cancel does not kill an issue-less author whose run context is null", async () => {
    const { companyId, writerAgentId, writerRunId, issueId } = await seedHeldCard({ authorStatus: "running" });
    await db.update(heartbeatRuns).set({ contextSnapshot: null }).where(eq(heartbeatRuns.id, writerRunId));

    const cancel = await request(appFor(boardActor(companyId))).patch(`/api/issues/${issueId}`).send({ status: "cancelled" });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, writerRunId));
    expect(run!.status).toBe("running");
  });

  it("a lock clear through the shared issue service promotes the held wake", async () => {
    const { writerAgentId, writerRunId, issueId, wakeId } = await seedHeldCard({ authorStatus: "failed" });
    runningProcesses.delete(writerRunId);
    const { issueService } = await import("../services/issues.ts");
    await issueService(db).update(issueId, { status: "todo" });
    await expectWakePromoted(issueId, writerAgentId, writerRunId, wakeId);
  });

  it("the sweep promotes a held wake on an already-unlocked card", async () => {
    const { writerAgentId, writerRunId, issueId, wakeId } = await seedHeldCard({ authorStatus: "failed" });
    runningProcesses.delete(writerRunId);
    await db.update(issues)
      .set({ checkoutRunId: null, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
      .where(eq(issues.id, issueId));

    await heartbeat.sweepStaleIssueLocks();
    await expectWakePromoted(issueId, writerAgentId, writerRunId, wakeId);
  });

  it("the silence lapse never clears a live card-scoped run", async () => {
    const { writerAgentId, writerRunId, issueId } = await seedHeldCard({ authorStatus: "running" });
    await db.update(heartbeatRuns)
      .set({
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        lastOutputAt: null,
      })
      .where(eq(heartbeatRuns.id, writerRunId));

    const result = await heartbeat.sweepStaleIssueLocks();
    expect(result.cleared).toBe(0);
    expect((await cardRow(issueId)).executionRunId).toBe(writerRunId);
  });

  it("a board reassign does not hold the new assignee's wakes behind the previous author", async () => {
    const { companyId, writerAgentId, peerAgentId, writerRunId } = await seed();
    const writer = appFor(agentActor(companyId, writerAgentId, writerRunId));
    const created = await request(writer)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Cross-agent hold", status: "in_progress", assigneeAgentId: writerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issueId = created.body.id as string;
    const comment = await request(appFor(boardActor(companyId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Board follow-up." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    await expectAuthorKeepsCard(issueId, writerAgentId, writerRunId);

    const reassign = await request(appFor(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: peerAgentId });
    expect(reassign.status, JSON.stringify(reassign.body)).toBe(200);
    const [author] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, writerRunId));
    expect(author!.status).toBe("running");

    await heartbeat.wakeup(peerAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "board_wake",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "board_wake" },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
    await vi.waitFor(
      async () => {
        expect(await otherRunsForCard(issueId, peerAgentId, writerRunId)).toHaveLength(1);
      },
      { timeout: WAKE_SETTLE_MS * 2, interval: 50 },
    );
  });

  it("the silence lapse reaches a queued successor behind a silent author", async () => {
    const { companyId, writerAgentId, peerAgentId, writerRunId } = await seed();
    const writer = appFor(agentActor(companyId, writerAgentId, writerRunId));
    const created = await request(writer)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Queued successor lapse", status: "in_progress", assigneeAgentId: writerAgentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issueId = created.body.id as string;
    const comment = await request(appFor(boardActor(companyId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Board follow-up." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    await expectAuthorKeepsCard(issueId, writerAgentId, writerRunId);
    // The only waiting work is the queued successor run, not a deferred wake.
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: peerAgentId,
      status: "queued",
      invocationSource: "assignment",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await db.update(heartbeatRuns)
      .set({
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        lastOutputAt: null,
      })
      .where(eq(heartbeatRuns.id, writerRunId));

    const result = await heartbeat.sweepStaleIssueLocks();
    expect(result.cleared).toBe(1);
    expect((await cardRow(issueId)).executionRunId).toBeNull();
  });

  it("a board cancel still stops a checked-out run that did not author the card", async () => {
    const { companyId, issuePrefix, writerAgentId, writerRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Checked-out card",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: writerAgentId,
      checkoutRunId: writerRunId,
      executionRunId: writerRunId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const cancel = await request(appFor(boardActor(companyId))).patch(`/api/issues/${issueId}`).send({ status: "cancelled" });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, writerRunId));
    expect(run!.status).toBe("cancelled");
  });

  it("a local_trusted request with only a run header does not forge the proof", async () => {
    const { companyId, writerAgentId, issueId, forgedRunId } = await seedForgedHeaderCard();

    const res = await request(authApp({ deploymentMode: "local_trusted" }))
      .patch(`/api/issues/${issueId}`)
      .set("x-paperclip-run-id", forgedRunId)
      .send({ assigneeAgentId: writerAgentId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectNoForgedHolder(companyId, issueId, forgedRunId);
  });
});
