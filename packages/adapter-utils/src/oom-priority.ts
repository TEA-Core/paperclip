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
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      return Math.min(Math.max(parsed, OOM_SCORE_ADJ_MIN), OOM_SCORE_ADJ_MAX);
    }
  }
  return DEFAULT_AGENT_OOM_SCORE_ADJ;
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
