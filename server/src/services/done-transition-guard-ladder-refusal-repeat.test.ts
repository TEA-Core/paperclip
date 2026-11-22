import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, issueExecutionDecisions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  reapStrandedSummaryGenerationIssues,
  SUMMARIZER_AGENT_ID,
} from "./execution-control-reconciliation.js";
import { evaluateDoneTransitionGuard, evaluateDoneTransitionGuardForBackstopClose } from "./done-transition-guard.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const REFUSED = "issue.done_transition_ladder_refused";
const REPEATED = "issue.done_transition_ladder_refusal_repeated";

// SUP-24136: the stranded-summary reaper runs the done-transition guard every
// 15 s on a Summarizer-assigned card. An unsatisfied review ladder wrote one
// identical refusal row per tick (SUP-24118: 54 rows in 13 minutes). The guard
// bounds identical refusal rows per window on the database clock. On top of
// that, the reaper defers a card while its ladder state is unchanged (the
// refusal row's `ladderStateKey`), so sweep ticks after the first do not
// reach the guard at all; only a ladder-state change re-arms the card. These
// tests drive the real reaper and guard against a real database.
describeEmbeddedPostgres("SUP-24136 repeated identical review-ladder refusals", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let reviewerAgentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("ladder-refusal-repeat-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    reviewerAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Ladder Refusal Repeat",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values([
      { id: SUMMARIZER_AGENT_ID, companyId, name: "Summarizer", adapterType: "claude_local", status: "idle" },
      { id: reviewerAgentId, companyId, name: "Reviewer", adapterType: "claude_local", status: "idle" },
    ]);
  }, 30_000);

  afterEach(async () => {
    vi.useRealTimers();
    await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
    await db.delete(issues).where(eq(issues.companyId, companyId));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** The SUP-24118 shape: one review stage, pending, no decision. Outside the settle window. */
  async function seedLadderCard() {
    const issueId = randomUUID();
    const stageId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Re-review corrected summary",
      status: "in_progress",
      assigneeAgentId: SUMMARIZER_AGENT_ID,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{ id: stageId, type: "review", participants: [{ type: "agent", agentId: reviewerAgentId }] }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: SUMMARIZER_AGENT_ID, userId: null },
        completedStageIds: [],
        skippedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        changesRequestedCount: 0,
      },
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });
    return { issueId, stageId };
  }

  const rows = (issueId: string, action: string) =>
    db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, action)));

  const statusOf = (issueId: string) =>
    db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((found) => found[0]?.status);

  /** Move every activity row of the issue back by `minutes` on the database clock. */
  const ageActivity = (issueId: string, minutes: number) =>
    db
      .update(activityLog)
      .set({ createdAt: sql`${activityLog.createdAt} - make_interval(mins => ${minutes})` })
      .where(eq(activityLog.entityId, issueId));

  // Before SUP-24136 the guard wrote refusal rows fire-and-forget and exposed
  // no promise to await, so the negative tests below (which must also hold on
  // that code) give any in-flight insert a short real-time delay to land
  // before they count. Fake timers cannot help: the insert waits on the
  // database, not on a timer. The current guard awaits the write.
  const drainAuditWrites = () => new Promise((resolve) => setTimeout(resolve, 250));

  const readIssue = async (issueId: string) => {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    expect(issue).toBeDefined();
    return issue!;
  };

  const policy = (stages: Array<{ id: string; type: "review" | "approval" }>) => ({
    mode: "normal",
    commentRequired: true,
    stages: stages.map((stage) => ({
      ...stage,
      participants: [{ type: "agent", agentId: reviewerAgentId }],
    })),
  });

  it.each([false, true])("refreshes capped deferral state, including legacy rows (%s), without bypassing the guard", async (legacy) => {
    const { issueId, stageId } = await seedLadderCard();
    for (let call = 0; call < 5; call++) {
      // Seed through the core door so a backstop-bypass mutant must reach
      // the real reaper outcome, not fail only on this setup assertion.
      expect((await evaluateDoneTransitionGuard(db, await readIssue(issueId), null)).allowed).toBe(false);
    }
    if (legacy) {
      await db.update(activityLog).set({
        details: sql`${activityLog.details} - 'ladderStateKey' - 'lastEvaluatedLadderStateKey'`,
      }).where(eq(activityLog.entityId, issueId));
    }
    const stages: Array<{ id: string; type: "review" }> = [{ id: stageId, type: "review" }];
    // Refresh twice AFTER the escalation exists. Reading its original key
    // alone cannot cache the second state. Old rows cannot settle-mask a bypass.
    for (let change = 0; change < 2; change++) {
      stages.push({ id: randomUUID(), type: "review" });
      await db.update(issues).set({ executionPolicy: policy(stages) }).where(eq(issues.id, issueId));
      await ageActivity(issueId, 10);
      const originalRefusals = await rows(issueId, REFUSED);
      expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 1, terminalized: 0 });
      expect(await statusOf(issueId)).toBe("in_progress");
      const refreshedRefusals = await rows(issueId, REFUSED);
      for (const original of originalRefusals) {
        const refreshed = refreshedRefusals.find((row) => row.id === original.id)!;
        const originalDetails = { ...original.details };
        const refreshedDetails = { ...refreshed.details };
        delete originalDetails.lastEvaluatedLadderStateKey;
        delete refreshedDetails.lastEvaluatedLadderStateKey;
        expect(refreshedDetails).toEqual(originalDetails);
        expect(refreshed.createdAt).toEqual(original.createdAt);
      }
      for (let tick = 0; tick < 3; tick++) {
        expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 0, terminalized: 0 });
      }
    }
    expect(await rows(issueId, REFUSED)).toHaveLength(3);
    expect(await rows(issueId, REPEATED)).toHaveLength(1);
  });

  it("preserves the computed refusal when a real cursor lock times out, then converges after release", async () => {
    const { issueId, stageId } = await seedLadderCard();
    for (let call = 0; call < 5; call++) {
      expect((await evaluateDoneTransitionGuardForBackstopClose({
        db, issue: await readIssue(issueId), closeComment: null,
      })).allowed).toBe(false);
    }
    await db.update(issues).set({
      executionPolicy: policy([{ id: stageId, type: "review" }, { id: randomUUID(), type: "review" }]),
    }).where(eq(issues.id, issueId));
    const [latest] = await db.select({ id: activityLog.id }).from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, REFUSED)))
      .orderBy(sql`${activityLog.createdAt} desc`, sql`${activityLog.id} desc`).limit(1);
    // This package's compiler library predates Promise.withResolvers.
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    let releaseLock!: () => void;
    const released = new Promise<void>((resolve) => { releaseLock = resolve; });
    const holding = db.transaction(async (tx) => {
      await tx.select({ id: activityLog.id }).from(activityLog).where(eq(activityLog.id, latest!.id)).for("update");
      signalLocked();
      await released;
    });
    await locked;
    // A separate single-connection pool makes the session timeout apply to
    // the actual refresh UPDATE, never to the lock-holding connection.
    const limitedDb = createDb(tempDb!.connectionString, { maxConnections: 1 });
    try {
      await limitedDb.execute(sql`set lock_timeout = '50ms'`);
      const verdict = await evaluateDoneTransitionGuardForBackstopClose({
        db: limitedDb, issue: await readIssue(issueId), closeComment: null,
      });
      expect(verdict).toMatchObject({
        allowed: false,
        code: "done_transition_missing_delivery",
        reason: expect.stringContaining(`review, ${stageId}`),
      });
      expect(await statusOf(issueId)).toBe("in_progress");
    } finally {
      releaseLock();
      await holding;
    }
    expect((await evaluateDoneTransitionGuardForBackstopClose({
      db, issue: await readIssue(issueId), closeComment: null,
    })).allowed).toBe(false);
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 0, terminalized: 0 });
    expect(await rows(issueId, REFUSED)).toHaveLength(3);
    expect(await rows(issueId, REPEATED)).toHaveLength(1);
  });

  it("refreshes only the changed card when another capped card owns the latest company refusal", async () => {
    const first = await seedLadderCard();
    for (let call = 0; call < 5; call++) {
      await evaluateDoneTransitionGuardForBackstopClose({ db, issue: await readIssue(first.issueId), closeComment: null });
    }
    await ageActivity(first.issueId, 1);
    const second = await seedLadderCard();
    for (let call = 0; call < 5; call++) {
      await evaluateDoneTransitionGuardForBackstopClose({ db, issue: await readIssue(second.issueId), closeComment: null });
    }
    const untouched = await rows(second.issueId, REFUSED);
    await db.update(issues).set({
      executionPolicy: policy([{ id: first.stageId, type: "review" }, { id: randomUUID(), type: "review" }]),
    }).where(eq(issues.id, first.issueId));
    expect((await evaluateDoneTransitionGuardForBackstopClose({
      db, issue: await readIssue(first.issueId), closeComment: null,
    })).allowed).toBe(false);
    const after = await rows(second.issueId, REFUSED);
    for (const original of untouched) {
      expect(after.find((row) => row.id === original.id)).toEqual(original);
    }
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 0, terminalized: 0 });
    expect(await statusOf(first.issueId)).toBe("in_progress");
    expect(await statusOf(second.issueId)).toBe("in_progress");
  });

  it("does not create new audit row versions for unchanged capped refusals", async () => {
    const { issueId } = await seedLadderCard();
    for (let call = 0; call < 5; call++) {
      await evaluateDoneTransitionGuardForBackstopClose({ db, issue: await readIssue(issueId), closeComment: null });
    }
    const before = await db.select({ id: activityLog.id, version: sql<string>`xmin::text` })
      .from(activityLog).where(eq(activityLog.entityId, issueId)).orderBy(activityLog.id);
    for (let call = 0; call < 2; call++) {
      expect((await evaluateDoneTransitionGuardForBackstopClose({
        db, issue: await readIssue(issueId), closeComment: null,
      })).allowed).toBe(false);
    }
    expect(await db.select({ id: activityLog.id, version: sql<string>`xmin::text` })
      .from(activityLog).where(eq(activityLog.entityId, issueId)).orderBy(activityLog.id)).toEqual(before);
    expect(await statusOf(issueId)).toBe("in_progress");
  });

  it("uses the latest refusal rather than an older differently evaluated state", async () => {
    const { issueId, stageId } = await seedLadderCard();
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 1, terminalized: 0 });
    await ageActivity(issueId, 10);
    await db.update(issues).set({
      executionPolicy: policy([{ id: stageId, type: "review" }, { id: randomUUID(), type: "review" }]),
    }).where(eq(issues.id, issueId));
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 1, terminalized: 0 });
    expect(await rows(issueId, REFUSED)).toHaveLength(2);
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 0, terminalized: 0 });
  });

  it("re-arms when a later stage changes completion while the first refused stage stays the same", async () => {
    const { issueId, stageId } = await seedLadderCard();
    const later = randomUUID();
    await db.update(issues).set({
      executionPolicy: policy([{ id: stageId, type: "review" }, { id: later, type: "review" }]),
    }).where(eq(issues.id, issueId));
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 1, terminalized: 0 });
    const issue = await readIssue(issueId);
    await db.update(issues).set({
      executionState: { ...issue.executionState, completedStageIds: [later] },
    }).where(eq(issues.id, issueId));
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 1, terminalized: 0 });
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 0, terminalized: 0 });
    expect(await statusOf(issueId)).toBe("in_progress");
  });

  it("re-evaluates reordered and retyped ladders whose refusal wording changes", async () => {
    const { issueId, stageId } = await seedLadderCard();
    const secondId = randomUUID();
    await db.update(issues).set({
      executionPolicy: policy([{ id: stageId, type: "review" }, { id: secondId, type: "review" }]),
    }).where(eq(issues.id, issueId));
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 1, terminalized: 0 });
    for (const type of ["approval", "review"] as const) {
      await db.update(issues).set({
        executionPolicy: policy([{ id: secondId, type }, { id: stageId, type: "review" }]),
      }).where(eq(issues.id, issueId));
      expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 1, terminalized: 0 });
      const refusals = await rows(issueId, REFUSED);
      expect(refusals.some((row) => row.details?.stageType === type && row.details?.reason === `review_ladder_unsatisfied:${secondId}`)).toBe(true);
      expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 0, terminalized: 0 });
    }
    expect(await statusOf(issueId)).toBe("in_progress");
  });

  it.each(["agent", "operator"] as const)("closes after a durable %s approval with stale projection without self-settling recovery audits", async (actor) => {
    const { issueId, stageId } = await seedLadderCard();
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 1, terminalized: 0 });
    await ageActivity(issueId, 10);
    await db.insert(issueExecutionDecisions).values({
      companyId, issueId, stageId, stageType: "review",
      actorAgentId: actor === "agent" ? reviewerAgentId : null,
      actorUserId: actor === "operator" ? "test-board-operator" : null,
      outcome: "approved", body: "Approved independently of the execution-state projection.",
      createdAt: sql`now() - interval '10 minutes'`,
    });
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 1, terminalized: 1 });
    expect(await statusOf(issueId)).toBe("done");
    expect(await rows(issueId, "issue.done_transition_ladder_recovered_from_decisions")).toHaveLength(1);
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 0, terminalized: 0 });
  });

  it.each([-2, 2])("uses the database clock to settle external activity despite %s-hour application skew", async (hours) => {
    const { issueId } = await seedLadderCard();
    await db.update(issues).set({ executionPolicy: null, deliveryRequirement: "record_only" }).where(eq(issues.id, issueId));
    await db.insert(activityLog).values({
      companyId, actorType: "user", actorId: "test-board-operator",
      action: "issue.updated", entityType: "issue", entityId: issueId,
    });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + hours * 60 * 60_000 });
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 1, terminalized: 0 });
    await ageActivity(issueId, 10);
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 1, terminalized: 1 });
    expect(await statusOf(issueId)).toBe("done");
  });

  it("defers an unchanged ladder state on later sweep ticks, while the guard still caps repeated direct evaluations", async () => {
    const { issueId, stageId } = await seedLadderCard();

    // First tick evaluates the guard and records the refusal; later ticks
    // see the same ladder-state key and defer without scanning the card.
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 1, terminalized: 0 });
    for (let tick = 0; tick < 9; tick++) {
      expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 0, terminalized: 0 });
    }

    expect(await statusOf(issueId)).toBe("in_progress");
    expect(await rows(issueId, REFUSED)).toHaveLength(1);
    expect(await rows(issueId, REPEATED)).toHaveLength(0);

    // The SUP-24136 bound still applies to evaluations that do reach the
    // guard (for example the PATCH door): three refusal rows per window,
    // then one escalation row, then nothing.
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    for (let call = 0; call < 5; call++) {
      const verdict = await evaluateDoneTransitionGuardForBackstopClose({
        db,
        issue: issue!,
        actorId: "system:execution-control-reconciliation",
        closeComment: null,
      });
      expect(verdict.allowed).toBe(false);
    }
    expect(await rows(issueId, REFUSED)).toHaveLength(3);
    const escalations = await rows(issueId, REPEATED);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      actorType: "system",
      actorId: "system:execution-control-reconciliation",
      runId: null,
      details: expect.objectContaining({
        reason: `review_ladder_unsatisfied:${stageId}`,
        refusalCount: 4,
        repeatLimit: 3,
        windowSeconds: 3600,
        unsatisfiedStageIds: [stageId],
        decisionCarried: false,
      }),
    });
  });

  it("does not strand the card: an approval right after a capped tick closes it on the first tick past the settle window", async () => {
    const { issueId, stageId } = await seedLadderCard();
    for (let tick = 0; tick < 6; tick++) {
      await reapStrandedSummaryGenerationIssues(db);
    }
    await drainAuditWrites();

    // The review approval commits right after the last refused tick.
    await db
      .update(issues)
      .set({
        executionState: {
          status: "completed",
          currentStageId: null,
          currentStageIndex: null,
          currentStageType: null,
          currentParticipant: null,
          returnAssignee: { type: "agent", agentId: SUMMARIZER_AGENT_ID, userId: null },
          completedStageIds: [stageId],
          skippedStageIds: [],
          lastDecisionId: randomUUID(),
          lastDecisionOutcome: "approved",
          changesRequestedCount: 0,
        },
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issueId));
    const refusedBefore = (await rows(issueId, REFUSED)).length;

    // Next tick: the guard allows, the settle window (fresh approval) defers.
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 1, terminalized: 0 });
    expect(await rows(issueId, REFUSED)).toHaveLength(refusedBefore);

    // Once the settle window has passed, the next tick closes the card. The
    // capped audit rows play no part in the close decision.
    await db
      .update(issues)
      .set({ updatedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(issues.id, issueId));
    await ageActivity(issueId, 10);
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 1, terminalized: 1 });
    expect(await statusOf(issueId)).toBe("done");
    expect(await rows(issueId, REFUSED)).toHaveLength(refusedBefore);
  });

  it("defers on ladder state, not on either clock: an application clock two hours ahead does not re-arm the card", async () => {
    const { issueId } = await seedLadderCard();
    for (let tick = 0; tick < 3; tick++) {
      await reapStrandedSummaryGenerationIssues(db);
    }
    expect(await rows(issueId, REFUSED)).toHaveLength(1);

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60 * 60_000 });
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 0, terminalized: 0 });
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 0, terminalized: 0 });

    expect(await rows(issueId, REFUSED)).toHaveLength(1);
    expect(await rows(issueId, REPEATED)).toHaveLength(0);
  });

  it("does not re-arm when refusal rows age past the window: only a ladder-state change re-arms", async () => {
    const { issueId } = await seedLadderCard();
    for (let tick = 0; tick < 5; tick++) {
      await reapStrandedSummaryGenerationIssues(db);
    }
    expect(await rows(issueId, REFUSED)).toHaveLength(1);
    await ageActivity(issueId, 61);

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - 2 * 60 * 60_000 });
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 0, terminalized: 0 });

    expect(await rows(issueId, REFUSED)).toHaveLength(1);
    expect(await rows(issueId, REPEATED)).toHaveLength(0);
  });

  it("records the first refusal row unchanged and counts each card separately", async () => {
    const first = await seedLadderCard();
    for (let tick = 0; tick < 5; tick++) {
      await reapStrandedSummaryGenerationIssues(db);
    }
    const second = await seedLadderCard();
    await reapStrandedSummaryGenerationIssues(db);
    await drainAuditWrites();

    const secondRows = await rows(second.issueId, REFUSED);
    expect(secondRows).toHaveLength(1);
    expect(secondRows[0]).toMatchObject({
      companyId,
      actorType: "system",
      actorId: "done-transition-guard",
      agentId: null,
      runId: null,
      entityType: "issue",
      details: {
        identifier: null,
        callingActor: "system:execution-control-reconciliation",
        callingRunId: null,
        reason: `review_ladder_unsatisfied:${second.stageId}`,
        skipReason: `review_ladder_unsatisfied:${second.stageId}`,
        stageIndex: 0,
        stageType: "review",
        unsatisfiedStageIds: [second.stageId],
        completedStageIds: [],
        skippedStageIds: [],
        ladderStateKey: JSON.stringify({
          totalStages: 1,
          firstUnsatisfiedIndex: 0,
          firstUnsatisfiedStage: { id: second.stageId, type: "review" },
          stages: [second.stageId],
          completedStageIds: [],
          skippedStageIds: [],
          unsatisfiedStageIds: [second.stageId],
        }),
        decisionCarried: false,
      },
    });
    expect(await rows(second.issueId, REPEATED)).toHaveLength(0);
  });
});
