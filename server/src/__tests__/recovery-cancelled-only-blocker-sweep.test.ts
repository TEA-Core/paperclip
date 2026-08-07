import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
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
    `Skipping embedded Postgres cancelled-only-blocker-dependent sweep tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery sweep reconcileCancelledOnlyBlockerDependents", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cancelled-only-blocker-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "activity_log",
        "issue_relations",
        "issues",
        "heartbeat_runs",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
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

  async function createBlockedIssue(companyId: string, agentId: string, title: string) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title,
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
    });
    return id;
  }

  async function createBlocker(companyId: string, status: string, title: string) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title,
      status,
      priority: "high",
    });
    return id;
  }

  async function addBlockerRelation(companyId: string, blockerId: string, blockedId: string) {
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId,
      type: "blocks",
      issueId: blockerId,
      relatedIssueId: blockedId,
    });
  }

  async function snapshotIssuesAndRelations() {
    const issueRows = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .then((rows) => rows.map((r) => ({ id: r.id, status: r.status })).sort((a, b) => (a.id < b.id ? -1 : 1)));
    const relationRows = await db
      .select({
        id: issueRelations.id,
        issueId: issueRelations.issueId,
        relatedIssueId: issueRelations.relatedIssueId,
        type: issueRelations.type,
      })
      .from(issueRelations)
      .then((rows) =>
        rows
          .map((r) => ({ id: r.id, issueId: r.issueId, relatedIssueId: r.relatedIssueId, type: r.type }))
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
      );
    return { issues: JSON.stringify(issueRows), relations: JSON.stringify(relationRows) };
  }

  it("reports a blocked dependent whose single unresolved blocker is cancelled", async () => {
    const { companyId, agentId } = await seed();
    const blockedId = await createBlockedIssue(companyId, agentId, "Blocked dependent");
    const blockerId = await createBlocker(companyId, "cancelled", "Cancelled blocker");
    await addBlockerRelation(companyId, blockerId, blockedId);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileCancelledOnlyBlockerDependents();

    expect(result.reported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.issueIds).toEqual([blockedId]);

    const audit = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.cancelled_blocker_dependent_detected"))
      .then((rows) => rows[0]);
    expect(audit?.entityId).toBe(blockedId);
  });

  it("reports a dependent whose blockers are all cancelled (>=2)", async () => {
    const { companyId, agentId } = await seed();
    const blockedId = await createBlockedIssue(companyId, agentId, "Blocked dependent");
    const blocker1Id = await createBlocker(companyId, "cancelled", "Cancelled blocker 1");
    const blocker2Id = await createBlocker(companyId, "cancelled", "Cancelled blocker 2");
    await addBlockerRelation(companyId, blocker1Id, blockedId);
    await addBlockerRelation(companyId, blocker2Id, blockedId);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileCancelledOnlyBlockerDependents();

    expect(result.reported).toBe(1);
    expect(result.issueIds).toEqual([blockedId]);
  });

  it("does NOT report when a non-terminal blocker (todo) is also unresolved", async () => {
    const { companyId, agentId } = await seed();
    const blockedId = await createBlockedIssue(companyId, agentId, "Blocked dependent");
    const cancelledBlockerId = await createBlocker(companyId, "cancelled", "Cancelled blocker");
    const todoBlockerId = await createBlocker(companyId, "todo", "Todo blocker");
    await addBlockerRelation(companyId, cancelledBlockerId, blockedId);
    await addBlockerRelation(companyId, todoBlockerId, blockedId);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileCancelledOnlyBlockerDependents();

    expect(result.reported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);
  });

  it("does NOT report when the unresolved set is empty (done blockers only)", async () => {
    const { companyId, agentId } = await seed();
    const blockedId = await createBlockedIssue(companyId, agentId, "Blocked dependent");
    const doneBlockerId = await createBlocker(companyId, "done", "Done blocker");
    await addBlockerRelation(companyId, doneBlockerId, blockedId);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileCancelledOnlyBlockerDependents();

    expect(result.reported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);
  });

  it("does NOT report a done-blocker-only dependent", async () => {
    const { companyId, agentId } = await seed();
    const doneDependentId = randomUUID();
    await db.insert(issues).values({
      id: doneDependentId,
      companyId,
      title: "Done dependent",
      status: "done",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const doneBlockerId = await createBlocker(companyId, "done", "Done blocker");
    await addBlockerRelation(companyId, doneBlockerId, doneDependentId);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileCancelledOnlyBlockerDependents();

    expect(result.reported).toBe(0);
    expect(result.issueIds).toEqual([]);
  });

  it("idempotent: two consecutive calls report the same set and mutate nothing", async () => {
    const { companyId, agentId } = await seed();
    const blockedId = await createBlockedIssue(companyId, agentId, "Blocked dependent");
    const blockerId = await createBlocker(companyId, "cancelled", "Cancelled blocker");
    await addBlockerRelation(companyId, blockerId, blockedId);

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.reconcileCancelledOnlyBlockerDependents();
    const second = await heartbeat.reconcileCancelledOnlyBlockerDependents();

    expect(first.reported).toBe(1);
    expect(first.issueIds).toEqual([blockedId]);
    expect(second.reported).toBe(1);
    expect(second.issueIds).toEqual([blockedId]);

    const audits = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.cancelled_blocker_dependent_detected"));
    expect(audits).toHaveLength(2);
  });

  it("invariant probe: before/after snapshot of issues.status and issue_blockers rows is byte-equal", async () => {
    const { companyId, agentId } = await seed();
    const blockedId = await createBlockedIssue(companyId, agentId, "Blocked dependent");
    const blockerId = await createBlocker(companyId, "cancelled", "Cancelled blocker");
    await addBlockerRelation(companyId, blockerId, blockedId);

    const before = await snapshotIssuesAndRelations();

    const heartbeat = heartbeatService(db);
    await heartbeat.reconcileCancelledOnlyBlockerDependents();

    const after = await snapshotIssuesAndRelations();

    expect(after.issues).toBe(before.issues);
    expect(after.relations).toBe(before.relations);
  });

  it("does NOT report a blocked dependent with no blockers at all", async () => {
    const { companyId, agentId } = await seed();
    const blockedId = await createBlockedIssue(companyId, agentId, "Blocked with no blockers");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileCancelledOnlyBlockerDependents();

    expect(result.reported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.issueIds).toEqual([]);
  });
});
