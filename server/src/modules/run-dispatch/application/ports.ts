import type { GateDecision } from "../domain/policy.js";
import type {
  CancelStaleQueuedRunOutcome,
  PromoteScheduledRetryOutcome,
} from "./types.js";

export type DueRetryRun = {
  runId: string;
  companyId: string;
};

export type ListDueRetriesInput = {
  now: Date;
  cutoff: Date | null;
  limit: number;
};

export type EvaluateScheduledRetryGateInput = {
  runId: string;
  companyId: string;
  retryReasonOverride: string;
  now: Date;
};

/** Read-only scheduled-retry operations exposed to application use cases. */
export interface ScheduledRetryReader {
  evaluateScheduledRetryGate(input: EvaluateScheduledRetryGateInput): Promise<GateDecision>;
  listDueRetries(input: ListDueRetriesInput): Promise<DueRetryRun[]>;
}

export type PromoteOrCancelDueRetryInput = {
  runId: string;
  companyId: string;
  now: Date;
};

export type CancelStaleQueuedRunInput = {
  runId: string;
  companyId: string;
  now: Date;
  expectedStatus: "queued" | "running";
  worktreeExecutionCutoff?: Date | null;
};

export type DispatchResolvedInteractionInput<T> = CancelStaleQueuedRunInput & {
  dispatch: (markDispatchStarted: () => void) => Promise<T>;
};

export type DispatchResolvedInteractionOutcome<T> =
  | { dispatched: true; resultPromise: Promise<T> }
  | { dispatched: false; cancellation: CancelStaleQueuedRunOutcome };

/** Semantic database operations; persistence rows and transaction handles stay inside the adapter. */
export interface RunDispatchWriter {
  promoteOrCancelDueRetry(input: PromoteOrCancelDueRetryInput): Promise<PromoteScheduledRetryOutcome>;
  cancelStaleQueuedRun(input: CancelStaleQueuedRunInput): Promise<CancelStaleQueuedRunOutcome>;
  dispatchResolvedInteractionIfCurrent<T>(
    input: DispatchResolvedInteractionInput<T>,
  ): Promise<DispatchResolvedInteractionOutcome<T>>;
}

/**
 * Keyset position of a listed run. `createdAtText` is the database's own text
 * form of `created_at` (microsecond precision with offset), so the next page
 * compares against the exact stored value; a JavaScript Date would truncate it
 * to milliseconds and re-select every run sharing that millisecond.
 */
export type ExpiredQueuedRunCursor = { createdAtText: string; runId: string };

export type ListExpiredQueuedRunsInput = {
  /** Runs created at or before this instant are past the queued-run age bound. */
  createdAtOrBefore: Date;
  limit: number;
  /** Only runs ordered strictly after this (created_at, id) position. */
  after?: ExpiredQueuedRunCursor;
};

export type ExpiredQueuedRunCandidate = DueRetryRun & { cursor: ExpiredQueuedRunCursor };

export type ExpireQueuedRunInput = {
  runId: string;
  companyId: string;
  now: Date;
};

/**
 * The queued-run age bound: lists issue-bound runs still `queued` past the
 * bound and terminalizes one under the same issue -> run locks the claim and
 * stale-run gates take.
 */
export interface QueuedRunExpiry {
  listExpiredQueuedRuns(input: ListExpiredQueuedRunsInput): Promise<ExpiredQueuedRunCandidate[]>;
  expireQueuedRun(input: ExpireQueuedRunInput): Promise<CancelStaleQueuedRunOutcome>;
}
