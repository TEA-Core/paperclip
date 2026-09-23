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
});
