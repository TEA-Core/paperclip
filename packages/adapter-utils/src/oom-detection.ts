import { readFile } from "node:fs/promises";

/**
 * SUP-18028 — OOM-kill detection + attribution for agent runs.
 *
 * An agent run executes inside the paperclip-server container and therefore
 * shares the server's memory cgroup with the control plane and every other
 * concurrent run. A test pool that sizes its workers from the host CPU count
 * (a `vitest` `forks` pool with no `maxWorkers`) can exceed that shared limit;
 * the kernel then OOM-kills the workers. From inside the run the agent sees
 * only a red suite and a non-zero exit code — the kernel kill is
 * indistinguishable from a genuine failure, and nothing on any surface records
 * that the kernel did it. That is the recurring failure mode of this fork: a
 * state the process could not determine, reported as a definite answer.
 *
 * This module implements the recommended fix — detection + attribution, not a
 * concurrency or cap change. The `runChildProcess` seam reads the cgroup
 * `memory.events` `oom_kill` counter at the run's top-level spawn and again when
 * that child closes, and the delta is surfaced on the run so a killed pool is
 * reported as infrastructure, not as a test result.
 *
 * WHAT THE DELTA MEANS. The cgroup counter is shared by every run in the
 * container, so the delta is "at least N OOM kills occurred in the shared
 * cgroup during this run's window" — a temporal correlation, not a proof this
 * run caused every kill. `formatOomKillNotice` is deliberately worded that way.
 * It is the strongest signal available without a per-run cgroup, and it is the
 * one that makes the false red legible: a reviewer and any re-wake can see the
 * OOM instead of blindly trusting a red suite.
 *
 * Best-effort by construction (SUP-16010/SUP-16011 pattern): a read that cannot
 * be performed — a non-Linux host, a cgroup v1 tree, an unreadable `/proc` or
 * `/sys`, or a container without a cgroup namespace — resolves to `null`, and
 * the run proceeds exactly as before. A run must never fail because the counter
 * could not be read.
 */

/** Environment key that disables the detector for a rollback. Unset = enabled. */
export const RUN_OOM_DETECTION_ENV_KEY = "PAPERCLIP_RUN_OOM_DETECTION";

/** The `oom_kill` line in a cgroup v2 `memory.events` body. */
const OOM_KILL_EVENT_KEY = "oom_kill";

/**
 * Evidence that the run's window saw OOM kills in the shared memory cgroup.
 * Carried on `RunProcessResult` and rendered into the run transcript so the
 * delta is attributable to the run rather than invisible.
 */
export interface OomKillEvidence {
  kind: "cgroup_oom_kill";
  /** `oom_kill` counter read at the run's top-level spawn (the window start). */
  baseline: number;
  /** `oom_kill` counter read when the run's top-level child closed. */
  observed: number;
  /** `observed - baseline`; always `>= 1` on a returned evidence object. */
  delta: number;
}

export interface ReadOomKillCountOptions {
  /** Injectable reader; defaults to `fs/promises.readFile`. */
  readFile?: (path: string) => Promise<string>;
  /** Injectable platform probe; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Pin the cgroup `memory.events` path, bypassing auto-resolution. */
  memoryEventsPath?: string;
  /** Injectable `/proc/self/cgroup` reader for path resolution. */
  readSelfCgroup?: () => Promise<string | null>;
}

/**
 * Resolve whether OOM-kill detection is enabled.
 *
 * Enabled by default: this is a correctness signal that costs one cgroup read
 * per run and is best-effort. Explicit `off`/`false`/`none`/`disabled`/`0`
 * disables it as a rollback lever; anything else (including a typo) stays on,
 * the safe direction.
 */
export function resolveOomDetectionEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[RUN_OOM_DETECTION_ENV_KEY];
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return true;
  return !(
    normalized === "off" ||
    normalized === "false" ||
    normalized === "none" ||
    normalized === "disabled" ||
    normalized === "0"
  );
}

/**
 * Resolve the path to the memory cgroup's `memory.events` file for this process.
 *
 * Prefers the process's own cgroup (the v2 unified line `0::` in
 * `/proc/self/cgroup`) so a non-namespaced container is read at its real cgroup
 * rather than the host root. Falls back to `/sys/fs/cgroup/memory.events`, which
 * is correct under the cgroup namespace every container deployment uses: the
 * container's own cgroup is mounted as the cgroup root, so the relative path is
 * `/` and the events file sits at the root.
 */
export async function resolveMemoryEventsPath(
  options: ReadOomKillCountOptions = {},
): Promise<string> {
  if (options.memoryEventsPath) return options.memoryEventsPath;
  const readSelfCgroup =
    options.readSelfCgroup ??
    (async (): Promise<string | null> => {
      try {
        return await readFile("/proc/self/cgroup", "utf8");
      } catch {
        return null;
      }
    });
  const self = await readSelfCgroup();
  if (self !== null) {
    for (const line of self.split("\n")) {
      const match = line.match(/^0::(.*)$/);
      if (!match) continue;
      const cgroupPath = (match[1] ?? "").trim();
      if (cgroupPath !== "" && cgroupPath !== "/") {
        return `/sys/fs/cgroup${cgroupPath}/memory.events`;
      }
      return "/sys/fs/cgroup/memory.events";
    }
  }
  return "/sys/fs/cgroup/memory.events";
}

/**
 * Parse an `oom_kill N` counter out of a `memory.events` body.
 *
 * The kernel writes one `key value` per line. A missing `oom_kill` line (a
 * cgroup v1 tree, or a kernel that predates the event) yields `null`, not `0` —
 * "not measurable" must never be reported as "no OOMs". A present-but-malformed
 * value likewise yields `null` rather than a fabricated number.
 */
export function parseOomKillCount(memoryEventsBody: string): number | null {
  for (const line of memoryEventsBody.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${OOM_KILL_EVENT_KEY} `)) continue;
    const value = trimmed.slice(OOM_KILL_EVENT_KEY.length + 1).trim();
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Read the cgroup `oom_kill` counter.
 *
 * Returns `null` when it cannot be measured — a non-Linux platform (no procfs),
 * a missing or unreadable events file, or content with no parseable counter —
 * so the caller fails open instead of reporting a fabricated zero.
 */
export async function readCgroupOomKillCount(
  options: ReadOomKillCountOptions = {},
): Promise<number | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return null;
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  const memoryEventsPath = await resolveMemoryEventsPath(options);
  let raw: string;
  try {
    raw = await read(memoryEventsPath);
  } catch {
    return null;
  }
  return parseOomKillCount(raw);
}

/**
 * Pure window decision: given the counter at the run's spawn and at its close,
 * report the delta when it is a positive, finite increase. `null` on either side
 * (unmeasurable) or a non-increase yields `null` — the detector only reports what
 * it actually observed.
 */
export function summarizeOomKillDelta(
  baseline: number | null,
  observed: number | null,
): OomKillEvidence | null {
  if (baseline === null || observed === null) return null;
  if (!Number.isSafeInteger(baseline) || !Number.isSafeInteger(observed)) return null;
  const delta = observed - baseline;
  if (delta <= 0) return null;
  return { kind: "cgroup_oom_kill", baseline, observed, delta };
}

/**
 * The line surfaced on the run (transcript and the run record's `stderrExcerpt`)
 * when the run's window saw OOM kills.
 *
 * Wording is deliberately a temporal correlation — "during this run" — not
 * "this run caused it", because the cgroup counter is shared by every
 * concurrent run. The actionable ask is to stop reading a red suite in this
 * window as a definitive failure without re-checking.
 */
export function formatOomKillNotice(evidence: OomKillEvidence): string {
  const { delta, baseline, observed } = evidence;
  return (
    `[paperclip] cgroup OOM: the shared memory cgroup recorded ${delta} OOM kill(s) ` +
    `during this run (memory.events oom_kill ${baseline} -> ${observed}). ` +
    `A failing test suite or red build in this window may be a kernel OOM-kill of a ` +
    `worker pool, not a genuine failure — re-run the failing step in isolation ` +
    `before treating it as a real failure.\n`
  );
}
