import { describe, expect, it } from "vitest";
import {
  CALLER_SEATS,
  resolveCallerSeat,
  SEAT_AUTHORITY_SECTION,
  SELF_GATED_ATTACH_TIME_REMEDY,
  seatAuthorityNextAction,
  selfGatedLadderHasRun,
  selfGatedNextAction,
} from "./seat-authority-refusal.js";

/**
 * 2026-10-02 board ruling (F1 server half): the seat-authority refusals must say
 * WHICH seat the caller holds. The exec re-audit found 11 runs that read a
 * seat-blind refusal tail ("add the missing stages", "change the return
 * assignee") as an instruction and worked around the gate from a seat that
 * could not lawfully fix it. The tail is a seat label plus a pointer to the
 * owning doctrine section, never a restatement of its rule (pointer principle,
 * board ruling 2026-10-02).
 */

const ASSIGNEE = "11111111-1111-4111-8111-111111111111";
const PARTICIPANT = "22222222-2222-4222-8222-222222222222";
const RETURN_ASSIGNEE = "33333333-3333-4333-8333-333333333333";
const STRANGER = "44444444-4444-4444-8444-444444444444";
const STAGE = "55555555-5555-4555-8555-555555555555";

function pendingIssue(overrides: Record<string, unknown> = {}) {
  return {
    assigneeAgentId: ASSIGNEE,
    assigneeUserId: null,
    executionPolicy: { returnAssigneeAgentId: RETURN_ASSIGNEE, stages: [] },
    executionState: {
      status: "pending",
      currentStageId: STAGE,
      currentStageType: "approval",
      currentParticipant: { type: "agent", agentId: PARTICIPANT, userId: null },
      returnAssignee: { type: "agent", agentId: RETURN_ASSIGNEE, userId: null },
      completedStageIds: [],
      skippedStageIds: [],
    },
    ...overrides,
  };
}

describe("resolveCallerSeat", () => {
  it("exposes exactly the ruled seat vocabulary", () => {
    expect([...CALLER_SEATS]).toEqual([
      "assignee",
      "currentParticipant",
      "returnAssignee",
      "ancestor-hatch",
      "other",
    ]);
  });

  it("names the holder of a live stage currentParticipant", () => {
    expect(resolveCallerSeat({ agentId: PARTICIPANT, userId: null }, pendingIssue())).toBe("currentParticipant");
  });

  it("an approver holding the live stage is currentParticipant even when it is also the assignee", () => {
    // In in_review the stage machine assigns the card to its participant, so
    // every approver is also the assignee; the live-stage seat wins.
    const issue = pendingIssue({ assigneeAgentId: PARTICIPANT });
    expect(resolveCallerSeat({ agentId: PARTICIPANT, userId: null }, issue)).toBe("currentParticipant");
  });

  it("names the assignee when no live stage is held by the caller", () => {
    expect(resolveCallerSeat({ agentId: ASSIGNEE, userId: null }, pendingIssue())).toBe("assignee");
    const done = pendingIssue({
      executionState: { status: "completed", currentStageId: null, currentParticipant: null, returnAssignee: null },
    });
    expect(resolveCallerSeat({ agentId: ASSIGNEE, userId: null }, done)).toBe("assignee");
  });

  it("a completed workflow's stale currentParticipant is not a live stage seat", () => {
    const completed = pendingIssue({
      executionState: {
        status: "completed",
        currentStageId: null,
        currentParticipant: { type: "agent", agentId: PARTICIPANT, userId: null },
      },
    });
    expect(resolveCallerSeat({ agentId: PARTICIPANT, userId: null }, completed)).toBe("other");
  });

  // The card goes where resolveReturnAssignee (issue-execution-policy.ts) sends it:
  // policy.returnAssigneeAgentId first, then executionState.returnAssignee.
  it("names the return assignee from the policy, falling back to state", () => {
    expect(resolveCallerSeat({ agentId: RETURN_ASSIGNEE, userId: null }, pendingIssue())).toBe("returnAssignee");
    const policyOnly = pendingIssue({ executionState: null });
    expect(resolveCallerSeat({ agentId: RETURN_ASSIGNEE, userId: null }, policyOnly)).toBe("returnAssignee");
    const stateOnly = pendingIssue({ executionPolicy: { stages: [] } });
    expect(resolveCallerSeat({ agentId: RETURN_ASSIGNEE, userId: null }, stateOnly)).toBe("returnAssignee");
  });

  it("when the policy was re-pointed after the stage armed, the policy's return assignee wins (a37e3e65 shape)", () => {
    const repointed = pendingIssue({ executionPolicy: { returnAssigneeAgentId: STRANGER, stages: [] } });
    expect(resolveCallerSeat({ agentId: STRANGER, userId: null }, repointed)).toBe("returnAssignee");
    expect(resolveCallerSeat({ agentId: RETURN_ASSIGNEE, userId: null }, repointed)).toBe("other");
  });

  it("names a write that travelled the ancestor escape hatch ancestor-hatch", () => {
    expect(
      resolveCallerSeat({ agentId: STRANGER, userId: null, viaAncestorHatch: true }, pendingIssue()),
    ).toBe("ancestor-hatch");
  });

  it("falls back to other, and never matches null ids to each other", () => {
    expect(resolveCallerSeat({ agentId: STRANGER, userId: null }, pendingIssue())).toBe("other");
    expect(resolveCallerSeat({ agentId: null, userId: null }, pendingIssue({ assigneeAgentId: null }))).toBe("other");
    expect(resolveCallerSeat({ agentId: STRANGER, userId: null }, null)).toBe("other");
  });

  it("matches board users by userId", () => {
    expect(
      resolveCallerSeat({ agentId: null, userId: "board-1" }, pendingIssue({ assigneeAgentId: null, assigneeUserId: "board-1" })),
    ).toBe("assignee");
  });
});

describe("next-action sentences", () => {
  const POINTER = "This is a seat-authority refusal: see control-plane-403.md §7 for the next step.";

  it("points to control-plane-403.md §7", () => {
    expect(SEAT_AUTHORITY_SECTION).toBe("control-plane-403.md §7");
  });

  for (const seat of CALLER_SEATS) {
    it(`${seat}: the tail is exactly the seat label plus the pointer`, () => {
      expect(seatAuthorityNextAction(seat)).toBe(`Your seat: ${seat}. ${POINTER}`);
    });
  }

  it("restates no doctrine rule: no remedy, owner or forbidden-workaround text", () => {
    for (const seat of CALLER_SEATS) {
      const text = seatAuthorityNextAction(seat);
      for (const restated of ["ask the board", "re-send", "rearmExecutionPolicy", "work-type:", "assignment hop", "unblockDescriptor", "hand the card"]) {
        expect(text).not.toContain(restated);
      }
    }
  });

  it("self-gated stage on a ladder that has run: the seat-authority pointer for every agent seat", () => {
    for (const seat of CALLER_SEATS) {
      expect(selfGatedNextAction(seat, { ladderHasRun: true })).toBe(seatAuthorityNextAction(seat));
    }
  });

  it("self-gated stage at attach time: an agent is told it is a payload error and pointed to the same section", () => {
    const text = selfGatedNextAction("other", { ladderHasRun: false });
    expect(text).toBe("Your seat: other. No stage has run yet, so this is a payload error: see control-plane-403.md §7 for its one fix.");
    expect(text).not.toContain("Give the stage a participant");
    expect(text).not.toContain("seat-authority refusal");
  });

  it("a board caller keeps the base remedy, whether or not the ladder has run (board rearm is a lever)", () => {
    expect(SELF_GATED_ATTACH_TIME_REMEDY).toBe(
      "Give the stage a participant that is not the return assignee, or change the return assignee. Never drop the stage to make this pass.",
    );
    for (const ladderHasRun of [false, true]) {
      expect(selfGatedNextAction("other", { ladderHasRun, boardActor: true })).toBe(SELF_GATED_ATTACH_TIME_REMEDY);
    }
  });

  it("selfGatedLadderHasRun reads completed, skipped or a current stage as run", () => {
    expect(selfGatedLadderHasRun(null)).toBe(false);
    expect(selfGatedLadderHasRun({ status: "idle", completedStageIds: [], skippedStageIds: [], currentStageId: null })).toBe(false);
    expect(selfGatedLadderHasRun({ completedStageIds: [STAGE] })).toBe(true);
    expect(selfGatedLadderHasRun({ skippedStageIds: [STAGE] })).toBe(true);
    expect(selfGatedLadderHasRun({ currentStageId: STAGE })).toBe(true);
  });
});
