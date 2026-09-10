import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import {
  buildHostRestartStrandEscalationComment,
  buildRearmMonitorPatch,
  decideHostRestartStrandRepair,
  isMonitorableIssueShape,
  planHostRestartStrandRepairs,
  sweepHostRestartStrandedIssues,
  type HostRestartStrandCandidate,
  type HostRestartStrandFacts,
  type HostRestartStrandLatestRun,
  type HostRestartStrandSourceRun,
} from "./host-restart-strand-sweep.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");

function hostRestartResult(): Record<string, unknown> {
  return {
    hostRestart: {
      detected: true,
      runBootId: "boot-old",
      currentBootId: "boot-new",
      detectedAt: "2026-09-10T00:00:00.000Z",
    },
  };
}

function executionStateWithMonitor(monitorOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "idle",
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: {
      status: "triggered",
      nextCheckAt: null,
      lastTriggeredAt: "2026-09-09T00:00:00.000Z",
      attemptCount: 1,
      notes: null,
      scheduledBy: "assignee",
      maxAttempts: 5,
      timeoutAt: null,
      clearedAt: null,
      clearReason: null,
      ...monitorOverrides,
    },
  };
}

function makeCandidate(overrides: Partial<HostRestartStrandCandidate> = {}): HostRestartStrandCandidate {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "PAP-1",
    status: "in_progress",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    executionState: executionStateWithMonitor(),
    monitorAttemptCount: 1,
    monitorNextCheckAt: null,
    monitorWakeRequestedAt: null,
    ...overrides,
  };
}

function makeLatestRun(overrides: Partial<HostRestartStrandLatestRun> = {}): HostRestartStrandLatestRun {
  return {
    id: "run-1",
    agentId: "agent-1",
    status: "failed",
    errorCode: null,
    resultJson: hostRestartResult(),
    ...overrides,
  };
}

function decide(overrides: Partial<Parameters<typeof decideHostRestartStrandRepair>[0]> = {}) {
  return decideHostRestartStrandRepair({
    status: "in_progress",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    executionState: executionStateWithMonitor(),
    monitorAttemptCount: 1,
    hasLiveRun: false,
    alreadyEscalated: false,
    latestRun: makeLatestRun(),
    now: NOW,
    ...overrides,
  });
}

describe("host-restart strand repair decision", () => {
  it("re-arms a monitorable card whose monitor policy is still live", () => {
    expect(decide()).toEqual({ action: "rearm" });
  });

  it("escalates an exhausted monitor instead of re-arming", () => {
    const decision = decide({
      executionState: executionStateWithMonitor({ attemptCount: 5, maxAttempts: 5 }),
      monitorAttemptCount: 5,
    });
    expect(decision).toEqual({ action: "escalate", reason: "exhausted" });
  });

  it("escalates a monitor whose timeout has already passed", () => {
    const decision = decide({
      executionState: executionStateWithMonitor({ timeoutAt: "2026-09-10T11:00:00.000Z" }),
    });
    expect(decision).toEqual({ action: "escalate", reason: "exhausted" });
  });

  it("escalates a card that was never armed with a monitor", () => {
    const decision = decide({ executionState: null });
    expect(decision).toEqual({ action: "escalate", reason: "never-armed" });
  });

  it("escalates a card that is not monitorable (user assignee)", () => {
    const decision = decide({ assigneeAgentId: null, assigneeUserId: "user-1" });
    expect(decision).toEqual({ action: "escalate", reason: "not-monitorable" });
  });

  it("never touches a card that still has a live run", () => {
    expect(decide({ hasLiveRun: true })).toEqual({ action: "skip-live" });
  });

  it("never touches a card whose latest run did not fail", () => {
    expect(decide({ latestRun: makeLatestRun({ status: "succeeded" }) })).toEqual({ action: "skip-no-marker" });
  });

  it("never touches a failed run that carries no host-restart marker", () => {
    expect(decide({ latestRun: makeLatestRun({ resultJson: {} }) })).toEqual({ action: "skip-no-marker" });
  });

  it("never touches a card with no runs at all", () => {
    expect(decide({ latestRun: null })).toEqual({ action: "skip-no-marker" });
  });

  it("is idempotent: an already-posted notice suppresses a second repair", () => {
    expect(decide({ alreadyEscalated: true })).toEqual({ action: "skip-already-escalated" });
  });
});

describe("re-arm patch", () => {
  it("points the monitor at now and clears the pending wake so the scheduler dispatches it", () => {
    const patch = buildRearmMonitorPatch(NOW);
    expect(patch.monitorNextCheckAt).toBe(NOW);
    expect(patch.monitorWakeRequestedAt).toBeNull();
    expect(patch.monitorNextCheckAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
  });
});

describe("isMonitorableIssueShape", () => {
  it("mirrors issueAllowsMonitor", () => {
    expect(isMonitorableIssueShape({ status: "in_progress", assigneeAgentId: "a", assigneeUserId: null })).toBe(true);
    expect(isMonitorableIssueShape({ status: "in_review", assigneeAgentId: "a", assigneeUserId: null })).toBe(true);
    expect(isMonitorableIssueShape({ status: "blocked", assigneeAgentId: "a", assigneeUserId: null })).toBe(true);
    expect(isMonitorableIssueShape({ status: "todo", assigneeAgentId: "a", assigneeUserId: null })).toBe(false);
    expect(isMonitorableIssueShape({ status: "in_progress", assigneeAgentId: null, assigneeUserId: null })).toBe(false);
    expect(isMonitorableIssueShape({ status: "in_progress", assigneeAgentId: "a", assigneeUserId: "u" })).toBe(false);
  });
});

function factsFor(overrides: Partial<HostRestartStrandFacts> = {}): HostRestartStrandFacts {
  return { hasLiveRun: false, latestRun: makeLatestRun(), alreadyEscalated: false, ...overrides };
}

describe("planHostRestartStrandRepairs", () => {
  it("fires the right branch per candidate", () => {
    const candidates = [
      makeCandidate({ id: "rearm" }),
      makeCandidate({ id: "escalate", executionState: executionStateWithMonitor({ maxAttempts: 1 }), monitorAttemptCount: 1 }),
      makeCandidate({ id: "live" }),
    ];
    const facts = new Map<string, HostRestartStrandFacts>([
      ["rearm", factsFor()],
      ["escalate", factsFor()],
      ["live", factsFor({ hasLiveRun: true })],
    ]);
    const plan = planHostRestartStrandRepairs({ candidates, facts, now: NOW, cap: 10 });
    expect(plan.repairs.map((r) => [r.issueId, r.kind])).toEqual([
      ["rearm", "rearm"],
      ["escalate", "escalate"],
    ]);
    expect(plan.skipped.liveRun).toEqual(["live"]);
  });

  it("enforces the per-sweep repair cap and defers the rest", () => {
    const candidates = [makeCandidate({ id: "a" }), makeCandidate({ id: "b" })];
    const facts = new Map<string, HostRestartStrandFacts>([
      ["a", factsFor()],
      ["b", factsFor()],
    ]);
    const plan = planHostRestartStrandRepairs({ candidates, facts, now: NOW, cap: 1 });
    expect(plan.repairs.map((r) => r.issueId)).toEqual(["a"]);
    expect(plan.skipped.capExceeded).toEqual(["b"]);
  });

  it("skips an already-escalated card without emitting a repair", () => {
    const candidates = [makeCandidate({ id: "a" })];
    const facts = new Map<string, HostRestartStrandFacts>([["a", factsFor({ alreadyEscalated: true })]]);
    const plan = planHostRestartStrandRepairs({ candidates, facts, now: NOW, cap: 10 });
    expect(plan.repairs).toEqual([]);
    expect(plan.skipped.alreadyEscalated).toEqual(["a"]);
  });
});

describe("buildHostRestartStrandEscalationComment", () => {
  it("names the reason and boot, and keys the notice to the source run", () => {
    const comment = buildHostRestartStrandEscalationComment({
      identifier: "PAP-1",
      sourceRun: { id: "run-1", agentId: "agent-1", status: "failed", errorCode: null },
      reason: "exhausted",
      bootId: "boot-new",
    });
    expect(comment.body).toContain("host-restart strand sweep: exhausted");
    expect(comment.body).toContain("boot-new");
    expect(comment.metadata.sourceRunId).toBe("run-1");
    expect(comment.recoveryActionId).toContain("run-1");
  });
});

interface FakeDbState {
  candidates: HostRestartStrandCandidate[];
  liveRunRows?: Array<{ id: string }>;
  latestRunRows?: Array<HostRestartStrandLatestRun>;
  escalationRows?: Array<{ id: string }>;
  updateRows?: Array<{ id: string }>;
  lastPatch?: unknown;
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
      then(resolve: (value: unknown) => unknown) {
        let rows: unknown[] = [];
        if (table === issues) rows = state.candidates.filter((candidate) => candidate.monitorNextCheckAt === null);
        else if (table === heartbeatRuns) rows = hasOrderBy ? state.latestRunRows ?? [] : state.liveRunRows ?? [];
        else if (table === issueComments) rows = state.escalationRows ?? [];
        return Promise.resolve(rows.slice(0, limitN)).then(resolve);
      },
    };
    return chain;
  }

  function update() {
    let patch: { monitorNextCheckAt?: unknown } | undefined;
    const chain = {
      set(patchValue: unknown) {
        patch = patchValue as { monitorNextCheckAt?: unknown };
        state.lastPatch = patchValue;
        return chain;
      },
      where() {
        return chain;
      },
      returning() {
        const rows = state.updateRows ?? [];
        const monitorNextCheckAt = patch?.monitorNextCheckAt;
        if (monitorNextCheckAt instanceof Date) {
          state.candidates = state.candidates.map((candidate) =>
            rows.some((row) => row.id === candidate.id)
              ? { ...candidate, monitorNextCheckAt }
              : candidate,
          );
        }
        return Promise.resolve(rows);
      },
    };
    return chain;
  }

  return { select, update } as unknown as Db;
}

function makeEscalateMock() {
  return vi.fn(
    async (
      _db: Db,
      _candidate: HostRestartStrandCandidate,
      _escalation: { reason: "exhausted" | "never-armed" | "not-monitorable"; sourceRun: HostRestartStrandSourceRun },
      _bootId: string | null,
    ): Promise<void> => {},
  );
}

describe("sweepHostRestartStrandedIssues", () => {
  it("re-arms a stranded card and escalates an unrecoverable one", async () => {
    const rearmable = makeCandidate({ id: "issue-rearm" });
    const unrecoverable = makeCandidate({
      id: "issue-escalate",
      executionState: executionStateWithMonitor({ attemptCount: 7, maxAttempts: 7 }),
      monitorAttemptCount: 7,
    });
    const state: FakeDbState = {
      candidates: [rearmable, unrecoverable],
      liveRunRows: [],
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
      updateRows: [{ id: "issue-rearm" }],
    };
    const escalateIssue = makeEscalateMock();

    const report = await sweepHostRestartStrandedIssues({
      db: makeFakeDb(state),
      now: NOW,
      escalateIssue,
    });

    expect(report.reArmed).toEqual(["issue-rearm"]);
    expect(report.escalated).toEqual(["issue-escalate"]);
    expect(state.lastPatch).toMatchObject({ monitorNextCheckAt: NOW, monitorWakeRequestedAt: null });
    expect(escalateIssue).toHaveBeenCalledTimes(1);
    expect(escalateIssue.mock.calls[0]?.[2]).toMatchObject({ reason: "exhausted", sourceRun: { id: "run-1" } });
  });

  it("does not touch a card that still has a live run", async () => {
    const state: FakeDbState = {
      candidates: [makeCandidate({ id: "issue-live" })],
      liveRunRows: [{ id: "live-run" }],
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
    };
    const escalateIssue = makeEscalateMock();

    const report = await sweepHostRestartStrandedIssues({
      db: makeFakeDb(state),
      now: NOW,
      escalateIssue,
    });

    expect(report.reArmed).toEqual([]);
    expect(report.escalated).toEqual([]);
    expect(report.skipped.liveRun).toEqual(["issue-live"]);
    expect(escalateIssue).not.toHaveBeenCalled();
  });

  it("is idempotent: an already-escalated card is skipped on a subsequent sweep", async () => {
    const state: FakeDbState = {
      candidates: [makeCandidate({ id: "issue-1" })],
      liveRunRows: [],
      latestRunRows: [makeLatestRun()],
      escalationRows: [{ id: "comment-1" }],
    };
    const escalateIssue = makeEscalateMock();

    const report = await sweepHostRestartStrandedIssues({
      db: makeFakeDb(state),
      now: NOW,
      escalateIssue,
    });

    expect(report.reArmed).toEqual([]);
    expect(report.escalated).toEqual([]);
    expect(report.skipped.alreadyEscalated).toEqual(["issue-1"]);
    expect(escalateIssue).not.toHaveBeenCalled();
  });

  it("respects the repair cap", async () => {
    const state: FakeDbState = {
      candidates: [makeCandidate({ id: "a" }), makeCandidate({ id: "b" })],
      liveRunRows: [],
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
      updateRows: [{ id: "a" }],
    };
    const escalateIssue = makeEscalateMock();

    const report = await sweepHostRestartStrandedIssues({
      db: makeFakeDb(state),
      now: NOW,
      cap: 1,
      escalateIssue,
    });

    expect(report.reArmed).toEqual(["a"]);
    expect(report.skipped.capExceeded).toEqual(["b"]);
  });

  it("is idempotent across two invocations for the same boot (re-arm)", async () => {
    const state: FakeDbState = {
      candidates: [makeCandidate({ id: "issue-rearm" })],
      liveRunRows: [],
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
      updateRows: [{ id: "issue-rearm" }],
    };
    const db = makeFakeDb(state);

    const first = await sweepHostRestartStrandedIssues({ db, now: NOW });
    const second = await sweepHostRestartStrandedIssues({ db, now: NOW });

    expect(first.reArmed).toEqual(["issue-rearm"]);
    expect(second.reArmed).toEqual([]);
    expect(second.escalated).toEqual([]);
    expect(second.considered).toBe(0);
  });

  it("is idempotent across two invocations for the same boot (escalation)", async () => {
    const state: FakeDbState = {
      candidates: [
        makeCandidate({
          id: "issue-escalate",
          executionState: executionStateWithMonitor({ attemptCount: 5, maxAttempts: 5 }),
          monitorAttemptCount: 5,
        }),
      ],
      liveRunRows: [],
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
    };
    const escalateIssue = vi.fn(async () => {
      state.escalationRows = [{ id: "comment-1" }];
    });
    const db = makeFakeDb(state);

    const first = await sweepHostRestartStrandedIssues({ db, now: NOW, escalateIssue });
    const second = await sweepHostRestartStrandedIssues({ db, now: NOW, escalateIssue });

    expect(first.escalated).toEqual(["issue-escalate"]);
    expect(second.escalated).toEqual([]);
    expect(second.skipped.alreadyEscalated).toEqual(["issue-escalate"]);
    expect(escalateIssue).toHaveBeenCalledTimes(1);
  });
});
