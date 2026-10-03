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
 *   - `details.nextAction` is the tail that follows the prefix in the message,
 *     so an agent that reads only `error` still gets it. A new caller-aware tail
 *     is a seat label plus a POINTER to the owning doctrine section, never a
 *     restatement of its rule (board ruling 2026-10-02: a restated rule drifts
 *     from the doctrine it copies; a pointer does not);
 *   - a board caller keeps the existing base text, and so does an agent
 *     assignee on Mechanism D (its ADR-103 remedy is unchanged).
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

/** The owning doctrine section every new caller-aware tail points to. */
export const SEAT_AUTHORITY_SECTION = "control-plane-403.md §7";

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
 * approver is also the assignee, and the live-stage seat is the one that
 * tells it what it holds. "assignee" therefore means "holds the card and no
 * live stage on it".
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

/** The caller-aware tail of every seat-authority refusal: the seat, then the pointer. */
export function seatAuthorityNextAction(seat: CallerSeat): string {
  return `Your seat: ${seat}. This is a seat-authority refusal: see ${SEAT_AUTHORITY_SECTION} for the next step.`;
}

/** True when the issue's ladder has run: a stage completed or skipped, or a current stage is set. */
export function selfGatedLadderHasRun(executionState: unknown): boolean {
  const state = readState(executionState);
  if (!state) return false;
  const nonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0;
  if (nonEmpty(state.completedStageIds) || nonEmpty(state.skippedStageIds)) return true;
  return typeof state.currentStageId === "string" && state.currentStageId.length > 0;
}

/** The attach-time tail of the self-gated 422, unchanged since SUP-13531. A board caller always keeps it. */
export const SELF_GATED_ATTACH_TIME_REMEDY =
  "Give the stage a participant that is not the return assignee, or change the return assignee. " +
  "Never drop the stage to make this pass.";

/**
 * 422 "Execution policy stage <n> (<type>) is gated solely by its own return assignee ...".
 * Before any stage has run it is a payload error, not a seat-authority refusal,
 * so an agent's tail says that and points to the same section, whose table row
 * names the one fix.
 */
export function selfGatedNextAction(
  seat: CallerSeat,
  ctx: { ladderHasRun: boolean; boardActor?: boolean },
): string {
  if (ctx.boardActor) return SELF_GATED_ATTACH_TIME_REMEDY;
  if (!ctx.ladderHasRun) {
    return `Your seat: ${seat}. No stage has run yet, so this is a payload error: see ${SEAT_AUTHORITY_SECTION} for its one fix.`;
  }
  return seatAuthorityNextAction(seat);
}
