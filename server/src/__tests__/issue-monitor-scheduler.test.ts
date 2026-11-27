import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as IssueRecoveryActionsModule from "../services/issue-recovery-actions.ts";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueDocuments,
  issues,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dispatchQuiesce } from "../services/dispatch-quiesce.ts";
import { activityService } from "../services/activity.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.ts";
import { applyIssueExecutionPolicyTransition, buildIssueMonitorClearedPatch, normalizeIssueExecutionPolicy, parseIssueExecutionState, setIssueExecutionPolicyMonitorScheduledBy } from "../services/issue-execution-policy.ts";

const recoveryActionHook = vi.hoisted(() => ({
  afterUpsert: null as null | (() => Promise<void>),
}));

// Lets a test run work between the recovery-action upsert and the monitor
// clear, which is where a concurrent re-arm can land in production.
vi.mock("../services/issue-recovery-actions.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof IssueRecoveryActionsModule>();
  return {
    ...actual,
    issueRecoveryActionService: (...args: Parameters<typeof actual.issueRecoveryActionService>) => {
      const service = actual.issueRecoveryActionService(...args);
      return {
        ...service,
        upsertSourceScoped: async (...upsertArgs: Parameters<typeof service.upsertSourceScoped>) => {
          const result = await service.upsertSourceScoped(...upsertArgs);
          await recoveryActionHook.afterUpsert?.();
          return result;
        },
      };
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue monitor scheduler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue monitor scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const seededAgentIds = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-monitor-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  async function waitForHeartbeatIdle(timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
      if (active.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat runs to settle");
  }

  async function cleanupRows() {
    // Triggering a monitor enqueues an on-demand wake, which dispatches a
    // heartbeat run fire-and-forget (startNextQueuedRunForAgent → executeRun),
    // and that run keeps writing rows after tickTimers resolves. Await the
    // in-flight executions the service tracks for exactly this purpose, the
    // same way heartbeat-issue-liveness-escalation.test.ts does.
    //
    // Draining alone is not enough here. These fixtures run a `process` adapter
    // that produces no output, so every dispatched run fails immediately and
    // terminal-run recovery re-dispatches the assigned issue, which fails again:
    // a self-feeding chain that emitted 445 run starts for one agent in 90s on
    // CI. drainActiveRunExecutions() waits until the in-flight set is empty, so
    // against an endless chain it never returns and the hook died at its 30s
    // budget. Engage the dispatch quiesce first (the lever deploys use to stop
    // starting new work while letting in-flight runs finish), so the chain has a
    // last link and the drain terminates.
    await heartbeatService(db).drainActiveRunExecutions();
    await db.delete(heartbeatRunEvents);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  afterEach(async () => {
    // The no-op process fixtures deliberately leave no task disposition. The
    // real lifecycle can now leave a bounded, scheduled repair after the
    // monitor assertions. Cancel that remaining work only during teardown.
    const heartbeat = heartbeatService(db);
    await heartbeat.drainActiveRunExecutions();
    const pending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
    for (const run of pending) await heartbeat.cancelRun(run.id, "Monitor fixture teardown", { suppressImmediateRecovery: true });
    await heartbeat.drainActiveRunExecutions();
    seededAgentIds.clear();
    // Hold the quiesce across every retry, not just one cleanupRows call, so a
    // failed attempt cannot hand the next one a freshly dispatched run.
    dispatchQuiesce.engage({ reason: "issue-monitor-scheduler teardown", ttlMs: 60_000 });
    try {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await cleanupRows();
          return;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      throw lastError;
    } finally {
      dispatchQuiesce.release();
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(input?: {
    agentStatus?: "active" | "paused";
    issueStatus?: "backlog" | "todo" | "in_progress" | "in_review" | "blocked";
    unassigned?: boolean;
    monitorAttemptCount?: number;
    monitor?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const nextCheckAt = new Date("2026-04-11T12:30:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    const monitorAttemptCount = input?.monitorAttemptCount ?? 0;
    const monitor: Record<string, unknown> = {
      nextCheckAt: nextCheckAt.toISOString(),
      notes: "Check deploy",
      scheduledBy: "assignee",
      ...(input?.monitor ?? {}),
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Monitor Bot",
      role: "engineer",
      status: input?.agentStatus ?? "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    seededAgentIds.add(agentId);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Watch external deploy",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: input?.unassigned ? null : agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor,
      },
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "scheduled",
          nextCheckAt: nextCheckAt.toISOString(),
          lastTriggeredAt: null,
          attemptCount: monitorAttemptCount,
          notes: "Check deploy",
          scheduledBy: "assignee",
          serviceName: typeof monitor.serviceName === "string" ? monitor.serviceName : null,
          externalRef: typeof monitor.externalRef === "string" ? monitor.externalRef : null,
          timeoutAt: typeof monitor.timeoutAt === "string" ? monitor.timeoutAt : null,
          maxAttempts: typeof monitor.maxAttempts === "number" ? monitor.maxAttempts : null,
          recoveryPolicy: typeof monitor.recoveryPolicy === "string" ? monitor.recoveryPolicy : null,
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorNextCheckAt: nextCheckAt,
      monitorAttemptCount,
      monitorNotes: "Check deploy",
      monitorScheduledBy: "assignee",
    });

    return { companyId, agentId, issueId, nextCheckAt };
  }

  it("triggers due issue monitors once and clears the one-shot schedule", async () => {
    const { issueId, agentId } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorAttemptCount).toBe(1);
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(tickAt.toISOString());
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
      lastTriggeredAt: tickAt.toISOString(),
      attemptCount: 1,
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_triggered");
    expect(activity).not.toContain("issue.monitor_unfireable");
  });

  it.each(["unknown", "exhausted"] as const)("does not replay a quota monitor with %s execution evidence", async (kind) => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId } = await seedFixture({
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId, status: "failed", errorCode: "provider_quota",
      finishedAt: new Date("2026-04-11T12:00:00.000Z"), contextSnapshot: { issueId },
      scheduledRetryAttempt: kind === "exhausted" ? 2 : 0,
      resultJson: kind === "exhausted" ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } : null,
    });
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select().from(issueRecoveryActions)).toMatchObject([{ ownerType: "board", evidence: { runId: sourceRunId } }]);
  });

  it("wakes a cross-agent review participant for provider quota monitors", async () => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId: assigneeAgentId } = await seedFixture({
      issueStatus: "in_review",
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });
    const participantAgentId = randomUUID();
    await db.insert(agents).values({
      id: participantAgentId,
      companyId,
      name: "Quota-limited reviewer",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    seededAgentIds.add(participantAgentId);
    const monitorState = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => parseIssueExecutionState(rows[0]?.executionState ?? null)?.monitor ?? null);
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: participantAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: assigneeAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: monitorState,
      },
    }).where(eq(issues.id, issueId));
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId: participantAgentId, status: "failed",
      errorCode: "provider_quota", finishedAt: new Date("2026-04-11T12:00:00.000Z"),
      contextSnapshot: { issueId },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      agentId: participantAgentId,
      reason: "execution_review_participant_recovery",
    });
    const [scheduled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, sourceRunId));
    expect(scheduled).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
    expect(await heartbeat.promoteDueScheduledRetries(scheduled.scheduledRetryAt!)).toMatchObject({ promoted: 1 });
    await heartbeat.resumeQueuedRuns();
    await waitForHeartbeatIdle();
    const participantRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, participantAgentId));
    expect(participantRuns).toHaveLength(2);
    expect(participantRuns.find((run) => run.id === scheduled.id)?.errorCode).not.toBe("issue_assignee_changed");
  });

  it("lets the board trigger a scheduled issue monitor immediately", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const triggeredAt = new Date("2026-04-11T12:00:00.000Z");

    const result = await heartbeat.triggerIssueMonitor(issueId, {
      now: triggeredAt,
      actorType: "user",
      actorId: "local-board",
    });

    expect(result.outcome).toBe("triggered");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(triggeredAt.toISOString());
    expect(issue.monitorAttemptCount).toBe(1);
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .orderBy(activityLog.createdAt);
    expect(activity.map((row) => row.action)).toContain("issue.monitor_triggered");
    const triggerEvent = activity.find((row) => row.action === "issue.monitor_triggered");
    expect(triggerEvent?.actorType).toBe("user");
    expect(triggerEvent?.actorId).toBe("local-board");
    expect(triggerEvent?.details).toMatchObject({
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });
  });

  it("clears due monitors that cannot be dispatched and records a skip", async () => {
    const { issueId } = await seedFixture({ agentStatus: "paused" });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "dispatch_skipped",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_skipped");
  });

  it("clears exhausted monitors and queues bounded owner recovery instead of another due check", async () => {
    const { issueId, agentId } = await seedFixture({
      monitorAttemptCount: 1,
      monitor: {
        maxAttempts: 1,
        recoveryPolicy: "wake_owner",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "max_attempts_exhausted",
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_recovery");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      clearReason: "max_attempts_exhausted",
      maxAttempts: 1,
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_exhausted");
    expect(activity).toContain("issue.monitor_recovery_wake_queued");
    expect(activity).not.toContain("issue.monitor_triggered");
  });

  it("clears timed-out monitors and creates a visible recovery issue when requested", async () => {
    const { issueId, companyId } = await seedFixture({
      monitor: {
        timeoutAt: "2026-04-11T12:00:00.000Z",
        recoveryPolicy: "create_recovery_issue",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "timeout_exceeded",
    });

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, issueId))
      .then((rows) => rows.find((row) => row.companyId === companyId && row.originKind === "stranded_issue_recovery") ?? null);
    expect(recoveryIssue).toMatchObject({
      parentId: issueId,
      priority: "high",
      assigneeAdapterOverrides: null,
    });
    expect(["todo", "in_progress"]).toContain(recoveryIssue?.status);
  });

  it("omits external monitor refs from wake payloads and activity details", async () => {
    const { issueId, agentId } = await seedFixture({
      monitor: {
        serviceName: "Deploy provider",
        externalRef: "https://provider.example/deploy/123?token=secret",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    await heartbeat.tickTimers(tickAt);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(JSON.stringify(wakeup?.payload)).not.toContain("provider.example");
    expect(wakeup?.payload).not.toHaveProperty("externalRef");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(JSON.stringify(activity.map((row) => row.details))).not.toContain("provider.example");
    expect(activity.find((row) => row.action === "issue.monitor_triggered")?.details).not.toHaveProperty("externalRef");
  });

  // SUP-23786: the legal arm -> fire -> re-arm sequence through exhaustion. The
  // re-arm after the last permitted fire used to be refused, so the configured
  // recoveryPolicy could never run and the monitor went silently dormant.
  describe("exhaustion of an agent-rearmed monitor (SUP-23786)", () => {
    const firstTickAt = new Date("2026-04-11T12:31:00.000Z");
    const rearmCheckAt = "2026-04-11T13:00:00.000Z";
    const recoveryTickAt = new Date("2026-04-11T13:01:00.000Z");

    async function readIssue(issueId: string) {
      return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    }

    async function exhaustionRows(issueId: string) {
      return db
        .select()
        .from(activityLog)
        .where(eq(activityLog.entityId, issueId))
        .then((rows) => rows.filter((row) => row.action === "issue.monitor_exhausted"));
    }

    async function recoveryWakeups(agentId: string) {
      return db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId))
        // A recovery wake can coalesce into the owner's active run (reason rewritten),
        // so identify it by its idempotency key.
        .then((rows) => rows.filter((row) => row.idempotencyKey?.startsWith("issue-monitor-recovery:")));
    }

    // Applies the owner's policy PATCH the way the issues route does: stamp the
    // actor's scheduledBy, run the policy transition, persist policy + patch.
    async function rearm(issueId: string, scheduledBy: "assignee" | "board", monitor: Record<string, unknown>) {
      const issue = await readIssue(issueId);
      const policy = setIssueExecutionPolicyMonitorScheduledBy(
        normalizeIssueExecutionPolicy({ stages: [], monitor: { nextCheckAt: rearmCheckAt, ...monitor } }),
        scheduledBy,
      );
      const { patch } = applyIssueExecutionPolicyTransition({
        issue,
        policy,
        previousPolicy: normalizeIssueExecutionPolicy(issue.executionPolicy ?? null),
        requestedAssigneePatch: {},
        actor: { agentId: issue.assigneeAgentId },
        monitorExplicitlyUpdated: true,
      });
      await db
        .update(issues)
        .set({ executionPolicy: policy as unknown as Record<string, unknown>, ...patch })
        .where(eq(issues.id, issueId));
    }

    async function armFireAndSettle(monitor: Record<string, unknown>) {
      const fixture = await seedFixture({ monitor });
      const heartbeat = heartbeatService(db);
      expect((await heartbeat.tickTimers(firstTickAt)).enqueued).toBe(1);
      await heartbeat.drainActiveRunExecutions();
      const fired = await readIssue(fixture.issueId);
      expect(fired.monitorAttemptCount).toBe(1);
      expect(fired.monitorNextCheckAt).toBeNull();
      return { ...fixture, heartbeat };
    }

    it("wake_owner: the re-arm after the last permitted fire runs the owner recovery wake once", async () => {
      const monitor = { maxAttempts: 1, recoveryPolicy: "wake_owner" };
      const { issueId, agentId, heartbeat } = await armFireAndSettle(monitor);

      await rearm(issueId, "assignee", monitor);
      const rearmed = await readIssue(issueId);
      expect(rearmed.monitorNextCheckAt?.toISOString()).toBe(rearmCheckAt);
      expect(rearmed.monitorAttemptCount).toBe(1);

      const tick = await heartbeat.tickTimers(recoveryTickAt);
      expect(tick.skipped).toBe(1);

      const issue = await readIssue(issueId);
      expect(issue.monitorNextCheckAt).toBeNull();
      expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
        status: "cleared",
        clearReason: "max_attempts_exhausted",
        attemptCount: 1,
      });

      const rows = await exhaustionRows(issueId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorType: "system", actorId: "heartbeat_scheduler" });
      expect(rows[0]!.details).toMatchObject({
        clearReason: "max_attempts_exhausted",
        attemptCount: 1,
        attemptedAttemptCount: 2,
        maxAttempts: 1,
        recoveryPolicy: "wake_owner",
        recoveryOutcome: "owner_wake_queued",
      });

      // Recovery targets the monitor owner as the system actor, never the re-arming principal.
      const wakeups = await recoveryWakeups(agentId);
      expect(wakeups).toHaveLength(1);
      expect(wakeups[0]).toMatchObject({ requestedByActorType: "system", requestedByActorId: "heartbeat_scheduler" });
      expect(wakeups[0]!.payload).toMatchObject({ issueId, clearReason: "max_attempts_exhausted", maxAttempts: 1 });

      // A second tick (and a manual trigger) neither records a second exhaustion nor recovers again.
      expect((await heartbeat.tickTimers(new Date("2026-04-11T13:02:00.000Z"))).skipped).toBe(0);
      await expect(heartbeat.triggerIssueMonitor(issueId)).rejects.toThrow("Issue has no scheduled monitor");
      expect(await exhaustionRows(issueId)).toHaveLength(1);
      expect(await recoveryWakeups(agentId)).toHaveLength(1);
    });

    it("create_recovery_issue: opens one recovery issue assigned to the monitor owner", async () => {
      const monitor = { maxAttempts: 1, recoveryPolicy: "create_recovery_issue" };
      const { issueId, agentId, companyId, heartbeat } = await armFireAndSettle(monitor);

      await rearm(issueId, "assignee", monitor);
      expect((await heartbeat.tickTimers(recoveryTickAt)).skipped).toBe(1);
      await heartbeat.drainActiveRunExecutions();
      await heartbeat.tickTimers(new Date("2026-04-11T13:02:00.000Z"));

      const recoveryIssues = await db
        .select()
        .from(issues)
        .then((rows) => rows.filter((row) => row.companyId === companyId && row.originId === issueId));
      expect(recoveryIssues).toHaveLength(1);
      expect(recoveryIssues[0]).toMatchObject({
        parentId: issueId,
        assigneeAgentId: agentId,
        originKind: "stranded_issue_recovery",
      });

      const rows = await exhaustionRows(issueId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.details).toMatchObject({
        clearReason: "max_attempts_exhausted",
        attemptCount: 1,
        maxAttempts: 1,
        recoveryPolicy: "create_recovery_issue",
        recoveryOutcome: "recovery_issue_created",
      });
    });

    it("escalate_to_board: records one board escalation comment", async () => {
      const monitor = { maxAttempts: 1, recoveryPolicy: "escalate_to_board" };
      const { issueId, heartbeat } = await armFireAndSettle(monitor);

      await rearm(issueId, "assignee", monitor);
      expect((await heartbeat.tickTimers(recoveryTickAt)).skipped).toBe(1);
      expect((await heartbeat.tickTimers(new Date("2026-04-11T13:02:00.000Z"))).skipped).toBe(0);

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0]!.body).toContain("maximum attempt count was reached");

      const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
      expect(activity.filter((row) => row.action === "issue.monitor_escalated_to_board")).toHaveLength(1);
      const rows = await exhaustionRows(issueId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.details).toMatchObject({
        recoveryPolicy: "escalate_to_board",
        recoveryOutcome: "escalated_to_board",
      });
    });

    // The recovery must not be re-armable: after it ran, the same agent's next
    // exhausted re-arm is refused, so each recoveryPolicy acts once per arming
    // epoch no matter how many times the agent re-arms (SUP-23786).
    it.each([
      ["wake_owner", { maxAttempts: 1 }],
      ["create_recovery_issue", { maxAttempts: 1 }],
      ["escalate_to_board", { maxAttempts: 1 }],
      ["escalate_to_board", { timeoutAt: "2026-04-11T12:45:00.000Z" }],
    ] as const)("%s runs once across three arm -> exhaustion cycles (%j)", async (recoveryPolicy, bound) => {
      const monitor = { ...bound, recoveryPolicy };
      const { issueId, agentId, companyId, heartbeat } = await armFireAndSettle(monitor);
      const recoveryIssueRows = () =>
        db
          .select()
          .from(issues)
          .then((rows) => rows.filter((row) => row.companyId === companyId && row.originId === issueId));
      const effects = async () => ({
        exhaustions: (await exhaustionRows(issueId)).length,
        wakeups: (await recoveryWakeups(agentId)).length,
        recoveryIssues: (await recoveryIssueRows()).length,
        comments: (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).length,
      });

      await rearm(issueId, "assignee", monitor);
      await heartbeat.tickTimers(recoveryTickAt);
      await heartbeat.drainActiveRunExecutions();
      const afterFirstCycle = await effects();
      expect(afterFirstCycle.exhaustions).toBe(1);
      const before = await readIssue(issueId);
      expect(before.monitorAttemptCount).toBe(1);

      for (const cycle of [2, 3]) {
        // Closing the recovery work must not re-open the loop.
        await db.update(issues).set({ status: "done" }).where(eq(issues.originId, issueId));
        await expect(rearm(issueId, "assignee", monitor)).rejects.toMatchObject({
          status: 422,
          message: "Monitor bounds are already exhausted",
        });
        await heartbeat.tickTimers(new Date(`2026-04-11T13:0${cycle}:00.000Z`));
        await heartbeat.drainActiveRunExecutions();
        expect(await effects()).toEqual(afterFirstCycle);
      }
      const after = await readIssue(issueId);
      expect(after.monitorNextCheckAt).toBeNull();
      expect(after.monitorAttemptCount).toBe(before.monitorAttemptCount);
    });

    async function recoveryEffects(issueId: string, agentId: string, companyId: string) {
      const created = await db
        .select()
        .from(issues)
        .then((rows) => rows.filter((row) => row.companyId === companyId && row.originId === issueId));
      return {
        exhaustions: (await exhaustionRows(issueId)).length,
        wakeups: (await recoveryWakeups(agentId)).length,
        recoveryIssues: created.length,
        comments: (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).length,
      };
    }

    async function clearMonitorAs(issueId: string, clearReason: Parameters<typeof buildIssueMonitorClearedPatch>[0]["clearReason"]) {
      const issue = await readIssue(issueId);
      const patch = buildIssueMonitorClearedPatch({
        issue,
        policy: normalizeIssueExecutionPolicy(issue.executionPolicy ?? null),
        clearReason,
      });
      await db.update(issues).set(patch).where(eq(issues.id, issueId));
    }

    // The bound is a sticky persisted fact, not a function of the last clearReason or of
    // the bounds the agent writes next: nothing an agent does gets a second recovery.
    it.each(["wake_owner", "create_recovery_issue", "escalate_to_board"] as const)(
      "%s: clears and re-arms with any bounds never run a second recovery",
      async (recoveryPolicy) => {
        const monitor = { maxAttempts: 1, recoveryPolicy };
        const { issueId, agentId, companyId, heartbeat } = await armFireAndSettle(monitor);
        await rearm(issueId, "assignee", monitor);
        await heartbeat.tickTimers(recoveryTickAt);
        await heartbeat.drainActiveRunExecutions();
        const afterFirstRecovery = await recoveryEffects(issueId, agentId, companyId);
        expect(afterFirstRecovery.exhaustions).toBe(1);
        expect((await readIssue(issueId)).executionState).toMatchObject({
          monitor: { exhaustionRecoveredAt: recoveryTickAt.toISOString() },
        });

        let minute = 2;
        for (const clearReason of ["manual", "dispatch_skipped", "invalid_status"] as const) {
          await clearMonitorAs(issueId, clearReason);
          for (const bounds of [{ maxAttempts: 1 }, { maxAttempts: 5 }, { timeoutAt: "2026-12-31T00:00:00.000Z" }]) {
            await expect(rearm(issueId, "assignee", { ...bounds, recoveryPolicy })).rejects.toMatchObject({
              status: 422,
              message: "Monitor bounds are already exhausted",
            });
          }
          await heartbeat.tickTimers(new Date(`2026-04-11T13:${String(minute).padStart(2, "0")}:00.000Z`));
          await heartbeat.drainActiveRunExecutions();
          minute += 1;
          expect(await recoveryEffects(issueId, agentId, companyId)).toEqual(afterFirstRecovery);
        }
        const after = await readIssue(issueId);
        expect(after.monitorNextCheckAt).toBeNull();
        expect(after.monitorAttemptCount).toBe(1);
      },
    );

    it("only a board-armed write ends the epoch; board and no-policy exhaustion leave no sticky fact", async () => {
      const monitor = { maxAttempts: 1, recoveryPolicy: "wake_owner" };
      const { issueId, heartbeat } = await armFireAndSettle(monitor);
      await rearm(issueId, "assignee", monitor);
      await heartbeat.tickTimers(recoveryTickAt);
      await heartbeat.drainActiveRunExecutions();

      await rearm(issueId, "board", { maxAttempts: 5, recoveryPolicy: "wake_owner" });
      const reset = await readIssue(issueId);
      expect(reset.executionState).toMatchObject({ monitor: { status: "scheduled", attemptCount: 1 } });
      expect(reset.executionState).not.toHaveProperty("monitor.exhaustionRecoveredAt");
      await rearm(issueId, "assignee", { maxAttempts: 5, recoveryPolicy: "wake_owner" });

      // Control: a board-armed monitor that exhausts at dispatch keeps its state shape.
      const boardArmed = await seedFixture({
        monitorAttemptCount: 1,
        monitor: { scheduledBy: "board", maxAttempts: 1, recoveryPolicy: "wake_owner" },
      });
      await heartbeat.tickTimers(new Date("2026-04-11T13:10:00.000Z"));
      const boardIssue = await readIssue(boardArmed.issueId);
      expect(boardIssue.executionState).toMatchObject({ monitor: { status: "cleared", clearReason: "max_attempts_exhausted" } });
      expect(boardIssue.executionState).not.toHaveProperty("monitor.exhaustionRecoveredAt");
      expect((await exhaustionRows(boardArmed.issueId)).length).toBe(1);
    });

    // The exhaustion dispatch must not lose the recovery nor claim an effect that did not happen.
    it("a paused owner defers the recovery: the monitor stays armed, nothing is cleared or recorded, then it recovers once", async () => {
      const monitor = { maxAttempts: 1, recoveryPolicy: "wake_owner" };
      const { issueId, agentId, heartbeat } = await armFireAndSettle(monitor);
      await rearm(issueId, "assignee", monitor);
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));

      await heartbeat.tickTimers(recoveryTickAt);
      const deferred = await readIssue(issueId);
      expect(deferred.monitorNextCheckAt?.toISOString()).toBe(rearmCheckAt);
      expect(deferred.monitorWakeRequestedAt).toBeNull();
      expect(deferred.executionState).toMatchObject({ monitor: { status: "scheduled" } });
      expect(await exhaustionRows(issueId)).toHaveLength(0);

      await db.update(agents).set({ status: "active" }).where(eq(agents.id, agentId));
      await heartbeat.tickTimers(new Date("2026-04-11T13:02:00.000Z"));
      await heartbeat.drainActiveRunExecutions();
      expect(await exhaustionRows(issueId)).toHaveLength(1);
      expect(await recoveryWakeups(agentId)).toHaveLength(1);
      expect((await readIssue(issueId)).monitorNextCheckAt).toBeNull();
    });

    it("an owner that does not accept on-demand wakes gets a truthful outcome, not a queued claim", async () => {
      const monitor = { maxAttempts: 1, recoveryPolicy: "wake_owner" };
      const { issueId, agentId, heartbeat } = await armFireAndSettle(monitor);
      await rearm(issueId, "assignee", monitor);
      await db
        .update(agents)
        .set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } })
        .where(eq(agents.id, agentId));

      await heartbeat.tickTimers(recoveryTickAt);

      const rows = await exhaustionRows(issueId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.details).toMatchObject({ recoveryPolicy: "wake_owner", recoveryOutcome: "owner_wake_not_queued" });
      const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
      expect(activity.map((row) => row.action)).not.toContain("issue.monitor_recovery_wake_queued");
      const queued = (await recoveryWakeups(agentId)).filter((row) => row.status !== "skipped");
      expect(queued).toHaveLength(0);
    });

    it.each([
      ["escalate_to_board", "issue_comments", ""],
      ["create_recovery_issue", "issues", "when (new.origin_kind = 'stranded_issue_recovery')"],
    ] as const)(
      "%s: a failing recovery effect leaves the monitor armed and retries instead of losing the recovery",
      async (recoveryPolicy, table, when) => {
        const monitor = { maxAttempts: 1, recoveryPolicy };
        const { issueId, agentId, companyId, heartbeat } = await armFireAndSettle(monitor);
        await rearm(issueId, "assignee", monitor);

        await db.execute(sql.raw(`
          create or replace function sup23786_fault() returns trigger language plpgsql as $$
          begin raise exception 'sup23786 injected fault'; end $$;
          create trigger sup23786_fault before insert on ${table} for each row ${when} execute function sup23786_fault();
        `));
        try {
          await heartbeat.tickTimers(recoveryTickAt);
          const failed = await readIssue(issueId);
          expect(failed.monitorNextCheckAt?.toISOString()).toBe(rearmCheckAt);
          expect(failed.monitorWakeRequestedAt).toBeNull();
          expect(failed.executionState).toMatchObject({ monitor: { status: "scheduled" } });
          expect(await recoveryEffects(issueId, agentId, companyId)).toMatchObject({ exhaustions: 0, comments: 0, recoveryIssues: 0 });
        } finally {
          await db.execute(sql.raw(`drop trigger if exists sup23786_fault on ${table}; drop function if exists sup23786_fault();`));
        }

        await heartbeat.tickTimers(new Date("2026-04-11T13:02:00.000Z"));
        await heartbeat.drainActiveRunExecutions();
        const effects = await recoveryEffects(issueId, agentId, companyId);
        expect(effects.exhaustions).toBe(1);
        expect(recoveryPolicy === "escalate_to_board" ? effects.comments : effects.recoveryIssues).toBe(1);
        expect((await readIssue(issueId)).monitorNextCheckAt).toBeNull();
      },
    );

    // A failure after the recovery effect but before the completion transaction
    // commits must not make the retry repeat a consumer-visible effect: the next
    // tick records the exhaustion once and every recovery effect stays single.
    it.each([
      ["wake_owner", "issue.monitor_recovery_wake_queued"],
      ["create_recovery_issue", "issue.monitor_recovery_issue_created"],
      ["escalate_to_board", "issue.monitor_escalated_to_board"],
    ] as const)(
      "%s: a completion failure after the effect does not repeat the effect on the next tick",
      async (recoveryPolicy, effectAction) => {
        const monitor = { maxAttempts: 1, recoveryPolicy };
        const { issueId, agentId, companyId, heartbeat } = await armFireAndSettle(monitor);
        await rearm(issueId, "assignee", monitor);
        const effectActivity = async () =>
          (await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))).filter(
            (row) => row.action === effectAction,
          ).length;
        const queuedRecoveryWakeups = async () =>
          (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))).filter(
            (row) =>
              row.status !== "skipped" &&
              (row.idempotencyKey?.startsWith("issue-monitor-recovery:") ||
                row.idempotencyKey?.startsWith("issue-monitor-recovery-issue:")),
          ).length;

        await db.execute(sql.raw(`
          create or replace function sup23786_completion_fault() returns trigger language plpgsql as $$
          begin raise exception 'sup23786 injected completion fault'; end $$;
          create trigger sup23786_completion_fault before insert on activity_log for each row
            when (new.action = 'issue.monitor_exhausted') execute function sup23786_completion_fault();
        `));
        try {
          await heartbeat.tickTimers(recoveryTickAt);
          await heartbeat.drainActiveRunExecutions();
          const failed = await readIssue(issueId);
          expect(failed.monitorNextCheckAt?.toISOString()).toBe(rearmCheckAt);
          expect(failed.executionState).toMatchObject({ monitor: { status: "scheduled" } });
          expect(await exhaustionRows(issueId)).toHaveLength(0);
        } finally {
          await db.execute(
            sql.raw(
              "drop trigger if exists sup23786_completion_fault on activity_log; drop function if exists sup23786_completion_fault();",
            ),
          );
        }

        await heartbeat.tickTimers(new Date("2026-04-11T13:02:00.000Z"));
        await heartbeat.drainActiveRunExecutions();
        await heartbeat.tickTimers(new Date("2026-04-11T13:03:00.000Z"));
        await heartbeat.drainActiveRunExecutions();

        const effects = await recoveryEffects(issueId, agentId, companyId);
        expect(effects.exhaustions).toBe(1);
        expect(await effectActivity()).toBe(1);
        expect(effects.comments).toBe(recoveryPolicy === "escalate_to_board" ? 1 : 0);
        expect(effects.recoveryIssues).toBe(recoveryPolicy === "create_recovery_issue" ? 1 : 0);
        expect(await queuedRecoveryWakeups()).toBe(recoveryPolicy === "escalate_to_board" ? 0 : 1);
        expect((await readIssue(issueId)).monitorNextCheckAt).toBeNull();
      },
    );

    it("timeout: an agent re-arm after timeoutAt still reaches the recovery", async () => {
      const monitor = {
        timeoutAt: "2026-04-11T12:45:00.000Z",
        recoveryPolicy: "escalate_to_board",
      };
      const { issueId, heartbeat } = await armFireAndSettle(monitor);

      await rearm(issueId, "assignee", monitor);
      expect((await heartbeat.tickTimers(recoveryTickAt)).skipped).toBe(1);

      const rows = await exhaustionRows(issueId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.details).toMatchObject({ clearReason: "timeout_exceeded", recoveryOutcome: "escalated_to_board" });
    });

    it.each([
      ["board-armed", "board", { maxAttempts: 1, recoveryPolicy: "wake_owner" }],
      ["no recoveryPolicy", "assignee", { maxAttempts: 1 }],
    ] as const)("%s monitors still refuse the exhausted re-arm and record nothing", async (_label, scheduledBy, monitor) => {
      const { issueId, agentId, heartbeat } = await armFireAndSettle(monitor);
      const before = await readIssue(issueId);

      await expect(rearm(issueId, scheduledBy, monitor)).rejects.toMatchObject({
        status: 422,
        message: "Monitor bounds are already exhausted",
        details: { clearReason: "max_attempts_exhausted" },
      });

      const after = await readIssue(issueId);
      expect(after.monitorNextCheckAt).toBeNull();
      expect(after.executionPolicy).toEqual(before.executionPolicy);
      expect(after.executionState).toEqual(before.executionState);
      expect((await heartbeat.tickTimers(recoveryTickAt)).skipped).toBe(0);
      expect(await exhaustionRows(issueId)).toHaveLength(0);
      expect(await recoveryWakeups(agentId)).toHaveLength(0);
    });

    it("records one exhaustion when overlapping ticks both claim the due monitor", async () => {
      const { issueId, agentId } = await seedFixture({
        monitorAttemptCount: 1,
        monitor: { maxAttempts: 1, recoveryPolicy: "wake_owner" },
      });
      const heartbeat = heartbeatService(db);
      // The later tick's clock is past the first claim's staleness window, so it
      // claims the same row too; only the guarded clear keeps recovery single.
      await Promise.all([
        heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z")),
        heartbeat.tickTimers(new Date("2026-04-11T12:40:00.000Z")),
      ]);

      expect(await exhaustionRows(issueId)).toHaveLength(1);
      expect(await recoveryWakeups(agentId)).toHaveLength(1);
    });
  });

  it("triggers a due monitor on a blocked issue and wakes the assignee", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture({ issueStatus: "blocked" });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorAttemptCount).toBe(1);
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(tickAt.toISOString());
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
      lastTriggeredAt: tickAt.toISOString(),
      attemptCount: 1,
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      nextCheckAt: nextCheckAt.toISOString(),
      source: "scheduled",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_triggered");
  });

  describe("due monitor on an unassigned issue", () => {
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    async function readIssue(issueId: string) {
      return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    }

    async function activityActions(issueId: string) {
      return db
        .select()
        .from(activityLog)
        .where(eq(activityLog.entityId, issueId))
        .then((rows) => rows.map((row) => row.action));
    }

    it.each([
      ["an explicit wake_owner policy", { recoveryPolicy: "wake_owner" }],
      ["no recovery policy (the wake_owner default)", {}],
    ])("raises one board recovery action for %s and stays idempotent", async (_label, monitor) => {
      const { companyId, issueId } = await seedFixture({
        issueStatus: "blocked",
        unassigned: true,
        monitor,
      });
      const heartbeat = heartbeatService(db);

      const first = await heartbeat.tickTimers(tickAt);
      expect(first.skipped).toBe(1);
      expect(first.enqueued).toBe(0);

      const issue = await readIssue(issueId);
      expect(issue.monitorNextCheckAt).toBeNull();
      expect(issue.monitorWakeRequestedAt).toBeNull();
      // The monitor never fired: no attempt and no trigger timestamp are recorded.
      expect(issue.monitorAttemptCount).toBe(0);
      expect(issue.monitorLastTriggeredAt).toBeNull();
      expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
        status: "cleared",
        clearReason: "invalid_assignee",
        attemptCount: 0,
      });

      const actions = await db.select().from(issueRecoveryActions);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        companyId,
        sourceIssueId: issueId,
        kind: "no_live_path_unowned",
        status: "active",
        ownerType: "board",
        ownerAgentId: null,
        fingerprint: `no_live_path_unowned:${companyId}:${issueId}`,
      });
      expect(actions[0]?.evidence).toMatchObject({
        source: "issue_monitor_unassigned_due",
        monitorNextCheckAt: "2026-04-11T12:30:00.000Z",
      });
      expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);

      const second = await heartbeat.tickTimers(new Date(tickAt.getTime() + 60_000));
      expect(second.checked).toBe(0);
      expect(await db.select().from(issueRecoveryActions)).toHaveLength(1);

      const actionsLogged = await activityActions(issueId);
      expect(actionsLogged.filter((action) => action === "issue.monitor_skipped")).toHaveLength(1);
      expect(actionsLogged.filter((action) => action === "issue.no_live_path_unowned_escalated")).toHaveLength(1);
      expect(actionsLogged).not.toContain("issue.monitor_triggered");
    });

    it("keeps a monitor re-armed between the claim and the clear scheduled", async () => {
      const { companyId, issueId } = await seedFixture({
        issueStatus: "blocked",
        unassigned: true,
        monitor: { recoveryPolicy: "wake_owner" },
      });
      const rearmedAt = new Date("2026-04-11T13:30:00.000Z");
      const rearmedMonitor = {
        nextCheckAt: rearmedAt.toISOString(),
        notes: "Re-armed check",
        scheduledBy: "assignee",
        recoveryPolicy: "wake_owner",
      };
      // A re-arm lands while the recovery-action awaits are still running, after
      // the tick claimed the old schedule and before it clears it.
      recoveryActionHook.afterUpsert = async () => {
        await db
          .update(issues)
          .set({
            monitorNextCheckAt: rearmedAt,
            monitorNotes: "Re-armed check",
            monitorWakeRequestedAt: null,
            executionPolicy: { mode: "normal", commentRequired: true, stages: [], monitor: rearmedMonitor },
            executionState: {
              status: "idle",
              currentStageId: null,
              currentStageIndex: null,
              currentStageType: null,
              currentParticipant: null,
              returnAssignee: null,
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
              monitor: {
                status: "scheduled",
                nextCheckAt: rearmedAt.toISOString(),
                lastTriggeredAt: null,
                attemptCount: 0,
                notes: "Re-armed check",
                scheduledBy: "assignee",
                serviceName: null,
                externalRef: null,
                timeoutAt: null,
                maxAttempts: null,
                recoveryPolicy: "wake_owner",
                clearedAt: null,
                clearReason: null,
              },
            },
          })
          .where(eq(issues.id, issueId));
      };
      const heartbeat = heartbeatService(db);

      const first = await heartbeat.tickTimers(tickAt);
      expect(first.skipped).toBe(1);

      const issue = await readIssue(issueId);
      expect(issue.monitorNextCheckAt?.toISOString()).toBe(rearmedAt.toISOString());
      expect(issue.monitorNotes).toBe("Re-armed check");
      expect(normalizeIssueExecutionPolicy(issue.executionPolicy)?.monitor?.notes).toBe("Re-armed check");
      expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
        status: "scheduled",
        nextCheckAt: rearmedAt.toISOString(),
        clearReason: null,
      });
      // The lost race writes neither a skip record nor a second recovery action.
      expect(await activityActions(issueId)).not.toContain("issue.monitor_skipped");
      expect(await db.select().from(issueRecoveryActions)).toHaveLength(1);

      // The surviving schedule still fires, and the active action is reused.
      recoveryActionHook.afterUpsert = null;
      const second = await heartbeat.tickTimers(new Date(rearmedAt.getTime() + 60_000));
      expect(second.skipped).toBe(1);
      expect((await readIssue(issueId)).monitorNextCheckAt).toBeNull();
      const actions = await db.select().from(issueRecoveryActions);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        companyId,
        sourceIssueId: issueId,
        kind: "no_live_path_unowned",
        status: "active",
      });
    });

    it("keeps an existing active recovery action of another kind and still consumes the monitor", async () => {
      const { companyId, issueId } = await seedFixture({
        issueStatus: "blocked",
        unassigned: true,
        monitor: { recoveryPolicy: "wake_owner" },
      });
      await issueRecoveryActionService(db).upsertSourceScoped({
        companyId,
        sourceIssueId: issueId,
        kind: "blocked_without_blockers",
        ownerType: "board",
        cause: "blocked_without_blockers",
        fingerprint: `blocked_without_blockers:${companyId}:${issueId}`,
        evidence: {},
        nextAction: "Name the blocker.",
        wakePolicy: null,
        monitorPolicy: null,
        maxAttempts: null,
      });

      await heartbeatService(db).tickTimers(tickAt);

      const actions = await db.select().from(issueRecoveryActions);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ kind: "blocked_without_blockers", status: "active" });
      expect((await readIssue(issueId)).monitorNextCheckAt).toBeNull();
      expect(await activityActions(issueId)).not.toContain("issue.no_live_path_unowned_escalated");
    });

    it.each(["create_recovery_issue", "escalate_to_board"] as const)(
      "leaves a %s monitor untouched",
      async (recoveryPolicy) => {
        const { issueId, nextCheckAt } = await seedFixture({
          issueStatus: "blocked",
          unassigned: true,
          monitor: { recoveryPolicy },
        });
        const heartbeat = heartbeatService(db);

        const result = await heartbeat.tickTimers(tickAt);

        expect(result.checked).toBe(0);
        const issue = await readIssue(issueId);
        expect(issue.monitorNextCheckAt?.toISOString()).toBe(nextCheckAt.toISOString());
        expect(issue.monitorWakeRequestedAt).toBeNull();
        expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
        expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
        // Untouched, but not silent: the issue activity names why it cannot fire.
        const rows = await activityService(db).forIssue(issueId);
        expect(rows.map((row) => row.action)).toEqual(["issue.monitor_unfireable"]);
        expect(rows[0]?.details).toMatchObject({
          reason: "no_assignee_agent",
          recoveryPolicy,
          nextCheckAt: nextCheckAt.toISOString(),
        });
      },
    );

    it("does not raise a recovery action for an assigned wake_owner monitor", async () => {
      const { issueId, agentId } = await seedFixture({
        issueStatus: "blocked",
        monitor: { recoveryPolicy: "wake_owner" },
      });

      const result = await heartbeatService(db).tickTimers(tickAt);

      expect(result.enqueued).toBe(1);
      expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
      const wakeup = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId))
        .then((rows) => rows[0] ?? null);
      expect(wakeup?.reason).toBe("issue_monitor_due");
      expect((await readIssue(issueId)).monitorAttemptCount).toBe(1);
      expect(await activityActions(issueId)).toContain("issue.monitor_triggered");
    });
  });

  describe("due monitor the dispatcher cannot select", () => {
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    async function readIssue(issueId: string) {
      return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    }

    async function unfireableRows(issueId: string) {
      // Read through the same service the issue activity API returns.
      const rows = await activityService(db).forIssue(issueId);
      return rows.filter((row) => row.action === "issue.monitor_unfireable");
    }

    it("records one unfireable row for a released, unassigned todo issue and keeps the monitor armed", async () => {
      // SUP-25284 shape: an agent release moved the issue to todo and dropped
      // the assignee, leaving the wake_owner monitor scheduled.
      const { issueId, nextCheckAt } = await seedFixture({ issueStatus: "todo", unassigned: true });
      const heartbeat = heartbeatService(db);

      const first = await heartbeat.tickTimers(tickAt);
      expect(first.enqueued).toBe(0);

      const rows = await unfireableRows(issueId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorType: "system", actorId: "heartbeat_scheduler", entityType: "issue" });
      expect(rows[0]?.details).toMatchObject({
        status: "todo",
        assigneeAgentId: null,
        nextCheckAt: nextCheckAt.toISOString(),
        attemptCount: 0,
        notes: "Check deploy",
        recoveryPolicy: "wake_owner",
        reason: "status_not_dispatchable",
        reasons: ["status_not_dispatchable"],
        source: "scheduled",
      });

      // Detection only: no wake, no recovery action, schedule unchanged.
      const issue = await readIssue(issueId);
      expect(issue.monitorNextCheckAt?.toISOString()).toBe(nextCheckAt.toISOString());
      expect(issue.monitorLastTriggeredAt).toBeNull();
      expect(issue.monitorAttemptCount).toBe(0);
      expect(issue.monitorWakeRequestedAt).toBeNull();
      expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
      expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);

      // A later tick does not repeat the report for the same schedule.
      await heartbeat.tickTimers(new Date(tickAt.getTime() + 60_000));
      expect(await unfireableRows(issueId)).toHaveLength(1);
    });

    it("reports a re-armed schedule again once it comes due", async () => {
      const { issueId } = await seedFixture({ issueStatus: "todo", unassigned: true });
      const heartbeat = heartbeatService(db);
      await heartbeat.tickTimers(tickAt);
      expect(await unfireableRows(issueId)).toHaveLength(1);

      const rearmedAt = new Date("2026-04-11T13:30:00.000Z");
      await db.update(issues).set({ monitorNextCheckAt: rearmedAt }).where(eq(issues.id, issueId));

      await heartbeat.tickTimers(new Date("2026-04-11T13:00:00.000Z"));
      expect(await unfireableRows(issueId)).toHaveLength(1);

      await heartbeat.tickTimers(new Date("2026-04-11T13:31:00.000Z"));
      const rows = await unfireableRows(issueId);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => (row.details as { nextCheckAt?: string }).nextCheckAt)).toContain(rearmedAt.toISOString());
    });

    it("records an assigned todo issue without waking its agent", async () => {
      const { issueId, nextCheckAt } = await seedFixture({ issueStatus: "todo" });

      await heartbeatService(db).tickTimers(tickAt);

      const rows = await unfireableRows(issueId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.details).toMatchObject({ status: "todo", reason: "status_not_dispatchable" });
      expect((await readIssue(issueId)).monitorNextCheckAt?.toISOString()).toBe(nextCheckAt.toISOString());
      expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    });

    it("does not repeat the report for a schedule stored with sub-millisecond precision", async () => {
      const { issueId } = await seedFixture({ issueStatus: "todo", unassigned: true });
      await db.execute(sql`update issues set monitor_next_check_at = '2026-04-11T12:30:00.123456Z' where id = ${issueId}`);
      const heartbeat = heartbeatService(db);

      await heartbeat.tickTimers(tickAt);
      await heartbeat.tickTimers(new Date(tickAt.getTime() + 60_000));

      const rows = await unfireableRows(issueId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.details).toMatchObject({ nextCheckAt: "2026-04-11T12:30:00.123Z" });
    });

    it("writes exactly one row per due monitor when two ticks overlap", async () => {
      const issueIds: string[] = [];
      for (let index = 0; index < 30; index += 1) {
        const { issueId } = await seedFixture({ issueStatus: "todo", unassigned: true });
        issueIds.push(issueId);
      }
      const first = heartbeatService(db);
      const second = heartbeatService(db);

      await Promise.all([first.tickTimers(tickAt), second.tickTimers(tickAt)]);
      // A later tick picks up anything the skipped overlapping tick left.
      await first.tickTimers(new Date(tickAt.getTime() + 30_000));

      const rows = await db
        .select({ entityId: activityLog.entityId })
        .from(activityLog)
        .where(eq(activityLog.action, "issue.monitor_unfireable"));
      const counts = new Map<string, number>();
      for (const row of rows) counts.set(row.entityId, (counts.get(row.entityId) ?? 0) + 1);
      expect(rows).toHaveLength(issueIds.length);
      for (const issueId of issueIds) expect(counts.get(issueId)).toBe(1);
    });

    it("does not report a fireable monitor whose wake claim is still fresh", async () => {
      // Eligible and due, but the scheduler claimed it a minute ago: an
      // in-flight wake, not an unfireable monitor.
      const { issueId, nextCheckAt } = await seedFixture({ issueStatus: "in_progress" });
      await db
        .update(issues)
        .set({ monitorWakeRequestedAt: new Date(tickAt.getTime() - 60_000) })
        .where(eq(issues.id, issueId));

      const result = await heartbeatService(db).tickTimers(tickAt);

      expect(result.enqueued).toBe(0);
      expect(await unfireableRows(issueId)).toHaveLength(0);
      const issue = await readIssue(issueId);
      expect(issue.monitorNextCheckAt?.toISOString()).toBe(nextCheckAt.toISOString());
      expect(issue.monitorLastTriggeredAt).toBeNull();
    });

    it("records nothing before the schedule comes due", async () => {
      const { issueId } = await seedFixture({ issueStatus: "todo", unassigned: true });

      await heartbeatService(db).tickTimers(new Date("2026-04-11T12:29:00.000Z"));

      expect(await unfireableRows(issueId)).toHaveLength(0);
    });
  });
});
