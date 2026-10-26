import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog, agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueExecutionDecisions,
  issueRecoveryActions, issueThreadInteractions, issues, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe.sequential : describe.skip;
const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const ISSUE = "33333333-3333-4333-8333-333333333333";
const ASSIGNEE = "44444444-4444-4444-8444-444444444444";
const PARTICIPANT = "55555555-5555-4555-8555-555555555555";
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
    await db.delete(companies);
    await db.insert(companies).values([
      { id: COMPANY, name: "Restore Co", issuePrefix: "RES" },
      { id: OTHER_COMPANY, name: "Other Co", issuePrefix: "OTH" },
    ]);
    await db.insert(agents).values([
      { id: ASSIGNEE, companyId: COMPANY, name: "Current", status: "idle", adapterType: "codex_local" },
      { id: PARTICIPANT, companyId: COMPANY, name: "Reviewer", status: "idle", adapterType: "codex_local" },
    ]);
    await db.insert(issues).values({
      id: ISSUE, companyId: COMPANY, title: "Stranded review", status: "blocked",
      assigneeAgentId: ASSIGNEE, executionState: pendingState,
      executionPolicy: { mode: "normal", stages: [{ id: STAGE, type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: PARTICIPANT }] }] },
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
    expect({ ...after, assigneeAgentId: before.assigneeAgentId }).toEqual(before);
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

  it("409s on pending interaction", async () => {
    await db.insert(issueThreadInteractions).values({ companyId: COMPANY, issueId: ISSUE, kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Continue?" } });
    expect((await post()).status).toBe(409);
    expect((await snapshot()).assigneeAgentId).toBe(ASSIGNEE);
  });

  it.each(["queued", "running"])("409s on %s live run bound to the issue", async (status) => {
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

  it("refuses agent and out-of-company board actors without changes", async () => {
    actor = { type: "agent", source: "agent_key", companyId: COMPANY, agentId: ASSIGNEE } as Express.Request["actor"];
    expect((await post()).status).toBe(403);
    actor = { type: "board", source: "cloud_tenant", companyIds: [OTHER_COMPANY] } as Express.Request["actor"];
    expect((await post()).status).toBe(404);
    expect((await snapshot()).assigneeAgentId).toBe(ASSIGNEE);
    expect(await audit()).toHaveLength(0);
  });
});
