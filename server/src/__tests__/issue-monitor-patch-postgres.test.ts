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
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.js";
import { errorHandler } from "../middleware/error-handler.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Keep real service reads, locks and writes. Commit a reassignment after
// checkout authorization, but before the monitor update takes its row lock.
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
// Never launch adapters when a regression or mutant admits a forbidden write.
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

describePostgres("monitor PATCH persisted authorization", () => {
  let db: Db;
  let tempDb: EmbeddedPostgresTestDatabase;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-monitor-patch-");
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

  async function seed() {
    const [company] = await db.insert(companies).values({
      name: "Monitor authorization", issuePrefix: `M${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const seats = await db.insert(agents).values(["Assignee", "Successor", "Approver"].map((name) => ({
      companyId: company!.id, name, role: "engineer", status: "active", adapterType: "process",
    }))).returning();
    const [assignee, successor, approver] = seats;
    const [issue] = await db.insert(issues).values({
      companyId: company!.id, title: "Original title", status: "in_progress",
      assigneeAgentId: assignee!.id,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company!.id, agentId: assignee!.id, status: "running",
      contextSnapshot: { issueId: issue!.id },
    }).returning();
    // A running assignee already owns checkout; refusal must not be obscured
    // by the separate legacy checkout-adoption write.
    await db.update(issues).set({
      checkoutRunId: run!.id, executionRunId: run!.id, executionLockedAt: new Date(),
    }).where(eq(issues.id, issue!.id));
    const actor: Express.Request["actor"] = {
      type: "agent", agentId: assignee!.id, companyId: company!.id,
      runId: run!.id, source: "agent_jwt",
    };
    return { company: company!, issue: issue!, run: run!, successor: successor!, approver: approver!, actor };
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

  async function assertNoIssueSideEffects(issueId: string) {
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))).toEqual([]);
    expect(wakeup).not.toHaveBeenCalled();
  }

  it.each([
    { spelling: "alias", operation: "arm" }, { spelling: "alias", operation: "clear" },
    { spelling: "nested", operation: "arm" }, { spelling: "nested", operation: "clear" },
  ])("refuses a former assignee's $spelling $operation after a committed reassignment", async ({ spelling, operation }) => {
    const { issue, successor, actor } = await seed();
    if (operation === "clear") {
      await db.update(issues).set({ executionPolicy: { monitor }, monitorNextCheckAt: new Date(monitor.nextCheckAt) })
        .where(eq(issues.id, issue.id));
    }
    let reassigned: typeof issues.$inferSelect | undefined;
    interleave.afterRead = async () => {
      [reassigned] = await db.update(issues).set({ assigneeAgentId: successor.id })
        .where(eq(issues.id, issue.id)).returning();
    };
    const value = operation === "clear" ? null : monitor;
    const res = await request(await appFor(actor)).patch(`/api/issues/${issue.id}`)
      .send(spelling === "alias" ? { monitor: value } : { executionPolicy: { monitor: value } });
    expect(reassigned?.assigneeAgentId).toBe(successor.id);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details.code).toBe("issue_execution_policy_conflict");
    expect(await stored(issue.id)).toEqual(reassigned);
    await assertNoIssueSideEffects(issue.id);
  });

  it("locks an explicit nested monitor:null that equals the pre-lock snapshot", async () => {
    const { issue, successor, actor } = await seed();
    let reassigned: typeof issues.$inferSelect | undefined;
    interleave.afterRead = async () => {
      [reassigned] = await db.update(issues).set({ assigneeAgentId: successor.id })
        .where(eq(issues.id, issue.id)).returning();
    };
    const res = await request(await appFor(actor)).patch(`/api/issues/${issue.id}`)
      .send({ executionPolicy: { monitor: null } });
    expect(reassigned?.assigneeAgentId).toBe(successor.id);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details.code).toBe("issue_execution_policy_conflict");
    expect(await stored(issue.id)).toEqual(reassigned);
    await assertNoIssueSideEffects(issue.id);
  });

  it.each(["alias", "nested"])("allows the unchanged assignee to arm through %s", async (spelling) => {
    const { issue, actor } = await seed();
    const res = await request(await appFor(actor)).patch(`/api/issues/${issue.id}`)
      .send(spelling === "alias" ? { monitor } : { executionPolicy: { monitor } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await stored(issue.id)).monitorNextCheckAt).toEqual(new Date(monitor.nextCheckAt));
  });

  it.each(["done", "cancelled"])("records a future verification lost when closing as %s", async (status) => {
    const { issue, actor, run } = await seed();
    await db.update(heartbeatRuns).set({ startedAt: new Date("2026-11-04T09:00:00Z") })
      .where(eq(heartbeatRuns.id, run.id));
    await db.update(issues).set({
      deliveryRequirement: "record_only",
      executionPolicy: { monitor: { ...monitor, recoveryPolicy: "wake_owner", notes: "Verify deployment tomorrow" } },
      monitorNextCheckAt: new Date(monitor.nextCheckAt),
    }).where(eq(issues.id, issue.id));
    const res = await request(await appFor(actor)).patch(`/api/issues/${issue.id}`).send({
      status,
      comment: "Closed at Tier 2 (live): record-only probe `fixture-check` target fixture observed 2026-11-04T09:15:00Z result: pass exit 0 verification fixture accepted",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe(status);
    expect(res.body.monitorNextCheckAt).toBeNull();
    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, issue.id));
    const clears = rows.filter((row) => row.action === "issue.monitor_cleared");
    expect(clears).toHaveLength(1);
    expect(clears[0]).toMatchObject({
      actorType: "agent", actorId: actor.agentId, agentId: actor.agentId, runId: actor.runId,
      details: {
        previousNextCheckAt: monitor.nextCheckAt,
        recoveryPolicy: "wake_owner",
        reason: "cleared_by_close_future_check",
        notes: "Verify deployment tomorrow",
      },
    });
  });

  it.each(["done", "cancelled"])("clears a past-due watchdog on %s without a disposition", async (status) => {
    const { issue, actor, run } = await seed();
    await db.update(heartbeatRuns).set({ startedAt: new Date("2026-11-04T09:00:00Z") })
      .where(eq(heartbeatRuns.id, run.id));
    const nextCheckAt = "2020-01-01T00:00:00.000Z";
    await db.update(issues).set({
      deliveryRequirement: "record_only",
      executionPolicy: { monitor: { nextCheckAt, recoveryPolicy: "wake_owner" } },
      monitorNextCheckAt: new Date(nextCheckAt),
    }).where(eq(issues.id, issue.id));
    const res = await request(await appFor(actor)).patch(`/api/issues/${issue.id}`).send({
      status,
      comment: "Closed at Tier 2 (live): record-only probe `fixture-check` target fixture observed 2026-11-04T09:15:00Z result: pass exit 0 verification fixture accepted",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe(status);
    expect(res.body.monitorNextCheckAt).toBeNull();
    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, issue.id));
    const clears = rows.filter((row) => row.action === "issue.monitor_cleared");
    expect(clears).toHaveLength(1);
    expect(clears[0]!.details).toEqual({
      identifier: issue.identifier,
      previousNextCheckAt: nextCheckAt,
      reason: status,
      notes: null,
    });
  });

  it("writes one clear row when a future check is armed between the close read and the row lock", async () => {
    const { issue, actor, run } = await seed();
    await db.update(heartbeatRuns).set({ startedAt: new Date("2026-11-04T09:00:00Z") })
      .where(eq(heartbeatRuns.id, run.id));
    const pastDueCheckAt = "2020-01-01T00:00:00.000Z";
    await db.update(issues).set({
      deliveryRequirement: "record_only",
      executionPolicy: { monitor: { nextCheckAt: pastDueCheckAt, recoveryPolicy: "wake_owner" } },
      monitorNextCheckAt: new Date(pastDueCheckAt),
    }).where(eq(issues.id, issue.id));
    interleave.afterRead = async () => {
      await db.update(issues).set({
        executionPolicy: { monitor: { ...monitor, recoveryPolicy: "wake_owner" } },
        monitorNextCheckAt: new Date(monitor.nextCheckAt),
      }).where(eq(issues.id, issue.id));
    };
    const res = await request(await appFor(actor)).patch(`/api/issues/${issue.id}`).send({
      status: "done",
      comment: "Closed at Tier 2 (live): record-only probe `fixture-check` target fixture observed 2026-11-04T09:15:00Z result: pass exit 0 verification fixture accepted",
    });
    const clears = (await db.select().from(activityLog).where(eq(activityLog.entityId, issue.id)))
      .filter((row) => row.action === "issue.monitor_cleared");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.monitorNextCheckAt).toBeNull();
    expect(clears).toHaveLength(1);
    expect(clears[0]!.details).toMatchObject({
      previousNextCheckAt: monitor.nextCheckAt,
      reason: "cleared_by_close_future_check",
    });
  });

  it("records a future verification lost when a review approval comment closes the issue", async () => {
    const { issue, approver } = await seed();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: approver.id,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
      deliveryRequirement: "record_only",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "agent", agentId: approver.id }] }],
        monitor: { ...monitor, recoveryPolicy: "wake_owner", notes: "Verify deployment tomorrow" },
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: approver.id },
        returnAssignee: { type: "agent", agentId: issue.assigneeAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
      monitorNextCheckAt: new Date(monitor.nextCheckAt),
    }).where(eq(issues.id, issue.id));
    const [approverRun] = await db.insert(heartbeatRuns).values({
      companyId: issue.companyId, agentId: approver.id, status: "running",
      startedAt: new Date("2026-11-04T09:00:00Z"), contextSnapshot: { issueId: issue.id },
    }).returning();
    const approverActor: Express.Request["actor"] = {
      type: "agent", agentId: approver.id, companyId: issue.companyId,
      runId: approverRun!.id, source: "agent_jwt",
    };
    const res = await request(await appFor(approverActor)).post(`/api/issues/${issue.id}/comments`).send({
      body: "## Review: APPROVED\n\nClosed at Tier 2 (live): record-only probe `fixture-check` target fixture observed 2026-11-04T09:15:00Z result: pass exit 0 verification fixture accepted",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const closed = await stored(issue.id);
    expect(closed.status).toBe("done");
    expect(closed.monitorNextCheckAt).toBeNull();
    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, issue.id));
    const clears = rows.filter((row) => row.action === "issue.monitor_cleared");
    expect(clears).toHaveLength(1);
    expect(clears[0]).toMatchObject({
      actorType: "agent", actorId: approver.id, agentId: approver.id, runId: approverRun!.id,
      details: {
        previousNextCheckAt: monitor.nextCheckAt,
        recoveryPolicy: "wake_owner",
        reason: "cleared_by_close_future_check",
        notes: "Verify deployment tomorrow",
      },
    });
  });

  it.each([
    { label: "future", nextCheckAt: monitor.nextCheckAt, recorded: true },
    { label: "past-due", nextCheckAt: "2020-01-01T00:00:00.000Z", recorded: false },
  ])("service callers that close with a $label monitor record only a lost future check", async ({ nextCheckAt, recorded }) => {
    const { issue } = await seed();
    const policy = normalizeIssueExecutionPolicy({ monitor: { nextCheckAt, recoveryPolicy: "wake_owner" } });
    await db.update(issues).set({
      executionPolicy: policy ? { ...policy } : null,
      monitorNextCheckAt: new Date(nextCheckAt),
    }).where(eq(issues.id, issue.id));
    const current = await stored(issue.id);
    const transition = applyIssueExecutionPolicyTransition({
      issue: current,
      policy: normalizeIssueExecutionPolicy(current.executionPolicy ?? null),
      requestedStatus: "cancelled",
      requestedAssigneePatch: {},
      actor: { agentId: null, userId: "board-user" },
    });
    const updated = await issueService(db).update(issue.id, {
      ...transition.patch,
      status: "cancelled",
      actorUserId: "board-user",
    });
    expect(updated?.status).toBe("cancelled");
    expect(updated?.monitorNextCheckAt).toBeNull();
    const clears = (await db.select().from(activityLog).where(eq(activityLog.entityId, issue.id)))
      .filter((row) => row.action === "issue.monitor_cleared");
    if (!recorded) {
      expect(clears).toEqual([]);
      return;
    }
    expect(clears).toHaveLength(1);
    expect(clears[0]).toMatchObject({
      actorType: "user", actorId: "board-user", agentId: null, runId: null,
      details: {
        previousNextCheckAt: nextCheckAt,
        recoveryPolicy: "wake_owner",
        reason: "cleared_by_close_future_check",
      },
    });
  });

  it.each([
    { principal: "board", spelling: "alias", value: monitor },
    { principal: "board", spelling: "alias", value: null },
    { principal: "board", spelling: "nested", value: null },
    { principal: "board", spelling: "title-only", value: null },
    { principal: "agent", spelling: "alias", value: monitor },
    { principal: "agent", spelling: "alias", value: null },
    { principal: "agent", spelling: "nested", value: null },
    { principal: "agent", spelling: "title-only", value: null },
  ])("$principal $spelling PATCH refuses release-assurance changes without committing anything", async ({ principal, spelling, value }) => {
    const { company, issue, actor, approver } = await seed();
    await db.update(issues).set({
      executionPolicy: {
        approvalAuthority: "release_assurance",
        stages: [{ id: randomUUID(), type: "approval", approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: approver.id }] }],
        monitor,
      },
      monitorNextCheckAt: new Date(monitor.nextCheckAt),
    }).where(eq(issues.id, issue.id));
    const before = await stored(issue.id);
    const runsBefore = await db.select().from(heartbeatRuns);
    const caller: Express.Request["actor"] = principal === "agent" ? actor : {
      type: "board", userId: "local-board", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false,
    };
    const res = await request(await appFor(caller)).patch(`/api/issues/${issue.id}`).send({
      title: "Must not commit",
      ...(spelling === "title-only" ? {} : { comment: "Must not commit" }),
      ...(spelling === "alias" ? { monitor: value }
        : spelling === "nested" ? { executionPolicy: { monitor: value } } : {}),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("release_assurance");
    expect(await stored(issue.id)).toEqual(before);
    await assertNoIssueSideEffects(issue.id);
    expect(await db.select().from(heartbeatRuns)).toEqual(runsBefore);
  });

  it("enforces the run cap for an alias-only agent PATCH", async () => {
    const { company, issue, run, actor } = await seed();
    const [source] = await db.insert(issues).values({ companyId: company.id, title: "Run source" }).returning();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: source!.id } }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(activityLog).values(Array.from({ length: 20 }, () => ({
      companyId: company.id, actorType: "agent", actorId: actor.agentId!, agentId: actor.agentId!,
      runId: run.id, action: "issue.cross_issue_influence_observed", entityType: "issue", entityId: issue.id,
    })));
    const before = await stored(issue.id);
    const res = await request(await appFor(actor)).patch(`/api/issues/${issue.id}`).send({ monitor });
    expect(res.status, JSON.stringify(res.body)).toBe(429);
    expect(await stored(issue.id)).toEqual(before);
    const audit = await db.select().from(activityLog).where(eq(activityLog.runId, run.id));
    expect(audit.filter((row) => row.action === "issue.cross_issue_influence_cap_rejected")).toHaveLength(1);
  });
});
