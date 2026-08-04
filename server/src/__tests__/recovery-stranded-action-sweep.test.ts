import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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

import { recoveryService } from "../services/recovery/service.js";

// Explicit sweep interval so the seeded staleness windows below are independent
// of RECOVERY_ACTION_WAKE_INTERVAL_MS in the ambient environment.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stranded-recovery-action sweeper tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery reconcileStaleRecoveryActionWakes (stranded action backstop)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stranded-recovery-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const ctoId = randomUUID();
    const coderId = randomUUID();
    const prefix = `SR${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Stranded Recovery Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ctoId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: ctoId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { companyId, ctoId, coderId, prefix };
  }

  let issueNumberSeq = 0;
  async function seedSourceIssue(companyId: string, assigneeAgentId: string, status = "in_progress", updatedAtOverride?: Date) {
    const issueId = randomUUID();
    issueNumberSeq += 1;
    const prefix = `SR${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    const now = new Date();
    // Default updatedAt to 30 min ago so it predates the 20-min staleAt window
    // used by seedRecoveryAction.
    const updatedAt = updatedAtOverride ?? new Date(now.getTime() - 30 * 60 * 1000);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded issue",
      status,
      priority: "medium",
      assigneeAgentId,
      issueNumber: issueNumberSeq,
      identifier: `${prefix}-${issueNumberSeq}`,
      createdAt: now,
      updatedAt,
    });
    return issueId;
  }

  async function seedRecoveryAction(overrides: Record<string, unknown> = {}) {
    const now = new Date();
    const staleAt = new Date(now.getTime() - 20 * 60 * 1000);
    const actionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: actionId,
      companyId: overrides.companyId ?? "company-1",
      sourceIssueId: overrides.sourceIssueId ?? "source-1",
      recoveryIssueId: null,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: overrides.ownerAgentId ?? "agent-1",
      ownerUserId: null,
      previousOwnerAgentId: overrides.previousOwnerAgentId ?? null,
      returnOwnerAgentId: null,
      cause: "stranded_assigned_issue",
      fingerprint: "stranded:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Restore a live execution path.",
      wakePolicy: overrides.wakePolicy ?? { type: "wake_owner" },
      monitorPolicy: null,
      attemptCount: 0,
      maxAttempts: null,
      timeoutAt: null,
      lastAttemptAt: overrides.lastAttemptAt ?? staleAt,
      outcome: null,
      resolutionNote: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
    return actionId;
  }

  it("re-queues a stale wake_owner action to its owner", async () => {
    const { companyId, ctoId, coderId } = await seedCompany();
    const sourceIssueId = await seedSourceIssue(companyId, coderId);
    const actionId = await seedRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: ctoId,
      wakePolicy: { type: "wake_owner", reason: "test" },
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: SWEEP_INTERVAL_MS });

    expect(result.reFired).toBe(1);
    expect(result.rerouted).toBe(0);
    expect(result.nonWakeableSkipped).toBe(0);
    expect(result.skippedTerminalSource).toBe(0);
    expect(result.actionIds).toEqual([actionId]);

    const updated = await db
      .select({ attemptCount: issueRecoveryActions.attemptCount, lastAttemptAt: issueRecoveryActions.lastAttemptAt })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId))
      .then((rows) => rows[0]);
    expect(updated?.attemptCount).toBe(1);
    expect(updated?.lastAttemptAt).not.toBeNull();

    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup.mock.calls[0][0]).toBe(ctoId);
    expect(enqueueWakeup.mock.calls[0][1].reason).toBe("source_scoped_recovery_action");
    expect(enqueueWakeup.mock.calls[0][1].idempotencyKey).toBe(
      `source_scoped_recovery_action:${actionId}:1`,
    );
  });

  it("skips actions whose source issue is done", async () => {
    const { companyId, ctoId, coderId } = await seedCompany();
    const sourceIssueId = await seedSourceIssue(companyId, coderId, "done");
    await seedRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: ctoId,
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: SWEEP_INTERVAL_MS });

    expect(result.reFired).toBe(0);
    expect(result.rerouted).toBe(0);
    expect(result.nonWakeableSkipped).toBe(0);
    expect(result.skippedTerminalSource).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("skips actions whose source issue is cancelled", async () => {
    const { companyId, ctoId, coderId } = await seedCompany();
    const sourceIssueId = await seedSourceIssue(companyId, coderId, "cancelled");
    await seedRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: ctoId,
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: SWEEP_INTERVAL_MS });

    expect(result.skippedTerminalSource).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("skips monitor_only and manual_repair_required actions", async () => {
    const { companyId, ctoId, coderId } = await seedCompany();
    const sourceIssueId1 = await seedSourceIssue(companyId, coderId);
    const sourceIssueId2 = await seedSourceIssue(companyId, coderId);

    await seedRecoveryAction({
      companyId,
      sourceIssueId: sourceIssueId1,
      ownerAgentId: ctoId,
      wakePolicy: { type: "monitor_only" },
    });
    await seedRecoveryAction({
      companyId,
      sourceIssueId: sourceIssueId2,
      ownerAgentId: ctoId,
      wakePolicy: { type: "manual_repair_required" },
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: SWEEP_INTERVAL_MS });

    expect(result.reFired).toBe(0);
    expect(result.rerouted).toBe(0);
    expect(result.nonWakeableSkipped).toBe(2);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("re-routes a board_escalation action when owner resolution succeeds", async () => {
    const { companyId, ctoId, coderId } = await seedCompany();
    const sourceIssueId = await seedSourceIssue(companyId, coderId);
    const actionId = await seedRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      wakePolicy: { type: "board_escalation" },
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: SWEEP_INTERVAL_MS });

    expect(result.rerouted).toBe(1);
    expect(result.reFired).toBe(0);
    expect(result.nonWakeableSkipped).toBe(0);
    expect(result.actionIds).toEqual([actionId]);

    const updated = await db
      .select({
        ownerAgentId: issueRecoveryActions.ownerAgentId,
        wakePolicy: issueRecoveryActions.wakePolicy,
        attemptCount: issueRecoveryActions.attemptCount,
      })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId))
      .then((rows) => rows[0]);
    expect(updated?.ownerAgentId).toBe(coderId);
    expect(updated?.wakePolicy).toMatchObject({ type: "wake_owner" });
    expect(updated?.attemptCount).toBe(1);

    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup.mock.calls[0][0]).toBe(coderId);
    expect(enqueueWakeup.mock.calls[0][1].reason).toBe("source_scoped_recovery_action");
  });

  it("leaves board_escalation action dead when owner resolution is exhausted", async () => {
    const { companyId, ctoId, coderId } = await seedCompany();
    const sourceIssueId = await seedSourceIssue(companyId, coderId);
    await db
      .update(agents)
      .set({ status: "terminated" })
      .where(eq(agents.id, ctoId));
    await db
      .update(agents)
      .set({ status: "terminated" })
      .where(eq(agents.id, coderId));
    const actionId = await seedRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: null,
      previousOwnerAgentId: ctoId,
      wakePolicy: { type: "board_escalation" },
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: SWEEP_INTERVAL_MS });

    expect(result.rerouted).toBe(0);
    expect(result.reFired).toBe(0);
    expect(result.nonWakeableSkipped).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const updated = await db
      .select({ attemptCount: issueRecoveryActions.attemptCount })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId))
      .then((rows) => rows[0]);
    expect(updated?.attemptCount).toBe(1);
  });

  it("skips actions with no ownerAgentId and non-board_escalation policy", async () => {
    const { companyId, coderId } = await seedCompany();
    const sourceIssueId = await seedSourceIssue(companyId, coderId);
    await seedRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: null,
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: SWEEP_INTERVAL_MS });

    expect(result.reFired).toBe(0);
    expect(result.rerouted).toBe(0);
    expect(result.nonWakeableSkipped).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not process actions that are not yet stale", async () => {
    const { companyId, ctoId, coderId } = await seedCompany();
    const sourceIssueId = await seedSourceIssue(companyId, coderId);
    await seedRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: ctoId,
      wakePolicy: { type: "wake_owner" },
      lastAttemptAt: new Date(),
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: SWEEP_INTERVAL_MS });

    expect(result.reFired).toBe(0);
    expect(result.rerouted).toBe(0);
    expect(result.nonWakeableSkipped).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not process non-active actions", async () => {
    const { companyId, ctoId, coderId } = await seedCompany();
    const sourceIssueId = await seedSourceIssue(companyId, coderId);
    await seedRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: ctoId,
      wakePolicy: { type: "wake_owner" },
      status: "resolved",
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: SWEEP_INTERVAL_MS });

    expect(result.reFired).toBe(0);
    expect(result.rerouted).toBe(0);
    expect(result.nonWakeableSkipped).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("is idempotent — second pass finds nothing stale", async () => {
    const { companyId, ctoId, coderId } = await seedCompany();
    const sourceIssueId = await seedSourceIssue(companyId, coderId);
    const actionId = await seedRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: ctoId,
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const first = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: SWEEP_INTERVAL_MS });
    expect(first.reFired).toBe(1);

    const second = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: SWEEP_INTERVAL_MS });
    expect(second.reFired).toBe(0);
    expect(second.rerouted).toBe(0);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("processes multiple stale actions in a single sweep", async () => {
    const { companyId, ctoId, coderId } = await seedCompany();
    const sourceIssueId1 = await seedSourceIssue(companyId, coderId);
    const sourceIssueId2 = await seedSourceIssue(companyId, coderId);

    const actionId1 = await seedRecoveryAction({
      companyId,
      sourceIssueId: sourceIssueId1,
      ownerAgentId: ctoId,
      wakePolicy: { type: "wake_owner" },
    });
    const actionId2 = await seedRecoveryAction({
      companyId,
      sourceIssueId: sourceIssueId2,
      ownerAgentId: ctoId,
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: SWEEP_INTERVAL_MS });

    expect(result.reFired).toBe(2);
    expect(result.actionIds).toHaveLength(2);
    expect(result.actionIds).toContain(actionId1);
    expect(result.actionIds).toContain(actionId2);
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
  });

  it("escalates and does not re-wake when attemptCount reaches the ceiling", async () => {
    const { companyId, ctoId, coderId } = await seedCompany();
    const sourceIssueId = await seedSourceIssue(companyId, coderId);
    const actionId = await seedRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: ctoId,
      wakePolicy: { type: "wake_owner", reason: "test" },
      attemptCount: 5,
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: SWEEP_INTERVAL_MS });

    expect(result.reFired).toBe(0);
    expect(result.rerouted).toBe(0);
    expect(result.maxAttemptsReached).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const updated = await db
      .select({ status: issueRecoveryActions.status, outcome: issueRecoveryActions.outcome })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId))
      .then((rows) => rows[0]);
    expect(updated?.status).toBe("escalated");
    expect(updated?.outcome).toBe("exhausted");
  });

  it("blocks the source issue and posts a board escalation comment when the ceiling is exhausted", async () => {
    const { companyId, ctoId, coderId } = await seedCompany();
    const sourceIssueId = await seedSourceIssue(companyId, coderId);
    const actionId = await seedRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: ctoId,
      wakePolicy: { type: "wake_owner", reason: "test" },
      attemptCount: 5,
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: SWEEP_INTERVAL_MS });

    expect(result.maxAttemptsReached).toBe(1);

    const issue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, sourceIssueId))
      .then((rows) => rows[0]);
    expect(issue?.status).toBe("blocked");

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, sourceIssueId));
    expect(comments.some((c) => (c.body ?? "").includes("exhausted its attempt ceiling"))).toBe(true);
    expect(comments.some((c) => (c.body ?? "").includes("escalated to the board"))).toBe(true);
  });

});
