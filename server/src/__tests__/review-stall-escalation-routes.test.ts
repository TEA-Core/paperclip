import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueExecutionDecisions,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { REVIEW_STALL_ESCALATED_ACTION } from "../services/issue-execution-policy.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// R20 stall hand-off through the real routes, services and database: the
// once-per-stage guard under concurrency, the transaction that ties the
// hand-off to its decision, the recovery-resolve door, and the arbiter's
// availability at policy-set time and at hand-off time.

// Fault injection for the activity write: when `action` matches, the real
// logger writes the row and then the call throws, as a later failure in the
// same unit of work would. A row written inside the decision transaction rolls
// back with it; a row written outside it would survive as an orphan.
const activityFault = vi.hoisted(() => ({ action: null as string | null }));
vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  const failAfterWrite = (action: string) => {
    if (activityFault.action !== null && action === activityFault.action) {
      throw new Error("injected failure after the activity write");
    }
  };
  return {
    ...actual,
    logActivity: async (...args: Parameters<typeof actual.logActivity>) => {
      const result = await actual.logActivity(...args);
      failAfterWrite(args[1].action);
      return result;
    },
    logActivityInTransaction: async (...args: Parameters<typeof actual.logActivityInTransaction>) => {
      const result = await actual.logActivityInTransaction(...args);
      failAfterWrite(args[1].action);
      return result;
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review-stall escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const HEAD = "c0ffee".padEnd(40, "0");

describeEmbeddedPostgres("review stall escalation through the routes (R20)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const seededRunIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-stall-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    activityFault.action = null;
    if (seededRunIds.length > 0) {
      await db.update(heartbeatRuns).set({ status: "cancelled" }).where(inArray(heartbeatRuns.id, seededRunIds));
      seededRunIds.length = 0;
    }
    // Every test seeds its own company and asserts by issue id; the database is
    // discarded in afterAll, so only background runs need to settle here.
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let companyCount = 0;
  async function seedCompany() {
    const companyId = randomUUID();
    const prefix = `RST${String.fromCharCode(65 + companyCount++)}`;
    const ids = {
      companyId,
      reviewerId: randomUUID(),
      coderId: randomUUID(),
      arbiterId: randomUUID(),
      pausedId: randomUUID(),
      terminatedId: randomUUID(),
      userId: `user-${companyId.slice(0, 8)}`,
    };
    await db.insert(companies).values({ id: companyId, name: "Stall Co", issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    const agent = (id: string, name: string, status: string) => ({
      id, companyId, name, role: "engineer", status, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(agents).values([
      agent(ids.reviewerId, "Reviewer", "idle"),
      agent(ids.coderId, "Coder", "idle"),
      agent(ids.arbiterId, "Arbiter", "idle"),
      agent(ids.pausedId, "Paused", "paused"),
      agent(ids.terminatedId, "Gone", "terminated"),
    ]);
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: ids.userId, status: "active", membershipRole: "operator",
    });
    return ids;
  }

  type Seeded = Awaited<ReturnType<typeof seedCompany>>;

  function stallPolicy(seeded: Seeded, stageId: string, toAgentId: string = seeded.arbiterId) {
    return {
      mode: "normal",
      commentRequired: true,
      stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "agent", agentId: seeded.reviewerId }] }],
      stallEscalation: { afterRounds: 2, toAgentId },
    };
  }

  async function seedPendingReview(
    seeded: Seeded,
    stateOverrides: (stageId: string) => Record<string, unknown> = () => ({}),
  ) {
    const issueId = randomUUID();
    const stageId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: seeded.companyId,
      title: "Stalled review",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: seeded.reviewerId,
      responsibleUserId: seeded.userId,
      createdByUserId: seeded.userId,
      deliveryRequirement: "record_only",
      executionPolicy: stallPolicy(seeded, stageId),
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: seeded.reviewerId },
        returnAssignee: { type: "agent", agentId: seeded.coderId },
        deliveryAuthor: { type: "agent", agentId: seeded.coderId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        changesRequestedCount: 1,
        deliveredHeadSha: HEAD,
        bouncedHeadSha: HEAD,
        ...stateOverrides(stageId),
      },
    });
    return { issueId, stageId };
  }

  async function liveRun(seeded: Seeded, agentId: string, issueId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: seeded.companyId, agentId, status: "running", contextSnapshot: { issueId },
    });
    seededRunIds.push(runId);
    return runId;
  }

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as unknown as { actor: Record<string, unknown> }).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as never));
    testApp.use(errorHandler);
    return testApp;
  }

  const agentActor = (seeded: Seeded, agentId: string, runId: string) => ({
    type: "agent", agentId, companyId: seeded.companyId, source: "agent_key", runId,
  });
  const boardActor = (seeded: Seeded) => ({
    type: "board",
    source: "session",
    userId: seeded.userId,
    companyIds: [seeded.companyId],
    memberships: [{ companyId: seeded.companyId, status: "active", membershipRole: "operator" }],
    isInstanceAdmin: false,
  });

  async function stallRows(issueId: string) {
    return db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.filter((row) => row.action === REVIEW_STALL_ESCALATED_ACTION));
  }

  async function decisionRows(issueId: string) {
    return db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, issueId));
  }

  async function issueRow(issueId: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    return row!;
  }

  it("lets exactly one of several concurrent stall decisions hand the stage off", async () => {
    const seeded = await seedCompany();
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const { issueId } = await seedPendingReview(seeded);
      const runId = await liveRun(seeded, seeded.reviewerId, issueId);
      const reviewer = app(agentActor(seeded, seeded.reviewerId, runId));

      const responses = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(reviewer)
            .patch(`/api/issues/${issueId}`)
            .send({ status: "in_progress", comment: "Same finding on the same head.\nCode acceptable: yes" }),
        ),
      );

      const statuses = responses.map((res) => res.status).sort();
      expect(statuses.filter((status) => status === 200), JSON.stringify(responses.map((res) => res.body))).toHaveLength(1);
      expect(statuses.every((status) => status === 200 || status === 409 || status === 422)).toBe(true);
      expect(await stallRows(issueId)).toHaveLength(1);
      expect(await decisionRows(issueId)).toHaveLength(1);
      const row = await issueRow(issueId);
      expect(row.assigneeAgentId).toBe(seeded.arbiterId);
      expect(row.executionState).toMatchObject({ stallHandoff: { arbiterAgentId: seeded.arbiterId } });
    }
  }, 120_000);

  it("rolls the hand-off, its decision and its activity row back together when the unit of work fails", async () => {
    const seeded = await seedCompany();
    const { issueId } = await seedPendingReview(seeded);
    const runId = await liveRun(seeded, seeded.reviewerId, issueId);
    activityFault.action = REVIEW_STALL_ESCALATED_ACTION;

    const res = await request(app(agentActor(seeded, seeded.reviewerId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: "Same finding on the same head" });

    expect(res.status).toBe(500);
    expect(await stallRows(issueId)).toHaveLength(0);
    expect(await decisionRows(issueId)).toHaveLength(0);
    const row = await issueRow(issueId);
    expect(row.status).toBe("in_review");
    expect(row.assigneeAgentId).toBe(seeded.reviewerId);
    expect(row.executionState).not.toHaveProperty("stallHandoff");
  }, 60_000);

  async function resolveRecovery(seeded: Seeded, issueId: string, note: string) {
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId: seeded.companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: seeded.reviewerId,
      cause: "stranded_assigned_issue",
      fingerprint: `recovery:${issueId}`,
      nextAction: "Decide the pending review.",
    }).returning();
    const runId = await liveRun(seeded, seeded.reviewerId, issueId);
    return request(app(agentActor(seeded, seeded.reviewerId, runId)))
      .post(`/api/issues/${issueId}/recovery-actions/resolve`)
      // A restored resolution returning the card to work is the recovery door's
      // changes-requested decision on the pending review stage.
      .send({ actionId: action!.id, outcome: "restored", sourceIssueStatus: "todo", resolutionNote: note });
  }

  it("hands off through the recovery-resolve door with its activity row, and never twice per stage-run", async () => {
    const seeded = await seedCompany();

    const fresh = await seedPendingReview(seeded);
    const first = await resolveRecovery(seeded, fresh.issueId, "Same finding on the same head");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((await issueRow(fresh.issueId)).assigneeAgentId).toBe(seeded.arbiterId);
    const [handoffRow] = await stallRows(fresh.issueId);
    const [decision] = await decisionRows(fresh.issueId);
    expect(handoffRow?.details).toMatchObject({ decisionId: decision!.id, arbiterAgentId: seeded.arbiterId });

    // This stage-run was already handed to the arbiter once (rounds ago).
    const handedOff = await seedPendingReview(seeded, (stageId) => ({
      changesRequestedCount: 3,
      stallHandoff: {
        stageId,
        arbiterAgentId: seeded.arbiterId,
        fromParticipant: { type: "agent", agentId: seeded.reviewerId, userId: null },
        changesRequestedCount: 2,
        signals: ["same_head_rebounced"],
        handedOffAt: "2026-11-05T00:00:00.000Z",
      },
    }));

    const second = await resolveRecovery(seeded, handedOff.issueId, "Same head again.\nCode acceptable: yes");
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const row = await issueRow(handedOff.issueId);
    expect(row.status).toBe("in_progress");
    expect(row.assigneeAgentId).toBe(seeded.coderId);
    expect(await stallRows(handedOff.issueId)).toHaveLength(0);
  }, 90_000);

  it("refuses a paused or terminated arbiter when a policy write names it", async () => {
    const seeded = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId: seeded.companyId, title: "Policy target", status: "todo", priority: "medium",
      assigneeAgentId: seeded.coderId, responsibleUserId: seeded.userId, createdByUserId: seeded.userId,
      deliveryRequirement: "record_only",
    });
    const board = app(boardActor(seeded));

    for (const toAgentId of [seeded.pausedId, seeded.terminatedId]) {
      const res = await request(board)
        .patch(`/api/issues/${issueId}`)
        .send({ executionPolicy: stallPolicy(seeded, randomUUID(), toAgentId) });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect((await issueRow(issueId)).executionPolicy).toBeNull();
    }

    const valid = await request(board)
      .patch(`/api/issues/${issueId}`)
      .send({ executionPolicy: stallPolicy(seeded, randomUUID(), seeded.arbiterId.toUpperCase()) });
    expect(valid.status, JSON.stringify(valid.body)).toBe(200);
    expect((await issueRow(issueId)).executionPolicy).toMatchObject({
      stallEscalation: { afterRounds: 2, toAgentId: seeded.arbiterId.toLowerCase() },
    });
  }, 60_000);

  it.each(["paused", "terminated"])(
    "skips the hand-off when the arbiter became %s after the policy was set",
    async (status) => {
      const seeded = await seedCompany();
      const { issueId } = await seedPendingReview(seeded);
      await db.update(agents).set({ status }).where(eq(agents.id, seeded.arbiterId));
      const runId = await liveRun(seeded, seeded.reviewerId, issueId);

      const res = await request(app(agentActor(seeded, seeded.reviewerId, runId)))
        .patch(`/api/issues/${issueId}`)
        .send({ status: "in_progress", comment: "Same finding on the same head.\nCode acceptable: yes" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row = await issueRow(issueId);
      expect(row.status).toBe("in_progress");
      expect(row.assigneeAgentId).toBe(seeded.coderId);
      expect(await stallRows(issueId)).toHaveLength(0);
    },
    60_000,
  );
});
