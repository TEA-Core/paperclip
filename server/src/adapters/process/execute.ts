import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  isForbiddenConfigEnvKey,
  isPaperclipRuntimeEnvKey,
  buildInvocationEnvForLogs,
  ensurePathInEnv,
  resolveCommandForLogs,
  runChildProcess,
} from "../utils.js";
import { applyPaperclipGitHubCredentialHelperGate } from "@paperclipai/adapter-utils/server-utils";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, onLog, onMeta, authToken } = ctx;
  const command = asString(config.command, "");
  if (!command) throw new Error("Process adapter missing command");

  const args = asStringArray(config.args);
  const cwd = asString(config.cwd, process.cwd());
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent),
  };
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v !== "string") continue;
    // Runtime PAPERCLIP_* always wins over config, and PAPERCLIP_API_KEY is
    // never accepted from config — the harness-minted run token is the only
    // source. Other PAPERCLIP_* keys Paperclip did not assign flow through.
    if (isForbiddenConfigEnvKey(k)) continue;
    if (isPaperclipRuntimeEnvKey(k) && k in env) continue;
    env[k] = v;
  }
  env.PAPERCLIP_RUN_ID = runId;
  if (authToken) env.PAPERCLIP_API_KEY = authToken;
  // Wire the agent-side GitHub App credential helper into this run's git so
  // git/gh authenticate against github.com with on-demand, broker-minted
  // installation tokens instead of a long-lived GH_TOKEN (SUP-14752 / GH-APP-6).
  // The helper ships with the server (not the run's workspace), so its path is
  // resolved from the server's own module tree — independent of cwd. Activation
  // is gated behind PAPERCLIP_AGENT_GIT_CREDENTIAL_HELPER (off by default) so
  // rollout is a reversible env change; behavior is byte-identical when the
  // flag is unset. When on, the existence check is the safety net — we never
  // point git at a helper that is not present, and GIT_TERMINAL_PROMPT=0 makes
  // git fail fast instead of prompting. See docs/deploy/secrets.md.
  applyPaperclipGitHubCredentialHelperGate(env, {
    flagEnv: process.env,
    moduleDir: path.dirname(fileURLToPath(import.meta.url)),
    cwd,
  });
  // runtimeEnv is only used to resolve the command path and log HOME below;
  // the child env is built inside runChildProcess from
  // sanitizeInheritedPaperclipEnv(process.env) + env, so a PAPERCLIP_API_KEY
  // on the server process never reaches the child.
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);

  if (onMeta) {
    await onMeta({
      adapterType: "process",
      command: resolvedCommand,
      cwd,
      commandArgs: args,
      env: loggedEnv,
    });
  }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
    onSpawn: ctx.onSpawn,
  });

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
    };
  }

  if ((proc.exitCode ?? 0) !== 0) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: `Process exited with code ${proc.exitCode ?? -1}`,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
    };
  }

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
  };
}
