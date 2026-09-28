import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { sql, eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import {
  agents,
  closeRegisteredClients,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const embeddedPostgresSupport = externalTestDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres duplicate close-comment dedup tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * SUP-17808 (exec-CTO ruling Q2, approved by support-CR 2026-09-28T03:54:48Z):
 * a done-close `PATCH /issues/:id` against an already-terminal issue used to append a
 * second, byte-identical close comment — the status transition and the
 * `issue_execution_decisions` row were already idempotent, only the inline comment was
 * not. That asymmetry is the whole defect.
 *
 * The ruled predicate (do not widen): suppress the comment only when BOTH hold —
 *   1. the issue is already terminal (done/cancelled) at PATCH time, AND
 *   2. the incoming body is byte-identical to the most recent agent comment on the
 *      thread.
 * Everything else appends. The response must explicitly distinguish deduplicated from
 * appended, and suppression must be atomic under concurrent identical PATCHes.
 */
describeEmbeddedPostgres("duplicate close-comment dedup on terminal issues (SUP-17808)", () => {
  let db!: Db;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  let app!: express.Express;
  let currentActor!: Express.Request["actor"];
  let previousSchedulingSuppression: string | undefined;

  beforeAll(async () => {
    previousSchedulingSuppression =
      process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    if (externalTestDatabaseUrl) {
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-dup-close-dedup-",
      );
      db = createDb(tempDb.connectionString);
    }
    await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
    app = createApp();
  }, 60_000);

  afterAll(async () => {
    // A terminal PATCH expires pending thread interactions after the response is
    // sent, so that query can still be in flight when the embedded database goes
    // away — surfacing as a CONNECTION_ENDED unhandled rejection. Drain first.
    if (db) await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    if (externalTestDatabaseUrl) {
      await closeRegisteredClients(externalTestDatabaseUrl);
    }
    await tempDb?.cleanup();
    if (previousSchedulingSuppression === undefined) {
      delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    } else {
      process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS =
        previousSchedulingSuppression;
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

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user-1",
      companyIds: [companyId],
      memberships: [
        { companyId, membershipRole: "owner", status: "active" },
      ],
      source: "cloud_tenant",
      isInstanceAdmin: false,
    } as unknown as Express.Request["actor"];
  }

  async function seedIssue(prefix: string, status: string) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const identifier = `${prefix}-1`;
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Closer",
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
      title: "Duplicate close dedup",
      status,
      priority: "medium",
    });
    return { companyId, issueId, agentId, identifier };
  }

  async function seedAgentCloseComment(
    companyId: string,
    issueId: string,
    agentId: string,
    body: string,
  ) {
    const [row] = await db
      .insert(issueComments)
      .values({
        companyId,
        issueId,
        authorAgentId: agentId,
        authorType: "agent",
        body,
      })
      .returning();
    return row;
  }

  async function commentRowsFor(issueId: string) {
    return db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
  }

  async function statusOf(issueId: string) {
    const rows = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    return rows[0]?.status;
  }

  it("terminal issue + byte-identical most-recent agent comment => no second row, status still done, response flags the dedup", async () => {
    const { companyId, issueId, agentId, identifier } = await seedIssue(
      "SUP17808A",
      "done",
    );
    const target = await seedAgentCloseComment(
      companyId,
      issueId,
      agentId,
      "Closed at Tier 1 (landed): SUP-17808 dedup literal.",
    );
    currentActor = boardActor(companyId);

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({
        status: "done",
        comment: "Closed at Tier 1 (landed): SUP-17808 dedup literal.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The status transition still returns success and the issue stays terminal.
    expect(res.body.status).toBe("done");
    // The response explicitly distinguishes a dedup from an append.
    expect(res.body.commentDeduplicated).toBe(true);
    expect(res.body.deduplicatedFromCommentId).toBe(target.id);
    expect(res.body.comment).toBeNull();

    // No second comment row: exactly the pre-existing agent close comment remains.
    const rows = await commentRowsFor(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(target.id);
    expect((await statusOf(issueId))).toBe("done");
  });

  it("terminal issue + non-identical body => comment appends, response says not deduped", async () => {
    const { companyId, issueId, agentId, identifier } = await seedIssue(
      "SUP17808B",
      "done",
    );
    await seedAgentCloseComment(companyId, issueId, agentId, "CLOSE-LITERAL-ONE");
    currentActor = boardActor(companyId);

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({
        status: "done",
        comment: "A genuinely different second opinion on the close.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.commentDeduplicated).toBe(false);
    expect(res.body.deduplicatedFromCommentId).toBeNull();
    expect(res.body.comment).not.toBeNull();
    expect(res.body.comment.body).toContain("genuinely different second opinion");

    // The different close comment is kept visible (a real second opinion).
    const rows = await commentRowsFor(issueId);
    expect(rows).toHaveLength(2);
    expect(
      rows.some((row) => row.body === "A genuinely different second opinion on the close."),
    ).toBe(true);
  });

  it("non-terminal issue + byte-identical body => comment appends, response says not deduped", async () => {
    const { companyId, issueId, agentId, identifier } = await seedIssue(
      "SUP17808C",
      "todo",
    );
    await seedAgentCloseComment(companyId, issueId, agentId, "CLOSE-LITERAL-ONE");
    currentActor = boardActor(companyId);

    // No status change: a plain comment on a non-terminal card. The dedup must
    // key on "already terminal" AND byte-identity, not identity alone.
    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({ comment: "CLOSE-LITERAL-ONE" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.commentDeduplicated).toBe(false);
    expect(res.body.deduplicatedFromCommentId).toBeNull();
    expect(res.body.comment).not.toBeNull();

    const rows = await commentRowsFor(issueId);
    expect(rows).toHaveLength(2);
  });

  it("cancelled terminal issue + byte-identical body => deduped too (terminal includes cancelled)", async () => {
    const { companyId, issueId, agentId, identifier } = await seedIssue(
      "SUP17808D",
      "cancelled",
    );
    const target = await seedAgentCloseComment(
      companyId,
      issueId,
      agentId,
      "CLOSE-LITERAL-CANCEL",
    );
    currentActor = boardActor(companyId);

    // Comment-only PATCH so the done-guard (which keys on resolving to `done`) is
    // not involved; the predicate still sees the card as terminal.
    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({ comment: "CLOSE-LITERAL-CANCEL" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.commentDeduplicated).toBe(true);
    expect(res.body.deduplicatedFromCommentId).toBe(target.id);
    expect(res.body.comment).toBeNull();
    const rows = await commentRowsFor(issueId);
    expect(rows).toHaveLength(1);
  });

  it("two simultaneous identical done-close PATCHes against the same terminal issue yield exactly one comment row", async () => {
    const { companyId, issueId, agentId, identifier } = await seedIssue(
      "SUP17808E",
      "done",
    );
    const target = await seedAgentCloseComment(
      companyId,
      issueId,
      agentId,
      "Closed at Tier 1 (landed): SUP-15882 twin literal.",
    );
    currentActor = boardActor(companyId);

    const [first, second] = await Promise.all([
      request(app)
        .patch(`/api/issues/${identifier}`)
        .send({
          status: "done",
          comment: "Closed at Tier 1 (landed): SUP-15882 twin literal.",
        }),
      request(app)
        .patch(`/api/issues/${identifier}`)
        .send({
          status: "done",
          comment: "Closed at Tier 1 (landed): SUP-15882 twin literal.",
        }),
    ]);

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(first.body.commentDeduplicated).toBe(true);
    expect(second.body.commentDeduplicated).toBe(true);
    expect(first.body.deduplicatedFromCommentId).toBe(target.id);
    expect(second.body.deduplicatedFromCommentId).toBe(target.id);

    // Atomicity: exactly one close comment row, the original — not two.
    const rows = await commentRowsFor(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(target.id);
    expect(await statusOf(issueId)).toBe("done");
  });

  it("status transition and idempotency are unchanged by the dedup", async () => {
    const { companyId, issueId, agentId, identifier } = await seedIssue(
      "SUP17808F",
      "done",
    );
    const target = await seedAgentCloseComment(
      companyId,
      issueId,
      agentId,
      "Closed at Tier 1 (landed): idempotent close literal.",
    );
    currentActor = boardActor(companyId);

    expect(await statusOf(issueId)).toBe("done");
    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({
        status: "done",
        comment: "Closed at Tier 1 (landed): idempotent close literal.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The transition is a no-op on an already-terminal card and stays done; no error.
    expect(res.body.status).toBe("done");
    expect(await statusOf(issueId)).toBe("done");
    // And the only close comment is still the original.
    const rows = await commentRowsFor(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(target.id);
  });
});
