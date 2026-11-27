import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  companies,
  companySecretProposals,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "../services/activity-log.js";
import { createSecretProposalsService } from "../services/secret-proposals.js";

/**
 * SUP-24746. `logActivity` is best-effort; a caller may still hand it a
 * transaction (here through a parameter typed `Db`, which the static guard cannot
 * see). Without a savepoint the failed audit insert aborts the caller's whole
 * transaction while `logActivity` swallows the error, so the mutation it was
 * meant to describe is silently rolled back. The audit insert must instead fail
 * on its own: the surrounding write commits, only the audit row is lost, and the
 * loss is logged with the action and entity it belonged to.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres best-effort transaction audit tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("best-effort activity log inside a transaction", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-activity-log-savepoint-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-log-savepoint-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.execute(sql.raw(
      "alter table activity_log drop constraint if exists activity_log_force_failure",
    ));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  /** Reject every new `activity_log` insert; `NOT VALID` still enforces new rows. */
  async function rejectActivityLogInserts() {
    await db.execute(sql.raw(
      "alter table activity_log add constraint activity_log_force_failure check (false) not valid",
    ));
  }

  let companySeq = 0;

  async function seedRun() {
    companySeq += 1;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const heartbeatRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Best-effort audit",
      issuePrefix: `BT${companySeq}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Proposer",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      status: "idle",
    });
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs credential",
      identifier: `BT${companySeq}-1`,
      status: "in_progress",
      executionRunId: heartbeatRunId,
    });
    return { companyId, agentId, heartbeatRunId, issueId };
  }

  async function countCompanyActivity(companyId: string) {
    const rows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    return rows.length;
  }

  it("commits a secret proposal and logs the lost audit row when its audit insert fails", async () => {
    const { companyId, agentId, heartbeatRunId } = await seedRun();
    const loggerError = vi.spyOn(logger, "error");
    await rejectActivityLogInserts();

    const proposal = await createSecretProposalsService(db).createSecret(
      { companyId, heartbeatRunId, registerForRedaction: () => {} },
      { name: "ops/api-token", value: "s3cret-value", justification: "Needs the API token" },
    );

    const persisted = await db
      .select({ id: companySecretProposals.id, status: companySecretProposals.status })
      .from(companySecretProposals)
      .where(eq(companySecretProposals.id, proposal.id));
    expect(persisted).toEqual([{ id: proposal.id, status: "pending" }]);
    expect(await countCompanyActivity(companyId)).toBe(0);
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId,
        action: "secret.proposal.created",
        entityType: "company_secret_proposal",
        entityId: proposal.id,
        actorId: agentId,
      }),
      expect.stringContaining("activity log write failed"),
    );
  });

  it("keeps the rest of the transaction usable after a failed best-effort audit", async () => {
    const { companyId, issueId } = await seedRun();
    await rejectActivityLogInserts();

    await db.transaction(async (tx) => {
      await tx.update(issues).set({ title: "Before the audit" }).where(eq(issues.id, issueId));
      await logActivity(tx as unknown as Db, {
        companyId,
        actorType: "system",
        actorId: "test:best-effort-savepoint",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
      });
      await tx.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
    });

    const [row] = await db
      .select({ title: issues.title, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(row).toEqual({ title: "Before the audit", status: "blocked" });
    expect(await countCompanyActivity(companyId)).toBe(0);
  });
});
