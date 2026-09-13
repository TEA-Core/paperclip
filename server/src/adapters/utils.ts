// Re-export everything from the shared adapter-utils/server-utils package.
// This file is kept as a convenience shim so existing in-tree
// imports (process/, http/, heartbeat.ts) don't need rewriting.
import type { ChildProcess } from "node:child_process";
import { logger } from "../middleware/logger.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";
import { registerRunProcessGroupCounter } from "@paperclipai/adapter-utils/run-process-cap";
import { countLiveProcessGroupMembers } from "../services/local-service-supervisor.js";
export type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

type BuildInvocationEnvForLogsOptions = {
  runtimeEnv?: NodeJS.ProcessEnv | Record<string, string>;
  includeRuntimeKeys?: string[];
  resolvedCommand?: string | null;
  resolvedCommandEnvKey?: string;
};

export const runningProcesses: Map<string, { child: ChildProcess; graceSec: number; processGroupId: number | null }> =
  serverUtils.runningProcesses;

// SUP-16011: wire the census-grade `/proc` process-group counter into the
// run-child seam so the per-run process cap (`PAPERCLIP_RUN_PROCESS_CAP`,
// derived default 512) can measure a run's existing group before it spawns.
// The census owns `countLiveProcessGroupMembers`; injecting it here keeps the
// seam single and introduces no second process-walking primitive. This module
// is imported early (the census and the process adapter both reach it), so the
// counter is in place before any run child is created. Stays inert on
// non-Linux hosts, where the counter returns null and the cap fails open.
registerRunProcessGroupCounter(countLiveProcessGroupMembers);
export const MAX_CAPTURE_BYTES = serverUtils.MAX_CAPTURE_BYTES;
export const MAX_EXCERPT_BYTES = serverUtils.MAX_EXCERPT_BYTES;
export const parseObject = serverUtils.parseObject;
export const asString = serverUtils.asString;
export const asNumber = serverUtils.asNumber;
export const asBoolean = serverUtils.asBoolean;
export const asStringArray = serverUtils.asStringArray;
export const parseJson = serverUtils.parseJson;
export const appendWithCap = serverUtils.appendWithCap;
export const appendWithByteCap = serverUtils.appendWithByteCap;
export const resolvePathValue = serverUtils.resolvePathValue;
export const renderTemplate = serverUtils.renderTemplate;
export const redactEnvForLogs = serverUtils.redactEnvForLogs;
export const buildPaperclipEnv = serverUtils.buildPaperclipEnv;
export const buildRuntimeToolsEnv = serverUtils.buildRuntimeToolsEnv;
export const isPaperclipRuntimeEnvKey = serverUtils.isPaperclipRuntimeEnvKey;
export const isForbiddenConfigEnvKey = serverUtils.isForbiddenConfigEnvKey;
export const defaultPathForPlatform = serverUtils.defaultPathForPlatform;
export const ensurePathInEnv = serverUtils.ensurePathInEnv;
export const ensureAbsoluteDirectory = serverUtils.ensureAbsoluteDirectory;
export const ensureCommandResolvable = serverUtils.ensureCommandResolvable;
export const resolveCommandForLogs = serverUtils.resolveCommandForLogs;

export function buildInvocationEnvForLogs(
  env: Record<string, string>,
  options: BuildInvocationEnvForLogsOptions = {},
): Record<string, string> {
  const maybeBuildInvocationEnvForLogs = (
    serverUtils as typeof serverUtils & {
      buildInvocationEnvForLogs?: (
        env: Record<string, string>,
        options?: BuildInvocationEnvForLogsOptions,
      ) => Record<string, string>;
    }
  ).buildInvocationEnvForLogs;

  if (typeof maybeBuildInvocationEnvForLogs === "function") {
    return maybeBuildInvocationEnvForLogs(env, options);
  }

  const merged: Record<string, string> = { ...env };
  const runtimeEnv = options.runtimeEnv ?? {};

  for (const key of options.includeRuntimeKeys ?? []) {
    if (key in merged) continue;
    const value = runtimeEnv[key];
    if (typeof value !== "string" || value.length === 0) continue;
    merged[key] = value;
  }

  const resolvedCommand = options.resolvedCommand?.trim();
  if (resolvedCommand) {
    merged[options.resolvedCommandEnvKey ?? "PAPERCLIP_RESOLVED_COMMAND"] =
      serverUtils.redactCommandTextForLogs(resolvedCommand);
  }

  return redactEnvForLogs(merged);
}

// Re-export runChildProcess with the server's pino logger wired in.
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
const _runChildProcess = serverUtils.runChildProcess;

export async function runChildProcess(
  runId: string,
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutSec: number;
    graceSec: number;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  },
): Promise<RunProcessResult> {
  return _runChildProcess(runId, command, args, {
    ...opts,
    onLogError: (err, id, msg) => logger.warn({ err, runId: id }, msg),
  });
}
