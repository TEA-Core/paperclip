import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping queued-run expiry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const HOUR_MS = 60 * 60 * 1000;
// The documented queued-run age bound. Spelled out rather than imported so a
// change to the bound fails these tests instead of moving the seeds with it.
const QUEUED_RUN_BOUND_MS = 24 * HOUR_MS;

describeEmbeddedPostgres("heartbeat queued-run age bound", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-queued-run-expiry-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Exec CEO",
      role: "ceo",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(companyId: string, agentId: string, issueNumber: number) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Issue ${issueNumber}`,
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber,
      identifier: `T-${issueNumber}`,
      responsibleUserId: "responsible-user",
    });
    return issueId;
  }

  /**
   * A never-started continuation retry that holds the issue execution lock,
   * shaped like the run that stayed queued for six days.
   */
  async function seedQueuedLockHolder(opts: {
    companyId: string;
    agentId: string;
    issueId: string;
    createdAt: Date;
  }) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: opts.companyId,
      agentId: opts.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      status: "queued",
      payload: { issueId: opts.issueId },
      requestedByActorType: "system",
      requestedAt: opts.createdAt,
      createdAt: opts.createdAt,
      updatedAt: opts.createdAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: opts.companyId,
      agentId: opts.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {
        issueId: opts.issueId,
        taskId: opts.issueId,
        wakeReason: "issue_adr072_close_ladder_incomplete",
        retryReason: "issue_continuation_needed",
      },
      createdAt: opts.createdAt,
      updatedAt: opts.createdAt,
    });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db
      .update(issues)
      .set({ executionRunId: runId, executionAgentNameKey: "exec ceo", executionLockedAt: new Date() })
      .where(eq(issues.id, opts.issueId));
    return { runId, wakeupRequestId };
  }

  async function seedRunningRun(companyId: string, agentId: string, issueId: string, startedAt: Date) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      createdAt: startedAt,
      updatedAt: startedAt,
    });
    return runId;
  }

  async function readRun(runId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
  }

  async function readIssueLock(issueId: string) {
    return db
      .select({
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
        checkoutRunId: issues.checkoutRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
  }

  async function expiryActivityRows() {
    return db.select().from(activityLog).where(eq(activityLog.action, "heartbeat.queued_run_expired"));
  }

  it("expires a queued run past the bound, releases its issue lock, and makes the issue writable again", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedIssue(companyId, agentId, 1);
    const stale = await seedQueuedLockHolder({
      companyId,
      agentId,
      issueId,
      createdAt: new Date(Date.now() - QUEUED_RUN_BOUND_MS - HOUR_MS),
    });
    const issuesSvc = issueService(db);
    const nextRunId = await seedRunningRun(companyId, agentId, issueId, new Date());

    // The stale holder blocks checkout and the run-ownership guard that
    // interaction withdraw (and every other agent issue write) goes through.
    await expect(issuesSvc.checkout(issueId, agentId, ["in_progress"], nextRunId)).rejects.toMatchObject({
      status: 409,
    });
    await expect(issuesSvc.assertCheckoutOwner(issueId, agentId, nextRunId)).rejects.toMatchObject({
      status: 409,
    });

    const result = await heartbeatService(db).expireStaleQueuedRuns();

    expect(result).toEqual({ expired: 1, runIds: [stale.runId], pageCapReached: false });
    const run = await readRun(stale.runId);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "queued_run_expired", startedAt: null });
    expect(run.finishedAt).toBeInstanceOf(Date);
    const [wake] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, stale.wakeupRequestId));
    expect(wake?.status).toBe("skipped");
    expect(await readIssueLock(issueId)).toEqual({
      executionRunId: null,
      executionLockedAt: null,
      checkoutRunId: null,
    });

    const activity = await db.select().from(activityLog);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      action: "heartbeat.queued_run_expired",
      actorType: "system",
      entityType: "heartbeat_run",
      entityId: stale.runId,
      runId: stale.runId,
      agentId,
    });
    expect(activity[0]!.details).toMatchObject({
      errorCode: "queued_run_expired",
      issueId,
      maxQueuedAgeMs: QUEUED_RUN_BOUND_MS,
    });

    const checkedOut = await issuesSvc.checkout(issueId, agentId, ["in_progress"], nextRunId);
    expect(checkedOut).toMatchObject({ checkoutRunId: nextRunId, executionRunId: nextRunId });
    await expect(issuesSvc.assertCheckoutOwner(issueId, agentId, nextRunId)).resolves.toBeTruthy();
  });

  it("leaves a queued run inside the bound untouched", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedIssue(companyId, agentId, 1);
    const fresh = await seedQueuedLockHolder({
      companyId,
      agentId,
      issueId,
      createdAt: new Date(Date.now() - QUEUED_RUN_BOUND_MS + HOUR_MS),
    });
    const lockBefore = await readIssueLock(issueId);

    const result = await heartbeatService(db).expireStaleQueuedRuns();

    expect(result).toEqual({ expired: 0, runIds: [], pageCapReached: false });
    expect((await readRun(fresh.runId)).status).toBe("queued");
    expect(await readIssueLock(issueId)).toEqual(lockBefore);
    expect(await expiryActivityRows()).toHaveLength(0);
  });

  it("pages past 100 old-but-not-expirable queued runs to reach a stale run behind them", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const oldest = Date.now() - QUEUED_RUN_BOUND_MS - 10 * HOUR_MS;
    const blockerIssueId = await seedIssue(companyId, agentId, 2);
    const blockers = [];
    for (let i = 0; i < 100; i += 1) {
      blockers.push({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation" as const,
        triggerDetail: "system",
        status: "queued",
        scheduledRetryAt: new Date(Date.now() + HOUR_MS),
        contextSnapshot: { issueId: blockerIssueId, taskId: blockerIssueId },
        createdAt: new Date(oldest + i),
        updatedAt: new Date(oldest + i),
      });
    }
    await db.insert(heartbeatRuns).values(blockers);
    const issueId = await seedIssue(companyId, agentId, 1);
    const stale = await seedQueuedLockHolder({
      companyId,
      agentId,
      issueId,
      createdAt: new Date(Date.now() - QUEUED_RUN_BOUND_MS - HOUR_MS),
    });

    const result = await heartbeatService(db).expireStaleQueuedRuns();

    expect(result.runIds).toContain(stale.runId);
    expect((await readRun(stale.runId)).status).toBe("cancelled");
    expect((await readIssueLock(issueId)).executionRunId).toBeNull();
  });

  function oldQueuedRunRows(opts: {
    companyId: string;
    agentId: string;
    issueId: string;
    count: number;
    firstCreatedAtMs: number;
    scheduledRetryAt?: Date;
  }) {
    return Array.from({ length: opts.count }, (_, i) => ({
      id: randomUUID(),
      companyId: opts.companyId,
      agentId: opts.agentId,
      invocationSource: "automation" as const,
      triggerDetail: "system",
      status: "queued",
      scheduledRetryAt: opts.scheduledRetryAt ?? null,
      contextSnapshot: { issueId: opts.issueId, taskId: opts.issueId },
      createdAt: new Date(opts.firstCreatedAtMs + i),
      updatedAt: new Date(opts.firstCreatedAtMs + i),
    }));
  }

  it("pages listed runs that share one created_at microsecond without re-reading a page", { timeout: 60_000 }, async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const oldest = Date.now() - QUEUED_RUN_BOUND_MS - 10 * HOUR_MS;
    const issueId = await seedIssue(companyId, agentId, 1);
    const sameInstant = oldQueuedRunRows({ companyId, agentId, issueId, count: 120, firstCreatedAtMs: oldest });
    await db.insert(heartbeatRuns).values(sameInstant);
    // One insert transaction's timestamp: every run on the same microsecond,
    // below the millisecond a JavaScript Date can carry.
    await db.execute(sql`
      update heartbeat_runs
      set created_at = to_timestamp(${Math.floor(oldest / 1000)}) + interval '123456 microseconds'
      where id in (${sql.join(sameInstant.map((row) => sql`${row.id}::uuid`), sql`, `)})
    `);
    const adapter = createPostgresRunDispatchAdapter(db);
    const now = new Date();
    const listInput = { createdAtOrBefore: new Date(now.getTime() - QUEUED_RUN_BOUND_MS), now, limit: 100 };

    const first = await adapter.listExpiredQueuedRuns(listInput);
    const second = await adapter.listExpiredQueuedRuns({ ...listInput, after: first.at(-1)!.cursor });

    expect(first).toHaveLength(100);
    expect(second).toHaveLength(20);
    const listed = [...first, ...second].map((candidate) => candidate.runId);
    expect(new Set(listed).size).toBe(120);
    expect([...listed].sort()).toEqual(sameInstant.map((row) => row.id).sort());
  });

  it("expires at most 100 runs per sweep and the rest on the next sweep", { timeout: 60_000 }, async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedIssue(companyId, agentId, 1);
    const rows = oldQueuedRunRows({
      companyId, agentId, issueId, count: 150, firstCreatedAtMs: Date.now() - QUEUED_RUN_BOUND_MS - 10 * HOUR_MS,
    });
    await db.insert(heartbeatRuns).values(rows);
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.expireStaleQueuedRuns();
    expect(first.expired).toBe(100);
    expect(first.runIds).toEqual(rows.slice(0, 100).map((row) => row.id));

    const second = await heartbeat.expireStaleQueuedRuns();
    expect(second.expired).toBe(50);
    expect(second.runIds).toEqual(rows.slice(100).map((row) => row.id));
    expect(await expiryActivityRows()).toHaveLength(150);
  });

  it("reaches a newer expirable run on the first sweep behind 2,500 older runs it may not expire", { timeout: 120_000 }, async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const oldest = Date.now() - QUEUED_RUN_BOUND_MS - 48 * HOUR_MS;
    // Shape 1: retry alarm still in the future.
    const futureRetryIssueId = await seedIssue(companyId, agentId, 1);
    const futureRetry = oldQueuedRunRows({
      companyId, agentId, issueId: futureRetryIssueId, count: 1_250, firstCreatedAtMs: oldest,
      scheduledRetryAt: new Date(Date.now() + HOUR_MS),
    });
    // Shape 2: the issue is held by another live (running) run.
    const leasedIssueId = await seedIssue(companyId, agentId, 2);
    const holderRunId = await seedRunningRun(companyId, agentId, leasedIssueId, new Date());
    await db.update(issues).set({ executionRunId: holderRunId, executionLockedAt: new Date() })
      .where(eq(issues.id, leasedIssueId));
    const leased = oldQueuedRunRows({
      companyId, agentId, issueId: leasedIssueId, count: 1_250, firstCreatedAtMs: oldest + 1_250,
    });
    for (let i = 0; i < 2_500; i += 500) {
      await db.insert(heartbeatRuns).values([...futureRetry, ...leased].slice(i, i + 500));
    }
    const staleIssueId = await seedIssue(companyId, agentId, 3);
    const stale = await seedQueuedLockHolder({
      companyId,
      agentId,
      issueId: staleIssueId,
      createdAt: new Date(Date.now() - QUEUED_RUN_BOUND_MS - HOUR_MS),
    });

    const result = await heartbeatService(db).expireStaleQueuedRuns();

    expect(result).toEqual({ expired: 1, runIds: [stale.runId], pageCapReached: false });
    expect((await readIssueLock(staleIssueId)).executionRunId).toBeNull();
    const stillQueued = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "queued"));
    expect(stillQueued).toHaveLength(2_500);
    expect((await readIssueLock(leasedIssueId)).executionRunId).toBe(holderRunId);
  });

  it("expires a paused agent's queued run past the bound, so a paused backlog cannot fill the scan", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    const issueId = await seedIssue(companyId, agentId, 1);
    const stale = await seedQueuedLockHolder({
      companyId,
      agentId,
      issueId,
      createdAt: new Date(Date.now() - QUEUED_RUN_BOUND_MS - HOUR_MS),
    });

    expect(await heartbeatService(db).expireStaleQueuedRuns())
      .toEqual({ expired: 1, runIds: [stale.runId], pageCapReached: false });
    expect((await readIssueLock(issueId)).executionRunId).toBeNull();
  });

  it("reaches newer expirable runs on the first sweep behind 2,100 older runs with a numeric issueId", { timeout: 120_000 }, async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const oldest = Date.now() - QUEUED_RUN_BOUND_MS - 48 * HOUR_MS;
    const placeholderIssueId = await seedIssue(companyId, agentId, 1);
    const numeric = oldQueuedRunRows({
      companyId, agentId, issueId: placeholderIssueId, count: 2_100, firstCreatedAtMs: oldest,
    }).map((row) => ({ ...row, contextSnapshot: { issueId: 12345 } }));
    for (let i = 0; i < numeric.length; i += 500) {
      await db.insert(heartbeatRuns).values(numeric.slice(i, i + 500));
    }
    const issueId = await seedIssue(companyId, agentId, 2);
    const expirable = oldQueuedRunRows({
      companyId, agentId, issueId, count: 20, firstCreatedAtMs: oldest + 10_000,
    });
    await db.insert(heartbeatRuns).values(expirable);

    const result = await heartbeatService(db).expireStaleQueuedRuns();

    expect(result).toMatchObject({ expired: 20, pageCapReached: false });
    expect([...result.runIds].sort()).toEqual(expirable.map((row) => row.id).sort());
  });

  it("completes a sweep past a run whose issueId is padded text and expires the run behind it", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const oldest = Date.now() - QUEUED_RUN_BOUND_MS - 10 * HOUR_MS;
    const issueId = await seedIssue(companyId, agentId, 1);
    const [poison] = oldQueuedRunRows({ companyId, agentId, issueId, count: 1, firstCreatedAtMs: oldest })
      .map((row) => ({ ...row, contextSnapshot: { issueId: ` ${issueId} ` } }));
    await db.insert(heartbeatRuns).values(poison!);
    const [expirable] = oldQueuedRunRows({ companyId, agentId, issueId, count: 1, firstCreatedAtMs: oldest + 1_000 });
    await db.insert(heartbeatRuns).values(expirable!);

    const result = await heartbeatService(db).expireStaleQueuedRuns();

    expect(result).toEqual({ expired: 1, runIds: [expirable!.id], pageCapReached: false });
    expect((await readRun(poison!.id)).status).toBe("queued");
  });

  it("treats a malformed issueId inside the locked decision as a missing issue instead of throwing", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedIssue(companyId, agentId, 1);
    const [poison] = oldQueuedRunRows({
      companyId, agentId, issueId, count: 1, firstCreatedAtMs: Date.now() - QUEUED_RUN_BOUND_MS - HOUR_MS,
    }).map((row) => ({ ...row, contextSnapshot: { issueId: ` ${issueId} ` } }));
    await db.insert(heartbeatRuns).values(poison!);

    const outcome = await createPostgresRunDispatchAdapter(db).expireQueuedRun({
      runId: poison!.id,
      companyId,
      now: new Date(),
    });

    expect(outcome).toMatchObject({ outcome: "cancelled", errorCode: "issue_not_found" });
    expect(await readIssueLock(issueId)).toEqual({ executionRunId: null, executionLockedAt: null, checkoutRunId: null });
  });

  it("does not cancel a listed run once its company is paused", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedIssue(companyId, agentId, 1);
    const stale = await seedQueuedLockHolder({
      companyId,
      agentId,
      issueId,
      createdAt: new Date(Date.now() - QUEUED_RUN_BOUND_MS - HOUR_MS),
    });
    const adapter = createPostgresRunDispatchAdapter(db);
    const now = new Date();
    const listed = await adapter.listExpiredQueuedRuns({
      createdAtOrBefore: new Date(now.getTime() - QUEUED_RUN_BOUND_MS), now, limit: 100,
    });
    expect(listed.map((candidate) => candidate.runId)).toEqual([stale.runId]);

    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, companyId));
    const outcome = await adapter.expireQueuedRun({ runId: stale.runId, companyId, now });

    expect(outcome).toEqual({ outcome: "not_stale" });
    expect((await readRun(stale.runId)).status).toBe("queued");
    expect((await readIssueLock(issueId)).executionRunId).toBe(stale.runId);
  });

  it("expires a run whose retry alarm is due exactly now", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedIssue(companyId, agentId, 1);
    const now = new Date();
    const [due] = oldQueuedRunRows({
      companyId, agentId, issueId, count: 1, firstCreatedAtMs: now.getTime() - QUEUED_RUN_BOUND_MS - HOUR_MS,
      scheduledRetryAt: now,
    });
    await db.insert(heartbeatRuns).values(due!);

    expect(await heartbeatService(db).expireStaleQueuedRuns({ now }))
      .toEqual({ expired: 1, runIds: [due!.id], pageCapReached: false });
  });

  it("leaves out a run whose upper-case issueId names an issue held by another running run", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedIssue(companyId, agentId, 1);
    const holderRunId = await seedRunningRun(companyId, agentId, issueId, new Date());
    await db.update(issues).set({ executionRunId: holderRunId, executionLockedAt: new Date() })
      .where(eq(issues.id, issueId));
    const [upper] = oldQueuedRunRows({
      companyId, agentId, issueId, count: 1, firstCreatedAtMs: Date.now() - QUEUED_RUN_BOUND_MS - HOUR_MS,
    }).map((row) => ({ ...row, contextSnapshot: { issueId: issueId.toUpperCase() } }));
    await db.insert(heartbeatRuns).values(upper!);
    const now = new Date();

    const listed = await createPostgresRunDispatchAdapter(db).listExpiredQueuedRuns({
      createdAtOrBefore: new Date(now.getTime() - QUEUED_RUN_BOUND_MS), now, limit: 100,
    });

    expect(listed).toEqual([]);
  });

  it("leaves a running run older than the bound untouched", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedIssue(companyId, agentId, 1);
    const runningRunId = await seedRunningRun(
      companyId,
      agentId,
      issueId,
      new Date(Date.now() - 3 * QUEUED_RUN_BOUND_MS),
    );
    await db.update(issues).set({ executionRunId: runningRunId, executionLockedAt: new Date() })
      .where(eq(issues.id, issueId));
    const lockBefore = await readIssueLock(issueId);

    const result = await heartbeatService(db).expireStaleQueuedRuns();

    expect(result).toEqual({ expired: 0, runIds: [], pageCapReached: false });
    expect((await readRun(runningRunId)).status).toBe("running");
    expect(await readIssueLock(issueId)).toEqual(lockBefore);
    expect(await expiryActivityRows()).toHaveLength(0);
  });

  it("releases only the expired run's issue and leaves another issue's queued holder in place", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const staleIssueId = await seedIssue(companyId, agentId, 1);
    const otherIssueId = await seedIssue(companyId, agentId, 2);
    const stale = await seedQueuedLockHolder({
      companyId,
      agentId,
      issueId: staleIssueId,
      createdAt: new Date(Date.now() - QUEUED_RUN_BOUND_MS - HOUR_MS),
    });
    const other = await seedQueuedLockHolder({
      companyId,
      agentId,
      issueId: otherIssueId,
      createdAt: new Date(Date.now() - HOUR_MS),
    });
    const otherLockBefore = await readIssueLock(otherIssueId);

    const result = await heartbeatService(db).expireStaleQueuedRuns();

    expect(result).toEqual({ expired: 1, runIds: [stale.runId], pageCapReached: false });
    expect((await readIssueLock(staleIssueId)).executionRunId).toBeNull();
    expect((await readRun(other.runId)).status).toBe("queued");
    expect(await readIssueLock(otherIssueId)).toEqual(otherLockBefore);
  });

  it("is idempotent: a second pass expires nothing and writes no activity", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedIssue(companyId, agentId, 1);
    const stale = await seedQueuedLockHolder({
      companyId,
      agentId,
      issueId,
      createdAt: new Date(Date.now() - QUEUED_RUN_BOUND_MS - HOUR_MS),
    });
    const heartbeat = heartbeatService(db);

    expect(await heartbeat.expireStaleQueuedRuns()).toEqual({ expired: 1, runIds: [stale.runId], pageCapReached: false });
    const runAfterFirst = await readRun(stale.runId);

    expect(await heartbeat.expireStaleQueuedRuns()).toEqual({ expired: 0, runIds: [], pageCapReached: false });
    expect(await readRun(stale.runId)).toEqual(runAfterFirst);
    expect(await expiryActivityRows()).toHaveLength(1);
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, stale.runId)))
      .toHaveLength(1);
  });

  /**
   * A run that was legitimately waiting: an ordinary assignment wake queued
   * behind the agent's single slot while another issue's run held it for
   * more than a day.
   */
  async function seedAssignmentRunBehindBusyAgent(status: "todo" | "in_progress") {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, agentId));
    const issueId = await seedIssue(companyId, agentId, 1);
    await db.update(issues).set({ status }).where(eq(issues.id, issueId));
    const busyIssueId = await seedIssue(companyId, agentId, 2);
    const busyRunId = await seedRunningRun(companyId, agentId, busyIssueId, new Date(Date.now() - 30 * HOUR_MS));
    await db.update(issues).set({ executionRunId: busyRunId, executionLockedAt: new Date() })
      .where(eq(issues.id, busyIssueId));
    const waiting = await seedQueuedLockHolder({
      companyId,
      agentId,
      issueId,
      createdAt: new Date(Date.now() - QUEUED_RUN_BOUND_MS - HOUR_MS),
    });
    await db.update(agentWakeupRequests)
      .set({ source: "assignment", reason: "issue_assigned", requestedByActorType: "user", requestedByActorId: "board-user" })
      .where(eq(agentWakeupRequests.id, waiting.wakeupRequestId));
    await db.update(heartbeatRuns)
      .set({ invocationSource: "assignment", contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" } })
      .where(eq(heartbeatRuns.id, waiting.runId));
    return { companyId, issueId, waiting };
  }

  it.each(["todo", "in_progress"] as const)(
    "hands a legitimately waiting %s run's work back to stranded-work recovery, not to a board hold",
    async (status) => {
      const { issueId, waiting } = await seedAssignmentRunBehindBusyAgent(status);
      const heartbeat = heartbeatService(db);

      expect(await heartbeat.expireStaleQueuedRuns()).toEqual({ expired: 1, runIds: [waiting.runId], pageCapReached: false });
      expect((await readRun(waiting.runId)).resultJson).toMatchObject({
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      });

      const reconciled = await heartbeat.reconcileStrandedAssignedIssues();
      await heartbeat.drainActiveRunExecutions();

      expect(reconciled.issueIds).toContain(issueId);
      const replacements = await db
        .select({ status: heartbeatRuns.status, retryOfRunId: heartbeatRuns.retryOfRunId })
        .from(heartbeatRuns)
        .where(and(
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          eq(heartbeatRuns.retryOfRunId, waiting.runId),
        ));
      expect(replacements).toEqual([{ status: "scheduled_retry", retryOfRunId: waiting.runId }]);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))
        .toEqual([]);
    },
  );

  it("leaves an automatic continuation whose source cannot be verified for the next wake, with the issue unlocked", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedIssue(companyId, agentId, 1);
    // A system continuation with no retry ancestry: the chat-control source
    // check is unresolved, the same verdict that kept the claim skipping it.
    const stale = await seedQueuedLockHolder({
      companyId,
      agentId,
      issueId,
      createdAt: new Date(Date.now() - QUEUED_RUN_BOUND_MS - HOUR_MS),
    });
    const heartbeat = heartbeatService(db);

    expect(await heartbeat.expireStaleQueuedRuns()).toEqual({ expired: 1, runIds: [stale.runId], pageCapReached: false });
    const reconciled = await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.drainActiveRunExecutions();

    expect(reconciled.issueIds).not.toContain(issueId);
    const issueRuns = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`);
    expect(issueRuns).toEqual([{ id: stale.runId }]);
    expect(await readIssueLock(issueId)).toEqual({ executionRunId: null, executionLockedAt: null, checkoutRunId: null });
    expect((await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)))[0]?.status)
      .toBe("in_progress");
  });

  // Owner decision 2026-11-17: queued approval, review, and wake runs on an
  // issue in review expire at the same 24-hour bound as any other queued run.
  const IN_REVIEW_RUN_KINDS = [
    { kind: "approval", wakeReason: "execution_approval_requested", byParticipant: true },
    { kind: "review", wakeReason: "execution_review_requested", byParticipant: true },
    { kind: "wake", wakeReason: "issue_commented", byParticipant: false },
  ] as const;

  async function seedInReviewQueuedRun(spec: (typeof IN_REVIEW_RUN_KINDS)[number], createdAt: Date) {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const participantAgentId = randomUUID();
    await db.insert(agents).values({
      id: participantAgentId,
      companyId,
      name: "Reviewer",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = await seedIssue(companyId, agentId, 1);
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
    const runAgentId = spec.byParticipant ? participantAgentId : agentId;
    const queued = await seedQueuedLockHolder({ companyId, agentId: runAgentId, issueId, createdAt });
    await db.update(agentWakeupRequests)
      .set({ source: "automation", reason: spec.wakeReason })
      .where(eq(agentWakeupRequests.id, queued.wakeupRequestId));
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { issueId, taskId: issueId, wakeReason: spec.wakeReason } })
      .where(eq(heartbeatRuns.id, queued.runId));
    return { issueId, runId: queued.runId };
  }

  it.each(IN_REVIEW_RUN_KINDS)(
    "expires a queued $kind run on an in_review issue past the bound and releases its lock",
    async (spec) => {
      const { issueId, runId } = await seedInReviewQueuedRun(spec, new Date(Date.now() - QUEUED_RUN_BOUND_MS - HOUR_MS));

      expect(await heartbeatService(db).expireStaleQueuedRuns())
        .toEqual({ expired: 1, runIds: [runId], pageCapReached: false });
      expect(await readRun(runId)).toMatchObject({ status: "cancelled", errorCode: "queued_run_expired" });
      expect(await readIssueLock(issueId)).toEqual({ executionRunId: null, executionLockedAt: null, checkoutRunId: null });
      const activity = await expiryActivityRows();
      expect(activity).toHaveLength(1);
      expect(activity[0]).toMatchObject({ entityId: runId, details: expect.objectContaining({ issueId }) });
    },
  );

  it.each(IN_REVIEW_RUN_KINDS)(
    "leaves a queued $kind run on an in_review issue inside the bound untouched",
    async (spec) => {
      const { issueId, runId } = await seedInReviewQueuedRun(spec, new Date(Date.now() - QUEUED_RUN_BOUND_MS + HOUR_MS));
      const lockBefore = await readIssueLock(issueId);

      expect(await heartbeatService(db).expireStaleQueuedRuns())
        .toEqual({ expired: 0, runIds: [], pageCapReached: false });
      expect((await readRun(runId)).status).toBe("queued");
      expect(await readIssueLock(issueId)).toEqual(lockBefore);
      expect(await expiryActivityRows()).toHaveLength(0);
    },
  );
});
