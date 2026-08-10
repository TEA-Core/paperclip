import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  environments,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { instanceSettingsService } from "./instance-settings.js";
import { provisionIssueExecutionWorkspace } from "./execution-workspace-provisioning.js";
import type { Environment } from "@paperclipai/shared";
import type { TrustPresetResolution } from "./trust-preset-resolver.js";
import type {
  ExecutionWorkspaceProvisioningIssueRef,
  ResolvedWorkspaceForRun,
} from "./execution-workspace-provisioning.js";
import {
  EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION,
  EFFECTIVE_RUN_CONFIG_FINGERPRINT_ALGORITHM,
  EFFECTIVE_RUN_CONFIG_FINGERPRINT_CATEGORIES,
} from "./effective-run-config-fingerprints.js";
import type { EffectiveRunConfigFingerprint } from "./effective-run-config-fingerprints.js";
import type { buildEffectiveRunSessionConfigMetadata } from "./heartbeat.js";

type SessionConfigMetadata = Awaited<ReturnType<typeof buildEffectiveRunSessionConfigMetadata>>;

function buildTestSessionConfigMetadata(): SessionConfigMetadata {
  const dummyFingerprint = `v${EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION}:${EFFECTIVE_RUN_CONFIG_FINGERPRINT_ALGORITHM}:0000000000000000000000000000000000000000000000000000000000000000`;
  const sessionCategories = [
    "adapter",
    "adapterConfig",
    "agentRuntimeConfig",
    "modelProfile",
    "instructions",
    "issueOverrides",
    "workspaceConfig",
    "environment",
    "envBindings",
    "secrets",
    "runtimeSkills",
  ] as const;
  const categoryFingerprints = Object.fromEntries(
    sessionCategories.map((cat) => [cat, dummyFingerprint]),
  ) as Record<typeof sessionCategories[number], string>;
  const makeFingerprint = (category: "session" | "workspace" | "lease"): EffectiveRunConfigFingerprint => ({
    version: EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION,
    category,
    algorithm: EFFECTIVE_RUN_CONFIG_FINGERPRINT_ALGORITHM,
    fingerprint: dummyFingerprint,
    canonicalJson: "{}",
  });
  return {
    version: EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION,
    fingerprint: dummyFingerprint,
    categories: [...sessionCategories],
    categoryFingerprints,
    fingerprints: {
      version: EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION,
      categories: [...EFFECTIVE_RUN_CONFIG_FINGERPRINT_CATEGORIES],
      sessionFingerprint: makeFingerprint("session"),
      workspaceFingerprint: makeFingerprint("workspace"),
      leaseFingerprint: makeFingerprint("lease"),
    },
  };
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping execution-workspace-provisioning tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

function standardTrustResolution(): TrustPresetResolution {
  return {
    kind: "standard",
    preset: "standard",
    boundary: null,
    sourcePresets: {},
  };
}

function buildResolvedWorkspace(overrides: Partial<ResolvedWorkspaceForRun> = {}): ResolvedWorkspaceForRun {
  return {
    cwd: "/tmp/project",
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "workspace-1",
    repoUrl: null,
    repoRef: null,
    workspaceHints: [],
    warnings: [],
    ...overrides,
  };
}

describeEmbeddedPostgres("provisionIssueExecutionWorkspace", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;
  let tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-provisioning-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    for (const root of tempRoots.splice(0)) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(executionWorkspaces);
    await db.delete(environments);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  }, 60_000);

  it("provisions a fresh execution workspace for an issue with no existing workspace", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const issueIdentifier = `${issuePrefix}-1`;
    const now = new Date("2026-07-07T00:00:00.000Z");

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-provisioning-test-"));
    tempRoots.push(tempRoot);

    await instanceSettingsService(db).updateExperimental({
      enableIsolatedWorkspaces: true,
      enableWorkspaceBranchReconcileForward: false,
      enableWorkspaceDirtyQuarantineRepair: false,
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix,
      status: "active",
      defaultResponsibleUserId: "responsible-user",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Provisioning test",
      status: "active",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "HEAD",
          branchTemplate: "{{issue.identifier}}",
        },
      },
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: tempRoot,
      isPrimary: true,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProvisioningAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
      },
      responsibleUserId: "responsible-user",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Provisioning test issue",
      status: "in_progress",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionAgentNameKey: "provisioningagent",
      executionLockedAt: now,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: issueIdentifier,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const localEnvironment: Environment = {
      id: "local-env",
      name: "Local",
      description: null,
      driver: "local",
      status: "active",
      config: {},
      envVars: {},
      metadata: null,
      createdAt: now,
      updatedAt: now,
    };

    const issueRef: ExecutionWorkspaceProvisioningIssueRef = {
      id: issueId,
      identifier: issueIdentifier,
      title: "Provisioning test issue",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      description: null,
      projectId,
      projectWorkspaceId,
      executionWorkspaceId: null,
       executionWorkspacePreference: null,
     };

     const run = await db.query.heartbeatRuns.findFirst({
      where: eq(heartbeatRuns.id, runId),
    });
    expect(run).toBeDefined();

    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, agentId),
    });
    expect(agent).toBeDefined();

    const result = await provisionIssueExecutionWorkspace({
      db,
      run: run!,
      agent: agent!,
      issueId,
      issueRef,
      runId,
      effectiveExecutionWorkspaceMode: "isolated_workspace",
      trustPreset: standardTrustResolution(),
       isolatedWorkspacesEnabled: true,
       selectedEnvironmentId: null,
      selectedEnvironmentForConfig: null,
      localEnvironment,
       environmentSelectionSource: "local",
      configSnapshot: null,
      secretManifest: [],
      projectExecutionWorkspacePolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        allowIssueOverride: true,
        workspaceStrategy: {
          type: "git_worktree",
          provisionCommand: "echo provision",
        },
      },
      issueExecutionWorkspaceSettings: { mode: "isolated_workspace" },
      executionProjectId: projectId,
      resolvedInstanceSettings: {
        experimental: {
          enableWorkspaceBranchReconcileForward: false,
          enableWorkspaceDirtyQuarantineRepair: false,
        },
      },
      mergedConfig: {},
      executionPolicy: { executionMode: "standard" },
      context: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      resolveWorkspace: async () =>
        buildResolvedWorkspace({
          cwd: tempRoot,
          source: "project_primary",
          projectId,
          workspaceId: projectWorkspaceId,
          repoUrl: null,
          repoRef: null,
        }),
      resolveSessionConfig: async () => ({
        previousSessionParams: null,
        resetTaskSession: true,
        sessionResetReason: null,
        sessionConfigFreshness: {
          reset: true,
          reasons: ["initial"],
          changedCategories: [],
          nextFingerprint: null,
          storedFingerprint: null,
        },
        sessionConfigMetadata: buildTestSessionConfigMetadata(),
      }),
      runLifecycle: {
        onExecutionWorkspaceOccupied: async () => {
          throw new Error("should not be called for fresh provisioning");
        },
      },
    });

    expect(result.kind).toBe("provisioned");
    if (result.kind !== "provisioned") return;

    expect(result.executionWorkspace).toMatchObject({
      cwd: expect.any(String),
      source: expect.any(String),
      strategy: expect.any(String),
      warnings: expect.any(Array),
      created: expect.any(Boolean),
    });

    expect(result.persistedExecutionWorkspace).not.toBeNull();
    expect(result.persistedExecutionWorkspace!.id).toEqual(expect.any(String));
    expect(result.persistedExecutionWorkspace!.status).toBe("active");
    expect(result.persistedExecutionWorkspace!.mode).toBe("isolated_workspace");
    expect(result.persistedExecutionWorkspace!.strategyType).toBe("git_worktree");
    expect(result.persistedExecutionWorkspace!.companyId).toBe(companyId);
    expect(result.persistedExecutionWorkspace!.projectId).toBe(projectId);
    expect(result.persistedExecutionWorkspace!.sourceIssueId).toBe(issueId);

    const persistedRows = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, result.persistedExecutionWorkspace!.id));
    expect(persistedRows).toHaveLength(1);
    expect(persistedRows[0]!.status).toBe("active");

    const issueRows = await db
      .select({ executionWorkspaceId: issues.executionWorkspaceId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issueRows).toHaveLength(1);
    expect(issueRows[0]!.executionWorkspaceId).toBe(result.persistedExecutionWorkspace!.id);
  });

  it("returns a deferred result when the workspace is occupied by another run", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const issueIdentifier = `${issuePrefix}-1`;
    const otherRunId = randomUUID();
    const otherIssueId = randomUUID();
    const otherIssueIdentifier = `${issuePrefix}-2`;
    const executionWorkspaceId = randomUUID();
    const now = new Date("2026-07-07T00:00:00.000Z");

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-provisioning-deferred-"));
    tempRoots.push(tempRoot);

    await instanceSettingsService(db).updateExperimental({
      enableIsolatedWorkspaces: true,
      enableWorkspaceBranchReconcileForward: false,
      enableWorkspaceDirtyQuarantineRepair: false,
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix,
      status: "active",
      defaultResponsibleUserId: "responsible-user",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Deferred test",
      status: "active",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "HEAD",
          branchTemplate: "{{issue.identifier}}",
        },
      },
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: tempRoot,
      isPrimary: true,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "DeferredAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: otherIssueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: otherIssueIdentifier,
      status: "active",
      cwd: tempRoot,
      repoUrl: null,
      baseRef: "HEAD",
      branchName: otherIssueIdentifier,
      providerType: "git_worktree",
      providerRef: tempRoot,
      lastUsedAt: now,
      openedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
      },
      responsibleUserId: "responsible-user",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        projectId,
        projectWorkspaceId,
        title: "Deferred test issue",
        status: "in_progress",
        workMode: "standard",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        executionAgentNameKey: "deferredagent",
        executionLockedAt: now,
        responsibleUserId: "responsible-user",
        issueNumber: 1,
        identifier: issueIdentifier,
        executionWorkspaceId: executionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
        },
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: otherIssueId,
        companyId,
        projectId,
        projectWorkspaceId,
        title: "Other issue (occupying workspace)",
        status: "in_progress",
        workMode: "standard",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: otherRunId,
        executionRunId: otherRunId,
        executionAgentNameKey: "deferredagent",
        executionLockedAt: now,
        responsibleUserId: "responsible-user",
        issueNumber: 2,
        identifier: otherIssueIdentifier,
        executionWorkspaceId: executionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
        },
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const localEnvironment: Environment = {
      id: "local-env",
      name: "Local",
      description: null,
      driver: "local",
      status: "active",
      config: {},
      envVars: {},
      metadata: null,
      createdAt: now,
      updatedAt: now,
    };

    const issueRef: ExecutionWorkspaceProvisioningIssueRef = {
      id: issueId,
      identifier: issueIdentifier,
      title: "Deferred test issue",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      description: null,
      projectId,
      projectWorkspaceId,
      executionWorkspaceId: executionWorkspaceId,
       executionWorkspacePreference: "reuse_existing",
     };

     const run = await db.query.heartbeatRuns.findFirst({
      where: eq(heartbeatRuns.id, runId),
    });
    expect(run).toBeDefined();

    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, agentId),
    });
    expect(agent).toBeDefined();

    let lifecycleCalled = false;
    const result = await provisionIssueExecutionWorkspace({
      db,
      run: run!,
      agent: agent!,
      issueId,
      issueRef,
      runId,
      effectiveExecutionWorkspaceMode: "isolated_workspace",
      trustPreset: standardTrustResolution(),
       isolatedWorkspacesEnabled: true,
       selectedEnvironmentId: null,
      selectedEnvironmentForConfig: null,
      localEnvironment,
       environmentSelectionSource: "local",
      configSnapshot: null,
      secretManifest: [],
      projectExecutionWorkspacePolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        allowIssueOverride: true,
        workspaceStrategy: {
          type: "git_worktree",
          provisionCommand: "echo provision",
        },
      },
      issueExecutionWorkspaceSettings: { mode: "isolated_workspace" },
      executionProjectId: projectId,
      resolvedInstanceSettings: {
        experimental: {
          enableWorkspaceBranchReconcileForward: false,
          enableWorkspaceDirtyQuarantineRepair: false,
        },
      },
      mergedConfig: {},
      executionPolicy: { executionMode: "standard" },
      context: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      resolveWorkspace: async () =>
        buildResolvedWorkspace({
          cwd: tempRoot,
          source: "project_primary",
          projectId,
          workspaceId: projectWorkspaceId,
          repoUrl: null,
          repoRef: null,
        }),
      resolveSessionConfig: async () => ({
        previousSessionParams: null,
        resetTaskSession: true,
        sessionResetReason: null,
        sessionConfigFreshness: {
          reset: true,
          reasons: ["initial"],
          changedCategories: [],
          nextFingerprint: null,
          storedFingerprint: null,
        },
        sessionConfigMetadata: buildTestSessionConfigMetadata(),
      }),
      runLifecycle: {
        onExecutionWorkspaceOccupied: async () => {
          lifecycleCalled = true;
        },
      },
    });

    expect(result.kind).toBe("deferred");
    expect(lifecycleCalled).toBe(true);
  });
});
