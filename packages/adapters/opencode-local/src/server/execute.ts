import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  adapterExecutionTargetDuplexObservabilityRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  readAdapterExecutionTarget,
  readAdapterExecutionTargetHomeDir,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  applyPaperclipGhWrapperGate,
  applyPaperclipGitHubCredentialHelperGate,
  joinPromptSections,
  renderRunDeadlineNotice,
  buildRunDeadlineEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  renderPaperclipWakePrompt,
  isPaperclipRecoveryWakePayload,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  runChildProcess,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolvePaperclipDesiredSkillNames,
  sanitizeInheritedPaperclipEnv,
  signalRunningProcess,
  runningProcesses,
  type OrphanedProcessEvidence,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import {
  describeIncompleteOpenCodeStream,
  isOpenCodeTerminalBillingError,
  isOpenCodeTransientStatementError,
  isOpenCodeUnknownSessionError,
  parseOpenCodeJsonl,
} from "./parse.js";
import {
  ensureOpenCodeModelConfiguredAndAvailable,
  isTruthyEnvFlag,
  parseOpenCodeModelsOutput,
  requireOpenCodeModelId,
} from "./models.js";
import { removeMaintainerOnlySkillSymlinks } from "@paperclipai/adapter-utils/server-utils";
import {
  describeOpenCodeDatabaseGrowthSpare,
  describeOpenCodeDatabaseGrowthTrip,
  formatBytes,
  readOpenCodeSessionIdFromChunk,
  resolveOpenCodeDatabaseGrowthLimitBytes,
  resolveOpenCodeDatabasePath,
  resolveOpenCodeDatabasePollIntervalMs,
  startOpenCodeDatabaseGrowthGuard,
  type OpenCodeDatabaseGrowthGuard,
  type OpenCodeDatabaseGrowthTrip,
} from "./db-guard.js";
import { ensureAgentAccessibleDir } from "@paperclipai/adapter-utils/agent-shared-dir";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import { redactCommandText } from "@paperclipai/adapter-utils/command-redaction";
import { resolveOpenCodeSkillsHome } from "./skills.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "").trim();
}

function stderrTail(text: string, maxLines = 10): string {
  const stripped = stripAnsi(text);
  const lines = stripped.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "";
  return lines.slice(-maxLines).join("\n");
}

// SUP-14939: when the smart router refuses admission it returns 503 with a body
// like {"reason":"no_eligible_rung","type":"router_abort"}, and opencode exits
// non-zero. That used to classify as opencode_exit_<N> — the SAME code as a
// genuine agent bug, a tool crash, or a model fault — because a non-zero exit
// code is this classifier's top-priority input and the 503 body was only
// reachable inside free-text stderrTail. The router body DOES reach the
// adapter: opencode emits the provider error as a stdout JSONL `error` event,
// which parseOpenCodeJsonl folds into parsedError (verified on opencode 1.18.27,
// 2026-09-04; stderr stays empty on this path). It can also surface on stderr
// under --print-logs, so scan both. Detect it BEFORE the exit-code branch, and
// only on a run that actually failed, so a healthy run whose log happens to
// mention the router is never mislabelled.
const ROUTER_ABORT_SIGNATURES: RegExp[] = [
  /router_abort/i,
  /no_eligible_rung/i,
  /no_eligible_target/i,
  /no eligible (?:rungs?|target)/i,
];

function hasRouterAbortSignature(text: string | null | undefined): boolean {
  if (!text) return false;
  return ROUTER_ABORT_SIGNATURES.some((pattern) => pattern.test(text));
}

// Pull the router `reason` out of the 503 body. Prefers the JSON `"reason"`
// field (clean or backslash-escaped), then the prose form, else "".
function extractRouterAbortReason(text: string): string {
  if (!text) return "";
  const clean = text.match(/"reason"\s*:\s*"([^"\\]+)"/);
  if (clean) return clean[1].trim();
  const escaped = text.match(/\\"reason\\"\s*:\s*\\"([^"\\]+)\\"/);
  if (escaped) return escaped[1].trim();
  const prose = text.match(/no eligible (?:rungs?|target)/i);
  if (prose) return prose[0].toLowerCase().replace(/\s+/g, "_");
  return "";
}

// Collapse a reason into a stable errorCode suffix: "no eligible target" ->
// "no_eligible_target". Returns "" when there is nothing to collapse.
function sanitizeRouterAbortReasonToken(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Check the router body on the channels it can reach, in priority order
// (parsedError first, then stderr). Returns the extracted reason — "" when a
// signature is present but no reason is extractable — or null when no signature
// is found at all.
function detectRouterAbortReason(parsedError: string, stderr: string): string | null {
  for (const text of [parsedError, stderr]) {
    if (hasRouterAbortSignature(text)) {
      return extractRouterAbortReason(text);
    }
  }
  return null;
}

/**
 * Classify the underlying cause of a non-timeout adapter failure into a
 * structured errorCode + errorMeta, so the heartbeat layer and downstream
 * consumers get a machine-readable reason instead of a bare ANSI string.
 *
 * Priority order:
 *   0. router admission refusal → router_abort[_<reason>]  (SUP-14939)
 *   1. non-zero exit code → opencode_exit_<N>
 *   2. signal termination → opencode_signal_<SIGNAL>
 *   3. parsed JSONL error → opencode_tool_error
 *   4. stderr content → opencode_stderr_error
 *   5. otherwise → null (success)
 */
export function classifyOpenCodeFailure(input: {
  exitCode: number | null;
  signal: string | null;
  parsedError: string;
  stderrLine: string;
  adapterSessionId: string | null;
  stderr: string;
  toolErrors: string[];
}): { errorCode: string | null; errorMeta: Record<string, unknown> } {
  const { exitCode, signal, parsedError, stderrLine, adapterSessionId, stderr, toolErrors } = input;
  const errorMeta: Record<string, unknown> = {
    adapterSessionId,
    stderrTail: stderrTail(stderr),
  };
  let errorCode: string | null = null;
  const runFailed =
    (exitCode !== null && exitCode !== 0) || signal !== null || parsedError.length > 0;
  const routerAbortReason = runFailed ? detectRouterAbortReason(parsedError, stderr) : null;
  if (routerAbortReason !== null) {
    const token = sanitizeRouterAbortReasonToken(routerAbortReason);
    errorCode = token ? `router_abort_${token}` : "router_abort";
    errorMeta.routerAbort = true;
    if (routerAbortReason) {
      errorMeta.routerAbortReason = routerAbortReason;
    }
  } else if (exitCode !== null && exitCode !== 0) {
    errorCode = `opencode_exit_${exitCode}`;
  } else if (signal) {
    errorCode = `opencode_signal_${signal}`;
  } else if (parsedError) {
    errorCode = "opencode_tool_error";
  } else if (stderrLine) {
    errorCode = "opencode_stderr_error";
  }
  if (parsedError) {
    errorMeta.parsedError = parsedError;
  }
  if (toolErrors.length > 0) {
    errorMeta.toolErrors = toolErrors;
  }
  return { errorCode, errorMeta };
}

/**
 * SUP-13963: a failure that records a non-null `errorCode` must leave a
 * greppable line in the container log. `errorMeta.stderrTail` is captured and
 * persisted on the run record, but until this it reached no log — the next
 * `opencode_exit_N` was an elimination exercise instead of a grep. One
 * structured line per failed run, scrubbed through the adapter's existing
 * redaction helper; the JSON payload keeps multi-line tails on a single
 * physical line so the grep target stays one line per failure.
 */
export function buildOpenCodeFailureLogLine(input: {
  runId: string;
  errorCode: string | null;
  errorMeta?: Record<string, unknown> | null;
}): string | null {
  const { runId, errorCode, errorMeta } = input;
  if (!errorCode) return null;
  const stderrTail = typeof errorMeta?.stderrTail === "string" ? errorMeta.stderrTail : "";
  const adapterSessionId =
    typeof errorMeta?.adapterSessionId === "string" ? errorMeta.adapterSessionId : null;
  return (
    `[paperclip] ${JSON.stringify({
      event: "opencode_adapter_failure",
      runId,
      errorCode,
      adapterSessionId,
      stderrTail: redactCommandText(stderrTail),
    })}\n`
  );
}

// SUP-10914: opencode resolves its SQLite database as
// `OPENCODE_DB` (joined to its data dir when relative) and otherwise defaults to
// `<data dir>/opencode.db`. Every Paperclip run shares one HOME, so every agent
// shared that one database — and opencode opens it with `busy_timeout = 5000`.
// On 2026-08-04 a single 431 MB assistant message, rewritten in full on every
// stream delta, held the only write lock long enough that every other agent's
// write blew that timeout ("Failed to execute statement / database is locked"),
// producing 63 `adapter_failed` in one hour across 7 agents.
//
// Giving each agent its own database file keeps a runaway run's blast radius
// inside that agent. The name stays RELATIVE so opencode still resolves it
// inside its own data dir, which keeps `auth.json` and the rest of the data dir
// shared — only the database is partitioned.
//
// SUP-11268 asked for a per-RUN file so a runaway run could not be confused with
// its siblings. That is not viable: opencode keeps its sessions in this database,
// and a fresh file per run would make every cross-run `--session` resume fail as
// an unknown session (see resolveOpenCodeSessionResume and the unknown-session
// fallback below), silently losing conversation continuity on every run. The
// misattribution it targeted is instead handled per SESSION inside the growth
// guard (SUP-11280), which is why the file stays per agent.
const OPENCODE_DB_AGENT_PREFIX = "opencode-agent-";

export function resolveOpenCodeDatabaseFile(input: {
  agentId: string;
  env: Record<string, string>;
  processEnv?: NodeJS.ProcessEnv;
}): string | null {
  const processEnv = input.processEnv ?? process.env;
  // Escape hatch: fall back to the single shared database.
  if (
    isTruthyEnvFlag(
      input.env.PAPERCLIP_OPENCODE_SHARED_DB ?? processEnv.PAPERCLIP_OPENCODE_SHARED_DB,
    )
  ) {
    return null;
  }
  // An explicitly configured database (adapterConfig.env or the host env) wins.
  const configured = (input.env.OPENCODE_DB ?? processEnv.OPENCODE_DB ?? "").trim();
  if (configured.length > 0) return null;
  const agentId = input.agentId.trim();
  if (agentId.length === 0) return null;
  return `${OPENCODE_DB_AGENT_PREFIX}${agentId.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`;
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function resolveOpenCodeBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "unknown";
}

const REMOTE_OPENCODE_MODELS_PROBE_DEFAULT_TIMEOUT_SEC = 20;
const REMOTE_OPENCODE_MODELS_PROBE_SANDBOX_TIMEOUT_SEC = 120;

export async function ensureRemoteOpenCodeModelConfiguredAndAvailable(input: {
  runId: string;
  executionTarget: NonNullable<AdapterExecutionContext["executionTarget"]>;
  command: string;
  model: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}) {
  const model = requireOpenCodeModelId(input.model);

  // When the caller opts into OPENCODE_ALLOW_ALL_MODELS, OpenCode accepts any
  // provider/model at run time (e.g. gateway-routed models that never appear in
  // `opencode models` output). Honour that on the REMOTE path too by skipping the
  // remote availability probe; we still enforce the provider/model format above.
  // Mirrors the local ensureOpenCodeModelConfiguredAndAvailable bypass. Prefer the
  // explicit run env, then the process env.
  if (isTruthyEnvFlag(input.env.OPENCODE_ALLOW_ALL_MODELS ?? process.env.OPENCODE_ALLOW_ALL_MODELS)) {
    return;
  }

  const defaultProbeTimeoutSec =
    input.executionTarget.kind === "remote" && input.executionTarget.transport === "sandbox"
      ? REMOTE_OPENCODE_MODELS_PROBE_SANDBOX_TIMEOUT_SEC
      : REMOTE_OPENCODE_MODELS_PROBE_DEFAULT_TIMEOUT_SEC;
  const probeTimeoutSec = input.timeoutSec > 0
    ? Math.min(input.timeoutSec, defaultProbeTimeoutSec)
    : defaultProbeTimeoutSec;
  const probe = await runAdapterExecutionTargetProcess(
    input.runId,
    input.executionTarget,
    input.command,
    ["models"],
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: probeTimeoutSec,
      graceSec: input.graceSec,
      onLog: async () => {},
    },
  );

  // The remote availability probe is a best-effort pre-flight guard, not a gate.
  // If `opencode models` itself cannot run on the target — timeout, transient CLI
  // error, provider hiccup — do NOT abort the run. The real invocation is
  // authoritative, so a probe that can't execute must never be fatal. (Previously
  // these threw and crashed runs mid-flight, losing the agent's work + disposition.)
  if (probe.timedOut) {
    console.warn(
      `[opencode-local] Remote model availability probe for "${model}" timed out after ${probeTimeoutSec}s; proceeding with the configured model.`,
    );
    return;
  }

  if ((probe.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(probe.stderr) || firstNonEmptyLine(probe.stdout);
    console.warn(
      `[opencode-local] Remote \`opencode models\` could not run for "${model}"${
        detail ? ` (${detail})` : ""
      }; proceeding with the configured model.`,
    );
    return;
  }

  const models = parseOpenCodeModelsOutput(probe.stdout);
  if (models.length === 0) {
    console.warn(
      `[opencode-local] Remote \`opencode models\` returned no models; proceeding with the configured model "${model}".`,
    );
    return;
  }

  if (!models.some((entry) => entry.id === model)) {
    const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured OpenCode model is unavailable on the remote execution target: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }
}

async function ensureOpenCodeSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
  skillsHome = resolveOpenCodeSkillsHome({}),
) {
  await fs.mkdir(skillsHome, { recursive: true });
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only OpenCode skill "${skillName}" from ${skillsHome}\n`,
    );
  }
  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} OpenCode skill "${entry.key}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject OpenCode skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function buildOpenCodeSkillsDir(config: Record<string, unknown>): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-skills-"));
  // Same 0700-mkdtemp hazard as the runtime config (SUP-13484): this path is handed
  // to the agent child, which runs at uid 1001 and cannot traverse a 0700 server dir.
  await ensureAgentAccessibleDir(tmp);
  const target = path.join(tmp, "skills");
  await fs.mkdir(target, { recursive: true });
  await ensureAgentAccessibleDir(target);
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = new Set(resolveLegacyPaperclipDesiredSkillNames(config, availableEntries));
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry)) continue;
    await fs.symlink(entry.source, path.join(target, entry.runtimeName));
  }
  return target;
}

export type OpenCodeSessionResumeDecision =
  | { resume: true; sessionId: string }
  | {
      resume: false;
      sessionId: string | null;
      reason: "no_session" | "unknown_cwd" | "cwd_mismatch" | "execution_target_mismatch";
    };

// `opencode run --session <s> --dir <d>` hangs forever when <d> is not the
// directory <s> was created in: opencode bootstraps <d>, then bootstraps the
// session's own recorded directory, exits its prompt loop, and then never
// terminates or writes a byte to stdout. Because the process adapter waits on
// child exit, that pins the heartbeat run at `running` with no exit code.
//
// So a resume requires positive proof that the session belongs to the directory
// we are about to run in. An unknown session cwd is NOT proof: sessions carried
// on the legacy `agent_runtime_state.session_id` fallback have no recorded cwd,
// and resuming those into whatever workspace resolution picked is exactly how
// the hang was reached. A fresh session that works beats a resumed session that
// hangs.
export function resolveOpenCodeSessionResume(input: {
  sessionId: string;
  sessionCwd: string;
  executionCwd: string;
  executionTargetMatches: boolean;
}): OpenCodeSessionResumeDecision {
  if (input.sessionId.length === 0) {
    return { resume: false, sessionId: null, reason: "no_session" };
  }
  if (!input.executionTargetMatches) {
    return { resume: false, sessionId: input.sessionId, reason: "execution_target_mismatch" };
  }
  if (input.sessionCwd.length === 0) {
    return { resume: false, sessionId: input.sessionId, reason: "unknown_cwd" };
  }
  if (path.resolve(input.sessionCwd) !== path.resolve(input.executionCwd)) {
    return { resume: false, sessionId: input.sessionId, reason: "cwd_mismatch" };
  }
  return { resume: true, sessionId: input.sessionId };
}

// OpenCode 1.18+ resolves the directory its session is rooted at from PWD, not
// from the process cwd, so a stale inherited PWD silently moves the session (and
// the directory its write permissions are scoped to) off the provisioned
// execution workspace. runChildProcess now keeps PWD aligned with the spawn cwd;
// passing --dir as well pins the run directory explicitly instead of relying on
// that env side channel alone.
export function buildOpenCodeRunArgs(input: {
  dir: string;
  model: string;
  variant: string;
  extraArgs: string[];
  printLogs: boolean;
  resumeSessionId: string | null;
}): string[] {
  const args = ["run", "--format", "json"];
  if (input.printLogs) args.push("--print-logs");
  if (input.dir) args.push("--dir", input.dir);
  if (input.resumeSessionId) args.push("--session", input.resumeSessionId);
  if (input.model) args.push("--model", input.model);
  if (input.variant) args.push("--variant", input.variant);
  if (input.extraArgs.length > 0) args.push(...input.extraArgs);
  return args;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "opencode");
  const model = asString(config.model, "").trim();
  const variant = asString(config.variant, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const openCodeSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredOpenCodeSkillNames = resolveLegacyPaperclipDesiredSkillNames(config, openCodeSkillEntries);
  if (!executionTargetIsRemote) {
    await ensureOpenCodeSkillsInjected(
      onLog,
      openCodeSkillEntries,
      desiredOpenCodeSkillNames,
      resolveOpenCodeSkillsHome(config),
    );
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  // Prevent OpenCode from writing an opencode.json config file into the
  // project working directory (which would pollute the git repo).  Model
  // selection is already handled via the --model CLI flag.  Set after the
  // envConfig loop so user overrides cannot disable this guard.
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
  // Partition the shared opencode SQLite database per agent (SUP-10914). Set
  // after the envConfig merge so an operator-configured OPENCODE_DB still wins.
  const openCodeDatabaseFile = resolveOpenCodeDatabaseFile({ agentId: agent.id, env });
  if (openCodeDatabaseFile) {
    env.OPENCODE_DB = openCodeDatabaseFile;
  }
  if (authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  // Wire the agent-side GitHub App credential helper (GH-APP-6 / SUP-14752) and
  // the `gh` wrapper (GH-APP-7 / SUP-14857) into this run's env so git/gh
  // authenticate against github.com with on-demand, broker-minted installation
  // tokens instead of a long-lived GH_TOKEN / shared PAT (SUP-14869). The
  // helpers ship with the server, so their paths resolve from the server's own
  // module tree — independent of the run's cwd. Both gates read the rollout flag
  // from the server process env — a read-only reference (`flagEnv`), never copied
  // into the child env — and are byte-identical no-ops when their flag is unset.
  // The gh gate also resolves the real `gh` from the inherited base PATH
  // (read-only `basePath`) and the scratch bin dir from PAPERCLIP_RUN_SCRATCH_DIR
  // in the run env, matching the process-adapter reference wiring. These
  // mutations run BEFORE prepareOpenCodeRuntimeConfig so they flow into
  // preparedRuntimeConfig.env, the object that composes the child env. `__moduleDir`
  // is one level deeper than
  // the process-adapter wiring this resolver was calibrated against, so step up
  // one directory — that makes the resolver's repo-root candidate resolve to the
  // server's `scripts/` dir rather than a `packages/` subpath.
  applyPaperclipGitHubCredentialHelperGate(env, {
    flagEnv: process.env, // spawn-env-guard: read-only — gate only reads the rollout flag; nothing is copied into the child env
    moduleDir: path.resolve(__moduleDir, ".."),
    cwd,
  });
  applyPaperclipGhWrapperGate(env, {
    flagEnv: process.env, // spawn-env-guard: read-only — gate only reads the rollout flag; nothing is copied into the child env
    moduleDir: path.resolve(__moduleDir, ".."),
    basePath: process.env.PATH ?? "", // spawn-env-guard: read-only — gate only resolves the real `gh` from the inherited PATH; not written to the child env
    cwd,
    onWarn: (message) => {
      void onLog("stderr", `paperclip-gh-wrapper: ${message}\n`);
    },
  });
  const preparedRuntimeConfig = await prepareOpenCodeRuntimeConfig({ env, config });
  const localRuntimeConfigHome = preparedRuntimeConfig.runtimeConfigHome;
  try {
    const runtimeEnv = Object.fromEntries(
      Object.entries(ensurePathInEnv({ ...sanitizeInheritedPaperclipEnv(process.env), ...preparedRuntimeConfig.env })).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
      executionTarget,
      asNumber(config.timeoutSec, 0),
    );
    const graceSec = asNumber(config.graceSec, 20);
    // One deadline, shared by the child's env and the prompt's wrap-up guidance —
    // two independently computed values would drift by the spawn latency between
    // them and quietly contradict each other. Derived from the EFFECTIVE timeout,
    // which a remote execution target may have capped below the configured one.
    const deadlineEnv = buildRunDeadlineEnv(timeoutSec);
    Object.assign(preparedRuntimeConfig.env, deadlineEnv);
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
    detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog,
    });
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
      installCommand: SANDBOX_INSTALL_COMMAND,
      timeoutSec,
    });
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
    let loggedEnv = buildInvocationEnvForLogs(preparedRuntimeConfig.env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });
    if (!executionTargetIsRemote) {
      await ensureOpenCodeModelConfiguredAndAvailable({
        model,
        command,
        cwd,
        env: runtimeEnv,
      });
    }

    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();
    let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
    let localSkillsDir: string | null = null;
    let remoteRuntimeRootDir: string | null = null;
    let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

    if (executionTarget?.kind === "remote") {
      localSkillsDir = await buildOpenCodeSkillsDir(config);
      await onLog(
        "stdout",
        `[paperclip] Syncing workspace and OpenCode runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "opencode",
        timeoutSec,
        workspaceLocalDir: cwd,
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        onProgress: (line) => onLog("stdout", line),
        onRuntimeProgress: ctx.onRuntimeProgress,
        assets: [
          {
            key: "skills",
            localDir: localSkillsDir,
            followSymlinks: true,
          },
          ...(localRuntimeConfigHome
            ? [{
              key: "xdgConfig",
              localDir: localRuntimeConfigHome,
            }]
            : []),
        ],
      });
      restoreRemoteWorkspace = () =>
        preparedExecutionTargetRuntime.restoreWorkspace((line) => onLog("stdout", line));
      effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
      refreshPaperclipWorkspaceEnvForExecution({
        env: preparedRuntimeConfig.env,
        envConfig,
        workspaceCwd: effectiveWorkspaceCwd,
        workspaceSource,
        workspaceId,
        workspaceRepoUrl,
        workspaceRepoRef,
        workspaceHints,
        agentHome,
        executionTargetIsRemote,
        executionCwd: effectiveExecutionCwd,
      });
      remoteRuntimeRootDir = preparedExecutionTargetRuntime.runtimeRootDir;
      const managedHome = adapterExecutionTargetUsesManagedHome(executionTarget);
      if (managedHome && preparedExecutionTargetRuntime.runtimeRootDir) {
        preparedRuntimeConfig.env.HOME = preparedExecutionTargetRuntime.runtimeRootDir;
      }
      if (localRuntimeConfigHome && preparedExecutionTargetRuntime.assetDirs.xdgConfig) {
        preparedRuntimeConfig.env.XDG_CONFIG_HOME = preparedExecutionTargetRuntime.assetDirs.xdgConfig;
      }
      const remoteHomeDir = managedHome && preparedExecutionTargetRuntime.runtimeRootDir
        ? preparedExecutionTargetRuntime.runtimeRootDir
        : await readAdapterExecutionTargetHomeDir(runId, executionTarget, {
            cwd,
            env: preparedRuntimeConfig.env,
            timeoutSec,
            graceSec,
            onLog,
          });
      if (remoteHomeDir && preparedExecutionTargetRuntime.assetDirs.skills) {
        const remoteSkillsDir = path.posix.join(remoteHomeDir, ".claude", "skills");
        await runAdapterExecutionTargetShellCommand(
          runId,
          executionTarget,
          `mkdir -p ${JSON.stringify(path.posix.dirname(remoteSkillsDir))} && rm -rf ${JSON.stringify(remoteSkillsDir)} && cp -a ${JSON.stringify(preparedExecutionTargetRuntime.assetDirs.skills)} ${JSON.stringify(remoteSkillsDir)}`,
          { cwd, env: preparedRuntimeConfig.env, timeoutSec, graceSec, onLog },
        );
      }
      await ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId,
        executionTarget,
        command,
        model,
        cwd,
        env: preparedRuntimeConfig.env,
        timeoutSec,
        graceSec,
      });
    }
    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeExecutionTarget),
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeExecutionTarget),
        runtimeRootDir: remoteRuntimeRootDir,
        adapterKey: "opencode",
        timeoutSec,
        hostApiToken: preparedRuntimeConfig.env.PAPERCLIP_API_KEY,
        onLog,
      });
      if (paperclipBridge) {
        Object.assign(preparedRuntimeConfig.env, paperclipBridge.env);
        loggedEnv = buildInvocationEnvForLogs(preparedRuntimeConfig.env, {
          runtimeEnv: Object.fromEntries(
            Object.entries(ensurePathInEnv({ ...sanitizeInheritedPaperclipEnv(process.env), ...preparedRuntimeConfig.env })).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          includeRuntimeKeys: ["HOME"],
          resolvedCommand,
        });
      }
    }

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const resumeDecision = resolveOpenCodeSessionResume({
      sessionId: runtimeSessionId,
      sessionCwd: runtimeSessionCwd,
      executionCwd: effectiveExecutionCwd,
      executionTargetMatches: adapterExecutionTargetSessionMatches(
        runtimeRemoteExecution,
        runtimeExecutionTarget,
      ),
    });
    const sessionId = resumeDecision.resume ? resumeDecision.sessionId : null;
    if (!resumeDecision.resume && resumeDecision.reason === "execution_target_mismatch") {
      await onLog(
        "stdout",
        `[paperclip] OpenCode session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
      );
    } else if (!resumeDecision.resume && resumeDecision.reason === "unknown_cwd") {
      await onLog(
        "stdout",
        `[paperclip] OpenCode session "${runtimeSessionId}" has no recorded workspace directory, so it cannot be proven to belong to "${effectiveExecutionCwd}" and will not be resumed. Starting a fresh session.\n`,
      );
    } else if (!resumeDecision.resume && resumeDecision.reason === "cwd_mismatch") {
      await onLog(
        "stdout",
        `[paperclip] OpenCode session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
      );
    }
    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    const resolvedInstructionsFilePath = instructionsFilePath
      ? path.resolve(cwd, instructionsFilePath)
      : "";
    const instructionsDir = resolvedInstructionsFilePath ? `${path.dirname(resolvedInstructionsFilePath)}/` : "";
    let instructionsPrefix = "";
    if (resolvedInstructionsFilePath && !sessionId) {
      try {
        const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
        instructionsPrefix =
          `${instructionsContents}\n\n` +
          `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
          `Resolve any relative file references from ${instructionsDir}.\n\n` +
          `Your execution workspace path is: ${cwd} (also available as the environment variable $PAPERCLIP_WORKSPACE_CWD).\n\n`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await onLog(
          "stdout",
          `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
        );
      }
    }

    const commandNotes = (() => {
      const notes = [...preparedRuntimeConfig.notes];
      if (!resolvedInstructionsFilePath) return notes;
      if (sessionId) {
        notes.push(`Skipped instructions prepend (resumed session ${sessionId})`);
        return notes;
      }
      if (instructionsPrefix.length > 0) {
        notes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
        notes.push(
          `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
        );
        notes.push(
          `Injected literal workspace path ${cwd} into prompt.`,
        );
        return notes;
      }
      notes.push(
        `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      );
      return notes;
    })();

    const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const renderedBootstrapPrompt =
      !sessionId && bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
        : "";
    const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
    const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
    const renderedPrompt = shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const deadlineNotice = renderRunDeadlineNotice(
      timeoutSec,
      Number(deadlineEnv.PAPERCLIP_RUN_DEADLINE_EPOCH ?? 0),
    );
    const prompt = joinPromptSections([
      instructionsPrefix,
      renderedBootstrapPrompt,
      deadlineNotice,
      wakePrompt,
      sessionHandoffNote,
      renderedPrompt,
    ]);
    const promptMetrics = {
      promptChars: prompt.length,
      instructionsChars: instructionsPrefix.length,
      deadlineNoticeChars: deadlineNotice.length,
      bootstrapPromptChars: renderedBootstrapPrompt.length,
      wakePromptChars: wakePrompt.length,
      sessionHandoffChars: sessionHandoffNote.length,
      heartbeatPromptChars: renderedPrompt.length,
    };

    // Optional diagnostic: surface OpenCode's own logs on stderr (captured into the
    // run result) so failures that OpenCode otherwise wraps as an opaque
    // "Unexpected server error" can be diagnosed in remote/sandbox runs where the
    // log file is unreachable. Toggle via PAPERCLIP_OPENCODE_PRINT_LOGS (run env,
    // then process env).
    const printLogs = isTruthyEnvFlag(
      env.PAPERCLIP_OPENCODE_PRINT_LOGS ?? process.env.PAPERCLIP_OPENCODE_PRINT_LOGS,
    );
    // SUP-10914: watch this agent's own database for the runaway-message
    // signature and terminate the run before it writes hundreds of megabytes.
    // Only armed when we set the per-agent database ourselves: on the shared
    // database (operator-configured OPENCODE_DB, or PAPERCLIP_OPENCODE_SHARED_DB)
    // the growth we would measure may belong to a different agent's run, and
    // killing this run for someone else's writes would be worse than the leak.
    // Remote targets are skipped because the file is not on this host.
    const databaseGuardPath =
      openCodeDatabaseFile && !executionTargetIsRemote
        ? resolveOpenCodeDatabasePath({ databaseFile: openCodeDatabaseFile, env: runtimeEnv })
        : null;
    const databaseGuardLimitBytes = databaseGuardPath
      ? resolveOpenCodeDatabaseGrowthLimitBytes({ env: runtimeEnv })
      : 0;
    const databaseGuardPollIntervalMs = resolveOpenCodeDatabasePollIntervalMs({ env: runtimeEnv });
    let databaseGuardTrip: OpenCodeDatabaseGrowthTrip | null = null;
    if (databaseGuardPath && databaseGuardLimitBytes > 0) {
      commandNotes.push(
        `Armed OpenCode database growth guard on ${databaseGuardPath} (limit ${formatBytes(databaseGuardLimitBytes)} per run). ` +
          `Attribution basis: per-session accounting. Growth is attributed to this run's own ` +
          `opencode session before the run is terminated, so a sibling run's writes on this ` +
          `agent's shared database do not kill this run.`,
      );
    }

    const buildArgs = (resumeSessionId: string | null) =>
      buildOpenCodeRunArgs({
        dir: effectiveExecutionCwd,
        model,
        variant,
        extraArgs,
        printLogs,
        resumeSessionId,
      });

    const runAttempt = async (resumeSessionId: string | null) => {
      const args = buildArgs(resumeSessionId);
      if (onMeta) {
        await onMeta({
          adapterType: "opencode_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes,
          commandArgs: [...args, `<stdin prompt ${prompt.length} chars>`],
          env: loggedEnv,
          prompt,
          promptMetrics,
          context,
        });
      }

      let terminalBillingErrorDetected: string | null = null;
      // Assigned just below; the log interceptor closes over it so the guard
      // learns which opencode session this run writes to as soon as the first
      // JSONL line lands, which is what lets it tell its own growth from a
      // sibling run's on the same per-agent database (SUP-11280).
      let databaseGuard: OpenCodeDatabaseGrowthGuard | null = null;
      const earlyAbortOnLog: typeof onLog = async (stream, chunk) => {
        await onLog(stream, chunk);
        if (stream === "stdout" && databaseGuard) {
          databaseGuard.noteSessionId(readOpenCodeSessionIdFromChunk(chunk));
        }
        if (stream === "stderr" && terminalBillingErrorDetected === null) {
          const detected = isOpenCodeTerminalBillingError("", chunk);
          if (detected) {
            terminalBillingErrorDetected = detected;
            await onLog(
              "stdout",
              `[paperclip] Terminal provider billing/usage error detected in stderr; aborting run early: ${detected}\n`,
            );
            const running = runningProcesses.get(runId);
            if (running) {
              signalRunningProcess(running, "SIGTERM");
            }
          }
        }
      };

      databaseGuard = databaseGuardPath
        ? startOpenCodeDatabaseGrowthGuard({
            databasePath: databaseGuardPath,
            limitBytes: databaseGuardLimitBytes,
            pollIntervalMs: databaseGuardPollIntervalMs,
            sessionId: resumeSessionId,
            onSpare: (spare) => {
              void onLog("stdout", `[paperclip] ${describeOpenCodeDatabaseGrowthSpare(spare)}\n`);
            },
            onTrip: (trip) => {
              databaseGuardTrip = trip;
              void (async () => {
                await onLog(
                  "stdout",
                  `[paperclip] ${describeOpenCodeDatabaseGrowthTrip(trip)}\n`,
                );
                const running = runningProcesses.get(runId);
                if (running) {
                  signalRunningProcess(running, "SIGTERM");
                }
              })();
            },
          })
        : null;

      try {
        const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
          cwd,
          env: preparedRuntimeConfig.env,
          stdin: prompt,
          timeoutSec,
          graceSec,
          onSpawn,
          onRuntimeProgress: ctx.onRuntimeProgress,
          onLog: earlyAbortOnLog,
          runLogTail: paperclipBridge?.runLogTail,
          settleRunDisposition: paperclipBridge?.settleRunDisposition,
        });
        return {
          proc,
          rawStderr: proc.stderr,
          parsed: parseOpenCodeJsonl(proc.stdout),
        };
      } finally {
        databaseGuard?.stop();
      }
    };

    // SUP-13963: emit the structured failure line for any result carrying a
    // non-null errorCode. The billing-abort branch records no errorCode and
    // stays quiet (that condition has its own stdout line above).
    const emitAdapterFailureLog = async (result: {
      errorCode?: string | null;
      errorMeta?: Record<string, unknown>;
    }): Promise<void> => {
      const line = buildOpenCodeFailureLogLine({
        runId,
        errorCode: result.errorCode ?? null,
        errorMeta: result.errorMeta,
      });
      if (line) await onLog("stderr", line);
    };

    const toResult = async (
      attempt: {
        proc: {
          exitCode: number | null;
          signal: string | null;
          timedOut: boolean;
          stdout: string;
          stderr: string;
          orphanedProcess?: OrphanedProcessEvidence | null;
          // Transport-level error code from the run-disposition seam; a lost
          // duplex control channel surfaces `duplex_channel_lost` here.
          errorCode?: string | null;
        };
        rawStderr: string;
        parsed: ReturnType<typeof parseOpenCodeJsonl>;
      },
      clearSessionOnMissingSession = false,
      errorCode: string | null = null,
      // Set when the adapter itself ended the run for a reason the process's own
      // exit status cannot express (currently: the database growth guard).
      errorMessageOverride: string | null = null,
    ): Promise<AdapterExecutionResult> => {
      const terminalBillingError = isOpenCodeTerminalBillingError(
        "",
        attempt.proc.stderr,
      );
      if (terminalBillingError) {
        const billingModelId = model || null;
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          finishReason: attempt.parsed.finalStepReason,
          errorMessage: `Terminal provider billing/usage error: ${terminalBillingError}`,
          usage: {
            inputTokens: attempt.parsed.usage.inputTokens,
            outputTokens: attempt.parsed.usage.outputTokens,
            cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
          },
          sessionId: attempt.parsed.sessionId ?? runtimeSessionId ?? runtime.sessionId ?? null,
          sessionParams: null,
          sessionDisplayId: attempt.parsed.sessionId ?? runtimeSessionId ?? runtime.sessionId ?? null,
          provider: parseModelProvider(billingModelId),
          biller: resolveOpenCodeBiller(runtimeEnv, parseModelProvider(billingModelId)),
          model: billingModelId,
          billingType: "unknown",
          costUsd: attempt.parsed.costUsd,
          resultJson: {
            stdout: attempt.proc.stdout,
            stderr: attempt.proc.stderr,
            paperclipToolCallCount: attempt.parsed.paperclipToolCallCount,
          },
          summary: attempt.parsed.summary,
          clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
        };
      }

      const resolvedSessionId =
        attempt.parsed.sessionId ??
        (clearSessionOnMissingSession ? null : runtimeSessionId ?? runtime.sessionId ?? null);
      const resolvedSessionParams = resolvedSessionId
        ? ({
            sessionId: resolvedSessionId,
            cwd: effectiveExecutionCwd,
            ...(workspaceId ? { workspaceId } : {}),
            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
            ...(executionTargetIsRemote
              ? {
                  remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
                }
              : {}),
          } as Record<string, unknown>)
        : null;

      // A timeout is a SIGTERM mid-turn, not a lost session: OpenCode already
      // emitted its session id on stdout, and the session itself survives on
      // disk. Hand the resolved session back so the next run resumes it instead
      // of restarting cold and re-deriving the same context. Usage is carried
      // too — the tokens were spent whether or not the run reached the wall.
      if (attempt.proc.timedOut) {
        const result: AdapterExecutionResult = {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          errorCode: "timeout",
          errorMeta: {
            stderrTail: stderrTail(attempt.proc.stderr),
            adapterSessionId: runtimeSessionId ?? runtime.sessionId ?? null,
            // Present only when the run timed out and the process outlived
            // every signal we could send it, so an operator reading the run
            // sees the process is still out there rather than assuming the
            // timeout stopped it.
            ...(attempt.proc.orphanedProcess
              ? { orphanedProcess: attempt.proc.orphanedProcess }
              : {}),
          },
          finishReason: attempt.parsed.finalStepReason,
          usage: {
            inputTokens: attempt.parsed.usage.inputTokens,
            outputTokens: attempt.parsed.usage.outputTokens,
            cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
          },
          sessionId: resolvedSessionId,
          sessionParams: resolvedSessionParams,
          sessionDisplayId: resolvedSessionId,
          costUsd: attempt.parsed.costUsd,
          clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
        };
        await emitAdapterFailureLog(result);
        return result;
      }

      const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
      // A stream that stopped early exits 0 and reports no error, so without this it reaches
      // the heartbeat as exitCode 0 + no errorMessage and is recorded `succeeded`.
      const incompleteStreamError = describeIncompleteOpenCodeStream(attempt.parsed.finalStepReason) ?? "";
      const effectiveParsedError = parsedError || incompleteStreamError;
      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const rawExitCode = attempt.proc.exitCode;
      // We terminate a guard-tripped run with SIGTERM, which leaves exitCode
      // null; without this it would be reported as a success or an opaque
      // signal death rather than the failure the adapter deliberately caused.
      const failedForOverride = Boolean(errorMessageOverride) && (rawExitCode ?? 0) === 0;
      const synthesizedExitCode =
        failedForOverride || (effectiveParsedError && (rawExitCode ?? 0) === 0) ? 1 : rawExitCode;
      const fallbackErrorMessage =
        effectiveParsedError ||
        (stderrLine
          ? `OpenCode exited with code ${synthesizedExitCode ?? -1}: ${stderrLine}`
          : `OpenCode exited with code ${synthesizedExitCode ?? -1}`);
      const modelId = model || null;

      const adapterSessionId = runtimeSessionId ?? runtime.sessionId ?? null;
      const { errorCode: classifiedErrorCode, errorMeta } = classifyOpenCodeFailure({
        exitCode: synthesizedExitCode,
        signal: attempt.proc.signal,
        parsedError: effectiveParsedError,
        stderrLine,
        adapterSessionId,
        stderr: attempt.proc.stderr,
        toolErrors: attempt.parsed.toolErrors,
      });
      if (databaseGuardTrip) {
        errorMeta.databaseGrowth = {
          databasePath: databaseGuardTrip.databasePath,
          baselineBytes: databaseGuardTrip.baselineBytes,
          observedBytes: databaseGuardTrip.observedBytes,
          growthBytes: databaseGuardTrip.growthBytes,
          limitBytes: databaseGuardTrip.limitBytes,
        };
      }

      const result: AdapterExecutionResult = {
        exitCode: synthesizedExitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        finishReason: attempt.parsed.finalStepReason,
        errorMessage:
          errorMessageOverride ??
          ((synthesizedExitCode ?? 0) === 0 ? null : stripAnsi(fallbackErrorMessage)),
        errorCode: errorCode ?? classifiedErrorCode ?? attempt.proc.errorCode ?? null,
        errorMeta: Object.keys(errorMeta).length > 0 ? errorMeta : undefined,
        usage: {
          inputTokens: attempt.parsed.usage.inputTokens,
          outputTokens: attempt.parsed.usage.outputTokens,
          cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
        },
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: parseModelProvider(modelId),
        biller: resolveOpenCodeBiller(runtimeEnv, parseModelProvider(modelId)),
        model: modelId,
        billingType: "unknown",
        costUsd: attempt.parsed.costUsd,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
          paperclipToolCallCount: attempt.parsed.paperclipToolCallCount,
          exitCode: synthesizedExitCode,
          errorCode: errorCode ?? classifiedErrorCode ?? attempt.proc.errorCode ?? null,
          ...(Object.keys(errorMeta).length > 0 ? { errorMeta } : {}),
        },
        summary: attempt.parsed.summary,
        clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
      };
      await emitAdapterFailureLog(result);
      return result;
    };


    // A guard-tripped attempt must never be retried: the retry would replay the
    // same runaway message and write the same bytes again. This short-circuits
    // both the unknown-session retry and the transient-statement retry loop —
    // and a runaway run plausibly emits lock errors of its own, which is exactly
    // what the latter retries on.
    const databaseGuardResult = async (
      attempt: Awaited<ReturnType<typeof runAttempt>>,
    ): Promise<AdapterExecutionResult | null> => {
      if (!databaseGuardTrip) return null;
      return toResult(
        attempt,
        false,
        "opencode_db_growth_limit",
        describeOpenCodeDatabaseGrowthTrip(databaseGuardTrip),
      );
    };

    try {
      const initial = await runAttempt(sessionId);
      const initialGuardResult = await databaseGuardResult(initial);
      if (initialGuardResult) return initialGuardResult;
      const initialFailed =
        !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || Boolean(initial.parsed.errorMessage));
      if (
        sessionId &&
        initialFailed &&
        isOpenCodeUnknownSessionError(initial.proc.stdout, initial.rawStderr)
      ) {
        await onLog(
          "stdout",
          `[paperclip] OpenCode session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
        );
        const retry = await runAttempt(null);
        return (await databaseGuardResult(retry)) ?? toResult(retry, true);
      }

      if (
        initialFailed &&
        !initial.proc.timedOut &&
        isOpenCodeTransientStatementError(initial.rawStderr) &&
        initial.parsed.paperclipToolCallCount === 0 &&
        initial.parsed.summary.trim() === ""
      ) {
        const backoffs = [500, 1500];
        let attempt = initial;
        for (let attemptIndex = 0; attemptIndex < backoffs.length; attemptIndex++) {
          const delay = backoffs[attemptIndex];
          await new Promise((resolve) => setTimeout(resolve, delay));
          await onLog(
            "stdout",
            `[paperclip] transient opencode statement error, retry ${attemptIndex + 1}/2 after ${delay}ms: ${firstNonEmptyLine(attempt.rawStderr)}\n`,
          );
          const retry = await runAttempt(sessionId);
          const retryGuardResult = await databaseGuardResult(retry);
          if (retryGuardResult) return retryGuardResult;
          const retryFailed =
            !retry.proc.timedOut &&
            ((retry.proc.exitCode ?? 0) !== 0 || Boolean(retry.parsed.errorMessage));
          if (!retryFailed) {
            return toResult(retry);
          }
          const retryTransient =
            !retry.proc.timedOut &&
            isOpenCodeTransientStatementError(retry.rawStderr) &&
            retry.parsed.paperclipToolCallCount === 0 &&
            retry.parsed.summary.trim() === "";
          if (!retryTransient) {
            return toResult(retry);
          }
          attempt = retry;
        }
        return toResult(attempt, false, "opencode_statement_failed");
      }

      return toResult(initial);
    } finally {
      await Promise.all([
        paperclipBridge?.stop(),
        restoreRemoteWorkspace?.(),
        localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
      ]);
    }
  } finally {
    await preparedRuntimeConfig.cleanup();
  }
}
