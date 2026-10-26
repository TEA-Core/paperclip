import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueWatchdogs,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateWithLockRetry } from "./helpers/truncate-with-lock-retry.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { recoveryService } from "../services/recovery/service.ts";
import {
  TIMER_DISPATCH_SUPPRESSED_ACTION,
  buildTimerDispatchSuppressionDetails,
} from "../services/issue-continuation-path.ts";

// loadConfig() in recovery/service.ts validates bind mode eagerly.
process.env.PAPERCLIP_BIND = "loopback";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dispatch-suppression-park tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}


const TRUNCATE_ALL_SQL = `
  TRUNCATE TABLE
    "activity_log",
    "document_revisions",
    "documents",
    "execution_workspaces",
    "heartbeat_run_events",
    "heartbeat_runs",
    "issue_comments",
    "issue_documents",
    "issue_relations",
    "issue_recovery_actions",
    "issue_thread_interactions",
    "issues",
    "agent_wakeup_requests",
    "agent_runtime_state",
    "agents",
    "instance_settings",
    "companies",
    "project_workspaces",
    "projects"
  RESTART IDENTITY CASCADE
`;

const ALL_FALSE_DISJUNCTS = {
  activeRun: false,
  monitorNextCheckAtInFuture: false,
  watchdog: false,
  scheduledRetry: false,
  activeRecoveryAction: false,
  successfulRunHandoffLive: false,
};

const PARKED_ACTION = "issue.dispatch_suppression_parked";
const NOTICE_MARKER = "Missing §2a disjuncts";

describeEmbeddedPostgres("recovery reconcileDispatchSuppressionParks", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dispatch-suppression-park-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    // No drain here: recovery() injects a mocked enqueueWakeup, so this suite
    // never dispatches a background run whose late writes could race the
    // TRUNCATE. The retry still guards the lock family (40P01 / 55P03 / 40001)
    // against any other writer.
    await truncateWithLockRetry(db, TRUNCATE_ALL_SQL);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function recovery() {
    return recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
  }

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

  async function seedSuppressedCard(input: {
    companyId: string;
    agentId: string;
    lastRealActivityMsAgo?: number;
    suppressionMsAgo?: number;
    monitorNextCheckAtMsFromNow?: number;
  }): Promise<string> {
    const issueId = randomUUID();
    const now = Date.now();
    const lastRealActivityAt = new Date(
      now - (input.lastRealActivityMsAgo ?? 3 * 60 * 60 * 1000),
    );
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Suppressed in-progress card",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: input.agentId,
      updatedAt: lastRealActivityAt,
      monitorNextCheckAt:
        input.monitorNextCheckAtMsFromNow != null
          ? new Date(now + input.monitorNextCheckAtMsFromNow)
          : null,
    });
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: "system",
      agentId: input.agentId,
      action: TIMER_DISPATCH_SUPPRESSED_ACTION,
      entityType: "issue",
      entityId: issueId,
      details: buildTimerDispatchSuppressionDetails({
        issueId,
        status: "in_progress",
        disjuncts: ALL_FALSE_DISJUNCTS,
        settledWithinWindow: false,
        lastActivityAt: lastRealActivityAt,
      }),
      createdAt: new Date(now - (input.suppressionMsAgo ?? 30 * 60 * 1000)),
    });
    return issueId;
  }

  async function readIssue(issueId: string) {
    const rows = await db
      .select({ status: issues.status, updatedAt: issues.updatedAt })
      .from(issues)
      .where(eq(issues.id, issueId));
    return rows[0] ?? null;
  }

  async function countActivity(action: string, issueId: string) {
    const rows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, action),
        ),
      );
    return rows.length;
  }

  async function countParkNotices(issueId: string) {
    const rows = await db
      .select({ id: issueComments.id, body: issueComments.body })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
    return rows.filter((row) => (row.body ?? "").includes(NOTICE_MARKER)).length;
  }

  it("parks a persistently suppressed in_progress card to blocked exactly once", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedSuppressedCard({ companyId, agentId });
    const svc = recovery();

    const first = await svc.reconcileDispatchSuppressionParks({ now: new Date() });
    expect(first.parked).toBe(1);
    expect(first.livePathSkipped).toBe(0);
    expect(first.sustainedWindowSkipped).toBe(0);
    expect(first.issueIds).toEqual([issueId]);

    expect((await readIssue(issueId))?.status).toBe("blocked");
    expect(await countActivity(PARKED_ACTION, issueId)).toBe(1);
    expect(await countParkNotices(issueId)).toBe(1);
    const firstActions = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(firstActions).toHaveLength(1);
    expect(firstActions[0]).toMatchObject({
      kind: "issue_graph_liveness",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
    });
    for (const cure of ["finish", "link a blocker or interaction", "arm a monitor", "reassign"]) {
      expect(firstActions[0]?.nextAction).toContain(cure);
    }

    // Re-run: the card is now blocked, so it is no longer an in_progress candidate.
    const second = await svc.reconcileDispatchSuppressionParks({ now: new Date() });
    expect(second.parked).toBe(0);
    expect(await countActivity(PARKED_ACTION, issueId)).toBe(1);
    expect(await countParkNotices(issueId)).toBe(1);
    const secondActions = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(secondActions).toHaveLength(1);
    expect(secondActions[0]?.status).toBe("active");
  });

  it("never parks a card that still has a live continuation path", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedSuppressedCard({
      companyId,
      agentId,
      monitorNextCheckAtMsFromNow: 60 * 60 * 1000, // a future monitor check is a live path
    });
    const svc = recovery();

    const result = await svc.reconcileDispatchSuppressionParks({ now: new Date() });
    expect(result.parked).toBe(0);
    expect(result.livePathSkipped).toBe(1);
    expect((await readIssue(issueId))?.status).toBe("in_progress");
    expect(await countActivity(PARKED_ACTION, issueId)).toBe(0);
  });

  it("does not park when a watchdog restores continuation after suppression", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedSuppressedCard({ companyId, agentId });
    await db.insert(issueWatchdogs).values({ companyId, issueId, watchdogAgentId: agentId });
    const result = await recovery().reconcileDispatchSuppressionParks({ now: new Date() });
    expect(result.parked).toBe(0);
    expect((await readIssue(issueId))?.status).toBe("in_progress");
    expect(await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
  });

  it("does not park a suppressed card before the sustained window elapses", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedSuppressedCard({
      companyId,
      agentId,
      lastRealActivityMsAgo: 10 * 60 * 1000, // 10 min < the 2h sustained window
      suppressionMsAgo: 5 * 60 * 1000,
    });
    const svc = recovery();

    const result = await svc.reconcileDispatchSuppressionParks({ now: new Date() });
    expect(result.parked).toBe(0);
    expect(result.sustainedWindowSkipped).toBe(1);
    expect((await readIssue(issueId))?.status).toBe("in_progress");
  });

  it("keeps the agent-owned park distinct from generic blockerless escalation", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedSuppressedCard({ companyId, agentId });
    const svc = recovery();
    await svc.reconcileDispatchSuppressionParks({ now: new Date() });
    const parked = await readIssue(issueId);
    const result = await svc.reconcileBlockedWithoutBlockers({
      now: new Date(parked!.updatedAt.getTime() + 16 * 60 * 1000),
    });
    expect(result.escalated).toBe(0);
    const actions = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "issue_graph_liveness", ownerAgentId: agentId });
  });

  it("does not cancel another issue-graph recovery cause", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedSuppressedCard({
      companyId, agentId, monitorNextCheckAtMsFromNow: 60_000,
    });
    await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "issue_graph_liveness",
      status: "active", ownerType: "agent", ownerAgentId: agentId,
      cause: "other_liveness_problem", fingerprint: `other:${issueId}`,
      nextAction: "Inspect other liveness problem.",
    });
    await recovery().reconcileDispatchSuppressionParks({ now: new Date() });
    const [action] = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action?.status).toBe("active");
  });

  it("cancels the park action when a future monitor restores a live continuation path", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedSuppressedCard({ companyId, agentId });
    const svc = recovery();
    await svc.reconcileDispatchSuppressionParks({ now: new Date() });
    await db.update(issues).set({ monitorNextCheckAt: new Date(Date.now() + 60_000) })
      .where(eq(issues.id, issueId));
    await svc.reconcileDispatchSuppressionParks({ now: new Date() });
    const actions = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: "cancelled", outcome: "cancelled" });
    await svc.reconcileDispatchSuppressionParks({ now: new Date() });
    expect(await countActivity("issue.dispatch_suppression_park_cancelled", issueId)).toBe(1);
  });

  it.each(["active run", "stamped queued run", "watchdog", "scheduled retry", "handoff wake"] as const)(
    "cancels the parked action when a %s restores continuation",
    async (path) => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = await seedSuppressedCard({ companyId, agentId });
      const svc = recovery();
      await svc.reconcileDispatchSuppressionParks({ now: new Date() });
      if (path === "watchdog") {
        await db.insert(issueWatchdogs).values({ companyId, issueId, watchdogAgentId: agentId });
      } else if (path === "handoff wake") {
        await db.insert(activityLog).values({
          companyId, actorType: "system", actorId: "system", action: "issue.successful_run_handoff_required",
          entityType: "issue", entityId: issueId, details: {},
        });
        await db.insert(agentWakeupRequests).values({
          companyId, agentId, source: "test", status: "queued", payload: { issueId },
        });
      } else if (path === "stamped queued run") {
        const [run] = await db.insert(heartbeatRuns).values({
          companyId, agentId, status: "queued",
        }).returning({ id: heartbeatRuns.id });
        await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, issueId));
      } else {
        await db.insert(heartbeatRuns).values({
          companyId, agentId, status: path === "active run" ? "running" : "scheduled_retry",
          contextSnapshot: { issueId },
          ...(path === "scheduled retry" ? { scheduledRetryReason: "test" } : {}),
        });
      }
      await svc.reconcileDispatchSuppressionParks({ now: new Date() });
      const [action] = await db.select().from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId));
      expect(action).toMatchObject({ kind: "issue_graph_liveness", status: "cancelled" });
    },
  );
});
