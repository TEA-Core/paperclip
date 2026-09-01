import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The route module's logger resolves its log dir from the Paperclip config
// file at import time; point it at a scratch home so the suite does not
// depend on a readable .paperclip/config.json (same pattern as
// issue-comment-attribution-audit-routes.test.ts).
vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

// SUP-14304: a PATCH /api/issues/{id} that is refused by the issue:mutate
// boundary used to answer with a bare 403 string that a consumer (SUP-14298)
// misread as a run-lease conflict. The refusal must go through the shared
// issue-write denial copy (403, tone boundary) so the boundary, who can act,
// and the sanctioned path are named. The mock scaffold below mirrors
// issue-comment-reopen-routes.test.ts because it loads the same route module.

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  isManagerOf: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() => vi.fn(() => ({ values: mockTxInsertValues })));
const mockTx = vi.hoisted(() => ({
  insert: mockTxInsert,
}));
const mockDbSelectOrderBy = vi.hoisted(() => vi.fn(async () => []));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  orderBy: mockDbSelectOrderBy,
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([]).then(onFulfilled, onRejected),
})));
const mockDbSelectFrom = vi.hoisted(() =>
  vi.fn(() => ({ where: mockDbSelectWhere })),
);
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
}));
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  listForIssue: vi.fn(async () => []),
}));
const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
}));
const mockIssueTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));
const mockExternalObjectService = vi.hoisted(() => ({
  syncCommentSafely: vi.fn(async () => undefined),
  syncIssueSafely: vi.fn(async () => undefined),
}));
const mockObserveCrossIssueInfluence = vi.hoisted(() => vi.fn());
const mockCrossIssueInfluenceLimitError = vi.hoisted(() => vi.fn());
const mockCrossIssueInfluenceRunContextError = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/feedback.js", () => ({
  feedbackService: () => mockFeedbackService,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/routines.js", () => ({
  routineService: () => mockRoutineService,
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => mockIssueRecoveryActionService,
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
  issueTreeControlService: () => mockIssueTreeControlService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({}),
}));

vi.mock("../services/external-objects.js", () => ({
  externalObjectService: () => mockExternalObjectService,
}));

vi.mock("../services/cross-issue-influence-limit.js", () => ({
  observeCrossIssueInfluence: mockObserveCrossIssueInfluence,
  crossIssueInfluenceLimitError: mockCrossIssueInfluenceLimitError,
  crossIssueInfluenceRunContextError: mockCrossIssueInfluenceRunContextError,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(app: express.Express, actor?: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
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

function makeIssue(status: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByAgentId: null,
    identifier: "PAP-580",
    title: "PATCH denial copy",
  };
}

function agentActor(agentId: string) {
  return {
    type: "agent",
    agentId,
    companyId: "company-1",
    source: "agent_key",
    runId: "run-1",
  };
}

describe.sequential("issue PATCH authz denial copy", () => {
  // Warm the route module cache outside the measured tests (see
  // issue-comment-reopen-routes.test.ts for the rationale).
  beforeAll(async () => {
    await Promise.all([import("../routes/issues.js"), import("../middleware/index.js")]);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.isManagerOf.mockReset();
    mockDbSelect.mockReset();
    mockDbSelectFrom.mockReset();
    mockDbSelectWhere.mockReset();
    mockDbSelectOrderBy.mockReset();
    mockDbSelectOrderBy.mockResolvedValue([]);
    mockDbSelectWhere.mockImplementation(() => ({
      orderBy: mockDbSelectOrderBy,
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([]).then(onFulfilled, onRejected),
    }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockAccessService.isManagerOf.mockResolvedValue(false);
  });

  it("answers a grantless PATCH with the issue-write denial copy instead of a bare 403 string", async () => {
    const outsiderAgentId = "33333333-3333-4333-8333-333333333333";
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockAccessService.decide.mockImplementation(async (input: { action?: string }) => ({
      allowed: false,
      action: input.action,
      reason: "deny_missing_grant",
      explanation: "Missing issue write grant.",
    }));

    const res = await request(await installActor(createApp(), agentActor(outsiderAgentId)))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ priority: "low" });

    expect(res.status).toBe(403);
    // The refusal routes through denyIssueWrite with the decision-derived code.
    expect(res.body.details.code).toBe("issue_write_no_grant");
    expect(res.body.details.boundary).toBe("Issue write grant");
    // The supported path is named, reusing the shared CHILD_ISSUE_PATH copy.
    expect(res.body.details.sanctionedPath).toContain("child issue");
    // The flattened error still carries the who-can-act and path obligations.
    expect(res.body.error).toContain("Who can act:");
    expect(res.body.error).toContain("Try this:");
    expect(res.body.error).toContain("PAP-580");
    expect(res.body.error).not.toContain("Issue is outside this actor's authorization boundary");
    // It is an authorization denial, not a run-lease conflict (409 +
    // issue_write_assignee_run_lock).
    expect(res.status).not.toBe(409);
    expect(res.body.details.code).not.toBe("issue_write_assignee_run_lock");
    // The authorization decision is unchanged: the same actor/issue pair is
    // still refused and nothing is written.
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({ action: "issue:mutate" }));
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("maps a low-trust boundary denial to the actor-class exclusion code", async () => {
    const outsiderAgentId = "33333333-3333-4333-8333-333333333333";
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockAccessService.decide.mockImplementation(async (input: { action?: string }) => ({
      allowed: false,
      action: input.action,
      reason: "deny_low_trust_boundary",
      explanation: "Actor-class boundary.",
    }));

    const res = await request(await installActor(createApp(), agentActor(outsiderAgentId)))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ priority: "low" });

    expect(res.status).toBe(403);
    expect(res.body.details.code).toBe("issue_write_actor_class_excluded");
    expect(res.body.details.code).not.toBe("issue_write_assignee_run_lock");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("still allows the assignee agent to PATCH its own issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("todo"),
      ...patch,
    }));
    mockAccessService.decide.mockImplementation(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    }));

    const res = await request(await installActor(createApp(), agentActor("22222222-2222-4222-8222-222222222222")))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ priority: "low" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });
});
