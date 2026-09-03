import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.ts";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stillborn-assigned-backlog sweep tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery sweep reconcileStillbornAssignedBacklog", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stillborn-backlog-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueTreeHolds);
    await db.delete(issueRecoveryActions);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId };
  }

  async function seedStillbornCard(companyId: string, agentId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stillborn assigned backlog",
      status: "backlog",
      priority: "high",
      assigneeAgentId: agentId,
      createdAt: new Date(Date.now() - 120_000),
    });
    return issueId;
  }

  async function seedFreshlyCreatedCard(companyId: string, agentId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Freshly created assigned backlog",
      status: "backlog",
      priority: "high",
      assigneeAgentId: agentId,
      createdAt: new Date(),
    });
    return issueId;
  }

  function makeSweep() {
    return recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
  }

  async function detectionRows(issueId: string) {
    return db
      .select({ id: activityLog.id, details: activityLog.details })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.action, "issue.stillborn_assigned_backlog_detected"),
          eq(activityLog.entityId, issueId),
        ),
      );
  }

  async function recoveryActionRows(issueId: string) {
    return db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
  }

  async function issueRow(issueId: string) {
    const rows = await db.select().from(issues).where(eq(issues.id, issueId));
    return rows[0] ?? null;
  }

  it("escalates a matching backlog row with an assigneeAgentId exactly once", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedStillbornCard(companyId, agentId);

    const result = await makeSweep().reconcileStillbornAssignedBacklog();

    expect(result.reported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await issueRow(issueId);
    expect(issue?.status).toBe("blocked");
    expect(issue?.assigneeAgentId).toBe(agentId);

    const actions = await recoveryActionRows(issueId);
    expect(actions).toHaveLength(1);
    expect(actions[0].cause).toBe("stillborn_assigned_backlog");

    const audits = await detectionRows(issueId);
    expect(audits).toHaveLength(1);
    expect((audits[0].details as Record<string, unknown>).recoveryActionId).toBe(actions[0].id);

    const comments = await db
      .select({ id: issueComments.id, authorType: issueComments.authorType, body: issueComments.body })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("`backlog`");
  });

  it("does not report an unassigned backlog row", async () => {
    const { companyId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Unassigned backlog",
      status: "backlog",
      priority: "high",
      assigneeAgentId: null,
    });

    const result = await makeSweep().reconcileStillbornAssignedBacklog();

    expect(result.reported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.issueIds).toEqual([]);
    expect(await recoveryActionRows(issueId)).toHaveLength(0);
    expect(await detectionRows(issueId)).toHaveLength(0);
  });

  it("does not report a todo row", async () => {
    const { companyId, agentId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Todo with assignee",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const result = await makeSweep().reconcileStillbornAssignedBacklog();

    expect(result.reported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.issueIds).toEqual([]);
    expect(await recoveryActionRows(issueId)).toHaveLength(0);
    expect(await detectionRows(issueId)).toHaveLength(0);
  });

  it("repeated sweeps over the same unchanged candidate escalate at most once", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedStillbornCard(companyId, agentId);

    const sweep = makeSweep();
    const results = [];
    for (let tick = 0; tick < 3; tick += 1) {
      // The candidate stays in the stillborn state across sweeps: whatever put
      // it back (or what kept it there) left status/assignee unchanged.
      if (tick > 0) {
        await db
          .update(issues)
          .set({ status: "backlog" })
          .where(eq(issues.id, issueId));
      }
      results.push(await sweep.reconcileStillbornAssignedBacklog());
    }

    expect(results.every((result) => result.reported === 1)).toBe(true);
    expect(results.every((result) => result.issueIds.includes(issueId))).toBe(true);

    // Verification reads the post-sweep database rows, not the return value:
    const actions = await recoveryActionRows(issueId);
    expect(actions).toHaveLength(1);
    expect(actions[0].cause).toBe("stillborn_assigned_backlog");

    const audits = await detectionRows(issueId);
    expect(audits).toHaveLength(1);

    const comments = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
    expect(comments).toHaveLength(1);

    expect((await issueRow(issueId))?.status).toBe("blocked");
  });

  it("second tick over an escalated population reports nothing new", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedStillbornCard(companyId, agentId);

    const sweep = makeSweep();
    const first = await sweep.reconcileStillbornAssignedBacklog();
    const second = await sweep.reconcileStillbornAssignedBacklog();

    expect(first.reported).toBe(1);
    expect(first.issueIds).toEqual([issueId]);
    // After the first tick the card is `blocked`, so it no longer matches the
    // candidate selection on the next tick.
    expect(second.reported).toBe(0);
    expect(second.issueIds).toEqual([]);

    const audits = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.stillborn_assigned_backlog_detected"));
    expect(audits).toHaveLength(1);
  });

  it("skips a candidate with an active execution path before escalating", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedStillbornCard(companyId, agentId);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    });

    const result = await makeSweep().reconcileStillbornAssignedBacklog();

    expect(result.reported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);
    expect(await recoveryActionRows(issueId)).toHaveLength(0);
    expect(await detectionRows(issueId)).toHaveLength(0);
    expect((await issueRow(issueId))?.status).toBe("backlog");
  });

  it("skips a candidate with a pending wake interaction before escalating", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedStillbornCard(companyId, agentId);
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: {},
    });

    const result = await makeSweep().reconcileStillbornAssignedBacklog();

    expect(result.reported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);
    expect(await recoveryActionRows(issueId)).toHaveLength(0);
    expect(await detectionRows(issueId)).toHaveLength(0);
    expect((await issueRow(issueId))?.status).toBe("backlog");
  });

  it("skips a candidate under an active pause hold before escalating", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedStillbornCard(companyId, agentId);
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: issueId,
      mode: "pause",
      status: "active",
      reason: "manual pause",
      releasePolicy: { strategy: "manual", note: "stillborn_sweep_test" },
    });

    const result = await makeSweep().reconcileStillbornAssignedBacklog();

    expect(result.reported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);
    expect(await recoveryActionRows(issueId)).toHaveLength(0);
    expect(await detectionRows(issueId)).toHaveLength(0);
    expect((await issueRow(issueId))?.status).toBe("backlog");
  });

  it("SUP-14907: does not escalate an issue created within the grace window", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedFreshlyCreatedCard(companyId, agentId);

    const result = await makeSweep().reconcileStillbornAssignedBacklog();

    expect(result.reported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.issueIds).toEqual([]);
    expect(await recoveryActionRows(issueId)).toHaveLength(0);
    expect(await detectionRows(issueId)).toHaveLength(0);
    expect((await issueRow(issueId))?.status).toBe("backlog");
  });

  it("SUP-14907: escalates an issue created before the grace window elapsed", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedStillbornCard(companyId, agentId);

    const result = await makeSweep().reconcileStillbornAssignedBacklog();

    expect(result.reported).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
    expect((await recoveryActionRows(issueId))).toHaveLength(1);
    expect((await issueRow(issueId))?.status).toBe("blocked");
  });
});
