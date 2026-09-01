import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
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
import { issueService } from "./issues.js";
import { provisionIssueExecutionWorkspace } from "./execution-workspace-provisioning.js";
import type { Environment, ProjectExecutionWorkspacePolicy } from "@paperclipai/shared";
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
import {
  buildEffectiveRunSessionConfigMetadata,
  buildSessionWorkspaceConfigCategoryValue,
  projectExecutionWorkspaceForSessionCategory,
} from "./heartbeat.js";

type SessionConfigMetadata = Awaited<ReturnType<typeof buildEffectiveRunSessionConfigMetadata>>;

function buildTestSessionConfigMetadata(): SessionConfigMetadata {
  const dummyFingerprint = `v${EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION}:${EFFECTIVE_RUN_CONFIG_FINGERPRINT_ALGORITHM}:0000000000000000000000000000000000000000000000000000000000000000`;
  const sessionCategories = [
    "adapter",
    "adapterConfig",
    "agentRuntimeConfig",
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

// `git commit` refuses to run without an author, and a bare CI runner has no
// global identity configured — only developer machines do, which is why this
// only ever failed off-laptop. Pin the identity locally in the throwaway repo
// rather than inheriting whatever the host happens to have, matching the
// idiom in workspace-runtime.test.ts and the heartbeat-workspace-* suites.
function initTempGitRepo(cwd: string) {
  execSync("git init", { cwd, stdio: "pipe" });
  execSync("git config user.email paperclip-test@example.com", { cwd, stdio: "pipe" });
  execSync("git config user.name 'Paperclip Test'", { cwd, stdio: "pipe" });
  execSync("git commit --allow-empty -m init", { cwd, stdio: "pipe" });
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
    baseCwdFallback: false,
    materializationFailures: [],
    additionalWorkspaces: [],
    referencedProjectFailures: [],
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
    initTempGitRepo(tempRoot);


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
      previousSessionParams: null,
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
      resolveSessionConfig: async (_input) => ({
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
    initTempGitRepo(tempRoot);


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
      sourceIssueId: null as never,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "master",
      status: "active",
      cwd: tempRoot,
      repoUrl: null,
      baseRef: "HEAD",
      branchName: "master",
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

    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: {
        issueId: otherIssueId,
        taskId: otherIssueId,
        wakeReason: "issue_assigned",
      },
      responsibleUserId: "responsible-user",
      createdAt: new Date(now.getTime() - 1000),
      updatedAt: new Date(now.getTime() - 1000),
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
      previousSessionParams: null,
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
      resolveSessionConfig: async (_input) => ({
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

  // SUP-13585 acceptance 2 / SUP-13733: the session's `workspaceConfig` subcategory must be
  // computed from the POST-attach state (attached issue fields + the persisted workspace
  // row), not from the pre-decision snapshot. Only then does what run N stores equal what
  // run N+1 computes, so the session evaluator stops resetting every time the
  // attach/persist decision itself changed the fields being hashed.
  it("keeps the session workspaceConfig subcategory stable across consecutive runs that reuse the same workspace row", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const issueIdentifier = `${issuePrefix}-1`;
    const now = new Date("2026-07-07T00:00:00.000Z");

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-provisioning-session-stability-"));
    tempRoots.push(tempRoot);
    initTempGitRepo(tempRoot);

    await instanceSettingsService(db).updateExperimental({
      enableIsolatedWorkspaces: true,
      enableWorkspaceBranchReconcileForward: false,
      enableWorkspaceDirtyQuarantineRepair: false,
    });

    const projectPolicy = {
      enabled: true,
      defaultMode: "isolated_workspace",
      allowIssueOverride: true,
      workspaceStrategy: {
        type: "git_worktree",
        provisionCommand: "echo provision",
      },
    } satisfies ProjectExecutionWorkspacePolicy;

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
      name: "Session stability test",
      status: "active",
      executionWorkspacePolicy: projectPolicy,
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
      name: "SessionStabilityAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Session stability test issue",
      status: "in_progress",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: issueIdentifier,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: { mode: "isolated_workspace" },
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

    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });

    // Captured at the start of each run (before provisioning mutates the issue row); the
    // post-attach computation below mirrors heartbeat.ts' resolveSessionConfig exactly:
    // pre-attach issue state + postAttachIssuePatch + the post-persist workspace row —
    // i.e. the state the NEXT run will read from the database.
    let preAttachIssueState: {
      projectWorkspaceId: string | null;
      executionWorkspacePreference: string | null;
      executionWorkspaceSettings: Record<string, unknown> | null;
    } | null = null;

    async function provisionOnce(runId: string) {
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
        responsibleUserId: "responsible-user",
        createdAt: now,
        updatedAt: now,
      });
      const run = await db.query.heartbeatRuns.findFirst({ where: eq(heartbeatRuns.id, runId) });
      const preAttachRow = await db
        .select({
          projectWorkspaceId: issues.projectWorkspaceId,
          executionWorkspaceId: issues.executionWorkspaceId,
          executionWorkspacePreference: issues.executionWorkspacePreference,
          executionWorkspaceSettings: issues.executionWorkspaceSettings,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]!);
      preAttachIssueState = {
        projectWorkspaceId: preAttachRow.projectWorkspaceId,
        executionWorkspacePreference: preAttachRow.executionWorkspacePreference,
        executionWorkspaceSettings: preAttachRow.executionWorkspaceSettings,
      };
      const issueRef: ExecutionWorkspaceProvisioningIssueRef = {
        id: issueId,
        identifier: issueIdentifier,
        title: "Session stability test issue",
        status: "in_progress",
        priority: "medium",
        workMode: "standard",
        description: null,
        projectId,
        projectWorkspaceId,
        executionWorkspaceId: preAttachRow.executionWorkspaceId,
        executionWorkspacePreference: preAttachRow.executionWorkspacePreference,
      };
      return provisionIssueExecutionWorkspace({
        db,
        run: run!,
        agent: agent!,
        issueId,
        issueRef,
        runId,
        previousSessionParams: null,
        effectiveExecutionWorkspaceMode: "isolated_workspace",
        trustPreset: standardTrustResolution(),
        isolatedWorkspacesEnabled: true,
        selectedEnvironmentId: null,
        selectedEnvironmentForConfig: null,
        localEnvironment,
        environmentSelectionSource: "local",
        configSnapshot: null,
        secretManifest: [],
        projectExecutionWorkspacePolicy: projectPolicy,
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
        resolveSessionConfig: async ({ persistedExecutionWorkspace, postAttachIssuePatch }) => {
          const postAttachIssueContext = preAttachIssueState
            ? {
                projectId,
                projectWorkspaceId:
                  postAttachIssuePatch?.projectWorkspaceId ?? preAttachIssueState.projectWorkspaceId,
                executionWorkspacePreference:
                  postAttachIssuePatch?.executionWorkspacePreference ??
                  preAttachIssueState.executionWorkspacePreference,
                executionWorkspaceSettings:
                  postAttachIssuePatch?.executionWorkspaceSettings ??
                  preAttachIssueState.executionWorkspaceSettings,
              }
            : null;
          const postAttachIssueSettings = postAttachIssuePatch?.executionWorkspaceSettings
            ? postAttachIssuePatch.executionWorkspaceSettings
            : { mode: "isolated_workspace" };
          const sessionConfigMetadata = await buildEffectiveRunSessionConfigMetadata({
            adapterType: "codex_local",
            effectiveAdapterConfig: {},
            agentRuntimeConfig: agent?.runtimeConfig ?? null,
            issueOverrides: null,
            workspaceConfig: buildSessionWorkspaceConfigCategoryValue({
              requestedMode: "isolated_workspace",
              effectiveMode: "isolated_workspace",
              issueContext: postAttachIssueContext,
              projectContext: { id: projectId, executionWorkspacePolicy: projectPolicy },
              projectPolicy,
              issueSettings: postAttachIssueSettings,
              existingExecutionWorkspace:
                projectExecutionWorkspaceForSessionCategory(persistedExecutionWorkspace),
            }),
            environment: null,
            environmentEnv: null,
            projectEnv: null,
            routineEnv: null,
            secretManifest: [],
            runtimeSkills: null,
            agentConfigRevision: null,
          });
          return {
            previousSessionParams: null,
            resetTaskSession: false,
            sessionResetReason: null,
            sessionConfigFreshness: {
              reset: false,
              reasons: [],
              changedCategories: [],
              nextFingerprint: null,
              storedFingerprint: null,
            },
            sessionConfigMetadata,
          };
        },
        runLifecycle: { onExecutionWorkspaceOccupied: async () => undefined },
      });
    }

    const first = await provisionOnce(randomUUID());
    expect(first.kind).toBe("provisioned");
    if (first.kind !== "provisioned") return;
    expect(first.persistedExecutionWorkspace).not.toBeNull();
    const workspaceRowId = first.persistedExecutionWorkspace!.id;
    const firstWorkspaceConfigFingerprint =
      first.sessionConfigMetadata.categoryFingerprints.workspaceConfig;

    const second = await provisionOnce(randomUUID());
    expect(second.kind).toBe("provisioned");
    if (second.kind !== "provisioned") return;
    // Run 2 is the "workspace evaluator reports reuse" arm: the row is restored, not
    // re-provisioned, and nothing config-relevant changed.
    expect(second.reusedExecutionWorkspace).not.toBeNull();
    expect(second.persistedExecutionWorkspace?.id).toBe(workspaceRowId);
    expect(second.workspaceConfigFreshness.action).toBe("reuse");
    expect(second.workspaceConfigFreshness.changedCategories).toEqual([]);
    // The invariant: what run 1 stores for the session must equal what run 2 computes —
    // otherwise the session evaluator resets on every reuse.
    expect(second.sessionConfigMetadata.categoryFingerprints.workspaceConfig).toBe(
      firstWorkspaceConfigFingerprint,
    );
  }, 60_000);
});

/**
 * SUP-13058: `executionWorkspacePolicy.allowIssueOverride` was parsed, persisted and
 * rendered but never read, so setting it to `false` enforced nothing.
 *
 * Enforcement lives at the issue write boundary (`issueService.create` / `.update`),
 * which is the only place an operator-supplied override is distinguishable from the
 * binding `provisionIssueExecutionWorkspace` persists on its own after every run.
 * The re-run test below is the negative control for that distinction: a guard that
 * reads the issue's persisted state instead of the supplied fields passes every other
 * test here and still rejects the second run of every issue.
 */
describeEmbeddedPostgres("allowIssueOverride enforcement (SUP-13058)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;
  let tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-allow-issue-override-");
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

  async function seed(allowIssueOverride: boolean | undefined) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date("2026-08-16T00:00:00.000Z");

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-allow-override-test-"));
    tempRoots.push(tempRoot);
    initTempGitRepo(tempRoot);

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
      name: "allowIssueOverride test",
      status: "active",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        // `undefined` exercises the "field absent" arm: the default stays `true`.
        ...(allowIssueOverride === undefined ? {} : { allowIssueOverride }),
        workspaceStrategy: {
          type: "git_worktree",
          provisionCommand: "echo provision",
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
      name: "OverrideAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
      createdAt: now,
      updatedAt: now,
    });

    const existingWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: existingWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: null,
      name: "Pre-existing workspace",
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      status: "idle",
      cwd: tempRoot,
      createdAt: now,
      updatedAt: now,
    });

    return { companyId, projectId, projectWorkspaceId, agentId, existingWorkspaceId, tempRoot, now };
  }

  // Acceptance 1: the false arm is rejected, and the error names the project setting.
  it("rejects an operator-supplied issue workspace override when allowIssueOverride is false", async () => {
    const { companyId, projectId, existingWorkspaceId } = await seed(false);
    const svc = issueService(db);

    await expect(
      svc.create(companyId, {
        title: "Override attempt",
        status: "todo",
        priority: "medium",
        workMode: "standard",
        projectId,
        executionWorkspaceId: existingWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
      } as Parameters<typeof svc.create>[1]),
    ).rejects.toThrow(/allowIssueOverride/);
  });

  it("names the project setting in the rejection payload", async () => {
    const { companyId, projectId, existingWorkspaceId } = await seed(false);
    const svc = issueService(db);

    const err = await svc.create(companyId, {
      title: "Override attempt",
      status: "todo",
      priority: "medium",
      workMode: "standard",
      projectId,
      executionWorkspaceId: existingWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    } as Parameters<typeof svc.create>[1]).then(
      () => null,
      (e: unknown) => e as { message?: string; details?: Record<string, unknown> },
    );

    expect(err).not.toBeNull();
    expect(err!.message).toContain("executionWorkspacePolicy.allowIssueOverride");
    expect(err!.details).toMatchObject({
      code: "workspace_issue_override_disallowed",
      field: "executionWorkspacePolicy.allowIssueOverride",
    });
  });

  // Acceptance 2: true and absent behave exactly as they do today.
  it.each([
    ["true", true],
    ["absent", undefined],
  ] as const)("honours an issue workspace override when allowIssueOverride is %s", async (_label, flag) => {
    const { companyId, projectId, existingWorkspaceId } = await seed(flag);
    const svc = issueService(db);

    const created = await svc.create(companyId, {
      title: "Override allowed",
      status: "todo",
      priority: "medium",
      workMode: "standard",
      projectId,
      executionWorkspaceId: existingWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    } as Parameters<typeof svc.create>[1]);

    expect(created.executionWorkspaceId).toBe(existingWorkspaceId);
    expect(created.executionWorkspacePreference).toBe("reuse_existing");
  });

  it("allows an issue with no workspace override under allowIssueOverride: false", async () => {
    const { companyId, projectId } = await seed(false);
    const svc = issueService(db);

    const created = await svc.create(companyId, {
      title: "No override",
      status: "todo",
      priority: "medium",
      workMode: "standard",
      projectId,
    } as Parameters<typeof svc.create>[1]);

    expect(created.id).toEqual(expect.any(String));
    expect(created.executionWorkspaceId).toBeNull();
  });

  /**
   * `dispatchRoutineRun` (routines.ts) and pipeline stage-entry automations
   * normalize with `?? null`, so these keys are PRESENT and null on every
   * routine-created issue even when nothing was configured. Keying the guard on
   * key-presence alone would reject all of them under `allowIssueOverride: false`.
   */
  it("accepts present-but-null workspace fields under allowIssueOverride: false", async () => {
    const { companyId, projectId } = await seed(false);
    const svc = issueService(db);

    const created = await svc.create(companyId, {
      title: "Routine-shaped create",
      status: "todo",
      priority: "medium",
      workMode: "standard",
      projectId,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: null,
    } as Parameters<typeof svc.create>[1]);

    expect(created.executionWorkspaceId).toBeNull();
  });

  it("accepts clearing an override under allowIssueOverride: false", async () => {
    const { companyId, projectId } = await seed(false);
    const svc = issueService(db);

    const created = await svc.create(companyId, {
      title: "Clearable",
      status: "todo",
      priority: "medium",
      workMode: "standard",
      projectId,
    } as Parameters<typeof svc.create>[1]);

    // Clearing is not itself an override — refusing it would trap the issue in
    // exactly the state the project forbids.
    const cleared = await svc.update(created.id, {
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
    });
    expect(cleared!.executionWorkspaceId).toBeNull();
  });

  it("rejects an override supplied through update when allowIssueOverride is false", async () => {
    const { companyId, projectId, existingWorkspaceId } = await seed(false);
    const svc = issueService(db);

    const created = await svc.create(companyId, {
      title: "Update override",
      status: "todo",
      priority: "medium",
      workMode: "standard",
      projectId,
    } as Parameters<typeof svc.create>[1]);

    await expect(
      svc.update(created.id, {
        executionWorkspaceId: existingWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
      }),
    ).rejects.toThrow(/allowIssueOverride/);

    // A non-workspace update on the same issue is untouched by the guard.
    const renamed = await svc.update(created.id, { title: "Renamed" });
    expect(renamed!.title).toBe("Renamed");
  });

  /**
   * The regression the first implementation failed: `provisionIssueExecutionWorkspace`
   * writes `executionWorkspaceId` (and `executionWorkspacePreference: "reuse_existing"`
   * for isolated/operator_branch) back onto the issue after every run. A guard keyed on
   * the issue's persisted state therefore rejects the SECOND run of every issue in an
   * `allowIssueOverride: false` project, even though the project's own defaultMode
   * produced that binding and no operator supplied anything.
   */
  it("provisions the same issue twice under allowIssueOverride: false (system binding is not an override)", async () => {
    const { companyId, projectId, projectWorkspaceId, agentId, tempRoot, now } = await seed(false);
    const svc = issueService(db);

    const created = await svc.create(companyId, {
      title: "Re-run issue",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      projectId,
      projectWorkspaceId,
      assigneeAgentId: agentId,
    } as Parameters<typeof svc.create>[1]);
    const issueId = created.id;

    // The issue starts unbound — no operator ever supplied a workspace.
    expect(created.executionWorkspaceId).toBeNull();

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
    } as unknown as Environment;

    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });

    async function provisionOnce(runId: string) {
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
        responsibleUserId: "responsible-user",
        createdAt: now,
        updatedAt: now,
      });
      const run = await db.query.heartbeatRuns.findFirst({ where: eq(heartbeatRuns.id, runId) });

      // issueRef mirrors heartbeat.ts:14524-14525 — it carries whatever the issue row
      // currently holds, which after run 1 includes the system-persisted binding.
      const row = await db
        .select({
          executionWorkspaceId: issues.executionWorkspaceId,
          executionWorkspacePreference: issues.executionWorkspacePreference,
          identifier: issues.identifier,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]!);

      const issueRef: ExecutionWorkspaceProvisioningIssueRef = {
        id: issueId,
        identifier: row.identifier!,
        title: "Re-run issue",
        status: "in_progress",
        priority: "medium",
        workMode: "standard",
        description: null,
        projectId,
        projectWorkspaceId,
        executionWorkspaceId: row.executionWorkspaceId,
        executionWorkspacePreference: row.executionWorkspacePreference,
      };

      return provisionIssueExecutionWorkspace({
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
          allowIssueOverride: false,
          workspaceStrategy: { type: "git_worktree", provisionCommand: "echo provision" },
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
        resolveSessionConfig: async (_input: {
          persistedExecutionWorkspace: unknown;
          postAttachIssuePatch: unknown;
        }) => ({
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
        runLifecycle: { onExecutionWorkspaceOccupied: async () => undefined },
      } as unknown as Parameters<typeof provisionIssueExecutionWorkspace>[0]);
    }

    const first = await provisionOnce(randomUUID());
    expect(first.kind).toBe("provisioned");

    // Run 1 persisted the binding that a state-based guard would misread as an override.
    const afterFirst = await db
      .select({
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
    expect(afterFirst.executionWorkspaceId).not.toBeNull();
    expect(afterFirst.executionWorkspacePreference).toBe("reuse_existing");

    // Run 2 must NOT be rejected. This is the arm the first implementation failed.
    const second = await provisionOnce(randomUUID());
    expect(second.kind).toBe("provisioned");
  }, 60_000);
});
