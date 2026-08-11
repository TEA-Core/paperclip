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

import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { isBlockedWithoutBlockers } from "../services/recovery/service.ts";
import { ISSUE_BLOCKERS_RESOLVED_WAKE_REASON } from "../services/issue-dependency-wakeups.ts";

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

// TRUNCATE takes AccessExclusiveLock on every listed table, so a heartbeat run
// dispatched by a heal and still writing in the background can deadlock with it
// (Postgres 40P01) or block it past lock_timeout (55P03). Losing that race used
// to abort cleanup and leak the previous test's issues/recovery actions into the
// next test, which then failed on unrelated count assertions. Retry instead: the
// competing statement is already finishing when Postgres breaks the cycle.
function isRetryableLockError(error: unknown): boolean {
  const codes = new Set(["40P01", "55P03", "40001"]);
  for (let current: unknown = error, depth = 0; current && depth < 6; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && codes.has(code)) return true;
    const message = (current as { message?: unknown }).message;
    if (
      typeof message === "string" &&
      (message.includes("deadlock detected") || message.includes("due to lock timeout"))
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

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

    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.execute(sql.raw(TRUNCATE_ALL_SQL));
        return;
      } catch (error) {
        if (!isRetryableLockError(error)) throw error;
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    throw lastError;
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

  function oldDate() {
    return new Date(Date.now() - GRACE_THRESHOLD_MS - 60_000);
  }

  async function enableBlockedWithoutBlockersAutoHeal() {
    await instanceSettingsService(db).updateGeneral({ enableBlockedWithoutBlockersAutoHeal: true });
  }

  async function drainAgentRuns(agentId: string, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const activeRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"] as const)));
      if (activeRuns.length === 0) return;
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
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.contextSnapshot, issueId))
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

  it("re-arm cap creates board-owned recovery action instead of wake", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const blockerId = randomUUID();
    const now = new Date("2026-08-05T12:00:00.000Z");
    const longAgo = new Date("2026-08-01T00:00:00.000Z");

    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        title: "Dependent blocked issue",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
        updatedAt: oldDate(),
      },
      {
        id: blockerId,
        companyId,
        title: "Resolved blocker",
        status: "done",
        priority: "high",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId,
      type: "blocks",
      issueId: blockerId,
      relatedIssueId: issueId,
    });
    const wakeIdempotencyKey = `${ISSUE_BLOCKERS_RESOLVED_WAKE_REASON}:${issueId}:${blockerId}`;
    await db.insert(agentWakeupRequests).values(
      [1, 2, 3].map(() => ({
        id: randomUUID(),
        companyId,
        agentId,
        source: "blockers_resolved_wake",
        status: "completed" as const,
        idempotencyKey: wakeIdempotencyKey,
        runId: randomUUID(),
        createdAt: longAgo,
        updatedAt: longAgo,

      })),
    );

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileResolvedDependencyWakeBackstop({
      now,
      rearmWindowMs: 100,
      rearmMaxCount: 3,
      companyId,
    });

    expect(result.checked).toBe(1);
    expect(result.reArmCapEscalated).toBe(1);
    expect(result.reArmCapSkipped).toBe(0);
    expect(result.reArmCapEscalatedIssueIds).toEqual([issueId]);
    expect(result.healed).toBe(0);

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
      previousOwnerAgentId: agentId,
      cause: "dependency_wake_rearm_cap_exhausted",
      fingerprint: `drearm:${companyId}:${issueId}`,
      nextAction: expect.stringContaining("woken multiple times"),
    });
    expect(action?.evidence).toMatchObject({
      identifier: null,
      reArmCount: 3,
      reArmMax: 3,
    });
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
});
