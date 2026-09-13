import { runningProcesses } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";
import { countLiveProcessGroupMembers } from "./local-service-supervisor.js";

/**
 * SUP-16010 — per-run child-process census.
 *
 * SUP-13949 fixed the one leak that reached 1,291 processes and 93% of the
 * container's memory on 2026-08-25; nothing bounds the next one. Before a
 * per-run cap can be argued it needs the observed distribution of legitimate
 * per-run child counts, so this sweep samples the live processes in every
 * run's process group and publishes the distribution on `GET /api/health`
 * under `sweepLiveness.sweeps.runProcessCensus.lastResult`.
 *
 * The result field names below are a consume-contract: the enforcement card
 * (SUP-16011) reads `sampleCount`/`max`/`p50`/`p95`/`p99`/`maxRunId` verbatim,
 * so renaming one breaks the consumer.
 *
 * Observe-only by construction: it reads the process table and counts. It
 * never signals, kills, throttles, or refuses a spawn.
 *
 * The count comes from `countLiveProcessGroupMembers` in
 * `local-service-supervisor.ts` — the same `/proc` scan behind the existing
 * `isProcessGroupAlive` seam — so the census adds no second process-walking
 * primitive.
 */

/** The per-run slice of a tracked run this census reads. */
export type RunProcessGroupEntry = {
  processGroupId: number | null;
};

/** One run's live-process count, as sampled from its process group. */
export type RunProcessCountSample = {
  runId: string;
  liveProcesses: number;
};

export type RunProcessCensusDistribution = {
  /** Number of runs sampled this pass (readable process groups only). */
  sampleCount: number;
  /** Largest per-run count, or null when nothing was sampled. */
  max: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  /** Run holding the max. Ties resolve to the first run encountered. */
  maxRunId: string | null;
};

export type RunProcessCensusResult = RunProcessCensusDistribution & {
  /**
   * Runs whose process group could not be read this pass. They are skipped
   * from the distribution rather than sampled as zero — an unreadable group
   * is not evidence of an idle run.
   */
  unreadable: number;
};

/**
 * Nearest-rank percentile over an ascending array. Rank is
 * `ceil(quantile * n)` clamped into range, so a single sample reports itself
 * for every quantile and no interpolation is invented.
 */
function nearestRankPercentile(sortedAscending: number[], quantile: number): number {
  const rank = Math.ceil(quantile * sortedAscending.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedAscending.length - 1);
  return sortedAscending[index];
}

/**
 * Reduce per-run samples to the published distribution. Pure: the whole
 * distribution contract is testable from a synthetic sample table without
 * touching the real process table.
 */
export function summarizeRunProcessCounts(
  samples: ReadonlyArray<RunProcessCountSample>,
): RunProcessCensusDistribution {
  if (samples.length === 0) {
    // Zero live runs is a legitimate observation, not an error: the sweep
    // still records a pass (so "ran, found nothing" is distinguishable from
    // "never fired") and reports no distribution rather than a fake zero.
    return {
      sampleCount: 0,
      max: null,
      p50: null,
      p95: null,
      p99: null,
      maxRunId: null,
    };
  }

  const sorted = samples.map((sample) => sample.liveProcesses).sort((left, right) => left - right);
  const max = sorted[sorted.length - 1];
  const maxSample = samples.find((sample) => sample.liveProcesses === max);

  return {
    sampleCount: samples.length,
    max,
    p50: nearestRankPercentile(sorted, 0.5),
    p95: nearestRankPercentile(sorted, 0.95),
    p99: nearestRankPercentile(sorted, 0.99),
    maxRunId: maxSample?.runId ?? null,
  };
}

/**
 * Sample every tracked run's process group and reduce to the census result.
 *
 * Infallible by design: a run whose group cannot be read (untracked group, a
 * non-Linux platform with no procfs, or a read that throws) is counted in
 * `unreadable` and skipped; one unreadable run never fails the pass.
 */
export function censusRunProcessGroups(input: {
  entries: Iterable<readonly [string, RunProcessGroupEntry]>;
  countLiveProcessGroupMembers?: (processGroupId: number) => number | null;
}): RunProcessCensusResult {
  const countMembers = input.countLiveProcessGroupMembers ?? countLiveProcessGroupMembers;
  const samples: RunProcessCountSample[] = [];
  let unreadable = 0;

  for (const [runId, entry] of input.entries) {
    const processGroupId = entry?.processGroupId;
    if (
      typeof processGroupId !== "number"
      || !Number.isInteger(processGroupId)
      || processGroupId <= 0
    ) {
      unreadable += 1;
      continue;
    }

    let liveProcesses: number | null;
    try {
      liveProcesses = countMembers(processGroupId);
    } catch {
      liveProcesses = null;
    }

    if (
      liveProcesses === null
      || !Number.isInteger(liveProcesses)
      || liveProcesses < 0
    ) {
      unreadable += 1;
      continue;
    }

    samples.push({ runId, liveProcesses });
  }

  return {
    ...summarizeRunProcessCounts(samples),
    unreadable,
  };
}

/**
 * The sweep body. Reads the in-memory run→process-group registry (the same
 * population the watchdog terminates) and returns the census result the
 * heartbeat wrapper records as `lastResult`.
 */
export async function runProcessCensusSweep(): Promise<RunProcessCensusResult> {
  const result = censusRunProcessGroups({ entries: runningProcesses.entries() });
  logger.debug({ ...result }, "run-process census sampled live child processes per run");
  return result;
}
