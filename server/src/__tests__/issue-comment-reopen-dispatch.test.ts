import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  companyMemberships,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  describeEmbeddedPostgres,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";
import { issueRoutes } from "../routes/issues.js";
import { runningProcesses } from "../adapters/index.ts";

// The run created for the reopen would otherwise spawn a real adapter process.
// Stub the adapter so execution resolves immediately; the assertion only needs the
// heartbeat_runs row that enqueueWakeup inserts before it hands off to execution.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "repro run",
    provider: "test",
    model: "test-model",
  })),
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

// SUP-15065 — the route-level regression the card asks for. Drives a comment-triggered
// reopen through the REAL route (issues.ts fire-and-forget flush) with a REAL heartbeat
// against embedded Postgres, and asserts a heartbeat_runs row appears — not just a wake
// object. A unit test on the wake object alone is precisely the gap this card closes.
const pg = useEmbeddedPostgres("paperclip-issue-comment-reopen-route-");

describeEmbeddedPostgres("issue comment reopen route dispatch (SUP-15065)", () => {
  afterEach(async () => {
    const db = pg.db;
    runningProcesses.clear();
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(issues);
        await db.delete(environmentLeases);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companyMemberships);
        await db.delete(principalPermissionGrants);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  async function seedDoneCard(opts: { wakeOnDemand?: boolean } = {}) {
    const db = pg.db;
    const company = await seedCompanyWithBoardAccess(db, "Reopen Dispatch");
    const wakeOnDemand = opts.wakeOnDemand ?? true;
    const [agent] = await db.insert(agents).values({
      companyId: company.companyId,
      name: "support-QAE",
      role: "support",
      status: "idle",
      adapterType: "opencode_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand, maxConcurrentRuns: 1 } },
      permissions: {},
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company.companyId,
      title: "Reopen dispatch repro",
      status: "done",
      priority: "medium",
      assigneeAgentId: agent!.id,
      responsibleUserId: company.userId,
    }).returning();
    return { company, agent: agent!, issue: issue! };
  }

  async function waitForReopenRun(agentId: string, ms = 8000) {
    const db = pg.db;
    const start = Date.now();
    for (;;) {
      const rows = await db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      const match = rows.find(
        (row) =>
          row.contextSnapshot?.wakeReason === "issue_reopened_via_comment" ||
          row.contextSnapshot?.source === "issue.comment.reopen",
      );
      if (match) return match;
      if (Date.now() - start > ms) {
        // Surface every skip the wake produced so the shape is diagnosable.
        const skips = await db
          .select({ reason: agentWakeupRequests.reason, status: agentWakeupRequests.status })
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.agentId, agentId));
        throw new Error(
          `no heartbeat_runs row for the reopen within ${ms}ms. agent_wakeup_requests: ${JSON.stringify(skips)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function waitForActivityRow(action: string, ms = 8000) {
    const db = pg.db;
    const start = Date.now();
    for (;;) {
      const rows = await db
        .select({ action: activityLog.action, details: activityLog.details })
        .from(activityLog)
        .where(eq(activityLog.action, action));
      if (rows.length > 0) return rows;
      if (Date.now() - start > ms) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it("records an issue.wake_not_dispatched row when the reopen wake is not dispatched", async () => {
    const db = pg.db;
    const { company, agent, issue } = await seedDoneCard({ wakeOnDemand: false });
    const app = routeApp(db, company.actor, issueRoutes);

    const res = await request(app)
      .post(`/api/issues/${issue.id}/comments`)
      .send({ body: "Please reopen and pick this up.", reopen: true });
    expect(res.status).toBe(201);

    // The reopen still flipped the card back to todo.
    const refetched = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issue.id));
    expect(refetched[0]?.status).toBe("todo");

    // The silent loss is now observable: a not_dispatched activity row was recorded.
    const notDispatched = await waitForActivityRow("issue.wake_not_dispatched");
    expect(notDispatched, "an issue.wake_not_dispatched row must exist").toHaveLength(1);
    expect(notDispatched![0].details).toMatchObject({
      agentId: agent.id,
      wakeupReason: "issue_reopened_via_comment",
      outcome: "not_dispatched",
    });

    // ...and no run was enqueued for the assignee (the wake was skipped, not dropped silently).
    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agent.id));
    expect(runs).toHaveLength(0);
  });

  it("POST /comments reopen on a done card enqueues a heartbeat_runs row for the assignee", async () => {
    const db = pg.db;
    const { company, agent, issue } = await seedDoneCard();
    const app = routeApp(db, company.actor, issueRoutes);

    const res = await request(app)
      .post(`/api/issues/${issue.id}/comments`)
      .send({ body: "Please reopen and pick this up.", reopen: true });

    expect(res.status).toBe(201);
    // POST /comments returns the created comment (its own id), not the issue.
    expect(res.body?.body).toBe("Please reopen and pick this up.");

    // The reopen flipped the card back to todo.
    const refetched = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issue.id));
    expect(refetched[0]?.status).toBe("todo");

    const run = await waitForReopenRun(agent.id);
    expect(run, "a heartbeat_runs row must exist for the reopen").toBeTruthy();
    expect(run.status).toBeTruthy();
  });
});
