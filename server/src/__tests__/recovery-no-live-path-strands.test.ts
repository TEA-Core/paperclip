import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueLabels,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
  labels,
} from "@paperclipai/db";
import { INTENTIONALLY_OWNERLESS_LABEL } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres no-live-path strand tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const GRACE_WINDOW_MS = 15 * 60 * 1000;

describeEmbeddedPostgres("recovery no-live-path strands", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-no-live-path-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRecoveryActions);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issueLabels);
    await db.delete(labels);
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

  async function seedCompanyWithIssue() {
    const { companyId, managerId, coderId, prefix } = await seedCompany();
    const sourceIssueId = randomUUID();
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
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    return { companyId, managerId, coderId, prefix, sourceIssueId, sourceIssue };
  }

  function createApp(
    actor: any = { type: "board", source: "local_implicit" },
    opts: Parameters<typeof issueRoutes>[2] = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, opts));
    app.use(errorHandler);
    return app;
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

  // -- Base tests --

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

  it("unowned issue with intentionally_ownerless label is not escalated for no_live_path_unowned", async () => {
    const { companyId, prefix } = await seedCompany();
    const labelId = randomUUID();
    await db.insert(labels).values({
      id: labelId,
      companyId,
      name: INTENTIONALLY_OWNERLESS_LABEL,
      color: "#000000",
    });
    const issueId = await createIssue(companyId, prefix, "todo", null, {
      updatedAt: pastGraceDate(),
    });
    await db.insert(issueLabels).values({
      issueId,
      labelId,
      companyId,
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.noLivePathUnowned).toBe(0);
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action).toBeUndefined();
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("unowned issue with intentionally_ownerless label clears an existing active no_live_path_unowned action", async () => {
    const { companyId, prefix } = await seedCompany();
    const labelId = randomUUID();
    await db.insert(labels).values({
      id: labelId,
      companyId,
      name: INTENTIONALLY_OWNERLESS_LABEL,
      color: "#000000",
    });
    const issueId = await createIssue(companyId, prefix, "todo", null, {
      updatedAt: pastGraceDate(),
    });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "no_live_path_unowned",
      status: "active",
      ownerType: "board",
      cause: "no_live_path_unowned",
      fingerprint: `no_live_path_unowned:${companyId}:${issueId}`,
      evidence: { identifier: `${prefix}-1`, status: "todo", msSinceUpdate: 1000000 },
      nextAction: "Assign an owner agent or record an intentional manual resolution.",
      attemptCount: 1,
    });
    await db.insert(issueLabels).values({
      issueId,
      labelId,
      companyId,
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.noLivePathUnowned).toBe(0);
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action).toMatchObject({
      kind: "no_live_path_unowned",
      status: "resolved",
      outcome: "false_positive",
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

  // -- SUP-15788: armed review stage stranded on a non-in_review card --

  function armedReviewStageFixture(stageId: string, participantId: string, participantAgentId: string) {
    return {
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [
              { id: participantId, type: "agent", agentId: participantAgentId, userId: null },
            ],
          },
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { id: participantId, type: "agent", agentId: participantAgentId, userId: null },
        returnAssignee: null,
        lastDecisionId: null,
        lastDecisionOutcome: null,
        completedStageIds: [],
        pendingSince: pastGraceDate().toISOString(),
      },
    };
  }

  it("mints a participant-owned review_stage_armed_stranded action when a pending review stage is armed on an in_progress card", async () => {
    const { companyId, managerId, coderId, prefix } = await seedCompany();
    const stageId = randomUUID();
    const participantId = randomUUID();
    const fixture = armedReviewStageFixture(stageId, participantId, managerId);
    const issueId = await createIssue(companyId, prefix, "in_progress", coderId, {
      updatedAt: pastGraceDate(),
      ...fixture,
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.reviewStageArmedStranded).toBe(1);
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action).toMatchObject({
      kind: "review_stage_armed_stranded",
      ownerType: "agent",
      ownerAgentId: managerId,
      ownerUserId: null,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: managerId,
      status: "active",
      cause: "review_stage_armed_stranded",
      fingerprint: `review_stage_armed_stranded:${companyId}:${issueId}`,
      wakePolicy: null,
      monitorPolicy: null,
      maxAttempts: null,
    });
    expect(action?.nextAction).toContain("Re-record the execution review stage verdict");
    expect(action?.evidence).toMatchObject({
      identifier: `${prefix}-1`,
      status: "in_progress",
      currentStageId: stageId,
      currentStageType: "review",
      participantType: "agent",
      participantAgentId: managerId,
      participantUserId: null,
    });

    const [activity] = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.review_stage_armed_stranded_escalated"),
        ),
      );
    expect(activity).toMatchObject({
      actorType: "system",
      actorId: "issue_graph_liveness_review_stage_armed_stranded",
      entityType: "issue",
      entityId: issueId,
    });
    expect(activity?.details).toMatchObject({
      source: "recovery.reconcile_review_stage_armed_stranded",
      fingerprint: `review_stage_armed_stranded:${companyId}:${issueId}`,
    });

    // Detection must not touch the stage: no re-arm, no reassign, no status write.
    const [reloaded] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(reloaded?.status).toBe("in_progress");
    expect(reloaded?.assigneeAgentId).toBe(coderId);
    expect(reloaded?.executionState).toMatchObject({
      status: "pending",
      currentStageId: stageId,
      currentParticipant: { type: "agent", agentId: managerId, userId: null },
    });

    // Minting does not wake; the stale-wake sweep owns that edge.
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("wakes the current participant from the minted review_stage_armed_stranded action", async () => {
    const { companyId, managerId, coderId, prefix } = await seedCompany();
    const stageId = randomUUID();
    const participantId = randomUUID();
    const fixture = armedReviewStageFixture(stageId, participantId, managerId);
    const issueId = await createIssue(companyId, prefix, "in_progress", coderId, {
      updatedAt: pastGraceDate(),
      ...fixture,
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    await recovery.reconcileStrandedAssignedIssues();
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));

    const sweep = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 0 });

    expect(sweep.reFired).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(
      managerId,
      expect.objectContaining({
        reason: "source_scoped_recovery_action",
        idempotencyKey: `source_scoped_recovery_action:${action?.id}:2`,
        payload: expect.objectContaining({
          issueId,
          recoveryActionId: action?.id,
          recoveryCause: "review_stage_armed_stranded",
        }),
      }),
    );
  });

  it("does not duplicate the review_stage_armed_stranded action or activity on a second sweep", async () => {
    const { companyId, managerId, coderId, prefix } = await seedCompany();
    const stageId = randomUUID();
    const participantId = randomUUID();
    const fixture = armedReviewStageFixture(stageId, participantId, managerId);
    const issueId = await createIssue(companyId, prefix, "in_progress", coderId, {
      updatedAt: pastGraceDate(),
      ...fixture,
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    await recovery.reconcileStrandedAssignedIssues();
    const second = await recovery.reconcileStrandedAssignedIssues();

    expect(second.reviewStageArmedStranded).toBe(0);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1);
    const activities = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.review_stage_armed_stranded_escalated"),
        ),
      );
    expect(activities).toHaveLength(1);

    // The participant-owned action is not auto-resolved as a "restored durable path":
    // the active-action reconciler only repairs board-owned or bounded-wake actions.
    const reconcile = await recovery.reconcileActiveRecoveryActions();
    expect(reconcile.resolved).toBe(0);
    const [stillActive] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(stillActive?.status).toBe("active");
  });

  it("does not escalate an armed review stage on a non-in_review card inside the grace window", async () => {
    const { companyId, managerId, coderId, prefix } = await seedCompany();
    const stageId = randomUUID();
    const participantId = randomUUID();
    const fixture = armedReviewStageFixture(stageId, participantId, managerId);
    const issueId = await createIssue(companyId, prefix, "in_progress", coderId, {
      updatedAt: withinGraceDate(),
      ...fixture,
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.reviewStageArmedStranded).toBe(0);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(0);
  });

  it("does not mint review_stage_armed_stranded for an in_review card carrying the same armed stage", async () => {
    const { companyId, managerId, coderId, prefix } = await seedCompany();
    const stageId = randomUUID();
    const participantId = randomUUID();
    const fixture = armedReviewStageFixture(stageId, participantId, managerId);
    const issueId = await createIssue(companyId, prefix, "in_review", coderId, {
      updatedAt: pastGraceDate(),
      ...fixture,
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.reviewStageArmedStranded).toBe(0);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions.some((action) => action.kind === "review_stage_armed_stranded")).toBe(false);
  });

  it("leaves a pending stage on a user participant alone (a deliberate human wait, not a wedged agent)", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const stageId = randomUUID();
    const issueId = await createIssue(companyId, prefix, "in_progress", coderId, {
      updatedAt: pastGraceDate(),
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: stageId,
            type: "approval",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "user", userId: "local-board", agentId: null }],
          },
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "approval",
        currentParticipant: { id: randomUUID(), type: "user", userId: "local-board", agentId: null },
        returnAssignee: null,
        lastDecisionId: null,
        lastDecisionOutcome: null,
        completedStageIds: [],
        pendingSince: pastGraceDate().toISOString(),
      },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.reviewStageArmedStranded).toBe(0);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions.some((action) => action.kind === "review_stage_armed_stranded")).toBe(false);
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

  // -- SUP-11327 tests (Defects A, B, C) --

  it("retires a no_live_path_owner_unavailable action on read projection when the source issue is in_progress with an agent owner", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompanyWithIssue();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
       kind: "no_live_path_owner_unavailable",
       ownerType: "board",
       ownerAgentId: null,
       cause: "no_live_path_owner_unavailable",
       fingerprint: "no-live-path:retire-on-read",
      evidence: { status: "in_progress", agentId: coderId, identifier: `${companyId.slice(0, 8)}-1` },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "board_escalation", reason: "no_invokable_recovery_owner" },
    });

    const app = createApp();
    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);

    expect(detail.body).toMatchObject({
      id: sourceIssueId,
      status: "in_progress",
      assigneeAgentId: coderId,
      activeRecoveryAction: null,
    });

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
    });
    expect(actionRow?.resolvedAt).toBeTruthy();
  });

  it("does not cancel a no_live_path_owner_unavailable action on read projection when the source issue is todo with a non-invokable (paused) agent owner", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const pausedAgentId = await seedPausedAgent(companyId, managerId);
    const issueId = await createIssue(companyId, prefix, "todo", pausedAgentId, {
      updatedAt: pastGraceDate(),
    });

    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId: issueId,
      kind: "no_live_path_owner_unavailable",
      ownerType: "board",
      ownerAgentId: null,
      cause: "no_live_path_owner_unavailable",
      fingerprint: `no-live-path:paused-todo-read:${issueId}`,
      evidence: { status: "todo", agentId: pausedAgentId, identifier: `${prefix}-1` },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "board_escalation", reason: "no_invokable_recovery_owner" },
    });

    const app = createApp();
    await request(app).get(`/api/issues/${issueId}`).expect(200);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
    });
    expect(actionRow?.resolvedAt).toBeNull();
  });

  it("converges rather than oscillating on repeated reads of a no_live_path_owner_unavailable action for a todo issue with a non-invokable agent", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const pausedAgentId = await seedPausedAgent(companyId, managerId);
    const issueId = await createIssue(companyId, prefix, "todo", pausedAgentId, {
      updatedAt: pastGraceDate(),
    });

    const recoveryActionSvc = issueRecoveryActionService(db);
    await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId: issueId,
      kind: "no_live_path_owner_unavailable",
      ownerType: "board",
      ownerAgentId: null,
      cause: "no_live_path_owner_unavailable",
      fingerprint: `no-live-path:oscillation-test:${issueId}`,
      evidence: { status: "todo", agentId: pausedAgentId, identifier: `${prefix}-1` },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "board_escalation", reason: "no_invokable_recovery_owner" },
    });

    const app = createApp();
    for (let i = 0; i < 5; i++) {
      await request(app).get(`/api/issues/${issueId}`).expect(200);
    }

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      status: "active",
      kind: "no_live_path_owner_unavailable",
    });
    expect(actions[0]?.resolvedAt).toBeNull();
  });

  it("does not open a no_live_path_owner_unavailable action when the issue has a future monitorNextCheckAt and a parseable executionPolicy.monitor", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompanyWithIssue();
    const now = new Date("2026-08-07T00:00:00.000Z");
    const monitorNextCheckAt = new Date("2026-08-07T09:00:00.000Z");

    await db
      .update(issues)
      .set({
        status: "in_progress",
        assigneeAgentId: coderId,
        monitorNextCheckAt,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          monitor: {
            kind: "external_service",
            serviceName: "deployment health",
            nextCheckAt: monitorNextCheckAt.toISOString(),
            scheduledBy: "assignee",
            recoveryPolicy: "wake_owner",
            maxAttempts: 3,
            notes: "Wait for deployment health monitor.",
          },
        },
      })
      .where(eq(issues.id, sourceIssueId));

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "running",
      startedAt: now,
      contextSnapshot: { issueId: sourceIssueId },
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.skipped).toBe(1);
    expect(result.escalated).toBe(0);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("carries the invokability block reason in a newly opened no_live_path_owner_unavailable action evidence", async () => {
    const { companyId, coderId, sourceIssue } = await seedCompanyWithIssue();

    await db
      .update(agents)
      .set({ status: "paused" })
      .where(eq(agents.id, coderId));

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const latestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { issueId: sourceIssue.id, retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    const updated = await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun,
      comment: "Automatic continuation recovery failed.",
      agentInvokability: {
        invokable: false,
        reason: "paused",
        message: "Agent is not invokable in its current state",
        details: { agentId: coderId, agentStatus: "paused" },
        invalidOrgChain: false,
      },
    });

    expect(updated).toMatchObject({ status: "blocked" });
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(action).toMatchObject({
      kind: "stranded_assigned_issue",
      cause: "stranded_assigned_issue",
      status: "active",
    });
    expect(action?.evidence).toMatchObject({
      agentInvokable: false,
      agentInvokabilityReason: "paused",
    });
    expect(action?.evidence?.agentInvokabilityMessage).toBeTruthy();
  });

  it("carries the invokability block reason in a sweep-created no_live_path_owner_unavailable action evidence", async () => {
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
      cause: "no_live_path_owner_unavailable",
      status: "active",
    });
    expect(action?.evidence).toMatchObject({
      agentInvokable: false,
      agentInvokabilityReason: "paused",
    });
    expect(action?.evidence?.agentInvokabilityMessage).toBeTruthy();
  });
});
