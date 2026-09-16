// TEA-Core fork (fold 2c, decision D3): a host-mode Git-context probe failure must not fail the run.
//
// Upstream's Git-context probe (execution-target.ts prepareGitHubExecutionEnvironment) spawns a
// node child (local) or a shell over the runner (SSH/sandbox) to discover host Git/gh config,
// Git metadata roots and network roots. Any throw (15 s timeout, missing workspace cwd, spawn
// failure, unreadable output) used to reach executeRun's outer setup catch as `setup_failed`.
// In host GitHub mode the run does not need the discovered keys to authenticate: the fork's
// credential helper and gh wrapper (invariants I4/I5) are applied by the adapters over whatever
// env they receive. So host mode continues with the runtime env and the controller-owned keys
// forced; managed mode rethrows, because it needs validated roots and launchers.
//
// heartbeat.ts reaches the probe only through this module (guarded by call count), passing its
// own imported binding as `deps.prepare` so test module mocks still take effect. This file must
// never call the probe directly.
import fs from "node:fs/promises";
import type { prepareGitHubExecutionEnvironment } from "@paperclipai/adapter-utils/execution-target";

type PrepareGitExecutionEnvironment = typeof prepareGitHubExecutionEnvironment;
type PrepareInput = Parameters<PrepareGitExecutionEnvironment>[0];

export type GitContextProbeFailureReason =
  | "timeout"
  | "cwd_missing"
  | "spawn_failed"
  | "output_overflow"
  | "probe_exit_nonzero"
  | "unreadable_output"
  | "remote_probe_failed"
  | "unknown";

export interface GitContextProbeFallback {
  reason: GitContextProbeFailureReason;
  errorCode: string | null;
  signal: string | null;
  elapsedMs: number;
  targetKind: "local" | "remote";
  /** The raw probe error, for pino only: its message embeds the probe script. */
  error: unknown;
}

/**
 * Keys the probe owns. Mirrors the controller-owned override at the end of upstream's probe;
 * if upstream adds a key there, add it here too (not pinned automatically).
 */
export const GIT_CONTEXT_PROBE_CONTROLLER_OWNED_KEYS = [
  "PAPERCLIP_GIT_METADATA_ROOTS",
  "PAPERCLIP_RUNNER_NETWORK_ROOTS",
  "PAPERCLIP_GITHUB_HOST_HOME",
  "PAPERCLIP_GITHUB_AUTH_MODE",
  "PAPERCLIP_RUNNER_NETWORK_ACCESS",
] as const;

export function buildHostModeGitContextFallbackEnv(input: {
  env: Record<string, string>;
  networkAccess: boolean;
}): Record<string, string> {
  const rest = { ...input.env };
  for (const key of GIT_CONTEXT_PROBE_CONTROLLER_OWNED_KEYS) delete rest[key];
  return {
    ...rest,
    PAPERCLIP_GIT_METADATA_ROOTS: "[]",
    PAPERCLIP_RUNNER_NETWORK_ROOTS: "[]",
    PAPERCLIP_GITHUB_AUTH_MODE: "host",
    PAPERCLIP_RUNNER_NETWORK_ACCESS: input.networkAccess ? "enabled" : "disabled",
  };
}

const defaultCwdExists = (candidate: string) =>
  fs.access(candidate).then(
    () => true,
    () => false,
  );

export async function classifyGitContextProbeFailure(
  err: unknown,
  input: { cwd: string; remote: boolean; cwdExists?: (candidate: string) => Promise<boolean> },
): Promise<GitContextProbeFailureReason> {
  // Upstream collapses remote exit/timeout/framing failures into one plain Error.
  if (input.remote) return "remote_probe_failed";
  const e = (err ?? {}) as { killed?: boolean; signal?: string | null; code?: unknown; message?: string };
  if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output_overflow";
  if (e.killed === true && typeof e.signal === "string") return "timeout";
  if (typeof e.code === "string") {
    // Decide by the cwd itself, not by parsing `syscall` text: its shape differs across node majors.
    if (e.code === "ENOENT" && !(await (input.cwdExists ?? defaultCwdExists)(input.cwd))) return "cwd_missing";
    return "spawn_failed";
  }
  if (typeof e.code === "number") return "probe_exit_nonzero";
  if (e.message === "Could not read execution-target Git context") return "unreadable_output";
  return "unknown";
}

export async function prepareGitExecutionEnvironmentWithHostFallback(
  input: PrepareInput,
  deps: {
    prepare: PrepareGitExecutionEnvironment;
    now?: () => number;
    cwdExists?: (candidate: string) => Promise<boolean>;
  },
): Promise<{ env: Record<string, string>; fallback: GitContextProbeFallback | null }> {
  const now = deps.now ?? Date.now;
  const started = now();
  try {
    return { env: await deps.prepare(input), fallback: null };
  } catch (error) {
    // Managed mode: upstream fatality preserved (it needs validated roots and launchers).
    if (!input.hostCredentials) throw error;
    const remote = input.target?.kind === "remote";
    const e = (error ?? {}) as { code?: unknown; signal?: unknown };
    return {
      env: buildHostModeGitContextFallbackEnv({ env: input.env, networkAccess: input.networkAccess }),
      fallback: {
        reason: await classifyGitContextProbeFailure(error, { cwd: input.cwd, remote, cwdExists: deps.cwdExists }),
        errorCode: e.code == null ? null : String(e.code),
        signal: typeof e.signal === "string" ? e.signal : null,
        elapsedMs: now() - started,
        targetKind: remote ? "remote" : "local",
        error,
      },
    };
  }
}
