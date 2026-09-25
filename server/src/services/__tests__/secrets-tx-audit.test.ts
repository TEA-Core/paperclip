import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  createDb,
  heartbeatRuns,
  secretAccessEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { logger } from "../../middleware/logger.js";
import { secretService } from "../secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping secret-read audit transaction tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A deterministic, self-contained failure for the `secret.value.read` audit
// write: any INSERT into `activity_log` raises this exception. DDL inside a
// Postgres transaction is transactional, so the transaction test rolls the
// blocker back with everything else, and the pool test commits it explicitly
// and drops it in teardown. The names are static test-local identifiers.
const AUDIT_BLOCKER_FUNCTION = "sup17463_block_activity_log_inserts";
const AUDIT_BLOCKER_TRIGGER = "sup17463_block_activity_log_inserts";
const AUDIT_BLOCKER_MARKER = "audit write blocked by SUP-17463 test";
const ACTIVITY_LOG_WRITE_FAILED_MSG = "activity log write failed; the audited mutation is unaffected";
const ABORTED_TRANSACTION_MARKER = "current transaction is aborted";

const CREATE_AUDIT_BLOCKER_SQL = [
  `CREATE FUNCTION ${AUDIT_BLOCKER_FUNCTION}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION '${AUDIT_BLOCKER_MARKER}'; END; $$ LANGUAGE plpgsql;`,
  `CREATE TRIGGER ${AUDIT_BLOCKER_TRIGGER} BEFORE INSERT ON activity_log FOR EACH STATEMENT EXECUTE FUNCTION ${AUDIT_BLOCKER_FUNCTION}();`,
].join("\n");

const DROP_AUDIT_BLOCKER_SQL = [
  `DROP TRIGGER IF EXISTS ${AUDIT_BLOCKER_TRIGGER} ON activity_log;`,
  `DROP FUNCTION IF EXISTS ${AUDIT_BLOCKER_FUNCTION}();`,
].join("\n");

// A synthetic placeholder, never a real credential.
const FIXTURE_VALUE = "sup17463-fixture-value";

// Drizzle wraps driver errors (`Failed query: ...`) with the original
// Postgres error on `cause`, so match against the whole chain, not just the
// top-level message.
function errorMessageChain(error: unknown): string {
  let current: unknown = error;
  let chain = "";
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    chain += `${current.message}\n`;
    current = current.cause;
  }
  return chain;
}

describeEmbeddedPostgres("secretService secret-read audit — transaction fate", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousAllowKeyGeneration = process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-secrets-tx-audit-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION = "1";
    const started = await startEmbeddedPostgresTestDatabase("secrets-tx-audit");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (stopDb) await stopDb();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    if (previousAllowKeyGeneration === undefined) {
      delete process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION;
    } else {
      process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION = previousAllowKeyGeneration;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function seedAgentRun(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Secret reader",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      status: "running",
      startedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { agentId, heartbeatRunId };
  }

  // Company-scoped local_encrypted secret, bound to the agent at the config
  // path the read context will use, so the resolution itself succeeds and the
  // only failing statement left in the flow is the audit INSERT.
  async function seedAgentBoundSecret(companyId: string, agentId: string) {
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `tx-audit-${randomUUID()}`,
      provider: "local_encrypted",
      value: FIXTURE_VALUE,
    });
    await svc.createBinding({
      companyId,
      secretId: secret.id,
      targetType: "agent",
      targetId: agentId,
      configPath: "env.SUP17463_TEST_KEY",
    });
    return secret;
  }

  it("rolls the transaction back when a secret-read audit fails under secretService(tx)", async () => {
    const companyId = await seedCompany();
    const { agentId, heartbeatRunId } = await seedAgentRun(companyId);
    const secret = await seedAgentBoundSecret(companyId, agentId);
    const originalName = secret.name;
    const context = {
      agentId,
      configPath: "env.SUP17463_TEST_KEY",
      actorSource: "agent_jwt" as const,
      heartbeatRunId,
      registerForRedaction: () => undefined,
    };

    const txError = await db
      .transaction(async (tx) => {
        await tx
          .update(companySecrets)
          .set({ name: `${originalName}-renamed-in-tx` })
          .where(eq(companySecrets.id, secret.id));
        await tx.execute(sql.raw(CREATE_AUDIT_BLOCKER_SQL));
        await secretService(tx).resolveSecretValueForAgentAccess(companyId, secret.id, "latest", context);
      })
      .catch((error: unknown) => error);
    expect(txError).toBeInstanceOf(Error);
    // The success-path audit INSERT trips the blocker and aborts the
    // transaction. Resolution itself succeeded, so the catch block runs the
    // failure-path audit — which hits the already-aborted transaction first
    // ("current transaction is aborted") and propagates. Either way the audit
    // failure, not a successful read, is what ends this transaction.
    expect(errorMessageChain(txError)).toContain(ABORTED_TRANSACTION_MARKER);

    const after = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, secret.id))
      .then((rows) => rows[0]);
    expect(after?.name).toBe(originalName);

    const auditRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, secret.id));
    expect(auditRows).toHaveLength(0);

    const blockerLeft = await db
      .execute(sql`SELECT to_regproc('sup17463_block_activity_log_inserts()') IS NOT NULL AS present`)
      .then((result) => Number((result[0] as { present: number | boolean }).present));
    expect(blockerLeft).toBe(0);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("rejects on the failure-path audit itself, not the original resolution error, under secretService(tx)", async () => {
    const companyId = await seedCompany();
    const { agentId, heartbeatRunId } = await seedAgentRun(companyId);
    const secret = await seedAgentBoundSecret(companyId, agentId);
    const originalName = secret.name;
    // No binding exists at this path, so the resolution itself fails with an
    // app-level `binding_missing` error; the failure-path audit is the next
    // write, and it trips the blocker. Removing the old `.catch` is what makes
    // the audit failure the rejection instead of the original secret error.
    const context = {
      agentId,
      configPath: "env.SUP17463_UNBOUND",
      actorSource: "agent_jwt" as const,
      heartbeatRunId,
      registerForRedaction: () => undefined,
    };

    const txError = await db
      .transaction(async (tx) => {
        await tx
          .update(companySecrets)
          .set({ name: `${originalName}-renamed-in-tx` })
          .where(eq(companySecrets.id, secret.id));
        await tx.execute(sql.raw(CREATE_AUDIT_BLOCKER_SQL));
        await secretService(tx).resolveSecretValueForAgentAccess(companyId, secret.id, "latest", context);
      })
      .catch((error: unknown) => error);

    expect(txError).toBeInstanceOf(Error);
    expect(errorMessageChain(txError)).toContain(AUDIT_BLOCKER_MARKER);

    const after = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, secret.id))
      .then((rows) => rows[0]);
    expect(after?.name).toBe(originalName);

    const auditRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, secret.id));
    expect(auditRows).toHaveLength(0);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("keeps the pool path best-effort: a failing audit is logged, swallowed, and the value is returned", async () => {
    const companyId = await seedCompany();
    const { agentId, heartbeatRunId } = await seedAgentRun(companyId);
    const secret = await seedAgentBoundSecret(companyId, agentId);
    const context = {
      agentId,
      configPath: "env.SUP17463_TEST_KEY",
      actorSource: "agent_jwt" as const,
      heartbeatRunId,
      registerForRedaction: () => undefined,
    };

    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(CREATE_AUDIT_BLOCKER_SQL));
    });
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      const result = await secretService(db).resolveSecretValueForAgentAccess(
        companyId,
        secret.id,
        "latest",
        context,
      );
      expect(result.value).toBe(FIXTURE_VALUE);
      expect(result.version).toBe(1);
    } finally {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(DROP_AUDIT_BLOCKER_SQL));
      });
    }

    const auditFailureCall = errorSpy.mock.calls.find(
      (call) => typeof call[1] === "string" && call[1].includes(ACTIVITY_LOG_WRITE_FAILED_MSG),
    );
    expect(auditFailureCall).toBeDefined();
    const payload = auditFailureCall?.[0] as { err?: unknown } | undefined;
    expect(errorMessageChain(payload?.err)).toContain(AUDIT_BLOCKER_MARKER);

    const auditRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, secret.id));
    expect(auditRows).toHaveLength(0);
    expect(JSON.stringify(auditRows)).not.toContain(FIXTURE_VALUE);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
