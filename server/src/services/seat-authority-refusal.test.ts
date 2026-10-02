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

  it("names the return assignee from state, falling back to the policy", () => {
    expect(resolveCallerSeat({ agentId: RETURN_ASSIGNEE, userId: null }, pendingIssue())).toBe("returnAssignee");
    const policyOnly = pendingIssue({ executionState: null });
    expect(resolveCallerSeat({ agentId: RETURN_ASSIGNEE, userId: null }, policyOnly)).toBe("returnAssignee");
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

  it("stage held elsewhere: names the holder, says no write from this seat advances it, and keeps the board as the exception", () => {
    const text = stageHeldElsewhereNextAction("returnAssignee", {
      stageType: "review",
      participant: { type: "agent", agentId: PARTICIPANT, userId: null },
    });
    expect(text).toContain("Your seat (returnAssignee) does not hold this review stage");
    expect(text).toContain(`agent ${PARTICIPANT} holds it`);
    expect(text).toContain("returns the card to you");
    expect(text).toContain("on a card you own");
    expect(text).toContain("ask the board only if");
    const other = stageHeldElsewhereNextAction("other", { stageType: null, participant: null });
    expect(other).not.toContain("returns the card to you");
  });

  it("self-gated stage on a ladder that has run is terminal from every seat", () => {
    const text = selfGatedNextAction("assignee", { ladderHasRun: true });
    expect(text).toContain("already run");
    expect(text).toContain("games the gate");
    expect(text).toContain("Never drop the stage");
    expect(text).toContain(RECORD_AND_ASK_BOARD);
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

  it("self-satisfying assignee write: the assignee may pick another assignee; other seats record and ask the board", () => {
    const asAssignee = selfSatisfyingAssigneeNextAction("assignee", { stageId: STAGE });
    expect(asAssignee).toContain(`not a participant of stage ${STAGE}`);
    expect(asAssignee).toContain("Never re-point returnAssigneeAgentId");
    expect(asAssignee).not.toContain("ask the board");
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
    expect(none).toContain(RECORD_AND_ASK_BOARD);
  });
});
