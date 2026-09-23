import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres ADR-103 M4 parent-edge tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * ADR-103 M4 (SUP-17183): the `parent_id` write is TOTAL. A decomposition edge
 * (create or re-parent) must be refused with 409 when it would take the parent's
 * laddered-child count from <2 to >=2 and arm the ADR-072 close ladder on a
 * parent whose pointer has already advanced and whose policy no longer carries
 * the conforming close-ladder shape. A rejected write persists nothing.
 *
 * These tests pin the gate against a real database, so a regression that drops
 * the gate from either write path cannot survive.
 */
describeEmbeddedPostgres("parent edge that would add an undischargeable ladder (ADR-103 M4)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb:
    | Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>
    | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-parent-edge-m4-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const heartbeatStub = {
    requestWakeup: async () => null,
    enqueueWakeup: async () => null,
  } as any;

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        memberships: [
          { companyId, membershipRole: "owner", status: "active" },
        ],
        isInstanceAdmin: false,
        source: "session",
      };
      next();
    });
    app.use("/api", issueRoutes(db, heartbeatStub));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "board-user",
      membershipRole: "owner",
      grantedByUserId: null,
    });
    return { companyId, issuePrefix };
  }

  async function seedSupportQaeAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "support-QAE",
      status: "active",
    });
    return agentId;
  }

  /**
   * A valid executionState whose pointer has (or has not) advanced past the
   * support-QAE review stage.
   */
  function executionStateFor(completedStageIds: string[]) {
    return {
      status: "pending",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: null,
      completedStageIds,
      skippedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    };
  }

  /**
   * The SUP-16872 work card: a review stage that has already RUN (the pointer
   * is advanced) but whose policy still lacks the review:coder-LE and
   * approval:exec-CTO close-ladder rungs (the shape can no longer be added
   * late). `advanced` toggles the pointer so the mirror case can be built.
   */
  async function seedAdvancedNonConformingParent(
    companyId: string,
    issuePrefix: string,
    issueNumber: number,
    supportQaeAgentId: string,
    advanced: boolean,
  ) {
    const id = randomUUID();
    const stageId = randomUUID();
    const [row] = await db
      .insert(issues)
      .values({
        id,
        companyId,
        issueNumber,
        identifier: `${issuePrefix}-${issueNumber}`,
        title: "Work card whose ladder already advanced",
        status: "in_progress",
        priority: "medium",
        executionPolicy: {
          stages: [
            {
              id: stageId,
              type: "review",
              participants: [{ type: "agent", agentId: supportQaeAgentId }],
            },
          ],
        },
        executionState: executionStateFor(advanced ? [stageId] : []),
      })
      .returning({ id: issues.id, identifier: issues.identifier });
    return { id: row.id, identifier: row.identifier, stageId };
  }

  /** A single qualifying laddered child (a manual child that has run a stage). */
  async function seedQualifyingChild(
    companyId: string,
    issuePrefix: string,
    issueNumber: number,
    parentId: string,
    supportQaeAgentId: string,
  ) {
    const id = randomUUID();
    const stageId = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      issueNumber,
      identifier: `${issuePrefix}-${issueNumber}`,
      parentId,
      parentLinkKind: "decomposition",
      title: "First laddered work child",
      status: "todo",
      priority: "medium",
      originKind: "manual",
      executionPolicy: {
        stages: [
          {
            id: stageId,
            type: "review",
            participants: [{ type: "agent", agentId: supportQaeAgentId }],
          },
        ],
      },
      executionState: executionStateFor([stageId]),
    });
    return id;
  }

  async function edgeFor(issueId: string) {
    const rows = await db
      .select({
        parentId: issues.parentId,
        parentLinkKind: issues.parentLinkKind,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    return rows[0] ?? null;
  }

  it("rejects (409) a decomposition edge that would arm the close ladder on an advanced, non-conforming parent (SUP-16872)", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const supportQaeAgentId = await seedSupportQaeAgent(companyId);
    const parent = await seedAdvancedNonConformingParent(
      companyId,
      issuePrefix,
      1,
      supportQaeAgentId,
      true,
    );
    await seedQualifyingChild(
      companyId,
      issuePrefix,
      2,
      parent.id,
      supportQaeAgentId,
    );

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Second laddered work child", parentId: parent.id });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    // The refusal names the parent and offers both lawful resolutions.
    expect(res.body.error).toContain(parent.identifier);
    const detailsJson = JSON.stringify(res.body.details ?? {});
    expect(detailsJson).toContain("'process'");
    expect(detailsJson).toContain("programme");
    // A rejected write persists nothing: no second child under the parent and
    // no row at all for the new title.
    const children = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.parentId, parent.id)));
    expect(children).toHaveLength(1);
    const byTitle = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.title, "Second laddered work child")));
    expect(byTitle).toHaveLength(0);
  });

  it("rejects (409) a re-parent into an advanced, non-conforming parent and leaves the child's parent_id unchanged", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const supportQaeAgentId = await seedSupportQaeAgent(companyId);
    const parent = await seedAdvancedNonConformingParent(
      companyId,
      issuePrefix,
      1,
      supportQaeAgentId,
      true,
    );
    await seedQualifyingChild(
      companyId,
      issuePrefix,
      2,
      parent.id,
      supportQaeAgentId,
    );

    // A benign parent the child currently sits under.
    const otherParentId = randomUUID();
    await db.insert(issues).values({
      id: otherParentId,
      companyId,
      issueNumber: 3,
      identifier: `${issuePrefix}-3`,
      title: "Benign parent",
      status: "todo",
      priority: "medium",
    });
    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      issueNumber: 4,
      identifier: `${issuePrefix}-4`,
      parentId: otherParentId,
      parentLinkKind: "decomposition",
      title: "Reparentable child",
      status: "todo",
      priority: "medium",
      originKind: "manual",
    });

    const res = await request(createApp(companyId))
      .patch(`/api/issues/${childId}`)
      .send({ parentId: parent.id });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toContain(parent.identifier);
    // The rejected re-parent persists nothing: the edge still points to the
    // benign parent.
    const edge = await edgeFor(childId);
    expect(edge?.parentId).toBe(otherParentId);
  });

  it("allows the same second decomposition edge when the parent's pointer has not advanced (the ladder can still arm)", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const supportQaeAgentId = await seedSupportQaeAgent(companyId);
    const parent = await seedAdvancedNonConformingParent(
      companyId,
      issuePrefix,
      1,
      supportQaeAgentId,
      false,
    );
    await seedQualifyingChild(
      companyId,
      issuePrefix,
      2,
      parent.id,
      supportQaeAgentId,
    );

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Second laddered work child", parentId: parent.id });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const edge = await edgeFor(res.body.id);
    expect(edge?.parentId).toBe(parent.id);
    expect(edge?.parentLinkKind).toBe("decomposition");
  });

  it("allows an edge declared process even when the parent is advanced and non-conforming", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const supportQaeAgentId = await seedSupportQaeAgent(companyId);
    const parent = await seedAdvancedNonConformingParent(
      companyId,
      issuePrefix,
      1,
      supportQaeAgentId,
      true,
    );
    await seedQualifyingChild(
      companyId,
      issuePrefix,
      2,
      parent.id,
      supportQaeAgentId,
    );

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Process courier child",
        parentId: parent.id,
        parentLinkKind: "process",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const edge = await edgeFor(res.body.id);
    expect(edge?.parentId).toBe(parent.id);
    expect(edge?.parentLinkKind).toBe("process");
  });

  it("allows a decomposition edge when the parent has no laddered children yet (count would reach only 1)", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const supportQaeAgentId = await seedSupportQaeAgent(companyId);
    const parent = await seedAdvancedNonConformingParent(
      companyId,
      issuePrefix,
      1,
      supportQaeAgentId,
      true,
    );
    // No qualifying child is seeded, so the new edge takes the count from 0 -> 1.

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Only laddered work child", parentId: parent.id });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const edge = await edgeFor(res.body.id);
    expect(edge?.parentId).toBe(parent.id);
  });
});
