import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
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
    `Skipping embedded Postgres report-sweep emission-gate tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// SUP-14539: the report-only recovery sweeps must emit a detection activity
// row edge-triggered — when an (issue, condition) pair enters the reported set
// or its details change materially — and the state-change check must be
// derived from the durable record (the most recent activity row for that
// entityId + action), not in-memory state, so a control-plane restart cannot
// re-arm emission.
describeEmbeddedPostgres("recovery report-only sweep emission gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sweep-emission-gate-");
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

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, adapterType: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent",
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedCard(companyId: string, agentId: string, identifier: string, status: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier,
      title: "Assigned card",
      status,
      priority: "high",
      assigneeAgentId: agentId,
      monitorNextCheckAt: null,
    });
    return issueId;
  }

  function makeSweep() {
    return recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
  }

  async function detectionRows(action: string, issueId: string) {
    return db
      .select({ id: activityLog.id, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.action, action), eq(activityLog.entityId, issueId)))
      .orderBy(desc(activityLog.createdAt));
  }

  async function seedPriorProcessDetectionRow(companyId: string, issueId: string, agentId: string) {
    // Simulate the durable record a previous (now dead) control-plane process
    // left behind: one detection row with the exact details the sweep would
    // write for the current fixture state.
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: "issue.undispatchable_assignee_detected",
      entityType: "issue",
      entityId: issueId,
      details: {
        source: "recovery.reconcile_undispatchable_assigned",
        identifier: "TEMISSION-1",
        assigneeAgentId: agentId,
        status: "todo",
      },
    });
  }

  it("two consecutive sweeps over an unchanged fixture emit exactly one row; a restarted service instance emits no second row", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId, "TEMISSION-1", "todo");

    const sweep = makeSweep();
    const first = await sweep.reconcileUndispatchableAssignedIssues();
    expect(first.reported).toBe(1);
    expect(first.issueIds).toEqual([issueId]);

    const second = await sweep.reconcileUndispatchableAssignedIssues();
    expect(second.reported).toBe(1);
    expect(second.issueIds).toEqual([issueId]);
    expect(await detectionRows("issue.undispatchable_assignee_detected", issueId)).toHaveLength(1);

    // Simulated process restart: a fresh service instance over the same DB.
    const restarted = makeSweep();
    await restarted.reconcileUndispatchableAssignedIssues();
    expect(await detectionRows("issue.undispatchable_assignee_detected", issueId)).toHaveLength(1);
  });

  it("a fresh service instance sees the durable record a prior process left and emits nothing", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId, "TEMISSION-1", "todo");
    await seedPriorProcessDetectionRow(companyId, issueId, pullOnlyAgentId);

    // No in-process sweep has seen this issue yet; only the durable row in the
    // activity log tells the gate that the condition was already reported.
    const result = await makeSweep().reconcileUndispatchableAssignedIssues();
    expect(result.reported).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
    expect(await detectionRows("issue.undispatchable_assignee_detected", issueId)).toHaveLength(1);
  });

  it("a material details change (assignee moves to another pull-only agent) emits exactly one new row", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentAId = await seedAgent(companyId, "process");
    const pullOnlyAgentBId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentAId, "TEMISSION-1", "todo");

    const sweep = makeSweep();
    await sweep.reconcileUndispatchableAssignedIssues();
    expect(await detectionRows("issue.undispatchable_assignee_detected", issueId)).toHaveLength(1);

    await db.update(issues).set({ assigneeAgentId: pullOnlyAgentBId }).where(eq(issues.id, issueId));

    const afterChange = await makeSweep().reconcileUndispatchableAssignedIssues();
    expect(afterChange.reported).toBe(1);
    const rows = await detectionRows("issue.undispatchable_assignee_detected", issueId);
    expect(rows).toHaveLength(2);
    expect((rows[0].details as Record<string, unknown>).assigneeAgentId).toBe(pullOnlyAgentBId);

    // The new baseline is stable: the changed state is now the recorded state.
    await makeSweep().reconcileUndispatchableAssignedIssues();
    expect(await detectionRows("issue.undispatchable_assignee_detected", issueId)).toHaveLength(2);
  });

  it("an issue that leaves the reported set and later re-enters it emits a new row", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId, "TEMISSION-1", "todo");

    const sweep = makeSweep();
    await sweep.reconcileUndispatchableAssignedIssues();
    expect(await detectionRows("issue.undispatchable_assignee_detected", issueId)).toHaveLength(1);

    // Leaves the set: terminal status is not a candidate for this sweep.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    const whileOutside = await makeSweep().reconcileUndispatchableAssignedIssues();
    expect(whileOutside.reported).toBe(0);
    expect(await detectionRows("issue.undispatchable_assignee_detected", issueId)).toHaveLength(1);

    // Re-enters the set in a materially different state: the recorded row says
    // `todo`, the re-entered state is `in_progress`, so a new row is emitted.
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    const afterReentry = await makeSweep().reconcileUndispatchableAssignedIssues();
    expect(afterReentry.reported).toBe(1);
    const rows = await detectionRows("issue.undispatchable_assignee_detected", issueId);
    expect(rows).toHaveLength(2);
    expect((rows[0].details as Record<string, unknown>).status).toBe("in_progress");
  });

  it("the cancelled-only-blocker sweep is gated by the same shared helper", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "codex_local");
    const blockedId = randomUUID();
    await db.insert(issues).values({
      id: blockedId,
      companyId,
      identifier: "TEMISSION-2",
      title: "Blocked dependent",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Cancelled blocker",
      status: "cancelled",
      priority: "high",
    });
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId,
      type: "blocks",
      issueId: blockerId,
      relatedIssueId: blockedId,
    });

    const first = await makeSweep().reconcileCancelledOnlyBlockerDependents();
    expect(first.reported).toBe(1);
    expect(first.issueIds).toEqual([blockedId]);
    expect(await detectionRows("issue.cancelled_blocker_dependent_detected", blockedId)).toHaveLength(1);

    const second = await makeSweep().reconcileCancelledOnlyBlockerDependents();
    expect(second.reported).toBe(1);
    expect(await detectionRows("issue.cancelled_blocker_dependent_detected", blockedId)).toHaveLength(1);
  });

  it("distinct reported issues each keep their own durable record", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueAId = await seedCard(companyId, pullOnlyAgentId, "TEMISSION-1", "todo");
    const issueBId = await seedCard(companyId, pullOnlyAgentId, "TEMISSION-2", "todo");

    const sweep = makeSweep();
    await sweep.reconcileUndispatchableAssignedIssues();

    expect(await detectionRows("issue.undispatchable_assignee_detected", issueAId)).toHaveLength(1);
    expect(await detectionRows("issue.undispatchable_assignee_detected", issueBId)).toHaveLength(1);

    await sweep.reconcileUndispatchableAssignedIssues();
    expect(await detectionRows("issue.undispatchable_assignee_detected", issueAId)).toHaveLength(1);
    expect(await detectionRows("issue.undispatchable_assignee_detected", issueBId)).toHaveLength(1);
  });
});
