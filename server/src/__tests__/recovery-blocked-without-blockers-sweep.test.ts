import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService } from "../services/heartbeat.ts";
import { isBlockedWithoutBlockers } from "../services/recovery/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocked-without-blockers sweeper tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery reconcileBlockedWithoutBlockers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-without-blockers-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
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

  async function seedCompanyAndAgent() {
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

  it("reports a blocked issue with zero blocker edges in counter + issueIds", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked with no blockers",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.reported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows[0]);
    expect(audit?.action).toBe("issue.blocked_without_blockers_detected");
    expect((audit?.details as { source?: string } | null)?.source).toBe(
      "recovery.reconcile_blocked_without_blockers",
    );
  });

  it("does not write issues.status and does not enqueueWakeup", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked with no blockers — no status write",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.reported).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("blocked");

    const wakeups = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.contextSnapshot, issueId))
      .then((rows) => rows.length);
    expect(wakeups).toBe(0);
  });

  it("does not report a blocked issue with >=1 blocker edge", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockedId = randomUUID();
    const blockerId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockedId,
        companyId,
        title: "Blocked with a blocker",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        id: blockerId,
        companyId,
        title: "Blocker",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId,
      type: "blocks",
      issueId: blockerId,
      relatedIssueId: blockedId,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.reported).toBe(0);
    expect(result.issueIds).toEqual([]);

    const audit = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, blockedId))
      .then((rows) => rows[0]);
    expect(audit).toBeUndefined();
  });

  it("does not report a non-blocked issue", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Not blocked",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(result.reported).toBe(0);
    expect(result.issueIds).toEqual([]);
  });

  it("dedupes — repeated ticks do not re-log the same issue every pass", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked with no blockers — dedupe",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.reconcileBlockedWithoutBlockers();
    const second = await heartbeat.reconcileBlockedWithoutBlockers();

    expect(first.reported).toBe(1);
    expect(first.issueIds).toEqual([issueId]);
    expect(second.reported).toBe(1);
    expect(second.issueIds).toEqual([issueId]);

    const auditRows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(auditRows.length).toBe(1);
  });

  it("isBlockedWithoutBlockers predicate", () => {
    expect(isBlockedWithoutBlockers({ status: "blocked", blockerIssueIds: [] })).toBe(true);
    expect(isBlockedWithoutBlockers({ status: "blocked", blockerIssueIds: ["x"] })).toBe(false);
    expect(isBlockedWithoutBlockers({ status: "todo", blockerIssueIds: [] })).toBe(false);
    expect(isBlockedWithoutBlockers({ status: "done", blockerIssueIds: [] })).toBe(false);
  });
});
