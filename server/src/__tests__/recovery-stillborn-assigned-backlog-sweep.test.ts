import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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

  it("reports a matching backlog row with an assigneeAgentId", async () => {
    const { companyId, agentId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stillborn assigned backlog",
      status: "backlog",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStillbornAssignedBacklog();

    expect(result.reported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const audit = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.stillborn_assigned_backlog_detected"))
      .then((rows) => rows[0]);
    expect(audit?.entityId).toBe(issueId);
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

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStillbornAssignedBacklog();

    expect(result.reported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.issueIds).toEqual([]);
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

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStillbornAssignedBacklog();

    expect(result.reported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.issueIds).toEqual([]);
  });

  it("dedup across two ticks — second tick over unchanged population reports 0 new signals", async () => {
    const { companyId, agentId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stillborn assigned backlog",
      status: "backlog",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.reconcileStillbornAssignedBacklog();
    const second = await heartbeat.reconcileStillbornAssignedBacklog();

    expect(first.reported).toBe(1);
    expect(first.issueIds).toEqual([issueId]);
    expect(second.reported).toBe(1);
    expect(second.issueIds).toEqual([issueId]);

    const audits = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.stillborn_assigned_backlog_detected"));
    expect(audits).toHaveLength(2);
  });
});
