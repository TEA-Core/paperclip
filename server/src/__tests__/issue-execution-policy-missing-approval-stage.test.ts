import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";
import { reportUnexpectedRouteError } from "./helpers/report-unexpected-route-error.js";

// SUP-15878: a card with at least one non-`cancelled` child issue and no
// `approval` stage in its executionPolicy. A `done` request is refused with a
// typed 409 (done_transition_missing_approval_stage) and a durable activity row;
// an `in_review` request completes as today and records the same diagnosis.

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  findOpenAncestorCreatedByAgent: vi.fn(async () => null),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getAncestors: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  listBlockerAttention: vi.fn(),
  listReviewAttention: vi.fn(),
  listProductivityReviews: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  getActiveInboxArchiveFields: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  decide: vi.fn(),
  hasPermission: vi.fn(async () => false),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
// Non-`cancelled` child rows the child-count query resolves. Per-test override
// switches between open children, cancelled-only children, and no children.
const childRowsState = vi.hoisted(() => ({ rows: [] as unknown[] }));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  listForIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  create: vi.fn(async () => ({ id: "77777777-7777-4777-8777-777777777777" })),
  getForIssue: vi.fn(),
  acceptInteraction: vi.fn(),
  rejectInteraction: vi.fn(),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));

const mockDbSelect = vi.hoisted(() => vi.fn());
const mockTxWriteChain = vi.hoisted(() => {
  const chain = (resolves: unknown[] = []) => {
    const self: Record<string, unknown> = {
      returning: () => chain(resolves),
      where: () => chain(resolves),
      set: () => chain(resolves),
      values: () => chain(resolves),
    };
    self.then = (onF?: unknown, onR?: unknown) =>
      Promise.resolve(resolves).then(
        onF as (v: unknown) => unknown,
        onR as (r: unknown) => unknown,
      );
    self.catch = (fn: (r: unknown) => unknown) => Promise.resolve(resolves).catch(fn);
    return self;
  };
  return chain;
});
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (callback: (tx: Record<string, unknown>) => Promise<unknown>) =>
    callback({
      select: mockDbSelect,
      insert: () => mockTxWriteChain([{}]),
      update: () => mockTxWriteChain([]),
      delete: () => mockTxWriteChain([]),
    })),
}));

const mockResolveSummaryGenerationReturnAssignee = vi.hoisted(() => vi.fn(async () => null));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1" })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async (agentId: string) => ({
        id: agentId,
        companyId: "company-1",
        permissions: null,
      })),
      resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
        ambiguous: false,
        agent: {
          id: reference,
          companyId: "company-1",
          name: `agent-${reference.slice(0, 8)}`,
          status: "idle",
          orgChainHealth: { status: "healthy" },
        },
      })),
    }),
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({
      getIssueDocumentPayload: vi.fn(async () => ({})),
    }),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({
      getDefaultCompanyGoal: vi.fn(async () => null),
    }),
    heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({
      getById: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      getExperimental: vi.fn(async () => ({ enableExternalObjects: false })),
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({
      listForIssue: vi.fn(async () => []),
    }),
  }));
  vi.doMock("../services/external-objects.js", () => ({
    externalObjectService: () => ({
      syncCommentSafely: vi.fn(async () => undefined),
      syncDocumentSafely: vi.fn(async () => undefined),
      syncIssueSafely: vi.fn(async () => undefined),
      listForIssue: vi.fn(async () => []),
      getIssueSummary: vi.fn(async () => null),
      getIssueSummaries: vi.fn(async () => []),
      refreshIssueObjects: vi.fn(async () => []),
    }),
  }));
  vi.doMock("../services/summary-slots.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../services/summary-slots.js")>();
    return {
      ...actual,
      resolveSummaryGenerationReturnAssignee: mockResolveSummaryGenerationReturnAssignee,
    };
  });
}

type TestActor =
  | {
      type: "board";
      userId: string;
      companyIds: string[];
      source: "local_implicit" | "oauth";
      isInstanceAdmin: boolean;
    }
  | {
      type: "agent";
      agentId: string;
      companyId: string;
      runId: string | null;
    };

async function createApp(actor?: TestActor) {
  const { errorHandler } = await import("../middleware/index.js");
  const { issueRoutes } = await import("../routes/issues.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(reportUnexpectedRouteError("issue-execution-policy-missing-approval-stage"));
  app.use(errorHandler);
  return app;
}

const HANDOFF_AGENT_ROWS = [{
  id: "55555555-5555-4555-8555-555555555555",
  companyId: "company-1",
  agentId: "33333333-3333-4333-8333-333333333333",
  contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  permissions: null,
}];

function dbChainNode(rows: unknown[]): Record<string, unknown> {
  return {
    where: () => dbChainNode(rows),
    for: () => dbChainNode(rows),
    orderBy: () => dbChainNode([]),
    limit: () => dbChainNode([]),
    offset: () => dbChainNode([]),
    innerJoin: () => dbChainNode([]),
    leftJoin: () => dbChainNode([]),
    returning: () => dbChainNode([]),
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(onFulfilled, onRejected),
    catch: (onRejected: (reason: unknown) => unknown) => Promise.resolve(rows).catch(onRejected),
  };
}

// The SUP-15878 child-count query is the only `select` in the PATCH path whose
// projection is exactly `{ status }`; every other chain (the handoff-agent row
// the wake path depends on) keeps the hoisted default.
function isChildCountSelect(columns: unknown) {
  return !!columns
    && typeof columns === "object"
    && !Array.isArray(columns)
    && Object.keys(columns as object).length === 1
    && Object.prototype.hasOwnProperty.call(columns, "status");
}

const PARENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD_PARTICIPANT_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "55555555-5555-4555-8555-555555555555";

function reviewOnlyPolicy() {
  return normalizeIssueExecutionPolicy({
    stages: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        type: "review",
        participants: [{ type: "agent", agentId: CHILD_PARTICIPANT_ID }],
      },
    ],
  })!;
}

function reviewPlusApprovalPolicy() {
  return normalizeIssueExecutionPolicy({
    stages: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        type: "review",
        participants: [{ type: "agent", agentId: CHILD_PARTICIPANT_ID }],
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        type: "approval",
        participants: [{ type: "agent", agentId: CHILD_PARTICIPANT_ID }],
      },
    ],
  })!;
}

function parentIssue(executionPolicy: unknown) {
  return {
    id: PARENT_ID,
    companyId: "company-1",
    status: "todo",
    reviewPolicy: null,
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-1587",
    title: "Parent with open children",
    executionPolicy,
    executionState: null,
  };
}

function gapActivityInputs() {
  return mockLogActivity.mock.calls
    .map((call) => call[1] as Record<string, unknown> | undefined)
    .filter((input): input is Record<string, unknown> =>
      typeof input?.action === "string" && input.action.includes("missing_approval_stage"));
}

function gapActivityInput(action: string) {
  return gapActivityInputs().find((input) => input.action === action);
}

describe("issue execution policy missing approval stage", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/external-objects.js");
    registerModuleMocks();
    vi.clearAllMocks();
    childRowsState.rows = [];
    mockResolveSummaryGenerationReturnAssignee.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.addComment.mockImplementation(async (_id: string, body: string) => ({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      body,
    }));
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockIssueService.listBlockerAttention.mockResolvedValue(new Map());
    mockIssueService.listReviewAttention.mockResolvedValue(new Map());
    mockIssueService.listProductivityReviews.mockResolvedValue(new Map());
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.getActiveInboxArchiveFields.mockResolvedValue({});
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueThreadInteractionService.create.mockResolvedValue({ id: "77777777-7777-4777-8777-777777777777" });
    mockIssueThreadInteractionService.getForIssue.mockResolvedValue(null);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockDbSelect.mockImplementation((columns: unknown) => {
      const childCountQuery = isChildCountSelect(columns);
      return {
        from: () => ({
          where: () => dbChainNode(childCountQuery ? childRowsState.rows : HANDOFF_AGENT_ROWS),
          innerJoin: () => dbChainNode([]),
        }),
      };
    });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
      const allowed = input.actor?.type === "board" && input.actor.source === "local_implicit"
        ? true
        : input.actor?.type === "agent" && [
            "company_scope:read",
            "issue:read",
            "issue:mutate",
            "runtime:manage",
            "tasks:assign",
          ].includes(input.action ?? "")
        ? true
        : Boolean(await mockAccessService.canUser() || await mockAccessService.hasPermission());
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  function agentActor(): TestActor {
    return { type: "agent", agentId: AGENT_ID, companyId: "company-1", runId: RUN_ID };
  }

  it("refuses done on an in-scope card with the typed ladder-gap signal", async () => {
    const issue = parentIssue(reviewOnlyPolicy());
    childRowsState.rows = [{ status: "in_progress" }, { status: "cancelled" }];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("no approval stage"),
      code: "done_transition_missing_approval_stage",
      remediation: expect.stringContaining("approval"),
      details: {
        issueId: PARENT_ID,
        identifier: "PAP-1587",
        childCount: 1,
        stageTypes: ["review"],
      },
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(gapActivityInput("issue.done_missing_approval_stage_refused")).toMatchObject({
      entityId: PARENT_ID,
      issueId: PARENT_ID,
      details: {
        childCount: 1,
        stageTypes: ["review"],
        source: "done",
      },
    });
  });

  // Regression: a `done` request that does not otherwise require a transaction
  // (no execution policy at all, so no decision, no relay stop, no review
  // activity) must STILL be refused with the typed signal. Pre-fix this took the
  // non-transactional `updateIssue()` branch, skipped the delivery catchall (the
  // gap was present), and closed the card successfully with neither guard.
  it("refuses a stage-less in-scope done that otherwise needs no transaction", async () => {
    const issue = parentIssue(null);
    childRowsState.rows = [{ status: "in_progress" }];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "done_transition_missing_approval_stage",
      details: {
        issueId: PARENT_ID,
        identifier: "PAP-1587",
        childCount: 1,
        stageTypes: [],
      },
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(gapActivityInput("issue.done_missing_approval_stage_refused")).toMatchObject({
      entityId: PARENT_ID,
      issueId: PARENT_ID,
      details: {
        childCount: 1,
        stageTypes: [],
        source: "done",
      },
    });
  });

  it("refuses a done on a review-only card whose review is already completed", async () => {
    const issue = {
      ...parentIssue(reviewOnlyPolicy()),
      status: "in_review",
      executionState: {
        status: "completed",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        deliveryAuthor: null,
        reviewRequest: null,
        completedStageIds: ["11111111-1111-4111-8111-111111111111"],
        skippedStageIds: [],
        lastDecisionId: "22222222-2222-4222-8222-222222222222",
        lastDecisionOutcome: "approved",
        monitor: null,
        changesRequestedCount: 0,
      },
    };
    childRowsState.rows = [{ status: "in_progress" }];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "done_transition_missing_approval_stage",
      details: {
        issueId: PARENT_ID,
        identifier: "PAP-1587",
        childCount: 1,
        stageTypes: ["review"],
      },
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(gapActivityInput("issue.done_missing_approval_stage_refused")).toMatchObject({
      entityId: PARENT_ID,
      issueId: PARENT_ID,
      details: {
        childCount: 1,
        stageTypes: ["review"],
        source: "done",
      },
    });
  });

  it("completes an in_review transition on an in-scope card and records the signal", async () => {
    const issue = parentIssue(reviewOnlyPolicy());
    childRowsState.rows = [{ status: "in_progress" }];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      PARENT_ID,
      expect.objectContaining({
        status: "in_review",
        executionState: expect.objectContaining({
          status: "pending",
          currentParticipant: expect.objectContaining({
            type: "agent",
            agentId: CHILD_PARTICIPANT_ID,
          }),
        }),
      }),
      expect.anything(),
    );
    expect(gapActivityInput("issue.in_review_missing_approval_stage")).toMatchObject({
      entityId: PARENT_ID,
      issueId: PARENT_ID,
      details: {
        childCount: 1,
        stageTypes: ["review"],
        source: "in_review",
      },
    });
  });

  it("leaves a childless card's done transition unchanged", async () => {
    const issue = parentIssue(reviewOnlyPolicy());
    childRowsState.rows = [];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(gapActivityInputs()).toEqual([]);
  });

  it("treats cancelled-only children as childless", async () => {
    const issue = parentIssue(reviewOnlyPolicy());
    childRowsState.rows = [{ status: "cancelled" }, { status: "cancelled" }];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(gapActivityInputs()).toEqual([]);
  });

  it("does not diagnose a card whose policy already has an approval stage", async () => {
    const issue = parentIssue(reviewPlusApprovalPolicy());
    childRowsState.rows = [{ status: "in_progress" }];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      PARENT_ID,
      expect.objectContaining({ status: "in_review" }),
      expect.anything(),
    );
    expect(gapActivityInputs()).toEqual([]);
  });
});
