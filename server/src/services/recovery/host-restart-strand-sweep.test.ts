import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import {
  buildEscalationGateSelect,
  buildHostRestartStrandEscalationComment,
  buildRearmMonitorPatch,
  buildRearmMonitorUpdate,
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
const BOOT_NEW = "boot-new";

function hostRestartResult(): Record<string, unknown> {
  return {
    hostRestart: {
      detected: true,
      runBootId: "boot-old",
      currentBootId: BOOT_NEW,
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

// A card's persisted execution policy as it is shaped right after its monitor
// fired: the fired patch stripped `monitor` off the policy (see
// buildIssueMonitorTriggeredPatch), so the policy carries no monitor here.
function strippedExecutionPolicy(): Record<string, unknown> {
  return { mode: "normal", commentRequired: true, stages: [] };
}

function makeCandidate(overrides: Partial<HostRestartStrandCandidate> = {}): HostRestartStrandCandidate {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "PAP-1",
    status: "in_progress",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    executionPolicy: strippedExecutionPolicy(),
    executionState: executionStateWithMonitor(),
    monitorAttemptCount: 1,
    monitorNextCheckAt: null,
    monitorWakeRequestedAt: null,
    monitorLastTriggeredAt: null,
    monitorNotes: null,
    monitorScheduledBy: null,
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
    detectedBootId: BOOT_NEW,
    ...overrides,
  });
}

describe("host-restart strand repair decision", () => {
  it("re-arms a monitorable card whose marker matches the detected boot", () => {
    expect(decide({ detectedBootId: BOOT_NEW })).toEqual({ action: "rearm" });
  });

  it("ignores a marker stamped for a different (older) boot", () => {
    expect(decide({ detectedBootId: "boot-newer" })).toEqual({ action: "skip-no-marker" });
  });

  it("skips a re-armable marker when boot detection fails (detectedBootId: null)", () => {
    expect(decide({ detectedBootId: null })).toEqual({ action: "skip-no-marker" });
  });

  it("skips a re-armable marker when no detected boot is passed (detectedBootId: undefined)", () => {
    expect(decide({ detectedBootId: undefined })).toEqual({ action: "skip-no-marker" });
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

  it("escalates a card whose monitor is not in the fired (triggered) state", () => {
    const decision = decide({
      executionState: executionStateWithMonitor({ status: "cleared", clearReason: "manual", clearedAt: NOW.toISOString() }),
    });
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

describe("buildRearmMonitorPatch", () => {
  function rearmableCandidate(overrides: Partial<HostRestartStrandCandidate> = {}) {
    return makeCandidate({
      executionState: executionStateWithMonitor({
        maxAttempts: 5,
        serviceName: "svc",
        externalRef: "ref-1",
        timeoutAt: "2099-01-01T00:00:00.000Z",
      }),
      ...overrides,
    });
  }

  it("restores the scheduled monitor in both the execution policy and the persisted state", () => {
    const patch = buildRearmMonitorPatch({ now: NOW, candidate: rearmableCandidate() });
    expect(patch).not.toBeNull();
    expect(patch?.monitorNextCheckAt.getTime()).toBe(NOW.getTime());
    expect(patch?.monitorWakeRequestedAt).toBeNull();
    expect(patch?.monitorScheduledBy).toBe("assignee");
    expect(patch?.executionPolicy.monitor).toMatchObject({
      nextCheckAt: NOW.toISOString(),
      scheduledBy: "assignee",
      maxAttempts: 5,
      serviceName: "svc",
      externalRef: "ref-1",
      timeoutAt: "2099-01-01T00:00:00.000Z",
    });
    expect(new Date((patch?.executionPolicy.monitor as { nextCheckAt: string }).nextCheckAt).getTime()).toBeLessThanOrEqual(NOW.getTime());
    expect(patch?.executionState.monitor).toMatchObject({
      status: "scheduled",
      nextCheckAt: NOW.toISOString(),
      attemptCount: 1,
      lastTriggeredAt: "2026-09-09T00:00:00.000Z",
      maxAttempts: 5,
      clearedAt: null,
      clearReason: null,
    });
  });

  it("keeps the existing policy fields while restoring the monitor", () => {
    const returnAssignee = "38ca3dab-cdb5-4d90-84dd-c5f2eb15da5e";
    const patch = buildRearmMonitorPatch({
      now: NOW,
      candidate: makeCandidate({
        executionPolicy: { mode: "normal", commentRequired: false, stages: [], returnAssigneeAgentId: returnAssignee },
        executionState: executionStateWithMonitor(),
      }),
    });
    expect(patch?.executionPolicy).toMatchObject({
      mode: "normal",
      commentRequired: false,
      returnAssigneeAgentId: returnAssignee,
    });
    expect((patch?.executionPolicy.monitor as { maxAttempts: number }).maxAttempts).toBe(5);
  });

  it("preserves the card's existing execution state while adding the scheduled monitor", () => {
    const patch = buildRearmMonitorPatch({
      now: NOW,
      candidate: makeCandidate({
        executionState: executionStateWithMonitor({ maxAttempts: 5, notes: "keep me" }),
      }),
    });
    expect(patch?.executionState).toMatchObject({
      status: "idle",
      currentStageId: null,
      completedStageIds: [],
    });
    expect((patch?.executionState.monitor as { notes: string }).notes).toBe("keep me");
  });

  it("returns null when there is no persisted monitor to reconstruct from", () => {
    expect(buildRearmMonitorPatch({ now: NOW, candidate: makeCandidate({ executionState: null }) })).toBeNull();
  });

  it("returns null when the monitor is not in the fired (triggered) state", () => {
    expect(
      buildRearmMonitorPatch({
        now: NOW,
        candidate: makeCandidate({
          executionState: executionStateWithMonitor({ status: "cleared", clearReason: "manual", clearedAt: NOW.toISOString() }),
        }),
      }),
    ).toBeNull();
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
    const plan = planHostRestartStrandRepairs({ candidates, facts, now: NOW, cap: 10, detectedBootId: BOOT_NEW });
    expect(plan.repairs.map((r) => [r.issueId, r.kind])).toEqual([
      ["rearm", "rearm"],
      ["escalate", "escalate"],
    ]);
    expect(plan.skipped.liveRun).toEqual(["live"]);
  });

  it("skips a candidate whose marker is for an older boot", () => {
    const candidates = [makeCandidate({ id: "stale" })];
    const facts = new Map<string, HostRestartStrandFacts>([["stale", factsFor()]]);
    const plan = planHostRestartStrandRepairs({ candidates, facts, now: NOW, cap: 10, detectedBootId: "boot-newer" });
    expect(plan.repairs).toEqual([]);
    expect(plan.skipped.noHostRestartMarker).toEqual(["stale"]);
  });

  it("enforces the per-sweep repair cap and defers the rest", () => {
    const candidates = [makeCandidate({ id: "a" }), makeCandidate({ id: "b" })];
    const facts = new Map<string, HostRestartStrandFacts>([
      ["a", factsFor()],
      ["b", factsFor()],
    ]);
    const plan = planHostRestartStrandRepairs({ candidates, facts, now: NOW, cap: 1, detectedBootId: BOOT_NEW });
    expect(plan.repairs.map((r) => r.issueId)).toEqual(["a"]);
    expect(plan.skipped.capExceeded).toEqual(["b"]);
  });

  it("skips an already-escalated card without emitting a repair", () => {
    const candidates = [makeCandidate({ id: "a" })];
    const facts = new Map<string, HostRestartStrandFacts>([["a", factsFor({ alreadyEscalated: true })]]);
    const plan = planHostRestartStrandRepairs({ candidates, facts, now: NOW, cap: 10, detectedBootId: BOOT_NEW });
    expect(plan.repairs).toEqual([]);
    expect(plan.skipped.alreadyEscalated).toEqual(["a"]);
  });

  it("plans no repair when boot detection fails (detectedBootId: null)", () => {
    const candidates = [makeCandidate({ id: "null-boot" })];
    const facts = new Map<string, HostRestartStrandFacts>([["null-boot", factsFor()]]);
    const plan = planHostRestartStrandRepairs({ candidates, facts, now: NOW, cap: 10, detectedBootId: null });
    expect(plan.repairs).toEqual([]);
    expect(plan.skipped.noHostRestartMarker).toEqual(["null-boot"]);
  });
});

describe("buildHostRestartStrandEscalationComment", () => {
  it("names the reason and boot, and keys the notice to the source run", () => {
    const comment = buildHostRestartStrandEscalationComment({
      identifier: "PAP-1",
      sourceRun: { id: "run-1", agentId: "agent-1", status: "failed", errorCode: null },
      reason: "exhausted",
      bootId: BOOT_NEW,
    });
    expect(comment.body).toContain("host-restart strand sweep: exhausted");
    expect(comment.body).toContain(BOOT_NEW);
    expect(comment.metadata.sourceRunId).toBe("run-1");
    expect(comment.recoveryActionId).toContain("run-1");
  });
});

interface FakeDbState {
  candidates: HostRestartStrandCandidate[];
  // One entry per live-run SELECT, consumed in call order. Entries past the end
  // fall back to "no live run". Models a run that exists only AFTER collection
  // (a write-time race) by giving the later call a live row.
  liveRunQueue: Array<Array<{ id: string }>>;
  latestRunRows?: Array<HostRestartStrandLatestRun>;
  escalationRows?: Array<{ id: string }>;
  updateRows?: Array<{ id: string }>;
  // Candidate ids that have a live run at WRITE time; drives the re-arm's
  // atomic NOT-EXISTS guard so the UPDATE affects zero rows for them.
  writeLiveRuns?: Set<string>;
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
        if (table === issues) {
          rows = state.candidates.filter((candidate) => candidate.monitorNextCheckAt === null);
        } else if (table === heartbeatRuns) {
          rows = hasOrderBy ? (state.latestRunRows ?? []) : (state.liveRunQueue.length > 0 ? (state.liveRunQueue.shift() ?? []) : []);
        } else if (table === issueComments) {
          rows = state.escalationRows ?? [];
        }
        return Promise.resolve(rows.slice(0, limitN)).then(resolve);
      },
    };
    return chain;
  }

  function update() {
    let patch: Record<string, unknown> | undefined;
    const chain = {
      set(patchValue: unknown) {
        patch = patchValue as Record<string, unknown>;
        state.lastPatch = patchValue;
        return chain;
      },
      where() {
        return chain;
      },
      returning() {
        const rows: Array<{ id: string }> = [];
        state.candidates = state.candidates.map((candidate) => {
          const intended = (state.updateRows ?? []).some((row) => row.id === candidate.id);
          if (!intended) return candidate;
          if (candidate.monitorNextCheckAt !== null) return candidate; // flat-column idempotency guard
          if (state.writeLiveRuns?.has(candidate.id)) return candidate; // atomic no-live-run guard
          rows.push({ id: candidate.id });
          return {
            ...candidate,
            monitorNextCheckAt: (patch?.monitorNextCheckAt as Date | null) ?? candidate.monitorNextCheckAt,
            monitorWakeRequestedAt: (patch?.monitorWakeRequestedAt as null) ?? candidate.monitorWakeRequestedAt,
            executionPolicy: (patch?.executionPolicy as Record<string, unknown> | null) ?? candidate.executionPolicy,
            executionState: (patch?.executionState as Record<string, unknown> | null) ?? candidate.executionState,
          };
        });
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
    ): Promise<boolean> => true,
  );
}

const resolveBootNew = async () => BOOT_NEW;

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
      liveRunQueue: [[], [], []],
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
      updateRows: [{ id: "issue-rearm" }],
    };
    const escalateIssue = makeEscalateMock();

    const report = await sweepHostRestartStrandedIssues({
      db: makeFakeDb(state),
      now: NOW,
      resolveBootId: resolveBootNew,
      escalateIssue,
    });

    expect(report.reArmed).toEqual(["issue-rearm"]);
    expect(report.escalated).toEqual(["issue-escalate"]);
    expect(state.lastPatch).toMatchObject({ monitorNextCheckAt: NOW, monitorWakeRequestedAt: null });
    expect((state.lastPatch as { executionPolicy: Record<string, unknown> }).executionPolicy.monitor).toMatchObject({
      maxAttempts: 5,
      scheduledBy: "assignee",
    });
    expect((state.lastPatch as { executionState: Record<string, unknown> }).executionState.monitor).toMatchObject({
      status: "scheduled",
    });
    expect(escalateIssue).toHaveBeenCalledTimes(1);
    expect(escalateIssue.mock.calls[0]?.[2]).toMatchObject({ reason: "exhausted", sourceRun: { id: "run-1" } });
  });

  it("does not touch a card that still has a live run", async () => {
    const state: FakeDbState = {
      candidates: [makeCandidate({ id: "issue-live" })],
      liveRunQueue: [[{ id: "live-run" }]],
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
    };
    const escalateIssue = makeEscalateMock();

    const report = await sweepHostRestartStrandedIssues({
      db: makeFakeDb(state),
      now: NOW,
      resolveBootId: resolveBootNew,
      escalateIssue,
    });

    expect(report.reArmed).toEqual([]);
    expect(report.escalated).toEqual([]);
    expect(report.skipped.liveRun).toEqual(["issue-live"]);
    expect(escalateIssue).not.toHaveBeenCalled();
  });

  it("ignores a card whose marker is stamped for an older boot", async () => {
    const state: FakeDbState = {
      candidates: [makeCandidate({ id: "issue-stale" })],
      liveRunQueue: [[]],
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
    };

    const report = await sweepHostRestartStrandedIssues({
      db: makeFakeDb(state),
      now: NOW,
      resolveBootId: async () => "boot-newer",
      escalateIssue: makeEscalateMock(),
    });

    expect(report.reArmed).toEqual([]);
    expect(report.escalated).toEqual([]);
    expect(report.skipped.noHostRestartMarker).toEqual(["issue-stale"]);
  });

  it("is idempotent: an already-escalated card is skipped on a subsequent sweep", async () => {
    const state: FakeDbState = {
      candidates: [makeCandidate({ id: "issue-1" })],
      liveRunQueue: [[]],
      latestRunRows: [makeLatestRun()],
      escalationRows: [{ id: "comment-1" }],
    };
    const escalateIssue = makeEscalateMock();

    const report = await sweepHostRestartStrandedIssues({
      db: makeFakeDb(state),
      now: NOW,
      resolveBootId: resolveBootNew,
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
      liveRunQueue: [[], []],
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
      updateRows: [{ id: "a" }],
    };
    const escalateIssue = makeEscalateMock();

    const report = await sweepHostRestartStrandedIssues({
      db: makeFakeDb(state),
      now: NOW,
      cap: 1,
      resolveBootId: resolveBootNew,
      escalateIssue,
    });

    expect(report.reArmed).toEqual(["a"]);
    expect(report.skipped.capExceeded).toEqual(["b"]);
  });

  it("is idempotent across two invocations for the same boot (re-arm)", async () => {
    const state: FakeDbState = {
      candidates: [makeCandidate({ id: "issue-rearm" })],
      liveRunQueue: [[]],
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
      updateRows: [{ id: "issue-rearm" }],
    };
    const db = makeFakeDb(state);

    const first = await sweepHostRestartStrandedIssues({ db, now: NOW, resolveBootId: resolveBootNew });
    const second = await sweepHostRestartStrandedIssues({ db, now: NOW, resolveBootId: resolveBootNew });

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
      liveRunQueue: [[], []],
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
    };
    // Persist the notice the way the real escalation does: the durable
    // system-comment keyed to the source run is what makes the second pass a
    // no-op (there is no in-memory per-boot flag).
    const escalateIssue = vi.fn(async () => {
      state.escalationRows = [{ id: "comment-1" }];
      return true;
    });
    const db = makeFakeDb(state);

    const first = await sweepHostRestartStrandedIssues({ db, now: NOW, resolveBootId: resolveBootNew, escalateIssue });
    const second = await sweepHostRestartStrandedIssues({ db, now: NOW, resolveBootId: resolveBootNew, escalateIssue });

    expect(first.escalated).toEqual(["issue-escalate"]);
    expect(second.escalated).toEqual([]);
    expect(second.considered).toBe(1);
    expect(second.skipped.alreadyEscalated).toEqual(["issue-escalate"]);
    expect(escalateIssue).toHaveBeenCalledTimes(1);
  });

  it("does not re-arm a card that gains a live run between planning and the write", async () => {
    const state: FakeDbState = {
      candidates: [makeCandidate({ id: "issue-race" })],
      liveRunQueue: [[]], // collection sees no live run -> plans a re-arm
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
      updateRows: [{ id: "issue-race" }],
      writeLiveRuns: new Set(["issue-race"]), // a run is live at write time
    };

    const report = await sweepHostRestartStrandedIssues({
      db: makeFakeDb(state),
      now: NOW,
      resolveBootId: resolveBootNew,
      escalateIssue: makeEscalateMock(),
    });

    expect(report.reArmed).toEqual([]);
    expect(report.escalated).toEqual([]);
  });

  it("does not escalate a card that gains a live run just before the escalation write", async () => {
    const state: FakeDbState = {
      candidates: [
        makeCandidate({
          id: "issue-e",
          executionState: executionStateWithMonitor({ attemptCount: 5, maxAttempts: 5 }),
          monitorAttemptCount: 5,
        }),
      ],
      liveRunQueue: [[], [{ id: "live" }]], // collection: no live; re-check: live
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
    };
    const escalateIssue = makeEscalateMock();

    const report = await sweepHostRestartStrandedIssues({
      db: makeFakeDb(state),
      now: NOW,
      resolveBootId: resolveBootNew,
      escalateIssue,
    });

    expect(report.escalated).toEqual([]);
    expect(escalateIssue).not.toHaveBeenCalled();
  });

  it("does not re-repair after a process restart (persisted state, no in-memory flag)", async () => {
    // Simulate a restart: a brand-new Db handle over the SAME persistent store.
    // There is no module-local per-boot flag anymore, so correctness must come
    // from what the first pass persisted.
    const rearmState: FakeDbState = {
      candidates: [makeCandidate({ id: "issue-rearm" })],
      liveRunQueue: [[]],
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
      updateRows: [{ id: "issue-rearm" }],
    };
    const firstRearm = await sweepHostRestartStrandedIssues({
      db: makeFakeDb(rearmState),
      now: NOW,
      resolveBootId: resolveBootNew,
    });
    const secondRearm = await sweepHostRestartStrandedIssues({
      db: makeFakeDb(rearmState),
      now: NOW,
      resolveBootId: resolveBootNew,
    });
    expect(firstRearm.reArmed).toEqual(["issue-rearm"]);
    expect(secondRearm.reArmed).toEqual([]);
    expect(secondRearm.considered).toBe(0);

    const escalateState: FakeDbState = {
      candidates: [
        makeCandidate({
          id: "issue-escalate",
          executionState: executionStateWithMonitor({ attemptCount: 5, maxAttempts: 5 }),
          monitorAttemptCount: 5,
        }),
      ],
      liveRunQueue: [[], []],
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
    };
    const escalateIssue = vi.fn(async () => {
      escalateState.escalationRows = [{ id: "comment-1" }];
      return true;
    });
    const firstEsc = await sweepHostRestartStrandedIssues({
      db: makeFakeDb(escalateState),
      now: NOW,
      resolveBootId: resolveBootNew,
      escalateIssue,
    });
    const secondEsc = await sweepHostRestartStrandedIssues({
      db: makeFakeDb(escalateState),
      now: NOW,
      resolveBootId: resolveBootNew,
      escalateIssue,
    });
    expect(firstEsc.escalated).toEqual(["issue-escalate"]);
    expect(secondEsc.escalated).toEqual([]);
    expect(secondEsc.skipped.alreadyEscalated).toEqual(["issue-escalate"]);
    expect(escalateIssue).toHaveBeenCalledTimes(1);
  });

  it("applies a re-arm exactly once under two overlapping invocations (atomic guarded write)", async () => {
    const state: FakeDbState = {
      candidates: [makeCandidate({ id: "issue-rearm" })],
      liveRunQueue: [[], [], []],
      latestRunRows: [makeLatestRun()],
      escalationRows: [],
      updateRows: [{ id: "issue-rearm" }],
    };
    const db = makeFakeDb(state);

    const [a, b] = await Promise.all([
      sweepHostRestartStrandedIssues({ db, now: NOW, resolveBootId: resolveBootNew }),
      sweepHostRestartStrandedIssues({ db, now: NOW, resolveBootId: resolveBootNew }),
    ]);

    // However the two invocations interleave, the conditional UPDATE means at
    // most one reports the re-arm; the other sees monitorNextCheckAt already set
    // (or the candidate already gone from the set).
    expect([...a.reArmed, ...b.reArmed]).toEqual(["issue-rearm"]);
  });
});

describe("real SQL shape (Postgres-acceptable guards)", () => {
  it("compiles the re-arm UPDATE with an alias-free no-live-run guard", () => {
    const db = createDb("postgres://user:pass@127.0.0.1:59999/probe");
    const candidate = makeCandidate({ id: "issue-rearm" });
    const patch = buildRearmMonitorPatch({ now: NOW, candidate });
    expect(patch).not.toBeNull();

    const compiled = buildRearmMonitorUpdate(db, candidate, patch!).toSQL();
    // Regression (SUP-15581 round 2): the subquery must NOT alias heartbeat_runs
    // while the correlated columns stay fully qualified, or Postgres rejects the
    // whole statement with `missing FROM-clause entry for table "heartbeat_runs"`.
    expect(compiled.sql).not.toContain("live_run");
    expect(compiled.sql).toContain('"heartbeat_runs"."company_id"');
    expect(compiled.sql).toContain('"heartbeat_runs"."context_snapshot"');
    expect(compiled.sql).toContain("->> 'issueId'");
    expect(compiled.sql.toLowerCase()).toContain("not exists");
    expect(compiled.sql).toContain('"issues"."monitor_next_check_at" is null');
  });

  it("compiles the escalation gate with the same alias-free guard and a row lock", () => {
    const db = createDb("postgres://user:pass@127.0.0.1:59999/probe");
    const compiled = buildEscalationGateSelect(db, "company-1", "issue-1").toSQL();
    expect(compiled.sql).not.toContain("live_run");
    expect(compiled.sql).toContain('"heartbeat_runs"."company_id"');
    expect(compiled.sql).toContain('"issues"."id"');
    expect(compiled.sql.toLowerCase()).toContain("not exists");
    expect(compiled.sql.toLowerCase()).toContain("for update");
  });
});
