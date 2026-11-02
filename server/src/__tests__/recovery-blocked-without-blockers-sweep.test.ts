import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueRelations,
  issueRecoveryActions,
  issueThreadInteractions,
  issueTreeHolds,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateWithLockRetry } from "./helpers/truncate-with-lock-retry.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Recovered blocked-without-blockers work.",
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

const mockMonitorTransitionFailure = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("../services/issue-execution-policy.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/issue-execution-policy.ts")>(
    "../services/issue-execution-policy.ts",
  );
  return {
    ...actual,
    applyIssueMonitorPolicyTransition: (...args: Parameters<typeof actual.applyIssueMonitorPolicyTransition>) => {
      if (mockMonitorTransitionFailure.error) throw mockMonitorTransitionFailure.error;
      return actual.applyIssueMonitorPolicyTransition(...args);
    },
  };
});

import { HttpError } from "../errors.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { hasUsableUnblockDescriptor, isBlockedWithoutBlockers } from "../services/recovery/service.ts";

// loadConfig() in recovery/service.ts validates bind mode eagerly.
process.env.PAPERCLIP_BIND = "loopback";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocked-without-blockers sweeper tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const GRACE_THRESHOLD_MS = 15 * 60 * 1000;

// Cleans up the issue graph plus everything a dispatched heartbeat run may
// create (run events, environment leases, documents/comments, company skills).
// CASCADE handles FK references that are omitted from this list.
const TRUNCATE_ALL_SQL = `
  TRUNCATE TABLE
    "activity_log",
    "document_revisions",
    "documents",
    "environment_leases",
    "environments",
    "execution_workspaces",
    "heartbeat_run_events",
    "heartbeat_run_watchdog_decisions",
    "heartbeat_runs",
    "issue_comments",
    "issue_documents",
    "issue_relations",
    "issue_recovery_actions",
    "issue_thread_interactions",
    "issue_tree_hold_members",
    "issue_tree_holds",
    "issue_work_products",
    "issues",
    "agent_wakeup_requests",
    "agent_runtime_state",
    "company_skill_versions",
    "company_skills",
    "agents",
    "instance_settings",
    "companies",
    "project_workspaces",
    "projects"
  RESTART IDENTITY CASCADE
`;

describeEmbeddedPostgres("recovery reconcileBlockedWithoutBlockers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-without-blockers-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    // Wait for any background executeRun promises to fully settle before
    // truncating. reconcileBlockedWithoutBlockers heals dispatch a wakeup that
    // kicks off executeRun fire-and-forget; executeRun keeps writing to
    // heartbeat_runs, heartbeat_run_events, agent_wakeup_requests, issues, etc.
    // AFTER the run row leaves queued/running state. A TRUNCATE racing those
    // late writes is what produces the 40P01 deadlock flake. drainActiveRunExecutions
    // awaits the in-flight execution promises (module-level, shared across
    // heartbeatService instances) so the DB is quiescent before we truncate.
    await heartbeatService(db).drainActiveRunExecutions();
    // Retry anyway: a heartbeat run is not the only possible writer, and losing
    // the lock race used to abort cleanup and leak the previous test's
    // issues/recovery actions into the next test, which then failed on
    // unrelated count assertions.
    await truncateWithLockRetry(db, TRUNCATE_ALL_SQL);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(overrides?: { agentRole?: string }) {
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
      role: overrides?.agentRole ?? "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  function oldDate() {
    return new Date(Date.now() - GRACE_THRESHOLD_MS - 60_000);
  }

  async function enableBlockedWithoutBlockersAutoHeal() {
    await instanceSettingsService(db).updateGeneral({ enableBlockedWithoutBlockersAutoHeal: true });
  }

  // Waits until nothing the agent owns can still count as an active execution
  // path, because reconcileBlockedWithoutBlockers skips such candidates
  // (livePathSkipped) instead of healing them. Polling heartbeat_runs alone is
  // not enough:
  //   1. executeRun is dispatched fire-and-forget and its finally block can
  //      promote and dispatch the next queued run for the same agent *after*
  //      the previous row has left queued/running, so a poll landing in that
  //      gap sees a false-quiet database and returns early.
  //   2. The sweep's skip guards look wider than queued/running runs:
  //      hasActiveExecutionPath also counts `scheduled_retry` runs and
  //      `deferred_issue_execution` wakeups, and hasQueuedIssueWake counts
  //      `queued` wakeups. None of those were awaited.
  //   3. On a loaded CI runner a run can still be executing when a short wall
  //      clock deadline lapses; returning silently there left the next sweep
  //      pass to skip the candidate and fail on an unrelated count assertion.
  // drainActiveRunExecutions awaits the actual in-flight execution promises
  // (follow-ups included, since they are registered before the parent settles),
  // so it is the deterministic primitive; the poll below only confirms the
  // database agrees, and fails loudly rather than silently timing out.
  async function drainAgentRuns(agentId: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await heartbeatService(db).drainActiveRunExecutions();
      const [activeRuns, pendingWakes] = await Promise.all([
        db
          .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.agentId, agentId),
              inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"] as const),
            ),
          ),
        db
          .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.agentId, agentId),
              inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"] as const),
            ),
          ),
      ]);
      if (activeRuns.length === 0 && pendingWakes.length === 0) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `drainAgentRuns timed out after ${timeoutMs}ms for agent ${agentId}: ` +
            `${activeRuns.length} active run(s) [${activeRuns.map((run) => run.status).join(", ")}], ` +
            `${pendingWakes.length} pending wake(s) [${pendingWakes.map((wake) => wake.status).join(", ")}]`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it("escalates a blocked issue with zero blocker edges into a board-owned recovery action", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const blockedAt = oldDate();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked with no blockers",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: blockedAt,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.checked).toBe(1);
    expect(result.escalated).toBe(1);
    expect(result.graceThresholdSkipped).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const action = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId))
      .then((rows) => rows[0]);
    expect(action).toMatchObject({
      companyId,
      sourceIssueId: issueId,
      kind: "blocked_without_blockers",
      status: "active",
      ownerType: "board",
      previousOwnerAgentId: agentId,
      cause: "blocked_without_blockers",
      fingerprint: `bwob:${companyId}:${issueId}`,
      nextAction: expect.stringContaining("Review this blocked issue"),
    });
    expect(action?.evidence).toMatchObject({
      identifier: null,
      status: "blocked",
      msInViolation: expect.any(Number),
    });

    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows[0]);
    expect(audit?.action).toBe("issue.blocked_without_blockers_escalated");
    expect((audit?.details as { source?: string } | null)?.source).toBe(
      "issue_graph_liveness.blocked_without_blockers",
    );
  });

  it("does not write issues.status and does not enqueue a wakeup", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked with no blockers — no status write",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("blocked");

    const wakeups = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`)
      .then((rows) => rows.length);
    expect(wakeups).toBe(0);
  });

  it("does not escalate a blocked issue with >=1 blocker edge", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockedId = randomUUID();
    const blockerId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockedId,
        companyId,
        title: "Blocked with a blocker",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
        updatedAt: oldDate(),
      },
      {
        id: blockerId,
        companyId,
        title: "Blocker",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId,
      type: "blocks",
      issueId: blockerId,
      relatedIssueId: blockedId,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([]);

    const audit = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, blockedId))
      .then((rows) => rows[0]);
    expect(audit).toBeUndefined();
  });

  it("does not escalate a non-blocked issue", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Not blocked",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([]);
  });

  it("skips issues within the grace threshold", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked within grace",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.checked).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.graceThresholdSkipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const audit = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows[0]);
    expect(audit).toBeUndefined();
  });

  it("dedupes — repeated ticks do not re-escalate the same issue", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked with no blockers — dedupe",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
    });

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.reconcileBlockedWithoutBlockers();
    const second = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(first.escalated).toBe(1);
    expect(first.issueIds).toEqual([issueId]);
    expect(second.escalated).toBe(0);
    expect(second.alreadyActionedSkipped).toBe(1);
    expect(second.issueIds).toEqual([]);

    const auditRows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(auditRows.length).toBe(1);
  });

  it("isBlockedWithoutBlockers predicate", () => {
    expect(isBlockedWithoutBlockers({ status: "blocked", blockerIssueIds: [] })).toBe(true);
    expect(isBlockedWithoutBlockers({ status: "blocked", blockerIssueIds: ["x"] })).toBe(false);
    expect(isBlockedWithoutBlockers({ status: "todo", blockerIssueIds: [] })).toBe(false);
    expect(isBlockedWithoutBlockers({ status: "done", blockerIssueIds: [] })).toBe(false);
  });

  it("sweeps pre-cutoff issues (no createdAt filter)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Old blocked issue",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      createdAt: cutoff,
      updatedAt: oldDate(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.checked).toBeGreaterThanOrEqual(1);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toContain(issueId);
  });

  it("suppresses escalation for issues with an active execution path", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Active run blocked issue",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId },
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.livePathSkipped).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([]);
  });

  it("suppresses escalation for issues with a future monitorNextCheckAt (auto-heal ON)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await enableBlockedWithoutBlockersAutoHeal();

    const issueId = randomUUID();
    const futureMonitor = new Date(Date.now() + 86400000);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Monitor-armed blocked issue",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
      monitorNextCheckAt: futureMonitor,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.livePathSkipped).toBe(1);
    expect(result.healed).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([]);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("blocked");
  });

  it("auto-heals a blocked issue with monitorNextCheckAt in the past (auto-heal ON)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await enableBlockedWithoutBlockersAutoHeal();

    const issueId = randomUUID();
    const pastMonitor = new Date(Date.now() - 86400000);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Past-monitor blocked issue",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
      monitorNextCheckAt: pastMonitor,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.healed).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("todo");

    await drainAgentRuns(agentId);
  });

  it("auto-heals a blocked issue with monitorNextCheckAt null (auto-heal ON)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await enableBlockedWithoutBlockersAutoHeal();

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Null-monitor blocked issue",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
      monitorNextCheckAt: null,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.healed).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("todo");

    await drainAgentRuns(agentId);
  });

  it("suppresses escalation for issues with a pending wake interaction", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pending interaction blocked",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
    });
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      title: "Pick an option",
      payload: { version: 1, questions: [] },
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.interactionSkipped).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([]);
  });

  // SUP-12010: a board ask has no blocker UUID to point at, so "waiting on the
  // board" and "stranded" are byte-identical in the issue row — the pending
  // interaction is the only field that separates them. These pin the exclusion
  // in the regime that matters: the auto-heal setting ON. Without them the
  // guard is only covered on the report-only (setting OFF) path, and a
  // refactor could reorder it below the heal branch with the suite still green.
  for (const { kind, continuationPolicy } of [
    { kind: "request_confirmation" as const, continuationPolicy: "wake_assignee" as const },
    { kind: "request_confirmation" as const, continuationPolicy: "wake_assignee_on_accept" as const },
    { kind: "ask_user_questions" as const, continuationPolicy: "wake_assignee" as const },
  ]) {
    it(`setting ON: does NOT heal a candidate with a pending ${kind}/${continuationPolicy} interaction`, async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      await enableBlockedWithoutBlockersAutoHeal();

      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Parked on a board ask — setting on",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
        updatedAt: oldDate(),
      });
      await db.insert(issueThreadInteractions).values({
        id: randomUUID(),
        companyId,
        issueId,
        kind,
        status: "pending",
        continuationPolicy,
        title: "Wire the credential",
        payload: { version: 1, questions: [] },
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reconcileBlockedWithoutBlockers();

      expect(result.interactionSkipped).toBe(1);
      expect(result.healed).toBe(0);
      expect(result.escalated).toBe(0);
      expect(result.issueIds).toEqual([]);

      // The issue must stay parked, and no wake may be enqueued — a wake is
      // what would make the assignee re-discover the missing credential and
      // file a duplicate board ask it cannot withdraw.
      const row = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(row?.status).toBe("blocked");

      const wakeups = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId))
        .then((rows) => rows.length);
      expect(wakeups).toBe(0);
    });
  }

  it("suppresses escalation for issues under pause hold", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Paused blocked issue",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: issueId,
      mode: "pause",
      status: "active",
      reason: "pause liveness recovery subtree",
      releasePolicy: { strategy: "manual" },
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.pauseHoldSkipped).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([]);
  });

  it("setting OFF: does not heal or change status (identical to 9ed3c8a5)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked with no blockers — setting off",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.checked).toBe(1);
    expect(result.healed).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("blocked");

    const wakeups = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows.length);
    expect(wakeups).toBe(0);
  });

  it("setting ON: heals a candidate with an assignee — transitions to todo AND enqueues a dispatch wake", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await enableBlockedWithoutBlockersAutoHeal();

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked with no blockers — setting on",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.checked).toBe(1);
    expect(result.healed).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("todo");

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0]);
    expect(wakeup).toMatchObject({
      companyId,
      agentId,
      source: "assignment",
      reason: "issue_assigned",
      payload: expect.objectContaining({
        issueId,
        mutation: "assigned_todo_liveness_dispatch",
      }),
      requestedByActorType: "system",
    });

    const action = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId))
      .then((rows) => rows[0]);
    expect(action).toMatchObject({
      status: "resolved",
      outcome: "false_positive",
      evidence: expect.objectContaining({
        healAttemptCount: 1,
      }),
    });

    const audit = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows[0]);
    expect(audit?.action).toBe("issue.blocked_without_blockers_healed");

    await drainAgentRuns(agentId);
  });

  it("setting ON: a card carrying a self-owned unblockDescriptor with a non-empty action is exempt — neither healed nor escalated (SUP-16951)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await enableBlockedWithoutBlockersAutoHeal();

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Deliberate operator-wait park (descriptor present)",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      unblockDescriptor: { owner: { agentId }, action: "Publish the verified body to the repo" },
      updatedAt: oldDate(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.checked).toBe(1);
    expect(result.unblockDescriptorExemptSkipped).toBe(1);
    expect(result.healed).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([]);

    const row = await db
      .select({ status: issues.status, unblockDescriptor: issues.unblockDescriptor })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("blocked");
    expect(row?.unblockDescriptor).toMatchObject({ action: "Publish the verified body to the repo" });

    const wakeups = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows.length);
    expect(wakeups).toBe(0);

    const actions = await db
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId))
      .then((rows) => rows.length);
    expect(actions).toBe(0);

    const audits = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((r) => r.action));
    expect(audits).not.toContain("issue.blocked_without_blockers_healed");
    expect(audits).not.toContain("issue.blocked_without_blockers_escalated");
    expect(audits).not.toContain("issue.blocked_without_blockers_suppressed");
  });

  it("setting ON: a descriptor whose action is empty/whitespace-only is NOT exempt — heals exactly as a descriptorless card (SUP-16951 contract)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await enableBlockedWithoutBlockersAutoHeal();

    const issueId = randomUUID();
    // Bypasses the API validator (which rejects a trim().min(1) action) to pin
    // the healer's own non-empty-action bound: a whitespace action carries no
    // usable unblock path, so the lane must still heal the card.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked with a blank-action descriptor",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      unblockDescriptor: { owner: { agentId }, action: "   " },
      updatedAt: oldDate(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.checked).toBe(1);
    expect(result.unblockDescriptorExemptSkipped).toBe(0);
    expect(result.healed).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("todo");

    await drainAgentRuns(agentId);
  });

  it("setting ON: candidate with assigneeAgentId: null falls through to board-owned action, not healed", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await enableBlockedWithoutBlockersAutoHeal();

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked with no blockers and no assignee",
      status: "blocked",
      priority: "high",
      assigneeAgentId: null,
      updatedAt: oldDate(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.checked).toBe(1);
    expect(result.healed).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("blocked");

    const wakeup = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0]);
    expect(wakeup).toBeUndefined();

    const action = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId))
      .then((rows) => rows[0]);
    expect(action).toMatchObject({
      companyId,
      sourceIssueId: issueId,
      kind: "blocked_without_blockers",
      ownerType: "board",
      previousOwnerAgentId: null,
    });
  });

  it("healed is counted separately from escalated", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await enableBlockedWithoutBlockersAutoHeal();

    const healableId = randomUUID();
    const unassignedId = randomUUID();
    await db.insert(issues).values([
      {
        id: healableId,
        companyId,
        title: "Healable blocked issue",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
        updatedAt: oldDate(),
      },
      {
        id: unassignedId,
        companyId,
        title: "Unassigned blocked issue",
        status: "blocked",
        priority: "high",
        assigneeAgentId: null,
        updatedAt: oldDate(),
      },
    ]);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.checked).toBe(2);
    expect(result.healed).toBe(1);
    expect(result.escalated).toBe(1);
    expect(result.issueIds.sort()).toEqual([healableId, unassignedId].sort());

    await drainAgentRuns(agentId);
  });

  it("flag ON + existing blocked_without_blockers action with low healAttemptCount — heals and resolves the action", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await enableBlockedWithoutBlockersAutoHeal();

    const issueId = randomUUID();
    const blockedAt = oldDate();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked with existing recovery action — should heal",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: blockedAt,
    });

    await db.insert(issueRecoveryActions).values({
      id: randomUUID(),
      companyId,
      sourceIssueId: issueId,
      kind: "blocked_without_blockers",
      status: "active",
      ownerType: "board",
      cause: "blocked_without_blockers",
      fingerprint: `bwob:${companyId}:${issueId}`,
      attemptCount: 1,
      nextAction: "Review this blocked issue.",
      evidence: { identifier: null },
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.alreadyActionedSkipped).toBe(0);
    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("todo");

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0]);
    expect(wakeup).toBeTruthy();

    const action = await db
      .select({ status: issueRecoveryActions.status, outcome: issueRecoveryActions.outcome, attemptCount: issueRecoveryActions.attemptCount, evidence: issueRecoveryActions.evidence })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      )
      .then((rows) => rows[0]);
    expect(action?.status).toBe("resolved");
    expect(action?.outcome).toBe("false_positive");
    expect(action?.attemptCount).toBe(1);
    expect(action?.evidence).toMatchObject({ healAttemptCount: 1 });

    await drainAgentRuns(agentId);
  });

  it("flag ON + existing action at healAttemptCount >= 5 — does NOT heal, alreadyActionedSkipped increments", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await enableBlockedWithoutBlockersAutoHeal();

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked with exhausted action — should not heal",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
    });

    await db.insert(issueRecoveryActions).values({
      id: randomUUID(),
      companyId,
      sourceIssueId: issueId,
      kind: "blocked_without_blockers",
      status: "active",
      ownerType: "board",
      cause: "blocked_without_blockers",
      fingerprint: `bwob:${companyId}:${issueId}`,
      attemptCount: 1,
      nextAction: "Review this blocked issue.",
      evidence: { identifier: null, healAttemptCount: 5 },
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.healed).toBe(0);
    expect(result.alreadyActionedSkipped).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([]);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("blocked");

    const action = await db
      .select({ status: issueRecoveryActions.status, attemptCount: issueRecoveryActions.attemptCount, evidence: issueRecoveryActions.evidence })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      )
      .then((rows) => rows[0]);
    expect(action?.status).toBe("active");
    expect(action?.attemptCount).toBe(1);
    expect(action?.evidence).toMatchObject({ healAttemptCount: 5 });
  });

  it("flag ON: repeated heals track a persistent ceiling and stop after MAX attempts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await enableBlockedWithoutBlockersAutoHeal();

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Repeatedly healed issue",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
    });

    const heartbeat = heartbeatService(db);

    // Heal to the ceiling. No active action exists on any pass because each heal
    // resolves the action, so the count must be recovered from resolved rows.
    for (let i = 1; i <= 5; i++) {
      await db
        .update(issues)
        .set({ status: "blocked", updatedAt: oldDate() })
        .where(eq(issues.id, issueId));
      const result = await heartbeat.reconcileBlockedWithoutBlockers();
      expect(result.healed).toBe(1);
      expect(result.escalated).toBe(0);

      const action = await db
        .select({ evidence: issueRecoveryActions.evidence, status: issueRecoveryActions.status })
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId))
        .orderBy(desc(issueRecoveryActions.updatedAt))
        .limit(1)
        .then((rows) => rows[0]);
      expect(action?.status).toBe("resolved");
      expect(action?.evidence).toMatchObject({ healAttemptCount: i });

      await drainAgentRuns(agentId);
    }

    // Sixth pass is at the ceiling: blocked_without_blockers should not heal;
    // it falls through to the normal escalation path.
    await db
      .update(issues)
      .set({ status: "blocked", updatedAt: oldDate() })
      .where(eq(issues.id, issueId));
    const finalResult = await heartbeat.reconcileBlockedWithoutBlockers();
    expect(finalResult.healed).toBe(0);
    expect(finalResult.alreadyActionedSkipped).toBe(0);
    expect(finalResult.escalated).toBe(1);
    expect(finalResult.issueIds).toEqual([issueId]);

    const escalatedAction = await db
      .select({ status: issueRecoveryActions.status, evidence: issueRecoveryActions.evidence })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId))
      .orderBy(desc(issueRecoveryActions.updatedAt))
      .limit(1)
      .then((rows) => rows[0]);
    expect(escalatedAction?.status).toBe("active");
    expect(escalatedAction?.evidence).toMatchObject({ healAttemptCount: 5 });
  });

  it("flag ON + prior resolved bwob heals + unrelated active action: ceiling reads the resolved bwob count, not 0", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await enableBlockedWithoutBlockersAutoHeal();

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Prior bwob heals + unrelated active action",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
    });

    // Seed 4 prior resolved blocked_without_blockers heals with counts 1-4,
    // ordered so count 4 is the latest resolved (that is what the sweep reads).
    for (let i = 1; i <= 4; i++) {
      await db.insert(issueRecoveryActions).values({
        id: randomUUID(),
        companyId,
        sourceIssueId: issueId,
        kind: "blocked_without_blockers",
        status: "resolved",
        ownerType: "board",
        cause: "blocked_without_blockers",
        fingerprint: `bwob:${companyId}:${issueId}`,
        attemptCount: 1,
        nextAction: "Review this blocked issue.",
        evidence: { identifier: null, healAttemptCount: i },
        resolvedAt: new Date(Date.now() - (5 - i) * 60_000),
      });
    }

    // Seed an unrelated ACTIVE action (successful_run_missing_state). This is
    // the row that previously made the heal branch skip the resolved-bwob
    // lookup and reset healAttemptCount to 0.
    await db.insert(issueRecoveryActions).values({
      id: randomUUID(),
      companyId,
      sourceIssueId: issueId,
      kind: "successful_run_missing_state",
      status: "active",
      ownerType: "board",
      cause: "successful_run_missing_state",
      fingerprint: `srm:${companyId}:${issueId}`,
      attemptCount: 1,
      nextAction: "Review successful run missing state issue.",
      evidence: { identifier: null, status: "blocked", blockedAt: oldDate() },
    });

    const heartbeat = heartbeatService(db);

    // First sweep: prior count 4 is read (not reset to 0), so this heal is #5
    // and it persists count 5 onto a new resolved bwob action.
    const firstResult = await heartbeat.reconcileBlockedWithoutBlockers();
    expect(firstResult.healed).toBe(1);
    expect(firstResult.escalated).toBe(0);

    const healedAction = await db
      .select({ evidence: issueRecoveryActions.evidence })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.sourceIssueId, issueId),
          eq(issueRecoveryActions.kind, "blocked_without_blockers"),
          eq(issueRecoveryActions.status, "resolved"),
        ),
      )
      .orderBy(desc(issueRecoveryActions.resolvedAt))
      .limit(1)
      .then((rows) => rows[0]);
    expect(healedAction?.evidence).toMatchObject({ healAttemptCount: 5 });

    await drainAgentRuns(agentId);

    // Re-block and sweep again: count 5 is at the ceiling, so the sweep must
    // NOT heal a 6th time. The unrelated active action is still present.
    await db
      .update(issues)
      .set({ status: "blocked", updatedAt: oldDate() })
      .where(eq(issues.id, issueId));
    const secondResult = await heartbeat.reconcileBlockedWithoutBlockers();
    expect(secondResult.healed).toBe(0);
    expect(secondResult.alreadyActionedSkipped).toBe(0);
    expect(secondResult.escalated).toBe(1);
    expect(secondResult.issueIds).toEqual([issueId]);

    const issue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issue?.status).toBe("blocked");

    await drainAgentRuns(agentId);
  });

  async function seedCompanyAgentAndProject() {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test Project",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "primary",
      isPrimary: true,
    });
    return { companyId, agentId, projectId, projectWorkspaceId };
  }

  async function seedIssueWithDeadWorkspaceBinding(opts: {
    cwd: string;
    companyId: string;
    agentId: string;
    projectId: string;
    projectWorkspaceId: string;
  }) {
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId: opts.companyId,
      projectId: opts.projectId,
      projectWorkspaceId: opts.projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: `workspace-${workspaceId}`,
      status: "active",
      cwd: opts.cwd,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: opts.companyId,
      title: "Blocked with dead reuse binding",
      status: "blocked",
      priority: "high",
      assigneeAgentId: opts.agentId,
      updatedAt: oldDate(),
      executionWorkspaceId: workspaceId,
      executionWorkspacePreference: "reuse_existing",
    });
    return { issueId, workspaceId };
  }

  it("flag ON + dead workspace binding (ENOENT) clears binding and heals", async () => {
    const { companyId, agentId, projectId, projectWorkspaceId } = await seedCompanyAgentAndProject();
    await enableBlockedWithoutBlockersAutoHeal();
    const missingCwd = "/tmp/not-a-real-worktree-path-blocked-without-blockers-test";
    const { issueId, workspaceId } = await seedIssueWithDeadWorkspaceBinding({
      cwd: missingCwd,
      companyId,
      agentId,
      projectId,
      projectWorkspaceId,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.checked).toBe(1);
    expect(result.deadBindingsCleared).toBe(1);
    expect(result.deadWorkspaceBindingSkipped).toBe(0);
    expect(result.healed).toBe(1);

    const issue = await db
      .select({
        status: issues.status,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issue?.status).toBe("todo");
    expect(issue?.executionWorkspaceId).toBeNull();
    expect(issue?.executionWorkspacePreference).toBeNull();

    const audit = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows[0]);
    expect(audit?.action).toBe("issue.blocked_without_blockers_healed");

    await drainAgentRuns(agentId);
  });

  it("flag ON + missing cwd on workspace row skips and counts deadWorkspaceBindingSkipped", async () => {
    const { companyId, agentId, projectId, projectWorkspaceId } = await seedCompanyAgentAndProject();
    await enableBlockedWithoutBlockersAutoHeal();
    const { issueId } = await seedIssueWithDeadWorkspaceBinding({
      cwd: "/nonexistent",
      companyId,
      agentId,
      projectId,
      projectWorkspaceId,
    });
    await db
      .update(executionWorkspaces)
      .set({ cwd: null })
      .where(eq(executionWorkspaces.companyId, companyId));

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.deadWorkspaceBindingSkipped).toBe(1);
    expect(result.deadBindingsCleared).toBe(0);
    expect(result.healed).toBe(0);

    const issue = await db
      .select({ status: issues.status, executionWorkspaceId: issues.executionWorkspaceId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issue?.status).toBe("blocked");
    expect(issue?.executionWorkspaceId).not.toBeNull();
  });

  it("flag ON + active dependency_wake_rearm_cap_exhausted action skips and counts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await enableBlockedWithoutBlockersAutoHeal();

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked with rearm cap exhausted action",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
    });
    await db.insert(issueRecoveryActions).values({
      id: randomUUID(),
      companyId,
      sourceIssueId: issueId,
      kind: "blocked_without_blockers",
      status: "active",
      ownerType: "board",
      previousOwnerAgentId: agentId,
      cause: "dependency_wake_rearm_cap_exhausted",
      fingerprint: `drearm:${companyId}:${issueId}`,
      attemptCount: 1,
      nextAction: "Review dependency wake rearm cap exhausted issue.",
      evidence: { identifier: null, reArmCount: 5, reArmMax: 5 },
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.rearmCapExhaustedSkipped).toBe(1);
    expect(result.healed).toBe(0);
    expect(result.escalated).toBe(0);

    const issue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issue?.status).toBe("blocked");

    const activeAction = await db
      .select({ status: issueRecoveryActions.status })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId))
      .then((rows) => rows[0]);
    expect(activeAction?.status).toBe("active");
  });

  it("flag ON + live workspace binding (directory exists) heals normally", async () => {
    const { companyId, agentId, projectId, projectWorkspaceId } = await seedCompanyAgentAndProject();
    await enableBlockedWithoutBlockersAutoHeal();
    const { issueId, workspaceId } = await seedIssueWithDeadWorkspaceBinding({
      cwd: process.cwd(),
      companyId,
      agentId,
      projectId,
      projectWorkspaceId,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.deadWorkspaceBindingSkipped).toBe(0);
    expect(result.deadBindingsCleared).toBe(0);
    expect(result.healed).toBe(1);

    const issue = await db
      .select({ status: issues.status, executionWorkspaceId: issues.executionWorkspaceId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issue?.status).toBe("todo");
    expect(issue?.executionWorkspaceId).toBe(workspaceId);

    await drainAgentRuns(agentId);
  });

  it("flag OFF - dead workspace binding does not clear or heal; candidate escalates", async () => {
    const { companyId, agentId, projectId, projectWorkspaceId } = await seedCompanyAgentAndProject();
    // auto-heal is OFF by default
    const missingCwd = "/tmp/not-a-real-worktree-path-blocked-without-blockers-test";
    const { issueId, workspaceId } = await seedIssueWithDeadWorkspaceBinding({
      cwd: missingCwd,
      companyId,
      agentId,
      projectId,
      projectWorkspaceId,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.deadBindingsCleared).toBe(0);
    expect(result.healed).toBe(0);
    expect(result.escalated).toBe(1);

    const issue = await db
      .select({ status: issues.status, executionWorkspaceId: issues.executionWorkspaceId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issue?.status).toBe("blocked");
    expect(issue?.executionWorkspaceId).toBe(workspaceId);
  });

  it("idempotence: second pass does not re-clear dead bindings or double-count", async () => {
    const { companyId, agentId, projectId, projectWorkspaceId } = await seedCompanyAgentAndProject();
    await enableBlockedWithoutBlockersAutoHeal();
    const missingCwd = "/tmp/not-a-real-worktree-path-blocked-without-blockers-test-2";
    await seedIssueWithDeadWorkspaceBinding({
      cwd: missingCwd,
      companyId,
      agentId,
      projectId,
      projectWorkspaceId,
    });

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.reconcileBlockedWithoutBlockers();
    expect(first.deadBindingsCleared).toBe(1);
    expect(first.healed).toBe(1);

    await drainAgentRuns(agentId);

    // The first heal transitions the issue to todo; the second pass finds zero
    // blocked candidates and takes no further action.
    const second = await heartbeat.reconcileBlockedWithoutBlockers();
    expect(second.checked).toBe(0);
    expect(second.deadBindingsCleared).toBe(0);
    expect(second.deadWorkspaceBindingSkipped).toBe(0);
    expect(second.healed).toBe(0);
  });

  async function seedExhaustedWorkspaceValidationAction(companyId: string, agentId: string, issueId: string) {
    await db.insert(issueRecoveryActions).values({
      id: randomUUID(),
      companyId,
      sourceIssueId: issueId,
      kind: "workspace_validation",
      status: "escalated",
      ownerType: "board",
      previousOwnerAgentId: agentId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:provision:failure",
      attemptCount: 5,
      maxAttempts: 5,
      nextAction: "Repair the worktree provisioning failure.",
      outcome: "exhausted",
      evidence: { identifier: null },
      lastAttemptAt: oldDate(),
    });
  }

  it("flag ON + exhausted/escalated recovery action on the issue — suppresses the auto-heal redispatch and records the skip", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await enableBlockedWithoutBlockersAutoHeal();

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked behind an exhausted recovery action",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
    });
    await seedExhaustedWorkspaceValidationAction(companyId, agentId, issueId);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.checked).toBe(1);
    expect(result.healed).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.exhaustedRecoverySuppressed).toBe(1);
    expect(result.issueIds).toEqual([]);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("blocked");

    // No dispatch back into the identical provisioning failure.
    const wakeups = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows.length);
    expect(wakeups).toBe(0);

    // No second recovery action row; the exhausted terminal row is untouched.
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      status: "escalated",
      outcome: "exhausted",
      attemptCount: 5,
      maxAttempts: 5,
    });

    // The skipped redispatch is observable so a board triage does not have to
    // reconstruct it from repeated rows.
    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.find((r) => r.action === "issue.blocked_without_blockers_suppressed"));
    expect(audit).toBeTruthy();
    expect((audit!.details as Record<string, unknown>).suppressedBy).toMatchObject({
      kind: "workspace_validation",
      outcome: "exhausted",
      attemptCount: 5,
      maxAttempts: 5,
    });
  });

  it("flag OFF + exhausted/escalated recovery action on the issue — records the skip instead of a duplicate board escalation", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // auto-heal is OFF by default.

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked behind an exhausted recovery action",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
    });
    await seedExhaustedWorkspaceValidationAction(companyId, agentId, issueId);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.checked).toBe(1);
    expect(result.healed).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.exhaustedRecoverySuppressed).toBe(1);
    expect(result.issueIds).toEqual([]);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("blocked");

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: "escalated", outcome: "exhausted" });

    const audit = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.find((r) => r.action === "issue.blocked_without_blockers_suppressed"));
    expect(audit).toBeTruthy();
  });

  async function countSuppressionRows(issueId: string) {
    return await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.blocked_without_blockers_suppressed"),
        ),
      )
      .then((rows) => rows.length);
  }

  it("flag ON + exhausted/escalated recovery action — writes exactly one suppression row across repeated sweep passes (SUP-14244)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await enableBlockedWithoutBlockersAutoHeal();

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked behind an exhausted recovery action",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
    });
    await seedExhaustedWorkspaceValidationAction(companyId, agentId, issueId);

    const heartbeat = heartbeatService(db);

    // Pass 1: the skip is recorded exactly once, with the unchanged payload.
    const first = await heartbeat.reconcileBlockedWithoutBlockers();
    expect(first.exhaustedRecoverySuppressed).toBe(1);
    expect(await countSuppressionRows(issueId)).toBe(1);
    const firstAudit = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.blocked_without_blockers_suppressed"),
        ),
      )
      .then((rows) => rows[0]);
    expect((firstAudit.details as Record<string, unknown>).suppressedBy).toMatchObject({
      kind: "workspace_validation",
      outcome: "exhausted",
      attemptCount: 5,
      maxAttempts: 5,
    });

    // Passes 2 and 3: SUP-21344 arms a board monitor on pass 1, so the card now
    // has a future monitor and `hasActiveExecutionPath` drains it before the
    // grace window (its updatedAt is now the monitor write) re-fails —
    // the card is no longer double-counted as suppressed, no heal/escalation
    // occurs, and no further suppression row is written.
    for (const pass of [2, 3] as const) {
      const result = await heartbeat.reconcileBlockedWithoutBlockers();
      expect(result.exhaustedRecoverySuppressed).toBe(0);
      expect(result.healed).toBe(0);
      expect(result.escalated).toBe(0);
      expect(await countSuppressionRows(issueId)).toBe(1);
    }
    const [drainedIssue] = await db
      .select({ monitorNextCheckAt: issues.monitorNextCheckAt, monitorScheduledBy: issues.monitorScheduledBy })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(drainedIssue.monitorNextCheckAt).not.toBeNull();
    expect(drainedIssue.monitorNextCheckAt!.getTime()).toBeGreaterThan(Date.now());
    expect(drainedIssue.monitorScheduledBy).toBe("board");

    // The issue is still blocked and the terminal action is untouched.
    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("blocked");
  });

  it("SUP-21344: exhausted drain on a blocked card with no agent assignee arms no fake monitor but links an owned recovery issue", async () => {
    // Role "cto" puts the seed agent on the stranded-owner ladder as a
    // resolvable owner candidate (the action's previousOwnerAgentId is not a
    // ladder input, so a lone engineer never becomes a recovery owner here).
    const { companyId, agentId } = await seedCompanyAndAgent({ agentRole: "cto" });
    await enableBlockedWithoutBlockersAutoHeal();

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked behind an exhausted recovery action, unassigned",
      status: "blocked",
      priority: "high",
      updatedAt: oldDate(),
    });
    await seedExhaustedWorkspaceValidationAction(companyId, agentId, issueId);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();
    expect(result.exhaustedRecoverySuppressed).toBe(1);
    expect(await countSuppressionRows(issueId)).toBe(1);

    // The scheduler can never fire a monitor without an agent assignee, so
    // the drain must not write monitor columns claiming a live wake.
    const [drainedIssue] = await db
      .select({
        monitorNextCheckAt: issues.monitorNextCheckAt,
        monitorScheduledBy: issues.monitorScheduledBy,
        executionPolicy: issues.executionPolicy,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(drainedIssue.monitorNextCheckAt).toBeNull();
    expect(drainedIssue.monitorScheduledBy).toBeNull();
    expect((drainedIssue.executionPolicy as { monitor?: unknown } | null)?.monitor).toBeUndefined();

    // Instead the action now links a durable, non-terminal recovery issue
    // owned by an invokable agent (the manager-ladder owner for the seed
    // agent), and the owner's wake was enqueued for it.
    const [action] = await db
      .select({ recoveryIssueId: issueRecoveryActions.recoveryIssueId })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action.recoveryIssueId).not.toBeNull();
    const [recoveryIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, action.recoveryIssueId!));
    expect(recoveryIssue).toBeDefined();
    expect(recoveryIssue.status).toBe("todo");
    expect(recoveryIssue.assigneeAgentId).toBe(agentId);
    expect(recoveryIssue.originKind).toBe("stranded_issue_recovery");
    expect(recoveryIssue.originId).toBe(issueId);

    const ownerWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(ownerWakes.length).toBeGreaterThan(0);

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    const drainComment = comments.find((c) => (c.body ?? "").includes("Board decision item:"));
    expect(drainComment).toBeDefined();
    expect(drainComment!.body).toContain("not monitor-dispatchable");
    expect(drainComment!.body).toContain(action.recoveryIssueId!);
    expect(drainComment!.body).not.toContain("board check armed for");

    // Idempotency: later passes reuse the linked recovery issue rather than
    // minting a duplicate for the same exhausted action.
    await heartbeat.reconcileBlockedWithoutBlockers();
    const recoveryIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
          eq(issues.originId, issueId),
        ),
      );
    expect(recoveryIssues).toHaveLength(1);
  });

  it("SUP-21344: baseline drain arms a future board monitor on a non-blocked exhausted source and adds no comments on repeat passes", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentRole: "cto" });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In review behind an exhausted recovery action",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
    });
    await seedExhaustedWorkspaceValidationAction(companyId, agentId, issueId);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileExhaustedRecoveryDrain();
    expect(result.checked).toBe(1);
    expect(result.monitorArmed).toBe(1);
    expect(result.recoveryIssueMinted).toBe(0);

    const [drainedIssue] = await db
      .select({
        monitorNextCheckAt: issues.monitorNextCheckAt,
        monitorScheduledBy: issues.monitorScheduledBy,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(drainedIssue.monitorNextCheckAt).not.toBeNull();
    expect(drainedIssue.monitorNextCheckAt!.getTime()).toBeGreaterThan(Date.now());
    expect(drainedIssue.monitorScheduledBy).toBe("board");

    const commentsAfterFirstPass = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    const second = await heartbeat.reconcileExhaustedRecoveryDrain();
    expect(second.monitorArmed).toBe(0);
    expect(second.recoveryIssueMinted).toBe(0);
    expect(second.alreadyLive).toBe(1);
    const commentsAfterSecondPass = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(commentsAfterSecondPass).toHaveLength(commentsAfterFirstPass.length);
  });

  function exhaustedMonitorExecutionState(attemptCount: number) {
    return {
      status: "idle",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: null,
      deliveryAuthor: null,
      reviewRequest: null,
      completedStageIds: [],
      skippedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      monitor: {
        status: "triggered",
        nextCheckAt: null,
        lastTriggeredAt: "2026-11-01T12:08:00.000Z",
        attemptCount,
        notes: null,
        scheduledBy: "assignee",
        kind: null,
        serviceName: null,
        externalRef: null,
        timeoutAt: null,
        maxAttempts: 3,
        recoveryPolicy: null,
        clearedAt: null,
        clearReason: null,
      },
    };
  }

  it("startup recovery sweeps complete when a blocked card and an escalated-exhausted card both have monitor_attempt_count >= 3", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentRole: "cto" });
    const blockedIssueId = randomUUID();
    const drainIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockedIssueId,
      companyId,
      title: "Blocked card whose monitor already fired three times",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      monitorAttemptCount: 10,
      monitorScheduledBy: "assignee",
      executionState: exhaustedMonitorExecutionState(10),
      updatedAt: oldDate(),
    });
    await db.insert(issues).values({
      id: drainIssueId,
      companyId,
      title: "Escalated-exhausted card whose monitor already fired three times",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
      monitorAttemptCount: 12,
      monitorScheduledBy: "assignee",
      executionState: exhaustedMonitorExecutionState(12),
      updatedAt: oldDate(),
    });
    await seedExhaustedWorkspaceValidationAction(companyId, agentId, blockedIssueId);
    await seedExhaustedWorkspaceValidationAction(companyId, agentId, drainIssueId);

    const heartbeat = heartbeatService(db);
    await expect(heartbeat.reconcileBlockedWithoutBlockers()).resolves.toBeDefined();
    await expect(heartbeat.reconcileExhaustedRecoveryDrain()).resolves.toBeDefined();
  });

  it("fresh board monitor armed by the drain resets the persisted monitor attempt counters", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentRole: "cto" });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Escalated-exhausted card re-armed with a fresh board monitor",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
      monitorAttemptCount: 12,
      monitorScheduledBy: "assignee",
      executionState: exhaustedMonitorExecutionState(12),
      updatedAt: oldDate(),
    });
    await seedExhaustedWorkspaceValidationAction(companyId, agentId, issueId);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileExhaustedRecoveryDrain();
    expect(result.monitorArmed).toBe(1);

    const [issue] = await db
      .select({
        monitorAttemptCount: issues.monitorAttemptCount,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issue.monitorNextCheckAt).not.toBeNull();
    expect(issue.monitorAttemptCount).toBe(0);
    expect(issue.executionState).toMatchObject({
      monitor: { status: "scheduled", attemptCount: 0, scheduledBy: "board" },
    });
  });

  it("bounds-exhausted board monitor re-arm falls through instead of throwing from the drain", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentRole: "cto" });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Escalated-exhausted card with an exhausted monitor",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
      monitorAttemptCount: 3,
      updatedAt: oldDate(),
    });
    await seedExhaustedWorkspaceValidationAction(companyId, agentId, issueId);

    mockMonitorTransitionFailure.error = new HttpError(422, "Monitor bounds are already exhausted", {
      clearReason: "max_attempts_exhausted",
    });
    try {
      const heartbeat = heartbeatService(db);
      await expect(heartbeat.reconcileExhaustedRecoveryDrain()).resolves.toBeDefined();
    } finally {
      mockMonitorTransitionFailure.error = null;
    }
    const [issue] = await db
      .select({ monitorNextCheckAt: issues.monitorNextCheckAt })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issue.monitorNextCheckAt).toBeNull();
  });

  it("board monitor re-arm rethrows non-422 transition errors from the drain", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentRole: "cto" });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Escalated-exhausted card with a failing monitor transition",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
      monitorAttemptCount: 3,
      updatedAt: oldDate(),
    });
    await seedExhaustedWorkspaceValidationAction(companyId, agentId, issueId);

    mockMonitorTransitionFailure.error = new HttpError(500, "monitor transition exploded");
    try {
      const heartbeat = heartbeatService(db);
      await expect(heartbeat.reconcileExhaustedRecoveryDrain()).rejects.toThrow(
        "monitor transition exploded",
      );
    } finally {
      mockMonitorTransitionFailure.error = null;
    }
  });

  it("SUP-21344-review: a due self-armed board monitor is claimed by the monitor tick, not re-armed by the drain", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentRole: "cto" });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In review behind an exhausted recovery action, monitor due",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
    });
    await seedExhaustedWorkspaceValidationAction(companyId, agentId, issueId);

    const heartbeat = heartbeatService(db);
    const armed = await heartbeat.reconcileExhaustedRecoveryDrain();
    expect(armed.monitorArmed).toBe(1);

    const [armedIssue] = await db
      .select({
        monitorNextCheckAt: issues.monitorNextCheckAt,
        monitorScheduledBy: issues.monitorScheduledBy,
        monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
        executionPolicy: issues.executionPolicy,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(armedIssue.monitorScheduledBy).toBe("board");
    expect(armedIssue.monitorWakeRequestedAt).toBeNull();
    // The board monitor carries a finite attempt cap, not null (uncapped).
    expect(
      (armedIssue.executionPolicy as { monitor?: { maxAttempts?: unknown } } | null)?.monitor?.maxAttempts,
    ).toBe(3);
    const armedCheckAt = armedIssue.monitorNextCheckAt!;
    expect(armedCheckAt.getTime()).toBeGreaterThan(Date.now());

    // Make the armed check due, as the live fleet's hourly checks become due.
    const dueCheckAt = new Date(Date.now() - 1000);
    await db
      .update(issues)
      .set({ monitorNextCheckAt: dueCheckAt })
      .where(eq(issues.id, issueId));

    // The drain must leave a due self-armed board monitor for the claim path:
    // no re-arm (+1h), no claim stamp consumed by the drain itself.
    const drainAtDue = await heartbeat.reconcileExhaustedRecoveryDrain();
    expect(drainAtDue.monitorArmed).toBe(0);
    expect(drainAtDue.monitorDueAwaitingClaim).toBe(1);
    const [afterDrain] = await db
      .select({
        monitorNextCheckAt: issues.monitorNextCheckAt,
        monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
        monitorLastTriggeredAt: issues.monitorLastTriggeredAt,
        monitorAttemptCount: issues.monitorAttemptCount,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(afterDrain.monitorNextCheckAt?.getTime()).toBe(dueCheckAt.getTime());
    expect(afterDrain.monitorWakeRequestedAt).toBeNull();
    expect(afterDrain.monitorLastTriggeredAt).toBeNull();

    // The monitor tick claims and fires it: a delivered issue_monitor_due wake.
    await heartbeat.tickTimers(new Date());
    const wakes = await db
      .select({ reason: agentWakeupRequests.reason, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.some((wake) => wake.reason === "issue_monitor_due")).toBe(true);

    const [afterTick] = await db
      .select({
        monitorNextCheckAt: issues.monitorNextCheckAt,
        monitorLastTriggeredAt: issues.monitorLastTriggeredAt,
        monitorAttemptCount: issues.monitorAttemptCount,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(afterTick.monitorNextCheckAt).toBeNull();
    expect(afterTick.monitorLastTriggeredAt).not.toBeNull();
    expect(afterTick.monitorAttemptCount).toBe(1);
    await drainAgentRuns(agentId);
  });

  it("SUP-21344-review: board monitor clears instead of re-firing once its attempt cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentRole: "cto" });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In review behind an exhausted recovery action, monitor capped",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
    });
    await seedExhaustedWorkspaceValidationAction(companyId, agentId, issueId);

    const heartbeat = heartbeatService(db);
    const armed = await heartbeat.reconcileExhaustedRecoveryDrain();
    expect(armed.monitorArmed).toBe(1);

    // Simulate the cap having been consumed by prior fires, then make it due.
    await db
      .update(issues)
      .set({ monitorNextCheckAt: new Date(Date.now() - 1000), monitorAttemptCount: 3 })
      .where(eq(issues.id, issueId));

    await heartbeat.tickTimers(new Date());
    const [afterTick] = await db
      .select({
        monitorNextCheckAt: issues.monitorNextCheckAt,
        monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    // Cleared, not re-armed +1h and not left due for endless claim retries.
    expect(afterTick.monitorNextCheckAt).toBeNull();
    const wakes = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.some((wake) => wake.reason === "issue_monitor_due")).toBe(false);
    await drainAgentRuns(agentId);
  });

  it("SUP-21344: baseline drain mints an owned recovery issue for an exhausted todo source with no agent assignee", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentRole: "cto" });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Todo behind an exhausted recovery action, unassigned",
      status: "todo",
      priority: "high",
      updatedAt: oldDate(),
    });
    await seedExhaustedWorkspaceValidationAction(companyId, agentId, issueId);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileExhaustedRecoveryDrain();
    expect(result.checked).toBe(1);
    expect(result.monitorArmed).toBe(0);
    expect(result.recoveryIssueMinted).toBe(1);

    const [sourceIssue] = await db
      .select({
        monitorNextCheckAt: issues.monitorNextCheckAt,
        monitorScheduledBy: issues.monitorScheduledBy,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(sourceIssue.monitorNextCheckAt).toBeNull();
    expect(sourceIssue.monitorScheduledBy).toBeNull();

    const [action] = await db
      .select({ recoveryIssueId: issueRecoveryActions.recoveryIssueId })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action.recoveryIssueId).not.toBeNull();
    const [recoveryIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, action.recoveryIssueId!));
    expect(recoveryIssue).toBeDefined();
    expect(recoveryIssue.status).toBe("todo");
    expect(recoveryIssue.assigneeAgentId).toBe(agentId);
    expect(recoveryIssue.originKind).toBe("stranded_issue_recovery");
    expect(recoveryIssue.originId).toBe(issueId);

    const ownerWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(ownerWakes.length).toBeGreaterThan(0);

    const second = await heartbeat.reconcileExhaustedRecoveryDrain();
    expect(second.monitorArmed).toBe(0);
    expect(second.recoveryIssueMinted).toBe(0);
    expect(second.alreadyLive).toBe(1);
    const recoveryIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
          eq(issues.originId, issueId),
        ),
      );
    expect(recoveryIssues).toHaveLength(1);
  });

  it("SUP-21344-review: reused exhausted recovery issue re-enqueues the owner wake when no live wake remains", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentRole: "cto" });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Todo behind an exhausted recovery action, reused recovery issue",
      status: "todo",
      priority: "high",
      updatedAt: oldDate(),
    });
    await seedExhaustedWorkspaceValidationAction(companyId, agentId, issueId);

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.reconcileExhaustedRecoveryDrain();
    expect(first.recoveryIssueMinted).toBe(1);
    const [action] = await db
      .select({ recoveryIssueId: issueRecoveryActions.recoveryIssueId })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action.recoveryIssueId).not.toBeNull();

    // Simulate the first owner wake having been consumed without producing a
    // disposition: a reused recovery issue must not stay a silent terminal sink.
    await db
      .update(agentWakeupRequests)
      .set({ status: "cancelled" })
      .where(eq(agentWakeupRequests.agentId, agentId));
    await drainAgentRuns(agentId);
    const wakesBeforeReuse = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    const second = await heartbeat.reconcileExhaustedRecoveryDrain();
    expect(second.recoveryIssueMinted).toBe(0);
    expect(second.alreadyLive).toBe(1);

    const wakesAfterReuse = await db
      .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakesAfterReuse.length).toBeGreaterThan(wakesBeforeReuse.length);
    expect(wakesAfterReuse.some((wake) => {
      const payload = wake.payload as { issueId?: unknown } | null;
      return payload?.issueId === action.recoveryIssueId;
    })).toBe(true);
  });

  it("SUP-21344-review: concurrent exhausted drains mint at most one recovery issue per source", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentRole: "cto" });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Todo behind an exhausted recovery action, concurrent drains",
      status: "todo",
      priority: "high",
      updatedAt: oldDate(),
    });
    await seedExhaustedWorkspaceValidationAction(companyId, agentId, issueId);

    const heartbeat = heartbeatService(db);
    const results = await Promise.all([
      heartbeat.reconcileExhaustedRecoveryDrain(),
      heartbeat.reconcileExhaustedRecoveryDrain(),
    ]);
    expect(results.every((result) => result.checked >= 1)).toBe(true);

    const recoveryIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
          eq(issues.originId, issueId),
        ),
      );
    expect(recoveryIssues).toHaveLength(1);

    const [action] = await db
      .select({ recoveryIssueId: issueRecoveryActions.recoveryIssueId })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action.recoveryIssueId).toBe(recoveryIssues[0]?.id);
  });

  it("flag ON + replacement exhausted recovery action (different id) — writes a fresh suppression row (SUP-14244)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await enableBlockedWithoutBlockersAutoHeal();

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked behind an exhausted recovery action",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      updatedAt: oldDate(),
    });

    const firstActionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: firstActionId,
      companyId,
      sourceIssueId: issueId,
      kind: "workspace_validation",
      status: "escalated",
      ownerType: "board",
      previousOwnerAgentId: agentId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:provision:failure",
      attemptCount: 5,
      maxAttempts: 5,
      nextAction: "Repair the worktree provisioning failure.",
      outcome: "exhausted",
      evidence: { identifier: null },
      lastAttemptAt: oldDate(),
    });

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.reconcileBlockedWithoutBlockers();
    expect(first.exhaustedRecoverySuppressed).toBe(1);
    expect(await countSuppressionRows(issueId)).toBe(1);

    // A board resolution clears the terminal action; a new terminal action
    // (different id) now suppresses the sweep.
    await db
      .update(issueRecoveryActions)
      .set({ status: "resolved" })
      .where(eq(issueRecoveryActions.id, firstActionId));

    const replacementActionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: replacementActionId,
      companyId,
      sourceIssueId: issueId,
      kind: "workspace_validation",
      status: "escalated",
      ownerType: "board",
      previousOwnerAgentId: agentId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:provision:failure",
      attemptCount: 5,
      maxAttempts: 5,
      nextAction: "Repair the worktree provisioning failure.",
      outcome: "exhausted",
      evidence: { identifier: null },
      lastAttemptAt: oldDate(),
    });

    // SUP-21344: the first pass armed a board monitor and refreshed updatedAt,
    // so the next sweep still sits inside the blocked-without-blockers grace
    // window. Once that window elapses, the future monitor makes the card
    // live-path skipped. Either way it must not double-record while armed.
    const second = await heartbeat.reconcileBlockedWithoutBlockers();
    expect(second.exhaustedRecoverySuppressed).toBe(0);
    expect(await countSuppressionRows(issueId)).toBe(1);
    const [drainedIssue] = await db
      .select({ monitorNextCheckAt: issues.monitorNextCheckAt, monitorScheduledBy: issues.monitorScheduledBy })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(drainedIssue.monitorNextCheckAt).not.toBeNull();
    expect(drainedIssue.monitorNextCheckAt!.getTime()).toBeGreaterThan(Date.now());
    expect(drainedIssue.monitorScheduledBy).toBe("board");

    const rows = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.blocked_without_blockers_suppressed"),
        ),
      );
    const suppressorIds = rows
      .map((r) => ((r.details as { suppressedBy: { id: string } }).suppressedBy.id))
      .sort();
    // SUP-21344: only the first suppressor is recorded while the board monitor
    // is armed; the replacement action is recorded on a later pass once the
    // monitor has been consumed (board acted or check elapsed).
    expect(suppressorIds).toEqual([firstActionId]);
  });
});

describe("hasUsableUnblockDescriptor (SUP-16951 exemption predicate)", () => {
  it("is exempt only for a non-null descriptor with a non-empty action string", () => {
    const agent = { agentId: "agent-1" };
    expect(hasUsableUnblockDescriptor(null)).toBe(false);
    expect(hasUsableUnblockDescriptor(undefined)).toBe(false);
    expect(hasUsableUnblockDescriptor({ owner: "board", action: "" })).toBe(false);
    expect(hasUsableUnblockDescriptor({ owner: "board", action: "   " })).toBe(false);
    expect(hasUsableUnblockDescriptor({ owner: agent, action: "Publish the verified body" })).toBe(true);
    expect(hasUsableUnblockDescriptor({ owner: "board", action: " Approve the ruleset PUT " })).toBe(true);
  });

  it("does not key on owner identity (self-owned vs board are both honoured)", () => {
    const agent = { agentId: "agent-1" };
    expect(hasUsableUnblockDescriptor({ owner: agent, action: "x" })).toBe(
      hasUsableUnblockDescriptor({ owner: "board", action: "x" }),
    );
  });
});
