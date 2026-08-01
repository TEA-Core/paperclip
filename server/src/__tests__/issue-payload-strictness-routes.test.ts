import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue payload strictness tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * `POST /issues` used to return 200 with a created issue and silently discard `blockedBy`, because
 * the real field is `blockedByIssueIds` and unrecognized keys were stripped by the validator. A
 * caller that set dependencies at create time got a tree that looked fired and had zero dependency
 * edges, with nothing reporting the loss.
 */
describeEmbeddedPostgres("issue payload strictness", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-payload-strictness-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
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
        memberships: [{ companyId, membershipRole: "admin", status: "active" }],
        isInstanceAdmin: false,
        source: "session",
      };
      next();
    });
    app.use("/api", issueRoutes(db, heartbeatStub));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithBlocker() {
    const companyId = randomUUID();
    const blockerIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Blocker",
      status: "todo",
      priority: "medium",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, blockerIssueId };
  }

  async function blockerIdsFor(issueId: string) {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, issueId))
      .then((rows) => rows.map((row) => row.blockerIssueId));
  }

  it("persists blockedByIssueIds supplied at create time", async () => {
    const { companyId, blockerIssueId } = await seedCompanyWithBlocker();

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Dependent", status: "todo", blockedByIssueIds: [blockerIssueId] });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await blockerIdsFor(res.body.id)).toEqual([blockerIssueId]);
  });

  it("rejects a misspelled blockedBy on create instead of dropping it", async () => {
    const { companyId, blockerIssueId } = await seedCompanyWithBlocker();

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Dependent", status: "todo", blockedBy: [blockerIssueId] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("blockedBy");
    expect(await db.select().from(issues).where(eq(issues.title, "Dependent"))).toHaveLength(0);
  });

  it("rejects a misspelled field on update instead of dropping it", async () => {
    const { companyId, blockerIssueId } = await seedCompanyWithBlocker();
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Dependent", status: "todo" });

    const res = await request(createApp(companyId))
      .patch(`/api/issues/${created.body.id}`)
      .send({ blockedBy: [blockerIssueId] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("blockedBy");
    expect(await blockerIdsFor(created.body.id)).toEqual([]);
  });

  it("rejects a blocker id that does not exist, on create and on update", async () => {
    const { companyId, blockerIssueId } = await seedCompanyWithBlocker();
    const missingId = "00000000-0000-4000-8000-000000000000";

    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Create with missing blocker", status: "todo", blockedByIssueIds: [missingId] });

    expect(created.status).toBe(422);
    expect(created.body.details?.unknownBlockedByIssueIds).toEqual([missingId]);

    const existing = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Patch with missing blocker", status: "todo", blockedByIssueIds: [blockerIssueId] });
    expect(existing.status).toBe(201);

    const patched = await request(createApp(companyId))
      .patch(`/api/issues/${existing.body.id}`)
      .send({ blockedByIssueIds: [missingId] });

    expect(patched.status).toBe(422);
    expect(patched.body.details?.unknownBlockedByIssueIds).toEqual([missingId]);
    // The original edge survives a rejected update.
    expect(await blockerIdsFor(existing.body.id)).toEqual([blockerIssueId]);
  });
});
