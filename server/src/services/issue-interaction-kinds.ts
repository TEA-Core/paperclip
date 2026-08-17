// SUP-11332. These sets are shared by the code that EXPIRES pending interactions
// when an issue goes terminal (issue-thread-interactions.ts) and the code that
// REFUSES a routine's own terminal transition while such interactions are still
// pending (issues.ts). They were duplicated, they disagreed, and the disagreement
// was the bug: the guard covered `request_confirmation` while the sweep silently
// expired three more kinds. One definition, so they cannot drift apart again.
//
// Deliberately importless: `issue-thread-interactions.ts` imports `issues.ts`, so
// anything either of them shares has to live outside that cycle.

export const REQUEST_CONFIRMATION_INTERACTION_KINDS = [
  "request_confirmation",
  "request_checkbox_confirmation",
  "request_board_approval",
] as const;

export const TARGET_BOUND_INTERACTION_KINDS = [
  ...REQUEST_CONFIRMATION_INTERACTION_KINDS,
  "request_item_verdicts",
] as const;

/**
 * Every kind that `expirePendingInteractionsForTerminalIssue` resolves to
 * `expired` / `expired_issue_terminal` when its issue reaches a terminal status.
 */
export const USER_COMMENT_SUPERSEDABLE_INTERACTION_KINDS = [
  ...TARGET_BOUND_INTERACTION_KINDS,
  "ask_user_questions",
] as const;
