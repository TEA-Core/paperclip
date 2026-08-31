import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
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
  issueInboxArchives,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { recoveryService } from "../services/recovery/service.ts";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres undispatchable-assignee escalation tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery sweep undispatchable-assignee escalation (SUP-14565)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-undispatchable-escalation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueInboxArchives);
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
    opts?: { status?: string; issueNumber?: number; prefix?: string },
  ) {
    const issueId = randomUUID();
    const issueNumber = opts?.issueNumber ?? 1;
    const prefix = opts?.prefix ?? "ESC";
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assigned card",
      status: opts?.status ?? "todo",
      priority: "high",
      assigneeAgentId: agentId,
      monitorNextCheckAt: null,
      issueNumber,
      identifier: `${prefix}-${issueNumber}`,
    });
    return issueId;
  }

  function makeSweep() {
    return recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
  }

  function createApp(actor: any = { type: "board", source: "local_implicit" }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }

  async function recoveryActionRows(issueId: string) {
    return db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
  }

  async function openEscalation(companyId: string, pullOnlyAgentId: string, issueId: string) {
    const sweep = makeSweep();
    await sweep.reconcileUndispatchableAssignedIssues();
    const second = await sweep.reconcileUndispatchableAssignedIssues();
    expect(second.escalated).toBe(1);
    const rows = await recoveryActionRows(issueId);
    expect(rows).toHaveLength(1);
    return { sweep, action: rows[0] };
  }

  it("first sight stays report-only: no recovery action on the first cycle", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId);

    const result = await makeSweep().reconcileUndispatchableAssignedIssues();

    expect(result.reported).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.resolved).toBe(0);
    expect(await recoveryActionRows(issueId)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("todo");
    expect(issue.assigneeAgentId).toBe(pullOnlyAgentId);
  });

  it("second confirmed cycle opens a board-owned, non-exhausting action", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId);

    const sweep = makeSweep();
    const first = await sweep.reconcileUndispatchableAssignedIssues();
    expect(first.escalated).toBe(0);
    const second = await sweep.reconcileUndispatchableAssignedIssues();
    expect(second.reported).toBe(1);
    expect(second.escalated).toBe(1);

    const [action] = await recoveryActionRows(issueId);
    expect(action).toMatchObject({
      kind: "undispatchable_assignee",
      status: "active",
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: pullOnlyAgentId,
      cause: "undispatchable_assignee",
      fingerprint: `undispatchable_assignee:${companyId}:${issueId}`,
      attemptCount: 1,
      maxAttempts: null,
      wakePolicy: null,
      monitorPolicy: null,
      outcome: null,
    });
    expect(action.evidence).toMatchObject({
      source: "recovery.reconcile_undispatchable_assigned",
      assigneeAgentId: pullOnlyAgentId,
      assigneeAdapterType: "process",
      status: "todo",
    });

    // The card itself is untouched: no status write, no reassignment, no comment.
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("todo");
    expect(issue.assigneeAgentId).toBe(pullOnlyAgentId);
    const comments = await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    // The card now carries the action through the standard activeRecoveryAction
    // exposure.
    const app = createApp();
    const detail = await request(app).get(`/api/issues/${issueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toMatchObject({
      id: action.id,
      kind: "undispatchable_assignee",
      status: "active",
    });

    const escalations = await db
      .select({ id: activityLog.id, details: activityLog.details })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.action, "issue.undispatchable_assignee_escalated"),
          eq(activityLog.entityId, issueId),
        ),
      );
    expect(escalations).toHaveLength(1);
    expect(escalations[0].details).toMatchObject({
      recoveryActionId: action.id,
      assigneeAgentId: pullOnlyAgentId,
    });
  });

  it("re-confirmation on later cycles is idempotent: no second action, no attempt bump", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId);

    const sweep = makeSweep();
    await sweep.reconcileUndispatchableAssignedIssues();
    const second = await sweep.reconcileUndispatchableAssignedIssues();
    expect(second.escalated).toBe(1);
    const third = await sweep.reconcileUndispatchableAssignedIssues();
    const fourth = await sweep.reconcileUndispatchableAssignedIssues();

    expect(third.escalated).toBe(0);
    expect(fourth.escalated).toBe(0);
    const rows = await recoveryActionRows(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe((await recoveryActionRows(issueId))[0].id);
    expect(rows[0].attemptCount).toBe(1);
    expect(rows[0].status).toBe("active");
  });

  it("the persisted action survives a control-plane restart without re-opening", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId);

    const { action } = await openEscalation(companyId, pullOnlyAgentId, issueId);

    // A fresh service instance (restart) has an empty in-memory sight counter,
    // so the first cycle counts first-sight again; the persisted action is the
    // source of truth and must not be duplicated.
    const restarted = makeSweep();
    const firstAfterRestart = await restarted.reconcileUndispatchableAssignedIssues();
    expect(firstAfterRestart.reported).toBe(1);
    expect(firstAfterRestart.escalated).toBe(0);
    const secondAfterRestart = await restarted.reconcileUndispatchableAssignedIssues();
    expect(secondAfterRestart.escalated).toBe(0);

    const rows = await recoveryActionRows(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(action.id);
    expect(rows[0].attemptCount).toBe(1);
    expect(rows[0].status).toBe("active");
  });

  it("resolves the open action when the card is re-assigned to a dispatchable agent", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const dispatchableAgentId = await seedAgent(companyId, "codex_local");
    const issueId = await seedCard(companyId, pullOnlyAgentId);

    const { action } = await openEscalation(companyId, pullOnlyAgentId, issueId);

    await db
      .update(issues)
      .set({ assigneeAgentId: dispatchableAgentId })
      .where(eq(issues.id, issueId));

    const result = await makeSweep().reconcileUndispatchableAssignedIssues();
    expect(result.resolved).toBe(1);
    expect(result.reported).toBe(0);

    const rows = await recoveryActionRows(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(action.id);
    expect(rows[0].status).toBe("resolved");
    expect(rows[0].outcome).toBe("restored");
    expect(rows[0].resolvedAt).toBeTruthy();
    expect(rows[0].resolutionNote).toContain("no longer a pull-only adapter agent");

    // The card is untouched apart from the reassignment.
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("todo");
    expect(issue.assigneeAgentId).toBe(dispatchableAgentId);
  });

  it("resolves the open action when the card leaves the stranded set", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId);

    const { action } = await openEscalation(companyId, pullOnlyAgentId, issueId);

    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));

    const result = await makeSweep().reconcileUndispatchableAssignedIssues();
    expect(result.resolved).toBe(1);

    const [row] = await recoveryActionRows(issueId);
    expect(row.status).toBe("resolved");
    expect(row.outcome).toBe("restored");
    expect(row.resolutionNote).toContain("now in_review");
  });

  it("never exhausts the board-owned action in the stale-wake sweep", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId);

    const { sweep, action } = await openEscalation(companyId, pullOnlyAgentId, issueId);

    // Make the action stale so the stale-wake sweep considers it.
    await db
      .update(issueRecoveryActions)
      .set({ lastAttemptAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(issueRecoveryActions.id, action.id));

    const stale = await sweep.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });
    expect(stale.nonWakeableSkipped).toBe(1);
    expect(stale.maxAttemptsReached).toBe(0);
    expect(stale.reFired).toBe(0);

    // No attempt burned: still active at attemptCount 1, no exhaustion outcome,
    // no exhaustion comment on the card.
    const [row] = await recoveryActionRows(issueId);
    expect(row.status).toBe("active");
    expect(row.attemptCount).toBe(1);
    expect(row.outcome).toBeNull();
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments.filter((c) => (c.body ?? "").includes("exhausted its attempt ceiling"))).toHaveLength(0);

    // Repeated sweeps keep skipping without burning, so the action can never
    // walk toward its ceiling.
    await db
      .update(issueRecoveryActions)
      .set({ lastAttemptAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(issueRecoveryActions.id, action.id));
    const staleAgain = await sweep.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });
    expect(staleAgain.nonWakeableSkipped).toBe(1);
    expect(staleAgain.maxAttemptsReached).toBe(0);
    const [rowAgain] = await recoveryActionRows(issueId);
    expect(rowAgain.attemptCount).toBe(1);
  });

  it("keeps the card board-writable even from a terminal exhausted action state", async () => {
    const companyId = await seedCompany();
    const prefix = `ESC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId, { prefix });

    const { action } = await openEscalation(companyId, pullOnlyAgentId, issueId);

    // Force the worst case: the action is terminal (escalated + exhausted).
    await db
      .update(issueRecoveryActions)
      .set({ status: "escalated", outcome: "exhausted", attemptCount: 5 })
      .where(eq(issueRecoveryActions.id, action.id));

    const app = createApp();
    const patched = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" })
      .expect(200);
    expect(patched.body).toMatchObject({ id: issueId, status: "done" });

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("done");

    // The terminal row is protected: ordinary resolution must not erase it,
    // but the card itself is fully writable.
    const [row] = await recoveryActionRows(issueId);
    expect(row.status).toBe("escalated");
    expect(row.outcome).toBe("exhausted");
  });
});
