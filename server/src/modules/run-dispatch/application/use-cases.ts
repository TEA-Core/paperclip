import { MAX_QUEUED_ISSUE_RUN_AGE_MS } from "../domain/policy.js";
import type {
  ExpiredQueuedRunCandidate,
  ExpiredQueuedRunCursor,
  QueuedRunExpiry,
  RunDispatchWriter,
  ScheduledRetryReader,
} from "./ports.js";
import type {
  CancelStaleQueuedRunOutcome,
  PostCommitEffect,
  PromoteScheduledRetryOutcome,
} from "./types.js";

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

/** At most this many runs are expired by one sweep; the next sweep takes the rest. */
export const MAX_EXPIRED_QUEUED_RUNS_PER_SWEEP = 100;
const EXPIRY_PAGE_SIZE = 100;
/**
 * Hard bound on candidate pages read by one sweep (2,000 runs), so a sweep
 * awaited at startup and on every heartbeat tick always returns.
 */
export const MAX_EXPIRY_PAGES_PER_SWEEP = 20;

/**
 * The queued-run age bound. A run still `queued` MAX_QUEUED_ISSUE_RUN_AGE_MS
 * after creation is cancelled with its issue lock released; running runs and
 * younger queued runs are never selected.
 */
export function createExpireStaleQueuedRuns(deps: { expiry: QueuedRunExpiry }) {
  return async function expireStaleQueuedRuns(input: { now?: Date } = {}) {
    const now = input.now ?? new Date();
    const createdAtOrBefore = new Date(now.getTime() - MAX_QUEUED_ISSUE_RUN_AGE_MS);
    const runIds: string[] = [];
    const postCommitEffects: PostCommitEffect[] = [];
    // A failure on one candidate (or one page read) is recorded and skipped:
    // it must not abort the sweep or drop the effects of committed cancels.
    const failures: Array<{ runId: string | null; error: unknown }> = [];
    let after: ExpiredQueuedRunCursor | undefined;
    let pagesScanned = 0;
    let pageCapReached = false;

    // The list query already drops runs the policy will not expire (future
    // retry alarm, issue held by another running run). Paging covers the rest:
    // a run whose verdict changes between the list and its locked decision.
    sweep: while (runIds.length < MAX_EXPIRED_QUEUED_RUNS_PER_SWEEP) {
      if (pagesScanned >= MAX_EXPIRY_PAGES_PER_SWEEP) {
        pageCapReached = true;
        break;
      }
      pagesScanned += 1;
      let page: ExpiredQueuedRunCandidate[];
      try {
        page = await deps.expiry.listExpiredQueuedRuns({
          createdAtOrBefore,
          now,
          limit: EXPIRY_PAGE_SIZE,
          after,
        });
      } catch (error) {
        failures.push({ runId: null, error });
        break;
      }
      for (const candidate of page) {
        if (runIds.length >= MAX_EXPIRED_QUEUED_RUNS_PER_SWEEP) break sweep;
        let result: CancelStaleQueuedRunOutcome;
        try {
          result = await deps.expiry.expireQueuedRun({
            runId: candidate.runId,
            companyId: candidate.companyId,
            now,
          });
        } catch (error) {
          failures.push({ runId: candidate.runId, error });
          continue;
        }
        if (result.outcome !== "cancelled") continue;
        runIds.push(candidate.runId);
        postCommitEffects.push(...result.postCommitEffects);
      }
      const last = page.at(-1);
      if (page.length < EXPIRY_PAGE_SIZE || !last) break;
      // The keyset is strict, so the cursor always moves; stop rather than
      // re-read a page if an adapter ever returns the same position.
      if (after && last.cursor.createdAtText === after.createdAtText && last.cursor.runId === after.runId) break;
      after = last.cursor;
    }

    return { expired: runIds.length, runIds, postCommitEffects, pagesScanned, pageCapReached, failures };
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
