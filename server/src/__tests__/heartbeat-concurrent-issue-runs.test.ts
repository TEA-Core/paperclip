import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping concurrent issue-run tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("concurrent runs of the same agent on one issue", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-concurrent-issue-runs-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(companySkills);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * One agent, one issue, a run already executing, and a second run sitting in
   * the queue for the same issue. `maxConcurrentRuns` is left at the product
   * default (20), which is what every agent gets unless an operator lowers it —
   * so the per-agent slot cap does not accidentally serialize the two runs.
   */
  async function seedIssueWithRunningHolderAndQueuedSibling(opts: {
    queuedRunAgent?: "same" | "other";
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = randomUUID();
    const holderRunId = randomUUID();
    const queuedRunId = randomUUID();
    const queuedWakeupId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Exec CTO",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Concurrent runs of the same agent",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: holderRunId,
      executionAgentNameKey: "exec cto",
      executionLockedAt: new Date(),
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    await db.insert(agentWakeupRequests).values({
      id: queuedWakeupId,
      companyId,
      agentId: opts.queuedRunAgent === "other" ? otherAgentId : agentId,
      source: "automation",
      status: "queued",
      payload: { issueId },
    });

    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId: opts.queuedRunAgent === "other" ? otherAgentId : agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: queuedWakeupId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });

    return { companyId, agentId, otherAgentId, issueId, holderRunId, queuedRunId };
  }

  const readRun = async (runId: string) =>
    db
      .select({
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

  it("does not start a queued run while another run of the same agent is executing the issue", async () => {
    const { issueId, holderRunId, queuedRunId } = await seedIssueWithRunningHolderAndQueuedSibling();

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const queued = await readRun(queuedRunId);
    // Held back, not cancelled: the wake is still wanted, just not now. The
    // holder's own completion re-runs the dispatcher for this agent.
    expect(queued?.status).toBe("queued");
    expect(queued?.startedAt).toBeNull();
    expect(queued?.errorCode).toBeNull();

    // The live holder must be left strictly alone — it is doing the work.
    const holder = await readRun(holderRunId);
    expect(holder?.status).toBe("running");

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(holderRunId);
  });

  it("records why the queued run was held so the deferral is visible on the board", async () => {
    const { issueId, holderRunId, queuedRunId } = await seedIssueWithRunningHolderAndQueuedSibling();

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const event = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, queuedRunId),
          eq(activityLog.action, "issue.concurrent_run_deferred"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    expect(event?.details).toMatchObject({
      issueId,
      holderRunId,
      holderStatus: "running",
    });
  });

  it("starts the queued run once the holder is no longer executing", async () => {
    const { queuedRunId, holderRunId } = await seedIssueWithRunningHolderAndQueuedSibling();

    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, holderRunId));
    await db.update(issues).set({ executionRunId: null, executionAgentNameKey: null });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const queued = await readRun(queuedRunId);
    expect(queued?.status).not.toBe("queued");
  });

  it("leaves a different agent's queued run to the existing cross-agent gates", async () => {
    const { queuedRunId } = await seedIssueWithRunningHolderAndQueuedSibling({
      queuedRunAgent: "other",
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    // The duplicate-dispatch gate is scoped to the agent that already owns the
    // issue's live run. A second agent's run is governed by the assignee /
    // review-participant staleness rules, which cancel it here — the point is
    // only that it is not silently parked by the new gate.
    const queued = await readRun(queuedRunId);
    expect(queued?.status).not.toBe("queued");
  });
});
