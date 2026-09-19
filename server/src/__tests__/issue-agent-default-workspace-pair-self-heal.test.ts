import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issueCreateIdempotencyKeys,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { provisionIssueExecutionWorkspace } from "../services/execution-workspace-provisioning.js";
import type {
  ExecutionWorkspaceProvisioningIssueRef,
  ResolvedWorkspaceForRun,
} from "../services/execution-workspace-provisioning.js";
import type { Environment, ProjectExecutionWorkspacePolicy } from "@paperclipai/shared";
import type { TrustPresetResolution } from "../services/trust-preset-resolver.js";
import {
  EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION,
  EFFECTIVE_RUN_CONFIG_FINGERPRINT_ALGORITHM,
  EFFECTIVE_RUN_CONFIG_FINGERPRINT_CATEGORIES,
} from "../services/effective-run-config-fingerprints.js";
import type { EffectiveRunConfigFingerprint } from "../services/effective-run-config-fingerprints.js";

type Db = ReturnType<typeof createDb>;
type SessionConfigMetadata = Awaited<
  ReturnType<typeof import("../services/heartbeat.js")["buildEffectiveRunSessionConfigMetadata"]>
>;

/**
 * SUP-16886: the forbidden `executionWorkspacePreference: "agent_default"` +
 * non-null `projectWorkspaceId` pair is still reachable on two write boundaries even
 * though the create path (SUP-16608) already normalizes it away:
 *
 *  1. the issues PATCH route guard used to 400 *every* PATCH on a card that already
 *     stored the pair — including a bare `{"status":"blocked"}` — so a bricked card
 *     could never be repaired or parked. It now self-heals: a request that itself
 *     asserts the pair is still rejected, but an innocent PATCH clears the
 *     projectWorkspaceId in the same write (`agent_default` wins).
 *  2. `provisionIssueExecutionWorkspace` re-stamped `projectWorkspaceId` onto a card
 *     whose preference is `agent_default` on every re-provision (the mode resolves to a
 *     project workspace even though the preference says otherwise), re-minting the pair
 *     the create path just removed.
 *
 * These tests prove both boundaries hold the invariant: `agent_default` cards never
 * carry a `projectWorkspaceId`, and a stored bricked pair is healed, not 400-bricked.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent_default self-heal tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issues PATCH self-heals a stored agent_default + projectWorkspaceId pair", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-default-selfheal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    return companyId;
  }

  async function seedProjectWithWorkspace(companyId: string) {
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Platform", status: "in_progress" });
    const projectWorkspaceId = randomUUID();
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "primary",
      isPrimary: true,
    });
    const executionWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });
    return { projectId, projectWorkspaceId, executionWorkspaceId };
  }

  async function seedOpenBlocker(companyId: string) {
    const [blocker] = await db
      .insert(issues)
      .values({ companyId, title: "Open blocker", status: "todo", priority: "medium" })
      .returning();
    return blocker;
  }

  async function seedAgentWithKey(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const token = `sup16886-${randomUUID()}`;
    const responsibleUserId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({
      id: responsibleUserId,
      name: "Operator",
      email: `${responsibleUserId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(agentApiKeys).values({
      agentId,
      companyId,
      name: "sup-16886-key",
      keyHash: createHash("sha256").update(token).digest("hex"),
      responsibleUserId,
    });
    return { agentId, token };
  }

  // Seeds a card that already stores the forbidden pair — exactly what the create path
  // forbids but that a stale row (or an old re-provision) can still hold.
  async function seedWedgedCard(input: {
    companyId: string;
    projectId: string;
    projectWorkspaceId: string;
    executionWorkspaceId: string;
    agentId: string;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "running",
    });
    const wedgedId = randomUUID();
    await db.insert(issues).values({
      id: wedgedId,
      companyId: input.companyId,
      projectId: input.projectId,
      projectWorkspaceId: input.projectWorkspaceId,
      executionWorkspaceId: input.executionWorkspaceId,
      executionWorkspacePreference: "agent_default",
      executionRunId: runId,
      assigneeAgentId: input.agentId,
      title: "Wedged card",
      status: "in_progress",
      priority: "medium",
    });
    return { wedgedId, runId };
  }

  it("lets a bare status PATCH heal a stored pair: agent_default wins, the project workspace is dropped, and the card stays patchable", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId, executionWorkspaceId } =
      await seedProjectWithWorkspace(companyId);
    const blocker = await seedOpenBlocker(companyId);
    const { agentId, token } = await seedAgentWithKey(companyId, "coder-be");
    const { wedgedId, runId } = await seedWedgedCard({
      companyId,
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      agentId,
    });

    const app = createApp();
    // The bricked pair is stored before the request.
    const [before] = await db.select().from(issues).where(eq(issues.id, wedgedId));
    expect(before.executionWorkspacePreference).toBe("agent_default");
    expect(before.projectWorkspaceId).toBe(projectWorkspaceId);

    // AC2: a PATCH that touches NEITHER half of the pair must not 400. The assignee just
    // parks the card; the guard heals the stored pair in the same write.
    const res = await request(app)
      .patch(`/api/issues/${wedgedId}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ status: "blocked", blockedByIssueIds: [blocker.id] });

    expect(res.status).toBe(200);

    const [after] = await db.select().from(issues).where(eq(issues.id, wedgedId));
    expect(after.status).toBe("blocked");
    // AC3: agent_default wins — the preference survives and the project workspace is dropped.
    expect(after.executionWorkspacePreference).toBe("agent_default");
    expect(after.projectWorkspaceId).toBeNull();
  });

  it("still rejects a request that itself asserts the pair (explicit projectWorkspaceId on an agent_default card)", async () => {
    const companyId = await seedCompany();
    const { projectId, projectWorkspaceId, executionWorkspaceId } =
      await seedProjectWithWorkspace(companyId);
    const { agentId, token } = await seedAgentWithKey(companyId, "coder-be");
    const { wedgedId, runId } = await seedWedgedCard({
      companyId,
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      agentId,
    });

    const app = createApp();
    const res = await request(app)
      .patch(`/api/issues/${wedgedId}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "Re-mint attempt", projectWorkspaceId });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("agent_default");

    const [after] = await db.select().from(issues).where(eq(issues.id, wedgedId));
    // The reject is a rejection, not a silent heal: the stored pair is untouched.
    expect(after.projectWorkspaceId).toBe(projectWorkspaceId);
  });
});

// ---------------------------------------------------------------------------
// AC4: provisioning regression. The mode resolves to a project workspace even when the
// card's executionWorkspacePreference is `agent_default`; the write boundary must neither
// mint a projectWorkspaceId onto such a card nor leave a stored bricked pair in place.
// `shared_workspace` + `project_primary` is used because `isolated_workspace` flips the
// preference to `reuse_existing`, which would mask the re-mint.
// ---------------------------------------------------------------------------

type SessionFreshness = {
  reset: boolean;
  reasons: string[];
  changedCategories: string[];
  nextFingerprint: string | null;
  storedFingerprint: string | null;
};

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
  ) as Record<(typeof sessionCategories)[number], string>;
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
  } as unknown as SessionConfigMetadata;
}

function standardTrustResolution(): TrustPresetResolution {
  return {
    kind: "standard",
    preset: "standard",
    boundary: null,
    sourcePresets: {},
  };
}

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

describeEmbeddedPostgres("provisionIssueExecutionWorkspace holds the agent_default pair invariant (SUP-16886)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;
  let tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-default-provisioning-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    for (const root of tempRoots.splice(0)) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  }, 60_000);

  async function seedSharedWorkspaceProject(
    storeBrickedPair: boolean,
  ): Promise<{
    companyId: string;
    projectId: string;
    projectWorkspaceId: string;
    agentId: string;
    issueId: string;
    issueIdentifier: string;
    tempRoot: string;
    now: Date;
  }> {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const issueIdentifier = `${issuePrefix}-1`;
    const now = new Date("2026-07-07T00:00:00.000Z");

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-agent-default-prov-"));
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

    const projectPolicy = {
      enabled: true,
      defaultMode: "shared_workspace",
      allowIssueOverride: true,
      workspaceStrategy: { type: "project_primary" },
    } satisfies ProjectExecutionWorkspacePolicy;

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Agent default provisioning test",
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
      name: "AgentDefaultAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
      createdAt: now,
      updatedAt: now,
    });

    const runId = randomUUID();
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

    // The card is pinned to agent_default (stale, but the preference the invariant keys on)
    // while the effective mode is shared_workspace — which resolves to the project primary.
    // When `storeBrickedPair` is set, the issue already carries the forbidden pair
    // (the state a stale row or an old re-provision leaves behind).
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId: storeBrickedPair ? projectWorkspaceId : null,
      title: "Agent default provisioning test issue",
      status: "in_progress",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionAgentNameKey: "agentdefaultagent",
      executionLockedAt: now,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: issueIdentifier,
      executionWorkspaceId: null,
      executionWorkspacePreference: "agent_default",
      executionWorkspaceSettings: { mode: "shared_workspace" },
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    return { companyId, projectId, projectWorkspaceId, agentId, issueId, issueIdentifier, tempRoot, now };
  }

  async function provisionAgentDefaultCard(input: Awaited<ReturnType<typeof seedSharedWorkspaceProject>>) {
    const { projectId, projectWorkspaceId, agentId, issueId, issueIdentifier, tempRoot, now } = input;

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

    const storedRow = await db
      .select({
        projectWorkspaceId: issues.projectWorkspaceId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);

    const issueRef: ExecutionWorkspaceProvisioningIssueRef = {
      id: issueId,
      identifier: issueIdentifier,
      title: "Agent default provisioning test issue",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      description: null,
      projectId,
      projectWorkspaceId: storedRow.projectWorkspaceId,
      executionWorkspaceId: storedRow.executionWorkspaceId,
      executionWorkspacePreference: storedRow.executionWorkspacePreference,
    };

    const run = await db.query.heartbeatRuns.findFirst({
      where: eq(heartbeatRuns.agentId, agentId),
    });
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });

    const projectPolicy = {
      enabled: true,
      defaultMode: "shared_workspace",
      allowIssueOverride: true,
      workspaceStrategy: { type: "project_primary" },
    } satisfies ProjectExecutionWorkspacePolicy;

    return provisionIssueExecutionWorkspace({
      db,
      run: run!,
      agent: agent!,
      issueId,
      issueRef,
      runId: run!.id,
      previousSessionParams: null,
      effectiveExecutionWorkspaceMode: "shared_workspace",
      trustPreset: standardTrustResolution(),
      isolatedWorkspacesEnabled: true,
      selectedEnvironmentId: null,
      selectedEnvironmentForConfig: null,
      localEnvironment,
      environmentSelectionSource: "local",
      configSnapshot: null,
      secretManifest: [],
      projectExecutionWorkspacePolicy: projectPolicy,
      issueExecutionWorkspaceSettings: { mode: "shared_workspace" },
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
        } as unknown as SessionFreshness,
        sessionConfigMetadata: buildTestSessionConfigMetadata(),
      }),
      runLifecycle: { onExecutionWorkspaceOccupied: async () => undefined },
    });
  }

  it("does not re-mint a projectWorkspaceId onto an agent_default card when the mode resolves to a project workspace", async () => {
    const seeded = await seedSharedWorkspaceProject(false);
    const result = await provisionAgentDefaultCard(seeded);
    expect(result.kind).toBe("provisioned");

    const [after] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    // No re-mint: the card stays free of a project workspace even though the run
    // executed against the project primary.
    expect(after.projectWorkspaceId).toBeNull();
    // The preference survives the run — this is exactly what makes the card a card at all.
    expect(after.executionWorkspacePreference).toBe("agent_default");
  });

  it("heals a stored bricked pair during re-provision instead of leaving it bricked", async () => {
    const seeded = await seedSharedWorkspaceProject(true);
    const result = await provisionAgentDefaultCard(seeded);
    expect(result.kind).toBe("provisioned");

    const [after] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    // agent_default wins: the bricked projectWorkspaceId is cleared in this same write.
    expect(after.projectWorkspaceId).toBeNull();
    expect(after.executionWorkspacePreference).toBe("agent_default");
  });
});
