import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, budgetPolicies, companies, costEvents, createDb, heartbeatRuns,
  issueRecoveryActions, issueRelations, issues,
  type Db, type EmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { issueRoutes } from "../../routes/issues.js";
import { normalizeIssueExecutionPolicy } from "../issue-execution-policy.js";
import {
  RECOVERY_BOUNCE_CONSECUTIVE_WAKE_FAILURES,
  hasConsecutiveWakeFailures,
  isRecoveryBounceTargetLive,
  recoveryBounceStatusRank,
  selectRecoveryBounceCandidate,
  decideRecoveryReassignment,
  wouldDisplacePendingStageParticipant,
  recoveryService,
} from "./service.js";

describe("SUP-17884: recovery bounce eligibility (pure helpers)", () => {
  describe("RECOVERY_BOUNCE_CONSECUTIVE_WAKE_FAILURES", () => {
    it("is at least 3 so a single transient failure does not kill an agent", () => {
      expect(RECOVERY_BOUNCE_CONSECUTIVE_WAKE_FAILURES).toBeGreaterThanOrEqual(3);
    });
  });

  describe("hasConsecutiveWakeFailures", () => {
    it("returns true when the K most-recent wake requests all failed", () => {
      expect(hasConsecutiveWakeFailures(["failed", "failed", "failed"], 3)).toBe(true);
    });

    it("returns true for a longer all-failed tail (most-recent-first)", () => {
      expect(hasConsecutiveWakeFailures(["failed", "failed", "failed", "failed"], 3)).toBe(true);
    });

    it("returns false when fewer than K wake requests exist", () => {
      expect(hasConsecutiveWakeFailures(["failed", "failed"], 3)).toBe(false);
    });

    it("returns false when the streak is broken by a non-failed outcome within K", () => {
      // most-recent-first: a success three back breaks the all-failed run
      expect(hasConsecutiveWakeFailures(["failed", "succeeded", "failed", "failed"], 3)).toBe(false);
    });

    it("returns false when a non-terminal status is the most recent", () => {
      expect(hasConsecutiveWakeFailures(["queued", "failed", "failed", "failed"], 3)).toBe(false);
    });

    it("returns false for empty / null / undefined history", () => {
      expect(hasConsecutiveWakeFailures([], 3)).toBe(false);
      expect(hasConsecutiveWakeFailures(null, 3)).toBe(false);
      expect(hasConsecutiveWakeFailures(undefined, 3)).toBe(false);
    });

    it("treats a single failure as not-dead at K=3", () => {
      expect(hasConsecutiveWakeFailures(["failed"], 3)).toBe(false);
    });
  });

  describe("recoveryBounceStatusRank (C3 ordering)", () => {
    it("ranks idle/active/running as the best (0)", () => {
      expect(recoveryBounceStatusRank("idle")).toBe(0);
      expect(recoveryBounceStatusRank("active")).toBe(0);
      expect(recoveryBounceStatusRank("running")).toBe(0);
    });

    it("demotes error below idle but not out of the set (1)", () => {
      expect(recoveryBounceStatusRank("error")).toBe(1);
    });

    it("ranks unknown statuses lowest (2)", () => {
      expect(recoveryBounceStatusRank("archived")).toBe(2);
      expect(recoveryBounceStatusRank(null)).toBe(2);
      expect(recoveryBounceStatusRank(undefined)).toBe(2);
    });

    it("prefers idle ahead of error", () => {
      expect(recoveryBounceStatusRank("idle")).toBeLessThan(recoveryBounceStatusRank("error"));
    });
  });

  describe("isRecoveryBounceTargetLive (C2 liveness)", () => {
    it("keeps a plain `error` agent live when its wake history is clean (no stripping of error)", () => {
      // A5 §0 guard: an error status alone must NOT make the agent undispatchable.
      expect(isRecoveryBounceTargetLive("error", null)).toBe(true);
      expect(isRecoveryBounceTargetLive("error", ["failed"])).toBe(true);
    });

    it("marks a dead agent (K consecutive failed wakes) not live even when status is error", () => {
      expect(
        isRecoveryBounceTargetLive("error", ["failed", "failed", "failed"], RECOVERY_BOUNCE_CONSECUTIVE_WAKE_FAILURES),
      ).toBe(false);
    });

    it("marks a dead agent not live even when its status is idle", () => {
      expect(
        isRecoveryBounceTargetLive("idle", ["failed", "failed", "failed"], RECOVERY_BOUNCE_CONSECUTIVE_WAKE_FAILURES),
      ).toBe(false);
    });

    it("keeps an idle agent with a clean wake history live", () => {
      expect(isRecoveryBounceTargetLive("idle", null)).toBe(true);
      expect(isRecoveryBounceTargetLive("idle", ["succeeded", "failed", "failed"])).toBe(true);
    });

    it("rejects a non-invokable status regardless of wake history", () => {
      expect(isRecoveryBounceTargetLive("archived", null)).toBe(false);
    });
  });

  describe("selectRecoveryBounceCandidate (C3 ordering)", () => {
    it("prefers an idle creator over a live error return assignee", () => {
      const selected = selectRecoveryBounceCandidate([
        { agentId: "return-assignee", status: "error", source: "return_assignee" },
        { agentId: "creator", status: "idle", source: "creator" },
      ]);

      expect(selected).toEqual({ agentId: "creator", source: "creator" });
    });

    it("preserves stable source order when candidates have equal status rank", () => {
      const selected = selectRecoveryBounceCandidate([
        { agentId: "return-assignee", status: "running", source: "return_assignee" },
        { agentId: "creator", status: "idle", source: "creator" },
      ]);

      expect(selected).toEqual({ agentId: "return-assignee", source: "return_assignee" });
    });
  });

  describe("decideRecoveryReassignment (C1 refusal)", () => {
    it("fast-paths when the recovery owner is the same as the current assignee", () => {
      const decision = decideRecoveryReassignment({
        currentAssigneeAgentId: "agent-1",
        recoveryOwnerAgentId: "agent-1",
        reviewStageSelfSatisfies: false,
        recoveryOwnerLive: true,
      });
      expect(decision).toMatchObject({ assigneeAgentId: "agent-1", refused: false, refusalReason: null });
    });

    it("keeps the current assignee when the recovery owner is null", () => {
      const decision = decideRecoveryReassignment({
        currentAssigneeAgentId: "agent-1",
        recoveryOwnerAgentId: null,
        reviewStageSelfSatisfies: false,
        recoveryOwnerLive: true,
      });
      expect(decision.assigneeAgentId).toBe("agent-1");
      expect(decision.refused).toBe(false);
    });

    it("assigns the recovery owner when it is live and the review stage is clear", () => {
      const decision = decideRecoveryReassignment({
        currentAssigneeAgentId: "agent-1",
        recoveryOwnerAgentId: "agent-2",
        reviewStageSelfSatisfies: false,
        recoveryOwnerLive: true,
      });
      expect(decision).toMatchObject({
        assigneeAgentId: "agent-2",
        refused: false,
        refusalReason: null,
        refusedAssigneeAgentId: null,
        keptAssigneeAgentId: null,
      });
    });

    it("refuses and keeps the current assignee when the recovery owner cannot start a run (A4)", () => {
      const decision = decideRecoveryReassignment({
        currentAssigneeAgentId: "agent-1",
        recoveryOwnerAgentId: "agent-2",
        reviewStageSelfSatisfies: false,
        recoveryOwnerLive: false,
      });
      expect(decision).toMatchObject({
        assigneeAgentId: "agent-1",
        refused: true,
        refusalReason: "reassignment_target_not_live",
      });
      // A3 evidence shape
      expect(decision.refusedAssigneeAgentId).toBe("agent-2");
      expect(decision.keptAssigneeAgentId).toBe("agent-1");
    });

    it("refuses when the write would make an incomplete review stage self-satisfiable (SUP-13526)", () => {
      const decision = decideRecoveryReassignment({
        currentAssigneeAgentId: "agent-1",
        recoveryOwnerAgentId: "agent-2",
        reviewStageSelfSatisfies: true,
        recoveryOwnerLive: true,
      });
      expect(decision).toMatchObject({
        assigneeAgentId: "agent-1",
        refused: true,
        refusalReason: "review_stage_self_satisfy",
      });
      expect(decision.refusedAssigneeAgentId).toBe("agent-2");
      expect(decision.keptAssigneeAgentId).toBe("agent-1");
    });

    it("prefers the review-stage refusal when both predicates hold", () => {
      const decision = decideRecoveryReassignment({
        currentAssigneeAgentId: "agent-1",
        recoveryOwnerAgentId: "agent-2",
        reviewStageSelfSatisfies: true,
        recoveryOwnerLive: false,
      });
      expect(decision.refusalReason).toBe("review_stage_self_satisfy");
    });

    it("keeps the card unassigned when refusing and there is no current assignee", () => {
      const decision = decideRecoveryReassignment({
        currentAssigneeAgentId: null,
        recoveryOwnerAgentId: "agent-2",
        reviewStageSelfSatisfies: false,
        recoveryOwnerLive: false,
      });
      expect(decision.assigneeAgentId).toBe(null);
      expect(decision.refused).toBe(true);
      expect(decision.keptAssigneeAgentId).toBe(null);
    });
  });
});

// ---------------------------------------------------------------------------
// SUP-17808 shape, end-to-end through the C1/C2/C3 pipeline the sweep uses.
//
// `resolveStrandedIssueRecoveryOwnerAgentId` filters candidates through C2 and
// orders the survivors through C3; `resolveRecoveryReassignedAssignee` applies
// the C1 refusal when the chosen owner is not live. These three pure helpers are
// the entire selection decision, so composing them reproduces the incident
// without a full database: the only candidate is a company root (exec-CEO) in
// `error` failing every dispatch. The card must not move onto it.
// ---------------------------------------------------------------------------

describe("SUP-17808 shape: ladder collapsing to a dead root agent", () => {
  it("reassigns nothing when the sole candidate is a root failing every dispatch", () => {
    // exec-CEO: company root (reportsTo: null, entered the ladder by ROLE),
    // status `error` (invokable — it is set on a failed run, cleared on the next
    // success), last K wake requests all `failed`.
    const root = { status: "error", wakes: ["failed", "failed", "failed"] };
    const cardOwner = "agent-1"; // who actually owed the card

    // C2 filters the candidate out of the ladder even though status is invokable.
    expect(isRecoveryBounceTargetLive(root.status, root.wakes)).toBe(false);

    // With no live candidate the ladder would propose the dead root as the
    // recovery owner. The shared refusal refuses that write and keeps the card
    // where it already sits — the assignee is UNCHANGED.
    const decision = decideRecoveryReassignment({
      currentAssigneeAgentId: cardOwner,
      recoveryOwnerAgentId: "exec-ceo",
      reviewStageSelfSatisfies: false,
      recoveryOwnerLive: false,
    });
    expect(decision.assigneeAgentId).toBe(cardOwner);
    expect(decision.refused).toBe(true);
    expect(decision.refusalReason).toBe("reassignment_target_not_live");
    expect(decision.refusedAssigneeAgentId).toBe("exec-ceo");
    expect(decision.keptAssigneeAgentId).toBe(cardOwner);
  });

  it("prefers a live idle candidate over a live-but-error one (C3 ordering)", () => {
    const idle = { status: "idle", wakes: ["succeeded"] };
    const errored = { status: "error", wakes: ["failed"] }; // one transient failure, still live

    // Both are live (one failed wake < K=3). C3 ranks idle ahead of error.
    expect(isRecoveryBounceTargetLive(idle.status, idle.wakes)).toBe(true);
    expect(isRecoveryBounceTargetLive(errored.status, errored.wakes)).toBe(true);
    expect(recoveryBounceStatusRank(idle.status)).toBeLessThan(recoveryBounceStatusRank(errored.status));
  });

  it("still selects an `error`-status agent with a clean wake history (the §0 guard)", () => {
    // A regression to C2 that treats `error` as dead would make any agent whose
    // last run failed permanently undispatchable. This pins the opposite: `error`
    // alone (no failed-wake streak) remains a selectable recovery target.
    const agent = { status: "error", wakes: null }; // never failed a dispatch, or never dispatched
    expect(isRecoveryBounceTargetLive(agent.status, agent.wakes)).toBe(true);

    const decision = decideRecoveryReassignment({
      currentAssigneeAgentId: "agent-1",
      recoveryOwnerAgentId: "exec-ceo",
      reviewStageSelfSatisfies: false,
      recoveryOwnerLive: true,
    });
    expect(decision.assigneeAgentId).toBe("exec-ceo");
    expect(decision.refused).toBe(false);
  });
});


describe("orphaned-stage deadlock: recovery must not move a card off its pending stage participant", () => {
  const SUPPORT_CR = "44953859-74c2-44de-9699-6d02e5f51817";
  const EXEC_CTO = "e75502a7-952d-4895-93df-6a2b524a804b";
  const CODER_BE = "3ff8593a-9166-4910-ae1e-1e0ded21521c";
  const BOARD_USER = "yuoJHg46O2i22rvDncrPSbBK0iUdakvZ";

  // The executionState of a production card as read just before the 2026-10-24 repair
  // (review stage 0 pending, participant support-CR). On that card the platform's
  // `reconcile_execution_review_participant` had re-seated the assignee from support-CR
  // to exec-CTO at 05:20:58Z while this state stayed pending, which deadlocked it.
  const pendingStageHeldBySupportCr = {
      "status": "pending",
      "monitor": null,
      "delivery": {
        "repo": {
          "owner": "TEA-Core",
          "repo": "paperclip"
        },
        "branch": "fixture",
        "headSha": "0000000000000000000000000000000000000000",
        "recordedAt": "2026-10-24T04:23:48.370Z",
        "recordedByRunId": "00000000-0000-4000-8000-000000000000"
      },
      "pendingSince": "2026-10-24T04:42:01.988Z",
      "reviewRequest": null,
      "currentStageId": "ef5d6619-c670-49a9-a294-0fad81bdd628",
      "deliveryAuthor": {
        "type": "agent",
        "userId": null,
        "agentId": "3ff8593a-9166-4910-ae1e-1e0ded21521c"
      },
      "lastDecisionId": "38d25ab4-0214-48f4-8cdd-2c4ca4a2ad74",
      "returnAssignee": {
        "type": "agent",
        "userId": null,
        "agentId": "3ff8593a-9166-4910-ae1e-1e0ded21521c"
      },
      "skippedStageIds": [],
      "currentStageType": "review",
      "completedStageIds": [],
      "currentStageIndex": 0,
      "currentParticipant": {
        "id": "71d4bbda-5cf8-44d4-b8a9-7092528cc0b6",
        "type": "agent",
        "userId": null,
        "agentId": "44953859-74c2-44de-9699-6d02e5f51817"
      },
      "lastDecisionOutcome": "changes_requested",
      "changesRequestedCount": 2
    };


  it("flags a reassignment from the pending participant to a different recovery owner", () => {
    expect(
      wouldDisplacePendingStageParticipant({
        executionState: pendingStageHeldBySupportCr,
        currentAssigneeAgentId: SUPPORT_CR,
        candidateAgentId: EXEC_CTO,
      }),
    ).toBe(true);
  });

  it("does not flag keeping the card with the participant", () => {
    expect(
      wouldDisplacePendingStageParticipant({
        executionState: pendingStageHeldBySupportCr,
        currentAssigneeAgentId: SUPPORT_CR,
        candidateAgentId: SUPPORT_CR,
      }),
    ).toBe(false);
  });

  it("does not flag when the stage is not pending or there is no state", () => {
    expect(
      wouldDisplacePendingStageParticipant({
        executionState: { ...pendingStageHeldBySupportCr, status: "changes_requested" },
        currentAssigneeAgentId: SUPPORT_CR,
        candidateAgentId: EXEC_CTO,
      }),
    ).toBe(false);
    expect(
      wouldDisplacePendingStageParticipant({
        executionState: null,
        currentAssigneeAgentId: SUPPORT_CR,
        candidateAgentId: EXEC_CTO,
      }),
    ).toBe(false);
  });

  it("does not flag when the current assignee is already not the participant (no new orphan is created)", () => {
    expect(
      wouldDisplacePendingStageParticipant({
        executionState: pendingStageHeldBySupportCr,
        currentAssigneeAgentId: CODER_BE,
        candidateAgentId: EXEC_CTO,
      }),
    ).toBe(false);
  });

  it("leaves a user-held escalation hold to its own sticky-hold rules", () => {
    expect(
      wouldDisplacePendingStageParticipant({
        executionState: {
          ...pendingStageHeldBySupportCr,
          currentParticipant: { ...pendingStageHeldBySupportCr.currentParticipant, type: "user", agentId: null, userId: BOARD_USER },
        },
        currentAssigneeAgentId: null,
        candidateAgentId: EXEC_CTO,
      }),
    ).toBe(false);
  });

  it("ignores missing assignee or candidate ids", () => {
    expect(
      wouldDisplacePendingStageParticipant({
        executionState: pendingStageHeldBySupportCr,
        currentAssigneeAgentId: null,
        candidateAgentId: EXEC_CTO,
      }),
    ).toBe(false);
    expect(
      wouldDisplacePendingStageParticipant({
        executionState: pendingStageHeldBySupportCr,
        currentAssigneeAgentId: SUPPORT_CR,
        candidateAgentId: null,
      }),
    ).toBe(false);
  });

  it("decideRecoveryReassignment refuses and keeps the participant when the displacement flag is set", () => {
    const decision = decideRecoveryReassignment({
      currentAssigneeAgentId: SUPPORT_CR,
      recoveryOwnerAgentId: EXEC_CTO,
      reviewStageSelfSatisfies: false,
      pendingStageParticipantDisplaced: true,
      recoveryOwnerLive: true,
    });
    expect(decision).toEqual({
      assigneeAgentId: SUPPORT_CR,
      refused: true,
      refusalReason: "pending_stage_participant_displaced",
      refusedAssigneeAgentId: EXEC_CTO,
      keptAssigneeAgentId: SUPPORT_CR,
    });
  });

  it("decideRecoveryReassignment still reassigns when nothing pins the card (flag omitted or false)", () => {
    for (const flag of [undefined, false]) {
      const decision = decideRecoveryReassignment({
        currentAssigneeAgentId: SUPPORT_CR,
        recoveryOwnerAgentId: EXEC_CTO,
        reviewStageSelfSatisfies: false,
        pendingStageParticipantDisplaced: flag,
        recoveryOwnerLive: true,
      });
      expect(decision.refused).toBe(false);
      expect(decision.assigneeAgentId).toBe(EXEC_CTO);
    }
  });

  it("the self-satisfy refusal keeps precedence over the displacement refusal", () => {
    const decision = decideRecoveryReassignment({
      currentAssigneeAgentId: SUPPORT_CR,
      recoveryOwnerAgentId: EXEC_CTO,
      reviewStageSelfSatisfies: true,
      pendingStageParticipantDisplaced: true,
      recoveryOwnerLive: true,
    });
    expect(decision.refusalReason).toBe("review_stage_self_satisfy");
  });
  it("ignores pending rows without a concrete review or approval stage", () => {
    for (const executionState of [
      { ...pendingStageHeldBySupportCr, currentStageId: null },
      { ...pendingStageHeldBySupportCr, currentStageType: null },
    ]) {
      expect(wouldDisplacePendingStageParticipant({
        executionState, currentAssigneeAgentId: SUPPORT_CR, candidateAgentId: EXEC_CTO,
      })).toBe(false);
    }
    expect(wouldDisplacePendingStageParticipant({
      executionState: { ...pendingStageHeldBySupportCr, currentStageType: "approval" },
      currentAssigneeAgentId: SUPPORT_CR, candidateAgentId: EXEC_CTO,
    })).toBe(true);
  });
});

const postgresSupport = await getEmbeddedPostgresTestSupport();
(postgresSupport.supported ? describe : describe.skip)("pending participant recovery with real service", () => {
  let temp: EmbeddedPostgresTestDatabase;
  let db: Db;
  let competingDb: Db;
  const participantId = randomUUID();
  const managerId = randomUUID();
  const authorId = randomUUID();
  const stageId = randomUUID();
  const participant = { id: randomUUID(), type: "agent" as const, agentId: participantId, userId: null };
  const stage = {
    status: "pending", monitor: null,
    delivery: {
      repo: { owner: "example", repo: "test" }, branch: "fixture",
      headSha: "0000000000000000000000000000000000000000",
      recordedAt: new Date().toISOString(), recordedByRunId: randomUUID(),
    },
    pendingSince: new Date().toISOString(), reviewRequest: null,
    currentStageId: stageId, currentStageType: "review", currentStageIndex: 0,
    currentParticipant: participant,
    deliveryAuthor: { type: "agent", agentId: authorId, userId: null },
    returnAssignee: { type: "agent", agentId: authorId, userId: null },
    lastDecisionId: randomUUID(), lastDecisionOutcome: "changes_requested",
    completedStageIds: [], skippedStageIds: [], changesRequestedCount: 2,
  };

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-pending-recovery-");
    db = createDb(temp.connectionString);
    competingDb = createDb(temp.connectionString);
  }, 60_000);
  afterEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => { await temp?.cleanup(); });

  async function seed(status: "active" | "paused" | "terminated" | "pending_approval" | "budget_paused" | "over_budget", state = stage) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const old = new Date(Date.now() - 3_600_000);
    await db.insert(companies).values({ id: companyId, name: "Pending review recovery", issuePrefix: "PRR", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: managerId, companyId, name: "Manager", role: "cto", status: "idle", adapterType: "codex_local", permissions: { canAssignTasks: true } },
      { id: participantId, companyId, name: "Reviewer", role: "engineer", status: status === "budget_paused" ? "paused" : status === "over_budget" ? "active" : status, pauseReason: status === "budget_paused" ? "budget" : null, reportsTo: managerId, adapterType: "codex_local" },
      { id: authorId, companyId, name: "Author", role: "engineer", status: "idle", reportsTo: managerId, adapterType: "codex_local" },
    ]);
    const policy = normalizeIssueExecutionPolicy({ mode: "normal", stages: [{ id: stageId, type: "review", participants: [participant] }] });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review pending", issueNumber: 1, identifier: "PRR-1", status: "in_review", assigneeAgentId: participantId, createdByAgentId: authorId, executionPolicy: policy ? { ...policy } : null, executionState: state, createdAt: old, updatedAt: old });
    await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId, agentId: participantId, status: "failed", invocationSource: "automation", errorCode: "fixture_failed", resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } }, contextSnapshot: { issueId, taskId: issueId, retryReason: "execution_review_participant_recovery" }, startedAt: old, finishedAt: old, createdAt: old, updatedAt: old });
    if (status === "over_budget") {
      await db.insert(budgetPolicies).values({ companyId, scopeType: "agent", scopeId: participantId, metric: "billed_cents", windowKind: "calendar_month", amount: 1, hardStopEnabled: true });
      await db.insert(costEvents).values({ companyId, agentId: participantId, provider: "test", model: "test", costCents: 2, billingType: "metered", occurredAt: new Date() });
    }
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    return { issueId, companyId, recovery, enqueueWakeup };
  }

  it.each(["paused", "terminated", "pending_approval", "budget_paused", "over_budget"] as const)(
    "routes an unavailable %s participant to the board instead of cancelling a replacement wake",
    async (status) => {
      const { issueId, recovery, enqueueWakeup } = await seed(status);
      await recovery.reconcileStrandedAssignedIssues();
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
      expect(issue.status).toBe("blocked");
      expect(issue.assigneeAgentId).toBe(participantId);
      expect(issue.executionState).toMatchObject({ status: "pending", currentParticipant: participant });
      expect(action).toMatchObject({
        ownerType: "board", ownerAgentId: null,
        evidence: { routingPolicy: "board_escalation_no_takeover_v1" },
      });
      expect(action.nextAction).toContain("Restore or replace the participant");
      expect(enqueueWakeup).not.toHaveBeenCalled();
    },
  );

  it("keeps a live reviewer assigned while the recovery manager works", async () => {
    const { issueId, recovery } = await seed("active");
    await recovery.reconcileStrandedAssignedIssues();
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.assigneeAgentId).toBe(participantId);
  });

  it("rechecks a stale issue snapshot under lock before reassigning its pending stage", async () => {
    const { issueId, recovery } = await seed("active", { ...stage, status: "changes_requested" });
    const [oldIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementationOnce(async (callback, config) => {
      await competingDb.update(issues).set({ executionState: stage }).where(eq(issues.id, issueId));
      return transaction(callback, config);
    });
    try {
      await recovery.escalateStrandedAssignedIssue({
        issue: oldIssue, previousStatus: "in_review", latestRun: null,
        recoveryCause: "execution_review_participant_recovery", recoveryOwnerAgentId: managerId,
      });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.assigneeAgentId).toBe(participantId);
    expect(issue.executionState).toMatchObject({ status: "pending", currentParticipant: participant });
  });
  it("does not assign an orphan blocker whose pending participant acquired the card after selection", async () => {
    const { issueId, companyId, recovery, enqueueWakeup } = await seed("active");
    const blockedId = randomUUID();
    await db.insert(issues).values({
      id: blockedId, companyId, title: "Blocked by review", status: "todo",
      issueNumber: 2, identifier: "PRR-2", assigneeAgentId: authorId,
    });
    await db.insert(issueRelations).values({
      companyId, issueId, relatedIssueId: blockedId, type: "blocks",
    });
    await db.update(issues).set({ status: "todo", assigneeAgentId: null }).where(eq(issues.id, issueId));
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementationOnce(async (callback, config) => {
      await competingDb.update(issues).set({ assigneeAgentId: participantId, executionState: stage })
        .where(eq(issues.id, issueId));
      return transaction(callback, config);
    });
    try {
      await recovery.reconcileStrandedAssignedIssues();
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.assigneeAgentId).toBe(participantId);
    expect(issue.executionState).toMatchObject({ status: "pending", currentParticipant: participant });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });
  it("lets the board reset a terminated participant's stage and hand the card to a live owner", async () => {
    const { issueId, companyId, recovery } = await seed("terminated");
    await recovery.reconcileStrandedAssignedIssues();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as typeof req & { actor: { type: "board"; source: "local_implicit" } }).actor = {
        type: "board", source: "local_implicit",
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never, {}));
    app.use(errorHandler);
    const response = await request(app).patch(`/api/issues/${issueId}`)
      .send({ status: "todo", assigneeAgentId: managerId });
    expect(response.status).toBe(200);
    const [issue] = await db.select().from(issues)
      .where(eq(issues.id, issueId));
    expect(issue).toMatchObject({
      companyId, status: "todo", assigneeAgentId: managerId, executionState: null,
    });
  });
});
