import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  boardApiKeys,
  createDb,
  inboxDismissals,
  projects,
} from "@paperclipai/db";
import {
  describeEmbeddedPostgres,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";
import { errorHandler } from "../middleware/index.js";
import { actorMiddleware } from "../middleware/auth.js";
import { inboxDismissalRoutes } from "../routes/inbox-dismissals.js";
import { projectRoutes } from "../routes/projects.js";
import { activityRoutes } from "../routes/activity.js";
import { logActivity } from "../services/activity-log.js";

function hashBearerToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function seedAuthUser(db: Parameters<typeof seedCompanyWithBoardAccess>[0], userId: string, label: string) {
  await db.insert(authUsers).values({
    id: userId,
    name: `Board User ${label}`,
    email: `${label}-${userId.slice(0, 8)}@example.com`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedBoardKey(
  db: Parameters<typeof seedCompanyWithBoardAccess>[0],
  input: { id: string; userId: string; name: string; token: string },
) {
  await db.insert(boardApiKeys).values({
    id: input.id,
    userId: input.userId,
    name: input.name,
    keyHash: hashBearerToken(input.token),
    scope: "all_access",
  });
}

describeEmbeddedPostgres("activity_log board API key attribution", () => {
  const pg = useEmbeddedPostgres("paperclip-board-api-key-activity-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(inboxDismissals);
      await db.delete(projects);
    },
  });

  let db!: ReturnType<typeof createDb>;
  let companyId = "";
  let userId = "";
  let keyA = "";
  let keyB = "";
  let keyC = "";
  let agentId = "";
  let agentKeyId = "";
  let app: express.Express;

  beforeAll(async () => {
    db = pg.db;
    const seeded = await seedCompanyWithBoardAccess(db, "Board Key Attribution");
    companyId = seeded.companyId;
    userId = seeded.userId;
    await seedAuthUser(db, userId, "attribution");

    keyA = randomUUID();
    keyB = randomUUID();
    keyC = randomUUID();
    await seedBoardKey(db, { id: keyA, userId, name: "board-key-a", token: "board-key-a-token" });
    await seedBoardKey(db, { id: keyB, userId, name: "board-key-b", token: "board-key-b-token" });
    await seedBoardKey(db, { id: keyC, userId, name: "board-key-c", token: "board-key-c-token" });

    agentId = randomUUID();
    agentKeyId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Attribution Agent",
      status: "idle",
    });
    await db.insert(agentApiKeys).values({
      id: agentKeyId,
      agentId,
      companyId,
      name: "attribution-agent-key",
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
    app.use(inboxDismissalRoutes(db));
    app.use(projectRoutes(db));
    app.use(activityRoutes(db));
    app.use(errorHandler);
  }, 60_000);

  it("stores the board key id on a real board-key write and reads it back unredacted", async () => {
    const itemKey = `approval:${randomUUID()}`;
    const res = await request(app)
      .post(`/companies/${companyId}/inbox-dismissals`)
      .set("Authorization", "Bearer board-key-a-token")
      .send({ itemKey });
    expect(res.status).toBe(201);

    const [row] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "inbox.dismissed"));
    expect(row).toBeTruthy();
    expect(row!.actorType).toBe("user");
    expect(row!.boardApiKeyId).toBe(keyA);

    const read = await request(app)
      .get(`/companies/${companyId}/activity?action=inbox.dismissed&entityType=company`)
      .set("Authorization", "Bearer board-key-a-token");
    expect(read.status).toBe(200);
    const readRow = (read.body as Array<Record<string, unknown>>).find(
      (item) => item.action === "inbox.dismissed",
    );
    expect(readRow).toBeTruthy();
    expect(readRow!.boardApiKeyId).toBe(keyA);
    expect(String(readRow!.boardApiKeyId)).not.toContain("REDACTED");
  });

  it("produces distinguishable rows for two different board keys", async () => {
    const dismissRes = await request(app)
      .post(`/companies/${companyId}/inbox-dismissals`)
      .set("Authorization", "Bearer board-key-a-token")
      .send({ itemKey: `run:${randomUUID()}` });
    expect(dismissRes.status).toBe(201);

    const createRes = await request(app)
      .post(`/companies/${companyId}/projects`)
      .set("Authorization", "Bearer board-key-b-token")
      .send({ name: "Board Key Project" });
    expect(createRes.status).toBe(201);

    const [byA] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "inbox.dismissed"));
    const [byB] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "project.created"));
    expect(byA).toBeTruthy();
    expect(byB).toBeTruthy();
    expect(byA!.boardApiKeyId).toBe(keyA);
    expect(byB!.boardApiKeyId).toBe(keyB);
    expect(byA!.boardApiKeyId).not.toBe(byB!.boardApiKeyId);
  });

  it("leaves board_api_key_id null for an agent-key write", async () => {
    const res = await request(app)
      .post(`/companies/${companyId}/projects`)
      .set("Authorization", "Bearer agent-key-token")
      .send({ name: "Agent Key Project" });
    expect(res.status).toBe(201);

    const [row] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "project.created"));
    expect(row).toBeTruthy();
    expect(row!.actorType).toBe("agent");
    expect(row!.boardApiKeyId).toBeNull();
  });

  it("leaves board_api_key_id null for a session write", async () => {
    const res = await request(app)
      .post(`/companies/${companyId}/inbox-dismissals`)
      .set("x-test-session", "yes")
      .send({ itemKey: `attention:${randomUUID()}` });
    expect(res.status).toBe(201);

    const [row] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "inbox.dismissed"));
    expect(row).toBeTruthy();
    expect(row!.actorType).toBe("user");
    expect(row!.actorId).toBe(userId);
    expect(row!.boardApiKeyId).toBeNull();
  });

  it("nulls board_api_key_id when the key is deleted (ON DELETE SET NULL)", async () => {
    const res = await request(app)
      .post(`/companies/${companyId}/inbox-dismissals`)
      .set("Authorization", "Bearer board-key-c-token")
      .send({ itemKey: `join:${randomUUID()}` });
    expect(res.status).toBe(201);

    const [row] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "inbox.dismissed"));
    expect(row!.boardApiKeyId).toBe(keyC);

    await db.delete(boardApiKeys).where(eq(boardApiKeys.id, keyC));

    const [after] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.id, row!.id));
    expect(after).toBeTruthy();
    expect(after!.boardApiKeyId).toBeNull();
    expect(after!.companyId).toBe(companyId);
  });

  it("ignores a malformed board_api_key_id instead of tripping the foreign key", async () => {
    const activity = await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      action: "board.key_write",
      entityType: "company",
      entityId: companyId,
      boardApiKeyId: "not-a-real-key",
    });
    expect(activity?.id).toBeTruthy();

    const [row] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.id, activity!.id));
    expect(row.boardApiKeyId).toBeNull();
  });

  it("exposes the board_api_key_id column, foreign key, and composite index on activity_log", async () => {
    const [column] = await db.execute(
      sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'activity_log' AND column_name = 'board_api_key_id'`,
    );
    expect(column).toBeTruthy();

    const [indexRow] = await db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'activity_log' AND indexname = 'activity_log_company_board_api_key_created_idx'`,
    );
    expect(indexRow).toBeTruthy();

    const [fkRow] = await db.execute(
      sql`SELECT conname FROM pg_constraint WHERE conrelid = 'activity_log'::regclass AND confrelid = 'board_api_keys'::regclass AND contype = 'f'`,
    );
    expect(fkRow).toBeTruthy();
  });
});
