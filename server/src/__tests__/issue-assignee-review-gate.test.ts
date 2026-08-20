import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  activityLog,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  issueComments,
  issueInboxArchives,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";
import {
  assertAssigneeWriteDoesNotSelfSatisfyReviewStage,
  findSelfSatisfyingReviewStage,
} from "../services/issue-assignee-review-gate.js";
import { recoveryService } from "../services/recovery/service.js";

const GATE_STAGE_ID = "11111111-1111-4111-8111-111111111111";
const ASSIGNEE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "board-user";

function policyWithStages(stages: unknown[]) {
  return { mode: "normal", commentRequired: true, stages };
}

function incompleteState(overrides: Record<string, unknown> = {}) {
  return {
    status: "pending",
    currentStageId: GATE_STAGE_ID,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: ASSIGNEE_ID, userId: null },
    returnAssignee: null,
    reviewRequest: null,
    completedStageIds: [],
    skippedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    ...overrides,
  };
}

describe("findSelfSatisfyingReviewStage (SUP-13526)", () => {
  it("flags an incoming assignee who is the sole participant of an incomplete review stage", () => {
    const finding = findSelfSatisfyingReviewStage({
      executionPolicy: policyWithStages([
        {
          id: GATE_STAGE_ID,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: "44444444-4444-4444-8444-444444444444", type: "agent", agentId: ASSIGNEE_ID }],
        },
      ]),
      executionState: incompleteState(),
      incomingAssigneeAgentId: ASSIGNEE_ID,
    });
    expect(finding).toMatchObject({
      assigneeAgentId: ASSIGNEE_ID,
      participantsExcludingAssignee: 0,
      approvalsNeeded: 1,
    });
    expect(finding?.stageId).toBe(GATE_STAGE_ID);
  });

  it("flags a stage whose approvalsNeeded exceeds the participants that can clear it without the assignee", () => {
    const finding = findSelfSatisfyingReviewStage({
      executionPolicy: policyWithStages([
        {
          id: GATE_STAGE_ID,
          type: "review",
          approvalsNeeded: 3,
          participants: [
            { id: "44444444-4444-4444-8444-444444444444", type: "agent", agentId: ASSIGNEE_ID },
            { id: "55555555-5555-4555-8555-555555555555", type: "agent", agentId: OTHER_AGENT_ID },
            { id: "66666666-6666-4666-8666-666666666666", type: "user", userId: USER_ID },
          ],
        },
      ]),
      executionState: incompleteState(),
      incomingAssigneeAgentId: ASSIGNEE_ID,
    });
    expect(finding).toMatchObject({
      assigneeAgentId: ASSIGNEE_ID,
      participantsExcludingAssignee: 2,
      approvalsNeeded: 3,
    });
    expect(finding?.stageId).toBe(GATE_STAGE_ID);
  });

  it("passes when other participants can satisfy approvalsNeeded", () => {
    const finding = findSelfSatisfyingReviewStage({
      executionPolicy: policyWithStages([
        {
          id: GATE_STAGE_ID,
          type: "review",
          approvalsNeeded: 2,
          participants: [
            { id: "44444444-4444-4444-8444-444444444444", type: "agent", agentId: ASSIGNEE_ID },
            { id: "55555555-5555-4555-8555-555555555555", type: "agent", agentId: OTHER_AGENT_ID },
            { id: "66666666-6666-4666-8666-666666666666", type: "user", userId: USER_ID },
          ],
        },
      ]),
      executionState: incompleteState(),
      incomingAssigneeAgentId: ASSIGNEE_ID,
    });
    expect(finding).toBeNull();
  });

  it("passes when the stage is completed or skipped", () => {
    for (const stateOverride of [{ completedStageIds: [GATE_STAGE_ID] }, { skippedStageIds: [GATE_STAGE_ID] }]) {
      const finding = findSelfSatisfyingReviewStage({
        executionPolicy: policyWithStages([
          {
            id: GATE_STAGE_ID,
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: "44444444-4444-4444-8444-444444444444", type: "agent", agentId: ASSIGNEE_ID }],
          },
        ]),
        executionState: incompleteState(stateOverride),
        incomingAssigneeAgentId: ASSIGNEE_ID,
      });
      expect(finding).toBeNull();
    }
  });

  it("passes when the incoming assignee is not a participant", () => {
    const finding = findSelfSatisfyingReviewStage({
      executionPolicy: policyWithStages([
        {
          id: GATE_STAGE_ID,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: "55555555-5555-4555-8555-555555555555", type: "agent", agentId: OTHER_AGENT_ID }],
        },
      ]),
      executionState: incompleteState(),
      incomingAssigneeAgentId: ASSIGNEE_ID,
    });
    expect(finding).toBeNull();
  });

  it("passes when there is no execution policy or the assignee is unassigned", () => {
    expect(
      findSelfSatisfyingReviewStage({
        executionPolicy: null,
        executionState: incompleteState(),
        incomingAssigneeAgentId: ASSIGNEE_ID,
      }),
    ).toBeNull();
    expect(
      findSelfSatisfyingReviewStage({
        executionPolicy: policyWithStages([
          {
            id: GATE_STAGE_ID,
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: "44444444-4444-4444-8444-444444444444", type: "agent", agentId: ASSIGNEE_ID }],
          },
        ]),
        executionState: incompleteState(),
        incomingAssigneeAgentId: null,
      }),
    ).toBeNull();
  });

  it("is lenient toward malformed stored policies so a bad row cannot wedge reassignment", () => {
    const finding = findSelfSatisfyingReviewStage({
      executionPolicy: { mode: "bogus", stages: "not-an-array" },
      executionState: { status: "not-a-status" },
      incomingAssigneeAgentId: ASSIGNEE_ID,
    });
    expect(finding).toBeNull();
    const junkStages = findSelfSatisfyingReviewStage({
      executionPolicy: policyWithStages([{ type: "review" }, "junk", null]),
      executionState: incompleteState(),
      incomingAssigneeAgentId: ASSIGNEE_ID,
    });
    expect(junkStages).toBeNull();
  });
});

describe("assertAssigneeWriteDoesNotSelfSatisfyReviewStage (SUP-13526)", () => {
  it("throws 422 naming the offending stage when the write would self-satisfy", () => {
    const error = (() => {
      try {
        assertAssigneeWriteDoesNotSelfSatisfyReviewStage({
          executionPolicy: policyWithStages([
            {
              id: GATE_STAGE_ID,
              type: "review",
              approvalsNeeded: 1,
              participants: [{ id: "44444444-4444-4444-8444-444444444444", type: "agent", agentId: ASSIGNEE_ID }],
            },
          ]),
          executionState: incompleteState(),
          incomingAssigneeAgentId: ASSIGNEE_ID,
        });
        return null;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).not.toBeNull();
    expect((error as { status: number }).status).toBe(422);
    expect((error as { message: string }).message).toContain(GATE_STAGE_ID);
    expect((error as { message: string }).message).toContain("self-satisfiable");
    expect((error as { details: Record<string, unknown> }).details).toMatchObject({
      guard: "assignee_review_gate",
      issueStageId: GATE_STAGE_ID,
      assigneeAgentId: ASSIGNEE_ID,
      participantsExcludingAssignee: 0,
      approvalsNeeded: 1,
    });
  });

  it("is a no-op when the stage stays clearable without the assignee", () => {
    expect(() =>
      assertAssigneeWriteDoesNotSelfSatisfyReviewStage({
        executionPolicy: policyWithStages([
          {
            id: GATE_STAGE_ID,
            type: "review",
            approvalsNeeded: 1,
            participants: [
              { id: "44444444-4444-4444-8444-444444444444", type: "agent", agentId: ASSIGNEE_ID },
              { id: "55555555-5555-4555-8555-555555555555", type: "agent", agentId: OTHER_AGENT_ID },
            ],
          },
        ]),
        executionState: incompleteState(),
        incomingAssigneeAgentId: ASSIGNEE_ID,
      }),
    ).not.toThrow();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("recovery reassignment self-satisfiable review stage guard (SUP-13526)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-assignee-review-gate-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(environments);
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(input: { secondParticipantAgent?: boolean } = {}) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const sourceIssueId = randomUUID();
    const secondParticipantAgentId = randomUUID();
    const prefix = `GATE${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Review Gate Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    const agentRows: Record<string, unknown>[] = [
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
    ];
    if (input.secondParticipantAgent) {
      agentRows.push({
        id: secondParticipantAgentId,
        companyId,
        name: "Second Reviewer",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    await db.insert(agents).values(agentRows as any);
    const participants = input.secondParticipantAgent
      ? [
          { id: randomUUID(), type: "agent", agentId: managerId, userId: null },
          { id: randomUUID(), type: "agent", agentId: secondParticipantAgentId, userId: null },
        ]
      : [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }];
    const stageId = GATE_STAGE_ID;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Guarded review issue",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants,
          },
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        skippedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    return { companyId, managerId, coderId, sourceIssueId, sourceIssue: sourceIssue!, stageId };
  }

  function makeLatestRun(companyId: string, agentId: string) {
    return {
      id: randomUUID(),
      agentId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
      companyId,
    } as const;
  }

  it("refuses a recovery reassignment that would make an incomplete review stage self-satisfiable and still blocks the issue", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const updated = await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_review",
      latestRun: makeLatestRun(companyId, managerId),
      comment: "Automatic continuation recovery failed.",
      recoveryOwnerAgentId: managerId,
    });

    expect(updated).not.toBeNull();
    const [afterEscalate] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterEscalate?.status).toBe("blocked");
    expect(afterEscalate?.assigneeAgentId).toBe(coderId);
    const [action] = await db.select().from(issueRecoveryActions).where(
      eq(issueRecoveryActions.sourceIssueId, sourceIssue.id),
    );
    expect(action?.ownerAgentId).toBe(managerId);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        refusedAssigneeAgentId: managerId,
        keptAssigneeAgentId: coderId,
      }),
      expect.stringContaining("self-satisfiable"),
    );
    warnSpy.mockRestore();
  });

  it("still reassigns when the recovery owner leaves enough other participants to satisfy the stage", async () => {
    const { companyId, managerId, sourceIssue } = await seedCompany({ secondParticipantAgent: true });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const updated = await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_review",
      latestRun: makeLatestRun(companyId, managerId),
      comment: "Automatic continuation recovery failed.",
      recoveryOwnerAgentId: managerId,
    });

    expect(updated).not.toBeNull();
    const [afterEscalate] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterEscalate?.status).toBe("blocked");
    expect(afterEscalate?.assigneeAgentId).toBe(managerId);
  });
});
