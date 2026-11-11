import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  completionContracts,
  costEvents,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueThreadInteractions,
  issues,
  nativeRunResults,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateWithLockRetry } from "./helpers/truncate-with-lock-retry.js";
import {
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";
import { bindNativeReviewCommitterWakeToRun } from "../services/native-runtime/native-review-participant.ts";
import { runningProcesses } from "../adapters/index.ts";
import { recoveryService } from "../services/recovery/service.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stale-queue invalidation test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat stale-queue invalidation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

const HEARTBEAT_INVALIDATION_TRUNCATE_SQL = `
  TRUNCATE TABLE
    "issue_thread_interactions",
    "status_decision_effects",
    "status_decisions",
    "work_assessments",
    "native_run_results",
    "completion_contracts",
    "company_skills",
    "issue_comments",
    "issue_documents",
    "document_revisions",
    "documents",
    "issue_relations",
    "issue_tree_holds",
    "issues",
    "heartbeat_run_events",
    "cost_events",
    "activity_log",
    "heartbeat_runs",
    "agent_wakeup_requests",
    "agent_runtime_state",
    "agents",
    "companies"
  RESTART IDENTITY CASCADE
`;

async function cleanupHeartbeatInvalidationFixture(
  db: ReturnType<typeof createDb>,
  heartbeat: ReturnType<typeof heartbeatService>,
) {
  // A run reaches its terminal status before executeRun finishes writing its
  // trailing lifecycle rows, so waiting for heartbeat_runs to leave
  // queued/running is not enough on its own: heartbeat_run_events, issues and
  // issue_comments writes can still be in flight. The TRUNCATE below takes
  // AccessExclusiveLock on every listed table and deadlocks against those late
  // writes (Postgres 40P01). drainActiveRunExecutions awaits the in-flight
  // execution promises (module-level, shared across heartbeatService instances)
  // so the database is quiescent before the lock is taken.
  await heartbeat.drainActiveRunExecutions();
  // Retry anyway: a heartbeat run is not the only possible writer, and the
  // predicate covers both the deadlock/lock-timeout family and the late
  // issue_comments foreign key this fixture used to retry on exclusively.
  await truncateWithLockRetry(db, HEARTBEAT_INVALIDATION_TRUNCATE_SQL, { attempts: 10 });
}

type SeedOptions = {
  agentName?: string;
  agentRole?: string;
  maxConcurrentRuns?: number;
  heartbeatConfig?: Record<string, unknown>;
};

type SeedResult = {
  companyId: string;
  agentId: string;
};

describeEmbeddedPostgres("heartbeat stale queued-run invalidation", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let beforeContinuationDispatchCheck:
    | ((input: { runId: string; issueId: string }) => Promise<void>)
    | null = null;
  let afterContinuationDispatchCheck:
    | ((input: { runId: string; issueId: string }) => Promise<void>)
    | null = null;

  const countExecuteCallsForRun = (runId: string) =>
    mockAdapterExecute.mock.calls.filter(([context]) => context?.runId === runId).length;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-stale-queue-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
      beforeResolvedInteractionContinuationDispatchCheck: async (input) => {
        await beforeContinuationDispatchCheck?.(input);
      },
      afterResolvedInteractionContinuationDispatchCheck: async (input) => {
        await afterContinuationDispatchCheck?.(input);
      },
    });
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    beforeContinuationDispatchCheck = null;
    afterContinuationDispatchCheck = null;
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Stale-queue invalidation test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await cleanupHeartbeatInvalidationFixture(db, heartbeat);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(opts: SeedOptions = {}): Promise<SeedResult> {
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
      name: opts.agentName ?? "ClaudeCoder",
      role: opts.agentRole ?? "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: opts.maxConcurrentRuns ?? 1,
          ...(opts.heartbeatConfig ?? {}),
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    wakeReason: string;
    contextExtras?: Record<string, unknown>;
    invocationSource?: "assignment" | "automation";
    scheduledRetryReason?: string | null;
  }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      reason: input.wakeReason,
      payload: { issueId: input.issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      scheduledRetryReason: input.scheduledRetryReason ?? null,
      contextSnapshot: {
        issueId: input.issueId,
        wakeReason: input.wakeReason,
        ...(input.contextExtras ?? {}),
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { runId, wakeupRequestId };
  }

  async function seedContinuationSummary(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    body: string;
  }) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId: input.companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: input.body,
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: input.agentId,
      updatedByAgentId: input.agentId,
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId: input.companyId,
      documentId,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: input.body,
      createdByAgentId: input.agentId,
    });
    await db.insert(issueDocuments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      documentId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    });
  }

  it("skips generic timer wakes with no actionable assigned work before adapter execution", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: true,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    const runRows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.timer.no_actionable_work",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        reason: expect.stringContaining("No assigned todo or in_progress issue"),
      },
    });
    expect(runRows).toHaveLength(0);
  });

  it("checks guarded issue status and assignee under the enqueue lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const parkedIssueId = randomUUID();
    const reassignedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: parkedIssueId,
        companyId,
        title: "Parked connection intent",
        status: "backlog" as const,
        priority: "medium" as const,
        assigneeAgentId: agentId,
      },
      {
        id: reassignedIssueId,
        companyId,
        title: "Reassigned connection intent",
        status: "in_progress" as const,
        priority: "medium" as const,
        assigneeAgentId: null,
      },
    ]);

    for (const issueId of [parkedIssueId, reassignedIssueId]) {
      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, interactionId: randomUUID() },
        contextSnapshot: { issueId, wakeReason: "issue_commented" },
        requestedByActorType: "user",
        requestedByActorId: "responsible-user",
        issueStateGuard: {
          statuses: ["in_progress"],
          assigneeAgentId: agentId,
        },
      });
      expect(run).toBeNull();
    }

    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)).toEqual([
      { status: "skipped", reason: "issue_state_guard_mismatch" },
      { status: "skipped", reason: "issue_state_guard_mismatch" },
    ]);
  });

  it.each([
    { runtimeMode: "native", status: "done", reassigned: false },
    { runtimeMode: "legacy", status: "done", reassigned: false },
    { runtimeMode: "native", status: "cancelled", reassigned: false },
    { runtimeMode: "native", status: "backlog", reassigned: false },
    { runtimeMode: "native", status: "in_review", reassigned: false },
    { runtimeMode: "native", status: "blocked", reassigned: false },
    { runtimeMode: "native", status: "in_progress", reassigned: true },
  ] as const)("skips stale $runtimeMode productive recovery after status=$status reassigned=$reassigned commits under the enqueue lock", async ({ runtimeMode, status, reassigned }) => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Completion racing with productive recovery",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      runtimeMode,
      status: "succeeded",
      livenessState: "completed",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      startedAt: new Date(),
      finishedAt: new Date(),
    });

    // Let the real sweep select its in-progress snapshot, then hold the issue
    // lock until the real enqueue transaction is waiting on the newer state.
    const enqueueWakeup = vi.fn(async (...[targetAgentId, options]: Parameters<typeof heartbeat.wakeup>) => {
      let pendingWake!: ReturnType<typeof heartbeat.wakeup>;
      await db.transaction(async (tx) => {
        await tx.update(issues).set({
          status,
          ...(reassigned ? { assigneeAgentId: null, assigneeUserId: "responsible-user" } : {}),
        }).where(eq(issues.id, issueId));
        const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        pendingWake = heartbeat.wakeup(targetAgentId, options);
        try {
          expect(await waitForCondition(async () => {
            const [{ waiting }] = await db.execute<{ waiting: boolean }>(sql`
              select exists (
                select 1 from pg_stat_activity
                where ${pid} = any(pg_blocking_pids(pid))
              ) as waiting
            `);
            return waiting;
          })).toBe(true);
        } catch (error) {
          // Observe a pending rejection even if the lock assertion fails.
          void pendingWake.catch(() => {});
          throw error;
        }
      });
      return pendingWake;
    });
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(enqueueWakeup).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ continuationRequeued: 0, escalated: 0, skipped: 1, issueIds: [] });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toEqual([{ id: runId }]);
    expect(await db.select().from(issueComments)).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const [wakeup] = await db.select().from(agentWakeupRequests);
    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "issue_state_guard_mismatch",
      runId: null,
      payload: {
        heartbeatSkip: {
          expectedStatuses: ["in_progress"],
          actualStatus: status,
          expectedAssigneeAgentId: agentId,
          actualAssigneeAgentId: reassigned ? null : agentId,
        },
      },
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ status, assigneeAgentId: reassigned ? null : agentId });
  });

  it("cancels a resolved connection-intent wake parked before queued-run claim", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Connection intent parked after enqueue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: {
        interactionId: randomUUID(),
        interactionKind: "connection_intent",
        interactionStatus: "accepted",
        interactionResolvedAt: "2026-08-28T13:30:00.000Z",
        mutation: "interaction",
        source: "connection_intent.resolved",
      },
    });

    await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, issueId));
    await heartbeat.resumeQueuedRuns();

    const [run, wakeup, issue] = await Promise.all([
      db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_not_in_progress" });
    expect(wakeup).toMatchObject({ status: "skipped", error: expect.stringContaining("no longer in_progress") });
    expect(issue?.status).toBe("backlog");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  type NativeReviewFixtureOptions = {
    interactionStatus?: "pending" | "rejected";
    wakeReason?: string;
    runAgentId?: string;
    authenticateWake?: boolean;
    queuedRunCount?: number;
  };

  async function seedNativeReviewFixture(opts: NativeReviewFixtureOptions = {}) {
    const interactionStatus = opts.interactionStatus ?? "pending";
    const { companyId, agentId: workerId } = await seedCompanyAndAgent();
    const reviewerId = randomUUID();
    await db.insert(agents).values({
      id: reviewerId,
      companyId,
      name: "ReviewLead",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    if (opts.runAgentId && opts.runAgentId !== reviewerId) {
      await db.insert(agents).values({
        id: opts.runAgentId,
        companyId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });
    }
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const contractId = randomUUID();
    const resultId = randomUUID();
    const assessmentId = randomUUID();
    const decisionId = randomUUID();
    const interactionId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Native review of completed work",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: workerId,
      statusVersion: 1,
      lastStatusDecisionId: decisionId,
    });
    await db.insert(completionContracts).values({
      id: contractId, companyId, issueId, revision: 1, schemaVersion: "1",
      policyVersion: "test", risk: "low", completionAuthority: "agent_claim_policy",
      incompleteCriteriaPolicy: "block", contractJson: {}, canonicalSha256: randomUUID(),
      createdByActorType: "agent", createdByActorId: workerId,
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId: workerId, status: "succeeded",
      runtimeMode: "native", nativeIssueId: issueId, completionContractId: contractId,
      contextSnapshot: { issueId }, startedAt: new Date(), finishedAt: new Date(),
    });
    await db.insert(nativeRunResults).values({
      id: resultId, companyId, issueId, runId: sourceRunId, completionContractId: contractId,
      serverFingerprint: randomUUID(), schemaStatus: "valid", resultJson: {},
      canonicalSha256: randomUUID(),
    });
    await db.insert(workAssessments).values({
      id: assessmentId, companyId, issueId, runId: sourceRunId, contractId, resultId,
      triggerKind: "test", triggerActorCompanyId: companyId, priorIssueStatus: "in_progress",
      priorStatusVersion: 0, policyVersion: "test", assessmentJson: {}, inputDigest: randomUUID(),
    });
    await db.insert(statusDecisions).values({
      id: decisionId, companyId, issueId, runId: sourceRunId, assessmentId,
      decisionVersion: 1, policyVersion: "test", fromStatus: "in_progress",
      toStatus: "in_review", reasonCode: "completion_review",
      decisionJson: { projectedStatusVersion: 1 }, decisionDigest: randomUUID(),
      applicationState: "applied",
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId, issueId, kind: "request_confirmation", status: interactionStatus,
      continuationPolicy: "wake_assignee", requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone", resolverPolicyProvenance: "inherited",
      sourceRunId, addresseeAgentId: reviewerId,
      payload: {
        version: 1, prompt: "Review",
        target: { type: "custom", key: "native_completion_review", revisionId: decisionId },
      },
    });
    const runAgentId = opts.runAgentId ?? reviewerId;
    const wakeReason = opts.wakeReason ?? "native_completion_review";
    const runIds: string[] = [];
    const wakeupRequestIds: string[] = [];
    for (let index = 0; index < (opts.queuedRunCount ?? 1); index += 1) {
      const queued = await seedQueuedRun({
        companyId,
        agentId: runAgentId,
        issueId,
        wakeReason,
        contextExtras: {
          nativeReviewInteractionId: interactionId,
          nativeReviewDecisionId: decisionId,
        },
      });
      runIds.push(queued.runId);
      wakeupRequestIds.push(queued.wakeupRequestId);
      if (opts.authenticateWake ?? true) {
        await db.update(agentWakeupRequests).set({
          idempotencyKey: `native-review:${interactionId}`,
          requestedByActorType: "system",
          requestedByActorId: "native-status-committer",
          payload: {
            issueId,
            nativeReviewInteractionId: interactionId,
            nativeReviewDecisionId: decisionId,
          },
        }).where(eq(agentWakeupRequests.id, queued.wakeupRequestId));
      }
    }
    if (wakeupRequestIds.length > 0) {
      await db.insert(statusDecisionEffects).values({
        companyId, issueId, decisionId, ordinal: 1, effectKind: "bind_reviewer",
        targetType: "issue_thread_interaction", targetId: interactionId,
        idempotencyKey: `native-status:${decisionId}:1`,
        payload: {
          interactionId, ownerAgentId: reviewerId,
          reviewerWakeId: wakeupRequestIds[0],
        },
        deliveryState: "delivered", deliveredAt: new Date(),
      });
    }
    return {
      companyId, workerId, reviewerId, issueId, interactionId, decisionId,
      runId: runIds[0]!, runIds, wakeupRequestId: wakeupRequestIds[0]!, wakeupRequestIds,
    };
  }

  async function readRunState(runId: string) {
    return db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function resumeAndReadRun(runId: string, service: ReturnType<typeof heartbeatService> = heartbeat) {
    await service.resumeQueuedRuns();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const settled = await waitForCondition(async () => {
        const run = await readRunState(runId);
        return run?.status !== "queued" && run?.status !== "running";
      });
      if (settled) break;
    }
    return readRunState(runId);
  }

  // Faults only queries matching the predicate (by table and bound params),
  // optionally only the first matching query. All other queries pass through.
  function createFaultedHeartbeat(
    shouldFail: (input: { table: unknown; params: unknown[] }) => boolean,
    opts: { once?: boolean } = {},
  ) {
    const injectedError = new Error("injected native-review lookup failure");
    let faulted = 0;
    const wrapBuilder = (builder: any, table: unknown): any => new Proxy(builder, {
      get(bt, bp) {
        const value = Reflect.get(bt, bp, bt);
        if (bp === "then") {
          return (onFulfilled: unknown, onRejected: unknown) => {
            let targeted = false;
            try {
              targeted = table !== undefined && shouldFail({ table, params: bt.toSQL().params as unknown[] });
            } catch {
              targeted = false;
            }
            if (targeted && (!opts.once || faulted === 0)) {
              faulted += 1;
              return Promise.reject(injectedError).then(onFulfilled as any, onRejected as any);
            }
            return (value as any).call(bt, onFulfilled, onRejected);
          };
        }
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result = (value as any).apply(bt, args);
          if (bp === "from") return wrapBuilder(result, args[0]);
          return result && typeof result === "object" &&
            (typeof result.from === "function" || typeof result.where === "function" || typeof result.then === "function")
            ? wrapBuilder(result, table)
            : result;
        };
      },
    });
    const wrapSelect = (target: object): any => new Proxy(target, {
      get(t, prop, receiver) {
        if (prop === "transaction") {
          const value = Reflect.get(t, prop, receiver) as any;
          return (fn: (tx: unknown) => Promise<unknown>) =>
            value.call(t, (tx: object) => fn(wrapSelect(tx)));
        }
        if (prop !== "select") return Reflect.get(t, prop, receiver);
        return (...args: unknown[]) => wrapBuilder((t as any).select(...args), undefined);
      },
    });
    const faultedDb = new Proxy(db, {
      get(t, prop, receiver) {
        if (prop === "select" || prop === "transaction") return wrapSelect(t)[prop];
        return Reflect.get(t, prop, receiver);
      },
    }) as typeof db;
    return heartbeatService(faultedDb, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
  }

  it("claims a bare native-review queued run for the reviewer instead of cancelling it as assignee-changed", async () => {
    const fixture = await seedNativeReviewFixture();
    const run = await resumeAndReadRun(fixture.runId);
    const [wakeup] = await db.select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, fixture.wakeupRequestId));
    expect(run?.errorCode).not.toBe("issue_assignee_changed");
    expect(run?.status).toBe("succeeded");
    expect(wakeup?.status).not.toBe("skipped");
    expect(countExecuteCallsForRun(fixture.runId)).toBe(1);
  });

  it("still cancels a native-review queued run whose interaction is no longer pending", async () => {
    const fixture = await seedNativeReviewFixture({ interactionStatus: "rejected" });
    const run = await resumeAndReadRun(fixture.runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_assignee_changed");
    expect(countExecuteCallsForRun(fixture.runId)).toBe(0);
  });

  it("cancels an ordinary issue_assigned wake carrying copied native-review markers", async () => {
    const fixture = await seedNativeReviewFixture({
      wakeReason: "issue_assigned",
      authenticateWake: false,
    });
    const run = await resumeAndReadRun(fixture.runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_assignee_changed");
    expect(countExecuteCallsForRun(fixture.runId)).toBe(0);
  });

  it("cancels a native-review queued run queued for an agent who is not the review addressee", async () => {
    const otherAgentId = randomUUID();
    const fixture = await seedNativeReviewFixture({ runAgentId: otherAgentId });
    const run = await resumeAndReadRun(fixture.runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_assignee_changed");
    expect(countExecuteCallsForRun(fixture.runId)).toBe(0);
  });

  it("cancels a native-review queued run whose assignment belongs to another company", async () => {
    const fixture = await seedNativeReviewFixture();
    const { companyId: foreignCompanyId, agentId: foreignWorkerId } = await seedCompanyAndAgent();
    const foreignReviewerId = randomUUID();
    await db.insert(agents).values({
      id: foreignReviewerId,
      companyId: foreignCompanyId,
      name: "ForeignReviewLead",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    const foreignIssueId = randomUUID();
    await db.insert(issues).values({
      id: foreignIssueId,
      companyId: foreignCompanyId,
      title: "Foreign issue with copied review markers",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: foreignWorkerId,
      statusVersion: 1,
      lastStatusDecisionId: fixture.decisionId,
    });
    const { runId } = await seedQueuedRun({
      companyId: foreignCompanyId,
      agentId: foreignReviewerId,
      issueId: foreignIssueId,
      wakeReason: "native_completion_review",
      contextExtras: {
        nativeReviewInteractionId: fixture.interactionId,
        nativeReviewDecisionId: fixture.decisionId,
      },
    });
    await db.update(agentWakeupRequests).set({
      idempotencyKey: `native-review:${fixture.interactionId}`,
      payload: {
        issueId: foreignIssueId,
        nativeReviewInteractionId: fixture.interactionId,
        nativeReviewDecisionId: fixture.decisionId,
      },
    }).where(eq(agentWakeupRequests.agentId, foreignReviewerId));

    const run = await resumeAndReadRun(runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_assignee_changed");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("executes only one of two queued runs for the same native-review assignment", async () => {
    const fixture = await seedNativeReviewFixture({ queuedRunCount: 2 });
    await heartbeat.resumeQueuedRuns();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const settled = await waitForCondition(async () => {
        const states = await Promise.all(fixture.runIds.map((runId) => readRunState(runId)));
        return states.every((run) => run?.status !== "queued" && run?.status !== "running");
      });
      if (settled) break;
    }
    const states = await Promise.all(fixture.runIds.map((runId) => readRunState(runId)));
    expect(states.filter((run) => run?.status === "succeeded")).toHaveLength(1);
    expect(states.filter((run) => run?.status === "cancelled")).toHaveLength(1);
    expect(fixture.runIds.reduce((total, runId) => total + countExecuteCallsForRun(runId), 0)).toBe(1);
  });

  it("keeps the sweep going when the native-review assignment lookup fails", async () => {
    const fixture = await seedNativeReviewFixture();
    const { companyId: ordinaryCompanyId, agentId: ordinaryAgentId } = await seedCompanyAndAgent();
    const ordinaryIssueId = randomUUID();
    await db.insert(issues).values({
      id: ordinaryIssueId,
      companyId: ordinaryCompanyId,
      title: "Ordinary assigned work in another company",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: ordinaryAgentId,
    });
    const ordinary = await seedQueuedRun({
      companyId: ordinaryCompanyId,
      agentId: ordinaryAgentId,
      issueId: ordinaryIssueId,
      wakeReason: "issue_assigned",
    });

    // Fault only the assignment lookup for this interaction: a query whose
    // bound parameters carry the interaction id. Every other query, including
    // the ordinary run's own interaction reads, passes through untouched.
    const faultedHeartbeat = createFaultedHeartbeat(({ params }) =>
      params.includes(fixture.interactionId));

    await expect(faultedHeartbeat.resumeQueuedRuns()).resolves.toBeUndefined();
    await waitForCondition(async () => {
      const run = await readRunState(ordinary.runId);
      return run?.status !== "queued" && run?.status !== "running";
    });
    expect((await readRunState(ordinary.runId))?.status).toBe("succeeded");
    expect(countExecuteCallsForRun(ordinary.runId)).toBe(1);
    expect((await readRunState(fixture.runId))?.status).toBe("queued");
    expect(countExecuteCallsForRun(fixture.runId)).toBe(0);
  });

  it("cancels a cloned server-actor native-review wake that the committer never bound to its run", async () => {
    const fixture = await seedNativeReviewFixture({ queuedRunCount: 0 });
    // The genuine committer wake exists but was never dispatched to a run.
    const genuineWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: genuineWakeId,
      companyId: fixture.companyId,
      agentId: fixture.reviewerId,
      source: "automation",
      triggerDetail: "system",
      reason: "native_completion_review",
      payload: {
        issueId: fixture.issueId,
        nativeReviewInteractionId: fixture.interactionId,
        nativeReviewDecisionId: fixture.decisionId,
      },
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "native-status-committer",
      idempotencyKey: `native-review:${fixture.interactionId}`,
    });
    await db.insert(statusDecisionEffects).values({
      companyId: fixture.companyId, issueId: fixture.issueId, decisionId: fixture.decisionId,
      ordinal: 1, effectKind: "bind_reviewer",
      targetType: "issue_thread_interaction", targetId: fixture.interactionId,
      idempotencyKey: `native-status:${fixture.decisionId}:1`,
      payload: {
        interactionId: fixture.interactionId, ownerAgentId: fixture.reviewerId,
        reviewerWakeId: genuineWakeId,
      },
      deliveryState: "delivered", deliveredAt: new Date(),
    });
    // A clone copies every wake-provenance field, including the server actor.
    const clone = await seedQueuedRun({
      companyId: fixture.companyId,
      agentId: fixture.reviewerId,
      issueId: fixture.issueId,
      wakeReason: "native_completion_review",
      contextExtras: {
        nativeReviewInteractionId: fixture.interactionId,
        nativeReviewDecisionId: fixture.decisionId,
      },
    });
    await db.update(agentWakeupRequests).set({
      idempotencyKey: `native-review:${fixture.interactionId}`,
      requestedByActorType: "system",
      requestedByActorId: "native-status-committer",
      payload: {
        issueId: fixture.issueId,
        nativeReviewInteractionId: fixture.interactionId,
        nativeReviewDecisionId: fixture.decisionId,
      },
    }).where(eq(agentWakeupRequests.id, clone.wakeupRequestId));

    // While the committer intent is unbound the clone is deferred, never
    // executed; once the intent is bound to the genuine run it is cancelled.
    await heartbeat.resumeQueuedRuns();
    expect((await readRunState(clone.runId))?.status).toBe("queued");
    expect(countExecuteCallsForRun(clone.runId)).toBe(0);

    const genuine = await seedQueuedRun({
      companyId: fixture.companyId,
      agentId: fixture.reviewerId,
      issueId: fixture.issueId,
      wakeReason: "native_completion_review",
      contextExtras: {
        nativeReviewInteractionId: fixture.interactionId,
        nativeReviewDecisionId: fixture.decisionId,
      },
    });
    await db.update(agentWakeupRequests).set({ runId: genuine.runId })
      .where(eq(agentWakeupRequests.id, genuineWakeId));
    const run = await resumeAndReadRun(clone.runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_assignee_changed");
    expect(countExecuteCallsForRun(clone.runId)).toBe(0);
  });

  it("claims a promoted native-review run whose wake receipt reason was rewritten", async () => {
    const fixture = await seedNativeReviewFixture();
    // Promotion keeps the wake row and payload but rewrites its reason to
    // issue_execution_promoted and rebinds it to the promoted run.
    await db.update(agentWakeupRequests).set({
      reason: "issue_execution_promoted",
      requestedByActorId: `native-status-wake-dispatch:${fixture.wakeupRequestId}`,
      payload: {
        issueId: fixture.issueId,
        _paperclipWakeContext: {
          issueId: fixture.issueId,
          nativeReviewInteractionId: fixture.interactionId,
          nativeReviewDecisionId: fixture.decisionId,
          wakeReason: "native_completion_review",
        },
      },
    }).where(eq(agentWakeupRequests.id, fixture.wakeupRequestId));
    const run = await resumeAndReadRun(fixture.runId);
    expect(run?.errorCode).not.toBe("issue_assignee_changed");
    expect(run?.status).toBe("succeeded");
    expect(countExecuteCallsForRun(fixture.runId)).toBe(1);
  });

  it("claims a valid native-review run when the current participant is the worker", async () => {
    const fixture = await seedNativeReviewFixture();
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: fixture.workerId, userId: null },
        returnAssignee: { type: "agent", agentId: fixture.workerId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, fixture.issueId));
    const run = await resumeAndReadRun(fixture.runId);
    expect(run?.errorCode).not.toBe("issue_review_participant_changed");
    expect(run?.status).toBe("succeeded");
    expect(countExecuteCallsForRun(fixture.runId)).toBe(1);
  });

  it("does not let an ordinary run carrying only the interaction id block a valid native review", async () => {
    const fixture = await seedNativeReviewFixture();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: fixture.companyId,
      agentId: fixture.workerId,
      status: "succeeded",
      contextSnapshot: {
        issueId: fixture.issueId,
        nativeReviewInteractionId: fixture.interactionId,
      },
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    const run = await resumeAndReadRun(fixture.runId);
    expect(run?.errorCode).not.toBe("native_review_assignment_already_claimed");
    expect(run?.status).toBe("succeeded");
    expect(countExecuteCallsForRun(fixture.runId)).toBe(1);
  });

  it("cancels a real wakeup clone that copies every native-review field including the server actor", async () => {
    const fixture = await seedNativeReviewFixture({ queuedRunCount: 0 });
    const genuineWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: genuineWakeId,
      companyId: fixture.companyId,
      agentId: fixture.reviewerId,
      source: "automation",
      triggerDetail: "system",
      reason: "native_completion_review",
      payload: {
        issueId: fixture.issueId,
        nativeReviewInteractionId: fixture.interactionId,
        nativeReviewDecisionId: fixture.decisionId,
        _paperclipWakeContext: {
          issueId: fixture.issueId,
          nativeReviewInteractionId: fixture.interactionId,
          nativeReviewDecisionId: fixture.decisionId,
        },
      },
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "native-status-committer",
      idempotencyKey: `native-review:${fixture.interactionId}`,
    });
    await db.insert(statusDecisionEffects).values({
      companyId: fixture.companyId, issueId: fixture.issueId, decisionId: fixture.decisionId,
      ordinal: 1, effectKind: "bind_reviewer",
      targetType: "issue_thread_interaction", targetId: fixture.interactionId,
      idempotencyKey: `native-status:${fixture.decisionId}:1`,
      payload: {
        interactionId: fixture.interactionId, ownerAgentId: fixture.reviewerId,
        reviewerWakeId: genuineWakeId,
      },
      deliveryState: "delivered", deliveredAt: new Date(),
    });

    const cloneRun = await heartbeat.wakeup(fixture.reviewerId, {
      source: "automation",
      triggerDetail: "system",
      reason: "native_completion_review",
      payload: {
        issueId: fixture.issueId,
        nativeReviewInteractionId: fixture.interactionId,
        nativeReviewDecisionId: fixture.decisionId,
        _paperclipWakeContext: {
          issueId: fixture.issueId,
          nativeReviewInteractionId: fixture.interactionId,
          nativeReviewDecisionId: fixture.decisionId,
        },
      },
      contextSnapshot: {
        issueId: fixture.issueId,
        nativeReviewInteractionId: fixture.interactionId,
        nativeReviewDecisionId: fixture.decisionId,
        _paperclipWakeContext: {
          issueId: fixture.issueId,
          nativeReviewInteractionId: fixture.interactionId,
          nativeReviewDecisionId: fixture.decisionId,
        },
      },
      requestedByActorType: "system",
      requestedByActorId: "native-status-committer",
      idempotencyKey: `native-review:${fixture.interactionId}`,
    });

    const cloneRunId = cloneRun?.id ?? null;
    expect(cloneRunId).not.toBeNull();
    // While the committer intent is unbound the clone is deferred, never
    // executed; once the intent is bound to the genuine run it is cancelled.
    await heartbeat.resumeQueuedRuns();
    expect(cloneRunId ? (await readRunState(cloneRunId))?.status : null).toBe("queued");
    if (cloneRunId) expect(countExecuteCallsForRun(cloneRunId)).toBe(0);

    const genuine = await seedQueuedRun({
      companyId: fixture.companyId,
      agentId: fixture.reviewerId,
      issueId: fixture.issueId,
      wakeReason: "native_completion_review",
      contextExtras: {
        nativeReviewInteractionId: fixture.interactionId,
        nativeReviewDecisionId: fixture.decisionId,
      },
    });
    await db.update(agentWakeupRequests).set({ runId: genuine.runId })
      .where(eq(agentWakeupRequests.id, genuineWakeId));
    await heartbeat.resumeQueuedRuns();
    const state = cloneRunId ? await readRunState(cloneRunId) : null;
    expect(state?.status).toBe("cancelled");
    if (cloneRunId) expect(countExecuteCallsForRun(cloneRunId)).toBe(0);
  });

  it("cancels an invalid native-review run even when the agent is the current review participant", async () => {
    const fixture = await seedNativeReviewFixture({ interactionStatus: "rejected" });
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: fixture.reviewerId, userId: null },
        returnAssignee: { type: "agent", agentId: fixture.workerId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, fixture.issueId));
    const run = await resumeAndReadRun(fixture.runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_assignee_changed");
    expect(countExecuteCallsForRun(fixture.runId)).toBe(0);
  });

  it("defers a native-review run until the committer intent is bound to it", async () => {
    const fixture = await seedNativeReviewFixture();
    // Unbound intent, kept out of the dispatcher's candidate set (completed)
    // so only the gate sees it: admission must defer, not cancel or execute.
    await db.update(agentWakeupRequests).set({ runId: null, status: "completed" })
      .where(eq(agentWakeupRequests.id, fixture.wakeupRequestId));

    await heartbeat.resumeQueuedRuns();
    expect((await readRunState(fixture.runId))?.status).toBe("queued");
    expect(countExecuteCallsForRun(fixture.runId)).toBe(0);

    await db.update(agentWakeupRequests).set({ runId: fixture.runId, status: "queued" })
      .where(eq(agentWakeupRequests.id, fixture.wakeupRequestId));
    const run = await resumeAndReadRun(fixture.runId);
    expect(run?.status).toBe("succeeded");
    expect(countExecuteCallsForRun(fixture.runId)).toBe(1);
  });

  it("transfers the committer binding on promotion only for the committer wake or its dispatch", async () => {
    const fixture = await seedNativeReviewFixture();
    const promoted = await seedQueuedRun({
      companyId: fixture.companyId,
      agentId: fixture.reviewerId,
      issueId: fixture.issueId,
      wakeReason: "issue_execution_promoted",
    });
    const committerRunId = async () => db.select({ runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, fixture.wakeupRequestId))
      .then((rows) => rows[0]?.runId ?? null);
    const context = {
      issueId: fixture.issueId,
      nativeReviewInteractionId: fixture.interactionId,
      nativeReviewDecisionId: fixture.decisionId,
    };

    await bindNativeReviewCommitterWakeToRun(db, {
      companyId: fixture.companyId, issueId: fixture.issueId, runId: promoted.runId,
      contextSnapshot: context,
      wake: {
        id: randomUUID(), idempotencyKey: null,
        requestedByActorType: "user", requestedByActorId: "someone",
      },
    });
    expect(await committerRunId()).toBe(fixture.runId);

    await bindNativeReviewCommitterWakeToRun(db, {
      companyId: fixture.companyId, issueId: fixture.issueId, runId: promoted.runId,
      contextSnapshot: context,
      wake: {
        id: fixture.wakeupRequestId, idempotencyKey: `native-review:${fixture.interactionId}`,
        requestedByActorType: "system", requestedByActorId: "native-status-committer",
      },
    });
    expect(await committerRunId()).toBe(promoted.runId);
  });

  it("cancels a native-review wake whose provenance actor is not the server committer", async () => {
    const fixture = await seedNativeReviewFixture();
    await db.update(agentWakeupRequests).set({
      requestedByActorType: "agent",
      requestedByActorId: fixture.reviewerId,
    }).where(eq(agentWakeupRequests.id, fixture.wakeupRequestId));
    const run = await resumeAndReadRun(fixture.runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_assignee_changed");
    expect(countExecuteCallsForRun(fixture.runId)).toBe(0);
  });

  it("does not execute a native-review run when the wake lookup fails once", async () => {
    const fixture = await seedNativeReviewFixture();
    const faultedHeartbeat = createFaultedHeartbeat(
      ({ table, params }) => table === agentWakeupRequests && params.includes(fixture.wakeupRequestId),
      { once: true },
    );
    await expect(faultedHeartbeat.resumeQueuedRuns()).resolves.toBeUndefined();
    expect((await readRunState(fixture.runId))?.status).toBe("queued");
    expect(countExecuteCallsForRun(fixture.runId)).toBe(0);

    const run = await resumeAndReadRun(fixture.runId);
    expect(run?.status).toBe("succeeded");
    expect(countExecuteCallsForRun(fixture.runId)).toBe(1);
  });

  it("does not execute a duplicate native-review run when the sibling lookup fails once", async () => {
    const fixture = await seedNativeReviewFixture();
    const first = await resumeAndReadRun(fixture.runId);
    expect(first?.status).toBe("succeeded");
    expect(countExecuteCallsForRun(fixture.runId)).toBe(1);

    const duplicate = await seedQueuedRun({
      companyId: fixture.companyId,
      agentId: fixture.reviewerId,
      issueId: fixture.issueId,
      wakeReason: "native_completion_review",
      contextExtras: {
        nativeReviewInteractionId: fixture.interactionId,
        nativeReviewDecisionId: fixture.decisionId,
      },
    });
    await db.update(agentWakeupRequests).set({
      idempotencyKey: `native-review:${fixture.interactionId}`,
      requestedByActorType: "system",
      requestedByActorId: "native-status-committer",
      payload: {
        issueId: fixture.issueId,
        nativeReviewInteractionId: fixture.interactionId,
        nativeReviewDecisionId: fixture.decisionId,
      },
    }).where(eq(agentWakeupRequests.id, duplicate.wakeupRequestId));

    const faultedHeartbeat = createFaultedHeartbeat(
      ({ table, params }) => table === heartbeatRuns && params.includes(fixture.interactionId),
      { once: true },
    );
    await expect(faultedHeartbeat.resumeQueuedRuns()).resolves.toBeUndefined();
    expect((await readRunState(duplicate.runId))?.status).toBe("queued");
    expect(countExecuteCallsForRun(duplicate.runId)).toBe(0);

    const run = await resumeAndReadRun(duplicate.runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("native_review_assignment_already_claimed");
    expect(countExecuteCallsForRun(duplicate.runId)).toBe(0);
  });

  it("does not re-open a resolved connection-intent issue parked after claim", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Connection intent parked between claim and checkout",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: {
        interactionId: randomUUID(),
        interactionKind: "connection_intent",
        interactionStatus: "accepted",
        interactionResolvedAt: "2026-08-28T13:30:00.000Z",
        mutation: "interaction",
        source: "connection_intent.resolved",
      },
    });

    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION park_connection_intent_after_claim()
      RETURNS trigger AS $trigger$
      BEGIN
        IF NEW.id = '${runId}'::uuid AND NEW.status = 'running' THEN
          UPDATE issues SET status = 'backlog' WHERE id = '${issueId}'::uuid;
        END IF;
        RETURN NEW;
      END;
      $trigger$ LANGUAGE plpgsql;

      CREATE TRIGGER park_connection_intent_after_claim
      AFTER UPDATE OF status ON heartbeat_runs
      FOR EACH ROW EXECUTE FUNCTION park_connection_intent_after_claim();
    `));

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const [run, wakeup] = await Promise.all([
        db.select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId))
          .then((rows) => rows[0] ?? null),
        db.select({ status: agentWakeupRequests.status })
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, wakeupRequestId))
          .then((rows) => rows[0] ?? null),
      ]);
      return run?.status === "cancelled" && wakeup?.status === "skipped";
    });

    const [run, wakeup, issue] = await Promise.all([
      db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_not_in_progress" });
    expect(wakeup).toMatchObject({ status: "skipped", error: expect.stringContaining("no longer in_progress") });
    expect(issue?.status).toBe("backlog");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it.each([
    {
      mutation: "parked",
      expectedErrorCode: "issue_not_in_progress",
      expectedError: "no longer in_progress",
    },
    {
      mutation: "reassigned",
      expectedErrorCode: "issue_assignee_changed",
      expectedError: "changed assignee",
    },
  ])(
    "cancels a resolved connection-intent wake $mutation after checkout but before adapter dispatch",
    async ({ mutation, expectedErrorCode, expectedError }) => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const replacementAgentId = randomUUID();
      if (mutation === "reassigned") {
        await db.insert(agents).values({
          id: replacementAgentId,
          companyId,
          name: "ReplacementCoder",
          role: "engineer",
          status: "active",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
          permissions: {},
        });
      }
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Connection intent ${mutation} at final dispatch`,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      });
      const { runId, wakeupRequestId } = await seedQueuedRun({
        companyId,
        agentId,
        issueId,
        wakeReason: "issue_commented",
        invocationSource: "automation",
        contextExtras: {
          interactionId: randomUUID(),
          interactionKind: "connection_intent",
          interactionStatus: "accepted",
          interactionResolvedAt: "2026-08-28T13:30:00.000Z",
          mutation: "interaction",
          source: "connection_intent.resolved",
        },
      });
      beforeContinuationDispatchCheck = async ({ runId: guardedRunId, issueId: guardedIssueId }) => {
        expect(guardedRunId).toBe(runId);
        expect(guardedIssueId).toBe(issueId);
        await db
          .update(issues)
          .set(mutation === "parked"
            ? { status: "backlog", updatedAt: new Date() }
            : { assigneeAgentId: replacementAgentId, updatedAt: new Date() })
          .where(eq(issues.id, issueId));
      };

      await heartbeat.resumeQueuedRuns();
      await waitForCondition(async () => {
        const [run, wakeup] = await Promise.all([
          db.select({ status: heartbeatRuns.status })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, runId))
            .then((rows) => rows[0] ?? null),
          db.select({ status: agentWakeupRequests.status })
            .from(agentWakeupRequests)
            .where(eq(agentWakeupRequests.id, wakeupRequestId))
            .then((rows) => rows[0] ?? null),
        ]);
        return run?.status === "cancelled" && wakeup?.status === "skipped";
      });

      const [run, wakeup, issue] = await Promise.all([
        db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId))
          .then((rows) => rows[0] ?? null),
        db.select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, wakeupRequestId))
          .then((rows) => rows[0] ?? null),
        db.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((rows) => rows[0] ?? null),
      ]);
      expect(run).toMatchObject({ status: "cancelled", errorCode: expectedErrorCode });
      expect(wakeup).toMatchObject({ status: "skipped", error: expect.stringContaining(expectedError) });
      expect(issue).toMatchObject(mutation === "parked"
        ? { status: "backlog", assigneeAgentId: agentId }
        : { status: "in_progress", assigneeAgentId: replacementAgentId });
      expect(countExecuteCallsForRun(runId)).toBe(0);
    },
  );

  it("rejects ownership changes immediately before the final continuation handoff", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Connection intent parked at the atomic dispatch gate",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: {
        interactionId: randomUUID(),
        interactionKind: "connection_intent",
        interactionStatus: "accepted",
        interactionResolvedAt: "2026-08-28T13:30:00.000Z",
        mutation: "interaction",
        source: "connection_intent.resolved",
      },
    });

    const ordering: string[] = [];
    let parkPromise: Promise<unknown> | null = null;
    afterContinuationDispatchCheck = async ({ runId: guardedRunId, issueId: guardedIssueId }) => {
      expect(guardedRunId).toBe(runId);
      expect(guardedIssueId).toBe(issueId);
      ordering.push("validated");
      parkPromise = Promise.resolve(
        db
          .update(issues)
          .set({
            status: "backlog",
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(issues.id, issueId))
          .returning({ id: issues.id }),
      ).then((rows) => {
        expect(rows).toHaveLength(1);
        ordering.push("parked");
      });
      // Admission is committed before adapter-owned setup. This concurrent
      // update must not wait on a lock held by the adapter callback.
      await new Promise((resolve) => setTimeout(resolve, 25));
      await parkPromise;
      expect(ordering).toEqual(["validated", "parked"]);
    };
    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });
    await parkPromise;

    const issue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("backlog");
    expect(ordering).toEqual(["validated", "parked"]);
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("rate-limits skipped generic timer wakes by advancing the timer baseline", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        intervalSec: 60,
        skipTimerWhenNoActionableWork: true,
      },
    });
    const now = new Date();
    await db
      .update(agents)
      .set({ lastHeartbeatAt: new Date(now.getTime() - 120_000) })
      .where(eq(agents.id, agentId));

    const firstTick = await heartbeat.tickTimers(now);
    const secondTick = await heartbeat.tickTimers(now);

    expect(firstTick.skipped).toBe(1);
    expect(secondTick.skipped).toBe(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const wakeups = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    const [agent] = await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId));

    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.reason).toBe("heartbeat.timer.no_actionable_work");
    expect(agent?.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(agent?.lastHeartbeatAt?.getTime()).toBeGreaterThan(now.getTime() - 120_000);
  });

  it("atomically claims a due timer interval across overlapping scheduler ticks", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        intervalSec: 60,
      },
    });
    const now = new Date();
    await db
      .update(agents)
      .set({
        createdAt: new Date(now.getTime() - 120_000),
        lastHeartbeatAt: null,
      })
      .where(eq(agents.id, agentId));

    const results = await Promise.all([
      heartbeat.tickTimers(now),
      heartbeat.tickTimers(now),
    ]);

    expect(results.reduce((total, result) => total + result.enqueued, 0)).toBe(1);

    const runs = await db
      .select({
        id: heartbeatRuns.id,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const [agent] = await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId));

    expect(runs).toHaveLength(1);
    expect(runs[0]?.contextSnapshot).toMatchObject({
      timerClaimWasFirstHeartbeat: true,
    });
    expect(agent?.lastHeartbeatAt?.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  it("allows generic timer wakes when the agent has assigned todo work", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: true,
      },
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Assigned work",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).not.toBeNull();
    await waitForCondition(async () => countExecuteCallsForRun(run!.id) > 0);

    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("allows legacy generic timer wakes by default when no skip policy is set", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).not.toBeNull();
    await waitForCondition(async () => countExecuteCallsForRun(run!.id) > 0);
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("allows explicit proactive generic timer wakes without assigned issue work", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: false,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).not.toBeNull();
    await waitForCondition(async () => countExecuteCallsForRun(run!.id) > 0);
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("skips wakes before queueing when per-agent daily run cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 1,
        limit: 1,
      },
    });
  });

  it("treats zero daily run cap as a hard stop", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 0,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 0,
        limit: 0,
      },
    });
  });

  it("counts started cancelled runs toward the per-agent daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "cancelled",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 1,
        limit: 1,
      },
    });
  });

  it("coalesces same-issue wakes before enforcing the daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
    });

    expect(run?.id).toBe(queuedRunId);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const wakeups = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "coalesced",
          reason: "issue_execution_same_name",
          runId: queuedRunId,
        }),
      ]),
    );
  });

  it("skips wakes before queueing when per-agent daily cost cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 75,
      },
    });
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 75,
      occurredAt: new Date(),
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_cost_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 75,
        limit: 75,
      },
    });
  });

  it("treats zero daily cost cap as a hard stop", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 0,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_cost_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 0,
        limit: 0,
      },
    });
  });

  it("skips already queued runs before adapter execution when the daily cost cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 75,
      },
    });
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: {},
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {},
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 75,
      occurredAt: new Date(),
    });

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "heartbeat.daily_cost_limit",
    });
    expect(run?.resultJson).toMatchObject({
      stopReason: "heartbeat.daily_cost_limit",
      observed: 75,
      limit: 75,
    });
    expect(wakeup).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("per-day heartbeat budget cap"),
    });
  });

  it("skips already queued issue runs at the daily run cap and releases the execution lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId));
    const [wakeup] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    const [issue] = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "heartbeat.daily_run_limit",
    });
    expect(wakeup).toMatchObject({ status: "skipped" });
    expect(issue?.executionRunId).toBeNull();
  });

  it("promotes deferred issue wakes when a queued holder is cancelled by the daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const peerAgentId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    const deferredWakeupId = randomUUID();
    await db.insert(agents).values({
      id: peerAgentId,
      companyId,
      name: "PeerAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeupId,
      companyId,
      agentId: peerAgentId,
      source: "comment",
      triggerDetail: "mention",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: {
          issueId,
          wakeReason: "issue_mention",
        },
      },
      status: "deferred_issue_execution",
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const [deferred] = await db
        .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWakeupId));
      return Boolean(deferred?.runId) && deferred?.status !== "deferred_issue_execution";
    });

    const [deferred] = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeupId));
    const [promotedRun] = deferred?.runId
      ? await db
        .select({ agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, deferred.runId))
      : [];

    expect(deferred?.status).not.toBe("deferred_issue_execution");
    expect(promotedRun?.agentId).toBe(peerAgentId);
  });

  it("cancels queued max-turn continuations when another continuation owns the issue lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const lockOwnerRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: lockOwnerRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      scheduledRetryAttempt: 1,
      scheduledRetryAt: new Date("2026-04-20T12:00:00.000Z"),
      contextSnapshot: {
        issueId,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Duplicate max-turn continuation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: lockOwnerRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: new Date("2026-04-20T11:59:00.000Z"),
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      invocationSource: "automation",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextExtras: {
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup, issue] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_execution_lock_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_execution_lock_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("execution lock");
    expect(issue?.executionRunId).toBe(lockOwnerRunId);
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("enqueues a run for the new owner after cancelling a stale review handoff", async () => {
    // SUP-10605: a review handoff moves the issue to in_review and reassigns it to
    // the reviewer while the outgoing assignee still has a queued run. Cancelling
    // that run used to leave the issue with no queued run and no executionRunId,
    // and nothing else re-dispatches it, so the issue parked forever — even though
    // the cancellation reason promised "the new owner will be woken instead".
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "OutgoingCoder" });
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "ReviewerAgent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Handed off to review",
      status: "in_review",
      priority: "high",
      // The execution policy mirrors the current participant onto the assignee,
      // so the reviewer owns the issue on both axes.
      assigneeAgentId: reviewerAgentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    const handedOff = await waitForCondition(async () => {
      const rows = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, reviewerAgentId));
      return rows.length > 0;
    }, 10_000);
    expect(handedOff).toBe(true);

    const staleRun = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        startedAt: heartbeatRuns.startedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(staleRun?.status).toBe("cancelled");
    expect(staleRun?.errorCode).toBe("issue_assignee_changed");
    expect(staleRun?.startedAt).toBeNull();
    expect(countExecuteCallsForRun(runId)).toBe(0);

    const handoffRuns = await db
      .select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, reviewerAgentId));
    expect(handoffRuns).toHaveLength(1);
    expect(handoffRuns[0]?.contextSnapshot).toMatchObject({
      issueId,
      staleRunHandoffFromRunId: runId,
      staleRunHandoffFromAgentId: agentId,
      staleRunHandoffErrorCode: "issue_assignee_changed",
      staleRunHandoffHops: 1,
    });

    // The new owner's run is a real dispatch, not another cancellation.
    const reached = await waitForCondition(async () => {
      const row = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, handoffRuns[0]!.id))
        .then((rows) => rows[0] ?? null);
      return row?.status === "succeeded";
    }, 10_000);
    expect(reached).toBe(true);
    expect(countExecuteCallsForRun(handoffRuns[0]!.id)).toBe(1);
  });

  it("enqueues a run for the current review participant after cancelling a stale participant run", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "StaleParticipant" });
    const participantAgentId = randomUUID();
    await db.insert(agents).values({
      id: participantAgentId,
      companyId,
      name: "CurrentParticipant",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In-review stage advanced to another participant",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: participantAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    const handedOff = await waitForCondition(async () => {
      const rows = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, participantAgentId));
      return rows.length > 0;
    }, 10_000);
    expect(handedOff).toBe(true);

    const staleRun = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(staleRun?.status).toBe("cancelled");
    expect(staleRun?.errorCode).toBe("issue_review_participant_changed");

    const handoffRuns = await db
      .select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, participantAgentId));
    expect(handoffRuns).toHaveLength(1);
    expect(handoffRuns[0]?.contextSnapshot).toMatchObject({
      issueId,
      staleRunHandoffFromRunId: runId,
      staleRunHandoffErrorCode: "issue_review_participant_changed",
      staleRunHandoffHops: 1,
    });

    // evaluateQueuedRunStaleness already exempts the current review participant
    // from the assignee check, so the handoff run is dispatchable, not re-cancelled.
    const reached = await waitForCondition(async () => {
      const row = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, handoffRuns[0]!.id))
        .then((rows) => rows[0] ?? null);
      return row?.status === "succeeded";
    }, 10_000);
    expect(reached).toBe(true);
  });

  it("does not enqueue a handoff when a stale cancellation promises no wake", async () => {
    // issue_terminal_status is a deliberate no-enqueue case: its reason string
    // makes no wake promise, and no replacement run may be created.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Already-completed task",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const allRuns = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]?.id).toBe(runId);
  });

  it("stops handing off after one hop instead of ping-ponging runs between two agents", async () => {
    // A handoff run that is itself found stale means ownership is contradictory.
    // The chain must terminate rather than bounce runs between the two agents.
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "AssigneeAgent" });
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Contradictory ownership",
      status: "todo",
      priority: "medium",
      assigneeAgentId: otherAgentId,
    });

    // Seed a run for a third party so the first hop targets otherAgentId, whose
    // own handoff attempt is then hop 2 and must be refused.
    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
      contextExtras: { staleRunHandoffHops: 1 },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    }, 10_000);

    // Give any runaway ping-pong a chance to produce more runs.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const allRuns = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]?.id).toBe(runId);
  });

  it("bounds the alternating pre-adapter setup_failed / issue_assignee_changed cycle and records retry exhaustion", async () => {
    // SUP-15589: an assignment dispatch fails `setup_failed` before the adapter
    // starts, the re-dispatch flips the assignee, that flip cancels the in-flight
    // run as `issue_assignee_changed`, and the cycle repeats. Neither the stale-run
    // hop counter (it never advances when the handoff run dies at setup) nor
    // didAutomaticRecoveryFail (keyed on a retryReason a stale-run handoff lacks)
    // counted it, so 869 runs burned in 82 minutes with retryExhaustedReason null.
    // Once the issue accumulates enough consecutive pre-adapter setup failures, the
    // stale-run handoff must refuse to re-dispatch and record the exhaustion.
    const { companyId, agentId: currentOwnerId } = await seedCompanyAndAgent({
      agentName: "CurrentOwner",
    });
    const outgoingAgentId = randomUUID();
    await db.insert(agents).values({
      id: outgoingAgentId,
      companyId,
      name: "OutgoingOwner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stuck in a pre-adapter setup failure loop",
      status: "todo",
      priority: "high",
      assigneeAgentId: currentOwnerId,
    });

    // Three consecutive pre-adapter setup failures on this issue — the bound.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId: currentOwnerId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "failed",
        errorCode: "setup_failed",
        startedAt: new Date(),
        finishedAt: new Date(),
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      });
    }

    // A queued run for the stale owner: the assignee has since flipped to
    // currentOwnerId, so claiming it fails staleness and would normally hand off.
    const { runId: staleRunId } = await seedQueuedRun({
      companyId,
      agentId: outgoingAgentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, staleRunId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    }, 10_000);

    // Give a runaway handoff a chance to produce more runs, then require the bound
    // to have held: three seeded failures plus the single cancelled run, no
    // replacement, and a non-null retryExhaustedReason on the cancelled run.
    await waitForCondition(async () => (await heartbeat.getRetryExhaustedReason(staleRunId)) != null, 3_000);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const staleRun = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, staleRunId))
      .then((rows) => rows[0] ?? null);
    expect(staleRun?.status).toBe("cancelled");
    expect(staleRun?.errorCode).toBe("issue_assignee_changed");

    const allRuns = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(allRuns).toHaveLength(4);

    const exhaustionReason = await heartbeat.getRetryExhaustedReason(staleRunId);
    expect(exhaustionReason).toContain("Bounded retry exhausted");
  });

  it("still hands off a stale run while the pre-adapter setup failure streak is below the bound", async () => {
    // The bound must not break the ordinary handoff path: below the threshold, a
    // stale run still hands off to the issue's current owner.
    const { companyId, agentId: currentOwnerId } = await seedCompanyAndAgent({
      agentName: "CurrentOwner",
    });
    const outgoingAgentId = randomUUID();
    await db.insert(agents).values({
      id: outgoingAgentId,
      companyId,
      name: "OutgoingOwner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Recovering from a transient setup failure",
      status: "todo",
      priority: "high",
      assigneeAgentId: currentOwnerId,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId: currentOwnerId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "failed",
        errorCode: "setup_failed",
        startedAt: new Date(),
        finishedAt: new Date(),
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      });
    }

    const { runId: staleRunId } = await seedQueuedRun({
      companyId,
      agentId: outgoingAgentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    const handedOff = await waitForCondition(async () => {
      const rows = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, currentOwnerId));
      return rows.length > 2;
    }, 10_000);
    expect(handedOff).toBe(true);

    const exhaustionReason = await heartbeat.getRetryExhaustedReason(staleRunId);
    expect(exhaustionReason).toBeNull();
  });

  it.each([
    ["accepted", "connection_intent"],
    ["rejected", "connection_intent"],
    ["rejected", "request_confirmation"],
  ])("resumes a %s %s outcome and promotes the claimed review task", async (interactionStatus, interactionKind) => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    const wakeCommentId = randomUUID();
    let claimedIssue: { status: string; executionRunId: string | null } | null = null;
    afterContinuationDispatchCheck = async ({ runId: checkedRunId, issueId: checkedIssueId }) => {
      if (checkedIssueId !== issueId) return;
      claimedIssue = await db
        .select({ status: issues.status, executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(claimedIssue).toEqual({ status: "in_progress", executionRunId: checkedRunId });
    };
    await db.insert(issues).values({ id: issueId, companyId, title: "Waiting for connection", status: "in_review", priority: "medium", assigneeAgentId: agentId });
    await db.insert(issueComments).values({
      id: wakeCommentId,
      companyId,
      issueId,
      authorUserId: "local-board",
      body: "Continue after the interaction result.",
    });
    if (interactionKind === "request_confirmation") {
      await db.insert(issueThreadInteractions).values({
        id: interactionId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "rejected",
        continuationPolicy: "wake_assignee",
        payload: {},
        result: { version: 1, outcome: "rejected", reason: "Needs more work" },
        createdByAgentId: agentId,
        resolvedAt: new Date(),
      });
    }
    const { runId } = await seedQueuedRun({ companyId, agentId, issueId, wakeReason: "issue_commented",
      contextExtras: { interactionId, interactionKind, interactionStatus, wakeCommentId,
        originCommentIds: [wakeCommentId],
        interactionResolvedAt: new Date().toISOString(), mutation: "interaction", source: `${interactionKind}.resolved`, forceFreshSession: true } });
    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => (await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status === "succeeded")).toBe(true);
    // Terminal status precedes completion bookkeeping. Drain those writes before
    // afterEach truncates the fixture, otherwise PostgreSQL can deadlock.
    await heartbeat.waitForRunExecutionDrain(runId);
    expect(countExecuteCallsForRun(runId)).toBe(1);
    await waitForCondition(async () => claimedIssue !== null);
    expect(claimedIssue).toEqual({ status: "in_progress", executionRunId: runId });
  });

  it("keeps a changes_requested continuation wake alive when the summary wrongly parks the executor (SUP-15899 regression)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implementation awaiting executor rework after a bounced review",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "changes_requested",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    await seedContinuationSummary({
      companyId,
      issueId,
      agentId,
      body: [
        "# Continuation Summary",
        "",
        "## Next Action",
        "",
        "- Wait for reviewer feedback or approval before continuing executor work.",
      ].join("\n"),
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      contextExtras: {
        retryReason: "issue_continuation_needed",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(countExecuteCallsForRun(runId)).toBe(1);
  });

  it("cancels a continuation wake when the card is genuinely in review with a non-assignee participant (SUP-16050 negative control)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const reviewerAgentId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implementation parked for review",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    await seedContinuationSummary({
      companyId,
      issueId,
      agentId,
      body: [
        "# Continuation Summary",
        "",
        "## Next Action",
        "",
        "- Wait for reviewer feedback or approval before continuing executor work.",
      ].join("\n"),
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      contextExtras: {
        retryReason: "issue_continuation_needed",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup, activity] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          action: activityLog.action,
          entityType: activityLog.entityType,
          entityId: activityLog.entityId,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueId),
            eq(activityLog.action, "issue.continuation_cancelled_waiting_on_review"),
          ),
        )
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_continuation_waiting_on_review");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_continuation_waiting_on_review" });
    expect(wakeup?.status).toBe("skipped");
    expect(activity).not.toBeNull();
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("no longer cancels a plain continuation wake from a parking summary when the card state says proceed (SUP-16050)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implementation continues",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await seedContinuationSummary({
      companyId,
      issueId,
      agentId,
      body: [
        "# Continuation Summary",
        "",
        "## Next Action",
        "",
        "- Wait for reviewer feedback or approval before continuing executor work.",
      ].join("\n"),
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      contextExtras: {
        retryReason: "issue_continuation_needed",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(countExecuteCallsForRun(runId)).toBe(1);
  });
});
