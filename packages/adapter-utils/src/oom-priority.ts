import { writeFileSync } from "node:fs";

/**
 * Make agent-run subprocesses the kernel's preferred OOM victims, so a runaway
 * agent workload cannot take the Paperclip server down with it.
 *
 * Why this exists (production incident, 2026-09-25): agent runs execute INSIDE the
 * `paperclip-server-1` container and therefore share the server's memory cgroup.
 * An agent ran the repo's vitest suite through the root config, which drives one
 * global worker pool that the server project's `maxWorkers: 1` does not bound, so
 * 16 forks came up on a 16-core host and each booted its own embedded Postgres.
 * Worker RSS reached 8.5 GiB, the container's 40 GiB limit was hit and the kernel
 * OOM-killed 13 workers in three minutes (33 kills in kern.log overall).
 *
 * The server survived that sweep only by being SMALLER than the workers. Nothing
 * made that outcome reliable: the server process sits at `oom_score` 684 with a
 * default `oom_score_adj` of 0, so a differently-shaped workload can just as
 * easily leave the server as the fattest task in the cgroup. If the kernel picks
 * it, tini stays PID 1, the container still reports `Up`, and the edge proxy has
 * nothing to reach — a 502 with no restart and no crash loop to point at.
 *
 * The server cannot defend itself directly: lowering its own `oom_score_adj`
 * needs CAP_SYS_RESOURCE, which the container does not hold (verified: writing a
 * negative value returns EACCES). RAISING a value is always permitted, including
 * as the unprivileged agent uid, and `oom_score_adj` is inherited across fork and
 * exec. So deprioritising the agent child at its spawn seam covers the entire
 * process tree beneath it — the provider CLI, the agent's shell, and any test
 * fleet it launches — while leaving the server at its default.
 *
 * WHAT "PERMITTED" DOES NOT COVER (SUP-17664). Raising the value needs no
 * privilege, but the writer still has to own the `/proc` entry, and with the
 * agent-uid split armed the server never does. `resolveSpawnTarget` makes the
 * spawned child the setuid-root shim, and a setuid execve is a secure-exec, so
 * the kernel re-owns that child's `/proc` entries to root:root before the shim
 * runs; after the shim drops, they belong to the agent uid. Measured: EACCES on
 * 20 of 20 spawns through the shim, and OK on 20 of 20 without it. So the call
 * below is effective exactly when no setuid binary is in the spawn path — dev
 * boxes, CI, and upstream — and is a no-op under the split, where
 * `docker/agent-spawn-shim/spawn-agent.c` performs the same write on itself
 * instead. Keep both: they cover disjoint deployments.
 *
 * Strictly best-effort. A failure here must never fail a run: the worst case is
 * the status quo ante.
 */

/** Default adjustment applied to an agent subprocess tree. */
export const DEFAULT_AGENT_OOM_SCORE_ADJ = 500;

/** Kernel-accepted range for `/proc/<pid>/oom_score_adj`. */
const OOM_SCORE_ADJ_MAX = 1000;
const OOM_SCORE_ADJ_MIN = 0;

export interface DeprioritizeForOomOptions {
  /** Injection seam for tests; defaults to a real `/proc` write. */
  write?: (path: string, value: string) => void;
  /** Injection seam for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Reported when the write fails, so a silent no-op is still observable. */
  onError?: (error: unknown) => void;
}

/**
 * Resolves the configured adjustment, clamped to the kernel's permitted range.
 *
 * Only non-negative values are honoured: a negative adjustment would need
 * CAP_SYS_RESOURCE and would fail the write, so accepting one here would just
 * turn a config mistake into a silent no-op.
 */
export function resolveAgentOomScoreAdj(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.PAPERCLIP_AGENT_OOM_SCORE_ADJ;
  if (raw === undefined) return DEFAULT_AGENT_OOM_SCORE_ADJ;
  const normalized = raw.trim();
  // The whole string must be an integer. `Number.parseInt` stops at the first
  // non-numeric character, so it reads "0.5" as 0 and "500MB" as 500 — silently
  // turning an operator's typo into a limit they did not ask for. Anything that
  // is not a clean integer falls back to the documented default instead.
  if (!/^-?\d+$/.test(normalized)) return DEFAULT_AGENT_OOM_SCORE_ADJ;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_AGENT_OOM_SCORE_ADJ;
  // A negative value is clamped to 0 rather than rejected. It expresses a wish to
  // protect the agent MORE than the default, which needs CAP_SYS_RESOURCE and
  // cannot be honoured here; 0 (no adjustment) is the closest achievable
  // behaviour. Falling back to the default would do the opposite of the intent.
  return Math.min(Math.max(parsed, OOM_SCORE_ADJ_MIN), OOM_SCORE_ADJ_MAX);
}

/**
 * Marks `pid` (and, by inheritance, everything it spawns) as a preferred OOM
 * victim relative to the server. Returns the value written, or `null` when the
 * adjustment was not applied.
 *
 * Never throws. A dead pid, a read-only `/proc`, a non-Linux host or a denied
 * write all resolve to `null`.
 */
export function deprioritizeForOom(
  pid: number | undefined,
  scoreAdj: number = resolveAgentOomScoreAdj(),
  options: DeprioritizeForOomOptions = {},
): number | null {
  const platform = options.platform ?? process.platform;
  // `/proc/<pid>/oom_score_adj` is Linux-only; elsewhere this is a no-op rather
  // than an error, so the same spawn path works on a developer's macOS machine.
  if (platform !== "linux") return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;

  const clamped = Math.min(Math.max(Math.trunc(scoreAdj), OOM_SCORE_ADJ_MIN), OOM_SCORE_ADJ_MAX);
  // 0 is the default: writing it changes nothing and would only add a failure mode.
  if (clamped === 0) return null;

  const write = options.write ?? ((path: string, value: string) => writeFileSync(path, value));
  try {
    write(`/proc/${pid}/oom_score_adj`, String(clamped));
    return clamped;
  } catch (error) {
    options.onError?.(error);
    return null;
  }
}

let oomMarkFailureReported = false;

/**
 * Wrap a reporter so the first failed mark per process is logged and the rest
 * are dropped.
 *
 * A failed write used to be completely silent — `onError` existed and no call
 * site passed it — so a mark that failed on every single spawn produced no
 * signal at all and the regression was found by hand-probing production
 * (SUP-17664). Reporting it per spawn is the opposite failure: under the
 * agent-uid split the server's write ALWAYS fails, by construction, so a
 * per-spawn warning would be unbounded noise describing intended behaviour.
 * Once per process is enough to notice, and cheap enough to keep forever.
 *
 * Exported for the tests, which need to clear the latch between cases.
 */
export function reportOomMarkFailureOnce(
  report: (message: string, error: unknown) => void,
): (error: unknown) => void {
  return (error: unknown) => {
    if (oomMarkFailureReported) return;
    oomMarkFailureReported = true;
    report(
      "could not mark the run child as a preferred OOM victim; when PAPERCLIP_AGENT_UID " +
        "is armed this is expected (the setuid spawn shim marks the agent tree itself) " +
        "and this message is emitted once per process",
      error,
    );
  };
}

/** Test seam: clear the once-per-process latch. */
export function resetOomMarkFailureReportedForTests(): void {
  oomMarkFailureReported = false;
}
