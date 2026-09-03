/**
 * Per-shard/worker port lane for the runtime-exposure reservation suites.
 *
 * Those suites drive real guests that bind loopback ports, so two test
 * processes sharing a lane collide with EADDRINUSE at guest bind time — the
 * merge_group flake SUP-14712. The lane is therefore shifted per CI shard, and
 * per vitest worker for unsharded parallel runs.
 *
 * ## Why the offset is wrapped rather than summed
 *
 * `VITEST_WORKER_ID` is NOT a bounded worker slot. The server vitest config
 * runs `pool: "forks"` with `isolate: true`, so vitest spawns a fresh child per
 * test FILE and increments the id each time — even with `maxWorkers: 1`.
 * Measured: 30 files under that config produce ids 0..29, while
 * `VITEST_POOL_ID` stays 1. The id therefore tracks the suite's position in its
 * shard, and grows with the shard's file count without bound.
 *
 * Treating it as a small slot and adding `workerIndex * stride` to the shard
 * base is what broke CI: on `server (5/5)` (shard index 4, base offset 400) the
 * exposure suite only had to be spawned 25th or later for the lane to leave the
 * dedicated range, which a single added test file was enough to cause. Both
 * halves are now derived from the range budget and the worker contribution is
 * taken modulo the lanes that actually fit, so the offset is in-range by
 * construction for any shard count and any worker id.
 */
import {
  RUNTIME_EXPOSURE_APP_PORT_MAX,
  RUNTIME_EXPOSURE_APP_PORT_MIN,
} from "@paperclipai/shared";

/** The pair lane B holds under an open lease, before the lane shift. */
export const BASE_LEASED_APP_PORT = 42_501;
export const BASE_LEASED_HMR_PORT = 52_501;
/** The next pair a correct allocator must relocate to, before the lane shift. */
export const BASE_NEXT_APP_PORT = 42_502;
export const BASE_NEXT_HMR_PORT = 52_502;

/** Ports consumed by one worker lane (leased app, next app, + HMR companions). */
export const WORKER_LANE_STRIDE = 4;

/**
 * Highest offset that keeps every derived port inside the dedicated app range.
 * The HMR companions sit a fixed +10000 above their app port, so their range
 * tracks this one and needs no separate budget.
 */
export const MAX_PORT_LANE_OFFSET = RUNTIME_EXPOSURE_APP_PORT_MAX - BASE_NEXT_APP_PORT;

function readNonNegativeEnvInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Where this process's lane sits inside the dedicated app range.
 *
 * The CI shard partition is the primary discriminator — `run-vitest-stable.mjs`
 * shards the server group by explicit file list rather than vitest's native
 * `--shard`, so no `VITEST_*` variable distinguishes sibling shards and the
 * wrapper exports `PAPERCLIP_TEST_SHARD_INDEX`/`PAPERCLIP_TEST_SHARD_COUNT`.
 * The worker id separates concurrent processes within one shard.
 *
 * Still throws if the derived lane would leave the range: the arithmetic below
 * makes that unreachable, so the guard now asserts an invariant instead of
 * catching an expected overflow.
 */
export function derivePortLaneOffset(env: NodeJS.ProcessEnv = process.env): number {
  const shardCount = Math.max(1, readNonNegativeEnvInt(env, "PAPERCLIP_TEST_SHARD_COUNT", 1));
  const shardIndex = Math.min(
    readNonNegativeEnvInt(env, "PAPERCLIP_TEST_SHARD_INDEX", 0),
    shardCount - 1,
  );

  // Split the budget across the shards actually in play, then across the worker
  // lanes that fit inside one shard's slice.
  const shardLaneStride = Math.floor((MAX_PORT_LANE_OFFSET + 1) / shardCount);
  const workerLanesPerShard = Math.max(1, Math.floor(shardLaneStride / WORKER_LANE_STRIDE));

  // Both ids are per-process counters, not bounded slots (see the file header),
  // so they are wrapped. Concurrent processes still land in distinct lanes as
  // long as no more than `workerLanesPerShard` of them run at once.
  const workerIndex = readNonNegativeEnvInt(env, "VITEST_WORKER_ID", 0);
  const poolIndex = Math.max(0, readNonNegativeEnvInt(env, "VITEST_POOL_ID", 1) - 1);
  const workerSlot = (workerIndex + poolIndex) % workerLanesPerShard;

  const offset = shardIndex * shardLaneStride + workerSlot * WORKER_LANE_STRIDE;
  if (offset > MAX_PORT_LANE_OFFSET) {
    throw new Error(
      `exposure-reservation lane offset ${offset} exceeds the dedicated app range ` +
        `[${RUNTIME_EXPOSURE_APP_PORT_MIN}, ${RUNTIME_EXPOSURE_APP_PORT_MAX}]; ` +
        `check PAPERCLIP_TEST_SHARD_INDEX/PAPERCLIP_TEST_SHARD_COUNT/` +
        `VITEST_WORKER_ID/VITEST_POOL_ID`,
    );
  }
  return offset;
}
