import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOARD_API_KEY_SCOPES } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";
import { createDb } from "./client.js";
import { boardApiKeys } from "./schema/board_api_keys.js";
import { authUsers } from "./schema/auth.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres board API key scope schema tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function expectConstraintError(action: () => Promise<unknown>) {
  return expect(action()).rejects.toThrow("Failed query");
}

describeEmbeddedPostgres("board_api_keys scope schema", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-api-key-scope-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("defaults scope to all_access and rejects out-of-enum values", async () => {
    const [user] = await db
      .insert(authUsers)
      .values({
        id: "scope-user-1",
        name: "Scope User 1",
        email: "scope-user-1@test.com",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    const [key] = await db
      .insert(boardApiKeys)
      .values({
        userId: user.id,
        name: "Default scope key",
        keyHash: "hash-1",
      })
      .returning();

    expect(key.scope).toBe("all_access");

    await expectConstraintError(() =>
      db.insert(boardApiKeys).values({
        userId: user.id,
        name: "Invalid scope key",
        keyHash: "hash-2",
        scope: "admin_access" as never,
      }),
    );
  });

  it("accepts all values from BOARD_API_KEY_SCOPES", async () => {
    const [user] = await db
      .insert(authUsers)
      .values({
        id: "scope-user-2",
        name: "Scope User 2",
        email: "scope-user-2@test.com",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    for (const scope of BOARD_API_KEY_SCOPES) {
      const [key] = await db
        .insert(boardApiKeys)
        .values({
          userId: user.id,
          name: `Key with scope ${scope}`,
          keyHash: `hash-${scope}`,
          scope,
        })
        .returning();
      expect(key.scope).toBe(scope);
    }
  });
});
