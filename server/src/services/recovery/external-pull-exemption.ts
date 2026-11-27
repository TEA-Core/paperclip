// Fork (two-fleet routing): an agent that declares `external_pull` work
// delivery runs outside Paperclip and pulls its own queue, so a card it has
// parked is not stranded. The stillborn-backlog sweep, the stranded-assigned
// sweep and the exhausted-recovery drain use this one decision for such a card.
//
// The exemption is narrow on purpose:
// - Only parked statuses are exempt from detection. A card the pull agent
//   holds in `todo` or `in_progress` is still detected, but goes to the board.
// - Only a live owner is exempt. A paused, terminated or pending-approval owner
//   pulls nothing.
// - The exemption expires. A parked card with no activity by anyone but the
//   owner for EXTERNAL_PULL_RECOVERY_EXEMPTION_MAX_AGE_MS is surfaced again.
//   The owner's own comments do not reset the clock.
// - The board can clear the exemption for one card.
// When the exemption does not hold for one of those reasons, the card goes to
// the board only. This board-owned hold is the intended design: recovery
// never re-homes a pull agent's card onto another agent, and it does not
// resume automatic recovery for it.

export const EXTERNAL_PULL_RECOVERY_EXEMPT_STATUSES: ReadonlySet<string> = new Set([
  "backlog",
  "blocked",
  "in_review",
]);

export const EXTERNAL_PULL_RECOVERY_EXEMPTION_MAX_AGE_MS = 72 * 60 * 60 * 1000;

/** Activity action that records a board override for one card. */
export const EXTERNAL_PULL_RECOVERY_EXEMPTION_CLEARED_ACTION =
  "issue.external_pull_recovery_exemption_cleared";

export type ExternalPullRecoveryBoardOnlyReason =
  | "owner_not_invokable"
  | "active_card"
  | "exemption_expired"
  | "board_cleared";

export const EXTERNAL_PULL_RECOVERY_NOTICE_REASONS: Readonly<
  Record<ExternalPullRecoveryBoardOnlyReason | "recovery_exhausted", string>
> = {
  owner_not_invokable: "the assignee is paused, terminated or pending approval, so it cannot pull this card.",
  active_card: "this active card has no live execution path.",
  exemption_expired: "this parked card has had no activity within the recovery exemption window.",
  board_cleared: "the board cleared the recovery exemption for this card.",
  recovery_exhausted: "automatic recovery for this card is exhausted.",
};

export type ExternalPullRecoveryExemption =
  | { kind: "none" }
  | { kind: "exempt" }
  | { kind: "board_only"; reason: ExternalPullRecoveryBoardOnlyReason };

export interface ExternalPullRecoveryExemptionFacts {
  /** The owner declares `external_pull` work delivery and is in the card's company. */
  ownerIsExternalPull: boolean;
  /** The owner's status lets it work (`isAgentStatusInvokable`). */
  ownerStatusInvokable: boolean;
  issueStatus: string;
  /** The latest activity by anyone but the owner, or the card's creation. */
  lastActivityAt: Date;
  /** A board override cleared the exemption for this card. */
  boardCleared: boolean;
  now: Date;
}

export function isExternalPullRecoveryExemptStatus(status: string): boolean {
  return EXTERNAL_PULL_RECOVERY_EXEMPT_STATUSES.has(status);
}

// Pure. `none` means normal recovery; `exempt` means skip the card;
// `board_only` means surface it to the board without any agent owner.
export function decideExternalPullRecoveryExemption(
  facts: ExternalPullRecoveryExemptionFacts,
): ExternalPullRecoveryExemption {
  if (!facts.ownerIsExternalPull) return { kind: "none" };
  if (!facts.ownerStatusInvokable) return { kind: "board_only", reason: "owner_not_invokable" };
  if (!isExternalPullRecoveryExemptStatus(facts.issueStatus)) return { kind: "board_only", reason: "active_card" };
  if (facts.boardCleared) return { kind: "board_only", reason: "board_cleared" };
  if (facts.now.getTime() - facts.lastActivityAt.getTime() >= EXTERNAL_PULL_RECOVERY_EXEMPTION_MAX_AGE_MS) {
    return { kind: "board_only", reason: "exemption_expired" };
  }
  return { kind: "exempt" };
}
