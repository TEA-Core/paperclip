import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  summarySlots,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const mockCaptureRunFailure = vi.hoisted(() => vi.fn());

/** Captures recorded after `since` that belong to `runId`. */
const capturesForRun = (since: number, runId: string) =>
  mockCaptureRunFailure.mock.calls
    .slice(since)
    .filter((call) => (call[0] as { runId?: unknown } | undefined)?.runId === runId);
vi.mock("../sentry.js", async () => {
  const actual = await vi.importActual<typeof import("../sentry.js")>("../sentry.js");
  return {
    ...actual,
    captureRunFailure: mockCaptureRunFailure,
  };
});

import {
  reapStrandedSummaryGenerationIssues,
  reapStaleExecutionOwnerLeases,
  reconcileAbandonedExecutionControl,
} from "./execution-control-reconciliation.js";
import { waitForPendingRunFailureReports } from "./run-failure-report.js";
import { getConversationOwnershipBlocker } from "./conversation-continuation.js";

/**
 * Settle the reports the sweep started but did not await.
 *
 * `reconcileAbandonedExecutionControl` reports with `void reportRunFailure(...)`
 * by design — the module's own contract is "do not await it, a Sentry read must
 * not delay the caller's required lifecycle work" — and that report reads the
 * database before it calls Sentry. So the sweep returning says nothing about
 * whether the capture has been recorded. Drain the module's own pending set
 * instead of guessing.
 */
const settleRunFailureReports = () => waitForPendingRunFailureReports();

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("reconcileAbandonedExecutionControl reports a genuine failed transition", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("execution-control-reconciliation-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAbandonedRunFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const pastDeadline = new Date(Date.now() - 60_000);

    await db.insert(companies).values({
      id: companyId,
      name: "Execution Control Reconciliation",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Stuck worker",
      adapterType: "codex_local",
      status: "running",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      executionControlDeadlineAt: pastDeadline,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Abandoned execution control fixture",
      status: "in_progress",
      assigneeAgentId: agentId,
      executionRunId: runId,
      checkoutRunId: runId,
    });

    return { companyId, agentId, issueId, runId };
  }

  it("reports exactly one Sentry event for a genuine finalization-deadline failure", async () => {
    const { runId } = await seedAbandonedRunFixture();
    const captureCallsBefore = mockCaptureRunFailure.mock.calls.length;

    const result = await reconcileAbandonedExecutionControl(db);

    expect(result.surfaced).toBe(1);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("execution_finalization_deadline_exceeded");

    // Scope to this test's run. `mockCaptureRunFailure` is shared across the
    // file, so a positional slice alone also picks up a capture emitted by a
    // sibling test whose async work settled after captureCallsBefore was read.
    await settleRunFailureReports();
    const newCaptures = capturesForRun(captureCallsBefore, runId);
    expect(newCaptures).toHaveLength(1);
    expect(newCaptures[0]?.[0]).toMatchObject({
      runId,
      runStatus: "failed",
      errorCode: "execution_finalization_deadline_exceeded",
    });
  });

  it("reports zero events for a repeated sweep over the same already-failed run", async () => {
    const { runId } = await seedAbandonedRunFixture();
    await reconcileAbandonedExecutionControl(db);
    // Settle the FIRST sweep's report before taking the baseline below. This is
    // what made the assertion flaky, and scoping by runId could not fix it: the
    // late capture is this run's OWN first-sweep report, so it matches the runId
    // filter. On a loaded shard its database read finished after
    // `captureCallsBefore` was read, and it was then counted as a second capture
    // that never happened.
    await settleRunFailureReports();
    // Assert the drain actually completed. `waitForPendingRunFailureReports`
    // returns the same `void` whether every report settled or its 5s timeout
    // expired, so the wait alone is not proof. If the first sweep's report has
    // not landed by now, the baseline below would be taken too early and the
    // original race would be back — fail here, where the cause is legible,
    // rather than three lines later as a phantom second capture.
    expect(capturesForRun(0, runId)).toHaveLength(1);

    // The first sweep already cleared executionControlDeadlineAt and moved the
    // run to "failed". Restore the deadline to simulate a second sweep still
    // observing the same run as a candidate.
    await db
      .update(heartbeatRuns)
      .set({ executionControlDeadlineAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, runId));

    const captureCallsBefore = mockCaptureRunFailure.mock.calls.length;
    const result = await reconcileAbandonedExecutionControl(db);

    // The run is already terminal ("failed"), so the early terminal-status
    // guard applies and no second "failed" write happens.
    expect(result.surfaced).toBe(1);
    // Give a report the second sweep might have fired the same chance to land
    // that the first one got. Asserting absence without this would pass merely
    // because nothing had settled yet.
    await settleRunFailureReports();
    // Scoped by runId so a sibling test's capture cannot satisfy or break this.
    expect(capturesForRun(captureCallsBefore, runId)).toHaveLength(0);
  });
});

describeEmbeddedPostgres("reapStaleExecutionOwnerLeases clears dead-holder leases and keeps live ones", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("stale-execution-lease-reaper-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // A legacy conversation run (the only shape that can raise an
  // execution_owner_active gate) plus the active, never-released lease it held.
  async function seedConversationLeaseRun(status: "failed" | "running" | "queued") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const leaseId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Stale Lease Reap",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Lease holder",
      adapterType: "claude_local",
      status: "running",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status,
      runtimeMode: "legacy",
      contextSnapshot: { issueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Lease gate",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(environmentLeases).values({
      id: leaseId,
      companyId,
      heartbeatRunId: runId,
      issueId,
      status: "active",
      leasePolicy: "ephemeral",
    });

    return { companyId, issueId, leaseId };
  }

  const getLease = (leaseId: string) =>
    db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .limit(1)
      .then((rows) => rows[0]);

  it("releases the lease and clears the gate for a dead holder run", async () => {
    const dead = await seedConversationLeaseRun("failed");

    // Before reaping, the dead conversation run's held lease is the gate.
    expect((await getConversationOwnershipBlocker(db, dead.companyId, dead.issueId))?.cause).toBe("execution_owner_active");

    const result = await reapStaleExecutionOwnerLeases(db);
    expect(result.reaped).toBe(1);

    const lease = await getLease(dead.leaseId);
    expect(lease?.releasedAt).not.toBeNull();
    expect(lease?.status).toBe("released");
    expect(lease?.cleanupStatus).toBe("success");

    // With the lease gone and no live process, the gate no longer reports.
    expect(await getConversationOwnershipBlocker(db, dead.companyId, dead.issueId)).toBeNull();
  });

  it("never releases the lease of a holder run that is still live", async () => {
    const live = await seedConversationLeaseRun("running");
    const queued = await seedConversationLeaseRun("queued");

    const result = await reapStaleExecutionOwnerLeases(db);

    // Neither the running nor the queued holder is terminal, so nothing is
    // reaped for them even though both hold an unreleased lease.
    expect(result.reaped).toBe(0);

    const liveLease = await getLease(live.leaseId);
    expect(liveLease?.releasedAt).toBeNull();
    expect(liveLease?.status).toBe("active");
    const queuedLease = await getLease(queued.leaseId);
    expect(queuedLease?.releasedAt).toBeNull();
  });

  it("never releases the lease of a legacy non-conversation (provider-backed) terminal run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const leaseId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Provider-Backed Lease",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Provider sandbox",
      adapterType: "paperclip_runner",
      status: "running",
    });
    // A legacy terminal run whose adapter is provider-backed, NOT a
    // conversation adapter. Its lease is owned by the provider teardown
    // path, not the in-plane bookkeeping the reaper targets.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "failed",
      runtimeMode: "legacy",
      contextSnapshot: { issueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Provider sandbox gate",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(environmentLeases).values({
      id: leaseId,
      companyId,
      heartbeatRunId: runId,
      issueId,
      status: "active",
      leasePolicy: "ephemeral",
    });

    const result = await reapStaleExecutionOwnerLeases(db);

    // The reaper must NOT release this lease: the holder run is terminal but
    // NOT a conversation run, so the blocker reader would never gate on it
    // and its cleanup belongs to the pending-cleanup sweep.
    expect(result.reaped).toBe(0);
    const lease = await getLease(leaseId);
    expect(lease?.releasedAt).toBeNull();
    expect(lease?.status).toBe("active");
  });
});

describeEmbeddedPostgres(
  "reapStrandedSummaryGenerationIssues terminalizes pre-existing stranded summary tasks",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("stranded-summary-generation-reaper-");
      db = createDb(tempDb.connectionString);
    }, 30_000);

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    /**
     * The mint-only token block `generationIssueDescription()` writes into every
     * generation task's description. The reaper selects on this marker rather
     * than the slot binding because SUP-16945's read-path reclaim clears
     * `summary_slots.generating_issue_id` without terminalizing the issue, so a
     * stranded card's slot may already be released by the time it is reaped.
     */
    function generationDescription(generationIssueId: string) {
      return [
        "Generate the project summary for `86aa3f31-ce0d-42f8-98e9-02154f9be6a9`.",
        "",
        "```json",
        JSON.stringify(
          {
            scopeKind: "project",
            scopeId: "86aa3f31-ce0d-42f8-98e9-02154f9be6a9",
            slotKey: "header",
            generationIssueId,
          },
          null,
          2,
        ),
        "```",
      ].join("\n");
    }

    async function seedCompanyAndSummarizer() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const reviewerAgentId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Stranded Summary Generation",
        issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      });
      await db.insert(agents).values([
        { id: agentId, companyId, name: "Summarizer", adapterType: "claude_local", status: "idle" },
        { id: reviewerAgentId, companyId, name: "Reviewer", adapterType: "claude_local", status: "idle" },
      ]);
      return { companyId, agentId, reviewerAgentId };
    }

    /**
     * A generation task in the pre-existing stranded shape: the review stage
     * bounced it to changes_requested, the bounce run is gone, and no recovery
     * action is in flight.
     */
    async function seedStrandedGenerationTask(opts: {
      companyId: string;
      agentId: string;
      reviewerAgentId: string;
      status?: "in_progress" | "blocked";
      description?: string;
    }) {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId: opts.companyId,
        title: "Summarize project",
        status: opts.status ?? "in_progress",
        assigneeAgentId: opts.agentId,
        executionState: {
          status: "changes_requested",
          currentStageId: randomUUID(),
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: opts.reviewerAgentId, userId: null },
          returnAssignee: { type: "agent", agentId: opts.agentId, userId: null },
          lastDecisionId: randomUUID(),
          lastDecisionOutcome: "changes_requested",
          changesRequestedCount: 1,
          pendingSince: new Date(Date.now() - 60_000).toISOString(),
        },
        description: opts.description ?? generationDescription(issueId),
      });
      return issueId;
    }

    const getIssue = (issueId: string) =>
      db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId))
        .limit(1)
        .then((rows) => rows[0]);

    it("terminalizes a pre-existing summary task stranded in changes_requested with no live run", async () => {
      const { companyId, agentId, reviewerAgentId } = await seedCompanyAndSummarizer();
      const issueId = await seedStrandedGenerationTask({ companyId, agentId, reviewerAgentId });

      const result = await reapStrandedSummaryGenerationIssues(db);

      expect(result).toEqual({ scanned: 1, terminalized: 1 });
      const issue = await getIssue(issueId);
      expect(issue?.status).toBe("done");
      expect(issue?.executionRunId).toBeNull();
      expect(issue?.checkoutRunId).toBeNull();
    });

    it("terminalizes a blocked summary task and releases a still-armed slot binding", async () => {
      const { companyId, agentId, reviewerAgentId } = await seedCompanyAndSummarizer();
      const issueId = await seedStrandedGenerationTask({ companyId, agentId, reviewerAgentId, status: "blocked" });
      const slotId = randomUUID();
      await db.insert(summarySlots).values({
        id: slotId,
        companyId,
        scopeKind: "project",
        scopeId: "86aa3f31-ce0d-42f8-98e9-02154f9be6a9",
        slotKey: "header",
        status: "generating",
        generatingIssueId: issueId,
      });

      const result = await reapStrandedSummaryGenerationIssues(db);

      expect(result).toEqual({ scanned: 1, terminalized: 1 });
      expect((await getIssue(issueId))?.status).toBe("done");
      // The terminal transition runs the same slot finalizer SUP-17609 relies on:
      // the binding is cleared. This generation wrote no surviving revision, so
      // the slot fails closed to "failed" for the refresh sweep to regenerate.
      const [slot] = await db
        .select()
        .from(summarySlots)
        .where(eq(summarySlots.id, slotId))
        .limit(1);
      expect(slot?.generatingIssueId).toBeNull();
      expect(slot?.status).toBe("failed");
    });

    it("is idempotent: a second pass over already-terminal rows is a no-op", async () => {
      const { companyId, agentId, reviewerAgentId } = await seedCompanyAndSummarizer();
      const issueId = await seedStrandedGenerationTask({ companyId, agentId, reviewerAgentId });

      expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 1, terminalized: 1 });

      const rerun = await reapStrandedSummaryGenerationIssues(db);
      expect(rerun).toEqual({ scanned: 0, terminalized: 0 });
      expect((await getIssue(issueId))?.status).toBe("done");
    });

    it("leaves a stranded summary task that still has a live run untouched", async () => {
      const { companyId, agentId, reviewerAgentId } = await seedCompanyAndSummarizer();
      const issueId = await seedStrandedGenerationTask({ companyId, agentId, reviewerAgentId });
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId },
      });
      await db
        .update(issues)
        .set({ executionRunId: runId, checkoutRunId: runId })
        .where(eq(issues.id, issueId));

      const result = await reapStrandedSummaryGenerationIssues(db);

      expect(result).toEqual({ scanned: 0, terminalized: 0 });
      expect((await getIssue(issueId))?.status).toBe("in_progress");
    });

    it("leaves a stranded summary task with an in-flight recovery action untouched", async () => {
      const { companyId, agentId, reviewerAgentId } = await seedCompanyAndSummarizer();
      const issueId = await seedStrandedGenerationTask({ companyId, agentId, reviewerAgentId });
      await db.insert(issueRecoveryActions).values({
        companyId,
        sourceIssueId: issueId,
        kind: "active_run_watchdog",
        status: "active",
        ownerType: "board",
        cause: "execution_finalization_deadline_exceeded",
        fingerprint: `test:${issueId}`,
        nextAction: "Inspect the failed run.",
      });

      const result = await reapStrandedSummaryGenerationIssues(db);

      expect(result).toEqual({ scanned: 0, terminalized: 0 });
      expect((await getIssue(issueId))?.status).toBe("in_progress");
    });

    it("leaves a changes_requested card that is not a summary generation task untouched", async () => {
      const { companyId, agentId, reviewerAgentId } = await seedCompanyAndSummarizer();
      const issueId = await seedStrandedGenerationTask({
        companyId,
        agentId,
        reviewerAgentId,
        description: "An ordinary task that happens to be waiting on review.",
      });

      const result = await reapStrandedSummaryGenerationIssues(db);

      expect(result).toEqual({ scanned: 0, terminalized: 0 });
      expect((await getIssue(issueId))?.status).toBe("in_progress");
    });
  },
);
