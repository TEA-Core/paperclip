import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";
import { reportUnexpectedRouteError } from "./helpers/report-unexpected-route-error.js";

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
  // GET /issues/:id read projections (baseRef readback route test).
  getAncestors: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  listBlockerAttention: vi.fn(),
  listReviewAttention: vi.fn(),
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
// SUP-17552: the accept door pre-flights the shared done-transition guard before
// it accepts a final-stage review escalation. Default delegates to the real
// guard (set in registerModuleMocks) so every other close path is unaffected;
// the refusal test overrides one call to prove the refusal is surfaced.
const mockEvaluateDoneTransitionGuard = vi.hoisted(() => vi.fn());
// The summary-generation forced-return resolver (SUP-15768). issues.ts imports
// this directly from ../services/summary-slots.js, so it is not covered by the
// ../services/index.js module mock. Default resolves null (a non-summary issue
// keeps its stored return assignee); individual tests override it to force the
// Summarizer and assert the hand-back routes there.
const mockResolveSummaryGenerationReturnAssignee = vi.hoisted(() => vi.fn(async () => null));
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
const mockRunnerGoalService = vi.hoisted(() => ({
  projection: vi.fn(async () => null),
  act: vi.fn(),
}));

function registerModuleMocks() {
  // SUP-17552: wrap the real done-transition guard so the accept door's
  // pre-flight refusal can be forced in one test while every other close path
  // keeps the genuine guard (and the module's other exports) verbatim.
  vi.doMock("../services/done-transition-guard.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../services/done-transition-guard.js")>();
    mockEvaluateDoneTransitionGuard.mockImplementation(actual.evaluateDoneTransitionGuard);
    return { ...actual, evaluateDoneTransitionGuard: mockEvaluateDoneTransitionGuard };
  });

  vi.doMock("../services/runner-goals.js", () => ({
    runnerGoalService: () => mockRunnerGoalService,
    RunnerGoalActionError: class RunnerGoalActionError extends Error {},
    RunnerGoalConflictError: class RunnerGoalConflictError extends Error {},
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1" })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async (agentId: string) => {
        if (agentId === PHANTOM_AGENT_ID) return null;
        return {
          id: agentId,
          companyId: agentId === OTHER_COMPANY_AGENT_ID ? "company-2" : "company-1",
          permissions: null,
        };
      }),
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
    logActivityInTransaction: mockLogActivity,
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
  // Swap only the resolver for the forced-return routing tests; keep every other
  // summary-slot export real so the app-under-test is unaffected.
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
  app.use(reportUnexpectedRouteError("issue-execution-policy-routes"));
  app.use(errorHandler);
  return app;
}

// The GET /issues/:id read path runs two db query shapes the per-test PATCH
// mocks never needed: a three-level innerJoin chain (listIssueLinkedCases) and
// a where().orderBy() activity-log read (listSuccessfulRunHandoffStates). One
// recursive thenable node satisfies any traversal: joins and orderBy/limit
// collapse to empty rows, while a bare .where()/`.for` still resolves the
// hoisted agent row the PATCH wake path depends on.
const HANDOFF_AGENT_ROWS = [{
  id: "55555555-5555-4555-8555-555555555555",
  companyId: "company-1",
  agentId: "33333333-3333-4333-8333-333333333333",
  contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  permissions: null,
}];

// SUP-17410: ids that exercise the agent-reference guard. PHANTOM is the live
// transcription slip from SUP-16903 (4893 vs the intended 4895); OTHER_COMPANY
// exists but belongs to a different company.
const PHANTOM_AGENT_ID = "e75502a7-952d-4893-93df-6a2b524a804b";
const OTHER_COMPANY_AGENT_ID = "0f0f0f0f-1111-4222-8333-444444444444";

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

describe("issue execution policy routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/external-objects.js");
    registerModuleMocks();
    vi.clearAllMocks();
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
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.getActiveInboxArchiveFields.mockResolvedValue({});
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
      // guard joins external_object_mentions to external_objects, and the GET
      // read path also chains three innerJoins (listIssueLinkedCases).
      innerJoin: () => dbChainNode([]),
    }));
    mockDbSelectWhere.mockImplementation(() => dbChainNode(HANDOFF_AGENT_ROWS));
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
      undefined,
      expect.any(Array),
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
      undefined,
      expect.any(Array),
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

  it("rejects a PATCH inserting a stage behind the live pointer (SUP-16525 INV-LADDER-1)", async () => {
    const stage1Id = "aaaaaaaa-0000-4000-8000-000000000001";
    const stage2Id = "aaaaaaaa-0000-4000-8000-000000000002";
    const stage3Id = "aaaaaaaa-0000-4000-8000-000000000003";
    const newStageId = "bbbbbbbb-0000-4000-8000-000000000004";
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: stage1Id,
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
        {
          id: stage2Id,
          type: "review",
          participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
        },
        { id: stage3Id, type: "approval", participants: [{ type: "user", userId: "cto-user" }] },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: "44444444-4444-4444-8444-444444444444",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1011",
      title: "Armed ladder",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: stage2Id,
        currentStageIndex: 1,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        returnAssignee: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        completedStageIds: [stage1Id],
        skippedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [
            {
              id: stage1Id,
              type: "review",
              participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
            },
            {
              id: newStageId,
              type: "review",
              participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
            },
            {
              id: stage2Id,
              type: "review",
              participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
            },
            { id: stage3Id, type: "approval", participants: [{ type: "user", userId: "cto-user" }] },
          ],
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "execution_policy_stage_inserted_behind_pointer",
      offendingStageId: newStageId,
      currentStageId: stage2Id,
    });
    // Fail-closed: the refusal happens before any write, so the stored policy,
    // pointer and completed set are left byte-identical to their pre-PATCH values.
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // SUP-16525 §4: the route-level probe for the ONE sanctioned recovery from
  // INV-LADDER-1. The same body that is refused above must persist a
  // self-consistent pointer when — and only when — it carries the explicit,
  // authorization-checked `rearmExecutionPolicy` opt-in.
  function armedLadderInsertIssue() {
    const stage1Id = "aaaaaaaa-0000-4000-8000-000000000001";
    const stage2Id = "aaaaaaaa-0000-4000-8000-000000000002";
    const stage3Id = "aaaaaaaa-0000-4000-8000-000000000003";
    const newStageId = "bbbbbbbb-0000-4000-8000-000000000004";
    const agentCoder = "33333333-3333-4333-8333-333333333333";
    const agentLE = "44444444-4444-4444-8444-444444444444";
    // The already-completed first gate is decided by a third agent, so no stage
    // in this ladder is gated solely by the coder return assignee (SUP-10602 /
    // assertIssueExecutionPolicyGatesAreEnforceable).
    const agentOther = "66666666-6666-4666-8666-666666666666";
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        { id: stage1Id, type: "review", participants: [{ type: "agent", agentId: agentOther }] },
        { id: stage2Id, type: "review", participants: [{ type: "agent", agentId: agentLE }] },
        { id: stage3Id, type: "approval", participants: [{ type: "user", userId: "cto-user" }] },
      ],
    })!;
    // newStage is spliced in BEFORE the live pointer (stage2) — the shape
    // INV-LADDER-1 refuses without the opt-in.
    const rearmBody = {
      mode: "normal",
      commentRequired: true,
      stages: [
        { id: stage1Id, type: "review", participants: [{ type: "agent", agentId: agentOther }] },
        { id: newStageId, type: "review", participants: [{ type: "agent", agentId: agentLE }] },
        { id: stage2Id, type: "review", participants: [{ type: "agent", agentId: agentLE }] },
        { id: stage3Id, type: "approval", participants: [{ type: "user", userId: "cto-user" }] },
      ],
    };
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      // The assignee is the coder, NOT the LE whose gate is being re-seated: a
      // stage gated solely by its own return assignee is refused by the
      // satisfiability guard (SUP-13526), and that guard must keep firing.
      assigneeAgentId: agentCoder,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1012",
      title: "Re-arm a rewritten ladder",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: stage2Id,
        currentStageIndex: 1,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: agentLE },
        returnAssignee: { type: "agent", agentId: agentCoder },
        completedStageIds: [stage1Id],
        skippedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    return { issue, rearmBody, stageIds: [stage1Id, newStageId, stage2Id, stage3Id], stage1Id, stage2Id, newStageId, agentLE };
  }

  it("persists both pointer halves when an authorized re-arm rewrites the ladder (SUP-16525 §4)", async () => {
    const { issue, rearmBody, stageIds, stage1Id, newStageId } = armedLadderInsertIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    // Control: the identical body WITHOUT the opt-in is still refused, and no
    // write reaches the store (fail closed).
    const refused = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: rearmBody });
    expect(refused.status).toBe(422);
    expect(refused.body.details).toMatchObject({
      code: "execution_policy_stage_inserted_behind_pointer",
      offendingStageId: newStageId,
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();

    // Board re-arm: accepted.
    const boardRes = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: rearmBody, rearmExecutionPolicy: true });
    expect(boardRes.status).toBe(200);

    // The sanctioned caller inside the ladder (the assignee/LE) can re-arm its
    // own card too — the opt-in is not a board-only escape hatch.
    const agentRes = await request(await createApp({
      type: "agent",
      agentId: issue.assigneeAgentId,
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: rearmBody, rearmExecutionPolicy: true });
    expect(agentRes.status).toBe(200);

    const patch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    // The rewritten ladder is persisted in the requested order...
    const writtenPolicy = patch.executionPolicy as { stages: Array<{ id: string }> };
    expect(writtenPolicy.stages.map((stage) => stage.id)).toEqual(stageIds);
    // ...and BOTH halves of the duplicated pointer are re-seated onto the first
    // stage that is not already completed, i.e. the newly inserted gate.
    const writtenState = patch.executionState as Record<string, unknown>;
    expect(patch.status).toBe("in_review");
    expect(writtenState.currentStageId).toBe(newStageId);
    expect(writtenState.currentStageIndex).toBe(1);
    expect(writtenPolicy.stages[writtenState.currentStageIndex as number]!.id).toBe(
      writtenState.currentStageId,
    );
    expect(writtenState.completedStageIds).toEqual([stage1Id]);
    expect(writtenState.skippedStageIds).toEqual([]);
    // A re-arm records no verdict: the re-armed gate is in NEITHER resolved set,
    // so it still blocks a close until it earns a real decision row.
    expect(writtenState.completedStageIds).not.toContain(newStageId);
    expect(writtenState.skippedStageIds).not.toContain(newStageId);
  });

  it("refuses a re-arm that carries no executionPolicy in the same body", async () => {
    const { issue } = armedLadderInsertIssue();
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ rearmExecutionPolicy: true });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("execution_policy_rearm_requires_policy_write");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("refuses a re-arm that smuggles another workflow mutation into the same body", async () => {
    const { issue, rearmBody } = armedLadderInsertIssue();
    mockIssueService.getById.mockResolvedValue(issue);

    // ...a stage verdict in the same body...
    const verdict = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: rearmBody, rearmExecutionPolicy: true, status: "done" });

    expect(verdict.status).toBe(422);
    expect(verdict.body.code).toBe("execution_policy_rearm_conflicts_with_status");
    expect(mockIssueService.update).not.toHaveBeenCalled();

    // ...and a monitor change, which the re-arm's short-circuit would drop.
    const monitor = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        executionPolicy: {
          ...rearmBody,
          monitor: {
            nextCheckAt: "2026-12-01T12:00:00.000Z",
            scheduledBy: "assignee",
            notes: "Wait for external QA report.",
          },
        },
        rearmExecutionPolicy: true,
      });

    expect(monitor.status).toBe(422);
    expect(monitor.body.code).toBe("execution_policy_rearm_conflicts_with_monitor_change");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("refuses the re-arm to an assignee agent without runtime:manage", async () => {
    const { issue, rearmBody } = armedLadderInsertIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));
    // The assignee holds issue:mutate (it clears the write boundary above) but
    // not runtime:manage — the re-arm gate must still refuse it.
    const defaultDecide = mockAccessService.decide.getMockImplementation()!;
    mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
      if (input.action === "runtime:manage") {
        return {
          allowed: false,
          action: "runtime:manage",
          reason: "deny_missing_grant",
          explanation: "Missing permission: runtime:manage",
        };
      }
      return defaultDecide(input);
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: issue.assigneeAgentId,
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: rearmBody, rearmExecutionPolicy: true });

    expect(res.status).toBe(403);
    expect(res.body.details?.explanation ?? res.body.error).toContain("runtime:manage");
    expect(mockIssueService.update).not.toHaveBeenCalled();
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
      mockIssueThreadInteractionService.create.mock.calls[0] as unknown as [
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
        expect(((call as unknown[])[1] as { action?: string }).action).not.toBe("issue.reviewers_updated");
        expect(((call as unknown[])[1] as { action?: string }).action).not.toBe("issue.approvers_updated");
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
        expect(((call as unknown[])[1] as { action?: string }).action).not.toBe("issue.reviewers_updated");
        expect(((call as unknown[])[1] as { action?: string }).action).not.toBe("issue.approvers_updated");
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

    it("accepting the escalation on the final stage records an approved decision, completes the stage, and closes the card done", async () => {
      const issue = escalatedRoundCapIssue();
      const pending = pendingEscalationInteraction();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue({
        ...issue,
        status: "done",
        assigneeAgentId: null,
        assigneeUserId: "board-user",
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
        return chain as never;
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
        status: "done",
        actorAgentId: null,
        actorUserId: "board-user",
      });
      // SUP-17552: the final-stage close must not hand the card back — no
      // return-assignee rewrite rides along with the `done` status.
      expect(updatePatch.assigneeAgentId).toBeUndefined();
      expect(updatePatch.assigneeUserId).toBeUndefined();
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

      // A closed card has no continuation wake target: the accept door must not
      // wake the return assignee back into a done card (SUP-17552).
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    });

    it("SUP-17552: approving a summary-generation escalation closes the final stage done instead of handing back to the Summarizer", async () => {
      const summarizerAgentId = "66666666-6666-4666-8666-666666666666";
      const issue = escalatedRoundCapIssue();
      const pending = pendingEscalationInteraction();
      // Even when the card is a summary-generation task whose forced-return
      // resolver would yield the Summarizer, the final-stage close supersedes the
      // hand-back: the card is done, so there is no return target to resolve.
      mockResolveSummaryGenerationReturnAssignee.mockResolvedValue({
        type: "agent",
        agentId: summarizerAgentId,
        userId: null,
      } as never);
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockResolvedValue({
        ...issue,
        status: "done",
        assigneeAgentId: null,
        assigneeUserId: "board-user",
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
      captureDecisionInsert();
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
        return chain as never;
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
      // The final-stage close is rendered instead of the summary hand-back, so the
      // forced-return resolver is never consulted on this door.
      expect(mockResolveSummaryGenerationReturnAssignee).not.toHaveBeenCalled();
      expect(mockIssueService.update).toHaveBeenCalledTimes(1);
      const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(updatePatch).toMatchObject({ status: "done" });
      expect(updatePatch.assigneeAgentId).toBeUndefined();
      expect(updatePatch.assigneeUserId).toBeUndefined();
    });

    it("SUP-17552: accepting an escalation on a non-final stage only advances the pointer (no done close)", async () => {
      const nextStageId = "22222222-2222-4222-8222-222222222222";
      const policy = normalizeIssueExecutionPolicy({
        stages: [
          {
            id: stageId,
            type: "review",
            participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
          },
          {
            id: nextStageId,
            type: "review",
            participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
          },
        ],
      })!;
      const issue = roundCapReviewIssue(
        { assigneeAgentId: null, assigneeUserId: "board-user", executionPolicy: policy },
        { changesRequestedCount: 3, currentParticipant: { type: "user", userId: "board-user" } },
      );
      const pending = pendingEscalationInteraction();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(
        async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch }),
      );
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
      captureDecisionInsert();
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
        return chain as never;
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
      const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
      // The escalated stage is stage 1 of 2: the approval advances the pointer to
      // the next pending stage, it does not close the card.
      expect(updatePatch.status).toBe("in_review");
      expect(updatePatch.executionState).toMatchObject({
        status: "pending",
        currentStageId: nextStageId,
        currentStageIndex: 1,
        currentStageType: "review",
      });
    });

    it("SUP-17552: a final-stage escalation close surfaces the done-transition guard refusal instead of swallowing it", async () => {
      const issue = escalatedRoundCapIssue();
      const pending = pendingEscalationInteraction();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueThreadInteractionService.getForIssue.mockResolvedValueOnce(pending);
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
        return chain as never;
      });

      const app = await createApp({
        type: "board",
        userId: "board-user",
        companyIds: ["company-1"],
        source: "local_implicit",
        isInstanceAdmin: false,
      });
      // The final-stage close runs the shared guard; force its delivery refusal.
      mockEvaluateDoneTransitionGuard.mockResolvedValueOnce({
        allowed: false,
        reason: "test refusal: no delivered head",
        aheadBy: null,
        branch: "SUP-17552-branch",
        defaultRef: null,
        owner: "acme",
        repo: "paperclip",
        skipped: false,
        skipReason: null,
        mechanism: "delivery",
        remedy: "Run deliver.sh before closing.",
      } as never);

      const res = await request(app)
        .post(`/api/issues/${issueId}/interactions/${interactionId}/accept`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("done_transition_missing_delivery");
      // The refusal is surfaced before the interaction is consumed or the card is
      // written: the pending escalation stays resolvable and no decision lands.
      expect(mockIssueThreadInteractionService.acceptInteraction).not.toHaveBeenCalled();
      expect(mockIssueService.update).not.toHaveBeenCalled();
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
        return chain as never;
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

  describe("executionPolicy.baseRef HTTP round-trip (SUP-15838)", () => {
    const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const baseIssue = {
      id: issueId,
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1551",
      title: "Stacked carrier child",
      projectId: null,
      goalId: null,
      executionPolicy: null,
      executionState: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    };

    it("PATCHes executionPolicy.baseRef (200) and reads it back verbatim from GET /issues/:id", async () => {
      const baseRef = "SUP-15486-carrier-child";
      mockIssueService.getById.mockResolvedValue(baseIssue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...baseIssue,
        ...patch,
        updatedAt: new Date(),
      }));

      const app = await createApp();
      const patchRes = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({ executionPolicy: { baseRef } });

      expect(patchRes.status, JSON.stringify(patchRes.body)).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(
        issueId,
        expect.objectContaining({
          executionPolicy: expect.objectContaining({ baseRef }),
        }),
      );

      // The exact policy handed to the service is what a later read must project
      // back verbatim — deliver.sh Phase 2c reads `.executionPolicy.baseRef` off
      // the GET body, so this asserts the real route pair, not the service shape.
      const persistedPolicy = (mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>)
        .executionPolicy;
      mockIssueService.getById.mockResolvedValue({ ...baseIssue, executionPolicy: persistedPolicy });

      const getRes = await request(app).get(`/api/issues/${issueId}`);
      expect(getRes.status, JSON.stringify(getRes.body)).toBe(200);
      expect(getRes.body.executionPolicy).toMatchObject({ baseRef });
      expect(getRes.body.executionPolicy.baseRef).toBe(baseRef);
    });

    it("rejects a path-escaping executionPolicy.baseRef with 400 naming the baseRef field", async () => {
      mockIssueService.getById.mockResolvedValue(baseIssue);

      const res = await request(await createApp())
        .patch(`/api/issues/${issueId}`)
        .send({ executionPolicy: { baseRef: "feature/../escape" } });

      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(mockIssueService.update).not.toHaveBeenCalled();
      const details = res.body.details as Array<{ path?: Array<string | number> }>;
      expect(Array.isArray(details)).toBe(true);
      expect(
        details.some((detail) => Array.isArray(detail.path) && detail.path.join(".") === "executionPolicy.baseRef"),
      ).toBe(true);
    });

    it("keeps executionPolicy additive when baseRef is omitted or null", async () => {
      mockIssueService.getById.mockResolvedValue(baseIssue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...baseIssue,
        ...patch,
        updatedAt: new Date(),
      }));

      const app = await createApp();
      const omitted = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({ executionPolicy: { mode: "normal" } });
      expect(omitted.status, JSON.stringify(omitted.body)).toBe(200);
      const omittedPatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
      // An empty/default policy still collapses to null exactly as it did before
      // baseRef existed: omitting the field introduces no new stored shape.
      expect(omittedPatch.executionPolicy ?? null).toBeNull();

      mockIssueService.update.mockClear();
      const nulled = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({ executionPolicy: { mode: "normal", baseRef: null } });
      expect(nulled.status, JSON.stringify(nulled.body)).toBe(200);
      const nulledPatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(nulledPatch.executionPolicy ?? null).toBeNull();
    });
  });

  // SUP-17410: a policy write must fail closed when it introduces a stage
  // participant (or return assignee) whose agentId resolves to no agent in the
  // issue's company. Such a reference arms on an undispatched principal, and a
  // stage past index 0 has no re-arm path, so the card wedges unrecoverably.
  describe("agent reference validation (SUP-17410)", () => {
    const REVIEWER_AGENT_ID = "22222222-2222-4222-8222-222222222222";
    const APPROVER_AGENT_ID = "33333333-3333-4333-8333-333333333333";
    const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";
    const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    function issueFixture(overrides: Record<string, unknown> = {}) {
      return {
        id: ISSUE_ID,
        companyId: "company-1",
        status: "in_progress",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        assigneeUserId: null,
        createdByUserId: "local-board",
        identifier: "PAP-17410",
        title: "Agent reference validation",
        executionPolicy: null,
        executionState: null,
        ...overrides,
      };
    }

    function programPatchTarget(issue: Record<string, unknown>) {
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(
        async (_id: string, patch: Record<string, unknown>) => ({
          ...issue,
          ...patch,
          updatedAt: new Date(),
        }),
      );
    }

    async function patchPolicy(executionPolicy: unknown) {
      return request(await createApp())
        .patch(`/api/issues/${ISSUE_ID}`)
        .send({ executionPolicy });
    }

    it("rejects a participant agentId that resolves to no agent, naming the stage and id", async () => {
      programPatchTarget(issueFixture());

      const res = await patchPolicy({
        stages: [
          { type: "review", participants: [{ type: "agent", agentId: REVIEWER_AGENT_ID }] },
          { type: "approval", participants: [{ type: "agent", agentId: PHANTOM_AGENT_ID }] },
        ],
      });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("stage 1");
      expect(res.body.error).toContain(PHANTOM_AGENT_ID);
      expect(res.body.details).toMatchObject({
        stageIndex: 1,
        stageType: "approval",
        agentId: PHANTOM_AGENT_ID,
        companyId: "company-1",
      });
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("rejects a returnAssigneeAgentId that resolves to no agent", async () => {
      programPatchTarget(issueFixture());

      const res = await patchPolicy({
        returnAssigneeAgentId: PHANTOM_AGENT_ID,
        stages: [
          { type: "review", participants: [{ type: "agent", agentId: REVIEWER_AGENT_ID }] },
        ],
      });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("returnAssigneeAgentId");
      expect(res.body.error).toContain(PHANTOM_AGENT_ID);
      expect(res.body.details).toMatchObject({
        field: "returnAssigneeAgentId",
        agentId: PHANTOM_AGENT_ID,
      });
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("accepts a policy where every participant and the return assignee resolve", async () => {
      programPatchTarget(issueFixture());

      const res = await patchPolicy({
        returnAssigneeAgentId: ASSIGNEE_AGENT_ID,
        stages: [
          { type: "review", participants: [{ type: "agent", agentId: REVIEWER_AGENT_ID }] },
          { type: "approval", participants: [{ type: "agent", agentId: APPROVER_AGENT_ID }] },
        ],
      });

      expect(res.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalled();
    });

    it("rejects an agent id that exists but belongs to another company", async () => {
      programPatchTarget(issueFixture());

      const res = await patchPolicy({
        stages: [
          { type: "review", participants: [{ type: "agent", agentId: OTHER_COMPANY_AGENT_ID }] },
        ],
      });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain(OTHER_COMPANY_AGENT_ID);
      expect(res.body.details).toMatchObject({
        stageIndex: 0,
        agentId: OTHER_COMPANY_AGENT_ID,
        companyId: "company-1",
      });
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("does not re-validate stored stages when the PATCH omits the stages key", async () => {
      // An issue already carrying a phantom participant (SUP-16903) must stay
      // mutable: a partial write that preserves the stored ladder is not
      // blocked, and the stored phantom is carried over untouched.
      programPatchTarget(
        issueFixture({
          executionPolicy: {
            mode: "normal",
            stages: [
              {
                id: "c16093a9-9b47-40a9-8c2d-3e4bcd6c496e",
                type: "review",
                participants: [
                  { id: "4a3f7748-7618-4f44-8d13-5877be64d311", type: "agent", agentId: PHANTOM_AGENT_ID },
                ],
              },
            ],
          },
        }),
      );

      const res = await request(await createApp())
        .patch(`/api/issues/${ISSUE_ID}`)
        .send({ executionPolicy: { mode: "normal" } });

      expect(res.status).toBe(200);
      const [, patch] = mockIssueService.update.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch.executionPolicy).toMatchObject({
        stages: [
          expect.objectContaining({
            participants: [expect.objectContaining({ agentId: PHANTOM_AGENT_ID })],
          }),
        ],
      });
    });

    it("does not re-validate an unchanged return assignee that is already stored", async () => {
      programPatchTarget(
        issueFixture({
          executionPolicy: {
            mode: "normal",
            returnAssigneeAgentId: PHANTOM_AGENT_ID,
            stages: [
              {
                id: "c16093a9-9b47-40a9-8c2d-3e4bcd6c496e",
                type: "review",
                participants: [
                  { id: "4a3f7748-7618-4f44-8d13-5877be64d311", type: "agent", agentId: REVIEWER_AGENT_ID },
                ],
              },
            ],
          },
        }),
      );

      const res = await patchPolicy({
        returnAssigneeAgentId: PHANTOM_AGENT_ID,
        stages: [
          { type: "review", participants: [{ type: "agent", agentId: REVIEWER_AGENT_ID }] },
        ],
      });

      expect(res.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalled();
    });

    it("accepts a full-stages PATCH that repairs one stage while preserving a legacy phantom in another", async () => {
      // Round-1 finding legacy-phantom-stage-repair-blocked: a card already
      // wedged with a phantom participant (SUP-16903) must stay repairable. A
      // PATCH that sends the full `stages` array, fixes one stage, and carries
      // the phantom forward untouched in a stage the repair does not touch must
      // not re-validate the preserved legacy id and 422 the repair.
      programPatchTarget(
        issueFixture({
          executionPolicy: {
            mode: "normal",
            stages: [
              {
                id: "c16093a9-9b47-40a9-8c2d-3e4bcd6c496e",
                type: "review",
                participants: [
                  { id: "4a3f7748-7618-4f44-8d13-5877be64d311", type: "agent", agentId: PHANTOM_AGENT_ID },
                ],
              },
              {
                id: "d26093a9-9b47-40a9-8c2d-3e4bcd6c496e",
                type: "approval",
                participants: [
                  { id: "5b4f7748-7618-4f44-8d13-5877be64d311", type: "agent", agentId: APPROVER_AGENT_ID },
                ],
              },
            ],
          },
        }),
      );

      const res = await patchPolicy({
        stages: [
          // Unchanged: the legacy phantom is preserved in place.
          { type: "review", participants: [{ type: "agent", agentId: PHANTOM_AGENT_ID }] },
          // Repaired: a valid agent newly introduced for this stage.
          { type: "approval", participants: [{ type: "agent", agentId: REVIEWER_AGENT_ID }] },
        ],
      });

      expect(res.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalled();
    });

    it("still rejects a newly introduced foreign-company agent id in a full-stages PATCH that preserves a legacy phantom", async () => {
      // The delta is prospective: a *newly introduced* id that exists but lives
      // in a different company is rejected even when the same write preserves a
      // legacy phantom elsewhere in the ladder.
      programPatchTarget(
        issueFixture({
          executionPolicy: {
            mode: "normal",
            stages: [
              {
                id: "c16093a9-9b47-40a9-8c2d-3e4bcd6c496e",
                type: "review",
                participants: [
                  { id: "4a3f7748-7618-4f44-8d13-5877be64d311", type: "agent", agentId: PHANTOM_AGENT_ID },
                ],
              },
              {
                id: "d26093a9-9b47-40a9-8c2d-3e4bcd6c496e",
                type: "approval",
                participants: [
                  { id: "5b4f7748-7618-4f44-8d13-5877be64d311", type: "agent", agentId: APPROVER_AGENT_ID },
                ],
              },
            ],
          },
        }),
      );

      const res = await patchPolicy({
        stages: [
          // Preserved legacy phantom: not re-validated.
          { type: "review", participants: [{ type: "agent", agentId: PHANTOM_AGENT_ID }] },
          // New foreign-company id: must be rejected.
          { type: "approval", participants: [{ type: "agent", agentId: OTHER_COMPANY_AGENT_ID }] },
        ],
      });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain(OTHER_COMPANY_AGENT_ID);
      expect(res.body.details).toMatchObject({
        stageIndex: 1,
        stageType: "approval",
        agentId: OTHER_COMPANY_AGENT_ID,
        companyId: "company-1",
      });
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("rejects a create whose participant agentId resolves to no agent", async () => {
      const res = await request(await createApp())
        .post("/api/companies/company-1/issues")
        .send({
          title: "Phantom participant on create",
          assigneeAgentId: ASSIGNEE_AGENT_ID,
          executionPolicy: {
            stages: [
              { type: "review", participants: [{ type: "agent", agentId: PHANTOM_AGENT_ID }] },
            ],
          },
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain(PHANTOM_AGENT_ID);
      expect(res.body.details).toMatchObject({ stageIndex: 0, agentId: PHANTOM_AGENT_ID });
      expect(mockIssueService.create).not.toHaveBeenCalled();
    });
  });
});
