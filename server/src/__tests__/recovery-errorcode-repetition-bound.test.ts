import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
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
    await db.delete(heartbeatRunEvents);
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
      resultJson?: Record<string, unknown> | null;
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
      // Every run here failed before any provider work started, and the heartbeat's
      // pre-adapter failure paths record exactly this evidence on such a run. Upstream
      // 35fdc0c66 (#13075) holds a failed legacy run WITHOUT it for board reconciliation
      // (legacyExecutionNeedsReconciliation) before the sweep reaches the errorCode bound, and
      // gave its own stranded-sweep fixture (heartbeat-process-recovery
      // seedStrandedIssueFixture) the same default.
      resultJson:
        overrides.resultJson === undefined
          ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } }
          : overrides.resultJson,
    });
    return runId;
  }

  // Mirrors the production wiring in heartbeat.ts, which passes both dependencies. Since
  // upstream 35fdc0c66 (#13075) the sweep re-dispatches a failed predecessor through
  // deps.scheduleRecoveryRetry (the durable bounded retry scheduler), not enqueueWakeup, so
  // a re-dispatch is observed on scheduleRecoveryRetry.
  function buildRecovery() {
    const enqueueWakeup = vi.fn(async (_agentId: string, _opts?: { reason?: string | null }) => null);
    const scheduleRecoveryRetry = vi.fn(
      async (runId: string) =>
        ({ id: randomUUID(), retryOfRunId: runId }) as typeof heartbeatRuns.$inferSelect,
    );
    const recovery = recoveryService(db, { enqueueWakeup, scheduleRecoveryRetry });
    return { recovery, enqueueWakeup, scheduleRecoveryRetry };
  }

  // The SUP-12466 errorCode-repetition bound is pinned on `workspace_validation_failed`.
  // Upstream 889947c23 (#13038) added `setup_failed` to the sweep classifier's non-retryable
  // set (classifyContinuationFailure), so the sweep parks a `setup_failed` run on its first
  // failure and never reaches the repetition bound. `workspace_validation_failed` is also a
  // deterministic pre-adapter failure that the heartbeat records with the same bootstrap
  // evidence, and the classifier still gives it the default one-attempt budget: one free
  // retry, then the repetition bound. That is the path this file pinned for `setup_failed`
  // before the fold.
  const REPEATING_ERROR_CODE = "workspace_validation_failed";
  const REPEATING_ERROR = "Project workspace cwd is not a directory: /srv/checkouts/missing";

  it("parks an in_progress issue whose recent runs repeat the same errorCode instead of re-dispatching it", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const issueId = await seedInProgressIssue(companyId, coderId, prefix);
    await seedFailedRun(companyId, coderId, issueId, {
      errorCode: REPEATING_ERROR_CODE,
      error: REPEATING_ERROR,
      finishedAt: new Date("2026-08-12T11:55:00.000Z"),
    });
    const latestRun = await seedFailedRun(companyId, coderId, issueId, {
      errorCode: REPEATING_ERROR_CODE,
      error: REPEATING_ERROR,
      finishedAt: new Date("2026-08-12T12:00:00.000Z"),
    });

    const { recovery, enqueueWakeup, scheduleRecoveryRetry } = buildRecovery();

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.continuationRequeued).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
    expect(scheduleRecoveryRetry).not.toHaveBeenCalled();
    expect(enqueueWakeup.mock.calls.some(([, opts]) => opts?.reason === "issue_continuation_needed")).toBe(false);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    // The repetition bound's own notice, not the classifier's non-retryable first-strike one.
    expect(comments[0]?.body).toContain("2× attempts");
    expect(comments[0]?.body).toContain("Moving it to `blocked`");
    expect(comments[0]?.body).not.toContain("non-retryable");
    // The repeating errorCode moved out of the body and into the notice
    // metadata: run failure detail is redacted out of issue copy, which
    // `heartbeat-process-recovery` asserts directly. The bound itself — park
    // after the repetition rather than re-dispatch again — is unchanged.
    expect(comments[0]?.body).not.toContain(REPEATING_ERROR_CODE);
    const metadataRows = ((comments[0]?.metadata as {
      sections?: Array<{ rows?: Array<Record<string, unknown>> }>;
    } | null)?.sections ?? []).flatMap((section) => section.rows ?? []);
    expect(metadataRows).toContainEqual({
      type: "key_value",
      label: "Failure code",
      value: REPEATING_ERROR_CODE,
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
    expect(scheduleRecoveryRetry).not.toHaveBeenCalled();
  });

  it("parks the attempt count instead of re-dispatching forever across many runs repeating the same errorCode", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const issueId = await seedInProgressIssue(companyId, coderId, prefix);
    for (let i = 0; i < 5; i += 1) {
      await seedFailedRun(companyId, coderId, issueId, {
        errorCode: REPEATING_ERROR_CODE,
        error: REPEATING_ERROR,
        finishedAt: new Date(`2026-08-12T11:3${i}:00.000Z`),
      });
    }

    const { recovery, enqueueWakeup, scheduleRecoveryRetry } = buildRecovery();

    const result = await recovery.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(scheduleRecoveryRetry).not.toHaveBeenCalled();
    expect(enqueueWakeup.mock.calls.some(([, opts]) => opts?.reason === "issue_continuation_needed")).toBe(false);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");
  });

  it("still re-dispatches a single run of that errorCode (one free retry before the bound)", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const issueId = await seedInProgressIssue(companyId, coderId, prefix);
    const runId = await seedFailedRun(companyId, coderId, issueId, {
      errorCode: REPEATING_ERROR_CODE,
      error: REPEATING_ERROR,
    });

    const { recovery, enqueueWakeup, scheduleRecoveryRetry } = buildRecovery();

    const result = await recovery.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");

    expect(scheduleRecoveryRetry).toHaveBeenCalledTimes(1);
    expect(scheduleRecoveryRetry).toHaveBeenCalledWith(runId);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  // Operator ruling 2026-09-16: the sweep blocks a single `setup_failed` run on its first
  // failure. This follows upstream 889947c23 (#13038), which made `setup_failed` non-retryable
  // in the sweep classifier, and its upstream-owned test "does not turn a pre-adapter setup
  // failure into a duplicate continuation run" (heartbeat-process-recovery). The one free
  // retry and SUP-15589's three-strike bound for `setup_failed` stay on the release path
  // (heartbeat releaseIssueExecutionAndPromote), which this sweep test does not drive.
  it("blocks a single setup_failed run on its first failure instead of re-dispatching it", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const issueId = await seedInProgressIssue(companyId, coderId, prefix);
    await seedFailedRun(companyId, coderId, issueId, {
      errorCode: "setup_failed",
      error: "workspace fetch flaked once",
    });

    const { recovery, enqueueWakeup, scheduleRecoveryRetry } = buildRecovery();

    const result = await recovery.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
    expect(scheduleRecoveryRetry).not.toHaveBeenCalled();
    expect(enqueueWakeup.mock.calls.some(([, opts]) => opts?.reason === "issue_continuation_needed")).toBe(false);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    // Parked by the classifier's first-strike branch, not by the repetition bound.
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("non-retryable");
  });

  it("re-dispatches when a repeating errorCode chain is broken by a different errorCode", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const issueId = await seedInProgressIssue(companyId, coderId, prefix);
    // Two repeating runs would park on their own (first test). A newer run with a different
    // errorCode ends that chain, so the latest code counts once and is re-dispatched.
    await seedFailedRun(companyId, coderId, issueId, {
      errorCode: REPEATING_ERROR_CODE,
      error: REPEATING_ERROR,
      finishedAt: new Date("2026-08-12T11:50:00.000Z"),
    });
    await seedFailedRun(companyId, coderId, issueId, {
      errorCode: REPEATING_ERROR_CODE,
      error: REPEATING_ERROR,
      finishedAt: new Date("2026-08-12T11:55:00.000Z"),
    });
    const latestRunId = await seedFailedRun(companyId, coderId, issueId, {
      errorCode: "adapter_failed",
      error: "ssh: connection reset",
      finishedAt: new Date("2026-08-12T12:00:00.000Z"),
    });

    const { recovery, enqueueWakeup, scheduleRecoveryRetry } = buildRecovery();

    const result = await recovery.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(scheduleRecoveryRetry).toHaveBeenCalledTimes(1);
    expect(scheduleRecoveryRetry).toHaveBeenCalledWith(latestRunId);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
  });
});
