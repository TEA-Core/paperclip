import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueExecutionDecisions,
  issueInboxArchives,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// SUP-17552: accepting a round-cap review escalation whose escalated review stage
// is the FINAL stage must render the same `done` close the normal reviewer-approval
// route does — `status = "done"` AND `completedAt` set — not leave the card parked
// `in_progress` with `completedAt: null` (the SUP-17292 defect). The mocked
// `issue-execution-policy-routes.test.ts` asserts the update patch; this file proves
// the persisted row through the real service + database so `completedAt` is covered.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review-escalation accept close tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("review-escalation accept closes the final stage done", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  type WakeupOptions = Parameters<ReturnType<typeof heartbeatService>["wakeup"]>[1];
  const enqueueWakeup = vi.fn(async (_agentId: string, _options: WakeupOptions) => ({
    id: randomUUID(),
  }));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-escalation-accept-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    enqueueWakeup.mockClear();
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.delete(issueThreadInteractions);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    const reviewerAgentId = randomUUID();
    const returnAgentId = randomUUID();
    const escalationUserId = `${prefix.toLowerCase()}-escalation-user`;
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: reviewerAgentId,
        companyId,
        name: `${prefix} Reviewer`,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: returnAgentId,
        companyId,
        name: `${prefix} Return`,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: escalationUserId,
      status: "active",
      membershipRole: "operator",
    });
    return { companyId, reviewerAgentId, returnAgentId, escalationUserId };
  }

  // The SUP-17292 shape: a review stage that exhausted its round cap
  // (`changesRequestedCount: 3`), so the card is parked on a human with the agent
  // it should return to preserved as `executionState.returnAssignee`, and a pending
  // `review-escalation:*` confirmation addressed to that human.
  async function seedRoundCapEscalation(input: {
    companyId: string;
    reviewerAgentId: string;
    returnAgentId: string;
    escalationUserId: string;
    identifier: string;
  }) {
    const issueId = randomUUID();
    const escalatedStageId = randomUUID();
    const stages = [
      {
        id: escalatedStageId,
        type: "review",
        approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId: input.reviewerAgentId }],
      },
    ];
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      status: "in_review",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: input.escalationUserId,
      responsibleUserId: input.escalationUserId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages,
      },
      executionState: {
        status: "pending",
        currentStageId: escalatedStageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "user", userId: input.escalationUserId },
        returnAssignee: { type: "agent", agentId: input.returnAgentId },
        completedStageIds: [],
        changesRequestedCount: 3,
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    // Three prior request-changes verdicts, as SUP-17292 carried.
    await db.insert(issueExecutionDecisions).values(
      Array.from({ length: 3 }, () => ({
        companyId: input.companyId,
        issueId,
        stageId: escalatedStageId,
        stageType: "review",
        actorAgentId: input.reviewerAgentId,
        outcome: "changes_requested",
        body: "Changes requested.",
      })),
    );
    const [interaction] = await db
      .insert(issueThreadInteractions)
      .values({
        companyId: input.companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        createdByUserId: input.escalationUserId,
        addresseeUserId: input.escalationUserId,
        continuationPolicy: "wake_assignee",
        requestedResolverPolicy: "human_only",
        effectiveResolverPolicy: "human_only",
        idempotencyKey: `review-escalation:${issueId}:${escalatedStageId}:3:0123456789abcdef`,
        payload: {
          version: 1,
          prompt: "Approve this review, or request further changes (round cap reached).",
        },
      })
      .returning();
    return { issueId, escalatedStageId, interactionId: interaction.id };
  }

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use(
      "/api",
      issueRoutes(db, {} as any, {
        stalledReviewDecisionEnqueueWakeup: enqueueWakeup as any,
      }),
    );
    testApp.use(errorHandler);
    return testApp;
  }

  function boardActor(companyId: string, userId: string) {
    return {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "operator" }],
      isInstanceAdmin: false,
    };
  }

  it("closes the final stage done with completedAt set (SUP-17292 regression)", async () => {
    const seeded = await seedCompany("REC");
    const { issueId, interactionId, escalatedStageId } = await seedRoundCapEscalation({
      companyId: seeded.companyId,
      reviewerAgentId: seeded.reviewerAgentId,
      returnAgentId: seeded.returnAgentId,
      escalationUserId: seeded.escalationUserId,
      identifier: "REC-1",
    });

    const res = await request(app(boardActor(seeded.companyId, seeded.escalationUserId)))
      .post(`/api/issues/${issueId}/interactions/${interactionId}/accept`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: interactionId, status: "accepted" });

    const row = await db
      .select({
        status: issues.status,
        completedAt: issues.completedAt,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(row?.status).toBe("done");
    expect(row?.completedAt).not.toBeNull();
    expect(row?.executionState).toMatchObject({
      status: "completed",
      currentStageId: null,
      completedStageIds: [escalatedStageId],
      lastDecisionOutcome: "approved",
    });

    // A closed card has no continuation wake target: the accept door must not wake
    // the return assignee back into a done card.
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });
});
