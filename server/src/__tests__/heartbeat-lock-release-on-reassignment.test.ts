import { randomUUID } from "node:crypto";
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

  beforeAll(async () => {
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
    await tempDb?.cleanup();
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

  // Admission only rediscovers a cleared execution lock through the holder's
  // contextSnapshot.issueId, so a holder that lookup cannot see must not be
  // exempted from the post-commit cancel or the successor would overlap it.
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
    // The assignee change clears the direct lock. Admission must rediscover
    // the outgoing issuer by issue, not by the new assignee.
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

  // Race-guard regression: the cancel UPDATE for the queued holder is pinned
  // to the exact non-running status that was read just above it. If a worker
  // races in and flips the holder from `queued` → `running` between that
  // SELECT and the cancel UPDATE, the status predicate in the WHERE clause
  // must guarantee zero rows are clobbered. We simulate the race by
  // pre-running the same UPDATE shape against a row that is already
  // `running` (the snapshot we would have read was `queued`); the row must
  // remain untouched, no wake-request cascade fires, and the lock stays
  // owned by the freshly-claimed running holder.
  it("guards the cancel UPDATE WHERE clause against a concurrent claim flip to running", async () => {
    const { coderAgentId, issueId, holderRunId, wakeupRequestId } = await seedCrossAgentScenario({
      holderStatus: "queued",
    });

    const snapshotStatus = "queued" as const;

    // Concurrent worker claims the queued run after the SELECT but before
    // the cancel UPDATE. In production this is a separate transaction
    // flipping the row from queued → running.
    await db
      .update(heartbeatRuns)
      .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, holderRunId));

    const cancelled = await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: new Date(),
        error: "Execution lock released after issue reassigned to a different agent",
        errorCode: "lock_released_on_reassignment",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(heartbeatRuns.id, holderRunId),
          eq(heartbeatRuns.status, snapshotStatus),
        ),
      )
      .returning({ id: heartbeatRuns.id });

    expect(cancelled).toHaveLength(0);

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
