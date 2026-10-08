import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateWithLockRetry } from "./helpers/truncate-with-lock-retry.js";
import { heartbeatService } from "../services/heartbeat.ts";

// TEA-Core fork: a continuation wake that loses a race with a reassign or a close fails fast at
// setup (`continuation_task_ownership_changed`). That is a benign precondition failure, not an agent
// fault, so the agent must stay idle instead of flipping to `error` until fleet-watch repairs it.

const adapterExecute = vi.hoisted(() =>
  vi.fn(async (_ctx: AdapterExecutionContext) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "Superseded continuation test run.",
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
  runningProcesses: new Map(),
}));

// The spread is mandatory: heartbeat imports other helpers from this module too.
vi.mock("../services/execution-continuation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/execution-continuation.js")>();
  return { ...actual, buildExecutionContinuation: vi.fn(actual.buildExecutionContinuation) };
});

const continuation = await import("../services/execution-continuation.js");
const buildContinuation = vi.mocked(continuation.buildExecutionContinuation);
const realBuildContinuation = (
  await vi.importActual<typeof import("../services/execution-continuation.js")>(
    "../services/execution-continuation.js",
  )
).buildExecutionContinuation;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres superseded-continuation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    "activity_log",
    "heartbeat_run_events",
    "heartbeat_runs",
    "agent_wakeup_requests",
    "agent_runtime_state",
    "issues",
    "agents",
    "companies"
  RESTART IDENTITY CASCADE
`;

describeEmbeddedPostgres("heartbeat superseded continuation keeps the agent idle", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "heartbeat-superseded-continuation-secret");
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-superseded-continuation-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    await truncateWithLockRetry(db, TRUNCATE_SQL);
    adapterExecute.mockClear();
    buildContinuation.mockReset();
    buildContinuation.mockImplementation(realBuildContinuation);
  });

  afterAll(async () => {
    await heartbeat.drainActiveRunExecutions();
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
  });

  async function waitForRunToFinish(runId: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run && !["queued", "running"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await heartbeat.getRun(runId);
  }

  /** An agent that owns an in-progress card, plus a second agent the card can move to. */
  async function seedOwnedCard() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Superseded continuation",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    for (const [id, name] of [[agentId, "OwnerAgent"], [otherAgentId, "NewOwnerAgent"]] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Card whose seat moves while the continuation is being set up",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { agentId, otherAgentId, issueId };
  }

  const readAgent = (agentId: string) =>
    db
      .select({
        status: agents.status,
        errorReason: agents.errorReason,
        lastHeartbeatAt: agents.lastHeartbeatAt,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);

  /** finalizeAgentStatus stamps lastHeartbeatAt in the same UPDATE as the status, and the seed leaves it null. */
  async function readAgentAfterFinalization(agentId: string) {
    await expect
      .poll(async () => (await readAgent(agentId))?.lastHeartbeatAt ?? null, { timeout: 10_000, interval: 25 })
      .not.toBeNull();
    return (await readAgent(agentId))!;
  }

  const lostRaces = [
    {
      name: "the card is reassigned",
      move: (db_: ReturnType<typeof createDb>, issueId: string, otherAgentId: string) =>
        db_.update(issues).set({ assigneeAgentId: otherAgentId }).where(eq(issues.id, issueId)),
    },
    {
      name: "the card is closed",
      move: (db_: ReturnType<typeof createDb>, issueId: string) =>
        db_.update(issues).set({ status: "done" }).where(eq(issues.id, issueId)),
    },
  ];

  it.each(lostRaces)(
    "leaves the agent idle when $name between setup's read and the continuation builder's re-read",
    async ({ move }) => {
      const { agentId, otherAgentId, issueId } = await seedOwnedCard();
      // The seat moves after run setup read the card and before the real builder re-reads it, so the
      // real builder throws the real error. Nothing about the throw is faked.
      buildContinuation.mockImplementationOnce(async (input) => {
        await move(db, issueId, otherAgentId);
        return realBuildContinuation(input);
      });

      const queued = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual");
      const finished = await waitForRunToFinish(queued!.id);
      const agent = await readAgentAfterFinalization(agentId);

      // Non-vacuity: the wrapped builder was reached, so the race really ran through the setup path.
      expect(buildContinuation).toHaveBeenCalledTimes(1);
      expect(finished?.status).toBe("failed");
      expect(finished?.errorCode).toBe("setup_failed");
      expect(finished?.error).toContain("continuation_task_ownership_changed");
      expect(adapterExecute).not.toHaveBeenCalled();
      // Precondition: a superseded run schedules no retry (the card is no longer this agent's), so this
      // run's finalization alone decides the agent status. If a retry ever appears, fail loudly here.
      expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(1);

      expect(agent.status).toBe("idle");
      expect(agent.errorReason).toBeNull();
    },
    30_000,
  );

  it("still flips the agent to error for any other setup failure", async () => {
    const { agentId, issueId } = await seedOwnedCard();
    // Persistent, so the continuation retry and the recovery run it triggers fail the same way and the
    // agent is not left `running` by a retry that happens to succeed.
    buildContinuation.mockRejectedValue(new Error("some other setup failure"));

    const queued = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual");
    const finished = await waitForRunToFinish(queued!.id);

    expect(finished?.status).toBe("failed");
    expect(finished?.errorCode).toBe("setup_failed");
    expect(adapterExecute).not.toHaveBeenCalled();

    await expect
      .poll(async () => (await readAgent(agentId))?.status, { timeout: 15_000, interval: 50 })
      .toBe("error");
    expect((await readAgent(agentId))?.errorReason).toContain("some other setup failure");
  }, 40_000);
});
