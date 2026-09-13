import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
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
    // activity_log.run_id references heartbeat_runs WITHOUT a delete rule, so the
    // activity must go before any seeded run (the provenance test seeds one).
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
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

  function boardActor(companyId: string, overrides: Record<string, unknown> = {}): Express.Request["actor"] {
    return {
      type: "board",
      userId: USER_ID,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      source: "cloud_tenant",
      ...overrides,
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
    /** Seed no return assignee at all (a ladder with no recorded owner). */
    nullReturnAssignee?: boolean;
    /** Seed a delivery-author user, distinct from the return assignee. */
    deliveryAuthorUserId?: string;
    /** Seed a changes_requested card parked on this current stage (A2: current-stage precedence). */
    changesRequestedStageId?: string;
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

    const returnAssigneePrincipal = opts.nullReturnAssignee
      ? null
      : opts.returnAssigneeUserId
        ? { type: "user" as const, agentId: null, userId: opts.returnAssigneeUserId }
        : { type: "agent" as const, agentId: returnAssigneeAgentId, userId: null };

    const changesRequestedStage = opts.changesRequestedStageId
      ? stages.find((s) => s.id === opts.changesRequestedStageId) ?? null
      : null;
    const changesRequestedParticipant = changesRequestedStage?.participants[0] ?? null;

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
        : changesRequestedStage
          ? {
            status: "changes_requested",
            currentStageId: changesRequestedStage.id,
            currentStageIndex: stages.indexOf(changesRequestedStage),
            currentStageType: changesRequestedStage.type,
            currentParticipant: {
              type: changesRequestedParticipant?.userId ? "user" : "agent",
              agentId: changesRequestedParticipant?.agentId ?? null,
              userId: changesRequestedParticipant?.userId ?? null,
            },
            returnAssignee: returnAssigneePrincipal,
            deliveryAuthor: null,
            completedStageIds: opts.completedStageIds ?? [],
            skippedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: "changes_requested",
            changesRequestedCount: 1,
          }
          : {
            status: "pending",
            currentStageId: STAGE_ID,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
            returnAssignee: returnAssigneePrincipal,
            deliveryAuthor: opts.deliveryAuthorUserId
              ? { type: "user", agentId: null, userId: opts.deliveryAuthorUserId }
              : null,
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
        // agent id wins resolution, so omit it for the user case (and when no
        // return assignee is seeded at all).
        ...(opts.returnAssigneeUserId || opts.nullReturnAssignee ? {} : { returnAssigneeAgentId }),
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

  it("A1: prunes a completed-stage id that no longer maps to a policy stage on a board decision", async () => {
    // A policy revision can drop a stage that a live card still carries in
    // completedStageIds. Board-decision must not re-persist that orphan id.
    const orphanStageId = "aaaa0000-0000-4000-8000-0000000000a1";
    const { companyId, issueId } = await seedIssue({ completedStageIds: [orphanStageId] });
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "board: approving the active stage" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    const persisted = (row!.executionState as Record<string, unknown>).completedStageIds as string[];
    expect(persisted).toContain(STAGE_ID);
    expect(persisted).not.toContain(orphanStageId);
  });

  it("A2: targets the changes_requested current stage, not an earlier still-undecided stage", async () => {
    // A policy revision inserted a stage ahead of the bounced card's current
    // stage. currentStageId is the LATER stage; the earlier stage is still
    // undecided. The board decision must write to the CURRENT stage, not the
    // first undecided one.
    const { companyId, issueId } = await seedIssue({
      twoStages: true,
      changesRequestedStageId: SECOND_STAGE_ID,
    });
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "board: approve the current stage" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stageId).toBe(SECOND_STAGE_ID);
    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.stageId).toBe(SECOND_STAGE_ID);
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

    // A board decision is NOT a closing transition. The shared hook's CLOSE
    // refusal signal (keyed by the done-close-landing backstop) must not be
    // written: flipping `closingTransition: false` to true in the route would
    // record `issue.merge_arming_refused_on_close` here and go red.
    const refusalActivity = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.merge_arming_refused_on_close"),
        ),
      );
    expect(refusalActivity).toHaveLength(0);
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
    // B1: a concrete-user 403 must commit ZERO decision/comment/activity rows.
    // This pins "no committed write after the 403" (the guard sits before the
    // commit boundary); it does not — and cannot — assert the read phase is empty.
    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(0);
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
    const activity = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.board_stage_override"),
        ),
      );
    expect(activity).toHaveLength(0);
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

  it("wakes the return assignee when a board decision requests changes", async () => {
    const { companyId, issueId, returnAssigneeAgentId } = await seedIssue();
    currentActor = boardActor(companyId);
    const calls: Array<{ agentId: string; reason: string | null }> = [];
    const localApp = createApp({
      executionStageWakeupEnqueue: async (agentId: string, options: any) => {
        calls.push({ agentId, reason: options?.reason ?? null });
        return { id: "wakeup-test" } as any;
      },
    });

    const res = await request(localApp)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "changes_requested", comment: "board: needs more error handling" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.agentId).toBe(returnAssigneeAgentId);
    expect(calls[0]!.reason).toBe("execution_changes_requested");
  });

  it("wakes the resolved return assignee when a board approval completes the final stage", async () => {
    const { companyId, issueId, returnAssigneeAgentId, reviewerAgentId } = await seedIssue();
    currentActor = boardActor(companyId);
    const calls: Array<{ agentId: string; reason: string | null; payload: any; contextSnapshot: any }> = [];
    const localApp = createApp({
      executionStageWakeupEnqueue: async (agentId: string, options: any) => {
        calls.push({
          agentId,
          reason: options?.reason ?? null,
          payload: options?.payload ?? {},
          contextSnapshot: options?.contextSnapshot ?? {},
        });
        return { id: "wakeup-test" } as any;
      },
    });

    const res = await request(localApp)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "board: final stage approved" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // The ladder completed, so no execution-stage wake exists. The handback must
    // still tell the resolved return assignee the card is theirs again — not the
    // displaced reviewer the board decided against.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.agentId).toBe(returnAssigneeAgentId);
    expect(calls[0]!.agentId).not.toBe(reviewerAgentId);
    expect(calls[0]!.reason).toBe("issue_assigned");
    expect(calls[0]!.payload.commentId).toBe(res.body.commentId);
    expect(calls[0]!.contextSnapshot.commentId).toBe(res.body.commentId);
  });

  it("clears the assignee and enqueues no wake when the final stage has no return assignee", async () => {
    const { companyId, issueId } = await seedIssue({ nullReturnAssignee: true });
    currentActor = boardActor(companyId);
    const calls: unknown[] = [];
    const localApp = createApp({
      executionStageWakeupEnqueue: async (agentId: string, options: any) => {
        calls.push({ agentId, options });
        return { id: "wakeup-test" } as any;
      },
    });

    const res = await request(localApp)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "board: final stage approved, no owner" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    // No return assignee: the card is queued (`todo`) with the assignee cleared
    // rather than left `in_progress` on the displaced reviewer the board decided
    // against (and cannot be `in_progress` with no assignee).
    expect(row!.status).toBe("todo");
    expect(row!.assigneeAgentId).toBeNull();
    expect(row!.assigneeUserId).toBeNull();
    // No assignee to wake: the route must not enqueue a wake for a null agent.
    expect(calls).toHaveLength(0);
  });

  it("rolls back the decision and the transition when the audit comment write fails", async () => {
    const { companyId, issueId, reviewerAgentId } = await seedIssue();
    currentActor = boardActor(companyId);
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION paperclip_test_fail_board_comment()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RAISE EXCEPTION 'forced board-decision comment failure';
      END
      $function$;
      CREATE TRIGGER paperclip_test_fail_board_comment
      BEFORE INSERT ON issue_comments
      FOR EACH ROW EXECUTE FUNCTION paperclip_test_fail_board_comment();
    `));
    try {
      const res = await request(app)
        .post(`/api/issues/${issueId}/execution-stage/board-decision`)
        .send({ decision: "approved", comment: "board: approving on the reviewer's behalf" });
      expect(res.status).toBe(500);
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS paperclip_test_fail_board_comment ON issue_comments;
        DROP FUNCTION IF EXISTS paperclip_test_fail_board_comment();
      `));
    }

    // The comment shares the decision's transaction: a failed comment must leave
    // neither the decision row nor the transition committed (no half-written audit).
    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(0);

    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(row!.status).toBe("in_review");
    expect(row!.assigneeAgentId).toBe(reviewerAgentId);
    expect((row!.executionState as Record<string, unknown>).completedStageIds).not.toContain(STAGE_ID);
  });

  it("records the concrete board user and run on the decision, comment, activity, and wake", async () => {
    const { companyId, issueId, reviewerAgentId, returnAssigneeAgentId } = await seedIssue();
    const runId = "88888888-8888-4888-8888-888888888888";
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: reviewerAgentId });
    currentActor = boardActor(companyId, { runId });
    const calls: Array<{ agentId: string; options: any }> = [];
    const localApp = createApp({
      executionStageWakeupEnqueue: async (agentId: string, options: any) => {
        calls.push({ agentId, options });
        return { id: "wakeup-test" } as any;
      },
    });

    const res = await request(localApp)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "changes_requested", comment: "board: needs more error handling" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const commentId = res.body.commentId as string;

    const [decisionRow] = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisionRow!.actorUserId).toBe(USER_ID);
    expect(decisionRow!.actorAgentId).toBeNull();
    expect(decisionRow!.createdByRunId).toBe(runId);

    const [commentRow] = await db.select().from(issueComments).where(eq(issueComments.id, commentId));
    expect(commentRow!.authorUserId).toBe(USER_ID);
    expect(commentRow!.authorAgentId).toBeNull();
    expect(commentRow!.createdByRunId).toBe(runId);

    const [activityRow] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.board_stage_override")));
    expect(activityRow!.actorId).toBe(USER_ID);
    expect(activityRow!.runId).toBe(runId);
    expect((activityRow!.details as Record<string, unknown>).commentId).toBe(commentId);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.agentId).toBe(returnAssigneeAgentId);
    expect(calls[0]!.options.requestedByActorType).toBe("user");
    expect(calls[0]!.options.requestedByActorId).toBe(USER_ID);
    expect(calls[0]!.options.payload.runId).toBe(runId);
    expect(calls[0]!.options.contextSnapshot.runId).toBe(runId);
  });

  it("serializes concurrent board decisions so each targets a distinct stage", async () => {
    const { companyId, issueId } = await seedIssue({ twoStages: true });
    currentActor = boardActor(companyId);
    const advisoryLockKey = 917460186;
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION paperclip_test_pause_board_decision()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        PERFORM pg_advisory_xact_lock(${advisoryLockKey});
        PERFORM pg_sleep(1);
        RETURN NEW;
      END
      $function$;
      CREATE TRIGGER paperclip_test_pause_board_decision
      BEFORE INSERT ON issue_execution_decisions
      FOR EACH ROW EXECUTE FUNCTION paperclip_test_pause_board_decision();
    `));
    try {
      const [first, second] = await Promise.all([
        request(app)
          .post(`/api/issues/${issueId}/execution-stage/board-decision`)
          .send({ decision: "approved", comment: "board: concurrent A" }),
        request(app)
          .post(`/api/issues/${issueId}/execution-stage/board-decision`)
          .send({ decision: "approved", comment: "board: concurrent B" }),
      ]);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(second.status, JSON.stringify(second.body)).toBe(200);
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS paperclip_test_pause_board_decision ON issue_execution_decisions;
        DROP FUNCTION IF EXISTS paperclip_test_pause_board_decision();
      `));
    }

    // The row lock (`.for("update")`) forces the losing decision to re-read the
    // committed state; it must therefore resolve the NEXT undecided stage instead
    // of double-deciding the first. Removing the lock lets both target STAGE_ID
    // and this collapses to a single distinct stage.
    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(2);
    expect(new Set(decisions.map((decision) => decision.stageId)).size).toBe(2);
  });

  it("409s with self_approval when the return assignee is an agent but the board user is the delivery author", async () => {
    const { companyId, issueId } = await seedIssue({ deliveryAuthorUserId: USER_ID });
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "board: approving own delivery via the delivery author" });

    // `returnAssignee` is an agent, so Guard B's first-match cascade would stop
    // there and never consult the delivery-author user. The union guard the board
    // path calls must still refuse the board user who is the delivery author.
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.reason).toBe("self_approval");

    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(0);
  });

  it("targets a stage whose latest verdict is changes_requested (not its stale approved row)", async () => {
    const { companyId, issueId } = await seedIssue();
    currentActor = boardActor(companyId);
    // STAGE_ID was approved then bounced: two durable rows with the LATEST being
    // changes_requested, and the projection cleared. Before the fix the stale
    // approved row marked the stage decided, so the board was refused with 409
    // no_undecided_stage; the latest verdict must win.
    await db.insert(issueExecutionDecisions).values([
      {
        id: "b1000000-0000-4000-8000-000000000001",
        companyId,
        issueId,
        stageId: STAGE_ID,
        stageType: "review",
        actorAgentId: null,
        actorUserId: USER_ID,
        outcome: "approved",
        body: "prior approval",
        createdByRunId: null,
        createdAt: new Date("2026-09-01T00:00:00Z"),
      },
      {
        id: "b1000000-0000-4000-8000-000000000002",
        companyId,
        issueId,
        stageId: STAGE_ID,
        stageType: "review",
        actorAgentId: null,
        actorUserId: USER_ID,
        outcome: "changes_requested",
        body: "later bounce",
        createdByRunId: null,
        createdAt: new Date("2026-09-01T01:00:00Z"),
      },
    ]);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "board: re-decide the bounced stage" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stageId).toBe(STAGE_ID);
  });

  it("does not restore a bounced stage into completedStageIds when the board approves the next stage", async () => {
    const { companyId, issueId } = await seedIssue({ twoStages: true });
    currentActor = boardActor(companyId);
    // STAGE_ID's latest verdict is changes_requested (approved then bounced) and
    // the card sits at the later approval stage. Approving that stage must not
    // restore the bounced STAGE_ID into completedStageIds.
    await db.insert(issueExecutionDecisions).values([
      {
        id: "b2000000-0000-4000-8000-000000000001",
        companyId,
        issueId,
        stageId: STAGE_ID,
        stageType: "review",
        actorAgentId: null,
        actorUserId: USER_ID,
        outcome: "approved",
        body: "prior approval",
        createdByRunId: null,
        createdAt: new Date("2026-09-01T00:00:00Z"),
      },
      {
        id: "b2000000-0000-4000-8000-000000000002",
        companyId,
        issueId,
        stageId: STAGE_ID,
        stageType: "review",
        actorAgentId: null,
        actorUserId: USER_ID,
        outcome: "changes_requested",
        body: "later bounce",
        createdByRunId: null,
        createdAt: new Date("2026-09-01T01:00:00Z"),
      },
    ]);
    await db
      .update(issues)
      .set({
        executionState: {
          status: "pending",
          currentStageId: SECOND_STAGE_ID,
          currentStageIndex: 1,
          currentStageType: "approval",
          currentParticipant: { type: "agent", agentId: "66666666-6666-4666-8666-666666666666", userId: null },
          returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444", userId: null },
          deliveryAuthor: null,
          completedStageIds: [],
          skippedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: "changes_requested",
          changesRequestedCount: 0,
        },
      })
      .where(eq(issues.id, issueId));

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "board: approve the approval stage" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stageId).toBe(SECOND_STAGE_ID);

    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    const completed = (row!.executionState as Record<string, unknown>).completedStageIds as string[];
    expect(completed).toContain(SECOND_STAGE_ID);
    expect(completed).not.toContain(STAGE_ID);
  });

  it("wakes the return assignee on a status-only handback (blocked -> in_progress, assignee unchanged)", async () => {
    const { companyId, issueId, returnAssigneeAgentId } = await seedIssue({ issueStatus: "blocked" });
    currentActor = boardActor(companyId);
    // The card is blocked and already assigned to the return assignee, so the
    // final-stage handback changes the status (blocked -> in_progress) without
    // changing the assignee. The wake gate must fire on the status change.
    await db
      .update(issues)
      .set({ assigneeAgentId: returnAssigneeAgentId })
      .where(eq(issues.id, issueId));
    const calls: Array<{ agentId: string; reason: string | null }> = [];
    const localApp = createApp({
      executionStageWakeupEnqueue: async (agentId: string, options: any) => {
        calls.push({ agentId, reason: options?.reason ?? null });
        return { id: "wakeup-test" } as any;
      },
    });

    const res = await request(localApp)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "board: final stage approved on a blocked card" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(row!.status).toBe("in_progress");
    expect(row!.assigneeAgentId).toBe(returnAssigneeAgentId);

    // Exactly one wake, fired on the status transition despite the unchanged
    // assignee (SUP-15547).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.agentId).toBe(returnAssigneeAgentId);
    expect(calls[0]!.reason).toBe("issue_assigned");
  });

  it("rolls back the decision and the transition when the override activity write fails", async () => {
    const { companyId, issueId, reviewerAgentId } = await seedIssue();
    currentActor = boardActor(companyId);
    const calls: unknown[] = [];
    const localApp = createApp({
      executionStageWakeupEnqueue: async (agentId: string, options: any) => {
        calls.push({ agentId, options });
        return { id: "wakeup-test" } as any;
      },
    });
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION paperclip_test_fail_board_override_activity()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RAISE EXCEPTION 'forced board-decision override activity failure';
      END
      $function$;
      CREATE TRIGGER paperclip_test_fail_board_override_activity
      BEFORE INSERT ON activity_log
      FOR EACH ROW WHEN (NEW.action = 'issue.board_stage_override')
      EXECUTE FUNCTION paperclip_test_fail_board_override_activity();
    `));
    try {
      const res = await request(localApp)
        .post(`/api/issues/${issueId}/execution-stage/board-decision`)
        .send({ decision: "approved", comment: "board: approving on the reviewer's behalf" });
      // The override audit write shares the decision's transaction. Failing it
      // must roll the whole mutation back. This is what pins the post-commit
      // relocation mutant: moving the override audit write AFTER commit would let
      // the decision and its comment commit while the audit row never lands (a
      // committed mutation with no audit trail), which is the regression this
      // test exists to catch. It pins the write's transaction placement, NOT the
      // choice of helper, so refactoring the helper is free.
      expect(res.status).toBe(500);
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS paperclip_test_fail_board_override_activity ON activity_log;
        DROP FUNCTION IF EXISTS paperclip_test_fail_board_override_activity();
      `));
    }

    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(0);

    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(row!.status).toBe("in_review");
    expect(row!.assigneeAgentId).toBe(reviewerAgentId);
    expect((row!.executionState as Record<string, unknown>).completedStageIds).not.toContain(STAGE_ID);

    const activity = await db.select().from(activityLog);
    expect(activity).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    expect(calls).toHaveLength(0);
  });
});
