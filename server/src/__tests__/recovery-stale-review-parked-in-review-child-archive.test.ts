import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
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

  it("archives stale in_review child when parent is blocked", async () => {
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
      monitorLastTriggeredAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.ingestStaleInReviewChildIssues();

    expect(result.archived).toBe(1);
    expect(result.skippedParentNotBlocked).toBe(0);

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
      monitorLastTriggeredAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
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

  it("skips in_review child that is not stale (recent monitor)", async () => {
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
      title: "Child — recent in_review",
      status: "in_review",
      priority: "high",
      parentId,
      assigneeAgentId: agentId,
      monitorLastTriggeredAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.ingestStaleInReviewChildIssues();

    expect(result.archived).toBe(0);
    expect(result.skippedParentNotBlocked).toBe(0);
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
      monitorLastTriggeredAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    await db.insert(unWakeableArchives).values({
      companyId,
      issueId: childId,
      policy: "stale_in_review_child",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.ingestStaleInReviewChildIssues();

    expect(result.archived).toBe(0);
    expect(result.skippedParentNotBlocked).toBe(0);
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
      monitorLastTriggeredAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.ingestStaleInReviewChildIssues();
    const second = await heartbeat.ingestStaleInReviewChildIssues();

    expect(first.archived).toBe(1);
    expect(second.archived).toBe(0);
  });
});
