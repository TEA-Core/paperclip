import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SUP-15614: the sanctioned operator path for a base-repo rescue reset.
 * These tests pin the route wiring: board-only, targetRef resolution, the
 * refusal → 409 mapping, and that every attempt is audit-logged with the
 * repo, prior tip, target and actor. The git invariants themselves are covered
 * by base-repo-rescue-reset.test.ts against a real repo.
 */

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  remove: vi.fn(),
  resolveByReference: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockInstanceSettingsService = vi.hoisted(() => ({ getExperimental: vi.fn() }));
const mockEnvironmentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockSecretService = vi.hoisted(() => ({ normalizeEnvBindingsForPersistence: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockReset = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));
vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  environmentService: () => mockEnvironmentService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  secretService: () => mockSecretService,
  workspaceOperationService: () => ({}),
}));
vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));
vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));
vi.mock("../services/workspace-runtime.js", () => ({
  buildWorkspaceRuntimeDesiredStatePatch: vi.fn(),
  listConfiguredRuntimeServiceEntries: vi.fn(),
  resetProjectBaseRepoWithRescue: mockReset,
  runWorkspaceJobForControl: vi.fn(),
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForProjectWorkspace: vi.fn(),
}));

async function createApp(actor: Record<string, unknown>) {
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/projects.js")>("../routes/projects.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).actor = actor;
    next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use("/api", projectRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const BOARD = {
  type: "board",
  userId: "board-user",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};
const AGENT = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-1",
  source: "agent_key",
};

function buildProject(workspace: Record<string, unknown>) {
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    name: "Project",
    workspaces: [
      {
        id: "workspace-1",
        companyId: "company-1",
        projectId: "project-1",
        name: "Primary",
        sourceType: "local_path",
        cwd: "/srv/projects/paperclip",
        repoUrl: null,
        defaultRef: "origin/main",
        isPrimary: true,
        ...workspace,
      },
    ],
    primaryWorkspace: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("POST /projects/:id/workspaces/:workspaceId/base-repo/rescue-reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableManagedSandboxOnly: false });
    mockProjectService.getById.mockResolvedValue(buildProject({}));
    mockProjectService.resolveByReference.mockResolvedValue({ ambiguous: false, project: null });
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
  });

  it("resets with the workspace defaultRef and audits the operator action", async () => {
    mockReset.mockResolvedValue({
      reset: true,
      rescueRef: "refs/paperclip/rescue/base-repo/x/head",
      priorTip: "bbbbbbbbbbbb",
      targetRef: "origin/main",
      targetSha: "aaaaaaaaaaaa",
      refused: null,
      warnings: [],
    });
    const app = await createApp(BOARD);
    const res = await request(app).post("/api/projects/project-1/workspaces/workspace-1/base-repo/rescue-reset");

    expect(res.status).toBe(200);
    expect(res.body.reset).toBe(true);
    expect(res.body.rescueRef).toBe("refs/paperclip/rescue/base-repo/x/head");
    expect(mockReset).toHaveBeenCalledWith({
      repoRoot: "/srv/projects/paperclip",
      targetRef: "origin/main",
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity.mock.calls[0][1]).toMatchObject({
      action: "project.base_repo_rescue_reset",
      entityType: "project_workspace",
      entityId: "workspace-1",
    });
    expect(mockLogActivity.mock.calls[0][1].details).toMatchObject({
      repo: "/srv/projects/paperclip",
      targetRef: "origin/main",
      targetSha: "aaaaaaaaaaaa",
      priorTip: "bbbbbbbbbbbb",
      rescueRef: "refs/paperclip/rescue/base-repo/x/head",
      reset: true,
    });
  });

  it("honours an explicit targetRef from the body over defaultRef", async () => {
    mockReset.mockResolvedValue({ reset: true, rescueRef: null, priorTip: "bbbb", targetRef: "v1.2.3", targetSha: "aaaa", refused: null, warnings: [] });
    const app = await createApp(BOARD);
    const res = await request(app)
      .post("/api/projects/project-1/workspaces/workspace-1/base-repo/rescue-reset")
      .send({ targetRef: "v1.2.3" });
    expect(res.status).toBe(200);
    expect(mockReset).toHaveBeenCalledWith({ repoRoot: "/srv/projects/paperclip", targetRef: "v1.2.3" });
  });

  it("maps a refusal to 409 and still records the attempt", async () => {
    mockReset.mockResolvedValue({ reset: false, rescueRef: null, priorTip: null, targetRef: "origin/main", targetSha: null, refused: "base repo has 2 uncommitted tracked change(s) and 0 unmerged path(s); refusing reset to avoid data loss", warnings: [] });
    const app = await createApp(BOARD);
    const res = await request(app).post("/api/projects/project-1/workspaces/workspace-1/base-repo/rescue-reset");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/uncommitted tracked change/);
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
  });

  it("is board-only: an agent key gets 403", async () => {
    mockReset.mockResolvedValue({ reset: true, rescueRef: null, priorTip: null, targetRef: "x", targetSha: null, refused: null, warnings: [] });
    const app = await createApp(AGENT);
    const res = await request(app).post("/api/projects/project-1/workspaces/workspace-1/base-repo/rescue-reset");
    expect(res.status).toBe(403);
    expect(mockReset).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("404s when the workspace does not belong to the project", async () => {
    const app = await createApp(BOARD);
    const res = await request(app).post("/api/projects/project-1/workspaces/unknown/base-repo/rescue-reset");
    expect(res.status).toBe(404);
    expect(mockReset).not.toHaveBeenCalled();
  });

  it("422s when the workspace has no base repo path", async () => {
    mockProjectService.getById.mockResolvedValue(buildProject({ cwd: null }));
    const app = await createApp(BOARD);
    const res = await request(app).post("/api/projects/project-1/workspaces/workspace-1/base-repo/rescue-reset");
    expect(res.status).toBe(422);
    expect(mockReset).not.toHaveBeenCalled();
  });

  it("422s when no targetRef is supplied and the workspace has no defaultRef", async () => {
    mockProjectService.getById.mockResolvedValue(buildProject({ defaultRef: null }));
    const app = await createApp(BOARD);
    const res = await request(app).post("/api/projects/project-1/workspaces/workspace-1/base-repo/rescue-reset");
    expect(res.status).toBe(422);
    expect(mockReset).not.toHaveBeenCalled();
  });
});
