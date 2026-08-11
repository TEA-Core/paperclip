import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockLoggerWarn = vi.hoisted(() => vi.fn());
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  getDependencyReadiness: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: mockLoggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(),
    listCompanyIds: vi.fn(),
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
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    expirePendingInteractionsOnTerminalIssueStatus: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

async function createApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
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

function issueFixture(overrides: Record<string, unknown>) {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "PAP-300",
    title: "Signal target",
    description: null,
    status: "todo",
    priority: "medium",
    parentId: null,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    executionWorkspaceId: null,
    labels: [],
    labelIds: [],
    ...overrides,
  };
}

function blockedWithoutBlockersWrites() {
  return mockLogActivity.mock.calls
    .map(([, input]) => input)
    .filter((input) => input.action === "issue.blocked_without_blockers_written");
}

describe("blocked-without-blockers telemetry signal in PATCH /issues/:id", () => {
  // createApp() pulls in the ../routes/issues.js module graph, whose first
  // transform costs multiple seconds on a loaded serial CI shard. Charged to
  // whichever test imports it first, that cost alone can blow vitest's 5s
  // testTimeout (observed: first test 5005ms timeout, later tests ~150ms once
  // the graph is cached). Warm the graph in beforeAll, which runs under the
  // 30s hookTimeout configured in server/vitest.config.ts, so the tests
  // themselves only pay module re-execution after vi.resetModules().
  beforeAll(async () => {
    await createApp();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "issue-1",
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it("emits the signal exactly once when a PATCH commits blocked with an empty blocker set", async () => {
    mockIssueService.getById.mockResolvedValue(issueFixture({ status: "todo" }));
    mockIssueService.update.mockResolvedValue(issueFixture({ status: "blocked" }));

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "blocked" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("blocked");
    expect(blockedWithoutBlockersWrites()).toHaveLength(1);
    const input = blockedWithoutBlockersWrites()[0];
    expect(input).toEqual(
      expect.objectContaining({
        companyId: "company-1",
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.blocked_without_blockers_written",
      }),
    );
    expect(input.details).toEqual(
      expect.objectContaining({
        source: "issue_update_route",
        identifier: "PAP-300",
        blockerIssueIds: [],
        actorSource: "local_implicit",
        statusChanged: true,
        blockersPatched: false,
      }),
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "issue-1",
        actorType: "user",
        actorId: "local-board",
      }),
      "issue PATCH committed blocked with an empty blocker set",
    );
  });

  it("emits nothing when a PATCH commits blocked with blocker edges", async () => {
    const blockerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue(issueFixture({ status: "todo" }));
    mockIssueService.update.mockResolvedValue(issueFixture({ status: "blocked" }));
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: blockerId }],
      blocks: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "issue-1",
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [blockerId],
      unresolvedBlockerCount: 1,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: false,
      isDependencyReady: false,
    });

    const res = await request(await createApp())
      .patch("/api/issues/issue-1")
      .send({ status: "blocked", blockedByIssueIds: [blockerId] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("blocked");
    expect(res.body.blockedBy).toEqual([{ id: blockerId }]);
    expect(blockedWithoutBlockersWrites()).toHaveLength(0);
  });

  it("emits nothing when the committed status is not blocked", async () => {
    mockIssueService.getById.mockResolvedValue(issueFixture({ status: "in_progress" }));
    mockIssueService.update.mockResolvedValue(issueFixture({ status: "done" }));

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(blockedWithoutBlockersWrites()).toHaveLength(0);
  });
});
