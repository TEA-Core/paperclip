import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { AskUserQuestionsPayload } from "@paperclipai/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  companySkillPolicies,
  createDb,
  issueComments,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySkillPolicyService } from "../services/company-skill-policy.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

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

  /**
   * `issues.addComment` is the propagated-handle case: its `dbOrTx` argument is
   * the pool when called normally, but a caller-supplied transaction when a
   * caller (or its own run-id serialization branch) passes one. The
   * `issue.thread_interaction_expired` audit must share that transaction's fate.
   */
  async function seedIssueWithSupersedableInteraction() {
    const companyId = randomUUID();
    companySeq += 1;
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Audit atomicity",
      issuePrefix: `AT${companySeq}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: `AT${companySeq}-1`,
      title: "Supersede the pending question",
      status: "in_progress",
    });
    const payload: AskUserQuestionsPayload = {
      version: 1,
      supersedeOnUserComment: true,
      questions: [
        {
          id: "scope",
          prompt: "Choose the scope",
          selectionMode: "single",
          options: [{ id: "phase-1", label: "Phase 1" }],
        },
      ],
    };
    const interaction = await issueThreadInteractionService(db).create(
      { id: issueId, companyId },
      { kind: "ask_user_questions", continuationPolicy: "wake_assignee", payload },
      { userId: "local-board" },
    );
    return { companyId, issueId, interactionId: interaction.id };
  }

  async function loadInteractionStatus(interactionId: string) {
    const [row] = await db
      .select({ status: issueThreadInteractions.status })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId));
    return row?.status;
  }

  async function listIssueComments(issueId: string) {
    return db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
  }

  async function listExpiryAudits(companyId: string) {
    return db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
  }

  it("expires the interaction and audits it when the caller transaction commits", async () => {
    const { companyId, issueId, interactionId } = await seedIssueWithSupersedableInteraction();

    await db.transaction((tx) =>
      issueService(db).addComment(
        issueId,
        "Superseding comment",
        { userId: "local-board" },
        {},
        tx,
      ),
    );

    expect(await loadInteractionStatus(interactionId)).toBe("expired");
    expect(await listIssueComments(issueId)).toHaveLength(1);
    expect(await listExpiryAudits(companyId)).toHaveLength(1);
  });

  it("rolls the comment and its expiry audit back when the audit insert fails", async () => {
    const { companyId, issueId, interactionId } = await seedIssueWithSupersedableInteraction();
    await rejectActivityLogInserts();

    let caught: unknown;
    try {
      await db.transaction((tx) =>
        issueService(db).addComment(
          issueId,
          "Superseding comment",
          { userId: "local-board" },
          {},
          tx,
        ),
      );
    } catch (error) {
      caught = error;
    }

    // The audit insert failure itself must surface from the service layer: the
    // DrizzleQueryError naming the audit insert. Best-effort swallows it, so the
    // caller only sees the driver's deferred PostgresError for the already
    // aborted transaction instead of the failure that caused it.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { message?: unknown }).message).toEqual(
      expect.stringContaining('Failed query: insert into "activity_log"'),
    );

    // The comment, the expiry and the audit row must share one fate: all gone.
    expect(await loadInteractionStatus(interactionId)).toBe("pending");
    expect(await listIssueComments(issueId)).toEqual([]);
    expect(await listExpiryAudits(companyId)).toEqual([]);
  });
});
