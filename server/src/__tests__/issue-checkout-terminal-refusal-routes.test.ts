import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projects,
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
    `Skipping embedded Postgres checkout terminal-refusal route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
type ExecutionWorkspaceRow = typeof executionWorkspaces.$inferSelect;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(company: CompanyRow): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [company.id],
    memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

async function seedCompany(db: Db, label = "Terminal") {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `${label} ${nonce}`,
    issuePrefix: `TR${nonce.slice(0, 4).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
  }).returning();
  return company!;
}

async function seedAgent(db: Db, companyId: string) {
  const [agent] = await db.insert(agents).values({
    companyId,
    name: `Agent ${randomUUID().slice(0, 6)}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  }).returning();
  return agent!;
}

async function seedProject(db: Db, companyId: string, name: string) {
  const [project] = await db.insert(projects).values({
    companyId,
    name,
    status: "in_progress",
  }).returning();
  return project!;
}

async function seedClosedIsolatedWorkspace(
  db: Db,
  input: { companyId: string; projectId: string; closedAt: Date },
): Promise<ExecutionWorkspaceRow> {
  const [workspace] = await db
    .insert(executionWorkspaces)
    .values({
      companyId: input.companyId,
      projectId: input.projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: `ws-${randomUUID().slice(0, 8)}`,
      status: "archived",
      providerType: "git_worktree",
      closedAt: input.closedAt,
    })
    .returning();
  return workspace!;
}

describeEmbeddedPostgres("issue checkout terminal-refusal route", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-checkout-terminal-refusal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it(
    "refuses a live-status checkout against a persisted done card with the distinct code, leaving the row and its closed workspace unchanged (SUP-15832)",
    async () => {
      // End-to-end reproduction of the SUP-15832 shape: a card that closed
      // through an approved ladder (done, with a completedAt) is later checked
      // out by a late run. The body names a LIVE status (["in_progress"] — the
      // exact list heartbeat.ts passes), so it clears the schema and would
      // previously rebuild the closed worktree and flip the card back to
      // in_progress. The route must instead refuse with the distinct code before
      // any workspace work, and the persisted row must stay byte-identical.
      const company = await seedCompany(db);
      const project = await seedProject(db, company.id, "Core");
      const agent = await seedAgent(db, company.id);
      const completedAt = new Date("2026-09-12T04:06:22.291Z");
      const closedAt = new Date("2026-09-12T04:06:30.000Z");
      const workspace = await seedClosedIsolatedWorkspace(db, {
        companyId: company.id,
        projectId: project.id,
        closedAt,
      });

      const [issue] = await db
        .insert(issues)
        .values({
          companyId: company.id,
          projectId: project.id,
          title: "Closed card checked out by a late run",
          status: "done",
          priority: "medium",
          statusVersion: 4,
          assigneeAgentId: agent.id,
          responsibleUserId: "board-user",
          startedAt: new Date("2026-09-12T04:00:00.000Z"),
          completedAt,
          executionWorkspaceId: workspace.id,
        })
        .returning();
      const doneIssue = issue!;

      const beforeIssue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, doneIssue.id))
        .then((rows) => rows[0]);
      const beforeWorkspace = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, workspace.id))
        .then((rows) => rows[0]);

      const res = await request(createApp(db, boardActor(company)))
        .post(`/api/issues/${doneIssue.id}/checkout`)
        .send({ agentId: agent.id, expectedStatuses: ["in_progress"] });

      // Distinct terminal refusal, not a generic 400/409.
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body).toMatchObject({
        code: "checkout_refused_terminal_status",
        details: { code: "checkout_refused_terminal_status", status: "done" },
      });

      // A refused checkout is a no-op write: the whole row is byte-identical —
      // status, completedAt, statusVersion, and the checkout/execution run
      // pointers all unchanged.
      const afterIssue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, doneIssue.id))
        .then((rows) => rows[0]);
      expect(afterIssue).toEqual(beforeIssue);
      expect(afterIssue).toMatchObject({
        status: "done",
        completedAt,
        statusVersion: 4,
        checkoutRunId: null,
        executionRunId: null,
      });

      // And no closed execution worktree was rebuilt or republished for a
      // checkout that cannot succeed.
      const afterWorkspace = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, workspace.id))
        .then((rows) => rows[0]);
      expect(afterWorkspace).toEqual(beforeWorkspace);
      expect(afterWorkspace).toMatchObject({ status: "archived", closedAt });
    },
  );

  it("fails closed at validation when the body names a terminal status, before touching the persisted row", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const agent = await seedAgent(db, company.id);
    const completedAt = new Date("2026-09-12T04:06:22.291Z");

    const [issue] = await db
      .insert(issues)
      .values({
        companyId: company.id,
        projectId: project.id,
        title: "Closed card, terminal status named in the body",
        status: "done",
        priority: "medium",
        statusVersion: 4,
        assigneeAgentId: agent.id,
        responsibleUserId: "board-user",
        completedAt,
      })
      .returning();
    const doneIssue = issue!;

    const beforeIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, doneIssue.id))
      .then((rows) => rows[0]);

    // A body that names a terminal status is refused at the checkoutIssueSchema,
    // so the route fails closed with 400 — the distinct terminal code is a
    // service/route refusal, not a validation error.
    const res = await request(createApp(db, boardActor(company)))
      .post(`/api/issues/${doneIssue.id}/checkout`)
      .send({ agentId: agent.id, expectedStatuses: ["done"] });

    expect(res.status).toBe(400);
    expect(res.body).not.toMatchObject({ code: "checkout_refused_terminal_status" });

    const afterIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, doneIssue.id))
      .then((rows) => rows[0]);
    expect(afterIssue).toEqual(beforeIssue);
  });
});
