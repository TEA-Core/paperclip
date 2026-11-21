import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  reapStrandedSummaryGenerationIssues,
  SUMMARIZER_AGENT_ID,
} from "./execution-control-reconciliation.js";
import { evaluateDoneTransitionGuardForBackstopClose } from "./done-transition-guard.js";

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
