import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  unWakeableArchives,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale in_review child archive tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

function hoursAgoISO(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function reviewStage(pendingSince: string | null, currentStageType: "review" | "approval" = "review") {
  return {
    status: "pending",
    currentStageId: "00000000-0000-0000-0000-000000000000",
    currentStageIndex: 0,
    currentStageType,
    currentParticipant: null,
    returnAssignee: null,
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: null,
    pendingSince,
  };
}

describeEmbeddedPostgres("recovery ingestStaleInReviewChildIssues", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-review-child-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(unWakeableArchives);
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
      name: "Worker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId };
  }

  it("archives a genuinely stale in_review child when parent is blocked", async () => {
    const { companyId, agentId } = await seed();
    const parentId = randomUUID();

    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent — blocked",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      title: "Child — stale in_review",
      status: "in_review",
      priority: "high",
      parentId,
      assigneeAgentId: agentId,
      // Residue from a previous life's monitor — must NOT drive the decision.
      monitorLastTriggeredAt: new Date(Date.now() - 40 * 60 * 60 * 1000),
      // Current review-stage arm is 25h old → genuinely stale.
      executionState: reviewStage(hoursAgoISO(25)),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.ingestStaleInReviewChildIssues();

    expect(result.archived).toBe(1);
    expect(result.skippedParentNotBlocked).toBe(0);
    expect(result.skippedFresh).toBe(0);
    expect(result.skippedLiveBlocker).toBe(0);

    const child = await db
      .select({ hiddenAt: issues.hiddenAt })
      .from(issues)
      .where(eq(issues.id, childId))
      .then((rows) => rows[0]);
    expect(child?.hiddenAt).not.toBeNull();

    const archive = await db
      .select({ policy: unWakeableArchives.policy, issueId: unWakeableArchives.issueId })
      .from(unWakeableArchives)
      .where(eq(unWakeableArchives.issueId, childId))
      .then((rows) => rows[0] ?? null);
    expect(archive?.policy).toBe("stale_in_review_child");

    // The auto_archived activity row keeps its existing shape.
    const activity = await db
      .select({ action: activityLog.action, entityType: activityLog.entityType, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.entityType, "issue"), eq(activityLog.entityId, childId), eq(activityLog.action, "issue.auto_archived")))
      .then((rows) => rows[0] ?? null);
    expect(activity?.action).toBe("issue.auto_archived");
    expect((activity?.details as Record<string, unknown>)?.policy).toBe("stale_in_review_child");
    expect((activity?.details as Record<string, unknown>)?.source).toBe("recovery.ingest_stale_in_review_child_issues");
  });

  it("does NOT archive a freshly-armed card even with old monitor residue (SUP-17735)", async () => {
    const { companyId, agentId } = await seed();
    const parentId = randomUUID();

    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent — blocked on this card",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      title: "Child — freshly armed in_review",
      status: "in_review",
      priority: "high",
      parentId,
      assigneeAgentId: agentId,
      // Stale residue from a dead monitor of a previous life — the old bug's trigger.
      monitorLastTriggeredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      // Just re-delivered into review: arm anchor is seconds old.
      executionState: reviewStage(hoursAgoISO(-0.03)),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.ingestStaleInReviewChildIssues();

    expect(result.archived).toBe(0);
    expect(result.skippedFresh).toBe(1);
    expect(result.skippedLiveBlocker).toBe(0);

    const child = await db
      .select({ hiddenAt: issues.hiddenAt })
      .from(issues)
      .where(eq(issues.id, childId))
      .then((rows) => rows[0]);
    expect(child?.hiddenAt).toBeNull();

    const archive = await db
      .select({ issueId: unWakeableArchives.issueId })
      .from(unWakeableArchives)
      .where(eq(unWakeableArchives.issueId, childId))
      .then((rows) => rows[0] ?? null);
    expect(archive).toBeNull();
  });

  it("skips stale in_review child when parent is not blocked", async () => {
    const { companyId, agentId } = await seed();
    const parentId = randomUUID();

    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent — in_progress",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      title: "Child — stale in_review",
      status: "in_review",
      priority: "high",
      parentId,
      assigneeAgentId: agentId,
      executionState: reviewStage(hoursAgoISO(25)),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.ingestStaleInReviewChildIssues();

    expect(result.archived).toBe(0);
    expect(result.skippedParentNotBlocked).toBe(1);

    const child = await db
      .select({ hiddenAt: issues.hiddenAt })
      .from(issues)
      .where(eq(issues.id, childId))
      .then((rows) => rows[0]);
    expect(child?.hiddenAt).toBeNull();
  });

  it("does NOT archive a stale card that is a live blocker of a non-terminal issue", async () => {
    const { companyId, agentId } = await seed();
    const parentId = randomUUID();

    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent — blocked",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      title: "Child — stale in_review, load-bearing blocker",
      status: "in_review",
      priority: "high",
      parentId,
      assigneeAgentId: agentId,
      executionState: reviewStage(hoursAgoISO(25)),
    });

    // The child blocks a still-open (todo) sibling card.
    const blockedId = randomUUID();
    await db.insert(issues).values({
      id: blockedId,
      companyId,
      title: "Sibling — blocked on this card",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: childId,
      relatedIssueId: blockedId,
      type: "blocks",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.ingestStaleInReviewChildIssues();

    expect(result.archived).toBe(0);
    expect(result.skippedLiveBlocker).toBe(1);

    const child = await db
      .select({ hiddenAt: issues.hiddenAt })
      .from(issues)
      .where(eq(issues.id, childId))
      .then((rows) => rows[0]);
    expect(child?.hiddenAt).toBeNull();
  });

  it("archives a stale card whose only blocked issues are terminal", async () => {
    const { companyId, agentId } = await seed();
    const parentId = randomUUID();

    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent — blocked",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      title: "Child — stale in_review, only blocks a done card",
      status: "in_review",
      priority: "high",
      parentId,
      assigneeAgentId: agentId,
      executionState: reviewStage(hoursAgoISO(25)),
    });

    const doneId = randomUUID();
    await db.insert(issues).values({
      id: doneId,
      companyId,
      title: "Done card",
      status: "done",
      priority: "high",
      assigneeAgentId: agentId,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: childId,
      relatedIssueId: doneId,
      type: "blocks",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.ingestStaleInReviewChildIssues();

    // A 'blocks' edge into a terminal issue is not a live blocker.
    expect(result.archived).toBe(1);
    expect(result.skippedLiveBlocker).toBe(0);

    const child = await db
      .select({ hiddenAt: issues.hiddenAt })
      .from(issues)
      .where(eq(issues.id, childId))
      .then((rows) => rows[0]);
    expect(child?.hiddenAt).not.toBeNull();
  });

  it("falls back to updatedAt when pendingSince is absent (legacy arm)", async () => {
    const { companyId, agentId } = await seed();
    const parentId = randomUUID();

    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent — blocked",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      title: "Child — legacy arm, old updatedAt",
      status: "in_review",
      priority: "high",
      parentId,
      assigneeAgentId: agentId,
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      executionState: reviewStage(null),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.ingestStaleInReviewChildIssues();

    expect(result.archived).toBe(1);
    expect(result.skippedFresh).toBe(0);
  });

  it("skips already-archived child via unWakeableArchives", async () => {
    const { companyId, agentId } = await seed();
    const parentId = randomUUID();

    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent — blocked",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      title: "Child — already archived",
      status: "in_review",
      priority: "high",
      parentId,
      assigneeAgentId: agentId,
      executionState: reviewStage(hoursAgoISO(25)),
    });
    await db.insert(unWakeableArchives).values({
      companyId,
      issueId: childId,
      policy: "stale_in_review_child",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.ingestStaleInReviewChildIssues();

    expect(result.archived).toBe(0);
  });

  it("skips in_review child at approval stage (not review stage)", async () => {
    const { companyId, agentId } = await seed();
    const parentId = randomUUID();

    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent — blocked",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      title: "Child — stale in_review at approval stage",
      status: "in_review",
      priority: "high",
      parentId,
      assigneeAgentId: agentId,
      executionState: reviewStage(hoursAgoISO(25), "approval"),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.ingestStaleInReviewChildIssues();

    // Approval-stage children are excluded by the SQL stage filter.
    expect(result.archived).toBe(0);
    expect(result.skippedFresh).toBe(0);

    const child = await db
      .select({ hiddenAt: issues.hiddenAt })
      .from(issues)
      .where(eq(issues.id, childId))
      .then((rows) => rows[0]);
    expect(child?.hiddenAt).toBeNull();
  });

  it("is idempotent — second pass finds nothing to archive", async () => {
    const { companyId, agentId } = await seed();
    const parentId = randomUUID();

    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent — blocked",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      title: "Child — stale in_review",
      status: "in_review",
      priority: "high",
      parentId,
      assigneeAgentId: agentId,
      executionState: reviewStage(hoursAgoISO(25)),
    });

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.ingestStaleInReviewChildIssues();
    const second = await heartbeat.ingestStaleInReviewChildIssues();

    expect(first.archived).toBe(1);
    expect(second.archived).toBe(0);
  });
});
