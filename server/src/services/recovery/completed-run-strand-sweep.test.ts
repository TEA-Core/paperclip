import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { decideHostRestartStrandRepair } from "./host-restart-strand-sweep.js";
import {
  buildCompletedRunEscalationGateSelect,
  buildCompletedRunStrandEscalationComment,
  completedRunIdleAnchor,
  decideCompletedRunStrandEscalation,
  isCompletedRunStrandIssueShape,
  planCompletedRunStrandEscalations,
  sweepCompletedRunStrandedIssues,
  type CompletedRunStrandCandidate,
  type CompletedRunStrandFacts,
  type CompletedRunStrandLatestRun,
} from "./completed-run-strand-sweep.js";
import { decideSuccessfulRunHandoff, isSuccessfulRunHandoffValidPathSkip } from "./successful-run-handoff.js";

const NOW = new Date("2026-09-15T12:00:00.000Z");
// Matches the sweep's DEFAULT_SWEEP_IDLE_THRESHOLD_MS.
const IDLE_THRESHOLD_MS = 30 * 60 * 1000;

function makeCandidate(overrides: Partial<CompletedRunStrandCandidate> = {}): CompletedRunStrandCandidate {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "PAP-1",
    status: "in_progress",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    ...overrides,
  };
}

// A successful run that finished 2h before NOW -> well past the idle threshold.
function makeLatestRun(overrides: Partial<CompletedRunStrandLatestRun> = {}): CompletedRunStrandLatestRun {
  const finishedAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
  return {
    id: "run-1",
    agentId: "agent-1",
    status: "succeeded",
    errorCode: null,
    finishedAt,
    updatedAt: finishedAt,
    createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000 - 1000),
    ...overrides,
  };
}

function factsFor(overrides: Partial<CompletedRunStrandFacts> = {}): CompletedRunStrandFacts {
  return { hasLiveRun: false, latestRun: makeLatestRun(), alreadyEscalated: false, ...overrides };
}

function decide(overrides: Partial<Parameters<typeof decideCompletedRunStrandEscalation>[0]> = {}) {
  return decideCompletedRunStrandEscalation({
    status: "in_progress",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    hasLiveRun: false,
    alreadyEscalated: false,
    latestRun: makeLatestRun(),
    now: NOW,
    idleThresholdMs: IDLE_THRESHOLD_MS,
    ...overrides,
  });
}

describe("isCompletedRunStrandIssueShape", () => {
  it("mirrors the in_progress agent-assigned shape", () => {
    expect(isCompletedRunStrandIssueShape({ status: "in_progress", assigneeAgentId: "a", assigneeUserId: null })).toBe(true);
    expect(isCompletedRunStrandIssueShape({ status: "in_review", assigneeAgentId: "a", assigneeUserId: null })).toBe(false);
    expect(isCompletedRunStrandIssueShape({ status: "done", assigneeAgentId: "a", assigneeUserId: null })).toBe(false);
    expect(isCompletedRunStrandIssueShape({ status: "in_progress", assigneeAgentId: null, assigneeUserId: null })).toBe(false);
    expect(isCompletedRunStrandIssueShape({ status: "in_progress", assigneeAgentId: "a", assigneeUserId: "u" })).toBe(false);
  });
});

describe("completedRunIdleAnchor", () => {
  it("prefers finishedAt, then updatedAt, then createdAt", () => {
    const finished = new Date("2026-09-15T10:00:00.000Z");
    const updated = new Date("2026-09-15T09:00:00.000Z");
    const created = new Date("2026-09-15T08:00:00.000Z");
    expect(
      completedRunIdleAnchor({ ...makeLatestRun(), finishedAt: finished, updatedAt: updated, createdAt: created }),
    ).toBe(finished);
    expect(
      completedRunIdleAnchor({ ...makeLatestRun(), finishedAt: null, updatedAt: updated, createdAt: created }),
    ).toBe(updated);
    expect(
      completedRunIdleAnchor({ ...makeLatestRun(), finishedAt: null, updatedAt: null, createdAt: created }),
    ).toBe(created);
  });
});

describe("decideCompletedRunStrandEscalation", () => {
  it("escalates an idle in_progress agent card whose latest run succeeded", () => {
    expect(decide({})).toEqual({ action: "escalate" });
  });

  it("also treats an `interrupted` run as out of scope (not a success-path completion)", () => {
    expect(decide({ latestRun: makeLatestRun({ status: "interrupted" }) })).toEqual({
      action: "skip-run-not-completed",
    });
  });

  it("skips a card that is no longer in_progress (blocked)", () => {
    expect(decide({ status: "blocked" })).toEqual({ action: "skip-not-scope" });
  });

  it("skips a card that is no longer in_progress (in_review)", () => {
    expect(decide({ status: "in_review" })).toEqual({ action: "skip-not-scope" });
  });

  it("skips a card that is no longer in_progress (done)", () => {
    expect(decide({ status: "done" })).toEqual({ action: "skip-not-scope" });
  });

  it("skips a user-assigned card", () => {
    expect(decide({ assigneeAgentId: null, assigneeUserId: "user-1" })).toEqual({ action: "skip-not-scope" });
  });

  it("skips a card with no agent assignee", () => {
    expect(decide({ assigneeAgentId: null })).toEqual({ action: "skip-not-scope" });
  });

  it("skips a card that still has a live run", () => {
    expect(decide({ hasLiveRun: true })).toEqual({ action: "skip-live" });
  });

  it("skips a card whose latest run is still running", () => {
    expect(decide({ latestRun: makeLatestRun({ status: "running" }) })).toEqual({ action: "skip-run-not-completed" });
  });

  it("skips a card whose latest run failed (host-restart domain)", () => {
    expect(decide({ latestRun: makeLatestRun({ status: "failed" }) })).toEqual({ action: "skip-run-not-completed" });
  });

  it("skips a card whose latest run was cancelled", () => {
    expect(decide({ latestRun: makeLatestRun({ status: "cancelled" }) })).toEqual({ action: "skip-run-not-completed" });
  });

  it("skips a card whose latest run was timed out", () => {
    expect(decide({ latestRun: makeLatestRun({ status: "timed_out" }) })).toEqual({ action: "skip-run-not-completed" });
  });

  it("skips a card with no runs at all", () => {
    expect(decide({ latestRun: null })).toEqual({ action: "skip-run-not-completed" });
  });

  it("is idempotent: an already-posted notice suppresses a second escalation", () => {
    expect(decide({ alreadyEscalated: true })).toEqual({ action: "skip-already-escalated" });
  });

  it("skips a card whose run completed within the idle threshold", () => {
    expect(
      decide({ latestRun: makeLatestRun({ finishedAt: new Date(NOW.getTime() - 5 * 60 * 1000) }) }),
    ).toEqual({ action: "skip-within-threshold" });
  });
});

function makeEscalateMock() {
  return vi.fn(
    async (
      _db: Db,
      _candidate: CompletedRunStrandCandidate,
      _escalation: { sourceRun: CompletedRunStrandLatestRun },
    ): Promise<boolean> => true,
  );
}

describe("planCompletedRunStrandEscalations", () => {
  it("fires the right branch per candidate", () => {
    const candidates = [
      makeCandidate({ id: "escalate" }),
      makeCandidate({ id: "live" }),
      makeCandidate({ id: "user", assigneeAgentId: null, assigneeUserId: "user-1" }),
    ];
    const facts = new Map<string, CompletedRunStrandFacts>([
      ["escalate", factsFor()],
      ["live", factsFor({ hasLiveRun: true })],
      ["user", factsFor()],
    ]);
    const plan = planCompletedRunStrandEscalations({
      candidates,
      facts,
      now: NOW,
      idleThresholdMs: IDLE_THRESHOLD_MS,
      cap: 10,
    });
    expect(plan.escalations.map((e) => e.issueId)).toEqual(["escalate"]);
    expect(plan.skipped.liveRun).toEqual(["live"]);
    expect(plan.skipped.notScope).toEqual(["user"]);
  });

  it("enforces the cap and defers the rest", () => {
    const candidates = [makeCandidate({ id: "a" }), makeCandidate({ id: "b" })];
    const facts = new Map<string, CompletedRunStrandFacts>([["a", factsFor()], ["b", factsFor()]]);
    const plan = planCompletedRunStrandEscalations({
      candidates,
      facts,
      now: NOW,
      idleThresholdMs: IDLE_THRESHOLD_MS,
      cap: 1,
    });
    expect(plan.escalations.map((e) => e.issueId)).toEqual(["a"]);
    expect(plan.skipped.capExceeded).toEqual(["b"]);
  });

  it("skips an already-escalated card without emitting an escalation", () => {
    const candidates = [makeCandidate({ id: "a" })];
    const facts = new Map<string, CompletedRunStrandFacts>([["a", factsFor({ alreadyEscalated: true })]]);
    const plan = planCompletedRunStrandEscalations({
      candidates,
      facts,
      now: NOW,
      idleThresholdMs: IDLE_THRESHOLD_MS,
      cap: 10,
    });
    expect(plan.escalations).toEqual([]);
    expect(plan.skipped.alreadyEscalated).toEqual(["a"]);
  });
});

describe("buildCompletedRunStrandEscalationComment", () => {
  it("keys the notice to the source run and marks the recovery cause", () => {
    const comment = buildCompletedRunStrandEscalationComment({
      identifier: "PAP-1",
      sourceRun: { id: "run-1", agentId: "agent-1", status: "succeeded", errorCode: null },
    });
    expect(comment.metadata.sourceRunId).toBe("run-1");
    expect(comment.recoveryActionId).toContain("run-1");
    expect(comment.recoveryActionId).toContain("completed-run-strand-sweep");
    expect(comment.body).toContain("in_progress");
    expect(comment.presentation.tone).toBe("warning");
    expect(comment.presentation.title).toBe("Completed run left card stranded");
  });
});

describe("real incidents SUP-16239 and SUP-16394 (2026-09-15)", () => {
  // Both cards: agent-assigned, in_progress, no marker, no scheduled monitor,
  // the assigned agent's most recent run finished on the success path
  // (DB `succeeded`, shown by the API as `completed`) without a terminal
  // disposition, idle far beyond the 30m threshold. Exactly the shape the
  // host-restart sweep returns `skip-no-marker` for.
  const cases = [
    { identifier: "SUP-16239", agentStopped: "2026-09-15T13:08:03.000Z", detected: "2026-09-15T15:54:00.000Z" },
    { identifier: "SUP-16394", agentStopped: "2026-09-15T13:59:16.000Z", detected: "2026-09-15T15:52:00.000Z" },
  ];

  for (const incident of cases) {
    it(`reports ${incident.identifier}: ${new Date(incident.agentStopped).toISOString()} run, in_progress, idle > threshold`, () => {
      const run: CompletedRunStrandLatestRun = {
        id: `run-${incident.identifier}`,
        agentId: "agent-incident",
        status: "succeeded",
        errorCode: null,
        finishedAt: new Date(incident.agentStopped),
        updatedAt: new Date(incident.agentStopped),
        createdAt: new Date(incident.agentStopped),
      };
      const facts = { hasLiveRun: false, latestRun: run, alreadyEscalated: false };
      const decision = decideCompletedRunStrandEscalation({
        status: "in_progress",
        assigneeAgentId: "agent-incident",
        assigneeUserId: null,
        ...facts,
        now: new Date(incident.detected),
        idleThresholdMs: IDLE_THRESHOLD_MS,
      });
      expect(decision).toEqual({ action: "escalate" });

      // The same facts are what the host-restart sweep returns
      // `skip-no-marker` for (a non-failed run carries no host-restart
      // marker), i.e. the class no failure-keyed sweep covers.
      expect(
        decideHostRestartStrandRepair({
          status: "in_progress",
          assigneeAgentId: "agent-incident",
          assigneeUserId: null,
          executionState: null,
          monitorAttemptCount: null,
          ...facts,
          latestRun: { ...run, resultJson: null },
          now: new Date(incident.detected),
        }),
      ).toEqual({ action: "skip-no-marker" });
    });
  }
});

interface FakeDbState {
  candidates: CompletedRunStrandCandidate[];
  // One entry per live-run SELECT, consumed in call order: collection hasLiveRun
  // for each candidate first, then the pre-write hasLiveRun for each escalation.
  // Entries past the end fall back to "no live run".
  liveRunQueue: Array<Array<{ id: string }>>;
  latestRunRows?: Array<CompletedRunStrandLatestRun>;
  escalationRows?: Array<{ id: string }>;
  // Count of UPDATE statements issued; the sweep must never write the issue row
  // (no status patch, no block, no reassign) — only a system comment.
  updates: number;
}

function makeFakeDb(state: FakeDbState): Db {
  function select() {
    let table: unknown;
    let hasOrderBy = false;
    let limitN = Number.POSITIVE_INFINITY;
    const chain = {
      from(t: unknown) {
        table = t;
        return chain;
      },
      where() {
        return chain;
      },
      orderBy() {
        hasOrderBy = true;
        return chain;
      },
      limit(n: number) {
        limitN = n;
        return chain;
      },
      for() {
        return chain;
      },
      then(resolve: (value: unknown) => unknown) {
        let rows: unknown[] = [];
        if (table === issues) {
          rows = state.candidates;
        } else if (table === heartbeatRuns) {
          rows = hasOrderBy
            ? (state.latestRunRows ?? [])
            : state.liveRunQueue.length > 0
              ? (state.liveRunQueue.shift() ?? [])
              : [];
        } else if (table === issueComments) {
          rows = state.escalationRows ?? [];
        }
        return Promise.resolve(rows.slice(0, limitN)).then(resolve);
      },
    };
    return chain;
  }

  function update() {
    const chain = {
      set() {
        state.updates += 1;
        return chain;
      },
      where() {
        return chain;
      },
      returning() {
        return Promise.resolve([]);
      },
    };
    return chain;
  }

  return { select, update } as unknown as Db;
}

describe("sweepCompletedRunStrandedIssues", () => {
  it("escalates a matching card exactly once and never writes the issue row", async () => {
    const state: FakeDbState = {
      candidates: [makeCandidate({ id: "issue-1" })],
      liveRunQueue: [[], []], // collection + pre-write, no live run
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
      updates: 0,
    };
    const escalateIssue = vi.fn(async () => {
      state.escalationRows = [{ id: "comment-1" }]; // the durable system notice
      return true;
    });

    const report = await sweepCompletedRunStrandedIssues({
      db: makeFakeDb(state),
      now: NOW,
      idleThresholdMs: IDLE_THRESHOLD_MS,
      escalateIssue,
    });

    expect(report.escalated).toEqual(["issue-1"]);
    expect(report.considered).toBe(1);
    expect(escalateIssue).toHaveBeenCalledTimes(1);
    expect(state.updates).toBe(0);
  });

  it("does not escalate a card that still has a live run", async () => {
    const state: FakeDbState = {
      candidates: [makeCandidate({ id: "issue-live" })],
      liveRunQueue: [[{ id: "live-run" }]],
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
      updates: 0,
    };
    const escalateIssue = makeEscalateMock();

    const report = await sweepCompletedRunStrandedIssues({
      db: makeFakeDb(state),
      now: NOW,
      idleThresholdMs: IDLE_THRESHOLD_MS,
      escalateIssue,
    });

    expect(report.escalated).toEqual([]);
    expect(report.skipped.liveRun).toEqual(["issue-live"]);
    expect(escalateIssue).not.toHaveBeenCalled();
  });

  it("does not escalate a card whose latest run failed (host-restart domain)", async () => {
    const state: FakeDbState = {
      candidates: [makeCandidate({ id: "issue-failed" })],
      liveRunQueue: [[]],
      latestRunRows: [makeLatestRun({ status: "failed" })],
      escalationRows: [],
      updates: 0,
    };
    const escalateIssue = makeEscalateMock();

    const report = await sweepCompletedRunStrandedIssues({
      db: makeFakeDb(state),
      now: NOW,
      idleThresholdMs: IDLE_THRESHOLD_MS,
      escalateIssue,
    });

    expect(report.escalated).toEqual([]);
    expect(report.skipped.runNotCompleted).toEqual(["issue-failed"]);
    expect(escalateIssue).not.toHaveBeenCalled();
  });

  it("does not escalate a card whose run completed within the idle threshold", async () => {
    const state: FakeDbState = {
      candidates: [makeCandidate({ id: "issue-recent" })],
      liveRunQueue: [[]],
      latestRunRows: [makeLatestRun({ finishedAt: new Date(NOW.getTime() - 5 * 60 * 1000) })],
      escalationRows: [],
      updates: 0,
    };
    const escalateIssue = makeEscalateMock();

    const report = await sweepCompletedRunStrandedIssues({
      db: makeFakeDb(state),
      now: NOW,
      idleThresholdMs: IDLE_THRESHOLD_MS,
      escalateIssue,
    });

    expect(report.escalated).toEqual([]);
    expect(report.skipped.withinThreshold).toEqual(["issue-recent"]);
    expect(escalateIssue).not.toHaveBeenCalled();
  });

  it("is idempotent: a second invocation does not double-escalate", async () => {
    const state: FakeDbState = {
      candidates: [makeCandidate({ id: "issue-1" })],
      liveRunQueue: [[], [], []],
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
      updates: 0,
    };
    const escalateIssue = vi.fn(async () => {
      state.escalationRows = [{ id: "comment-1" }];
      return true;
    });
    const db = makeFakeDb(state);

    const first = await sweepCompletedRunStrandedIssues({
      db,
      now: NOW,
      idleThresholdMs: IDLE_THRESHOLD_MS,
      escalateIssue,
    });
    const second = await sweepCompletedRunStrandedIssues({
      db,
      now: NOW,
      idleThresholdMs: IDLE_THRESHOLD_MS,
      escalateIssue,
    });

    expect(first.escalated).toEqual(["issue-1"]);
    expect(second.escalated).toEqual([]);
    expect(second.skipped.alreadyEscalated).toEqual(["issue-1"]);
    expect(escalateIssue).toHaveBeenCalledTimes(1);
    expect(state.updates).toBe(0);
  });

  it("does not escalate a card that gains a live run just before the write", async () => {
    const state: FakeDbState = {
      candidates: [makeCandidate({ id: "issue-race" })],
      liveRunQueue: [[], [{ id: "live" }]], // collection: none; pre-write: live
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
      updates: 0,
    };
    const escalateIssue = makeEscalateMock();

    const report = await sweepCompletedRunStrandedIssues({
      db: makeFakeDb(state),
      now: NOW,
      idleThresholdMs: IDLE_THRESHOLD_MS,
      escalateIssue,
    });

    expect(report.escalated).toEqual([]);
    expect(escalateIssue).not.toHaveBeenCalled();
  });

  it("respects the escalation cap", async () => {
    const state: FakeDbState = {
      candidates: [makeCandidate({ id: "a" }), makeCandidate({ id: "b" })],
      liveRunQueue: [[], [], []], // a: collection; b: collection; a: pre-write
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
      updates: 0,
    };
    const escalateIssue = makeEscalateMock();

    const report = await sweepCompletedRunStrandedIssues({
      db: makeFakeDb(state),
      now: NOW,
      idleThresholdMs: IDLE_THRESHOLD_MS,
      cap: 1,
      escalateIssue,
    });

    expect(report.escalated).toEqual(["a"]);
    expect(report.skipped.capExceeded).toEqual(["b"]);
    expect(escalateIssue).toHaveBeenCalledTimes(1);
  });
});

describe("real SQL shape (Postgres-acceptable guards)", () => {
  it("compiles the escalation gate with the in_progress shape, alias-free no-live-run guard, and a row lock", () => {
    const db = createDb("postgres://user:pass@127.0.0.1:59999/probe");
    const compiled = buildCompletedRunEscalationGateSelect(db, "company-1", "issue-1").toSQL();
    // Regression guard: the subquery must NOT alias heartbeat_runs while the
    // correlated columns stay fully qualified, or Postgres rejects the whole
    // statement with `missing FROM-clause entry for table "heartbeat_runs"`.
    expect(compiled.sql).not.toContain("live_run");
    expect(compiled.sql).toContain('"heartbeat_runs"."company_id"');
    expect(compiled.sql).toContain('"heartbeat_runs"."context_snapshot"');
    expect(compiled.sql).toContain("->> 'issueId'");
    expect(compiled.sql.toLowerCase()).toContain("not exists");
    // Re-validates the target shape so a card that flipped between scan and
    // write is not escalated.
    expect(compiled.sql).toContain('"issues"."status" = $');
    expect(compiled.sql.toLowerCase()).toContain("for update");
  });
});

// Fold 2c: upstream's chat channels (not on the fork base) keep a conversation
// card `in_progress` between turns. The fold's own successful-run handoff treats
// a correlated chat wake as a valid path ("chat conversation already owns the
// next action"), so this sweep must not call that card stranded either.
describe("chat conversation ownership (fold 2c)", () => {
  const CHAT_COMMENT_ID = "11111111-1111-4111-8111-111111111111";
  const chatContext = {
    issueId: "issue-chat",
    source: "chat:slack",
    wakeCommentId: CHAT_COMMENT_ID,
    wakeCommentIds: [CHAT_COMMENT_ID],
  };

  it("skips escalation when the chat conversation owns the next action", () => {
    expect(decide({ chatConversationOwnsNextAction: true } as never)).toEqual({ action: "skip-chat-conversation" });
    expect(decide({ chatConversationOwnsNextAction: false } as never)).toEqual({ action: "escalate" });
  });

  it("does not escalate an idle chat_channel card whose latest run was a correlated chat wake", async () => {
    const state: FakeDbState = {
      candidates: [makeCandidate({ id: "issue-chat", originKind: "chat_channel" } as never)],
      liveRunQueue: [[], []],
      latestRunRows: [makeLatestRun({ contextSnapshot: chatContext } as never)],
      escalationRows: [],
      updates: 0,
    };
    const escalateIssue = vi.fn(async () => true);
    const report = await sweepCompletedRunStrandedIssues({
      db: makeFakeDb(state),
      now: NOW,
      idleThresholdMs: IDLE_THRESHOLD_MS,
      escalateIssue,
    });
    expect(report.escalated).toEqual([]);
    expect(escalateIssue).not.toHaveBeenCalled();
    expect((report.skipped as unknown as Record<string, string[]>).chatConversation).toEqual(["issue-chat"]);
  });

  it("agrees with the fold's successful-run handoff decision on the same run", async () => {
    const cases = [
      { name: "correlated chat wake on a chat card", originKind: "chat_channel", context: chatContext },
      { name: "chat wake context on a non-chat card", originKind: null, context: chatContext },
      { name: "chat card without a wake comment", originKind: "chat_channel", context: { issueId: "issue-chat", source: "chat:slack" } },
    ];
    for (const entry of cases) {
      const handoff = decideSuccessfulRunHandoff({
        run: { id: "run-1", companyId: "company-1", agentId: "agent-1", status: "succeeded", contextSnapshot: entry.context } as never,
        issue: {
          id: "issue-chat", companyId: "company-1", identifier: "PAP-9", title: "Chat", description: null,
          status: "in_progress", assigneeAgentId: "agent-1", assigneeUserId: null, executionState: null, originKind: entry.originKind,
        } as never,
        agent: { id: "agent-1", companyId: "company-1", status: "idle" } as never,
        livenessState: "advanced",
        detectedProgressSummary: "replied",
        hasProgressEvidence: true,
        paperclipToolCallCount: null,
        finalReport: "replied",
        nextAction: null,
        taskKey: "issue-chat",
        hasActiveExecutionPath: false,
        hasQueuedWake: false,
        hasPendingInteractionOrApproval: false,
        hasPersistedMonitor: false,
        hasExplicitBlockerPath: false,
        hasOpenRecoveryIssue: false,
        hasPauseHold: false,
        hasActiveRoutineContinuation: false,
        budgetBlocked: false,
        idempotentWakeExists: false,
      });
      const state: FakeDbState = {
        candidates: [makeCandidate({ id: "issue-chat", originKind: entry.originKind } as never)],
        liveRunQueue: [[], []],
        latestRunRows: [makeLatestRun({ contextSnapshot: entry.context } as never)],
        escalationRows: [],
        updates: 0,
      };
      const report = await sweepCompletedRunStrandedIssues({
        db: makeFakeDb(state),
        now: NOW,
        idleThresholdMs: IDLE_THRESHOLD_MS,
        escalateIssue: vi.fn(async () => true),
      });
      const foldTreatsAsOwned = isSuccessfulRunHandoffValidPathSkip(handoff) &&
        handoff.reason === "chat conversation already owns the next action";
      expect({ case: entry.name, sweepEscalated: report.escalated.length > 0 })
        .toEqual({ case: entry.name, sweepEscalated: !foldTreatsAsOwned });
    }
  });
});
