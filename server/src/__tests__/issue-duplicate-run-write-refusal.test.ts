import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const holderAgentId = "33333333-3333-4333-8333-333333333333";
const peerAgentId = "44444444-4444-4444-8444-444444444444";
const holderRunId = "55555555-5555-4555-8555-555555555555";
const duplicateRunId = "66666666-6666-4666-8666-666666666666";
const peerRunId = "77777777-7777-4777-8777-777777777777";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getRelationSummaries: vi.fn(),
  findMentionedAgents: vi.fn(),
  list: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  isManagerOf: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  upsertIssueDocument: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  createForIssue: vi.fn(),
  getById: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
}));

const mockStorageService = vi.hoisted(() => ({
  provider: "local_disk",
  putFile: vi.fn(),
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(async () => []),
  listForIssue: vi.fn(async () => []),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  link: vi.fn(),
  unlink: vi.fn(),
  listApprovalsForIssue: vi.fn(async () => []),
}));

const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  listActiveForIssues: vi.fn(async () => new Map()),
  resolveActiveForIssue: vi.fn(async () => null),
}));

const mockTaskWatchdogService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  revalidateMutationScope: vi.fn(async () => ({
    allowed: true,
    classification: { state: "stopped", stopFingerprint: "task_watchdog_stop:test" },
  })),
  reconcileForIssueAndAncestors: vi.fn(async () => ({
    checked: 0,
    triggered: 0,
    skipped: 0,
    watchdogIssueIds: [],
  })),
  upsertForIssue: vi.fn(),
  disableForIssue: vi.fn(async () => null),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockExternalObjectService = vi.hoisted(() => ({
  getIssueSummaries: vi.fn(async () => new Map()),
  getIssueSummary: vi.fn(async () => ({
    authRequiredCount: 0,
    byLiveness: {},
    byStatusCategory: {},
    highestSeverity: "muted",
    objects: [],
    staleCount: 0,
    total: 0,
    unreachableCount: 0,
  })),
  getProjectSummary: vi.fn(async () => ({
    authRequiredCount: 0,
    byLiveness: {},
    byStatusCategory: {},
    highestSeverity: "muted",
    objects: [],
    staleCount: 0,
    total: 0,
    unreachableCount: 0,
  })),
  listForIssue: vi.fn(async () => []),
  refreshIssueObjects: vi.fn(async () => []),
  syncCommentSafely: vi.fn(async () => undefined),
  syncDocumentSafely: vi.fn(async () => undefined),
  syncIssueSafely: vi.fn(async () => undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockObserveCrossIssueInfluence = vi.hoisted(() => vi.fn(async () => null));

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/documents.js", () => ({
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => mockDocumentService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
    ORPHANED_DUPLICATE_RUN_CONFLICT_CODE: "orphaned_duplicate_run",
  }));

  vi.doMock("../services/work-products.js", () => ({
    workProductService: () => mockWorkProductService,
  }));

  vi.doMock("../services/external-objects.js", () => ({
    externalObjectService: () => mockExternalObjectService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/cross-issue-influence-limit.js", () => ({
    observeCrossIssueInfluence: mockObserveCrossIssueInfluence,
    crossIssueInfluenceLimitError: vi.fn(),
    crossIssueInfluenceRunContextError: () => new HttpError(
      403,
      "Agent issue comments and updates require a valid heartbeat run so cross-issue influence can be contained",
      { code: "cross_issue_influence_run_context_required" },
    ),
  }));

  vi.doMock("../services/index.js", () => ({
    ISSUE_LIST_DEFAULT_LIMIT: 100,
    ISSUE_LIST_MAX_LIMIT: 500,
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    clampIssueListLimit: (value: number) => Math.min(Math.max(value, 1), 500),
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    companyService: () => mockCompanyService,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => mockDocumentService,
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
      listCompanyIds: vi.fn(async () => [companyId]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
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
    taskWatchdogService: () => mockTaskWatchdogService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => mockWorkProductService,
  }));
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_progress",
    priority: "high",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: holderAgentId,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "PAP-1649",
    title: "Owned active issue",
    checkoutRunId: null,
    executionRunId: null,
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

function makeAgent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId,
    role: "engineer",
    reportsTo: null,
    permissions: { canCreateAgents: false },
    ...overrides,
  };
}

function createRunContextDb(
  contextSnapshot: Record<string, unknown> = {},
  runAgentOrRows: string | Record<string, unknown>[] = holderAgentId,
  runId: string = holderRunId,
) {
  const runRows = Array.isArray(runAgentOrRows)
    ? runAgentOrRows
    : [{
        id: runId,
        companyId,
        agentId: runAgentOrRows,
        agentCompanyId: companyId,
        contextSnapshot,
      }];
  const firstRun = runRows[0] ?? {};
  const runAgentId = typeof firstRun.agentId === "string" ? firstRun.agentId : holderAgentId;
  const runAgentCompanyId = typeof firstRun.agentCompanyId === "string" ? firstRun.agentCompanyId : companyId;
  const rowsForSelection = (selection: Record<string, unknown>) => {
    const keys = Object.keys(selection);
    if (keys.includes("entityId")) return [];
    if (keys.includes("sourceIssueId")) return [];
    if (keys.includes("contextSnapshot")) return runRows;
    if (keys.includes("agentCompanyId")) return runRows;
    return [{ id: runAgentId, companyId: runAgentCompanyId, permissions: {}, role: "engineer", reportsTo: null }];
  };
  const buildQuery = (selection: Record<string, unknown>) => {
    const rows = rowsForSelection(selection);
    const whereResult = {
      orderBy: vi.fn(async () => []),
      limit: vi.fn(() => ({
        then: async (resolve: (limitedRows: unknown[]) => unknown) => resolve(rows),
      })),
      then: async (resolve: (selectedRows: unknown[]) => unknown) => resolve(rows),
    };
    const query = {
      innerJoin: vi.fn(() => query),
      where: vi.fn(() => whereResult),
    };
    return query;
  };
  return {
    transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({}),
    select: vi.fn((selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => buildQuery(selection)),
    })),
  };
}

async function createApp(actor: Record<string, unknown>, db?: unknown) {
  const routeDb = db ?? createRunContextDb(
    {},
    typeof actor.agentId === "string" ? actor.agentId : holderAgentId,
    typeof actor.runId === "string" ? actor.runId : holderRunId,
  );
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(routeDb as any, mockStorageService as any));
  app.use(errorHandler);
  return app;
}

function holderActor() {
  return {
    type: "agent",
    agentId: holderAgentId,
    companyId,
    source: "agent_key",
    runId: holderRunId,
  };
}

function duplicateActor() {
  return {
    type: "agent",
    agentId: holderAgentId,
    companyId,
    source: "agent_key",
    runId: duplicateRunId,
  };
}

function peerActor() {
  return {
    type: "agent",
    agentId: peerAgentId,
    companyId,
    source: "agent_key",
    runId: peerRunId,
  };
}

function boardActor() {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

function holderRunRow(status: string = "running") {
  return {
    id: holderRunId,
    companyId,
    agentId: holderAgentId,
    status,
  };
}

describe("SUP-14303 duplicate same-agent run first-write refusal", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/cross-issue-influence-limit.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/external-objects.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/work-products.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockAccessService.canUser.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed:
        input.action === "tasks:assign" ||
        input.action === "issue:comment" ||
        input.action === "issue:read" ||
        input.action === "issue:mutate" ||
        input.action === "company_scope:read",
      action: input.action,
      reason:
        input.action === "tasks:assign" ||
          input.action === "issue:comment" ||
          input.action === "issue:read" ||
          input.action === "issue:mutate" ||
          input.action === "company_scope:read"
          ? "allow_explicit_grant"
          : "deny_missing_grant",
      explanation:
        input.action === "tasks:assign" ||
          input.action === "issue:comment" ||
          input.action === "issue:read" ||
          input.action === "issue:mutate" ||
          input.action === "company_scope:read"
          ? "Allowed by test default."
          : "Missing permission.",
    }));
    mockAccessService.hasPermission.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockCompanyService.getById.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.getByIdentifier.mockReset();
    mockIssueService.getById.mockReset();
    mockIssueService.getDependencyReadiness.mockReset();
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      blockerIssueIds: [],
      isDependencyReady: false,
      unresolvedBlockerCount: 0,
    });
    mockIssueService.getRelationSummaries.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.list.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueService.update.mockReset();
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockReset();
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireStaleRequestConfirmationsForIssueDocument.mockReset();
    mockIssueThreadInteractionService.expireStaleRequestConfirmationsForIssueDocument.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByHistoricalComments.mockReset();
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByHistoricalComments.mockResolvedValue([]);
    mockIssueThreadInteractionService.listForIssue.mockReset();
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueRecoveryActionService.getActiveForIssue.mockReset();
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueRecoveryActionService.listActiveForIssues.mockReset();
    mockIssueRecoveryActionService.listActiveForIssues.mockResolvedValue(new Map());
    mockIssueRecoveryActionService.resolveActiveForIssue.mockReset();
    mockTaskWatchdogService.getActiveForIssue.mockReset();
    mockTaskWatchdogService.getActiveForIssue.mockResolvedValue(null);
    mockTaskWatchdogService.revalidateMutationScope.mockReset();
    mockTaskWatchdogService.revalidateMutationScope.mockResolvedValue({
      allowed: true,
      classification: { state: "stopped", stopFingerprint: "task_watchdog_stop:test" },
    });
    mockTaskWatchdogService.reconcileForIssueAndAncestors.mockReset();
    mockTaskWatchdogService.reconcileForIssueAndAncestors.mockResolvedValue({
      checked: 0,
      triggered: 0,
      skipped: 0,
      watchdogIssueIds: [],
    });
    mockTaskWatchdogService.upsertForIssue.mockReset();
    mockTaskWatchdogService.disableForIssue.mockReset();
    mockTaskWatchdogService.disableForIssue.mockResolvedValue(null);
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockReset();
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockIssueApprovalService.link.mockReset();
    mockIssueApprovalService.unlink.mockReset();
    mockIssueApprovalService.listApprovalsForIssue.mockReset();
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockLogActivity.mockClear();
    mockObserveCrossIssueInfluence.mockReset();
    mockObserveCrossIssueInfluence.mockResolvedValue(null);
    mockDocumentService.upsertIssueDocument.mockReset();
    mockWorkProductService.createForIssue.mockReset();
    mockWorkProductService.getById.mockReset();
    mockWorkProductService.remove.mockReset();
    mockWorkProductService.update.mockReset();
    mockStorageService.putFile.mockReset();
    mockStorageService.getObject.mockReset();
    mockStorageService.headObject.mockReset();
    mockStorageService.deleteObject.mockReset();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === holderAgentId) return makeAgent(holderAgentId);
      if (id === peerAgentId) return makeAgent(peerAgentId);
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      makeAgent(holderAgentId),
      makeAgent(peerAgentId),
    ]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockCompanyService.getById.mockResolvedValue({ id: companyId, issuePrefix: "PAP" });
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.addComment.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      issueId,
      companyId,
      body: "comment",
    });
  });

  it("refuses a duplicate same-agent run's first comment with a 409 orphaned_duplicate_run", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "in_progress", executionRunId: holderRunId }),
    );
    mockHeartbeatService.getRun.mockImplementation(async (runId: string) =>
      runId === holderRunId ? holderRunRow("running") : null,
    );

    const res = await request(await createApp(duplicateActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Status update from the duplicate run." });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Issue run ownership conflict");
    expect(res.body.details.code).toBe("orphaned_duplicate_run");
    expect(res.body.details.holderRunId).toBe(holderRunId);
    expect(res.body.details.actorRunId).toBe(duplicateRunId);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it.each(["todo", "in_progress", "blocked", "in_review"] as const)(
    "refuses a duplicate same-agent run's PATCH when the issue status is %s",
    async (status) => {
      mockIssueService.getById.mockResolvedValue(
        makeIssue({ status, executionRunId: holderRunId }),
      );
      mockHeartbeatService.getRun.mockImplementation(async (runId: string) =>
        runId === holderRunId ? holderRunRow("running") : null,
      );

      const res = await request(await createApp(duplicateActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ title: "Updated by the duplicate run" });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toBe("Issue run ownership conflict");
      expect(res.body.details.code).toBe("orphaned_duplicate_run");
      expect(res.body.details.holderRunId).toBe(holderRunId);
      expect(res.body.details.status).toBe(status);
      expect(mockIssueService.update).not.toHaveBeenCalled();
    },
  );

  it("leaves cross-agent writes on the existing denial path", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "in_progress", executionRunId: holderRunId }),
    );
    mockHeartbeatService.getRun.mockImplementation(async (runId: string) =>
      runId === holderRunId ? holderRunRow("running") : null,
    );

    const res = await request(await createApp(peerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Updated by a peer" });

    // The pre-existing assignee run-lock denial, not the new duplicate code.
    expect(res.status).toBe(409);
    expect(res.body.details.code).toBe("issue_write_assignee_run_lock");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("leaves a different agent's comment on a live holder issue unaffected", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "in_progress", executionRunId: holderRunId }),
    );
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "issue:comment" || input.action === "issue:read",
      action: input.action,
      reason: input.action === "issue:comment" ? "allow_issue_mention_grant" : "allow_explicit_grant",
      explanation: "Allowed by test default.",
    }));
    mockHeartbeatService.getRun.mockImplementation(async (runId: string) =>
      runId === holderRunId ? holderRunRow("running") : null,
    );

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Peer comment while the holder is running." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalled();
  });

  it.each(["queued", "succeeded"] as const)(
    "leaves the existing path intact when the holder run is %s",
    async (holderStatus) => {
      mockIssueService.getById.mockResolvedValue(
        makeIssue({ status: "todo", executionRunId: holderRunId }),
      );
      mockHeartbeatService.getRun.mockImplementation(async (runId: string) =>
        runId === holderRunId ? holderRunRow(holderStatus) : null,
      );

      const res = await request(await createApp(duplicateActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ title: "Updated while the holder is not running" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalled();
    },
  );

  it("leaves the holder run's own writes unaffected", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "in_progress", executionRunId: holderRunId }),
    );
    mockHeartbeatService.getRun.mockImplementation(async (runId: string) =>
      runId === holderRunId ? holderRunRow("running") : null,
    );
    const app = await createApp(holderActor());

    const patchRes = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Updated by the holder" });
    expect(patchRes.status, JSON.stringify(patchRes.body)).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(issueId, holderAgentId, holderRunId);

    const commentRes = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Holder comment." });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);
  });

  it("leaves actors without a run id on the existing path", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "todo", executionRunId: holderRunId }),
    );
    mockHeartbeatService.getRun.mockImplementation(async (runId: string) =>
      runId === holderRunId ? holderRunRow("running") : null,
    );

    const res = await request(
      await createApp({ type: "agent", agentId: holderAgentId, companyId, source: "agent_key" }),
    )
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Updated without a run id" });

    // The duplicate guard is out of scope for actors without a run id: it must
    // never consult the holder run, and the write is handled by the pre-existing
    // cross-issue-influence gate (context-less run refusal), not the new 409.
    expect(res.body.details?.code).not.toBe("orphaned_duplicate_run");
    expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("does not fire when the issue has no executionRunId", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "in_progress", executionRunId: null }),
    );

    const res = await request(await createApp(duplicateActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Updated on an unbound issue" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(issueId, holderAgentId, duplicateRunId);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("leaves board writes on a duplicate-held issue unaffected", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "in_progress", executionRunId: holderRunId }),
    );
    mockHeartbeatService.getRun.mockImplementation(async (runId: string) =>
      runId === holderRunId ? holderRunRow("running") : null,
    );

    const res = await request(await createApp(boardActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Updated by the board" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });
});
