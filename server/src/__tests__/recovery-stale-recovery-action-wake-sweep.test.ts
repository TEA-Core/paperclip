import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

// loadConfig() in recovery/service.ts validates bind mode eagerly.
process.env.PAPERCLIP_BIND = "loopback";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("reconcileStaleRecoveryActionWakes", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-recovery-action-wake-sweep-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `SW${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Stale Wake Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
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
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Implement backend recovery",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    return { companyId, managerId, coderId, sourceIssueId, prefix };
  }

  async function seedHeartbeatRun(input: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId: string;
    status: string;
  }) {
    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "manual",
      status: input.status,
      startedAt: new Date("2026-05-13T18:00:00.000Z"),
      contextSnapshot: { issueId: input.issueId },
    });
  }

  async function insertRecoveryAction(input: {
    companyId: string;
    sourceIssueId: string;
     ownerAgentId: string | null;
    cause: string;
    attemptCount: number;
    maxAttempts: number | null;
    lastAttemptAt: Date;
    status: "active" | "escalated" | "resolved" | "cancelled";
    wakePolicy: Record<string, unknown> | null;
  }) {
    const [row] = await db
      .insert(issueRecoveryActions)
      .values({
        id: randomUUID(),
        companyId: input.companyId,
        sourceIssueId: input.sourceIssueId,
        recoveryIssueId: null,
        kind: "stranded_assigned_issue",
        status: input.status,
        ownerType: "agent",
        ownerAgentId: input.ownerAgentId,
        ownerUserId: null,
        previousOwnerAgentId: null,
        returnOwnerAgentId: null,
        cause: input.cause,
        fingerprint: `fingerprint:${input.sourceIssueId}`,
        evidence: {},
        nextAction: "Restore a live execution path.",
        wakePolicy: input.wakePolicy,
        monitorPolicy: null,
        attemptCount: input.attemptCount,
        maxAttempts: input.maxAttempts,
        timeoutAt: null,
        lastAttemptAt: input.lastAttemptAt,
        outcome: null,
        resolutionNote: null,
        resolvedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    return row;
  }

  it("re-fires wake_owner for stale active actions and bumps attemptCount", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await seedHeartbeatRun({
      companyId,
      agentId: coderId,
      runId,
      issueId: sourceIssueId,
      status: "failed",
    });

    const staleAt = new Date(Date.now() - 10 * 60_000);
    const action = await insertRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 1,
      maxAttempts: null,
      lastAttemptAt: staleAt,
      status: "active",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

    expect(result.checked).toBe(1);
    expect(result.reFired).toBe(1);
    expect(result.maxAttemptsReached).toBe(0);
    expect(result.issueIds).toContain(sourceIssueId);

    const [updated] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(updated.attemptCount).toBe(2);
    expect(updated.lastAttemptAt.getTime()).toBeGreaterThan(staleAt.getTime());

    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(
      coderId,
      expect.objectContaining({
        reason: "source_scoped_recovery_action",
        idempotencyKey: `source_scoped_recovery_action:${action.id}:2`,
        payload: expect.objectContaining({
          recoveryActionId: action.id,
          recoveryCause: "stranded_assigned_issue",
        }),
      }),
    );
  });

  it("skips non-wakeable causes (configuration_incomplete, provider_quota without owner) without bumping attemptCount", async () => {
    const { companyId, coderId, prefix } = await seedCompany();

    const configIssueId = randomUUID();
    const quotaIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: configIssueId,
        companyId,
        title: "Config issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 2,
        identifier: `${prefix}-2`,
      },
      {
        id: quotaIssueId,
        companyId,
        title: "Quota issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 3,
        identifier: `${prefix}-3`,
      },
    ]);

    const staleAt = new Date(Date.now() - 10 * 60_000);
    const configAction = await insertRecoveryAction({
      companyId,
      sourceIssueId: configIssueId,
      ownerAgentId: coderId,
      cause: "configuration_incomplete",
      attemptCount: 1,
      maxAttempts: null,
      lastAttemptAt: staleAt,
      status: "active",
      wakePolicy: { type: "wake_owner" },
    });
    const quotaAction = await insertRecoveryAction({
      companyId,
      sourceIssueId: quotaIssueId,
      ownerAgentId: null,
      cause: "provider_quota",
      attemptCount: 1,
      maxAttempts: null,
      lastAttemptAt: staleAt,
      status: "active",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

    expect(result.checked).toBe(2);
    expect(result.reFired).toBe(0);
    expect(result.nonWakeableSkipped).toBe(2);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const [configUpdated] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, configAction.id));
    expect(configUpdated.attemptCount).toBe(1);

    const [quotaUpdated] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, quotaAction.id));
    expect(quotaUpdated.attemptCount).toBe(1);
  });

  it("stops re-firing at maxAttempts and reports maxAttemptsReached", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();

    const staleAt = new Date(Date.now() - 10 * 60_000);
    const action = await insertRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 3,
      maxAttempts: 3,
      lastAttemptAt: staleAt,
      status: "active",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

    expect(result.checked).toBe(1);
    expect(result.reFired).toBe(0);
    expect(result.maxAttemptsReached).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const [updated] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(updated.attemptCount).toBe(3);
  });

  it("persists the enforced default maxAttempts when escalating a null-maxAttempts action", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();

    const staleAt = new Date(Date.now() - 10 * 60_000);
    const action = await insertRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 5,
      maxAttempts: null,
      lastAttemptAt: staleAt,
      status: "active",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

    expect(result.checked).toBe(1);
    expect(result.maxAttemptsReached).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const [updated] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(updated.status).toBe("escalated");
    expect(updated.outcome).toBe("exhausted");
    expect(updated.maxAttempts).toBe(5);

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, sourceIssueId));
    const exhaustionComment = comments.find((c) =>
      (c.body ?? "").includes("exhausted its attempt ceiling"),
    );
    expect(exhaustionComment).toBeDefined();
    expect(exhaustionComment!.body).toContain(`(${action.attemptCount}/${updated.maxAttempts})`);
  });

  it("does not re-fire for actions that are not stale", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();

    const recentAt = new Date(Date.now() - 1 * 60_000);
    await insertRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 1,
      maxAttempts: null,
      lastAttemptAt: recentAt,
      status: "active",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

    expect(result.checked).toBe(0);
    expect(result.reFired).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not re-fire for non-active actions", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();

    const staleAt = new Date(Date.now() - 10 * 60_000);
    await insertRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 1,
      maxAttempts: null,
      lastAttemptAt: staleAt,
      status: "resolved",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

    expect(result.checked).toBe(0);
    expect(result.reFired).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("handles concurrent CAS failure gracefully (row changed between read and update)", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await seedHeartbeatRun({
      companyId,
      agentId: coderId,
      runId,
      issueId: sourceIssueId,
      status: "failed",
    });

    const staleAt = new Date(Date.now() - 10 * 60_000);
    const action = await insertRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 1,
      maxAttempts: null,
      lastAttemptAt: staleAt,
      status: "active",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const updateSpy = vi
      .spyOn(db, "update")
      .mockImplementation(() =>
        new Proxy({} as ReturnType<typeof db.update>, {
          get(_target, prop) {
            if (prop === "returning") return () => Promise.resolve([]);
            return () => ({ where: () => ({ returning: () => Promise.resolve([]) }) });
          },
        }),
      );

    try {
      const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

      expect(result.checked).toBe(1);
      expect(result.reFired).toBe(0);
      expect(enqueueWakeup).not.toHaveBeenCalled();

      const [updated] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, action.id));
      expect(updated.attemptCount).toBe(1);
    } finally {
      updateSpy.mockRestore();
    }
  });
});
