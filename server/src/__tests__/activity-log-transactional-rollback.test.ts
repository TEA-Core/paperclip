import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  companySkillPolicies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySkillPolicyService } from "../services/company-skill-policy.js";

/**
 * Behavioral counterpart to the static guard. A converted site must be atomic:
 * if the audit insert fails, the mutation it describes and the audit row
 * disappear together, and the caller sees the failure. Before SUP-16540 the
 * audit here was best-effort, so the delete committed and the failure vanished.
 *
 * `companySkillPolicyService.reset` is a representative converted site: it
 * deletes the policy row and writes the `company.skill_policy_reset` audit entry
 * inside one transaction, both through the same handle.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres transactional activity log tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("transactional activity log", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-log-transactional-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await allowActivityLogInserts();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** Reject every new `activity_log` insert; `NOT VALID` still enforces new rows. */
  async function rejectActivityLogInserts() {
    await db.execute(sql.raw(
      "alter table activity_log add constraint activity_log_force_failure check (false) not valid",
    ));
  }

  async function allowActivityLogInserts() {
    await db.execute(sql.raw(
      "alter table activity_log drop constraint if exists activity_log_force_failure",
    ));
  }

  let companySeq = 0;

  async function seedCompanyWithPolicy() {
    const companyId = randomUUID();
    companySeq += 1;
    await db.insert(companies).values({
      id: companyId,
      name: "Audit atomicity",
      issuePrefix: `AT${companySeq}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companySkillPolicies).values({
      companyId,
      revision: 3,
      defaultEffect: "deny",
      rules: [],
    });
    return companyId;
  }

  async function listPolicyRevisions(companyId: string) {
    return db
      .select({ revision: companySkillPolicies.revision })
      .from(companySkillPolicies)
      .where(eq(companySkillPolicies.companyId, companyId));
  }

  async function listResetAudits(companyId: string) {
    return db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
  }

  it("commits the reset and its audit entry when the insert succeeds", async () => {
    const companyId = await seedCompanyWithPolicy();

    const policy = await companySkillPolicyService(db).reset({
      companyId,
      activity: { actorType: "system", actorId: "test:audit-atomicity" },
    });

    expect(policy.materialized).toBe(false);
    expect(await listPolicyRevisions(companyId)).toEqual([]);
    expect(await listResetAudits(companyId)).toHaveLength(1);
  });

  it("rolls the reset back and rejects when the audit insert fails", async () => {
    const companyId = await seedCompanyWithPolicy();
    await rejectActivityLogInserts();

    await expect(
      companySkillPolicyService(db).reset({
        companyId,
        activity: { actorType: "system", actorId: "test:audit-atomicity" },
      }),
    ).rejects.toThrow();

    expect(await listPolicyRevisions(companyId)).toEqual([{ revision: 3 }]);
    expect(await listResetAudits(companyId)).toEqual([]);
  });
});
