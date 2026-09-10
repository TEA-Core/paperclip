// SUP-15552 / D1 of SUP-15551 (ADR-096): a wake skipped for a transient,
// instance-level condition is a DEFERRAL, not a drop. The class is decided by
// what the skip reason describes — the instance (re-drive once it clears) vs
// the work or the agent (stay terminal).
//
// This lives in its own module rather than in heartbeat.ts because both the
// write side (heartbeat.ts, which records the skip) and the replay side
// (recovery/service.ts, which re-drives it) need the classification, and
// heartbeat.ts already imports recovery/service.js — importing back would be a
// runtime cycle. One module, one source of truth, no cycle.
//
// Exhaustiveness (acceptance #4) is enforced in two directions:
//   - `WAKE_SKIP_CLASSIFICATION` is a `Record<WakeSkipReason, WakeSkipClass>`,
//     so adding a member to the union without classifying it fails typecheck.
//   - `writeSkippedRequest` in heartbeat.ts takes `WakeSkipReason`, not
//     `string`, so introducing a new skip reason at a call site without adding
//     it to the union fails typecheck.
// An unclassified reason therefore cannot reach the table at all, which is the
// guard against this defect recurring by silently defaulting to terminal.

export type WakeSkipReason =
  | "heartbeat.scheduling_suppressed"
  | "heartbeat.worktree_execution_cutoff"
  | "budget.blocked"
  | "agent.not_invokable"
  | "heartbeat.disabled"
  | "heartbeat.wakeOnDemand.disabled"
  | "company.inactive"
  | "issue_tree_hold_active"
  | "heartbeat.timer.all_work_leased"
  | "heartbeat.timer.no_actionable_work";

export type WakeSkipClass = "deferrable" | "terminal";

export const WAKE_SKIP_CLASSIFICATION: Record<WakeSkipReason, WakeSkipClass> = {
  // Describes the INSTANCE — the transient condition that suppressed dispatch
  // will clear, so the wake must be re-driven, not destroyed.
  "heartbeat.scheduling_suppressed": "deferrable",
  "heartbeat.worktree_execution_cutoff": "deferrable",
  "budget.blocked": "deferrable",
  // Describes the WORK or the AGENT — re-driving cannot help while the state
  // persists, so it stays terminal exactly as before.
  "agent.not_invokable": "terminal",
  "heartbeat.disabled": "terminal",
  "heartbeat.wakeOnDemand.disabled": "terminal",
  "company.inactive": "terminal",
  "issue_tree_hold_active": "terminal",
  "heartbeat.timer.all_work_leased": "terminal",
  "heartbeat.timer.no_actionable_work": "terminal",
};

// Derived from the record rather than written out a second time, so the replay
// sweep's candidate filter cannot drift from the classification.
export const DEFERRABLE_WAKE_SKIP_REASONS: readonly WakeSkipReason[] = (
  Object.keys(WAKE_SKIP_CLASSIFICATION) as WakeSkipReason[]
).filter((reason) => WAKE_SKIP_CLASSIFICATION[reason] === "deferrable");

export function wakeSkipClassForReason(reason: string | null | undefined): WakeSkipClass | null {
  if (typeof reason !== "string" || !Object.hasOwn(WAKE_SKIP_CLASSIFICATION, reason)) return null;
  return WAKE_SKIP_CLASSIFICATION[reason as WakeSkipReason];
}

// Fails safe: an unrecognised reason is NOT deferrable, so it stays terminal
// exactly as it does today rather than becoming a forever-pending row.
export function isDeferrableWakeSkipReason(reason: string | null | undefined): boolean {
  return wakeSkipClassForReason(reason) === "deferrable";
}

// Which card a deferred wake belongs to, as recorded in `payload` — the single
// source of truth for that derivation (SUP-15552 review round 3).
//
// Three writers name the card in three places and all of them are load-bearing:
//   - `issueId`               — the ordinary issue-bound wake payload;
//   - `taskId`                — the interchangeable spelling `enrichWakeContextSnapshot` accepts;
//   - `heartbeatSkip.issueId` — the ONLY place the card appears when the caller
//                               passed it through `contextSnapshot` instead of
//                               `payload` and a skip site resolved the issue
//                               itself (both worktree-cutoff sites do this).
//
// Every consumer of "which card is this wake for" MUST derive it from this
// list. Two consumers deriving it two ways is this card's own defect class:
// round 2 was a write that bypassed the classification, round 3 was the
// coalescing predicate reading `payload ->> 'issueId'` while the writer stored
// the card under `heartbeatSkip.issueId` — which silently merged two different
// cards' deferred wakes onto one row and destroyed the second card's signal.
// The paths are exported so the SQL predicate is built from the same list the
// TypeScript reader walks and the two cannot drift.
export const WAKE_ISSUE_ID_PAYLOAD_PATHS: readonly (readonly string[])[] = [
  ["issueId"],
  ["taskId"],
  ["heartbeatSkip", "issueId"],
];

function readNonEmptyStringAt(value: unknown, path: readonly string[]): string | null {
  let cursor: unknown = value;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (typeof cursor !== "string") return null;
  const trimmed = cursor.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readWakeIssueIdFromPayload(payload: unknown): string | null {
  for (const path of WAKE_ISSUE_ID_PAYLOAD_PATHS) {
    const found = readNonEmptyStringAt(payload, path);
    if (found) return found;
  }
  return null;
}
