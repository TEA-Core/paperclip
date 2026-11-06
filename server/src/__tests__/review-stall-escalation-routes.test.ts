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
  issueComments,
  issueExecutionDecisions,
  issueRecoveryActions,
  issues,
  projects,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { REVIEW_STALL_ESCALATED_ACTION } from "../services/issue-execution-policy.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { routineService } from "../services/routines.js";
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
// Deterministic interleaving: `beforeLock` runs once, on the request's first
// row-lock read, after the route computed its decision from the unlocked read
// and before the locked re-check reads the row.
// `afterResolve` runs once, right after an interaction accept or reject commits
// and before the route writes the escalation stage decision.
const lockInterleave = vi.hoisted(() => ({
  beforeLock: null as null | (() => Promise<void>),
  afterResolve: null as null | (() => Promise<void>),
}));
vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  const failAfterWrite = (action: string) => {
    if (activityFault.action !== null && action === activityFault.action) {
      throw new Error("injected failure after the activity write");
    }
  };
  return {
    ...actual,
    issueService: (...args: Parameters<typeof actual.issueService>) => {
      const svc = actual.issueService(...args);
      return {
        ...svc,
        getByIdForUpdate: async (...lockArgs: Parameters<typeof svc.getByIdForUpdate>) => {
          const hook = lockInterleave.beforeLock;
          lockInterleave.beforeLock = null;
          if (hook) await hook();
          return svc.getByIdForUpdate(...lockArgs);
        },
      };
    },
    issueThreadInteractionService: (...args: Parameters<typeof actual.issueThreadInteractionService>) => {
      const svc = actual.issueThreadInteractionService(...args);
      const afterResolve = async <T,>(result: T): Promise<T> => {
        const hook = lockInterleave.afterResolve;
        lockInterleave.afterResolve = null;
        if (hook) await hook();
        return result;
      };
      return {
        ...svc,
        acceptInteraction: async (...resolveArgs: Parameters<typeof svc.acceptInteraction>) =>
          afterResolve(await svc.acceptInteraction(...resolveArgs)),
        rejectInteraction: async (...resolveArgs: Parameters<typeof svc.rejectInteraction>) =>
          afterResolve(await svc.rejectInteraction(...resolveArgs)),
      };
    },
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
    lockInterleave.beforeLock = null;
    lockInterleave.afterResolve = null;
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
      secondReviewerId: randomUUID(),
      coderId: randomUUID(),
      arbiterId: randomUUID(),
      pausedId: randomUUID(),
      otherId: randomUUID(),
      terminatedId: randomUUID(),
      userId: `user-${companyId.slice(0, 8)}`,
    };
    await db.insert(companies).values({ id: companyId, name: "Stall Co", issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    // The routes fire real wakeups; the "process" adapter rejects an empty config
    // at once, so afterEach's drain never waits on a real codex run (slow in CI).
    const agent = (id: string, name: string, status: string) => ({
      id, companyId, name, role: "engineer", status, adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(agents).values([
      agent(ids.reviewerId, "Reviewer", "idle"),
      agent(ids.secondReviewerId, "Second reviewer", "idle"),
      agent(ids.coderId, "Coder", "idle"),
      agent(ids.arbiterId, "Arbiter", "idle"),
      agent(ids.pausedId, "Paused", "paused"),
      agent(ids.otherId, "Other", "idle"),
      agent(ids.terminatedId, "Gone", "terminated"),
    ]);
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: ids.userId, status: "active", membershipRole: "operator",
    });
    return ids;
  }

  type Seeded = Awaited<ReturnType<typeof seedCompany>>;

  type PolicyShape = { reviewers?: string[]; approvalStageId?: string; maxReviewRounds?: number };

  function stallPolicy(seeded: Seeded, stageId: string, toAgentId: string = seeded.arbiterId, shape: PolicyShape = {}) {
    const reviewers = shape.reviewers ?? [seeded.reviewerId];
    return {
      mode: "normal",
      commentRequired: true,
      stages: [
        { id: stageId, type: "review", approvalsNeeded: 1, participants: reviewers.map((agentId) => ({ id: randomUUID(), type: "agent", agentId })) },
        ...(shape.approvalStageId
          ? [{ id: shape.approvalStageId, type: "approval", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "user", userId: seeded.userId }] }]
          : []),
      ],
      stallEscalation: { afterRounds: 2, toAgentId },
      ...(shape.maxReviewRounds !== undefined ? { maxReviewRounds: shape.maxReviewRounds } : {}),
    };
  }

  async function seedPendingReview(
    seeded: Seeded,
    stateOverrides: (stageId: string) => Record<string, unknown> = () => ({}),
    shape: { reviewers?: string[]; twoStage?: boolean; maxReviewRounds?: number } = {},
  ) {
    const issueId = randomUUID();
    const stageId = randomUUID();
    const approvalStageId = shape.twoStage ? randomUUID() : undefined;
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
      executionPolicy: stallPolicy(seeded, stageId, seeded.arbiterId, {
        reviewers: shape.reviewers,
        approvalStageId,
        maxReviewRounds: shape.maxReviewRounds,
      }),
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
    return { issueId, stageId, approvalStageId };
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

  it("refuses a hand-off decided against a policy the board changed before the row lock", async () => {
    const seeded = await seedCompany();
    const { issueId, stageId } = await seedPendingReview(seeded);
    const runId = await liveRun(seeded, seeded.reviewerId, issueId);
    // The reviewer's decision was computed from the old policy (arbiter, afterRounds 2);
    // the board commits a new arbiter and afterRounds 3 before the decision locks the row.
    const boardPolicy = { ...stallPolicy(seeded, stageId), stallEscalation: { afterRounds: 3, toAgentId: seeded.otherId } };
    lockInterleave.beforeLock = async () => {
      await db.update(issues).set({ executionPolicy: boardPolicy }).where(eq(issues.id, issueId));
    };

    const res = await request(app(agentActor(seeded, seeded.reviewerId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: "Same finding on the same head.\nCode acceptable: yes" });

    expect(lockInterleave.beforeLock).toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ code: "review_stall_policy_changed" });
    expect(await stallRows(issueId)).toHaveLength(0);
    expect(await decisionRows(issueId)).toHaveLength(0);
    const row = await issueRow(issueId);
    expect(row.status).toBe("in_review");
    expect(row.assigneeAgentId).toBe(seeded.reviewerId);
    expect(row.executionState).not.toHaveProperty("stallHandoff");
    expect(row.executionPolicy).toMatchObject({ stallEscalation: { afterRounds: 3, toAgentId: seeded.otherId } });
  }, 60_000);

  it("refuses a hand-off to the old arbiter when the board replaced only the arbiter before the row lock", async () => {
    const seeded = await seedCompany();
    const { issueId } = await seedPendingReview(seeded);
    const runId = await liveRun(seeded, seeded.reviewerId, issueId);
    // Only the arbiter changes: same ceiling, same afterRounds, same stages.
    lockInterleave.beforeLock = async () => {
      const current = (await issueRow(issueId)).executionPolicy as StoredPolicy;
      await db
        .update(issues)
        .set({ executionPolicy: { ...current, stallEscalation: { ...current.stallEscalation, toAgentId: seeded.otherId } } })
        .where(eq(issues.id, issueId));
    };

    const res = await request(app(agentActor(seeded, seeded.reviewerId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: "Same finding on the same head.\nCode acceptable: yes" });

    expect(lockInterleave.beforeLock).toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ code: "review_stall_policy_changed" });
    expect(await stallRows(issueId)).toHaveLength(0);
    expect(await decisionRows(issueId)).toHaveLength(0);
    const row = await issueRow(issueId);
    expect(row.assigneeAgentId).toBe(seeded.reviewerId);
    expect(row.executionState).not.toHaveProperty("stallHandoff");
  }, 60_000);

  // One stale hand-off per compared policy control (N5 afterRounds, N8 stage
  // type, N9 participants): the board commits the edit between the reviewer's
  // read and its row lock; the hand-off computed from the old policy is refused.
  it.each<[string, (policy: StoredPolicy, seeded: Seeded) => Record<string, unknown>]>([
    ["raised afterRounds from 2 to 5", (policy) => ({ ...policy, stallEscalation: { ...policy.stallEscalation, afterRounds: 5 } })],
    ["changed the stage type from review to approval", (policy) => ({ ...policy, stages: policy.stages.map((stage) => ({ ...stage, type: "approval" })) })],
    [
      "added a second reviewer to the stage",
      (policy, seeded) => ({
        ...policy,
        stages: policy.stages.map((stage) => ({
          ...stage,
          participants: [...stage.participants, { id: randomUUID(), type: "agent", agentId: seeded.secondReviewerId }],
        })),
      }),
    ],
    [
      "swapped the stage reviewer",
      (policy, seeded) => ({
        ...policy,
        stages: policy.stages.map((stage) => ({ ...stage, participants: [{ id: randomUUID(), type: "agent", agentId: seeded.secondReviewerId }] })),
      }),
    ],
  ])(
    "refuses a stale hand-off when the board %s before the row lock",
    async (_change, edit) => {
      const seeded = await seedCompany();
      const { issueId } = await seedPendingReview(seeded);
      const runId = await liveRun(seeded, seeded.reviewerId, issueId);
      lockInterleave.beforeLock = async () => {
        const current = (await issueRow(issueId)).executionPolicy as StoredPolicy;
        await db.update(issues).set({ executionPolicy: edit(current, seeded) }).where(eq(issues.id, issueId));
      };

      const res = await request(app(agentActor(seeded, seeded.reviewerId, runId)))
        .patch(`/api/issues/${issueId}`)
        .send({ status: "in_progress", comment: "Same finding on the same head.\nCode acceptable: yes" });

      expect(lockInterleave.beforeLock).toBeNull();
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.details).toMatchObject({ code: "review_stall_policy_changed" });
      expect(await stallRows(issueId)).toHaveLength(0);
      expect(await decisionRows(issueId)).toHaveLength(0);
      const row = await issueRow(issueId);
      expect(row.assigneeAgentId).toBe(seeded.reviewerId);
      expect(row.executionState).not.toHaveProperty("stallHandoff");
    },
    60_000,
  );

  async function seedArbiterHold(seeded: Seeded, shape: { reviewers?: string[]; twoStage?: boolean } = {}) {
    const seededIssue = await seedPendingReview(
      seeded,
      (stageId) => ({
        currentParticipant: { type: "agent", agentId: seeded.arbiterId },
        changesRequestedCount: 2,
        stallHandoff: {
          stageId,
          arbiterAgentId: seeded.arbiterId,
          fromParticipant: { type: "agent", agentId: seeded.reviewerId, userId: null },
          changesRequestedCount: 2,
          signals: ["same_head_rebounced"],
          handedOffAt: "2026-11-05T00:00:00.000Z",
        },
      }),
      shape,
    );
    await db.update(issues).set({ assigneeAgentId: seeded.arbiterId }).where(eq(issues.id, seededIssue.issueId));
    const stored = (await issueRow(seededIssue.issueId)).executionPolicy as StoredPolicy;
    return { ...seededIssue, stored };
  }

  type StoredPolicy = ReturnType<typeof stallPolicy>;

  // F-R2-1's first step: list the arbiter on the review stage and point the
  // stall policy elsewhere, so validation (arbiter not a participant) passes.
  const withArbiterBesideReviewer = (policy: StoredPolicy, seeded: Seeded) => ({
    ...policy,
    stages: policy.stages.map((stage) =>
      stage.type === "review"
        ? { ...stage, participants: [...stage.participants, { id: randomUUID(), type: "agent", agentId: seeded.arbiterId }] }
        : stage,
    ),
    stallEscalation: { afterRounds: 2, toAgentId: seeded.otherId },
  });

  it.each<[string, (policy: StoredPolicy, seeded: Seeded) => Record<string, unknown>]>([
    ["raises the round ceiling", (policy) => ({ executionPolicy: { ...policy, maxReviewRounds: 50 } })],
    ["moves afterRounds", (policy) => ({ executionPolicy: { ...policy, stallEscalation: { ...policy.stallEscalation, afterRounds: 1 } } })],
    ["names another arbiter", (policy, seeded) => ({ executionPolicy: { ...policy, stallEscalation: { ...policy.stallEscalation, toAgentId: seeded.otherId } } })],
    ["drops stallEscalation", ({ stallEscalation: _dropped, ...policy }) => ({ executionPolicy: policy })],
    ["sends only the stages", (policy) => ({ executionPolicy: { stages: policy.stages } })],
    [
      "rewrites the stage reviewers",
      (policy, seeded) => ({
        executionPolicy: {
          ...policy,
          stages: policy.stages.map((stage) => ({ ...stage, participants: [{ id: randomUUID(), type: "agent", agentId: seeded.otherId }] })),
        },
      }),
    ],
    ["adds itself beside the reviewer", (policy, seeded) => ({ executionPolicy: withArbiterBesideReviewer(policy, seeded) })],
    ["only changes baseRef", (policy) => ({ executionPolicy: { ...policy, baseRef: "release/r20" } })],
    ["writes the review policy", () => ({ reviewPolicy: "anyone" })],
    // Malformed bodies get the same refusal, before body validation (no 400).
    ["sends a malformed policy with unknown and type-wrong keys", () => ({ executionPolicy: { stages: "not-a-list", bogus: true } })],
    ["sends an unknown key beside a valid policy", (policy) => ({ executionPolicy: { ...policy, unknownKey: 1 } })],
    ["sends a type-wrong review policy", () => ({ reviewPolicy: 42 })],
    [
      "nests a malformed policy in a bulk body",
      (policy) => ({ title: "Renamed by the arbiter", executionPolicy: { ...policy, maxReviewRounds: "fifty" }, notAField: true }),
    ],
  ])(
    "refuses the seated arbiter a PATCH that %s",
    async (_shape, body) => {
      const seeded = await seedCompany();
      const { issueId, stored } = await seedArbiterHold(seeded);
      const runId = await liveRun(seeded, seeded.arbiterId, issueId);

      const res = await request(app(agentActor(seeded, seeded.arbiterId, runId)))
        .patch(`/api/issues/${issueId}`)
        .send(body(stored, seeded));

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details).toMatchObject({ code: "stall_arbiter_policy_edit_refused" });
      const row = await issueRow(issueId);
      expect(row.executionPolicy).toEqual(stored);
      expect(row.reviewPolicy).toBeNull();
      expect(row.assigneeAgentId).toBe(seeded.arbiterId);
      expect(row.title).toBe("Stalled review");
    },
    60_000,
  );

  it("keeps the arbiter from approving the review stage after it tries to add itself to it (F-R2-1)", async () => {
    const seeded = await seedCompany();
    const { issueId, stageId, stored } = await seedArbiterHold(seeded, { twoStage: true });
    const runId = await liveRun(seeded, seeded.arbiterId, issueId);
    const arbiter = app(agentActor(seeded, seeded.arbiterId, runId));

    const selfAdd = await request(arbiter).patch(`/api/issues/${issueId}`).send({ executionPolicy: withArbiterBesideReviewer(stored, seeded) });
    const done = await request(arbiter).patch(`/api/issues/${issueId}`).send({ status: "done", comment: "Approved on my reading." });

    expect(selfAdd.status, JSON.stringify(selfAdd.body)).toBe(403);
    expect(done.status, JSON.stringify(done.body)).toBe(422);
    expect(done.body.details).toMatchObject({ code: "stall_arbiter_cannot_approve" });
    expect(await decisionRows(issueId)).toHaveLength(0);
    const row = await issueRow(issueId);
    expect(row.assigneeAgentId).toBe(seeded.arbiterId);
    expect(row.executionState).toMatchObject({ currentStageId: stageId, completedStageIds: [] });
  }, 60_000);

  it("keeps the handed-off arbiter from approving when the board later lists it on the review stage", async () => {
    const seeded = await seedCompany();
    const { issueId, stageId, stored } = await seedArbiterHold(seeded, {
      twoStage: true,
      reviewers: [seeded.reviewerId, seeded.secondReviewerId],
    });

    const boardEdit = await request(app(boardActor(seeded)))
      .patch(`/api/issues/${issueId}`)
      .send({ executionPolicy: withArbiterBesideReviewer(stored, seeded) });
    expect(boardEdit.status, JSON.stringify(boardEdit.body)).toBe(200);
    expect((await issueRow(issueId)).assigneeAgentId).toBe(seeded.arbiterId);

    const runId = await liveRun(seeded, seeded.arbiterId, issueId);
    const done = await request(app(agentActor(seeded, seeded.arbiterId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Approved on my reading." });

    expect(done.status, JSON.stringify(done.body)).toBe(422);
    expect(done.body.details).toMatchObject({ code: "stall_arbiter_cannot_approve" });
    expect(await decisionRows(issueId)).toHaveLength(0);
    expect((await issueRow(issueId)).executionState).toMatchObject({ currentStageId: stageId, completedStageIds: [] });
  }, 60_000);

  it("lets the configured reviewer approve after an arbiter round (P17r)", async () => {
    const seeded = await seedCompany();
    const { issueId, stageId, approvalStageId } = await seedArbiterHold(seeded, { twoStage: true });

    // The arbiter answers with a directive; the implementer redelivers; the
    // stage goes back to its configured reviewer, who approves it.
    const arbiterRun = await liveRun(seeded, seeded.arbiterId, issueId);
    const directive = await request(app(agentActor(seeded, seeded.arbiterId, arbiterRun)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: "Regenerate the stale fixture and redeliver." });
    expect(directive.status, JSON.stringify(directive.body)).toBe(200);
    expect((await issueRow(issueId)).assigneeAgentId).toBe(seeded.coderId);

    const coderRun = await liveRun(seeded, seeded.coderId, issueId);
    const redelivery = await request(app(agentActor(seeded, seeded.coderId, coderRun)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review", comment: "Redelivered with the regenerated fixture." });
    expect(redelivery.status, JSON.stringify(redelivery.body)).toBe(200);
    expect((await issueRow(issueId)).assigneeAgentId).toBe(seeded.reviewerId);

    const reviewerRun = await liveRun(seeded, seeded.reviewerId, issueId);
    const approval = await request(app(agentActor(seeded, seeded.reviewerId, reviewerRun)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Approved: the fixture is regenerated." });

    expect(approval.status, JSON.stringify(approval.body)).toBe(200);
    expect((await issueRow(issueId)).executionState).toMatchObject({
      currentStageId: approvalStageId,
      completedStageIds: [stageId],
    });
    const outcomes = (await decisionRows(issueId)).map((row) => `${row.outcome}:${row.actorAgentId}`).sort();
    expect(outcomes).toEqual([`approved:${seeded.reviewerId}`, `changes_requested:${seeded.arbiterId}`].sort());
  }, 90_000);

  // Mixed concurrent decisions by the stage's reviewer on a two-reviewer stage
  // without the same-head signal: only the marker decision hands off.
  const plainBounce = { status: "in_progress", comment: "Another finding in the retry path." };
  const markerBounce = { status: "in_progress", comment: "Only a nit is left.\nCode acceptable: yes" };
  const seedMixedRace = (seeded: Seeded) =>
    seedPendingReview(seeded, () => ({ bouncedHeadSha: "b".repeat(40) }), {
      reviewers: [seeded.reviewerId, seeded.secondReviewerId],
    });

  it("refuses a plain decision that would erase a hand-off committed after its read (F-R2-2)", async () => {
    const seeded = await seedCompany();
    const { issueId } = await seedMixedRace(seeded);
    const runId = await liveRun(seeded, seeded.reviewerId, issueId);
    const reviewer = app(agentActor(seeded, seeded.reviewerId, runId));
    const raced: { stall?: request.Response } = {};
    // The plain decision has read the card; the stall decision commits its
    // hand-off before the plain decision takes the row lock.
    lockInterleave.beforeLock = async () => {
      raced.stall = await request(reviewer).patch(`/api/issues/${issueId}`).send(markerBounce);
    };

    const plain = await request(reviewer).patch(`/api/issues/${issueId}`).send(plainBounce);

    expect(lockInterleave.beforeLock).toBeNull();
    expect(raced.stall?.status, JSON.stringify(raced.stall?.body)).toBe(200);
    expect(plain.status, JSON.stringify(plain.body)).toBe(409);
    expect(plain.body.details).toMatchObject({ code: "review_stall_handoff_conflict" });
    expect(await stallRows(issueId)).toHaveLength(1);
    expect(await decisionRows(issueId)).toHaveLength(1);
    const row = await issueRow(issueId);
    expect(row.assigneeAgentId).toBe(seeded.arbiterId);
    expect(row.executionState).toMatchObject({ stallHandoff: { arbiterAgentId: seeded.arbiterId } });
  }, 60_000);

  it("refuses a hand-off computed before a concurrent plain decision committed", async () => {
    const seeded = await seedCompany();
    const { issueId } = await seedMixedRace(seeded);
    const runId = await liveRun(seeded, seeded.reviewerId, issueId);
    const reviewer = app(agentActor(seeded, seeded.reviewerId, runId));
    const raced: { plain?: request.Response } = {};
    // The stall decision has read the card; the plain decision commits its
    // bounce before the stall decision takes the row lock.
    lockInterleave.beforeLock = async () => {
      raced.plain = await request(reviewer).patch(`/api/issues/${issueId}`).send(plainBounce);
    };

    const stall = await request(reviewer).patch(`/api/issues/${issueId}`).send(markerBounce);

    expect(lockInterleave.beforeLock).toBeNull();
    expect(raced.plain?.status, JSON.stringify(raced.plain?.body)).toBe(200);
    expect(stall.status, JSON.stringify(stall.body)).toBe(409);
    expect(stall.body.details).toMatchObject({ code: "review_stall_handoff_conflict" });
    expect(await stallRows(issueId)).toHaveLength(0);
    expect(await decisionRows(issueId)).toHaveLength(1);
    const row = await issueRow(issueId);
    expect(row.assigneeAgentId).toBe(seeded.coderId);
    expect(row.executionState ?? {}).not.toHaveProperty("stallHandoff");
  }, 60_000);

  it("never writes a hand-off over a hand-off record that appeared before the row lock", async () => {
    const seeded = await seedCompany();
    const { issueId, stageId } = await seedPendingReview(seeded);
    const runId = await liveRun(seeded, seeded.reviewerId, issueId);
    const recorded = {
      stageId,
      arbiterAgentId: seeded.arbiterId,
      fromParticipant: { type: "agent", agentId: seeded.reviewerId, userId: null },
      changesRequestedCount: 1,
      signals: ["code_acceptable"],
      handedOffAt: "2026-11-06T00:00:00.000Z",
    };
    // The stage-run's hand-off record lands after this decision's read, with
    // the decision pointer unchanged: only the hand-off comparison sees it.
    lockInterleave.beforeLock = async () => {
      const current = await issueRow(issueId);
      await db
        .update(issues)
        .set({ executionState: { ...(current.executionState as Record<string, unknown>), stallHandoff: recorded } })
        .where(eq(issues.id, issueId));
    };

    const res = await request(app(agentActor(seeded, seeded.reviewerId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: "Same finding on the same head.\nCode acceptable: yes" });

    expect(lockInterleave.beforeLock).toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ code: "review_stall_handoff_conflict" });
    expect(await stallRows(issueId)).toHaveLength(0);
    expect(await decisionRows(issueId)).toHaveLength(0);
    const row = await issueRow(issueId);
    expect(row.assigneeAgentId).toBe(seeded.reviewerId);
    expect(row.executionState).toMatchObject({ stallHandoff: recorded });
  }, 60_000);

  it("refuses a hand-off whose delivered head was refreshed before the row lock", async () => {
    const seeded = await seedCompany();
    const { issueId } = await seedPendingReview(seeded);
    const runId = await liveRun(seeded, seeded.reviewerId, issueId);
    const refreshedHead = "d".repeat(40);
    // A delivery refresh moves the delivered head after the reviewer's read;
    // the reviewer's hand-off was computed from the old, re-bounced head.
    lockInterleave.beforeLock = async () => {
      const current = await issueRow(issueId);
      await db
        .update(issues)
        .set({ executionState: { ...(current.executionState as Record<string, unknown>), deliveredHeadSha: refreshedHead } })
        .where(eq(issues.id, issueId));
    };

    const res = await request(app(agentActor(seeded, seeded.reviewerId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: "Same finding on the same head." });

    expect(lockInterleave.beforeLock).toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ code: "review_stall_policy_changed" });
    expect(await stallRows(issueId)).toHaveLength(0);
    expect(await decisionRows(issueId)).toHaveLength(0);
    const row = await issueRow(issueId);
    expect(row.assigneeAgentId).toBe(seeded.reviewerId);
    expect(row.executionState).toMatchObject({ deliveredHeadSha: refreshedHead });
    expect(row.executionState).not.toHaveProperty("stallHandoff");
  }, 60_000);

  it("refuses an ordinary bounce whose delivered head was refreshed before the row lock", async () => {
    const seeded = await seedCompany();
    // No stall signal: the reviewer's decision is an ordinary bounce, guarded
    // only because the card carries stallEscalation.
    const { issueId } = await seedMixedRace(seeded);
    const runId = await liveRun(seeded, seeded.reviewerId, issueId);
    const refreshedHead = "d".repeat(40);
    lockInterleave.beforeLock = async () => {
      const current = await issueRow(issueId);
      await db
        .update(issues)
        .set({ executionState: { ...(current.executionState as Record<string, unknown>), deliveredHeadSha: refreshedHead } })
        .where(eq(issues.id, issueId));
    };

    const res = await request(app(agentActor(seeded, seeded.reviewerId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send(plainBounce);

    expect(lockInterleave.beforeLock).toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ code: "review_stall_policy_changed" });
    expect(await decisionRows(issueId)).toHaveLength(0);
    const row = await issueRow(issueId);
    expect(row.status).toBe("in_review");
    expect(row.assigneeAgentId).toBe(seeded.reviewerId);
    expect(row.executionState).toMatchObject({ deliveredHeadSha: refreshedHead });
  }, 60_000);

  it("refuses an ordinary bounce computed before the board lowered the round ceiling", async () => {
    const seeded = await seedCompany();
    // Ceiling 4 and round 3 next, no stall signal: an ordinary bounce to the coder.
    const { issueId } = await seedPendingReview(
      seeded,
      () => ({ changesRequestedCount: 2, bouncedHeadSha: "b".repeat(40) }),
      { maxReviewRounds: 4 },
    );
    const runId = await liveRun(seeded, seeded.reviewerId, issueId);
    // The board lowers the ceiling to 2 after the reviewer's read: under it this
    // round escalates to the responsible human instead.
    lockInterleave.beforeLock = async () => {
      const current = await issueRow(issueId);
      await db
        .update(issues)
        .set({ executionPolicy: { ...(current.executionPolicy as Record<string, unknown>), maxReviewRounds: 2 } })
        .where(eq(issues.id, issueId));
    };

    const res = await request(app(agentActor(seeded, seeded.reviewerId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send(plainBounce);

    expect(lockInterleave.beforeLock).toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ code: "review_stall_policy_changed" });
    expect(await decisionRows(issueId)).toHaveLength(0);
    const row = await issueRow(issueId);
    expect(row.status).toBe("in_review");
    expect(row.assigneeAgentId).toBe(seeded.reviewerId);
    expect(row.executionPolicy).toMatchObject({ maxReviewRounds: 2 });
  }, 60_000);

  it("refuses an ordinary bounce on a card that keeps only a hand-off record when the ceiling was lowered (G2)", async () => {
    const seeded = await seedCompany();
    // This stage-run was handed off earlier; the stall policy has since been
    // dropped (SUP-23065) and the reviewer is seated again. Only the hand-off
    // record makes the decision a guarded one.
    const { issueId } = await seedPendingReview(
      seeded,
      (stageId) => ({
        changesRequestedCount: 2,
        bouncedHeadSha: "b".repeat(40),
        stallHandoff: {
          stageId,
          arbiterAgentId: seeded.arbiterId,
          fromParticipant: { type: "agent", agentId: seeded.reviewerId, userId: null },
          changesRequestedCount: 1,
          signals: ["same_head_rebounced"],
          handedOffAt: "2026-11-05T00:00:00.000Z",
        },
      }),
      { maxReviewRounds: 4 },
    );
    const { stallEscalation: _dropped, ...withoutStall } = (await issueRow(issueId)).executionPolicy as StoredPolicy;
    await db.update(issues).set({ executionPolicy: withoutStall }).where(eq(issues.id, issueId));
    const runId = await liveRun(seeded, seeded.reviewerId, issueId);
    lockInterleave.beforeLock = async () => {
      await db.update(issues).set({ executionPolicy: { ...withoutStall, maxReviewRounds: 2 } }).where(eq(issues.id, issueId));
    };

    const res = await request(app(agentActor(seeded, seeded.reviewerId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send(plainBounce);

    expect(lockInterleave.beforeLock).toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ code: "review_stall_policy_changed" });
    expect(await decisionRows(issueId)).toHaveLength(0);
    const row = await issueRow(issueId);
    expect(row.status).toBe("in_review");
    expect(row.assigneeAgentId).toBe(seeded.reviewerId);
  }, 60_000);

  function plainPolicy(seeded: Seeded, stageId: string, maxReviewRounds?: number, secondStage = false) {
    return {
      mode: "normal",
      commentRequired: true,
      stages: [
        {
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: seeded.reviewerId }],
        },
        ...(secondStage
          ? [
              {
                id: randomUUID(),
                type: "review",
                approvalsNeeded: 1,
                participants: [{ id: randomUUID(), type: "agent", agentId: seeded.arbiterId }],
              },
            ]
          : []),
      ],
      ...(maxReviewRounds !== undefined ? { maxReviewRounds } : {}),
    };
  }

  async function seedPlainPendingReview(
    seeded: Seeded,
    shape: {
      maxReviewRounds?: number;
      changesRequestedCount?: number;
      delivery?: Record<string, unknown>;
      secondStage?: boolean;
      escalated?: boolean;
    } = {},
  ) {
    const issueId = randomUUID();
    const stageId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: seeded.companyId,
      title: "Plain review",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: shape.escalated ? null : seeded.reviewerId,
      assigneeUserId: shape.escalated ? seeded.userId : null,
      responsibleUserId: seeded.userId,
      createdByUserId: seeded.userId,
      deliveryRequirement: "record_only",
      executionPolicy: plainPolicy(seeded, stageId, shape.maxReviewRounds, shape.secondStage),
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: shape.escalated
          ? { type: "user", agentId: null, userId: seeded.userId }
          : { type: "agent", agentId: seeded.reviewerId },
        returnAssignee: { type: "agent", agentId: seeded.coderId },
        deliveryAuthor: { type: "agent", agentId: seeded.coderId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        changesRequestedCount: shape.changesRequestedCount ?? (shape.escalated ? 3 : 1),
        ...(shape.delivery ? { delivery: shape.delivery } : {}),
      },
    });
    return { issueId, stageId };
  }

  const plainFinding = { status: "in_progress", comment: "finding" };

  it("records an ordinary bounce on a plain card when the snapshot is still current", async () => {
    const seeded = await seedCompany();
    const { issueId } = await seedPlainPendingReview(seeded, { maxReviewRounds: 50 });
    const runId = await liveRun(seeded, seeded.reviewerId, issueId);

    const res = await request(app(agentActor(seeded, seeded.reviewerId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send(plainFinding);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await issueRow(issueId);
    expect(row.status).toBe("in_progress");
    expect(row.assigneeAgentId).toBe(seeded.coderId);
    expect(row.executionPolicy).not.toHaveProperty("stallEscalation");
    expect(await decisionRows(issueId)).toHaveLength(1);
  }, 60_000);

  it("refuses a plain-card bounce that would erase a same-head PR binding refreshed after the read (SUP-23260)", async () => {
    const seeded = await seedCompany();
    const headSha = "a".repeat(40);
    const { issueId } = await seedPlainPendingReview(seeded, {
      maxReviewRounds: 50,
      delivery: {
        repo: { owner: "TEA-Core", repo: "paperclip" },
        branch: "fm/plain-card",
        headSha,
      },
    });
    const runId = await liveRun(seeded, seeded.reviewerId, issueId);
    const refreshed = {
      repo: { owner: "TEA-Core", repo: "paperclip" },
      branch: "fm/plain-card",
      headSha,
      prNumber: 1117,
      prUrl: "https://github.com/TEA-Core/paperclip/pull/1117",
    };
    // Same head, new PR binding. A compare that only looks at deliveredHeadSha
    // (absent on both sides) lets this return 200 and wipes the fields.
    lockInterleave.beforeLock = async () => {
      const current = await issueRow(issueId);
      await db
        .update(issues)
        .set({ executionState: { ...(current.executionState as Record<string, unknown>), delivery: refreshed } })
        .where(eq(issues.id, issueId));
    };

    const res = await request(app(agentActor(seeded, seeded.reviewerId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send(plainFinding);

    expect(lockInterleave.beforeLock).toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ code: "review_stall_policy_changed" });
    expect(await decisionRows(issueId)).toHaveLength(0);
    const row = await issueRow(issueId);
    expect(row.status).toBe("in_review");
    expect(row.assigneeAgentId).toBe(seeded.reviewerId);
    expect(row.executionState).toMatchObject({ delivery: refreshed });
  }, 60_000);

  it("refuses a plain-card bounce when only delivery.headSha moved after the read (SUP-23260)", async () => {
    const seeded = await seedCompany();
    const headSha = "a".repeat(40);
    const { issueId } = await seedPlainPendingReview(seeded, {
      maxReviewRounds: 50,
      delivery: {
        repo: { owner: "TEA-Core", repo: "paperclip" },
        branch: "fm/plain-card",
        headSha,
        prNumber: 1117,
        prUrl: "https://github.com/TEA-Core/paperclip/pull/1117",
      },
    });
    const runId = await liveRun(seeded, seeded.reviewerId, issueId);
    const movedHead = "b".repeat(40);
    lockInterleave.beforeLock = async () => {
      const current = await issueRow(issueId);
      const state = current.executionState;
      const previousDelivery =
        state && typeof state === "object" && "delivery" in state && state.delivery && typeof state.delivery === "object"
          ? state.delivery
          : {};
      const delivery = { ...previousDelivery, headSha: movedHead };
      await db
        .update(issues)
        .set({ executionState: { ...(state && typeof state === "object" ? state : {}), delivery } })
        .where(eq(issues.id, issueId));
    };

    const res = await request(app(agentActor(seeded, seeded.reviewerId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send(plainFinding);

    expect(lockInterleave.beforeLock).toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ code: "review_stall_policy_changed" });
    expect(await decisionRows(issueId)).toHaveLength(0);
    const row = await issueRow(issueId);
    expect(row.status).toBe("in_review");
    const stored = row.executionState;
    const storedHead =
      stored && typeof stored === "object" && "delivery" in stored && stored.delivery && typeof stored.delivery === "object" && "headSha" in stored.delivery
        ? stored.delivery.headSha
        : null;
    expect(storedHead).toBe(movedHead);
  }, 60_000);

  it("refuses a plain-card bounce computed before the board lowered the round ceiling (SUP-23260)", async () => {
    const seeded = await seedCompany();
    // No stallEscalation and no hand-off record. Ceiling 4, next round 3: the
    // unlocked read is a bounce to the coder. Dropping the plain-card arm lets
    // this return 200 and assign the coder.
    const { issueId } = await seedPlainPendingReview(seeded, {
      maxReviewRounds: 4,
      changesRequestedCount: 2,
    });
    const runId = await liveRun(seeded, seeded.reviewerId, issueId);
    lockInterleave.beforeLock = async () => {
      const current = await issueRow(issueId);
      await db
        .update(issues)
        .set({ executionPolicy: { ...(current.executionPolicy as Record<string, unknown>), maxReviewRounds: 2 } })
        .where(eq(issues.id, issueId));
    };

    const res = await request(app(agentActor(seeded, seeded.reviewerId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send(plainFinding);

    expect(lockInterleave.beforeLock).toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ code: "review_stall_policy_changed" });
    expect(await decisionRows(issueId)).toHaveLength(0);
    const row = await issueRow(issueId);
    expect(row.status).toBe("in_review");
    expect(row.assigneeAgentId).toBe(seeded.reviewerId);
    expect(row.executionPolicy).toMatchObject({ maxReviewRounds: 2 });
    expect(row.executionPolicy).not.toHaveProperty("stallEscalation");
    expect(row.executionState ?? {}).not.toHaveProperty("stallHandoff");
  }, 60_000);

  it.each([12, 20, 50])(
    "returns all %i concurrent plain-card decisions without a pool wait (SUP-23260)",
    async (count) => {
      const seeded = await seedCompany();
      const { issueId } = await seedPlainPendingReview(seeded, {
        maxReviewRounds: 50,
        changesRequestedCount: 0,
      });
      const runId = await liveRun(seeded, seeded.reviewerId, issueId);
      const reviewer = app(agentActor(seeded, seeded.reviewerId, runId));

      const responses = await Promise.all(
        Array.from({ length: count }, (_, index) =>
          request(reviewer).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: `finding ${index}` }),
        ),
      );

      expect(responses, JSON.stringify(responses.map((res) => ({ status: res.status, body: res.body })))).toHaveLength(count);
      expect(responses.every((res) => res.status === 200)).toBe(true);
      expect(await decisionRows(issueId)).toHaveLength(count);
    },
    60_000,
  );

  const approvalComment = { body: "## Review: APPROVED\n\nLooks good." };

  it("approves through the comment door when the snapshot is still current", async () => {
    const seeded = await seedCompany();
    const { issueId } = await seedPlainPendingReview(seeded, { maxReviewRounds: 50, secondStage: true });
    const runId = await liveRun(seeded, seeded.reviewerId, issueId);

    const res = await request(app(agentActor(seeded, seeded.reviewerId, runId)))
      .post(`/api/issues/${issueId}/comments`)
      .send(approvalComment);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await decisionRows(issueId)).toHaveLength(1);
    expect((await issueRow(issueId)).executionState).toMatchObject({ lastDecisionOutcome: "approved" });
  }, 60_000);

  it("refuses a comment-door approval that would erase a same-head PR binding refreshed after the read (SUP-23260)", async () => {
    const seeded = await seedCompany();
    const headSha = "a".repeat(40);
    const { issueId } = await seedPlainPendingReview(seeded, {
      maxReviewRounds: 50,
      secondStage: true,
      delivery: {
        repo: { owner: "TEA-Core", repo: "paperclip" },
        branch: "fm/plain-card",
        headSha,
      },
    });
    const runId = await liveRun(seeded, seeded.reviewerId, issueId);
    const refreshed = {
      repo: { owner: "TEA-Core", repo: "paperclip" },
      branch: "fm/plain-card",
      headSha,
      prNumber: 1117,
      prUrl: "https://github.com/TEA-Core/paperclip/pull/1117",
    };
    lockInterleave.beforeLock = async () => {
      const current = await issueRow(issueId);
      await db
        .update(issues)
        .set({ executionState: { ...(current.executionState as Record<string, unknown>), delivery: refreshed } })
        .where(eq(issues.id, issueId));
    };

    const res = await request(app(agentActor(seeded, seeded.reviewerId, runId)))
      .post(`/api/issues/${issueId}/comments`)
      .send(approvalComment);

    expect(lockInterleave.beforeLock).toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ code: "review_stall_policy_changed" });
    expect(await decisionRows(issueId)).toHaveLength(0);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(0);
    const row = await issueRow(issueId);
    expect(row.status).toBe("in_review");
    expect(row.executionState).toMatchObject({ status: "pending", delivery: refreshed });
  }, 60_000);

  it("refuses a comment-door approval computed before the board lowered the round ceiling (SUP-23260)", async () => {
    const seeded = await seedCompany();
    const { issueId } = await seedPlainPendingReview(seeded, { maxReviewRounds: 4, changesRequestedCount: 2, secondStage: true });
    const runId = await liveRun(seeded, seeded.reviewerId, issueId);
    lockInterleave.beforeLock = async () => {
      const current = await issueRow(issueId);
      await db
        .update(issues)
        .set({ executionPolicy: { ...(current.executionPolicy as Record<string, unknown>), maxReviewRounds: 2 } })
        .where(eq(issues.id, issueId));
    };

    const res = await request(app(agentActor(seeded, seeded.reviewerId, runId)))
      .post(`/api/issues/${issueId}/comments`)
      .send(approvalComment);

    expect(lockInterleave.beforeLock).toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ code: "review_stall_policy_changed" });
    expect(await decisionRows(issueId)).toHaveLength(0);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(0);
    const row = await issueRow(issueId);
    expect(row.status).toBe("in_review");
    expect(row.executionPolicy).toMatchObject({ maxReviewRounds: 2 });
  }, 60_000);

  async function seedEscalationInteraction(seeded: Seeded, issueId: string, stageId: string) {
    return issueThreadInteractionService(db).create(
      { id: issueId, companyId: seeded.companyId },
      {
        kind: "request_confirmation",
        title: "Review round cap reached — your decision is needed",
        summary: "Review stage hit the round cap and was escalated to you.",
        addresseeAgentId: null,
        resolverPolicy: "human_only",
        continuationPolicy: "wake_assignee",
        sourceRunId: null,
        idempotencyKey: `review-escalation:${issueId}:${stageId}:3:${randomUUID().slice(0, 8)}`,
        payload: {
          version: 1,
          prompt: "Approve this review, or request further changes (round cap reached).",
          acceptLabel: "Approve & advance",
          rejectLabel: "Request changes",
          rejectRequiresReason: true,
          allowDeclineReason: true,
          detailsMarkdown: "Escalated.",
        },
      },
      { agentId: null, userId: seeded.userId },
    );
  }

  const sameHeadDelivery = (headSha: string) => ({
    repo: { owner: "TEA-Core", repo: "paperclip" },
    branch: "fm/plain-card",
    headSha,
  });

  function refreshDeliveryAfterResolve(issueId: string, delivery: Record<string, unknown>) {
    lockInterleave.afterResolve = async () => {
      const current = await issueRow(issueId);
      await db
        .update(issues)
        .set({ executionState: { ...(current.executionState as Record<string, unknown>), delivery } })
        .where(eq(issues.id, issueId));
    };
  }

  it("records an escalation accept when the snapshot is still current", async () => {
    const seeded = await seedCompany();
    const headSha = "a".repeat(40);
    const { issueId, stageId } = await seedPlainPendingReview(seeded, {
      maxReviewRounds: 3,
      secondStage: true,
      escalated: true,
      delivery: sameHeadDelivery(headSha),
    });
    const interaction = await seedEscalationInteraction(seeded, issueId, stageId);

    const res = await request(app(boardActor(seeded)))
      .post(`/api/issues/${issueId}/interactions/${interaction.id}/accept`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await decisionRows(issueId)).toHaveLength(1);
    expect((await issueRow(issueId)).executionState).toMatchObject({
      lastDecisionOutcome: "approved",
      delivery: sameHeadDelivery(headSha),
    });
  }, 60_000);

  it("refuses an escalation accept that would erase a same-head PR binding refreshed after the read (SUP-23260)", async () => {
    const seeded = await seedCompany();
    const headSha = "a".repeat(40);
    const { issueId, stageId } = await seedPlainPendingReview(seeded, {
      maxReviewRounds: 3,
      secondStage: true,
      escalated: true,
      delivery: sameHeadDelivery(headSha),
    });
    const interaction = await seedEscalationInteraction(seeded, issueId, stageId);
    const refreshed = {
      ...sameHeadDelivery(headSha),
      prNumber: 1117,
      prUrl: "https://github.com/TEA-Core/paperclip/pull/1117",
    };
    refreshDeliveryAfterResolve(issueId, refreshed);

    const res = await request(app(boardActor(seeded)))
      .post(`/api/issues/${issueId}/interactions/${interaction.id}/accept`)
      .send({});

    expect(lockInterleave.afterResolve).toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ code: "review_stall_policy_changed" });
    expect(await decisionRows(issueId)).toHaveLength(0);
    const row = await issueRow(issueId);
    expect(row.status).toBe("in_review");
    expect(row.executionState).toMatchObject({ status: "pending", delivery: refreshed });
  }, 60_000);

  it("refuses an escalation reject that would erase a same-head PR binding refreshed after the read (SUP-23260)", async () => {
    const seeded = await seedCompany();
    const headSha = "a".repeat(40);
    const { issueId, stageId } = await seedPlainPendingReview(seeded, {
      maxReviewRounds: 3,
      escalated: true,
      delivery: sameHeadDelivery(headSha),
    });
    const interaction = await seedEscalationInteraction(seeded, issueId, stageId);
    const refreshed = {
      ...sameHeadDelivery(headSha),
      prNumber: 1117,
      prUrl: "https://github.com/TEA-Core/paperclip/pull/1117",
    };
    refreshDeliveryAfterResolve(issueId, refreshed);

    const res = await request(app(boardActor(seeded)))
      .post(`/api/issues/${issueId}/interactions/${interaction.id}/reject`)
      .send({ reason: "Needs another round." });

    expect(lockInterleave.afterResolve).toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ code: "review_stall_policy_changed" });
    expect(await decisionRows(issueId)).toHaveLength(0);
    expect((await issueRow(issueId)).executionState).toMatchObject({ status: "pending", delivery: refreshed });
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

  it("re-applies a stored policy at routine dispatch even when its arbiter is paused, but refuses a newly written one", async () => {
    const seeded = await seedCompany();
    const issuesSvc = issueService(db);
    const policy = stallPolicy(seeded, randomUUID(), seeded.pausedId);

    await expect(
      issuesSvc.create(seeded.companyId, {
        title: "API-written policy",
        status: "todo",
        assigneeAgentId: seeded.coderId,
        responsibleUserId: seeded.userId,
        executionPolicy: policy,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "stall_arbiter_paused" } });

    const dispatched = await issuesSvc.create(seeded.companyId, {
      title: "Routine-dispatched policy",
      status: "todo",
      assigneeAgentId: seeded.coderId,
      responsibleUserId: seeded.userId,
      executionPolicy: policy,
      trustExplicitExecutionPolicy: true,
      reapplyStoredExecutionPolicy: true,
    });
    expect((await issueRow(dispatched.id)).executionPolicy).toMatchObject({
      stallEscalation: { afterRounds: 2, toAgentId: seeded.pausedId.toLowerCase() },
    });
  }, 60_000);

  it("refuses a paused arbiter on the public create route even when the policy has explicitly empty stages", async () => {
    const seeded = await seedCompany();

    const res = await request(app(boardActor(seeded)))
      .post(`/api/companies/${seeded.companyId}/issues`)
      .send({
        title: "API-written empty-stage policy",
        status: "todo",
        assigneeAgentId: seeded.coderId,
        executionPolicy: {
          stages: [],
          baseRef: "main",
          stallEscalation: { afterRounds: 2, toAgentId: seeded.pausedId },
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ code: "stall_arbiter_paused" });
    const created = await db.select({ id: issues.id }).from(issues).where(eq(issues.title, "API-written empty-stage policy"));
    expect(created).toHaveLength(0);
  }, 60_000);

  it.each(["paused", "terminated"])(
    "dispatches a routine whose stored policy names a %s arbiter, while public creates naming it stay refused (G7)",
    async (status) => {
      const seeded = await seedCompany();
      const projectId = randomUUID();
      await db.insert(projects).values({ id: projectId, companyId: seeded.companyId, name: "Stall routines", status: "in_progress" });
      const routines = routineService(db, { heartbeat: { wakeup: async () => null } as never });
      const policy = stallPolicy(seeded, randomUUID());
      const routine = await routines.create(
        seeded.companyId,
        {
          projectId,
          goalId: null,
          parentIssueId: null,
          title: "Stall routine",
          description: "Dispatch with a stored stall policy",
          assigneeAgentId: seeded.coderId,
          priority: "medium",
          status: "active",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          executionPolicy: policy as never,
          variables: [],
        },
        { userId: seeded.userId },
      );
      // The arbiter becomes unavailable after the routine stored its policy.
      await db.update(agents).set({ status }).where(eq(agents.id, seeded.arbiterId));

      const run = await routines.runRoutine(routine.id, { source: "manual" });

      expect(run.status).toBe("issue_created");
      expect((await issueRow(run.linkedIssueId!)).executionPolicy).toMatchObject({
        stallEscalation: { afterRounds: 2, toAgentId: seeded.arbiterId.toLowerCase() },
      });

      const board = app(boardActor(seeded));
      const titles = ["API policy with stages", "API policy with empty stages", "Smuggled reapply option"];
      for (const [title, executionPolicy] of [
        [titles[0], policy],
        [titles[1], { stages: [], baseRef: "main", stallEscalation: policy.stallEscalation }],
      ] as const) {
        const res = await request(board)
          .post(`/api/companies/${seeded.companyId}/issues`)
          .send({ title, status: "todo", assigneeAgentId: seeded.coderId, executionPolicy });
        expect(res.status, `${title}: ${JSON.stringify(res.body)}`).toBe(409);
      }
      // The routine-only create option is not part of the public schema.
      const smuggled = await request(board)
        .post(`/api/companies/${seeded.companyId}/issues`)
        .send({ title: titles[2], status: "todo", assigneeAgentId: seeded.coderId, executionPolicy: policy, reapplyStoredExecutionPolicy: true });
      expect(smuggled.status, JSON.stringify(smuggled.body)).toBe(400);
      expect(await db.select({ id: issues.id }).from(issues).where(inArray(issues.title, titles))).toHaveLength(0);
    },
    90_000,
  );

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
