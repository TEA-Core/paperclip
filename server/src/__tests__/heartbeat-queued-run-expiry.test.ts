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

    expect(result).toEqual({ expired: 1, runIds: [stale.runId] });
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

    expect(result).toEqual({ expired: 0, runIds: [] });
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

    expect(result).toEqual({ expired: 0, runIds: [] });
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

    expect(result).toEqual({ expired: 1, runIds: [stale.runId] });
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

    expect(await heartbeat.expireStaleQueuedRuns()).toEqual({ expired: 1, runIds: [stale.runId] });
    const runAfterFirst = await readRun(stale.runId);

    expect(await heartbeat.expireStaleQueuedRuns()).toEqual({ expired: 0, runIds: [] });
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

      expect(await heartbeat.expireStaleQueuedRuns()).toEqual({ expired: 1, runIds: [waiting.runId] });
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

    expect(await heartbeat.expireStaleQueuedRuns()).toEqual({ expired: 1, runIds: [stale.runId] });
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
});
