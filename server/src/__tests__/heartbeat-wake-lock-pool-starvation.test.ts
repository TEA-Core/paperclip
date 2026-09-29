import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

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

  it("admits a wake with no issue without reading the responsible user through the pool", async () => {
    const seed = await seedAgent("agent");
    const { wake } = onePool();

    const result = await wake(seed.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "pool_starvation_probe",
    });

    expect(result).toMatchObject({ settled: true, runId: expect.any(String) });
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
        .then(
          () => performance.now() - startedAt,
          () => performance.now() - startedAt,
        ),
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
  }, 30_000);
});
