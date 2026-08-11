import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("least-privilege serving role", () => {
  afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

  it("allows DML and CREATE SCHEMA but blocks DDL for paperclip_serving", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-least-privilege-");
    cleanups.push(database.cleanup);

    const adminSql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => adminSql.end());

    // Enable LOGIN + password for the serving role so we can connect as it.
    await adminSql`ALTER ROLE paperclip_serving WITH LOGIN PASSWORD 'paperclip'`;

    // Derive the port from the connection string to build the serving role URL.
    const port = database.connectionString.match(/:(\d+)\//)?.[1];
    expect(port).toBeDefined();
    const servingSql = postgres(
      `postgres://paperclip_serving:paperclip@127.0.0.1:${port}/paperclip`,
      { max: 1, onnotice: () => {} },
    );
    cleanups.push(async () => servingSql.end());

    const companyId = randomUUID();
    await adminSql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Paperclip', 'PAP')`;

    // 1. DML works: SELECT
    const [company] = await servingSql<{ id: string; name: string }[]>`
      SELECT "id", "name" FROM "companies" WHERE "id" = ${companyId}
    `;
    expect(company).toEqual({ id: companyId, name: "Paperclip" });

    // 2. DML works: INSERT
    const agentId = randomUUID();
    await servingSql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "status")
      VALUES (${agentId}, ${companyId}, 'test-agent', 'general', 'active')
    `;

    // 3. DML works: UPDATE
    await servingSql`UPDATE "agents" SET "name" = 'updated-agent' WHERE "id" = ${agentId}`;
    const [agent] = await servingSql<{ name: string }[]>`
      SELECT "name" FROM "agents" WHERE "id" = ${agentId}
    `;
    expect(agent?.name).toBe("updated-agent");

    // 4. DML works: DELETE
    await servingSql`DELETE FROM "agents" WHERE "id" = ${agentId}`;
    const [deleted] = await servingSql<{ id: string }[]>`
      SELECT "id" FROM "agents" WHERE "id" = ${agentId}
    `;
    expect(deleted).toBeUndefined();

    // 5. CREATE SCHEMA IF NOT EXISTS works (plugin-database.ts:376)
    await servingSql`CREATE SCHEMA IF NOT EXISTS test_plugin_foo`;
    const [schema] = await adminSql<{ nspname: string }[]>`
      SELECT "nspname" FROM "pg_namespace" WHERE "nspname" = 'test_plugin_foo'
    `;
    expect(schema?.nspname).toBe("test_plugin_foo");

    // Cleanup the test schema.
    await adminSql`DROP SCHEMA IF EXISTS test_plugin_foo`;

    // 6. DDL is blocked: CREATE TABLE (no CREATE privilege on public schema)
    await expect(
      servingSql`CREATE TABLE should_fail (id serial PRIMARY KEY)`,
    ).rejects.toMatchObject({ code: "42501" });

    // 7. DDL is blocked: DROP TABLE
    await expect(
      servingSql`DROP TABLE IF EXISTS companies`,
    ).rejects.toMatchObject({ code: "42501" });

    // 8. DDL is blocked: ALTER TABLE (requires table ownership)
    await expect(
      servingSql`ALTER TABLE companies ADD COLUMN should_fail text`,
    ).rejects.toMatchObject({ code: "42501" });

    // 9. The serving role is not a superuser.
    const [roleAttrs] = await adminSql<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }[]>`
      SELECT "rolsuper", "rolcreatedb", "rolcreaterole" FROM "pg_roles" WHERE "rolname" = 'paperclip_serving'
    `;
    expect(roleAttrs).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false });
  }, 30_000);

  it("migration is idempotent", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-least-privilege-idempotent-");
    cleanups.push(database.cleanup);

    const adminSql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => adminSql.end());

    // Re-running the migration statements should not error.
    await adminSql`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_serving') THEN CREATE ROLE paperclip_serving NOLOGIN; END IF; END $$;`;
    await adminSql`ALTER ROLE paperclip_serving NOINHERIT;`;
    await adminSql`DO $$ DECLARE db_name text := current_database(); BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO paperclip_serving', db_name); EXECUTE format('GRANT CREATE ON DATABASE %I TO paperclip_serving', db_name); END $$;`;
    await adminSql`GRANT USAGE ON SCHEMA public TO paperclip_serving;`;
    await adminSql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO paperclip_serving;`;
    await adminSql`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO paperclip_serving;`;
    await adminSql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO paperclip_serving;`;
    await adminSql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO paperclip_serving;`;

    const [role] = await adminSql<{ rolname: string }[]>`
      SELECT "rolname" FROM "pg_roles" WHERE "rolname" = 'paperclip_serving'
    `;
    expect(role?.rolname).toBe("paperclip_serving");
  }, 30_000);
});
