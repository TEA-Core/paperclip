import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  agentSessionGoalActions,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issueTreeHolds,
  issues,
  routines,
} from "@paperclipai/db";
import {
  EXTERNAL_PULL_DELIVERY_SKIP_REASON,
  decideSuccessfulRunHandoff,
  isSuccessfulRunHandoffValidPathSkip,
} from "./successful-run-handoff.js";
import {
  STRAND_SKIP_REASONS,
  collectStrandSkipFacts,
  evaluateStrandSkipFacts,
  hasActiveReviewStageExecutionState,
  isSessionGoalDrivenContext,
  type StrandSkipFacts,
} from "./strand-skip.js";

// ---------------------------------------------------------------------------
// Handoff parity harness
//
// The shared predicate has to stay in lockstep with `decideSuccessfulRunHandoff`
// (the SUP-16504 drift between the handoff's hold list and the sweeps' hand-copied
// list is what produced the bug). For every hold the two share, we drive the real
// handoff decision and assert the sweep predicate answers with the exact same
// reason — and the same valid-path verdict.
// ---------------------------------------------------------------------------

const run = {
  id: "run-1",
  companyId: "company-1",
  agentId: "agent-1",
  status: "succeeded",
  contextSnapshot: { issueId: "issue-1" },
} as any;

const issue = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "PAP-1",
  title: "Card",
  description: null,
  status: "in_progress",
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  executionState: null,
  originKind: null,
} as any;

const agent = { id: "agent-1", companyId: "company-1", status: "idle" } as any;

const STAGE_ID = "11111111-1111-4111-8111-111111111111";

// Mirrors `blankExecutionState()` in issue-execution-policy.ts; the persisted
// state is schema-validated on read, so the helper only ever sees full rows.
function executionState(overrides: Record<string, unknown> = {}) {
  return {
    status: "idle",
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: null,
    deliveryAuthor: null,
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: null,
    ...overrides,
  };
}

function monitorState(overrides: Record<string, unknown> = {}) {
  return {
    status: "triggered",
    nextCheckAt: null,
    lastTriggeredAt: null,
    attemptCount: 0,
    notes: null,
    scheduledBy: null,
    clearedAt: null,
    clearReason: null,
    ...overrides,
  };
}

function decide(overrides: Partial<Parameters<typeof decideSuccessfulRunHandoff>[0]> = {}) {
  return decideSuccessfulRunHandoff({
    run,
    issue,
    agent,
    livenessState: "advanced",
    detectedProgressSummary: "Run produced concrete action evidence: 1 issue comment(s)",
    hasProgressEvidence: true,
    paperclipToolCallCount: null,
    finalReport: "Implemented and verified the change.",
    nextAction: "Record the correct issue disposition.",
    taskKey: "issue-1",
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
    ...overrides,
  });
}

function factsWith(overrides: Partial<StrandSkipFacts> = {}): StrandSkipFacts {
  return {
    hasExecutionState: false,
    pluginManagedLifecycle: false,
    hasOpenRecoveryAction: false,
    hasActiveRoutineContinuation: false,
    hasActiveSessionGoal: false,
    isExternalPullAssignee: false,
    hasPendingWake: false,
    hasPendingInteractionOrApproval: false,
    hasExplicitBlockerPath: false,
    hasOpenRecoveryIssue: false,
    hasPauseHold: false,
    ...overrides,
  };
}

interface ParityCase {
  name: string;
  hold: keyof StrandSkipFacts;
  reason: string;
  validPath: boolean;
  handoff: Partial<Parameters<typeof decideSuccessfulRunHandoff>[0]>;
}

const PARITY_CASES: ParityCase[] = [
  {
    name: "execution policy state",
    hold: "hasExecutionState",
    reason: STRAND_SKIP_REASONS.executionState,
    validPath: true,
    handoff: {
      issue: {
        ...issue,
        executionState: executionState({ currentStageId: STAGE_ID, currentStageType: "review" }),
      } as any,
    },
  },
  {
    // The handoff owns the lifecycle skip but, unlike the other holds, does not
    // count it as a valid path that can durably resolve a stale event.
    name: "plugin-managed lifecycle",
    hold: "pluginManagedLifecycle",
    reason: STRAND_SKIP_REASONS.pluginManagedLifecycle,
    validPath: false,
    handoff: { issue: { ...issue, originKind: "plugin:foo" } as any },
  },
  {
    name: "active routine continuation",
    hold: "hasActiveRoutineContinuation",
    reason: STRAND_SKIP_REASONS.activeRoutineContinuation,
    validPath: true,
    handoff: { hasActiveRoutineContinuation: true },
  },
  {
    name: "external-pull assignee",
    hold: "isExternalPullAssignee",
    reason: EXTERNAL_PULL_DELIVERY_SKIP_REASON,
    validPath: true,
    handoff: { agent: { ...agent, runtimeConfig: { workDelivery: "external_pull" } } as any },
  },
  {
    name: "queued wake",
    hold: "hasPendingWake",
    reason: STRAND_SKIP_REASONS.pendingWake,
    validPath: true,
    handoff: { hasQueuedWake: true },
  },
  {
    name: "pending interaction or approval",
    hold: "hasPendingInteractionOrApproval",
    reason: STRAND_SKIP_REASONS.pendingInteractionOrApproval,
    validPath: true,
    handoff: { hasPendingInteractionOrApproval: true },
  },
  {
    name: "explicit blocker path",
    hold: "hasExplicitBlockerPath",
    reason: STRAND_SKIP_REASONS.explicitBlockerPath,
    validPath: true,
    handoff: { hasExplicitBlockerPath: true },
  },
  {
    name: "open recovery issue",
    hold: "hasOpenRecoveryIssue",
    reason: STRAND_SKIP_REASONS.openRecoveryIssue,
    validPath: true,
    handoff: { hasOpenRecoveryIssue: true },
  },
  {
    name: "pause hold",
    hold: "hasPauseHold",
    reason: STRAND_SKIP_REASONS.pauseHold,
    validPath: true,
    handoff: { hasPauseHold: true },
  },
];

describe("strand skip predicate matches the successful-run handoff", () => {
  it.each(PARITY_CASES)("$name", (entry) => {
    const handoff = decide(entry.handoff);
    const strand = evaluateStrandSkipFacts(factsWith({ [entry.hold]: true }));

    expect(strand).toEqual({ skip: true, reason: entry.reason });
    if (handoff.kind !== "skip") {
      throw new Error(`handoff did not skip for ${entry.name}`);
    }
    expect(handoff.reason).toBe(entry.reason);
    expect(isSuccessfulRunHandoffValidPathSkip(handoff)).toBe(entry.validPath);
  });

  it("does not skip when no hold is set", () => {
    expect(evaluateStrandSkipFacts(factsWith())).toEqual({ skip: false });
    expect(decide().kind).toBe("enqueue");
  });

  it("keeps the sweep-only holds out of the handoff parity set", () => {
    // Every other hold has a handoff twin (checked above). The open recovery
    // action is the extra signal the handoff cannot express; the session-goal
    // hold is the handoff wrapper's early return, not a
    // `decideSuccessfulRunHandoff` reason. Each wins when paired.
    expect(evaluateStrandSkipFacts(factsWith({ hasOpenRecoveryAction: true }))).toEqual({
      skip: true,
      reason: STRAND_SKIP_REASONS.openRecoveryAction,
    });
    expect(evaluateStrandSkipFacts(factsWith({ hasActiveSessionGoal: true }))).toEqual({
      skip: true,
      reason: STRAND_SKIP_REASONS.activeSessionGoal,
    });
  });
});

describe("isSessionGoalDrivenContext", () => {
  it("recognises a goal-control or resume-heartbeat run context", () => {
    expect(isSessionGoalDrivenContext(null)).toBe(false);
    expect(isSessionGoalDrivenContext(undefined)).toBe(false);
    expect(isSessionGoalDrivenContext({})).toBe(false);
    expect(isSessionGoalDrivenContext({ goalControlRequestId: "" })).toBe(false);
    expect(isSessionGoalDrivenContext({ goalControlRequestId: "req-1" })).toBe(true);
    expect(isSessionGoalDrivenContext({ resumeSessionGoalHeartbeat: true })).toBe(true);
    expect(isSessionGoalDrivenContext({ resumeSessionGoalHeartbeat: false })).toBe(false);
  });
});

describe("hasActiveReviewStageExecutionState", () => {
  it("is true only for a state with a stage in flight", () => {
    expect(hasActiveReviewStageExecutionState(null)).toBe(false);
    expect(hasActiveReviewStageExecutionState(undefined)).toBe(false);
    expect(hasActiveReviewStageExecutionState("garbage")).toBe(false);
    expect(hasActiveReviewStageExecutionState(executionState())).toBe(false);
    expect(hasActiveReviewStageExecutionState(
      executionState({ currentStageId: STAGE_ID, currentStageType: "review" }),
    )).toBe(true);
  });

  it("does not treat a monitor-only state as a review stage", () => {
    // The host-restart sweep's escalate candidates always carry a monitor here;
    // feeding raw truthiness would suppress every exhausted-monitor escalation.
    const monitorOnly = executionState({ monitor: monitorState() });
    expect(hasActiveReviewStageExecutionState(monitorOnly)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// collectStrandSkipFacts mapping (fake Db)
// ---------------------------------------------------------------------------

interface FakeDbState {
  rows: Map<unknown, unknown[]>;
}

function fakeDb(state: FakeDbState): Db {
  function select() {
    let table: unknown;
    let limitN = Number.POSITIVE_INFINITY;
    const chain = {
      from(next: unknown) {
        table = next;
        return chain;
      },
      where() {
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit(next: number) {
        limitN = next;
        return chain;
      },
      then(resolve: (value: unknown) => unknown) {
        const rows = (state.rows.get(table) ?? []).slice(0, limitN);
        return Promise.resolve(rows).then(resolve);
      },
    };
    return chain;
  }
  return { select } as unknown as Db;
}

function collectInput(overrides: Partial<Parameters<typeof collectStrandSkipFacts>[1]> = {}) {
  return {
    companyId: "company-1",
    issueId: "issue-1",
    assigneeAgentId: "agent-1",
    executionState: null,
    originKind: null,
    ...overrides,
  };
}

describe("collectStrandSkipFacts", () => {
  it("reads an open recovery action on the source issue (SUP-16504)", async () => {
    const state: FakeDbState = { rows: new Map([[issueRecoveryActions, [{ id: "ra-1" }]]]) };
    const facts = await collectStrandSkipFacts(fakeDb(state), collectInput());
    expect(facts.hasOpenRecoveryAction).toBe(true);
    expect(evaluateStrandSkipFacts(facts)).toEqual({
      skip: true,
      reason: STRAND_SKIP_REASONS.openRecoveryAction,
    });
  });

  it("reads an open recovery issue", async () => {
    const state: FakeDbState = { rows: new Map([[issues, [{ id: "ri-1" }]]]) };
    const facts = await collectStrandSkipFacts(fakeDb(state), collectInput());
    expect(facts.hasOpenRecoveryIssue).toBe(true);
  });

  it("reads an active routine continuation", async () => {
    const state: FakeDbState = { rows: new Map([[routines, [{ id: "routine-1" }]]]) };
    const facts = await collectStrandSkipFacts(fakeDb(state), collectInput());
    expect(facts.hasActiveRoutineContinuation).toBe(true);
  });

  it("reads an external-pull assignee from the agent record", async () => {
    const state: FakeDbState = {
      rows: new Map([[agents, [{ runtimeConfig: { workDelivery: "external_pull" } }]]]),
    };
    const facts = await collectStrandSkipFacts(fakeDb(state), collectInput());
    expect(facts.isExternalPullAssignee).toBe(true);
  });

  it("skips the agent lookup when the issue has no assignee", async () => {
    const state: FakeDbState = {
      rows: new Map([[agents, [{ runtimeConfig: { workDelivery: "external_pull" } }]]]),
    };
    const facts = await collectStrandSkipFacts(fakeDb(state), collectInput({ assigneeAgentId: null }));
    expect(facts.isExternalPullAssignee).toBe(false);
  });

  it("reads a queued wake and a pending interaction", async () => {
    const state: FakeDbState = {
      rows: new Map<unknown, unknown[]>([
        [agentWakeupRequests, [{ id: "wake-1" }]],
        [issueThreadInteractions, [{ id: "int-1" }]],
      ]),
    };
    const facts = await collectStrandSkipFacts(fakeDb(state), collectInput());
    expect(facts.hasPendingWake).toBe(true);
    expect(facts.hasPendingInteractionOrApproval).toBe(true);
  });

  it("reads a pending approval linked to the issue", async () => {
    const state: FakeDbState = {
      rows: new Map<unknown, unknown[]>([
        [issueApprovals, [{ approvalId: "approval-1" }]],
        [approvals, [{ id: "approval-1" }]],
      ]),
    };
    const facts = await collectStrandSkipFacts(fakeDb(state), collectInput());
    expect(facts.hasPendingInteractionOrApproval).toBe(true);
  });

  it("reads an explicit blocker path", async () => {
    const state: FakeDbState = { rows: new Map([[issueRelations, [{ issueId: "blocked-1" }]]]) };
    const facts = await collectStrandSkipFacts(fakeDb(state), collectInput());
    expect(facts.hasExplicitBlockerPath).toBe(true);
  });

  it("reads an active pause hold", async () => {
    const state: FakeDbState = {
      rows: new Map([[issueTreeHolds, [{ id: "hold-1", rootIssueId: "issue-1" }]]]),
    };
    const facts = await collectStrandSkipFacts(fakeDb(state), collectInput());
    expect(facts.hasPauseHold).toBe(true);
  });

  it("passes executionState and originKind through from the candidate row", async () => {
    const facts = await collectStrandSkipFacts(fakeDb({ rows: new Map() }), collectInput({
      executionState: executionState({ currentStageId: STAGE_ID, currentStageType: "review" }),
      originKind: "plugin:foo",
    }));
    expect(facts.hasExecutionState).toBe(true);
    expect(facts.pluginManagedLifecycle).toBe(true);
  });

  // A durable session-goal wake: the goal projection the handoff wrapper reads
  // is the one `runnerGoalService.projection` builds from the agent task session.
  function goalState(goalStatus: string): FakeDbState {
    return {
      rows: new Map<unknown, unknown[]>([
        [issues, [{ id: "issue-1", companyId: "company-1", assigneeAgentId: "agent-1" }]],
        [agents, [{ id: "agent-1", companyId: "company-1", adapterType: "opencode_local", adapterConfig: {} }]],
        [agentTaskSessions, [{
          id: "session-1",
          goalJson: { objective: "Keep going", status: goalStatus },
          goalRevision: 1,
        }]],
        [agentSessionGoalActions, []],
        [heartbeatRuns, []],
      ]),
    };
  }

  it("holds a goal-driven run while its session goal is not complete", async () => {
    const facts = await collectStrandSkipFacts(fakeDb(goalState("active")), collectInput({
      latestRunContextSnapshot: { goalControlRequestId: "req-1" },
    }));
    expect(facts.hasActiveSessionGoal).toBe(true);
    expect(evaluateStrandSkipFacts(facts)).toEqual({
      skip: true,
      reason: STRAND_SKIP_REASONS.activeSessionGoal,
    });
  });

  it("recognises the resume-heartbeat marker as a goal-driven run", async () => {
    const facts = await collectStrandSkipFacts(fakeDb(goalState("paused")), collectInput({
      latestRunContextSnapshot: { resumeSessionGoalHeartbeat: true },
    }));
    expect(facts.hasActiveSessionGoal).toBe(true);
  });

  it("releases the hold once the session goal is complete", async () => {
    const facts = await collectStrandSkipFacts(fakeDb(goalState("complete")), collectInput({
      latestRunContextSnapshot: { goalControlRequestId: "req-1" },
    }));
    expect(facts.hasActiveSessionGoal).toBe(false);
  });

  it("does not probe a session goal for a non-goal run", async () => {
    const facts = await collectStrandSkipFacts(fakeDb(goalState("active")), collectInput({
      latestRunContextSnapshot: { issueId: "issue-1" },
    }));
    expect(facts.hasActiveSessionGoal).toBe(false);
  });

  it("does not probe a session goal when the issue has no assignee", async () => {
    const facts = await collectStrandSkipFacts(fakeDb(goalState("active")), collectInput({
      assigneeAgentId: null,
      latestRunContextSnapshot: { goalControlRequestId: "req-1" },
    }));
    expect(facts.hasActiveSessionGoal).toBe(false);
  });

  it("holds a goal-driven run with no resolvable session, matching the handoff", async () => {
    // The handoff wrapper early-returns on `projection?.goal?.status !==
    // "complete"`, and `undefined !== "complete"` — so a marker with no session
    // still holds. Lock that parity rather than reinterpreting it.
    const facts = await collectStrandSkipFacts(fakeDb({ rows: new Map() }), collectInput({
      latestRunContextSnapshot: { goalControlRequestId: "req-1" },
    }));
    expect(facts.hasActiveSessionGoal).toBe(true);
  });
});
