import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueExecutionDecisions,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.ts";

type RecoveryWakeup = (agentId: string, opts?: Record<string, unknown>) => Promise<{ id: string } | null>;

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

// loadConfig() in recovery/service.ts validates bind mode eagerly.
process.env.PAPERCLIP_BIND = "loopback";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pending-review-rearm sweeper tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery reconcilePendingReviewRearm", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pending-review-rearm-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "activity_log",
        "agent_wakeup_requests",
        "heartbeat_runs",
        "issue_execution_decisions",
        "issue_recovery_actions",
        "issue_relations",
        "issues",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
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
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  function buildExecutionState(agentId: string, overrides: { lastDecisionId?: string | null; currentStageId?: string; currentStageIndex?: number } = {}) {
    return {
      status: "pending",
      currentStageId: overrides.currentStageId ?? randomUUID(),
      currentStageIndex: overrides.currentStageIndex ?? 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId, userId: null },
      returnAssignee: null,
      reviewRequest: { instructions: "Please review" },
      completedStageIds: [],
      lastDecisionId: overrides.lastDecisionId ?? null,
      lastDecisionOutcome: null,
    };
  }

  function makeMockEnqueueWakeup() {
    const calls: Array<{ agentId: string; opts: Parameters<RecoveryWakeup>[1] }> = [];
    const mockEnqueue = vi.fn(async (agentId: string, opts?: Parameters<RecoveryWakeup>[1]) => {
      calls.unshift({ agentId, opts });
      return { id: randomUUID() } as Awaited<ReturnType<RecoveryWakeup>>;
    });
    return { mockEnqueue, calls };
  }

  it("re-arms a stale in_review issue with an agent participant and no decision", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const now = new Date();
    const updatedAt = new Date(now.getTime() - 60_000);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs review",
      status: "in_review",
      priority: "high",
      executionState: buildExecutionState(agentId),
      updatedAt,
    });

    const { mockEnqueue } = makeMockEnqueueWakeup();
    const recovery = recoveryService(db, { enqueueWakeup: mockEnqueue });
    const result = await recovery.reconcilePendingReviewRearm({
      now,
      rearmWindowMs: 1000,
      rearmMaxCount: 3,
    });

    expect(result.checked).toBe(1);
    expect(result.reArmed).toBe(1);
    expect(result.dependencyBlockedSkipped).toBe(0);
    expect(result.livePathSkipped).toBe(0);
    expect(result.queuedWakeSkipped).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const call = mockEnqueue.mock.calls[0];
    expect(call?.[0]).toBe(agentId);
    const opts = call?.[1] as { payload?: Record<string, unknown>; contextSnapshot?: Record<string, unknown> } | undefined;
    expect(opts?.reason).toBe("execution_review_requested");
    expect(opts?.payload).toMatchObject({
      issueId,
      mutation: "update",
      rearm: true,
      executionStage: expect.objectContaining({
        wakeRole: "reviewer",
        stageType: "review",
        allowedActions: ["approve", "request_changes"],
      }),
    });
    expect(opts?.contextSnapshot).toMatchObject({
      issueId,
      taskId: issueId,
      wakeReason: "execution_review_requested",
      source: "issue_graph_liveness.pending_review_rearm",
      rearm: true,
    });
  });

  it("skips dependency-blocked in_review issues", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockerId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();

    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Blocker",
        status: "todo",
        priority: "high",
        updatedAt: new Date(now.getTime() - 60_000),
      },
      {
        id: issueId,
        companyId,
        title: "Blocked review",
        status: "in_review",
        priority: "high",
        executionState: buildExecutionState(agentId),
        updatedAt: new Date(now.getTime() - 60_000),
      },
    ]);
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId,
      issueId: blockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });

    const { mockEnqueue } = makeMockEnqueueWakeup();
    const recovery = recoveryService(db, { enqueueWakeup: mockEnqueue });
    const result = await recovery.reconcilePendingReviewRearm({
      now,
      rearmWindowMs: 1000,
      rearmMaxCount: 3,
    });

    expect(result.checked).toBe(1);
    expect(result.reArmed).toBe(0);
    expect(result.dependencyBlockedSkipped).toBe(1);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("skips issues whose review decision has already landed", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const now = new Date();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reviewed",
      status: "in_review",
      priority: "high",
      executionState: buildExecutionState(agentId, { lastDecisionId: randomUUID(), currentStageId: stageId }),
      updatedAt: new Date(now.getTime() - 60_000),
    });
    await db.insert(issueExecutionDecisions).values({
      id: randomUUID(),
      companyId,
      issueId,
      stageId,
      stageType: "review",
      actorAgentId: agentId,
      outcome: "approved",
      body: "LGTM",
    });

    const { mockEnqueue } = makeMockEnqueueWakeup();
    const recovery = recoveryService(db, { enqueueWakeup: mockEnqueue });
    const result = await recovery.reconcilePendingReviewRearm({
      now,
      rearmWindowMs: 1000,
      rearmMaxCount: 3,
    });

    expect(result.checked).toBe(0);
    expect(result.reArmed).toBe(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("re-arms a multi-stage ladder parked at stage >= 1 with a prior-stage decision", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const currentStageId = randomUUID();
    const previousDecisionId = randomUUID();
    const now = new Date();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Multi-stage review",
      status: "in_review",
      priority: "high",
      executionState: buildExecutionState(agentId, {
        lastDecisionId: previousDecisionId,
        currentStageId,
        currentStageIndex: 1,
      }),
      updatedAt: new Date(now.getTime() - 60_000),
    });

    const { mockEnqueue } = makeMockEnqueueWakeup();
    const recovery = recoveryService(db, { enqueueWakeup: mockEnqueue });
    const result = await recovery.reconcilePendingReviewRearm({
      now,
      rearmWindowMs: 1000,
      rearmMaxCount: 3,
    });

    expect(result.checked).toBe(1);
    expect(result.reArmed).toBe(1);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue.mock.calls[0]?.[0]).toBe(agentId);
  });

  it("skips a multi-stage ladder whose current stage already has a decision", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const currentStageId = randomUUID();
    const now = new Date();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Current stage decided",
      status: "in_review",
      priority: "high",
      executionState: buildExecutionState(agentId, {
        lastDecisionId: randomUUID(),
        currentStageId,
        currentStageIndex: 1,
      }),
      updatedAt: new Date(now.getTime() - 60_000),
    });
    await db.insert(issueExecutionDecisions).values({
      id: randomUUID(),
      companyId,
      issueId,
      stageId: currentStageId,
      stageType: "review",
      actorAgentId: agentId,
      outcome: "changes_requested",
      body: "Please fix the issues",
    });

    const { mockEnqueue } = makeMockEnqueueWakeup();
    const recovery = recoveryService(db, { enqueueWakeup: mockEnqueue });
    const result = await recovery.reconcilePendingReviewRearm({
      now,
      rearmWindowMs: 1000,
      rearmMaxCount: 3,
    });

    expect(result.checked).toBe(0);
    expect(result.reArmed).toBe(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("skips when an active run already owns the issue", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const now = new Date();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Active review",
      status: "in_review",
      priority: "high",
      executionState: buildExecutionState(agentId),
      updatedAt: new Date(now.getTime() - 60_000),
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId, taskId: issueId },
    });

    const { mockEnqueue } = makeMockEnqueueWakeup();
    const recovery = recoveryService(db, { enqueueWakeup: mockEnqueue });
    const result = await recovery.reconcilePendingReviewRearm({
      now,
      rearmWindowMs: 1000,
      rearmMaxCount: 3,
    });

    expect(result.checked).toBe(1);
    expect(result.reArmed).toBe(0);
    expect(result.livePathSkipped).toBe(1);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("caps re-arms per issue and surfaces the exhausted state as a recovery action", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const now = new Date();
    const updatedAt = new Date(now.getTime() - 60_000);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review rearm exhausted",
      status: "in_review",
      priority: "high",
      executionState: buildExecutionState(agentId),
      updatedAt,
    });

    for (let i = 0; i < 3; i++) {
      await db.insert(agentWakeupRequests).values({
        id: randomUUID(),
        companyId,
        agentId,
        source: "automation",
        reason: "execution_review_requested",
        payload: { issueId, rearm: true },
        status: "completed",
        requestedAt: new Date(now.getTime() - 100 + i),
      });
    }

    const { mockEnqueue } = makeMockEnqueueWakeup();
    const recovery = recoveryService(db, { enqueueWakeup: mockEnqueue });
    const result = await recovery.reconcilePendingReviewRearm({
      now,
      rearmWindowMs: 1000,
      rearmMaxCount: 3,
    });

    expect(result.checked).toBe(1);
    expect(result.reArmed).toBe(0);
    expect(result.reArmCapSkipped).toBe(1);
    expect(result.reArmCapExhausted).toBe(1);
    expect(result.reArmCapExhaustedIssueIds).toEqual([issueId]);
    expect(mockEnqueue).not.toHaveBeenCalled();

    const action = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId))
      .then((rows) => rows[0]);
    expect(action).toMatchObject({
      companyId,
      sourceIssueId: issueId,
      kind: "pending_review_rearm_cap_exhausted",
      status: "active",
      ownerType: "board",
      previousOwnerAgentId: agentId,
      cause: "pending_review_rearm_cap_exhausted",
      fingerprint: `prr:${companyId}:${issueId}`,
    });
  });
});
