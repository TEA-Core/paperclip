import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { OPENCODE_V2_CLI_VERSION } from "../index.js";

export type OpenCodeCliVersion = {
  version: string;
  major: number;
  supported: boolean;
};

export function parseOpenCodeCliVersion(value: string): OpenCodeCliVersion | null {
  const match = value.match(/(?:^|\s|v)(\d+\.\d+\.\d+)(?:\s|$)/);
  if (!match?.[1]) return null;
  const version = match[1];
  const major = Number(version.split(".")[0]);
  return { version, major, supported: major === 1 || major === 2 };
}

// The single V2 rule: a CLI version string (configured or detected) is V2 when
// its major version is 2. Argv shape, runtime config, MCP projection and model
// discovery all key off this; OPENCODE_V2_CLI_VERSION only gates acceptance of a
// version that is known. An undetermined version is not V2 here, but it is never
// run as V1 either: callers refuse it (see openCodeVersionProbeRefusal).
export function isOpenCodeV2CliVersion(version: string | null | undefined): boolean {
  return typeof version === "string" && parseOpenCodeCliVersion(version)?.major === 2;
}

export function unsupportedOpenCodeV2CliVersionMessage(version: string): string {
  return `Unsupported OpenCode CLI version: ${version}. Use ${OPENCODE_V2_CLI_VERSION} for V2 opt-in or omit cliVersion for V1.`;
}

export function unsupportedDetectedOpenCodeV2CliVersionMessage(command: string, version: string): string {
  return `Unsupported OpenCode CLI version: ${version} reported by ${command}. Install ${OPENCODE_V2_CLI_VERSION} or point command at a V1 binary.`;
}

export function allowsUnsupportedOpenCodeVersion(environment: NodeJS.ProcessEnv): boolean {
  const value = environment.PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function unsupportedOpenCodeVersionMessage(version: OpenCodeCliVersion): string {
  return `OpenCode ${version.version} is unsupported; Paperclip supports OpenCode 1.x and 2.x.`;
}

const DEFAULT_VERSION_PROBE_TIMEOUT_SEC = 10;
const MAX_VERSION_PROBE_TIMEOUT_SEC = 20;

// A semver-looking token with a prerelease or build suffix (2.2.4-beta.1). The
// stable-only parser above cannot read it, so it is named explicitly rather than
// reported as garbage.
const PRERELEASE_VERSION_RE = /(?:^|\s|v)(\d+\.\d+\.\d+[-+][0-9A-Za-z.+-]+)(?:\s|$)/;

export type OpenCodeCliVersionProbeFailure =
  | { reason: "timed_out"; detail: string }
  | { reason: "exited_nonzero"; detail: string }
  | { reason: "spawn_failed"; detail: string }
  | { reason: "empty_output"; detail: string }
  | { reason: "unparseable_output"; detail: string }
  | { reason: "prerelease"; detail: string };

export type OpenCodeCliVersionProbe =
  | { ok: true; version: OpenCodeCliVersion }
  | ({ ok: false } & OpenCodeCliVersionProbeFailure);

function summarizeProbeOutput(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > 80 ? `${clean.slice(0, 79)}...` : clean;
}

// The version probe must be bounded even when the run has no timeout: a run
// timeoutSec of 0 means "no run deadline", not "a one-second probe".
export function resolveOpenCodeVersionProbeTimeoutSec(timeoutSec: number): number {
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) return DEFAULT_VERSION_PROBE_TIMEOUT_SEC;
  return Math.max(1, Math.min(timeoutSec, MAX_VERSION_PROBE_TIMEOUT_SEC));
}

export function classifyOpenCodeCliVersionOutput(output: string): OpenCodeCliVersionProbe {
  const parsed = parseOpenCodeCliVersion(output);
  if (parsed) return { ok: true, version: parsed };
  const prerelease = PRERELEASE_VERSION_RE.exec(output)?.[1];
  if (prerelease) return { ok: false, reason: "prerelease", detail: prerelease };
  const trimmed = output.trim();
  if (!trimmed) return { ok: false, reason: "empty_output", detail: "empty --version output" };
  return { ok: false, reason: "unparseable_output", detail: `unrecognized --version output "${summarizeProbeOutput(trimmed)}"` };
}

// An undeterminable version is never treated as V1: the caller refuses it. The
// probe reports why so the refusal can name the cause.
export async function probeOpenCodeCliVersion(input: {
  runId: string;
  command: string;
  target: AdapterExecutionTarget | null | undefined;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<OpenCodeCliVersionProbe> {
  const timeoutSec = resolveOpenCodeVersionProbeTimeoutSec(input.timeoutSec);
  try {
    const options = {
      cwd: input.cwd,
      env: input.env,
      timeoutSec,
      graceSec: Math.max(1, Math.min(input.graceSec, 5)),
      onLog: async () => {},
    };
    const result = input.target?.kind === "remote"
      ? await runAdapterExecutionTargetProcess(input.runId, input.target, input.command, ["--version"], options)
      : await runChildProcess(input.runId, input.command, ["--version"], options);
    if (result.timedOut) {
      return { ok: false, reason: "timed_out", detail: `--version timed out after ${timeoutSec}s` };
    }
    if (result.exitCode !== 0) {
      return { ok: false, reason: "exited_nonzero", detail: `--version exited with code ${result.exitCode ?? "unknown"}` };
    }
    return classifyOpenCodeCliVersionOutput(`${result.stdout}\n${result.stderr}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "spawn_failed", detail: `--version could not run: ${summarizeProbeOutput(message)}` };
  }
}

// Refusal text for a probe that did not yield a usable version. A prerelease is
// a known-but-unsupported build; every other failure leaves the version unknown.
export function openCodeVersionProbeRefusal(
  command: string,
  probe: Extract<OpenCodeCliVersionProbe, { ok: false }>,
): { code: "opencode_cli_version_unsupported" | "opencode_cli_version_unknown"; message: string } {
  if (probe.reason === "prerelease") {
    return {
      code: "opencode_cli_version_unsupported",
      message: `Unsupported OpenCode CLI version: ${probe.detail} reported by ${command}. Prerelease builds are not supported; install ${OPENCODE_V2_CLI_VERSION} or point command at a stable V1 binary.`,
    };
  }
  return {
    code: "opencode_cli_version_unknown",
    message: `Could not determine the OpenCode CLI version of ${command}: ${probe.detail}. Refusing to assume V1; install ${OPENCODE_V2_CLI_VERSION} or point command at a stable V1 binary.`,
  };
}
