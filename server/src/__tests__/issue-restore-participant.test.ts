import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog, agentWakeupRequests, agents, companies, companyMemberships, createDb, heartbeatRuns, issueExecutionDecisions,
  issueRecoveryActions, issueThreadInteractions, issues, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe.sequential : describe.skip;
const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const ISSUE = "33333333-3333-4333-8333-333333333333";
const ASSIGNEE = "44444444-4444-4444-8444-444444444444";
const PARTICIPANT = "55555555-5555-4555-8555-555555555555";
const INDEPENDENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STAGE = "66666666-6666-4666-8666-666666666666";
const RUN = "77777777-7777-4777-8777-777777777777";
const DECISION = "88888888-8888-4888-8888-888888888888";

const pendingState = {
  status: "pending", currentStageId: STAGE, currentStageIndex: 0, currentStageType: "review",
  currentParticipant: { type: "agent", agentId: PARTICIPANT, userId: null },
  pendingSince: "2026-10-25T04:57:54.443Z", completedStageIds: [], skippedStageIds: [],
  lastDecisionId: DECISION, lastDecisionOutcome: "changes_requested", changesRequestedCount: 1,
  returnAssignee: { type: "agent", agentId: ASSIGNEE, userId: null },
};
// Real isolated PostgreSQL: row locks, status_version trigger, audit and concurrency must be exercised together.
describeDb("POST /api/issues/:id/restore-participant", () => {
  let db: Db;
  let app: express.Express;
  let actor: Express.Request["actor"];
  let tempDb: EmbeddedPostgresTestDatabase | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restore-participant-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1], {} as Parameters<typeof issueRoutes>[2]));
    app.use(errorHandler);
  }, 60_000);

  afterAll(async () => { await tempDb?.cleanup(); });

  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.insert(companies).values([
      { id: COMPANY, name: "Restore Co", issuePrefix: "RES" },
      { id: OTHER_COMPANY, name: "Other Co", issuePrefix: "OTH" },
    ]);
    await db.insert(agents).values([
      { id: ASSIGNEE, companyId: COMPANY, name: "Current", status: "idle", adapterType: "codex_local" },
      { id: PARTICIPANT, companyId: COMPANY, name: "Reviewer", status: "idle", adapterType: "codex_local" },
      { id: INDEPENDENT, companyId: COMPANY, name: "Independent reviewer", status: "idle", adapterType: "codex_local" },
    ]);
    await db.insert(companyMemberships).values([
      { companyId: COMPANY, principalType: "agent", principalId: ASSIGNEE, status: "active", membershipRole: "member" },
      { companyId: COMPANY, principalType: "agent", principalId: PARTICIPANT, status: "active", membershipRole: "member" },
      { companyId: COMPANY, principalType: "agent", principalId: INDEPENDENT, status: "active", membershipRole: "member" },
    ]);
    await db.insert(issues).values({
      id: ISSUE, companyId: COMPANY, title: "Stranded review", status: "blocked",
      assigneeAgentId: ASSIGNEE, executionState: pendingState,
      executionPolicy: { mode: "normal", stages: [{ id: STAGE, type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: PARTICIPANT }, { type: "agent", agentId: INDEPENDENT }] }] },
    });
    await db.insert(issueExecutionDecisions).values({
      id: DECISION, companyId: COMPANY, issueId: ISSUE, stageId: STAGE,
      stageType: "review", outcome: "changes_requested", body: "Earlier verdict",
    });
    actor = { type: "board", source: "local_implicit", companyIds: [COMPANY] } as Express.Request["actor"];
  });

  const body = () => ({
    expectedAssigneeAgentId: ASSIGNEE,
    expectedStatus: "blocked",
    expectedStatusVersion: 0,
    expectedPendingParticipantAgentId: PARTICIPANT,
  });
  const post = (input: Record<string, unknown> = body()) => request(app).post(`/api/issues/${ISSUE}/restore-participant`).send(input);
  async function snapshot() {
    const [issue] = await db.select().from(issues).where(eq(issues.id, ISSUE));
    return issue;
  }
  async function audit() {
    return db.select().from(activityLog).where(eq(activityLog.entityId, ISSUE));
  }

  it("restores only the assignee, preserving status/version and execution state and decisions; records one before/after audit without waking", async () => {
    const before = await snapshot();
    const decisionsBefore = await db.select().from(issueExecutionDecisions);
    const result = await post();
    expect(result.status).toBe(200);
    const after = await snapshot();
    expect(after.assigneeAgentId).toBe(PARTICIPANT);
    expect({ ...after, assigneeAgentId: before.assigneeAgentId, updatedAt: before.updatedAt }).toEqual(before);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(after.executionState).toEqual(pendingState);
    expect(after.statusVersion).toBe(before.statusVersion); // DB bumps only on status transitions.
    expect(await db.select().from(issueExecutionDecisions)).toEqual(decisionsBefore);
    const events = await audit();
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({ before: { assigneeAgentId: ASSIGNEE }, after: { assigneeAgentId: PARTICIPANT } });
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("restores an unassigned blocked card without changing its stage", async () => {
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, ISSUE));
    const before = await snapshot();
    expect((await post({ ...body(), expectedAssigneeAgentId: null })).status).toBe(200);
    const after = await snapshot();
    expect(after.assigneeAgentId).toBe(PARTICIPANT);
    expect(after.executionState).toEqual(before.executionState);
    expect(after.status).toBe("blocked");
    expect(after.statusVersion).toBe(before.statusVersion);
  });

  it("restores an approval-stage participant without making a decision", async () => {
    await db.update(issues).set({
      executionState: { ...pendingState, currentStageType: "approval" },
      executionPolicy: { mode: "normal", stages: [{ id: STAGE, type: "approval", approvalsNeeded: 1, participants: [{ type: "agent", agentId: PARTICIPANT }] }] },
    }).where(eq(issues.id, ISSUE));
    const before = await snapshot();
    const decisions = await db.select().from(issueExecutionDecisions);
    expect((await post()).status).toBe(200);
    const after = await snapshot();
    expect(after.executionState).toEqual(before.executionState);
    expect(after.status).toBe(before.status);
    expect(await db.select().from(issueExecutionDecisions)).toEqual(decisions);
  });

  it("keeps a sole independent reviewer from becoming a self-satisfying assignee", async () => {
    await db.update(issues).set({
      executionPolicy: { mode: "normal", stages: [{ id: STAGE, type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: PARTICIPANT }] }] },
    }).where(eq(issues.id, ISSUE));
    const before = await snapshot();
    const ordinary = await request(app).patch(`/api/issues/${ISSUE}`).send({ assigneeAgentId: PARTICIPANT });
    expect(ordinary.status, JSON.stringify(ordinary.body)).toBe(422);
    expect((await post()).status).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toHaveLength(0);
  });

  it("lets an independent restored participant decide later without a wake from restoration", async () => {
    await db.update(issues).set({ status: "in_review", deliveryRequirement: "record_only" })
      .where(eq(issues.id, ISSUE));
    const before = await snapshot();
    const decisionsBefore = await db.select().from(issueExecutionDecisions);
    const restored = await post({ ...body(), expectedStatus: before.status, expectedStatusVersion: before.statusVersion });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect((await snapshot()).executionState).toEqual(before.executionState);
    expect(await db.select().from(issueExecutionDecisions)).toEqual(decisionsBefore);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);

    await db.insert(heartbeatRuns).values({
      id: RUN, companyId: COMPANY, agentId: PARTICIPANT, status: "running",
      contextSnapshot: { issueId: ISSUE },
    });
    actor = { type: "agent", source: "agent_jwt", agentId: PARTICIPANT, companyId: COMPANY, runId: RUN } as Express.Request["actor"];
    const approved = await request(app).patch(`/api/issues/${ISSUE}`)
      .set("X-Paperclip-Run-Id", RUN)
      .send({
        status: "done",
        comment: "Approved.\n\nkind: review\ndecision: approved\n\nClosed at Tier 2 (live): verified the isolated fixture.",
      });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await snapshot()).status).toBe("done");
    const decisionsAfter = await db.select().from(issueExecutionDecisions);
    expect(decisionsAfter).toHaveLength(2);
    expect(decisionsAfter.some((row) => row.outcome === "approved" && row.actorAgentId === PARTICIPANT)).toBe(true);
  });

  it.each(["creator", "return assignee", "delivery author"])(
    "does not grant a %s the review seat to approve its own work",
    async (origin) => {
      const reviewer = { type: "agent", agentId: PARTICIPANT, userId: null };
      await db.update(issues).set({
        status: "in_review",
        createdByAgentId: origin === "creator" ? PARTICIPANT : null,
        executionState: {
          ...pendingState,
          lastDecisionId: null,
          lastDecisionOutcome: null,
          returnAssignee: origin === "return assignee" ? reviewer : pendingState.returnAssignee,
          deliveryAuthor: origin === "delivery author" ? reviewer : null,
        },
        executionPolicy: { mode: "normal", stages: [{ id: STAGE, type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: PARTICIPANT }] }] },
      }).where(eq(issues.id, ISSUE));
      const before = await snapshot();
      const ordinary = await request(app).patch(`/api/issues/${ISSUE}`).send({ assigneeAgentId: PARTICIPANT });
      expect(ordinary.status, JSON.stringify(ordinary.body)).toBe(422);

      const restore = await post({ ...body(), expectedStatus: before.status, expectedStatusVersion: before.statusVersion });
      expect(restore.status, JSON.stringify(restore.body)).toBe(409);
      expect(await snapshot()).toEqual(before);
      expect(await audit()).toHaveLength(0);
      expect(await db.select().from(issueExecutionDecisions)).toHaveLength(1);
    },
  );

  it.each(["creator", "return assignee", "delivery author"])(
    "rejects an attributed %s approval on a preexisting self-owned review seat",
    async (origin) => {
      const reviewer = { type: "agent", agentId: PARTICIPANT, userId: null };
      await db.update(issues).set({
        status: "in_review",
        assigneeAgentId: PARTICIPANT,
        createdByAgentId: origin === "creator" ? PARTICIPANT : null,
        deliveryRequirement: "record_only",
        executionState: {
          ...pendingState,
          lastDecisionId: null,
          lastDecisionOutcome: null,
          returnAssignee: origin === "return assignee" ? reviewer : pendingState.returnAssignee,
          deliveryAuthor: origin === "delivery author" ? reviewer : null,
        },
      }).where(eq(issues.id, ISSUE));
      await db.insert(heartbeatRuns).values({
        id: RUN, companyId: COMPANY, agentId: PARTICIPANT, status: "running",
        contextSnapshot: { issueId: ISSUE },
      });
      const before = await snapshot();
      actor = { type: "agent", source: "agent_jwt", agentId: PARTICIPANT, companyId: COMPANY, runId: RUN } as Express.Request["actor"];
      const decision = await request(app).patch(`/api/issues/${ISSUE}`)
        .set("X-Paperclip-Run-Id", RUN)
        .send({
          status: "done",
          comment: "Approved.\n\nkind: review\ndecision: approved\n\nClosed at Tier 2 (live): verified the isolated fixture.",
        });
      expect(decision.status, JSON.stringify(decision.body)).toBe(422);
      expect(await snapshot()).toEqual(before);
      expect(await db.select().from(issueExecutionDecisions)).toHaveLength(1);
    },
  );

  it.each([
    ["assignee", { expectedAssigneeAgentId: null }],
    ["status", { expectedStatus: "in_review" }],
    ["status version", { expectedStatusVersion: 1 }],
    ["participant", { expectedPendingParticipantAgentId: ASSIGNEE }],
  ])("409s on stale %s", async (_name, patch) => {
    const before = await snapshot();
    expect((await post({ ...body(), ...patch })).status).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toHaveLength(0);
  });

  it.each(["todo", "in_progress", "backlog"])("409s on a %s card carrying a pending review pointer", async (status) => {
    await db.update(issues).set({ status }).where(eq(issues.id, ISSUE));
    const before = await snapshot();
    expect((await post({ ...body(), expectedStatus: status, expectedStatusVersion: before.statusVersion })).status).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toHaveLength(0);
  });

  it.each([
    ["wrong stage id", { currentStageId: RUN }],
    ["wrong stage index", { currentStageIndex: 1 }],
    ["completed stage", { completedStageIds: [STAGE] }],
    ["skipped stage", { skippedStageIds: [STAGE] }],
  ])("409s on %s even with a matching restoration snapshot", async (_name, patch) => {
    await db.update(issues).set({ executionState: { ...pendingState, ...patch } }).where(eq(issues.id, ISSUE));
    const before = await snapshot();
    expect((await post()).status).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toHaveLength(0);
  });

  it("409s when the stored participant is absent from its original policy stage", async () => {
    await db.update(issues).set({
      executionPolicy: { mode: "normal", stages: [{ id: STAGE, type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: INDEPENDENT }] }] },
    }).where(eq(issues.id, ISSUE));
    const before = await snapshot();
    expect((await post()).status).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toHaveLength(0);
  });

  it("409s when the stage already has an approved decision", async () => {
    await db.insert(issueExecutionDecisions).values({
      companyId: COMPANY, issueId: ISSUE, stageId: STAGE, stageType: "review",
      outcome: "approved", body: "Already approved",
    });
    const before = await snapshot();
    const decisions = await db.select().from(issueExecutionDecisions);
    expect((await post()).status).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect(await db.select().from(issueExecutionDecisions)).toEqual(decisions);
    expect(await audit()).toHaveLength(0);
  });

  it("409s when the pending agent has a removed company membership", async () => {
    await db.update(companyMemberships).set({ status: "removed" })
      .where(eq(companyMemberships.principalId, PARTICIPANT));
    const before = await snapshot();
    expect((await post()).status).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toHaveLength(0);
  });

  it.each([
    ["non-pending", { executionState: { ...pendingState, status: "changes_requested" } }],
    ["no stage", { executionState: { ...pendingState, currentStageId: null } }],
    ["non-review stage", { executionState: { ...pendingState, currentStageType: "execution" } }],
    ["human participant", { executionState: { ...pendingState, currentParticipant: { type: "user", userId: "human" } } }],
    ["already assigned", { assigneeAgentId: PARTICIPANT }],
    ["human assignee", { assigneeUserId: "human" }],
    ["terminal card", { status: "done" }],
    ["checkout pointer", { checkoutRunId: RUN }],
    ["execution pointer", { executionRunId: RUN }],
    ["execution lock", { executionLockedAt: new Date() }],
    ["execution name lock", { executionAgentNameKey: "reviewer" }],
  ])("409s for %s", async (_name, patch) => {
    if ("checkoutRunId" in patch || "executionRunId" in patch) await seedRun("completed");
    await db.update(issues).set(patch).where(eq(issues.id, ISSUE));
    const before = await snapshot();
    expect((await post({ ...body(), expectedStatus: before.status, expectedAssigneeAgentId: before.assigneeAgentId, expectedStatusVersion: before.statusVersion })).status).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toHaveLength(0);
  });

  async function seedRun(status: string, contextSnapshot: Record<string, unknown> = {}) {
    await db.insert(heartbeatRuns).values({ id: RUN, companyId: COMPANY, agentId: ASSIGNEE, status, contextSnapshot });
  }

  it.each(["active", "escalated"])("409s on %s recovery action", async (status) => {
    await db.insert(issueRecoveryActions).values({
      companyId: COMPANY, sourceIssueId: ISSUE, status, kind: "review_stage_unarmed",
      cause: "test", fingerprint: "test", nextAction: "review",
    });
    expect((await post()).status).toBe(409);
    expect((await snapshot()).assigneeAgentId).toBe(ASSIGNEE);
  });

  it("returns 409 when a recovery action acquires the issue lock before restoration", async () => {
    // This package's TypeScript lib predates Promise.withResolvers.
    let signalLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const blocker = db.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE issue_recovery_actions IN SHARE MODE`);
      signalLocked();
      await release;
    });
    await locked;

    const write = issueRecoveryActionService(db).upsertSourceScoped({
      companyId: COMPANY, sourceIssueId: ISSUE, kind: "review_stage_unarmed",
      cause: "pending_stage_stranded", fingerprint: `pending-stage:${ISSUE}`,
      nextAction: "Board review",
    });
    let restore: Promise<{ status: number }> | null = null;
    let responseStatus: number | undefined;
    let blockedWrite = false;
    let blockedRestore = false;
    async function waitingFor(fragment: string, statement: string) {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const [row] = await db.execute<{ waiting: boolean }>(sql`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND state = 'active'
              AND wait_event_type = 'Lock'
              AND query ILIKE ${`%${fragment}%`}
              AND query ILIKE ${`%${statement}%`}
          ) AS waiting
        `);
        if (row?.waiting) return true;
        // PostgreSQL lock waits occur outside the JS clock; fake timers cannot advance them.
        await delay(25);
      }
      return false;
    }
    try {
      blockedWrite = await waitingFor("issue_recovery_actions", "insert");
      restore = Promise.resolve(post());
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const [row] = await db.execute<{ count: number }>(sql`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'
        `);
        // The writer waits on the recovery table; a second waiter is the restore request on the issue row.
        if ((row?.count ?? 0) >= 2) { blockedRestore = true; break; }
        await delay(25);
      }
    } finally {
      releaseLock();
      await blocker;
      const [, response] = await Promise.all([write, restore]);
      responseStatus = response?.status;
    }

    expect({ blockedWrite, blockedRestore, responseStatus }).toEqual({
      blockedWrite: true, blockedRestore: true, responseStatus: 409,
    });
    expect((await snapshot()).assigneeAgentId).toBe(ASSIGNEE);
    expect(await audit()).toHaveLength(0);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(1);
  });

  it("409s on pending interaction", async () => {
    await db.insert(issueThreadInteractions).values({ companyId: COMPANY, issueId: ISSUE, kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Continue?" } });
    expect((await post()).status).toBe(409);
    expect((await snapshot()).assigneeAgentId).toBe(ASSIGNEE);
  });

  it.each(["queued", "running", "scheduled_retry"])("409s on %s live run bound to the issue", async (status) => {
    await seedRun(status, { issueId: ISSUE });
    expect((await post()).status).toBe(409);
    expect((await snapshot()).assigneeAgentId).toBe(ASSIGNEE);
  });

  it.each([
    ["native issue", { nativeIssueId: ISSUE }],
    ["nested context", { contextSnapshot: { paperclipIssue: { id: ISSUE } } }],
  ])("409s on live run with %s binding", async (_name, fields) => {
    await db.insert(heartbeatRuns).values({ id: RUN, companyId: COMPANY, agentId: ASSIGNEE, status: "running", ...fields });
    expect((await post()).status).toBe(409);
    expect((await snapshot()).assigneeAgentId).toBe(ASSIGNEE);
  });

  it("waits for an in-flight issue-bound run writer before testing the live-run predicate", async () => {
    let signalInserted!: () => void;
    let releaseWriter!: () => void;
    const inserted = new Promise<void>((resolve) => { signalInserted = resolve; });
    const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const writer = db.transaction(async (tx) => {
      await tx.insert(heartbeatRuns).values({
        id: RUN, companyId: COMPANY, agentId: ASSIGNEE, status: "running",
        contextSnapshot: { issueId: ISSUE },
      });
      signalInserted();
      await release;
    });
    await inserted;
    const restoring = Promise.resolve(post());
    let waitedForWriter = false;
    try {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const [row] = await db.execute<{ waiting: boolean }>(sql`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND state = 'active'
              AND wait_event_type = 'Lock'
              AND query ILIKE '%LOCK TABLE heartbeat_runs IN SHARE MODE%'
          ) AS waiting
        `);
        if (row?.waiting) { waitedForWriter = true; break; }
        await delay(25);
      }
    } finally {
      releaseWriter();
      await writer;
    }
    const response = await restoring;
    expect({ waitedForWriter, status: response.status }).toEqual({ waitedForWriter: true, status: 409 });
    expect((await snapshot()).assigneeAgentId).toBe(ASSIGNEE);
    expect(await audit()).toHaveLength(0);
  });

  it.each(["paused", "terminated", "pending_approval"])("409s on %s participant", async (status) => {
    await db.update(agents).set({ status }).where(eq(agents.id, PARTICIPANT));
    expect((await post()).status).toBe(409);
  });

  it("409s if the participant does not exist in the issue's company", async () => {
    const other = "99999999-9999-4999-8999-999999999999";
    await db.insert(agents).values({ id: other, companyId: OTHER_COMPANY, name: "Other", status: "idle" });
    await db.update(issues).set({ executionState: { ...pendingState, currentParticipant: { type: "agent", agentId: other } } }).where(eq(issues.id, ISSUE));
    expect((await post({ ...body(), expectedPendingParticipantAgentId: other })).status).toBe(409);
  });

  it("serializes concurrent requests: exactly one wins and one audit row commits", async () => {
    const results = await Promise.all([post(), post()]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect((await snapshot()).assigneeAgentId).toBe(PARTICIPANT);
    expect(await audit()).toHaveLength(1);
  });

  it("refuses invalid and incomplete compare-and-set bodies", async () => {
    expect((await post({ ...body(), expectedStatusVersion: -1 })).status).toBe(400);
    expect((await post({ expectedStatus: "blocked" })).status).toBe(400);
    expect((await snapshot()).assigneeAgentId).toBe(ASSIGNEE);
  });

  it("refuses a non-viewer board member without assignment permission for a private participant", async () => {
    const userId = "operator-without-assignment-grant";
    await db.update(agents).set({
      permissions: {
        authorizationPolicy: {
          agentVisibility: { mode: "private", hiddenFromDefaultDirectory: true },
          assignmentPolicy: { mode: "company_default" },
          protectedAgent: { requiresApproval: false },
          managedBy: "permissions-extension",
        },
      },
    }).where(eq(agents.id, PARTICIPANT));
    await db.insert(companyMemberships).values({
      companyId: COMPANY, principalType: "user", principalId: userId,
      status: "active", membershipRole: "operator",
    });
    actor = {
      type: "board", source: "cloud_tenant", userId, companyIds: [COMPANY],
      memberships: [{ companyId: COMPANY, status: "active", membershipRole: "operator" }],
    } as Express.Request["actor"];
    expect((await post()).status).toBe(403);
    expect((await snapshot()).assigneeAgentId).toBe(ASSIGNEE);
    expect(await audit()).toHaveLength(0);
  });

  it("refuses agent and out-of-company board actors without changes", async () => {
    actor = { type: "agent", source: "agent_key", companyId: COMPANY, agentId: ASSIGNEE } as Express.Request["actor"];
    expect((await post()).status).toBe(403);
    actor = { type: "board", source: "cloud_tenant", companyIds: [OTHER_COMPANY] } as Express.Request["actor"];
    expect((await post()).status).toBe(404);
    expect((await snapshot()).assigneeAgentId).toBe(ASSIGNEE);
    expect(await audit()).toHaveLength(0);
  });
});
