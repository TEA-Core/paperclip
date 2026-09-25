import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueCreateIdempotencyKeys,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue create parentage route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// Regression guard for SUP-14719 (follow-up to SUP-14715):
// `POST /api/companies/:companyId/issues` must tell the truth about the parent
// field it accepts. A create that returns 2xx and discards a supplied parent is
// the one outcome the create path must never produce.
describeEmbeddedPostgres("issue create parentage contract routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-create-parentage-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedParent(companyId: string) {
    const [parent] = await db.insert(issues).values({
      companyId,
      title: "Parent issue",
      status: "todo",
      priority: "medium",
    }).returning();
    return parent;
  }

  it("honours a supplied parentId at create and the re-GET shows that parent", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Child created with parentId" })
      .expect(201);

    // The 2xx response must name the parent that was actually stored, not silently
    // return a success with a null parent.
    expect(created.body.parentId).toBe(parent.id);

    // The re-GET the filer uses to double-check the hierarchy shows the parent.
    const reGet = await request(app).get(`/api/issues/${created.body.id}`).expect(200);
    expect(reGet.body.parentId).toBe(parent.id);

    // The DB row is the source of truth: the child really is parented, so child
    // rollup / parent close gates see a non-empty child set.
    const rows = await db.select().from(issues).where(eq(issues.parentId, parent.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(created.body.id);
  });

  it("rejects the sibling parentIssueId spelling with a 400 naming the field", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentIssueId: parent.id, title: "Child with wrong parent spelling" });

    // The strict create schema turns the unknown key into a 400 that names it —
    // never a 2xx that discards it.
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unrecognized field(s): parentIssueId");

    // No issue was created, so there is nothing to silently drop.
    const rows = await db.select().from(issues).where(eq(issues.parentId, parent.id));
    expect(rows).toHaveLength(0);
  });

  // SUP-17538: the company-scoped create door must run the same non-authoritative
  // ADR-072 close-ladder advisory as the child-create and accepted-plan doors.
  // This runs against the real store, so the shared shape helper, the durable
  // dedup marker, and the system comment are all exercised end to end.
  it("emits the ADR-072 close-ladder advisory on the parent when the create reaches two laddered children", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    // Two ladder-carrying open children make the parent a decomposed body; the
    // parent's executionPolicy carries none of the ratified ADR-072 rungs, so
    // its close ladder is shape-incomplete.
    await db.insert(issues).values([
      {
        companyId,
        parentId: parent.id,
        title: "Laddered child A",
        status: "todo",
        priority: "medium",
        executionPolicy: {
          stages: [
            { id: randomUUID(), type: "review", participants: [{ type: "agent", agentId: randomUUID() }] },
          ],
        },
      },
      {
        companyId,
        parentId: parent.id,
        title: "Laddered child B",
        status: "todo",
        priority: "medium",
        executionPolicy: {
          stages: [
            { id: randomUUID(), type: "review", participants: [{ type: "agent", agentId: randomUUID() }] },
          ],
        },
      },
    ]);

    const app = createApp();
    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Third child" })
      .expect(201);
    expect(created.body.parentId).toBe(parent.id);

    // The durable marker is written on the PARENT, not the new child, so the
    // advisory is discoverable from the card that owes the ladder.
    const advisoryRows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.adr072_close_ladder_incomplete"),
          eq(activityLog.entityId, parent.id),
        ),
      );
    expect(advisoryRows).toHaveLength(1);

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, parent.id));
    const advisories = comments.filter((row) =>
      (row.body ?? "").includes("[ADR-072 close ladder incomplete]"),
    );
    expect(advisories).toHaveLength(1);
    // Ratified order, all three rungs named.
    expect(advisories[0]!.body).toContain("review:support-QAE");
    expect(advisories[0]!.body).toContain("review:coder-LE");
    expect(advisories[0]!.body).toContain("approval:exec-CTO");
  });
});
