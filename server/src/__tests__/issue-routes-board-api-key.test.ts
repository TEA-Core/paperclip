import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  boardApiKeys,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
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
import { agentRoutes } from "../routes/agents.js";

function hashBearerToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * SUP-17867 (ii): the issue routes (comments, status PATCHes, interaction
 * resolutions, wakeups) must persist the board API key id on `activity_log` when
 * the write is attributable to a board API key. These drive a *real* board-key
 * request through the auth middleware (not a faked `req.actor`) and read the
 * row back to confirm `board_api_key_id` is set on the board-key path and stays
 * null on a session board write or an agent-key write.
 *
 * Lanes covered: `issue.comment_added` (comments), `issue.updated` (status),
 * `issue.thread_interaction_accepted` (interaction resolution), and
 * `heartbeat.invoked` (agent wakeup, driven through the agent routes).
 */
describeEmbeddedPostgres("issue routes board API key attribution", () => {
  const pg = useEmbeddedPostgres("paperclip-board-api-key-issue-routes-");

  let db!: ReturnType<typeof createDb>;
  let companyId = "";
  let userId = "";
  let keyA = "";
  let keyB = "";
  let agentId = "";
  let agentKeyId = "";
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

    // An agent key for the same agent, to prove an agent-key write on these
    // routes leaves `board_api_key_id` null (no spurious attribution).
    agentKeyId = randomUUID();
    await db.insert(agentApiKeys).values({
      id: agentKeyId,
      agentId,
      companyId,
      name: "board-key-attribution-agent-key",
      keyHash: hashBearerToken("agent-key-token"),
      responsibleUserId: userId,
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
    app.use("/api", agentRoutes(db, {} as any));
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

  it("leaves board_api_key_id null for an agent-key write (agent-key negative)", async () => {
    const issueId = await seedIssue();

    // An agent comment is attributed to a live heartbeat run (cross-issue
    // influence cap + audit), so mint one for this agent and send its run id.
    const executionRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: executionRunId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId },
    });

    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set("Authorization", "Bearer agent-key-token")
      .set("X-Paperclip-Run-Id", executionRunId)
      .send({ body: "Agent key comment, no board key" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const [row] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.comment_added"))
      .then((rows) => rows.filter((r) => r.entityId === issueId));
    expect(row).toBeTruthy();
    expect(row!.actorType).toBe("agent");
    expect(row!.agentId).toBe(agentId);
    expect(row!.boardApiKeyId).toBeNull();
  });

  it("stores the board key id on a board-key interaction resolution (resolution lane)", async () => {
    const issueId = await seedIssue();
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "requested",
      createdByAgentId: agentId,
      payload: { version: 1, prompt: "Board-key resolution probe" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/issues/${issueId}/interactions/${interactionId}/accept`)
      .set("Authorization", "Bearer board-key-a-token")
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [row] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.thread_interaction_accepted"))
      .then((rows) => rows.filter((r) => r.entityId === issueId));
    expect(row).toBeTruthy();
    expect(row!.actorType).toBe("user");
    expect(row!.actorId).toBe(userId);
    expect(row!.boardApiKeyId).toBe(keyA);
  });

  it("stores the board key id on a board-key agent wakeup (wakeup lane)", async () => {
    // The audit row on this lane is written only when `heartbeat.wakeup` mints a
    // real run; a suppressed run engine returns a skipped receipt instead. Lift
    // the suppression just for this request (the live `process.env` is what the
    // service reads), then re-assert it before the fire-and-forget executor
    // starts so it stands down. This is the only wakeup in the suite, so there
    // is exactly one `heartbeat.invoked` row to assert.
    delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    let res;
    try {
      res = await request(app)
        .post(`/api/agents/${agentId}/wakeup`)
        .set("Authorization", "Bearer board-key-a-token")
        .send({ reason: "board-key-wakeup-probe" });
    } finally {
      process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    }
    expect(res.status, JSON.stringify(res.body)).toBe(202);

    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "heartbeat.invoked"))
      .then((rs) => rs.filter((r) => r.entityId !== null));
    expect(rows.length).toBe(1);
    expect(rows[0].actorType).toBe("user");
    expect(rows[0].actorId).toBe(userId);
    expect(rows[0].boardApiKeyId).toBe(keyA);
  });
});
