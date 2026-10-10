import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

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

export function usesOpenCodeV2Cli(version: OpenCodeCliVersion | null): boolean {
  return version?.major === 2;
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
