import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { issueService } from "../services/issues.ts";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentTaskRun = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentTaskRun: mockTrackAgentTaskRun,
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfDeclaredRunService } from "../services/self-declared-run.js";
import {
  withQueuedCommentIdsInRunContext,
  withQueuedCommentIdsInWakePayload,
} from "../services/issue-queued-comment-queue.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat lock-release-on-reassignment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat lock release on cross-agent reassignment", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let paperclipHome: string | null = null;

  beforeAll(async () => {
    paperclipHome = await mkdtemp(join(tmpdir(), "heartbeat-handoff-home-"));
    vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-lock-release-on-reassignment-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // The route also creates comments, decisions and audit rows. Clear the
    // disposable company graph together, including their run foreign keys.
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    if (db && heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
    if (paperclipHome) await rm(paperclipHome, { recursive: true, force: true });
  });

  async function seedCrossAgentScenario(opts: {
    holderStatus: "queued" | "running";
    holderContext?: (issueId: string) => Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const coderAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const issueId = randomUUID();
    const holderRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values([
      {
        id: coderAgentId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: coderAgentId,
      source: "assignment",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId,
      agentId: coderAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: opts.holderStatus,
      wakeupRequestId,
      contextSnapshot: opts.holderContext?.(issueId) ??
        { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cross-agent reassignment race",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: reviewerAgentId,
      executionRunId: holderRunId,
      executionAgentNameKey: "coder",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return {
      companyId,
      coderAgentId,
      reviewerAgentId,
      issueId,
      holderRunId,
      wakeupRequestId,
    };
  }

  async function seedStageHandoff(holderContext?: (issueId: string) => Record<string, unknown>) {
    const seeded = await seedCrossAgentScenario({ holderStatus: "running", holderContext });
    const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId } = seeded;
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: coderAgentId }] },
        { type: "review", participants: [{ type: "agent", agentId: reviewerAgentId }] },
      ],
    })!;
    await db.update(issues).set({
      assigneeAgentId: coderAgentId,
      deliveryRequirement: "record_only",
      executionPolicy: { ...policy },
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0]!.id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: policy.stages[0]!.participants[0],
        returnAssignee: { type: "agent", agentId: coderAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, issueId));
    // Hold the successor's only slot on another issue. Promotion can create a
    // real queued run without launching a provider in this disposable database.
    await db.update(agents).set({
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, reviewerAgentId));
    const [busyRun] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: reviewerAgentId,
      status: "running",
      contextSnapshot: { issueId: randomUUID() },
      startedAt: new Date(),
    }).returning();

    const client = express();
    client.use(express.json());
    client.use((req, _res, next) => {
      req.actor = { type: "agent", companyId, agentId: coderAgentId, runId: holderRunId };
      next();
    });
    // This PATCH does not access attachment storage.
    const unusedStorage = {} as Parameters<typeof issueRoutes>[1];
    client.use("/api", issueRoutes(db, unusedStorage, {}));
    client.use(errorHandler);
    return { ...seeded, policy, busyRun, client };
  }

  it("retains the resolved unscoped issuer while real post-commit cancellation is blocked", async () => {
    const { coderAgentId, reviewerAgentId, issueId, holderRunId, policy, client } =
      await seedStageHandoff(() => ({ wakeReason: "timer" }));
    await db.execute(sql.raw(`CREATE FUNCTION test_stage_cancel_delay() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(739405); RETURN NEW; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER test_stage_cancel_delay BEFORE UPDATE OF status ON heartbeat_runs
      FOR EACH ROW WHEN (OLD.status = 'running' AND NEW.status = 'cancelled')
      EXECUTE FUNCTION test_stage_cancel_delay()`));
    const barrier = new EventEmitter();
    const entered = once(barrier, "entered");
    const gate = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(739405)`);
      const released = once(barrier, "release");
      barrier.emit("entered");
      await released;
    });
    await entered;
    const patch = request(client).patch(`/api/issues/${issueId}`).send({
      status: "done", comment: "Review passed; save the next stage before stopping this issuer.",
    }).then((response) => response);
    let deferredId: string | undefined;
    try {
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event = 'advisory'
            AND query LIKE '%heartbeat_runs%'`);
        expect(waiting).toHaveLength(1);
      }, { timeout: 10_000 });
      const [saved] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(saved).toMatchObject({
        assigneeAgentId: reviewerAgentId,
        executionState: { currentStageId: policy.stages[1]!.id },
      });
      expect((await heartbeat.getRun(holderRunId))?.status).toBe("running");
      await heartbeat.wakeup(reviewerAgentId, {
        source: "automation", reason: "issue_assigned", payload: { issueId },
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
        requestedByActorType: "agent", requestedByActorId: coderAgentId,
      });
      const [deferred] = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.agentId, reviewerAgentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
      ));
      expect(deferred).toMatchObject({ status: "deferred_issue_execution", runId: null });
      deferredId = deferred!.id;
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionRunId).toBe(holderRunId);
    } finally {
      barrier.emit("release");
      await gate;
      await patch;
      await db.execute(sql.raw("DROP TRIGGER test_stage_cancel_delay ON heartbeat_runs"));
      await db.execute(sql.raw("DROP FUNCTION test_stage_cancel_delay()"));
    }
    const response = await patch;
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await heartbeat.getRun(holderRunId))?.status).toBe("cancelled");
    const [promoted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferredId!));
    expect(promoted).toMatchObject({ status: "queued", reason: "issue_execution_promoted" });
    expect(await heartbeat.getRun(promoted.runId!)).toMatchObject({ agentId: reviewerAgentId, status: "queued" });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionRunId).toBe(promoted.runId);
  });

  it.each([
    "unscoped", "unscoped multiple bindings", "missing context issue", "existing context issue",
  ])("retains a resolved issuer after an actual cancel failure with %s until a real stop promotes every held successor", async (scope) => {
    const contextIssueId = scope.startsWith("unscoped") ? null : randomUUID();
    const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId, client } =
      await seedStageHandoff(() => contextIssueId ? { issueId: contextIssueId } : { wakeReason: "timer" });
    if (scope === "existing context issue") {
      await db.insert(issues).values({
        id: contextIssueId!, companyId, title: "Issuer's original task",
        status: "in_review", assigneeAgentId: coderAgentId, executionRunId: holderRunId,
      });
    }
    const siblingIssueId = scope === "unscoped" ? null : randomUUID();
    if (siblingIssueId) {
      await db.insert(issues).values({
        id: siblingIssueId, companyId, title: "Other legacy held task",
        status: "in_review", assigneeAgentId: reviewerAgentId, executionRunId: holderRunId,
      });
    }
    await db.execute(sql.raw(`CREATE FUNCTION test_stage_cancel_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test cancellation rejected'; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER test_stage_cancel_failure BEFORE UPDATE OF status ON heartbeat_runs
      FOR EACH ROW WHEN (OLD.status = 'running' AND NEW.status = 'cancelled')
      EXECUTE FUNCTION test_stage_cancel_failure()`));
    let deferredId: string | undefined;
    let siblingDeferredId: string | undefined;
    try {
      const response = await request(client).patch(`/api/issues/${issueId}`).send({
        status: "done", comment: "Review passed; cancellation failure must not admit overlapping execution.",
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({ status: "in_review", assigneeAgentId: reviewerAgentId });
      expect((await heartbeat.getRun(holderRunId))?.status).toBe("running");
      await heartbeat.wakeup(reviewerAgentId, {
        source: "automation", reason: "issue_assigned", payload: { issueId },
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
        requestedByActorType: "agent", requestedByActorId: coderAgentId,
      });
      const [deferred] = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.agentId, reviewerAgentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
      ));
      expect(deferred).toMatchObject({ status: "deferred_issue_execution", runId: null });
      deferredId = deferred!.id;
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionRunId).toBe(holderRunId);
      if (siblingIssueId) {
        await heartbeat.wakeup(reviewerAgentId, {
          source: "automation", reason: "issue_assigned", payload: { issueId: siblingIssueId },
          contextSnapshot: { issueId: siblingIssueId, taskId: siblingIssueId, wakeReason: "issue_assigned" },
          requestedByActorType: "agent", requestedByActorId: coderAgentId,
        });
        const [siblingDeferred] = await db.select().from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.agentId, reviewerAgentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${siblingIssueId}`,
        ));
        expect(siblingDeferred).toMatchObject({ status: "deferred_issue_execution", runId: null });
        siblingDeferredId = siblingDeferred!.id;
      }
    } finally {
      await db.execute(sql.raw("DROP TRIGGER test_stage_cancel_failure ON heartbeat_runs"));
      await db.execute(sql.raw("DROP FUNCTION test_stage_cancel_failure()"));
    }
    await heartbeat.cancelRun(holderRunId, "The issuer actually stopped", { suppressImmediateRecovery: true });
    expect((await heartbeat.getRun(holderRunId))?.status).toBe("cancelled");
    const [promoted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferredId!));
    expect(promoted).toMatchObject({ status: "queued", reason: "issue_execution_promoted" });
    expect(await heartbeat.getRun(promoted.runId!)).toMatchObject({ agentId: reviewerAgentId, status: "queued" });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionRunId).toBe(promoted.runId);
    if (siblingDeferredId) {
      const [siblingPromoted] = await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, siblingDeferredId));
      expect(siblingPromoted).toMatchObject({ status: "queued", reason: "issue_execution_promoted" });
      expect(await heartbeat.getRun(siblingPromoted.runId!)).toMatchObject({
        agentId: reviewerAgentId, status: "queued", contextSnapshot: { issueId: siblingIssueId },
      });
      expect((await db.select().from(issues).where(eq(issues.id, siblingIssueId!)))[0].executionRunId)
        .toBe(siblingPromoted.runId);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, coderAgentId)))
        .toEqual([expect.objectContaining({ id: holderRunId, status: "cancelled" })]);
    }
  });

  it("promotes a healthy sibling when another sibling promotion fails", async () => {
    const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId } = await seedStageHandoff();
    const failedIssueId = "00000000-0000-4000-8000-000000000001";
    const healthyIssueId = "00000000-0000-4000-8000-000000000002";
    await db.update(issues).set({
      status: "in_progress", assigneeAgentId: reviewerAgentId, executionPolicy: null, executionState: null,
      checkoutRunId: holderRunId,
    }).where(eq(issues.id, issueId));
    await db.update(agents).set({
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    }).where(eq(agents.id, reviewerAgentId));
    await db.insert(issues).values([failedIssueId, healthyIssueId].map((id) => ({
      id, companyId, title: "Held sibling", status: "in_progress", assigneeAgentId: reviewerAgentId,
      executionRunId: holderRunId, checkoutRunId: holderRunId,
    })));
    for (const id of [issueId, failedIssueId, healthyIssueId]) {
      await heartbeat.wakeup(reviewerAgentId, {
        source: "automation", reason: "issue_assigned", payload: { issueId: id },
        contextSnapshot: { issueId: id, taskId: id, wakeReason: "issue_assigned" },
        requestedByActorType: "agent", requestedByActorId: coderAgentId,
      });
    }
    const [healthyWake] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${healthyIssueId}`,
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
    ));
    expect(healthyWake).toMatchObject({ status: "deferred_issue_execution", runId: null });
    await db.execute(sql.raw("CREATE SEQUENCE test_sibling_promotion_faults"));
    await db.execute(sql.raw(`CREATE FUNCTION test_sibling_promotion_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.context_snapshot->>'issueId' = '${failedIssueId}' THEN
          PERFORM nextval('test_sibling_promotion_faults');
          RAISE EXCEPTION 'test sibling promotion rejected';
        END IF;
        RETURN NEW;
      END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER test_sibling_promotion_failure BEFORE INSERT ON heartbeat_runs
      FOR EACH ROW EXECUTE FUNCTION test_sibling_promotion_failure()`));
    try {
      await heartbeat.cancelRun(holderRunId, "Issuer stopped", { suppressImmediateRecovery: true }).catch(() => undefined);
      expect((await heartbeat.getRun(holderRunId))?.status).toBe("cancelled");
      const [fault] = await db.execute(sql`SELECT is_called FROM test_sibling_promotion_faults`);
      expect(fault?.is_called).toBe(true);
      const [promoted] = await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, healthyWake!.id));
      expect(promoted).toMatchObject({ status: "queued" });
      expect(await heartbeat.getRun(promoted!.runId!)).toMatchObject({
        status: "queued", agentId: reviewerAgentId, contextSnapshot: { issueId: healthyIssueId },
      });
      expect((await db.select().from(issues).where(eq(issues.id, healthyIssueId)))[0])
        .toMatchObject({ executionRunId: promoted!.runId, checkoutRunId: null });
      expect((await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${failedIssueId}`,
      )))[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
    } finally {
      await db.execute(sql.raw("DROP TRIGGER test_sibling_promotion_failure ON heartbeat_runs"));
      await db.execute(sql.raw("DROP FUNCTION test_sibling_promotion_failure()"));
      await db.execute(sql.raw("DROP SEQUENCE test_sibling_promotion_faults"));
    }
  });

  it.each([
    ["unscoped", () => ({ wakeReason: "timer" })],
    ["other-issue", () => ({ issueId: randomUUID(), wakeReason: "issue_assigned" })],
  ])("does not use an unresolved %s request header as cancellation or hold authority", async (_label, holderContext) => {
    const { coderAgentId, reviewerAgentId, issueId, holderRunId, client } = await seedStageHandoff(holderContext);
    await db.update(issues).set({
      checkoutRunId: null, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
    }).where(eq(issues.id, issueId));
    const response = await request(client).patch(`/api/issues/${issueId}`).send({
      status: "done", comment: "Review passed without a resolved execution binding.",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ status: "in_review", assigneeAgentId: reviewerAgentId });
    expect((await heartbeat.getRun(holderRunId))?.status).toBe("running");
    await heartbeat.wakeup(reviewerAgentId, {
      source: "automation", reason: "issue_assigned", payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "agent", requestedByActorId: coderAgentId,
    });
    const successors = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.agentId, reviewerAgentId), eq(heartbeatRuns.status, "queued"),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
    ));
    expect(successors).toEqual([expect.objectContaining({ agentId: reviewerAgentId, status: "queued" })]);
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, reviewerAgentId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    ))).toEqual([]);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionRunId).not.toBe(holderRunId);
  });

  it("retains a checkout-only saved handoff without borrowing header cancellation authority", async () => {
    const { coderAgentId, reviewerAgentId, issueId, holderRunId, client } =
      await seedStageHandoff(() => ({ issueId: randomUUID(), wakeReason: "issue_assigned" }));
    await db.update(issues).set({
      checkoutRunId: holderRunId, executionRunId: null,
      executionAgentNameKey: null, executionLockedAt: null,
    }).where(eq(issues.id, issueId));
    const response = await request(client).patch(`/api/issues/${issueId}`).send({
      status: "done", comment: "Review passed with a durable legacy checkout binding.",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await heartbeat.getRun(holderRunId))?.status).toBe("running");
    const [saved] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(saved).toMatchObject({
      status: "in_review", assigneeAgentId: reviewerAgentId,
      checkoutRunId: null, executionRunId: holderRunId,
    });
    await heartbeat.wakeup(reviewerAgentId, {
      source: "automation", reason: "issue_assigned", payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "agent", requestedByActorId: coderAgentId,
    });
    const [deferred] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, reviewerAgentId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
    ));
    expect(deferred).toMatchObject({ status: "deferred_issue_execution", runId: null });
    await heartbeat.cancelRun(holderRunId, "The legacy issuer stopped", { suppressImmediateRecovery: true });
    const [promoted] = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferred!.id));
    expect(promoted).toMatchObject({ status: "queued", reason: "issue_execution_promoted" });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionRunId).toBe(promoted.runId);
  });

  // A resolved issuer without matching issue context still gets the normal
  // post-commit cancellation attempt, even though its admission hold survives.
  it.each([
    ["has no issueId in its context", () => ({ wakeReason: "timer" })],
    ["is scoped to a different issue", () => ({ issueId: randomUUID(), wakeReason: "issue_assigned" })],
  ])("saves the handoff, then cancels an issuing run that %s", async (_label, holderContext) => {
    const { reviewerAgentId, issueId, holderRunId, policy, client } = await seedStageHandoff(holderContext);
    const response = await request(client).patch(`/api/issues/${issueId}`).send({
      status: "done", comment: "Review passed; the next reviewer can continue.",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      executionState: { currentStageId: policy.stages[1]!.id },
    });
    expect((await heartbeat.getRun(holderRunId))?.status).toBe("cancelled");
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ status: "in_review", assigneeAgentId: reviewerAgentId });
    expect(issue.executionRunId).not.toBe(holderRunId);
  });

  it("defers the next stage behind its issuing run after the handoff PATCH and promotes it on stop", async () => {
    const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId, policy, busyRun, client } =
      await seedStageHandoff();
    await db.update(issues).set({
      executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
    }).where(eq(issues.id, issueId));
    const response = await request(client).patch(`/api/issues/${issueId}`).send({
      status: "done", comment: "Review passed; the next reviewer can continue after this run stops.",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      executionState: { currentStageId: policy.stages[1]!.id },
    });
    expect((await heartbeat.getRun(holderRunId))?.status).toBe("running");
    // This legacy binding was already cleared before PATCH. Admission must
    // rediscover its scoped issuer independently of the new assignee.
    await heartbeat.wakeup(reviewerAgentId, {
      source: "automation",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "agent",
      requestedByActorId: coderAgentId,
    });
    const deferred = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, reviewerAgentId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
    ));
    expect(deferred).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "deferred_issue_execution", runId: null }),
    ]));
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionRunId).toBe(holderRunId);
    expect((await heartbeat.getRun(holderRunId))?.status).toBe("running");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(2);

    await heartbeat.cancelRun(holderRunId, "Stage issuer finished", { suppressImmediateRecovery: true });
    expect((await heartbeat.getRun(holderRunId))?.status).toBe("cancelled");
    await vi.waitFor(async () => {
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferred[0]!.id));
      expect(receipt).toMatchObject({ status: "queued", reason: "issue_execution_promoted" });
      const successor = await heartbeat.getRun(receipt.runId!);
      expect(successor).toMatchObject({ agentId: reviewerAgentId, status: "queued", contextSnapshot: { issueId } });
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue.executionRunId).toBe(successor!.id);
    });
    expect((await heartbeat.getRun(busyRun.id))?.status).toBe("running");
  });

  describe("checkout with a cleared execution lock", () => {
    it("refuses successor checkout while the stage-handoff issuer still runs", async () => {
      const { companyId, reviewerAgentId, issueId, holderRunId } =
        await seedCrossAgentScenario({ holderStatus: "running" });
      // Seed the committed handoff shape without a wake repairing its missing
      // execution pointer before checkout can exercise the null-lock path.
      await db.update(issues).set({
        executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
      }).where(eq(issues.id, issueId));
      const [busyRun] = await db.insert(heartbeatRuns).values({
        companyId, agentId: reviewerAgentId, status: "running",
        contextSnapshot: { wakeReason: "timer" },
      }).returning();
      const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(before).toMatchObject({
        assigneeAgentId: reviewerAgentId,
        checkoutRunId: null,
        executionRunId: null,
      });
      expect((await heartbeat.getRun(holderRunId))?.status).toBe("running");

      await expect(issueService(db).checkout(
        issueId, reviewerAgentId, ["in_review"], busyRun.id,
      )).rejects.toMatchObject({ status: 409, message: "Issue checkout conflict" });

      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(after).toMatchObject({
        status: before.status,
        assigneeAgentId: reviewerAgentId,
        checkoutRunId: null,
      });
      expect(after.executionRunId).not.toBe(busyRun.id);
      expect((await heartbeat.getRun(holderRunId))?.status).toBe("running");
    });

    it.each(["checkout", "adoption"])("allows the issuing run ahead of an older queued successor through %s", async (door) => {
      const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId } =
        await seedCrossAgentScenario({ holderStatus: "running" });
      await db.update(issues).set({
        status: door === "adoption" ? "in_progress" : "in_review",
        assigneeAgentId: coderAgentId,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      }).where(eq(issues.id, issueId));
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId: reviewerAgentId,
        status: "queued",
        contextSnapshot: { issueId },
        createdAt: new Date(0),
      });

      const svc = issueService(db);
      const checkedOut = door === "checkout"
        ? await svc.checkout(issueId, coderAgentId, ["in_review"], holderRunId)
        : await svc.assertCheckoutOwner(issueId, coderAgentId, holderRunId);
      expect(checkedOut).toMatchObject({
        id: issueId,
        assigneeAgentId: coderAgentId,
        checkoutRunId: holderRunId,
        executionRunId: holderRunId,
      });
    });

    it.each(["checkout", "adoption"])("allows successor %s after the issuer has finished", async (door) => {
      const { companyId, reviewerAgentId, issueId, holderRunId } =
        await seedCrossAgentScenario({ holderStatus: "running" });
      await db.update(issues).set({
        status: door === "adoption" ? "in_progress" : "in_review",
        executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
      }).where(eq(issues.id, issueId));
      await db.update(heartbeatRuns).set({
        status: "succeeded", finishedAt: new Date(),
      }).where(eq(heartbeatRuns.id, holderRunId));
      const [successor] = await db.insert(heartbeatRuns).values({
        companyId, agentId: reviewerAgentId, status: "running", contextSnapshot: {},
      }).returning();

      const svc = issueService(db);
      const checkedOut = door === "checkout"
        ? await svc.checkout(issueId, reviewerAgentId, ["in_review"], successor.id)
        : await svc.assertCheckoutOwner(issueId, reviewerAgentId, successor.id);
      expect(checkedOut).toMatchObject({
        id: issueId,
        assigneeAgentId: reviewerAgentId,
        checkoutRunId: successor.id,
        executionRunId: successor.id,
      });
    });

    it.each(["checkout", "adoption"])("allows %s on another issue while the issuer runs", async (door) => {
      const { companyId, reviewerAgentId, issueId, holderRunId } =
        await seedCrossAgentScenario({ holderStatus: "running" });
      const svc = issueService(db);
      const otherIssue = await svc.create(companyId, {
        title: "Unrelated checkout", status: door === "adoption" ? "in_progress" : "todo", priority: "medium",
        assigneeAgentId: reviewerAgentId,
      });
      const [otherRun] = await db.insert(heartbeatRuns).values({
        companyId, agentId: reviewerAgentId, status: "running", contextSnapshot: {},
      }).returning();

      const checkedOut = door === "checkout"
        ? await svc.checkout(otherIssue.id, reviewerAgentId, ["todo"], otherRun.id)
        : await svc.assertCheckoutOwner(otherIssue.id, reviewerAgentId, otherRun.id);
      expect(checkedOut).toMatchObject({
        id: otherIssue.id,
        checkoutRunId: otherRun.id,
        executionRunId: otherRun.id,
      });
      const [original] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(original.executionRunId).toBe(holderRunId);
      expect((await heartbeat.getRun(holderRunId))?.status).toBe("running");
    });

    it.each(["checkout", "adoption"])("ignores a foreign-company context holder during %s", async (door) => {
      const { companyId, reviewerAgentId, issueId } = await seedCrossAgentScenario({
        holderStatus: "running", holderContext: () => ({}),
      });
      await db.update(issues).set({
        status: door === "adoption" ? "in_progress" : "in_review",
        executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
      }).where(eq(issues.id, issueId));
      const foreign = await seedCrossAgentScenario({
        holderStatus: "running", holderContext: () => ({ issueId }),
      });
      const [successor] = await db.insert(heartbeatRuns).values({
        companyId, agentId: reviewerAgentId, status: "running", contextSnapshot: {},
      }).returning();

      const svc = issueService(db);
      const checkedOut = door === "checkout"
        ? await svc.checkout(issueId, reviewerAgentId, ["in_review"], successor.id)
        : await svc.assertCheckoutOwner(issueId, reviewerAgentId, successor.id);
      expect(checkedOut).toMatchObject({
        id: issueId,
        checkoutRunId: successor.id,
        executionRunId: successor.id,
      });
      expect((await heartbeat.getRun(foreign.holderRunId))?.status).toBe("running");
    });

    it.each([
      ["no run id", false, true],
      ["an unscoped run", false, false],
      ["another run of the same agent", true, false],
    ] as const)("refuses checkout by %s while a different issue holder runs", async (_label, sameAgent, noRunId) => {
      const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId } =
        await seedCrossAgentScenario({ holderStatus: "running" });
      const actorAgentId = sameAgent ? coderAgentId : reviewerAgentId;
      await db.update(issues).set({
        assigneeAgentId: actorAgentId,
        executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
      }).where(eq(issues.id, issueId));
      const actorRun = noRunId ? null : (await db.insert(heartbeatRuns).values({
        companyId, agentId: actorAgentId, status: "running", contextSnapshot: {},
      }).returning())[0]!;

      await expect(issueService(db).checkout(
        issueId, actorAgentId, ["in_review"], actorRun?.id ?? null,
      )).rejects.toMatchObject({ status: 409 });
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue).toMatchObject({ checkoutRunId: null, executionRunId: null });
      expect((await heartbeat.getRun(holderRunId))?.status).toBe("running");
    });

    it.each(["checkout", "adoption", "stale adoption"])("refuses a foreign-company acting run during %s", async (door) => {
      const { reviewerAgentId, issueId, holderRunId } = await seedCrossAgentScenario({ holderStatus: "running" });
      const foreign = await seedCrossAgentScenario({ holderStatus: "running", holderContext: () => ({}) });
      const staleRun = door === "stale adoption" ? (await db.insert(heartbeatRuns).values({
        companyId: foreign.companyId, agentId: foreign.reviewerAgentId, status: "running", startedAt: new Date(), contextSnapshot: {},
      }).returning())[0]! : null;
      await db.update(issues).set({
        status: door === "checkout" ? "in_review" : "in_progress", checkoutRunId: staleRun?.id ?? null,
        executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
      }).where(eq(issues.id, issueId));
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, holderRunId));

      const svc = issueService(db);
      const acquire = door === "checkout"
        ? svc.checkout(issueId, reviewerAgentId, ["in_review"], foreign.holderRunId)
        : svc.assertCheckoutOwner(issueId, reviewerAgentId, foreign.holderRunId);
      await expect(acquire).rejects.toMatchObject({
        status: 409,
        ...(door !== "checkout" ? { details: { actorRun: null } } : {}),
      });
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue).toMatchObject({ executionRunId: null });
      expect(issue!.checkoutRunId).not.toBe(foreign.holderRunId);
      expect((await heartbeat.getRun(foreign.holderRunId))?.status).toBe("running");
    });

    it.each(["checkout", "adoption"])("refuses a different-issue acting run during %s", async (door) => {
      const { companyId, reviewerAgentId, issueId } = await seedCrossAgentScenario({ holderStatus: "running" });
      await db.update(issues).set({
        status: door === "adoption" ? "in_progress" : "in_review",
        executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
      }).where(eq(issues.id, issueId));
      const otherIssue = await issueService(db).create(companyId, {
        title: "Actor's other issue", status: "todo", priority: "medium", assigneeAgentId: reviewerAgentId,
      });
      const [actorRun] = await db.insert(heartbeatRuns).values({
        companyId, agentId: reviewerAgentId, status: "running", contextSnapshot: { issueId: otherIssue.id },
      }).returning();

      const svc = issueService(db);
      await expect(door === "checkout"
        ? svc.checkout(issueId, reviewerAgentId, ["in_review"], actorRun!.id)
        : svc.assertCheckoutOwner(issueId, reviewerAgentId, actorRun!.id)
      ).rejects.toMatchObject({ status: 409 });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0])
        .toMatchObject({ checkoutRunId: null, executionRunId: null });
      expect((await db.select().from(issues).where(eq(issues.id, otherIssue.id)))[0])
        .toMatchObject({ checkoutRunId: null, executionRunId: null });
    });

    it.each([false, true])("refuses unowned adoption behind a live holder (same agent: %s)", async (sameAgent) => {
      const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId } =
        await seedCrossAgentScenario({ holderStatus: "running" });
      const actorAgentId = sameAgent ? coderAgentId : reviewerAgentId;
      await db.update(issues).set({
        assigneeAgentId: actorAgentId,
        status: "in_progress", executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
      }).where(eq(issues.id, issueId));
      const [actorRun] = await db.insert(heartbeatRuns).values({
        companyId, agentId: actorAgentId, status: "running", contextSnapshot: {},
      }).returning();

      await expect(issueService(db).assertCheckoutOwner(issueId, actorAgentId, actorRun!.id))
        .rejects.toMatchObject({ status: 409 });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0])
        .toMatchObject({ checkoutRunId: null, executionRunId: null });
      expect((await heartbeat.getRun(holderRunId))?.status).toBe("running");
    });

    it.each([false, true])("does not adopt a stale checkout over a live direct holder (same agent: %s)", async (sameAgent) => {
      const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId } =
        await seedCrossAgentScenario({ holderStatus: "running", holderContext: () => ({}) });
      const actorAgentId = sameAgent ? coderAgentId : reviewerAgentId;
      const [staleRun] = await db.insert(heartbeatRuns).values({
        companyId, agentId: actorAgentId, status: "succeeded", finishedAt: new Date(), contextSnapshot: {},
      }).returning();
      const [actorRun] = await db.insert(heartbeatRuns).values({
        companyId, agentId: actorAgentId, status: "running", contextSnapshot: {},
      }).returning();
      await db.update(issues).set({ status: "in_progress", assigneeAgentId: actorAgentId, checkoutRunId: staleRun!.id })
        .where(eq(issues.id, issueId));

      await expect(issueService(db).assertCheckoutOwner(issueId, actorAgentId, actorRun!.id))
        .rejects.toMatchObject({ status: 409 });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0])
        .toMatchObject({ checkoutRunId: staleRun!.id, executionRunId: holderRunId });
      expect((await heartbeat.getRun(holderRunId))?.status).toBe("running");
    });

    it("recovers a foreign-company checkout binding without taking or cancelling its run", async () => {
      const { companyId, reviewerAgentId, issueId, holderRunId } =
        await seedCrossAgentScenario({ holderStatus: "running", holderContext: () => ({}) });
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, holderRunId));
      const foreign = await seedCrossAgentScenario({ holderStatus: "running", holderContext: () => ({}) });
      const [actor] = await db.insert(heartbeatRuns).values({
        companyId, agentId: reviewerAgentId, status: "running", contextSnapshot: {},
      }).returning();
      await db.update(issues).set({
        status: "in_progress", checkoutRunId: foreign.holderRunId, executionRunId: null,
        executionAgentNameKey: null, executionLockedAt: null,
      }).where(eq(issues.id, issueId));
      expect(await issueService(db).assertCheckoutOwner(issueId, reviewerAgentId, actor!.id))
        .toMatchObject({ checkoutRunId: actor!.id, executionRunId: actor!.id });
      expect((await heartbeat.getRun(foreign.holderRunId))?.status).toBe("running");
    });

    it.each(["checkout", "adoption"])("serializes %s with a legacy holder published between its read and stamp", async (door) => {
      const { companyId, reviewerAgentId, issueId, holderRunId } =
        await seedCrossAgentScenario({ holderStatus: "running", holderContext: () => ({}) });
      await db.update(issues).set({
        status: door === "adoption" ? "in_progress" : "in_review",
        executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
      }).where(eq(issues.id, issueId));
      const [actorRun] = await db.insert(heartbeatRuns).values({
        companyId, agentId: reviewerAgentId, status: "running", contextSnapshot: {},
      }).returning();
      const writeBarrier = new EventEmitter();
      const atWrite = once(writeBarrier, "write");
      const continueWrite = once(writeBarrier, "release");

      // Pause only execution of the real checkout UPDATE. No query or service
      // result is supplied by this wrapper; PostgreSQL arbitrates both writers.
      const interceptUpdates = (client: Pick<typeof db, "update">) => {
        const realUpdate = client.update.bind(client);
        client.update = ((table: Parameters<typeof db.update>[0]) => {
          const builder = realUpdate(table);
          const realSet = builder.set.bind(builder);
          builder.set = ((values: Parameters<typeof builder.set>[0]) => {
            const query = realSet(values);
            if (table === issues && "checkoutRunId" in values && values.checkoutRunId === actorRun!.id) {
              const realThen = query.then.bind(query);
              query.then = ((...args: Parameters<typeof query.then>) =>
                Promise.resolve().then(async () => {
                  writeBarrier.emit("write");
                  await continueWrite;
                  return realThen(...args);
                })) as typeof query.then;
            }
            return query;
          }) as typeof builder.set;
          return builder;
        }) as typeof client.update;
      };
      const originalUpdate = db.update;
      const originalTransaction = db.transaction;
      const realTransaction = originalTransaction.bind(db);
      interceptUpdates(db);
      db.transaction = ((work: Parameters<typeof db.transaction>[0], config: Parameters<typeof db.transaction>[1]) =>
        realTransaction(async (tx) => {
          interceptUpdates(tx);
          return work(tx);
        }, config)) as typeof db.transaction;
      const svc = issueService(db);
      const checkout = (door === "checkout"
        ? svc.checkout(issueId, reviewerAgentId, ["in_review"], actorRun!.id)
        : svc.assertCheckoutOwner(issueId, reviewerAgentId, actorRun!.id))
        .then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
      let publishedHolder = false;
      try {
        await Promise.race([atWrite, checkout.then((result) => {
          throw new Error(`Checkout ended before the write barrier: ${JSON.stringify(result)}`);
        })]);
        try {
          await realTransaction(async (tx) => {
            const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId)).for("update", { noWait: true });
            if (issue!.executionRunId !== null) return;
            await tx.update(heartbeatRuns).set({ contextSnapshot: { issueId } })
              .where(eq(heartbeatRuns.id, holderRunId));
            publishedHolder = true;
          });
        } catch (error) {
          const pgError = error && typeof error === "object" && "cause" in error ? error.cause : error;
          if (!pgError || typeof pgError !== "object" || !("code" in pgError) || pgError.code !== "55P03") throw error;
        }
      } finally {
        writeBarrier.emit("release");
        db.update = originalUpdate;
        db.transaction = originalTransaction;
      }
      const result = await checkout;
      expect(publishedHolder && result.value !== null, "checkout must not overlap a newly published live holder").toBe(false);
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      if (publishedHolder) {
        expect(result.error).toMatchObject({ status: 409 });
        expect(issue!.executionRunId).not.toBe(actorRun!.id);
      } else {
        expect(result.error).toBeNull();
        expect(issue!.executionRunId).toBe(actorRun!.id);
      }
    });
  });

  describe("other execution acquisition doors", () => {
    it.each([
      { label: "ordinary", scheduledRetry: false, commentMode: "none", checkoutOnly: false },
      { label: "scheduled retry", scheduledRetry: true, commentMode: "none", checkoutOnly: false },
      { label: "legacy comment", scheduledRetry: false, commentMode: "legacy", checkoutOnly: false },
      { label: "queued comment", scheduledRetry: false, commentMode: "queued", checkoutOnly: false },
      { label: "checkout-only holder", scheduledRetry: false, commentMode: "none", checkoutOnly: true },
    ] as const)("does not claim a prequeued successor behind a live issuer ($label)", async ({ scheduledRetry, commentMode, checkoutOnly }) => {
      const { companyId, reviewerAgentId, issueId, holderRunId } =
        await seedCrossAgentScenario({ holderStatus: "running", holderContext: checkoutOnly ? () => ({}) : undefined });
      const executionDir = await mkdtemp(join(tmpdir(), "issue-acquisition-"));
      await db.update(agents).set({
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: executionDir },
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      }).where(eq(agents.id, reviewerAgentId));
      await db.update(issues).set({
        status: "in_progress", executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
        checkoutRunId: checkoutOnly ? holderRunId : null,
      }).where(eq(issues.id, issueId));
      const successorId = randomUUID();
      const [comment] = commentMode === "none" ? [] : await db.insert(issueComments).values({
        companyId, issueId, authorUserId: "responsible-user", body: "Continue this issue after the current run.",
      }).returning();
      const wakeReason = comment ? "issue_comment" : "issue_assigned";
      const baseContext = { issueId, taskId: issueId, wakeReason };
      const contextSnapshot = comment
        ? withQueuedCommentIdsInRunContext(baseContext, [comment.id])
        : baseContext;
      const payload = commentMode === "queued" && comment
        ? withQueuedCommentIdsInWakePayload({ issueId }, [comment.id])
        : { issueId, ...(comment ? { commentId: comment.id } : {}) };
      const [wake] = await db.insert(agentWakeupRequests).values({
        companyId, agentId: reviewerAgentId, source: "assignment", status: "queued",
        reason: wakeReason, runId: null, payload,
      }).returning();
      await db.insert(heartbeatRuns).values({
        id: successorId, companyId, agentId: reviewerAgentId, status: "queued",
        invocationSource: "assignment", triggerDetail: "system", wakeupRequestId: wake!.id,
        contextSnapshot,
        responsibleUserId: "responsible-user",
        scheduledRetryReason: scheduledRetry ? "process_lost" : null,
        scheduledRetryAt: scheduledRetry ? new Date(0) : null,
      });
      await db.update(agentWakeupRequests).set({ runId: successorId }).where(eq(agentWakeupRequests.id, wake!.id));
      await db.execute(sql`CREATE TABLE test_issue_run_starts (run_id uuid PRIMARY KEY, execution_run_id uuid)`);
      await db.execute(sql`CREATE FUNCTION test_capture_issue_run_start() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO test_issue_run_starts(run_id, execution_run_id)
          SELECT NEW.id, execution_run_id FROM issues WHERE id::text = NEW.context_snapshot->>'issueId'
          ON CONFLICT DO NOTHING;
          RETURN NEW;
        END;
      $$`);
      await db.execute(sql`CREATE CONSTRAINT TRIGGER test_capture_issue_run_start
        AFTER UPDATE ON heartbeat_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        WHEN (NEW.status = 'running' AND OLD.status IS DISTINCT FROM NEW.status)
        EXECUTE FUNCTION test_capture_issue_run_start()`);
      try {
        await heartbeat.resumeQueuedRuns();
        const starts = await db.execute(sql`SELECT run_id FROM test_issue_run_starts WHERE run_id = ${successorId}`);
        expect(Array.from(starts), "successor must not start while its issuer still runs").toEqual([]);
        expect((await heartbeat.getRun(successorId))?.status).toBe("queued");
        expect((await heartbeat.getRun(holderRunId))?.status).toBe("running");
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.executionRunId).toBe(holderRunId);

        await heartbeat.cancelRun(holderRunId, "Issuer finished", { suppressImmediateRecovery: true });
        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();
        expect(Array.from(await db.execute(sql`SELECT run_id, execution_run_id FROM test_issue_run_starts WHERE run_id = ${successorId}`)))
          .toEqual([{ run_id: successorId, execution_run_id: successorId }]);
      } finally {
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
        await db.execute(sql`DROP TRIGGER test_capture_issue_run_start ON heartbeat_runs`);
        await db.execute(sql`DROP FUNCTION test_capture_issue_run_start()`);
        await db.execute(sql`DROP TABLE test_issue_run_starts`);
        await rm(executionDir, { recursive: true, force: true });
      }
    });

    it("serializes ordinary running admission with a legacy holder published before its claim", async () => {
      const { companyId, reviewerAgentId, issueId, holderRunId } =
        await seedCrossAgentScenario({ holderStatus: "running", holderContext: () => ({}) });
      await db.update(agents).set({
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      }).where(eq(agents.id, reviewerAgentId));
      await db.update(issues).set({
        status: "in_progress", executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
      }).where(eq(issues.id, issueId));
      const [successor] = await db.insert(heartbeatRuns).values({
        companyId, agentId: reviewerAgentId, status: "queued", invocationSource: "assignment",
        contextSnapshot: { issueId, wakeReason: "issue_assigned" }, responsibleUserId: "responsible-user",
      }).returning();
      await db.execute(sql`CREATE TABLE test_atomic_claim_starts (run_id uuid PRIMARY KEY)`);
      await db.execute(sql`CREATE FUNCTION test_atomic_claim_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(19568);
          INSERT INTO test_atomic_claim_starts(run_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
          RETURN NEW;
        END;
      $$`);
      await db.execute(sql`CREATE TRIGGER test_atomic_claim_barrier
        BEFORE UPDATE OF status ON heartbeat_runs FOR EACH ROW
        WHEN (NEW.status = 'running' AND OLD.status IS DISTINCT FROM NEW.status)
        EXECUTE FUNCTION test_atomic_claim_barrier()`);
      const barrier = new EventEmitter();
      const locked = once(barrier, "locked");
      const release = once(barrier, "release");
      const holder = db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(19568)`);
        barrier.emit("locked");
        await release;
      });
      await locked;
      const resume = heartbeat.resumeQueuedRuns();
      let publishedHolder = false;
      try {
        await vi.waitFor(async () => {
          const waiters = await db.execute(sql`
            SELECT pid FROM pg_stat_activity WHERE datname = current_database()
              AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND wait_event = 'advisory'
          `);
          expect(Array.from(waiters)).toHaveLength(1);
        }, { timeout: 5_000, interval: 20 });
        try {
          await db.transaction(async (tx) => {
            const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId)).for("update", { noWait: true });
            if (issue!.executionRunId !== null) return;
            await tx.update(heartbeatRuns).set({ contextSnapshot: { issueId } })
              .where(eq(heartbeatRuns.id, holderRunId));
            publishedHolder = true;
          });
        } catch (error) {
          const pgError = error && typeof error === "object" && "cause" in error ? error.cause : error;
          if (!pgError || typeof pgError !== "object" || !("code" in pgError) || pgError.code !== "55P03") throw error;
        }
        barrier.emit("release");
        await holder;
        await resume;
        const starts = Array.from(await db.execute(sql`
          SELECT run_id FROM test_atomic_claim_starts WHERE run_id = ${successor!.id}
        `));
        expect(publishedHolder && starts.some((row) => row.run_id === successor!.id),
          "running admission must not overlap a legacy holder published after its lookup").toBe(false);
        expect(starts).toEqual([{ run_id: successor!.id }]);
      } finally {
        barrier.emit("release");
        await holder;
        await resume;
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
        await db.execute(sql`DROP TRIGGER test_atomic_claim_barrier ON heartbeat_runs`);
        await db.execute(sql`DROP FUNCTION test_atomic_claim_barrier()`);
        await db.execute(sql`DROP TABLE test_atomic_claim_starts`);
      }
    }, 30_000);

    it("keeps a replacement queued when checkout changes after its preclaim check", async () => {
      const { companyId, reviewerAgentId, issueId, holderRunId, wakeupRequestId } =
        await seedCrossAgentScenario({ holderStatus: "running", holderContext: (id) => ({ issueId: id }) });
      await db.update(heartbeatRuns).set({
        status: "succeeded", agentId: reviewerAgentId, finishedAt: new Date(),
      }).where(eq(heartbeatRuns.id, holderRunId));
      await db.update(agentWakeupRequests).set({
        agentId: reviewerAgentId, status: "claimed", runId: holderRunId,
        requestedByActorType: "user", requestedByActorId: "local-board",
      }).where(eq(agentWakeupRequests.id, wakeupRequestId));
      await db.update(agents).set({
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      }).where(eq(agents.id, reviewerAgentId));
      await db.update(issues).set({
        status: "in_progress", executionRunId: null, checkoutRunId: null,
        executionAgentNameKey: null, executionLockedAt: null,
      }).where(eq(issues.id, issueId));
      const [comment] = await db.insert(issueComments).values({
        companyId, issueId, authorUserId: "responsible-user", body: "Keep my pending request in the replacement.",
      }).returning();
      const context = withQueuedCommentIdsInRunContext({
        issueId, wakeReason: "native_safe_replacement",
        retryReason: "native_safe_replacement", forceFreshSession: true,
      }, [comment!.id]);
      const [wake] = await db.insert(agentWakeupRequests).values({
        companyId, agentId: reviewerAgentId, source: "automation", status: "queued",
        reason: "native_safe_replacement",
        payload: withQueuedCommentIdsInWakePayload({ issueId }, [comment!.id]),
      }).returning();
      const [replacement] = await db.insert(heartbeatRuns).values({
        companyId, agentId: reviewerAgentId, status: "queued", invocationSource: "automation",
        scheduledRetryReason: "native_safe_replacement", scheduledRetryAt: new Date(0),
        wakeupRequestId: wake!.id, retryOfRunId: holderRunId,
        responsibleUserId: "responsible-user", contextSnapshot: context,
      }).returning();
      await db.update(agentWakeupRequests).set({ runId: replacement!.id })
        .where(eq(agentWakeupRequests.id, wake!.id));
      await db.execute(sql`CREATE TABLE test_replacement_claims (run_id uuid PRIMARY KEY)`);
      await db.execute(sql`CREATE FUNCTION test_capture_replacement_claim() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO test_replacement_claims VALUES (NEW.id);
          RETURN NEW;
        END;
      $$`);
      await db.execute(sql`CREATE CONSTRAINT TRIGGER test_capture_replacement_claim
        AFTER UPDATE ON heartbeat_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        WHEN (NEW.status = 'running' AND OLD.status IS DISTINCT FROM NEW.status)
        EXECUTE FUNCTION test_capture_replacement_claim()`);
      const replacementHeartbeat = heartbeatService(db, {
        beforeChatControlRecoveryCheck: async ({ runId, stage }) => {
          if (runId !== replacement!.id || stage !== "claim") return;
          // This real DB mutation is after queue validation and before the
          // claim transaction, at the existing admission race boundary.
          await db.update(issues).set({ checkoutRunId: holderRunId }).where(eq(issues.id, issueId));
        },
      });
      try {
        await replacementHeartbeat.resumeQueuedRuns();
        await replacementHeartbeat.drainActiveRunExecutions();
        expect(Array.from(await db.execute(sql`
          SELECT run_id FROM test_replacement_claims WHERE run_id = ${replacement!.id}
        `))).toEqual([]);
        expect(await replacementHeartbeat.getRun(replacement!.id)).toMatchObject({ status: "queued", startedAt: null });
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0])
          .toMatchObject({ checkoutRunId: holderRunId, executionRunId: null });
      } finally {
        await drainHeartbeatRunsToQuiescence(db, replacementHeartbeat);
        await db.execute(sql`DROP TRIGGER test_capture_replacement_claim ON heartbeat_runs`);
        await db.execute(sql`DROP FUNCTION test_capture_replacement_claim()`);
        await db.execute(sql`DROP TABLE test_replacement_claims`);
      }
    }, 30_000);

    it("defers ordinary work and commits exactly one stamp with its locked claim", async () => {
      const { companyId, reviewerAgentId, issueId, holderRunId } =
        await seedCrossAgentScenario({ holderStatus: "running" });
      await db.update(agents).set({
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      }).where(eq(agents.id, reviewerAgentId));
      await db.update(issues).set({
        status: "in_progress", executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
      }).where(eq(issues.id, issueId));
      const [successor] = await db.insert(heartbeatRuns).values({
        companyId, agentId: reviewerAgentId, status: "queued", invocationSource: "assignment",
        contextSnapshot: { issueId, wakeReason: "issue_assigned" }, responsibleUserId: "responsible-user",
      }).returning();
      await db.execute(sql`CREATE TABLE test_composed_claims (
        run_id uuid PRIMARY KEY, execution_run_id uuid, claim_txid bigint,
        stamp_count integer, same_transaction boolean
      )`);
      await db.execute(sql`CREATE TABLE test_composed_stamps (run_id uuid, stamp_txid bigint)`);
      await db.execute(sql`CREATE FUNCTION test_capture_composed_claim() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO test_composed_claims
          SELECT NEW.id, issue.execution_run_id, txid_current(), stamp.stamp_count, stamp.same_transaction
          FROM issues issue CROSS JOIN (
            SELECT count(*)::int AS stamp_count,
              bool_and(stamp_txid = txid_current()) AS same_transaction
            FROM test_composed_stamps WHERE run_id = NEW.id
          ) stamp
          WHERE issue.id::text = NEW.context_snapshot->>'issueId' AND issue.company_id = NEW.company_id;
          RETURN NEW;
        END;
      $$`);
      // Freeze the admission-commit boundary, not later run-lifecycle writes.
      await db.execute(sql`CREATE CONSTRAINT TRIGGER test_capture_composed_claim
        AFTER UPDATE ON heartbeat_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        WHEN (NEW.status = 'running' AND OLD.status IS DISTINCT FROM NEW.status)
        EXECUTE FUNCTION test_capture_composed_claim()`);
      await db.execute(sql`CREATE FUNCTION test_capture_composed_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.execution_run_id IS NOT NULL THEN
            INSERT INTO test_composed_stamps VALUES (NEW.execution_run_id, txid_current());
          END IF;
          RETURN NEW;
        END;
      $$`);
      await db.execute(sql`CREATE TRIGGER test_capture_composed_stamp
        AFTER UPDATE OF execution_run_id ON issues FOR EACH ROW EXECUTE FUNCTION test_capture_composed_stamp()`);
      await db.execute(sql`CREATE FUNCTION test_composed_claim_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(68421);
          RETURN NEW;
        END;
      $$`);
      await db.execute(sql`CREATE TRIGGER test_composed_claim_barrier
        BEFORE UPDATE OF status ON heartbeat_runs FOR EACH ROW
        WHEN (NEW.status = 'running' AND OLD.status IS DISTINCT FROM NEW.status)
        EXECUTE FUNCTION test_composed_claim_barrier()`);
      let resume: Promise<unknown> | undefined;
      let holder: Promise<unknown> | undefined;
      const barrier = new EventEmitter();
      try {
        await heartbeat.resumeQueuedRuns();
        expect(await heartbeat.getRun(successor!.id)).toMatchObject({ status: "queued", startedAt: null });
        expect(await heartbeat.getRun(holderRunId)).toMatchObject({ status: "running" });
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.executionRunId).toBe(holderRunId);
        expect(Array.from(await db.execute(sql`SELECT * FROM test_composed_claims`))).toEqual([]);
        await heartbeat.cancelRun(holderRunId, "Issuer finished", { suppressImmediateRecovery: true });
        const locked = once(barrier, "locked");
        const release = once(barrier, "release");
        holder = db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(68421)`);
          barrier.emit("locked");
          await release;
        });
        await locked;
        resume = heartbeat.resumeQueuedRuns();
        await vi.waitFor(async () => {
          expect(Array.from(await db.execute(sql`
            SELECT pid FROM pg_stat_activity WHERE datname = current_database()
              AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND wait_event = 'advisory'
          `))).toHaveLength(1);
        }, { timeout: 5_000, interval: 20 });
        let issueLocked = false;
        try {
          await db.transaction(async (tx) => {
            await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update", { noWait: true });
          });
        } catch (error) {
          const pgError = error && typeof error === "object" && "cause" in error ? error.cause : error;
          if (!pgError || typeof pgError !== "object" || !("code" in pgError) || pgError.code !== "55P03") throw error;
          issueLocked = true;
        }
        barrier.emit("release");
        await holder;
        await resume;
        await heartbeat.drainActiveRunExecutions();
        expect(issueLocked, "running admission must hold the issue row until claim and stamp commit").toBe(true);
        expect(Array.from(await db.execute(sql`
          SELECT execution_run_id, stamp_count, same_transaction
          FROM test_composed_claims WHERE run_id = ${successor!.id}
        `))).toEqual([{ execution_run_id: successor!.id, stamp_count: 1, same_transaction: true }]);
      } finally {
        barrier.emit("release");
        await holder;
        await resume;
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
        await db.execute(sql`DROP TRIGGER test_composed_claim_barrier ON heartbeat_runs`);
        await db.execute(sql`DROP FUNCTION test_composed_claim_barrier()`);
        await db.execute(sql`DROP TRIGGER test_capture_composed_claim ON heartbeat_runs`);
        await db.execute(sql`DROP FUNCTION test_capture_composed_claim()`);
        await db.execute(sql`DROP TRIGGER test_capture_composed_stamp ON issues`);
        await db.execute(sql`DROP FUNCTION test_capture_composed_stamp()`);
        await db.execute(sql`DROP TABLE test_composed_claims, test_composed_stamps`);
      }
    }, 30_000);

    it("does not resurrect an ordinary queued run cancelled before its claim commits", async () => {
      const { companyId, reviewerAgentId, issueId, holderRunId } =
        await seedCrossAgentScenario({ holderStatus: "running" });
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, holderRunId));
      const executionDir = await mkdtemp(join(tmpdir(), "claim-cancel-"));
      const dispatchedPath = join(executionDir, "dispatched");
      await db.update(agents).set({
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'dispatched')", dispatchedPath],
          cwd: executionDir,
        },
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      }).where(eq(agents.id, reviewerAgentId));
      const [wake] = await db.insert(agentWakeupRequests).values({
        companyId, agentId: reviewerAgentId, source: "assignment", status: "queued",
        reason: "issue_assigned", payload: { issueId },
      }).returning();
      const [queued] = await db.insert(heartbeatRuns).values({
        companyId, agentId: reviewerAgentId, status: "queued", invocationSource: "assignment",
        wakeupRequestId: wake!.id, responsibleUserId: "responsible-user",
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      }).returning();
      await db.update(agentWakeupRequests).set({ runId: queued!.id })
        .where(eq(agentWakeupRequests.id, wake!.id));
      await db.update(issues).set({
        status: "in_progress", checkoutRunId: queued!.id, executionRunId: queued!.id,
        executionAgentNameKey: "reviewer", executionLockedAt: new Date(),
      }).where(eq(issues.id, issueId));
      await db.execute(sql`CREATE TABLE test_cancelled_claims (kind text, run_id uuid)`);
      await db.execute(sql`CREATE FUNCTION test_capture_cancelled_claim() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO test_cancelled_claims VALUES ('running', NEW.id);
          RETURN NEW;
        END;
      $$`);
      await db.execute(sql`CREATE TRIGGER test_capture_cancelled_claim
        AFTER UPDATE OF status ON heartbeat_runs FOR EACH ROW
        WHEN (NEW.status = 'running' AND OLD.status IS DISTINCT FROM NEW.status)
        EXECUTE FUNCTION test_capture_cancelled_claim()`);
      await db.execute(sql`CREATE FUNCTION test_capture_cancelled_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO test_cancelled_claims VALUES ('stamp', NEW.execution_run_id);
          RETURN NEW;
        END;
      $$`);
      await db.execute(sql`CREATE TRIGGER test_capture_cancelled_stamp
        AFTER UPDATE OF execution_run_id ON issues FOR EACH ROW
        WHEN (NEW.execution_run_id IS NOT NULL)
        EXECUTE FUNCTION test_capture_cancelled_stamp()`);
      // A separate application identifies only this claim's backend, without
      // depending on SQL text or interfering with the real cancellation client.
      const applicationName = `claim-cancel-${queued!.id}`;
      const claimDb = createDb(tempDb!.connectionString, { applicationName, maxConnections: 1 });
      const claimingHeartbeat = heartbeatService(claimDb);
      const barrier = new EventEmitter();
      const locked = once(barrier, "locked");
      const release = once(barrier, "release");
      let barrierPid = 0;
      const holder = db.transaction(async (tx) => {
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
        const [backend] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        barrierPid = Number(backend!.pid);
        barrier.emit("locked");
        await release;
      });
      let resume: Promise<void> | undefined;
      let cancel: Promise<unknown> | undefined;
      try {
        await locked;
        resume = claimingHeartbeat.resumeQueuedRuns();
        await vi.waitFor(async () => {
          const waiters = await db.execute(sql`
            SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND application_name = ${applicationName}
              AND wait_event_type = 'Lock' AND ${barrierPid} = ANY(pg_blocking_pids(pid))
          `);
          expect(Array.from(waiters), "ordinary claim reached its issue lock after reading the queued run").toHaveLength(1);
        }, { timeout: 5_000, interval: 20 });
        // Cancel commits the run and wake status before its issue cleanup waits
        // on the same barrier. The claim now holds a stale queued snapshot.
        cancel = heartbeat.cancelRun(queued!.id, "Cancelled during ordinary claim", { suppressImmediateRecovery: true });
        await vi.waitFor(async () => {
          expect(await heartbeat.getRun(queued!.id)).toMatchObject({
            status: "cancelled", startedAt: null, error: "Cancelled during ordinary claim", errorCode: "cancelled",
          });
          expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id)))[0])
            .toMatchObject({ status: "cancelled", error: "Cancelled during ordinary claim" });
        }, { timeout: 5_000, interval: 20 });
        const [cancelledRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
        const [cancelledWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id));
        barrier.emit("release");
        await holder;
        await Promise.all([resume, cancel]);
        await claimingHeartbeat.drainActiveRunExecutions();
        // Capture committed transitions, not just the final status: later
        // cancellation cleanup must not hide a claim or stamp that escaped.
        expect(Array.from(await db.execute(sql`
          SELECT kind, run_id FROM test_cancelled_claims WHERE run_id = ${queued!.id}
        `)), "cancelled run must not be claimed as running or take an execution stamp").toEqual([]);
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id)))[0]).toEqual(cancelledRun);
        expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id)))[0]).toEqual(cancelledWake);
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({
          checkoutRunId: null, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
        });
        expect(cancelledRun!.runnerProfileJson?.adapterDispatch).toBeUndefined();
        await expect(readFile(dispatchedPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        barrier.emit("release");
        await holder;
        await resume;
        await cancel;
        await drainHeartbeatRunsToQuiescence(db, claimingHeartbeat);
        await claimDb.$client.end({ timeout: 5 });
        await db.execute(sql`DROP TRIGGER test_capture_cancelled_claim ON heartbeat_runs`);
        await db.execute(sql`DROP FUNCTION test_capture_cancelled_claim()`);
        await db.execute(sql`DROP TRIGGER test_capture_cancelled_stamp ON issues`);
        await db.execute(sql`DROP FUNCTION test_capture_cancelled_stamp()`);
        await db.execute(sql`DROP TABLE test_cancelled_claims`);
        await rm(executionDir, { recursive: true, force: true });
      }
    }, 30_000);

    it("refuses external self-declared work behind a context-only issuer without creating a run", async () => {
      const { companyId, reviewerAgentId, issueId, holderRunId } =
        await seedCrossAgentScenario({ holderStatus: "running" });
      const executionDir = await mkdtemp(join(tmpdir(), "self-declared-acquisition-"));
      await db.update(agents).set({
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: executionDir },
        runtimeConfig: { workDelivery: "external_pull" },
      }).where(eq(agents.id, reviewerAgentId));
      await db.update(issues).set({
        status: "todo", executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
      }).where(eq(issues.id, issueId));
      try {
        await expect(selfDeclaredRunService(db).openSelfDeclaredRun(issueId, reviewerAgentId))
          .rejects.toMatchObject({ status: 409 });
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0])
          .toMatchObject({ status: "todo", checkoutRunId: null, executionRunId: null });
        expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, reviewerAgentId),
          eq(heartbeatRuns.invocationSource, "self_declared"),
        ))).toEqual([]);
        expect((await heartbeat.getRun(holderRunId))?.status).toBe("running");
      } finally {
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
        await rm(executionDir, { recursive: true, force: true });
      }
    });

    it("allows only one of two concurrent external sessions to acquire the issue", async () => {
      const { companyId, reviewerAgentId, issueId, holderRunId } =
        await seedCrossAgentScenario({ holderStatus: "running" });
      const executionDir = await mkdtemp(join(tmpdir(), "self-declared-race-"));
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, holderRunId));
      await db.update(agents).set({
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: executionDir },
        runtimeConfig: { workDelivery: "external_pull" },
      }).where(eq(agents.id, reviewerAgentId));
      await db.update(issues).set({
        status: "todo", executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
      }).where(eq(issues.id, issueId));
      const barrier = new EventEmitter();
      const tableLocked = once(barrier, "locked");
      const releaseTable = once(barrier, "release");
      const tableBarrier = db.transaction(async (tx) => {
        // Both old acquisitions can pass their issue UPDATE before either
        // inserts a run. A correct transaction keeps the second behind the first.
        await tx.execute(sql`LOCK TABLE heartbeat_runs IN SHARE MODE`);
        barrier.emit("locked");
        await releaseTable;
      });
      await tableLocked;
      const sessions = selfDeclaredRunService(db);
      const settled = Promise.allSettled([
        sessions.openSelfDeclaredRun(issueId, reviewerAgentId),
        sessions.openSelfDeclaredRun(issueId, reviewerAgentId),
      ]);
      try {
        await vi.waitFor(async () => {
          const waiters = await db.execute(sql`
            SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND (query ILIKE '%heartbeat_runs%' OR query ILIKE '%issues%')
          `);
          expect(Array.from(waiters)).toHaveLength(2);
        }, { timeout: 5_000, interval: 20 });
        barrier.emit("release");
        await tableBarrier;
        const outcomes = await settled;
        const succeeded = outcomes.filter((result) => result.status === "fulfilled");
        const failed = outcomes.filter((result) => result.status === "rejected");
        expect(failed.map((result) => result.reason)).toEqual([expect.objectContaining({ status: 409 })]);
        expect(succeeded).toHaveLength(1);
        const winnerId = succeeded[0]!.value.runId;
        const activeSessions = await db.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, reviewerAgentId),
          eq(heartbeatRuns.invocationSource, "self_declared"),
          eq(heartbeatRuns.status, "running"),
        ));
        expect(activeSessions).toEqual([expect.objectContaining({
          id: winnerId, contextSnapshot: expect.objectContaining({ issueId }),
        })]);
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0])
          .toMatchObject({ checkoutRunId: winnerId, executionRunId: winnerId });
      } finally {
        barrier.emit("release");
        await tableBarrier;
        await settled;
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
        await rm(executionDir, { recursive: true, force: true });
      }
    });

    it.each([
      { handoff: false, sibling: false },
      { handoff: true, sibling: false },
      { handoff: false, sibling: true },
    ])("keeps missing-comment recovery behind existing ownership (handoff=$handoff,sibling=$sibling)", async ({ handoff, sibling }) => {
      const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId } =
        await seedCrossAgentScenario({ holderStatus: "running", holderContext: () => ({}) });
      const executionDir = await mkdtemp(join(tmpdir(), "missing-comment-ownership-"));
      const enteredPath = join(executionDir, "entered");
      const finishPath = join(executionDir, "finish");
      const siblingId = sibling ? randomUUID() : null;
      const program = `
        const fs = require("node:fs");
        const watcher = fs.watch(require("node:path").dirname(process.argv[2]), () => {
          if (!fs.existsSync(process.argv[2])) return;
          watcher.close();
          process.exit(0);
        });
        fs.writeFileSync(process.argv[1], "entered");
      `;
      await db.update(agents).set({
        adapterConfig: { command: process.execPath, args: ["-e", program, enteredPath, finishPath], cwd: executionDir },
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      }).where(eq(agents.id, reviewerAgentId));
      await db.update(agents).set({
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      }).where(eq(agents.id, coderAgentId));
      await db.update(issues).set({
        status: "in_progress", executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
      }).where(eq(issues.id, issueId));
      try {
        const finisher = await heartbeat.wakeup(reviewerAgentId, {
          source: "assignment", reason: "issue_assigned", payload: { issueId },
          contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
          requestedByActorType: "user", requestedByActorId: "responsible-user",
        });
        expect(finisher?.agentId).toBe(reviewerAgentId);
        await vi.waitFor(async () => {
          expect(await readFile(enteredPath, "utf8")).toBe("entered");
        }, { timeout: 10_000, interval: 20 });
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.executionRunId).toBe(finisher!.id);
        const [busy] = await db.insert(heartbeatRuns).values({
          companyId, agentId: reviewerAgentId, status: "running",
          contextSnapshot: { issueId: randomUUID() }, startedAt: new Date(),
        }).returning();
        await db.update(agents).set({
          runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        }).where(eq(agents.id, reviewerAgentId));
        if (handoff) {
          await issueService(db).update(issueId, { assigneeAgentId: coderAgentId });
          await heartbeat.wakeup(coderAgentId, {
            source: "assignment", reason: "issue_assigned", payload: { issueId },
            contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
            requestedByActorType: "user", requestedByActorId: "responsible-user",
          });
        } else if (siblingId) {
          await db.transaction(async (tx) => {
            await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
            await tx.insert(issues).values({
              id: siblingId, companyId, title: "Legacy sibling binding", status: "in_progress", priority: "medium",
              assigneeAgentId: reviewerAgentId, executionRunId: finisher!.id, checkoutRunId: finisher!.id,
              issueNumber: 2, identifier: "LEGACY-2",
            });
            await tx.update(issues).set({
              assigneeAgentId: coderAgentId, executionRunId: holderRunId, executionAgentNameKey: "coder",
              executionLockedAt: new Date(), checkoutRunId: null,
            }).where(eq(issues.id, issueId));
          });
        } else {
          // Publish the legacy holder while the real finisher is in its child
          // process. The producer must check this third holder when it finishes.
          await db.transaction(async (tx) => {
            await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
            await tx.update(heartbeatRuns).set({ contextSnapshot: { issueId } })
              .where(eq(heartbeatRuns.id, holderRunId));
          });
        }
        await writeFile(finishPath, "finish");
        await heartbeat.drainActiveRunExecutions();
        expect((await heartbeat.getRun(finisher!.id))?.status).toBe("succeeded");
        const retries = await db.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, finisher!.id),
          sql`${heartbeatRuns.contextSnapshot}->>'retryReason' = 'missing_issue_comment'`,
        ));
        if (handoff) {
          expect(retries, "a former assignee must not reclaim the new stage through a comment retry").toEqual([]);
          const [promoted] = await db.select().from(agentWakeupRequests).where(and(
            eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, coderAgentId),
            sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
          ));
          expect(promoted).toMatchObject({ status: "queued", reason: "issue_execution_promoted" });
          expect(await heartbeat.getRun(promoted!.runId!)).toMatchObject({ agentId: coderAgentId, status: "queued" });
        } else if (siblingId) {
          expect(retries, "a sibling binding cannot authorize a retry on the former context issue").toEqual([]);
          expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.executionRunId).toBe(holderRunId);
          expect((await db.select().from(issues).where(eq(issues.id, siblingId)))[0])
            .toMatchObject({ executionRunId: null, checkoutRunId: null });
        } else {
          expect((await heartbeat.getRun(finisher!.id))?.issueCommentStatus).toBe("retry_queued");
          expect(retries).toEqual([expect.objectContaining({
            agentId: reviewerAgentId, status: "queued", startedAt: null,
          })]);
          expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.executionRunId).toBe(holderRunId);
          expect((await heartbeat.getRun(holderRunId))?.status).toBe("running");
          await heartbeat.cancelRun(holderRunId, "Issuer stopped", { suppressImmediateRecovery: true });
          await heartbeat.cancelRun(busy!.id, "Other slot freed", { suppressImmediateRecovery: true });
          await heartbeat.resumeQueuedRuns();
          await heartbeat.drainActiveRunExecutions();
          expect((await heartbeat.getRun(retries[0]!.id))?.startedAt).toBeInstanceOf(Date);
        }
      } finally {
        await writeFile(finishPath, "finish");
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
        await rm(executionDir, { recursive: true, force: true });
      }
    }, 30_000);
  });

  describe("release behind another live execution holder", () => {
    it("keeps a deferred successor behind the live issuer when an older run finalizes", async () => {
      const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId } = await seedStageHandoff();
      await db.update(issues).set({
        status: "in_progress", assigneeAgentId: reviewerAgentId, executionPolicy: null, executionState: null,
        executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
      }).where(eq(issues.id, issueId));
      const [finished] = await db.insert(heartbeatRuns).values({
        companyId, agentId: coderAgentId, status: "succeeded", invocationSource: "assignment",
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        startedAt: new Date(), finishedAt: new Date(), responsibleUserId: "responsible-user",
      }).returning();
      const [wake] = await db.insert(agentWakeupRequests).values({
        companyId, agentId: reviewerAgentId, source: "automation", status: "deferred_issue_execution",
        reason: "issue_assigned", payload: { issueId }, requestedByActorType: "user",
        requestedByActorId: "responsible-user",
      }).returning();

      await heartbeat.releaseIssueExecutionAndPromote(finished!, { suppressImmediateRecovery: true });
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id)))[0])
        .toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.executionRunId).toBe(holderRunId);
      expect((await heartbeat.getRun(holderRunId))?.status).toBe("running");

      await heartbeat.cancelRun(holderRunId, "Issuer stopped", { suppressImmediateRecovery: true });
      const [promoted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id));
      expect(promoted).toMatchObject({ status: "queued", reason: "issue_execution_promoted" });
      expect(await heartbeat.getRun(promoted!.runId!))
        .toMatchObject({ agentId: reviewerAgentId, status: "queued", contextSnapshot: { issueId } });
    });

    it("retains review recovery intent without replacing another live holder", async () => {
      const { companyId, reviewerAgentId, issueId, holderRunId, policy, busyRun } = await seedStageHandoff();
      await db.update(issues).set({
        assigneeAgentId: reviewerAgentId, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
        executionState: {
          status: "pending", currentStageId: policy.stages[1]!.id, currentStageIndex: 1,
          currentStageType: "review", currentParticipant: policy.stages[1]!.participants[0],
          returnAssignee: { type: "agent", agentId: reviewerAgentId }, completedStageIds: [policy.stages[0]!.id],
          lastDecisionId: null, lastDecisionOutcome: null,
        },
      }).where(eq(issues.id, issueId));
      await db.update(agents).set({
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      }).where(eq(agents.id, reviewerAgentId));
      const [finished] = await db.insert(heartbeatRuns).values({
        companyId, agentId: reviewerAgentId, status: "succeeded", invocationSource: "assignment",
        contextSnapshot: { issueId, wakeReason: "execution_review_requested" },
        startedAt: new Date(), finishedAt: new Date(), responsibleUserId: "responsible-user",
      }).returning();

      await heartbeat.releaseIssueExecutionAndPromote(finished!);
      const receipts = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, reviewerAgentId),
        sql`${agentWakeupRequests.payload}->>'retryOfRunId' = ${finished!.id}`,
      ));
      expect(receipts).toEqual([expect.objectContaining({
        agentId: reviewerAgentId, status: expect.stringMatching(/^(queued|deferred_issue_execution)$/),
      })]);
      if (receipts[0]!.runId) {
        expect(await heartbeat.getRun(receipts[0]!.runId!))
          .toMatchObject({ agentId: reviewerAgentId, status: "queued", startedAt: null });
      } else {
        expect(receipts[0]!.status).toBe("deferred_issue_execution");
      }
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.executionRunId).toBe(holderRunId);
      expect((await heartbeat.getRun(holderRunId))?.status).toBe("running");

      await heartbeat.cancelRun(holderRunId, "Issuer stopped", { suppressImmediateRecovery: true });
      await heartbeat.cancelRun(busyRun!.id, "Other slot freed", { suppressImmediateRecovery: true });
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const [resumed] = await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, receipts[0]!.id));
      expect((await heartbeat.getRun(resumed!.runId!))?.startedAt).toBeInstanceOf(Date);
    });

    it("retains immediate recovery intent behind a checkout-only live holder", async () => {
      const { companyId, reviewerAgentId, issueId, holderRunId, busyRun } = await seedStageHandoff(() => ({}));
      await db.update(issues).set({
        status: "in_progress", assigneeAgentId: reviewerAgentId, executionPolicy: null, executionState: null,
        checkoutRunId: holderRunId, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
      }).where(eq(issues.id, issueId));
      await db.update(agents).set({
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      }).where(eq(agents.id, reviewerAgentId));
      const [finished] = await db.insert(heartbeatRuns).values({
        companyId, agentId: reviewerAgentId, status: "failed", invocationSource: "assignment",
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        startedAt: new Date(), finishedAt: new Date(), responsibleUserId: "responsible-user",
      }).returning();

      await heartbeat.releaseIssueExecutionAndPromote(finished!);
      const receipts = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, reviewerAgentId),
        sql`${agentWakeupRequests.payload}->>'retryOfRunId' = ${finished!.id}`,
      ));
      expect(receipts).toEqual([expect.objectContaining({ agentId: reviewerAgentId, status: "queued" })]);
      expect(await heartbeat.getRun(receipts[0]!.runId!))
        .toMatchObject({ agentId: reviewerAgentId, status: "queued", startedAt: null });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0])
        .toMatchObject({ executionRunId: holderRunId, checkoutRunId: holderRunId });
      expect((await heartbeat.getRun(holderRunId))?.status).toBe("running");

      await heartbeat.cancelRun(holderRunId, "Issuer stopped", { suppressImmediateRecovery: true });
      await heartbeat.cancelRun(busyRun!.id, "Other slot freed", { suppressImmediateRecovery: true });
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      expect((await heartbeat.getRun(receipts[0]!.runId!))?.startedAt).toBeInstanceOf(Date);
    });
  });

  it("defers a cross-agent wake while the holder is still running and leaves the holder alone", async () => {
    const { coderAgentId, reviewerAgentId, issueId, holderRunId, wakeupRequestId } =
      await seedCrossAgentScenario({ holderStatus: "running" });

    const heartbeat = heartbeatService(db);
    const followupRun = await heartbeat.wakeup(reviewerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(followupRun).toBeNull();

    const holder = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        agentId: heartbeatRuns.agentId,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, holderRunId))
      .then((rows) => rows[0] ?? null);

    expect(holder?.status).toBe("running");
    expect(holder?.errorCode).toBeNull();
    expect(holder?.finishedAt).toBeNull();
    expect(holder?.agentId).toBe(coderAgentId);

    const heldWakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);

    expect(heldWakeup?.status).toBe("queued");

    const deferred = await db
      .select({ status: agentWakeupRequests.status, agentId: agentWakeupRequests.agentId })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, reviewerAgentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    expect(deferred).not.toBeNull();

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue?.executionRunId).toBe(holderRunId);
  });

  it("cancels a queued holder's run on reassignment and emits agent.task_run for it", async () => {
    const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId } =
      await seedCrossAgentScenario({ holderStatus: "queued" });

    // Keep the reviewer's queue from auto-claiming/executing the new run
    // during this unit test, matching the pattern used for the sibling
    // reassignment scenario in heartbeat-retry-scheduling.test.ts: cap
    // concurrency at 1, then occupy that one slot with a busy run.
    await db
      .update(agents)
      .set({
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      })
      .where(eq(agents.id, reviewerAgentId));
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: reviewerAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { wakeReason: "test_busy_slot" },
      startedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const newAssigneeRun = await heartbeat.wakeup(reviewerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(newAssigneeRun).not.toBeNull();
    expect(newAssigneeRun?.agentId).toBe(reviewerAgentId);
    expect(newAssigneeRun?.status).toBe("queued");

    const holder = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, holderRunId))
      .then((rows) => rows[0] ?? null);

    expect(holder).toEqual({
      status: "cancelled",
      errorCode: "lock_released_on_reassignment",
    });

    // The cancel runs inside enqueueWakeup's transaction, and the run's own
    // required lifecycle work never awaits the telemetry emission, so wait
    // for it here instead of asserting it fired synchronously.
    await vi.waitFor(() => {
      expect(mockTrackAgentTaskRun).toHaveBeenCalledWith(
        mockTelemetryClient,
        expect.objectContaining({
          agentId: coderAgentId,
          state: "cancelled",
        }),
      );
    });
  });
});
