import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
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
    `Skipping embedded Postgres parent_link_kind detail-read tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * SUP-17484 (ADR-103 M2 / SUP-17481 §2): `issues.parent_link_kind` is
 * `NOT NULL DEFAULT 'decomposition'` and is not tied to `parent_id`, so every
 * unparented row stored that column as `'decomposition'` and reported
 * `parentLinkKind: "decomposition"` on the single-issue read — a false
 * observation that readers misread as a decomposition edge (the live defect
 * behind SUP-17432 and the `parent-close-ladder-missing` signature). These
 * tests pin the read boundary against a real database: an unparented card must
 * read `parentLinkKind: null`, a card with a parent must round-trip its stored
 * kind, and setting/clearing a parent must move the reported value without ever
 * writing to the column.
 */
describeEmbeddedPostgres("parent_link_kind detail-read boundary", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-parent-link-kind-detail-read-",
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

    // Two top-level parents so a card can be promoted onto / demoted off an edge.
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

  async function storedEdge(issueId: string) {
    const rows = await db
      .select({
        parentId: issues.parentId,
        parentLinkKind: issues.parentLinkKind,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    return rows[0] ?? null;
  }

  async function createIssue(companyId: string, body: object) {
    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  it("reports parentLinkKind as null for an unparented card whose stored kind is the 'decomposition' default (SUP-17484 regression)", async () => {
    const { companyId } = await seedCompanyWithParents();

    const created = await createIssue(companyId, { title: "Top-level card" });

    // The stored column keeps its NOT NULL 'decomposition' default — untouched.
    const stored = await storedEdge(created.id);
    expect(stored?.parentId).toBeNull();
    expect(stored?.parentLinkKind).toBe("decomposition");

    // The detail read must report the absence of an edge as null, not
    // "decomposition" — this is the exact shape that produced the defect.
    const detail = await request(createApp(companyId)).get(
      `/api/issues/${created.id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.parentId).toBeNull();
    expect(detail.body.parentLinkKind).toBeNull();
  });

  it("round-trips a stored parentLinkKind on the detail read when the card has a parent (SUP-17484 AC: round-trip)", async () => {
    const { companyId, parentA } = await seedCompanyWithParents();

    const processChild = await createIssue(companyId, {
      title: "Process child",
      parentId: parentA,
      parentLinkKind: "process",
    });
    const processDetail = await request(createApp(companyId)).get(
      `/api/issues/${processChild.id}`,
    );
    expect(processDetail.status).toBe(200);
    expect(processDetail.body.parentId).toBe(parentA);
    expect(processDetail.body.parentLinkKind).toBe("process");

    const decompositionChild = await createIssue(companyId, {
      title: "Decomposition child",
      parentId: parentA,
    });
    const decompositionDetail = await request(createApp(companyId)).get(
      `/api/issues/${decompositionChild.id}`,
    );
    expect(decompositionDetail.status).toBe(200);
    expect(decompositionDetail.body.parentId).toBe(parentA);
    expect(decompositionDetail.body.parentLinkKind).toBe("decomposition");
  });

  it("reports the stored kind once a parent is set and null again once it is cleared, with no write to the column (SUP-17484 AC: set/clear)", async () => {
    const { companyId, parentA } = await seedCompanyWithParents();

    const created = await createIssue(companyId, { title: "Promoted card" });
    const id = created.id;

    // Promote onto parentA, omitting the kind: the stored 'decomposition' value
    // now has a real edge behind it, so the detail read reports it.
    const setParent = await request(createApp(companyId))
      .patch(`/api/issues/${id}`)
      .send({ parentId: parentA });
    expect(setParent.status, JSON.stringify(setParent.body)).toBe(200);
    const afterSet = await request(createApp(companyId)).get(`/api/issues/${id}`);
    expect(afterSet.body.parentId).toBe(parentA);
    expect(afterSet.body.parentLinkKind).toBe("decomposition");
    // The set direction wrote nothing to the column.
    expect((await storedEdge(id))?.parentLinkKind).toBe("decomposition");

    // Demote back to top-level, omitting the kind: the read reports null again.
    const clearParent = await request(createApp(companyId))
      .patch(`/api/issues/${id}`)
      .send({ parentId: null });
    expect(clearParent.status, JSON.stringify(clearParent.body)).toBe(200);
    const afterClear = await request(createApp(companyId)).get(`/api/issues/${id}`);
    expect(afterClear.body.parentId).toBeNull();
    expect(afterClear.body.parentLinkKind).toBeNull();
    // The clear direction wrote nothing to the column either.
    expect((await storedEdge(id))?.parentLinkKind).toBe("decomposition");
  });
});
