import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  boardApiKeys,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  describeEmbeddedPostgres,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";
import { errorHandler } from "../middleware/index.js";
import { actorMiddleware } from "../middleware/auth.js";
import { issueRoutes } from "../routes/issues.js";

function hashBearerToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * SUP-17867 (ii): the issue routes (comments, status PATCHes, interaction
 * resolutions, wakeups) must persist the board API key id on `activity_log` when
 * the write is attributable to a board API key. These drive a *real* board-key
 * request through the auth middleware (not a faked `req.actor`) and read the
 * row back to confirm `board_api_key_id` is set on the board-key path and stays
 * null on a session board write.
 */
describeEmbeddedPostgres("issue routes board API key attribution", () => {
  const pg = useEmbeddedPostgres("paperclip-board-api-key-issue-routes-");

  let db!: ReturnType<typeof createDb>;
  let companyId = "";
  let userId = "";
  let keyA = "";
  let keyB = "";
  let agentId = "";
  let app!: express.Express;
  let previousSchedulingSuppression: string | undefined;

  beforeAll(async () => {
    // Comment and status mutations fire `void heartbeat.wakeup(...)`, which
    // queues a real run that outlives the request and keeps querying while the
    // embedded cluster shuts down. This suite is about the audit write on the
    // request path, so suppress the run engine outright (mirrors
    // activity-log-best-effort-routes).
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";

    db = pg.db;
    const seeded = await seedCompanyWithBoardAccess(db, "Board Key Issue Routes");
    companyId = seeded.companyId;
    userId = seeded.userId;

    // `resolveBoardAccess` gates the board-key auth on an existing auth user
    // row for the key's owner; seed it so the Bearer token resolves to a board actor.
    await db.insert(authUsers).values({
      id: userId,
      name: "Board Key Attribution User",
      email: `board-key-${userId.slice(0, 8)}@example.com`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    keyA = randomUUID();
    keyB = randomUUID();
    await db.insert(boardApiKeys).values({
      id: keyA,
      userId,
      name: "board-key-a",
      keyHash: hashBearerToken("board-key-a-token"),
      scope: "all_access",
    });
    await db.insert(boardApiKeys).values({
      id: keyB,
      userId,
      name: "board-key-b",
      keyHash: hashBearerToken("board-key-b-token"),
      scope: "all_access",
    });

    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Board Key Attribution Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    app = express();
    app.use(express.json());
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async (req) =>
          req.header("x-test-session")
            ? {
                session: { id: "test-session", userId },
                user: { id: userId, name: "Session User", email: "session@example.com" },
              }
            : null,
      }),
    );
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
  }, 60_000);

  afterAll(async () => {
    if (previousSchedulingSuppression === undefined) {
      delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    } else {
      process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = previousSchedulingSuppression;
    }
  });

  async function seedIssue(status: "todo" = "todo"): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `BK-${issueId.slice(0, 8)}`,
      title: "Board key attribution probe",
      status,
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: userId,
    });
    return issueId;
  }

  it("stores the board key id on a board-key comment (comments lane)", async () => {
    const issueId = await seedIssue();

    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set("Authorization", "Bearer board-key-a-token")
      .send({ body: "Board key comment" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const [row] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.comment_added"))
      .then((rows) => rows.filter((r) => r.entityId === issueId));
    expect(row).toBeTruthy();
    expect(row!.actorType).toBe("user");
    expect(row!.actorId).toBe(userId);
    expect(row!.boardApiKeyId).toBe(keyA);
  });

  it("stores the board key id on a board-key status PATCH (status lane)", async () => {
    const issueId = await seedIssue();

    // Transitions into in_progress require activeRun evidence: stamp a live
    // execution run on the issue so the in_progress write carries it.
    const executionRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: executionRunId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId },
    });
    await db.update(issues).set({ executionRunId: executionRunId }).where(eq(issues.id, issueId));

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .set("Authorization", "Bearer board-key-a-token")
      .send({ status: "in_progress", comment: "Picked up via board key" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [statusRow] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.updated"))
      .then((rows) => rows.filter((r) => r.entityId === issueId));
    expect(statusRow).toBeTruthy();
    expect(statusRow!.boardApiKeyId).toBe(keyA);
  });

  it("leaves board_api_key_id null for a session board write (distinguishes the key path)", async () => {
    const issueId = await seedIssue();

    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set("x-test-session", "yes")
      .send({ body: "Session comment, no key" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const [row] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.comment_added"))
      .then((rows) => rows.filter((r) => r.entityId === issueId));
    expect(row).toBeTruthy();
    expect(row!.actorType).toBe("user");
    expect(row!.actorId).toBe(userId);
    expect(row!.boardApiKeyId).toBeNull();
  });

  it("produces distinguishable rows for two different board keys", async () => {
    const issueId = await seedIssue();

    const a = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set("Authorization", "Bearer board-key-a-token")
      .send({ body: "from key A" });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set("Authorization", "Bearer board-key-b-token")
      .send({ body: "from key B" });
    expect(b.status, JSON.stringify(b.body)).toBe(201);

    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.comment_added"))
      .then((rs) => rs.filter((r) => r.entityId === issueId));
    const byA = rows.find((r) => r.boardApiKeyId === keyA);
    const byB = rows.find((r) => r.boardApiKeyId === keyB);
    expect(byA).toBeTruthy();
    expect(byB).toBeTruthy();
    expect(byA!.boardApiKeyId).not.toBe(byB!.boardApiKeyId);
  });
});
