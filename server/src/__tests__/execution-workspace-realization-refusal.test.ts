import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  projectWorkspaces,
  projects,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executionWorkspaceService } from "../services/execution-workspaces.ts";
import { assertProjectPrimaryBaseWorkspaceReady } from "../services/heartbeat.ts";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import type { ExecutionWorkspaceInput } from "../services/workspace-runtime.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution workspace realization refusal tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const agentId = "agent-1";
const fallbackCwd = resolveDefaultAgentWorkspaceDir(agentId);

function buildBase(overrides: Partial<ExecutionWorkspaceInput> = {}): ExecutionWorkspaceInput {
  return {
    baseCwd: fallbackCwd,
    source: "agent_home",
    projectId: "project-1",
    workspaceId: null,
    repoUrl: null,
    repoRef: null,
    ...overrides,
  };
}

describe("assertProjectPrimaryBaseWorkspaceReady", () => {
  it("refuses a project_primary realization that fell back to agent home when a project workspace was expected", async () => {
    await expect(assertProjectPrimaryBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "shared_workspace",
      config: {},
      agentId,
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        executionWorkspaceId: null,
        executionWorkspacePreference: "shared_workspace",
      },
      base: buildBase(),
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      message: expect.stringContaining("requested shared_workspace with project_primary, but no project cwd was resolved"),
      resultJson: {
        workspaceValidation: expect.objectContaining({
          reason: "project_primary_base_agent_home",
          issueId: "issue-1",
          resolvedWorkspaceSource: "agent_home",
          resolvedWorkspaceCwd: fallbackCwd,
          requestedExecutionWorkspaceMode: "shared_workspace",
          workspaceStrategyType: "project_primary",
        }),
      },
    });
  });

  it("refuses the unrealizable agent_default + projectWorkspaceId pair even though agent_default alone runs from agent home", async () => {
    await expect(assertProjectPrimaryBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "agent_default",
      config: {},
      agentId,
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        executionWorkspaceId: null,
        executionWorkspacePreference: "agent_default",
      },
      base: buildBase(),
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      message: expect.stringContaining("refusing to create a project_primary execution workspace from agent fallback cwd"),
      resultJson: {
        workspaceValidation: expect.objectContaining({
          reason: "project_primary_base_agent_home",
          issueExecutionWorkspacePreference: "agent_default",
          requestedExecutionWorkspaceMode: "agent_default",
          workspaceStrategyType: "adapter_managed",
        }),
      },
    });
  });

  it("refuses when project workspace rows resolved but their cwd fell back to the agent home directory", async () => {
    await expect(assertProjectPrimaryBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "shared_workspace",
      config: {},
      agentId,
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
      },
      base: buildBase({
        source: "project_primary",
        workspaceId: "workspace-1",
        baseCwd: fallbackCwd,
      }),
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          reason: "project_primary_base_agent_home",
          resolvedWorkspaceSource: "project_primary",
          resolvedProjectWorkspaceId: "workspace-1",
        }),
      },
    });
  });

  it("allows a legit agent_default run with no project workspace binding", async () => {
    await expect(assertProjectPrimaryBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "agent_default",
      config: {},
      agentId,
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        projectId: null,
        projectWorkspaceId: null,
      },
      base: buildBase({ projectId: null }),
    })).resolves.toBeUndefined();
  });

  it("allows a project_primary realization that resolved a real project cwd", async () => {
    await expect(assertProjectPrimaryBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "shared_workspace",
      config: {},
      agentId,
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
      },
      base: buildBase({
        source: "project_primary",
        workspaceId: "workspace-1",
        baseCwd: "/srv/projects/example",
      }),
    })).resolves.toBeUndefined();
  });

  it("delegates git_worktree strategy to the worktree guard", async () => {
    await expect(assertProjectPrimaryBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "isolated_workspace",
      config: { workspaceStrategy: { type: "git_worktree" } },
      agentId,
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
      },
      base: buildBase(),
    })).resolves.toBeUndefined();
  });

  it("allows agent_home resolution when no project workspace was expected", async () => {
    await expect(assertProjectPrimaryBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "shared_workspace",
      config: {},
      agentId,
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        projectId: null,
        projectWorkspaceId: null,
      },
      base: buildBase({ projectId: null }),
    })).resolves.toBeUndefined();
  });
});

describeEmbeddedPostgres("execution workspace realization refusal persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof executionWorkspaceService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-workspace-realization-refusal-");
    db = createDb(tempDb.connectionString);
    svc = executionWorkspaceService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(workspaceRuntimeServices);
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);

    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function countExecutionWorkspaces(companyId: string) {
    const rows = await db
      .select({ id: executionWorkspaces.id })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.companyId, companyId));
    return rows.length;
  }

  async function seedIssue(input: { projectWorkspaceCwd: string; executionWorkspacePreference: string | null }) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspaces",
      status: "in_progress",
      executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace" },
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Main",
      cwd: input.projectWorkspaceCwd,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Unrealizable workspace",
      identifier: "PAP-1",
      status: "todo",
      executionWorkspacePreference: input.executionWorkspacePreference,
    });

    return { companyId, projectId, projectWorkspaceId, issueId };
  }

  it("refuses to fabricate a project_primary row and writes no execution workspace when realization fell back to agent home", async () => {
    const { companyId, projectId, projectWorkspaceId, issueId } = await seedIssue({
      projectWorkspaceCwd: "/srv/projects/unavailable",
      executionWorkspacePreference: "agent_default",
    });

    const beforeCount = await countExecutionWorkspaces(companyId);
    expect(beforeCount).toBe(0);

    await expect(assertProjectPrimaryBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "agent_default",
      config: {},
      agentId,
      issue: {
        id: issueId,
        identifier: "PAP-1",
        projectId,
        projectWorkspaceId,
        executionWorkspaceId: null,
        executionWorkspacePreference: "agent_default",
      },
      base: buildBase({ projectId }),
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          reason: "project_primary_base_agent_home",
          issueProjectWorkspaceId: projectWorkspaceId,
        }),
      },
    });

    const afterCount = await countExecutionWorkspaces(companyId);
    expect(afterCount).toBe(beforeCount);
  });

  it("persists a project_primary row with the real project cwd when realization resolved a project workspace", async () => {
    const realCwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-realization-project-cwd-"));
    tempDirs.add(realCwd);
    const { companyId, projectId, projectWorkspaceId, issueId } = await seedIssue({
      projectWorkspaceCwd: realCwd,
      executionWorkspacePreference: "shared_workspace",
    });

    await expect(assertProjectPrimaryBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "shared_workspace",
      config: {},
      agentId,
      issue: {
        id: issueId,
        identifier: "PAP-1",
        projectId,
        projectWorkspaceId,
        executionWorkspaceId: null,
        executionWorkspacePreference: "shared_workspace",
      },
      base: buildBase({
        source: "project_primary",
        projectId,
        workspaceId: projectWorkspaceId,
        baseCwd: realCwd,
      }),
    })).resolves.toBeUndefined();

    await svc.create({
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: issueId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "PAP-1",
      status: "active",
      cwd: realCwd,
      repoUrl: null,
      baseRef: null,
      branchName: null,
      providerType: "local_fs",
      providerRef: null,
      lastUsedAt: new Date(),
      openedAt: new Date(),
      metadata: { source: "project_primary", createdByRuntime: true },
    });

    const rows = await db
      .select({ cwd: executionWorkspaces.cwd, projectWorkspaceId: executionWorkspaces.projectWorkspaceId })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cwd).toBe(realCwd);
    expect(rows[0]!.projectWorkspaceId).toBe(projectWorkspaceId);
  });
});
