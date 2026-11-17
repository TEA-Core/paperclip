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

export type ListExpiredQueuedRunsInput = {
  /** Runs created at or before this instant are past the queued-run age bound. */
  createdAtOrBefore: Date;
  limit: number;
  /** Keyset cursor: only runs ordered after this (createdAt, runId) pair. */
  after?: { createdAt: Date; runId: string };
};

export type ExpiredQueuedRunCandidate = DueRetryRun & { createdAt: Date };

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
