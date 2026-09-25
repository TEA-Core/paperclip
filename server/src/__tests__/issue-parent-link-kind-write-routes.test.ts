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
  issueLabels,
  issueRelations,
  issues,
  labels,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { countLadderedChildren } from "../services/done-transition-guard.js";
import {
  MISSING_APPROVAL_STAGE_ERROR_CODE,
  diagnoseMissingApprovalStage,
} from "../services/issue-execution-policy.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres parent_link_kind write tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * ADR-103 M2 (SUP-17182): the parent edge's `parent_link_kind` must be written in
 * the SAME statement as `parent_id` on both write paths (create and re-parent),
 * and a re-parent that omits the kind must leave the stored kind untouched
 * (preserve-on-omit). These tests pin that against a real database so a
 * regression that drops the column from the INSERT/SET cannot survive.
 */
describeEmbeddedPostgres("parent_link_kind write paths", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-parent-link-kind-write-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueLabels);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(labels);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const heartbeatStub = { requestWakeup: async () => null, enqueueWakeup: async () => null } as any;

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        isInstanceAdmin: false,
        source: "session",
      };
      next();
    });
    app.use("/api", issueRoutes(db, heartbeatStub));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithParents() {
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

    // Two top-level parents for re-parenting between.
    const parentA = randomUUID();
    const parentB = randomUUID();
    await db.insert(issues).values({
      id: parentA,
      companyId,
      title: "Parent A",
      status: "todo",
      priority: "medium",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(issues).values({
      id: parentB,
      companyId,
      title: "Parent B",
      status: "todo",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });

    return { companyId, parentA, parentB };
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

  async function createChild(
    companyId: string,
    parentId: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    // A unique title keeps the create route's recent-title dedup from folding the
    // second child into the first (which would return 200 with the same id).
    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: `Child ${randomUUID()}`, parentId, ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }

  // Give a child a ran review ladder so `countLadderedChildren` sees it as a
  // genuine decomposition child (policy present + a completed stage).
  async function makeChildLaddered(childId: string) {
    const stageId = randomUUID();
    await db
      .update(issues)
      .set({
        executionPolicy: { mode: "normal", stages: [{ id: stageId, type: "review" }] },
        executionState: {
          status: "completed",
          currentStageId: null,
          currentStageIndex: null,
          currentStageType: null,
          currentParticipant: null,
          returnAssignee: null,
          completedStageIds: [stageId],
          skippedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      })
      .where(eq(issues.id, childId));
  }

  // The route's done-transition probe (routes/issues.ts) makes exactly these two
  // calls: countLadderedChildren then diagnoseMissingApprovalStage. A null gap is
  // what lets the close proceed without the typed
  // done_transition_missing_approval_stage 409; a non-null gap is that refusal.
  async function closeGapFor(companyId: string, parentId: string) {
    const census = await countLadderedChildren(db, companyId, parentId);
    const gap = diagnoseMissingApprovalStage({
      policy: null,
      ladderedChildCount: census.count,
      ladderedChildIdentifiers: census.identifiers,
      excludedChildIdentifiers: census.excludedChildIdentifiers,
    });
    return { census, gap };
  }

  it("writes parent_link_kind beside parent_id at create time", async () => {
    const { companyId, parentA } = await seedCompanyWithParents();

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Edge-declared process child",
        parentId: parentA,
        parentLinkKind: "process",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const edge = await edgeFor(res.body.id);
    expect(edge?.parentId).toBe(parentA);
    expect(edge?.parentLinkKind).toBe("process");
  });

  it("leaves parent_link_kind at its 'decomposition' default when omitted at create", async () => {
    const { companyId, parentA } = await seedCompanyWithParents();

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Ordinary child", parentId: parentA });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const edge = await edgeFor(res.body.id);
    expect(edge?.parentId).toBe(parentA);
    expect(edge?.parentLinkKind).toBe("decomposition");
  });

  it("rejects an invalid parent_link_kind at create time instead of writing it", async () => {
    const { companyId, parentA } = await seedCompanyWithParents();

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Bad kind", parentId: parentA, parentLinkKind: "other" });

    expect(res.status).toBe(400);
    expect(
      await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.title, "Bad kind"))),
    ).toHaveLength(0);
  });

  it("writes the restated parent_link_kind in the same update that re-parents", async () => {
    const { companyId, parentA, parentB } = await seedCompanyWithParents();

    // Create the child under A with the kind defaulted to decomposition.
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Reparented child", parentId: parentA });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const reparented = await request(createApp(companyId))
      .patch(`/api/issues/${created.body.id}`)
      .send({ parentId: parentB, parentLinkKind: "process" });

    expect(reparented.status, JSON.stringify(reparented.body)).toBe(200);
    const edge = await edgeFor(created.body.id);
    expect(edge?.parentId).toBe(parentB);
    expect(edge?.parentLinkKind).toBe("process");
  });

  it("preserves the stored parent_link_kind when a re-parent omits it (preserve-on-omit)", async () => {
    const { companyId, parentA, parentB } = await seedCompanyWithParents();

    // Create the child under A with an edge-declared process kind.
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Process child", parentId: parentA, parentLinkKind: "process" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    // Re-parent to B WITHOUT restating the kind: the stored 'process' value must
    // survive, because the field is not in the update SET when it is omitted.
    const reparented = await request(createApp(companyId))
      .patch(`/api/issues/${created.body.id}`)
      .send({ parentId: parentB });

    expect(reparented.status, JSON.stringify(reparented.body)).toBe(200);
    const edge = await edgeFor(created.body.id);
    expect(edge?.parentId).toBe(parentB);
    expect(edge?.parentLinkKind).toBe("process");
  });

  it("accepts parent_link_kind on the child-create route and writes it", async () => {
    // M2 omitted the field from `createChildIssueSchema` on the premise that
    // child edges are always decomposition, which made the ADR-103 M4 gate's own
    // advertised remedy — "declare the edge procedural by setting
    // parent_link_kind: 'process'" — a 400 `unrecognized_keys` on the very route
    // agents file sub-work through. The remedy has to be reachable where the
    // refusal is raised.
    const { companyId, parentA } = await seedCompanyWithParents();

    const res = await request(createApp(companyId))
      .post(`/api/issues/${parentA}/children`)
      .send({ title: "Procedural courier child", parentLinkKind: "process" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const edge = await edgeFor(res.body.id);
    expect(edge?.parentId).toBe(parentA);
    expect(edge?.parentLinkKind).toBe("process");
  });

  it("still defaults a child-route edge to decomposition when the kind is omitted", async () => {
    const { companyId, parentA } = await seedCompanyWithParents();

    const res = await request(createApp(companyId))
      .post(`/api/issues/${parentA}/children`)
      .send({ title: "Ordinary sub-work child" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const edge = await edgeFor(res.body.id);
    expect(edge?.parentId).toBe(parentA);
    expect(edge?.parentLinkKind).toBe("decomposition");
  });

  it("still rejects an invalid parent_link_kind on the child-create route", async () => {
    const { companyId, parentA } = await seedCompanyWithParents();

    const res = await request(createApp(companyId))
      .post(`/api/issues/${parentA}/children`)
      .send({ title: "Bad child kind", parentLinkKind: "other" });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(
      await db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(eq(issues.companyId, companyId), eq(issues.title, "Bad child kind")),
        ),
    ).toHaveLength(0);
  });

  // SUP-17553: the close-guard decision must follow the `parent_link_kind` (or
  // carve-out label) written at CREATE — not a later PATCH. These seed children
  // through the real POST route, then exercise the exact predicate the
  // done-transition probe runs, so a regression that reads the wrong column (or
  // drops a carve-out name) fails here against a real database.
  describe("close-guard decision follows the create-time edge (SUP-17553)", () => {
    it("excludes two process children created via POST — no close ladder owed (AC2/AC5)", async () => {
      const { companyId, parentA } = await seedCompanyWithParents();
      const child1 = await createChild(companyId, parentA, { parentLinkKind: "process" });
      const child2 = await createChild(companyId, parentA, { parentLinkKind: "process" });
      await makeChildLaddered(child1);
      await makeChildLaddered(child2);

      const { census, gap } = await closeGapFor(companyId, parentA);
      expect(census.count).toBe(0);
      expect(census.excludedChildIdentifiers).toHaveLength(2);
      expect(gap).toBeNull();

      // And on the real route: the approval-stage refusal is absent. (The close
      // may still be held by an unrelated guard, so assert only the code.)
      const done = await request(createApp(companyId))
        .patch(`/api/issues/${parentA}`)
        .send({ status: "done" });
      expect(
        done.body?.details?.code ?? done.body?.code,
        JSON.stringify(done.body),
      ).not.toBe(MISSING_APPROVAL_STAGE_ERROR_CODE);
    });

    it("still refuses for two decomposition children created via POST (AC5)", async () => {
      const { companyId, parentA } = await seedCompanyWithParents();
      const child1 = await createChild(companyId, parentA, { parentLinkKind: "decomposition" });
      const child2 = await createChild(companyId, parentA, { parentLinkKind: "decomposition" });
      await makeChildLaddered(child1);
      await makeChildLaddered(child2);

      const { census, gap } = await closeGapFor(companyId, parentA);
      expect(census.count).toBe(2);
      expect(census.identifiers).toHaveLength(2);
      expect(gap).not.toBeNull();
      expect(gap?.ladderedChildCount).toBe(2);
      // The gap is the route's typed refusal code.
      expect(MISSING_APPROVAL_STAGE_ERROR_CODE).toBe("done_transition_missing_approval_stage");

      // And on the real route: the done transition is refused with that code.
      const done = await request(createApp(companyId))
        .patch(`/api/issues/${parentA}`)
        .send({ status: "done" });
      expect(done.status, JSON.stringify(done.body)).toBe(409);
      expect(
        done.body?.details?.code ?? done.body?.code,
        JSON.stringify(done.body),
      ).toBe(MISSING_APPROVAL_STAGE_ERROR_CODE);
    });

    it("carves out work-type:recovery children attached at the create edge (AC3)", async () => {
      // This company's procedural label is `work-type:recovery` (it has no
      // `work-type:process` label), so AC3's reachable label route is the
      // recovery name. Two such children must not arm the parent's close ladder.
      const { companyId, parentA } = await seedCompanyWithParents();
      const labelId = randomUUID();
      await db.insert(labels).values({
        id: labelId,
        companyId,
        name: "work-type:recovery",
        color: "#000000",
      });

      const child1 = await createChild(companyId, parentA, { labelIds: [labelId] });
      const child2 = await createChild(companyId, parentA, { labelIds: [labelId] });
      await makeChildLaddered(child1);
      await makeChildLaddered(child2);

      const { census, gap } = await closeGapFor(companyId, parentA);
      expect(census.count).toBe(0);
      expect(census.excludedChildIdentifiers).toHaveLength(2);
      expect(gap).toBeNull();
    });
  });
});
