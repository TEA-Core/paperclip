import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { recoveryService } from "../services/recovery/service.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import {
  TIMER_DISPATCH_SUPPRESSED_ACTION,
  buildTimerDispatchSuppressionDetails,
} from "../services/issue-continuation-path.ts";
import { buildDispatchSuppressionParkNotice } from "../services/recovery/stranded-notice.ts";

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

const SUSTAINED_WINDOW_MS = 2 * 60 * 60 * 1000;

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
    await db.execute(sql.raw(TRUNCATE_ALL_SQL));
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

    // Re-run: the card is now blocked, so it is no longer an in_progress candidate.
    const second = await svc.reconcileDispatchSuppressionParks({ now: new Date() });
    expect(second.parked).toBe(0);
    expect(await countActivity(PARKED_ACTION, issueId)).toBe(1);
    expect(await countParkNotices(issueId)).toBe(1);
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

  it("escalates a parked card onto the board surface via the existing sweep, exactly once", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedSuppressedCard({ companyId, agentId });
    const svc = recovery();

    await svc.reconcileDispatchSuppressionParks({ now: new Date() });
    const parked = await readIssue(issueId);
    expect(parked?.status).toBe("blocked");

    const sweepNow = new Date(parked!.updatedAt.getTime() + 16 * 60 * 1000);
    const escalation = await svc.reconcileBlockedWithoutBlockers({ now: sweepNow });
    expect(escalation.escalated).toBe(1);
    expect(escalation.issueIds).toEqual([issueId]);

    const actions = await db
      .select({
        kind: issueRecoveryActions.kind,
        status: issueRecoveryActions.status,
        ownerType: issueRecoveryActions.ownerType,
      })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions[0]).toMatchObject({
      kind: "blocked_without_blockers",
      status: "active",
      ownerType: "board",
    });

    // A second pass dedupes on the active board action.
    const again = await svc.reconcileBlockedWithoutBlockers({
      now: new Date(parked!.updatedAt.getTime() + 20 * 60 * 1000),
    });
    expect(again.escalated).toBe(0);
    expect(again.alreadyActionedSkipped).toBe(1);
  });

  it("heals a parked card through the existing _healed path when auto-heal is enabled", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedSuppressedCard({ companyId, agentId });
    const svc = recovery();

    await svc.reconcileDispatchSuppressionParks({ now: new Date() });
    const parked = await readIssue(issueId);
    expect(parked?.status).toBe("blocked");

    await instanceSettingsService(db).updateGeneral({ enableBlockedWithoutBlockersAutoHeal: true });
    const sweepNow = new Date(parked!.updatedAt.getTime() + 16 * 60 * 1000);
    const result = await svc.reconcileBlockedWithoutBlockers({ now: sweepNow });
    expect(result.healed).toBe(1);
    expect((await readIssue(issueId))?.status).toBe("todo");
    expect(await countActivity("issue.blocked_without_blockers_healed", issueId)).toBe(1);
  });
});

describe("buildDispatchSuppressionParkNotice", () => {
  it("names the failing §2a disjuncts and a concrete unblock action", () => {
    const notice = buildDispatchSuppressionParkNotice({
      disjuncts: ALL_FALSE_DISJUNCTS,
      identifier: "SUP-1",
      assignee: { id: "agent-1", name: "Coder" },
    });
    expect(notice.body).toContain("SUP-1");
    expect(notice.body).toContain(NOTICE_MARKER);
    expect(notice.body).toContain("no active or queued run");
    expect(notice.body).toContain("Unblock it by");
    expect(notice.body).toContain("monitor next check");
    expect(notice.presentation).toMatchObject({ kind: "system_notice", tone: "danger" });
    expect(JSON.stringify(notice.metadata.sections)).toContain("Unblock owner");
    expect(JSON.stringify(notice.metadata.sections)).toContain("agent-1");
  });
});
