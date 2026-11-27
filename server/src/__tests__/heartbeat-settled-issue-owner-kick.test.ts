import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { dispatchQuiesce } from "../services/dispatch-quiesce.js";
import { logger } from "../middleware/logger.js";

// Runs block on a per-run gate so a test decides exactly when the previous
// owner's executor settles. Nothing in this file runs the scheduler tick after
// that point: the next owner can start only if the settle itself re-drives it.
const runGates = vi.hoisted(() => new Map<string, Promise<void>>());
const runEffects = vi.hoisted(() => new Map<string, () => Promise<unknown>>());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (context: { runId: string }) => {
    await runGates.get(context.runId);
    await runEffects.get(context.runId)?.();
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Settled-issue owner kick test run.",
      provider: "test",
      model: "test-model",
    };
  }),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres settled-issue owner kick tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat settled issue kicks the next owner's queue", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let paperclipHome: string | null = null;
  const gateReleases: Array<() => void> = [];

  const executeCallsForRun = (runId: string) =>
    mockAdapterExecute.mock.calls.filter(([context]) => context?.runId === runId).length;

  beforeAll(async () => {
    paperclipHome = await mkdtemp(join(tmpdir(), "heartbeat-settled-owner-kick-home-"));
    vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-settled-owner-kick-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
  }, 30_000);

  afterEach(async () => {
    dispatchQuiesce.release();
    for (const release of gateReleases.splice(0)) release();
    vi.restoreAllMocks();
    await db.execute(sql`DROP TRIGGER IF EXISTS test_fail_owner_claim ON heartbeat_runs`);
    await db.execute(sql`DROP FUNCTION IF EXISTS test_fail_owner_claim()`);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.status, "queued"));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    runGates.clear();
    runEffects.clear();
    mockAdapterExecute.mockClear();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
    if (paperclipHome) await rm(paperclipHome, { recursive: true, force: true });
  });

  function gateRun(runId: string) {
    let release!: () => void;
    runGates.set(runId, new Promise<void>((resolve) => { release = resolve; }));
    gateReleases.push(release);
    return release;
  }

  async function seedQueuedRun(companyId: string, agentId: string, issueId: string) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId, companyId, agentId, source: "assignment", triggerDetail: "system",
      reason: "issue_assigned", payload: { issueId }, status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
      status: "queued", wakeupRequestId, contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeupRequestId));
    return runId;
  }

  /**
   * The previous owner (Coder) is executing the issue and holds its execution
   * lock. The issue then moves to the next owner (Reviewer), whose queued run
   * must wait until the Coder's executor settles.
   */
  async function seedHandoff(opts: { reviewerMaxConcurrentRuns?: number } = {}) {
    const companyId = randomUUID();
    const coderAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    const agentRow = (id: string, name: string, maxConcurrentRuns: number) => ({
      id, companyId, name, role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns } },
    });
    await db.insert(agents).values([
      agentRow(coderAgentId, "Coder", 1),
      agentRow(reviewerAgentId, "Reviewer", opts.reviewerMaxConcurrentRuns ?? 1),
    ]);
    await db.insert(issues).values({
      id: issueId, companyId, title: "Owner handoff", status: "todo", assigneeAgentId: coderAgentId,
    });

    const previousRunId = await seedQueuedRun(companyId, coderAgentId, issueId);
    const settlePrevious = gateRun(previousRunId);
    // Setup only: start the previous owner's run.
    await heartbeat.resumeQueuedRuns();
    await vi.waitFor(() => expect(executeCallsForRun(previousRunId)).toBe(1), { timeout: 5_000 });
    const [locked] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(locked!.executionRunId).toBe(previousRunId);

    await db.update(issues).set({ assigneeAgentId: reviewerAgentId }).where(eq(issues.id, issueId));
    const nextRunId = await seedQueuedRun(companyId, reviewerAgentId, issueId);
    return { companyId, coderAgentId, reviewerAgentId, issueId, previousRunId, settlePrevious, nextRunId };
  }

  async function runStatus(runId: string) {
    return (await heartbeat.getRun(runId))?.status;
  }

  it("starts the next owner's queued run when the previous owner's execution settles, without a scheduler tick", async () => {
    const { previousRunId, settlePrevious, nextRunId, issueId } = await seedHandoff();
    // The next owner's wake reaches admission while the previous owner still
    // runs: the live-holder deferral keeps it queued.
    await heartbeat.resumeQueuedRuns();
    expect(await runStatus(nextRunId)).toBe("queued");
    expect(executeCallsForRun(nextRunId)).toBe(0);

    settlePrevious();
    await heartbeat.drainActiveRunExecutions();

    expect(await runStatus(previousRunId)).toBe("succeeded");
    expect(executeCallsForRun(nextRunId)).toBe(1);
    expect(await runStatus(nextRunId)).toBe("succeeded");
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue!.executionRunId).not.toBe(previousRunId);
  });

  it("keeps the claim fence closed while the terminal previous owner's executor is still settling", async () => {
    const { previousRunId, settlePrevious, nextRunId, issueId } = await seedHandoff();
    // A terminal status can be published before the executor finishes its
    // cleanup; the issue lock still names the previous owner at that point.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, previousRunId));
    await heartbeat.resumeQueuedRuns();
    expect(await runStatus(nextRunId)).toBe("queued");
    expect(executeCallsForRun(nextRunId)).toBe(0);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.executionRunId).toBe(previousRunId);

    settlePrevious();
    await heartbeat.drainActiveRunExecutions();

    expect(executeCallsForRun(nextRunId)).toBe(1);
    expect(await runStatus(nextRunId)).toBe("succeeded");
  });

  it("lets the live-holder deferral decide when the settle kicks the next owner behind another live holder", async () => {
    const { companyId, coderAgentId, settlePrevious, nextRunId, issueId } = await seedHandoff();
    // A different run still holds the issue checkout and is live in the
    // database. The previous owner's settle must not start the next owner past it.
    const [liveHolder] = await db.insert(heartbeatRuns).values({
      companyId, agentId: coderAgentId, invocationSource: "assignment", triggerDetail: "system",
      status: "running", startedAt: new Date(), contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    }).returning();
    await db.update(issues).set({ checkoutRunId: liveHolder!.id }).where(eq(issues.id, issueId));

    settlePrevious();
    await heartbeat.drainActiveRunExecutions();

    expect(await runStatus(nextRunId)).toBe("queued");
    expect(executeCallsForRun(nextRunId)).toBe(0);
    // The settle reached admission for the next owner, and the deferral held it.
    const deferrals = await db.select({ details: activityLog.details }).from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, "issue.concurrent_run_deferred"),
      eq(activityLog.entityId, nextRunId),
    ));
    expect(deferrals.map((row) => row.details?.holderRunId)).toEqual([liveHolder!.id]);
  });

  it.each([
    { name: "paused agent", block: "paused" },
    { name: "budget hard stop", block: "budget" },
    { name: "scheduling suppression", block: "suppressed" },
    { name: "cancelled run", block: "cancelled" },
  ] as const)("starts nothing for an ineligible next owner: $name", async ({ block }) => {
    const { reviewerAgentId, previousRunId, settlePrevious, nextRunId } = await seedHandoff();
    if (block === "paused" || block === "budget") {
      await db.update(agents).set({
        status: "paused", pauseReason: block === "budget" ? "budget" : "manual", pausedAt: new Date(),
      }).where(eq(agents.id, reviewerAgentId));
    } else if (block === "suppressed") {
      dispatchQuiesce.engage({ reason: "settled-issue kick test", ttlMs: 60_000 });
    } else {
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, nextRunId));
    }

    settlePrevious();
    await heartbeat.drainActiveRunExecutions();

    expect(await runStatus(previousRunId)).toBe("succeeded");
    expect(executeCallsForRun(nextRunId)).toBe(0);
    expect(["queued", "cancelled"]).toContain(await runStatus(nextRunId));
    const reviewerRuns = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, reviewerAgentId));
    expect(reviewerRuns.filter((run) => run.status === "running" || run.status === "succeeded")).toEqual([]);
  });

  it("starts the next owner's run once when the settle kick races scheduler ticks", async () => {
    const { previousRunId, settlePrevious, nextRunId, issueId } = await seedHandoff({ reviewerMaxConcurrentRuns: 2 });
    // The next owner closes the task, so a continuation run never executes.
    runEffects.set(nextRunId, () => db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId)));

    settlePrevious();
    await Promise.all([
      heartbeat.drainActiveRunExecutions(),
      heartbeat.resumeQueuedRuns(),
      heartbeat.resumeQueuedRuns(),
    ]);
    await heartbeat.drainActiveRunExecutions();

    // One adapter start per run: the kick and both ticks share one claim.
    expect(mockAdapterExecute.mock.calls.map(([context]) => context.runId).sort())
      .toEqual([previousRunId, nextRunId].sort());
    expect(await runStatus(nextRunId)).toBe("succeeded");
  });

  it("does not fail the previous owner's settle when the kick fails", async () => {
    const { reviewerAgentId, previousRunId, settlePrevious, nextRunId } = await seedHandoff();
    await db.execute(sql`CREATE FUNCTION test_fail_owner_claim() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected next-owner claim failure';
      END;
    $$`);
    await db.execute(sql.raw(`CREATE TRIGGER test_fail_owner_claim
      BEFORE UPDATE OF status ON heartbeat_runs FOR EACH ROW
      WHEN (NEW.status = 'running' AND OLD.status = 'queued' AND NEW.agent_id = '${reviewerAgentId}')
      EXECUTE FUNCTION test_fail_owner_claim()`));
    const errorSpy = vi.spyOn(logger, "error");
    const warnSpy = vi.spyOn(logger, "warn");

    settlePrevious();
    await heartbeat.drainActiveRunExecutions();

    expect(await runStatus(previousRunId)).toBe("succeeded");
    expect(await runStatus(nextRunId)).toBe("queued");
    expect(executeCallsForRun(nextRunId)).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ runId: previousRunId, agentId: reviewerAgentId }),
      expect.stringContaining("next owner"),
    );
    expect(errorSpy.mock.calls.filter(([, message]) => message === "queued heartbeat execution failed")).toEqual([]);
  });
});
