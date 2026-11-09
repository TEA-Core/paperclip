import { MAX_QUEUED_ISSUE_RUN_AGE_MS } from "../domain/policy.js";
import type { RunDispatchWriter, ScheduledRetryReader } from "./ports.js";
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
const MAX_STALE_QUEUED_RUNS_PER_SWEEP = 50;

export function createSweepStaleQueuedRuns(deps: {
  reader: Pick<ScheduledRetryReader, "listStaleQueuedRuns">;
  cancelStaleQueuedRun: ReturnType<typeof createCancelStaleQueuedRun>;
}) {
  return async function sweepStaleQueuedRuns(input: { now?: Date }) {
    const now = input.now ?? new Date();
    const cutoff = new Date(now.getTime() - MAX_QUEUED_ISSUE_RUN_AGE_MS);
    const staleRuns = await deps.reader.listStaleQueuedRuns({ cutoff, limit: MAX_STALE_QUEUED_RUNS_PER_SWEEP });
    const cancelledRunIds: string[] = [];
    const postCommitEffects: PostCommitEffect[] = [];
    for (const run of staleRuns.slice(0, MAX_STALE_QUEUED_RUNS_PER_SWEEP)) {
      const result = await deps.cancelStaleQueuedRun({ ...run, expectedStatus: "queued", now });
      if (result.outcome !== "cancelled") continue;
      cancelledRunIds.push(run.runId);
      postCommitEffects.push(...(result.postCommitEffects ?? []));
    }
    return { cancelled: cancelledRunIds.length, runIds: cancelledRunIds, postCommitEffects };
  };
}

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
