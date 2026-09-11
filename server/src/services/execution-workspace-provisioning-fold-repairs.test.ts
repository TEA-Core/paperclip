// Slice 2b fold repairs to provisionIssueExecutionWorkspace: native recovery never touches
// the issue's workspace binding (upstream #12616 / #12901), warm lease-reusing sandboxes
// switch to reuse_existing and follow a workspace replaced at realization (#12901 / #12904),
// and a local run's post-realization re-bind is a strict no-op. Upstream carried these in
// its inline provisioning; this fork provisions through this service (SUP-11806), so they
// were ported here.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
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

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`embedded postgres unsupported: ${support.reason}`);

const SENTINEL_UPDATED_AT = new Date("2000-01-01T00:00:00.000Z");

function initTempGitRepo(cwd: string) {
  execSync("git init", { cwd, stdio: "pipe" });
  execSync("git config user.email paperclip-test@example.com", { cwd, stdio: "pipe" });
  execSync("git config user.name 'Paperclip Test'", { cwd, stdio: "pipe" });
  execSync("git commit --allow-empty -m init", { cwd, stdio: "pipe" });
}

describeDb("fold repairs: provisionIssueExecutionWorkspace (slice 2b fold repairs)", () => {
  let tempDb: any = null;
  let db: any;
  const roots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-fold-repair-harness-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await db?.$client.end();
    await tempDb?.cleanup();
  }, 60_000);

  async function seed(mode: "isolated_workspace" | "shared_workspace") {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date("2026-07-07T00:00:00.000Z");
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-fold-repair-"));
    roots.push(tempRoot);
    initTempGitRepo(tempRoot);
    await instanceSettingsService(db).updateExperimental({
      enableIsolatedWorkspaces: true,
      enableWorkspaceBranchReconcileForward: false,
      enableWorkspaceDirtyQuarantineRepair: false,
    });
    await db.insert(companies).values({
      id: companyId, name: "Acme", issuePrefix, status: "active",
      defaultResponsibleUserId: "responsible-user", createdAt: now, updatedAt: now,
    });
    await db.insert(projects).values({
      id: projectId, companyId, name: "Fold repair", status: "active",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: mode,
        workspaceStrategy: mode === "isolated_workspace"
          ? { type: "git_worktree", baseRef: "HEAD", branchTemplate: "{{issue.identifier}}" }
          : { type: "project_primary" },
      },
      createdAt: now, updatedAt: now,
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId, companyId, projectId, name: "Primary", cwd: tempRoot, isPrimary: true,
      createdAt: now, updatedAt: now,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "FoldRepairAgent", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {}, createdAt: now, updatedAt: now,
    });
    await db.insert(issues).values({
      id: issueId, companyId, projectId, projectWorkspaceId, title: "Fold repair issue",
      status: "in_progress", workMode: "standard", priority: "medium", assigneeAgentId: agentId,
      responsibleUserId: "responsible-user", issueNumber: 1, identifier: `${issuePrefix}-1`,
      executionWorkspaceId: null, executionWorkspacePreference: null,
      executionWorkspaceSettings: { mode }, startedAt: now, createdAt: now, updatedAt: now,
    });
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
    return { companyId, projectId, projectWorkspaceId, agentId, issueId, now, tempRoot, agent, mode };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  const readIssue = (issueId: string) => db.query.issues.findFirst({ where: eq(issues.id, issueId) });
  const stampIssueUpdatedAt = (issueId: string) =>
    db.update(issues).set({ updatedAt: SENTINEL_UPDATED_AT }).where(eq(issues.id, issueId));

  function issueRefFromRow(s: Seeded, row: any) {
    return {
      id: s.issueId, identifier: row.identifier, title: row.title, status: row.status,
      priority: row.priority, workMode: row.workMode, description: null,
      projectId: s.projectId, projectWorkspaceId: s.projectWorkspaceId,
      executionWorkspaceId: row.executionWorkspaceId,
      executionWorkspacePreference: row.executionWorkspacePreference,
    };
  }

  async function provision(s: Seeded, overrides: {
    issueRef?: Record<string, unknown>;
    selectedEnvironmentForConfig?: Record<string, unknown>;
    requestedExecutionWorkspaceIdOverride?: string | null;
    skipIssueBinding?: boolean;
  } = {}) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: s.companyId, agentId: s.agentId, invocationSource: "assignment",
      triggerDetail: "system", status: "queued",
      contextSnapshot: { issueId: s.issueId, taskId: s.issueId, wakeReason: "issue_assigned" },
      responsibleUserId: "responsible-user", createdAt: s.now, updatedAt: s.now,
    });
    const run = await db.query.heartbeatRuns.findFirst({ where: eq(heartbeatRuns.id, runId) });
    const issueRef = overrides.issueRef ?? issueRefFromRow(s, await readIssue(s.issueId));
    const captured: { postAttachIssuePatch?: unknown } = {};
    const result: any = await provisionIssueExecutionWorkspace({
      db, run, agent: s.agent, issueId: s.issueId, issueRef, runId, previousSessionParams: null,
      effectiveExecutionWorkspaceMode: s.mode,
      trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
      isolatedWorkspacesEnabled: true,
      selectedEnvironmentId: (overrides.selectedEnvironmentForConfig?.id as string | undefined) ?? null,
      selectedEnvironmentForConfig: overrides.selectedEnvironmentForConfig ?? null,
      localEnvironment: {
        id: "local-env", name: "Local", description: null, driver: "local", status: "active",
        config: {}, envVars: {}, metadata: null, createdAt: s.now, updatedAt: s.now,
      },
      environmentSelectionSource: overrides.selectedEnvironmentForConfig ? "agent" : "local",
      configSnapshot: null,
      secretManifest: [],
      projectExecutionWorkspacePolicy: {
        enabled: true,
        defaultMode: s.mode,
        allowIssueOverride: true,
        workspaceStrategy: s.mode === "isolated_workspace"
          ? { type: "git_worktree", provisionCommand: "echo provision" }
          : { type: "project_primary" },
      },
      issueExecutionWorkspaceSettings: { mode: s.mode },
      executionProjectId: s.projectId,
      resolvedInstanceSettings: {
        experimental: { enableWorkspaceBranchReconcileForward: false, enableWorkspaceDirtyQuarantineRepair: false },
      },
      mergedConfig: {},
      executionPolicy: { executionMode: "standard" },
      context: { issueId: s.issueId, taskId: s.issueId, wakeReason: "issue_assigned" },
      resolveWorkspace: async () => ({
        cwd: s.tempRoot, source: "project_primary", projectId: s.projectId, workspaceId: s.projectWorkspaceId,
        repoUrl: null, repoRef: null, workspaceHints: [], warnings: [], baseCwdFallback: false,
        materializationFailures: [], additionalWorkspaces: [], referencedProjectFailures: [],
      }),
      resolveSessionConfig: async (input: { postAttachIssuePatch: unknown }) => {
        captured.postAttachIssuePatch = input.postAttachIssuePatch;
        return {
          previousSessionParams: null, resetTaskSession: true, sessionResetReason: null,
          sessionConfigFreshness: { reset: true, reasons: ["initial"], changedCategories: [], nextFingerprint: null, storedFingerprint: null },
          sessionConfigMetadata: {},
        };
      },
      runLifecycle: {
        onExecutionWorkspaceOccupied: async () => {
          throw new Error("unexpected occupancy deferral");
        },
      },
      requestedExecutionWorkspaceIdOverride: overrides.requestedExecutionWorkspaceIdOverride,
      skipIssueBinding: overrides.skipIssueBinding,
    } as any);
    expect(result.kind).toBe("provisioned");
    return { result, captured };
  }

  async function provisionThenClearBinding() {
    const s = await seed("isolated_workspace");
    const first = await provision(s);
    const nativeBoundWorkspaceId: string = first.result.persistedExecutionWorkspace.id;
    // A newer run cleared the issue's workspace binding while the older native run was
    // still recoverable.
    await db
      .update(issues)
      .set({ executionWorkspaceId: null, executionWorkspacePreference: null, updatedAt: SENTINEL_UPDATED_AT })
      .where(eq(issues.id, s.issueId));
    return { s, first, nativeBoundWorkspaceId };
  }

  it("a local run's post-realization re-bind with the provisioned row writes nothing", async () => {
    const s = await seed("isolated_workspace");
    const { result } = await provision(s);
    const boundRow = await readIssue(s.issueId);
    expect(boundRow.executionWorkspaceId).toBe(result.persistedExecutionWorkspace.id);
    expect(boundRow.executionWorkspacePreference).toBe("reuse_existing");
    await stampIssueUpdatedAt(s.issueId);
    await result.bindIssueToRealizedExecutionWorkspace(result.persistedExecutionWorkspace);
    const after = await readIssue(s.issueId);
    expect(after.updatedAt.getTime()).toBe(SENTINEL_UPDATED_AT.getTime());
    expect(after.executionWorkspaceId).toBe(boundRow.executionWorkspaceId);
  });

  it("native recovery restores the persisted native workspace and never touches a cleared issue binding", async () => {
    const { s, nativeBoundWorkspaceId } = await provisionThenClearBinding();
    const recovery = await provision(s, {
      requestedExecutionWorkspaceIdOverride: nativeBoundWorkspaceId,
      skipIssueBinding: true,
    });
    expect(recovery.result.workspaceReuseRequest.requestedShouldReuseExisting).toBe(true);
    expect(recovery.result.persistedExecutionWorkspace.id).toBe(nativeBoundWorkspaceId);
    expect(recovery.captured.postAttachIssuePatch).toEqual({});
    await recovery.result.bindIssueToRealizedExecutionWorkspace(recovery.result.persistedExecutionWorkspace);
    const after = await readIssue(s.issueId);
    expect(after.executionWorkspaceId).toBeNull();
    expect(after.executionWorkspacePreference).toBeNull();
    expect(after.updatedAt.getTime()).toBe(SENTINEL_UPDATED_AT.getTime());
  });


  it("native recovery leaves an issue a newer run moved onto another workspace where it is", async () => {
    const s = await seed("isolated_workspace");
    const first = await provision(s);
    const nativeBoundWorkspaceId: string = first.result.persistedExecutionWorkspace.id;
    const newerWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: newerWorkspaceId, companyId: s.companyId, projectId: s.projectId, projectWorkspaceId: s.projectWorkspaceId,
      sourceIssueId: s.issueId, mode: "isolated_workspace", strategyType: "git_worktree", name: "newer",
      status: "active", cwd: s.tempRoot, providerType: "local_fs", createdAt: s.now, updatedAt: s.now,
    });
    await db
      .update(issues)
      .set({ executionWorkspaceId: newerWorkspaceId, updatedAt: SENTINEL_UPDATED_AT })
      .where(eq(issues.id, s.issueId));
    const recovery = await provision(s, {
      requestedExecutionWorkspaceIdOverride: nativeBoundWorkspaceId,
      skipIssueBinding: true,
    });
    expect(recovery.result.persistedExecutionWorkspace.id).toBe(nativeBoundWorkspaceId);
    await recovery.result.bindIssueToRealizedExecutionWorkspace(recovery.result.persistedExecutionWorkspace);
    const after = await readIssue(s.issueId);
    expect(after.executionWorkspaceId).toBe(newerWorkspaceId);
    expect(after.updatedAt.getTime()).toBe(SENTINEL_UPDATED_AT.getTime());
  });

  it("a warm, lease-reusing sandbox switches the issue to reuse_existing and follows a replaced workspace once", async () => {
    const s = await seed("shared_workspace");
    const warmSandbox = {
      id: "sandbox-env", name: "Warm sandbox", description: null, driver: "sandbox", status: "active",
      config: { provider: "fake", reuseLease: true, runnerLifecycleMode: "warm" },
      envVars: {}, metadata: null, createdAt: s.now, updatedAt: s.now,
    };
    const { result, captured } = await provision(s, { selectedEnvironmentForConfig: warmSandbox });
    const bound = await readIssue(s.issueId);
    expect(bound.executionWorkspaceId).toBe(result.persistedExecutionWorkspace.id);
    expect(bound.executionWorkspacePreference).toBe("reuse_existing");
    expect(bound.executionWorkspaceSettings).toMatchObject({ mode: "shared_workspace" });
    expect(captured.postAttachIssuePatch).toMatchObject({ executionWorkspacePreference: "reuse_existing" });

    const replacementId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: replacementId, companyId: s.companyId, projectId: s.projectId, projectWorkspaceId: s.projectWorkspaceId,
      sourceIssueId: s.issueId, mode: "shared_workspace", strategyType: "project_primary", name: "replacement",
      status: "active", cwd: s.tempRoot, providerType: "local_fs", createdAt: s.now, updatedAt: s.now,
    });
    const replacement = await db.query.executionWorkspaces.findFirst({ where: eq(executionWorkspaces.id, replacementId) });
    await result.bindIssueToRealizedExecutionWorkspace(replacement);
    const rebound = await readIssue(s.issueId);
    expect(rebound.executionWorkspaceId).toBe(replacementId);
    expect(rebound.executionWorkspacePreference).toBe("reuse_existing");

    await stampIssueUpdatedAt(s.issueId);
    await result.bindIssueToRealizedExecutionWorkspace(replacement);
    expect((await readIssue(s.issueId)).updatedAt.getTime()).toBe(SENTINEL_UPDATED_AT.getTime());
  });

  it("a per-turn sandbox keeps the fork's shared_workspace binding (no reuse_existing switch)", async () => {
    const s = await seed("shared_workspace");
    const perTurnSandbox = {
      id: "sandbox-env", name: "Per-turn sandbox", description: null, driver: "sandbox", status: "active",
      config: { provider: "fake", reuseLease: false },
      envVars: {}, metadata: null, createdAt: s.now, updatedAt: s.now,
    };
    const { result } = await provision(s, { selectedEnvironmentForConfig: perTurnSandbox });
    const bound = await readIssue(s.issueId);
    expect(bound.executionWorkspaceId).toBe(result.persistedExecutionWorkspace.id);
    expect(bound.executionWorkspacePreference).toBeNull();
  });
});
