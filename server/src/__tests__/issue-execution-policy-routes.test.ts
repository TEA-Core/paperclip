import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
    ambiguous: false,
    agent: { id: raw, companyId: "company-1", status: "active" },
  })),
}));

const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
const returnAssigneeAgentId = "44444444-4444-4444-8444-444444444444";

function executionPolicyPayload(agentId = returnAssigneeAgentId) {
  return {
    stages: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        type: "review",
        participants: [{ type: "agent", agentId: reviewerAgentId }],
      },
    ],
    returnAssigneeAgentId: agentId,
  };
}

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => ({
      canUser: vi.fn(async () => false),
      hasPermission: vi.fn(async () => false),
    }),
    agentService: () => mockAgentService,
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
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

async function createApp() {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue execution policy routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: { id: raw, companyId: "company-1", status: "active" },
    }));
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

  it("persists returnAssigneeAgentId when executionPolicy is patched", async () => {
    const stageId = "11111111-1111-4111-8111-111111111111";
    const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
    const returnAssigneeAgentId = "44444444-4444-4444-8444-444444444444";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-998",
      title: "Policy update test",
      executionPolicy: normalizeIssueExecutionPolicy({
        stages: [
          {
            id: stageId,
            type: "review",
            participants: [{ type: "agent", agentId: reviewerAgentId }],
          },
        ],
      }),
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
          returnAssigneeAgentId,
        },
      });

    expect(res.status).toBe(200);
    expect(mockAgentService.resolveByReference).toHaveBeenCalledWith("company-1", returnAssigneeAgentId);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        executionPolicy: expect.objectContaining({
          returnAssigneeAgentId,
          stages: [
            expect.objectContaining({
              id: stageId,
              participants: [expect.objectContaining({ agentId: reviewerAgentId })],
            }),
          ],
        }) as unknown,
      }),
    );
  });

  it("updates returnAssigneeAgentId when executionPolicy is patched with a different agent", async () => {
    const oldReturnAssigneeAgentId = "44444444-4444-4444-8444-444444444444";
    const nextReturnAssigneeAgentId = "55555555-5555-4555-8555-555555555555";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-997",
      title: "Policy update test",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            type: "review",
            approvalsNeeded: 1,
            participants: [
              {
                id: "22222222-2222-4222-8222-222222222222",
                type: "agent",
                agentId: "33333333-3333-4333-8333-333333333333",
                userId: null,
              },
            ],
          },
        ],
        returnAssigneeAgentId: oldReturnAssigneeAgentId,
      },
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
          ...issue.executionPolicy,
          returnAssigneeAgentId: nextReturnAssigneeAgentId,
        },
      });

    expect(res.status).toBe(200);
    expect(mockAgentService.resolveByReference).toHaveBeenCalledWith("company-1", nextReturnAssigneeAgentId);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        executionPolicy: expect.objectContaining({
          returnAssigneeAgentId: nextReturnAssigneeAgentId,
        }) as unknown,
      }),
    );
  });

  it("clears returnAssigneeAgentId when executionPolicy is patched with null", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-996",
      title: "Policy clear test",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            type: "review",
            approvalsNeeded: 1,
            participants: [
              {
                id: "22222222-2222-4222-8222-222222222222",
                type: "agent",
                agentId: "33333333-3333-4333-8333-333333333333",
                userId: null,
              },
            ],
          },
        ],
        returnAssigneeAgentId: "44444444-4444-4444-8444-444444444444",
      },
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
          returnAssigneeAgentId: null,
        },
      });

    expect(res.status).toBe(200);
    expect(mockAgentService.resolveByReference).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        executionPolicy: expect.objectContaining({
          returnAssigneeAgentId: null,
          stages: [expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" })],
        }) as unknown,
      }),
    );
  });

  it("rejects returnAssigneeAgentId that does not resolve to a company agent", async () => {
    const missingAgentId = "55555555-5555-4555-8555-555555555555";
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-995",
      title: "Policy invalid return assignee test",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

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
          returnAssigneeAgentId: missingAgentId,
        },
      });

    expect(res.status).toBe(404);
    expect(mockAgentService.resolveByReference).toHaveBeenCalledWith("company-1", missingAgentId);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.each(["pending_approval", "terminated"] as const)(
    "rejects patch returnAssigneeAgentId for %s agents",
    async (status) => {
      mockAgentService.resolveByReference.mockResolvedValue({
        ambiguous: false,
        agent: { id: returnAssigneeAgentId, companyId: "company-1", status },
      });
      const issue = {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId: "company-1",
        status: "todo",
        assigneeAgentId: null,
        assigneeUserId: "local-board",
        createdByUserId: "local-board",
        identifier: "PAP-994",
        title: "Policy invalid return assignee status test",
        executionPolicy: null,
        executionState: null,
      };
      mockIssueService.getById.mockResolvedValue(issue);

      const res = await request(await createApp())
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({ executionPolicy: executionPolicyPayload() });

      expect(res.status).toBe(409);
      expect(mockIssueService.update).not.toHaveBeenCalled();
    },
  );

  it("validates and persists returnAssigneeAgentId when an issue is created", async () => {
    mockIssueService.create.mockImplementation(async (companyId: string, payload: Record<string, unknown>) => ({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId,
      identifier: "PAP-993",
      title: payload.title,
      executionPolicy: payload.executionPolicy,
    }));

    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Create with return assignee",
        executionPolicy: executionPolicyPayload(),
      });

    expect(res.status).toBe(201);
    expect(mockAgentService.resolveByReference).toHaveBeenCalledWith("company-1", returnAssigneeAgentId);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        executionPolicy: expect.objectContaining({ returnAssigneeAgentId }) as unknown,
      }),
    );
  });

  it("rejects create returnAssigneeAgentId for terminated agents", async () => {
    mockAgentService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      agent: { id: returnAssigneeAgentId, companyId: "company-1", status: "terminated" },
    });

    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Create with invalid return assignee",
        executionPolicy: executionPolicyPayload(),
      });

    expect(res.status).toBe(409);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("validates and persists returnAssigneeAgentId when a child issue is created", async () => {
    const parent = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-992",
      title: "Parent",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.createChild.mockImplementation(async (_parentId: string, payload: Record<string, unknown>) => ({
      issue: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        companyId: "company-1",
        identifier: "PAP-991",
        title: payload.title,
        executionPolicy: payload.executionPolicy,
      },
      parentBlockerAdded: false,
    }));

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child with return assignee",
        executionPolicy: executionPolicyPayload(),
      });

    expect(res.status).toBe(201);
    expect(mockAgentService.resolveByReference).toHaveBeenCalledWith("company-1", returnAssigneeAgentId);
    expect(mockIssueService.createChild).toHaveBeenCalledWith(
      parent.id,
      expect.objectContaining({
        executionPolicy: expect.objectContaining({ returnAssigneeAgentId }) as unknown,
      }),
    );
  });

  it("rejects child-create returnAssigneeAgentId for pending approval agents", async () => {
    mockAgentService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      agent: { id: returnAssigneeAgentId, companyId: "company-1", status: "pending_approval" },
    });
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-990",
      title: "Parent",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child with invalid return assignee",
        executionPolicy: executionPolicyPayload(),
      });

    expect(res.status).toBe(409);
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });
});
