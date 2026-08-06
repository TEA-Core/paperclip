import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const GRACE_WINDOW_MS = 15 * 60 * 1000;

describeEmbeddedPostgres("recovery no-live-path strands", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-no-live-path-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueRecoveryActions);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const prefix = `RA${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Co",
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
    return { companyId, managerId, coderId, prefix };
  }

  async function seedPausedAgent(companyId: string, managerId: string) {
    const pausedAgentId = randomUUID();
    await db.insert(agents).values({
      id: pausedAgentId,
      companyId,
      name: "Paused",
      role: "engineer",
      status: "paused",
      reportsTo: managerId,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return pausedAgentId;
  }

  async function seedTerminatedAgent(companyId: string, managerId: string) {
    const terminatedAgentId = randomUUID();
    await db.insert(agents).values({
      id: terminatedAgentId,
      companyId,
      name: "Terminated",
      role: "engineer",
      status: "terminated",
      reportsTo: managerId,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return terminatedAgentId;
  }

  async function createIssue(
    companyId: string,
    prefix: string,
    status: "todo" | "in_progress" | "in_review",
    assigneeAgentId: string | null,
    opts: {
      updatedAt?: Date;
      executionPolicy?: Record<string, unknown>;
      executionState?: Record<string, unknown> | null;
    } = {},
  ) {
    const issueId = randomUUID();
    const issueNumber = 1;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Test ${status} issue`,
      status,
      priority: "medium",
      assigneeAgentId: assigneeAgentId ?? undefined,
      issueNumber,
      identifier: `${prefix}-${issueNumber}`,
      updatedAt: opts.updatedAt ?? new Date(),
      executionPolicy: opts.executionPolicy ?? undefined,
      executionState: opts.executionState ?? undefined,
    });
    return issueId;
  }

  function pastGraceDate(): Date {
    return new Date(Date.now() - GRACE_WINDOW_MS - 60_000);
  }

  function withinGraceDate(): Date {
    return new Date(Date.now() - 5 * 60_000);
  }

  it("branch 1: unassigned todo issue past grace window creates no_live_path_unowned recovery action", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const issueId = await createIssue(companyId, prefix, "todo", null, {
      updatedAt: pastGraceDate(),
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.noLivePathUnowned).toBe(1);
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action).toMatchObject({
      kind: "no_live_path_unowned",
      ownerType: "board",
      status: "active",
      cause: "no_live_path_unowned",
      fingerprint: `no_live_path_unowned:${companyId}:${issueId}`,
      nextAction: "Assign an owner agent or record an intentional manual resolution.",
      wakePolicy: null,
      monitorPolicy: null,
      maxAttempts: null,
    });
    expect(action?.evidence).toMatchObject({
      identifier: expect.any(String),
      status: "todo",
      msSinceUpdate: expect.any(Number),
    });

    const [activity] = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.no_live_path_unowned_escalated"),
        ),
      );
    expect(activity).toMatchObject({
      actorType: "system",
      actorId: "issue_graph_liveness_no_live_path_unowned",
      entityType: "issue",
      entityId: issueId,
    });
    expect(activity?.details).toMatchObject({
      source: "recovery.reconcile_no_live_path_unowned",
      fingerprint: `no_live_path_unowned:${companyId}:${issueId}`,
    });

    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("branch 1: unassigned in_progress issue past grace window creates no_live_path_unowned recovery action", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const issueId = await createIssue(companyId, prefix, "in_progress", null, {
      updatedAt: pastGraceDate(),
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.noLivePathUnowned).toBe(1);
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action).toMatchObject({
      kind: "no_live_path_unowned",
      ownerType: "board",
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("branch 2: in_review issue with executionPolicy.stages but null executionState past grace window creates review_stage_unarmed recovery action", async () => {
    const { companyId, managerId, coderId, prefix } = await seedCompany();
    const stageId = randomUUID();
    const issueId = await createIssue(companyId, prefix, "in_review", coderId, {
      updatedAt: pastGraceDate(),
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [
              { id: randomUUID(), type: "agent", agentId: managerId, userId: null },
            ],
          },
        ],
      },
      executionState: null,
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.reviewStageUnarmed).toBe(1);
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action).toMatchObject({
      kind: "review_stage_unarmed",
      ownerType: "board",
      status: "active",
      cause: "review_stage_unarmed",
      fingerprint: `review_stage_unarmed:${companyId}:${issueId}`,
      nextAction:
        "Re-arm the execution review stage by setting the current participant and state, or record an intentional manual resolution.",
      wakePolicy: null,
      monitorPolicy: null,
      maxAttempts: null,
    });

    const [activity] = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.review_stage_unarmed_escalated"),
        ),
      );
    expect(activity).toMatchObject({
      actorType: "system",
      actorId: "issue_graph_liveness_review_stage_unarmed",
      entityType: "issue",
      entityId: issueId,
    });
    expect(activity?.details).toMatchObject({
      source: "recovery.reconcile_review_stage_unarmed",
      fingerprint: `review_stage_unarmed:${companyId}:${issueId}`,
    });

    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("branch 3: non-in_review issue with paused assignee past grace window creates no_live_path_owner_unavailable recovery action", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const pausedAgentId = await seedPausedAgent(companyId, managerId);
    const issueId = await createIssue(companyId, prefix, "in_progress", pausedAgentId, {
      updatedAt: pastGraceDate(),
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.noLivePathOwnerUnavailable).toBe(1);
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action).toMatchObject({
      kind: "no_live_path_owner_unavailable",
      ownerType: "board",
      status: "active",
      cause: "no_live_path_owner_unavailable",
      fingerprint: `no_live_path_owner_unavailable:${companyId}:${issueId}`,
      nextAction:
        "Restore a live execution path, reactivate or replace the assignee, or record an intentional manual resolution.",
      wakePolicy: null,
      monitorPolicy: null,
      maxAttempts: null,
    });
    expect(action?.evidence).toMatchObject({
      identifier: expect.any(String),
      status: "in_progress",
      agentId: pausedAgentId,
      msSinceUpdate: expect.any(Number),
    });
    expect(action?.previousOwnerAgentId).toBe(pausedAgentId);

    const [activity] = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.no_live_path_owner_unavailable_escalated"),
        ),
      );
    expect(activity).toMatchObject({
      actorType: "system",
      actorId: "issue_graph_liveness_no_live_path_owner_unavailable",
      entityType: "issue",
      entityId: issueId,
    });
    expect(activity?.details).toMatchObject({
      source: "recovery.reconcile_no_live_path_owner_unavailable",
      fingerprint: `no_live_path_owner_unavailable:${companyId}:${issueId}`,
    });

    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("branch 3: non-in_review issue with terminated assignee past grace window creates no_live_path_owner_unavailable recovery action", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const terminatedAgentId = await seedTerminatedAgent(companyId, managerId);
    const issueId = await createIssue(companyId, prefix, "in_progress", terminatedAgentId, {
      updatedAt: pastGraceDate(),
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.noLivePathOwnerUnavailable).toBe(1);
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action).toMatchObject({
      kind: "no_live_path_owner_unavailable",
      ownerType: "board",
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("dedup: second sweep over same no_live_path_unowned state creates no duplicate action", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const issueId = await createIssue(companyId, prefix, "todo", null, {
      updatedAt: pastGraceDate(),
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const firstResult = await recovery.reconcileStrandedAssignedIssues();
    expect(firstResult.noLivePathUnowned).toBe(1);

    const secondResult = await recovery.reconcileStrandedAssignedIssues();
    expect(secondResult.noLivePathUnowned).toBe(0);
    expect(secondResult.skipped).toBe(1);

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("no_live_path_unowned");
  });

  it("dedup: second sweep over same review_stage_unarmed state creates no duplicate action", async () => {
    const { companyId, managerId, coderId, prefix } = await seedCompany();
    const stageId = randomUUID();
    const issueId = await createIssue(companyId, prefix, "in_review", coderId, {
      updatedAt: pastGraceDate(),
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [
              { id: randomUUID(), type: "agent", agentId: managerId, userId: null },
            ],
          },
        ],
      },
      executionState: null,
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const firstResult = await recovery.reconcileStrandedAssignedIssues();
    expect(firstResult.reviewStageUnarmed).toBe(1);

    const secondResult = await recovery.reconcileStrandedAssignedIssues();
    expect(secondResult.reviewStageUnarmed).toBe(0);

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1);
  });

  it("dedup: second sweep over same no_live_path_owner_unavailable state creates no duplicate action", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const pausedAgentId = await seedPausedAgent(companyId, managerId);
    const issueId = await createIssue(companyId, prefix, "in_progress", pausedAgentId, {
      updatedAt: pastGraceDate(),
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const firstResult = await recovery.reconcileStrandedAssignedIssues();
    expect(firstResult.noLivePathOwnerUnavailable).toBe(1);

    const secondResult = await recovery.reconcileStrandedAssignedIssues();
    expect(secondResult.noLivePathOwnerUnavailable).toBe(0);

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1);
  });

  it("no status write occurs on no_live_path_unowned path", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const issueId = await createIssue(companyId, prefix, "todo", null, {
      updatedAt: pastGraceDate(),
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    await recovery.reconcileStrandedAssignedIssues();

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("todo");
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("no status write occurs on review_stage_unarmed path", async () => {
    const { companyId, managerId, coderId, prefix } = await seedCompany();
    const stageId = randomUUID();
    const issueId = await createIssue(companyId, prefix, "in_review", coderId, {
      updatedAt: pastGraceDate(),
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [
              { id: randomUUID(), type: "agent", agentId: managerId, userId: null },
            ],
          },
        ],
      },
      executionState: null,
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    await recovery.reconcileStrandedAssignedIssues();

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("in_review");
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("no status write occurs on no_live_path_owner_unavailable path", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const pausedAgentId = await seedPausedAgent(companyId, managerId);
    const issueId = await createIssue(companyId, prefix, "in_progress", pausedAgentId, {
      updatedAt: pastGraceDate(),
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    await recovery.reconcileStrandedAssignedIssues();

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("in_progress");
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("issue inside grace window is not escalated for no_live_path_unowned", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const issueId = await createIssue(companyId, prefix, "todo", null, {
      updatedAt: withinGraceDate(),
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.noLivePathUnowned).toBe(0);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("same issue past grace window is escalated for no_live_path_unowned", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const issueId = await createIssue(companyId, prefix, "todo", null, {
      updatedAt: pastGraceDate(),
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.noLivePathUnowned).toBe(1);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1);
  });

  it("issue inside grace window is not escalated for review_stage_unarmed", async () => {
    const { companyId, managerId, coderId, prefix } = await seedCompany();
    const stageId = randomUUID();
    const issueId = await createIssue(companyId, prefix, "in_review", coderId, {
      updatedAt: withinGraceDate(),
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [
              { id: randomUUID(), type: "agent", agentId: managerId, userId: null },
            ],
          },
        ],
      },
      executionState: null,
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.reviewStageUnarmed).toBe(0);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(0);
  });

  it("issue inside grace window is not escalated for no_live_path_owner_unavailable", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const pausedAgentId = await seedPausedAgent(companyId, managerId);
    const issueId = await createIssue(companyId, prefix, "in_progress", pausedAgentId, {
      updatedAt: withinGraceDate(),
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.noLivePathOwnerUnavailable).toBe(0);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(0);
  });

  it("widened candidate filter admits unassigned todo issues; user-assigned issues are out of scope", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const userId = randomUUID();
    const issueId = await createIssue(companyId, prefix, "todo", null, {
      updatedAt: pastGraceDate(),
    });
    await db.update(issues).set({ assigneeUserId: userId }).where(eq(issues.id, issueId));

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.noLivePathUnowned).toBe(0);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(0);
  });

  it("backlog status is not a candidate", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const issueId = await createIssue(companyId, prefix, "in_progress", null, {
      updatedAt: pastGraceDate(),
    });
    await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, issueId));

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.noLivePathUnowned).toBe(0);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(0);
  });

  it("suppression: live execution path prevents review_stage_unarmed escalation (branch 2 is after suppression checks)", async () => {
    const { companyId, managerId, coderId, prefix } = await seedCompany();
    const stageId = randomUUID();
    const issueId = await createIssue(companyId, prefix, "in_review", coderId, {
      updatedAt: pastGraceDate(),
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [
              { id: randomUUID(), type: "agent", agentId: managerId, userId: null },
            ],
          },
        ],
      },
      executionState: null,
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.reviewStageUnarmed).toBe(0);
    expect(result.skipped).toBe(1);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(0);
  });

  it("suppression: pending wake interaction prevents review_stage_unarmed escalation (branch 2 is after suppression checks)", async () => {
    const { companyId, managerId, coderId, prefix } = await seedCompany();
    const stageId = randomUUID();
    const issueId = await createIssue(companyId, prefix, "in_review", coderId, {
      updatedAt: pastGraceDate(),
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [
              { id: randomUUID(), type: "agent", agentId: managerId, userId: null },
            ],
          },
        ],
      },
      executionState: null,
    });
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: {},
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.reviewStageUnarmed).toBe(0);
    expect(result.skipped).toBe(1);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(0);
  });
});
