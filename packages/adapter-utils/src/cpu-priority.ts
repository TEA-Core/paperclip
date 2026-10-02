import os from "node:os";
import path from "node:path";

/**
 * Run agent subprocess trees at a lower CPU priority than the Paperclip server.
 *
 * Why this exists (production incident, 2026-09-30): agent runs execute INSIDE
 * the server container and therefore share its CPU cgroup. At equal priority the
 * scheduler splits CPU per runnable thread, so an agent that starts a large test
 * fleet or a CPU-load reproduction outweighs the control plane. One agent's 128
 * busy-loop workers drove the host to load 184 at the server's own priority.
 * Measured on that kernel in a container: a nice-0 thread competing with 16 busy
 * threads on two cores got 0.11 of a core against nice-0 workers and 0.68 against
 * nice-10 workers.
 *
 * TWO SEAMS, DISJOINT DEPLOYMENTS — the same split as ./oom-priority.ts:
 *   - With the agent-uid split armed, the spawned child is the setuid-root shim
 *     (docker/agent-spawn-shim/spawn-agent.c), which lowers its own priority by
 *     AGENT_NICE after dropping privilege.
 *   - Everywhere else — no split, or the ACP lane of an agent without its lane
 *     flag, where acpx spawns the provider directly as the server's uid — the
 *     server lowers the child here, right after spawn().
 * The server must NOT step a shim child as well: at spawn() return the shim
 * still carries the server's real uid, so the call would be permitted, and the
 * shim's own relative step would then land on top of it (nice 19 instead of 10,
 * depending on which runs first). {@link isAgentSpawnShim} is the guard.
 *
 * The niceness is inherited across fork and exec, so one call on the top-level
 * child covers the provider CLI, the agent's shell and everything it launches.
 * Raising one's own child's niceness needs no privilege. Strictly best-effort:
 * a failure never fails a run.
 */

/** Default number of nice steps between the server and an agent tree. */
export const DEFAULT_AGENT_NICE = 10;

/** The kernel's lowest priority. */
const NICE_MAX = 19;

const DEFAULT_AGENT_SPAWN_SHIM = "/usr/local/sbin/paperclip-spawn-agent";

/**
 * Resolves the configured step from `PAPERCLIP_AGENT_NICE`, clamped to 0..19.
 * This governs the server-side step only; under the uid split the shim's
 * compile-time AGENT_NICE governs, because the shim reads no environment.
 */
export function resolveAgentNice(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAPERCLIP_AGENT_NICE;
  if (raw === undefined) return DEFAULT_AGENT_NICE;
  const normalized = raw.trim();
  // A whole integer only: parseInt would read "5.5" as 5 and "10x" as 10.
  if (!/^-?\d+$/.test(normalized)) return DEFAULT_AGENT_NICE;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_AGENT_NICE;
  // A negative step would put agents ABOVE the server. That needs CAP_SYS_NICE
  // and is never the intent, so it means "no step" rather than the default.
  return Math.min(Math.max(parsed, 0), NICE_MAX);
}

/**
 * True when `command` is the setuid uid-split shim, which takes the priority
 * step itself. Compared as a normalized absolute path against the same
 * `PAPERCLIP_AGENT_SPAWN_SHIM` override the spawn-target resolvers use.
 */
export function isAgentSpawnShim(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const shimPath = env.PAPERCLIP_AGENT_SPAWN_SHIM?.trim() || DEFAULT_AGENT_SPAWN_SHIM;
  return path.resolve(command) === path.resolve(shimPath);
}

export interface DeprioritizeCpuOptions {
  /** Injection seams for tests; default to node:os. `pid` 0 means this process. */
  getPriority?: (pid: number) => number;
  setPriority?: (pid: number, priority: number) => void;
  /** Injection seam for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Reported when the step fails, so a silent no-op is still observable. */
  onError?: (error: unknown) => void;
}

/**
 * Puts `pid` `steps` nice levels below this process, capped at 19. Returns the
 * niceness written, or `null` when nothing was changed. Never lowers a child
 * that already sits at or below the target, and never throws.
 */
export function deprioritizeCpu(
  pid: number | undefined,
  steps: number = resolveAgentNice(),
  options: DeprioritizeCpuOptions = {},
): number | null {
  const platform = options.platform ?? process.platform;
  // Windows maps priorities onto classes, not nice values; leave it alone.
  if (platform === "win32") return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  const step = Math.min(Math.max(Math.trunc(steps), 0), NICE_MAX);
  if (step === 0) return null;

  const getPriority = options.getPriority ?? ((target: number) => os.getPriority(target));
  const setPriority = options.setPriority ?? ((target: number, value: number) => os.setPriority(target, value));
  try {
    const target = Math.min(getPriority(0) + step, NICE_MAX);
    if (getPriority(pid) >= target) return null;
    setPriority(pid, target);
    return target;
  } catch (error) {
    options.onError?.(error);
    return null;
  }
}

let cpuStepFailureReported = false;

/**
 * Wrap a reporter so the first failed step per process is logged and the rest
 * are dropped — the same latch as reportOomMarkFailureOnce, for the same reason.
 */
export function reportCpuStepFailureOnce(
  report: (message: string, error: unknown) => void,
): (error: unknown) => void {
  return (error) => {
    if (cpuStepFailureReported) return;
    cpuStepFailureReported = true;
    report("could not lower the run child's CPU priority; it runs at the server's priority", error);
  };
}

/** Test seam: clear the once-per-process latch. */
export function resetCpuStepFailureReportedForTests(): void {
  cpuStepFailureReported = false;
}
