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

  // A queued wakeup on the source card. `sourceHasNewPathOutsideRecoveryAction`
  // treats any queued/claimed/deferred wakeup whose recoveryActionId differs from
  // the open action as a "new execution path", but `hasActiveExecutionPath`
  // (which the mint sweep keys off) only counts `deferred_issue_execution`, so a
  // plain `queued` wakeup reproduces the faulty resolve-side signal without
  // making the mint sweep skip the card.
  async function seedQueuedWakeup(companyId: string, agentId: string, issueId: string) {
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "test",
      status: "queued",
      payload: { issueId },
    });
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

    // SUP-14906 supersedes the row half of this assertion. SUP-14565 pinned the
    // ceiling-exhausted row as protected against ordinary resolution, which left
    // it permanently active on a terminal source: the classifier's terminal
    // branch decided to cancel it on every read and the predicate matched zero
    // rows every time. SUP-14906 AC1 makes a terminal source clear the action,
    // so the row is now resolved rather than preserved. The board-writability
    // guarantee this test exists for — the PATCH above returning 200 with the
    // card at `done` — is unchanged, and AC2 (the clear must not write the
    // issue's own status) is asserted above.
    const [row] = await recoveryActionRows(issueId);
    expect(row.status).toBe("cancelled");
    expect(row.outcome).toBe("cancelled");
  });

  async function resolveBoardRuling(actionId: string, outcome: "false_positive" | "restored") {
    // Simulates the board resolution this card consumes: a resolved row of the
    // action whose outcome records the ruling. The mint-time evidence
    // (assigneeAgentId) is deliberately preserved — a board resolution does not
    // rewrite it. This is the row the producer card makes reachable via
    // `resolveIssueRecoveryActionSchema` (outcome false_positive on a todo
    // source); exercising it here through the row keeps this card independent
    // of that validator relaxation.
    await db
      .update(issueRecoveryActions)
      .set({
        status: "resolved",
        outcome,
        resolutionNote: outcome === "false_positive"
          ? "Ruled structurally invalid: pull-only assignee has no wake path by design."
          : "Condition cleared; re-detection stays armed.",
        resolvedAt: new Date(),
      })
      .where(eq(issueRecoveryActions.id, actionId));
  }

  it("does not re-mint after a board false_positive ruling with an unchanged assignee, across two consecutive sweeps", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId);

    const { action } = await openEscalation(companyId, pullOnlyAgentId, issueId);
    await resolveBoardRuling(action.id, "false_positive");

    // A fresh service instance: first sweep is first-sight, second is the
    // confirmed cycle that the pre-fix code re-minted. Both must stay quiet.
    const sweep = makeSweep();
    const next = await sweep.reconcileUndispatchableAssignedIssues();
    expect(next.escalated).toBe(0);
    const again = await sweep.reconcileUndispatchableAssignedIssues();
    expect(again.escalated).toBe(0);
    expect(again.reported).toBe(1);

    const rows = await recoveryActionRows(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(action.id);
    expect(rows[0].status).toBe("resolved");
    expect(rows[0].outcome).toBe("false_positive");
  });

  it("the false_positive ruling survives a simulated control-plane restart", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId);

    const { action } = await openEscalation(companyId, pullOnlyAgentId, issueId);
    await resolveBoardRuling(action.id, "false_positive");

    // Restart = fresh instance with an empty in-memory sight counter. The
    // suppression must come from the persisted row, not that counter.
    const restarted = makeSweep();
    await restarted.reconcileUndispatchableAssignedIssues();
    const second = await restarted.reconcileUndispatchableAssignedIssues();
    expect(second.escalated).toBe(0);

    const rows = await recoveryActionRows(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("resolved");
    expect(rows[0].outcome).toBe("false_positive");
  });

  it("re-arms and re-mints when the card is re-assigned to a different pull-only agent", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentAId = await seedAgent(companyId, "process");
    const pullOnlyAgentBId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentAId);

    const { action } = await openEscalation(companyId, pullOnlyAgentAId, issueId);
    await resolveBoardRuling(action.id, "false_positive");

    // A different agent is a different claim: the ruling no longer applies.
    await db.update(issues).set({ assigneeAgentId: pullOnlyAgentBId }).where(eq(issues.id, issueId));

    const restarted = makeSweep();
    const first = await restarted.reconcileUndispatchableAssignedIssues();
    expect(first.escalated).toBe(0);
    const second = await restarted.reconcileUndispatchableAssignedIssues();
    expect(second.escalated).toBe(1);

    const rows = await recoveryActionRows(issueId);
    expect(rows).toHaveLength(2);
    const active = rows.find((r) => r.status === "active");
    expect(active?.kind).toBe("undispatchable_assignee");
    expect(active?.previousOwnerAgentId).toBe(pullOnlyAgentBId);
    expect(active?.evidence).toMatchObject({ assigneeAgentId: pullOnlyAgentBId });
  });

  it("a prior restored resolution does not suppress: the cleared condition keeps re-detecting", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId);

    const { action } = await openEscalation(companyId, pullOnlyAgentId, issueId);
    await resolveBoardRuling(action.id, "restored");

    // `restored` means the condition cleared — detection stays armed, so a new
    // confirmed cycle mints a fresh (distinct) action instead of staying quiet.
    const sweep = makeSweep();
    const first = await sweep.reconcileUndispatchableAssignedIssues();
    expect(first.escalated).toBe(0);
    const second = await sweep.reconcileUndispatchableAssignedIssues();
    expect(second.escalated).toBe(1);

    const active = (await recoveryActionRows(issueId)).find((r) => r.status === "active");
    expect(active).toBeTruthy();
    expect(active?.id).not.toBe(action.id);
  });

  it("the report-only detection row still emits under suppression (not a blind spot)", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId);

    const { action } = await openEscalation(companyId, pullOnlyAgentId, issueId);
    await resolveBoardRuling(action.id, "false_positive");

    // Wipe the durable detection record so a suppressed sweep must still emit a
    // fresh one: the report path runs even though the mint path is suppressed.
    await db.delete(activityLog).where(eq(activityLog.entityId, issueId));

    const next = await makeSweep().reconcileUndispatchableAssignedIssues();
    expect(next.reported).toBe(1);
    expect(next.issueIds).toEqual([issueId]);
    expect(next.escalated).toBe(0);

    const detections = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.undispatchable_assignee_detected"),
        ),
      );
    expect(detections).toHaveLength(1);
    expect(detections[0].details).toMatchObject({ assigneeAgentId: pullOnlyAgentId });
  });

  it("does not resolve the open action on a pull-only assignee's own run/wake (SUP-14992)", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId);

    const { action } = await openEscalation(companyId, pullOnlyAgentId, issueId);

    // A queued wakeup on the card that the faulty `new_source_execution_path`
    // predicate would treat as proof the card is dispatchable again. It is not:
    // the assignee is still a pull-only adapter and can never be woken.
    await seedQueuedWakeup(companyId, pullOnlyAgentId, issueId);

    const result = await makeSweep().reconcileActiveRecoveryActions();
    expect(result.resolved).toBe(0);

    const [row] = await recoveryActionRows(issueId);
    expect(row.id).toBe(action.id);
    expect(row.status).toBe("active");
    expect(row.outcome).toBeNull();
    expect(row.attemptCount).toBe(1);
  });

  it("still resolves the open action once the assignee leaves the pull-only set", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const dispatchableAgentId = await seedAgent(companyId, "codex_local");
    const issueId = await seedCard(companyId, pullOnlyAgentId);

    const { action } = await openEscalation(companyId, pullOnlyAgentId, issueId);
    await seedQueuedWakeup(companyId, pullOnlyAgentId, issueId);

    // Reassignment to a dispatchable agent is what actually clears the
    // condition; a run/wake on the card is now legitimate recovery evidence.
    await db
      .update(issues)
      .set({ assigneeAgentId: dispatchableAgentId })
      .where(eq(issues.id, issueId));

    const result = await makeSweep().reconcileActiveRecoveryActions();
    expect(result.resolved).toBe(1);

    const [row] = await recoveryActionRows(issueId);
    expect(row.id).toBe(action.id);
    expect(row.status).toBe("resolved");
    expect(row.outcome).toBe("restored");
    expect(row.resolutionNote).toBe("new_source_execution_path");
  });

  it("survives two mint->resolve sweep pairs as one stable action (flap regression)", async () => {
    const companyId = await seedCompany();
    const pullOnlyAgentId = await seedAgent(companyId, "process");
    const issueId = await seedCard(companyId, pullOnlyAgentId);

    const { sweep, action } = await openEscalation(companyId, pullOnlyAgentId, issueId);
    await seedQueuedWakeup(companyId, pullOnlyAgentId, issueId);

    // The production flap: each 30s tick the resolve sweep "restored" the
    // action on the pull-only assignee's own run/wake, so the next mint sweep
    // re-confirmed and minted a fresh action with a new attempt budget, until
    // the card walked to a false terminal board escalation. Reuse one sweep
    // instance so the in-memory confirmation counter stays past first-sight.
    for (let pair = 0; pair < 2; pair += 1) {
      const mint = await sweep.reconcileUndispatchableAssignedIssues();
      expect(mint.escalated).toBe(0);
      await sweep.reconcileActiveRecoveryActions();
    }

    const rows = await recoveryActionRows(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(action.id);
    expect(rows[0].status).toBe("active");
    expect(rows[0].attemptCount).toBe(1);
  });
});
