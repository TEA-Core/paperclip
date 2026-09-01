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
    `Skipping embedded Postgres undispatchable-assigned sweep tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery sweep reconcileUndispatchableAssignedIssues", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-undispatchable-assigned-");
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

  async function seedCard(
    companyId: string,
    agentId: string,
    opts?: { status?: string; monitorNextCheckAt?: Date },
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assigned card",
      status: opts?.status ?? "todo",
      priority: "high",
      assigneeAgentId: agentId,
      monitorNextCheckAt: opts?.monitorNextCheckAt ?? null,
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
          eq(activityLog.action, "issue.undispatchable_assignee_detected"),
          eq(activityLog.entityId, issueId),
        ),
      );
  }

  async function issueRow(issueId: string) {
    const rows = await db.select().from(issues).where(eq(issues.id, issueId));
    return rows[0] ?? null;
  }

  async function recoveryActionRows(issueId: string) {
    return db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
  }

  async function commentRows(issueId: string) {
    return db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
  }

  it("reports a pull-only assigned todo card with no continuation path, report-only", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId);

    const result = await makeSweep().reconcileUndispatchableAssignedIssues();

    expect(result.reported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const audits = await detectionRows(issueId);
    expect(audits).toHaveLength(1);
    const details = audits[0].details as Record<string, unknown>;
    expect(details.source).toBe("recovery.reconcile_undispatchable_assigned");
    expect(details.assigneeAgentId).toBe(pullOnlyAgentId);
    expect(details.status).toBe("todo");

    // Report-only: no status write, no reassignment, no recovery action, no comment.
    const issue = await issueRow(issueId);
    expect(issue?.status).toBe("todo");
    expect(issue?.assigneeAgentId).toBe(pullOnlyAgentId);
    expect(await recoveryActionRows(issueId)).toHaveLength(0);
    expect(await commentRows(issueId)).toHaveLength(0);
  });

  it("reports an in_progress pull-only assigned card with no continuation path", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId, { status: "in_progress" });

    const result = await makeSweep().reconcileUndispatchableAssignedIssues();

    expect(result.reported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const audits = await detectionRows(issueId);
    expect(audits).toHaveLength(1);
    const details = audits[0].details as Record<string, unknown>;
    expect(details.status).toBe("in_progress");

    const issue = await issueRow(issueId);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.assigneeAgentId).toBe(pullOnlyAgentId);
  });

  it("skips a pull-only assigned card with a future monitorNextCheckAt", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId, {
      monitorNextCheckAt: new Date(Date.now() + 60 * 60_000),
    });

    const result = await makeSweep().reconcileUndispatchableAssignedIssues();

    expect(result.reported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);
    expect(await detectionRows(issueId)).toHaveLength(0);
    expect((await issueRow(issueId))?.status).toBe("todo");
  });

  it("skips a dispatchable assigned card with no continuation path", async () => {
    const companyId = await seedCompany();
    const dispatchableAgentId = await seedAgent(companyId, "codex_local");
    const issueId = await seedCard(companyId, dispatchableAgentId);

    const result = await makeSweep().reconcileUndispatchableAssignedIssues();

    expect(result.reported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);
    expect(await detectionRows(issueId)).toHaveLength(0);
    expect((await issueRow(issueId))?.status).toBe("todo");
  });

  it("skips a backlog card owned by the stillborn sweep", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId, { status: "backlog" });

    const result = await makeSweep().reconcileUndispatchableAssignedIssues();

    expect(result.reported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.issueIds).toEqual([]);
    expect(await detectionRows(issueId)).toHaveLength(0);
    expect((await issueRow(issueId))?.status).toBe("backlog");
  });

  it("reports the six fresh-census pull-only todo cards' shape and not cards owned by dispatchable agents", async () => {
    // Fresh census 2026-08-28T17:50Z (SUP-14281 filer correction): six pull-only
    // `todo` cards with no continuation path; the "9 dependents" figure is historical.
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const dispatchableAgentId = await seedAgent(companyId, "codex_local");

    const terminalIds: string[] = [];
    for (let n = 0; n < 6; n += 1) {
      terminalIds.push(await seedCard(companyId, pullOnlyAgentId));
    }
    const dispatchableCardId = await seedCard(companyId, dispatchableAgentId);

    const result = await makeSweep().reconcileUndispatchableAssignedIssues();

    expect(result.reported).toBe(6);
    expect(result.skipped).toBe(1);
    expect([...result.issueIds].sort()).toEqual([...terminalIds].sort());
    for (const issueId of terminalIds) {
      expect(await detectionRows(issueId)).toHaveLength(1);
    }
    expect(await detectionRows(dispatchableCardId)).toHaveLength(0);
    expect((await issueRow(dispatchableCardId))?.status).toBe("todo");
  });

  it("rotates past the candidate window so higher-id cards are scanned on later passes", async () => {
    // Board reopen 2026-08-29: the sweep's fixed limit on asc(id) pinned the scan
    // to the lowest candidate ids forever once 100 cards stay perpetually
    // eligible (report-only cards never leave the candidate set). Regression:
    // a keyset cursor advances the window, so no stranded card is never scanned.
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");

    const ids: string[] = [];
    for (let n = 0; n < 105; n += 1) {
      ids.push(await seedCard(companyId, pullOnlyAgentId));
    }
    const sortedIds = [...ids].sort();
    const expectedFirstWindow = sortedIds.slice(0, 100);
    const expectedRemainder = sortedIds.slice(100);

    const sweep = makeSweep();

    const first = await sweep.reconcileUndispatchableAssignedIssues();
    expect(first.scanned).toBe(100);
    expect(first.reported).toBe(100);
    expect([...first.issueIds].sort()).toEqual(expectedFirstWindow);

    const second = await sweep.reconcileUndispatchableAssignedIssues();
    expect(second.scanned).toBe(expectedRemainder.length);
    expect(second.reported).toBe(expectedRemainder.length);
    expect([...second.issueIds].sort()).toEqual(expectedRemainder);

    // Cursor wrapped: the window re-scans the lowest ids. Emission is
    // edge-triggered on the durable record (SUP-14539), so the re-scan reports
    // the set but writes no second row per issue.
    const third = await sweep.reconcileUndispatchableAssignedIssues();
    expect(third.scanned).toBe(100);
    expect(third.reported).toBe(100);

    // One detection row per seeded card (first window + remainder); the
    // wrapped re-scan of the first 100 ids writes no second row per issue.
    const allRows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.undispatchable_assignee_detected"));
    expect(allRows).toHaveLength(105);
  });

  it("repeated ticks over the same unchanged card report the set but emit one row", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId);

    const sweep = makeSweep();
    const first = await sweep.reconcileUndispatchableAssignedIssues();
    const second = await sweep.reconcileUndispatchableAssignedIssues();

    expect(first.reported).toBe(1);
    expect(first.issueIds).toEqual([issueId]);
    expect(second.reported).toBe(1);
    expect(second.skipped).toBe(0);
    expect(second.issueIds).toEqual([issueId]);

    // One detection row total despite repeated ticks over the same unchanged card.
    expect(await detectionRows(issueId)).toHaveLength(1);
  });
});
