import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issueRecoveryActions,
  issueThreadInteractions,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService } from "../services/heartbeat.ts";
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

describeEmbeddedPostgres("recovery reconcileBlockedWithoutBlockers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-without-blockers-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(issueRecoveryActions);
    await db.delete(agentWakeupRequests);
    await db.delete(issueThreadInteractions);
    await db.delete(issueTreeHolds);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
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
});
