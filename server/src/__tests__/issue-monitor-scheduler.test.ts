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
import { heartbeatService } from "../services/heartbeat.ts";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.ts";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../services/issue-execution-policy.ts";

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
    issueStatus?: "in_progress" | "in_review" | "blocked";
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
    const monitor = {
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
        expect(await activityActions(issueId)).toEqual([]);
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
});
