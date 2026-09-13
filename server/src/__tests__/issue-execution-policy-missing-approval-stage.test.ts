import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueLabels, labels } from "@paperclipai/db";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";
import { reportUnexpectedRouteError } from "./helpers/report-unexpected-route-error.js";

// SUP-15878 / SUP-15958: the in-scope predicate is the canonical shared
// `countLadderedChildren` (post-exclusion, `>= 2` mechanism-D count). A card
// whose only children are redo/delivery or otherwise excluded does NOT owe a
// close ladder and is not diagnosed; a card with two or more laddered children
// and no `approval` stage is refused with a typed 409 and a durable activity
// row on both the `done` and `in_review` paths, carrying the canonical
// ladderedChildCount / ladderedChildIdentifiers / excludedChildIdentifiers.

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
// SUP-15878: both durable missing-approval-stage signals are now written through
// the transactional logger (logActivityInTransaction), which propagates
// persistence errors, so the test asserts against that call rather than the
// fire-and-forget logActivity.
const mockLogActivityInTransaction = vi.hoisted(() => vi.fn(async () => undefined));
// Non-`cancelled` child rows the child-count query resolves. Per-test override
// switches between open children, cancelled-only children, and no children.
const childRowsState = vi.hoisted(() => ({ rows: [] as unknown[] }));
// SUP-15958: the carve-out label rows (`work-type:redo` / `work-type:delivery`)
// and the issue_labels mapping they resolve to. `countLadderedChildren` reads
// these to exclude redo/delivery children from the laddered count; empty by
// default so the carve-out is inert unless a test arms it.
const carveOutLabelRowsState = vi.hoisted(() => ({ rows: [] as unknown[] }));
const carveOutIssueLabelRowsState = vi.hoisted(() => ({ rows: [] as unknown[] }));
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
    logActivityInTransaction: mockLogActivityInTransaction,
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

const PARENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD_PARTICIPANT_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "55555555-5555-4555-8555-555555555555";

// A decomposition child that counts toward the laddered count: manual origin,
// a non-null executionPolicy, and at least one completed stage — exactly the
// row shape `countLadderedChildren` reads from the issues table.
function ladderedChildRow(id: string, identifier: string, originKind: string = "manual") {
  return {
    id,
    identifier,
    executionPolicy: {
      stages: [{ id: "stage-x", type: "review", participants: [{ type: "agent", agentId: AGENT_ID }] }],
    },
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
    originKind,
  };
}

// Arm the `work-type:redo` carve-out so the named child is excluded from the
// laddered count by the real helper (the label-name read returns the redo
// label and the issue_labels read maps it onto that child).
function armRedoCarveOutFor(childId: string) {
  carveOutLabelRowsState.rows = [{ id: "label-work-type-redo" }];
  carveOutIssueLabelRowsState.rows = [{ issueId: childId }];
}

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
  // Both durable signals are written through logActivityInTransaction (the
  // error-propagating, transactional logger). Asserting against that call is what
  // proves the signals are no longer fire-and-forget.
  return mockLogActivityInTransaction.mock.calls
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
    carveOutLabelRowsState.rows = [];
    carveOutIssueLabelRowsState.rows = [];
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
      const keys =
        columns && typeof columns === "object" && !Array.isArray(columns)
          ? Object.keys(columns as object)
          : [];
      // SUP-15958: `countLadderedChildren` runs up to three indexed reads on the
      // PATCH path. Route each to its own state so the real helper's exclusions
      // are exercised; every other select keeps the hoisted handoff-agent-row
      // default. The child decomposition is the only 5-key projection on the
      // path, so it is matched by signature alone (no table-identity assumption);
      // the carve-out label reads are matched by table + single-key projection.
      const childSignature =
        keys.length === 5
        && keys.includes("id")
        && keys.includes("identifier")
        && keys.includes("executionPolicy")
        && keys.includes("executionState")
        && keys.includes("originKind");
      return {
        from: (table: unknown) => {
          let rows: unknown[] = HANDOFF_AGENT_ROWS;
          if (childSignature) {
            rows = childRowsState.rows;
          } else if (table === labels && keys.length === 1 && keys[0] === "id") {
            rows = carveOutLabelRowsState.rows;
          } else if (table === issueLabels && keys.length === 1 && keys[0] === "issueId") {
            rows = carveOutIssueLabelRowsState.rows;
          }
          return {
            where: () => dbChainNode(rows),
            innerJoin: () => dbChainNode([]),
          };
        },
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
    childRowsState.rows = [
      ladderedChildRow("child-a-id", "PAP-2"),
      ladderedChildRow("child-b-id", "PAP-3"),
    ];
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
        ladderedChildCount: 2,
        ladderedChildIdentifiers: ["PAP-2", "PAP-3"],
        excludedChildIdentifiers: [],
        stageTypes: ["review"],
      },
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(gapActivityInput("issue.done_missing_approval_stage_refused")).toMatchObject({
      entityId: PARENT_ID,
      issueId: PARENT_ID,
      details: {
        ladderedChildCount: 2,
        ladderedChildIdentifiers: ["PAP-2", "PAP-3"],
        excludedChildIdentifiers: [],
        stageTypes: ["review"],
        source: "done",
      },
    });
  });

  // Distinguishing regression (SUP-15878 R2 / SUP-16024): the durable refusal
  // row is REQUIRED evidence, not best-effort. If its write cannot persist, the
  // route must fail closed — it may not return the typed 409 (which claims the
  // signal was emitted) when no `issue.done_missing_approval_stage_refused`
  // row actually committed. Forcing the transactional logger to reject proves
  // the persistence error is surfaced as a 5xx rather than swallowed and the
  // original 409 rethrown. The normal 409 path above already pins the
  // committed-row success behaviour.
  it("fails closed with an error (not the typed 409) when the refusal audit row cannot persist", async () => {
    const issue = parentIssue(reviewOnlyPolicy());
    childRowsState.rows = [
      ladderedChildRow("child-a-id", "PAP-2"),
      ladderedChildRow("child-b-id", "PAP-3"),
    ];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));
    mockLogActivityInTransaction.mockRejectedValueOnce(new Error("audit row insert failed"));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    // No successful-looking 409 may coexist with a missing durable row: the
    // persistence error surfaces as a 5xx and the missing-stage diagnosis is
    // not claimed as emitted.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.code).not.toBe("done_transition_missing_approval_stage");
    expect(res.body.error).not.toContain("no approval stage");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // Regression: a `done` request that does not otherwise require a transaction
  // (no execution policy at all, so no decision, no relay stop, no review
  // activity) must STILL be refused with the typed signal. Pre-fix this took the
  // non-transactional `updateIssue()` branch, skipped the delivery catchall (the
  // gap was present), and closed the card successfully with neither guard.
  it("refuses a stage-less in-scope done that otherwise needs no transaction", async () => {
    const issue = parentIssue(null);
    childRowsState.rows = [
      ladderedChildRow("child-a-id", "PAP-2"),
      ladderedChildRow("child-b-id", "PAP-3"),
    ];
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
        ladderedChildCount: 2,
        ladderedChildIdentifiers: ["PAP-2", "PAP-3"],
        excludedChildIdentifiers: [],
        stageTypes: [],
      },
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(gapActivityInput("issue.done_missing_approval_stage_refused")).toMatchObject({
      entityId: PARENT_ID,
      issueId: PARENT_ID,
      details: {
        ladderedChildCount: 2,
        ladderedChildIdentifiers: ["PAP-2", "PAP-3"],
        excludedChildIdentifiers: [],
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
    childRowsState.rows = [
      ladderedChildRow("child-a-id", "PAP-2"),
      ladderedChildRow("child-b-id", "PAP-3"),
    ];
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
        ladderedChildCount: 2,
        ladderedChildIdentifiers: ["PAP-2", "PAP-3"],
        excludedChildIdentifiers: [],
        stageTypes: ["review"],
      },
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(gapActivityInput("issue.done_missing_approval_stage_refused")).toMatchObject({
      entityId: PARENT_ID,
      issueId: PARENT_ID,
      details: {
        ladderedChildCount: 2,
        ladderedChildIdentifiers: ["PAP-2", "PAP-3"],
        excludedChildIdentifiers: [],
        stageTypes: ["review"],
        source: "done",
      },
    });
  });

  it("completes an in_review transition on an in-scope card and records the signal", async () => {
    const issue = parentIssue(reviewOnlyPolicy());
    childRowsState.rows = [
      ladderedChildRow("child-a-id", "PAP-2"),
      ladderedChildRow("child-b-id", "PAP-3"),
    ];
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
        ladderedChildCount: 2,
        ladderedChildIdentifiers: ["PAP-2", "PAP-3"],
        excludedChildIdentifiers: [],
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

  // Distinguishing regression (SUP-15958): the SUP-15826 / SUP-15813 shape — a
  // card whose ONLY child is a work-type:redo child. The redo child is itself a
  // genuine laddered child (manual origin, a policy, a completed stage), so under
  // the old raw parent_id count it armed the diagnosis (1 child, no approval
  // stage → 409 refusal + spurious in_review row). The canonical
  // countLadderedChildren predicate excludes it via the work-type:redo
  // carve-out, so the laddered count is 0, the card owes no close ladder, and the
  // `done` transition is unchanged with neither signal.
  it("does not diagnose a redo-only child set and leaves the done transition unchanged", async () => {
    const issue = parentIssue(reviewOnlyPolicy());
    childRowsState.rows = [ladderedChildRow("child-redo-id", "PAP-2")];
    armRedoCarveOutFor("child-redo-id");
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
    childRowsState.rows = [
      ladderedChildRow("child-a-id", "PAP-2"),
      ladderedChildRow("child-b-id", "PAP-3"),
    ];
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
