import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companyMemberships,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

// SUP-17978. enqueueWakeup admits a wake inside a transaction that holds the
// issue row (or, for a wake with no issue, the agent row) FOR UPDATE. On
// 2026-09-29 production wedged twice at 10-14 concurrent runs: every backend
// sat `idle in transaction` (wait_event ClientRead) while the server stopped
// answering DB-backed routes. The transaction resolved the queued run's
// responsible user — and, with isolated workspaces on, the prior task session —
// through the app-wide pool instead of the transaction. That read needs a
// second connection while the first is held; once every pool connection is
// held by such a transaction, or by a wake queued on its row lock, the pool
// waits on itself and Postgres cannot see the deadlock.
//
// A one-connection pool makes the same deadlock deterministic with one wake:
// any pool read issued while the admission transaction is open waits forever.

// A test can hold the adapter open to keep a run live on its issue.
const adapterGate = vi.hoisted(() => ({ hold: null as Promise<void> | null }));
const adapterExecute = vi.hoisted(() =>
  vi.fn(async () => {
    if (adapterGate.hold) await adapterGate.hold;
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "done",
    };
  }),
);

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute: adapterExecute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute: adapterExecute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const WAKE_BUDGET_MS = 5_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hasLockTimeout(error: unknown): boolean {
  for (
    let cause: unknown = error;
    cause && typeof cause === "object";
    cause = "cause" in cause ? cause.cause : null
  ) {
    if ("code" in cause && typeof cause.code === "string" && cause.code === "55P03") return true;
  }
  return false;
}

// The nested-only issue lock has to still be held when the receipt insert runs.
// A lock that committed in an earlier statement lets this probe take the row.
async function assertNestedIssueLockHeldThroughInsert(
  setupDb: ReturnType<typeof createDb>,
  agentId: string,
  issueId: string,
) {
  const heartbeat = heartbeatService(setupDb);
  await setupDb.execute(sql`
    CREATE OR REPLACE FUNCTION pause_admission_lock_witness() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.reason = 'admission_lock_witness' THEN
        PERFORM pg_sleep(1.5);
      END IF;
      RETURN NEW;
    END $$
  `);
  await setupDb.execute(sql`DROP TRIGGER IF EXISTS pause_admission_lock_witness ON agent_wakeup_requests`);
  await setupDb.execute(sql`
    CREATE TRIGGER pause_admission_lock_witness BEFORE INSERT ON agent_wakeup_requests
    FOR EACH ROW EXECUTE FUNCTION pause_admission_lock_witness()
  `);
  let wakeFinished = false;
  const waking = heartbeat.wakeup(agentId, {
    source: "assignment",
    triggerDetail: "system",
    reason: "admission_lock_witness",
    contextSnapshot: { paperclipIssue: { id: issueId } },
  }).finally(() => { wakeFinished = true; });
  try {
    let paused = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [row] = await setupDb.execute<{ paused: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event = 'PgSleep' AND query ILIKE '%agent_wakeup_requests%'
        ) AS paused
      `);
      if (row?.paused) { paused = true; break; }
      await sleep(20);
    }
    expect(paused).toBe(true);
    expect(wakeFinished).toBe(false);
    let lockHeld = false;
    try {
      await setupDb.transaction(async (tx) => {
        await tx.execute(sql`select set_config('lock_timeout', '400', true)`);
        await tx.execute(sql`select id from issues where id = ${issueId} for update`);
      });
    } catch (error) {
      lockHeld = hasLockTimeout(error);
    }
    expect(lockHeld).toBe(true);
    const run = await waking;
    expect(run).toMatchObject({ id: expect.any(String), status: "queued" });
    const [queued] = await setupDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(queued?.contextSnapshot).toMatchObject({ paperclipIssue: { id: issueId } });
    expect(queued?.contextSnapshot).not.toHaveProperty("issueId");
  } finally {
    await waking.catch(() => null);
    await setupDb.execute(sql`DROP TRIGGER IF EXISTS pause_admission_lock_witness ON agent_wakeup_requests`);
    await setupDb.execute(sql`DROP FUNCTION IF EXISTS pause_admission_lock_witness()`);
  }
}

describe("wake admission never needs a second pool connection (SUP-17978)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let setupDb: ReturnType<typeof createDb>;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-wake-lock-pool-");
    setupDb = createDb(temporary.connectionString);
  }, 60_000);

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await instanceSettingsService(setupDb).updateExperimental({ enableIsolatedWorkspaces: false });
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function seedAgent(label: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    await setupDb.insert(companies).values({
      id: companyId,
      name: `Pool ${label}`,
      issuePrefix: `P${label.slice(0, 3).toUpperCase()}${randomUUID().slice(0, 4).toUpperCase()}`,
      status: "active",
      defaultResponsibleUserId: "responsible-user",
    });
    await setupDb.insert(projects).values({ id: projectId, companyId, name: "Project", status: "active" });
    await setupDb.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      isPrimary: true,
    });
    await setupDb.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${label}`,
      adapterType: "codex_local",
      status: "idle",
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    return { companyId, agentId, projectId, projectWorkspaceId };
  }

  async function seedIssue(seed: Awaited<ReturnType<typeof seedAgent>>) {
    const issueId = randomUUID();
    await setupDb.insert(issues).values({
      id: issueId,
      companyId: seed.companyId,
      projectId: seed.projectId,
      projectWorkspaceId: seed.projectWorkspaceId,
      title: "Pool starvation probe",
      status: "todo",
      workMode: "standard",
      assigneeAgentId: seed.agentId,
    });
    return issueId;
  }

  // A heartbeat service on a one-connection pool, plus a bounded wake: an
  // admission transaction that reads through the pool never settles.
  function onePool() {
    const db = createDb(temporary.connectionString, { maxConnections: 1 });
    const heartbeat = heartbeatService(db);
    cleanups.push(async () => {
      await Promise.race([drainHeartbeatRunsToQuiescence(db, heartbeat), sleep(10_000)]);
      await db.$client.end({ timeout: 1 });
    });
    return {
      db,
      heartbeat,
      async wake(agentId: string, opts: Parameters<typeof heartbeat.wakeup>[1]) {
        const outcome = heartbeat.wakeup(agentId, opts).then(
          (run) => ({ settled: true as const, runId: (run as { id?: string } | null)?.id ?? null }),
          (error: unknown) => ({ settled: true as const, error }),
        );
        return Promise.race([outcome, sleep(WAKE_BUDGET_MS).then(() => ({ settled: false as const }))]);
      },
    };
  }

  it("admits an issue wake without reading the responsible user through the pool", async () => {
    const seed = await seedAgent("issue");
    const issueId = await seedIssue(seed);
    const { wake } = onePool();

    const result = await wake(seed.agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId },
    });

    expect(result).toMatchObject({ settled: true, runId: expect.any(String) });
  }, 30_000);

  it("serializes twenty nested-only wakes against held issue rows without altering their task context", async () => {
    const { wake } = onePool();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const seed = await seedAgent(`nested-${attempt}`);
      const issueId = await seedIssue(seed);
      let signalLocked!: (pid: number) => void;
      let releaseIssue!: () => void;
      const locked = new Promise<number>((resolveLocked) => { signalLocked = resolveLocked; });
      const release = new Promise<void>((resolveRelease) => { releaseIssue = resolveRelease; });
      const holder = setupDb.transaction(async (tx) => {
        const [connection] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid()::int as pid`);
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
        signalLocked(connection!.pid);
        await release;
      });
      const holderPid = await locked;
      const waking = wake(seed.agentId, {
        source: "assignment", triggerDetail: "system", reason: "issue_assigned",
        contextSnapshot: { paperclipIssue: { id: issueId } },
      });
      let waitedForIssue = false;
      let queuedBeforeRelease = false;
      try {
        for (let poll = 0; poll < 80; poll += 1) {
          const [row] = await setupDb.execute<{ waiting: boolean }>(sql`
            select exists (
              select 1 from pg_stat_activity
              where datname = current_database() and pid <> pg_backend_pid()
                and ${holderPid} = any(pg_blocking_pids(pid))
            ) as waiting
          `);
          if (row?.waiting) { waitedForIssue = true; break; }
          await sleep(25);
        }
        queuedBeforeRelease = (await setupDb.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.companyId, seed.companyId))).length > 0;
      } finally {
        releaseIssue();
        await holder;
      }
      const result = await waking;
      expect({ attempt, waitedForIssue, queuedBeforeRelease }).toEqual({
        attempt, waitedForIssue: true, queuedBeforeRelease: false,
      });
      expect(result).toMatchObject({ settled: true, runId: expect.any(String) });
      const [queued] = await setupDb.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, "runId" in result ? result.runId! : ""));
      expect(queued?.contextSnapshot).toMatchObject({ paperclipIssue: { id: issueId } });
      expect(queued?.contextSnapshot).not.toHaveProperty("issueId");
      expect(queued?.contextSnapshot).not.toHaveProperty("taskKey");
    }
    const witness = await seedAgent("placement");
    const witnessIssueId = await seedIssue(witness);
    await assertNestedIssueLockHeldThroughInsert(setupDb, witness.agentId, witnessIssueId);
  }, 120_000);

  it("admits twenty nested-only wakes after an actual restore releases the issue row", async () => {
    const { db, heartbeat, wake } = onePool();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit" } as Express.Request["actor"];
      next();
    });
    app.use("/api", issueRoutes(setupDb, {} as Parameters<typeof issueRoutes>[1], {} as Parameters<typeof issueRoutes>[2]));
    app.use(errorHandler);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const seed = await seedAgent(`restored-${attempt}`);
      const participantId = randomUUID();
      const independentId = randomUUID();
      const issueId = randomUUID();
      const stageId = randomUUID();
      await setupDb.insert(agents).values([
        { id: participantId, companyId: seed.companyId, name: "Participant", adapterType: "codex_local", status: "idle" },
        { id: independentId, companyId: seed.companyId, name: "Independent", adapterType: "codex_local", status: "idle" },
      ]);
      await setupDb.insert(companyMemberships).values([
        { companyId: seed.companyId, principalType: "agent", principalId: seed.agentId, status: "active", membershipRole: "member" },
        { companyId: seed.companyId, principalType: "agent", principalId: participantId, status: "active", membershipRole: "member" },
      ]);
      await setupDb.insert(issues).values({
        id: issueId, companyId: seed.companyId, projectId: seed.projectId,
        projectWorkspaceId: seed.projectWorkspaceId, title: "Held restore wake",
        status: "blocked", assigneeAgentId: seed.agentId,
        executionPolicy: { mode: "normal", stages: [{
          id: stageId, type: "review", approvalsNeeded: 1,
          participants: [{ type: "agent", agentId: participantId }, { type: "agent", agentId: independentId }],
        }] },
        executionState: {
          status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
          currentParticipant: { type: "agent", agentId: participantId, userId: null },
          pendingSince: "2026-10-25T04:57:54.443Z", completedStageIds: [], skippedStageIds: [],
          lastDecisionId: randomUUID(), lastDecisionOutcome: "changes_requested",
          changesRequestedCount: 1, returnAssignee: { type: "agent", agentId: seed.agentId, userId: null },
        },
      });
      let signalLocked!: (pid: number) => void;
      let releaseAudit!: () => void;
      const locked = new Promise<number>((resolve) => { signalLocked = resolve; });
      const release = new Promise<void>((resolve) => { releaseAudit = resolve; });
      const auditHolder = setupDb.transaction(async (tx) => {
        const [connection] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid()::int as pid`);
        await tx.execute(sql`lock table activity_log in access exclusive mode`);
        signalLocked(connection!.pid);
        await release;
      });
      const auditPid = await locked;
      const restoring = Promise.resolve(request(app).post(`/api/issues/${issueId}/restore-participant`).send({
        expectedAssigneeAgentId: seed.agentId, expectedStatus: "blocked",
        expectedStatusVersion: 0, expectedPendingParticipantAgentId: participantId,
      }));
      let restorePid: number | null = null;
      let waitedForRestore = false;
      let queuedBeforeRelease = false;
      let waking: ReturnType<typeof wake> | null = null;
      try {
        for (let poll = 0; poll < 80; poll += 1) {
          const [row] = await setupDb.execute<{ pid: number | null }>(sql`
            select pid from pg_stat_activity
            where datname = current_database() and pid <> pg_backend_pid()
              and ${auditPid} = any(pg_blocking_pids(pid))
              and query like '%activity_log%'
            limit 1
          `);
          if (row?.pid) { restorePid = row.pid; break; }
          await sleep(5);
        }
        if (restorePid) {
          // Restore also locks the pending participant's agent row. A wait on
          // that row still happens if the issue FOR UPDATE is removed.
          waking = wake(participantId, {
            source: "assignment", triggerDetail: "system", reason: "issue_assigned",
            contextSnapshot: { paperclipIssue: { id: issueId } },
          });
          for (let poll = 0; poll < 40; poll += 1) {
            const [row] = await setupDb.execute<{ waitingOnIssue: boolean; waitingOnAgent: boolean }>(sql`
              select
                exists (
                  select 1 from pg_stat_activity
                  where datname = current_database() and pid <> pg_backend_pid()
                    and ${restorePid} = any(pg_blocking_pids(pid))
                    and query ~* 'from[[:space:]]+"?issues"?'
                    and query ~* 'for update'
                ) as "waitingOnIssue",
                exists (
                  select 1 from pg_stat_activity
                  where datname = current_database() and pid <> pg_backend_pid()
                    and ${restorePid} = any(pg_blocking_pids(pid))
                    and query ~* 'from[[:space:]]+"?agents"?'
                    and query ~* 'for update'
                ) as "waitingOnAgent"
            `);
            if (row?.waitingOnIssue) { waitedForRestore = true; break; }
            if (row?.waitingOnAgent) break;
            await sleep(5);
          }
          queuedBeforeRelease = (await setupDb.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
            .where(eq(heartbeatRuns.companyId, seed.companyId))).length > 0;
        }
      } finally {
        releaseAudit();
        await auditHolder;
      }
      const response = await restoring;
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect({ attempt, restorePid: !!restorePid, waitedForRestore, queuedBeforeRelease, status: response.status })
        .toEqual({ attempt, restorePid: true, waitedForRestore: true, queuedBeforeRelease: false, status: 200 });
      const result = await waking!;
      expect(result).toMatchObject({ settled: true, runId: expect.any(String) });
      const [queued] = await setupDb.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, "runId" in result ? result.runId! : ""));
      expect(queued?.contextSnapshot).toMatchObject({ paperclipIssue: { id: issueId } });
      expect(queued?.contextSnapshot).not.toHaveProperty("issueId");
      expect(queued?.contextSnapshot).not.toHaveProperty("taskKey");
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
    }
    const witness = await seedAgent("restore-placement");
    const witnessIssueId = await seedIssue(witness);
    await assertNestedIssueLockHeldThroughInsert(setupDb, witness.agentId, witnessIssueId);
  }, 120_000);

  it("keeps a nested-only wake with a non-UUID id unscoped and admits it", async () => {
    const seed = await seedAgent("nested-unscoped");
    const { wake } = onePool();
    const result = await wake(seed.agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      contextSnapshot: { paperclipIssue: { id: "SUP-1" } },
    });
    expect(result).toMatchObject({ settled: true, runId: expect.any(String) });
    const [queued] = await setupDb.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, "runId" in result ? result.runId! : ""));
    expect(queued?.contextSnapshot).toMatchObject({ paperclipIssue: { id: "SUP-1" } });
    for (const key of ["issueId", "taskId", "taskKey"]) {
      expect(queued?.contextSnapshot).not.toHaveProperty(key);
    }
  }, 30_000);

  it("admits a wake with no issue without reading the responsible user through the pool", async () => {
    const seed = await seedAgent("agent");
    const { wake } = onePool();
    const executionContext = { owner: "background", scope: ["unscoped", "retry"] };
    const result = await wake(seed.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "pool_starvation_probe",
      contextSnapshot: { taskKey: "unscoped-operator-job", executionContext },
    });

    expect(result).toMatchObject({ settled: true, runId: expect.any(String) });
    const [queued] = await setupDb.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, "runId" in result ? result.runId! : ""));
    expect(queued?.contextSnapshot?.taskKey).toBe("unscoped-operator-job");
    expect(JSON.stringify(queued?.contextSnapshot?.executionContext)).toBe(JSON.stringify(executionContext));
    expect(queued?.contextSnapshot).not.toHaveProperty("issueId");
  }, 30_000);

  it("admits as many concurrent wakes for one issue as the pool has connections", async () => {
    // The production convoy: one wake holds the issue row lock, the others
    // queue on it (wait_event tuple/transactionid) and pin the remaining pool
    // connections, so the holder can never get the connection it waits for.
    const poolSize = 4;
    const seed = await seedAgent("convoy");
    const issueId = await seedIssue(seed);
    const db = createDb(temporary.connectionString, {
      maxConnections: poolSize,
      applicationName: "sup-17978-convoy",
    });
    const heartbeat = heartbeatService(db);
    cleanups.push(async () => {
      await Promise.race([drainHeartbeatRunsToQuiescence(db, heartbeat), sleep(10_000)]);
      await db.$client.end({ timeout: 1 });
    });

    const startedAt = performance.now();
    const wakes = Array.from({ length: poolSize }, (_, index) =>
      heartbeat
        .wakeup(seed.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: { issueId, convoyIndex: index },
          contextSnapshot: { issueId, taskId: issueId },
        })
        // A rejected admission fails the test; only the timing of a
        // successful one is measured.
        .then(() => performance.now() - startedAt),
    );
    const settled = await Promise.race([
      Promise.all(wakes),
      sleep(WAKE_BUDGET_MS).then(() => null),
    ]);
    // Anything still holding a transaction open on the client side after the
    // budget is a wedged admission, not a slow one.
    const stuck = await setupDb.$client<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
      where application_name = 'sup-17978-convoy'
        and state = 'idle in transaction'
        and now() - xact_start > interval '2 seconds'`;

    expect(stuck[0]?.n).toBe(0);
    expect(settled).not.toBeNull();
    expect(Math.max(...(settled ?? [Infinity]))).toBeLessThan(WAKE_BUDGET_MS);
  }, 30_000);

  it("promotes a wake deferred behind a finished run without reading through the pool", async () => {
    // A wake that arrives while the issue has a live run is parked as
    // deferred_issue_execution. When that run finishes,
    // releaseIssueExecutionAndPromote locks the issue row and promotes the
    // parked wake into a new run inside the same transaction.
    const seed = await seedAgent("promote");
    const issueId = await seedIssue(seed);
    const { heartbeat, wake } = onePool();
    let releaseAdapter!: () => void;
    adapterGate.hold = new Promise<void>((resolve) => {
      releaseAdapter = resolve;
    });
    cleanups.push(async () => {
      adapterGate.hold = null;
      releaseAdapter();
    });

    const first = await wake(seed.agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId },
    });
    expect(first).toMatchObject({ settled: true, runId: expect.any(String) });
    for (let attempt = 0; attempt < 100 && adapterExecute.mock.calls.length === 0; attempt++) await sleep(50);
    expect(adapterExecute).toHaveBeenCalled();

    await wake(seed.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId },
      // Park it behind the live run instead of merging it into that run.
      allowRunCoalescing: false,
    });
    const deferred = await setupDb
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.status, "deferred_issue_execution"));
    expect(deferred.length).toBeGreaterThan(0);

    releaseAdapter();
    adapterGate.hold = null;
    await Promise.race([heartbeat.drainActiveRunExecutions(), sleep(WAKE_BUDGET_MS)]);
    const runs = await setupDb
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, seed.agentId));
    const stuck = await setupDb.$client<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
      where state = 'idle in transaction' and now() - xact_start > interval '2 seconds'`;

    expect(stuck[0]?.n).toBe(0);
    // The finished run plus the run the deferred wake was promoted into.
    expect(runs.length).toBe(2);
  }, 30_000);

  it("admits an isolated-workspace issue wake without reading the prior task session through the pool", async () => {
    await instanceSettingsService(setupDb).updateExperimental({ enableIsolatedWorkspaces: true });
    const seed = await seedAgent("isolated");
    const issueId = await seedIssue(seed);
    // A prior task session for this issue: the admission preflight reads it to
    // decide whether an earlier session workspace can be resumed.
    await setupDb.insert(agentTaskSessions).values({
      companyId: seed.companyId,
      agentId: seed.agentId,
      adapterType: "codex_local",
      taskKey: issueId,
      sessionParamsJson: { cwd: "/nonexistent/sup-17978" },
      sessionDisplayId: "prior-session",
    });
    const { wake } = onePool();

    const result = await wake(seed.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId },
    });

    expect(result).toMatchObject({ settled: true });
    expect(result).not.toHaveProperty("error");
  }, 30_000);
});
