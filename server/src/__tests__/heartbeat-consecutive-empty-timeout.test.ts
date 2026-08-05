import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const TIMEOUT_TEST_ADAPTER = "consecutive_empty_timeout_test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres consecutive empty-output timeout tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

async function waitForAgentToLeaveRunning(
  db: ReturnType<typeof createDb>,
  agentId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.select().from(agents).where(eq(agents.id, agentId));
    if (rows[0]?.status !== "running") return rows[0] ?? null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const rows = await db.select().from(agents).where(eq(agents.id, agentId));
  return rows[0] ?? null;
}

describeEmbeddedPostgres("consecutive empty-output timeout breaker", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousAgentJwtSecret: string | undefined;

  beforeAll(async () => {
    previousAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "heartbeat-consecutive-empty-timeout-test-secret";
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-consecutive-empty-timeout-");
    db = createDb(tempDb.connectionString);
    registerServerAdapter({
      type: TIMEOUT_TEST_ADAPTER,
      execute: async () => ({
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: "simulated run timeout",
      }),
      testEnvironment: async () => ({
        adapterType: TIMEOUT_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "environment_leases",
        "environments",
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    unregisterServerAdapter(TIMEOUT_TEST_ADAPTER);
    await tempDb?.cleanup();
    if (previousAgentJwtSecret === undefined) {
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    } else {
      process.env.PAPERCLIP_AGENT_JWT_SECRET = previousAgentJwtSecret;
    }
  });

  async function seedAgent(opts?: { status?: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TimeoutCoder",
      role: "engineer",
      status: opts?.status ?? "idle",
      adapterType: TIMEOUT_TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedCompletedRuns(
    companyId: string,
    agentId: string,
    runs: Array<{ errorCode: string | null; logBytes: number | null; status: string }>,
    baseNow = new Date("2026-08-04T00:00:00.000Z"),
  ) {
    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index]!;
      const startedAt = new Date(baseNow.getTime() + index * 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: run.status,
        errorCode: run.errorCode,
        logBytes: run.logBytes,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 5_000),
        error: run.errorCode === "timeout" ? "run timed out" : null,
        contextSnapshot: {},
        createdAt: startedAt,
        updatedAt: startedAt,
      });
    }
  }

  it("pauses an agent after 3 consecutive empty-output timeout runs", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedCompletedRuns(companyId, agentId, [
      { status: "timed_out", errorCode: "timeout", logBytes: 63 },
      { status: "timed_out", errorCode: "timeout", logBytes: 63 },
    ]);

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("timed_out");
    expect(finished?.errorCode).toBe("timeout");

    const agent = await waitForAgentToLeaveRunning(db, agentId);
    expect(agent?.status).toBe("paused");
    expect(agent?.pauseReason).toBe("consecutive_empty_timeouts");
    expect(agent?.pausedAt).not.toBeNull();
  });

  it("does NOT pause an agent whose timeouts have large logs", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedCompletedRuns(companyId, agentId, [
      { status: "timed_out", errorCode: "timeout", logBytes: 404_423 },
      { status: "timed_out", errorCode: "timeout", logBytes: 404_423 },
    ]);

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    await waitForRunToFinish(heartbeat, queued!.id);

    const agent = await waitForAgentToLeaveRunning(db, agentId);
    expect(agent?.status).not.toBe("paused");
    expect(agent?.pauseReason).toBeNull();
  });

  it("does NOT pause an agent with a recent succeeded run breaking the streak", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedCompletedRuns(companyId, agentId, [
      { status: "succeeded", errorCode: null, logBytes: 500_000 },
      { status: "timed_out", errorCode: "timeout", logBytes: 63 },
    ]);

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    await waitForRunToFinish(heartbeat, queued!.id);

    const agent = await waitForAgentToLeaveRunning(db, agentId);
    expect(agent?.status).not.toBe("paused");
    expect(agent?.pauseReason).toBeNull();
  });

  it("treats null log_bytes as empty output (null < 10000)", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedCompletedRuns(companyId, agentId, [
      { status: "timed_out", errorCode: "timeout", logBytes: null },
      { status: "timed_out", errorCode: "timeout", logBytes: null },
    ]);

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    await waitForRunToFinish(heartbeat, queued!.id);

    const agent = await waitForAgentToLeaveRunning(db, agentId);
    expect(agent?.status).toBe("paused");
    expect(agent?.pauseReason).toBe("consecutive_empty_timeouts");
  });

  it("requires the full window of runs to qualify before pausing", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedCompletedRuns(companyId, agentId, [
      { status: "timed_out", errorCode: "timeout", logBytes: 63 },
    ]);

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    await waitForRunToFinish(heartbeat, queued!.id);

    const agent = await waitForAgentToLeaveRunning(db, agentId);
    expect(agent?.status).not.toBe("paused");
    expect(agent?.pauseReason).toBeNull();
  });

  it("replaying coder-RS-O's 11 consecutive empty-output timeout runs triggers the breaker", async () => {
    const { companyId, agentId } = await seedAgent();
    const rsOSequence = Array.from({ length: 10 }, () => ({
      status: "timed_out" as const,
      errorCode: "timeout",
      logBytes: 63,
    }));
    await seedCompletedRuns(companyId, agentId, rsOSequence);

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("timed_out");

    const agent = await waitForAgentToLeaveRunning(db, agentId);
    expect(agent?.status).toBe("paused");
    expect(agent?.pauseReason).toBe("consecutive_empty_timeouts");
  });

  it("replaying coder-BE's last 50 runs does NOT trigger the breaker", async () => {
    const { companyId, agentId } = await seedAgent();
    const coderBeSequence: Array<{
      status: "timed_out" | "succeeded";
      errorCode: string | null;
      logBytes: number | null;
    }> = [];
    for (let index = 0; index < 50; index += 1) {
      const isTimeout = index % 6 === 0;
      coderBeSequence.push(
        isTimeout
          ? { status: "timed_out", errorCode: "timeout", logBytes: 404_423 }
          : { status: "succeeded", errorCode: null, logBytes: 100_000 + index * 1_000 },
      );
    }
    await seedCompletedRuns(companyId, agentId, coderBeSequence);

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("timed_out");

    const agent = await waitForAgentToLeaveRunning(db, agentId);
    expect(agent?.status).not.toBe("paused");
    expect(agent?.pauseReason).toBeNull();
  });
});
