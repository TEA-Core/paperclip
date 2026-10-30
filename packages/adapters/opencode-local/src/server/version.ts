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
// version that is known. A version that cannot be determined (probe failed, timed
// out, or empty or unparseable output) is not V2 here, so callers treat it as V1.
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

export async function probeOpenCodeCliVersion(input: {
  runId: string;
  command: string;
  target: AdapterExecutionTarget | null | undefined;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<OpenCodeCliVersion | null> {
  try {
    const options = {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: Math.max(1, Math.min(input.timeoutSec, 20)),
      graceSec: Math.max(1, Math.min(input.graceSec, 5)),
      onLog: async () => {},
    };
    const result = input.target?.kind === "remote"
      ? await runAdapterExecutionTargetProcess(input.runId, input.target, input.command, ["--version"], options)
      : await runChildProcess(input.runId, input.command, ["--version"], options);
    if (result.timedOut || result.exitCode !== 0) return null;
    return parseOpenCodeCliVersion(`${result.stdout}\n${result.stderr}`);
  } catch {
    return null;
  }
}
