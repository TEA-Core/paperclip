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
  issueRecoveryActions,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  heartbeatService,
  readExecutionWorkspaceOccupancyDeferrals,
  resolveExecutionWorkspaceOccupancyDecision,
} from "../services/heartbeat.ts";
import { executionFailureRetryCount } from "../services/execution-recovery-attempt.js";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { legacyExecutionNeedsReconciliation } from "../services/legacy-execution-recovery.js";

const execFileAsync = promisify(execFile);

// Fold 2c / occupancy-retry-count: a one-shot, per-issue failure injected at
// environment acquisition, which runs after the occupancy guard lets a run into
// its workspace and before the adapter is invoked. It is the real pre-provider
// setup failure path (errorCode setup_failed, bootstrap recovery evidence).
const environmentAcquireFailure = vi.hoisted(() => ({ issueIds: new Set<string>() }));

vi.mock("../services/environment-run-orchestrator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/environment-run-orchestrator.js")>();
  return {
    ...actual,
    environmentRunOrchestrator: (...args: Parameters<typeof actual.environmentRunOrchestrator>) => {
      const orchestrator = actual.environmentRunOrchestrator(...args);
      return {
        ...orchestrator,
        acquireForRun: async (input: Parameters<typeof orchestrator.acquireForRun>[0]) => {
          if (input.issueId && environmentAcquireFailure.issueIds.delete(input.issueId)) {
            throw new Error("Injected environment acquisition failure after the occupancy wait");
          }
          return orchestrator.acquireForRun(input);
        },
      };
    },
  };
});

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
      await db.delete(issueRecoveryActions);
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
    environmentAcquireFailure.issueIds.clear();
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

  // Fold 2c / occupancy-retry-count (operator ruling 2026-09-16). Upstream #13075
  // (35fdc0c66) bounds legacy failure retries with executionFailureRetryCount: a
  // pre-provider failure is held for board reconciliation once the count reaches
  // 2, and the bounded retry is exhausted past 2. Upstream knows only its own
  // workspace_busy wait as a non-failure. The occupancy guard's
  // scheduledRetryAttempt counts deferrals, so without carrying the pre-wait
  // failure count a contender that merely waited twice was held (or exhausted)
  // on its first real failure.
  describe("failure retry accounting across occupancy deferrals", () => {
    const OCCUPANCY_RETRY = {
      retryReason: "execution_workspace_occupied",
      wakeReason: "execution_workspace_occupied_retry",
      // Mirrors onExecutionWorkspaceOccupied's scheduler options.
      maxAttempts: 8,
      delayMs: 5 * 60_000,
    } as const;
    const bootstrapFailure = { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } };

    async function waitForOccupancySuccessor(predecessorRunId: string) {
      return waitFor(
        async () =>
          db
            .select()
            .from(heartbeatRuns)
            .where(and(
              eq(heartbeatRuns.retryOfRunId, predecessorRunId),
              eq(heartbeatRuns.scheduledRetryReason, "execution_workspace_occupied"),
            ))
            .then((rows) => rows[0] ?? null),
        10_000,
        `the occupancy successor of run ${predecessorRunId}`,
      );
    }

    async function promoteAndSettle(heartbeat: Heartbeat, runId: string) {
      await db
        .update(heartbeatRuns)
        .set({ scheduledRetryAt: new Date(Date.now() - 60_000), updatedAt: new Date() })
        .where(eq(heartbeatRuns.id, runId));
      await heartbeat.promoteDueScheduledRetries();
      await heartbeat.resumeQueuedRuns();
      return waitForRunToFinish(heartbeat, runId, 30_000);
    }

    async function readRun(runId: string) {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      if (!row) throw new Error(`run ${runId} is missing`);
      return row;
    }

    async function legacyHoldsFor(issueId: string) {
      return db
        .select()
        .from(issueRecoveryActions)
        .where(and(
          eq(issueRecoveryActions.sourceIssueId, issueId),
          eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"),
        ));
    }

    /** A contender run at rest, written the way the retry paths leave it. */
    async function insertContenderRun(
      seeded: Awaited<ReturnType<typeof seedSharedWorkspaceTargets>>,
      run: Partial<typeof heartbeatRuns.$inferInsert> & Pick<typeof heartbeatRuns.$inferInsert, "status">,
    ) {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({
        id,
        companyId: seeded.companyId,
        agentId: seeded.contenderAgentId,
        invocationSource: "automation",
        finishedAt: new Date(),
        ...run,
        contextSnapshot: { issueId: seeded.contenderIssueId, ...run.contextSnapshot },
      });
      return id;
    }

    /** What onExecutionWorkspaceOccupied writes before it schedules the successor. */
    async function cancelAsOccupied(runId: string) {
      await db
        .update(heartbeatRuns)
        .set({ status: "cancelled", errorCode: "execution_workspace_occupied", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, runId));
    }

    /** A real pre-provider failure: setup_failed with bootstrap evidence and no conversation policy. */
    async function failBeforeProvider(runId: string) {
      await db
        .update(heartbeatRuns)
        .set({ status: "failed", errorCode: "setup_failed", finishedAt: new Date(), resultJson: bootstrapFailure })
        .where(eq(heartbeatRuns.id, runId));
    }

    async function scheduled(result: Awaited<ReturnType<Heartbeat["scheduleBoundedRetry"]>>) {
      if (result.outcome !== "scheduled" || !result.run) {
        throw new Error(`expected a scheduled retry, got ${JSON.stringify(result)}`);
      }
      return readRun(result.run.id);
    }

    // claude_local/codex_local-style conversation adapters record the #13237
    // continuation policy on failure, which bypasses the board hold, so there the
    // count decides retry exhaustion; a non-conversation adapter gets the hold.
    it.each(["codex_local", "process"])(
      "gives a %s contender that waited twice and then fails once for real a bounded retry, not a board hold",
      async (contenderAdapterType) => {
        const repoRoot = await createGitRepo();
        tempRoots.push(repoRoot);
        const seeded = await seedSharedWorkspaceTargets(db, repoRoot);
        await db
          .update(agents)
          .set({ adapterType: contenderAdapterType })
          .where(eq(agents.id, seeded.contenderAgentId));
        const heartbeat = heartbeatService(db);

        const { contenderRunId, occupantRunId, releaseOccupant } =
          await runContenderAgainstOccupiedWorkspace(heartbeat, seeded);
        const firstDeferral = await waitForOccupancySuccessor(contenderRunId);
        expect(firstDeferral.scheduledRetryAttempt).toBe(1);

        // The occupant still holds the worktree, so the real guard defers again.
        expect(await promoteAndSettle(heartbeat, firstDeferral.id)).toMatchObject({
          status: "cancelled",
          errorCode: "execution_workspace_occupied",
        });
        const secondDeferral = await waitForOccupancySuccessor(firstDeferral.id);
        expect(secondDeferral.scheduledRetryAttempt).toBe(2);

        releaseOccupant();
        await waitForRunToFinish(heartbeat, occupantRunId);
        await waitForHeartbeatIdle(db);

        // The contender now gets its workspace and fails once, before the provider starts.
        environmentAcquireFailure.issueIds.add(seeded.contenderIssueId);
        expect(await promoteAndSettle(heartbeat, secondDeferral.id)).toMatchObject({
          status: "failed",
          errorCode: "setup_failed",
        });
        const failed = await readRun(secondDeferral.id);
        expect(failed.resultJson).toMatchObject(bootstrapFailure);

        // Wait for the failure's follow-up to settle, whichever one it is.
        const followUp = await waitFor(
          async () => {
            const [retryRun] = await db
              .select()
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.retryOfRunId, failed.id));
            const holds = await legacyHoldsFor(seeded.contenderIssueId);
            return retryRun || holds.length > 0 ? { retryRun: retryRun ?? null, holds } : null;
          },
          10_000,
          "the contender failure's retry or board hold",
        );
        expect(followUp.holds).toEqual([]);
        expect(followUp.retryRun).not.toBeNull();
        expect(await heartbeat.scheduleBoundedRetry(failed.id, { random: () => 0 })).toMatchObject({
          outcome: "scheduled",
        });
        expect(executionFailureRetryCount(failed)).toBe(0);
        expect(legacyExecutionNeedsReconciliation(failed)).toBe(false);
        // Each deferral carried the contender's pre-wait failure count forward.
        for (const deferral of [firstDeferral, secondDeferral]) {
          expect((await readRun(deferral.id)).contextSnapshot).toMatchObject({
            failureRetriesBeforeWorkspaceWait: 0,
          });
        }

        // Let the retry run to rest so its late writes cannot race the teardown.
        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();
        await waitForHeartbeatIdle(db);
        await heartbeat.drainActiveRunExecutions();
        expect(await legacyHoldsFor(seeded.contenderIssueId)).toEqual([]);
      },
      120_000,
    );

    it("keeps genuine real failures on both sides of a wait on the upstream hold and retry bound", async () => {
      const seeded = await seedSharedWorkspaceTargets(db, os.tmpdir());
      const heartbeat = heartbeatService(db);

      // Control, no wait involved: two real failures already spent.
      const control = await insertContenderRun(seeded, {
        status: "failed",
        errorCode: "setup_failed",
        scheduledRetryReason: "transient_failure",
        scheduledRetryAttempt: 2,
        resultJson: bootstrapFailure,
      });
      const controlRow = await readRun(control);
      expect(legacyExecutionNeedsReconciliation(controlRow)).toBe(true);
      expect(await heartbeat.scheduleBoundedRetry(control, { random: () => 0 })).toMatchObject({
        outcome: "retry_exhausted",
        attempt: 3,
        maxAttempts: 2,
      });

      // The same two real failures, then a claim that waits twice, then one more failure.
      const secondRetry = await insertContenderRun(seeded, {
        status: "cancelled",
        errorCode: "execution_workspace_occupied",
        scheduledRetryReason: "transient_failure",
        scheduledRetryAttempt: 2,
      });
      // SUP-16566: the wait budget is separate from the transient budget, so the
      // first deferral after two transient retries is attempt 1, not 3.
      const firstWait = await scheduled(await heartbeat.scheduleBoundedRetry(secondRetry, OCCUPANCY_RETRY));
      expect(firstWait).toMatchObject({ scheduledRetryReason: "execution_workspace_occupied", scheduledRetryAttempt: 1 });
      expect(firstWait.contextSnapshot).toMatchObject({ failureRetriesBeforeWorkspaceWait: 2 });
      await cancelAsOccupied(firstWait.id);
      const secondWait = await scheduled(await heartbeat.scheduleBoundedRetry(firstWait.id, OCCUPANCY_RETRY));
      expect(secondWait).toMatchObject({ scheduledRetryReason: "execution_workspace_occupied", scheduledRetryAttempt: 2 });
      expect(secondWait.contextSnapshot).toMatchObject({ failureRetriesBeforeWorkspaceWait: 2 });
      await failBeforeProvider(secondWait.id);
      const failedAfterWait = await readRun(secondWait.id);
      expect(executionFailureRetryCount(failedAfterWait)).toBe(executionFailureRetryCount(controlRow));
      expect(legacyExecutionNeedsReconciliation(failedAfterWait)).toBe(true);
      expect(await heartbeat.scheduleBoundedRetry(secondWait.id, { random: () => 0 })).toMatchObject({
        outcome: "retry_exhausted",
        attempt: 3,
        maxAttempts: 2,
      });

      // No failures before a wait: real failures after it count up from zero to the same bound.
      const firstClaim = await insertContenderRun(seeded, {
        status: "cancelled",
        errorCode: "execution_workspace_occupied",
      });
      const wait = await scheduled(await heartbeat.scheduleBoundedRetry(firstClaim, OCCUPANCY_RETRY));
      await cancelAsOccupied(wait.id);
      const lastWait = await scheduled(await heartbeat.scheduleBoundedRetry(wait.id, OCCUPANCY_RETRY));
      expect(lastWait.scheduledRetryAttempt).toBe(2);
      await failBeforeProvider(lastWait.id);
      expect(legacyExecutionNeedsReconciliation(await readRun(lastWait.id))).toBe(false);
      const firstRetry = await scheduled(await heartbeat.scheduleBoundedRetry(lastWait.id, { random: () => 0 }));
      expect(firstRetry).toMatchObject({ scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 1 });
      await failBeforeProvider(firstRetry.id);
      expect(legacyExecutionNeedsReconciliation(await readRun(firstRetry.id))).toBe(false);
      const secondRetryRun = await scheduled(await heartbeat.scheduleBoundedRetry(firstRetry.id, { random: () => 0 }));
      expect(secondRetryRun).toMatchObject({ scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 2 });
      // The wait's carried count rides along in context but is not trusted outside a wait.
      expect(secondRetryRun.contextSnapshot).toMatchObject({ failureRetriesBeforeWorkspaceWait: 0 });
      await failBeforeProvider(secondRetryRun.id);
      const exhausted = await readRun(secondRetryRun.id);
      expect(executionFailureRetryCount(exhausted)).toBe(2);
      expect(legacyExecutionNeedsReconciliation(exhausted)).toBe(true);
      expect(await heartbeat.scheduleBoundedRetry(secondRetryRun.id, { random: () => 0 })).toMatchObject({
        outcome: "retry_exhausted",
        attempt: 3,
        maxAttempts: 2,
      });
    }, 60_000);

    it("leaves the occupancy guard's eight-deferral bound unchanged", async () => {
      const seeded = await seedSharedWorkspaceTargets(db, os.tmpdir());
      const heartbeat = heartbeatService(db);

      let predecessor: string = await insertContenderRun(seeded, {
        status: "cancelled",
        errorCode: "execution_workspace_occupied",
      });
      for (let deferral = 1; deferral <= 8; deferral += 1) {
        const successor = await scheduled(await heartbeat.scheduleBoundedRetry(predecessor, OCCUPANCY_RETRY));
        expect(successor).toMatchObject({
          scheduledRetryReason: "execution_workspace_occupied",
          scheduledRetryAttempt: deferral,
        });
        expect(successor.contextSnapshot).toMatchObject({ failureRetriesBeforeWorkspaceWait: 0 });
        // The guard's own default budget decides from the successor's deferral count.
        expect(resolveExecutionWorkspaceOccupancyDecision({
          reuseRequested: true,
          occupied: true,
          priorDeferrals: readExecutionWorkspaceOccupancyDeferrals(successor),
        })).toMatchObject(deferral < 8 ? { action: "defer", attempt: deferral + 1 } : { action: "provision_fresh", deferrals: 8 });
        await cancelAsOccupied(successor.id);
        predecessor = successor.id;
      }
      expect(await heartbeat.scheduleBoundedRetry(predecessor, OCCUPANCY_RETRY)).toMatchObject({
        outcome: "retry_exhausted",
        attempt: 9,
        maxAttempts: 8,
      });
    }, 60_000);

    it("leaves upstream's workspace_busy accounting unchanged", async () => {
      const seeded = await seedSharedWorkspaceTargets(db, os.tmpdir());
      const heartbeat = heartbeatService(db);
      const workspaceWait = { executionRecovery: { kind: "workspace_wait", providerWorkStarted: false } };
      const busyRetry = (attempt: number) => ({
        retryReason: "workspace_busy",
        wakeReason: "workspace_busy_retry",
        maxAttempts: attempt + 1,
        delayMs: 1_000,
      });

      // One real failure, then two workspace_busy waits.
      const firstRetry = await insertContenderRun(seeded, {
        status: "cancelled",
        errorCode: "workspace_busy",
        scheduledRetryReason: "transient_failure",
        scheduledRetryAttempt: 1,
        resultJson: workspaceWait,
      });
      const busy = await scheduled(await heartbeat.scheduleBoundedRetry(firstRetry, busyRetry(1)));
      expect(busy).toMatchObject({ scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 2 });
      expect(busy.contextSnapshot).toMatchObject({ failureRetriesBeforeWorkspaceWait: 1 });
      await db
        .update(heartbeatRuns)
        .set({ status: "cancelled", errorCode: "workspace_busy", resultJson: workspaceWait })
        .where(eq(heartbeatRuns.id, busy.id));
      const busyAgain = await scheduled(await heartbeat.scheduleBoundedRetry(busy.id, busyRetry(2)));
      expect(busyAgain).toMatchObject({ scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 3 });
      expect(busyAgain.contextSnapshot).toMatchObject({ failureRetriesBeforeWorkspaceWait: 1 });
      await failBeforeProvider(busyAgain.id);
      expect(executionFailureRetryCount(await readRun(busyAgain.id))).toBe(1);
      const lastRetry = await scheduled(await heartbeat.scheduleBoundedRetry(busyAgain.id, { random: () => 0 }));
      expect(lastRetry).toMatchObject({ scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 2 });
      await failBeforeProvider(lastRetry.id);
      expect(await heartbeat.scheduleBoundedRetry(lastRetry.id, { random: () => 0 })).toMatchObject({
        outcome: "retry_exhausted",
      });

      // A workspace_busy wait entered from an occupancy deferral keeps the carried count.
      const occupancyWait = await insertContenderRun(seeded, {
        status: "cancelled",
        errorCode: "workspace_busy",
        scheduledRetryReason: "execution_workspace_occupied",
        scheduledRetryAttempt: 5,
        contextSnapshot: { failureRetriesBeforeWorkspaceWait: 1 },
        resultJson: workspaceWait,
      });
      const busyAfterOccupancy = await scheduled(
        await heartbeat.scheduleBoundedRetry(occupancyWait, busyRetry(5)),
      );
      expect(busyAfterOccupancy).toMatchObject({ scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 6 });
      expect(busyAfterOccupancy.contextSnapshot).toMatchObject({ failureRetriesBeforeWorkspaceWait: 1 });
    }, 60_000);

    // SUP-16566 (operator-mandated test group 1): the transient-retry budget and
    // the occupancy-deferral budget are separate. A first deferral starts at 1
    // no matter how many transient retries came before, so N transient retries
    // never shrink — and never drop — the eight-deferral wait.
    it.each([0, 3, 8, 9])(
      "grants the full eight-deferral wait after %i transient-failure retries",
      async (transientRetries) => {
        const seeded = await seedSharedWorkspaceTargets(db, os.tmpdir());
        const heartbeat = heartbeatService(db);

        // The run that meets the occupied workspace: a transient-retry
        // successor (its reason is transient_failure, so its attempt is the
        // transient count) that the occupancy guard just cancelled.
        let predecessor: string = await insertContenderRun(seeded, {
          status: "cancelled",
          errorCode: "execution_workspace_occupied",
          scheduledRetryReason: "transient_failure",
          scheduledRetryAttempt: transientRetries,
        });

        for (let deferral = 1; deferral <= 8; deferral += 1) {
          const successor = await scheduled(await heartbeat.scheduleBoundedRetry(predecessor, OCCUPANCY_RETRY));
          expect(successor).toMatchObject({
            scheduledRetryReason: "execution_workspace_occupied",
            scheduledRetryAttempt: deferral,
          });
          // The pre-wait failure count rides along, so the wait does not reset
          // the transient budget.
          expect(successor.contextSnapshot).toMatchObject({
            failureRetriesBeforeWorkspaceWait: transientRetries,
          });
          await cancelAsOccupied(successor.id);
          predecessor = successor.id;
        }

        // The wait is exhausted only after all eight deferrals, exactly as with
        // no prior transient retries.
        expect(await heartbeat.scheduleBoundedRetry(predecessor, OCCUPANCY_RETRY)).toMatchObject({
          outcome: "retry_exhausted",
          attempt: 9,
          maxAttempts: 8,
        });
      },
      60_000,
    );

    // SUP-16566 (operator-mandated test group 2): the combined transient-retry
    // plus occupancy-deferral chain must terminate. The transient count is
    // carried across every wait (so a wait cannot reset it) and the number of
    // waits is bounded by the transient budget, so there is no endless
    // ping-pong in which each counter resets the other.
    it("bounds the combined transient-failure and occupancy-deferral chain", async () => {
      const seeded = await seedSharedWorkspaceTargets(db, os.tmpdir());
      const heartbeat = heartbeatService(db);
      const TRANSIENT_MAX_ATTEMPTS = 2;

      let current: string = await insertContenderRun(seeded, {
        status: "cancelled",
        errorCode: "execution_workspace_occupied",
        scheduledRetryReason: "transient_failure",
        scheduledRetryAttempt: 0,
      });
      let transientRetries = 0;
      let occupancyDeferrals = 0;
      let hops = 0;
      let lastOutcome: Awaited<ReturnType<Heartbeat["scheduleBoundedRetry"]>> | null = null;
      const cap = 40;

      for (; hops < cap; hops += 1) {
        // The workspace is occupied: defer once.
        const deferred = await heartbeat.scheduleBoundedRetry(current, OCCUPANCY_RETRY);
        if (deferred.outcome !== "scheduled" || !deferred.run) {
          lastOutcome = deferred;
          break;
        }
        const deferredRun = await readRun(deferred.run.id);
        occupancyDeferrals += 1;
        // Every wait starts its own deferral budget at 1 and carries the real
        // transient count forward, so neither counter resets the other.
        expect(deferredRun.scheduledRetryAttempt).toBe(1);
        expect(deferredRun.contextSnapshot).toMatchObject({
          failureRetriesBeforeWorkspaceWait: transientRetries,
        });
        await failBeforeProvider(deferredRun.id);

        // Then the run fails for real before the provider starts.
        const retried = await heartbeat.scheduleBoundedRetry(deferredRun.id, { random: () => 0 });
        if (retried.outcome !== "scheduled" || !retried.run) {
          lastOutcome = retried;
          break;
        }
        transientRetries += 1;
        current = retried.run.id;
      }

      expect(lastOutcome?.outcome).toBe("retry_exhausted");
      expect(transientRetries).toBe(TRANSIENT_MAX_ATTEMPTS);
      expect(occupancyDeferrals).toBe(TRANSIENT_MAX_ATTEMPTS + 1);
      // The whole chain is bounded well below the safety cap.
      expect(hops).toBeLessThan(cap);
      expect(occupancyDeferrals).toBeLessThanOrEqual((TRANSIENT_MAX_ATTEMPTS + 1) * 8);
    }, 60_000);

    // SUP-16566 (operator-mandated test group 3): the attempt number a deferral
    // notice reports is the deferral count actually written to the successor,
    // and a real failure after a wait reports the carried transient count. The
    // two counters never disagree with the notice (before the fix the notice
    // said 1 while the successor was scheduled at N+1).
    it("reports notice attempts that match the count actually used", async () => {
      const seeded = await seedSharedWorkspaceTargets(db, os.tmpdir());
      const heartbeat = heartbeatService(db);

      let predecessor = await readRun(await insertContenderRun(seeded, {
        status: "cancelled",
        errorCode: "execution_workspace_occupied",
        scheduledRetryReason: "transient_failure",
        scheduledRetryAttempt: 2,
      }));

      for (let deferral = 1; deferral <= 3; deferral += 1) {
        // onExecutionWorkspaceOccupied builds its "deferring attempt X/8"
        // notice from this decision.
        const notice = resolveExecutionWorkspaceOccupancyDecision({
          reuseRequested: true,
          occupied: true,
          priorDeferrals: readExecutionWorkspaceOccupancyDeferrals(predecessor),
        });
        const successor = await scheduled(await heartbeat.scheduleBoundedRetry(predecessor.id, OCCUPANCY_RETRY));
        expect(notice).toMatchObject({ action: "defer", attempt: deferral, maxDeferrals: 8 });
        expect(successor.scheduledRetryAttempt).toBe(deferral);
        await cancelAsOccupied(successor.id);
        predecessor = await readRun(successor.id);
      }

      // A real failure after the wait reports the carried transient count + 1,
      // not the deferral count.
      await failBeforeProvider(predecessor.id);
      expect(await heartbeat.scheduleBoundedRetry(predecessor.id, { random: () => 0 })).toMatchObject({
        outcome: "retry_exhausted",
        attempt: 3,
        maxAttempts: 2,
      });
    }, 60_000);
  });
});

describe("Fold 2c / occupancy-retry-count: executionFailureRetryCount for occupancy deferrals", () => {
  it("reads an occupancy successor's carried pre-wait failure count, not its deferral count", () => {
    expect(executionFailureRetryCount({
      scheduledRetryReason: "execution_workspace_occupied",
      scheduledRetryAttempt: 6,
      contextSnapshot: { failureRetriesBeforeWorkspaceWait: 0 },
    })).toBe(0);
    expect(executionFailureRetryCount({
      scheduledRetryReason: "execution_workspace_occupied",
      scheduledRetryAttempt: 6,
      contextSnapshot: { failureRetriesBeforeWorkspaceWait: 2 },
    })).toBe(2);
  });

  it("stays conservative for an occupancy successor written without a valid carried count", () => {
    for (const contextSnapshot of [undefined, {}, { failureRetriesBeforeWorkspaceWait: -1 },
      { failureRetriesBeforeWorkspaceWait: 1.5 }, { failureRetriesBeforeWorkspaceWait: "0" }]) {
      expect(executionFailureRetryCount({
        scheduledRetryReason: "execution_workspace_occupied",
        scheduledRetryAttempt: 3,
        contextSnapshot,
      })).toBe(3);
    }
  });

  it("keeps upstream's workspace_busy, transient and continuation readings", () => {
    expect(executionFailureRetryCount({ scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 12,
      contextSnapshot: { failureRetriesBeforeWorkspaceWait: 1 } })).toBe(1);
    expect(executionFailureRetryCount({ scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 4 })).toBe(4);
    expect(executionFailureRetryCount({ scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 2,
      contextSnapshot: { failureRetriesBeforeWorkspaceWait: 0 } })).toBe(2);
    expect(executionFailureRetryCount({ scheduledRetryReason: "max_turns_continuation", scheduledRetryAttempt: 4 })).toBe(0);
  });

  it("holds a legacy failure after a wait only for genuine prior failures", () => {
    const failedAfterWait = (failureRetriesBeforeWorkspaceWait: number) => ({
      runtimeMode: "legacy",
      status: "failed",
      errorCode: "setup_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      scheduledRetryReason: "execution_workspace_occupied",
      scheduledRetryAttempt: 2,
      contextSnapshot: { failureRetriesBeforeWorkspaceWait },
    });
    expect(legacyExecutionNeedsReconciliation(failedAfterWait(0))).toBe(false);
    expect(legacyExecutionNeedsReconciliation(failedAfterWait(1))).toBe(false);
    expect(legacyExecutionNeedsReconciliation(failedAfterWait(2))).toBe(true);
    // The deferral itself stays exempt however long the wait (a262e0fad).
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy",
      status: "cancelled",
      errorCode: "execution_workspace_occupied",
      resultJson: null,
      scheduledRetryReason: "execution_workspace_occupied",
      scheduledRetryAttempt: 8,
    })).toBe(false);
  });
});
