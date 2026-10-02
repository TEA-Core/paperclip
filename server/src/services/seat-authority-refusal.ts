/**
 * Caller-aware seat-authority refusals (board ruling 2026-10-02, F1 server half).
 *
 * Six refusals mean "no write from your seat reaches this outcome" rather than
 * "your payload was wrong": the done-transition guard's Mechanism D 409, the
 * stage machine's 422 "Only the active reviewer or approver can advance the
 * current execution stage", the two self-gated 422s ("... is gated solely by its
 * own return assignee" and "Refusing assigneeAgentId write: ...") and the 403
 * "Ancestor escape hatch only permits ...". Their tails used to be seat-blind:
 * every caller read the same "add the missing stages" / "change the return
 * assignee" remedy, and the 2026-09-30..10-02 exec re-audit found 11 runs that
 * took that tail as an instruction from a seat that could not lawfully follow it
 * (re-arms, returnAssignee re-points, courier cards, status-only closes).
 *
 * Contract kept by every caller of this module:
 *   - the existing message PREFIX is byte-identical (agent doctrine quotes it:
 *     paperclip-agent-tools doctrine/control-plane-403.md §7, and
 *     scripts/paperclip-transition.sh matches it);
 *   - `details.callerSeat` is one of {@link CALLER_SEATS};
 *   - `details.nextAction` is the seat-specific next-action sentence, and the
 *     same sentence follows the prefix in the message, so an agent that reads
 *     only `error` still gets it;
 *   - when the caller's seat CAN lawfully act (any writer of a policy that has
 *     not run yet on the self-gated 422, a board user on the self-gated 422 and
 *     on Mechanism D) the existing remedy is kept unchanged. Close-ladder
 *     repair is the board's: an agent assignee gets the record-and-ask text
 *     like every other agent seat.
 *
 * This module is pure: no DB, no imports from the policy service (which imports
 * it), so it cannot form an import cycle.
 */

export const CALLER_SEATS = [
  "assignee",
  "currentParticipant",
  "returnAssignee",
  "ancestor-hatch",
  "other",
] as const;

export type CallerSeat = (typeof CALLER_SEATS)[number];

export interface RefusalCaller {
  agentId?: string | null;
  userId?: string | null;
  /** The route authorized this write only through the org-chain ancestor escape hatch. */
  viaAncestorHatch?: boolean;
}

export interface RefusalIssue {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  executionState?: unknown;
  executionPolicy?: unknown;
}

export interface RefusalPrincipal {
  type?: string | null;
  agentId?: string | null;
  userId?: string | null;
}

/**
 * The carve-out labels that take a child out of the laddered-child count. Kept as
 * a literal here (not imported) so this module stays dependency-free; the
 * equality with laddered-child-eligibility.ts is pinned by
 * seat-authority-refusal.test.ts.
 */
export const BOARD_CARVE_OUT_LABELS = [
  "work-type:redo",
  "work-type:delivery",
  "work-type:architecture-review",
  "work-type:process",
  "work-type:recovery",
] as const;

/** The shared terminal tail: where the record goes and who decides. */
export const RECORD_AND_ASK_BOARD =
  "Record this refusal (its message and details) on a card you own and ask the board. " +
  "Do not re-send it, re-shape it, or reach the same outcome through another field, card, route or seat.";

function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && a.length > 0 && a === b;
}

function principalMatches(caller: RefusalCaller, principal: RefusalPrincipal | null | undefined): boolean {
  if (!principal || typeof principal !== "object") return false;
  return sameId(caller.agentId, principal.agentId) || sameId(caller.userId, principal.userId);
}

function readState(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function readPrincipal(raw: unknown): RefusalPrincipal | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as RefusalPrincipal) : null;
}

/** The live stage, if the workflow is pending on one. A completed workflow's leftover participant is not live. */
export function liveStageOf(issue: RefusalIssue | null | undefined): {
  stageId: string;
  stageType: string | null;
  participant: RefusalPrincipal | null;
} | null {
  const state = readState(issue?.executionState);
  if (!state) return null;
  if (state.status !== "pending") return null;
  const stageId = typeof state.currentStageId === "string" && state.currentStageId ? state.currentStageId : null;
  if (!stageId) return null;
  return {
    stageId,
    stageType: typeof state.currentStageType === "string" ? state.currentStageType : null,
    participant: readPrincipal(state.currentParticipant),
  };
}

/**
 * Same order as resolveReturnAssignee in issue-execution-policy.ts, which decides
 * where a changes_requested sends the card: the policy's returnAssigneeAgentId
 * first, then executionState.returnAssignee. They differ when the policy is
 * re-pointed after the stage armed (a37e3e65 / SUP-18002).
 */
function returnAssigneeOf(issue: RefusalIssue): RefusalPrincipal | null {
  const policy = readState(issue.executionPolicy);
  const declared = policy?.returnAssigneeAgentId;
  if (typeof declared === "string" && declared) return { type: "agent", agentId: declared, userId: null };
  const state = readState(issue.executionState);
  const fromState = readPrincipal(state?.returnAssignee);
  return fromState && (fromState.agentId || fromState.userId) ? fromState : null;
}

/**
 * The caller's seat on the refused issue. Precedence:
 *   currentParticipant > assignee > returnAssignee > ancestor-hatch > other.
 *
 * The live-stage seat wins over the assignee seat on purpose. In `in_review`
 * the stage machine assigns the card to its current participant, so every
 * approver is also the assignee, and the live-stage texts (who decides the
 * stage) apply to it. "assignee" therefore means "holds the card and no live
 * stage on it". Under the 2026-10-02 ruling neither seat repairs a close
 * ladder; the board does.
 */
export function resolveCallerSeat(caller: RefusalCaller, issue: RefusalIssue | null | undefined): CallerSeat {
  if (!issue) return caller.viaAncestorHatch ? "ancestor-hatch" : "other";
  const live = liveStageOf(issue);
  if (live && principalMatches(caller, live.participant)) return "currentParticipant";
  if (sameId(caller.agentId, issue.assigneeAgentId) || sameId(caller.userId, issue.assigneeUserId)) {
    return "assignee";
  }
  if (principalMatches(caller, returnAssigneeOf(issue))) return "returnAssignee";
  if (caller.viaAncestorHatch) return "ancestor-hatch";
  return "other";
}

export function describePrincipal(principal: RefusalPrincipal | null | undefined): string {
  if (principal?.agentId) return `agent ${principal.agentId}`;
  if (principal?.userId) return `user ${principal.userId}`;
  return "its participant";
}

/** Mechanism D (ADR-072 close-ladder shape) 409, for every agent seat, the assignee included. */
export function mechanismDNextAction(seat: CallerSeat): string {
  return (
    `Your seat (${seat}) cannot lawfully repair this close ladder: no re-arm, no added or reordered stage, ` +
    "no relabelled or re-parented child, no courier card, and no second close until the board answers. " +
    `${RECORD_AND_ASK_BOARD} The board's levers are a carve-out label ` +
    `(${BOARD_CARVE_OUT_LABELS.join(", ")}) on a child that is not decomposition work, ` +
    "or a board rearmExecutionPolicy with the full close ladder. " +
    // Persisted as the thread record's Remedy line, which the run the board's answer
    // wakes reads first: it must not forbid that run's one lawful write.
    "Once the board reports the ladder repaired, re-send the refused close or verdict once."
  );
}

/** Appended to the assignee/board remedy for a board caller, who holds the levers itself. */
export function mechanismDBoardNote(): string {
  return (
    "As a board user you also hold the carve-out labels " +
    `(${BOARD_CARVE_OUT_LABELS.join(", ")}) and rearmExecutionPolicy.`
  );
}

/** 422 "Only the active reviewer or approver can advance the current execution stage". */
export function stageHeldElsewhereNextAction(
  seat: CallerSeat,
  stage: { stageType: string | null; participant: RefusalPrincipal | null },
): string {
  const stageName = stage.stageType ? `${stage.stageType} stage` : "stage";
  if (seat === "currentParticipant") {
    // The holder reaches this refusal only with an assignee write naming someone
    // else, alone or with in_review (its decision branch handles done, blocked
    // and every other status). Its in_review with no assignee is not a stage
    // advance: it is accepted, its inline comment lands, and the stage stays.
    return (
      `Your seat (currentParticipant) holds this ${stageName}, and only your decision moves it: ` +
      "done with a comment approves; todo, in_progress or cancelled with a comment requests changes; " +
      "blocked with a comment parks it. An assignee write naming anyone but you (alone or with in_review) is refused; " +
      "an in_review write without one is accepted and does not move the stage. " +
      "Do not hand the card away."
    );
  }
  const returns =
    // Only a changes_requested decision hands the card back: an approve moves it to the
    // next stage's participant or completes the workflow with the approver.
    seat === "returnAssignee" ? ", and if it requests changes the card returns to you" : "";
  return (
    `Your seat (${seat}) does not hold this ${stageName}; ${describePrincipal(stage.participant)} holds it${returns}. ` +
    "No status or assignee write from your seat advances it. Record this refusal (its message and details) on a " +
    "card you own; ask the board only if the stage must move without its participant's decision. " +
    "Do not re-send it, re-shape it, or reach the same outcome through another field, card, route or seat."
  );
}

/** True when the issue's ladder has run: a stage completed or skipped, or a current stage is set. */
export function selfGatedLadderHasRun(executionState: unknown): boolean {
  const state = readState(executionState);
  if (!state) return false;
  const nonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0;
  if (nonEmpty(state.completedStageIds) || nonEmpty(state.skippedStageIds)) return true;
  return typeof state.currentStageId === "string" && state.currentStageId.length > 0;
}

/** The attach-time tail of the self-gated 422, unchanged since SUP-13531. */
export const SELF_GATED_ATTACH_TIME_REMEDY =
  "Give the stage a participant that is not the return assignee, or change the return assignee. " +
  "Never drop the stage to make this pass.";

/**
 * 422 "Execution policy stage <n> (<type>) is gated solely by its own return assignee ...".
 * A board user keeps the payload fix on a ladder that has run too: a board
 * rearmExecutionPolicy is one of the board's own close-ladder levers.
 */
export function selfGatedNextAction(
  seat: CallerSeat,
  ctx: { ladderHasRun: boolean; boardActor?: boolean },
): string {
  if (!ctx.ladderHasRun || ctx.boardActor) return SELF_GATED_ATTACH_TIME_REMEDY;
  return (
    "This issue's ladder has already run, so this is not a payload fix: changing a participant or the return " +
    `assignee now to pass this check games the gate, from any seat (yours: ${seat}). Never drop the stage. ` +
    RECORD_AND_ASK_BOARD
  );
}

/** 422 "Refusing assigneeAgentId write: ..." (self-satisfiable review stage). */
export function selfSatisfyingAssigneeNextAction(seat: CallerSeat, ctx: { stageId: string }): string {
  const noGaming =
    "Never re-point returnAssigneeAgentId or change the stage's participants to pass this check.";
  // control-plane-403 §7: this refusal is terminal at the first refusal for every
  // seat; re-picking the assignee is a re-shape, not a payload fix.
  const keep =
    seat === "assignee"
      ? `: keep the card as it is (stage ${ctx.stageId} hands the card to its own participant when the work enters review)`
      : "";
  return `Your seat (${seat}) cannot clear this${keep}. ${RECORD_AND_ASK_BOARD} ${noGaming}`;
}

/** 403 "Ancestor escape hatch only permits ...". */
export function ancestorHatchNextAction(input: {
  forbiddenFields: string[];
  liveStage: { stageType: string | null; participant: RefusalPrincipal | null } | null;
}): string {
  const fields = input.forbiddenFields.join(", ");
  if (input.liveStage) {
    const stageName = input.liveStage.stageType ? `${input.liveStage.stageType} stage` : "stage";
    return (
      `Your seat (ancestor-hatch): this issue has a live ${stageName} held by ` +
      `${describePrincipal(input.liveStage.participant)}, and no write from your seat moves it, with or without ` +
      `${fields}. Record this refusal (its message and details) on a card you own; the stage's participant ` +
      "decides it. Do not re-send it, re-shape it, or reach the same outcome through another field, card, route or seat."
    );
  }
  // No live stage: escalation.md keeps the assignment hop (assigneeAgentId set to
  // yourself, then the write as the assignee) as the one lawful change of seat, so
  // this branch names it and does not forbid "another seat".
  return (
    `Your seat (ancestor-hatch) cannot write ${fields} on this issue, and re-sending the write without them does ` +
    "not reach the outcome they were for. The only change of seat is the assignment hop: take the card over as its " +
    "assignee (a PATCH of assigneeAgentId to yourself and nothing else), then make the write as the assignee. " +
    "Otherwise record this refusal (its message and details) on a card you own and ask the board. " +
    "Do not re-send it, re-shape it, or reach the same outcome through another field, card or route."
  );
}
