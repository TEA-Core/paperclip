import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Issue rewake throttle test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue rewake throttle tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat issue rewake throttle", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-rewake-throttle-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    // Await every in-flight background heartbeat run to quiescence before the
    // deletes below. A wakeup claims a run and dispatches its execution
    // fire-and-forget, and that run can dispatch a follow-up wakeup, so a run or
    // wakeup can still write heartbeat_runs and issues rows when teardown starts
    // and would race the deletes (a heartbeat_runs delete deadlocks on the ON
    // DELETE SET NULL cascade to issues). The shared drain also awaits an
    // in-flight wakeup that is still before run registration, which a plain run
    // table status poll cannot see.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // Post-run bookkeeping (run-event records, follow-up wake scheduling) can
    // still write for a moment after a run reaches a terminal status, so a
    // single delete sweep can hit a foreign-key violation when a late insert
    // lands between two deletes. Retry the sweep until it goes through clean.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgentIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Interrupted import mission",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    return { companyId, agentId, issueId };
  }

  async function seedTerminalRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status?: string;
    finishedSecondsAgo: number;
    startedSecondsAgo?: number;
    sessionIdAfter?: string;
  }) {
    const runId = randomUUID();
    const finishedAt = new Date(Date.now() - input.finishedSecondsAgo * 1000);
    const startedAt = input.startedSecondsAgo === undefined
      ? new Date(finishedAt.getTime() - 5_000)
      : new Date(Date.now() - input.startedSecondsAgo * 1000);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: input.status ?? "succeeded",
      responsibleUserId: "responsible-user",
      createdAt: startedAt,
      startedAt,
      finishedAt,
      sessionIdAfter: input.sessionIdAfter,
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_assigned" },
    });
    return runId;
  }

  function assignmentWake(agentId: string, issueId: string) {
    return heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
  }

  async function latestWakeRequest(agentId: string) {
    return db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  it("skips event-free re-wakes after consecutive no-progress runs and admits them again on new input", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const throttledWake = await assignmentWake(agentId, issueId);
    expect(throttledWake).toBeNull();

    const skipped = await latestWakeRequest(agentId);
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.reason).toBe("issue_rewake_throttled");
    const heartbeatSkip = (skipped?.payload as Record<string, unknown> | null)?.heartbeatSkip as
      | Record<string, unknown>
      | undefined;
    expect(heartbeatSkip?.noProgressStreak).toBe(2);
    expect(typeof heartbeatSkip?.nextAllowedAt).toBe("string");

    const runCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .then((rows) => rows[0]?.count ?? 0);
    expect(runCount).toBe(2);

    // A board comment on the issue is new input: the next event-free wake is
    // admitted even though the streak has not been broken by a run.
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
    });

    const admittedWake = await assignmentWake(agentId, issueId);
    expect(admittedWake).not.toBeNull();
  });

  it("does not throttle system comment-driven wakes even during a no-progress streak", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const commentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      contextSnapshot: { issueId, wakeReason: "issue_commented" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    expect(commentWake).not.toBeNull();
  });

  it("keeps agent comments throttled without hiding genuinely new human input", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const agentCommentId = randomUUID();
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: randomUUID(),
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
    });
    const throttledAgentCommentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: agentCommentId },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
        wakeCommentId: agentCommentId,
      },
      requestedByActorType: "agent",
      requestedByActorId: randomUUID(),
    });
    expect(throttledAgentCommentWake).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_throttled");

    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
    });
    const nextAgentCommentId = randomUUID();
    const admittedAfterHumanInput = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: nextAgentCommentId },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
        wakeCommentId: nextAgentCommentId,
      },
      requestedByActorType: "agent",
      requestedByActorId: randomUUID(),
    });
    expect(admittedAfterHumanInput).not.toBeNull();
  });

  it("keeps agent-authored explicit resume comments inside the no-progress cooldown", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    const resumeFromRunId = await seedTerminalRun({
      companyId,
      agentId,
      issueId,
      finishedSecondsAgo: 40,
      sessionIdAfter: randomUUID(),
    });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const commentId = randomUUID();
    const resumeWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_reopened_via_comment",
      payload: { issueId, commentId, resumeFromRunId, resumeIntent: true },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_reopened_via_comment",
        wakeCommentId: commentId,
        resumeIntent: true,
      },
      requestedByActorType: "agent",
      requestedByActorId: randomUUID(),
    });

    expect(resumeWake).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_throttled");
  });

  it("does not throttle the wake that follows a failed run", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 70 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    await seedTerminalRun({ companyId, agentId, issueId, status: "failed", finishedSecondsAgo: 10 });

    const recoveryWake = await assignmentWake(agentId, issueId);
    expect(recoveryWake).not.toBeNull();
  });

  it("does not throttle when a recent run produced issue-visible progress", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    const progressRunId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId: progressRunId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
      createdAt: new Date(Date.now() - 11_000),
    });

    const wake = await assignmentWake(agentId, issueId);
    expect(wake).not.toBeNull();
  });

  it("does not count progress on another issue toward the current issue", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId,
      title: "Related follow-up",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    const progressRunId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId: progressRunId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: otherIssueId,
      createdAt: new Date(Date.now() - 11_000),
    });

    const wake = await assignmentWake(agentId, issueId);
    expect(wake).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_throttled");
  });

  it("counts a long-running session that finished inside the lookback window", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({
      companyId,
      agentId,
      issueId,
      finishedSecondsAgo: 40,
      startedSecondsAgo: 7 * 60 * 60,
    });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const wake = await assignmentWake(agentId, issueId);
    expect(wake).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_throttled");
  });

  describe("deferred-wake promotion damp (SUP-14737)", () => {
    async function seedDeferredWake(input: {
      companyId: string;
      agentId: string;
      issueId: string;
      requestedByActorType: "user" | "agent" | "system";
      /** Stored under the deferred-wake context key the promotion path reads. */
      wakeContext?: Record<string, unknown>;
    }) {
      const wakeId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: wakeId,
        companyId: input.companyId,
        agentId: input.agentId,
        source: "automation",
        reason: "issue_execution_promoted",
        payload: input.wakeContext
          ? { issueId: input.issueId, _paperclipWakeContext: input.wakeContext }
          : { issueId: input.issueId },
        status: "deferred_issue_execution",
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorType === "agent" ? input.agentId : "board-user",
        requestedAt: new Date(),
      });
      return wakeId;
    }

    async function fetchWakeRow(wakeId: string) {
      const [wake] = await db
        .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeId));
      return wake ?? null;
    }

    async function runsForWakeup(companyId: string, wakeId: string) {
      return db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.wakeupRequestId, wakeId)));
    }

    it("damps a no-progress self-loop promotion: the deferred wake is skipped, no run re-armed", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

      // Two consecutive terminal runs that produced no issue-state change.
      await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
      const endingRunId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 0 });

      const wakeId = await seedDeferredWake({
        companyId,
        agentId,
        issueId,
        requestedByActorType: "agent",
      });

      const [endingRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, endingRunId));
      await heartbeat.releaseIssueExecutionAndPromote(endingRun);

      const wake = await fetchWakeRow(wakeId);
      expect(wake?.status).toBe("skipped");
      expect(wake?.reason).toBe("issue_deferred_promotion_dampened");
      expect(await runsForWakeup(companyId, wakeId)).toEqual([]);
    });

    it("drains a deferred wake on a blocked card with an unresolved blocker that is not board input", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

      // The blocker edge is what gates dispatch: `blocked` alone is still
      // actionable (the assignee re-evaluates), so the drain only fires when
      // the card cannot progress — i.e. it has an unresolved blocker edge.
      const blockerId = randomUUID();
      await db.insert(issues).values({
        id: blockerId,
        companyId,
        title: "Unresolved blocker",
        status: "in_progress",
        priority: "high",
      });
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerId,
        relatedIssueId: issueId,
        type: "blocks",
      });
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));

      const endingRunId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 0 });
      const wakeId = await seedDeferredWake({
        companyId,
        agentId,
        issueId,
        requestedByActorType: "agent",
      });

      const [endingRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, endingRunId));
      await heartbeat.releaseIssueExecutionAndPromote(endingRun);

      const wake = await fetchWakeRow(wakeId);
      expect(wake?.status).toBe("skipped");
      expect(wake?.reason).toBe("issue_deferred_promotion_drained_blocked");
      expect(await runsForWakeup(companyId, wakeId)).toEqual([]);
    });

    /**
     * The drain gate exists to mirror dispatch: drain exactly what a fresh
     * dispatch would suppress. Dispatch (`claimQueuedRun`) admits any wake
     * satisfying `allowsIssueInteractionWake` even with unresolved blockers,
     * and interaction wakes carry the actor type of whoever produced the
     * comment — the merged-PR sweep enqueues `issue_commented` as `"system"`.
     * Gating on actor type alone therefore drained wakes dispatch would admit.
     */
    it("does NOT drain a deferred interaction wake on a blocked card, even when the actor is system", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

      const blockerId = randomUUID();
      await db.insert(issues).values({
        id: blockerId,
        companyId,
        title: "Unresolved blocker",
        status: "in_progress",
        priority: "high",
      });
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerId,
        relatedIssueId: issueId,
        type: "blocks",
      });
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));

      const endingRunId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 0 });
      const wakeId = await seedDeferredWake({
        companyId,
        agentId,
        issueId,
        requestedByActorType: "system",
        wakeContext: { issueId, wakeReason: "issue_commented", commentId: randomUUID() },
      });

      const [endingRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, endingRunId));
      await heartbeat.releaseIssueExecutionAndPromote(endingRun);

      const wake = await fetchWakeRow(wakeId);
      expect(wake?.reason).not.toBe("issue_deferred_promotion_drained_blocked");
      expect(wake?.status).not.toBe("skipped");
    });

    // Negative: the bypass must key on a real interaction wake, not merely on
    // the presence of a wake context. A context with an interaction reason but
    // NO comment id fails `allowsIssueInteractionWake`, exactly as it does at
    // the dispatch gate, and must still drain.
    it("still drains a blocked-card wake whose context has an interaction reason but no comment id", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

      const blockerId = randomUUID();
      await db.insert(issues).values({
        id: blockerId,
        companyId,
        title: "Unresolved blocker",
        status: "in_progress",
        priority: "high",
      });
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerId,
        relatedIssueId: issueId,
        type: "blocks",
      });
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));

      const endingRunId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 0 });
      const wakeId = await seedDeferredWake({
        companyId,
        agentId,
        issueId,
        requestedByActorType: "agent",
        wakeContext: { issueId, wakeReason: "issue_commented" },
      });

      const [endingRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, endingRunId));
      await heartbeat.releaseIssueExecutionAndPromote(endingRun);

      const wake = await fetchWakeRow(wakeId);
      expect(wake?.status).toBe("skipped");
      expect(wake?.reason).toBe("issue_deferred_promotion_drained_blocked");
      expect(await runsForWakeup(companyId, wakeId)).toEqual([]);
    });

    it("does NOT drain a deferred wake on a bare blocked card (no unresolved blocker): it promotes so the assignee can re-evaluate", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));

      const endingRunId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 0 });
      const wakeId = await seedDeferredWake({
        companyId,
        agentId,
        issueId,
        requestedByActorType: "agent",
      });

      const [endingRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, endingRunId));
      await heartbeat.releaseIssueExecutionAndPromote(endingRun);

      const wake = await fetchWakeRow(wakeId);
      expect(wake?.reason).toBe("issue_execution_promoted");
      expect(["queued", "claimed", "processing"]).toContain(wake?.status);
      const promoted = await runsForWakeup(companyId, wakeId);
      expect(promoted).toHaveLength(1);
    });

    it("lets a promotion through when genuine new user input arrived after the last run", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

      await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
      const endingRunId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 5 });

      // A board comment after the newest run finished is new input: it breaks the
      // no-progress streak and the deferred self-promotion must proceed.
      await db.insert(activityLog).values({
        companyId,
        actorType: "user",
        actorId: "board-user",
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issueId,
        createdAt: new Date(),
      });

      const wakeId = await seedDeferredWake({
        companyId,
        agentId,
        issueId,
        requestedByActorType: "agent",
      });

      const [endingRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, endingRunId));
      await heartbeat.releaseIssueExecutionAndPromote(endingRun);

      const wake = await fetchWakeRow(wakeId);
      // Reason is the promotion marker; the status may have advanced to "claimed"
      // by the time we read it because the heartbeat worker claims a freshly
      // promoted queued wake immediately.
      expect(wake?.reason).toBe("issue_execution_promoted");
      expect(["queued", "claimed", "processing"]).toContain(wake?.status);
      const promoted = await runsForWakeup(companyId, wakeId);
      expect(promoted).toHaveLength(1);
    });

    it("promotes deferred retries for two sibling issues without cross-stamping pointers", async () => {
      const { companyId, agentId, issueId: issueAId } = await seedCompanyAgentIssue();
      const issueBId = randomUUID();
      await db.insert(issues).values({
        id: issueBId,
        companyId,
        title: "Sibling mission",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      });

      // One terminal run per sibling, each scoped to its own issue.
      const endingRunAId = await seedTerminalRun({
        companyId,
        agentId,
        issueId: issueAId,
        finishedSecondsAgo: 0,
      });
      const endingRunBId = await seedTerminalRun({
        companyId,
        agentId,
        issueId: issueBId,
        finishedSecondsAgo: 0,
      });

      // One deferred wake per sibling, each carrying its own issue in both the
      // payload issueId the promotion selects on and the wake context the
      // promoted run inherits.
      const wakeAId = await seedDeferredWake({
        companyId,
        agentId,
        issueId: issueAId,
        requestedByActorType: "user",
        wakeContext: { issueId: issueAId, wakeReason: "issue_reopened_via_comment" },
      });
      const wakeBId = await seedDeferredWake({
        companyId,
        agentId,
        issueId: issueBId,
        requestedByActorType: "user",
        wakeContext: { issueId: issueBId, wakeReason: "issue_reopened_via_comment" },
      });

      const [endingA] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, endingRunAId));
      const [endingB] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, endingRunBId));
      await heartbeat.releaseIssueExecutionAndPromote(endingA);
      await heartbeat.releaseIssueExecutionAndPromote(endingB);

      const promotedA = await runsForWakeup(companyId, wakeAId);
      const promotedB = await runsForWakeup(companyId, wakeBId);
      expect(promotedA).toHaveLength(1);
      expect(promotedB).toHaveLength(1);

      const contextIssueOf = async (runId: string) => {
        const run = await db
          .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId))
          .then((rows) => rows[0] ?? null);
        return ((run?.contextSnapshot ?? {}) as Record<string, unknown>).issueId ?? null;
      };

      // Each promoted run is bound to the sibling whose deferred wake produced
      // it — never to the other sibling the same agent is working.
      expect(await contextIssueOf(promotedA[0].id)).toBe(issueAId);
      expect(await contextIssueOf(promotedB[0].id)).toBe(issueBId);

      // Settle the promoted executions, then assert the durable invariant: any
      // surviving execution/checkout pointer names a run scoped to that card.
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const cards = await db
        .select({
          id: issues.id,
          executionRunId: issues.executionRunId,
          checkoutRunId: issues.checkoutRunId,
        })
        .from(issues)
        .where(eq(issues.companyId, companyId));
      for (const card of cards) {
        for (const runId of [card.executionRunId, card.checkoutRunId]) {
          if (!runId) continue;
          expect(await contextIssueOf(runId)).toBe(card.id);
        }
      }
    });

    /**
     * Fold D9 regression. Upstream gates deferred promotion on the issue's execution blocker in
     * the dormant wake-queue adapter's `releaseIssueExecution` ("A release must leave deferred
     * messages intact while execution is held"). While D9 is deferred, this in-file loop is the
     * only live release path, and it carried no such gate: a Stop's no-replay recovery
     * disposition did not stop it promoting the stopped session's queued wake, so a freshly
     * reset chat re-ran the old topic. Upstream #13284's reset test caught it as a ~37%
     * failure on the fork against ~7% on pure upstream at the same cutoff.
     */
    it("does NOT promote a deferred wake while a no-replay execution blocker holds the issue", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      const endingRunId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 0 });
      const wakeId = await seedDeferredWake({
        companyId,
        agentId,
        issueId,
        requestedByActorType: "agent",
      });

      // The disposition a Stop leaves behind: resolved bookkeeping that still forbids a replay.
      await db.insert(issueRecoveryActions).values({
        companyId,
        sourceIssueId: issueId,
        kind: "active_run_watchdog",
        ownerType: "board",
        cause: "uncertain_provider_action",
        status: "resolved",
        fingerprint: randomUUID(),
        evidence: { automaticRecovery: { replay: "blocked" } },
        nextAction: "Do not replay the stopped turn.",
      });

      const [endingRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, endingRunId));
      await heartbeat.releaseIssueExecutionAndPromote(endingRun);

      // Left intact, not cancelled: upstream withholds the promotion, it does not consume the wake.
      const wake = await fetchWakeRow(wakeId);
      expect(wake?.status).toBe("deferred_issue_execution");
      expect(await runsForWakeup(companyId, wakeId)).toEqual([]);
    });

    /**
     * Fold D9 regression, second half. The gate must sit at the promotion step, not at the head
     * of this loop. The loop disposes of stale queued wakes before it promotes anything, so a
     * loop-head gate skips the disposal too and the wake sits `deferred_issue_execution` forever
     * instead of being cancelled. Measured on upstream #13284's reset test: 0/12 passes with the
     * loop-head gate against 11/12 with the gate at the promotion step.
     */
    it("still disposes of a stale queued wake while a no-replay disposition holds the issue", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      const endingRunId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 0 });

      // A queued comment that is no longer live: the disposal path cancels a wake whose queued
      // comments have all been discarded.
      const [queued] = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorUserId: "board-user",
          body: "Queued before the stop",
          deletedAt: new Date(),
        })
        .returning();

      const wakeId = await seedDeferredWake({
        companyId,
        agentId,
        issueId,
        requestedByActorType: "user",
        wakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [queued.id] },
      });

      await db.insert(issueRecoveryActions).values({
        companyId,
        sourceIssueId: issueId,
        kind: "active_run_watchdog",
        ownerType: "board",
        cause: "uncertain_provider_action",
        status: "resolved",
        fingerprint: randomUUID(),
        evidence: { automaticRecovery: { replay: "blocked" } },
        nextAction: "Do not replay the stopped turn.",
      });

      const [endingRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, endingRunId));
      await heartbeat.releaseIssueExecutionAndPromote(endingRun);

      // Disposed of, not promoted and not left deferred.
      const wake = await fetchWakeRow(wakeId);
      expect(wake?.status).toBe("cancelled");
      expect(await runsForWakeup(companyId, wakeId)).toEqual([]);
    });

    it("still promotes the same deferred wake once no execution blocker holds the issue", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      const endingRunId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 0 });
      const wakeId = await seedDeferredWake({
        companyId,
        agentId,
        issueId,
        requestedByActorType: "agent",
      });

      const [endingRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, endingRunId));
      await heartbeat.releaseIssueExecutionAndPromote(endingRun);

      const wake = await fetchWakeRow(wakeId);
      expect(wake?.reason).toBe("issue_execution_promoted");
      expect(["queued", "claimed", "processing"]).toContain(wake?.status);
      expect(await runsForWakeup(companyId, wakeId)).toHaveLength(1);
    });
  });
});
