import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  approvalComments,
  approvals,
  authUsers,
  boardApiKeys,
  createDb,
} from "@paperclipai/db";
import {
  describeEmbeddedPostgres,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";
import { errorHandler } from "../middleware/index.js";
import { actorMiddleware } from "../middleware/auth.js";
import { approvalRoutes } from "../routes/approvals.js";
import { activityRoutes } from "../routes/activity.js";

function hashBearerToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * SUP-17868 (i)+(ii): the approval routes (create, approve, reject,
 * request-revision, resubmit, comment) must persist the board API key id on
 * `activity_log` when the write is attributable to a board API key. These drive
 * a *real* board-key request through the auth middleware (not a faked
 * `req.actor`) and read the row back to confirm `board_api_key_id` is set on
 * the board-key path and stays null on a session board write or an agent-key
 * write.
 *
 * Lanes covered: `approval.created`, `approval.approved`, `approval.rejected`,
 * `approval.revision_requested`, `approval.resubmitted`,
 * `approval.comment_added`, and `approval.requester_wakeup_queued` (the
 * requester-wakeup audit write fired by a board-key decision on an
 * agent-requested approval).
 *
 * Not covered here (documented in the PR body): `approval.review_path_wakeup_queued`
 * / `approval.review_path_wakeup_failed` (fire only when a linked issue is in
 * the `stalled` lost-review-path state) and `approval.requester_wakeup_failed`
 * (failure twin of the queued lane; fires only when `heartbeat.wakeup` throws,
 * wired with the same `boardApiKeyId`).
 */
describeEmbeddedPostgres("approval routes board API key attribution", () => {
  const pg = useEmbeddedPostgres("paperclip-board-api-key-approval-routes-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(approvalComments);
      await db.delete(approvals);
    },
  });

  let db!: ReturnType<typeof createDb>;
  let companyId = "";
  let userId = "";
  let keyA = "";
  let keyB = "";
  let agentId = "";
  let app!: express.Express;
  let previousSchedulingSuppression: string | undefined;

  beforeAll(async () => {
    // Approve/reject/request-revision `await heartbeat.wakeup(...)` on the
    // request path. With a real dispatch the queued run outlives the request
    // and keeps querying while the embedded cluster shuts down. This suite is
    // about the audit write on the request path, so suppress the run engine
    // outright (mirrors activity-log-best-effort-routes and
    // issue-routes-board-api-key). Under suppression `enqueueWakeup` writes a
    // skipped receipt and resolves null — no throw — so the
    // `approval.requester_wakeup_queued` audit write still fires.
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";

    db = pg.db;
    const seeded = await seedCompanyWithBoardAccess(db, "Board Key Approval Routes");
    companyId = seeded.companyId;
    userId = seeded.userId;

    // `resolveBoardAccess` gates the board-key auth on an existing auth user
    // row for the key's owner; seed it so the Bearer token resolves to a board actor.
    await db.insert(authUsers).values({
      id: userId,
      name: "Board Key Approval User",
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
      name: "Board Key Approval Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentApiKeys).values({
      id: randomUUID(),
      agentId,
      companyId,
      name: "board-key-approval-agent-key",
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
    app.use(approvalRoutes(db));
    app.use(activityRoutes(db));
    app.use(errorHandler);
  }, 60_000);

  afterAll(async () => {
    if (previousSchedulingSuppression === undefined) {
      delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    } else {
      process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = previousSchedulingSuppression;
    }
  });

  async function createApproval(opts: { token: string; requestedByAgentId?: string }): Promise<string> {
    const res = await request(app)
      .post(`/companies/${companyId}/approvals`)
      .set("Authorization", `Bearer ${opts.token}`)
      .send({
        type: "approve_ceo_strategy",
        payload: { note: "board key attribution probe" },
        ...(opts.requestedByAgentId ? { requestedByAgentId: opts.requestedByAgentId } : {}),
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }

  async function findActivityRows(action: string, entityId: string) {
    const rows = await db.select().from(activityLog).where(eq(activityLog.action, action));
    return rows.filter((row) => row.entityId === entityId);
  }

  it("stores the board key id on a board-key approval create and reads it back via the activity API", async () => {
    const approvalId = await createApproval({ token: "board-key-a-token" });

    const [created] = await findActivityRows("approval.created", approvalId);
    expect(created).toBeTruthy();
    expect(created!.actorType).toBe("user");
    expect(created!.actorId).toBe(userId);
    expect(created!.boardApiKeyId).toBe(keyA);

    const read = await request(app)
      .get(`/companies/${companyId}/activity?action=approval.created&entityType=approval`)
      .set("Authorization", "Bearer board-key-a-token");
    expect(read.status).toBe(200);
    const readRow = (read.body as Array<Record<string, unknown>>).find(
      (item) => item.action === "approval.created" && item.entityId === approvalId,
    );
    expect(readRow).toBeTruthy();
    expect(readRow!.boardApiKeyId).toBe(keyA);
    expect(String(readRow!.boardApiKeyId)).not.toContain("REDACTED");
  });

  it("attributes a board-key approval decision (approval.approved) and its requester-wakeup row", async () => {
    const approvalId = await createApproval({
      token: "board-key-a-token",
      requestedByAgentId: agentId,
    });

    const res = await request(app)
      .post(`/approvals/${approvalId}/approve`)
      .set("Authorization", "Bearer board-key-b-token")
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [approved] = await findActivityRows("approval.approved", approvalId);
    expect(approved).toBeTruthy();
    expect(approved!.actorType).toBe("user");
    expect(approved!.actorId).toBe(userId);
    expect(approved!.boardApiKeyId).toBe(keyB);

    const [wakeup] = await findActivityRows("approval.requester_wakeup_queued", approvalId);
    expect(wakeup).toBeTruthy();
    expect(wakeup!.boardApiKeyId).toBe(keyB);
  });

  it("attributes a board-key rejection (approval.rejected)", async () => {
    const approvalId = await createApproval({
      token: "board-key-a-token",
      requestedByAgentId: agentId,
    });

    const res = await request(app)
      .post(`/approvals/${approvalId}/reject`)
      .set("Authorization", "Bearer board-key-b-token")
      .send({ decisionNote: "Rejected via board key B" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [rejected] = await findActivityRows("approval.rejected", approvalId);
    expect(rejected).toBeTruthy();
    expect(rejected!.boardApiKeyId).toBe(keyB);

    const [wakeup] = await findActivityRows("approval.requester_wakeup_queued", approvalId);
    expect(wakeup).toBeTruthy();
    expect(wakeup!.boardApiKeyId).toBe(keyB);
  });

  it("attributes a board-key revision request (approval.revision_requested)", async () => {
    const approvalId = await createApproval({ token: "board-key-a-token" });

    const res = await request(app)
      .post(`/approvals/${approvalId}/request-revision`)
      .set("Authorization", "Bearer board-key-b-token")
      .send({ decisionNote: "Revise via board key B" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [revision] = await findActivityRows("approval.revision_requested", approvalId);
    expect(revision).toBeTruthy();
    expect(revision!.boardApiKeyId).toBe(keyB);
  });

  it("attributes a board-key resubmission (approval.resubmitted)", async () => {
    const approvalId = await createApproval({ token: "board-key-a-token" });

    const revise = await request(app)
      .post(`/approvals/${approvalId}/request-revision`)
      .set("Authorization", "Bearer board-key-a-token")
      .send({ decisionNote: "Revise first" });
    expect(revise.status, JSON.stringify(revise.body)).toBe(200);

    const res = await request(app)
      .post(`/approvals/${approvalId}/resubmit`)
      .set("Authorization", "Bearer board-key-b-token")
      .send({ payload: { note: "resubmitted via board key B" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [resubmitted] = await findActivityRows("approval.resubmitted", approvalId);
    expect(resubmitted).toBeTruthy();
    expect(resubmitted!.actorType).toBe("user");
    expect(resubmitted!.actorId).toBe(userId);
    expect(resubmitted!.boardApiKeyId).toBe(keyB);
  });

  it("attributes a board-key approval comment (approval.comment_added)", async () => {
    const approvalId = await createApproval({ token: "board-key-a-token" });

    const res = await request(app)
      .post(`/approvals/${approvalId}/comments`)
      .set("Authorization", "Bearer board-key-b-token")
      .send({ body: "Board key B comment" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const [comment] = await findActivityRows("approval.comment_added", approvalId);
    expect(comment).toBeTruthy();
    expect(comment!.boardApiKeyId).toBe(keyB);
  });

  it("leaves board_api_key_id null for an agent-key approval comment", async () => {
    const approvalId = await createApproval({ token: "board-key-a-token" });

    const res = await request(app)
      .post(`/approvals/${approvalId}/comments`)
      .set("Authorization", "Bearer agent-key-token")
      .send({ body: "Agent key comment" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const [comment] = await findActivityRows("approval.comment_added", approvalId);
    expect(comment).toBeTruthy();
    expect(comment!.actorType).toBe("agent");
    expect(comment!.boardApiKeyId).toBeNull();
  });

  it("leaves board_api_key_id null for a session board approval comment", async () => {
    const approvalId = await createApproval({ token: "board-key-a-token" });

    const res = await request(app)
      .post(`/approvals/${approvalId}/comments`)
      .set("x-test-session", "yes")
      .send({ body: "Session comment, no key" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const [comment] = await findActivityRows("approval.comment_added", approvalId);
    expect(comment).toBeTruthy();
    expect(comment!.actorType).toBe("user");
    expect(comment!.actorId).toBe(userId);
    expect(comment!.boardApiKeyId).toBeNull();
  });

  it("produces distinguishable rows for two different board keys on approval decisions", async () => {
    const approvedId = await createApproval({ token: "board-key-a-token" });
    const approveRes = await request(app)
      .post(`/approvals/${approvedId}/approve`)
      .set("Authorization", "Bearer board-key-a-token")
      .send({});
    expect(approveRes.status, JSON.stringify(approveRes.body)).toBe(200);

    const rejectedId = await createApproval({ token: "board-key-b-token" });
    const rejectRes = await request(app)
      .post(`/approvals/${rejectedId}/reject`)
      .set("Authorization", "Bearer board-key-b-token")
      .send({});
    expect(rejectRes.status, JSON.stringify(rejectRes.body)).toBe(200);

    const [byA] = await findActivityRows("approval.approved", approvedId);
    const [byB] = await findActivityRows("approval.rejected", rejectedId);
    expect(byA).toBeTruthy();
    expect(byB).toBeTruthy();
    expect(byA!.boardApiKeyId).toBe(keyA);
    expect(byB!.boardApiKeyId).toBe(keyB);
    expect(byA!.boardApiKeyId).not.toBe(byB!.boardApiKeyId);
  });
});
