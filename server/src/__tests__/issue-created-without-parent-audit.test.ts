import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  issues,
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
    `Skipping embedded Postgres "issue created without parent" audit tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue created without parent audit row (SUP-15668)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let currentActor!: Express.Request["actor"];
  let previousSchedulingSuppression: string | undefined;

  beforeAll(async () => {
    // A create that assigns a run can queue a background heartbeat run; the run
    // engine outlives the request and keeps querying while the embedded Postgres
    // is torn down, surfacing as an unhandled vitest error even though every
    // assertion passed. Suppress the run engine for this suite, which is only
    // about the audit row on the request path.
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-created-without-parent-audit-");
    db = createDb(tempDb.connectionString);
    app = createApp();
  }, 60_000);

  afterEach(async () => {
    await allowActivityLogInserts();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousSchedulingSuppression === undefined) {
      delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    } else {
      process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = previousSchedulingSuppression;
    }
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = currentActor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  /** Reject every new `activity_log` insert so an audit write genuinely fails. */
  async function rejectActivityLogInserts() {
    await db.execute(sql.raw(
      "alter table activity_log add constraint activity_log_force_failure check (false) not valid",
    ));
  }

  async function allowActivityLogInserts() {
    await db.execute(sql.raw(
      "alter table activity_log drop constraint if exists activity_log_force_failure",
    ));
  }

  async function seedCompany(issuePrefix: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "OrphanCreatingAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedBoardMembership(companyId: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
  }

  async function seedParent(companyId: string) {
    const [parent] = await db.insert(issues).values({
      companyId,
      title: "Parent for child create",
      status: "todo",
      priority: "medium",
    }).returning();
    return parent;
  }

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, source: "agent_key" };
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "cloud-user-1",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      source: "cloud_tenant",
      isInstanceAdmin: false,
    };
  }

  async function createdWithoutParentRows(companyId: string) {
    return db
      .select({
        id: activityLog.id,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
        agentId: activityLog.agentId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.created_without_parent"),
        ),
      );
  }

  async function countCreated(companyId: string) {
    const rows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.created")));
    return rows.length;
  }

  it("records exactly one issue.created_without_parent row when an agent creates a top-level issue", async () => {
    const companyId = await seedCompany("NPW");
    const agentId = await seedAgent(companyId);
    currentActor = agentActor(companyId, agentId);

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Orphan root card" })
      .expect(201);
    const createdId = res.body.id as string;
    const createdIdentifier = res.body.identifier as string;

    const rows = await createdWithoutParentRows(companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityType: "issue",
      entityId: createdId,
      agentId,
    });
    expect(rows[0].details).toMatchObject({
      issueId: createdId,
      identifier: createdIdentifier,
      companyId,
      projectId: null,
      actorAgentId: agentId,
      hasBlockedByIssueIds: false,
    });
    // The regular issue.created row still lands; the new row is additive.
    expect(await countCreated(companyId)).toBe(1);
  });

  it("carries hasBlockedByIssueIds=true when an agent top-level create passes blockedByIssueIds", async () => {
    const companyId = await seedCompany("NPB");
    const agentId = await seedAgent(companyId);
    currentActor = agentActor(companyId, agentId);
    const blocker = await seedParent(companyId);

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Blocked orphan root", blockedByIssueIds: [blocker.id] })
      .expect(201);

    const rows = await createdWithoutParentRows(companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({
      issueId: res.body.id,
      hasBlockedByIssueIds: true,
    });
  });

  it("records no issue.created_without_parent row when an agent creates a child issue", async () => {
    const companyId = await seedCompany("NPL");
    const agentId = await seedAgent(companyId);
    currentActor = agentActor(companyId, agentId);
    const parent = await seedParent(companyId);

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Ordinary child" })
      .expect(201);

    expect(await createdWithoutParentRows(companyId)).toHaveLength(0);
  });

  it("records no issue.created_without_parent row when a board user creates a top-level issue", async () => {
    const companyId = await seedCompany("NPU");
    await seedBoardMembership(companyId);
    currentActor = boardActor(companyId);

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Board root card" })
      .expect(201);

    expect(await createdWithoutParentRows(companyId)).toHaveLength(0);
  });

  it("still returns 201 and persists the issue when the audit insert fails for an agent top-level create", async () => {
    const companyId = await seedCompany("NPF");
    const agentId = await seedAgent(companyId);
    currentActor = agentActor(companyId, agentId);
    await rejectActivityLogInserts();

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Orphan despite broken audit" })
      .expect(201);
    const createdId = res.body.id as string;

    const [persisted] = await db.select({ id: issues.id }).from(issues).where(eq(issues.id, createdId));
    expect(persisted).toMatchObject({ id: createdId });
    // The broken audit table swallowed the write; no row landed.
    expect(await createdWithoutParentRows(companyId)).toHaveLength(0);
  });
});
