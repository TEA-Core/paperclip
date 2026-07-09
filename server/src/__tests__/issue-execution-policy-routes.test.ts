import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  listForIssue: vi.fn(async () => []),
  create: vi.fn(),
  acceptInteraction: vi.fn(),
  rejectInteraction: vi.fn(),
  answerQuestions: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

async function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => ({
      canUser: vi.fn(async () => false),
      hasPermission: vi.fn(async () => false),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
    }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => ({}),
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
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

async function createApp(actorOverride?: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actorOverride ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  const mockTx = {
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  } as any;
  const mockDb = {
    transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(mockTx)),
  } as any;
  app.use("/api", issueRoutes(mockDb, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue execution policy routes", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    await registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it("does not auto-start execution review when reviewers are added to an already in_review issue", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-999",
      title: "Execution policy edit",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        executionPolicy: policy,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBeUndefined();
    expect(updatePatch.assigneeAgentId).toBeUndefined();
    expect(updatePatch.assigneeUserId).toBeUndefined();
    expect(updatePatch.executionState).toBeUndefined();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("preserves returnAssigneeAgentId through normalization on create", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
      returnAssigneeAgentId: "44444444-4444-4444-4444-444444444444",
    })!;
    mockIssueService.create.mockImplementation(async (_companyId: string, data: Record<string, unknown>) => ({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-999",
      title: "Execution policy create test",
      executionPolicy: data.executionPolicy as Record<string, unknown>,
      executionState: null,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Return assignee test",
        executionPolicy: {
          stages: [
            {
              type: "review",
              participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
            },
          ],
          returnAssigneeAgentId: "44444444-4444-4444-4444-444444444444",
        },
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        executionPolicy: expect.objectContaining({
          returnAssigneeAgentId: "44444444-4444-4444-4444-444444444444",
        }) as unknown,
      }),
    );
  });

  it("preserves returnAssigneeAgentId through normalization on update", async () => {
    const existingPolicy = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-998",
      title: "Policy update test",
      executionPolicy: existingPolicy,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        executionPolicy: {
          stages: [
            {
              type: "review",
              participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
            },
          ],
          returnAssigneeAgentId: "55555555-5555-5555-5555-555555555555",
        },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        executionPolicy: expect.objectContaining({
          returnAssigneeAgentId: "55555555-5555-5555-5555-555555555555",
        }) as unknown,
      }),
    );
  });

  it("routes changes_requested bounce to configured returnAssigneeAgentId via live PATCH path", async () => {
    const coderAgentId = "66666666-6666-4666-8666-666666666666";
    const qaAgentId = "33333333-3333-4333-8333-333333333333";
    const leAgentId = "77777777-7777-4777-8777-777777777777";

    const policyWithReturn = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          type: "review",
          participants: [{ type: "agent", agentId: qaAgentId }],
        },
      ],
      returnAssigneeAgentId: leAgentId,
    })!;

    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: qaAgentId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-997",
      title: "Bounce to configured return assignee",
      executionPolicy: policyWithReturn,
      executionState: {
        status: "pending",
        currentStageId: "22222222-2222-4222-8222-222222222222",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
        returnAssignee: { type: "agent", agentId: coderAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "Needs fixes" });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: qaAgentId,
      companyId: "company-1",
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_progress", comment: "Needs fixes" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_progress",
        assigneeAgentId: leAgentId,
        executionState: expect.objectContaining({
          status: "changes_requested",
          lastDecisionOutcome: "changes_requested",
        }) as unknown,
      }),
      expect.anything(),
    );
  });
});
