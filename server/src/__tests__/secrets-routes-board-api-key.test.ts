import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  activityLog,
  authUsers,
  boardApiKeys,
  createDb,
  userSecretDefinitions,
} from "@paperclipai/db";
import {
  describeEmbeddedPostgres,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";
import { errorHandler } from "../middleware/index.js";
import { actorMiddleware } from "../middleware/auth.js";
import { secretRoutes } from "../routes/secrets.js";

function hashBearerToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * SUP-17872 (2c): the secrets routes (user_secret_value.created) must persist
 * the board API key id on `activity_log` when the write is attributable to a
 * board API key. Drives a *real* board-key request through the auth middleware
 * (not a faked `req.actor`) and reads the row back to confirm
 * `board_api_key_id` is set on the board-key path and stays null on a
 * session board write.
 *
 * Lanes covered: `user_secret_value.created` (the representative site from
 * this card's residual set in secrets.ts).
 */
describeEmbeddedPostgres("secrets routes board API key attribution", () => {
  const pg = useEmbeddedPostgres("paperclip-board-api-key-secrets-routes-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
    },
  });

  let db!: ReturnType<typeof createDb>;
  let companyId = "";
  let userId = "";
  let keyA = "";
  let definitionKey = "bk-attribution-key";
  let app!: express.Express;
  let previousSchedulingSuppression: string | undefined;

  beforeAll(async () => {
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";

    db = pg.db;
    const seeded = await seedCompanyWithBoardAccess(db, "Board Key Secrets Routes");
    companyId = seeded.companyId;
    userId = seeded.userId;

    await db.insert(authUsers).values({
      id: userId,
      name: "Board Key Secrets User",
      email: `board-key-secrets-${userId.slice(0, 8)}@example.com`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    keyA = randomUUID();
    await db.insert(boardApiKeys).values({
      id: keyA,
      userId,
      name: "board-key-secrets",
      keyHash: hashBearerToken("board-key-secrets-token"),
      scope: "all_access",
    });

    // Seed a user secret definition so the create-value route can resolve it.
    await db.insert(userSecretDefinitions).values({
      companyId,
      key: definitionKey,
      name: "Attribution Probe Secret",
      status: "active",
      provider: "local_encrypted",
      managedMode: "paperclip_managed",
      createdByUserId: userId,
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
    app.use("/api", secretRoutes(db, {}));
    app.use(errorHandler);
  }, 60_000);

  afterAll(async () => {
    if (previousSchedulingSuppression === undefined) {
      delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    } else {
      process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = previousSchedulingSuppression;
    }
  });

  it("stores the board key id on a board-key user secret value creation", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/me/user-secrets`)
      .set("Authorization", "Bearer board-key-secrets-token")
      .send({ definitionKey, value: "board-key-attribution-value" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const [row] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "user_secret_value.created"));
    expect(row).toBeTruthy();
    expect(row!.actorType).toBe("user");
    expect(row!.actorId).toBe(userId);
    expect(row!.boardApiKeyId).toBe(keyA);
  });

  it("leaves board_api_key_id null for a session board write", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/me/user-secrets`)
      .set("x-test-session", "yes")
      .send({ definitionKey: "bk-session-key", value: "session-value" });
    // Need a second definition for the session test to avoid the
    // "value already exists" conflict on the first definition.
    if (res.status !== 201) {
      // Seed a second definition and retry
      await db.insert(userSecretDefinitions).values({
        companyId,
        key: "bk-session-key",
        name: "Session Secret",
        status: "active",
        provider: "local_encrypted",
        managedMode: "paperclip_managed",
        createdByUserId: userId,
      });
      const retry = await request(app)
        .post(`/api/companies/${companyId}/me/user-secrets`)
        .set("x-test-session", "yes")
        .send({ definitionKey: "bk-session-key", value: "session-value" });
      expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    }

    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "user_secret_value.created"));
    const sessionRow = rows.find((r) => r.boardApiKeyId === null);
    expect(sessionRow, "expected a session write with null board_api_key_id").toBeTruthy();
    expect(sessionRow!.actorType).toBe("user");
    expect(sessionRow!.actorId).toBe(userId);
  });
});
