import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres inbox-lite execution-lease tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type InboxLiteRow = {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
  projectId: string | null;
  goalId: string | null;
  parentId: string | null;
  updatedAt: string;
  activeRun: unknown;
  activeRecoveryAction: unknown;
  dependencyReady: boolean;
  unresolvedBlockerCount: number;
  unresolvedBlockerIssueIds: string[];
  executionLease: null | {
    runId: string;
    agentId: string;
    status: string;
    startedAt: string | null;
    heldByAnotherRun: boolean;
  };
};

describeEmbeddedPostgres("agents inbox-lite execution lease", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-inbox-lite-lease-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function agentActor(
    companyId: string,
    agentId: string,
    runId?: string,
  ): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      ...(runId ? { runId } : {}),
      source: "agent_jwt",
    };
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "InboxLiteLease",
      issuePrefix: `IL${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, agentId: string) {
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "LeaseAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    status: string,
    startedAt?: Date | null,
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status,
      startedAt: startedAt ?? new Date("2026-08-28T10:00:00Z"),
    });
    return runId;
  }

  async function seedIssue(input: {
    companyId: string;
    title: string;
    status: string;
    assigneeAgentId: string;
    identifier?: string;
    executionRunId?: string | null;
    checkoutRunId?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      title: input.title,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId,
      issueNumber: 1,
      identifier: input.identifier ?? `ILLEASE-${randomUUID().slice(0, 8)}`,
      executionRunId: input.executionRunId ?? null,
      checkoutRunId: input.checkoutRunId ?? null,
    });
    return id;
  }

  async function fetchRows(app: express.Express) {
    const res = await request(app).get("/api/agents/me/inbox-lite");
    expect(res.status).toBe(200);
    return res.body as InboxLiteRow[];
  }

  it("flags a foreign live execution lease on the row without hiding the issue", async () => {
    const companyId = await seedCompany();
    const actorAgentId = randomUUID();
    const holderAgentId = randomUUID();
    await seedAgent(companyId, actorAgentId);
    await seedAgent(companyId, holderAgentId);

    const callerRunId = await seedRun(companyId, actorAgentId, "running");
    const foreignRunId = await seedRun(companyId, holderAgentId, "running");
    const leasedIssueId = await seedIssue({
      companyId,
      title: "Leased by a foreign live run",
      status: "todo",
      assigneeAgentId: actorAgentId,
      executionRunId: foreignRunId,
    });

    const rows = await fetchRows(appFor(agentActor(companyId, actorAgentId, callerRunId)));
    const row = rows.find((r) => r.id === leasedIssueId);

    expect(row).toBeDefined();
    expect(row!.executionLease).toEqual({
      runId: foreignRunId,
      agentId: holderAgentId,
      status: "running",
      startedAt: new Date("2026-08-28T10:00:00Z").toISOString(),
      heldByAnotherRun: true,
    });
    expect(row!.activeRun).not.toBeNull();
    expect(row!.status).toBe("todo");
    expect(row!.dependencyReady).toBe(true);
    expect(row!.unresolvedBlockerCount).toBe(0);
  });

  it("marks a lease held by the caller's own run as heldByAnotherRun false", async () => {
    const companyId = await seedCompany();
    const actorAgentId = randomUUID();
    await seedAgent(companyId, actorAgentId);

    const callerRunId = await seedRun(companyId, actorAgentId, "running");
    const ownLeasedIssueId = await seedIssue({
      companyId,
      title: "Leased by the caller's own run",
      status: "in_progress",
      assigneeAgentId: actorAgentId,
      executionRunId: callerRunId,
    });

    const rows = await fetchRows(appFor(agentActor(companyId, actorAgentId, callerRunId)));
    const row = rows.find((r) => r.id === ownLeasedIssueId);

    expect(row).toBeDefined();
    expect(row!.executionLease).not.toBeNull();
    expect(row!.executionLease!.runId).toBe(callerRunId);
    expect(row!.executionLease!.agentId).toBe(actorAgentId);
    expect(row!.executionLease!.heldByAnotherRun).toBe(false);
  });

  it("yields executionLease null when the lease points at a non-running run", async () => {
    const companyId = await seedCompany();
    const actorAgentId = randomUUID();
    const holderAgentId = randomUUID();
    await seedAgent(companyId, actorAgentId);
    await seedAgent(companyId, holderAgentId);

    const callerRunId = await seedRun(companyId, actorAgentId, "running");
    const queuedRunId = await seedRun(companyId, holderAgentId, "queued", null);
    const scheduledRetryRunId = await seedRun(companyId, holderAgentId, "scheduled_retry", null);
    const finishedRunId = await seedRun(companyId, holderAgentId, "succeeded");

    const queuedIssueId = await seedIssue({
      companyId,
      title: "Queued run pointer",
      status: "todo",
      assigneeAgentId: actorAgentId,
      executionRunId: queuedRunId,
    });
    const scheduledRetryIssueId = await seedIssue({
      companyId,
      title: "Scheduled retry run pointer",
      status: "todo",
      assigneeAgentId: actorAgentId,
      executionRunId: scheduledRetryRunId,
    });
    const checkoutOnlyIssueId = await seedIssue({
      companyId,
      title: "Finished checkout run pointer",
      status: "todo",
      assigneeAgentId: actorAgentId,
      executionRunId: null,
      checkoutRunId: finishedRunId,
    });

    const rows = await fetchRows(appFor(agentActor(companyId, actorAgentId, callerRunId)));
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get(queuedIssueId)?.executionLease).toBeNull();
    expect(byId.get(scheduledRetryIssueId)?.executionLease).toBeNull();
    expect(byId.get(checkoutOnlyIssueId)?.executionLease).toBeNull();
    for (const id of [queuedIssueId, scheduledRetryIssueId, checkoutOnlyIssueId]) {
      expect(byId.get(id)).toBeDefined();
    }
  });

  it("surfaces a live lease held through checkoutRunId", async () => {
    const companyId = await seedCompany();
    const actorAgentId = randomUUID();
    const holderAgentId = randomUUID();
    await seedAgent(companyId, actorAgentId);
    await seedAgent(companyId, holderAgentId);

    const callerRunId = await seedRun(companyId, actorAgentId, "running");
    const checkoutRunId = await seedRun(companyId, holderAgentId, "running");
    const checkoutLeasedIssueId = await seedIssue({
      companyId,
      title: "Leased through checkoutRunId",
      status: "todo",
      assigneeAgentId: actorAgentId,
      executionRunId: null,
      checkoutRunId: checkoutRunId,
    });

    const rows = await fetchRows(appFor(agentActor(companyId, actorAgentId, callerRunId)));
    const row = rows.find((r) => r.id === checkoutLeasedIssueId);

    expect(row).toBeDefined();
    expect(row!.executionLease).toEqual({
      runId: checkoutRunId,
      agentId: holderAgentId,
      status: "running",
      startedAt: new Date("2026-08-28T10:00:00Z").toISOString(),
      heldByAnotherRun: true,
    });
    expect(row!.activeRun).toBeNull();
  });

  it("keeps unleased rows additive: existing fields unchanged and executionLease null", async () => {
    const companyId = await seedCompany();
    const actorAgentId = randomUUID();
    await seedAgent(companyId, actorAgentId);

    const unleasedIdentifier = "ILLEASE-UNLEASED";
    const unleasedIssueId = await seedIssue({
      companyId,
      title: "Unleased",
      status: "todo",
      assigneeAgentId: actorAgentId,
      identifier: unleasedIdentifier,
    });

    const rows = await fetchRows(appFor(agentActor(companyId, actorAgentId)));
    const row = rows.find((r) => r.id === unleasedIssueId);

    expect(row).toBeDefined();
    expect(row!.executionLease).toBeNull();
    expect(row!.activeRun).toBeNull();
    expect(row!.activeRecoveryAction).toBeNull();
    expect(row!.dependencyReady).toBe(true);
    expect(row!.unresolvedBlockerCount).toBe(0);
    expect(row!.unresolvedBlockerIssueIds).toEqual([]);
    expect(row!.identifier).toBe(unleasedIdentifier);
    expect(row!.title).toBe("Unleased");
    expect(row!.status).toBe("todo");
    expect(row!.priority).toBe("medium");
  });

  it("treats a live lease as foreign when the caller has no resolved run id", async () => {
    const companyId = await seedCompany();
    const actorAgentId = randomUUID();
    await seedAgent(companyId, actorAgentId);

    const foreignRunId = await seedRun(companyId, actorAgentId, "running");
    const leasedIssueId = await seedIssue({
      companyId,
      title: "Leased without caller run context",
      status: "in_progress",
      assigneeAgentId: actorAgentId,
      executionRunId: foreignRunId,
    });

    const rows = await fetchRows(appFor(agentActor(companyId, actorAgentId)));
    const row = rows.find((r) => r.id === leasedIssueId);

    expect(row).toBeDefined();
    expect(row!.executionLease).not.toBeNull();
    expect(row!.executionLease!.runId).toBe(foreignRunId);
    expect(row!.executionLease!.heldByAnotherRun).toBe(true);
  });
});
