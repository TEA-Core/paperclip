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

  async function seedCompany(
    sourceIssue: {
      status?: string;
      assigneeAgentId?: string | null;
      assigneeUserId?: string | null;
    } = {},
  ) {
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
      status: sourceIssue.status ?? "in_progress",
      priority: "medium",
      ...(sourceIssue.assigneeAgentId === null
        ? {}
        : { assigneeAgentId: sourceIssue.assigneeAgentId ?? coderId }),
      ...(sourceIssue.assigneeUserId ? { assigneeUserId: sourceIssue.assigneeUserId } : {}),
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
    startedAt?: Date;
  }) {
    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "manual",
      status: input.status,
      startedAt: input.startedAt ?? new Date("2026-05-13T18:00:00.000Z"),
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
    kind?: string;
    ownerType?: "agent" | "board";
    previousOwnerAgentId?: string | null;
    updatedAt?: Date;
  }) {
    const [row] = await db
      .insert(issueRecoveryActions)
      .values({
        id: randomUUID(),
        companyId: input.companyId,
        sourceIssueId: input.sourceIssueId,
        recoveryIssueId: null,
        kind: input.kind ?? "stranded_assigned_issue",
        status: input.status,
        ownerType: input.ownerType ?? "agent",
        ownerAgentId: input.ownerAgentId,
        ownerUserId: null,
        previousOwnerAgentId: input.previousOwnerAgentId ?? null,
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
        updatedAt: input.updatedAt ?? new Date(),
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
    expect(updated.lastAttemptAt).not.toBeNull();
    if (updated.lastAttemptAt === null) {
      throw new Error("expected lastAttemptAt to be set");
    }
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

    // SUP-21344: exhaustion must leave the board a concrete artefact the monitor
    // claimer can fire (an armed board decision monitor), not a passive comment.
    const [sourceIssue] = await db
      .select({ monitorNextCheckAt: issues.monitorNextCheckAt, monitorScheduledBy: issues.monitorScheduledBy })
      .from(issues)
      .where(eq(issues.id, sourceIssueId));
    expect(sourceIssue.monitorNextCheckAt).not.toBeNull();
    expect(sourceIssue.monitorNextCheckAt!.getTime()).toBeGreaterThan(Date.now());
    expect(sourceIssue.monitorScheduledBy).toBe("board");
    expect(exhaustionComment!.body).toContain("Board decision item:");
  });

  it.each([
    { label: "todo status", sourceIssue: { status: "todo" } },
    { label: "unassigned", sourceIssue: { assigneeAgentId: null } },
    { label: "user assignee", sourceIssue: { assigneeUserId: "board-user-1" } },
  ])(
    "SUP-21344: exhaustion on a non-monitor-dispatchable source ($label) arms no fake monitor but mints an owned recovery issue",
    async ({ sourceIssue }) => {
      const { companyId, coderId, managerId, sourceIssueId } = await seedCompany(sourceIssue);

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

      const wakeCalls: unknown[][] = [];
      const enqueueWakeup = vi.fn((...args: unknown[]) => {
        wakeCalls.push(args);
        return Promise.resolve(null);
      });
      const recovery = recoveryService(db, { enqueueWakeup });

      const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

      expect(result.maxAttemptsReached).toBe(1);
      // The only wake is the recovery-issue owner's, not a source re-fire.
      expect(enqueueWakeup).toHaveBeenCalledTimes(1);

      const [updated] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, action.id));
      expect(updated.status).toBe("escalated");
      expect(updated.outcome).toBe("exhausted");
      expect(updated.ownerType).toBe("board");
      expect(updated.recoveryIssueId).not.toBeNull();

      const [wakeAgentId, wakeOpts] = wakeCalls[0]!;
      expect(wakeAgentId).toBe(managerId);
      const opts = wakeOpts as {
        reason: string;
        idempotencyKey: string;
        payload: { sourceIssueId: string; recoveryActionId: string };
      };
      expect(opts.reason).toBe("exhausted_recovery_issue");
      expect(opts.idempotencyKey).toBe(
        `exhausted-recovery-issue:${action.id}:${updated.recoveryIssueId}`,
      );
      expect(opts.payload.sourceIssueId).toBe(sourceIssueId);
      expect(opts.payload.recoveryActionId).toBe(action.id);

      // The linked recovery issue is a durable, non-terminal, agent-owned card.
      const [recoveryIssue] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, updated.recoveryIssueId!));
      expect(recoveryIssue).toBeDefined();
      expect(recoveryIssue.status).toBe("todo");
      expect(recoveryIssue.assigneeAgentId).toBe(managerId);
      expect(recoveryIssue.originKind).toBe("stranded_issue_recovery");
      expect(recoveryIssue.originId).toBe(sourceIssueId);
      expect(recoveryIssue.parentId).toBe(sourceIssueId);

      // No fireable-wake claim on the source: the scheduler requires an agent
      // assignee in in_progress/in_review/blocked, so no monitor columns may
      // be written on the source row.
      const [issue] = await db
        .select({
          monitorNextCheckAt: issues.monitorNextCheckAt,
          monitorScheduledBy: issues.monitorScheduledBy,
          executionPolicy: issues.executionPolicy,
        })
        .from(issues)
        .where(eq(issues.id, sourceIssueId));
      expect(issue.monitorNextCheckAt).toBeNull();
      expect(issue.monitorScheduledBy).toBeNull();
      expect((issue.executionPolicy as { monitor?: unknown } | null)?.monitor).toBeUndefined();

      // The comment names the recovery issue and must not claim a scheduled
      // board check on the source.
      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, sourceIssueId));
      const exhaustionComment = comments.find((c) =>
        (c.body ?? "").includes("exhausted its attempt ceiling"),
      );
      expect(exhaustionComment).toBeDefined();
      expect(exhaustionComment!.body).toContain(`Board decision item: recovery_action:${action.id}`);
      expect(exhaustionComment!.body).toContain("not monitor-dispatchable");
      expect(exhaustionComment!.body).toContain(updated.recoveryIssueId!);
      expect(exhaustionComment!.body).not.toContain("next board check at");

      // Idempotency: a second sweep must not mint a duplicate recovery issue
      // or re-wake (the action is escalated now, so it is no longer a stale
      // `active` candidate at all).
      const second = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });
      expect(second.maxAttemptsReached).toBe(0);
      expect(enqueueWakeup).toHaveBeenCalledTimes(1);
      const recoveryIssues = await db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, "stranded_issue_recovery"),
            eq(issues.originId, sourceIssueId),
          ),
        );
      expect(recoveryIssues).toHaveLength(1);
    },
  );

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

  // -- SUP-24251 (redo of SUP-22273): live-owner hold --

  const SWEEP_INTERVAL_MS = 5 * 60_000;

  function minutesBefore(base: Date, minutes: number): Date {
    return new Date(base.getTime() - minutes * 60_000);
  }

  function minutesAgo(minutes: number): Date {
    return minutesBefore(new Date(), minutes);
  }

  async function readAction(actionId: string) {
    const [row] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId));
    return row!;
  }

  async function exhaustionComments(issueId: string) {
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    return comments.filter((c) => (c.body ?? "").includes("exhausted its attempt ceiling"));
  }

  async function sweepOnce() {
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: SWEEP_INTERVAL_MS });
    return { result, enqueueWakeup };
  }

  // Seeds the SUP-21709 shape: an active execution_review_participant_recovery
  // action owned by the recovery agent for the review participant, one attempt
  // in, with the owner's only run placed relative to the first sweep.
  async function seedReviewParticipantRecoveryAction(input: { ownerRunMinutesBeforeStart: number }) {
    const start = minutesAgo(4 * 60);
    vi.setSystemTime(start);
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany({ status: "in_review" });
    const action = await insertRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      cause: "execution_review_participant_recovery",
      attemptCount: 1,
      maxAttempts: null,
      lastAttemptAt: minutesBefore(start, 30),
      status: "active",
      wakePolicy: { type: "wake_owner" },
    });
    await seedHeartbeatRun({
      companyId,
      agentId: managerId,
      runId: randomUUID(),
      issueId: sourceIssueId,
      status: "succeeded",
      startedAt: minutesBefore(start, input.ownerRunMinutesBeforeStart),
    });
    return { start, sourceIssueId, actionId: action.id };
  }

  async function sweepSixTimes(input: { actionId: string; start: Date }) {
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const attemptCounts: number[] = [];
    const statuses: string[] = [];
    for (let sweep = 0; sweep < 6; sweep += 1) {
      // 31 minutes apart: past the longest backoff a below-ceiling row reaches
      // (4 x 5 min), so only the live-owner hold can stop a re-fire.
      vi.setSystemTime(new Date(input.start.getTime() + sweep * 31 * 60_000));
      await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: SWEEP_INTERVAL_MS });
      const row = await readAction(input.actionId);
      attemptCounts.push(row.attemptCount);
      statuses.push(row.status);
    }
    return { attemptCounts, statuses, enqueueWakeup };
  }

  it("SUP-24251 T2: six sweeps neither burn attempts nor escalate while the action owner ran after lastAttemptAt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { start, sourceIssueId, actionId } = await seedReviewParticipantRecoveryAction({
        ownerRunMinutesBeforeStart: 5,
      });

      const { attemptCounts, statuses, enqueueWakeup } = await sweepSixTimes({ actionId, start });

      expect(attemptCounts).toEqual([1, 1, 1, 1, 1, 1]);
      expect(statuses).toEqual(["active", "active", "active", "active", "active", "active"]);
      expect((await readAction(actionId)).outcome).toBeNull();
      expect(enqueueWakeup).not.toHaveBeenCalled();
      expect(await exhaustionComments(sourceIssueId)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("SUP-24251: six sweeps still burn attempts and escalate when the owner has not run since lastAttemptAt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // The owner ran inside the live window, but before the last wake.
      const { start, sourceIssueId, actionId } = await seedReviewParticipantRecoveryAction({
        ownerRunMinutesBeforeStart: 45,
      });

      const { attemptCounts, statuses } = await sweepSixTimes({ actionId, start });

      expect(attemptCounts).toEqual([2, 3, 4, 5, 5, 5]);
      expect(statuses).toEqual(["active", "active", "active", "active", "escalated", "escalated"]);
      expect((await readAction(actionId)).outcome).toBe("exhausted");
      expect(await exhaustionComments(sourceIssueId)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("SUP-24251: holds an at-ceiling action instead of escalating while its owner ran after lastAttemptAt", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const action = await insertRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      attemptCount: 5,
      maxAttempts: null,
      lastAttemptAt: minutesAgo(10),
      status: "active",
      wakePolicy: { type: "wake_owner" },
    });
    await seedHeartbeatRun({
      companyId,
      agentId: managerId,
      runId: randomUUID(),
      issueId: sourceIssueId,
      status: "succeeded",
      startedAt: minutesAgo(5),
    });

    const { result, enqueueWakeup } = await sweepOnce();

    expect(result).toMatchObject({ checked: 1, skippedOwnerLive: 1, maxAttemptsReached: 0, reFired: 0 });
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await readAction(action.id)).toMatchObject({
      status: "active",
      outcome: null,
      attemptCount: 5,
      maxAttempts: null,
    });
    expect(await exhaustionComments(sourceIssueId)).toHaveLength(0);
  });

  it("SUP-24251: holds a board-owned review_stage_unarmed action while its pending participant ran after lastAttemptAt", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const action = await insertRecoveryAction({
      companyId,
      sourceIssueId,
      kind: "review_stage_unarmed",
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      cause: "review_stage_unarmed",
      attemptCount: 5,
      maxAttempts: null,
      lastAttemptAt: minutesAgo(10),
      status: "active",
      wakePolicy: null,
    });
    await seedHeartbeatRun({
      companyId,
      agentId: coderId,
      runId: randomUUID(),
      issueId: sourceIssueId,
      status: "succeeded",
      startedAt: minutesAgo(5),
    });

    const { result } = await sweepOnce();

    expect(result).toMatchObject({ skippedOwnerLive: 1, maxAttemptsReached: 0 });
    expect(await readAction(action.id)).toMatchObject({ status: "active", outcome: null, attemptCount: 5 });
  });

  it("SUP-24251: a terminal source still escalates at the ceiling even while its owner is live", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany({ status: "done" });
    const action = await insertRecoveryAction({
      companyId,
      sourceIssueId,
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      attemptCount: 5,
      maxAttempts: null,
      lastAttemptAt: minutesAgo(10),
      status: "active",
      wakePolicy: { type: "wake_owner" },
    });
    await seedHeartbeatRun({
      companyId,
      agentId: managerId,
      runId: randomUUID(),
      issueId: sourceIssueId,
      status: "succeeded",
      startedAt: minutesAgo(5),
    });

    const { result } = await sweepOnce();

    expect(result).toMatchObject({ skippedOwnerLive: 0, maxAttemptsReached: 1 });
    expect(await readAction(action.id)).toMatchObject({ status: "escalated", outcome: "exhausted" });
  });

  it.each([
    {
      label: "the hold deadline (two live windows after the last row update) has passed",
      kind: "stranded_assigned_issue",
      lastAttemptMinutesAgo: 13 * 60,
      updatedMinutesAgo: 13 * 60,
      ownerRunMinutesAgo: 5,
    },
    {
      label: "the owner's run after lastAttemptAt is outside the live window",
      kind: "stranded_assigned_issue",
      lastAttemptMinutesAgo: 8 * 60,
      updatedMinutesAgo: 0,
      ownerRunMinutesAgo: 7 * 60,
    },
    {
      label: "the kind is not a stranded-participant kind",
      kind: "missing_disposition",
      lastAttemptMinutesAgo: 10,
      updatedMinutesAgo: 0,
      ownerRunMinutesAgo: 5,
    },
  ])("SUP-24251: burns the attempt as before when $label", async (scenario) => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const action = await insertRecoveryAction({
      companyId,
      sourceIssueId,
      kind: scenario.kind,
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
      maxAttempts: null,
      lastAttemptAt: minutesAgo(scenario.lastAttemptMinutesAgo),
      updatedAt: minutesAgo(scenario.updatedMinutesAgo),
      status: "active",
      wakePolicy: { type: "wake_owner" },
    });
    await seedHeartbeatRun({
      companyId,
      agentId: managerId,
      runId: randomUUID(),
      issueId: sourceIssueId,
      status: "succeeded",
      startedAt: minutesAgo(scenario.ownerRunMinutesAgo),
    });

    const { result } = await sweepOnce();

    expect(result).toMatchObject({ skippedOwnerLive: 0, reFired: 1 });
    expect((await readAction(action.id)).attemptCount).toBe(3);
  });
});
