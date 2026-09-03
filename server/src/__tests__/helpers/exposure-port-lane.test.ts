/**
 * The lane arithmetic must keep every derived port inside the dedicated
 * exposure range for ANY shard count and ANY vitest worker id.
 *
 * Regression: `VITEST_WORKER_ID` is a per-file counter under
 * `pool: "forks"` + `isolate: true` (30 files produce ids 0..29 even with
 * `maxWorkers: 1`), not a small bounded slot. The previous formula added
 * `workerIndex * 4` to a hardcoded `shardIndex * 100`, so on shard 4 the suite
 * only had to be spawned 25th to leave the range — which a single added test
 * file caused, breaking `General tests (server (5/5))` on every open PR.
 */
import { describe, expect, it } from "vitest";
import {
  BASE_LEASED_APP_PORT,
  BASE_NEXT_APP_PORT,
  MAX_PORT_LANE_OFFSET,
  WORKER_LANE_STRIDE,
  derivePortLaneOffset,
} from "./exposure-port-lane.js";
import {
  RUNTIME_EXPOSURE_APP_PORT_MAX,
  RUNTIME_EXPOSURE_APP_PORT_MIN,
  isRuntimeExposureAppPort,
  isRuntimeExposureHmrPort,
} from "@paperclipai/shared";

function lane(env: Record<string, string>): number {
  return derivePortLaneOffset(env as NodeJS.ProcessEnv);
}

describe("derivePortLaneOffset", () => {
  it("stays in range for every shard and worker id the CI matrix can produce", () => {
    // 5 is today's `general-server` shard count; sweep past it so a future
    // re-split cannot reintroduce the overflow.
    for (const shardCount of [1, 2, 3, 5, 8, 13]) {
      for (let shardIndex = 0; shardIndex < shardCount; shardIndex += 1) {
        // Worker ids track the suite's position in its shard, so sweep well
        // past any plausible per-shard file count.
        for (const workerId of [0, 1, 25, 26, 101, 500, 5000]) {
          const offset = lane({
            PAPERCLIP_TEST_SHARD_COUNT: String(shardCount),
            PAPERCLIP_TEST_SHARD_INDEX: String(shardIndex),
            VITEST_WORKER_ID: String(workerId),
          });
          const where = `shard ${shardIndex}/${shardCount} worker ${workerId}`;

          expect(offset, where).toBeGreaterThanOrEqual(0);
          expect(offset, where).toBeLessThanOrEqual(MAX_PORT_LANE_OFFSET);
          // The pair the suite actually binds, and its HMR companion.
          expect(isRuntimeExposureAppPort(BASE_LEASED_APP_PORT + offset), where).toBe(true);
          expect(isRuntimeExposureAppPort(BASE_NEXT_APP_PORT + offset), where).toBe(true);
          expect(isRuntimeExposureHmrPort(BASE_LEASED_APP_PORT + 10_000 + offset), where).toBe(true);
        }
      }
    }
  });

  it("reproduces the CI break: shard 4 of 5 with a late-spawned worker", () => {
    // The exact combination that failed — offset 500 against a 497 ceiling.
    const offset = lane({
      PAPERCLIP_TEST_SHARD_COUNT: "5",
      PAPERCLIP_TEST_SHARD_INDEX: "4",
      VITEST_WORKER_ID: "26",
    });
    expect(offset).toBeLessThanOrEqual(MAX_PORT_LANE_OFFSET);
    expect(BASE_NEXT_APP_PORT + offset).toBeLessThanOrEqual(RUNTIME_EXPOSURE_APP_PORT_MAX);
    expect(BASE_LEASED_APP_PORT + offset).toBeGreaterThanOrEqual(RUNTIME_EXPOSURE_APP_PORT_MIN);
  });

  it("gives sibling shards disjoint lanes", () => {
    const shardCount = 5;
    const lanes = new Set<number>();
    for (let shardIndex = 0; shardIndex < shardCount; shardIndex += 1) {
      lanes.add(
        lane({
          PAPERCLIP_TEST_SHARD_COUNT: String(shardCount),
          PAPERCLIP_TEST_SHARD_INDEX: String(shardIndex),
          VITEST_WORKER_ID: "1",
        }),
      );
    }
    expect(lanes.size).toBe(shardCount);
  });

  it("separates concurrent workers inside one shard", () => {
    const lanes = new Set<number>();
    for (let workerId = 0; workerId < 8; workerId += 1) {
      lanes.add(lane({ VITEST_WORKER_ID: String(workerId) }));
    }
    expect(lanes.size).toBe(8);
    // Lanes are spaced far enough apart that a lane's four ports cannot reach
    // into the next one.
    const sorted = [...lanes].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(WORKER_LANE_STRIDE);
    }
  });

  it("defaults to the base lane with no sharding or worker env", () => {
    expect(lane({})).toBe(0);
  });

  it("ignores malformed env values instead of throwing", () => {
    expect(
      lane({
        PAPERCLIP_TEST_SHARD_COUNT: "not-a-number",
        PAPERCLIP_TEST_SHARD_INDEX: "-3",
        VITEST_WORKER_ID: "",
      }),
    ).toBe(0);
  });
});
