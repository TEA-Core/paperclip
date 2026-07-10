import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

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
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

type TestActor = {
  type?: "board" | "agent" | "user" | "none";
  userId?: string;
  companyIds?: string[];
  source?: string;
  isInstanceAdmin?: boolean;
  companyId?: string;
  role?: string;
  agentId?: string;
};

async function createApp(actorOverrides: TestActor = {}) {
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
      ...actorOverrides,
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

  it("requires tasks:assign to create an issue with returnAssigneeAgentId in policy", async () => {
    const assigneeAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const policy = normalizeIssueExecutionPolicy({
      returnAssigneeAgentId: assigneeAgentId,
      stages: [{
        type: "review",
        participants: [{ type: "agent", agentId: reviewerAgentId }],
      }],
    })!;

    mockIssueService.create.mockResolvedValue({
      id: randomUUID(),
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      title: "Policy issue",
    } as any);

    const res = await request(await createApp({ source: "oauth", userId: "external-user" }))
      .post("/api/companies/company-1/issues")
      .send({ title: "Policy issue", executionPolicy: policy });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Missing permission: tasks:assign" });
  });

  it("requires tasks:assign to create a child issue with returnAssigneeAgentId in policy", async () => {
    const assigneeAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();
    const policy = normalizeIssueExecutionPolicy({
      returnAssigneeAgentId: assigneeAgentId,
      stages: [{
        type: "approval",
        participants: [{ type: "agent", agentId: reviewerAgentId }],
      }],
    })!;

    mockIssueService.getById.mockResolvedValue({ id: parentId, companyId: "company-1" });
    mockIssueService.createChild.mockResolvedValue({
      issue: {
        id: childId,
        companyId: "company-1",
        status: "todo",
      } as any,
      parentBlockerAdded: false,
    });

    const res = await request(await createApp({ source: "oauth", userId: "external-user" }))
      .post(`/api/issues/${parentId}/children`)
      .send({ title: "Child policy issue", executionPolicy: policy });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Missing permission: tasks:assign" });
  });

  it("requires tasks:assign to set returnAssigneeAgentId via issue update", async () => {
    const issueId = randomUUID();
    const returnAssigneeAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const issue = {
      id: issueId,
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-42",
      title: "Execution policy edit",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, executionPolicy: { returnAssigneeAgentId, stages: [] } } as any);

    const policy = normalizeIssueExecutionPolicy({
      returnAssigneeAgentId,
      stages: [{
        type: "review",
        participants: [{ type: "agent", agentId: reviewerAgentId }],
      }],
    })!;

    const res = await request(await createApp({ source: "oauth", userId: "external-user" }))
      .patch(`/api/issues/${issueId}`)
      .send({ executionPolicy: policy });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Missing permission: tasks:assign" });
  });
});
