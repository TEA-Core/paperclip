import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog, agentSessionGoalActions, agentTaskSessions, agentWakeupRequests, agents, chatConversations, chatEndpoints, companies, companyMemberships, createDb, heartbeatRunEvents, heartbeatRuns,
  issueExecutionDecisions, issueRecoveryActions, issueThreadInteractions, issues, nativeRunFinalizations, toolApplications, toolConnections, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { claimNativeRestartRecoveries } from "../services/native-runtime/native-restart-recovery.js";
import { heartbeatService } from "../services/heartbeat.js";
import { selfDeclaredRunService } from "../services/self-declared-run.js";
import { recoveryService } from "../services/recovery/service.js";
import { collectDispositionRepairSourceState } from "../services/recovery/disposition-repair.js";

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
    await db.delete(heartbeatRunEvents);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRecoveryActions);
    await db.delete(chatConversations);
    await db.delete(chatEndpoints);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(nativeRunFinalizations);
    await db.delete(agentSessionGoalActions);
    await db.delete(agentTaskSessions);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
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

  // The BEFORE UPDATE trigger pauses *after* restore's final live-run read while
  // its transaction still holds the issue row. Only the disposable test DB has it.
  async function pauseRestoreAtAssignment() {
    await db.execute(sql`
      CREATE FUNCTION pause_participant_restore() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(2);
        RETURN NEW;
      END $$;
    `);
    await db.execute(sql`
      CREATE TRIGGER pause_participant_restore BEFORE UPDATE OF assignee_agent_id ON issues
      FOR EACH ROW WHEN (NEW.id = '33333333-3333-4333-8333-333333333333')
      EXECUTE FUNCTION pause_participant_restore()
    `);
  }

  async function waitForPausedRestore() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [row] = await db.execute<{ paused: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event = 'PgSleep' AND query ILIKE '%assignee_agent_id%'
        ) AS paused
      `);
      if (row?.paused) return;
      await delay(20);
    }
    throw new Error("Restore did not reach its post-read assignment pause");
  }

  async function unpauseRestore() {
    await db.execute(sql`DROP TRIGGER IF EXISTS pause_participant_restore ON issues`);
    await db.execute(sql`DROP FUNCTION IF EXISTS pause_participant_restore()`);
  }

  async function pauseNestedWakeReceipt() {
    await db.execute(sql`
      CREATE FUNCTION pause_nested_wake_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(2);
        RETURN NEW;
      END $$;
    `);
    await db.execute(sql`
      CREATE TRIGGER pause_nested_wake_receipt BEFORE INSERT ON agent_wakeup_requests
      FOR EACH ROW WHEN (NEW.reason = 'nested_lock_witness')
      EXECUTE FUNCTION pause_nested_wake_receipt()
    `);
  }

  async function waitForPausedWakeReceipt() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [row] = await db.execute<{ paused: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event = 'PgSleep' AND query ILIKE '%agent_wakeup_requests%'
        ) AS paused
      `);
      if (row?.paused) return;
      await delay(20);
    }
    throw new Error("Nested wake did not reach its paused receipt insert");
  }

  async function unpauseNestedWakeReceipt() {
    await db.execute(sql`DROP TRIGGER IF EXISTS pause_nested_wake_receipt ON agent_wakeup_requests`);
    await db.execute(sql`DROP FUNCTION IF EXISTS pause_nested_wake_receipt()`);
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

  it("409s without changes for a fixed conversation identity", async () => {
    await db.update(issues).set({ conversationAgentId: ASSIGNEE, conversationUserId: "human", conversationState: "active" })
      .where(eq(issues.id, ISSUE));
    const before = await snapshot();
    expect((await post()).status).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toHaveLength(0);
  });

  it.each(["active", "paused"])("refuses restoration while the prior assignee has a %s runner goal, without waking", async (status) => {
    await db.insert(agentTaskSessions).values({
      companyId: COMPANY, agentId: ASSIGNEE, adapterType: "codex_local", taskKey: ISSUE,
      goalJson: { objective: "Finish current work", status },
    });
    const before = await snapshot();
    const goalsBefore = await db.select().from(agentTaskSessions);
    expect((await post()).status).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect(await db.select().from(agentTaskSessions)).toEqual(goalsBefore);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await audit()).toHaveLength(0);
  });

  it("refuses a pending goal control even without an observed goal, without waking", async () => {
    const [session] = await db.insert(agentTaskSessions).values({
      companyId: COMPANY, agentId: ASSIGNEE, adapterType: "codex_local", taskKey: ISSUE,
    }).returning({ id: agentTaskSessions.id });
    await db.insert(agentSessionGoalActions).values({
      companyId: COMPANY, sessionId: session!.id, requestId: "prior-control",
      action: "create", payloadJson: { objective: "Queued control" }, status: "pending",
    });
    const before = await snapshot();
    expect((await post()).status).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect(await db.select().from(agentSessionGoalActions)).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await audit()).toHaveLength(0);
  });

  it("restores when the former assignee's goal has completed", async () => {
    await db.insert(agentTaskSessions).values({
      companyId: COMPANY, agentId: ASSIGNEE, adapterType: "codex_local", taskKey: ISSUE,
      goalJson: { objective: "Finished work", status: "complete" },
    });
    expect((await post()).status).toBe(200);
    expect((await snapshot()).assigneeAgentId).toBe(PARTICIPANT);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("409s without changes for an issue bound to an external chat channel", async () => {
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const endpointId = randomUUID();
    await db.insert(toolApplications).values({
      id: applicationId, companyId: COMPANY, applicationKey: `chat:slack:${endpointId}`, name: "Slack", type: "chat", status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId, companyId: COMPANY, applicationId, name: "Slack channel", uid: `chat-slack-${endpointId}`,
      connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true,
    });
    await db.insert(chatEndpoints).values({
      id: endpointId, companyId: COMPANY, connectionId, provider: "slack", publicId: randomUUID(), assignedAgentId: ASSIGNEE, status: "active",
      capabilities: {
        threads: true, directMessages: true, nativeStreaming: false, messageEdits: true, messageDeletes: false, reactions: true,
        files: true, cards: true, actions: true, modals: true, slashCommands: true, ephemeralMessages: true, proactiveDirectMessages: true,
      },
    });
    await db.insert(chatConversations).values({
      companyId: COMPANY, endpointId, issueId: ISSUE, externalConversationId: "conversation", externalThreadId: "thread",
      externalLabel: "thread", state: "active",
    });
    const before = await snapshot();
    const result = await post();
    expect(result.status).toBe(409);
    expect(result.body.details).toMatchObject({ code: "chat_binding_agent_locked" });
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
    "leaves an attributed %s approval on a preexisting self-owned review seat unchanged",
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
      actor = { type: "agent", source: "agent_jwt", agentId: PARTICIPANT, companyId: COMPANY, runId: RUN } as Express.Request["actor"];
      const decision = await request(app).patch(`/api/issues/${ISSUE}`)
        .set("X-Paperclip-Run-Id", RUN)
        .send({
          status: "done",
          comment: "Approved.\n\nkind: review\ndecision: approved\n\nClosed at Tier 2 (live): verified the isolated fixture.",
        });
      expect(decision.status, JSON.stringify(decision.body)).toBe(200);
      expect((await snapshot()).status).toBe("done");
      const decisions = await db.select().from(issueExecutionDecisions);
      expect(decisions).toHaveLength(2);
      expect(decisions.some((row) => row.outcome === "approved" && row.actorAgentId === PARTICIPANT)).toBe(true);
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

  it("serializes nested-only bounded retry against restore after its final live-run read", async () => {
    await seedRun("failed", { paperclipIssue: { id: ISSUE } });
    await db.update(heartbeatRuns).set({
      errorCode: "adapter_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      responsibleUserId: "operator",
    }).where(eq(heartbeatRuns.id, RUN));
    await pauseRestoreAtAssignment();
    let restoring: ReturnType<typeof post> | null = null;
    try {
      restoring = post();
      const response = Promise.resolve(restoring);
      await waitForPausedRestore();
      const retry = heartbeatService(db).scheduleBoundedRetry(RUN, { delayMs: 60_000, maxAttempts: 1 });
      const [result, restoration] = await Promise.all([retry, response]);
      const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, RUN));
      expect({ restoreStatus: restoration.status, retryOutcome: result.outcome, successorCount: successors.length })
        .toEqual({ restoreStatus: 200, retryOutcome: "not_scheduled", successorCount: 0 });
      expect((await snapshot()).assigneeAgentId).toBe(restoration.status === 200 ? PARTICIPANT : ASSIGNEE);
    } finally {
      if (restoring) await Promise.resolve(restoring);
      await unpauseRestore();
    }
  }, 30_000);

  it.each(["max_turns_continuation", "interaction_continuation_infra_retry"])(
    "serializes nested-only %s continuation retry against a completed restore",
    async (retryReason) => {
      await seedRun("failed", { paperclipIssue: { id: ISSUE } });
      await db.update(heartbeatRuns).set({
        responsibleUserId: "operator",
        errorCode: "adapter_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      }).where(eq(heartbeatRuns.id, RUN));
      await pauseRestoreAtAssignment();
      let restoring: ReturnType<typeof post> | null = null;
      try {
        restoring = post();
        const response = Promise.resolve(restoring);
        await waitForPausedRestore();
        const retry = heartbeatService(db).scheduleBoundedRetry(RUN, {
          retryReason, delayMs: 60_000, maxAttempts: 1,
        });
        const [result, restoration] = await Promise.all([retry, response]);
        const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, RUN));
        expect({ restoreStatus: restoration.status, retryOutcome: result.outcome, successorCount: successors.length })
          .toEqual({ restoreStatus: 200, retryOutcome: "not_scheduled", successorCount: 0 });
        expect(result).toMatchObject({ errorCode: "issue_reassigned", issueId: ISSUE });
        expect((await snapshot()).assigneeAgentId).toBe(PARTICIPANT);
      } finally {
        if (restoring) await Promise.resolve(restoring);
        await unpauseRestore();
      }
    },
    30_000,
  );

  it("does not coalesce an old owner's queued run into a newly restored stage after the final read", async () => {
    await seedRun("queued", { taskId: "same-scope" });
    await pauseRestoreAtAssignment();
    let restoring: ReturnType<typeof post> | null = null;
    try {
      restoring = post();
      const response = Promise.resolve(restoring);
      await waitForPausedRestore();
      const wakeup = heartbeatService(db).wakeup(ASSIGNEE, {
        source: "automation", triggerDetail: "system", reason: "queued_scope_refresh",
        contextSnapshot: { taskId: "same-scope", paperclipIssue: { id: ISSUE } },
      });
      const [wakeResult, restoration] = await Promise.all([wakeup, response]);
      const [queued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, RUN));
      expect(restoration.status).toBe(200);
      expect(queued.contextSnapshot).not.toHaveProperty("paperclipIssue.id", ISSUE);
      expect(wakeResult?.id).not.toBe(RUN);
      expect((await snapshot()).assigneeAgentId).toBe(PARTICIPANT);
    } finally {
      if (restoring) await Promise.resolve(restoring);
      await unpauseRestore();
    }
  }, 30_000);

  it("still coalesces a same-scope nested-only wake whose issue row does not exist", async () => {
    await seedRun("queued", { taskId: "same-scope" });
    const wakeResult = await heartbeatService(db).wakeup(ASSIGNEE, {
      source: "automation", triggerDetail: "system", reason: "queued_scope_refresh",
      contextSnapshot: { taskId: "same-scope", paperclipIssue: { id: randomUUID() } },
    });
    expect(wakeResult?.id).toBe(RUN);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
  }, 30_000);

  it("keeps the self-declared assignee/status gate ahead of its run insert after restore's final read", async () => {
    await db.update(agents).set({ runtimeConfig: { workDelivery: "external_pull" } }).where(eq(agents.id, ASSIGNEE));
    await seedRun("failed", { issueId: ISSUE });
    await db.update(heartbeatRuns).set({
      invocationSource: "self_declared",
      errorCode: "self_declared_run_expired",
      finishedAt: new Date(Date.now() - 16 * 60_000),
    }).where(eq(heartbeatRuns.id, RUN));
    await pauseRestoreAtAssignment();
    let restoring: ReturnType<typeof post> | null = null;
    try {
      restoring = post();
      const response = Promise.resolve(restoring);
      await waitForPausedRestore();
      const opening = selfDeclaredRunService(db).openSelfDeclaredRun(ISSUE, ASSIGNEE).then(
        () => "opened" as const,
        (error: unknown) => error,
      );
      const [result, restoration] = await Promise.all([opening, response]);
      expect(restoration.status).toBe(200);
      expect(result).toMatchObject({ status: 403 });
      expect((await snapshot()).assigneeAgentId).toBe(PARTICIPANT);
      expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    } finally {
      if (restoring) await Promise.resolve(restoring);
      await unpauseRestore();
    }
  }, 30_000);

  it("does not schedule the former owner's provider-quota run from a snapshot held across restore", async () => {
    await seedRun("failed", { issueId: ISSUE });
    await db.update(heartbeatRuns).set({
      errorCode: "provider_quota",
      resultJson: { errorFamily: "provider_quota", providerQuotaRetryNotBefore: new Date(Date.now() + 60_000).toISOString() },
    }).where(eq(heartbeatRuns.id, RUN));
    const sourceIssue = await snapshot();
    const [latestRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, RUN));
    await pauseRestoreAtAssignment();
    let restoring: ReturnType<typeof post> | null = null;
    try {
      restoring = post();
      const response = Promise.resolve(restoring);
      await waitForPausedRestore();
      const recovery = recoveryService(db, { enqueueWakeup: async () => null })
        .escalateStrandedAssignedIssue({
          issue: sourceIssue, latestRun, previousStatus: "in_progress", recoveryCause: "provider_quota",
        });
      const [result, restoration] = await Promise.all([recovery, response]);
      const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.scheduledRetryReason, "provider_quota_recovery"));
      expect(restoration.status).toBe(200);
      expect(result).toBeNull();
      expect(retries).toHaveLength(0);
      expect((await snapshot()).assigneeAgentId).toBe(PARTICIPANT);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.status, "active"))).toHaveLength(0);
    } finally {
      if (restoring) await Promise.resolve(restoring);
      await unpauseRestore();
    }
  }, 30_000);

  it("excludes delayed disposition repair while a pending stage is restored after its final read", async () => {
    await seedRun("failed", { issueId: ISSUE, retryReason: "issue_continuation_needed" });
    await pauseRestoreAtAssignment();
    let restoring: ReturnType<typeof post> | null = null;
    try {
      restoring = post();
      const response = Promise.resolve(restoring);
      await waitForPausedRestore();
      const waitingState = await collectDispositionRepairSourceState(db, { issue: await snapshot() });
      expect(waitingState).toMatchObject({
        hasActiveExecutionPath: false,
        hasDurableWaitingPath: true,
        durablePathReason: "execution_stage",
      });
      const sweep = recoveryService(db, { enqueueWakeup: async () => null }).reconcileStrandedAssignedIssues();
      const [, restoration] = await Promise.all([sweep, response]);
      expect(restoration.status).toBe(200);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.scheduledRetryReason, "issue_disposition_repair"))).toHaveLength(0);
      expect((await snapshot()).assigneeAgentId).toBe(PARTICIPANT);
    } finally {
      if (restoring) await Promise.resolve(restoring);
      await unpauseRestore();
    }
  }, 30_000);

  it("does not admit an old-owner nested-only wake after restore's final read", async () => {
    await seedRun("running");
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, ASSIGNEE));
    await pauseRestoreAtAssignment();
    let restoring: ReturnType<typeof post> | null = null;
    try {
      restoring = post();
      const response = Promise.resolve(restoring);
      await waitForPausedRestore();
      const waking = heartbeatService(db).wakeup(ASSIGNEE, {
        source: "automation", triggerDetail: "system", reason: "nested_scope_refresh",
        allowRunCoalescing: false,
        contextSnapshot: { taskId: randomUUID(), responsibleUserId: "operator", paperclipIssue: { id: ISSUE } },
      });
      const [run, restoration] = await Promise.all([waking, response]);
      expect(restoration.status).toBe(200);
      expect(run).toBeNull();
      expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
      expect((await snapshot()).assigneeAgentId).toBe(PARTICIPANT);
    } finally {
      if (restoring) await Promise.resolve(restoring);
      await unpauseRestore();
    }
  }, 30_000);

  it("holds the nested-only issue lock through the wake receipt and run insert", async () => {
    await seedRun("running");
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, ASSIGNEE));
    await pauseNestedWakeReceipt();
    let wakeFinished = false;
    const waking = heartbeatService(db).wakeup(ASSIGNEE, {
      source: "automation", triggerDetail: "system", reason: "nested_lock_witness",
      allowRunCoalescing: false,
      contextSnapshot: { taskId: randomUUID(), responsibleUserId: "operator", paperclipIssue: { id: ISSUE } },
    }).finally(() => { wakeFinished = true; });
    try {
      await waitForPausedWakeReceipt();
      const restoration = await post();
      expect(wakeFinished).toBe(false);
      const run = await waking;
      expect(restoration.status).toBe(409);
      expect(run?.status).toBe("queued");
      expect((await snapshot()).assigneeAgentId).toBe(ASSIGNEE);
      expect(await audit()).toHaveLength(0);
    } finally {
      await waking.catch(() => null);
      await unpauseNestedWakeReceipt();
    }
  }, 30_000);

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
    ["before the issue-lock wait", true],
    ["after the first run check but before the issue-lock write", false],
  ])("refuses a queued run inserted %s", async (_order, queueBeforeRestore) => {
    let signalLocked!: (pid: number) => void;
    let releaseIssue!: () => void;
    const locked = new Promise<number>((resolve) => { signalLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseIssue = resolve; });
    const blocker = db.transaction(async (tx) => {
      const [connection] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid()::int AS pid`);
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, ISSUE)).for("update");
      signalLocked(connection!.pid);
      await release;
    });
    const blockerPid = await locked;
    if (queueBeforeRestore) await seedRun("queued", { issueId: ISSUE });
    const restoring = Promise.resolve(post());
    let waitedForIssue = false;
    try {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const [row] = await db.execute<{ waiting: boolean }>(sql`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND ${blockerPid} = ANY(pg_blocking_pids(pid))
          ) AS waiting
        `);
        if (row?.waiting) { waitedForIssue = true; break; }
        await delay(25);
      }
      if (!queueBeforeRestore) await seedRun("queued", { issueId: ISSUE });
    } finally {
      releaseIssue();
      await blocker;
    }
    const response = await restoring;
    expect({ waitedForIssue, status: response.status }).toEqual({ waitedForIssue: true, status: 409 });
    expect((await snapshot()).assigneeAgentId).toBe(ASSIGNEE);
    expect(await audit()).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, RUN))).toMatchObject([{ status: "queued" }]);
  });

  it("returns a retryable 409 when the issue row stays locked past the repair lock timeout", async () => {
    let signalLocked!: () => void;
    let releaseIssue!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseIssue = resolve; });
    const blocker = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, ISSUE)).for("update");
      signalLocked();
      await release;
    });
    await locked;
    const restoring = Promise.resolve(post());
    let response: { status: number; body: { code?: string; details?: { code?: string; retryable?: boolean } }; headers: Record<string, string> } | null = null;
    try {
      response = await Promise.race([restoring, delay(1500).then(() => null)]);
    } finally {
      releaseIssue();
      await blocker;
      await restoring;
    }
    expect(response).toMatchObject({
      status: 409,
      headers: { "retry-after": "1" },
      body: { code: "participant_restore_lock_busy", details: { code: "participant_restore_lock_busy", retryable: true } },
    });
    expect((await snapshot()).assigneeAgentId).toBe(ASSIGNEE);
    expect(await audit()).toHaveLength(0);
  });

  it.each([
    ["native issue", { nativeIssueId: ISSUE }],
    ["nested context", { contextSnapshot: { paperclipIssue: { id: ISSUE } } }],
  ])("409s on live run with %s binding", async (_name, fields) => {
    await db.insert(heartbeatRuns).values({ id: RUN, companyId: COMPANY, agentId: ASSIGNEE, status: "running", ...fields });
    expect((await post()).status).toBe(409);
    expect((await snapshot()).assigneeAgentId).toBe(ASSIGNEE);
  });

  async function restoreWaitingOnRunRows() {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const [row] = await db.execute<{ waiting: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'active'
            AND wait_event_type = 'Lock'
            AND query ILIKE '%from "heartbeat_runs"%' AND query ILIKE '%for update%'
        ) AS waiting
      `);
      if (row?.waiting) return true;
      await delay(25);
    }
    return false;
  }

  it("waits for an in-flight writer of the issue's live run row, then re-evaluates the live-run predicate", async () => {
    await seedRun("running", { issueId: ISSUE });
    let signalLocked!: () => void;
    let releaseWriter!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const writer = db.transaction(async (tx) => {
      await tx.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, RUN));
      signalLocked();
      await release;
    });
    await locked;
    const restoring = Promise.resolve(post());
    let waitedForWriter = false;
    try {
      waitedForWriter = await restoreWaitingOnRunRows();
    } finally {
      releaseWriter();
      await writer;
    }
    const response = await restoring;
    expect({ waitedForWriter, status: response.status }).toEqual({ waitedForWriter: true, status: 200 });
    expect((await snapshot()).assigneeAgentId).toBe(PARTICIPANT);
    expect(await audit()).toHaveLength(1);
  });

  it("does not deadlock with a finalizer that holds the run row and then upserts a recovery action", async () => {
    await seedRun("running", { issueId: ISSUE });
    let signalLocked!: () => void;
    let proceed!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const gate = new Promise<void>((resolve) => { proceed = resolve; });
    const finalizer = db.transaction(async (tx) => {
      await tx.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, RUN));
      signalLocked();
      await gate;
      await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({
        companyId: COMPANY, sourceIssueId: ISSUE, kind: "review_stage_unarmed",
        cause: "pending_stage_stranded", fingerprint: `pending-stage:${ISSUE}`,
        nextAction: "Board review",
      });
    });
    await locked;
    const restoring = Promise.resolve(post());
    let waitedForRunRow = false;
    try {
      waitedForRunRow = await restoreWaitingOnRunRows();
    } finally {
      proceed();
    }
    await finalizer;
    const response = await restoring;
    expect({ waitedForRunRow, status: response.status }).toEqual({ waitedForRunRow: true, status: 409 });
    expect((await snapshot()).assigneeAgentId).toBe(ASSIGNEE);
    expect(await audit()).toHaveLength(0);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(1);
  });

  it.each(["restore-first", "recovery-first"] as const)(
    "bounds the %s restore/recovery lock order on a two-connection pool",
    async (order) => {
      await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } })
        .where(eq(agents.id, ASSIGNEE));
      await db.insert(heartbeatRuns).values({
        id: RUN, companyId: COMPANY, agentId: ASSIGNEE, status: "running",
        runtimeMode: "native", nativeIssueId: ISSUE, contextSnapshot: { issueId: ISSUE },
      });
      await db.insert(nativeRunFinalizations).values({
        runId: RUN, companyId: COMPANY, issueId: ISSUE, phase: "observed",
      });
      const raceDb = createDb(tempDb!.connectionString, { maxConnections: 2 });
      const raceApp = express();
      raceApp.use(express.json());
      raceApp.use((req, _res, next) => { req.actor = actor; next(); });
      raceApp.use("/api", issueRoutes(raceDb, {} as Parameters<typeof issueRoutes>[1], {} as Parameters<typeof issueRoutes>[2]));
      raceApp.use(errorHandler);
      const blockedRow = order === "restore-first" ? issues : heartbeatRuns;
      let signalLocked!: (pid: number) => void;
      let releaseBlocker!: () => void;
      const locked = new Promise<number>((resolve) => { signalLocked = resolve; });
      const release = new Promise<void>((resolve) => { releaseBlocker = resolve; });
      const blocker = db.transaction(async (tx) => {
        const [connection] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid()::int as pid`);
        if (blockedRow === issues) {
          await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, ISSUE)).for("update");
        } else {
          await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, RUN)).for("update");
        }
        signalLocked(connection!.pid);
        await release;
      });
      const blockerPid = await locked;
      const restore = () => request(raceApp).post(`/api/issues/${ISSUE}/restore-participant`).send(body());
      const recover = () => claimNativeRestartRecoveries({
        db: raceDb, controller: { bootId: randomUUID(), pid: process.pid, processStartedAt: new Date() },
        restartKind: "hard", runIds: [RUN],
      });
      async function blockedCount() {
        const [row] = await db.execute<{ count: number }>(sql`
          select count(*)::int as count from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()
            and ${blockerPid} = any(pg_blocking_pids(pid))
        `);
        return row?.count ?? 0;
      }
      async function waitForBlocked(count: number) {
        for (let poll = 0; poll < 80; poll += 1) {
          if (await blockedCount() >= count) return true;
          await delay(10);
        }
        return false;
      }
      let restoring: Promise<{ status: number }> | null = null;
      let recovering: ReturnType<typeof recover> | null = null;
      let firstBlocked = false;
      // The second contender may reach its lock only after the 250ms restore timeout.
      try {
        if (order === "restore-first") {
          restoring = Promise.resolve(restore());
          firstBlocked = await waitForBlocked(1);
          recovering = recover();
        } else {
          recovering = recover();
          firstBlocked = await waitForBlocked(1);
          restoring = Promise.resolve(restore());
        }
        await delay(30);
      } finally {
        releaseBlocker();
        await blocker;
      }
      try {
        const completed = await Promise.race([
          Promise.allSettled([restoring!, recovering!]),
          delay(5_000).then(() => null),
        ]);
        expect(completed).not.toBeNull();
        expect(firstBlocked).toBe(true);
        expect(completed?.[0]).toMatchObject({ status: "fulfilled", value: { status: 409 } });
        expect(completed?.[1]).toMatchObject({ status: "fulfilled" });
        expect((await snapshot()).assigneeAgentId).toBe(ASSIGNEE);
        expect(await audit()).toHaveLength(0);
      } finally {
        await raceDb.$client.end({ timeout: 1 });
      }
    },
    20_000,
  );

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
