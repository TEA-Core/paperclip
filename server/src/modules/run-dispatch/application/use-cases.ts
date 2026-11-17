import { MAX_QUEUED_ISSUE_RUN_AGE_MS } from "../domain/policy.js";
import type { QueuedRunExpiry, RunDispatchWriter, ScheduledRetryReader } from "./ports.js";
import type { PostCommitEffect, PromoteScheduledRetryOutcome } from "./types.js";

export function createEvaluateScheduledRetryGate(deps: { reader: ScheduledRetryReader }) {
  return (input: {
    runId: string;
    companyId: string;
    retryReasonOverride: string;
    now?: Date;
  }) => deps.reader.evaluateScheduledRetryGate({ ...input, now: input.now ?? new Date() });
}

export function createPromoteScheduledRetry(deps: { writer: RunDispatchWriter }) {
  return (input: {
    runId: string;
    companyId: string;
    now?: Date;
  }): Promise<PromoteScheduledRetryOutcome> =>
    deps.writer.promoteOrCancelDueRetry({
      runId: input.runId,
      companyId: input.companyId,
      now: input.now ?? new Date(),
    });
}

const MAX_DUE_RETRIES_PER_SWEEP = 50;

export function createPromoteDueScheduledRetries(deps: {
  reader: ScheduledRetryReader;
  promoteScheduledRetry: ReturnType<typeof createPromoteScheduledRetry>;
}) {
  return async function promoteDueScheduledRetries(input: { now?: Date; cutoff: Date | null }) {
    const now = input.now ?? new Date();
    const dueRuns = (
      await deps.reader.listDueRetries({ now, cutoff: input.cutoff, limit: MAX_DUE_RETRIES_PER_SWEEP })
    ).slice(0, MAX_DUE_RETRIES_PER_SWEEP);
    const runIds: string[] = [];
    const postCommitEffects: PostCommitEffect[] = [];

    for (const dueRun of dueRuns) {
      const result = await deps.promoteScheduledRetry({ ...dueRun, now });
      if (result.outcome !== "promoted") continue;
      runIds.push(dueRun.runId);
      postCommitEffects.push(...result.postCommitEffects);
    }

    return { promoted: runIds.length, runIds, postCommitEffects };
  };
}

export function createCancelStaleQueuedRun(deps: { writer: RunDispatchWriter }) {
  return (input: {
    runId: string;
    companyId: string;
    expectedStatus: "queued" | "running";
    now?: Date;
    worktreeExecutionCutoff?: Date | null;
  }) => deps.writer.cancelStaleQueuedRun({ ...input, now: input.now ?? new Date() });
}

const MAX_EXPIRED_QUEUED_RUNS_PER_SWEEP = 100;

/**
 * The queued-run age bound. A run still `queued` MAX_QUEUED_ISSUE_RUN_AGE_MS
 * after creation is cancelled with its issue lock released; running runs and
 * younger queued runs are never selected.
 */
export function createExpireStaleQueuedRuns(deps: { expiry: QueuedRunExpiry }) {
  return async function expireStaleQueuedRuns(input: { now?: Date } = {}) {
    const now = input.now ?? new Date();
    const candidates = await deps.expiry.listExpiredQueuedRuns({
      createdAtOrBefore: new Date(now.getTime() - MAX_QUEUED_ISSUE_RUN_AGE_MS),
      limit: MAX_EXPIRED_QUEUED_RUNS_PER_SWEEP,
    });
    const runIds: string[] = [];
    const postCommitEffects: PostCommitEffect[] = [];

    for (const candidate of candidates) {
      const result = await deps.expiry.expireQueuedRun({ ...candidate, now });
      if (result.outcome !== "cancelled") continue;
      runIds.push(candidate.runId);
      postCommitEffects.push(...result.postCommitEffects);
    }

    return { expired: runIds.length, runIds, postCommitEffects };
  };
}

export function createDispatchResolvedInteractionIfCurrent(deps: { writer: RunDispatchWriter }) {
  return <T>(input: {
    runId: string;
    companyId: string;
    expectedStatus: "queued" | "running";
    dispatch: (markDispatchStarted: () => void) => Promise<T>;
    now?: Date;
  }) => deps.writer.dispatchResolvedInteractionIfCurrent({
    ...input,
    now: input.now ?? new Date(),
  });
}
