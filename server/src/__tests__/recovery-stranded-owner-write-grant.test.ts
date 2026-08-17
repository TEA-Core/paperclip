import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres recovery write-grant tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery stranded owner write-grant guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-write-grant-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(options?: { ctoReportsTo?: string | null; coderReportsTo?: string | null }) {
    const companyId = randomUUID();
    const ctoId = randomUUID();
    const coderId = randomUUID();
    const prefix = `WG${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Write Grant Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ctoId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        reportsTo: options?.ctoReportsTo ?? null,
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: options?.coderReportsTo === undefined ? ctoId : options.coderReportsTo,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { companyId, ctoId, coderId, prefix };
  }

  async function seedSourceIssue(companyId: string, assigneeAgentId: string, prefix: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    return row!;
  }

  it("rejects a ladder candidate that lacks a write grant on the source issue (SUP-13091 shape)", async () => {
    // The CTO is invokable (standard trust, role=cto), but it is NOT the
    // assignee's reportsTo ancestor (reportsTo: null) and did not create the
    // source issue. Under issue:comment + actual assignment, the CTO is denied
    // deny_missing_grant — the exact live failure — so it must NOT be selected.
    const { companyId, ctoId, coderId, prefix } = await seedCompany({
      ctoReportsTo: null,
      coderReportsTo: null,
    });
    const sourceIssue = await seedSourceIssue(companyId, coderId, prefix);

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const latestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));

    expect(action).toBeDefined();
    expect(action.ownerAgentId).not.toBe(ctoId);
    expect(action.ownerAgentId).toBe(coderId);
    expect(action.returnOwnerAgentId).toBe(coderId);
  });

  it("still escalates to the manager ladder when the candidate can hold the issue (happy path)", async () => {
    // The CTO IS the coder's reportsTo ancestor, so issue:comment + actual
    // assignment passes via allow_manager_chain. The CTO is selected as owner,
    // and the return owner is the coder (the original assignee).
    const { companyId, ctoId, coderId, prefix } = await seedCompany({ ctoReportsTo: null });
    const sourceIssue = await seedSourceIssue(companyId, coderId, prefix);

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const latestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));

    expect(action).toBeDefined();
    expect(action.ownerAgentId).toBe(ctoId);
    expect(action.returnOwnerAgentId).toBe(coderId);
    expect(action.evidence.routingFallbackReason).toBeNull();
  });

  it("drops a return owner that lacks a write grant on the source issue", async () => {
    // process_lost routes back to the agent that ran. Here the run agent is a
    // standard-trust reviewer that is neither the assignee, creator, nor
    // org-chain ancestor of the source issue — so it lacks a write grant and
    // the return owner is dropped with a routingFallbackReason.
    const { companyId, ctoId, coderId, prefix } = await seedCompany({ ctoReportsTo: null });
    const sourceIssue = await seedSourceIssue(companyId, coderId, prefix);
    const reviewerId = randomUUID();
    await db.insert(agents).values({
      id: reviewerId,
      companyId,
      name: "Reviewer",
      role: "engineer",
      status: "idle",
      reportsTo: null,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const latestRun = {
      id: randomUUID(),
      agentId: reviewerId,
      status: "failed",
      error: "process lost",
      errorCode: "process_lost",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));

    expect(action).toBeDefined();
    expect(action.ownerAgentId).toBe(ctoId);
    expect(action.returnOwnerAgentId).toBeNull();
    expect(action.evidence.routingFallbackReason).toContain("lacks a write grant on the source issue");
  });
});
