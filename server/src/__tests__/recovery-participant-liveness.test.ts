import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
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
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import {
  REVIEW_PARTICIPANT_LIVE_WINDOW_MS,
  participantRanSince,
} from "../services/recovery/participant-liveness.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres participant-liveness tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const GRACE_WINDOW_MS = 15 * 60 * 1000;

describeEmbeddedPostgres("recovery review-participant liveness (SUP-22272)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-participant-liveness-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
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
    const prefix = `RL${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
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

  async function createIssue(
    companyId: string,
    prefix: string,
    status: "in_progress" | "in_review" | "done" | "cancelled",
    assigneeAgentId: string | null,
    opts: {
      issueNumber?: number;
      updatedAt?: Date;
      executionPolicy?: Record<string, unknown>;
      executionState?: Record<string, unknown> | null;
    } = {},
  ) {
    const issueId = randomUUID();
    const issueNumber = opts.issueNumber ?? 1;
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

  function hoursAgo(hours: number): Date {
    return new Date(Date.now() - hours * 60 * 60 * 1000);
  }

  /**
   * A terminal succeeded run for the agent. Terminal on purpose: it must not
   * register as an active execution path (hasActiveExecutionPath), so the
   * sweep reaches the detectors and the liveness guard itself is what
   * suppresses the mint.
   */
  async function seedParticipantRun(
    companyId: string,
    agentId: string,
    startedAt: Date,
    issueId?: string,
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "succeeded",
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 60_000),
      ...(issueId ? { contextSnapshot: { issueId } } : {}),
    });
    return runId;
  }

  function armedReviewStageFixture(
    stageId: string,
    participantId: string,
    participantAgentId: string,
    pendingSince: Date,
  ) {
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
        pendingSince: pendingSince.toISOString(),
      },
    };
  }

  // -- helper semantics --

  it("participantRanSince: a run newer than sinceMs counts (agent-scoped, any issue)", async () => {
    const { companyId, managerId, coderId } = await seedCompany();
    // Run belongs to coder on an unrelated issue; manager has none.
    await seedParticipantRun(companyId, coderId, hoursAgo(2));
    expect(
      await participantRanSince(db, companyId, coderId, Date.now() - 8 * 60 * 60 * 1000, REVIEW_PARTICIPANT_LIVE_WINDOW_MS),
    ).toBe(true);
    expect(
      await participantRanSince(db, companyId, managerId, Date.now() - 8 * 60 * 60 * 1000, REVIEW_PARTICIPANT_LIVE_WINDOW_MS),
    ).toBe(false);
  });

  it("participantRanSince: a run older than the window does not count (suppress-with-expiry)", async () => {
    const { companyId, managerId } = await seedCompany();
    await seedParticipantRun(companyId, managerId, hoursAgo(7));
    // sinceMs far in the past -> threshold is now - 6h; the 7h-old run is older.
    expect(
      await participantRanSince(db, companyId, managerId, Date.now() - 48 * 60 * 60 * 1000, REVIEW_PARTICIPANT_LIVE_WINDOW_MS),
    ).toBe(false);
  });

  it("participantRanSince: a run inside the window but before sinceMs does not count", async () => {
    const { companyId, managerId } = await seedCompany();
    await seedParticipantRun(companyId, managerId, hoursAgo(2));
    // sinceMs = 30min ago wins over the 6h window; the 2h-old run predates it.
    expect(
      await participantRanSince(db, companyId, managerId, Date.now() - 30 * 60 * 1000, REVIEW_PARTICIPANT_LIVE_WINDOW_MS),
    ).toBe(false);
  });

  // -- armed-review detector (non-in_review card) --

  it("armed detector suppresses the mint when the participant has run since the stage armed (within the window)", async () => {
    const { companyId, managerId, coderId, prefix } = await seedCompany();
    const stageId = randomUUID();
    const participantId = randomUUID();
    const fixture = armedReviewStageFixture(stageId, participantId, managerId, hoursAgo(8));
    const issueId = await createIssue(companyId, prefix, "in_progress", coderId, {
      updatedAt: pastGraceDate(),
      ...fixture,
    });
    // Participant ran 2h ago: after pendingSince (8h ago) and inside the 6h window.
    await seedParticipantRun(companyId, managerId, hoursAgo(2));

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.reviewStageArmedStranded).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("armed detector still mints the identical fingerprint once the participant's run is outside the window (expiry)", async () => {
    const { companyId, managerId, coderId, prefix } = await seedCompany();
    const stageId = randomUUID();
    const participantId = randomUUID();
    const fixture = armedReviewStageFixture(stageId, participantId, managerId, hoursAgo(8));
    const issueId = await createIssue(companyId, prefix, "in_progress", coderId, {
      updatedAt: pastGraceDate(),
      ...fixture,
    });
    // Participant's newest run is 7h old: past the 6h window, so the mint is unchanged.
    await seedParticipantRun(companyId, managerId, hoursAgo(7));

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.reviewStageArmedStranded).toBe(1);
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action).toMatchObject({
      kind: "review_stage_unarmed",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "review_stage_armed_stranded",
      status: "active",
      fingerprint: `review_stage_armed_stranded:${companyId}:${issueId}:${stageId}:${managerId}`,
    });
  });

  it("armed detector still mints when the participant's run predates pendingSince even inside the window", async () => {
    const { companyId, managerId, coderId, prefix } = await seedCompany();
    const stageId = randomUUID();
    const participantId = randomUUID();
    // Stage armed 30min ago (past the 15min grace).
    const fixture = armedReviewStageFixture(stageId, participantId, managerId, new Date(Date.now() - 30 * 60 * 1000));
    const issueId = await createIssue(companyId, prefix, "in_progress", coderId, {
      updatedAt: pastGraceDate(),
      ...fixture,
    });
    // Run 2h ago is inside the 6h window but BEFORE pendingSince: the participant
    // has not run since the stage armed, so this is a genuine wedge.
    await seedParticipantRun(companyId, managerId, hoursAgo(2));

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.reviewStageArmedStranded).toBe(1);
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action).toMatchObject({
      cause: "review_stage_armed_stranded",
      fingerprint: `review_stage_armed_stranded:${companyId}:${issueId}:${stageId}:${managerId}`,
    });
  });

  // -- in_review detector (no pending participant pointer) --

  function reviewPolicyFixture(stageId: string, participantId: string, participantAgentId: string) {
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
      // executionState null: the card lost its pending participant pointer, the
      // exact shape the in_review unarmed detector exists for. Delivery makes
      // the review participant the assignee, so the recovery target is the
      // assignee.
      executionState: null,
    };
  }

  it("in_review detector suppresses the board mint while the assignee (review participant) has run recently", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const stageId = randomUUID();
    const participantId = randomUUID();
    const issueId = await createIssue(companyId, prefix, "in_review", managerId, {
      updatedAt: pastGraceDate(),
      ...reviewPolicyFixture(stageId, participantId, managerId),
    });
    // Terminal run 5min ago: newer than updatedAt and inside the window, but not
    // an active execution path — only the liveness guard explains the skip.
    await seedParticipantRun(companyId, managerId, new Date(Date.now() - 5 * 60 * 1000), issueId);

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.reviewStageUnarmed).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("in_review detector mints unchanged once the assignee's run is outside the window", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const stageId = randomUUID();
    const participantId = randomUUID();
    const issueId = await createIssue(companyId, prefix, "in_review", managerId, {
      updatedAt: pastGraceDate(),
      ...reviewPolicyFixture(stageId, participantId, managerId),
    });
    // Run 7h ago: outside the 6h window, and not active. The board mint is unchanged.
    await seedParticipantRun(companyId, managerId, hoursAgo(7), issueId);

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
      ownerAgentId: null,
      cause: "review_stage_unarmed",
      status: "active",
      fingerprint: `review_stage_unarmed:${companyId}:${issueId}`,
    });
  });

  // -- stale-wake sweep attempt accounting (SUP-22273) --

  function minutesAgo(minutes: number): Date {
    return new Date(Date.now() - minutes * 60_000);
  }

  async function insertSweepAction(input: {
    companyId: string;
    sourceIssueId: string;
    kind: string;
    cause: string;
    ownerType: "agent" | "board";
    ownerAgentId: string | null;
    previousOwnerAgentId: string | null;
    attemptCount: number;
    lastAttemptAt: Date;
    updatedAt?: Date;
    wakePolicy: Record<string, unknown> | null;
  }) {
    const [row] = await db
      .insert(issueRecoveryActions)
      .values({
        id: randomUUID(),
        companyId: input.companyId,
        sourceIssueId: input.sourceIssueId,
        recoveryIssueId: null,
        kind: input.kind,
        status: "active",
        ownerType: input.ownerType,
        ownerAgentId: input.ownerAgentId,
        ownerUserId: null,
        previousOwnerAgentId: input.previousOwnerAgentId,
        returnOwnerAgentId: null,
        cause: input.cause,
        fingerprint: `${input.kind}:${input.sourceIssueId}`,
        evidence: {},
        nextAction: "Restore a live execution path.",
        wakePolicy: input.wakePolicy,
        monitorPolicy: null,
        attemptCount: input.attemptCount,
        maxAttempts: null,
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

  it("sweep holds a stale stranded_assigned_issue while its owner ran after lastAttemptAt (no burn, no wake)", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const issueId = await createIssue(companyId, prefix, "in_progress", coderId);
    const lastAttemptAt = minutesAgo(30);
    const action = await insertSweepAction({
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      cause: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: coderId,
      previousOwnerAgentId: null,
      attemptCount: 2,
      // Past the 2x backoff window so the sweep would re-fire without the hold.
      lastAttemptAt,
      wakePolicy: { type: "wake_owner" },
    });
    // Owner ran 5min ago: after lastAttemptAt and inside the 6h window.
    await seedParticipantRun(companyId, coderId, minutesAgo(5));

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

    expect(result.checked).toBe(1);
    expect(result.skippedOwnerLive).toBe(1);
    expect(result.reFired).toBe(0);
    expect(result.maxAttemptsReached).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const [updated] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(updated.attemptCount).toBe(2);
    expect(updated.lastAttemptAt?.toISOString()).toBe(lastAttemptAt.toISOString());
    expect(updated.status).toBe("active");
  });

  it("sweep resumes counted recovery after the live-owner hold deadline", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const issueId = await createIssue(companyId, prefix, "in_progress", coderId);
    const lastAttemptAt = hoursAgo(13);
    const action = await insertSweepAction({
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      cause: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: coderId,
      previousOwnerAgentId: null,
      attemptCount: 2,
      lastAttemptAt,
      updatedAt: lastAttemptAt,
      wakePolicy: { type: "wake_owner" },
    });
    await seedParticipantRun(companyId, coderId, minutesAgo(5), issueId);

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

    expect(result.checked).toBe(1);
    expect(result.skippedOwnerLive).toBe(0);
    expect(result.reFired).toBe(1);
    expect(result.maxAttemptsReached).toBe(0);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);

    const [updated] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(updated.attemptCount).toBe(3);
    expect(updated.lastAttemptAt?.getTime()).toBeGreaterThan(lastAttemptAt.getTime());
  });

  it("sweep holds at the attempt ceiling instead of escalating while the owner is live (review_stage_unarmed, agent-owned)", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const issueId = await createIssue(companyId, prefix, "in_progress", managerId);
    const action = await insertSweepAction({
      companyId,
      sourceIssueId: issueId,
      kind: "review_stage_unarmed",
      cause: "review_stage_unarmed",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: null,
      attemptCount: 5,
      lastAttemptAt: minutesAgo(10),
      wakePolicy: { type: "wake_owner" },
    });
    await seedParticipantRun(companyId, managerId, minutesAgo(5));

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

    // The exact incident shape (SUP-21921): a live reviewer's card at 5/5 must
    // not walk to the board.
    expect(result.skippedOwnerLive).toBe(1);
    expect(result.maxAttemptsReached).toBe(0);
    expect(result.reFired).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const [updated] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(updated.status).toBe("active");
    expect(updated.outcome).toBeNull();
    expect(updated.maxAttempts).toBeNull();

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments.some((c) => (c.body ?? "").includes("exhausted its attempt ceiling"))).toBe(false);
  });

  it("sweep escalates at the ceiling after the live-owner hold deadline", async () => {
    const { companyId, managerId, prefix } = await seedCompany();
    const issueId = await createIssue(companyId, prefix, "in_progress", managerId);
    const lastAttemptAt = hoursAgo(13);
    const action = await insertSweepAction({
      companyId,
      sourceIssueId: issueId,
      kind: "review_stage_unarmed",
      cause: "review_stage_unarmed",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: null,
      attemptCount: 5,
      lastAttemptAt,
      updatedAt: lastAttemptAt,
      wakePolicy: { type: "wake_owner" },
    });
    await seedParticipantRun(companyId, managerId, minutesAgo(5), issueId);

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

    expect(result.skippedOwnerLive).toBe(0);
    expect(result.maxAttemptsReached).toBe(1);
    expect(result.reFired).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const [updated] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(updated.status).toBe("escalated");
    expect(updated.outcome).toBe("exhausted");
    expect(updated.maxAttempts).toBe(5);
  });

  it("sweep holds a board-owned review_stage_unarmed at the ceiling while the pending participant (previousOwnerAgentId) is live", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const issueId = await createIssue(companyId, prefix, "in_progress", coderId);
    const action = await insertSweepAction({
      companyId,
      sourceIssueId: issueId,
      kind: "review_stage_unarmed",
      cause: "review_stage_unarmed",
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      attemptCount: 5,
      lastAttemptAt: minutesAgo(10),
      wakePolicy: null,
    });
    // The pending participant the board row was minted for is live.
    await seedParticipantRun(companyId, coderId, minutesAgo(5));

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

    // Without the hold the exhaustion check (which precedes the non-wakeable
    // board checks) escalates this row to the board immediately.
    expect(result.skippedOwnerLive).toBe(1);
    expect(result.maxAttemptsReached).toBe(0);

    const [updated] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(updated.status).toBe("active");
    expect(updated.outcome).toBeNull();
  });

  it("keeps a live-owner re-mint's reserved attempt across repeated stale sweeps", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const remintedAt = new Date();
      vi.setSystemTime(new Date(remintedAt.getTime() - 2 * 60 * 60_000));
      const { companyId, coderId, prefix } = await seedCompany();
      const issueId = await createIssue(companyId, prefix, "in_progress", coderId);
      const svc = issueRecoveryActionService(db);
      const fingerprint = `stranded_assigned_issue:${companyId}:${issueId}`;
      const input = {
        companyId,
        sourceIssueId: issueId,
        kind: "stranded_assigned_issue" as const,
        ownerType: "agent" as const,
        ownerAgentId: coderId,
        cause: "stranded_assigned_issue",
        fingerprint,
        nextAction: "Restore a live execution path.",
        wakePolicy: { type: "wake_owner" as const },
      };
      const predecessor = await svc.upsertSourceScoped(input);
      await db
        .update(issueRecoveryActions)
        .set({ attemptCount: 5 })
        .where(eq(issueRecoveryActions.id, predecessor.id));
      await svc.resolveActiveForIssue({
        companyId,
        sourceIssueId: issueId,
        kind: "stranded_assigned_issue",
        fingerprint,
        status: "resolved",
        outcome: "false_positive",
        resolutionNote: "Cycle resolved.",
      });

      vi.setSystemTime(remintedAt);
      await seedParticipantRun(companyId, coderId, minutesAgo(5), issueId);
      const successor = await svc.upsertSourceScoped(input);
      expect(successor.attemptCount).toBe(4);
      expect(successor.status).toBe("active");

      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });
      const results = [];
      for (let sweep = 0; sweep < 2; sweep += 1) {
        vi.setSystemTime(new Date(remintedAt.getTime() + (sweep + 1) * 81 * 60_000));
        results.push(await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 }));
      }
      expect(results.map((result) => ({
        checked: result.checked,
        skippedOwnerLive: result.skippedOwnerLive,
        reFired: result.reFired,
        maxAttemptsReached: result.maxAttemptsReached,
      }))).toEqual([
        { checked: 1, skippedOwnerLive: 1, reFired: 0, maxAttemptsReached: 0 },
        { checked: 1, skippedOwnerLive: 1, reFired: 0, maxAttemptsReached: 0 },
      ]);

      const [updated] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, successor.id));
      expect(updated.status).toBe("active");
      expect(updated.outcome).toBeNull();
      expect(updated.attemptCount).toBe(4);
      expect(
        updated.lastAttemptAt ? new Date(updated.lastAttemptAt).toISOString() : null,
      ).toBe(successor.lastAttemptAt ? new Date(successor.lastAttemptAt).toISOString() : null);
      expect(enqueueWakeup).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles a terminal source before holding its live owner", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const doneIssueId = await createIssue(companyId, prefix, "done", coderId);
    const belowCeilingAction = await insertSweepAction({
      companyId,
      sourceIssueId: doneIssueId,
      kind: "stranded_assigned_issue",
      cause: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: coderId,
      previousOwnerAgentId: null,
      attemptCount: 2,
      lastAttemptAt: minutesAgo(30),
      wakePolicy: { type: "wake_owner" },
    });
    const cancelledIssueId = await createIssue(companyId, prefix, "cancelled", coderId, {
      issueNumber: 2,
    });
    const ceilingAction = await insertSweepAction({
      companyId,
      sourceIssueId: cancelledIssueId,
      kind: "stranded_assigned_issue",
      cause: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: coderId,
      previousOwnerAgentId: null,
      attemptCount: 5,
      lastAttemptAt: minutesAgo(20),
      wakePolicy: { type: "wake_owner" },
    });
    await seedParticipantRun(companyId, coderId, minutesAgo(5), doneIssueId);

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

    expect(result.checked).toBe(2);
    expect(result.skippedTerminalSource).toBe(1);
    expect(result.skippedOwnerLive).toBe(0);
    expect(result.reFired).toBe(0);
    expect(result.maxAttemptsReached).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        inArray(issueRecoveryActions.id, [belowCeilingAction.id, ceilingAction.id]),
      );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: belowCeilingAction.id,
          status: "active",
          attemptCount: 2,
        }),
        expect.objectContaining({
          id: ceilingAction.id,
          status: "escalated",
          outcome: "exhausted",
          attemptCount: 5,
        }),
      ]),
    );
  });

  it("expiry: once the owner's run is outside the window the sweep re-fires and burns the attempt as before", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const issueId = await createIssue(companyId, prefix, "in_progress", coderId);
    const action = await insertSweepAction({
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      cause: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: coderId,
      previousOwnerAgentId: null,
      attemptCount: 2,
      lastAttemptAt: minutesAgo(30),
      wakePolicy: { type: "wake_owner" },
    });
    // 7h old: outside the 6h participant live window. Also the issue's latest
    // run for the wake payload.
    await seedParticipantRun(companyId, coderId, hoursAgo(7), issueId);

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

    expect(result.skippedOwnerLive).toBe(0);
    expect(result.reFired).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);

    const [updated] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(updated.attemptCount).toBe(3);
  });

  it("expiry at the ceiling: an idle owner still escalates exactly as before", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const issueId = await createIssue(companyId, prefix, "in_progress", coderId);
    const action = await insertSweepAction({
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      cause: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: coderId,
      previousOwnerAgentId: null,
      attemptCount: 5,
      lastAttemptAt: minutesAgo(10),
      wakePolicy: { type: "wake_owner" },
    });
    await seedParticipantRun(companyId, coderId, hoursAgo(7), issueId);

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

    expect(result.skippedOwnerLive).toBe(0);
    expect(result.maxAttemptsReached).toBe(1);
    expect(result.reFired).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const [updated] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(updated.status).toBe("escalated");
    expect(updated.outcome).toBe("exhausted");
    expect(updated.maxAttempts).toBe(5);
  });

  it("kind scope: a live owner on an out-of-scope kind still burns attempts and re-fires", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const issueId = await createIssue(companyId, prefix, "in_progress", coderId);
    const action = await insertSweepAction({
      companyId,
      sourceIssueId: issueId,
      kind: "missing_disposition",
      cause: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: coderId,
      previousOwnerAgentId: null,
      attemptCount: 1,
      lastAttemptAt: minutesAgo(10),
      wakePolicy: { type: "wake_owner" },
    });
    // Owner live — but the kind is not in the hold set, so accounting is
    // untouched by SUP-22273.
    await seedParticipantRun(companyId, coderId, minutesAgo(5), issueId);

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

    expect(result.skippedOwnerLive).toBe(0);
    expect(result.reFired).toBe(1);

    const [updated] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(updated.attemptCount).toBe(2);
  });
});
