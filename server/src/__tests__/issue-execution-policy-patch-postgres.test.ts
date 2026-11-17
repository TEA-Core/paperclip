import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, companies, createDb, executionWorkspaces,
  heartbeatRunEvents, heartbeatRuns, issueComments, issues, projects,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type * as IssueServiceModule from "../services/issues.js";
import type * as HeartbeatModule from "../services/heartbeat.js";
import type { EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import { errorHandler } from "../middleware/error-handler.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Keep the real service reads, locks and writes. The hook commits a concurrent
// write after the PATCH read its request snapshot (checkout authorization runs
// after that read) and before the update takes its row lock.
const interleave = vi.hoisted(() => ({ afterRead: null as null | (() => Promise<void>) }));
const wakeup = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../services/issues.js", async (importOriginal) => {
  const actual = await importOriginal<typeof IssueServiceModule>();
  return {
    ...actual,
    issueService: (...args: Parameters<typeof actual.issueService>) => {
      const service = actual.issueService(...args);
      return {
        ...service,
        assertCheckoutOwner: async (...readArgs: Parameters<typeof service.assertCheckoutOwner>) => {
          const row = await service.assertCheckoutOwner(...readArgs);
          const hook = interleave.afterRead;
          interleave.afterRead = null;
          await hook?.();
          return row;
        },
      };
    },
  };
});
vi.mock("../services/issue-assignment-wakeup.js", () => ({ queueIssueAssignmentWakeup: vi.fn() }));
// Never launch adapters when a regression admits a write.
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof HeartbeatModule>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
      ...actual.heartbeatService(...args), wakeup,
    }),
  };
});

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const monitor = { nextCheckAt: "2099-12-01T12:00:00.000Z" };

interface ReviewStage {
  id: string;
  type: "review";
  phase: "pre_merge";
  approvalsNeeded: 1;
  participants: Array<{ id: string; type: "agent"; agentId: string; userId: null }>;
}

function reviewStage(agentId: string): ReviewStage {
  return {
    id: randomUUID(), type: "review", phase: "pre_merge", approvalsNeeded: 1,
    participants: [{ id: randomUUID(), type: "agent", agentId, userId: null }],
  };
}

function ladder(stages: ReviewStage[]) {
  return { mode: "normal", commentRequired: true, stages };
}

describePostgres("issue PATCH executionPolicy persisted shape and stale-write fence", () => {
  let db: Db;
  let tempDb: EmbeddedPostgresTestDatabase;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-policy-patch-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterEach(async () => {
    interleave.afterRead = null;
    wakeup.mockClear();
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => tempDb?.cleanup());

  async function seed(executionPolicy: Record<string, unknown> | null, extra: Partial<typeof issues.$inferInsert> = {}) {
    const [company] = await db.insert(companies).values({
      name: "Policy PATCH", issuePrefix: `P${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const seats = await db.insert(agents).values(["Assignee", "ReviewerA", "ReviewerB", "ReviewerC"].map((name) => ({
      companyId: company!.id, name, role: "engineer", status: "active", adapterType: "process",
    }))).returning();
    const [assignee, reviewerA, reviewerB, reviewerC] = seats;
    const [issue] = await db.insert(issues).values({
      companyId: company!.id, title: "Policy PATCH", status: "in_progress",
      assigneeAgentId: assignee!.id, executionPolicy, ...extra,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company!.id, agentId: assignee!.id, status: "running",
      contextSnapshot: { issueId: issue!.id },
    }).returning();
    await db.update(issues).set({
      checkoutRunId: run!.id, executionRunId: run!.id, executionLockedAt: new Date(),
    }).where(eq(issues.id, issue!.id));
    const actor: Express.Request["actor"] = {
      type: "agent", agentId: assignee!.id, companyId: company!.id,
      runId: run!.id, source: "agent_jwt",
    };
    return { issue: issue!, actor, reviewerA: reviewerA!, reviewerB: reviewerB!, reviewerC: reviewerC! };
  }

  async function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  async function stored(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
  }

  // F1: a legacy monitor-only row has no `stages` key. Clearing its monitor
  // must leave a null policy, as before explicit-empty preservation existed.
  it.each(["alias", "nested"])("clears a legacy stage-less monitor policy to null through the %s spelling", async (spelling) => {
    const { issue, actor } = await seed({ monitor }, { monitorNextCheckAt: new Date(monitor.nextCheckAt) });
    const res = await request(await appFor(actor)).patch(`/api/issues/${issue.id}`)
      .send(spelling === "alias" ? { monitor: null } : { executionPolicy: { monitor: null } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await stored(issue.id);
    expect(row.executionPolicy).toBeNull();
    expect(row.monitorNextCheckAt).toBeNull();
  });

  // A row that stores `stages: []` explicitly keeps that "no ladder" shape
  // when its monitor is cleared.
  it("keeps an explicit stages:[] policy stage-less when its monitor is cleared", async () => {
    const { issue, actor } = await seed(
      { mode: "normal", commentRequired: true, stages: [], monitor },
      { monitorNextCheckAt: new Date(monitor.nextCheckAt) },
    );
    const res = await request(await appFor(actor)).patch(`/api/issues/${issue.id}`)
      .send({ executionPolicy: { monitor: null } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await stored(issue.id)).executionPolicy).toEqual({ mode: "normal", commentRequired: true, stages: [] });
  });

  // The service keeps a stage-less policy only when the incoming object AND
  // the stored row both carry a raw `stages: []`.
  it.each([
    { stored: "explicit-empty", incoming: "explicit-empty", expected: "explicit-empty" },
    { stored: "explicit-empty", incoming: "stages-omitted", expected: null },
    { stored: "ladder", incoming: "explicit-empty", expected: null },
    { stored: "legacy-monitor", incoming: "explicit-empty", expected: null },
  ])("service update with a $stored row and a $incoming write stores $expected", async ({ stored: storedShape, incoming, expected }) => {
    const { issue, reviewerA } = await seed(null);
    const explicitEmpty = { mode: "normal", commentRequired: true, stages: [] };
    const storedPolicy = storedShape === "explicit-empty" ? explicitEmpty
      : storedShape === "ladder" ? ladder([reviewStage(reviewerA.id)])
      : { monitor };
    await db.update(issues).set({ executionPolicy: storedPolicy }).where(eq(issues.id, issue.id));
    const incomingPolicy = incoming === "explicit-empty" ? explicitEmpty : { mode: "normal", commentRequired: true };
    await issueService(db).update(issue.id, { executionPolicy: incomingPolicy });
    expect((await stored(issue.id)).executionPolicy).toEqual(expected === null ? null : explicitEmpty);
  });

  // F2: an explicit stage-less policy with no other content carries nothing
  // the null guard protects, so a null PATCH clears it.
  it("accepts executionPolicy:null over an explicit stage-less policy with no content", async () => {
    const { issue, actor } = await seed({ mode: "normal", commentRequired: true, stages: [] });
    const res = await request(await appFor(actor)).patch(`/api/issues/${issue.id}`)
      .send({ executionPolicy: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await stored(issue.id)).executionPolicy).toBeNull();
  });

  it("still refuses executionPolicy:null over a stage-less policy that carries a monitor", async () => {
    const { issue, actor } = await seed(
      { mode: "normal", commentRequired: true, stages: [], monitor },
      { monitorNextCheckAt: new Date(monitor.nextCheckAt) },
    );
    const before = await stored(issue.id);
    const res = await request(await appFor(actor)).patch(`/api/issues/${issue.id}`)
      .send({ executionPolicy: null });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("executionPolicy must not be set to null");
    expect(await stored(issue.id)).toEqual(before);
  });

  // F3: a stage-less partial policy PATCH carries the stored ladder forward.
  // When the ladder changes after the request snapshot, the PATCH must not
  // write the older ladder back.
  it("refuses a stages-omitted policy PATCH when the ladder changed before the update lock", async () => {
    const seeded = await seed(null);
    const { issue, actor, reviewerA, reviewerB } = seeded;
    await db.update(issues).set({ executionPolicy: ladder([reviewStage(reviewerA.id)]) }).where(eq(issues.id, issue.id));
    let concurrent: typeof issues.$inferSelect | undefined;
    interleave.afterRead = async () => {
      [concurrent] = await db.update(issues).set({ executionPolicy: ladder([reviewStage(reviewerB.id)]) })
        .where(eq(issues.id, issue.id)).returning();
    };
    const res = await request(await appFor(actor)).patch(`/api/issues/${issue.id}`)
      .send({ executionPolicy: { mode: "normal", commentRequired: true } });
    expect(concurrent).toBeDefined();
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details.code).toBe("execution_policy_stale");
    expect(await stored(issue.id)).toEqual(concurrent);
  });

  it("keeps the stored ladder for a stages-omitted policy PATCH without a concurrent change", async () => {
    const { issue, actor, reviewerA } = await seed(null);
    const storedLadder = ladder([reviewStage(reviewerA.id)]);
    await db.update(issues).set({ executionPolicy: storedLadder }).where(eq(issues.id, issue.id));
    const res = await request(await appFor(actor)).patch(`/api/issues/${issue.id}`)
      .send({ executionPolicy: { mode: "normal", commentRequired: true, baseRef: "release-base" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await stored(issue.id)).executionPolicy).toEqual({ ...storedLadder, baseRef: "release-base" });
  });

  // A stages-omitted write cannot insert a stage, so the request-time check
  // skips INV-LADDER-1; the locked re-check must skip it too, even for a row
  // whose stored pointer halves disagree.
  it("does not run INV-LADDER-1 under the lock for a stages-omitted policy PATCH", async () => {
    const { issue, actor, reviewerA, reviewerB } = await seed(null);
    const s1 = reviewStage(reviewerA.id);
    const s2 = reviewStage(reviewerB.id);
    const storedLadder = ladder([s1, s2]);
    await db.update(issues).set({
      executionPolicy: storedLadder,
      executionState: {
        status: "pending", currentStageId: s1.id, currentStageIndex: 1, currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerA.id },
        returnAssignee: { type: "agent", agentId: actor.agentId },
        completedStageIds: [], skippedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, issue.id));
    const res = await request(await appFor(actor)).patch(`/api/issues/${issue.id}`)
      .send({ executionPolicy: { mode: "normal", commentRequired: true, baseRef: "release-base" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await stored(issue.id)).executionPolicy).toEqual({ ...storedLadder, baseRef: "release-base" });
  });

  it("refuses executionPolicy:null when a ladder was installed before the update lock", async () => {
    const { issue, actor, reviewerB } = await seed(null);
    let concurrent: typeof issues.$inferSelect | undefined;
    interleave.afterRead = async () => {
      [concurrent] = await db.update(issues).set({ executionPolicy: ladder([reviewStage(reviewerB.id)]) })
        .where(eq(issues.id, issue.id)).returning();
    };
    const res = await request(await appFor(actor)).patch(`/api/issues/${issue.id}`)
      .send({ executionPolicy: null });
    expect(concurrent).toBeDefined();
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details.code).toBe("execution_policy_stale");
    expect(await stored(issue.id)).toEqual(concurrent);
  });

  // Test gap (SUP-16525 INV-LADDER-1 under the lock): the stored policy is
  // unchanged, so the stale check passes, but the live pointer advanced after
  // the request snapshot. A stage that was ahead of the old pointer is now
  // behind the new one, and the locked re-validation must refuse it.
  it("refuses a stage insert that the live pointer passed before the update lock", async () => {
    const { issue, actor, reviewerA, reviewerB, reviewerC } = await seed(null);
    const s1 = reviewStage(reviewerA.id);
    const s2 = reviewStage(reviewerB.id);
    const inserted = reviewStage(reviewerC.id);
    const pointer = (stage: ReviewStage, index: number, completedStageIds: string[]) => ({
      status: "pending", currentStageId: stage.id, currentStageIndex: index, currentStageType: "review",
      currentParticipant: { type: "agent", agentId: stage.participants[0]!.agentId },
      returnAssignee: { type: "agent", agentId: actor.agentId },
      completedStageIds, skippedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
    });
    await db.update(issues).set({ executionPolicy: ladder([s1, s2]), executionState: pointer(s1, 0, []) })
      .where(eq(issues.id, issue.id));
    let advanced: typeof issues.$inferSelect | undefined;
    interleave.afterRead = async () => {
      [advanced] = await db.update(issues).set({ executionState: pointer(s2, 1, [s1.id]) })
        .where(eq(issues.id, issue.id)).returning();
    };
    const res = await request(await appFor(actor)).patch(`/api/issues/${issue.id}`)
      .send({ executionPolicy: ladder([s1, inserted, s2]) });
    expect(advanced).toBeDefined();
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "execution_policy_stage_inserted_behind_pointer",
      offendingStageId: inserted.id,
      currentStageId: s2.id,
    });
    expect(await stored(issue.id)).toEqual(advanced);
  });

  // The locked re-check also refuses a stage-less write when the locked row
  // carries a live pointer: the resolved policy cannot hold that stage.
  it("refuses a stage-less policy PATCH when the locked row carries a live pointer", async () => {
    const { issue, actor, reviewerA } = await seed({ mode: "normal", commentRequired: true, stages: [] });
    const orphanStageId = randomUUID();
    let armed: typeof issues.$inferSelect | undefined;
    interleave.afterRead = async () => {
      [armed] = await db.update(issues).set({
        executionState: {
          status: "pending", currentStageId: orphanStageId, currentStageIndex: 0, currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerA.id },
          returnAssignee: { type: "agent", agentId: actor.agentId },
          completedStageIds: [], skippedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
        },
      }).where(eq(issues.id, issue.id)).returning();
    };
    const res = await request(await appFor(actor)).patch(`/api/issues/${issue.id}`)
      .send({ executionPolicy: { mode: "normal", commentRequired: true, stages: [] } });
    expect(armed).toBeDefined();
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "execution_policy_current_stage_removed",
      currentStageId: orphanStageId,
    });
    expect(await stored(issue.id)).toEqual(armed);
  });
});
