import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issues,
  issueRelations,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * SUP-15501 regression: `hiddenAt` must stop being invisible.
 *
 * A live, load-bearing issue (a blocker that other issues point at) could be
 * parked out of every list projection by writing `hiddenAt`, with no way to
 * see it again and no audit trail of who did it. This pins the two fixes:
 *   1. `GET /companies/:companyId/issues?includeHidden=true` returns hidden
 *      issues (default omits them), and the hidden rows carry `hiddenAt`.
 *   2. Writing `hiddenAt` via PATCH emits a dedicated, fate-shared
 *      `issue.hidden` activity row naming the actor and the before/after value.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue list includeHidden + hiddenAt audit (SUP-15501)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-list-include-hidden-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const operatorUserId = `user-${randomUUID()}`;
    const hiddenIssueId = randomUUID();
    const visibleIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: `Include hidden ${companyId}`,
      issuePrefix: `IH${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
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
    await db.insert(issues).values([
      {
        id: hiddenIssueId,
        companyId,
        identifier: "IH-HIDDEN",
        title: "Hidden load-bearing blocker",
        status: "in_review",
        priority: "medium",
        hiddenAt: now,
      },
      {
        id: visibleIssueId,
        companyId,
        identifier: "IH-VISIBLE",
        title: "Visible todo",
        status: "todo",
        priority: "medium",
      },
      {
        id: blockedIssueId,
        companyId,
        identifier: "IH-BLOCKED",
        title: "Blocked by the hidden issue",
        status: "blocked",
        priority: "medium",
      },
    ]);
    // The hidden issue blocks the blocked issue, so it "appears in another
    // issue's blockedBy" — load-bearing even though it is hidden from lists.
    await db.insert(issueRelations).values({
      companyId,
      issueId: hiddenIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    return { companyId, operatorUserId, hiddenIssueId, visibleIssueId, blockedIssueId };
  }

  function appFor(seeded: Awaited<ReturnType<typeof seed>>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        source: "session",
        userId: seeded.operatorUserId,
        companyIds: [seeded.companyId],
        memberships: [
          { companyId: seeded.companyId, membershipRole: "operator", status: "active" },
        ],
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  function issueIds(body: unknown): Set<string> {
    return new Set(
      (Array.isArray(body) ? body : [])
        .map((row) => (row as { id?: unknown }).id)
        .filter((id): id is string => typeof id === "string"),
    );
  }

  it("omits hidden issues by default and returns them (marked by hiddenAt) with includeHidden=true", async () => {
    const seeded = await seed();
    const app = appFor(seeded);

    const byDefault = await request(app)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .expect(200);
    const defaultIds = issueIds(byDefault.body);
    expect(defaultIds.has(seeded.hiddenIssueId)).toBe(false);
    expect(defaultIds.has(seeded.visibleIssueId)).toBe(true);
    expect(defaultIds.has(seeded.blockedIssueId)).toBe(true);

    const withHidden = await request(app)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ includeHidden: "true" })
      .expect(200);
    const withHiddenIds = issueIds(withHidden.body);
    expect(withHiddenIds.has(seeded.hiddenIssueId)).toBe(true);
    const hiddenRow = (withHidden.body as Array<Record<string, unknown>>).find(
      (row) => row.id === seeded.hiddenIssueId,
    );
    expect(hiddenRow?.hiddenAt).toBeTruthy();
  });

  it("includes a hidden issue when combined with a status filter and includeHidden=true", async () => {
    const seeded = await seed();
    const app = appFor(seeded);

    const onlyStatus = await request(app)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ status: "in_review" })
      .expect(200);
    expect(issueIds(onlyStatus.body).has(seeded.hiddenIssueId)).toBe(false);

    const withHidden = await request(app)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ status: "in_review", includeHidden: "true" })
      .expect(200);
    expect(issueIds(withHidden.body).has(seeded.hiddenIssueId)).toBe(true);
  });

  it("marks hidden rows with hiddenAt in the compact (view=compact) projection", async () => {
    const seeded = await seed();
    const app = appFor(seeded);

    const compactDefault = await request(app)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ view: "compact" })
      .expect(200);
    expect(issueIds(compactDefault.body).has(seeded.hiddenIssueId)).toBe(false);

    const compactWithHidden = await request(app)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ view: "compact", includeHidden: "true" })
      .expect(200);
    expect(issueIds(compactWithHidden.body).has(seeded.hiddenIssueId)).toBe(true);
    const hiddenRow = (compactWithHidden.body as Array<Record<string, unknown>>).find(
      (row) => row.id === seeded.hiddenIssueId,
    );
    expect(hiddenRow?.hiddenAt).toBeTruthy();

    // Ordinary (non-hidden) compact rows carry a null marker so callers can
    // distinguish hidden rows by `hiddenAt != null` even in the compact view.
    const visibleRow = (compactWithHidden.body as Array<Record<string, unknown>>).find(
      (row) => row.id === seeded.visibleIssueId,
    );
    expect(visibleRow?.hiddenAt).toBeNull();
  });

  it("rejects a malformed includeHidden value with 400", async () => {
    const seeded = await seed();
    await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ includeHidden: "maybe" })
      .expect(400);
  });

  it("emits a dedicated issue.hidden audit row naming the actor when hiddenAt is set via PATCH", async () => {
    const seeded = await seed();
    const app = appFor(seeded);

    const res = await request(app)
      .patch(`/api/issues/${seeded.visibleIssueId}`)
      .send({ hiddenAt: new Date().toISOString() })
      .expect(200);
    expect((res.body as { hiddenAt?: unknown }).hiddenAt).toBeTruthy();

    const rows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, seeded.companyId),
          eq(activityLog.entityId, seeded.visibleIssueId),
          eq(activityLog.action, "issue.hidden"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].actorType).toBe("user");
    expect(rows[0].actorId).toBe(seeded.operatorUserId);
    expect(rows[0].details).toEqual(expect.objectContaining({ issueId: seeded.visibleIssueId }));
  });

  it("emits issue.unhidden when hiddenAt is cleared via PATCH", async () => {
    const seeded = await seed();
    const app = appFor(seeded);

    // Hide the visible issue, then clear the flag in a second PATCH.
    await request(app)
      .patch(`/api/issues/${seeded.visibleIssueId}`)
      .send({ hiddenAt: new Date().toISOString() })
      .expect(200);
    await request(app)
      .patch(`/api/issues/${seeded.visibleIssueId}`)
      .send({ hiddenAt: null })
      .expect(200);

    const rows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, seeded.companyId),
          eq(activityLog.entityId, seeded.visibleIssueId),
          eq(activityLog.action, "issue.unhidden"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].actorType).toBe("user");
    expect(rows[0].actorId).toBe(seeded.operatorUserId);
  });
});
