import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issuePlanDecompositions,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const execFileAsync = promisify(execFile);

const adapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "Workspace occupancy test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  listAdapterModelProfiles: async () => [],
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat workspace occupancy tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;
type Heartbeat = ReturnType<typeof heartbeatService>;

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createGitRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-occupancy-repo-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip-test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await writeFile(path.join(repoRoot, "README.md"), "workspace occupancy\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor<T>(
  probe: () => Promise<T | null>,
  timeoutMs = 15_000,
  label = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForRunToFinish(heartbeat: Heartbeat, runId: string, timeoutMs = 20_000) {
  return waitFor(
    async () => {
      const run = await heartbeat.getRun(runId);
      return run && run.status !== "queued" && run.status !== "running" ? run : null;
    },
    timeoutMs,
    `run ${runId} to finish`,
  );
}

async function waitForHeartbeatIdle(db: Db, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * This suite deliberately leaves a scheduled retry behind, and the scheduler can
 * mint fresh heartbeat rows between the drain and the deletes that depend on it.
 * Retry the whole chain rather than the tail: a foreign-key violation here means
 * new rows appeared, not that anything is wrong with the run under test.
 */
async function resetDatabase(db: Db) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await db.delete(issuePlanDecompositions);
      await db.delete(issueDocuments);
      await db.delete(documentRevisions);
      await db.delete(documents);
      await db.delete(agentTaskSessions);
      await db.delete(environmentLeases);
      await db.delete(workspaceOperations);
      await db.delete(activityLog);
      await db.delete(heartbeatRunEvents);
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      await db.delete(issueComments);
      await db.delete(issues);
      await db.delete(projectWorkspaces);
      await db.delete(projects);
      await db.delete(agentRuntimeState);
      await db.delete(agents);
      await db.delete(executionWorkspaces);
      await db.delete(environments);
      await db.delete(companySkills);
      await db.delete(companies);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

function readAdapterCall(input: unknown) {
  const context = (input as { context?: Record<string, unknown> }).context ?? {};
  const workspace = context.paperclipWorkspace as Record<string, unknown> | undefined;
  return {
    issueId: typeof context.issueId === "string" ? context.issueId : null,
    executionWorkspaceId:
      typeof context.executionWorkspaceId === "string" ? context.executionWorkspaceId : null,
    cwd: typeof workspace?.cwd === "string" ? workspace.cwd : null,
    branchName: typeof workspace?.branchName === "string" ? workspace.branchName : null,
  };
}

async function seedSharedWorkspaceTargets(db: Db, repoRoot: string) {
  const companyId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();
  const occupantIssueId = randomUUID();
  const contenderIssueId = randomUUID();
  const occupantAgentId = randomUUID();
  const contenderAgentId = randomUUID();

  await instanceSettingsService(db).updateExperimental({
    enableIsolatedWorkspaces: true,
  });
  await db.insert(companies).values({
    id: companyId,
    name: "Acme",
    issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    status: "active",
    defaultResponsibleUserId: "responsible-user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name: "Workspace Occupancy Guard",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(projectWorkspaces).values({
    id: projectWorkspaceId,
    companyId,
    projectId,
    name: "Primary",
    cwd: repoRoot,
    isPrimary: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  // Two agents, because a single agent serialises its own runs and would hide
  // the collision this guard exists to prevent.
  for (const [agentId, name] of [
    [occupantAgentId, "OccupantCoder"],
    [contenderAgentId, "ContenderCoder"],
  ] as const) {
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
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
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  for (const [issueId, agentId, title] of [
    [occupantIssueId, occupantAgentId, "Occupies the shared worktree"],
    [contenderIssueId, contenderAgentId, "Wants the same shared worktree"],
  ] as const) {
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title,
      status: "in_progress",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: agentId,
      identifier: `PAP-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      executionWorkspaceSettings: { mode: "isolated_workspace" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  return {
    companyId,
    occupantIssueId,
    contenderIssueId,
    occupantAgentId,
    contenderAgentId,
  };
}

async function wakeIssue(heartbeat: Heartbeat, agentId: string, issueId: string) {
  return heartbeat.wakeup(agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_commented",
    payload: { issueId },
    contextSnapshot: {
      issueId,
      taskId: issueId,
      wakeReason: "issue_commented",
      skipIssueComment: true,
    },
  });
}

describeEmbeddedPostgres("heartbeat shared execution workspace occupancy guard", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];
  const releaseGates: Array<() => void> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-occupancy-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    while (releaseGates.length > 0) releaseGates.pop()?.();
    await waitForHeartbeatIdle(db);
    adapterExecute.mockReset();
    adapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Workspace occupancy test run.",
      provider: "test",
      model: "test-model",
    }));
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await resetDatabase(db);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  }, 60_000);

  /**
   * Park the occupant mid-run inside its worktree, bind the contender issue to
   * the same workspace, and hand the contender back. Returns once the contender
   * run has come to rest.
   */
  async function runContenderAgainstOccupiedWorkspace(heartbeat: Heartbeat, seeded: {
    occupantAgentId: string;
    occupantIssueId: string;
    contenderAgentId: string;
    contenderIssueId: string;
  }) {
    const occupantStarted = deferred<{ executionWorkspaceId: string; cwd: string; branchName: string }>();
    const occupantMayFinish = deferred<void>();
    releaseGates.push(() => occupantMayFinish.resolve());

    adapterExecute.mockImplementation(async (input) => {
      const call = readAdapterCall(input);
      if (call.issueId === seeded.occupantIssueId) {
        occupantStarted.resolve({
          executionWorkspaceId: call.executionWorkspaceId!,
          cwd: call.cwd!,
          branchName: call.branchName!,
        });
        await occupantMayFinish.promise;
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Workspace occupancy test run.",
        provider: "test",
        model: "test-model",
      };
    });

    const occupantRun = await wakeIssue(heartbeat, seeded.occupantAgentId, seeded.occupantIssueId);
    expect(occupantRun).not.toBeNull();
    const occupantWorkspace = await occupantStarted.promise;

    await db
      .update(issues)
      .set({
        executionWorkspaceId: occupantWorkspace.executionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
        updatedAt: new Date(),
      })
      .where(eq(issues.id, seeded.contenderIssueId));

    const contenderRun = await wakeIssue(heartbeat, seeded.contenderAgentId, seeded.contenderIssueId);
    expect(contenderRun).not.toBeNull();
    const settledContender = await waitForRunToFinish(heartbeat, contenderRun!.id);

    return {
      occupantRunId: occupantRun!.id,
      occupantWorkspace,
      contenderRunId: contenderRun!.id,
      settledContender,
      releaseOccupant: () => occupantMayFinish.resolve(),
    };
  }

  it("defers a dispatch whose workspace is still held by another issue's run", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const seeded = await seedSharedWorkspaceTargets(db, repoRoot);
    const heartbeat = heartbeatService(db);

    const { occupantWorkspace, contenderRunId, settledContender, releaseOccupant } =
      await runContenderAgainstOccupiedWorkspace(heartbeat, seeded);

    // The contender must not have entered the worktree at all.
    expect(settledContender).toMatchObject({
      status: "cancelled",
      errorCode: "execution_workspace_occupied",
    });
    const contenderAdapterCalls = adapterExecute.mock.calls.filter(
      ([input]) => readAdapterCall(input).issueId === seeded.contenderIssueId,
    );
    expect(contenderAdapterCalls).toHaveLength(0);

    // ...and the work is not dropped: a successor is queued to try again.
    const successor = await waitFor(
      async () =>
        db
          .select()
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.retryOfRunId, contenderRunId),
            eq(heartbeatRuns.scheduledRetryReason, "execution_workspace_occupied"),
          ))
          .then((rows) => rows[0] ?? null),
      10_000,
      "the deferred contender's successor run",
    );
    expect(successor.scheduledRetryAttempt).toBe(1);
    expect(successor.scheduledRetryAt).not.toBeNull();

    releaseOccupant();
    await waitForHeartbeatIdle(db);

    // The occupant kept the worktree it started with; nothing forked it away.
    const workspaceRow = await db
      .select({ id: executionWorkspaces.id })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, occupantWorkspace.executionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    expect(workspaceRow).not.toBeNull();
  }, 60_000);

  it("reuses the same workspace once the occupant releases it", async () => {
    const repoRoot = await createGitRepo();
    tempRoots.push(repoRoot);
    const seeded = await seedSharedWorkspaceTargets(db, repoRoot);
    const heartbeat = heartbeatService(db);

    const { occupantWorkspace, contenderRunId, releaseOccupant, occupantRunId } =
      await runContenderAgainstOccupiedWorkspace(heartbeat, seeded);

    releaseOccupant();
    await waitForRunToFinish(heartbeat, occupantRunId);
    await waitForHeartbeatIdle(db);

    // Waiting is only worth anything if the wait actually ends in the workspace
    // the contender wanted. Bring the scheduled retry forward rather than
    // sleeping out its real delay.
    const successor = await waitFor(
      async () =>
        db
          .select()
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.retryOfRunId, contenderRunId),
            eq(heartbeatRuns.scheduledRetryReason, "execution_workspace_occupied"),
          ))
          .then((rows) => rows[0] ?? null),
      10_000,
      "the deferred contender's successor run",
    );
    await db
      .update(heartbeatRuns)
      .set({ scheduledRetryAt: new Date(Date.now() - 60_000), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, successor.id));

    await heartbeat.promoteDueScheduledRetries();
    // Promotion only moves the run into the queued pool; the scheduler loop that
    // would normally drain it is not running under test.
    await heartbeat.resumeQueuedRuns();
    const promotedRun = await waitForRunToFinish(heartbeat, successor.id, 30_000);
    expect(promotedRun).toMatchObject({ status: "succeeded" });

    const contenderCalls = adapterExecute.mock.calls
      .map(([input]) => readAdapterCall(input))
      .filter((call) => call.issueId === seeded.contenderIssueId);
    expect(contenderCalls).toHaveLength(1);
    expect(contenderCalls[0]?.executionWorkspaceId).toBe(occupantWorkspace.executionWorkspaceId);
    expect(contenderCalls[0]?.cwd).toBe(occupantWorkspace.cwd);
  }, 90_000);
});
