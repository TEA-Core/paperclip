import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "ok",
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

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres sweep candidacy tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * SUP-9858. The stranded-assignment sweep nominates every assigned open issue
 * without first asking whether `enqueueWakeup` can accept a wake for that
 * agent/issue. Every refusal writes a `skipped` row into
 * `agent_wakeup_requests` and the sweep retries on the next pass, forever.
 *
 * These tests run the real sweep against a real database and count the rows it
 * leaves behind, which is exactly how the issue was measured in production.
 */
describeEmbeddedPostgres("recovery sweep wake candidacy", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sweep-candidacy-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    await db.delete(issueComments);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRecoveryActions);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    // A dispatched run syncs the bundled skill inventory for its company, and
    // `company_skills.company_id` has no ON DELETE CASCADE, so these rows must go
    // before the companies they point at.
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const prefix = `SW${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Sweep Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    return { companyId, prefix };
  }

  async function seedAgent(
    companyId: string,
    runtimeConfig: Record<string, unknown>,
    opts: { role?: string; reportsTo?: string | null } = {},
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${agentId.slice(0, 4)}`,
      role: opts.role ?? "engineer",
      status: "idle",
      reportsTo: opts.reportsTo ?? null,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig,
      permissions: {},
    });
    return agentId;
  }

  async function seedIssue(input: {
    companyId: string;
    prefix: string;
    issueNumber: number;
    status: string;
    assigneeAgentId?: string | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: `Issue ${input.issueNumber}`,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      responsibleUserId: "responsible-user",
      issueNumber: input.issueNumber,
      identifier: `${input.prefix}-${input.issueNumber}`,
    });
    return issueId;
  }

  /** Manager + coder so the coder passes the org-chain invokability check. */
  async function seedOrg(companyId: string, coderRuntimeConfig: Record<string, unknown>) {
    const managerId = await seedAgent(companyId, {}, { role: "cto" });
    const coderId = await seedAgent(companyId, coderRuntimeConfig, { reportsTo: managerId });
    return { managerId, coderId };
  }

  async function wakeRowsFor(agentId: string) {
    return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
  }

  it("does not ask for a wake the agent's policy will always refuse", async () => {
    const { companyId, prefix } = await seedCompany();
    const { coderId } = await seedOrg(companyId, { heartbeat: { wakeOnDemand: false } });
    await seedIssue({ companyId, prefix, issueNumber: 1, status: "todo", assigneeAgentId: coderId });

    const heartbeat = heartbeatService(db);
    await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.reconcileStrandedAssignedIssues();

    expect(await wakeRowsFor(coderId)).toEqual([]);
  });

  it("does not ask on the in_progress continuation path either", async () => {
    const { companyId, prefix } = await seedCompany();
    const { coderId } = await seedOrg(companyId, { heartbeat: { wakeOnDemand: false } });
    const issueId = await seedIssue({
      companyId,
      prefix,
      issueNumber: 1,
      status: "in_progress",
      assigneeAgentId: coderId,
    });
    const now = new Date();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      status: "failed",
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId, taskId: issueId },
      error: "process lost",
      errorCode: "process_lost",
      startedAt: now,
      finishedAt: now,
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.reconcileStrandedAssignedIssues();

    expect(await wakeRowsFor(coderId)).toEqual([]);
  });

  it("still dispatches for an agent that accepts on-demand wakes", async () => {
    const { companyId, prefix } = await seedCompany();
    const { coderId } = await seedOrg(companyId, { heartbeat: { wakeOnDemand: true } });
    await seedIssue({ companyId, prefix, issueNumber: 1, status: "todo", assigneeAgentId: coderId });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.assignmentDispatched).toBe(1);
    const rows = await wakeRowsFor(coderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).not.toBe("skipped");
  });

  it("does not ask for a wake the issue's unresolved blockers will always refuse", async () => {
    const { companyId, prefix } = await seedCompany();
    const { coderId } = await seedOrg(companyId, { heartbeat: { wakeOnDemand: true } });
    const blockedIssueId = await seedIssue({
      companyId,
      prefix,
      issueNumber: 1,
      status: "todo",
      assigneeAgentId: coderId,
    });
    const blockerIssueId = await seedIssue({
      companyId,
      prefix,
      issueNumber: 2,
      status: "todo",
      assigneeAgentId: null,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.reconcileStrandedAssignedIssues();

    const rows = await wakeRowsFor(coderId);
    expect(rows.filter((row) => row.reason === "issue_dependencies_blocked")).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("never asks the timer scheduler for a wake a disabled heartbeat would refuse", async () => {
    const { companyId, prefix } = await seedCompany();
    const { coderId } = await seedOrg(companyId, {
      heartbeat: { enabled: false, intervalSec: 60, wakeOnDemand: true },
    });
    await seedIssue({ companyId, prefix, issueNumber: 1, status: "todo", assigneeAgentId: coderId });

    const heartbeat = heartbeatService(db);
    await heartbeat.tickTimers(new Date());
    await heartbeat.tickTimers(new Date());

    const rows = await wakeRowsFor(coderId);
    expect(rows.filter((row) => row.reason === "heartbeat.disabled")).toEqual([]);
  });
});
