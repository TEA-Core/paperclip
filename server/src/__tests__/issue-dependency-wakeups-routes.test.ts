import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildIssueBlockersResolvedWakeStateKey } from "../services/issue-dependency-wakeups.ts";
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

const mockWakeup = vi.hoisted(() =>
  vi.fn(async (_agentId: string, _wakeup?: Record<string, unknown>) => undefined),
);
const mockLogActivity = vi.hoisted(() =>
  vi.fn(async (_db: unknown, _activity: { action?: string }) => undefined),
);
const mockFindExistingIssueBlockersResolvedWakeForReadyState = vi.hoisted(() => vi.fn(async () => null));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  checkout: vi.fn(),
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

vi.mock("../services/issue-dependency-wakeups.js", async () => {
  const actual = await vi.importActual<typeof import("../services/issue-dependency-wakeups.js")>(
    "../services/issue-dependency-wakeups.js",
  );
  return {
    ...actual,
    findExistingIssueBlockersResolvedWakeForReadyState:
      mockFindExistingIssueBlockersResolvedWakeForReadyState,
  };
});

type RouteTestTableRows = Record<string, Record<string, unknown>[]>;

function applyIssueStatusPredicates(rows: unknown[], condition: unknown): unknown[] {
  const predicates: Array<(row: Record<string, unknown>) => boolean> = [];
  const visit = (value: any): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value.queryChunks)) return;
    const chunks = value.queryChunks;
    const statusIndex = chunks.findIndex((chunk: any) => chunk?.name === "status" && chunk?.table);
    if (statusIndex >= 0) {
      const operator = chunks[statusIndex + 1]?.value?.join("").trim();
      const rawValues = chunks[statusIndex + 2];
      const values = (Array.isArray(rawValues) ? rawValues : [rawValues]).map((param) => param?.value);
      if (operator === "=" || operator === "in") {
        predicates.push((row) => values.includes(row.status));
      } else if (operator === "<>") {
        predicates.push((row) => row.status !== values[0]);
      } else if (operator === "not in") {
        predicates.push((row) => !values.includes(row.status));
      } else {
        throw new Error(`Unsupported issue status predicate in route test: ${operator}`);
      }
    }
    chunks.forEach(visit);
  };
  visit(condition);
  return rows.filter((row) => predicates.every((predicate) => predicate(row as Record<string, unknown>)));
}

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
      let tableName = "";
      const whereResult = {
        for: vi.fn(() => whereResult),
        limit: vi.fn(async () => rows),
        orderBy: vi.fn(() => whereResult),
        then: async (resolve: (rows: unknown[]) => unknown) => resolve(rows),
      };
      const query: Record<string, unknown> = {};
      query.innerJoin = vi.fn(() => query);
      query.where = vi.fn((condition: unknown) => {
        if (tableName === "issues") rows = applyIssueStatusPredicates(rows, condition);
        return whereResult;
      });
      return {
        from: vi.fn((table: object) => {
          tableName = String((table as Record<symbol, unknown>)[Symbol.for("drizzle:Name")] ?? "");
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
    mockWakeup.mockImplementation(async () => undefined);
    mockFindExistingIssueBlockersResolvedWakeForReadyState.mockResolvedValue(null);
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

  it("refuses to enter blocked on an already-done blocker even with an unblock descriptor", async () => {
    const { dependentId, childId } = mockDependencyPatch({ status: "todo" });

    const res = await request(await createApp({
      tableRows: { issues: [{ id: childId, companyId: "company-1", status: "done" }] },
    }))
      .patch(`/api/issues/${dependentId}`)
      .send({
        status: "blocked",
        blockedByIssueIds: [childId],
        unblockDescriptor: { owner: "board", action: "Review the restored dependency" },
      });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ details: { reason: "blocked_on_resolved_blockers" } });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("refuses to rewrite a blocked issue to a different done blocker", async () => {
    const newBlockerId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const { dependentId } = mockDependencyPatch({
      status: "blocked",
      blockerIssueIds: [newBlockerId],
      existingBlockerIssueIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    });

    const res = await request(await createApp({
      tableRows: { issues: [{ id: newBlockerId, companyId: "company-1", status: "done" }] },
    }))
      .patch(`/api/issues/${dependentId}`)
      .send({ blockedByIssueIds: [newBlockerId] });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ details: { reason: "blocked_on_resolved_blockers" } });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
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

  function mockDependencyPatch(options: {
    status?: string;
    updatedStatus?: string;
    blockerIssueIds?: string[];
    existingBlockerIssueIds?: string[];
    unresolvedBlockerIssueIds?: string[];
    assigneeAgentId?: string;
  } = {}) {
    const dependentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const blockerIssueIds = options.blockerIssueIds ?? [childId];
    const existingBlockerIssueIds = options.existingBlockerIssueIds ?? blockerIssueIds;
    const unresolvedBlockerIssueIds = options.unresolvedBlockerIssueIds ?? [];
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-DEPENDENT",
      title: "Dependent",
      status: options.status ?? "in_progress",
      assigneeAgentId: options.assigneeAgentId ?? "agent-2",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-DEPENDENT",
      title: "Dependent",
      status: options.updatedStatus ?? "blocked",
      assigneeAgentId: options.assigneeAgentId ?? "agent-2",
      blockedTransitionAt: new Date("2026-08-01T12:00:00.000Z"),
    }));
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: existingBlockerIssueIds.map((id) => ({ id })),
      blocks: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: dependentId,
      blockerIssueIds,
      unresolvedBlockerIssueIds,
      unresolvedBlockerCount: unresolvedBlockerIssueIds.length,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: unresolvedBlockerIssueIds.length === 0,
      isDependencyReady: unresolvedBlockerIssueIds.length === 0,
    });
    return { dependentId, childId };
  }

  it("wakes a Release-like dependent after a terminal reset using the stable ready-state key", async () => {
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

  it("refuses three all-done re-block PATCHes without any wake-driven checkout", async () => {
    const assigneeAgentId = "55555555-5555-4555-8555-555555555555";
    const { dependentId, childId } = mockDependencyPatch({
      existingBlockerIssueIds: [],
      assigneeAgentId,
    });
    mockIssueService.checkout.mockResolvedValue(issueRecord({
      id: dependentId,
      status: "in_progress",
      assigneeAgentId,
    }));
    const app = await createApp();
    const checkoutResponseStatuses: number[] = [];
    mockWakeup.mockImplementation(async (agentId, wakeup) => {
      if (wakeup?.reason !== "issue_blockers_resolved") return;
      const checkoutResponse = await request(app)
        .post(`/api/issues/${dependentId}/checkout`)
        .send({ agentId, expectedStatuses: ["todo", "in_progress", "blocked"] });
      checkoutResponseStatuses.push(checkoutResponse.status);
    });

    const responses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      responses.push(await request(app)
        .patch(`/api/issues/${dependentId}`)
        .send({
          status: "blocked",
          blockedByIssueIds: [childId],
          unblockDescriptor: { owner: "board", action: "Replay the resolved dependency" },
        }));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(checkoutResponseStatuses).toEqual([]);
    expect(
      mockLogActivity.mock.calls.filter(([, activity]) => activity.action === "issue.checked_out"),
    ).toHaveLength(0);
    expect(responses.map((response) => response.status)).toEqual([422, 422, 422]);
    for (const response of responses) {
      expect(response.body).toMatchObject({ details: { reason: "blocked_on_resolved_blockers" } });
    }
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("refuses an assignee agent's re-park on a newly added done blocker without a self-wake", async () => {
    const { dependentId, childId } = mockDependencyPatch({
      status: "blocked",
      existingBlockerIssueIds: [],
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
    const tableRows: RouteTestTableRows = {
      heartbeat_runs: [{
        id: actorRunId,
        companyId: "company-1",
        agentId: "agent-2",
        status: "running",
        contextSnapshot: { issueId: dependentId },
      }],
    };

    const res = await request(await createApp({ actor, tableRows }))
      .patch(`/api/issues/${dependentId}`)
      .send({ blockedByIssueIds: [childId] });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ details: { reason: "blocked_on_resolved_blockers" } });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it.each([
    ["interaction", { issue_thread_interactions: [{ id: "itx-1", status: "pending" }] }],
    ["approval", { issue_approvals: [{ approvalId: "approval-1", status: "pending" }] }],
  ])("refuses an all-done blocked write while a pending %s exists", async (_kind, tableRows) => {
    const { dependentId, childId } = mockDependencyPatch({ status: "blocked" });

    const res = await request(await createApp({ tableRows }))
      .patch(`/api/issues/${dependentId}`)
      .send({ blockedByIssueIds: [childId] });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ details: { reason: "blocked_on_resolved_blockers" } });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("refuses entering blocked on an all-done set named only by readiness", async () => {
    const { dependentId } = mockDependencyPatch({ status: "todo" });

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

  it("allows a descriptor-backed blocked state with no dependency blockers", async () => {
    const { dependentId } = mockDependencyPatch({
      status: "todo",
      blockerIssueIds: [],
      existingBlockerIssueIds: [],
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${dependentId}`)
      .send({
        status: "blocked",
        unblockDescriptor: { owner: "board", action: "Wait for an operator decision" },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("refuses an explicit blocked-status replay without repeating blocker IDs", async () => {
    const { dependentId } = mockDependencyPatch({ status: "blocked" });

    const res = await request(await createApp())
      .patch(`/api/issues/${dependentId}`)
      .send({ status: "blocked" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ details: { reason: "blocked_on_resolved_blockers" } });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("refuses a descriptor-only replay of an all-done blocked issue", async () => {
    const { dependentId } = mockDependencyPatch({ status: "blocked" });

    const res = await request(await createApp())
      .patch(`/api/issues/${dependentId}`)
      .send({ unblockDescriptor: { owner: "board", action: "Keep waiting on resolved work" } });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ details: { reason: "blocked_on_resolved_blockers" } });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.each([
    { startingStatus: "todo", write: { status: "blocked" } },
    { startingStatus: "blocked", write: {} },
  ])("allows a $startingStatus issue to retain a done blocker with pending finalization", async ({ startingStatus, write }) => {
    const { dependentId, childId } = mockDependencyPatch({ status: startingStatus });
    const executionWorkspaceId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: dependentId,
      blockerIssueIds: [childId],
      unresolvedBlockerIssueIds: [childId],
      unresolvedBlockerCount: 1,
      pendingFinalizeBlockerIssueIds: [childId],
      allBlockersDone: false,
      isDependencyReady: false,
    });
    const tableRows: RouteTestTableRows = {
      issues: [{
        id: childId,
        companyId: "company-1",
        status: "done",
        executionWorkspaceId,
      }],
      workspace_operations: [{
        companyId: "company-1",
        issueId: childId,
        executionWorkspaceId,
        phase: "workspace_finalize",
        status: "running",
        startedAt: new Date("2026-08-01T12:00:00.000Z"),
      }],
    };

    const res = await request(await createApp({ tableRows }))
      .patch(`/api/issues/${dependentId}`)
      .send({ ...write, blockedByIssueIds: [childId] });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("allows a blocked issue to retain a cancelled blocker", async () => {
    const { dependentId, childId } = mockDependencyPatch({
      status: "blocked",
      unresolvedBlockerIssueIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    });
    const tableRows: RouteTestTableRows = {
      issues: [{ id: childId, companyId: "company-1", status: "cancelled" }],
    };

    const res = await request(await createApp({ tableRows }))
      .patch(`/api/issues/${dependentId}`)
      .send({ blockedByIssueIds: [childId] });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("allows re-blocking when the set still holds a not-done blocker", async () => {
    const { dependentId, childId } = mockDependencyPatch({
      unresolvedBlockerIssueIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
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
