import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * Regression test for `pendingReviewParticipantAgentId` on
 * `GET /companies/:companyId/issues`.
 *
 * The filter existed in the issue service but was only wired into the
 * `inbox-lite` handler. Because this route silently drops unknown query
 * parameters, `?pendingReviewParticipantAgentId=<agent>&status=in_review`
 * returned every `in_review` issue in the company, and a bogus agent id
 * returned exactly the same rows — a probe that reads like it works and does
 * not. These cases pin the two behaviors that make the filter observable:
 * a wrong id must return nothing, and a malformed id must fail loudly.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue list pendingReviewParticipantAgentId filter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-list-pending-review-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const reviewerAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const pendingForReviewerIssueId = randomUUID();
    const pendingForOtherIssueId = randomUUID();
    const decidedForReviewerIssueId = randomUUID();
    const operatorUserId = `user-${randomUUID()}`;
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: `Pending review ${companyId}`,
      issuePrefix: `PR${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(authUsers).values({
      id: operatorUserId,
      name: "Operator",
      email: `${operatorUserId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: operatorUserId,
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(agents).values([
      {
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: pendingForReviewerIssueId,
        companyId,
        title: "Pending review for reviewer",
        status: "in_review",
        priority: "medium",
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentStageId: randomUUID(),
          currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
          lastDecisionId: null,
        },
      },
      {
        id: pendingForOtherIssueId,
        companyId,
        title: "Pending review for someone else",
        status: "in_review",
        priority: "medium",
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentStageId: randomUUID(),
          currentParticipant: { type: "agent", agentId: otherAgentId, userId: null },
          lastDecisionId: null,
        },
      },
      {
        id: decidedForReviewerIssueId,
        companyId,
        title: "Already decided",
        status: "in_review",
        priority: "medium",
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentStageId: randomUUID(),
          currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
          lastDecisionId: randomUUID(),
        },
      },
    ]);

    return {
      companyId,
      operatorUserId,
      reviewerAgentId,
      otherAgentId,
      pendingForReviewerIssueId,
      pendingForOtherIssueId,
      decidedForReviewerIssueId,
    };
  }

  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  function agentActor(seeded: Awaited<ReturnType<typeof seed>>): Express.Request["actor"] {
    return {
      type: "agent",
      source: "agent_jwt",
      agentId: seeded.reviewerAgentId,
      companyId: seeded.companyId,
      onBehalfOfUserId: null,
      onBehalfOfMemberships: [],
    };
  }

  function boardActor(seeded: Awaited<ReturnType<typeof seed>>): Express.Request["actor"] {
    return {
      type: "board",
      source: "session",
      userId: seeded.operatorUserId,
      companyIds: [seeded.companyId],
      memberships: [
        { companyId: seeded.companyId, membershipRole: "operator", status: "active" },
      ],
      isInstanceAdmin: false,
    };
  }

  it("narrows ?status=in_review to the named agent's pending reviews", async () => {
    const seeded = await seed();
    const res = await request(appFor(boardActor(seeded)))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ status: "in_review", pendingReviewParticipantAgentId: seeded.reviewerAgentId })
      .expect(200);

    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([
      seeded.pendingForReviewerIssueId,
    ]);
  });

  it("returns no rows for a well-formed agent id with no pending reviews (pre-fix this returned every in_review issue)", async () => {
    const seeded = await seed();
    const app = appFor(boardActor(seeded));

    const unfiltered = await request(app)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ status: "in_review" })
      .expect(200);
    expect(unfiltered.body).toHaveLength(3);

    const bogus = await request(app)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ status: "in_review", pendingReviewParticipantAgentId: randomUUID() })
      .expect(200);
    expect(bogus.body).toEqual([]);
  });

  it("rejects a malformed agent id with 422 instead of ignoring it", async () => {
    const seeded = await seed();
    await request(appFor(boardActor(seeded)))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ status: "in_review", pendingReviewParticipantAgentId: "not-a-uuid" })
      .expect(422)
      .expect(({ body }) => expect(body.error).toMatch(/pendingReviewParticipantAgentId/));

    await request(appFor(boardActor(seeded)))
      .get(
        `/api/companies/${seeded.companyId}/issues?pendingReviewParticipantAgentId=${seeded.reviewerAgentId}&pendingReviewParticipantAgentId=${seeded.otherAgentId}`,
      )
      .expect(422);
  });

  it("resolves 'me' to the calling agent and rejects it for board actors", async () => {
    const seeded = await seed();

    const asAgent = await request(appFor(agentActor(seeded)))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ pendingReviewParticipantAgentId: "me" })
      .expect(200);
    expect(asAgent.body.map((issue: { id: string }) => issue.id)).toEqual([
      seeded.pendingForReviewerIssueId,
    ]);

    await request(appFor(boardActor(seeded)))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ pendingReviewParticipantAgentId: "me" })
      .expect(403);
  });

  it("treats a blank value as no filter", async () => {
    const seeded = await seed();
    const res = await request(appFor(boardActor(seeded)))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ status: "in_review", pendingReviewParticipantAgentId: "" })
      .expect(200);
    expect(res.body).toHaveLength(3);
  });
});
