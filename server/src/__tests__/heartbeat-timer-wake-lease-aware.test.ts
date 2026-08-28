import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
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
import { heartbeatService } from "../services/heartbeat.ts";
import { resolveLiveExecutionLeases } from "../services/issue-execution-lease.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Timer-wake lease-aware test run.",
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
    `Skipping timer-wake lease-aware tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

async function cleanupLeaseFixture(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await db.execute(sql.raw(`
        TRUNCATE TABLE
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
      `));
      return;
    } catch (error) {
      const isLateCommentRace =
        error instanceof Error &&
        error.message.includes("issue_comments_issue_id_issues_id_fk");
      if (!isLateCommentRace || attempt === 9) {
        throw error;
      }
      // Heartbeat completion can write issue-thread comments shortly after the
      // run leaves queued/running. Retry the dependent deletes once those land.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

type Seed = { companyId: string; agentId: string };

describeEmbeddedPostgres("unscoped timer wake: lease-aware actionability (SUP-14301)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-timer-wake-lease-aware-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 60_000);

  afterEach(async () => {
    // Drain before resetting the mock so in-flight adapter calls from the
    // just-finished test cannot leak into the next test's call count.
    await heartbeat.drainActiveRunExecutions();
    await new Promise((resolve) => setTimeout(resolve, 50));
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Timer-wake lease-aware test run.",
      provider: "test",
      model: "test-model",
    }));
    await cleanupLeaseFixture(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(opts: { heartbeat?: Record<string, unknown> } = {}): Promise<Seed> {
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
      name: "Be Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          wakeOnDemand: true,
          maxConcurrentRuns: 20,
          ...opts.heartbeat,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  /**
   * One agent, one assigned in_progress issue, and a run in `status` holding
   * the issue's execution lease (executionRunId by default, checkoutRunId via
   * `viaCheckout`).
   */
  async function seedLeasedIssue(input: {
    companyId: string;
    agentId: string;
    status: string;
    holderAgentId?: string;
    viaCheckout?: boolean;
  }) {
    const issueId = randomUUID();
    const holderRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId: input.companyId,
      agentId: input.holderAgentId ?? input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.status,
      startedAt: input.status === "running" ? new Date() : null,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: `Leased issue ${issueId.slice(0, 8)}`,
      status: "in_progress",
      priority: "high",
      assigneeAgentId: input.agentId,
      executionRunId: input.viaCheckout ? null : holderRunId,
      checkoutRunId: input.viaCheckout ? holderRunId : null,
      executionAgentNameKey: "be agent",
      executionLockedAt: new Date(),
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `TLEAS-${issueId.slice(0, 8).toUpperCase()}`,
    });
    return { issueId, holderRunId };
  }

  async function seedPlainIssue(companyId: string, agentId: string, status: "todo" | "in_progress" = "todo") {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Free issue ${issueId.slice(0, 8)}`,
      status,
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 2,
      identifier: `TFREE-${issueId.slice(0, 8).toUpperCase()}`,
    });
    return { issueId };
  }

  /** A queued generic timer run: context carries no issueId/taskId/taskKey. */
  async function seedQueuedGenericTimerRun(
    companyId: string,
    agentId: string,
    contextExtras: Record<string, unknown> = {},
  ) {
    const wakeupId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      companyId,
      agentId,
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      payload: { source: "scheduler", reason: "interval_elapsed" },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: wakeupId,
      contextSnapshot: {
        source: "scheduler",
        reason: "interval_elapsed",
        now: new Date().toISOString(),
        timerClaimWasFirstHeartbeat: false,
        ...contextExtras,
      },
    });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeupId));
    return { runId, wakeupId };
  }

  const readRun = (runId: string) =>
    db
      .select({
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

  describe("resolveLiveExecutionLeases", () => {
    it("counts a lease as live only when the referenced run is running", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const { issueId, holderRunId } = await seedLeasedIssue({ companyId, agentId, status: "running" });

      const leases = await resolveLiveExecutionLeases(db, companyId, [issueId]);
      expect(leases.get(issueId)).toMatchObject({
        runId: holderRunId,
        agentId,
        status: "running",
      });
      expect(leases.get(issueId)?.startedAt).toBeInstanceOf(Date);
    });

    it("does not count queued or scheduled_retry runs as live leases", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const queued = await seedLeasedIssue({ companyId, agentId, status: "queued" });
      const scheduledRetry = await seedLeasedIssue({ companyId, agentId, status: "scheduled_retry" });

      const leases = await resolveLiveExecutionLeases(db, companyId, [
        queued.issueId,
        scheduledRetry.issueId,
      ]);
      expect(leases.size).toBe(0);
    });

    it("resolves checkoutRunId as well as executionRunId", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const { issueId, holderRunId } = await seedLeasedIssue({
        companyId,
        agentId,
        status: "running",
        viaCheckout: true,
      });

      const leases = await resolveLiveExecutionLeases(db, companyId, [issueId]);
      expect(leases.get(issueId)?.runId).toBe(holderRunId);
    });

    it("prefers executionRunId over checkoutRunId when both are live", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = randomUUID();
      const execHolder = randomUUID();
      const checkoutHolder = randomUUID();
      await db.insert(heartbeatRuns).values([
        {
          id: execHolder,
          companyId,
          agentId,
          invocationSource: "assignment",
          status: "running",
          startedAt: new Date(),
          contextSnapshot: { issueId },
        },
        {
          id: checkoutHolder,
          companyId,
          agentId,
          invocationSource: "automation",
          status: "running",
          startedAt: new Date(),
          contextSnapshot: { issueId },
        },
      ]);
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Double-leased issue ${issueId.slice(0, 8)}`,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        executionRunId: execHolder,
        checkoutRunId: checkoutHolder,
        responsibleUserId: "responsible-user",
        issueNumber: 1,
        identifier: `TDBL-${issueId.slice(0, 8).toUpperCase()}`,
      });

      const leases = await resolveLiveExecutionLeases(db, companyId, [issueId]);
      expect(leases.get(issueId)?.runId).toBe(execHolder);
    });

    it("excludes the run named by excludeRunId from holder consideration", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const { issueId, holderRunId } = await seedLeasedIssue({ companyId, agentId, status: "running" });

      const withoutExclusion = await resolveLiveExecutionLeases(db, companyId, [issueId]);
      expect(withoutExclusion.get(issueId)?.runId).toBe(holderRunId);
      const withExclusion = await resolveLiveExecutionLeases(db, companyId, [issueId], {
        excludeRunId: holderRunId,
      });
      expect(withExclusion.size).toBe(0);
    });

    it("returns an empty map for an empty issue set and ignores other companies", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const { issueId } = await seedPlainIssue(companyId, agentId);
      const foreign = await seedCompanyAndAgent();
      const foreignIssue = randomUUID();
      await db.insert(issues).values({
        id: foreignIssue,
        companyId: foreign.companyId,
        title: `Foreign issue ${foreignIssue.slice(0, 8)}`,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: foreign.agentId,
        responsibleUserId: "responsible-user",
        issueNumber: 1,
        identifier: `TFOE-${foreignIssue.slice(0, 8).toUpperCase()}`,
      });

      expect((await resolveLiveExecutionLeases(db, companyId, [])).size).toBe(0);
      expect((await resolveLiveExecutionLeases(db, companyId, [foreignIssue])).size).toBe(0);
      expect((await resolveLiveExecutionLeases(db, foreign.companyId, [issueId])).size).toBe(0);
    });
  });

  describe("enqueue gate: generic timer wake is lease-aware", () => {
    it("skips with heartbeat.timer.all_work_leased when every assigned issue is held by a live run", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent({
        heartbeat: { skipTimerWhenNoActionableWork: true },
      });
      const { holderRunId } = await seedLeasedIssue({ companyId, agentId, status: "running" });
      const [baseline] = await db
        .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
        .from(agents)
        .where(eq(agents.id, agentId));

      const run = await heartbeat.wakeup(agentId, {
        source: "timer",
        triggerDetail: "system",
      });

      expect(run).toBeNull();
      const [wakeup] = await db
        .select({
          status: agentWakeupRequests.status,
          reason: agentWakeupRequests.reason,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      const runRows = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      const [after] = await db
        .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
        .from(agents)
        .where(eq(agents.id, agentId));

      expect(wakeup).toMatchObject({ status: "skipped", reason: "heartbeat.timer.all_work_leased" });
      expect(wakeup?.payload).toMatchObject({
        heartbeatSkip: {
          reason: expect.stringContaining("live execution run"),
          holderRunIds: expect.arrayContaining([expect.any(String)]),
        },
      });
      // No new timer run was enqueued: the only run for this agent is the holder.
      expect(runRows).toHaveLength(1);
      expect(runRows[0]).toEqual({ id: holderRunId, status: "running" });
      // markTimerHeartbeatChecked still ran on this path.
      expect(after?.lastHeartbeatAt).toBeInstanceOf(Date);
      if (baseline?.lastHeartbeatAt) {
        expect(after!.lastHeartbeatAt!.getTime()).toBeGreaterThan(baseline.lastHeartbeatAt.getTime());
      }
    });

    it("keeps heartbeat.timer.no_actionable_work for the nothing-assigned case", async () => {
      const { agentId } = await seedCompanyAndAgent({
        heartbeat: { skipTimerWhenNoActionableWork: true },
      });

      const run = await heartbeat.wakeup(agentId, { source: "timer", triggerDetail: "system" });

      expect(run).toBeNull();
      const [wakeup] = await db
        .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      expect(wakeup).toMatchObject({ status: "skipped", reason: "heartbeat.timer.no_actionable_work" });
    });

    it("enqueues the timer run when at least one assigned issue is lease-free", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent({
        heartbeat: { skipTimerWhenNoActionableWork: true },
      });
      await seedLeasedIssue({ companyId, agentId, status: "running" });
      await seedPlainIssue(companyId, agentId);

      const run = await heartbeat.wakeup(agentId, { source: "timer", triggerDetail: "system" });

      expect(run).not.toBeNull();
      const row = await readRun(run!.id);
      // Claimed past the lease gate: the lease-free issue makes the wake actionable.
      expect(row?.status).not.toBe("queued");
    });

    it("does not treat a queued (non-live) lease as a holder", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent({
        heartbeat: { skipTimerWhenNoActionableWork: true },
      });
      await seedLeasedIssue({ companyId, agentId, status: "queued" });

      const run = await heartbeat.wakeup(agentId, { source: "timer", triggerDetail: "system" });

      expect(run).not.toBeNull();
    });
  });

  describe("claim gate: generic timer run re-evaluates leases at claim time", () => {
    it("declines to claim a generic timer run when all assigned work is leased", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const { holderRunId } = await seedLeasedIssue({ companyId, agentId, status: "running" });
      const { runId } = await seedQueuedGenericTimerRun(companyId, agentId);

      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();

      const timer = await readRun(runId);
      expect(timer?.status).toBe("queued");
      expect(timer?.startedAt).toBeNull();
      const holder = await readRun(holderRunId);
      expect(holder?.status).toBe("running");
      expect(mockAdapterExecute).not.toHaveBeenCalled();
    });

    it("records a board-visible, deduplicated deferral per live holder", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const { issueId, holderRunId } = await seedLeasedIssue({ companyId, agentId, status: "running" });
      const { runId } = await seedQueuedGenericTimerRun(companyId, agentId);

      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();

      const event = await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, runId),
            eq(activityLog.action, "issue.concurrent_run_deferred"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      expect(event?.details).toMatchObject({
        issueId,
        deferredRunId: runId,
        holderRunId,
        holderStatus: "running",
      });

      // The record is deduplicated: a second sweep writes no fresh row.
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const rows = await db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, runId),
            eq(activityLog.action, "issue.concurrent_run_deferred"),
          ),
        );
      expect(rows).toHaveLength(1);
    });

    it("claims the generic timer run once the lease is released", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const { holderRunId } = await seedLeasedIssue({ companyId, agentId, status: "running" });
      const { runId } = await seedQueuedGenericTimerRun(companyId, agentId);

      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, holderRunId));
      await db.update(issues).set({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      });

      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();

      const timer = await readRun(runId);
      expect(timer?.status).not.toBe("queued");
    });

    it("leaves issue-scoped queued runs unaffected by the generic timer gate", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const { holderRunId } = await seedLeasedIssue({ companyId, agentId, status: "running" });
      const { issueId } = await seedPlainIssue(companyId, agentId, "in_progress");
      // A queued assignment run scoped at a different, lease-free issue.
      const scopedWakeupId = randomUUID();
      const scopedRunId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: scopedWakeupId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        status: "queued",
      });
      await db.insert(heartbeatRuns).values({
        id: scopedRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: scopedWakeupId,
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      });
      await db.update(agentWakeupRequests).set({ runId: scopedRunId }).where(eq(agentWakeupRequests.id, scopedWakeupId));

      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();

      // The issue-scoped run is governed only by findRunningIssueRunForAgent:
      // its issue is not running on this agent, so it claims even though
      // another assigned issue is leased.
      const scoped = await readRun(scopedRunId);
      expect(scoped?.status).not.toBe("queued");
      const holder = await readRun(holderRunId);
      expect(holder?.status).toBe("running");
    });
  });
});
