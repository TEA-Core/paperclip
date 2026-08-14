import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { logActivityInTransaction } from "../services/activity-log.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres best-effort activity log route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("best-effort activity log on issue routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let currentActor!: Express.Request["actor"];
  let previousSchedulingSuppression: string | undefined;

  beforeAll(async () => {
    // Comment and status mutations fire `void heartbeat.wakeup(...)`, which queues a
    // real run and executes it in the background. Those runs outlive the request and
    // keep querying while `afterAll` shuts the embedded Postgres down, which surfaces
    // as a vitest unhandled error even though every assertion passed. This suite is
    // about the audit write on the request path, so suppress the run engine outright;
    // `PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS` is read only by
    // `resolveHeartbeatSchedulingSuppression`, so nothing else changes behavior.
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-log-best-effort-");
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

  /**
   * Reject every new `activity_log` insert. `NOT VALID` only skips the backfill check of
   * existing rows — new inserts are still enforced — so this reproduces a genuinely failing
   * audit write rather than the narrower "run id could not be resolved" case.
   */
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

  async function seedIssue(issuePrefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const identifier = `${issuePrefix}-1`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier,
      title: "Audit failures must not fail the mutation",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "cloud-user-1",
    });

    return { companyId, agentId, issueId, identifier };
  }

  /** A run id minted elsewhere: well-formed, but with no `heartbeat_runs` row here. */
  function unresolvableRunId() {
    return randomUUID();
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId,
    };
  }

  function boardActor(companyId: string, runId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "cloud-user-1",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      source: "cloud_tenant",
      isInstanceAdmin: false,
      runId,
    };
  }

  async function listIssueActivity(companyId: string, issueId: string) {
    const rows = await db
      .select({
        action: activityLog.action,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
        runId: activityLog.runId,
      })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    return rows.filter((row) => row.entityType === "issue" && row.entityId === issueId);
  }

  async function countCompanyActivity(companyId: string) {
    const rows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    return rows.length;
  }

  async function listComments(issueId: string) {
    return db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
  }

  async function readStatus(issueId: string) {
    return db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]?.status ?? null);
  }

  it.each([
    { label: "agent", issuePrefix: "BEA" },
    { label: "board", issuePrefix: "BEB" },
  ])("records a $label comment without a run id when the run is unknown here", async ({ label, issuePrefix }) => {
    const { companyId, agentId, issueId, identifier } = await seedIssue(issuePrefix);
    const runId = unresolvableRunId();
    currentActor = label === "agent" ? agentActor(companyId, agentId, runId) : boardActor(companyId, runId);

    const res = await request(app)
      .post(`/api/issues/${identifier}/comments`)
      .send({ body: "Audit write must not decide this request" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await listComments(issueId)).toEqual([
      { body: "Audit write must not decide this request" },
    ]);

    const activity = await listIssueActivity(companyId, issueId);
    expect(activity.map((row) => row.action)).toContain("issue.comment_added");
    expect(activity.every((row) => row.runId === null)).toBe(true);
  });

  it.each([
    { label: "agent", issuePrefix: "BEC" },
    { label: "board", issuePrefix: "BED" },
  ])("records a $label status change without a run id when the run is unknown here", async ({ label, issuePrefix }) => {
    const { companyId, agentId, issueId, identifier } = await seedIssue(issuePrefix);
    const runId = unresolvableRunId();
    currentActor = label === "agent" ? agentActor(companyId, agentId, runId) : boardActor(companyId, runId);

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({ status: "done", comment: "Closed at Tier 2 (live): best-effort audit path exercised." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await readStatus(issueId)).toBe("done");

    const activity = await listIssueActivity(companyId, issueId);
    expect(activity.map((row) => row.action)).toContain("issue.updated");
    expect(activity.every((row) => row.runId === null)).toBe(true);
  });

  it.each([
    { label: "agent", issuePrefix: "BEE" },
    { label: "board", issuePrefix: "BEF" },
  ])("keeps a $label comment committed when the audit insert fails", async ({ label, issuePrefix }) => {
    const { companyId, agentId, issueId, identifier } = await seedIssue(issuePrefix);
    currentActor = label === "agent"
      ? agentActor(companyId, agentId, unresolvableRunId())
      : boardActor(companyId, unresolvableRunId());
    await rejectActivityLogInserts();

    const res = await request(app)
      .post(`/api/issues/${identifier}/comments`)
      .send({ body: "Committed despite a broken audit table" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await listComments(issueId)).toEqual([
      { body: "Committed despite a broken audit table" },
    ]);
    expect(await countCompanyActivity(companyId)).toBe(0);
  });

  it.each([
    { label: "agent", issuePrefix: "BEG" },
    { label: "board", issuePrefix: "BEH" },
  ])("keeps a $label status change committed when the audit insert fails", async ({ label, issuePrefix }) => {
    const { companyId, agentId, issueId, identifier } = await seedIssue(issuePrefix);
    currentActor = label === "agent"
      ? agentActor(companyId, agentId, unresolvableRunId())
      : boardActor(companyId, unresolvableRunId());
    await rejectActivityLogInserts();

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({ status: "done", comment: "Closed at Tier 2 (live): best-effort audit path exercised." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await readStatus(issueId)).toBe("done");
    expect(await countCompanyActivity(companyId)).toBe(0);
  });

  it("still propagates audit failures from logActivityInTransaction", async () => {
    const { companyId, agentId, issueId } = await seedIssue("BEI");
    await rejectActivityLogInserts();

    await expect(logActivityInTransaction(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
    })).rejects.toThrow();
  });
});
