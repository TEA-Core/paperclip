import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

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
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  for: () => ({
    then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve([{
        id: "55555555-5555-4555-8555-555555555555",
        companyId: "company-1",
        agentId: "33333333-3333-4333-8333-333333333333",
        contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        permissions: null,
      }]).then(onFulfilled, onRejected),
  }),
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{
      id: "55555555-5555-4555-8555-555555555555",
      companyId: "company-1",
      agentId: "33333333-3333-4333-8333-333333333333",
      contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      permissions: null,
    }]).then(onFulfilled, onRejected),
})));
// `innerJoin` is needed by the fork's merge-arming done-transition guard
// (`resolveLinkedPullRequestsWithState`), which runs on every done transition.
// Without it the guard throws and the route answers 500 instead of the
// authorization status under test.
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({
  where: mockDbSelectWhere,
  innerJoin: () => ({ where: () => Promise.resolve([]) }),
})));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
// Generic chainable/thenable for tx.insert/update/delete, which the
// decision-recording transaction path needs (SUP-14805 escalation mints after
// inserting an issue_execution_decisions row inside the same transaction).
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

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
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
      resolveByReference: vi.fn(async (_companyId: string, reference: string) => {
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference);
        if (isUuid) {
          const isCoder = reference.startsWith("00000000-0000-4000-8") || reference.startsWith("00000000-0000-4000-9");
          return {
            ambiguous: false,
            agent: {
              id: reference,
              companyId: "company-1",
              name: isCoder ? `coder-${reference.slice(0, 8)}` : `agent-${reference.slice(0, 8)}`,
              status: "idle",
              orgChainHealth: { status: "healthy" },
            },
          };
        }
        const isCoder = reference.toLowerCase().startsWith("coder-");
        return {
          ambiguous: false,
          agent: {
            id: reference,
            companyId: "company-1",
            name: isCoder ? reference : `agent-${reference.slice(0, 8)}`,
            status: "idle",
            orgChainHealth: { status: "healthy" },
          },
        };
      }),
    }),
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({
      getById: vi.fn(async () => null),
    }),
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
    workProductService: () => ({}),
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
}

type TestActor =
  | {
      type: "board";
      userId: string;
      companyIds: string[];
      // `oauth` is the un-elevated external caller: the same board shape, but it
      // does not carry the implicit local grant, so permission gates are enforced.
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
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
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
  app.use(errorHandler);
  return app;
}

describe("issue execution policy routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/external-objects.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.addComment.mockImplementation(async (_id: string, body: string) => ({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      body,
    }));
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueThreadInteractionService.create.mockResolvedValue({ id: "77777777-7777-4777-8777-777777777777" });
    mockIssueThreadInteractionService.getForIssue.mockResolvedValue(null);
    mockIssueThreadInteractionService.acceptInteraction.mockResolvedValue({
      interaction: null,
      createdIssues: [],
      continuationIssue: null,
    });
    mockIssueThreadInteractionService.rejectInteraction.mockResolvedValue(null);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelectFrom.mockImplementation(() => ({
      where: mockDbSelectWhere,
      // See the hoisted default above: the fork's merge-arming done-transition
      // guard joins external_object_mentions to external_objects.
      innerJoin: () => ({ where: () => Promise.resolve([]) }),
    }));
    mockDbSelectWhere.mockImplementation(() => ({
      for: () => ({
        then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve([{
            id: "55555555-5555-4555-8555-555555555555",
            companyId: "company-1",
            agentId: "33333333-3333-4333-8333-333333333333",
            contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
            permissions: null,
          }]).then(onFulfilled, onRejected),
      }),
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{
          id: "55555555-5555-4555-8555-555555555555",
          companyId: "company-1",
          agentId: "33333333-3333-4333-8333-333333333333",
          contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          permissions: null,
        }]).then(onFulfilled, onRejected),
    }));
    mockIssueService.createChild.mockResolvedValue({
      issue: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        companyId: "company-1",
        identifier: "PAP-1002",
        title: "Child issue",
      },
      parentBlockerAdded: false,
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

  it("reauthorizes a terminal verdict against the review policy held under the update lock", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      reviewPolicy: "anyone",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Concurrent policy update",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getByIdForUpdate.mockResolvedValue({
      ...issue,
      reviewPolicy: "human_only",
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      details: {
        code: "review_policy_denied",
        policy: "human_only",
      },
    });
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(mockIssueService.getByIdForUpdate).toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects an agent-authored in_review transition without a review path", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1003",
      title: "Missing review path",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid_issue_disposition");
    expect(res.body.error).toContain("request_confirmation");
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "review_path",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows an agent-authored in_review transition with a pending confirmation interaction", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
      {
        id: "11111111-1111-4111-8111-111111111111",
        kind: "request_confirmation",
        status: "pending",
        createdByAgentId: "33333333-3333-4333-8333-333333333333",
        sourceRunId: "55555555-5555-4555-8555-555555555555",
      },
    ]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({ status: "in_review" }),
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.not.objectContaining({ reviewInteractionId: expect.anything() }),
      }),
      expect.any(Array),
    );
    expect(mockLogActivity.mock.calls[0]?.[0]).toBe(mockIssueService.update.mock.calls[0]?.[2]);
  });

  it("binds an explicitly designated same-run confirmation to the review transition", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([{
      id: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
      sourceRunId: "55555555-5555-4555-8555-555555555555",
      payload: { version: 1, prompt: "Approve this review?" },
    }]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        reviewInteractionId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.not.objectContaining({ reviewInteractionId: expect.anything() }),
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          reviewInteractionId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
      expect.any(Array),
    );
  });

  it("binds a user-designated confirmation to the review transition activity", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([{
      id: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: null,
      createdByUserId: "local-board",
      sourceRunId: null,
      payload: { version: 1, prompt: "Approve this review?" },
    }]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      changes: { status: { from: "todo", to: "in_review" } },
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        reviewInteractionId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.not.objectContaining({ reviewInteractionId: expect.anything() }),
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        actorType: "user",
        actorId: "local-board",
        details: expect.objectContaining({
          reviewInteractionId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
      expect.any(Array),
    );
  });

  it("keeps a review transition and its confirmation binding in one rollback boundary", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([{
      id: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
      sourceRunId: "55555555-5555-4555-8555-555555555555",
      payload: { version: 1, prompt: "Approve this review?" },
    }]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      changes: { status: { from: "todo", to: "in_review" } },
      updatedAt: new Date(),
    }));
    mockLogActivity.mockRejectedValueOnce(new Error("activity insert failed"));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        reviewInteractionId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status).toBe(500);
    expect(mockDb.transaction).toHaveBeenCalled();
    const updateTx = mockIssueService.update.mock.calls[0]?.[2];
    const activityTx = mockLogActivity.mock.calls[0]?.[0];
    expect(activityTx).toBe(updateTx);
  });

  it("rejects a review binding to a confirmation from another run", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([{
      id: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
      sourceRunId: "44444444-4444-4444-8444-444444444444",
      payload: { version: 1, prompt: "Approve another run's request?" },
    }]);

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        reviewInteractionId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("created by this agent run"),
      details: { code: "invalid_review_interaction" },
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows an agent-authored in_review transition with a typed execution participant", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1005",
      title: "Execution participant",
      executionPolicy: null,
      executionState: null,
    };
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
        },
      ],
    })!;
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        executionState: expect.objectContaining({
          status: "pending",
          currentParticipant: expect.objectContaining({
            type: "agent",
            agentId: "44444444-4444-4444-8444-444444444444",
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it("allows an agent-authored in_review transition with a scheduled monitor", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1006",
      title: "External review monitor",
      executionPolicy: null,
      executionState: null,
      monitorAttemptCount: 0,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
      monitorNotes: null,
      monitorScheduledBy: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-12-01T12:00:00.000Z",
            scheduledBy: "assignee",
            notes: "Wait for external QA report.",
          },
        },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        monitorNextCheckAt: new Date("2026-12-01T12:00:00.000Z"),
      }),
      expect.anything(),
    );
  });

  it("rejects board-authored in_review transitions without a review path", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1007",
      title: "Board repair",
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
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid_issue_disposition");
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "review_path",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows board-authored in_review transitions with a human assignee", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1008",
      title: "Board repair with human reviewer",
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
      .send({ status: "in_review", assigneeUserId: "human-reviewer" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({ status: "in_review", assigneeUserId: "human-reviewer" }),
      expect.anything(),
    );
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        actorType: "user",
        actorId: "local-board",
        details: expect.objectContaining({ status: "in_review" }),
      }),
      expect.any(Array),
    );
    expect(mockLogActivity.mock.calls[0]?.[0]).toBe(mockIssueService.update.mock.calls[0]?.[2]);
    expect(mockIssueThreadInteractionService.listForIssue).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
  });

  it("allows board-authored in_review transitions with a pending confirmation interaction", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1009",
      title: "Board repair with pending interaction",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
      { id: "interaction-1", kind: "request_confirmation", status: "pending" },
    ]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueThreadInteractionService.listForIssue).toHaveBeenCalled();
  });

  it("allows board-authored in_review transitions with a scheduled monitor", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1010",
      title: "Board repair with scheduled monitor",
      executionPolicy: null,
      executionState: null,
      monitorAttemptCount: 0,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
      monitorNotes: null,
      monitorScheduledBy: null,
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
        status: "in_review",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-12-01T12:00:00.000Z",
            scheduledBy: "assignee",
            notes: "Wait for external QA report.",
          },
        },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        monitorNextCheckAt: new Date("2026-12-01T12:00:00.000Z"),
      }),
      expect.anything(),
    );
  });

  it("allows board-authored in_review transitions with a typed execution participant", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1011",
      title: "Board repair with execution participant",
      executionPolicy: null,
      executionState: null,
    };
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
        },
      ],
    })!;
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        executionState: expect.objectContaining({
          status: "pending",
          currentParticipant: expect.objectContaining({
            type: "agent",
            agentId: "44444444-4444-4444-8444-444444444444",
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it("allows board-authored in_review transitions with a linked pending approval", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1012",
      title: "Board repair with pending approval",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
      { id: "approval-1", status: "pending" },
    ]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueApprovalService.listApprovalsForIssue).toHaveBeenCalled();
  });

  it("rejects board-authored in_review repair updates without a review path (fork policy)", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1007",
      title: "Board repair",
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
      .send({ status: "in_review" });

    // SUP-10525: the review-path requirement is deliberately NOT gated on
    // `actorType === "agent"`. Upstream exempts a board/user actor here; under
    // fork policy a board repair that parks an issue in in_review with no review
    // path is refused for the same reason an agent's is. Inverted rather than
    // deleted so the divergence stays guarded.
    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "review_path",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows a board user to cancel an active agent review task", async () => {
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
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1008",
      title: "Active review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "cancelled",
        executionState: null,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
      expect.anything(),
    );
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("allows a board user to cancel a drifted pending agent review task", async () => {
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
      status: "blocked",
      assigneeAgentId: "44444444-4444-4444-8444-444444444444",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1009",
      title: "Drifted active review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "cancelled",
        executionState: null,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
      expect.anything(),
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBe("cancelled");
    expect(updatePatch.assigneeAgentId).toBeUndefined();
    expect(updatePatch.assigneeUserId).toBeUndefined();
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("keeps the review stage pending when a board user reassigns to an eligible participant", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [
            { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
            { type: "agent", agentId: "55555555-5555-4555-8555-555555555555" },
          ],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1010",
      title: "Reassigned review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ assigneeAgentId: "55555555-5555-4555-8555-555555555555" });

    expect(res.status).toBe(200);
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBe("in_review");
    expect(updatePatch.assigneeAgentId).toBe("55555555-5555-4555-8555-555555555555");
    expect(updatePatch.assigneeUserId).toBeNull();
    expect(updatePatch.executionState).toMatchObject({
      status: "pending",
      currentStageId: "11111111-1111-4111-8111-111111111111",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: "55555555-5555-4555-8555-555555555555" },
      returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
    });
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  function roundCapReviewIssue(overrides: Record<string, unknown> = {}, stateOverrides: Record<string, unknown> = {}) {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    return {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      responsibleUserId: "board-user",
      createdByUserId: "local-board",
      identifier: "PAP-2001",
      title: "Round-cap review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        ...stateOverrides,
      },
      ...overrides,
    };
  }

  it("mints exactly one review-escalation interaction at the round cap (SUP-14805)", async () => {
    const issue = roundCapReviewIssue({}, { changesRequestedCount: 2 });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(
      await createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "77777777-7777-4777-8777-777777777777",
      }),
    )
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_progress", comment: "Round three — still not converging" });

    expect(res.status).toBe(200);
    // The stage stays pending and the responsible human becomes the assignee.
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBe("in_review");
    expect(updatePatch.assigneeAgentId).toBeNull();
    expect(updatePatch.assigneeUserId).toBe("board-user");
    expect(updatePatch.executionState).toMatchObject({
      status: "pending",
      currentParticipant: { type: "user", userId: "board-user" },
      changesRequestedCount: 3,
    });

    // Exactly one interaction is minted, as a user-actor request_confirmation.
    expect(mockIssueThreadInteractionService.create).toHaveBeenCalledTimes(1);
    const [createIssue, createOptions, createActor] =
      mockIssueThreadInteractionService.create.mock.calls[0] as [
        unknown,
        Record<string, unknown>,
        Record<string, unknown>,
      ];
    expect(createIssue).toEqual({
      id: issue.id,
      companyId: issue.companyId,
      identifier: issue.identifier ?? null,
    });
    expect(createOptions).toMatchObject({
      kind: "request_confirmation",
      addresseeAgentId: null,
      resolverPolicy: "human_only",
      continuationPolicy: "wake_assignee",
      sourceRunId: "77777777-7777-4777-8777-777777777777",
    });
    expect(createOptions.idempotencyKey).toMatch(
      /^review-escalation:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:11111111-1111-4111-8111-111111111111:3:[a-f0-9]{16}$/,
    );
    expect(createOptions.payload).toMatchObject({
      version: 1,
      prompt: "Approve this review, or request further changes (round cap reached).",
      acceptLabel: "Approve & advance",
      rejectLabel: "Request changes",
      rejectRequiresReason: true,
      allowDeclineReason: true,
    });
    const details = (createOptions.payload as { detailsMarkdown: string }).detailsMarkdown;
    expect(details).toContain("reaching the round cap of 3");
    expect(details).toContain("> Round three — still not converging");
    expect(details).toContain("Return assignee: agent 44444444-4444-4444-8444-444444444444");
    expect(details).toContain("on issue `PAP-2001`");
    expect(details).toContain("a human send-back does not burn a round");
    // Created as the escalated human, not the reviewer agent.
    expect(createActor).toEqual({ agentId: null, userId: "board-user" });
  });

  it("mints no interaction below the round cap", async () => {
    const issue = roundCapReviewIssue({}, { changesRequestedCount: 1 });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(
      await createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "77777777-7777-4777-8777-777777777777",
      }),
    )
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_progress", comment: "Round two feedback" });

    expect(res.status).toBe(200);
    // Below the cap: hand back to the executor, no escalation, no card.
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBe("in_progress");
    expect(updatePatch.assigneeAgentId).toBe("44444444-4444-4444-8444-444444444444");
    expect(mockIssueThreadInteractionService.create).not.toHaveBeenCalled();
  });

  it("mints no second interaction when a drifted assignee re-asserts the escalated hold", async () => {
    // The stage is already escalated (participant is the responsible human, round
    // count at the cap), but the assignee drifted back to the agent reviewer.
    // Re-asserting the hold must not mint a fresh card.
    const issue = roundCapReviewIssue(
      { assigneeAgentId: "33333333-3333-4333-8333-333333333333", assigneeUserId: null },
      {
        currentParticipant: { type: "user", userId: "board-user" },
        changesRequestedCount: 3,
      },
    );
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(
      await createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "77777777-7777-4777-8777-777777777777",
      }),
    )
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ description: "Still working on the fix" });

    expect(res.status).toBe(200);
    // The hold re-asserts: the responsible human is the assignee again.
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.assigneeAgentId).toBeNull();
    expect(updatePatch.assigneeUserId).toBe("board-user");
    expect(mockIssueThreadInteractionService.create).not.toHaveBeenCalled();
  });
  it("dissolves the review when a board user reassigns an in_review task to a non-participant", async () => {
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
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1011",
      title: "Reassigned away from review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ assigneeAgentId: "55555555-5555-4555-8555-555555555555" });

    expect(res.status).toBe(200);
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBe("in_progress");
    expect(updatePatch.executionState).toBeNull();
    expect(updatePatch.assigneeAgentId).toBe("55555555-5555-4555-8555-555555555555");
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
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

  it("triggers a scheduled monitor immediately from the dedicated route", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Manual monitor trigger",
      executionPolicy: normalizeIssueExecutionPolicy({
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      }),
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/monitor/check-now")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockHeartbeatService.triggerIssueMonitor).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        actorType: "user",
        actorId: "local-board",
        agentId: null,
      }),
    );
  });

  it("lets a board user create a child issue with a scheduled monitor", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "assignee",
          },
        },
      });

    expect(res.status).toBe(201);
    const createPayload = mockIssueService.createChild.mock.calls[0]?.[1] as {
      executionPolicy: { monitor: { scheduledBy: string } };
    };
    expect(createPayload.executionPolicy.monitor.scheduledBy).toBe("board");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.monitor_scheduled",
        details: expect.objectContaining({
          scheduledBy: "board",
        }),
      }),
    );
  });

  it("rejects child monitor scheduling by a non-assignee agent even with task assignment permission", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "board",
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the assignee agent or a board user can manage issue monitors");
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("normalizes spoofed child monitor scheduledBy to the assignee actor", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "board",
            externalRef: "https://example.test/deploy?token=secret",
          },
        },
      });

    expect(res.status).toBe(201);
    const createPayload = mockIssueService.createChild.mock.calls[0]?.[1] as {
      executionPolicy: { monitor: { scheduledBy: string; externalRef: string | null } };
    };
    expect(createPayload.executionPolicy.monitor.scheduledBy).toBe("assignee");
    expect(createPayload.executionPolicy.monitor.externalRef).toBe("[redacted]");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.monitor_scheduled",
        entityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        details: expect.not.objectContaining({ externalRef: expect.anything() }),
      }),
    );
  });

  describe("returnAssigneeAgentId assignment authorization", () => {
    // The default board actor carries `local_implicit`, which bypasses the
    // permission gate. These cases need a caller that does not, so they build the
    // same board shape over an `oauth` source. The 403 bodies are matched rather
    // than compared whole because this tree's deny response also carries
    // `details.reason`, which is not what these cases are about.
    function externalActor(): TestActor {
      return {
        type: "board",
        userId: "external-user",
        companyIds: ["company-1"],
        source: "oauth",
        isInstanceAdmin: false,
      };
    }

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

      const res = await request(await createApp(externalActor()))
        .post("/api/companies/company-1/issues")
        .send({ title: "Policy issue", executionPolicy: policy });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "Missing permission: tasks:assign" });
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

      // The child route gates parent read access before it reaches the assign
      // gate, and the shared test grant only allows `issue:read` for a
      // `local_implicit` board actor. Grant every action except `tasks:assign`
      // so this case lands on the gate it is actually about.
      mockAccessService.decide.mockImplementation(async (input: { action?: string }) => {
        const allowed = input.action !== "tasks:assign";
        return {
          allowed,
          action: input.action,
          reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
          explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
        };
      });

      mockIssueService.getById.mockResolvedValue({ id: parentId, companyId: "company-1" });
      mockIssueService.createChild.mockResolvedValue({
        issue: {
          id: childId,
          companyId: "company-1",
          status: "todo",
        } as any,
        parentBlockerAdded: false,
      });

      const res = await request(await createApp(externalActor()))
        .post(`/api/issues/${parentId}/children`)
        .send({ title: "Child policy issue", executionPolicy: policy });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "Missing permission: tasks:assign" });
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

      const res = await request(await createApp(externalActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ executionPolicy: policy });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "Missing permission: tasks:assign" });
    });

    it("requires tasks:assign to change returnAssigneeAgentId via issue update", async () => {
      const issueId = randomUUID();
      const oldReturnAssigneeAgentId = randomUUID();
      const newReturnAssigneeAgentId = randomUUID();
      const reviewerAgentId = randomUUID();
      const issue = {
        id: issueId,
        companyId: "company-1",
        status: "todo",
        assigneeAgentId: null,
        assigneeUserId: null,
        createdByUserId: "local-board",
        identifier: "PAP-43",
        title: "Execution policy change",
        executionPolicy: normalizeIssueExecutionPolicy({
          returnAssigneeAgentId: oldReturnAssigneeAgentId,
          stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerAgentId }] }],
        }),
        executionState: null,
      };
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue({ ...issue, executionPolicy: { returnAssigneeAgentId: newReturnAssigneeAgentId, stages: [] } } as any);

      const policy = normalizeIssueExecutionPolicy({
        returnAssigneeAgentId: newReturnAssigneeAgentId,
        stages: [{
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        }],
      })!;

      const res = await request(await createApp(externalActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ executionPolicy: policy });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "Missing permission: tasks:assign" });
    });

    it("requires tasks:assign to clear returnAssigneeAgentId via issue update", async () => {
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
        identifier: "PAP-44",
        title: "Execution policy clear",
        executionPolicy: normalizeIssueExecutionPolicy({
          returnAssigneeAgentId,
          stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerAgentId }] }],
        }),
        executionState: null,
      };
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue({ ...issue, executionPolicy: { stages: [] } } as any);

      const policy = normalizeIssueExecutionPolicy({
        stages: [{
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        }],
      })!;

      const res = await request(await createApp(externalActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ executionPolicy: policy });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "Missing permission: tasks:assign" });
    });
  });

  describe("write-boundary close-ladder protection (SUP-13634)", () => {
    function ladderIssue(issueId: string) {
      return {
        id: issueId,
        companyId: "company-1",
        status: "in_progress",
        assigneeAgentId: null,
        assigneeUserId: null,
        createdByUserId: "local-board",
        identifier: "PAP-13634",
        title: "Close ladder protection",
        executionPolicy: normalizeIssueExecutionPolicy({
          stages: [
            {
              type: "review",
              participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
            },
            {
              type: "approval",
              participants: [{ type: "user", userId: "cto-user" }],
            },
          ],
        }),
        executionState: null,
      };
    }

    it("rejects a PATCH whose executionPolicy.stages is an empty array and leaves the stored policy untouched", async () => {
      const issueId = randomUUID();
      const issue = ladderIssue(issueId);
      const storedPolicy = issue.executionPolicy;
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue({ ...issue, executionPolicy: null } as any);

      const res = await request(await createApp())
        .patch(`/api/issues/${issueId}`)
        .send({ executionPolicy: { stages: [] } });

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: "executionPolicy.stages must not be empty" });
      expect(mockIssueService.update).not.toHaveBeenCalled();
      for (const call of mockLogActivity.mock.calls) {
        expect((call[1] as { action?: string }).action).not.toBe("issue.reviewers_updated");
        expect((call[1] as { action?: string }).action).not.toBe("issue.approvers_updated");
      }
      expect(storedPolicy).not.toBeNull();
    });

    // SUP-13925: the monitor re-arm round-trip. A monitor-only watcher stores
    // `stages: []` by design, so reading its policy, editing
    // `monitor.nextCheckAt` and writing the whole object back necessarily
    // carries an explicit empty array. That used to 422, which silently stopped
    // the ci-health daily digest from re-arming.
    function monitorOnlyIssue(issueId: string) {
      return {
        id: issueId,
        companyId: "company-1",
        status: "in_progress",
        // A monitor may only be scheduled on an agent-assigned in_progress /
        // in_review issue, so the watcher fixture carries an assignee.
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        assigneeUserId: null,
        createdByUserId: "local-board",
        identifier: "PAP-13925",
        title: "Monitor-only watcher",
        executionPolicy: normalizeIssueExecutionPolicy({
          stages: [],
          monitor: { nextCheckAt: "2026-08-25T08:00:00.000Z", notes: "ci-health digest" },
        }),
        executionState: null,
      };
    }

    it("accepts the whole-object monitor re-arm on an empty-stages issue and persists the new nextCheckAt", async () => {
      const issueId = randomUUID();
      const issue = monitorOnlyIssue(issueId);
      expect((issue.executionPolicy as { stages: unknown[] }).stages).toEqual([]);
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue(issue as any);

      const res = await request(await createApp())
        .patch(`/api/issues/${issueId}`)
        .send({
          executionPolicy: {
            mode: "normal",
            commentRequired: true,
            stages: [],
            monitor: {
              nextCheckAt: "2026-08-26T08:00:00.000Z",
              notes: "ci-health digest",
              maxAttempts: 100,
            },
          },
        });

      expect(res.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalled();
      const written = mockIssueService.update.mock.calls.at(-1)?.[1] as {
        executionPolicy?: { stages?: unknown[]; monitor?: { nextCheckAt?: string; maxAttempts?: number } };
      };
      expect(written.executionPolicy?.stages).toEqual([]);
      expect(written.executionPolicy?.monitor?.nextCheckAt).toBe("2026-08-26T08:00:00.000Z");
      expect(written.executionPolicy?.monitor?.maxAttempts).toBe(100);
    });

    it("rejects a PATCH that sets executionPolicy to null over a non-null stored policy and leaves it untouched", async () => {
      const issueId = randomUUID();
      const issue = ladderIssue(issueId);
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue({ ...issue, executionPolicy: null } as any);

      const res = await request(await createApp())
        .patch(`/api/issues/${issueId}`)
        .send({ executionPolicy: null });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("executionPolicy must not be set to null");
      expect(mockIssueService.update).not.toHaveBeenCalled();
      for (const call of mockLogActivity.mock.calls) {
        expect((call[1] as { action?: string }).action).not.toBe("issue.reviewers_updated");
        expect((call[1] as { action?: string }).action).not.toBe("issue.approvers_updated");
      }
    });

    it("still allows a full replacement policy so repaired ladders can be re-PATCHed", async () => {
      const issueId = randomUUID();
      const issue = ladderIssue(issueId);
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const replacement = normalizeIssueExecutionPolicy({
        stages: [
          {
            type: "review",
            participants: [{ type: "agent", agentId: "55555555-5555-4555-8555-555555555555" }],
          },
          {
            type: "approval",
            participants: [{ type: "user", userId: "cto-user" }],
          },
        ],
      })!;

      const res = await request(await createApp())
        .patch(`/api/issues/${issueId}`)
        .send({ executionPolicy: replacement });

      expect(res.status).toBe(200);
      const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(updatePatch.executionPolicy).toMatchObject({
        stages: [
          { type: "review", participants: [{ type: "agent", agentId: "55555555-5555-4555-8555-555555555555" }] },
          { type: "approval", participants: [{ type: "user", userId: "cto-user" }] },
        ],
      });
    });

    it("still allows an explicit null over a null stored policy (no-op)", async () => {
      const issueId = randomUUID();
      const issue = { ...ladderIssue(issueId), executionPolicy: null };
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp())
        .patch(`/api/issues/${issueId}`)
        .send({ executionPolicy: null });

      expect(res.status).toBe(200);
      const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(updatePatch.executionPolicy).toBeNull();
    });
  });

  describe("non-coder agent assignee with no execution policy", () => {
    it("allows creating a company issue with assigneeAgentId and no execution policy", async () => {
      mockIssueService.create.mockResolvedValue({
        id: randomUUID(),
        companyId: "company-1",
        status: "todo",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        assigneeUserId: null,
        title: "No policy issue",
      } as any);

      const res = await request(await createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-1",
      }))
        .post("/api/companies/company-1/issues")
        .send({ title: "No policy issue", assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

      expect(res.status).toBe(201);
      expect(mockIssueService.create).toHaveBeenCalled();
    });

    it("allows creating a company issue with assigneeUserId and no execution policy", async () => {
      mockIssueService.create.mockResolvedValue({
        id: randomUUID(),
        companyId: "company-1",
        status: "todo",
        assigneeAgentId: null,
        assigneeUserId: "user-1",
        title: "No policy issue",
      } as any);

      const res = await request(await createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-1",
      }))
        .post("/api/companies/company-1/issues")
        .send({ title: "No policy issue", assigneeUserId: "user-1" });

      expect(res.status).toBe(201);
      expect(mockIssueService.create).toHaveBeenCalled();
    });

    it("allows a non-coder agent with returnAssigneeAgentId and empty stages", async () => {
      const assigneeAgentId = randomUUID();
      const emptyPolicy = normalizeIssueExecutionPolicy({
        returnAssigneeAgentId: assigneeAgentId,
        stages: [],
      });

      expect(emptyPolicy).not.toBeNull();
      expect(emptyPolicy?.stages).toEqual([]);

      mockIssueService.create.mockResolvedValue({
        id: randomUUID(),
        companyId: "company-1",
        status: "todo",
        assigneeAgentId: assigneeAgentId,
        assigneeUserId: null,
        title: "Empty policy issue",
      } as any);

      const res = await request(await createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-1",
      }))
        .post("/api/companies/company-1/issues")
        .send({
          title: "Empty policy issue",
          assigneeAgentId: assigneeAgentId,
          executionPolicy: { returnAssigneeAgentId: assigneeAgentId, stages: [] },
        });

      expect(res.status).toBe(201);
      expect(mockIssueService.create).toHaveBeenCalled();
    });

    it("allows creating a company issue with assigneeAgentId and a valid execution policy", async () => {
      const reviewerAgentId = randomUUID();
      const policy = normalizeIssueExecutionPolicy({
        stages: [{
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        }],
      })!;

      mockIssueService.create.mockResolvedValue({
        id: randomUUID(),
        companyId: "company-1",
        status: "todo",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        assigneeUserId: null,
        title: "Valid policy issue",
      } as any);

      const res = await request(await createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-1",
      }))
        .post("/api/companies/company-1/issues")
        .send({
          title: "Valid policy issue",
          assigneeAgentId: "33333333-3333-4333-8333-333333333333",
          executionPolicy: policy,
        });

      expect(res.status).toBe(201);
      expect(mockIssueService.create).toHaveBeenCalled();
    });

    it("allows creating a child issue with assigneeAgentId and no execution policy", async () => {
      const parentId = randomUUID();
      mockIssueService.getById.mockResolvedValue({ id: parentId, companyId: "company-1" });
      mockIssueService.createChild.mockResolvedValue({
        issue: {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          companyId: "company-1",
          status: "todo",
        },
        parentBlockerAdded: false,
      });

      const res = await request(await createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-1",
      }))
        .post(`/api/issues/${parentId}/children`)
        .send({ title: "Child no policy", assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

      expect(res.status).toBe(201);
      expect(mockIssueService.createChild).toHaveBeenCalled();
    });

    it("allows creating a child issue with assigneeAgentId and a valid execution policy", async () => {
      const parentId = randomUUID();
      const reviewerAgentId = randomUUID();
      const policy = normalizeIssueExecutionPolicy({
        stages: [{
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        }],
      })!;

      mockIssueService.getById.mockResolvedValue({ id: parentId, companyId: "company-1" });
      mockIssueService.createChild.mockResolvedValue({
        issue: {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          companyId: "company-1",
          status: "todo",
        },
        parentBlockerAdded: false,
      });

      const res = await request(await createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-1",
      }))
        .post(`/api/issues/${parentId}/children`)
        .send({
          title: "Child valid policy",
          assigneeAgentId: "33333333-3333-4333-8333-333333333333",
          executionPolicy: policy,
        });

      expect(res.status).toBe(201);
      expect(mockIssueService.createChild).toHaveBeenCalled();
    });
  });

  describe("coder agent assignee requires non-empty execution policy with stages", () => {
    it("rejects creating a company issue with a coder-* agent and no execution policy (400)", async () => {
      const coderAgentId = "00000000-0000-4000-8000-000000000001";
      mockIssueService.create.mockResolvedValue({
        id: randomUUID(),
        companyId: "company-1",
        status: "todo",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        title: "No policy coder issue",
      } as any);

      const res = await request(await createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-1",
      }))
        .post("/api/companies/company-1/issues")
        .send({ title: "No policy coder issue", assigneeAgentId: coderAgentId });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("coder agent requires a non-empty execution policy");
      expect(res.body.error).toContain("deliver.sh cannot route");
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe("executionPolicy");
      expect(mockIssueService.create).not.toHaveBeenCalled();
    });

    it("rejects creating a company issue with a coder-* agent and empty execution policy stages (400)", async () => {
      const coderAgentId = "00000000-0000-4000-8000-000000000002";
      mockIssueService.create.mockResolvedValue({
        id: randomUUID(),
        companyId: "company-1",
        status: "todo",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        title: "Empty stages coder issue",
      } as any);

      const res = await request(await createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-1",
      }))
        .post("/api/companies/company-1/issues")
        .send({
          title: "Empty stages coder issue",
          assigneeAgentId: coderAgentId,
          executionPolicy: { stages: [] },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("coder agent requires a non-empty execution policy");
      expect(res.body.error).toContain("deliver.sh cannot route");
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe("executionPolicy");
      expect(mockIssueService.create).not.toHaveBeenCalled();
    });

    it("rejects creating a child issue with a coder-* agent and no execution policy (400)", async () => {
      const parentId = randomUUID();
      const coderAgentId = "00000000-0000-4000-8000-000000000003";
      mockIssueService.getById.mockResolvedValue({ id: parentId, companyId: "company-1" });
      mockIssueService.createChild.mockResolvedValue({
        issue: {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          companyId: "company-1",
          status: "todo",
        },
        parentBlockerAdded: false,
      });

      const res = await request(await createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-1",
      }))
        .post(`/api/issues/${parentId}/children`)
        .send({ title: "Child coder no policy", assigneeAgentId: coderAgentId });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("coder agent requires a non-empty execution policy");
      expect(res.body.error).toContain("deliver.sh cannot route");
      expect(mockIssueService.createChild).not.toHaveBeenCalled();
    });

    it("allows creating a company issue with a coder-* agent and a valid execution policy with stages", async () => {
      const coderAgentId = "00000000-0000-4000-8000-000000000004";
      const reviewerAgentId = randomUUID();
      const policy = normalizeIssueExecutionPolicy({
        stages: [{
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        }],
      })!;

      mockIssueService.create.mockResolvedValue({
        id: randomUUID(),
        companyId: "company-1",
        status: "todo",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        title: "Valid policy coder issue",
      } as any);

      const res = await request(await createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-1",
      }))
        .post("/api/companies/company-1/issues")
        .send({
          title: "Valid policy coder issue",
          assigneeAgentId: coderAgentId,
          executionPolicy: policy,
        });

      expect(res.status).toBe(201);
      expect(mockIssueService.create).toHaveBeenCalled();
    });

    it("rejects creating a company issue with a coder-* agent and empty stages via returnAssigneeAgentId (400)", async () => {
      const coderAgentId = "00000000-0000-4000-8000-000000000005";
      const returnAssigneeAgentId = "00000000-0000-4000-8000-000000000006";
      mockIssueService.create.mockResolvedValue({
        id: randomUUID(),
        companyId: "company-1",
        status: "todo",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        title: "Empty stages via returnAssignee",
      } as any);

      const res = await request(await createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-1",
      }))
        .post("/api/companies/company-1/issues")
        .send({
          title: "Empty stages via returnAssignee",
          assigneeAgentId: coderAgentId,
          executionPolicy: { stages: [], returnAssigneeAgentId: returnAssigneeAgentId },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("coder agent requires a non-empty execution policy");
      expect(res.body.error).toContain("deliver.sh cannot route");
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe("executionPolicy");
      expect(mockIssueService.create).not.toHaveBeenCalled();
    });

    it("rejects creating a company issue with a coder-* agent and a stage with no participants that is silently dropped (400)", async () => {
      const coderAgentId = "00000000-0000-4000-8000-000000000007";
      const returnAssigneeAgentId = "00000000-0000-4000-8000-000000000008";
      mockIssueService.create.mockResolvedValue({
        id: randomUUID(),
        companyId: "company-1",
        status: "todo",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        title: "Silent drop",
      } as any);

      const res = await request(await createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-1",
      }))
        .post("/api/companies/company-1/issues")
        .send({
          title: "Silent drop",
          assigneeAgentId: coderAgentId,
          executionPolicy: {
            returnAssigneeAgentId: returnAssigneeAgentId,
            stages: [{ type: "review", participants: [] }],
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("coder agent requires a non-empty execution policy");
      expect(res.body.error).toContain("deliver.sh cannot route");
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe("executionPolicy");
      expect(mockIssueService.create).not.toHaveBeenCalled();
    });
  });

  describe("SUP-14919: review round-cap escalation resolution records a decision and wakes the return assignee", () => {
    const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const interactionId = "interaction-escalation-1";
    const stageId = "11111111-1111-4111-8111-111111111111";
    const returnAssigneeAgentId = "44444444-4444-4444-8444-444444444444";

    function escalatedRoundCapIssue() {
      return roundCapReviewIssue(
        {
          assigneeAgentId: null,
          assigneeUserId: "board-user",
        },
        {
          changesRequestedCount: 3,
          currentParticipant: { type: "user", userId: "board-user" },
        },
      );
    }

    function pendingEscalationInteraction() {
      return {
        id: interactionId,
        companyId: "company-1",
        issueId,
        kind: "request_confirmation",
        status: "pending",
        createdByAgentId: null,
        createdByUserId: "board-user",
        addresseeAgentId: null,
        continuationPolicy: "wake_assignee",
        requestedResolverPolicy: "human_only",
        effectiveResolverPolicy: "human_only",
        sourceRunId: null,
        idempotencyKey:
          `review-escalation:${issueId}:${stageId}:3:0123456789abcdef`,
        payload: {
          version: 1,
          prompt: "Approve this review, or request further changes (round cap reached).",
        },
      };
    }

    function captureDecisionInsert() {
      let insertedDecision: Record<string, unknown> | null = null;
      mockDb.transaction.mockImplementation(
        async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => {
          await callback({
            select: mockDbSelect,
            insert: () => ({
              values: async (values: Record<string, unknown>) => {
                insertedDecision = values;
                return [{ id: values.id }];
              },
            }),
            update: () => mockTxWriteChain([]),
            delete: () => mockTxWriteChain([]),
          });
          return "committed";
        },
      );
      return () => insertedDecision;
    }

    it("accepting the escalation records an approved decision, completes the stage, and wakes the return assignee", async () => {
      const issue = escalatedRoundCapIssue();
      const pending = pendingEscalationInteraction();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue({
        ...issue,
        status: "in_progress",
        assigneeAgentId: returnAssigneeAgentId,
        assigneeUserId: null,
      } as any);
      mockIssueThreadInteractionService.getForIssue.mockResolvedValueOnce(pending);
      mockIssueThreadInteractionService.acceptInteraction.mockResolvedValueOnce({
        interaction: {
          ...pending,
          status: "accepted",
          result: { version: 1, outcome: "accepted" },
        },
        createdIssues: [],
        continuationIssue: null,
      });
      const readInsertedDecision = captureDecisionInsert();
      // The accept route's review-verdict binding probe queries the activity log
      // through an orderBy/limit chain the default mock where() does not model.
      mockDbSelectWhere.mockImplementation(() => {
        const resolveDefault = (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve([{
            id: "55555555-5555-4555-8555-555555555555",
            companyId: "company-1",
            agentId: "33333333-3333-4333-8333-333333333333",
            contextSnapshot: { issueId },
            permissions: null,
          }]).then(onFulfilled, onRejected);
        const chain: Record<string, unknown> = {
          for: () => ({ then: resolveDefault }),
          orderBy: () => chain,
          limit: () => chain,
          then: resolveDefault,
        };
        return chain;
      });

      const app = await createApp({
        type: "board",
        userId: "board-user",
        companyIds: ["company-1"],
        source: "local_implicit",
        isInstanceAdmin: false,
      });
      const res = await request(app)
        .post(`/api/issues/${issueId}/interactions/${interactionId}/accept`)
        .send({});

      expect(res.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledTimes(1);
      const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(updatePatch).toMatchObject({
        status: "in_progress",
        assigneeAgentId: returnAssigneeAgentId,
        assigneeUserId: null,
        actorAgentId: null,
        actorUserId: "board-user",
      });
      const executionState = updatePatch.executionState as Record<string, unknown>;
      expect(executionState).toMatchObject({
        status: "completed",
        currentStageId: null,
        currentStageType: null,
        currentParticipant: null,
        completedStageIds: [stageId],
        lastDecisionOutcome: "approved",
        returnAssignee: { type: "agent", agentId: returnAssigneeAgentId },
      });
      const decisionId = executionState.lastDecisionId as string;
      expect(decisionId).toBeTruthy();

      const insertedDecision = readInsertedDecision();
      expect(insertedDecision).toMatchObject({
        companyId: "company-1",
        issueId,
        stageId,
        stageType: "review",
        actorAgentId: null,
        actorUserId: "board-user",
        outcome: "approved",
        body: "Review approved via the round-cap escalation.",
        createdByRunId: null,
      });
      expect(insertedDecision?.id).toBe(decisionId);

      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        returnAssigneeAgentId,
        expect.objectContaining({
          payload: expect.objectContaining({
            issueId,
            interactionId,
            interactionKind: "request_confirmation",
            interactionStatus: "accepted",
          }),
        }),
      );
    });

    it("rejecting the escalation records a changes_requested decision, resets rounds, and returns the card to the return assignee", async () => {
      const issue = escalatedRoundCapIssue();
      const pending = pendingEscalationInteraction();
      const reason = "Human review: needs more edge-case tests before approval.";
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue({
        ...issue,
        status: "in_progress",
        assigneeAgentId: returnAssigneeAgentId,
        assigneeUserId: null,
      } as any);
      mockIssueThreadInteractionService.getForIssue.mockResolvedValueOnce(pending);
      mockIssueThreadInteractionService.rejectInteraction.mockResolvedValueOnce({
        ...pending,
        status: "rejected",
        result: { version: 1, outcome: "rejected", reason },
      });
      const readInsertedDecision = captureDecisionInsert();
      mockDbSelectWhere.mockImplementation(() => {
        const resolveDefault = (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve([{
            id: "55555555-5555-4555-8555-555555555555",
            companyId: "company-1",
            agentId: "33333333-3333-4333-8333-333333333333",
            contextSnapshot: { issueId },
            permissions: null,
          }]).then(onFulfilled, onRejected);
        const chain: Record<string, unknown> = {
          for: () => ({ then: resolveDefault }),
          orderBy: () => chain,
          limit: () => chain,
          then: resolveDefault,
        };
        return chain;
      });

      const app = await createApp({
        type: "board",
        userId: "board-user",
        companyIds: ["company-1"],
        source: "local_implicit",
        isInstanceAdmin: false,
      });
      const res = await request(app)
        .post(`/api/issues/${issueId}/interactions/${interactionId}/reject`)
        .send({ reason });

      expect(res.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledTimes(1);
      const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(updatePatch).toMatchObject({
        status: "in_progress",
        assigneeAgentId: returnAssigneeAgentId,
        assigneeUserId: null,
        actorAgentId: null,
        actorUserId: "board-user",
      });
      const executionState = updatePatch.executionState as Record<string, unknown>;
      expect(executionState).toMatchObject({
        status: "changes_requested",
        currentStageId: stageId,
        currentStageType: "review",
        returnAssignee: { type: "agent", agentId: returnAssigneeAgentId },
        lastDecisionOutcome: "changes_requested",
        changesRequestedCount: 0,
      });
      const decisionId = executionState.lastDecisionId as string;
      expect(decisionId).toBeTruthy();

      const insertedDecision = readInsertedDecision();
      expect(insertedDecision).toMatchObject({
        companyId: "company-1",
        issueId,
        stageId,
        stageType: "review",
        actorAgentId: null,
        actorUserId: "board-user",
        outcome: "changes_requested",
        body: reason,
        createdByRunId: null,
      });
      expect(insertedDecision?.id).toBe(decisionId);

      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        returnAssigneeAgentId,
        expect.objectContaining({
          payload: expect.objectContaining({
            issueId,
            interactionId,
            interactionKind: "request_confirmation",
            interactionStatus: "rejected",
          }),
        }),
      );
    });
  });
});
