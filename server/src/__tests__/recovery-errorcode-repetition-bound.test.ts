import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres errorCode-repetition-bound tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery bounds deterministic setup-failure re-dispatch on errorCode repetition", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-errorcode-repetition-bound-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const prefix = `ER${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "ErrorCode Repetition Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { companyId, managerId, coderId, prefix };
  }

  async function seedInProgressIssue(companyId: string, coderId: string, prefix: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Setup fails deterministically",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      checkoutRunId: null,
      executionRunId: null,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    return issueId;
  }

  async function seedFailedRun(
    companyId: string,
    agentId: string,
    issueId: string,
    overrides: {
      status?: string;
      errorCode?: string | null;
      error?: string | null;
      retryReason?: string | null;
      runSource?: string | null;
      finishedAt?: Date;
      createdAt?: Date;
    } = {},
  ) {
    const runId = randomUUID();
    const finishedAt = overrides.finishedAt ?? new Date("2026-08-12T12:00:00.000Z");
    const createdAt = overrides.createdAt ?? finishedAt;
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: overrides.status ?? "failed",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
        ...(overrides.retryReason ? { retryReason: overrides.retryReason } : {}),
        ...(overrides.runSource ? { source: overrides.runSource } : {}),
      },
      errorCode: overrides.errorCode ?? null,
      error: overrides.error ?? null,
      startedAt: createdAt,
      finishedAt,
      createdAt,
      updatedAt: finishedAt,
      livenessState: null,
      resultJson: null,
    });
    return runId;
  }

  it("parks an in_progress issue whose recent runs repeat setup_failed instead of enqueuing another wake", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const issueId = await seedInProgressIssue(companyId, coderId, prefix);
    await seedFailedRun(companyId, coderId, issueId, {
      errorCode: "setup_failed",
      error: "Low-trust review requires a concrete project, root issue, or issue-id boundary.",
      finishedAt: new Date("2026-08-12T11:55:00.000Z"),
    });
    const latestRun = await seedFailedRun(companyId, coderId, issueId, {
      errorCode: "setup_failed",
      error: "Low-trust review requires a concrete project, root issue, or issue-id boundary.",
      finishedAt: new Date("2026-08-12T12:00:00.000Z"),
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.continuationRequeued).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
    expect(enqueueWakeup.mock.calls.some(([agentId, args]) => args.reason === "issue_continuation_needed")).toBe(false);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("2× attempts");
    expect(comments[0]?.body).toContain("Moving it to `blocked`");
    // The repeating errorCode moved out of the body and into the notice
    // metadata: run failure detail is redacted out of issue copy, which
    // `heartbeat-process-recovery` asserts directly. The bound itself — park
    // after the repetition rather than enqueue another wake — is unchanged.
    expect(comments[0]?.body).not.toContain("setup_failed");
    const metadataRows = ((comments[0]?.metadata as {
      sections?: Array<{ rows?: Array<Record<string, unknown>> }>;
    } | null)?.sections ?? []).flatMap((section) => section.rows ?? []);
    expect(metadataRows).toContainEqual({
      type: "key_value",
      label: "Failure code",
      value: "setup_failed",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1);
    expect(actions[0]?.status).toBe("active");
    expect(actions[0]?.kind).toBe("stranded_assigned_issue");
    expect(actions[0]?.evidence).toMatchObject({ latestRunId: latestRun });

    const secondResult = await recovery.reconcileStrandedAssignedIssues();
    expect(secondResult.escalated).toBe(0);
    expect(secondResult.continuationRequeued).toBe(0);
    expect(secondResult.issueIds).toEqual([]);
  });

  it("parks the attempt count instead of re-dispatching forever across many repeating setup_failed runs", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const issueId = await seedInProgressIssue(companyId, coderId, prefix);
    for (let i = 0; i < 5; i += 1) {
      await seedFailedRun(companyId, coderId, issueId, {
        errorCode: "setup_failed",
        error: "Low-trust review requires a concrete project, root issue, or issue-id boundary.",
        finishedAt: new Date(`2026-08-12T11:3${i}:00.000Z`),
      });
    }

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.dispatchRequeued).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");
  });

  it("still re-dispatches a single transient setup_failed run (one free retry before the bound)", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const issueId = await seedInProgressIssue(companyId, coderId, prefix);
    const runId = await seedFailedRun(companyId, coderId, issueId, {
      errorCode: "setup_failed",
      error: "workspace fetch flaked once",
    });

    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");

    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup.mock.calls[0][0]).toBe(coderId);
    expect(enqueueWakeup.mock.calls[0][1].reason).toBe("issue_continuation_needed");
    expect(enqueueWakeup.mock.calls[0][1].contextSnapshot).toMatchObject({
      issueId,
      retryReason: "issue_continuation_needed",
      source: "issue.continuation_recovery",
    });
  });

  it("re-dispatches when a repeating setup_failed chain is broken by a different errorCode", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const issueId = await seedInProgressIssue(companyId, coderId, prefix);
    await seedFailedRun(companyId, coderId, issueId, {
      errorCode: "setup_failed",
      error: "Low-trust review requires a concrete project, root issue, or issue-id boundary.",
      finishedAt: new Date("2026-08-12T11:55:00.000Z"),
    });
    await seedFailedRun(companyId, coderId, issueId, {
      errorCode: "adapter_failed",
      error: "ssh: connection reset",
      finishedAt: new Date("2026-08-12T12:00:00.000Z"),
    });

    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
  });
});
