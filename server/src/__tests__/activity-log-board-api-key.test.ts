import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Request } from "express";
import {
  activityLog,
  authUsers,
  boardApiKeys,
  companies,
  createDb,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logActivity, type LogActivityInput } from "../services/activity-log.js";
import { getActorInfo } from "../routes/authz.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres board API key activity tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Build a request whose `actor` is shaped exactly the way `middleware/auth.ts` sets it after
 * resolving a board API key (type "board", source "board_key", keyId = the key row id). This
 * is the input the board-key call sites hand to `getActorInfo`, so it exercises the real seam
 * without standing up the full auth middleware stack.
 */
function boardKeyRequest(input: { userId: string; keyId: string; source?: "board_key" | "session" }) {
  return {
    actor: {
      type: "board" as const,
      userId: input.userId,
      keyId: input.keyId,
      boardKeyScope: "all_access",
      source: input.source ?? "board_key",
    },
  } as unknown as Request;
}

async function seedCompany(db: Db, companyId: string) {
  await db.insert(companies).values({
    id: companyId,
    name: "Board Key Co",
    issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
}

async function seedAuthUser(db: Db, userId: string) {
  await db.insert(authUsers).values({
    id: userId,
    name: "Board User",
    email: `board-${userId}@example.com`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedBoardKey(db: Db, input: { id: string; userId: string }) {
  await db.insert(boardApiKeys).values({
    id: input.id,
    userId: input.userId,
    name: "Test Board Key",
    keyHash: `hash-${input.id}`,
  });
}

describeEmbeddedPostgres("activity_log board API key attribution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-board-key-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(boardApiKeys);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists board_api_key_id for a board-key write and reads it back unredacted", async () => {
    const companyId = randomUUID();
    const userId = `board-user-${randomUUID()}`;
    const boardKeyId = randomUUID();
    await seedCompany(db, companyId);
    await seedAuthUser(db, userId);
    await seedBoardKey(db, { id: boardKeyId, userId });

    const actor = getActorInfo(boardKeyRequest({ userId, keyId: boardKeyId }));
    expect(actor.actorType).toBe("user");
    expect(actor.actorSource).toBe("board_key");
    expect(actor.boardApiKeyId).toBe(boardKeyId);
    expect(actor.agentApiKeyId).toBeNull();

    const publications: unknown[] = [];
    const input: LogActivityInput = {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "board.key_write",
      entityType: "company",
      entityId: companyId,
      agentApiKeyId: actor.agentApiKeyId,
      boardApiKeyId: actor.boardApiKeyId,
      responsibleUserIdOverride: userId,
    };
    const activity = await logActivity(db, input, publications as never);

    expect(activity?.id).toBeTruthy();
    const [row] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.id, activity!.id));
    expect(row.boardApiKeyId).toBe(boardKeyId);
    expect(row.boardApiKeyId).not.toContain("REDACTED");
    expect((publications[0] as { payload: Record<string, unknown> }).payload.boardApiKeyId).toBe(boardKeyId);
  });

  it("leaves board_api_key_id null for a session (non board-key) request", async () => {
    const companyId = randomUUID();
    const userId = `session-user-${randomUUID()}`;
    const someKeyId = randomUUID();
    await seedCompany(db, companyId);
    await seedAuthUser(db, userId);

    // A session actor carries a key id on the request but source "session", so
    // getActorInfo must NOT attribute it to a board key.
    const actor = getActorInfo(boardKeyRequest({ userId, keyId: someKeyId, source: "session" }));
    expect(actor.actorType).toBe("user");
    expect(actor.boardApiKeyId).toBeNull();

    const publications: unknown[] = [];
    const activity = await logActivity(
      db,
      {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "session.worked",
        entityType: "company",
        entityId: companyId,
        boardApiKeyId: actor.boardApiKeyId,
        responsibleUserIdOverride: userId,
      },
      publications as never,
    );
    expect(activity?.id).toBeTruthy();

    const [row] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.id, activity!.id));
    expect(row.boardApiKeyId).toBeNull();
  });

  it("distinguishes two different board keys", async () => {
    const companyId = randomUUID();
    const userId = `two-key-user-${randomUUID()}`;
    const keyA = randomUUID();
    const keyB = randomUUID();
    await seedCompany(db, companyId);
    await seedAuthUser(db, userId);
    await seedBoardKey(db, { id: keyA, userId });
    await seedBoardKey(db, { id: keyB, userId });

    const publications: unknown[] = [];
    const write = (keyId: string) =>
      logActivity(
        db,
        {
          companyId,
          actorType: "user",
          actorId: userId,
          action: "board.wrote",
          entityType: "company",
          entityId: companyId,
          boardApiKeyId: keyId,
          responsibleUserIdOverride: userId,
        },
        publications as never,
      );
    const a = await write(keyA);
    const b = await write(keyB);

    const byA = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.boardApiKeyId, keyA)));
    const byB = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.boardApiKeyId, keyB)));
    expect(byA.map((r) => r.id)).toEqual([a!.id]);
    expect(byB.map((r) => r.id)).toEqual([b!.id]);
    expect(a!.id).not.toBe(b!.id);
  });

  it("nulls board_api_key_id when the key is deleted (ON DELETE SET NULL)", async () => {
    const companyId = randomUUID();
    const userId = `deleted-key-user-${randomUUID()}`;
    const boardKeyId = randomUUID();
    await seedCompany(db, companyId);
    await seedAuthUser(db, userId);
    await seedBoardKey(db, { id: boardKeyId, userId });

    const publications: unknown[] = [];
    const activity = await logActivity(
      db,
      {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "board.key_write",
        entityType: "company",
        entityId: companyId,
        boardApiKeyId: boardKeyId,
        responsibleUserIdOverride: userId,
      },
      publications as never,
    );
    expect(activity?.id).toBeTruthy();

    await db.delete(boardApiKeys).where(eq(boardApiKeys.id, boardKeyId));

    const [row] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.id, activity!.id));
    expect(row.boardApiKeyId).toBeNull();
  });

  it("ignores a malformed board_api_key_id instead of tripping the foreign key", async () => {
    const companyId = randomUUID();
    const userId = `malformed-key-user-${randomUUID()}`;
    await seedCompany(db, companyId);
    await seedAuthUser(db, userId);

    const publications: unknown[] = [];
    const activity = await logActivity(
      db,
      {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "board.key_write",
        entityType: "company",
        entityId: companyId,
        boardApiKeyId: "not-a-real-key",
        responsibleUserIdOverride: userId,
      },
      publications as never,
    );
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
