import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";
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
    status: "in_progress" | "in_review",
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
});
