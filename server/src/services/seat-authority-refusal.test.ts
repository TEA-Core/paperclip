import { describe, expect, it } from "vitest";
import { LADDERED_CHILD_CARVE_OUT_LABEL_NAMES } from "./laddered-child-eligibility.js";
import {
  ancestorHatchNextAction,
  BOARD_CARVE_OUT_LABELS,
  CALLER_SEATS,
  mechanismDNextAction,
  RECORD_AND_ASK_BOARD,
  resolveCallerSeat,
  selfGatedLadderHasRun,
  selfGatedNextAction,
  selfSatisfyingAssigneeNextAction,
  stageHeldElsewhereNextAction,
} from "./seat-authority-refusal.js";

/**
 * 2026-10-02 board ruling (F1 server half): the seat-authority refusals must say
 * WHICH seat the caller holds and what that seat may lawfully do next. The
 * exec re-audit found 11 runs that read a seat-blind refusal tail ("add the
 * missing stages", "change the return assignee") as an instruction and worked
 * around the gate from a seat that could not lawfully fix it.
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
    // every approver is also the assignee. The close-ladder repair is the
    // board's, not the approver's (board ruling 2026-10-02 F1), so the stage
    // seat wins over the assignee seat.
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
  it("the board's carve-out labels are exactly the laddered-child carve-outs", () => {
    expect([...BOARD_CARVE_OUT_LABELS]).toEqual([...LADDERED_CHILD_CARVE_OUT_LABEL_NAMES]);
  });

  it("the shared tail says record on a card you own and ask the board", () => {
    expect(RECORD_AND_ASK_BOARD).toContain("on a card you own");
    expect(RECORD_AND_ASK_BOARD).toContain("ask the board");
    expect(RECORD_AND_ASK_BOARD).toMatch(/Do not re-send it/);
  });

  it("Mechanism D: a non-assignee seat is told it cannot repair the ladder and is pointed at the board's levers", () => {
    const text = mechanismDNextAction("currentParticipant");
    expect(text).toMatch(/^Your seat \(currentParticipant\) cannot lawfully repair this close ladder/);
    expect(text).toContain(RECORD_AND_ASK_BOARD);
    expect(text).toContain("rearmExecutionPolicy");
    expect(text).toContain("work-type:redo");
    expect(text).toContain("work-type:delivery");
    expect(text).not.toMatch(/Add (any|the) missing/);
  });

  // The text is persisted as the `[Terminal status refused]` record's Remedy line, which the
  // NEXT run reads, including the run the board's answer wakes. It must not forbid the one
  // lawful next step (control-plane-403.md §7: when the board answers, re-send once).
  it("Mechanism D: the no-second-close bar lasts until the board answers, then one re-send", () => {
    const text = mechanismDNextAction("currentParticipant");
    expect(text).toContain("no second close until the board answers");
    expect(text).toMatch(/Once the board reports the ladder repaired, re-send the refused close or verdict once\.$/);
  });

  // control-plane-403.md §7 / write-safety-core item 4: the one post-answer re-send is
  // the stage holder's. Every other seat records, asks the board, and does not re-send.
  for (const seat of ["assignee", "returnAssignee", "ancestor-hatch", "other"] as const) {
    it(`Mechanism D: ${seat} is not told to re-send after the board answers`, () => {
      const text = mechanismDNextAction(seat);
      expect(text).toContain(RECORD_AND_ASK_BOARD);
      expect(text).toContain("no second close from your seat");
      expect(text).not.toContain("until the board answers");
      expect(text).not.toMatch(/re-send the refused close/);
    });
  }

  it("stage held elsewhere: names the holder, says no write from this seat advances it, and leaves it to the participant", () => {
    const text = stageHeldElsewhereNextAction("returnAssignee", {
      stageType: "review",
      participant: { type: "agent", agentId: PARTICIPANT, userId: null },
    });
    expect(text).toContain("Your seat (returnAssignee) does not hold this review stage");
    expect(text).toContain(`agent ${PARTICIPANT} holds it`);
    // On approve the card goes to the next stage or stays with the approver; only a
    // changes_requested decision hands it back (issue-execution-policy.ts).
    expect(text).toContain("if it requests changes the card returns to you");
    expect(text).not.toContain("when it is decided");
    expect(text).toContain("on a card you own");
    // control-plane-403.md §7: its current participant owns it; no board ask from this seat.
    expect(text).not.toContain("ask the board");
    expect(text).toContain("the stage's participant decides it");
    expect(text).toContain("If you own no card in this run, write nothing more");
    const other = stageHeldElsewhereNextAction("other", { stageType: null, participant: null });
    expect(other).not.toContain("returns the card to you");
  });

  // Re-audit 3: the stage holder's own assignee-only / in_review write falls out
  // of its decision branch and reaches this refusal with seat currentParticipant.
  // It must not be told it does not hold the stage.
  it("the stage holder's non-verdict write is told it holds the stage and only its verdict moves it", () => {
    const text = stageHeldElsewhereNextAction("currentParticipant", {
      stageType: "review",
      participant: { type: "agent", agentId: PARTICIPANT, userId: null },
    });
    expect(text).not.toContain("does not hold");
    expect(text).toContain("Your seat (currentParticipant) holds this review stage");
    expect(text).toContain("only your decision moves it");
    expect(text).toContain("done with a comment approves");
    expect(text).toContain("blocked with a comment parks it");
    expect(text).toContain("Do not hand the card away");
    // applyIssueExecutionStageTransition: the holder's in_review with no assignee is
    // not a stage advance, so it is accepted (its inline comment lands); only an
    // assignee naming someone else, alone or with in_review, reaches this 422.
    expect(text).not.toContain("non-verdict in_review write is refused");
    expect(text).toContain("An assignee write naming anyone but you (alone or with in_review) is refused");
    expect(text).toContain("an in_review write without one is accepted and does not move the stage");
  });

  it("self-gated stage on a ladder that has run is terminal from every seat", () => {
    const text = selfGatedNextAction("assignee", { ladderHasRun: true });
    expect(text).toContain("already run");
    expect(text).toContain("games the gate");
    expect(text).toContain("Never drop the stage");
    expect(text).toContain(RECORD_AND_ASK_BOARD);
  });

  it("self-gated stage on a ladder that has run keeps the payload fix for a board caller (board rearm is a lever)", () => {
    const text = selfGatedNextAction("other", { ladderHasRun: true, boardActor: true });
    expect(text).toBe(
      "Give the stage a participant that is not the return assignee, or change the return assignee. Never drop the stage to make this pass.",
    );
    expect(selfGatedNextAction("other", { ladderHasRun: true, boardActor: false })).toContain("games the gate");
  });

  it("self-gated stage at attach time keeps the one lawful payload fix", () => {
    const text = selfGatedNextAction("assignee", { ladderHasRun: false });
    expect(text).toBe(
      "Give the stage a participant that is not the return assignee, or change the return assignee. Never drop the stage to make this pass.",
    );
  });

  it("selfGatedLadderHasRun reads completed, skipped or a current stage as run", () => {
    expect(selfGatedLadderHasRun(null)).toBe(false);
    expect(selfGatedLadderHasRun({ status: "idle", completedStageIds: [], skippedStageIds: [], currentStageId: null })).toBe(false);
    expect(selfGatedLadderHasRun({ completedStageIds: [STAGE] })).toBe(true);
    expect(selfGatedLadderHasRun({ skippedStageIds: [STAGE] })).toBe(true);
    expect(selfGatedLadderHasRun({ currentStageId: STAGE })).toBe(true);
  });

  it("self-satisfying assignee write: terminal for every seat, the assignee included (record and ask the board)", () => {
    const asAssignee = selfSatisfyingAssigneeNextAction("assignee", { stageId: STAGE });
    expect(asAssignee).toMatch(/^Your seat \(assignee\) cannot clear this/);
    expect(asAssignee).toContain("keep the card as it is");
    expect(asAssignee).toContain(RECORD_AND_ASK_BOARD);
    expect(asAssignee).toContain("Never re-point returnAssigneeAgentId");
    expect(asAssignee).not.toContain("hand the card to");
    const asOther = selfSatisfyingAssigneeNextAction("ancestor-hatch", { stageId: STAGE });
    expect(asOther).toMatch(/^Your seat \(ancestor-hatch\) cannot clear this/);
    expect(asOther).toContain(RECORD_AND_ASK_BOARD);
    expect(asOther).toContain("Never re-point returnAssigneeAgentId");
  });

  it("ancestor hatch: a live stage means no write from the hatch moves it; otherwise re-sending without the fields is not a fix", () => {
    const live = ancestorHatchNextAction({
      forbiddenFields: ["comment"],
      liveStage: { stageType: "approval", participant: { type: "agent", agentId: PARTICIPANT, userId: null } },
    });
    expect(live).toContain("live approval stage");
    expect(live).toContain(`agent ${PARTICIPANT}`);
    expect(live).toContain("with or without comment");
    expect(live).toContain("on a card you own");
    const none = ancestorHatchNextAction({ forbiddenFields: ["title", "comment"], liveStage: null });
    expect(none).toContain("title, comment");
    expect(none).toContain("re-sending the write without them does not reach the outcome");
    // control-plane-403 §7 / escalation.md: the assignment hop is the one lawful change of seat
    // on a card with no live stage, so this branch names it and does not forbid "another seat".
    expect(none).toContain("assignment hop");
    expect(none).toContain("ask the board");
    expect(none).not.toContain(RECORD_AND_ASK_BOARD);
    expect(none).not.toMatch(/route or seat/);
    expect(live).toContain("route or seat");
  });
});
