import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildIssueBlockersResolvedRestoredWakeIdempotencyKey,
  buildIssueBlockersResolvedWakeStateKey,
} from "../services/issue-dependency-wakeups.ts";
import { reportUnexpectedRouteError } from "./helpers/report-unexpected-route-error.js";

// The first test in this suite imports the large `routes/issues.ts` module
// through `vi.importActual` inside `createApp`. `vi.resetModules()` in
// `beforeEach` forces a fresh import each test, so the first test pays the
// one-time transform and execution cost of that module. Locally the first
// test takes about 3.7s while the later tests take about 0.13s each. Under
// the loaded serial shard (maxWorkers=1) this cold-start can cross vitest's
// default 5000ms test timeout and produce a flaky "Test timed out in 5000ms"
// failure. Give the suite generous headroom, far above the observed cold-start
// yet still below the 30s hook timeout.
vi.setConfig({ testTimeout: 30000 });

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockFindExistingIssueBlockersResolvedWakeForReadyState = vi.hoisted(() => vi.fn(async () => null));
const mockFindExistingIssueBlockersResolvedWakeForAnyKey = vi.hoisted(() => vi.fn(async () => null));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
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

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    decide: vi.fn(async () => ({ allowed: true })),
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
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    getExperimental: vi.fn(async () => ({ enableExternalObjects: false })),
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
    expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    expirePendingInteractionsOnTerminalIssueStatus: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
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

vi.mock("../services/issue-dependency-wakeups.js", async () => {
  const actual = await vi.importActual<typeof import("../services/issue-dependency-wakeups.js")>(
    "../services/issue-dependency-wakeups.js",
  );
  return {
    ...actual,
    findExistingIssueBlockersResolvedWakeForReadyState:
      mockFindExistingIssueBlockersResolvedWakeForReadyState,
    findExistingIssueBlockersResolvedWakeForAnyKey:
      mockFindExistingIssueBlockersResolvedWakeForAnyKey,
  };
});

type RouteTestTableRows = Record<string, Record<string, unknown>[]>;

async function createApp(
  options: { actor?: Record<string, unknown>; tableRows?: RouteTestTableRows } = {},
) {
  const tableRows = options.tableRows ?? {};
  // The route module is re-imported after `vi.resetModules()`, so its drizzle
  // table objects are fresh instances: rows cannot be keyed by table identity.
  // Key them by the pg table NAME instead — drizzle stores it as the VALUE at
  // the `Symbol.for("drizzle:Name")` property. Rows are returned as
  // configured, without evaluating the query predicates: a configured row
  // stands in for a row that SURVIVES the query's where clause, and an
  // unconfigured table yields no rows.
  const rowsForTable = (table: object): unknown[] => {
    const name = (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name")];
    if (typeof name === "string" && name in tableRows) return tableRows[name];
    return [];
  };
  const routeDb = {
    select: vi.fn(() => {
      let rows: unknown[] = [];
      const whereResult = {
        for: vi.fn(() => whereResult),
        limit: vi.fn(async () => rows),
        orderBy: vi.fn(() => whereResult),
        then: async (resolve: (rows: unknown[]) => unknown) => resolve(rows),
      };
      const query: Record<string, unknown> = {};
      query.innerJoin = vi.fn(() => query);
      query.where = vi.fn(() => whereResult);
      return {
        from: vi.fn((table: object) => {
          rows = rowsForTable(table);
          return query;
        }),
      };
    }),
    // Transactions see the same row stubs as the top-level db so the agent
    // cross-issue attribution guard can resolve its `for update` run lookup.
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(routeDb),
  };
  const { issueRoutes } = await vi.importActual<typeof import("../routes/issues.js")>(
    "../routes/issues.js",
  );
  const { errorHandler } = await vi.importActual<typeof import("../middleware/index.js")>(
    "../middleware/index.js",
  );
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = options.actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(routeDb as any, {} as any));
  app.use(reportUnexpectedRouteError("issue-dependency-wakeups-routes"));
  app.use(errorHandler);
  return app;
}

describe("issue dependency wakeups in issue routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockFindExistingIssueBlockersResolvedWakeForReadyState.mockResolvedValue(null);
    mockFindExistingIssueBlockersResolvedWakeForAnyKey.mockResolvedValue(null);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
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

  it("wakes dependents when the final blocker transitions to done", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "done",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        blockerIssueIds: ["issue-1", "issue-3"],
      },
    ]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: "issue-2",
            resolvedBlockerIssueId: "issue-1",
          }),
        }),
      );
    });
  });

  it("wakes an assigned blocked issue when blockers are applied after the blocker is already done", async () => {
    const parentIssueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue({
      id: parentIssueId,
      companyId: "company-1",
      identifier: "PAP-200",
      title: "Blocked after completion",
      description: null,
      status: "todo",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: parentIssueId,
      companyId: "company-1",
      identifier: "PAP-200",
      title: "Blocked after completion",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: parentIssueId,
      blockerIssueIds: [childIssueId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${parentIssueId}`)
      .send({
        status: "blocked",
        blockedByIssueIds: [childIssueId],
        unblockDescriptor: { owner: "board", action: "Review the restored dependency" },
      });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: parentIssueId,
            resolvedBlockerIssueId: childIssueId,
            mutation: "blocked_dependency_restored",
          }),
          contextSnapshot: expect.objectContaining({
            source: "issue.blockers_restored",
          }),
        }),
      );
    });
  });

  it("wakes a blocked issue when its blocker edge is rewritten to a different done blocker", async () => {
    const dependentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const newBlockerId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    mockIssueService.getById.mockResolvedValue({
      id: dependentId,
      companyId: "company-1",
      identifier: "PAP-301",
      title: "Blocked, edge rewrite pending",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: dependentId,
      companyId: "company-1",
      identifier: "PAP-301",
      title: "Blocked, edge rewrite pending",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    // existing relations show the previous (now-removed) blocker
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
      blocks: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: dependentId,
      blockerIssueIds: [newBlockerId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${dependentId}`)
      .send({ blockedByIssueIds: [newBlockerId] });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: dependentId,
            resolvedBlockerIssueId: newBlockerId,
            mutation: "blocked_dependency_restored",
          }),
          contextSnapshot: expect.objectContaining({
            source: "issue.blockers_restored",
          }),
        }),
      );
    });
  });

  it("wakes the parent when all direct children become terminal", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "in_progress",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "done",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue({
      id: "parent-1",
      assigneeAgentId: "agent-9",
      childIssueIds: ["child-0", "child-1"],
      childIssueSummaries: [
        {
          id: "child-0",
          identifier: "PAP-100",
          title: "First child",
          status: "done",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
          updatedAt: new Date("2026-04-18T12:00:00.000Z"),
          summary: "First child finished.",
        },
        {
          id: "child-1",
          identifier: "PAP-101",
          title: "Last child",
          status: "done",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
          updatedAt: new Date("2026-04-18T12:05:00.000Z"),
          summary: "Last child finished.",
        },
      ],
      childIssueSummaryTruncated: false,
    });

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-9",
        expect.objectContaining({
          reason: "issue_children_completed",
          payload: expect.objectContaining({
            issueId: "parent-1",
            completedChildIssueId: "child-1",
            childIssueSummaries: expect.arrayContaining([
              expect.objectContaining({ identifier: "PAP-101", summary: "Last child finished." }),
            ]),
          }),
          contextSnapshot: expect.objectContaining({
            childIssueSummaries: expect.arrayContaining([
              expect.objectContaining({ identifier: "PAP-100", summary: "First child finished." }),
            ]),
          }),
        }),
      );
    });
  });

  function issueRecord(overrides: Record<string, unknown> = {}) {
    return {
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Issue",
      description: null,
      status: "todo",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      blockedTransitionAt: null,
      labels: [],
      labelIds: [],
      ...overrides,
    };
  }

  it("wakes a Release-like dependent after a terminal reset using the current blocked cycle", async () => {
    const reviewIssueId = "11111111-1111-4111-8111-111111111111";
    const releaseIssueId = "22222222-2222-4222-8222-222222222222";
    const releaseBlockedAt = new Date("2026-08-01T15:00:00.000Z");
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: reviewIssueId,
      identifier: "PAP-REVIEW",
      title: "Review",
      status: "in_progress",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: reviewIssueId,
      identifier: "PAP-REVIEW",
      title: "Review",
      status: "done",
    }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: releaseIssueId,
        assigneeAgentId: "agent-release",
        blockerIssueIds: [reviewIssueId],
        blockedTransitionAt: releaseBlockedAt,
      },
    ]);

    const res = await request(await createApp()).patch(`/api/issues/${reviewIssueId}`).send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockFindExistingIssueBlockersResolvedWakeForReadyState).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId: "company-1",
          dependentIssueId: releaseIssueId,
          blockerIssueIds: [reviewIssueId],
          blockedTransitionAt: releaseBlockedAt,
        }),
      );
      expect(mockWakeup).toHaveBeenCalledTimes(1);
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-release",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
            dependentIssueId: releaseIssueId,
            blockerIssueIds: [reviewIssueId],
            blockedTransitionAt: releaseBlockedAt,
          }),
          payload: expect.objectContaining({
            issueId: releaseIssueId,
            resolvedBlockerIssueId: reviewIssueId,
            mutation: "blocker_done",
          }),
        }),
      );
    });
  });

  it("does not enqueue a second wake when the blocker is already done", async () => {
    const reviewIssueId = "11111111-1111-4111-8111-111111111111";
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: reviewIssueId,
      identifier: "PAP-REVIEW",
      title: "Review",
      status: "done",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: reviewIssueId,
      identifier: "PAP-REVIEW",
      title: "Review",
      status: "done",
    }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "22222222-2222-4222-8222-222222222222",
        assigneeAgentId: "agent-release",
        blockerIssueIds: [reviewIssueId],
        blockedTransitionAt: new Date("2026-08-01T15:00:00.000Z"),
      },
    ]);

    const res = await request(await createApp()).patch(`/api/issues/${reviewIssueId}`).send({ status: "done" });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockWakeup).not.toHaveBeenCalled();
    expect(mockIssueService.listWakeableBlockedDependents).not.toHaveBeenCalled();
  });

  it("wakes a QA-like chain one dependent at a time after each blocker completes", async () => {
    const reviewIssueId = "11111111-1111-4111-8111-111111111111";
    const releaseIssueId = "22222222-2222-4222-8222-222222222222";
    const qaIssueId = "33333333-3333-4333-8333-333333333333";
    const releaseBlockedAt = new Date("2026-08-02T10:00:00.000Z");
    const qaBlockedAt = new Date("2026-08-02T10:05:00.000Z");
    const app = await createApp();

    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: reviewIssueId,
      identifier: "PAP-REVIEW",
      title: "Review",
      status: "in_progress",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: reviewIssueId,
      identifier: "PAP-REVIEW",
      title: "Review",
      status: "done",
    }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: releaseIssueId,
        assigneeAgentId: "agent-release",
        blockerIssueIds: [reviewIssueId],
        blockedTransitionAt: releaseBlockedAt,
      },
    ]);

    expect((await request(app).patch(`/api/issues/${reviewIssueId}`).send({ status: "done" })).status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledTimes(1);
    });
    expect(mockWakeup).toHaveBeenCalledWith(
      "agent-release",
      expect.objectContaining({
        payload: expect.objectContaining({ issueId: releaseIssueId }),
        idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: releaseIssueId,
          blockerIssueIds: [reviewIssueId],
          blockedTransitionAt: releaseBlockedAt,
        }),
      }),
    );

    mockWakeup.mockClear();
    mockFindExistingIssueBlockersResolvedWakeForReadyState.mockClear();
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: releaseIssueId,
      identifier: "PAP-RELEASE",
      title: "Release",
      status: "blocked",
      assigneeAgentId: "agent-release",
      blockedTransitionAt: releaseBlockedAt,
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: releaseIssueId,
      identifier: "PAP-RELEASE",
      title: "Release",
      status: "done",
      assigneeAgentId: "agent-release",
    }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: qaIssueId,
        assigneeAgentId: "agent-qa",
        blockerIssueIds: [releaseIssueId],
        blockedTransitionAt: qaBlockedAt,
      },
    ]);

    expect((await request(app).patch(`/api/issues/${releaseIssueId}`).send({ status: "done" })).status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledTimes(1);
    });
    expect(mockWakeup).toHaveBeenCalledWith(
      "agent-qa",
      expect.objectContaining({
        payload: expect.objectContaining({
          issueId: qaIssueId,
          resolvedBlockerIssueId: releaseIssueId,
        }),
        idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: qaIssueId,
          blockerIssueIds: [releaseIssueId],
          blockedTransitionAt: qaBlockedAt,
        }),
      }),
    );
    expect(mockWakeup).not.toHaveBeenCalledWith("agent-release", expect.anything());
  });

  it("wakes a blocked-and-ready dependent with a permanent restored-state wake key", async () => {
    const parentIssueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: parentIssueId,
      identifier: "PAP-200",
      title: "Blocked after completion",
      status: "done",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: parentIssueId,
      identifier: "PAP-200",
      title: "Blocked after completion",
      status: "blocked",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: parentIssueId,
      blockerIssueIds: [childIssueId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
    // The relation summary is empty, so the child edge is NEW in this write:
    // the resolved-set refusal carves out on the new edge and the write goes
    // through under the permanent restored-state wake key.
    const restoredStateKey = buildIssueBlockersResolvedRestoredWakeIdempotencyKey({
      dependentIssueId: parentIssueId,
      blockerIssueIds: [childIssueId],
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${parentIssueId}`)
      .send({
        status: "blocked",
        blockedByIssueIds: [childIssueId],
        unblockDescriptor: { owner: "board", action: "Review the restored dependency" },
      });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockFindExistingIssueBlockersResolvedWakeForAnyKey).toHaveBeenCalledWith(
        expect.anything(),
        { companyId: "company-1", idempotencyKeys: [restoredStateKey] },
      );
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          idempotencyKey: restoredStateKey,
          payload: expect.objectContaining({
            mutation: "blocked_dependency_restored",
          }),
        }),
      );
    });
    expect(mockFindExistingIssueBlockersResolvedWakeForReadyState).not.toHaveBeenCalled();
  });

  it("refuses re-blocking onto the same already-resolved blocker set (re-block replay)", async () => {
    const dependentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-REPLAY",
      title: "Re-block replay",
      status: "in_progress",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-REPLAY",
      title: "Re-block replay",
      status: "blocked",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: childId }],
      blocks: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: dependentId,
      blockerIssueIds: [childId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${dependentId}`)
      .send({
        status: "blocked",
        blockedByIssueIds: [childId],
        unblockDescriptor: { owner: "board", action: "Re-apply the restored dependency" },
      });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: "Cannot block on a blocker set that is already fully resolved. Move the issue forward, or add a blocker that is not done.",
      details: { reason: "blocked_on_resolved_blockers" },
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("refuses re-applying the same resolved blocker set while the issue is already blocked", async () => {
    const dependentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-REPLAY",
      title: "Re-block replay",
      status: "blocked",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-REPLAY",
      title: "Re-block replay",
      status: "blocked",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: childId }],
      blocks: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: dependentId,
      blockerIssueIds: [childId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });

    // No status field: the blockedByIssueIds write alone is a block intent.
    const res = await request(await createApp())
      .patch(`/api/issues/${dependentId}`)
      .send({ blockedByIssueIds: [childId] });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ details: { reason: "blocked_on_resolved_blockers" } });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("refuses entering blocked on an all-done set named only by readiness", async () => {
    const dependentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-REPLAY",
      title: "Re-block replay",
      status: "todo",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: dependentId,
      blockerIssueIds: [childId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });

    // No blockedByIssueIds: the refusal must still fire off readiness alone.
    const res = await request(await createApp())
      .patch(`/api/issues/${dependentId}`)
      .send({
        status: "blocked",
        unblockDescriptor: { owner: "board", action: "Re-apply the restored dependency" },
      });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ details: { reason: "blocked_on_resolved_blockers" } });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("still allows a first block on a live blocker and wakes once under the restored-state key", async () => {
    const dependentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-FRESH",
      title: "Fresh block on a live blocker",
      status: "todo",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-FRESH",
      title: "Fresh block on a live blocker",
      status: "blocked",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: dependentId,
      blockerIssueIds: [childId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
    // The live-blocker row survives the not-done query, so the entering-blocked
    // gate and the resolved-set refusal both pass without a descriptor.
    const tableRows: RouteTestTableRows = {
      issues: [{ id: childId, companyId: "company-1", status: "in_progress" }],
    };
    const restoredStateKey = buildIssueBlockersResolvedRestoredWakeIdempotencyKey({
      dependentIssueId: dependentId,
      blockerIssueIds: [childId],
    });

    const res = await request(await createApp({ tableRows }))
      .patch(`/api/issues/${dependentId}`)
      .send({ status: "blocked", blockedByIssueIds: [childId] });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledTimes(1);
    });
    expect(mockWakeup).toHaveBeenCalledWith(
      "agent-2",
      expect.objectContaining({
        idempotencyKey: restoredStateKey,
        payload: expect.objectContaining({ mutation: "blocked_dependency_restored" }),
      }),
    );
  });

  it("does not re-arm the restored wake when a permanent wake already exists for the set", async () => {
    const dependentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-FRESH",
      title: "Fresh block on a live blocker",
      status: "in_progress",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-FRESH",
      title: "Fresh block on a live blocker",
      status: "blocked",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: dependentId,
      blockerIssueIds: [childId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
    // The operator cleared the edges, so the refusal's new-edge carve-out
    // allows the write — but the permanent restored-state dedup still holds.
    mockFindExistingIssueBlockersResolvedWakeForAnyKey.mockResolvedValue({
      id: "prior-wake",
      status: "completed",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${dependentId}`)
      .send({
        status: "blocked",
        blockedByIssueIds: [childId],
        unblockDescriptor: { owner: "board", action: "Re-apply the restored dependency" },
      });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockFindExistingIssueBlockersResolvedWakeForAnyKey).toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("does not wake the dependent assignee when the assignee agent re-parks its own issue", async () => {
    const dependentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const newChildId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-SELF",
      title: "Self re-park",
      status: "blocked",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-SELF",
      title: "Self re-park",
      status: "blocked",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: childId }],
      blocks: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: dependentId,
      blockerIssueIds: [childId, newChildId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
    const actorRunId = "44444444-4444-4444-8444-444444444444";
    const actor = {
      type: "agent",
      agentId: "agent-2",
      companyId: "company-1",
      companyIds: ["company-1"],
      runId: actorRunId,
      source: "agent_key",
      agentApiKeyId: "key-1",
    };
    // The cross-issue attribution guard resolves the run and anchors it to
    // this issue, so the write counts as the run's own issue (no cap insert).
    const tableRows: RouteTestTableRows = {
      heartbeat_runs: [
        {
          id: actorRunId,
          companyId: "company-1",
          agentId: "agent-2",
          status: "running",
          contextSnapshot: { issueId: dependentId },
        },
      ],
    };

    // The new edge (newChildId) carves the resolved-set refusal out, so the
    // write is allowed — but the assignee's own PATCH must not wake it.
    const res = await request(await createApp({ actor, tableRows }))
      .patch(`/api/issues/${dependentId}`)
      .send({ blockedByIssueIds: [childId, newChildId] });

    expect(res.status).toBe(200);
    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("still wakes the assignee when a board actor parks the issue on a resolved set via a new edge", async () => {
    const dependentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const newChildId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-BOARD",
      title: "Board re-park",
      status: "blocked",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-BOARD",
      title: "Board re-park",
      status: "blocked",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: childId }],
      blocks: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: dependentId,
      blockerIssueIds: [childId, newChildId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
    const restoredStateKey = buildIssueBlockersResolvedRestoredWakeIdempotencyKey({
      dependentIssueId: dependentId,
      blockerIssueIds: [childId, newChildId],
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${dependentId}`)
      .send({ blockedByIssueIds: [childId, newChildId] });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          idempotencyKey: restoredStateKey,
          payload: expect.objectContaining({ mutation: "blocked_dependency_restored" }),
        }),
      );
    });
  });

  it("allows re-blocking a resolved set while a pending interaction holds the card", async () => {
    const dependentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-PENDING",
      title: "Waiting on a human",
      status: "blocked",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-PENDING",
      title: "Waiting on a human",
      status: "blocked",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: childId }],
      blocks: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: dependentId,
      blockerIssueIds: [childId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
    const tableRows: RouteTestTableRows = {
      issue_thread_interactions: [
        { id: "itx-1", companyId: "company-1", issueId: dependentId, status: "pending" },
      ],
    };

    const res = await request(await createApp({ tableRows }))
      .patch(`/api/issues/${dependentId}`)
      .send({ blockedByIssueIds: [childId] });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("allows re-blocking when the set still holds a not-done blocker", async () => {
    const dependentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-LIVE",
      title: "Live blocker control",
      status: "in_progress",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-LIVE",
      title: "Live blocker control",
      status: "blocked",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: childId }],
      blocks: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: dependentId,
      blockerIssueIds: [childId],
      unresolvedBlockerIssueIds: [childId],
      unresolvedBlockerCount: 1,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: false,
      isDependencyReady: false,
    });
    const tableRows: RouteTestTableRows = {
      issues: [{ id: childId, companyId: "company-1", status: "in_progress" }],
    };

    const res = await request(await createApp({ tableRows }))
      .patch(`/api/issues/${dependentId}`)
      .send({ status: "blocked", blockedByIssueIds: [childId] });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("does not emit a dependency wake when an unresolved or cancelled blocker remains", async () => {
    mockIssueService.getById.mockResolvedValue(issueRecord({ status: "in_progress" }));
    mockIssueService.update.mockResolvedValue(issueRecord({ status: "done" }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockWakeup).not.toHaveBeenCalled();
  });
});
