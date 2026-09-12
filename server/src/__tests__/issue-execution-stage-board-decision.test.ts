import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping board stage-decision route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * SUP-15805: POST /issues/:id/execution-stage/board-decision — a board user
 * decides an execution stage on behalf of an unresponsive/absent agent
 * participant. The route is flag-gated (off by default), board-only, and
 * owner/admin-only; it advances (never closes) the card.
 */

const STAGE_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_STAGE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "cloud-user-1";

describeEmbeddedPostgres("POST /issues/:id/execution-stage/board-decision (SUP-15805)", () => {
  let db: Db;
  let app: express.Express;
  let currentActor: Express.Request["actor"];
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousOverrideFlag: string | undefined;

  beforeAll(async () => {
    previousOverrideFlag = process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-stage-decision-");
    db = createDb(tempDb.connectionString);
    app = createApp();
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousOverrideFlag === undefined) {
      delete process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE;
    } else {
      process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE = previousOverrideFlag;
    }
  });

  beforeEach(async () => {
    process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE = "true";
    await db.delete(issueExecutionDecisions);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  function createApp(routeOpts: Record<string, unknown> = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = currentActor;
      next();
    });
    app.use(
      "/api",
      issueRoutes(
        db,
        {} as any,
        {
          // Keep the real heartbeat service out of these route tests: a live wake
          // would create heartbeat_runs tied to the seeded agents and make per-test
          // cleanup FK-hostile. Tests that assert the wake inject a recording spy.
          executionStageWakeupEnqueue: async () => ({ id: "wakeup-stub" }),
          ...routeOpts,
        } as any,
      ),
    );
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: USER_ID,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      source: "cloud_tenant",
    } as unknown as Express.Request["actor"];
  }

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: "00000000-0000-4000-8000-000000000000",
    } as unknown as Express.Request["actor"];
  }

  interface SeedOptions {
    membershipRole?: string;
    /** Stage ids that are already decided (completed) in the seeded state. */
    completedStageIds?: string[];
    /** Seed a second, still-undecided stage on the policy. */
    twoStages?: boolean;
    /** Seed an executionState with no active pending stage (completed ladder). */
    terminalState?: boolean;
    /** Issue status to seed (defaults to in_review); use done/cancelled for terminal cases. */
    issueStatus?: string;
    /** Seed executionState as null (a ladder that never ran). */
    noExecutionState?: boolean;
    /** Seed the return assignee as this board user instead of an agent. */
    returnAssigneeUserId?: string;
  }

  async function seedIssue(opts: SeedOptions = {}) {
    const companyId = currentSeedCompanyId();
    const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
    const returnAssigneeAgentId = "44444444-4444-4444-8444-444444444444";
    const secondStageAgentId = "66666666-6666-4666-8666-666666666666";
    const issueId = "55555555-5555-4555-8555-555555555555";
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Board Decision Co",
      issuePrefix: "SUP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: USER_ID,
      status: "active",
      membershipRole: opts.membershipRole ?? "owner",
      updatedAt: now,
    });
    for (const id of [reviewerAgentId, returnAssigneeAgentId, secondStageAgentId]) {
      await db.insert(agents).values({
        id,
        companyId,
        name:
          id === reviewerAgentId
            ? "Reviewer"
            : id === returnAssigneeAgentId
              ? "Return Assignee"
              : "Second Stage Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }

    const stages = [
      {
        id: STAGE_ID,
        type: "review" as const,
        approvalsNeeded: 1,
        participants: [{ type: "agent" as const, agentId: reviewerAgentId }],
      },
      ...(opts.twoStages
        ? [
            {
              id: SECOND_STAGE_ID,
              type: "approval" as const,
              approvalsNeeded: 1,
              // Distinct from the return assignee: the selector excludes the
              // return assignee from participant selection (SUP-15805).
              participants: [{ type: "agent" as const, agentId: secondStageAgentId }],
            },
          ]
        : []),
    ];

    const returnAssigneePrincipal = opts.returnAssigneeUserId
      ? { type: "user" as const, agentId: null, userId: opts.returnAssigneeUserId }
      : { type: "agent" as const, agentId: returnAssigneeAgentId, userId: null };

    const executionState = opts.noExecutionState
      ? null
      : opts.terminalState
        ? {
            status: "completed",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: returnAssigneePrincipal,
            deliveryAuthor: null,
            completedStageIds: opts.completedStageIds ?? stages.map((s) => s.id),
            skippedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: "approved",
            changesRequestedCount: 0,
          }
        : {
            status: "pending",
            currentStageId: STAGE_ID,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
            returnAssignee: returnAssigneePrincipal,
            deliveryAuthor: null,
            completedStageIds: opts.completedStageIds ?? [],
            skippedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
            changesRequestedCount: 0,
          };

    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "SUP-15805-1",
      issueNumber: 1,
      title: "Board stage decision target",
      status: opts.issueStatus ?? "in_review",
      priority: "medium",
      assigneeAgentId: reviewerAgentId,
      createdByUserId: USER_ID,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        // A user return assignee lives on the execution state; the policy's
        // agent id wins resolution, so omit it for the user case.
        ...(opts.returnAssigneeUserId ? {} : { returnAssigneeAgentId }),
        stages,
      },
      executionState,
    });

    return { companyId, issueId, reviewerAgentId, returnAssigneeAgentId };
  }

  function currentSeedCompanyId(): string {
    // Stable per-call company id so a caller can build a boardActor(companyId).
    return `00000000-0000-4000-8000-${(seedCounter++).toString().padStart(12, "0")}`;
  }
  let seedCounter = 0;

  it("404s when the override flag is off, before any read", async () => {
    const { companyId, issueId } = await seedIssue();
    process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE = "0";
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "lgtm" });

    expect(res.status).toBe(404);
    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(0);
  });

  it("rejects an agent caller with 403", async () => {
    const { companyId, issueId, reviewerAgentId } = await seedIssue();
    currentActor = agentActor(companyId, reviewerAgentId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "lgtm" });

    // Pin Gate 1 specifically: an agent is refused by assertBoard ("Board access
    // required"), not by the owner/admin membership gate (a different message).
    // Asserting the message keeps this red if the board-only check is removed.
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Board access required");
  });

  it("rejects a board caller without owner/admin membership with 403", async () => {
    const { companyId, issueId } = await seedIssue({ membershipRole: "operator" });
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "lgtm" });

    expect(res.status).toBe(403);
  });

  it("rejects a malformed body with 400", async () => {
    const { companyId, issueId } = await seedIssue();
    currentActor = boardActor(companyId);

    const missingComment = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved" });
    expect(missingComment.status).toBe(400);

    const blankComment = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "   " });
    expect(blankComment.status).toBe(400);

    const unknownDecision = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "maybe", comment: "lgtm" });
    expect(unknownDecision.status).toBe(400);
  });

  it("409s with no_undecided_stage when every stage is already decided", async () => {
    const { companyId, issueId } = await seedIssue({ terminalState: true });
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "lgtm" });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("no_undecided_stage");
  });

  it("404s for an unknown issue id", async () => {
    const { companyId } = await seedIssue();
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/99999999-9999-4999-8999-999999999999/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "lgtm" });

    expect(res.status).toBe(404);
  });

  it("approves the active stage, records a board decision, and never closes the card", async () => {
    const { companyId, issueId, reviewerAgentId } = await seedIssue({ twoStages: true });
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "board: approving on the reviewer's behalf" });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("approved");
    expect(res.body.stageId).toBe(STAGE_ID);
    expect(res.body.stageType).toBe("review");

    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    // Advanced, not closed.
    expect(row!.status).toBe("in_review");
    expect((row!.executionState as Record<string, unknown>).completedStageIds).toContain(STAGE_ID);

    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.outcome).toBe("approved");
    expect(decisions[0]!.actorUserId).toBe(USER_ID);
    expect(decisions[0]!.actorAgentId).toBeNull();
    expect(decisions[0]!.stageId).toBe(STAGE_ID);

    const activity = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.board_stage_override"),
        ),
      );
    expect(activity).toHaveLength(1);
    expect(activity[0]!.actorId).toBe(USER_ID);

    void reviewerAgentId;
  });

  it("requests changes back to the return assignee and resets the round counter", async () => {
    const { companyId, issueId, returnAssigneeAgentId } = await seedIssue();
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "changes_requested", comment: "board: needs more error handling" });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("changes_requested");

    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    // A board hand-back lands in todo, not in_progress: the live stuck cards
    // return to an external-pull agent (wakeOnDemand false), so the card must be
    // queued rather than stranded mid-flight.
    expect(row!.status).toBe("todo");
    expect(row!.assigneeAgentId).toBe(returnAssigneeAgentId);
    const state = row!.executionState as Record<string, unknown>;
    expect(state.status).toBe("changes_requested");
    expect(state.changesRequestedCount).toBe(0);

    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.outcome).toBe("changes_requested");
    expect(decisions[0]!.actorUserId).toBe(USER_ID);
  });

  it("after a board approval, a board PATCH to done is no longer refused by the stage guard", async () => {
    const { companyId, issueId } = await seedIssue();
    currentActor = boardActor(companyId);
    const override = {
      doneTransitionOverride: {
        disposition: "upstream-equivalent-fix-no-deliverable-head",
        reason: "Tier 1",
      },
    };

    // Control: with the stage still undecided, mechanism C refuses the close.
    const refused = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        ...override,
        comment: "Closed at Tier 1 (landed, not liveness-probed): before. Liveness unverified.",
      });
    expect(refused.status, JSON.stringify(refused.body)).not.toBe(200);

    const approved = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "board: approving on the reviewer's behalf" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const closed = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        ...override,
        comment: "Closed at Tier 1 (landed, not liveness-probed): after. Liveness unverified.",
      });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(row!.status).toBe("done");
  });

  it("does not bypass the approval-status publish guard when the decision head is unresolvable", async () => {
    // No linked PR: the delivery identity cannot resolve, so the shared
    // post-decision hook must refuse to stamp publication. Existing
    // merge-arming coverage pins that refusal; this asserts the new route
    // reuses the hook rather than writing an approval status of its own.
    const { companyId, issueId } = await seedIssue();
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "board: approving on the reviewer's behalf" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [decisionRow] = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisionRow!.outcome).toBe("approved");

    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    const approvalStatus = ((row!.executionState as Record<string, unknown>).approvalStatus ??
      {}) as Record<string, unknown>;
    expect(approvalStatus.publishedHeadSha).toBeUndefined();

    // Distinguishing (SUP-15805 addendum 7): the shared hook ALWAYS writes a
    // `[Merge-arming]` system comment when it runs — armed or refused. Its
    // presence proves the route invoked the hook; `publishedHeadSha` alone is
    // also undefined when the hook never runs at all.
    const armComments = await db
      .select()
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
    expect(armComments.some((c) => c.body.startsWith("[Merge-arming]"))).toBe(true);
  });

  it("409s with terminal_status on a done issue", async () => {
    const { companyId, issueId } = await seedIssue({ issueStatus: "done" });
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "board: approving a closed card" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.reason).toBe("terminal_status");
  });

  it("409s with terminal_status on a cancelled issue", async () => {
    const { companyId, issueId } = await seedIssue({ issueStatus: "cancelled" });
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "changes_requested", comment: "board: changes on a cancelled card" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.reason).toBe("terminal_status");
  });

  it("409s with not_in_review when approving an issue with no execution state", async () => {
    const { companyId, issueId } = await seedIssue({ noExecutionState: true });
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "board: approving a ladder that never ran" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.reason).toBe("not_in_review");
  });

  it("409s with self_approval when the board user is the return assignee", async () => {
    const { companyId, issueId } = await seedIssue({ returnAssigneeUserId: USER_ID });
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "board: approving own delivery" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.reason).toBe("self_approval");

    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(0);
  });

  it("rejects a board actor with no concrete user id with 403", async () => {
    const { companyId, issueId } = await seedIssue();
    currentActor = {
      type: "board",
      companyIds: [companyId],
      source: "cloud_tenant",
    } as unknown as Express.Request["actor"];

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "board: approving" });

    expect(res.status).toBe(403);
  });

  it("enqueues the next-stage wake when a board approval advances the ladder", async () => {
    const { companyId, issueId } = await seedIssue({ twoStages: true });
    currentActor = boardActor(companyId);
    const secondStageAgentId = "66666666-6666-4666-8666-666666666666";
    const calls: Array<{ agentId: string; reason: string | null; issueId: unknown }> = [];
    const localApp = createApp({
      executionStageWakeupEnqueue: async (agentId: string, options: any) => {
        calls.push({
          agentId,
          reason: options?.reason ?? null,
          issueId: options?.payload?.issueId ?? null,
        });
        return { id: "wakeup-test" } as any;
      },
    });

    const res = await request(localApp)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "board: approving on the reviewer's behalf" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.agentId).toBe(secondStageAgentId);
    expect(calls[0]!.reason).toBe("execution_approval_requested");
    expect(calls[0]!.issueId).toBe(issueId);
  });

  it("skips a stage that already has a durable approved decision row", async () => {
    const { companyId, issueId } = await seedIssue({ twoStages: true });
    currentActor = boardActor(companyId);
    // The projection can lose completedStageIds (a board `done` PATCH clears it)
    // while the durable approved row survives. The target selector must consult
    // the row and never re-decide the stage.
    await db.insert(issueExecutionDecisions).values({
      id: "77777777-7777-4777-8777-777777777777",
      companyId,
      issueId,
      stageId: STAGE_ID,
      stageType: "review",
      actorAgentId: null,
      actorUserId: USER_ID,
      outcome: "approved",
      body: "prior board approval",
      createdByRunId: null,
    });

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "board: approving on the reviewer's behalf" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stageId).toBe(SECOND_STAGE_ID);

    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(2);
  });
});
