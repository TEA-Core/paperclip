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
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueInboxArchives,
  issueRecoveryActions,
  issues,
  pluginManagedResources,
  plugins,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";
import {
  assertAssigneeWriteDoesNotSelfSatisfyReviewStage,
  assertWikiHandoffWriteIntegrity,
  findSelfSatisfyingReviewStage,
  resolveCanonicalWikiMaintainerAgentId,
  wikiHandoffWriteWouldViolate,
} from "../services/issue-assignee-review-gate.js";
import { recoveryService } from "../services/recovery/service.js";
import { decideRecoveryReassignment } from "../services/recovery/service.js";

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

  // Board ruling 2026-10-02 (F1 server half): caller-aware. The prefix through
  // the existing parenthetical is byte-identical; the seat label and a pointer
  // to control-plane-403.md §7 follow it and travel in details. Without a refusal context (the recovery
  // service) nothing changes.
  describe("caller-aware refusal", () => {
    const stage = {
      id: GATE_STAGE_ID,
      type: "review",
      approvalsNeeded: 1,
      participants: [{ id: "44444444-4444-4444-8444-444444444444", type: "agent", agentId: ASSIGNEE_ID }],
    };
    const legacyMessage =
      `Refusing assigneeAgentId write: ${ASSIGNEE_ID} is a participant of incomplete review stage ${GATE_STAGE_ID} ` +
      "and the write would make the stage self-satisfiable, because it cannot be cleared without the assignee " +
      "approving their own work (participants excluding the assignee: 0, approvalsNeeded: 1)";
    const refuse = (refusalContext?: Parameters<typeof assertAssigneeWriteDoesNotSelfSatisfyReviewStage>[0]["refusalContext"]) => {
      try {
        assertAssigneeWriteDoesNotSelfSatisfyReviewStage({
          executionPolicy: policyWithStages([stage]),
          executionState: incompleteState({ currentParticipant: { type: "agent", agentId: OTHER_AGENT_ID, userId: null } }),
          incomingAssigneeAgentId: ASSIGNEE_ID,
          refusalContext,
        });
      } catch (thrown) {
        return thrown as { message: string; details: Record<string, unknown> };
      }
      throw new Error("expected throw");
    };

    it("gives the assignee its seat label and the pointer to control-plane-403.md §7", () => {
      const err = refuse({
        caller: { agentId: OTHER_AGENT_ID },
        issue: { assigneeAgentId: OTHER_AGENT_ID, executionState: { status: "idle" } },
      });
      expect(err.message).toBe(
        `${legacyMessage}. Your seat: assignee. This is a seat-authority refusal: see control-plane-403.md §7 for the next step.`,
      );
      expect(err.details.callerSeat).toBe("assignee");
      expect(err.details.nextAction).toBe(
        "Your seat: assignee. This is a seat-authority refusal: see control-plane-403.md §7 for the next step.",
      );
      expect(err.details).toMatchObject({ guard: "assignee_review_gate", issueStageId: GATE_STAGE_ID });
    });

    it("gives any other seat its own label and the same pointer", () => {
      const err = refuse({
        caller: { agentId: "66666666-6666-4666-8666-666666666666", viaAncestorHatch: true },
        issue: { assigneeAgentId: OTHER_AGENT_ID, executionState: null },
      });
      expect(err.details.callerSeat).toBe("ancestor-hatch");
      expect(err.details.nextAction).toBe(
        "Your seat: ancestor-hatch. This is a seat-authority refusal: see control-plane-403.md §7 for the next step.",
      );
      expect(err.message).toContain(String(err.details.nextAction));
    });

    it("without a refusal context the message is unchanged", () => {
      const err = refuse(undefined);
      expect(err.message).toBe(legacyMessage);
      expect(err.details.callerSeat).toBeUndefined();
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
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(environments);
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(pluginManagedResources);
    await db.delete(agents);
    await db.delete(plugins);
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

describe("wiki handoff write integrity (SUP-21752, pure helpers)", () => {
  const WINNING_AGENT = "11111111-1111-4111-8111-111111111111";
  const INTRUDER_AGENT = "22222222-2222-4222-8222-222222222222";
  const CANONICAL = "33333333-3333-4333-8333-333333333333";
  const STAGE_ID = "44444444-4444-4444-8444-444444444444";

  function policy(participantIds: string[]) {
    return policyWithStages([
      {
        id: STAGE_ID,
        type: "review",
        approvalsNeeded: 1,
        participants: participantIds.map((agentId) => ({
          id: randomUUID(),
          type: "agent",
          agentId,
        })),
      },
    ]);
  }

  function state(currentAgentId: string) {
    return incompleteState({
      currentStageId: STAGE_ID,
      currentParticipant: { type: "agent", agentId: currentAgentId, userId: null },
    });
  }

  it("rejects the recurrence shape: a non-canonical write on a Wiki handoff", () => {
    expect(
      wikiHandoffWriteWouldViolate({
        canonicalMaintainerAgentId: CANONICAL,
        incomingAssigneeAgentId: INTRUDER_AGENT,
        executionPolicy: policy([INTRUDER_AGENT]),
        executionState: state(INTRUDER_AGENT),
      }),
    ).toEqual({ reason: "wiki_handoff_non_canonical_assignee" });
  });

  it("rejects the d328e99a self-reassignment shape: canonical write stays, intruder write does not", () => {
    // SUP-21631 / SUP-21750 d328e99a: e9675a12 (canonical) -> 38ca3dab while
    // 38ca3dab is the sole pending review participant. The first write that
    // substitutes the assignee must already be refused.
    expect(
      wikiHandoffWriteWouldViolate({
        canonicalMaintainerAgentId: CANONICAL,
        incomingAssigneeAgentId: INTRUDER_AGENT,
        executionPolicy: policy([INTRUDER_AGENT, WINNING_AGENT]),
        executionState: state(INTRUDER_AGENT),
      }),
    ).toEqual({ reason: "wiki_handoff_non_canonical_assignee" });
  });

  it("rejects the SUP-21591 self-approvable shape: canonical assignee is the sole stage participant", () => {
    expect(
      wikiHandoffWriteWouldViolate({
        canonicalMaintainerAgentId: CANONICAL,
        incomingAssigneeAgentId: CANONICAL,
        executionPolicy: policy([CANONICAL]),
        executionState: state(CANONICAL),
      }),
    ).toEqual({ reason: "wiki_handoff_self_satisfy" });
  });

  it("allows the canonical maintainer when another participant can clear the stage", () => {
    expect(
      wikiHandoffWriteWouldViolate({
        canonicalMaintainerAgentId: CANONICAL,
        incomingAssigneeAgentId: CANONICAL,
        executionPolicy: policy([CANONICAL, INTRUDER_AGENT]),
        executionState: state(CANONICAL),
      }),
    ).toBeNull();
  });

  it("is a no-op when there is no canonical binding", () => {
    expect(
      wikiHandoffWriteWouldViolate({
        canonicalMaintainerAgentId: null,
        incomingAssigneeAgentId: INTRUDER_AGENT,
        executionPolicy: policy([INTRUDER_AGENT]),
        executionState: state(INTRUDER_AGENT),
      }),
    ).toBeNull();
  });

  it("routes a wiki-handoff refusal through decideRecoveryReassignment unchanged", () => {
    const decision = decideRecoveryReassignment({
      currentAssigneeAgentId: CANONICAL,
      recoveryOwnerAgentId: INTRUDER_AGENT,
      reviewStageSelfSatisfies: false,
      recoveryOwnerLive: true,
      wikiHandoffViolation: "wiki_handoff_non_canonical_assignee",
    });
    expect(decision).toMatchObject({
      assigneeAgentId: CANONICAL,
      refused: true,
      refusalReason: "wiki_handoff_non_canonical_assignee",
      refusedAssigneeAgentId: INTRUDER_AGENT,
      keptAssigneeAgentId: CANONICAL,
    });
  });
});

describeEmbeddedPostgres("wiki handoff canonical resolution (SUP-21752)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wiki-handoff-gate-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(environments);
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(pluginManagedResources);
    await db.delete(agents);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const CANONICAL = "33333333-3333-4333-8333-333333333333";
  const INTRUDER = "22222222-2222-4222-8222-222222222222";

  async function seedCanonicalBinding(companyId: string) {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclipai.plugin-llm-wiki",
      packageName: "@paperclipai/plugin-llm-wiki",
      version: "0.1.0",
      apiVersion: 1,
      categories: [],
      manifestJson: {} as never,
      status: "ready",
      installOrder: 1,
    });
    await db.insert(pluginManagedResources).values({
      companyId,
      pluginId,
      pluginKey: "paperclipai.plugin-llm-wiki",
      resourceKind: "agent",
      resourceKey: "wiki-maintainer",
      resourceId: CANONICAL,
      defaultsJson: {},
    });
  }

  async function seedHandoffCompany() {
    const companyId = randomUUID();
    const maintainerId = CANONICAL;
    const intruderId = INTRUDER;
    const prefix = `WIKI${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Wiki Handoff Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: maintainerId,
        companyId,
        name: "Wiki Maintainer",
        role: "knowledge-maintainer",
        status: "paused",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: intruderId,
        companyId,
        name: "coder-LE",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ] as never);
    await seedCanonicalBinding(companyId);
    return { companyId, maintainerId, intruderId, prefix };
  }

  it("resolves the canonical maintainer only for a Wiki handoff title via the managed plugin key", async () => {
    const { companyId, maintainerId } = await seedHandoffCompany();
    await expect(
      resolveCanonicalWikiMaintainerAgentId(db, companyId, {
        title: "[PPC ER] Weekly Report — handoff to Wiki Maintainer",
        description: null,
      }),
    ).resolves.toBe(maintainerId);
    await expect(
      resolveCanonicalWikiMaintainerAgentId(db, companyId, {
        title: "Ordinary issue",
        description: null,
      }),
    ).resolves.toBeNull();
  });

  it("rejects a non-canonical assignee write on a Wiki handoff (recurrence shape d1743569/0e1fe94b/0f1e8f3b)", async () => {
    const { companyId, intruderId } = await seedHandoffCompany();
    await expect(
      assertWikiHandoffWriteIntegrity({
        db,
        companyId,
        issue: {
          title: "[PPC ER] Weekly Report — 2026-10-26 — handoff to Wiki Maintainer",
          description: "Canonical wiki path wiki/projects/example/reports/2026-10-26.md",
          executionPolicy: null,
          executionState: null,
        },
        incomingAssigneeAgentId: intruderId,
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        guard: "assignee_review_gate",
        subGuard: "wiki_handoff",
        reason: "wiki_handoff_non_canonical_assignee",
        pluginKey: "paperclipai.plugin-llm-wiki",
        resourceKey: "wiki-maintainer",
      },
    });
  });

  it("rejects the d328e99a self-approvable shape even when the write targets the canonical maintainer", async () => {
    const { companyId, maintainerId } = await seedHandoffCompany();
    const stageId = GATE_STAGE_ID;
    await expect(
      assertWikiHandoffWriteIntegrity({
        db,
        companyId,
        issue: {
          title: "[PPC ER] Weekly Report — 2026-10-29 — handoff to Wiki Maintainer",
          description: null,
          executionPolicy: policyWithStages([
            {
              id: stageId,
              type: "review",
              approvalsNeeded: 1,
              participants: [{ id: randomUUID(), type: "agent", agentId: maintainerId, userId: null }],
            },
          ]),
          executionState: incompleteState({ currentStageId: stageId }),
        },
        incomingAssigneeAgentId: maintainerId,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("allows the canonical maintainer when another participant can clear the stage", async () => {
    const { companyId, maintainerId, intruderId } = await seedHandoffCompany();
    const stageId = GATE_STAGE_ID;
    await expect(
      assertWikiHandoffWriteIntegrity({
        db,
        companyId,
        issue: {
          title: "[PPC ER] Weekly Report — handoff to Wiki Maintainer",
          description: null,
          executionPolicy: policyWithStages([
            {
              id: stageId,
              type: "review",
              approvalsNeeded: 1,
              participants: [
                { id: randomUUID(), type: "agent", agentId: maintainerId, userId: null },
                { id: randomUUID(), type: "agent", agentId: intruderId, userId: null },
              ],
            },
          ]),
          executionState: incompleteState({ currentStageId: stageId }),
        },
        incomingAssigneeAgentId: maintainerId,
      }),
    ).resolves.toBeUndefined();
  });

  it("recovery keeps the canonical maintainer when the recovery owner is not canonical", async () => {
    const { companyId, maintainerId, intruderId, prefix } = await seedHandoffCompany();
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, maintainerId));
    const issueId = randomUUID();
    const stageId = GATE_STAGE_ID;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "[PPC ER] Weekly Report — handoff to Wiki Maintainer",
      description: null,
      status: "in_review",
      priority: "medium",
      assigneeAgentId: maintainerId,
      issueNumber: 7,
      identifier: `${prefix}-7`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "agent", agentId: maintainerId, userId: null }],
          },
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: maintainerId, userId: null },
        returnAssignee: { type: "agent", agentId: maintainerId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        skippedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const updated = await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue!,
      previousStatus: "in_review",
      latestRun: {
        id: randomUUID(),
        agentId: intruderId,
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
        companyId,
      } as const,
      comment: "Automatic continuation recovery failed.",
      recoveryOwnerAgentId: intruderId,
    });

    expect(updated).not.toBeNull();
    const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(after?.status).toBe("blocked");
    expect(after?.assigneeAgentId).toBe(maintainerId);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        refusedAssigneeAgentId: intruderId,
        keptAssigneeAgentId: maintainerId,
        refusalReason: "wiki_handoff_non_canonical_assignee",
      }),
      expect.stringContaining("Wiki handoff"),
    );
    warnSpy.mockRestore();
  });
});
