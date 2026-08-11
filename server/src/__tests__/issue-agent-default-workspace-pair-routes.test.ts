import type { Server } from "node:http";
import express from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  getByIdentifier: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockIssueReferenceService = vi.hoisted(() => ({
  deleteDocumentSource: vi.fn(async () => undefined),
  diffIssueReferenceSummary: vi.fn(() => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  })),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  syncIssue: vi.fn(async () => undefined),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeEnvBindingsForPersistence: vi.fn(async (_companyId: string, env: Record<string, unknown>) => env),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  projectService: () => ({}),
  issueService: () => mockIssueService,
  companyService: () => mockCompanyService,
  environmentService: () => mockEnvironmentService,
  issueReferenceService: () => mockIssueReferenceService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => ({}),
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
  executionWorkspaceService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    getRun: vi.fn(),
    getActiveRunForAgent: vi.fn(),
    getRunById: vi.fn(),
  }),
  issueApprovalService: () => ({
    listApprovalsForIssue: vi.fn(),
    unlink: vi.fn(),
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  documentService: () => ({}),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  routineService: () => ({}),
  workProductService: () => ({}),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

function buildApp(routerFactory: (app: express.Express) => void) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    };
    next();
  });
  routerFactory(app);
  app.use(errorHandler);
  return app;
}

let issueServer: Server | null = null;

function createIssueApp() {
  issueServer ??= buildApp((expressApp) => {
    expressApp.use("/api", issueRoutes({} as any, {} as any));
  }).listen(0);
  return issueServer;
}

async function closeServer(server: Server | null) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

describe.sequential("issue PATCH agent_default / projectWorkspaceId pair guard", () => {
  afterAll(async () => {
    await closeServer(issueServer);
    issueServer = null;
  });

  beforeEach(() => {
    mockIssueService.create.mockReset();
    mockIssueService.getById.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.getByIdentifier.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockCompanyService.getById.mockReset();
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      attachmentMaxBytes: 10 * 1024 * 1024,
    });
    mockEnvironmentService.getById.mockReset();
    mockIssueReferenceService.deleteDocumentSource.mockClear();
    mockIssueReferenceService.diffIssueReferenceSummary.mockClear();
    mockIssueReferenceService.emptySummary.mockClear();
    mockIssueReferenceService.listIssueReferenceSummary.mockClear();
    mockIssueReferenceService.syncComment.mockClear();
    mockIssueReferenceService.syncDocument.mockClear();
    mockIssueReferenceService.syncIssue.mockClear();
    mockSecretService.normalizeEnvBindingsForPersistence.mockClear();
    mockLogActivity.mockReset();
  });

  it("rejects a PATCH that would leave executionWorkspacePreference agent_default with a non-null projectWorkspaceId", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      projectId: "project-1",
      projectWorkspaceId: "11111111-1111-4111-8111-111111111111",
      executionWorkspacePreference: "agent_default",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: null,
      identifier: "PAPA-999",
    });
    const app = createIssueApp();

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({ title: "Touched" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("executionWorkspacePreference");
    expect(res.body.error).toContain("projectWorkspaceId");
    expect(res.body.error).toContain("agent_default");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects setting projectWorkspaceId on an issue that already prefers agent_default", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      executionWorkspacePreference: "agent_default",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: null,
      identifier: "PAPA-999",
    });
    const app = createIssueApp();

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({ projectWorkspaceId: "11111111-1111-4111-8111-111111111111" });

    expect(res.status).toBe(400);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects setting executionWorkspacePreference to agent_default on an issue bound to a project workspace", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      projectWorkspaceId: "11111111-1111-4111-8111-111111111111",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: null,
      identifier: "PAPA-999",
    });
    const app = createIssueApp();

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({ executionWorkspacePreference: "agent_default" });

    expect(res.status).toBe(400);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("accepts executionWorkspacePreference agent_default on its own", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: null,
      identifier: "PAPA-999",
    });
    mockIssueService.update.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      status: "todo",
      identifier: "PAPA-999",
    });
    const app = createIssueApp();

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({ executionWorkspacePreference: "agent_default" });

    expect(res.status).not.toBe(400);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("accepts projectWorkspaceId on its own", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: null,
      identifier: "PAPA-999",
    });
    mockIssueService.update.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      status: "todo",
      identifier: "PAPA-999",
    });
    const app = createIssueApp();

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({ projectWorkspaceId: "11111111-1111-4111-8111-111111111111" });

    expect(res.status).not.toBe(400);
    expect(mockIssueService.update).toHaveBeenCalled();
  });
});
