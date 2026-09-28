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
  issueThreadInteractions,
  issueWatchdogs,
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
  SUMMARIZER_AGENT_ID,
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
  "reapStrandedSummaryGenerationIssues terminalizes Summarizer cards with no live continuation path (SUP-17698 amended contract)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
    let companyId!: string;
    let reviewerAgentId!: string;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("stranded-summary-generation-reaper-");
      db = createDb(tempDb.connectionString);
      // The Summarizer row carries the fixed UUID the amended contract pins,
      // and agents.id is a global primary key — so it can exist only once per
      // database. Seed the company and both agents once for the whole block;
      // every test isolates itself with fresh issue rows instead.
      companyId = randomUUID();
      reviewerAgentId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Stranded Summary Generation",
        issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      });
      await db.insert(agents).values([
        {
          id: SUMMARIZER_AGENT_ID,
          companyId,
          name: "Summarizer",
          adapterType: "claude_local",
          status: "idle",
        },
        { id: reviewerAgentId, companyId, name: "Reviewer", adapterType: "claude_local", status: "idle" },
      ]);
    }, 30_000);

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    /**
     * The mint-only token block `generationIssueDescription()` writes into every
     * generation task's description. Kept in the fixture for fidelity to the
     * production strands — the amended selector does NOT read the description.
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

    /**
     * A card in the stranded population: assigned to the Summarizer,
     * non-terminal, and (by default) free of every continuation path.
     * `executionState` is deliberately variable — the amended selector does
     * not read it. `updatedAt` is backdated by default so the card sits
     * outside the §2a settle window, like the production strands that have
     * been abandoned for days.
     */
    async function seedStrandedGenerationTask(opts: {
      companyId: string;
      reviewerAgentId: string;
      status?: "todo" | "in_progress" | "blocked";
      executionState?: Record<string, unknown> | null;
      description?: string;
      recentActivity?: boolean;
    }) {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId: opts.companyId,
        title: "Summarize project",
        status: opts.status ?? "in_progress",
        assigneeAgentId: SUMMARIZER_AGENT_ID,
        executionState:
          opts.executionState === undefined
            ? {
                status: "changes_requested",
                currentStageId: randomUUID(),
                currentStageIndex: 0,
                currentStageType: "review",
                currentParticipant: { type: "agent", agentId: opts.reviewerAgentId, userId: null },
                returnAssignee: { type: "agent", agentId: SUMMARIZER_AGENT_ID, userId: null },
                lastDecisionId: randomUUID(),
                lastDecisionOutcome: "changes_requested",
                changesRequestedCount: 1,
                pendingSince: new Date(Date.now() - 60_000).toISOString(),
              }
            : opts.executionState,
        description: opts.description ?? generationDescription(issueId),
        updatedAt: opts.recentActivity ? new Date() : new Date(Date.now() - 10 * 60_000),
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

    it("terminalizes a summary task stranded in changes_requested with no live run", async () => {

      const issueId = await seedStrandedGenerationTask({ companyId, reviewerAgentId });

      const result = await reapStrandedSummaryGenerationIssues(db);

      expect(result).toEqual({ scanned: 1, terminalized: 1 });
      const issue = await getIssue(issueId);
      expect(issue?.status).toBe("done");
      expect(issue?.executionRunId).toBeNull();
      expect(issue?.checkoutRunId).toBeNull();
    });

    it("terminalizes a summary task with a null execution state and no live run", async () => {

      const issueId = await seedStrandedGenerationTask({
        companyId,
        reviewerAgentId,
        executionState: null,
      });

      const result = await reapStrandedSummaryGenerationIssues(db);

      expect(result).toEqual({ scanned: 1, terminalized: 1 });
      expect((await getIssue(issueId))?.status).toBe("done");
    });

    it("terminalizes a blocked summary task and releases a still-armed slot binding", async () => {

      const issueId = await seedStrandedGenerationTask({ companyId, reviewerAgentId, status: "blocked" });
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

    it("terminalizes a todo summary task with a null execution state", async () => {

      const issueId = await seedStrandedGenerationTask({
        companyId,
        reviewerAgentId,
        status: "todo",
        executionState: null,
      });

      const result = await reapStrandedSummaryGenerationIssues(db);

      expect(result).toEqual({ scanned: 1, terminalized: 1 });
      expect((await getIssue(issueId))?.status).toBe("done");
    });

    it("terminalizes a card whose stamped run is dead but whose status never settled", async () => {

      const issueId = await seedStrandedGenerationTask({
        companyId,
        reviewerAgentId,
        executionState: null,
      });
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: SUMMARIZER_AGENT_ID,
        status: "failed",
        contextSnapshot: { issueId },
      });
      await db
        .update(issues)
        .set({ executionRunId: runId, checkoutRunId: runId })
        .where(eq(issues.id, issueId));

      const result = await reapStrandedSummaryGenerationIssues(db);

      // A terminal stamped run is not a live run: the amended contract
      // selects on the absence of a LIVE run, and the funnel clears the
      // dead binding as part of the terminal transition.
      expect(result).toEqual({ scanned: 1, terminalized: 1 });
      const issue = await getIssue(issueId);
      expect(issue?.status).toBe("done");
      expect(issue?.executionRunId).toBeNull();
    });

    it("is idempotent: a second pass over already-terminal rows is a no-op", async () => {

      const issueId = await seedStrandedGenerationTask({ companyId, reviewerAgentId });

      expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 1, terminalized: 1 });

      const rerun = await reapStrandedSummaryGenerationIssues(db);
      expect(rerun).toEqual({ scanned: 0, terminalized: 0 });
      expect((await getIssue(issueId))?.status).toBe("done");
    });

    it("leaves a stranded summary task that still has a live run untouched", async () => {

      const issueId = await seedStrandedGenerationTask({ companyId, reviewerAgentId });
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: SUMMARIZER_AGENT_ID,
        status: "running",
        contextSnapshot: { issueId },
      });
      await db
        .update(issues)
        .set({ executionRunId: runId, checkoutRunId: runId })
        .where(eq(issues.id, issueId));

      const result = await reapStrandedSummaryGenerationIssues(db);

      expect(result).toEqual({ scanned: 1, terminalized: 0 });
      expect((await getIssue(issueId))?.status).toBe("in_progress");

      // Leave the database as found: this card stays coarse-scan-visible to
      // sibling tests, so delete the fixture.
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      await db.delete(issues).where(eq(issues.id, issueId));
    });

    it("leaves a stranded summary task with a pending thread interaction untouched", async () => {

      const issueId = await seedStrandedGenerationTask({
        companyId,
        reviewerAgentId,
        executionState: null,
      });
      await db.insert(issueThreadInteractions).values({
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        payload: { version: 1, prompt: "Review native evidence" },
      });

      const result = await reapStrandedSummaryGenerationIssues(db);

      // A question awaiting a human answer is a continuation path: the card
      // is not a scan candidate at all.
      expect(result).toEqual({ scanned: 0, terminalized: 0 });
      expect((await getIssue(issueId))?.status).toBe("in_progress");
    });

    it("leaves a stranded summary task with an armed monitor untouched", async () => {

      const issueId = await seedStrandedGenerationTask({
        companyId,
        reviewerAgentId,
        executionState: null,
      });
      await db
        .update(issues)
        .set({ monitorNextCheckAt: new Date(Date.now() + 3_600_000) })
        .where(eq(issues.id, issueId));

      const result = await reapStrandedSummaryGenerationIssues(db);

      expect(result).toEqual({ scanned: 0, terminalized: 0 });
      expect((await getIssue(issueId))?.status).toBe("in_progress");
    });

    it("leaves a stranded summary task with an active task watchdog untouched", async () => {

      const issueId = await seedStrandedGenerationTask({
        companyId,
        reviewerAgentId,
        executionState: null,
      });
      await db.insert(issueWatchdogs).values({
        companyId,
        issueId,
        watchdogAgentId: reviewerAgentId,
        status: "active",
      });

      const result = await reapStrandedSummaryGenerationIssues(db);

      // The watchdog is a §2a live-continuation disjunct the coarse scan does
      // not filter on, so the card is scanned and then left to its watchdog.
      expect(result).toEqual({ scanned: 1, terminalized: 0 });
      expect((await getIssue(issueId))?.status).toBe("in_progress");

      // Leave the database as found: this card stays coarse-scan-visible to
      // sibling tests, so delete the fixture.
      await db.delete(issueWatchdogs).where(eq(issueWatchdogs.issueId, issueId));
      await db.delete(issues).where(eq(issues.id, issueId));
    });

    it("leaves a stranded summary task with an in-flight recovery action untouched", async () => {

      const issueId = await seedStrandedGenerationTask({ companyId, reviewerAgentId });
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

    it("leaves a card whose last activity is inside the settle window untouched", async () => {

      const issueId = await seedStrandedGenerationTask({
        companyId,
        reviewerAgentId,
        executionState: null,
        recentActivity: true,
      });

      const result = await reapStrandedSummaryGenerationIssues(db);

      // §2a settle window: run stamping and status commit are not
      // simultaneous, so a card touched within the last five minutes is not
      // a ghost yet.
      expect(result).toEqual({ scanned: 1, terminalized: 0 });
      expect((await getIssue(issueId))?.status).toBe("in_progress");

      // Leave the database as found: this card stays coarse-scan-visible to
      // sibling tests, so delete the fixture.
      await db.delete(issues).where(eq(issues.id, issueId));
    });

    it("leaves a non-terminal card assigned to a different agent untouched", async () => {

      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Summarize project",
        status: "in_progress",
        assigneeAgentId: reviewerAgentId,
        executionState: null,
        description: generationDescription(issueId),
        updatedAt: new Date(Date.now() - 10 * 60_000),
      });

      const result = await reapStrandedSummaryGenerationIssues(db);

      // The amended population is pinned by assignee: an identically-shaped
      // card owned by another agent is not this reaper's.
      expect(result).toEqual({ scanned: 0, terminalized: 0 });
      expect((await getIssue(issueId))?.status).toBe("in_progress");
    });
  },
);
