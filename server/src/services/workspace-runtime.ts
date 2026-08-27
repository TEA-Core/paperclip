import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AdapterRuntimeServiceReport } from "@paperclipai/adapter-utils";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, issueComments, issues, projectWorkspaces, workspaceRuntimeServices } from "@paperclipai/db";
import {
  ISSUE_COMMENT_METADATA_TEXT_MAX_LENGTH,
  listWorkspaceServiceCommandDefinitions,
  type GitWorktreeBranchAncestryVerdict,
  type GitWorktreeBranchIncoherenceEvidence as SharedGitWorktreeBranchIncoherenceEvidence,
  type GitWorktreeInProgressOperation,
  type IssueCommentMetadata,
  type IssueCommentPresentation,
  type WorkspaceOperationPhase,
  type WorkspaceRuntimeDesiredState,
  type WorkspaceRuntimeServiceStateMap,
} from "@paperclipai/shared";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { asNumber, asString, parseObject, renderTemplate } from "../adapters/utils.js";
import { resolveHomeAwarePath } from "../home-paths.js";
import {
  createLocalServiceKey,
  findLocalServiceRegistryRecordByRuntimeServiceId,
  findAdoptableLocalService,
  isLocalServiceProcessInWorkspace,
  readLocalServiceProcessCwd,
  readLocalServicePortOwner,
  removeLocalServiceRegistryRecord,
  terminateLocalService,
  touchLocalServiceRegistryRecord,
  writeLocalServiceRegistryRecord,
} from "./local-service-supervisor.js";
import { workspaceOperationService, type WorkspaceOperationRecorder } from "./workspace-operations.js";
import { executionWorkspaceService, readExecutionWorkspaceConfig, type ExecutionWorkspaceBranchReconcileMode } from "./execution-workspaces.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import { readProjectWorkspaceRuntimeConfig } from "./project-workspace-runtime-config.js";
import {
  cleanupWorktreeInstanceArtifacts,
  deriveWorktreeInstanceId,
  readWorktreeInstancePointer,
  WORKTREE_INSTANCE_ROOT_METADATA_KEY,
  type WorktreeInstancePointer,
} from "./workspace-instance-cleanup.js";

const execFileAsync = promisify(execFile);

export function resolveShell(): string {
  const fallback = process.platform === "win32" ? "sh" : "/bin/sh";
  const shell = process.env.SHELL?.trim();
  if (!shell) return fallback;
  if (path.isAbsolute(shell) && !existsSync(shell)) return fallback;
  return shell;
}

/**
 * A read-only referenced (mentioned) project workspace carried alongside the anchor. Additive and
 * backward-compatible: it defaults to an empty array. Additional workspaces never get git-worktree
 * realization; the anchor keeps the single scalar realization path.
 */
export interface ExecutionWorkspaceAdditionalInput {
  cwd: string;
  projectId: string;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
}

export interface ExecutionWorkspaceInput {
  baseCwd: string;
  source: "project_primary" | "task_session" | "agent_home";
  projectId: string | null;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  additionalWorkspaces?: ExecutionWorkspaceAdditionalInput[];
}

/**
 * A prepared credential-bearing git invocation for one remote URL, or null to keep ambient
 * behavior. Structurally compatible with the provider built by `git-credentials.ts` — this
 * module deliberately takes prepared invocations rather than tokens, so it never imports the
 * secrets layer and test fakes stay trivial.
 */
export type GitRemoteAuthInvocation = {
  configArgs: string[];
  env: Record<string, string>;
  source?: string;
  secretName?: string | null;
};

export type GitRemoteAuthProvider = (remoteUrl: string) => Promise<GitRemoteAuthInvocation | null>;

export interface ExecutionWorkspaceIssueRef {
  id: string;
  identifier: string | null;
  title: string | null;
  workMode?: string | null;
}

export interface ExecutionWorkspaceAgentRef {
  id: string | null;
  name: string;
  companyId: string;
}

export interface RealizedExecutionWorkspace extends ExecutionWorkspaceInput {
  strategy: "project_primary" | "git_worktree";
  cwd: string;
  branchName: string | null;
  worktreePath: string | null;
  warnings: string[];
  created: boolean;
  baseRefSha?: string | null;
  pendingForwardBranchReconcile?: PendingForwardBranchReconcile | null;
}

export class WorkspaceRuntimeValidationFailure extends Error {
  code = "workspace_validation_failed" as const;
  resultJson: Record<string, unknown>;

  constructor(message: string, resultJson: Record<string, unknown>) {
    super(message);
    this.name = "WorkspaceRuntimeValidationFailure";
    this.resultJson = resultJson;
  }
}

export interface RuntimeServiceRef {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  issueId: string | null;
  serviceName: string;
  status: "provisioning" | "starting" | "running" | "stopped" | "failed";
  lifecycle: "shared" | "ephemeral";
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
  reuseKey: string | null;
  command: string | null;
  cwd: string | null;
  port: number | null;
  url: string | null;
  provider: "local_process" | "adapter_managed";
  providerRef: string | null;
  ownerAgentId: string | null;
  startedByRunId: string | null;
  lastUsedAt: string;
  startedAt: string;
  stoppedAt: string | null;
  stopPolicy: Record<string, unknown> | null;
  healthStatus: "unknown" | "healthy" | "unhealthy";
  reused: boolean;
}

interface RuntimeServiceRecord extends RuntimeServiceRef {
  db?: Db;
  child: ChildProcess | null;
  leaseRunIds: Set<string>;
  idleTimer: ReturnType<typeof globalThis.setTimeout> | null;
  envFingerprint: string;
  serviceKey: string;
  profileKind: string;
  processGroupId: number | null;
}

type LocalRuntimeServiceStart = {
  record: RuntimeServiceRecord;
  readiness: Promise<void>;
};

type StoppedRuntimeServiceReuseCandidate = {
  id: string;
  port: number | null;
};

const runtimeServicesById = new Map<string, RuntimeServiceRecord>();
const runtimeServicesByReuseKey = new Map<string, string>();
const runtimeServiceLeasesByRun = new Map<string, string[]>();
const runtimeProvisionByWorkspace = new Map<string, Promise<void>>();
const DEFAULT_EXECUTE_PROCESS_OUTPUT_BYTES = 256 * 1024;

type ProcessOutputCapture = {
  text: string;
  truncated: boolean;
  totalBytes: number;
};

type ProcessOutputAccumulator = {
  append(chunk: string): void;
  finish(): ProcessOutputCapture;
};

export async function resetRuntimeServicesForTests(options?: { keepProcessesRunning?: boolean }) {
  // Stop what is still registered instead of merely forgetting it. These maps
  // are the only handle on a spawned child, so clearing them while a service is
  // still running orphans that process permanently — nothing can reap it
  // afterwards and it holds its port for the life of the host. Any service a
  // test did not stop itself lands here.
  //
  // keepProcessesRunning is for the adoption tests, which need a live service to
  // survive the reset so they can model a Paperclip restart. Callers that pass it
  // own the resulting process and must stop it themselves.
  if (!options?.keepProcessesRunning) {
    for (const serviceId of Array.from(runtimeServicesById.keys())) {
      await stopRuntimeService(serviceId).catch(() => undefined);
    }
  }
  for (const record of runtimeServicesById.values()) {
    clearIdleTimer(record);
  }
  runtimeServicesById.clear();
  runtimeServicesByReuseKey.clear();
  runtimeServiceLeasesByRun.clear();
  runtimeProvisionByWorkspace.clear();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(rec[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

type WorkspaceLinkMismatch = {
  packageName: string;
  expectedPath: string;
  actualPath: string | null;
};

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function findWorkspaceRoot(startCwd: string) {
  let current = path.resolve(startCwd);
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isLinkedGitWorktreeCheckout(rootDir: string) {
  const gitMetadataPath = path.join(rootDir, ".git");
  if (!existsSync(gitMetadataPath)) return false;

  const stat = lstatSync(gitMetadataPath);
  if (!stat.isFile()) return false;

  return readFileSync(gitMetadataPath, "utf8").trimStart().startsWith("gitdir:");
}

function discoverWorkspacePackagePaths(rootDir: string): Map<string, string> {
  const packagePaths = new Map<string, string>();
  const ignoredDirNames = new Set([".git", ".paperclip", "dist", "node_modules"]);

  function visit(dirPath: string) {
    if (!existsSync(dirPath)) return;

    const packageJsonPath = path.join(dirPath, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = readJsonFile(packageJsonPath);
      if (typeof packageJson.name === "string" && packageJson.name.length > 0) {
        packagePaths.set(packageJson.name, dirPath);
      }
    }

    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (ignoredDirNames.has(entry.name)) continue;
      visit(path.join(dirPath, entry.name));
    }
  }

  visit(path.join(rootDir, "packages"));
  visit(path.join(rootDir, "server"));
  visit(path.join(rootDir, "ui"));
  visit(path.join(rootDir, "cli"));

  return packagePaths;
}

function findServerWorkspaceLinkMismatches(rootDir: string): WorkspaceLinkMismatch[] {
  const serverPackageJsonPath = path.join(rootDir, "server", "package.json");
  if (!existsSync(serverPackageJsonPath)) return [];

  const serverPackageJson = readJsonFile(serverPackageJsonPath);
  const dependencies = {
    ...(serverPackageJson.dependencies as Record<string, unknown> | undefined),
    ...(serverPackageJson.devDependencies as Record<string, unknown> | undefined),
  };
  const workspacePackagePaths = discoverWorkspacePackagePaths(rootDir);
  const mismatches: WorkspaceLinkMismatch[] = [];

  for (const [packageName, version] of Object.entries(dependencies)) {
    if (typeof version !== "string" || !version.startsWith("workspace:")) continue;

    const expectedPath = workspacePackagePaths.get(packageName);
    if (!expectedPath) continue;
    const normalizedExpectedPath = existsSync(expectedPath) ? path.resolve(realpathSync(expectedPath)) : path.resolve(expectedPath);

    const linkPath = path.join(rootDir, "server", "node_modules", ...packageName.split("/"));
    const actualPath = existsSync(linkPath) ? path.resolve(realpathSync(linkPath)) : null;
    if (actualPath === normalizedExpectedPath) continue;

    mismatches.push({
      packageName,
      expectedPath: normalizedExpectedPath,
      actualPath,
    });
  }

  return mismatches;
}

export async function ensureServerWorkspaceLinksCurrent(
  startCwd: string,
  opts?: {
    onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  },
) {
  const workspaceRoot = findWorkspaceRoot(startCwd);
  if (!workspaceRoot) return;
  if (!isLinkedGitWorktreeCheckout(workspaceRoot)) return;

  const mismatches = findServerWorkspaceLinkMismatches(workspaceRoot);
  if (mismatches.length === 0) return;

  if (opts?.onLog) {
    await opts.onLog("stdout", "[runtime] detected stale workspace package links for server; relinking dependencies...\n");
    for (const mismatch of mismatches) {
      await opts.onLog(
        "stdout",
        `[runtime]   ${mismatch.packageName}: ${mismatch.actualPath ?? "missing"} -> ${mismatch.expectedPath}\n`,
      );
    }
  }

  for (const mismatch of mismatches) {
    const linkPath = path.join(workspaceRoot, "server", "node_modules", ...mismatch.packageName.split("/"));
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.rm(linkPath, { recursive: true, force: true });
    await fs.symlink(mismatch.expectedPath, linkPath);
  }

  const remainingMismatches = findServerWorkspaceLinkMismatches(workspaceRoot);
  if (remainingMismatches.length === 0) return;

  throw new Error(
    `Workspace relink did not repair all server package links: ${remainingMismatches.map((item) => item.packageName).join(", ")}`,
  );
}

export function sanitizeRuntimeServiceBaseEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PAPERCLIP_")) {
      delete env[key];
    }
  }
  delete env.DATABASE_URL;
  delete env.npm_config_tailscale_auth;
  delete env.npm_config_authenticated_private;
  return env;
}

function stableRuntimeServiceId(input: {
  adapterType: string;
  runId: string;
  scopeType: RuntimeServiceRef["scopeType"];
  scopeId: string | null;
  serviceName: string;
  reportId: string | null;
  providerRef: string | null;
  reuseKey: string | null;
}) {
  if (input.reportId) return input.reportId;
  const digest = createHash("sha256")
    .update(
      stableStringify({
        adapterType: input.adapterType,
        runId: input.runId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        serviceName: input.serviceName,
        providerRef: input.providerRef,
        reuseKey: input.reuseKey,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `${input.adapterType}-${digest}`;
}

function toRuntimeServiceRef(record: RuntimeServiceRecord, overrides?: Partial<RuntimeServiceRef>): RuntimeServiceRef {
  return {
    id: record.id,
    companyId: record.companyId,
    projectId: record.projectId,
    projectWorkspaceId: record.projectWorkspaceId,
    executionWorkspaceId: record.executionWorkspaceId,
    issueId: record.issueId,
    serviceName: record.serviceName,
    status: record.status,
    lifecycle: record.lifecycle,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    reuseKey: record.reuseKey,
    command: record.command,
    cwd: record.cwd,
    port: record.port,
    url: record.url,
    provider: record.provider,
    providerRef: record.providerRef,
    ownerAgentId: record.ownerAgentId,
    startedByRunId: record.startedByRunId,
    lastUsedAt: record.lastUsedAt,
    startedAt: record.startedAt,
    stoppedAt: record.stoppedAt,
    stopPolicy: record.stopPolicy,
    healthStatus: record.healthStatus,
    reused: record.reused,
    ...overrides,
  };
}

function sanitizeSlugPart(value: string | null | undefined, fallback: string): string {
  const raw = (value ?? "").trim().toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
}

function renderWorkspaceTemplate(template: string, input: {
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  projectId: string | null;
  repoRef: string | null;
}) {
  const issueIdentifier = input.issue?.identifier ?? input.issue?.id ?? "issue";
  const slug = sanitizeSlugPart(input.issue?.title, sanitizeSlugPart(issueIdentifier, "issue"));
  return renderTemplate(template, {
    issue: {
      id: input.issue?.id ?? "",
      identifier: input.issue?.identifier ?? "",
      title: input.issue?.title ?? "",
    },
    agent: {
      id: input.agent.id ?? "",
      name: input.agent.name,
    },
    project: {
      id: input.projectId ?? "",
    },
    workspace: {
      repoRef: input.repoRef ?? "",
    },
    slug,
  });
}

function sanitizeBranchName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "")
    .slice(0, 120) || "paperclip-work";
}

function isAbsolutePath(value: string) {
  return path.isAbsolute(value) || value.startsWith("~");
}

function resolveConfiguredPath(value: string, baseDir: string): string {
  if (isAbsolutePath(value)) {
    return resolveHomeAwarePath(value);
  }
  return path.resolve(baseDir, value);
}

function formatCommandForDisplay(command: string, args: string[]) {
  return [command, ...args]
    .map((part) => (/^[A-Za-z0-9_./:-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

function trimToLastBytes(value: string, limit: number) {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength <= limit) return value;
  return Buffer.from(value, "utf8").subarray(byteLength - limit).toString("utf8");
}

function createProcessOutputCapture(maxBytes: number): ProcessOutputAccumulator {
  const limit = Math.max(1, Math.trunc(maxBytes));
  let text = "";
  let truncated = false;
  let totalBytes = 0;

  return {
    append(chunk: string) {
      if (!chunk) return;
      totalBytes += Buffer.byteLength(chunk, "utf8");

      const combined = text + chunk;
      if (Buffer.byteLength(combined, "utf8") <= limit) {
        text = combined;
        return;
      }

      text = trimToLastBytes(combined, limit);
      truncated = true;
    },
    finish(): ProcessOutputCapture {
      if (!truncated) {
        return {
          text,
          truncated: false,
          totalBytes,
        };
      }
      return {
        text: `[output truncated to last ${limit} bytes; total ${totalBytes} bytes]\n${text}`,
        truncated: true,
        totalBytes,
      };
    },
  };
}

async function executeProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}> {
  const proc = await new Promise<{
    stdout: ProcessOutputAccumulator;
    stderr: ProcessOutputAccumulator;
    code: number | null;
  }>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: input.env ?? process.env,
    });
    const stdout = createProcessOutputCapture(input.maxStdoutBytes ?? DEFAULT_EXECUTE_PROCESS_OUTPUT_BYTES);
    const stderr = createProcessOutputCapture(input.maxStderrBytes ?? DEFAULT_EXECUTE_PROCESS_OUTPUT_BYTES);
    child.stdout?.on("data", (chunk) => {
      stdout.append(String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr.append(String(chunk));
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
  const stdout = proc.stdout.finish();
  const stderr = proc.stderr.finish();
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    code: proc.code,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdoutBytes: stdout.totalBytes,
    stderrBytes: stderr.totalBytes,
  };
}

async function runGit(args: string[], cwd: string, opts?: { env?: NodeJS.ProcessEnv }): Promise<string> {
  const proc = await executeProcess({
    command: "git",
    args,
    cwd,
    env: opts?.env,
  });
  if (proc.code !== 0) {
    throw new Error(proc.stderr.trim() || proc.stdout.trim() || `git ${args.join(" ")} failed`);
  }
  return proc.stdout.trim();
}

function formatShortSha(value: string | null | undefined) {
  return value ? value.slice(0, 12) : "unknown";
}

function gitErrorIncludes(error: unknown, needle: string) {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes(needle.toLowerCase());
}

function parseRemoteTrackingRef(ref: string): { remote: string; branch: string } | null {
  const trimmed = ref.trim();
  const refsRemotesPrefix = "refs/remotes/";
  const normalized = trimmed.startsWith(refsRemotesPrefix)
    ? trimmed.slice(refsRemotesPrefix.length)
    : trimmed;
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0 || slashIndex === normalized.length - 1) return null;
  const remote = normalized.slice(0, slashIndex);
  const branch = normalized.slice(slashIndex + 1);
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) return null;
  return { remote, branch };
}

export async function refreshRemoteTrackingBaseRef(
  repoRoot: string,
  baseRef: string,
  resolveGitAuth?: GitRemoteAuthProvider | null,
): Promise<string[]> {
  const remoteTracking = parseRemoteTrackingRef(baseRef);
  if (!remoteTracking) return [];

  const remoteUrl = await runGit(["remote", "get-url", remoteTracking.remote], repoRoot)
    .then((value) => value.trim() || null)
    .catch(() => null);
  if (!remoteUrl) return [];

  const auth = resolveGitAuth ? await resolveGitAuth(remoteUrl).catch(() => null) : null;
  try {
    await runGit([
      ...(auth?.configArgs ?? []),
      "fetch",
      "--prune",
      remoteTracking.remote,
      `+refs/heads/${remoteTracking.branch}:refs/remotes/${remoteTracking.remote}/${remoteTracking.branch}`,
    ], repoRoot, auth ? { env: { ...process.env, ...auth.env } } : undefined);
    return [];
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    // Mask URL userinfo (any scheme) and whole URL query strings before the message rides
    // warnings that reach run logs.
    const message = rawMessage
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@")
      .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s"'?]*)\?[^\s"']*/gi, "$1?***");
    const authNote = auth
      ? ` The fetch authenticated with ${auth.secretName ? `the ${auth.secretName} company-secret GitHub credential` : "the server-environment GitHub credential"}, which may have been rejected.`
      : "";
    return [`Could not refresh base ref ${baseRef} before preparing the execution workspace: ${message}${authNote}`];
  }
}

async function resolveBaseRefSha(repoRoot: string, baseRef: string): Promise<string | null> {
  return await runGit(["rev-parse", "--verify", `${baseRef}^{commit}`], repoRoot).catch(() => null);
}

function readRecordedBaseRefSha(metadata: Record<string, unknown> | null | undefined): string | null {
  const snapshot = parseObject(metadata?.baseRefSnapshot);
  const resolvedSha = snapshot.resolvedSha;
  return typeof resolvedSha === "string" && resolvedSha.trim().length > 0 ? resolvedSha.trim() : null;
}

export async function inspectExecutionWorkspaceBaseDrift(input: {
  repoRoot: string;
  worktreePath: string;
  branchName: string | null;
  baseRef: string | null;
  recordedBaseRefSha?: string | null;
  skipRefresh?: boolean;
  resolveGitAuth?: GitRemoteAuthProvider | null;
}): Promise<{
  warnings: string[];
  currentBaseRefSha: string | null;
  branchBaseRefSha: string | null;
}> {
  const baseRef = input.baseRef?.trim();
  if (!baseRef) {
    return { warnings: [], currentBaseRefSha: null, branchBaseRefSha: null };
  }

  const warnings = input.skipRefresh
    ? []
    : await refreshRemoteTrackingBaseRef(input.repoRoot, baseRef, input.resolveGitAuth);
  const currentBaseRefSha = await resolveBaseRefSha(input.repoRoot, baseRef);
  if (!currentBaseRefSha) {
    warnings.push(`Could not resolve base ref ${baseRef} while checking execution workspace freshness.`);
    return { warnings, currentBaseRefSha: null, branchBaseRefSha: null };
  }

  const branchBaseRefSha = await runGit(["merge-base", "HEAD", baseRef], input.worktreePath).catch(() => null);
  if (!branchBaseRefSha) {
    warnings.push(`Could not compare execution workspace ${input.branchName ?? "branch"} against base ref ${baseRef}.`);
    return { warnings, currentBaseRefSha, branchBaseRefSha: null };
  }

  if (branchBaseRefSha !== currentBaseRefSha) {
    const behindCountRaw = await runGit(["rev-list", "--count", `HEAD..${baseRef}`], input.worktreePath).catch(() => "");
    const behindCount = parseInt(behindCountRaw, 10);
    const behindText = Number.isFinite(behindCount) && behindCount > 0
      ? `${behindCount} commit${behindCount === 1 ? "" : "s"}`
      : "newer commits";
    const recordedText = input.recordedBaseRefSha
      ? `recorded base ${formatShortSha(input.recordedBaseRefSha)}`
      : `merge-base ${formatShortSha(branchBaseRefSha)}`;
    warnings.push(
      `Execution workspace branch ${input.branchName ? `"${input.branchName}"` : "HEAD"} is behind ${baseRef} by ${behindText}: ${recordedText}, current base ${formatShortSha(currentBaseRefSha)}. Refresh or rebase the workspace before relying on recent base-branch fixes.`,
    );
  }

  return { warnings, currentBaseRefSha, branchBaseRefSha };
}

async function localBranchExists(repoRoot: string, branch: string): Promise<boolean> {
  return runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot)
    .then(() => true)
    .catch(() => false);
}

async function remoteExists(repoRoot: string, remote: string): Promise<boolean> {
  return runGit(["remote", "get-url", remote], repoRoot)
    .then(() => true)
    .catch(() => false);
}

const GIT_WORKTREE_BRANCH_INCOHERENCE_REASON = "git_worktree_branch_incoherence";
const WORKTREE_METADATA_MISSING_REASON = "worktree_metadata_missing";

type GitWorktreeCleanliness = SharedGitWorktreeBranchIncoherenceEvidence["cleanliness"];

type GitWorktreeBranchIncoherenceEvidence = SharedGitWorktreeBranchIncoherenceEvidence;

type GitWorktreeBranchContention = NonNullable<GitWorktreeBranchIncoherenceEvidence["contention"]>;

type GitWorktreeBranchCoherenceResult = {
  branchName: string | null;
  reconciledForward: boolean;
  pendingForwardBranchReconcile?: PendingForwardBranchReconcile | null;
  dirtyQuarantineRepair?: DirtyQuarantineRepairResult | null;
  warnings: string[];
};

type DirtyQuarantineRepairResult = {
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  clearedInProgressOperation: GitWorktreeInProgressOperation | null;
  sourceAuditCommentId: string | null;
  claimantAuditCommentId: string | null;
};

export type PendingForwardBranchReconcile = {
  recordedBranchName: string;
  adoptedBranchName: string;
  prePersistenceFingerprint: string;
  reason: string;
};

function formatBranchForMessage(branch: string | null | undefined) {
  return branch && branch.length > 0 ? branch : "<detached>";
}

const GIT_IN_PROGRESS_OPERATION_MARKERS: ReadonlyArray<{
  operation: GitWorktreeInProgressOperation;
  marker: string;
}> = [
  { operation: "rebase", marker: "rebase-merge" },
  { operation: "rebase", marker: "rebase-apply" },
  { operation: "merge", marker: "MERGE_HEAD" },
  { operation: "cherry_pick", marker: "CHERRY_PICK_HEAD" },
  { operation: "revert", marker: "REVERT_HEAD" },
  { operation: "bisect", marker: "BISECT_LOG" },
];

const GIT_IN_PROGRESS_OPERATION_LABELS: Record<GitWorktreeInProgressOperation, string> = {
  rebase: "rebase",
  merge: "merge",
  cherry_pick: "cherry-pick",
  revert: "revert",
  bisect: "bisect",
};

// `--quit` clears the interrupted operation's state directory without touching
// the working tree or moving HEAD, unlike `--abort` which resets both.
const GIT_IN_PROGRESS_OPERATION_QUIT_ARGS: Record<GitWorktreeInProgressOperation, string[]> = {
  rebase: ["rebase", "--quit"],
  merge: ["merge", "--quit"],
  cherry_pick: ["cherry-pick", "--quit"],
  revert: ["revert", "--quit"],
  bisect: ["bisect", "reset", "HEAD"],
};

async function detectGitWorktreeInProgressOperation(
  worktreePath: string,
): Promise<GitWorktreeInProgressOperation | null> {
  for (const { operation, marker } of GIT_IN_PROGRESS_OPERATION_MARKERS) {
    const markerPath = await runGit(["rev-parse", "--git-path", marker], worktreePath).catch(() => null);
    if (!markerPath) continue;
    if (existsSync(path.resolve(worktreePath, markerPath))) return operation;
  }
  return null;
}

const DIRTY_PATH_SAMPLE_LIMIT = 5;

function parseGitPorcelainPath(line: string) {
  const raw = line.trimEnd();
  if (raw.trim().length <= 3) return raw.trim();
  if (raw[1] === " " && raw[2] !== " ") return raw.slice(2).trim();
  return raw.slice(3).trim();
}

function sampleDirtyStatusPaths(statusLines: string[] | null) {
  return (statusLines ?? [])
    .map(parseGitPorcelainPath)
    .filter((value) => value.length > 0)
    .slice(0, DIRTY_PATH_SAMPLE_LIMIT);
}

function formatUtcBranchTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function buildDirtyQuarantineRescueBranch(sourceIssue: ExecutionWorkspaceIssueRef | null) {
  const issueComponent = sanitizeBranchName(sourceIssue?.identifier ?? sourceIssue?.id ?? "issue");
  return sanitizeBranchName(`paperclip/rescue/${issueComponent}/${formatUtcBranchTimestamp()}`);
}

function formatIssueReference(issueId: string | null | undefined, identifier: string | null | undefined) {
  if (!identifier) return issueId ? `\`${issueId}\`` : "`unknown`";
  const match = identifier.match(/^([A-Z]+)-\d+$/);
  if (!match) return `\`${identifier}\``;
  return `[${identifier}](/${match[1]}/issues/${identifier})`;
}

async function readIssueCompanyId(db: Db, issueId: string | null | undefined): Promise<string | null> {
  if (!issueId) return null;
  return db
    .select({ companyId: issues.companyId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0]?.companyId ?? null);
}

async function findGitWorktreeBranchContention(input: {
  db: Db | null | undefined;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  actualBranchName: string | null;
}): Promise<GitWorktreeBranchContention | null> {
  if (!input.db) return null;
  const companyId = await readIssueCompanyId(input.db, input.sourceIssue?.id);
  if (!companyId) return null;
  return executionWorkspaceService(input.db).findGitWorktreeContention({
    companyId,
    worktreePath: input.worktreePath,
    liveBranchName: input.actualBranchName,
    excludingExecutionWorkspaceId: input.executionWorkspaceId,
  });
}

function executionWorkspaceUsesInheritedProjectRuntimeServices(
  row: typeof executionWorkspaces.$inferSelect,
) {
  if (row.mode !== "shared_workspace" || !row.projectWorkspaceId) return false;
  return !readExecutionWorkspaceConfig((row.metadata as Record<string, unknown> | null) ?? null)?.workspaceRuntime;
}

async function findActiveRuntimeServiceBlockingDirtyQuarantine(input: {
  db: Db;
  workspace: typeof executionWorkspaces.$inferSelect;
}) {
  const inheritedProjectWorkspaceId = executionWorkspaceUsesInheritedProjectRuntimeServices(input.workspace)
    ? input.workspace.projectWorkspaceId
    : null;
  const serviceScopeCondition = inheritedProjectWorkspaceId
    ? and(
        eq(workspaceRuntimeServices.companyId, input.workspace.companyId),
        eq(workspaceRuntimeServices.projectWorkspaceId, inheritedProjectWorkspaceId),
        eq(workspaceRuntimeServices.scopeType, "project_workspace"),
      )
    : and(
        eq(workspaceRuntimeServices.companyId, input.workspace.companyId),
        eq(workspaceRuntimeServices.executionWorkspaceId, input.workspace.id),
      );

  const [service] = await input.db
    .select({
      id: workspaceRuntimeServices.id,
      serviceName: workspaceRuntimeServices.serviceName,
      status: workspaceRuntimeServices.status,
      scopeType: workspaceRuntimeServices.scopeType,
    })
    .from(workspaceRuntimeServices)
    .where(and(serviceScopeCondition, ne(workspaceRuntimeServices.status, "stopped")))
    .orderBy(desc(workspaceRuntimeServices.updatedAt), desc(workspaceRuntimeServices.createdAt))
    .limit(1);
  return service ?? null;
}

async function assertDirtyQuarantineRuntimeServicesStopped(input: {
  db: Db;
  executionWorkspaceId: string | null;
  evidence: GitWorktreeBranchIncoherenceEvidence;
}) {
  if (!input.executionWorkspaceId) {
    input.evidence.safeRepair.eligible = false;
    input.evidence.safeRepair.reason = "dirty quarantine repair requires an execution workspace id for runtime-service checks";
    throw branchIncoherenceValidationFailure(input.evidence);
  }

  const [workspace] = await input.db
    .select()
    .from(executionWorkspaces)
    .where(eq(executionWorkspaces.id, input.executionWorkspaceId));
  if (!workspace) {
    input.evidence.safeRepair.eligible = false;
    input.evidence.safeRepair.reason = "dirty quarantine repair requires a persisted execution workspace for runtime-service checks";
    throw branchIncoherenceValidationFailure(input.evidence);
  }

  const activeService = await findActiveRuntimeServiceBlockingDirtyQuarantine({
    db: input.db,
    workspace,
  });
  if (!activeService) return;

  input.evidence.safeRepair.eligible = false;
  input.evidence.safeRepair.reason =
    `dirty quarantine repair requires runtime service "${activeService.serviceName}" (${activeService.id}) to be stopped; current status is ${activeService.status}`;
  throw branchIncoherenceValidationFailure(input.evidence);
}

async function assertGitIndexIsUnlocked(worktreePath: string) {
  const indexLockPath = await runGit(["rev-parse", "--git-path", "index.lock"], worktreePath)
    .catch(() => null);
  if (indexLockPath && existsSync(indexLockPath)) {
    throw new Error(`git index lock exists at ${indexLockPath}`);
  }
}

// Detect a truncated (zero-byte) git index before any git read/write that would
// fatal on it. A zero-byte index is unrecoverable worktree corruption, not a
// transient lock — surfacing it as a workspace validation failure keeps the
// dispatch loop from crash-looping the agent into `error` and leaves the run
// with an errorCode operators can search on.
export async function assertGitIndexIntegrity(worktreePath: string): Promise<void> {
  const indexFile = await runGit(["rev-parse", "--git-path", "index"], worktreePath).catch(() => null);
  if (!indexFile) return;
  try {
    const stats = await fs.stat(indexFile);
    if (stats.size === 0) {
      throw new WorkspaceRuntimeValidationFailure(
        `Git index at "${indexFile}" is 0 bytes (truncated). The worktree git index is corrupted and must be repaired before the worktree can be used.`,
        {
          workspaceValidation: {
            reason: "git_index_truncated",
            worktreePath,
            indexFile,
            size: 0,
          },
        },
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceRuntimeValidationFailure) throw error;
    // Index file absent (fresh repo) or unstat-able — nothing to guard.
  }
}

/**
 * Refuse a worktree whose HEAD does not resolve to a commit.
 *
 * SUP-10008 and SUP-10933 both reached provisioning with HEAD pointing at a branch ref that no
 * longer existed. `git worktree list` shows such a worktree as `000000000` and every rev-parse
 * fails, so an agent dispatched there cannot commit, branch, or diff — whatever it does strands.
 *
 * The reuse preflight never caught it because the branch-coherence check asks
 * `git symbolic-ref --short HEAD`, which reports the symref's *target name* whether or not that ref
 * exists. The name matched the recorded branch, so the check returned early and validation moved
 * on. The run then failed later and elsewhere — SUP-10008 surfaced as a pnpm lockfile error — which
 * pointed the operator at the wrong thing entirely.
 *
 * Deliberately narrow: this asserts only that HEAD resolves. A dirty tree, deleted tracked files, a
 * detached HEAD and an interrupted rebase all resolve fine and are none of this guard's business.
 */
export async function assertGitHeadResolvable(worktreePath: string): Promise<void> {
  const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], worktreePath).catch(() => null);
  if (head) return;

  const symbolicTarget = await runGit(["symbolic-ref", "--quiet", "HEAD"], worktreePath).catch(() => null);
  throw new WorkspaceRuntimeValidationFailure(
    symbolicTarget
      ? `Git HEAD at "${worktreePath}" does not resolve to a commit: it points at "${symbolicTarget}", which no longer exists. The worktree's branch ref was deleted or was never created, so git cannot commit, branch or diff here. Recreate the branch at the intended commit, or clear the issue's reuse_existing workspace binding so a fresh workspace is provisioned.`
      : `Git HEAD at "${worktreePath}" does not resolve to a commit. The worktree git metadata is corrupted and must be repaired before the worktree can be used.`,
    {
      workspaceValidation: {
        reason: "git_head_unresolvable",
        worktreePath,
        symbolicTarget: symbolicTarget ?? null,
      },
    },
  );
}

function fingerprintWorkspaceBranchIncoherence(input: {
  sourceIssueId: string | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  expectedBranch: string;
  actualBranch: string | null;
  cleanliness: GitWorktreeCleanliness;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}) {
  const digest = createHash("sha256")
    .update(stableStringify({
      version: 1,
      reason: GIT_WORKTREE_BRANCH_INCOHERENCE_REASON,
      sourceIssueId: input.sourceIssueId,
      executionWorkspaceId: input.executionWorkspaceId,
      worktreePath: path.resolve(input.worktreePath),
      expectedBranch: input.expectedBranch,
      actualBranch: input.actualBranch,
      cleanliness: input.cleanliness,
      expectedHeadSha: input.expectedHeadSha,
      actualHeadSha: input.actualHeadSha,
    }))
    .digest("hex");
  return `workspace_incoherence:v1:sha256:${digest}`;
}

function fingerprintWorktreeMetadataMissing(input: {
  sourceIssueId: string | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  expectedBranch: string;
}) {
  const digest = createHash("sha256")
    .update(stableStringify({
      version: 1,
      reason: WORKTREE_METADATA_MISSING_REASON,
      sourceIssueId: input.sourceIssueId,
      executionWorkspaceId: input.executionWorkspaceId,
      worktreePath: path.resolve(input.worktreePath),
      expectedBranch: input.expectedBranch,
    }))
    .digest("hex");
  return `workspace_metadata_missing:v1:sha256:${digest}`;
}

async function getGitWorktreeBranchAncestryVerdict(input: {
  repoRoot: string;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}): Promise<GitWorktreeBranchAncestryVerdict> {
  if (!input.expectedHeadSha || !input.actualHeadSha) return "unknown";

  const proc = await executeProcess({
    command: "git",
    args: ["merge-base", "--is-ancestor", input.expectedHeadSha, input.actualHeadSha],
    cwd: input.repoRoot,
  }).catch(() => null);
  if (!proc) return "unknown";
  if (proc.code === 0) return "ancestor";
  if (proc.code === 1) return "diverged";
  return "unknown";
}

/**
 * Is the checked-out HEAD already contained in the recorded branch?
 *
 * `getGitWorktreeBranchAncestryVerdict` only asks the forward question (is the recorded branch an
 * ancestor of HEAD), so its "diverged" verdict conflates two states that must be treated
 * differently:
 *
 * - HEAD is *behind* the recorded branch — every commit it carries is already reachable from the
 *   recorded branch, so restoring that branch abandons nothing. This is the leftover-branch state
 *   SUP-10665 was filed for.
 * - HEAD and the recorded branch have genuinely diverged — HEAD carries commits the recorded branch
 *   does not. Restoring the recorded branch silently walks away from another run's work, which is
 *   exactly what workspace-branch containment exists to prevent.
 *
 * Only the first is a safe repair. Returns false on an indeterminate git result, so an unanswerable
 * question fails closed.
 */
async function isActualHeadContainedInExpectedBranch(input: {
  repoRoot: string;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}): Promise<boolean> {
  if (!input.expectedHeadSha || !input.actualHeadSha) return false;

  const proc = await executeProcess({
    command: "git",
    args: ["merge-base", "--is-ancestor", input.actualHeadSha, input.expectedHeadSha],
    cwd: input.repoRoot,
  }).catch(() => null);
  return proc?.code === 0;
}

function explainGitWorktreeBranchIncoherence(input: {
  expectedBranchName: string;
  actualBranchName: string | null;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
  sameHead: boolean;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
}) {
  const actualBranch = formatBranchForMessage(input.actualBranchName);
  if (!input.expectedHeadSha || !input.actualHeadSha) {
    return `Paperclip could not determine branch ancestry because the recorded branch "${input.expectedBranchName}" or checked-out branch "${actualBranch}" is missing a resolvable HEAD commit.`;
  }
  if (input.sameHead) {
    return `The recorded branch "${input.expectedBranchName}" and checked-out branch "${actualBranch}" resolve to the same commit, so the mismatch is branch metadata rather than commit divergence.`;
  }
  if (input.ancestryVerdict === "ancestor") {
    return `The recorded branch "${input.expectedBranchName}" is an ancestor of the checked-out branch "${actualBranch}", so the checked-out branch is forward of the recorded branch.`;
  }
  if (input.ancestryVerdict === "diverged") {
    return `The recorded branch "${input.expectedBranchName}" is not an ancestor of the checked-out branch "${actualBranch}", so Paperclip cannot prove a forward-only reconciliation.`;
  }
  return `Paperclip could not determine whether the checked-out branch "${actualBranch}" is forward of the recorded branch "${input.expectedBranchName}".`;
}

async function buildWorktreeMetadataMissingEvidence(input: {
  db?: Db | null;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  executionWorkspaceId?: string | null;
}): Promise<GitWorktreeBranchIncoherenceEvidence> {
  const expectedHeadSha = await runGit(
    ["rev-parse", "--verify", `refs/heads/${input.expectedBranchName}^{commit}`],
    input.repoRoot,
  ).catch(() => null);
  const expectedBranchExists = Boolean(expectedHeadSha);

  return {
    reason: WORKTREE_METADATA_MISSING_REASON,
    fingerprint: fingerprintWorktreeMetadataMissing({
      sourceIssueId: input.sourceIssue?.id ?? null,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      worktreePath: input.worktreePath,
      expectedBranch: input.expectedBranchName,
    }),
    sourceIssueId: input.sourceIssue?.id ?? null,
    sourceIdentifier: input.sourceIssue?.identifier ?? null,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    worktreePath: path.resolve(input.worktreePath),
    repoRoot: path.resolve(input.repoRoot),
    expectedBranch: input.expectedBranchName,
    actualBranch: null,
    cleanliness: "unknown",
    inProgressOperation: null,
    statusEntryCount: null,
    dirtyPathSample: [],
    contention: null,
    provenance: {
      expectedBranchRef: `refs/heads/${input.expectedBranchName}`,
      actualBranchRef: null,
      registeredBranchRef: null,
      registeredPathFound: false,
      registeredBranchMatchesHead: false,
      expectedBranchExists,
      actualBranchExists: null,
      expectedHeadSha,
      actualHeadSha: null,
      sameHead: false,
      ancestryVerdict: "unknown",
      defaultBranch: await detectDefaultBranch(input.repoRoot).catch(() => null),
      // There is no checked-out branch to compare: the path has no worktree
      // metadata, so nothing here can be the default branch.
      actualBranchIsDefaultBranch: false,
      plainLanguageReason:
        "The workspace path is not a registered git worktree; its git metadata is missing or resolves to a different repository.",
    },
    safeRepair: {
      eligible: true,
      attempted: false,
      succeeded: false,
      reason: "worktree metadata is missing; relinking or re-provisioning may repair it",
    },
  };
}

async function inspectGitWorktreeBranchIncoherence(input: {
  db?: Db | null;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string;
  actualBranchName: string | null;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  executionWorkspaceId?: string | null;
  contentionExcludeExecutionWorkspaceId?: string | null;
}): Promise<GitWorktreeBranchIncoherenceEvidence> {
  const resolvedTopLevel = await runGit(["rev-parse", "--show-toplevel"], input.worktreePath)
    .then((output) => resolvePathForWorktreeComparison(output))
    .catch(() => null);
  const expectedPath = await resolvePathForWorktreeComparison(input.worktreePath);
  const registered = await findRegisteredGitWorktreeByPath(input.repoRoot, input.worktreePath);
  if (!resolvedTopLevel || resolvedTopLevel !== expectedPath || !registered) {
    return buildWorktreeMetadataMissingEvidence({
      db: input.db ?? null,
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      expectedBranchName: input.expectedBranchName,
      sourceIssue: input.sourceIssue,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
    });
  }

  const status = await runGit(
    ["status", "--porcelain", "--untracked-files=all"],
    input.worktreePath,
  ).catch(() => null);
  const statusLines = status === null
    ? null
    : status.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  const dirtyPathSample = sampleDirtyStatusPaths(statusLines);
  const cleanliness: GitWorktreeCleanliness =
    status === null ? "unknown" : status.trim().length > 0 ? "dirty" : "clean";
  const inProgressOperation = await detectGitWorktreeInProgressOperation(input.worktreePath);
  const expectedHeadSha = await runGit(
    ["rev-parse", "--verify", `refs/heads/${input.expectedBranchName}^{commit}`],
    input.repoRoot,
  ).catch(() => null);
  const actualHeadSha = await runGit(["rev-parse", "HEAD"], input.worktreePath).catch(() => null);
  const actualBranchExists = input.actualBranchName
    ? await localBranchExists(input.repoRoot, input.actualBranchName)
    : null;
  const actualBranchRef = input.actualBranchName ? `refs/heads/${input.actualBranchName}` : null;
  const registeredBranchRef = registered?.branch ?? null;
  const registeredBranchMatchesHead = Boolean(registered && registeredBranchRef === actualBranchRef);
  const sameHead = Boolean(expectedHeadSha && actualHeadSha && expectedHeadSha === actualHeadSha);
  const expectedBranchExists = Boolean(expectedHeadSha);
  const defaultBranch = input.repoRoot ? await detectDefaultBranch(input.repoRoot) : null;
  const actualBranchIsDefaultBranch =
    Boolean(input.actualBranchName) &&
    Boolean(defaultBranch) &&
    normalizeDefaultBranchForComparison(input.actualBranchName) ===
      normalizeDefaultBranchForComparison(defaultBranch);
  const ancestryVerdict = await getGitWorktreeBranchAncestryVerdict({
    repoRoot: input.repoRoot,
    expectedHeadSha,
    actualHeadSha,
  });
  const actualHeadContainedInExpectedBranch = await isActualHeadContainedInExpectedBranch({
    repoRoot: input.repoRoot,
    expectedHeadSha,
    actualHeadSha,
  });
  // Contention is consulted by the eligibility predicates below, so it must be resolved before
  // them: restoring the recorded branch is only safe while no *other* workspace is actively
  // running on the branch this worktree is parked on.
  const contention = await findGitWorktreeBranchContention({
    db: input.db ?? null,
    sourceIssue: input.sourceIssue,
    executionWorkspaceId:
      input.contentionExcludeExecutionWorkspaceId ?? input.executionWorkspaceId ?? null,
    worktreePath: input.worktreePath,
    actualBranchName: input.actualBranchName,
  });
  const basePlainLanguageReason = explainGitWorktreeBranchIncoherence({
    expectedBranchName: input.expectedBranchName,
    actualBranchName: input.actualBranchName,
    expectedHeadSha,
    actualHeadSha,
    sameHead,
    ancestryVerdict,
  });
  const plainLanguageReason = inProgressOperation
    ? `${basePlainLanguageReason} An interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[inProgressOperation]} is still in progress in this worktree.`
    : basePlainLanguageReason;
  const canCheckoutRecordedBranch =
    cleanliness === "clean" && expectedBranchExists && sameHead && registeredBranchMatchesHead;
  const canAdoptForwardActualBranch =
    cleanliness === "clean" &&
    expectedBranchExists &&
    actualBranchExists === true &&
    ancestryVerdict === "ancestor" &&
    !sameHead &&
    registeredBranchMatchesHead;
  const canAttachRecordedBranchToDetachedHead =
    cleanliness === "clean" &&
    expectedBranchExists &&
    input.actualBranchName === null &&
    ancestryVerdict === "ancestor" &&
    !sameHead &&
    registeredBranchMatchesHead;
  const canRebindDeletedBranchToDefaultBranch =
    cleanliness === "clean" &&
    !expectedBranchExists &&
    actualBranchExists === true &&
    registeredBranchMatchesHead &&
    actualBranchIsDefaultBranch;
  // SUP-10665: a reused worktree left on a leftover branch by the previous run must not dead-block
  // forever. But the repair may only run when restoring the recorded branch abandons nothing — that
  // is, when HEAD is already contained in the recorded branch. Divergence that would strand commits
  // stays fail-closed; see heartbeat-workspace-branch-containment. (Divergence on a *live named
  // branch* strands nothing and is handled by canRestoreRecordedBranchOverLiveNamedBranch below.)
  const canRestoreRecordedBranchOverContainedHead =
    cleanliness === "clean" &&
    expectedBranchExists &&
    !sameHead &&
    registeredBranchMatchesHead &&
    input.actualBranchName !== null &&
    ancestryVerdict !== "ancestor" &&
    actualHeadContainedInExpectedBranch;
  // SUP-11207: the containment proof above is only *needed* when the commits on HEAD would
  // otherwise become unreachable — a detached HEAD, or a branch ref that no longer exists. When
  // HEAD is on a live named branch that git still resolves, checking out the recorded branch
  // abandons nothing: every commit stays reachable from that branch's own ref, under a name the
  // operator can see in `git branch`. Requiring containment here left every agent that ran
  // `git checkout -b` inside its worktree permanently dead-blocked behind
  // workspace_validation_failed. Still fail-closed on contention, because yanking the worktree
  // back would pull the rug out from under another workspace's live run.
  const canRestoreRecordedBranchOverLiveNamedBranch =
    cleanliness === "clean" &&
    expectedBranchExists &&
    !sameHead &&
    registeredBranchMatchesHead &&
    input.actualBranchName !== null &&
    actualBranchExists === true &&
    ancestryVerdict !== "ancestor" &&
    !contention;
  // a detached HEAD that diverged from the recorded branch is refused by every
  // predicate above, because reattachment is only provably lossless when the recorded branch
  // already contains HEAD. But the hazard is narrower than the refusal: the detached commits are
  // reachable from no ref, so checking the recorded branch out would strand them. Naming them on
  // a rescue branch first — the same move the dirty-quarantine path already makes — removes that
  // hazard, and the restore becomes as safe as canRestoreRecordedBranchOverLiveNamedBranch.
  // Fail-closed on contention, as everywhere else here.
  const canRescueDivergedDetachedHead =
    cleanliness === "clean" &&
    expectedBranchExists &&
    !sameHead &&
    registeredBranchMatchesHead &&
    input.actualBranchName === null &&
    Boolean(actualHeadSha) &&
    ancestryVerdict !== "ancestor" &&
    !contention;
  const eligible =
    canCheckoutRecordedBranch ||
    canAdoptForwardActualBranch ||
    canAttachRecordedBranchToDetachedHead ||
    canRebindDeletedBranchToDefaultBranch ||
    canRestoreRecordedBranchOverContainedHead ||
    canRestoreRecordedBranchOverLiveNamedBranch ||
    canRescueDivergedDetachedHead;
  const safeRepairReason = eligible
    ? canCheckoutRecordedBranch
      ? "clean worktree and expected branch points at the current HEAD"
      : canAdoptForwardActualBranch
        ? "clean worktree and checked-out branch is forward of the recorded branch"
        : canAttachRecordedBranchToDetachedHead
          ? "clean detached worktree HEAD is forward of the recorded branch"
          : canRebindDeletedBranchToDefaultBranch
            ? "clean worktree with deleted recorded branch is already on the default branch"
            : canRestoreRecordedBranchOverContainedHead
              ? "clean worktree HEAD is already contained in the recorded branch, so restoring it abandons no commits"
              : canRescueDivergedDetachedHead
                ? "clean detached worktree HEAD diverged from the recorded branch, so its commits are named on a rescue branch before the recorded branch is restored"
                : `clean worktree HEAD is on live branch "${input.actualBranchName}", which keeps its commits reachable after the recorded branch is restored`
    : cleanliness !== "clean"
      ? inProgressOperation
        ? `worktree is not clean and a git ${GIT_IN_PROGRESS_OPERATION_LABELS[inProgressOperation]} is in progress`
        : "worktree is not clean"
      : !registered
        ? "worktree path is not registered"
      : !registeredBranchMatchesHead
        ? "registered worktree branch does not match HEAD"
      : contention
        ? formatBranchContentionRefusal("recorded branch restore", contention)
      : !expectedBranchExists
        ? actualBranchIsDefaultBranch
          ? "recorded branch is deleted but worktree is clean and already on the default branch"
          : "expected branch does not exist"
        : !sameHead
          ? "expected branch and current HEAD differ"
          : "safe repair could not be proven";
  const fingerprint = fingerprintWorkspaceBranchIncoherence({
    sourceIssueId: input.sourceIssue?.id ?? null,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    worktreePath: input.worktreePath,
    expectedBranch: input.expectedBranchName,
    actualBranch: input.actualBranchName,
    cleanliness,
    expectedHeadSha,
    actualHeadSha,
  });

  return {
    reason: GIT_WORKTREE_BRANCH_INCOHERENCE_REASON,
    fingerprint,
    sourceIssueId: input.sourceIssue?.id ?? null,
    sourceIdentifier: input.sourceIssue?.identifier ?? null,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    worktreePath: path.resolve(input.worktreePath),
    repoRoot: path.resolve(input.repoRoot),
    expectedBranch: input.expectedBranchName,
    actualBranch: input.actualBranchName,
    cleanliness,
    inProgressOperation,
    statusEntryCount: statusLines?.length ?? null,
    dirtyPathSample,
    contention,
    provenance: {
      expectedBranchRef: `refs/heads/${input.expectedBranchName}`,
      actualBranchRef,
      registeredBranchRef,
      registeredPathFound: Boolean(registered),
      registeredBranchMatchesHead,
      expectedBranchExists,
      actualBranchExists,
      expectedHeadSha,
      actualHeadSha,
      sameHead,
      ancestryVerdict,
      defaultBranch,
      actualBranchIsDefaultBranch,
      plainLanguageReason,
    },
    safeRepair: {
      eligible,
      attempted: false,
      succeeded: false,
      reason: safeRepairReason,
    },
  };
}

function branchIncoherenceValidationFailure(evidence: GitWorktreeBranchIncoherenceEvidence) {
  const message = evidence.reason === WORKTREE_METADATA_MISSING_REASON
    ? `Execution workspace at "${evidence.worktreePath}" is missing its git worktree metadata. Safe repair ${evidence.safeRepair.succeeded ? "succeeded" : "was not completed"}: ${evidence.safeRepair.reason}.`
    : `Execution workspace git worktree expected branch "${evidence.expectedBranch}" but found "${formatBranchForMessage(evidence.actualBranch)}" at "${evidence.worktreePath}". Safe repair ${evidence.safeRepair.succeeded ? "succeeded" : "was not completed"}: ${evidence.safeRepair.reason}.`;
  return new WorkspaceRuntimeValidationFailure(
    message,
    {
      workspaceValidation: evidence,
    },
  );
}

function formatBranchContentionRefusal(repairLabel: string, contention: GitWorktreeBranchContention) {
  const activeRunText = contention.activeRun
    ? ` with active run ${contention.activeRun.id}`
    : " with no active run";
  return `${repairLabel} refused because workspace ${contention.claimedByWorkspaceId} already claims the live branch${activeRunText}`;
}

function formatDirtyQuarantineContentionRefusal(contention: GitWorktreeBranchContention) {
  return formatBranchContentionRefusal("dirty quarantine repair", contention);
}

function formatDirtyQuarantineFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    gitErrorIncludes(error, "index.lock") ||
    gitErrorIncludes(error, "index lock") ||
    gitErrorIncludes(error, "another git process") ||
    gitErrorIncludes(error, "Unable to create")
  ) {
    return `dirty quarantine repair aborted because git reported index contention: ${message}`;
  }
  return `dirty quarantine repair failed: ${message}`;
}

function formatDirtyQuarantineAuditComment(input: {
  evidence: GitWorktreeBranchIncoherenceEvidence;
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  claimant: GitWorktreeBranchContention | null;
}) {
  const dirtySample = input.evidence.dirtyPathSample.length > 0
    ? input.evidence.dirtyPathSample.map((entry) => `\`${entry}\``).join(", ")
    : "`none captured`";
  return [
    "Execution workspace dirty worktree quarantined before restore.",
    "",
    `- Source issue: ${formatIssueReference(input.evidence.sourceIssueId, input.evidence.sourceIdentifier ?? input.sourceIssue?.identifier ?? null)}`,
    `- Workspace: \`${input.evidence.executionWorkspaceId ?? "unpersisted"}\``,
    `- Worktree: \`${input.evidence.worktreePath}\``,
    `- Recorded branch: \`${input.evidence.expectedBranch}\``,
    `- Live branch: \`${formatBranchForMessage(input.evidence.actualBranch)}\``,
    `- Rescue branch: \`${input.rescueBranch}\``,
    `- Rescue commit: \`${input.rescueCommitSha}\``,
    `- Dirty file count: \`${input.fileCount}\``,
    `- Dirty path sample: ${dirtySample}`,
    ...(input.evidence.inProgressOperation
      ? [`- Interrupted operation: \`git ${GIT_IN_PROGRESS_OPERATION_LABELS[input.evidence.inProgressOperation]}\` (state cleared after rescue; resolution preserved on the rescue branch)`]
      : []),
    `- Fingerprint: \`${input.evidence.fingerprint}\``,
    input.claimant
      ? `- Claimant: workspace \`${input.claimant.claimedByWorkspaceId}\` on issue ${formatIssueReference(input.claimant.claimedByIssueId, input.claimant.claimedByIssueIdentifier)}${input.claimant.activeRun ? ` with active run \`${input.claimant.activeRun.id}\`` : " with no active run"}`
      : "- Claimant: none",
  ].join("\n");
}

async function writeDirtyQuarantineAuditComments(input: {
  db: Db;
  companyId: string;
  evidence: GitWorktreeBranchIncoherenceEvidence;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  heartbeatRunId: string | null;
}): Promise<{ sourceAuditCommentId: string | null; claimantAuditCommentId: string | null }> {
  const body = formatDirtyQuarantineAuditComment({
    evidence: input.evidence,
    rescueBranch: input.rescueBranch,
    rescueCommitSha: input.rescueCommitSha,
    fileCount: input.fileCount,
    sourceIssue: input.sourceIssue,
    claimant: input.evidence.contention,
  });
  let sourceAuditCommentId: string | null = null;
  let claimantAuditCommentId: string | null = null;
  const now = new Date();
  if (input.evidence.sourceIssueId) {
    const [sourceComment] = await input.db
      .insert(issueComments)
      .values({
        companyId: input.companyId,
        issueId: input.evidence.sourceIssueId,
        authorAgentId: null,
        authorUserId: null,
        authorType: "system",
        createdByRunId: input.heartbeatRunId,
        body,
      })
      .returning({ id: issueComments.id });
    sourceAuditCommentId = sourceComment?.id ?? null;
    await input.db
      .update(issues)
      .set({ updatedAt: now })
      .where(eq(issues.id, input.evidence.sourceIssueId));
  }

  const claimantIssueId = input.evidence.contention?.claimedByIssueId ?? null;
  if (claimantIssueId && claimantIssueId !== input.evidence.sourceIssueId) {
    const [claimantComment] = await input.db
      .insert(issueComments)
      .values({
        companyId: input.companyId,
        issueId: claimantIssueId,
        authorAgentId: null,
        authorUserId: null,
        authorType: "system",
        createdByRunId: input.heartbeatRunId,
        body,
      })
      .returning({ id: issueComments.id });
    claimantAuditCommentId = claimantComment?.id ?? null;
    await input.db
      .update(issues)
      .set({ updatedAt: now })
      .where(eq(issues.id, claimantIssueId));
  }

  return { sourceAuditCommentId, claimantAuditCommentId };
}

async function logDirtyQuarantineActivity(input: {
  db: Db;
  companyId: string;
  evidence: GitWorktreeBranchIncoherenceEvidence;
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  heartbeatRunId: string | null;
  sourceAuditCommentId: string | null;
  claimantAuditCommentId: string | null;
}) {
  await logActivity(input.db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "workspace_runtime",
    runId: input.heartbeatRunId,
    action: "execution_workspace.dirty_worktree_quarantined",
    entityType: input.evidence.executionWorkspaceId ? "execution_workspace" : "issue",
    entityId: input.evidence.executionWorkspaceId ?? input.evidence.sourceIssueId ?? input.companyId,
    details: {
      reason: GIT_WORKTREE_BRANCH_INCOHERENCE_REASON,
      sourceIssueId: input.evidence.sourceIssueId,
      executionWorkspaceId: input.evidence.executionWorkspaceId,
      worktreePath: input.evidence.worktreePath,
      expectedBranch: input.evidence.expectedBranch,
      actualBranch: input.evidence.actualBranch,
      rescueBranch: input.rescueBranch,
      rescueCommitSha: input.rescueCommitSha,
      fileCount: input.fileCount,
      dirtyPathSample: input.evidence.dirtyPathSample,
      fingerprint: input.evidence.fingerprint,
      contention: input.evidence.contention,
      sourceAuditCommentId: input.sourceAuditCommentId,
      claimantAuditCommentId: input.claimantAuditCommentId,
      actor: {
        type: "system",
        id: "workspace_runtime",
        source: "workspace_runtime",
      },
    },
  });
}

async function recordDirtyQuarantineOperation(input: {
  recorder?: WorkspaceOperationRecorder | null;
  phase?: "worktree_prepare" | "workspace_finalize";
  cwd: string;
  evidence: GitWorktreeBranchIncoherenceEvidence;
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  sourceAuditCommentId: string | null;
  claimantAuditCommentId: string | null;
}) {
  if (!input.recorder) return;
  await input.recorder.recordOperation({
    phase: input.phase ?? "worktree_prepare",
    cwd: input.cwd,
    metadata: {
      repoRoot: input.evidence.repoRoot,
      worktreePath: input.evidence.worktreePath,
      expectedBranchName: input.evidence.expectedBranch,
      actualBranchName: input.evidence.actualBranch,
      branchIncoherenceDirtyQuarantineRepair: true,
      rescueBranch: input.rescueBranch,
      rescueCommitSha: input.rescueCommitSha,
      fileCount: input.fileCount,
      dirtyPathSample: input.evidence.dirtyPathSample,
      fingerprint: input.evidence.fingerprint,
      sourceIssueId: input.evidence.sourceIssueId,
      executionWorkspaceId: input.evidence.executionWorkspaceId,
      sourceAuditCommentId: input.sourceAuditCommentId,
      claimantAuditCommentId: input.claimantAuditCommentId,
    },
    run: async () => ({
      status: "succeeded",
      system:
        `Quarantined dirty git worktree state on ${input.rescueBranch} (${formatShortSha(input.rescueCommitSha)}) and restored recorded branch ${input.evidence.expectedBranch}.\n`,
    }),
  });
}

async function quarantineDirtyWorktreeBranchIncoherence(input: {
  db: Db;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  executionWorkspaceId: string | null;
  heartbeatRunId: string | null;
  evidence: GitWorktreeBranchIncoherenceEvidence;
  phase?: "worktree_prepare" | "workspace_finalize";
  recorder?: WorkspaceOperationRecorder | null;
  // Set only when the recorded branch no longer exists: the sha to recreate it at, which is the
  // worktree's HEAD from before the rescue commit moved it.
  recreateRecordedBranchAtSha?: string | null;
}): Promise<DirtyQuarantineRepairResult> {
  const companyId = await readIssueCompanyId(input.db, input.evidence.sourceIssueId);
  if (!companyId) {
    input.evidence.safeRepair.eligible = false;
    input.evidence.safeRepair.reason = "dirty quarantine repair requires a source issue company for audit";
    throw branchIncoherenceValidationFailure(input.evidence);
  }

  const freshContention = await findGitWorktreeBranchContention({
    db: input.db,
    sourceIssue: input.sourceIssue,
    executionWorkspaceId: input.executionWorkspaceId,
    worktreePath: input.worktreePath,
    actualBranchName: input.evidence.actualBranch,
  });
  input.evidence.contention = freshContention;
  if (freshContention) {
    input.evidence.safeRepair.eligible = false;
    input.evidence.safeRepair.reason = formatDirtyQuarantineContentionRefusal(freshContention);
    throw branchIncoherenceValidationFailure(input.evidence);
  }

  const rescueBranch = buildDirtyQuarantineRescueBranch(input.sourceIssue);
  const fileCount = input.evidence.statusEntryCount ?? input.evidence.dirtyPathSample.length;
  const baseMetadata = {
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName: input.expectedBranchName,
    actualBranchName: input.evidence.actualBranch,
    branchIncoherenceDirtyQuarantineRepair: true,
    rescueBranch,
    fingerprint: input.evidence.fingerprint,
    sourceIssueId: input.evidence.sourceIssueId,
    executionWorkspaceId: input.evidence.executionWorkspaceId,
    fileCount,
    dirtyPathSample: input.evidence.dirtyPathSample,
    contention: input.evidence.contention,
  };

  let rescueBranchCreated = false;
  let expectedBranchRestored = false;
  try {
    await assertGitIndexIsUnlocked(input.worktreePath);
    await recordGitOperation(input.recorder, {
      phase: input.phase ?? "worktree_prepare",
      args: ["checkout", "-b", rescueBranch],
      cwd: input.worktreePath,
      metadata: baseMetadata,
      successMessage: `Created rescue branch ${rescueBranch} for dirty git worktree state at ${input.worktreePath}\n`,
      failureLabel: `git checkout -b ${rescueBranch}`,
    });
    rescueBranchCreated = true;
    await recordGitOperation(input.recorder, {
      phase: input.phase ?? "worktree_prepare",
      args: ["add", "-A"],
      cwd: input.worktreePath,
      metadata: baseMetadata,
      successMessage: `Staged dirty git worktree state for rescue branch ${rescueBranch}\n`,
      failureLabel: "git add -A",
    });
    await recordGitOperation(input.recorder, {
      phase: input.phase ?? "worktree_prepare",
      args: [
        "commit",
        "-m",
        "Paperclip dirty workspace rescue",
        "-m",
        [
          `Source-Issue: ${input.evidence.sourceIdentifier ?? input.evidence.sourceIssueId ?? "unknown"}`,
          `Run-Id: ${input.heartbeatRunId ?? "unknown"}`,
          `Recorded-Branch: ${input.expectedBranchName}`,
          `Live-Branch: ${formatBranchForMessage(input.evidence.actualBranch)}`,
          `Fingerprint: ${input.evidence.fingerprint}`,
        ].join("\n"),
      ],
      cwd: input.worktreePath,
      metadata: baseMetadata,
      successMessage: `Committed dirty git worktree state to rescue branch ${rescueBranch}\n`,
      failureLabel: "git commit dirty workspace rescue",
    });
    const rescueCommitSha = await runGit(["rev-parse", "HEAD"], input.worktreePath);
    const recreateAtSha = input.recreateRecordedBranchAtSha ?? null;
    // `checkout -B <branch> <sha>` rather than a plain checkout when the recorded branch is gone:
    // the rescue commit already moved HEAD, so the branch has to be pinned back to the sha the
    // worktree was on before the rescue, not to wherever HEAD sits now.
    const restoreArgs = recreateAtSha
      ? ["checkout", "--ignore-other-worktrees", "-B", input.expectedBranchName, recreateAtSha]
      : ["checkout", input.expectedBranchName];
    await recordGitOperation(input.recorder, {
      phase: input.phase ?? "worktree_prepare",
      args: restoreArgs,
      cwd: input.worktreePath,
      metadata: {
        ...baseMetadata,
        rescueCommitSha,
        ...(recreateAtSha ? { recreatedRecordedBranchAtSha: recreateAtSha } : {}),
      },
      successMessage: recreateAtSha
        ? `Recreated deleted recorded branch ${input.expectedBranchName} at ${formatShortSha(recreateAtSha)} after dirty workspace rescue ${rescueBranch}\n`
        : `Restored recorded branch ${input.expectedBranchName} after dirty workspace rescue ${rescueBranch}\n`,
      failureLabel: recreateAtSha
        ? `git checkout -B ${input.expectedBranchName} ${formatShortSha(recreateAtSha)}`
        : `git checkout ${input.expectedBranchName}`,
    });
    expectedBranchRestored = true;

    // A run that died mid-rebase (or mid-merge/cherry-pick/revert/bisect)
    // leaves the operation's state directory behind even after the recorded
    // branch is checked out, which wedges the next git command in the
    // worktree. The rescue commit above already preserved the in-flight
    // resolution, so clearing the state metadata here loses nothing.
    let clearedInProgressOperation: GitWorktreeInProgressOperation | null = null;
    const lingeringOperation = await detectGitWorktreeInProgressOperation(input.worktreePath);
    if (lingeringOperation) {
      const operationLabel = GIT_IN_PROGRESS_OPERATION_LABELS[lingeringOperation];
      const quitArgs = GIT_IN_PROGRESS_OPERATION_QUIT_ARGS[lingeringOperation];
      await recordGitOperation(input.recorder, {
        phase: input.phase ?? "worktree_prepare",
        args: quitArgs,
        cwd: input.worktreePath,
        metadata: {
          ...baseMetadata,
          clearedInProgressOperation: lingeringOperation,
        },
        successMessage: `Cleared interrupted git ${operationLabel} state after dirty workspace rescue ${rescueBranch}\n`,
        failureLabel: `git ${quitArgs.join(" ")}`,
      });
      const stillInProgress = await detectGitWorktreeInProgressOperation(input.worktreePath);
      if (stillInProgress) {
        input.evidence.safeRepair.succeeded = false;
        input.evidence.safeRepair.reason =
          `dirty quarantine repair could not clear the interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[stillInProgress]} state`;
        throw branchIncoherenceValidationFailure(input.evidence);
      }
      clearedInProgressOperation = lingeringOperation;
    }

    const repairedBranch = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath)
      .catch(() => null);
    if (repairedBranch !== input.expectedBranchName) {
      input.evidence.safeRepair.succeeded = false;
      input.evidence.safeRepair.reason =
        `dirty quarantine repair checked out ${formatBranchForMessage(repairedBranch)} instead of ${input.expectedBranchName}`;
      throw branchIncoherenceValidationFailure(input.evidence);
    }
    const repairedStatus = await runGit(["status", "--porcelain", "--untracked-files=all"], input.worktreePath);
    if (repairedStatus.trim().length > 0) {
      input.evidence.safeRepair.succeeded = false;
      input.evidence.safeRepair.reason = "dirty quarantine repair completed but the worktree is still dirty";
      throw branchIncoherenceValidationFailure(input.evidence);
    }

    const comments = await writeDirtyQuarantineAuditComments({
      db: input.db,
      companyId,
      evidence: input.evidence,
      sourceIssue: input.sourceIssue,
      rescueBranch,
      rescueCommitSha,
      fileCount,
      heartbeatRunId: input.heartbeatRunId,
    });
    await logDirtyQuarantineActivity({
      db: input.db,
      companyId,
      evidence: input.evidence,
      rescueBranch,
      rescueCommitSha,
      fileCount,
      heartbeatRunId: input.heartbeatRunId,
      sourceAuditCommentId: comments.sourceAuditCommentId,
      claimantAuditCommentId: comments.claimantAuditCommentId,
    });
    await recordDirtyQuarantineOperation({
      recorder: input.recorder,
      phase: input.phase,
      cwd: input.worktreePath,
      evidence: input.evidence,
      rescueBranch,
      rescueCommitSha,
      fileCount,
      sourceAuditCommentId: comments.sourceAuditCommentId,
      claimantAuditCommentId: comments.claimantAuditCommentId,
    });
    return {
      rescueBranch,
      rescueCommitSha,
      fileCount,
      clearedInProgressOperation,
      ...comments,
    };
  } catch (error) {
    if (rescueBranchCreated && !expectedBranchRestored) {
      // When the recorded branch was deleted there is nothing to go back to under that name, so
      // fall back to the branch the worktree was actually on. Otherwise a failed rescue leaves the
      // worktree parked on the rescue branch, and the next dispatch would fold the quarantined
      // dirty commit into the recorded branch it recreates.
      const rollbackTarget = input.recreateRecordedBranchAtSha && input.evidence.actualBranch
        ? input.evidence.actualBranch
        : input.expectedBranchName;
      await runGit(["checkout", rollbackTarget], input.worktreePath).catch(() => null);
    }
    if (error instanceof WorkspaceRuntimeValidationFailure) throw error;
    input.evidence.safeRepair.succeeded = false;
    input.evidence.safeRepair.reason = formatDirtyQuarantineFailure(error);
    throw branchIncoherenceValidationFailure(input.evidence);
  }
}

async function recordForwardBranchReconcileOperation(input: {
  recorder?: WorkspaceOperationRecorder | null;
  phase?: "worktree_prepare" | "workspace_finalize";
  cwd: string;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string;
  actualBranchName: string;
  executionWorkspaceId: string | null;
  sourceIssueId: string | null;
  fingerprint: string;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
  mode: "record_updated" | "adopt_for_realize";
  auditCommentId?: string | null;
  recoveryActionId?: string | null;
}) {
  if (!input.recorder) return;

  await input.recorder.recordOperation({
    phase: input.phase ?? "worktree_prepare",
    cwd: input.cwd,
    metadata: {
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      expectedBranchName: input.expectedBranchName,
      actualBranchName: input.actualBranchName,
      branchIncoherenceReconcileForward: true,
      reconcileMode: input.mode,
      fingerprint: input.fingerprint,
      sourceIssueId: input.sourceIssueId,
      executionWorkspaceId: input.executionWorkspaceId,
      expectedHeadSha: input.expectedHeadSha,
      actualHeadSha: input.actualHeadSha,
      ancestryVerdict: input.ancestryVerdict,
      auditCommentId: input.auditCommentId ?? null,
      recoveryActionId: input.recoveryActionId ?? null,
    },
    run: async () => ({
      status: "succeeded",
      system:
        input.mode === "record_updated"
          ? `Reconciled execution workspace branch record from ${input.expectedBranchName} to ${input.actualBranchName}; worktree left unchanged.\n`
          : `Adopted live git worktree branch ${input.actualBranchName} for this execution workspace realization; worktree left unchanged.\n`,
    }),
  });
}

async function logForwardBranchReconcileActivity(input: {
  db: Db;
  companyId: string;
  executionWorkspaceId: string;
  sourceIssueId: string | null;
  runId: string | null;
  mode: ExecutionWorkspaceBranchReconcileMode;
  reason: string | null;
  fromBranch: string;
  toBranch: string;
  fromSha: string | null;
  toSha: string | null;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
  fingerprint: string;
  auditCommentId: string | null;
  recoveryActionId: string | null;
}) {
  await logActivity(input.db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "workspace_runtime",
    runId: input.runId,
    action: "execution_workspace.branch_reconciled",
    entityType: "execution_workspace",
    entityId: input.executionWorkspaceId,
    details: {
      mode: input.mode,
      reason: input.reason,
      fromBranch: input.fromBranch,
      toBranch: input.toBranch,
      fromSha: input.fromSha,
      toSha: input.toSha,
      ancestryVerdict: input.ancestryVerdict,
      fingerprint: input.fingerprint,
      sourceIssueId: input.sourceIssueId,
      auditCommentId: input.auditCommentId,
      recoveryActionId: input.recoveryActionId,
      actor: {
        type: "system",
        id: "workspace_runtime",
        source: "workspace_runtime",
      },
    },
  });
}

export async function reconcilePendingForwardBranchAfterPersistence(input: {
  db: Db;
  executionWorkspaceId: string;
  pending: PendingForwardBranchReconcile;
  heartbeatRunId?: string | null;
  reconcileOperationPhase?: "worktree_prepare" | "workspace_finalize";
  recorder?: WorkspaceOperationRecorder | null;
}) {
  const result = await executionWorkspaceService(input.db).reconcileExecutionWorkspaceBranch(
    input.executionWorkspaceId,
    {
      mode: "forward",
      reason: input.pending.reason,
      alternateRecoveryFingerprints: [input.pending.prePersistenceFingerprint],
      actor: {
        actorType: "system",
        actorId: "workspace_runtime",
        agentId: null,
        runId: input.heartbeatRunId ?? null,
      },
    },
  );
  await logForwardBranchReconcileActivity({
    db: input.db,
    companyId: result.workspace.companyId,
    executionWorkspaceId: result.workspace.id,
    sourceIssueId: result.workspace.sourceIssueId,
    runId: input.heartbeatRunId ?? null,
    mode: "forward",
    reason: input.pending.reason,
    fromBranch: result.inspection.fromBranch,
    toBranch: result.inspection.toBranch,
    fromSha: result.inspection.fromSha,
    toSha: result.inspection.toSha,
    ancestryVerdict: result.inspection.ancestryVerdict,
    fingerprint: result.inspection.fingerprint,
    auditCommentId: result.auditCommentId,
    recoveryActionId: result.recoveryAction?.id ?? null,
  });
  await recordForwardBranchReconcileOperation({
    recorder: input.recorder,
    phase: input.reconcileOperationPhase,
    cwd: result.inspection.worktreePath,
    repoRoot: result.inspection.repoRoot,
    worktreePath: result.inspection.worktreePath,
    expectedBranchName: result.inspection.fromBranch,
    actualBranchName: result.inspection.toBranch,
    executionWorkspaceId: result.workspace.id,
    sourceIssueId: result.workspace.sourceIssueId,
    fingerprint: result.inspection.fingerprint,
    expectedHeadSha: result.inspection.fromSha,
    actualHeadSha: result.inspection.toSha,
    ancestryVerdict: result.inspection.ancestryVerdict,
    mode: "adopt_for_realize",
    auditCommentId: result.auditCommentId,
    recoveryActionId: result.recoveryAction?.id ?? null,
  });
  return result;
}

export async function ensureGitWorktreeBranchCoherent(input: {
  db?: Db | null;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string | null;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  executionWorkspaceId?: string | null;
  /**
   * SUP-11520: the workspace row that is *asking* for this repair, for callers that can name it
   * but do not own it. Defaults to `executionWorkspaceId`. It is used for one thing only —
   * excluding the asker from the branch-contention search — and never grants record writes.
   */
  contentionExcludeExecutionWorkspaceId?: string | null;
  actualBranchName?: string | null;
  heartbeatRunId?: string | null;
  enableWorkspaceBranchReconcileForward?: boolean;
  enableWorkspaceDirtyQuarantineRepair?: boolean;
  persistForwardReconcile?: boolean;
  reconcileOperationPhase?: "worktree_prepare" | "workspace_finalize";
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<GitWorktreeBranchCoherenceResult> {
  const expectedBranchName = input.expectedBranchName?.trim();
  if (!expectedBranchName) return { branchName: null, reconciledForward: false, warnings: [] };

  const currentBranch = input.actualBranchName !== undefined
    ? input.actualBranchName
    : await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath).catch(() => null);
  if (currentBranch === expectedBranchName) {
    return { branchName: expectedBranchName, reconciledForward: false, warnings: [] };
  }

  const evidence = await inspectGitWorktreeBranchIncoherence({
    db: input.db ?? null,
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName,
    actualBranchName: currentBranch,
    sourceIssue: input.sourceIssue,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    contentionExcludeExecutionWorkspaceId:
      input.contentionExcludeExecutionWorkspaceId ?? input.executionWorkspaceId ?? null,
  });

  if (evidence.reason === WORKTREE_METADATA_MISSING_REASON) {
    throw branchIncoherenceValidationFailure(evidence);
  }

  if (evidence.cleanliness === "dirty" && input.enableWorkspaceDirtyQuarantineRepair === true) {
    if (!input.db) {
      evidence.safeRepair.reason = "dirty quarantine repair requires database access for claimant checks and audit";
      throw branchIncoherenceValidationFailure(evidence);
    }
    if (!evidence.provenance.registeredPathFound) {
      evidence.safeRepair.reason = "dirty quarantine repair requires a registered git worktree path";
      throw branchIncoherenceValidationFailure(evidence);
    }
    // A deleted recorded branch used to be an unconditional refusal, which dead-blocked every later
    // dispatch for an issue whose agent had merely renamed its branch. The refusal is not what keeps
    // commits safe here: the deletion already happened, and recreating the branch at the worktree's
    // current HEAD makes nothing unreachable that was still reachable a moment ago. What it cannot
    // do is recover whatever the branch pointed at before it was deleted, so the repair is only
    // allowed when there is a HEAD to recreate from, and it always says so in the warning.
    const recordedBranchRecreateSha = evidence.provenance.expectedBranchExists
      ? null
      : evidence.provenance.actualHeadSha;
    if (!evidence.provenance.expectedBranchExists && !recordedBranchRecreateSha) {
      evidence.safeRepair.reason =
        "dirty quarantine repair requires the recorded branch to exist, or a resolvable worktree HEAD to recreate it from";
      throw branchIncoherenceValidationFailure(evidence);
    }
    if (evidence.contention) {
      evidence.safeRepair.eligible = false;
      evidence.safeRepair.reason = formatDirtyQuarantineContentionRefusal(evidence.contention);
      throw branchIncoherenceValidationFailure(evidence);
    }
    await assertDirtyQuarantineRuntimeServicesStopped({
      db: input.db,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      evidence,
    });
    evidence.safeRepair.eligible = true;
    evidence.safeRepair.attempted = true;
    evidence.safeRepair.reason = "dirty worktree can be quarantined on a rescue branch before restoring the recorded branch";
    const result = await quarantineDirtyWorktreeBranchIncoherence({
      db: input.db,
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      expectedBranchName,
      sourceIssue: input.sourceIssue,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      heartbeatRunId: input.heartbeatRunId ?? null,
      evidence,
      phase: input.reconcileOperationPhase,
      recorder: input.recorder ?? null,
      recreateRecordedBranchAtSha: recordedBranchRecreateSha,
    });
    evidence.safeRepair.succeeded = true;
    const recreatedNote = recordedBranchRecreateSha
      ? `; recorded branch had been deleted and was recreated at ${formatShortSha(recordedBranchRecreateSha)}`
      : "";
    evidence.safeRepair.reason = result.clearedInProgressOperation
      ? `dirty worktree quarantined on ${result.rescueBranch} at ${formatShortSha(result.rescueCommitSha)}; interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[result.clearedInProgressOperation]} state cleared${recreatedNote}`
      : `dirty worktree quarantined on ${result.rescueBranch} at ${formatShortSha(result.rescueCommitSha)}${recreatedNote}`;
    return {
      branchName: expectedBranchName,
      reconciledForward: false,
      dirtyQuarantineRepair: result,
      warnings: [
        `Execution workspace dirty worktree state was quarantined on rescue branch "${result.rescueBranch}" (${formatShortSha(result.rescueCommitSha)}; ${result.fileCount} ${result.fileCount === 1 ? "file" : "files"}) before restoring recorded branch "${expectedBranchName}".${result.clearedInProgressOperation ? ` An interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[result.clearedInProgressOperation]} was also cleared; its in-flight state is preserved on the rescue branch.` : ""}${recordedBranchRecreateSha ? ` Recorded branch "${expectedBranchName}" had been deleted from the repository and was recreated at ${formatShortSha(recordedBranchRecreateSha)}, the commit this worktree was on; any history it pointed at before the deletion is not recoverable from the worktree and may need to be restored from a reflog or a remote.` : ""}`,
      ],
    };
  }

  // A recorded branch that no longer exists anywhere has no commits to lose, so
  // adopting the clean checked-out branch is trivially forward-only. This is the
  // steady state left behind when an agent renames its task branch (e.g. to a
  // feat/* PR branch) and the recorded branch was never created or was deleted.
  const recordedBranchMissingButAdoptable =
    !evidence.provenance.expectedBranchExists &&
    evidence.provenance.actualBranchExists === true &&
    evidence.provenance.registeredBranchMatchesHead;
  if (
    input.enableWorkspaceBranchReconcileForward === true &&
    evidence.cleanliness === "clean" &&
    currentBranch &&
    ((evidence.provenance.ancestryVerdict === "ancestor" && !evidence.provenance.sameHead) ||
      recordedBranchMissingButAdoptable)
  ) {
    const reason = evidence.provenance.expectedBranchExists
      ? "Automatic forward reconciliation: recorded branch is an ancestor of the checked-out branch."
      : "Automatic forward reconciliation: the recorded branch no longer exists, so Paperclip adopted the clean checked-out branch.";
    if (input.executionWorkspaceId && input.persistForwardReconcile !== false) {
      if (!input.db) {
        evidence.safeRepair.reason = "forward reconciliation requires database access to update the execution workspace record";
        throw branchIncoherenceValidationFailure(evidence);
      }
      try {
        const result = await executionWorkspaceService(input.db).reconcileExecutionWorkspaceBranch(
          input.executionWorkspaceId,
          {
            mode: "forward",
            reason,
            actor: {
              actorType: "system",
              actorId: "workspace_runtime",
              agentId: null,
              runId: input.heartbeatRunId ?? null,
            },
          },
        );
        await logForwardBranchReconcileActivity({
          db: input.db,
          companyId: result.workspace.companyId,
          executionWorkspaceId: result.workspace.id,
          sourceIssueId: result.workspace.sourceIssueId ?? evidence.sourceIssueId ?? null,
          runId: input.heartbeatRunId ?? null,
          mode: "forward",
          reason,
          fromBranch: result.inspection.fromBranch,
          toBranch: result.inspection.toBranch,
          fromSha: result.inspection.fromSha,
          toSha: result.inspection.toSha,
          ancestryVerdict: result.inspection.ancestryVerdict,
          fingerprint: result.inspection.fingerprint,
          auditCommentId: result.auditCommentId,
          recoveryActionId: result.recoveryAction?.id ?? null,
        });
        await recordForwardBranchReconcileOperation({
          recorder: input.recorder,
          phase: input.reconcileOperationPhase,
          cwd: input.worktreePath,
          repoRoot: result.inspection.repoRoot,
          worktreePath: result.inspection.worktreePath,
          expectedBranchName: result.inspection.fromBranch,
          actualBranchName: result.inspection.toBranch,
          executionWorkspaceId: result.workspace.id,
          sourceIssueId: result.workspace.sourceIssueId ?? evidence.sourceIssueId ?? null,
          fingerprint: result.inspection.fingerprint,
          expectedHeadSha: result.inspection.fromSha,
          actualHeadSha: result.inspection.toSha,
          ancestryVerdict: result.inspection.ancestryVerdict,
          mode: "record_updated",
          auditCommentId: result.auditCommentId,
          recoveryActionId: result.recoveryAction?.id ?? null,
        });
        return { branchName: result.inspection.toBranch, reconciledForward: true, warnings: [] };
      } catch (error) {
        evidence.safeRepair.reason =
          `forward reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
        throw branchIncoherenceValidationFailure(evidence);
      }
    }

    if (!input.db) {
      evidence.safeRepair.reason = "forward reconciliation adoption requires database access to audit after workspace realization";
      throw branchIncoherenceValidationFailure(evidence);
    }
    return {
      branchName: currentBranch,
      reconciledForward: true,
      warnings: [],
      pendingForwardBranchReconcile: {
        recordedBranchName: expectedBranchName,
        adoptedBranchName: currentBranch,
        prePersistenceFingerprint: evidence.fingerprint,
        reason,
      },
    };
  }

  if (!evidence.safeRepair.eligible) {
    throw branchIncoherenceValidationFailure(evidence);
  }

  evidence.safeRepair.attempted = true;
  const warningPrefix =
    `Execution workspace branch metadata was self-healed from "${expectedBranchName}" to "${formatBranchForMessage(currentBranch)}" at ${input.worktreePath}.`;
  if (
    currentBranch &&
    evidence.provenance.actualBranchExists === true &&
    evidence.provenance.ancestryVerdict === "ancestor" &&
    !evidence.provenance.sameHead
  ) {
    evidence.safeRepair.succeeded = true;
    evidence.safeRepair.reason = "clean worktree adopted the checked-out branch because it is forward of the recorded branch";
    return {
      branchName: currentBranch,
      reconciledForward: false,
      warnings: [
        `${warningPrefix} The checked-out branch contains the recorded branch plus newer commits, so Paperclip adopted it for subsequent runs.`,
      ],
    };
  }

  if (
    currentBranch === null &&
    evidence.provenance.ancestryVerdict === "ancestor" &&
    !evidence.provenance.sameHead &&
    evidence.provenance.actualHeadSha
  ) {
    try {
      await recordGitOperation(input.recorder, {
        phase: "worktree_prepare",
        args: ["checkout", "-B", expectedBranchName, evidence.provenance.actualHeadSha],
        cwd: input.worktreePath,
        metadata: {
          repoRoot: input.repoRoot,
          worktreePath: input.worktreePath,
          expectedBranchName,
          actualBranchName: currentBranch,
          branchIncoherenceRepair: true,
          detachedHeadRepair: true,
          fingerprint: evidence.fingerprint,
          sourceIssueId: evidence.sourceIssueId,
          executionWorkspaceId: evidence.executionWorkspaceId,
        },
        successMessage: `Reattached detached git worktree HEAD at ${input.worktreePath} to ${expectedBranchName}\n`,
        failureLabel: `git checkout -B ${expectedBranchName} ${formatShortSha(evidence.provenance.actualHeadSha)}`,
      });
    } catch (error) {
      evidence.safeRepair.succeeded = false;
      evidence.safeRepair.reason = `safe detached HEAD reattachment failed: ${error instanceof Error ? error.message : String(error)}`;
      throw branchIncoherenceValidationFailure(evidence);
    }

    const repairedBranch = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath)
      .catch(() => null);
    if (repairedBranch !== expectedBranchName) {
      evidence.safeRepair.succeeded = false;
      evidence.safeRepair.reason = `reattach completed but HEAD is ${formatBranchForMessage(repairedBranch)}`;
      throw branchIncoherenceValidationFailure(evidence);
    }

    evidence.safeRepair.succeeded = true;
    evidence.safeRepair.reason = "clean detached worktree HEAD was reattached to the recorded branch";
    return {
      branchName: expectedBranchName,
      reconciledForward: false,
      warnings: [
        `${warningPrefix} The detached HEAD contained the recorded branch plus newer commits, so Paperclip moved the recorded branch to that HEAD.`,
      ],
    };
  }

  if (
    !evidence.provenance.expectedBranchExists &&
    currentBranch &&
    evidence.provenance.actualBranchExists === true &&
    evidence.provenance.actualBranchIsDefaultBranch &&
    evidence.provenance.registeredBranchMatchesHead
  ) {
    if (input.db && input.executionWorkspaceId) {
      const reason = `Automatic default-branch rebind: recorded branch "${expectedBranchName}" was deleted; clean worktree is on the default branch "${currentBranch}".`;
      try {
        const result = await executionWorkspaceService(input.db).reconcileExecutionWorkspaceBranch(
          input.executionWorkspaceId,
          {
            mode: "default_branch_rebind",
            reason,
            alternateRecoveryFingerprints: [evidence.fingerprint],
            actor: { actorType: "system", actorId: "workspace_runtime", agentId: null, runId: input.heartbeatRunId ?? null },
          },
        );
        await logForwardBranchReconcileActivity({
          db: input.db,
          companyId: result.workspace.companyId,
          executionWorkspaceId: result.workspace.id,
          sourceIssueId: result.workspace.sourceIssueId ?? evidence.sourceIssueId ?? null,
          runId: input.heartbeatRunId ?? null,
          mode: "default_branch_rebind",
          reason,
          fromBranch: result.inspection.fromBranch,
          toBranch: result.inspection.toBranch,
          fromSha: result.inspection.fromSha,
          toSha: result.inspection.toSha,
          ancestryVerdict: result.inspection.ancestryVerdict,
          fingerprint: result.inspection.fingerprint,
          auditCommentId: result.auditCommentId,
          recoveryActionId: result.recoveryAction?.id ?? null,
        });
        await recordForwardBranchReconcileOperation({
          recorder: input.recorder,
          phase: input.reconcileOperationPhase,
          cwd: input.worktreePath,
          repoRoot: result.inspection.repoRoot,
          worktreePath: result.inspection.worktreePath,
          expectedBranchName: result.inspection.fromBranch,
          actualBranchName: result.inspection.toBranch,
          executionWorkspaceId: result.workspace.id,
          sourceIssueId: result.workspace.sourceIssueId ?? evidence.sourceIssueId ?? null,
          fingerprint: result.inspection.fingerprint,
          expectedHeadSha: result.inspection.fromSha,
          actualHeadSha: result.inspection.toSha,
          ancestryVerdict: result.inspection.ancestryVerdict,
          mode: "record_updated",
          auditCommentId: result.auditCommentId,
          recoveryActionId: result.recoveryAction?.id ?? null,
        });
        evidence.safeRepair.succeeded = true;
        evidence.safeRepair.reason = "clean worktree with deleted recorded branch rebound to the default branch and persisted";
        return {
          branchName: result.inspection.toBranch,
          reconciledForward: false,
          warnings: [
            `${warningPrefix} The recorded branch "${expectedBranchName}" was deleted from the repository, but the worktree is clean and already on the default branch "${currentBranch}". Paperclip adopted the default branch as the workspace branch.`,
          ],
        };
      } catch (error) {
        evidence.safeRepair.succeeded = false;
        evidence.safeRepair.reason = `default branch rebind persistence failed: ${error instanceof Error ? error.message : String(error)}`;
        throw branchIncoherenceValidationFailure(evidence);
      }
    }

    evidence.safeRepair.succeeded = true;
    evidence.safeRepair.reason = "clean worktree with deleted recorded branch is already on the default branch";
    return {
      branchName: currentBranch,
      reconciledForward: false,
      warnings: [
        `${warningPrefix} The recorded branch "${expectedBranchName}" was deleted from the repository, but the worktree is clean and already on the default branch "${currentBranch}". Paperclip adopted the default branch as the workspace branch.`,
      ],
    };
  }

  // the shared checkout below strands anything reachable only from a detached HEAD, so
  // when HEAD is detached and diverged, give its commits a name first. This must happen before the
  // checkout, not after: once HEAD moves, the sha is only recoverable from the reflog.
  let divergedDetachedRescueBranch: string | null = null;
  const divergedDetachedHeadSha = evidence.provenance.actualHeadSha;
  if (
    currentBranch === null &&
    divergedDetachedHeadSha &&
    !evidence.provenance.sameHead &&
    evidence.provenance.ancestryVerdict !== "ancestor"
  ) {
    const rescueBranch = buildDirtyQuarantineRescueBranch(input.sourceIssue);
    try {
      await recordGitOperation(input.recorder, {
        phase: input.reconcileOperationPhase ?? "worktree_prepare",
        args: ["branch", rescueBranch, divergedDetachedHeadSha],
        cwd: input.worktreePath,
        metadata: {
          repoRoot: input.repoRoot,
          worktreePath: input.worktreePath,
          expectedBranchName,
          actualBranchName: currentBranch,
          branchIncoherenceRepair: true,
          divergedDetachedHeadRescue: true,
          rescueBranch,
          rescueCommitSha: divergedDetachedHeadSha,
          fingerprint: evidence.fingerprint,
          sourceIssueId: evidence.sourceIssueId,
          executionWorkspaceId: evidence.executionWorkspaceId,
        },
        successMessage:
          `Named diverged detached HEAD ${formatShortSha(divergedDetachedHeadSha)} on rescue branch ${rescueBranch} at ${input.worktreePath}\n`,
        failureLabel: `git branch ${rescueBranch} ${formatShortSha(divergedDetachedHeadSha)}`,
      });
    } catch (error) {
      evidence.safeRepair.succeeded = false;
      evidence.safeRepair.reason =
        `detached HEAD rescue branch creation failed: ${error instanceof Error ? error.message : String(error)}`;
      throw branchIncoherenceValidationFailure(evidence);
    }
    divergedDetachedRescueBranch = rescueBranch;
  }

  try {
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      // --ignore-other-worktrees is required, not incidental: the recorded branch is routinely
      // checked out in the base repo, and without this git refuses every safe repair with
      // "already used by worktree at ...". The eligibility predicates above are what bound this
      // checkout; see canRestoreRecordedBranchOverContainedHead.
      args: ["checkout", "--ignore-other-worktrees", expectedBranchName],
      cwd: input.worktreePath,
      metadata: {
        repoRoot: input.repoRoot,
        worktreePath: input.worktreePath,
        expectedBranchName,
        actualBranchName: currentBranch,
        branchIncoherenceRepair: true,
        fingerprint: evidence.fingerprint,
        sourceIssueId: evidence.sourceIssueId,
        executionWorkspaceId: evidence.executionWorkspaceId,
      },
      successMessage: `Repaired clean git worktree branch mismatch at ${input.worktreePath}: checked out ${expectedBranchName}\n`,
      failureLabel: `git checkout ${expectedBranchName}`,
    });
  } catch (error) {
    evidence.safeRepair.succeeded = false;
    evidence.safeRepair.reason = `safe checkout failed: ${error instanceof Error ? error.message : String(error)}`;
    throw branchIncoherenceValidationFailure(evidence);
  }

  const repairedBranch = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath)
    .catch(() => null);
  if (repairedBranch !== expectedBranchName) {
    evidence.safeRepair.succeeded = false;
    evidence.safeRepair.reason = `checkout completed but HEAD is ${formatBranchForMessage(repairedBranch)}`;
    throw branchIncoherenceValidationFailure(evidence);
  }

  evidence.safeRepair.succeeded = true;
  evidence.safeRepair.reason = divergedDetachedRescueBranch
    ? `clean detached worktree HEAD was preserved on rescue branch ${divergedDetachedRescueBranch} before the recorded branch was checked out`
    : "clean worktree checked out the recorded branch";
  // Name the branch the worktree was parked on. Its commits survive there, but nothing else in the
  // run surfaces them, so an agent resuming on the recorded branch would otherwise just see its
  // previous work vanish and redo it.
  const abandonedBranchNote = divergedDetachedRescueBranch
    ? ` The worktree was on a detached HEAD that diverged from the recorded branch; its commits were preserved on rescue branch "${divergedDetachedRescueBranch}" (${formatShortSha(divergedDetachedHeadSha)}) and were not discarded.`
    : currentBranch && !evidence.provenance.sameHead && evidence.provenance.actualBranchExists === true
      ? ` The worktree was parked on "${currentBranch}"; any commits made there are still reachable from that branch and were not discarded.`
      : "";
  return {
    branchName: expectedBranchName,
    reconciledForward: false,
    warnings: [
      `Execution workspace branch metadata was self-healed by checking out recorded branch "${expectedBranchName}" at ${input.worktreePath}.${abandonedBranchNote}`,
    ],
  };
}

// Resolve the authoritative base ref for a fresh worktree. A configured local
// branch is mapped to its `origin/<branch>` counterpart so unpushed local
// divergence never leaks into the task branch; remote-tracking refs, SHAs, and
// tags are used verbatim, and an unset/`HEAD` base falls back to the detected
// default branch (which already prefers `origin/master`).
async function resolveAuthoritativeBaseRef(
  repoRoot: string,
  configuredBaseRef: string | null,
  resolveGitAuth?: GitRemoteAuthProvider | null,
): Promise<{ baseRef: string; warnings: string[]; refreshed: boolean }> {
  const warnings: string[] = [];
  const detectOrHead = async () => (await detectDefaultBranch(repoRoot, resolveGitAuth)) ?? "HEAD";

  const configured = configuredBaseRef?.trim();
  if (!configured || configured === "HEAD") {
    const detected = await detectOrHead();
    warnings.push(
      `No baseRef configured on the workspace strategy, project workspace repoRef, or defaultRef; falling back to detected default branch "${detected}". Set project executionWorkspacePolicy.workspaceStrategy.baseRef or the workspace defaultRef to pin the base.`,
    );
    return { baseRef: detected, warnings, refreshed: false };
  }

  const remoteTracking = parseRemoteTrackingRef(configured);
  if (remoteTracking && (await remoteExists(repoRoot, remoteTracking.remote))) {
    return { baseRef: configured, warnings, refreshed: false };
  }

  if (await localBranchExists(repoRoot, configured)) {
    const remoteCandidate = `origin/${configured}`;
    // Refresh here and keep the warnings; the caller skips its own refresh of
    // the returned ref (see `refreshed`) so we never fetch the same ref twice.
    warnings.push(...await refreshRemoteTrackingBaseRef(repoRoot, remoteCandidate, resolveGitAuth));
    if (await resolveBaseRefSha(repoRoot, remoteCandidate)) {
      return { baseRef: remoteCandidate, warnings, refreshed: true };
    }
    if (await remoteExists(repoRoot, "origin")) {
      warnings.push(
        `Configured base ref "${configured}" is a local branch with no matching origin/${configured}; basing the execution workspace on the local ref, which may include unpushed commits.`,
      );
    }
    return { baseRef: configured, warnings, refreshed: false };
  }

  return { baseRef: configured, warnings, refreshed: false };
}

// Auto-refresh a reused worktree to the latest base only when it is provably
// unstarted: no task commits past the base and a clean tree (including untracked
// files). This pulls an idle worktree forward to the freshest `origin/master`
// after a long planning phase without ever destroying in-progress work. Only
// remote-tracking bases are eligible; local-only bases keep warn-only drift.
async function refreshUnstartedWorktreeToBase(input: {
  repoRoot: string;
  worktreePath: string;
  branchName: string | null;
  baseRef: string;
  currentBaseRefSha: string;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<{ refreshed: boolean; baseRefSha: string | null }> {
  if (!parseRemoteTrackingRef(input.baseRef)) {
    return { refreshed: false, baseRefSha: null };
  }

  const headSha = await runGit(["rev-parse", "HEAD"], input.worktreePath).catch(() => null);
  if (!headSha) {
    return { refreshed: false, baseRefSha: null };
  }
  if (headSha === input.currentBaseRefSha) {
    return { refreshed: false, baseRefSha: input.currentBaseRefSha };
  }

  const commitsPastBaseRaw = await runGit(
    ["rev-list", "--count", `${input.currentBaseRefSha}..HEAD`],
    input.worktreePath,
  ).catch(() => null);
  const commitsPastBase = commitsPastBaseRaw === null ? null : parseInt(commitsPastBaseRaw, 10);
  if (commitsPastBase === null || !Number.isFinite(commitsPastBase) || commitsPastBase > 0) {
    return { refreshed: false, baseRefSha: null };
  }

  // Force `--untracked-files=all` so untracked files are counted regardless of a
  // local `status.showUntrackedFiles=no`; otherwise the clean-tree guard could
  // pass and the `reset --hard` below would destroy untracked work.
  const status = await runGit(
    ["status", "--porcelain", "--untracked-files=all"],
    input.worktreePath,
  ).catch(() => null);
  if (status === null || status.trim().length > 0) {
    return { refreshed: false, baseRefSha: null };
  }

  await recordGitOperation(input.recorder, {
    phase: "worktree_prepare",
    args: ["reset", "--hard", input.currentBaseRefSha],
    cwd: input.worktreePath,
    metadata: {
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      baseRef: input.baseRef,
      previousHeadSha: headSha,
      baseRefSha: input.currentBaseRefSha,
      refreshedUnstartedWorktree: true,
    },
    successMessage: `Refreshed unstarted git worktree at ${input.worktreePath} to ${input.baseRef} (${formatShortSha(input.currentBaseRefSha)})\n`,
    failureLabel: `git reset --hard ${input.currentBaseRefSha}`,
  });

  return { refreshed: true, baseRefSha: input.currentBaseRefSha };
}


type GitWorktreeListEntry = {
  worktree: string;
  branch: string | null;
};

export type ManagedGitWorktreeBranchInspection = {
  valid: boolean;
  reason: string | null;
  reasonCode:
    | "missing_worktree"
    | "not_a_git_checkout"
    | "not_registered"
    | "wrong_repository_root"
    | "branch_mismatch"
    | null;
  repoRoot: string | null;
  worktreePath: string;
  expectedBranchName: string | null;
  actualBranchName: string | null;
};

function parseGitWorktreeListPorcelain(raw: string): GitWorktreeListEntry[] {
  const entries: GitWorktreeListEntry[] = [];
  let current: Partial<GitWorktreeListEntry> = {};

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { worktree: line.slice("worktree ".length) };
      continue;
    }
    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
      continue;
    }
    if (line === "" && current.worktree) {
      entries.push({
        worktree: current.worktree,
        branch: current.branch ?? null,
      });
      current = {};
    }
  }

  if (current.worktree) {
    entries.push({
      worktree: current.worktree,
      branch: current.branch ?? null,
    });
  }

  return entries;
}

async function resolveGitOwnerRepoRoot(cwd: string): Promise<string> {
  const checkoutRoot = path.resolve(await runGit(["rev-parse", "--show-toplevel"], cwd));
  const commonDir = await runGit(["rev-parse", "--git-common-dir"], checkoutRoot).catch(() => null);
  if (!commonDir) return checkoutRoot;
  return path.dirname(path.resolve(checkoutRoot, commonDir));
}

async function findRegisteredGitWorktreeByBranch(repoRoot: string, branchName: string): Promise<string | null> {
  const raw = await runGit(["worktree", "list", "--porcelain"], repoRoot).catch(() => null);
  if (!raw) return null;

  const expectedBranchRef = `refs/heads/${branchName}`;
  for (const entry of parseGitWorktreeListPorcelain(raw)) {
    if (entry.branch !== expectedBranchRef) continue;
    return path.resolve(entry.worktree);
  }

  return null;
}

async function findRegisteredGitWorktreeByPath(repoRoot: string, worktreePath: string): Promise<GitWorktreeListEntry | null> {
  const raw = await runGit(["worktree", "list", "--porcelain"], repoRoot).catch(() => null);
  if (!raw) return null;

  const expectedPath = await resolvePathForWorktreeComparison(worktreePath);
  for (const entry of parseGitWorktreeListPorcelain(raw)) {
    if (await resolvePathForWorktreeComparison(entry.worktree) === expectedPath) {
      return entry;
    }
  }
  return null;
}

async function isGitCheckout(cwd: string): Promise<boolean> {
  return Boolean(await runGit(["rev-parse", "--git-dir"], cwd).catch(() => null));
}

export async function detectDefaultBranch(
  repoRoot: string,
  resolveGitAuth?: GitRemoteAuthProvider | null,
): Promise<string | null> {
  const originMasterRef = "origin/master";
  await refreshRemoteTrackingBaseRef(repoRoot, originMasterRef, resolveGitAuth);
  if (await resolveBaseRefSha(repoRoot, originMasterRef)) {
    return originMasterRef;
  }

  // Try the explicit remote HEAD first (set by git clone or git remote set-head)
  try {
    const remoteHead = await runGit(
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      repoRoot,
    );
    if (remoteHead) {
      await refreshRemoteTrackingBaseRef(repoRoot, remoteHead, resolveGitAuth);
      if (await resolveBaseRefSha(repoRoot, remoteHead)) return remoteHead;
    }
  } catch {
    // Not set — fall through to heuristic
  }

  // Fallback: check for common default branch names on the remote
  for (const candidate of ["origin/master", "origin/main", "main", "master"]) {
    try {
      await refreshRemoteTrackingBaseRef(repoRoot, candidate, resolveGitAuth);
      await runGit(["rev-parse", "--verify", `${candidate}^{commit}`], repoRoot);
      return candidate;
    } catch {
      // Not found — try next
    }
  }

  return null;
}

export function normalizeDefaultBranchForComparison(branch: string | null | undefined): string | null {
  if (!branch) return null;
  return branch.replace(/^origin\//, "");
}

async function detectRemoteDefaultBranch(repoRoot: string): Promise<string | null> {
  try {
    const remoteHead = (await execFileAsync(
      "git",
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      { cwd: repoRoot },
    )).stdout.trim();
    if (remoteHead) {
      const stripped = remoteHead.startsWith("origin/") ? remoteHead.slice("origin/".length) : remoteHead;
      if (stripped.length > 0) return stripped;
    }
  } catch {
    // origin/HEAD not set — fall through to heuristic
  }

  for (const candidate of ["origin/master", "origin/main"]) {
    try {
      await execFileAsync("git", ["rev-parse", "--verify", `${candidate}^{commit}`], { cwd: repoRoot });
      return candidate.slice("origin/".length);
    } catch {
      // Not found — try next
    }
  }

  return null;
}

async function directoryExists(value: string) {
  return fs.stat(value).then((stats) => stats.isDirectory()).catch(() => false);
}

async function resolvePathForWorktreeComparison(value: string): Promise<string> {
  const resolved = path.resolve(value);
  return fs.realpath(resolved).then((realPath) => path.resolve(realPath)).catch(() => resolved);
}

async function listLinkedGitWorktreePaths(repoRoot: string): Promise<Set<string>> {
  const output = await runGit(["worktree", "list", "--porcelain"], repoRoot);
  const paths = new Set<string>();
  for (const line of output.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const worktree = line.slice("worktree ".length).trim();
    if (!worktree) continue;
    paths.add(await resolvePathForWorktreeComparison(worktree));
  }
  return paths;
}

export async function inspectManagedGitWorktreeBranch(input: {
  worktreePath: string;
  expectedBranchName: string | null | undefined;
  repoRoot?: string | null;
}): Promise<ManagedGitWorktreeBranchInspection> {
  const worktreePath = await resolvePathForWorktreeComparison(input.worktreePath);
  const expectedBranchName = asString(input.expectedBranchName, "").trim() || null;
  const base = {
    worktreePath,
    expectedBranchName,
    actualBranchName: null,
  };

  if (!await directoryExists(worktreePath)) {
    return {
      ...base,
      valid: false,
      reason: `worktree path "${worktreePath}" does not exist`,
      reasonCode: "missing_worktree",
      repoRoot: input.repoRoot ? path.resolve(input.repoRoot) : null,
    };
  }

  const repoRoot = input.repoRoot
    ? path.resolve(input.repoRoot)
    : await resolveGitOwnerRepoRoot(worktreePath).catch(() => null);
  if (!repoRoot) {
    return {
      ...base,
      valid: false,
      reason: "path is not a git checkout",
      reasonCode: "not_a_git_checkout",
      repoRoot: null,
    };
  }

  const listedWorktrees = await listLinkedGitWorktreePaths(repoRoot).catch(() => null);
  if (!listedWorktrees?.has(worktreePath)) {
    return {
      ...base,
      valid: false,
      reason: "path is not registered in `git worktree list`",
      reasonCode: "not_registered",
      repoRoot,
    };
  }

  const worktreeTopLevel = await runGit(["rev-parse", "--show-toplevel"], worktreePath).catch(() => null);
  if (!worktreeTopLevel || path.resolve(worktreeTopLevel) !== worktreePath) {
    return {
      ...base,
      valid: false,
      reason: "git resolves this path to a different repository root",
      reasonCode: "wrong_repository_root",
      repoRoot,
    };
  }

  const actualBranchName = await runGit(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    worktreePath,
  ).catch(() => null);
  if (expectedBranchName && actualBranchName !== expectedBranchName) {
    return {
      ...base,
      valid: false,
      reason: `worktree HEAD is on "${actualBranchName ?? "<detached>"}" instead of "${expectedBranchName}"`,
      reasonCode: "branch_mismatch",
      repoRoot,
      actualBranchName,
    };
  }

  return {
    ...base,
    valid: true,
    reason: null,
    reasonCode: null,
    repoRoot,
    actualBranchName,
  };
}

async function validateLinkedGitWorktree(input: {
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string | null;
}): Promise<
  | { valid: true }
  | {
    valid: false;
    reason: string;
    reasonCode: Exclude<ManagedGitWorktreeBranchInspection["reasonCode"], null>;
    actualBranchName?: string | null;
  }
> {
  const inspection = await inspectManagedGitWorktreeBranch({
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName: input.expectedBranchName,
  });
  if (!inspection.valid) {
    return {
      valid: false,
      reason: inspection.reason ?? "unknown git worktree mismatch",
      reasonCode: inspection.reasonCode ?? "not_a_git_checkout",
      actualBranchName: inspection.actualBranchName,
    };
  }
  await assertGitIndexIntegrity(input.worktreePath);
  await assertGitHeadResolvable(input.worktreePath);
  return { valid: true };
}

export function formatManagedGitWorktreeBranchInspection(input: ManagedGitWorktreeBranchInspection) {
  return {
    valid: input.valid,
    reason: input.reason,
    reasonCode: input.reasonCode,
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName: input.expectedBranchName,
    actualBranchName: input.actualBranchName,
  };
}

function terminateChildProcess(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall through to the direct child kill.
    }
  }
  if (!child.killed) {
    child.kill("SIGTERM");
  }
}

function buildWorkspaceCommandEnv(input: {
  base: ExecutionWorkspaceInput;
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  created: boolean;
}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PAPERCLIP_WORKSPACE_CWD = input.worktreePath;
  env.PAPERCLIP_WORKSPACE_PATH = input.worktreePath;
  env.PAPERCLIP_WORKSPACE_WORKTREE_PATH = input.worktreePath;
  env.PAPERCLIP_WORKSPACE_BRANCH = input.branchName;
  env.PAPERCLIP_WORKSPACE_BASE_CWD = input.base.baseCwd;
  env.PAPERCLIP_WORKSPACE_REPO_ROOT = input.repoRoot;
  env.PAPERCLIP_WORKSPACE_SOURCE = input.base.source;
  env.PAPERCLIP_WORKSPACE_REPO_REF = input.base.repoRef ?? "";
  env.PAPERCLIP_WORKSPACE_REPO_URL = input.base.repoUrl ?? "";
  env.PAPERCLIP_WORKSPACE_CREATED = input.created ? "true" : "false";
  env.PAPERCLIP_PROJECT_ID = input.base.projectId ?? "";
  env.PAPERCLIP_PROJECT_WORKSPACE_ID = input.base.workspaceId ?? "";
  env.PAPERCLIP_AGENT_ID = input.agent.id ?? "";
  env.PAPERCLIP_AGENT_NAME = input.agent.name;
  env.PAPERCLIP_COMPANY_ID = input.agent.companyId;
  env.PAPERCLIP_ISSUE_ID = input.issue?.id ?? "";
  env.PAPERCLIP_ISSUE_IDENTIFIER = input.issue?.identifier ?? "";
  env.PAPERCLIP_ISSUE_TITLE = input.issue?.title ?? "";
  env.PAPERCLIP_ISSUE_WORK_MODE = input.issue?.workMode ?? "";
  return env;
}

function quoteShellArg(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveRepoManagedWorkspaceCommand(command: string, repoRoot: string) {
  const patterns = [
    /^(?<prefix>(?:bash|sh|zsh)\s+)(?<quote>["']?)(?<relative>\.\/[^"'\s]+)\k<quote>(?<suffix>(?:\s.*)?)$/s,
    /^(?<quote>["']?)(?<relative>\.\/[^"'\s]+)\k<quote>(?<suffix>(?:\s.*)?)$/s,
  ];

  for (const pattern of patterns) {
    const match = command.match(pattern);
    if (!match?.groups) continue;

    const relativePath = match.groups.relative;
    const repoManagedPath = path.join(repoRoot, relativePath.slice(2));
    if (!existsSync(repoManagedPath)) continue;

    const prefix = match.groups.prefix ?? "";
    const suffix = match.groups.suffix ?? "";
    return `${prefix}${quoteShellArg(repoManagedPath)}${suffix}`;
  }

  return command;
}

async function runWorkspaceCommand(input: {
  command: string;
  resolvedCommand?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const shell = resolveShell();
  const proc = await executeProcess({
    command: shell,
    args: ["-c", input.resolvedCommand ?? input.command],
    cwd: input.cwd,
    env: input.env,
  });
  if (proc.stdout && input.onLog) await input.onLog("stdout", `[runtime-provision] ${proc.stdout}`);
  if (proc.stderr && input.onLog) await input.onLog("stderr", `[runtime-provision] ${proc.stderr}`);
  if (proc.code === 0) return;

  const details = [proc.stderr.trim(), proc.stdout.trim()].filter(Boolean).join("\n");
  throw new Error(
    details.length > 0
      ? `${input.label} failed: ${details}`
      : `${input.label} failed with exit code ${proc.code ?? -1}`,
  );
}

async function recordGitOperation(
  recorder: WorkspaceOperationRecorder | null | undefined,
  input: {
    phase: WorkspaceOperationPhase;
    args: string[];
    cwd: string;
    metadata?: Record<string, unknown> | null;
    successMessage?: string | null;
    failureLabel?: string | null;
  },
): Promise<string> {
  if (!recorder) {
    return runGit(input.args, input.cwd);
  }

  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  await recorder.recordOperation({
    phase: input.phase,
    command: formatCommandForDisplay("git", input.args),
    cwd: input.cwd,
    metadata: input.metadata ?? null,
    run: async () => {
      const result = await executeProcess({
        command: "git",
        args: input.args,
        cwd: input.cwd,
      });
      stdout = result.stdout;
      stderr = result.stderr;
      code = result.code;
      return {
        status: result.code === 0 ? "succeeded" : "failed",
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        system: result.code === 0 ? input.successMessage ?? null : null,
        metadata:
          result.stdoutTruncated || result.stderrTruncated
            ? {
                stdoutTruncated: result.stdoutTruncated,
                stderrTruncated: result.stderrTruncated,
                stdoutBytes: result.stdoutBytes,
                stderrBytes: result.stderrBytes,
              }
            : null,
      };
    },
  });

  if (code !== 0) {
    const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
    throw new Error(
      details.length > 0
        ? `${input.failureLabel ?? `git ${input.args.join(" ")}`} failed: ${details}`
        : `${input.failureLabel ?? `git ${input.args.join(" ")}`} failed with exit code ${code ?? -1}`,
    );
  }
  return stdout.trim();
}

async function recordWorkspaceCommandOperation(
  recorder: WorkspaceOperationRecorder | null | undefined,
  input: {
    phase: "workspace_provision" | "workspace_runtime_provision" | "workspace_teardown";
    command: string;
    resolvedCommand?: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    label: string;
    metadata?: Record<string, unknown> | null;
    successMessage?: string | null;
    onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  },
) {
  if (!recorder) {
    await runWorkspaceCommand(input);
    return null;
  }

  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  const operation = await recorder.recordOperation({
    phase: input.phase,
    command: input.command,
    cwd: input.cwd,
    metadata: input.metadata ?? null,
    run: async () => {
      const shell = resolveShell();
      const result = await executeProcess({
        command: shell,
        args: ["-c", input.resolvedCommand ?? input.command],
        cwd: input.cwd,
        env: input.env,
      });
      stdout = result.stdout;
      stderr = result.stderr;
      code = result.code;
      if (result.stdout && input.onLog) await input.onLog("stdout", `[runtime-provision] ${result.stdout}`);
      if (result.stderr && input.onLog) await input.onLog("stderr", `[runtime-provision] ${result.stderr}`);
      return {
        status: result.code === 0 ? "succeeded" : "failed",
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        system: result.code === 0 ? input.successMessage ?? null : null,
        metadata:
          result.stdoutTruncated || result.stderrTruncated
            ? {
                stdoutTruncated: result.stdoutTruncated,
                stderrTruncated: result.stderrTruncated,
                stdoutBytes: result.stdoutBytes,
                stderrBytes: result.stderrBytes,
              }
            : null,
      };
    },
  });

  if (code === 0) return operation;

  const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  throw new Error(
    details.length > 0
      ? `${input.label} failed: ${details}`
      : `${input.label} failed with exit code ${code ?? -1}`,
  );
}

export async function assertWorktreeWritableByProcessUser(worktreePath: string): Promise<void> {
  await assertGitIndexIntegrity(worktreePath);
  let trackedPaths: string[];
  try {
    const proc = await executeProcess({
      command: "git",
      args: ["-C", worktreePath, "ls-files", "-z"],
      cwd: worktreePath,
    });
    if (proc.code !== 0) {
      throw new Error(proc.stderr.trim() || proc.stdout.trim() || `git ls-files failed in ${worktreePath}`);
    }
    trackedPaths = proc.stdout.split("\0").filter((p) => p.length > 0);
  } catch (error) {
    throw new Error(
      `Execution worktree at ${worktreePath} is not a valid git repository or is missing: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const uid = process.getuid != null ? process.getuid() : null;
  const gid = process.getgid != null ? process.getgid() : null;
  const failures: string[] = [];
  let totalFailures = 0;
  const MAX_FAILURES = 10;

  if (await fs.access(worktreePath, fs.constants.W_OK).then(() => true, () => false)) {
    // writable
  } else {
    failures.push(worktreePath);
    totalFailures++;
  }

  for (const relPath of trackedPaths) {
    const fullPath = path.join(worktreePath, relPath);
    const writable = await fs.access(fullPath, fs.constants.W_OK).then(
      () => true,
      (err: NodeJS.ErrnoException) =>
        // A tracked file that is absent is an uncommitted deletion — ordinary
        // work in progress — and says nothing about whether we can write here.
        // Treating ENOENT as a permission failure blocked provisioning for any
        // issue whose agent had deleted a file, and told the operator to run a
        // `chown` that could not have fixed it. Only real permission failures
        // count; everything else this check exists for still reports.
        err?.code === "ENOENT",
    );
    if (!writable) {
      totalFailures++;
      if (failures.length < MAX_FAILURES) {
        failures.push(fullPath);
      }
    }
  }

  if (totalFailures > 0) {
    const uidPart = uid != null ? `uid ${uid}` : "current user";
    const gidPart = gid != null ? `:${gid}` : "";
    throw new Error(
      `Execution worktree at ${worktreePath} contains ${totalFailures} files not writable by the server user (${uidPart}${gidPart}) (showing first ${failures.length}): ${failures.join(", ")}. A host-side process likely wrote them as another user (e.g. root). Repair on the host with: chown -R ${uid != null ? uid : ""}${gidPart} ${worktreePath} — then retry provisioning.`,
    );
  }
}

import { ensureSharedGroupOwnership, ensureSharedGroupTraversalPath } from "./shared-group-ownership.js";

/**
 * SUP-13090: pnpm refuses a frozen install when the committed lockfile disagrees
 * with the branch's manifests, under two codes — ERR_PNPM_OUTDATED_LOCKFILE (a
 * changed dependency version) and ERR_PNPM_LOCKFILE_CONFIG_MISMATCH (a changed
 * pnpm setting inside package.json: overrides, patchedDependencies,
 * packageExtensions).
 *
 * SUP-12984 taught `scripts/provision-worktree.sh` to retry without
 * `--frozen-lockfile`, but a project can configure any `provisionCommand`, and
 * this project's execution workspaces carry the inline
 * `corepack enable && pnpm install --frozen-lockfile --prefer-offline`. That
 * command never reaches the script, so it had no retry: SUP-12986 and SUP-12996
 * failed EVERY dispatch in ~8s with `workspace_validation_failed`, agent- and
 * adapter-independent, because their reused worktrees carry an `overrides` change
 * whose lockfile has not been regenerated.
 *
 * The retry belongs here, at the layer that executes whatever provisionCommand a
 * project configured, so both the fresh-provision and the reuse path are covered.
 * Returns the command to retry with, or null when this failure is not a lockfile
 * mismatch (registry 404, EACCES, missing peer) — those must still fail the
 * dispatch rather than be silently re-run.
 */
const PNPM_LOCKFILE_MISMATCH_ERROR_CODES = [
  "ERR_PNPM_OUTDATED_LOCKFILE",
  "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH",
] as const;

export function resolvePnpmLockfileMismatchRetryCommand(
  command: string,
  failureOutput: string,
): string | null {
  if (!PNPM_LOCKFILE_MISMATCH_ERROR_CODES.some((code) => failureOutput.includes(code))) return null;
  // Leave `--frozen-lockfile=false` and an existing `--no-frozen-lockfile` alone:
  // neither can produce this error, and rewriting them would be a no-op retry loop.
  const retryCommand = command.replace(/--frozen-lockfile(?![=\w-])/g, "--no-frozen-lockfile");
  return retryCommand === command ? null : retryCommand;
}

async function provisionExecutionWorktree(input: {
  strategy: Record<string, unknown>;
  base: ExecutionWorkspaceInput;
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  created: boolean;
  recorder?: WorkspaceOperationRecorder | null;
}) {
  await assertWorktreeWritableByProcessUser(input.worktreePath);
  const provisionCommand = asString(input.strategy.provisionCommand, "").trim();
  if (!provisionCommand) return;

  const env = buildWorkspaceCommandEnv({
    base: input.base,
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    branchName: input.branchName,
    issue: input.issue,
    agent: input.agent,
    created: input.created,
  });
  const runProvisionCommand = async (command: string, lockfileMismatchRetry: boolean) => {
    const resolvedCommand = resolveRepoManagedWorkspaceCommand(command, input.repoRoot);
    await recordWorkspaceCommandOperation(input.recorder, {
      phase: "workspace_provision",
      command,
      resolvedCommand,
      cwd: input.worktreePath,
      env,
      label: `Execution workspace provision command "${command}"`,
      metadata: {
        repoRoot: input.repoRoot,
        worktreePath: input.worktreePath,
        branchName: input.branchName,
        created: input.created,
        resolvedCommand: resolvedCommand === command ? null : resolvedCommand,
        ...(lockfileMismatchRetry ? { lockfileMismatchRetry: true, originalCommand: provisionCommand } : {}),
      },
      successMessage: `Provisioned workspace at ${input.worktreePath}\n`,
    });
  };

  try {
    await runProvisionCommand(provisionCommand, false);
  } catch (error) {
    const failureOutput = error instanceof Error ? error.message : String(error);
    const retryCommand = resolvePnpmLockfileMismatchRetryCommand(provisionCommand, failureOutput);
    if (!retryCommand) throw error;
    await runProvisionCommand(retryCommand, true);
  }
}

export type BaseRepoHygieneDecision =
  | { action: "ok" }
  | { action: "fastForward" }
  | { action: "restore"; reasons: string[]; snapshotTrackedChanges: boolean }
  | { action: "diverged"; aheadCount: number; behindCount: number; aheadCommitSubjects: string[] }
  | { action: "indeterminate"; graftCommits: string[] };

/**
 * SUP-11285: should the base repo be put back before we cut a worktree from it?
 *
 * The primary clone is nobody's workspace, but it is an ancestor directory of
 * every agent worktree (`<repoRoot>/.paperclip/worktrees/<branch>`), its path is
 * handed out as PAPERCLIP_WORKSPACE_BASE_CWD, and it is the only checkout holding
 * the default branch — so any main-branch errand an agent runs has exactly one
 * home. Observed consequences: primaries parked on task branches or detached,
 * commits for a dozen issues landing in one shared checkout, a TypeScript source
 * file left carrying conflict markers for over a day, and orphaned commits
 * reachable from no ref at all.
 *
 * Restoring is hygiene, not a gate. It never blocks the dispatch: refusing to run
 * because the base repo is untidy would dead-block issues over a condition the
 * issue did not cause, which is the SUP-11207 mistake.
 */
export function resolveBaseRepoHygieneDecision(input: {
  /** Branch the base repo has checked out; null when detached. */
  currentBranch: string | null;
  /** The ref the base repo is expected to sit on, e.g. "main". */
  defaultRef: string | null;
  /** Tracked paths with modifications. Untracked paths are deliberately excluded. */
  dirtyTrackedPathCount: number;
  /** Unmerged index entries — a half-finished merge nobody is going to finish. */
  unmergedPathCount: number;
  /** Resolved SHA of the base repo's HEAD, or null when unresolvable. */
  headSha: string | null;
  /** Resolved SHA of the base ref, or null when unresolvable. */
  baseRefSha: string | null;
  /**
   * True when the base repo's HEAD is a strict ancestor of the base ref (i.e.
   * behind / fast-forwardable). Only consulted when there are no restore
   * reasons, so dirty/unmerged/wrong-branch repos still return `restore`.
   */
  headBehindBaseRef?: boolean;
  /**
   * Number of commits the base repo's HEAD is ahead of the base ref.
   * Best-effort; may be undefined when unavailable.
   */
  aheadCount?: number;
  /**
   * Number of commits the base repo's HEAD is behind the base ref.
   * Best-effort; may be undefined when unavailable.
   */
  behindCount?: number;
  /**
   * Subject lines of commits the base repo's HEAD is ahead of the base ref.
   * Best-effort; may be undefined when unavailable.
   */
  aheadCommitSubjects?: string[];
  /**
   * SUP-13857: false when ancestry between HEAD and the base ref cannot be
   * computed — a shallow clone whose graft severs the history, or two roots
   * with no merge base at all.
   *
   * This exists because `git rev-list --left-right --count A...B` does NOT fail
   * when there is no merge base: it silently degenerates to counting BOTH WHOLE
   * HISTORIES. Observed on the Trading-Signal-Platform base repo 2026-08-24 —
   * reported 2519 ahead / 137 behind where the truth was 22 ahead / 349 behind.
   * Those numbers then classify the repo `diverged`, and `diverged` by design
   * never resets, so the base repo drifts permanently with no way back.
   *
   * A count nobody can compute must not be published at all. Defaults to true
   * so every existing caller and every non-shallow repo behaves exactly as before.
   */
  divergenceComputable?: boolean;
  /** Graft commits read from `.git/shallow`, for the indeterminate warning. */
  graftCommits?: string[];
}): BaseRepoHygieneDecision {
  const reasons: string[] = [];
  const defaultRef = input.defaultRef?.replace(/^origin\//, "") ?? null;
  const contentMatches = Boolean(input.headSha && input.baseRefSha && input.headSha === input.baseRefSha);
  if (defaultRef && input.currentBranch !== defaultRef) {
    if (input.currentBranch === null) {
      // Detached HEAD is only a problem when the content is not already the base ref.
      if (!contentMatches) {
        reasons.push("base repo is on a detached HEAD");
      }
    } else {
      reasons.push(`base repo is on "${input.currentBranch}" instead of "${defaultRef}"`);
    }
  }
  if (input.unmergedPathCount > 0) {
    reasons.push(`base repo has ${input.unmergedPathCount} unmerged path(s) from an abandoned merge`);
  }
  if (input.dirtyTrackedPathCount > 0) {
    reasons.push(`base repo has ${input.dirtyTrackedPathCount} modified tracked path(s)`);
  }
  if (reasons.length === 0) {
    if (input.headBehindBaseRef) {
      return { action: "fastForward" };
    }
    // SUP-13857: refuse to publish a divergence we cannot compute. Deliberately
    // AFTER the fastForward check: `merge-base --is-ancestor` succeeding proves
    // the ancestry is intact for that pair, so a genuine fast-forward inside the
    // shallow window still resolves normally.
    if (input.divergenceComputable === false) {
      return { action: "indeterminate", graftCommits: input.graftCommits ?? [] };
    }
    if (input.aheadCount && input.aheadCount > 0 && input.behindCount && input.behindCount > 0) {
      return {
        action: "diverged",
        aheadCount: input.aheadCount,
        behindCount: input.behindCount,
        aheadCommitSubjects: input.aheadCommitSubjects ?? [],
      };
    }
    return { action: "ok" };
  }
  return {
    action: "restore",
    reasons,
    snapshotTrackedChanges: input.dirtyTrackedPathCount > 0 || input.unmergedPathCount > 0,
  };
}

/**
 * SUP-13857: how long a base-repo deepen may take, and how far it may reach.
 *
 * Bounded on purpose. The deepen is opportunistic hygiene on a repo the dispatched
 * issue did not break, so it must never become the thing that makes a dispatch slow
 * or stuck. One attempt at each strategy, an explicit wall clock, no retry loop.
 */
const BASE_REPO_DEEPEN_TIMEOUT_MS = 60_000;
const BASE_REPO_DEEPEN_COMMITS = 1000;

/** Run a git command with a hard wall clock. Rejects on timeout; the caller decides. */
async function runGitBounded(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    // Never let the bound itself hold the process open.
    timer.unref?.();
  });
  try {
    return await Promise.race([runGit(args, cwd), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Graft commits recorded in `.git/shallow`, or [] when the repo is not shallow. */
async function readShallowGraftCommits(repoRoot: string): Promise<string[]> {
  // Ask git where the git dir is rather than assuming `<repoRoot>/.git` — it is a
  // FILE, not a directory, in a linked worktree.
  const gitDir = await runGit(["rev-parse", "--git-dir"], repoRoot).catch(() => null);
  if (!gitDir) return [];
  const shallowPath = path.isAbsolute(gitDir)
    ? path.join(gitDir, "shallow")
    : path.join(repoRoot, gitDir, "shallow");
  return await fs
    .readFile(shallowPath, "utf8")
    .then((text) => text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0))
    .catch(() => []);
}

/**
 * SUP-13857: decide ONCE, before any counting, whether ahead/behind is computable.
 *
 * `git rev-list --left-right --count A...B` does not fail without a merge base — it
 * counts both whole histories and returns two large, meaningless integers. Those get
 * classified `diverged`, which never resets, so the base repo is stuck for good. The
 * only safe move is to not produce the numbers.
 *
 * Deepening is attempted first because the honest fix is to restore the ancestry, and
 * it is entirely best-effort: any failure becomes a warning and the dispatch proceeds.
 */
async function resolveBaseRepoShallowState(
  repoRoot: string,
  baseRef: string,
): Promise<{ divergenceComputable: boolean; graftCommits: string[]; warnings: string[]; mergeBase: string | null }> {
  const warnings: string[] = [];
  const describe = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0];
  const isShallow = async () =>
    (await runGit(["rev-parse", "--is-shallow-repository"], repoRoot).catch(() => "false")).trim() === "true";

  let shallow = await isShallow();
  if (shallow) {
    let deepened = false;
    try {
      await runGitBounded(["fetch", "--unshallow"], repoRoot, BASE_REPO_DEEPEN_TIMEOUT_MS);
      deepened = true;
    } catch (unshallowError) {
      // --unshallow fails on a repo that is already complete, and on some servers
      // that refuse it; --deepen is the narrower fallback.
      try {
        await runGitBounded(["fetch", `--deepen=${BASE_REPO_DEEPEN_COMMITS}`], repoRoot, BASE_REPO_DEEPEN_TIMEOUT_MS);
        deepened = true;
      } catch (deepenError) {
        warnings.push(
          `Base repository at ${repoRoot} is a shallow clone and could not be deepened ` +
            `(git fetch --unshallow: ${describe(unshallowError)}; ` +
            `git fetch --deepen=${BASE_REPO_DEEPEN_COMMITS}: ${describe(deepenError)}). ` +
            `Proceeding without ahead/behind counts.`,
        );
      }
    }
    if (deepened) shallow = await isShallow();
  }

  // Still checked when NOT shallow: two unrelated roots have no merge base either,
  // and the same whole-history degeneration applies.
  const mergeBase = await runGit(["merge-base", "HEAD", baseRef], repoRoot)
    .then((value) => value.trim())
    .catch(() => "");
  const divergenceComputable = !shallow && mergeBase.length > 0;
  const graftCommits = divergenceComputable ? [] : await readShallowGraftCommits(repoRoot);
  // SUP-13858 reuses the merge base to bound its patch-id window. Resolving it twice
  // could disagree if a concurrent fetch lands between the two calls.
  return { divergenceComputable, graftCommits, warnings, mergeBase: mergeBase.length > 0 ? mergeBase : null };
}

/**
 * SUP-13858: how far the patch-id comparison may look, on EITHER side.
 *
 * Bounded on purpose, and the bound is the safety property, not a performance
 * tweak. Comparing whole histories is what produced the fabricated counts T1
 * exists to stop; a reset authorised off an unbounded scan would be the same
 * mistake with a destructive ending. Exceeding the window is treated as
 * "cannot prove duplication", which means no reset.
 */
const BASE_REPO_PATCH_ID_WINDOW_COMMITS = 1000;

/** Run git with `input` on stdin. Needed because `git patch-id` reads a diff there. */
async function runGitWithStdin(args: string[], cwd: string, input: string): Promise<string> {
  const proc = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
  if (proc.code !== 0) throw new Error(proc.stderr.trim() || `git ${args.join(" ")} failed`);
  return proc.stdout.trim();
}

/**
 * Stable patch-id for one commit, or null when it cannot be determined.
 *
 * Null is the FAIL-CLOSED answer and every caller must read it as "this commit is
 * unique". A merge commit lands here by design: `git show --format=` prints no diff
 * for one, so there is no single patch-id to compare and a merge must never be
 * counted as a duplicate of anything.
 */
async function resolveCommitPatchId(repoRoot: string, sha: string): Promise<string | null> {
  const diff = await runGit(["show", "--format=", "--no-color", sha], repoRoot).catch(() => null);
  if (!diff) return null;
  const output = await runGitWithStdin(["patch-id", "--stable"], repoRoot, `${diff}\n`).catch(() => null);
  if (!output) return null;
  const id = output.split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{40,}$/.test(id) ? id : null;
}

/**
 * SUP-13858: is EVERY ahead commit already upstream, by patch-id?
 *
 * Only ever used to authorise discarding local commits, so it is written to be wrong
 * in one direction only. Every uncertainty — an unreadable commit, an empty patch-id,
 * a merge, a window overrun, a git failure — returns `false` with a reason. Nothing
 * about "I could not tell" may read as "safe to reset".
 */
async function resolveBaseRepoAheadCommitsAllUpstream(input: {
  repoRoot: string;
  baseRef: string;
  mergeBase: string | null;
}): Promise<{ allUpstream: boolean; aheadCount: number; reason: string | null }> {
  const cap = BASE_REPO_PATCH_ID_WINDOW_COMMITS;
  const revList = async (range: string) =>
    (await runGit(["rev-list", `--max-count=${cap + 1}`, range], input.repoRoot).catch(() => ""))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

  const aheadShas = await revList(`${input.baseRef}..HEAD`);
  if (aheadShas.length === 0) return { allUpstream: false, aheadCount: 0, reason: "no ahead commits to compare" };
  if (aheadShas.length > cap) {
    return { allUpstream: false, aheadCount: aheadShas.length, reason: `more than ${cap} ahead commits` };
  }

  // The upstream side is bounded by the merge base. Without one there is no honest
  // window at all, and T1 has already classified that case as indeterminate anyway.
  if (!input.mergeBase) {
    return { allUpstream: false, aheadCount: aheadShas.length, reason: "no merge base — no bounded upstream window" };
  }
  const upstreamShas = await revList(`${input.mergeBase}..${input.baseRef}`);
  if (upstreamShas.length > cap) {
    return { allUpstream: false, aheadCount: aheadShas.length, reason: `upstream window exceeds ${cap} commits` };
  }

  const upstreamPatchIds = new Set<string>();
  for (const sha of upstreamShas) {
    const id = await resolveCommitPatchId(input.repoRoot, sha);
    // An indeterminate UPSTREAM commit only shrinks the duplicate set, so it can be
    // skipped: it can cause a false "unique", never a false "duplicate".
    if (id) upstreamPatchIds.add(id);
  }

  for (const sha of aheadShas) {
    const id = await resolveCommitPatchId(input.repoRoot, sha);
    if (!id) {
      return {
        allUpstream: false,
        aheadCount: aheadShas.length,
        reason: `indeterminate patch-id for ${sha.slice(0, 12)} (merge commit or unreadable diff)`,
      };
    }
    if (!upstreamPatchIds.has(id)) {
      return { allUpstream: false, aheadCount: aheadShas.length, reason: `${sha.slice(0, 12)} is not upstream` };
    }
  }
  return { allUpstream: true, aheadCount: aheadShas.length, reason: null };
}

/**
 * SUP-13858: pin the current tip on a rescue ref, THEN reset to the base ref.
 *
 * Order is the whole contract. The rescue ref is created and independently re-read
 * before anything moves, so a reset can never be the step that makes commits
 * unreachable. If the pin cannot be proven, nothing moves at all — the diverged
 * repo is an inconvenience, an unreachable commit is data loss.
 */
async function resetBaseRepoToBaseRefWithRescue(input: {
  repoRoot: string;
  baseRef: string;
  baseRefSha: string;
  priorTip: string;
  aheadCount: number;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<{ reset: boolean; rescueRef: string | null; warnings: string[] }> {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const rescueRef = `refs/paperclip/rescue/base-repo/${stamp}/head`;

  try {
    await runGit(["update-ref", rescueRef, input.priorTip], input.repoRoot);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return {
      reset: false,
      rescueRef: null,
      warnings: [
        `Base repository at ${input.repoRoot} has ${input.aheadCount} ahead commit(s) already upstream, ` +
          `but the rescue ref could not be created (${detail}). NOT reset — local commits preserved.`,
      ],
    };
  }

  // Read it back rather than trusting update-ref's exit code: this is the only
  // guarantee that the commits survive the reset.
  const pinned = await runGit(["rev-parse", "--verify", `${rescueRef}^{commit}`], input.repoRoot).catch(() => null);
  if (pinned !== input.priorTip) {
    return {
      reset: false,
      rescueRef: null,
      warnings: [
        `Base repository at ${input.repoRoot} has ${input.aheadCount} ahead commit(s) already upstream, ` +
          `but the rescue ref ${rescueRef} did not resolve to the prior tip ${input.priorTip.slice(0, 12)} ` +
          `(got ${pinned ? pinned.slice(0, 12) : "nothing"}). NOT reset — local commits preserved.`,
      ],
    };
  }

  try {
    await runGit(["reset", "--hard", input.baseRefSha], input.repoRoot);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return {
      reset: false,
      rescueRef,
      warnings: [
        `Base repository at ${input.repoRoot} could not be reset to ${input.baseRef} (${detail}). ` +
          `The prior tip is pinned at ${rescueRef}; no commits were lost.`,
      ],
    };
  }

  return {
    reset: true,
    rescueRef,
    warnings: [
      `Base repository at ${input.repoRoot} was reset to ${input.baseRef}: all ${input.aheadCount} ahead ` +
        `commit(s) were already upstream (same patch-id), so none represented unshipped work. ` +
        `Prior tip ${input.priorTip.slice(0, 12)} is preserved at ${rescueRef}.`,
    ],
  };
}

async function inspectBaseRepoHygiene(repoRoot: string) {
  const currentBranch = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], repoRoot)
    .then((value) => value || null)
    .catch(() => null);
  // Porcelain v1: untracked entries start with "??" and are deliberately ignored.
  // The worktrees themselves live at <repoRoot>/.paperclip/worktrees, and that path
  // is untracked in at least one repo on this fleet — anything that removes
  // untracked files from the base repo would delete every agent's worktree.
  const status = await runGit(["status", "--porcelain"], repoRoot).catch(() => null);
  if (status === null) return null;
  const lines = status.split("\n").filter((line) => line.trim().length > 0);
  const unmergedPathCount = lines.filter((line) => {
    const code = line.slice(0, 2);
    return code === "UU" || code === "AA" || code === "DD" ||
      code.startsWith("U") || code.endsWith("U");
  }).length;
  const dirtyTrackedPathCount = lines.filter((line) => !line.startsWith("??")).length - unmergedPathCount;
  return {
    currentBranch,
    dirtyTrackedPathCount: Math.max(0, dirtyTrackedPathCount),
    unmergedPathCount,
  };
}

/**
 * Put the base repo back on its default ref, preserving anything found there.
 *
 * Order matters and is chosen so every step is recoverable from a ref if the next
 * one fails: pin HEAD first (a commit made on a detached HEAD is reachable from
 * nothing the moment we move), then snapshot tracked modifications, only then
 * move the working tree.
 *
 * Never removes untracked files that the base ref does not itself contain. Never uses `git clean` or `stash -u`: the
 * worktree directory lives inside the base repo and is untracked in some repos,
 * so removing untracked content there would delete live agent workspaces.
 */
async function restoreBaseRepoToDefaultRef(input: {
  repoRoot: string;
  baseRef: string;
  decision: Extract<BaseRepoHygieneDecision, { action: "restore" }>;
  timestamp: string;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<{ restored: boolean; warnings: string[]; rescueRefs: string[] }> {
  const warnings: string[] = [];
  const rescueRefs: string[] = [];
  const shortDefault = input.baseRef.replace(/^origin\//, "");
  const prefix = `refs/heads/paperclip/rescue/base-repo/${input.timestamp}-${randomUUID().slice(0, 8)}`;

  const headSha = await runGit(["rev-parse", "HEAD"], input.repoRoot).catch(() => null);
  if (headSha) {
    await runGit(["update-ref", `${prefix}/head`, headSha], input.repoRoot)
      .then(() => rescueRefs.push(`${prefix}/head`))
      .catch((err) => warnings.push(`could not pin base repo HEAD: ${err instanceof Error ? err.message : String(err)}`));
  }

  if (input.decision.snapshotTrackedChanges) {
    // `stash create` builds the commit objects without touching the working tree
    // or index, so a failure here leaves the repo exactly as it was found.
    const stashSha = await runGit(["stash", "create", `paperclip base repo rescue ${input.timestamp}`], input.repoRoot)
      .then((value) => value || null)
      .catch((err) => {
        warnings.push(`base repo stash create failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
    if (stashSha) {
      await runGit(["update-ref", `${prefix}/worktree`, stashSha], input.repoRoot)
        .then(() => rescueRefs.push(`${prefix}/worktree`))
        .catch((err) => warnings.push(`could not pin base repo stashed worktree: ${err instanceof Error ? err.message : String(err)}`));
    } else {
      // An unmerged index defeats `stash create`. Fall back to recording the
      // conflicted blobs so nothing is discarded unseen.
      const unmerged = await runGit(["ls-files", "-u"], input.repoRoot).catch(() => "");
      if (unmerged.trim().length > 0) {
        warnings.push(
          "base repo had unmerged index entries that could not be stashed; their blobs remain in the object store and are listed in this operation's metadata",
        );
      }
    }
  }

  if (input.decision.snapshotTrackedChanges && !rescueRefs.some((ref) => ref.endsWith("/worktree"))) {
    warnings.push("base repo has tracked modifications that could not be snapshotted; skipping restore to avoid data loss");
    return { restored: false, warnings, rescueRefs };
  }

  const checkout = await runGit(["checkout", "--force", shortDefault], input.repoRoot)
    .then(() => true)
    .catch(() => false);
  let restored = checkout;
  if (!checkout) {
    // The default branch can be held by an agent worktree, which is its own bug
    // but must not stop us tidying the base repo. Detaching lands the same content
    // without contending for the branch — and without creating a second checkout
    // of it, which is the very thing that corrupts shared branches.
    restored = await runGit(["checkout", "--force", "--detach", input.baseRef], input.repoRoot)
      .then(() => true)
      .catch((err) => {
        warnings.push(`could not restore base repo to ${input.baseRef}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      });
    if (restored) {
      warnings.push(
        `base repo was detached at ${input.baseRef} because branch "${shortDefault}" is checked out elsewhere`,
      );
    }
  }

  if (input.recorder) {
    await input.recorder.recordOperation({
      phase: "worktree_prepare",
      command: `git checkout --force ${shortDefault}`,
      cwd: input.repoRoot,
      metadata: {
        baseRepoHygiene: true,
        repoRoot: input.repoRoot,
        baseRef: input.baseRef,
        reasons: input.decision.reasons,
        rescueRefs,
        restored,
      },
      run: async () => ({
        status: restored ? "succeeded" : "failed",
        system: [...input.decision.reasons, ...warnings].join("\n"),
      }),
    }).catch(() => undefined);
  }

  return { restored, warnings, rescueRefs };
}

/**
 * Untracked base-repo paths that the base ref itself contains.
 *
 * These, and only these, are what git refuses to overwrite:
 *
 *   error: The following untracked working tree files would be overwritten by merge:
 *
 * Derived from git state rather than parsed out of that message, so wording,
 * locale, and truncation cannot change the answer. `--exclude-standard` keeps
 * ignored paths out, and the base ref is queried with the untracked paths as a
 * pathspec, so this stays one `ls-tree` regardless of repo size.
 */
async function resolveBaseRepoUntrackedCollisions(input: {
  repoRoot: string;
  baseRef: string;
}): Promise<string[]> {
  const untracked = await runGit(["ls-files", "--others", "--exclude-standard"], input.repoRoot)
    .then((value) => value.split("\n").map((line) => line.trim()).filter(Boolean))
    .catch(() => [] as string[]);
  const candidates = untracked.filter(isQuarantinableBaseRepoPath).slice(0, BASE_REPO_QUARANTINE_MAX_PATHS);
  if (candidates.length === 0) return [];

  const inBaseRef = await runGit(
    ["ls-tree", "-r", "--name-only", "-z", input.baseRef, "--", ...candidates],
    input.repoRoot,
  )
    .then((value) => new Set(value.split("\0").map((line) => line.trim()).filter(Boolean)))
    .catch(() => new Set<string>());

  return candidates.filter((candidate) => inBaseRef.has(candidate));
}

/** Hard limit on how many paths one quarantine may move. */
const BASE_REPO_QUARANTINE_MAX_PATHS = 200;
/** How many quarantine directories to keep before pruning the oldest. */
const BASE_REPO_QUARANTINE_KEEP = 20;

/**
 * Whether an untracked path may be moved out of the way at all.
 *
 * The agent worktrees live at `<repoRoot>/.paperclip/worktrees`, and that whole
 * directory is untracked in at least one repo on this fleet. Nothing under
 * `.paperclip/` is ever eligible, whatever the base ref claims to contain —
 * moving a live workspace to unwedge a fast-forward would trade a noisy failure
 * for a silent one.
 */
export function isQuarantinableBaseRepoPath(relativePath: string): boolean {
  if (!relativePath || path.isAbsolute(relativePath)) return false;
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  if (segments[0] === ".paperclip" || segments[0] === ".git") return false;
  return true;
}

/**
 * Move untracked base-repo files that block a fast-forward out of the way.
 *
 * The motivating incident: the Trading-Signal-Platform base repo sat on main,
 * tracked-clean and 22 commits behind, holding untracked files an agent errand
 * had left in it. Two of those paths later landed upstream, so every subsequent
 * `git merge --ff-only origin/main` aborted — 1,035 recorded worktree_prepare
 * failures over seven days, and a base repo that could never advance again,
 * because untracked paths are (correctly) excluded from the hygiene decision and
 * nothing else ever cleared them.
 *
 * Surgical by construction: only paths git state proves are both untracked and
 * present in the base ref, never a `git clean`, and the files are moved rather
 * than deleted so the content survives inspection. The destination is inside the
 * git directory, not the working tree, so a quarantine can never itself become
 * the untracked file that blocks the next merge.
 */
async function quarantineBaseRepoUntrackedCollisions(input: {
  repoRoot: string;
  baseRef: string;
  timestamp: string;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<{ quarantined: string[]; destination: string | null; warnings: string[] }> {
  const warnings: string[] = [];
  const collisions = await resolveBaseRepoUntrackedCollisions(input);
  if (collisions.length === 0) return { quarantined: [], destination: null, warnings };

  const gitDir = await runGit(["rev-parse", "--git-common-dir"], input.repoRoot)
    .then((value) => path.resolve(input.repoRoot, value))
    .catch(() => null);
  if (!gitDir) {
    warnings.push("could not resolve the base repo git directory; leaving untracked collisions in place");
    return { quarantined: [], destination: null, warnings };
  }

  const destination = path.join(gitDir, "paperclip-base-repo-quarantine", input.timestamp);
  const quarantined: string[] = [];
  for (const relativePath of collisions) {
    const from = path.join(input.repoRoot, relativePath);
    const to = path.join(destination, relativePath);
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to).catch(async (error) => {
        // Cross-device or a permission shape rename cannot handle: copy, then unlink.
        // Only an unlink that succeeds counts, because a file still on disk still blocks.
        if ((error as NodeJS.ErrnoException)?.code !== "EXDEV") throw error;
        await fs.cp(from, to, { recursive: true });
        await fs.rm(from, { recursive: true, force: false });
      });
      quarantined.push(relativePath);
    } catch (error) {
      warnings.push(
        `could not quarantine untracked base repo path "${relativePath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (quarantined.length > 0) {
    await pruneBaseRepoQuarantine(path.dirname(destination));
  }

  if (input.recorder && quarantined.length > 0) {
    await input.recorder.recordOperation({
      phase: "worktree_prepare",
      command: `quarantine ${quarantined.length} untracked base repo path(s)`,
      cwd: input.repoRoot,
      metadata: {
        baseRepoHygiene: true,
        baseRepoUntrackedQuarantine: true,
        repoRoot: input.repoRoot,
        baseRef: input.baseRef,
        quarantined,
        destination,
      },
      run: async () => ({
        status: "succeeded",
        system: `Moved ${quarantined.length} untracked path(s) that ${input.baseRef} also contains to ${destination}:\n${quarantined.join("\n")}`,
      }),
    }).catch(() => undefined);
  }

  return { quarantined, destination, warnings };
}

/** Keep the quarantine bounded — it is an audit trail, not a second repository. */
async function pruneBaseRepoQuarantine(quarantineRoot: string): Promise<void> {
  const entries = await fs.readdir(quarantineRoot).catch(() => [] as string[]);
  const stale = entries.sort().slice(0, Math.max(0, entries.length - BASE_REPO_QUARANTINE_KEEP));
  for (const entry of stale) {
    await fs.rm(path.join(quarantineRoot, entry), { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Fast-forward a clean base repo to its default ref.
 *
 * Uses `git merge --ff-only`, which advances HEAD only when it is a strict
 * ancestor of the target — i.e. exactly the "behind" predicate. It refuses
 * (non-zero exit) when HEAD is ahead, diverged, or when an untracked file would
 * be overwritten, which is the desired safety behavior: a refused fast-forward
 * only warns and never blocks the dispatch (same SUP-11285 contract as restore).
 *
 * Safe, however, is not the same as self-clearing. The untracked-file refusal is
 * the one refusal that never resolves on its own: the file stays, the base ref
 * keeps containing it, and the identical abort repeats on every dispatch for as
 * long as anyone leaves it there. So that case — and only that case — is cleared
 * first, by `quarantineBaseRepoUntrackedCollisions`. It is asked before the merge
 * rather than after a refusal: reaching here means HEAD is behind, so an untracked
 * path the base ref also contains is not a risk of a refusal, it is the refusal
 * already decided, and the doomed attempt is worth neither running nor recording.
 * Ahead and diverged still just warn; they mean commits, and commits are
 * somebody's work.
 *
 * No rescue ref / snapshot is needed — a fast-forward is non-destructive (old
 * HEAD remains an ancestor of the new tip). Never uses `git reset --hard`,
 * `checkout -f`, `clean`, or `stash -u`: those could overwrite or remove
 * untracked files wholesale, including the `.paperclip/worktrees` directory.
 */
async function fastForwardBaseRepoToDefaultRef(input: {
  repoRoot: string;
  baseRef: string;
  timestamp: string;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<{ fastForwarded: boolean; quarantined: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const merge = (quarantined: string[], untracked: string[]) =>
    recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["merge", "--ff-only", input.baseRef],
      cwd: input.repoRoot,
      metadata: {
        baseRepoHygiene: true,
        repoRoot: input.repoRoot,
        baseRef: input.baseRef,
        fastForwardOnly: true,
        ...(quarantined.length > 0 ? { quarantinedUntrackedPaths: quarantined } : {}),
        // Files an agent errand left in a checkout that is nobody's workspace.
        // None of these block anything today; any of them becomes the next wedge
        // the moment the same path lands on the base ref. Recorded rather than
        // warned so the drift is queryable without adding noise to every
        // dispatch, and without new rows — this operation is written regardless.
        ...(untracked.length > 0 ? { untrackedBaseRepoPaths: untracked } : {}),
      },
      successMessage: `Fast-forwarded base repository at ${input.repoRoot} to ${input.baseRef}\n`,
      failureLabel: `git merge --ff-only ${input.baseRef}`,
    });

  // Clear the one blocker that never clears itself, BEFORE the merge rather than
  // after it refuses. We are only here because HEAD is behind the base ref, so an
  // untracked path the base ref also contains is not a risk of a refusal — it is
  // the refusal, already decided. Asking first costs two plumbing commands and
  // means the doomed attempt is never run and never recorded as a failure.
  const quarantine = await quarantineBaseRepoUntrackedCollisions({
    repoRoot: input.repoRoot,
    baseRef: input.baseRef,
    timestamp: input.timestamp,
    recorder: input.recorder ?? null,
  }).catch((error) => ({
    quarantined: [] as string[],
    destination: null,
    warnings: [`could not quarantine untracked base repo paths: ${error instanceof Error ? error.message : String(error)}`],
  }));
  warnings.push(...quarantine.warnings);
  if (quarantine.quarantined.length > 0) {
    warnings.push(
      `Moved ${quarantine.quarantined.length} untracked path(s) that ${input.baseRef} also contains to ${quarantine.destination}: ${quarantine.quarantined.join(", ")}.`,
    );
  }

  const remainingUntracked = await runGit(["ls-files", "--others", "--exclude-standard"], input.repoRoot)
    .then((value) => value.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 50))
    .catch(() => [] as string[]);

  try {
    await merge(quarantine.quarantined, remainingUntracked);
    return { fastForwarded: true, quarantined: quarantine.quarantined, warnings };
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
    return { fastForwarded: false, quarantined: quarantine.quarantined, warnings };
  }
}

function buildExecutionWorkspaceCleanupEnv(input: {
  workspace: {
    cwd: string | null;
    providerRef: string | null;
    branchName: string | null;
    repoUrl: string | null;
    baseRef: string | null;
    projectId: string | null;
    projectWorkspaceId: string | null;
    sourceIssueId: string | null;
  };
  projectWorkspaceCwd?: string | null;
}) {
  const env: NodeJS.ProcessEnv = sanitizeRuntimeServiceBaseEnv(process.env);
  env.PAPERCLIP_WORKSPACE_CWD = input.workspace.cwd ?? "";
  env.PAPERCLIP_WORKSPACE_PATH = input.workspace.cwd ?? "";
  env.PAPERCLIP_WORKSPACE_WORKTREE_PATH =
    input.workspace.providerRef ?? input.workspace.cwd ?? "";
  env.PAPERCLIP_WORKSPACE_BRANCH = input.workspace.branchName ?? "";
  env.PAPERCLIP_WORKSPACE_BASE_CWD = input.projectWorkspaceCwd ?? "";
  env.PAPERCLIP_WORKSPACE_REPO_ROOT = input.projectWorkspaceCwd ?? "";
  env.PAPERCLIP_WORKSPACE_REPO_URL = input.workspace.repoUrl ?? "";
  env.PAPERCLIP_WORKSPACE_REPO_REF = input.workspace.baseRef ?? "";
  env.PAPERCLIP_PROJECT_ID = input.workspace.projectId ?? "";
  env.PAPERCLIP_PROJECT_WORKSPACE_ID = input.workspace.projectWorkspaceId ?? "";
  env.PAPERCLIP_ISSUE_ID = input.workspace.sourceIssueId ?? "";
  return env;
}

async function resolveGitRepoRootForWorkspaceCleanup(
  worktreePath: string,
  projectWorkspaceCwd: string | null,
): Promise<string | null> {
  if (projectWorkspaceCwd) {
    const resolvedProjectWorkspaceCwd = path.resolve(projectWorkspaceCwd);
    const gitDir = await runGit(["rev-parse", "--git-common-dir"], resolvedProjectWorkspaceCwd)
      .catch(() => null);
    if (gitDir) {
      const resolvedGitDir = path.resolve(resolvedProjectWorkspaceCwd, gitDir);
      return path.dirname(resolvedGitDir);
    }
  }

  const gitDir = await runGit(["rev-parse", "--git-common-dir"], worktreePath).catch(() => null);
  if (!gitDir) return null;
  const resolvedGitDir = path.resolve(worktreePath, gitDir);
  return path.dirname(resolvedGitDir);
}

export async function prepareBaseRepoForWorkspace(input: {
  repoRoot: string;
  configuredBaseRef: string | null;
  resolveGitAuth?: GitRemoteAuthProvider | null;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<{ baseRef: string; baseRefSha: string | null; warnings: string[] }> {
  const {
    baseRef,
    warnings: baseRefResolutionWarnings,
    refreshed: baseRefAlreadyRefreshed,
  } = await resolveAuthoritativeBaseRef(input.repoRoot, input.configuredBaseRef, input.resolveGitAuth);
  const baseRefreshWarnings = [
    ...baseRefResolutionWarnings,
    ...(baseRefAlreadyRefreshed ? [] : await refreshRemoteTrackingBaseRef(input.repoRoot, baseRef, input.resolveGitAuth)),
  ];
  const currentBaseRefSha = await resolveBaseRefSha(input.repoRoot, baseRef);

  // SUP-11285: tidy the base repo before cutting from it. Strictly best-effort —
  // the dispatch proceeds whatever happens here, because the issue being run did
  // not cause the mess and must not be held hostage to it.
  const baseRepoHygieneWarnings: string[] = [];
  try {
    const hygiene = await inspectBaseRepoHygiene(input.repoRoot);
    if (hygiene) {
      const headSha = await runGit(["rev-parse", "HEAD"], input.repoRoot).catch(() => null);
      const headBehindBaseRef = Boolean(headSha && currentBaseRefSha && headSha !== currentBaseRefSha)
        ? await runGit(["merge-base", "--is-ancestor", headSha!, currentBaseRefSha!], input.repoRoot)
            .then(() => true).catch(() => false)
        : false;
      // SUP-13857: resolve shallowness ONCE, before any counting. When ancestry is
      // severed the counts below are not merely approximate, they are whole-history
      // totals, so the guard has to sit in front of them rather than sanity-check
      // them afterwards.
      const shallowState = await resolveBaseRepoShallowState(input.repoRoot, baseRef);
      baseRepoHygieneWarnings.push(...shallowState.warnings);
      let aheadCount: number | undefined;
      let behindCount: number | undefined;
      let aheadCommitSubjects: string[] | undefined;
      if (
        shallowState.divergenceComputable &&
        !headBehindBaseRef && headSha && currentBaseRefSha && headSha !== currentBaseRefSha
      ) {
        const revList = await runGit(["rev-list", "--left-right", "--count", baseRef + "...HEAD"], input.repoRoot)
          .then((value) => {
            const tokens = value.trim().split(/\s+/);
            if (tokens.length >= 2) {
              return { behind: parseInt(tokens[0], 10), ahead: parseInt(tokens[1], 10) };
            }
            return null;
          })
          .catch(() => null);
        if (revList) {
          behindCount = revList.behind;
          aheadCount = revList.ahead;
          if (aheadCount > 0) {
            aheadCommitSubjects = await runGit(["log", "--format=%s", baseRef + "..HEAD"], input.repoRoot)
              .then((value) => value.trim().split("\n").filter((line) => line.length > 0))
              .catch(() => []);
          }
        }
      }
      const decision = resolveBaseRepoHygieneDecision({
        currentBranch: hygiene.currentBranch,
        defaultRef: baseRef,
        dirtyTrackedPathCount: hygiene.dirtyTrackedPathCount,
        unmergedPathCount: hygiene.unmergedPathCount,
        headSha,
        baseRefSha: currentBaseRefSha,
        headBehindBaseRef,
        aheadCount,
        behindCount,
        aheadCommitSubjects,
        divergenceComputable: shallowState.divergenceComputable,
        graftCommits: shallowState.graftCommits,
      });
      if (decision.action === "restore") {
        const result = await restoreBaseRepoToDefaultRef({
          repoRoot: input.repoRoot,
          baseRef,
          decision,
          timestamp: new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"),
          recorder: input.recorder ?? null,
        });
        baseRepoHygieneWarnings.push(
          `Base repository at ${input.repoRoot} was restored to ${baseRef}: ${decision.reasons.join("; ")}.` +
            (result.rescueRefs.length > 0
              ? ` Anything found there is preserved on ${result.rescueRefs.join(", ")}.`
              : ""),
          ...result.warnings,
        );
      } else if (decision.action === "fastForward") {
        const result = await fastForwardBaseRepoToDefaultRef({
          repoRoot: input.repoRoot,
          baseRef,
          timestamp: new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"),
          recorder: input.recorder ?? null,
        });
        baseRepoHygieneWarnings.push(
          result.fastForwarded
            ? `Base repository at ${input.repoRoot} was fast-forwarded to ${baseRef}.` +
                (result.quarantined.length > 0
                  ? ` ${result.quarantined.length} untracked path(s) it also contains were moved aside: ${result.quarantined.join(", ")}.`
                  : "")
            : `Could not fast-forward base repository at ${input.repoRoot} to ${baseRef}: ${result.warnings.join("; ")}`,
        );
      } else if (decision.action === "diverged") {
        // SUP-13858: `diverged` never resets, by design — which is right when the ahead
        // commits are real work, and a permanent freeze when they are not. In the
        // motivating incident 20 of 22 ahead commits were duplicates or belonged to a
        // cancelled issue and ZERO were unshipped, yet the base repo stayed stuck for
        // 16 days. So: prove every ahead commit is already upstream by patch-id, pin the
        // tip, and only then reset. Anything short of proof falls through to the
        // unchanged warning below.
        const upstreamCheck = await resolveBaseRepoAheadCommitsAllUpstream({
          repoRoot: input.repoRoot,
          baseRef,
          mergeBase: shallowState.mergeBase,
        });
        const resetOutcome = upstreamCheck.allUpstream && headSha && currentBaseRefSha
          ? await resetBaseRepoToBaseRefWithRescue({
              repoRoot: input.repoRoot,
              baseRef,
              baseRefSha: currentBaseRefSha,
              priorTip: headSha,
              aheadCount: upstreamCheck.aheadCount,
              recorder: input.recorder ?? null,
            })
          : null;

        if (resetOutcome) {
          baseRepoHygieneWarnings.push(...resetOutcome.warnings);
          for (const warning of resetOutcome.warnings) logger.warn(warning);
        } else {
          // Unchanged, verbatim: at least one ahead commit is unique, or duplication
          // could not be proven. Warn, preserve, never reset.
          const subjects = decision.aheadCommitSubjects.length > 0
            ? decision.aheadCommitSubjects.join(", ")
            : "(no subjects)";
          const message =
            `Base repository at ${input.repoRoot} has diverged from ${baseRef}: ` +
            `${decision.aheadCount} ahead, ${decision.behindCount} behind. ` +
            `Ahead commits: ${subjects}. Local commits preserved — no reset performed.`;
          baseRepoHygieneWarnings.push(message);
          logger.warn(message);
        }
      } else if (decision.action === "indeterminate") {
        // No integers in this message, by contract: the whole point is that there is
        // no ahead/behind number anyone is entitled to state.
        const grafts = decision.graftCommits.length > 0
          ? decision.graftCommits.map((sha) => sha.slice(0, 12)).join(", ")
          : `none recorded — HEAD and ${baseRef} share no merge base`;
        const message =
          `Base repository at ${input.repoRoot} has an indeterminate (shallow) relationship to ${baseRef}: ` +
          `ancestry between HEAD and ${baseRef} cannot be computed, so no ahead/behind counts are reported ` +
          `and no reset was performed. Graft commits: ${grafts}.`;
        baseRepoHygieneWarnings.push(message);
        logger.warn(message);
      } else if (decision.action === "ok") {
        if (shallowState.divergenceComputable && headSha && currentBaseRefSha && headSha !== currentBaseRefSha) {
          const revList = await runGit(
            ["rev-list", "--left-right", "--count", `HEAD...${baseRef}`],
            input.repoRoot,
          ).catch(() => null);
          if (revList) {
            const [aheadStr, behindStr] = revList.split("\t");
            const ahead = Number(aheadStr);
            const behind = Number(behindStr);
            const subjects = await runGit(
              ["log", "--format=%s", `${baseRef}..HEAD`],
              input.repoRoot,
            ).catch(() => "");
            const subjectList = subjects ? subjects.split("\n") : [];
            baseRepoHygieneWarnings.push(
              `Base repository at ${input.repoRoot} is ahead of ${baseRef}: ${ahead} commit(s) ahead, ${behind} commit(s) behind. Ahead commits: ${subjectList.join(", ")}`,
            );
          }
        }
      }
    }
  } catch (err) {
    baseRepoHygieneWarnings.push(
      `Base repository hygiene check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    baseRef,
    baseRefSha: currentBaseRefSha,
    warnings: [...baseRepoHygieneWarnings, ...baseRefreshWarnings],
  };
}

export async function realizeExecutionWorkspace(input: {
  db?: Db | null;
  base: ExecutionWorkspaceInput;
  config: Record<string, unknown>;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  /**
   * SUP-11520: the execution workspace row this issue is already bound to, when one exists.
   *
   * Realization is a fresh *realization*, not necessarily a fresh *row*: an issue whose workspace
   * config went stale is re-realized while its existing row still points at the same worktree
   * path. The branch-contention check has to know which row belongs to the asker, or it matches
   * that row on path and reports the asking run as its own competing claimant — a refusal whose
   * precondition is created by the act of asking, so it can never clear.
   *
   * Identification only. Realization does not own this row (the dispatch persists workspace
   * records after realization returns), so this must not be passed as `executionWorkspaceId`,
   * which is what grants mid-repair write access to the record.
   */
  existingExecutionWorkspaceId?: string | null;
  heartbeatRunId?: string | null;
  enableWorkspaceBranchReconcileForward?: boolean;
  enableWorkspaceDirtyQuarantineRepair?: boolean;
  recorder?: WorkspaceOperationRecorder | null;
  resolveGitAuth?: GitRemoteAuthProvider | null;
}): Promise<RealizedExecutionWorkspace> {
  const rawStrategy = parseObject(input.config.workspaceStrategy);
  const strategyType = asString(rawStrategy.type, "project_primary");
  if (strategyType !== "git_worktree") {
    return {
      ...input.base,
      strategy: "project_primary",
      cwd: input.base.baseCwd,
      branchName: null,
      worktreePath: null,
      warnings: [],
      created: false,
      baseRefSha: null,
    };
  }

  const repoRoot = await resolveGitOwnerRepoRoot(input.base.baseCwd);
  const branchTemplate = asString(rawStrategy.branchTemplate, "{{issue.identifier}}-{{slug}}");
  const renderedBranch = renderWorkspaceTemplate(branchTemplate, {
    issue: input.issue,
    agent: input.agent,
    projectId: input.base.projectId,
    repoRef: input.base.repoRef,
  });
  let branchName = sanitizeBranchName(renderedBranch);
  const remoteDefaultBranch = await detectRemoteDefaultBranch(repoRoot);
  if (remoteDefaultBranch && branchName === remoteDefaultBranch) {
    throw new Error(
      `Execution workspace branch name "${branchName}" matches the repo's default branch. ` +
      `Creating a worktree on the default branch would permanently strand the primary clone. ` +
      `Use a branch template that produces a unique name (e.g., "{{issue.identifier}}-{{slug}}").`,
    );
  }
  const configuredParentDir = asString(rawStrategy.worktreeParentDir, "");
  const worktreeParentDir = configuredParentDir
    ? resolveConfiguredPath(configuredParentDir, repoRoot)
    : path.join(repoRoot, ".paperclip", "worktrees");
  const worktreePath = path.join(worktreeParentDir, branchName);
  let pendingForwardBranchReconcile: PendingForwardBranchReconcile | null = null;
  const configuredBaseRef = typeof rawStrategy.baseRef === "string" && rawStrategy.baseRef.length > 0
    ? rawStrategy.baseRef
    : input.base.repoRef ?? null;
  const baseRepoHygiene = await prepareBaseRepoForWorkspace({
    repoRoot,
    configuredBaseRef,
    resolveGitAuth: input.resolveGitAuth ?? null,
    recorder: input.recorder ?? null,
  });
  const baseRef = baseRepoHygiene.baseRef;
  const currentBaseRefSha = baseRepoHygiene.baseRefSha;

  await fs.mkdir(worktreeParentDir, { recursive: true });
  // Repair the whole chain, not just the leaf. The recursive mkdir above can
  // create BOTH `.paperclip` and `worktrees`, and the repo root above them was
  // never repaired at all — it was group-traversable only by accident of the
  // creating process's umask. A repo root left at 0o2700 makes every path
  // beneath it EACCES for the agent uid, which surfaces as a run on issue A
  // dying while it stats issue B's worktree.
  await ensureSharedGroupTraversalPath(worktreeParentDir, repoRoot);

  async function reuseExistingWorktree(reusablePath: string, effectiveBranchName = branchName, extraWarnings: string[] = []) {
    const refresh = currentBaseRefSha
      ? await refreshUnstartedWorktreeToBase({
          repoRoot,
          worktreePath: reusablePath,
          branchName: effectiveBranchName,
          baseRef,
          currentBaseRefSha,
          recorder: input.recorder ?? null,
        })
      : { refreshed: false, baseRefSha: null };
    const baseDrift = await inspectExecutionWorkspaceBaseDrift({
      repoRoot,
      worktreePath: reusablePath,
      branchName,
      baseRef,
      recordedBaseRefSha: null,
      skipRefresh: true,
    });
    if (input.recorder) {
      await input.recorder.recordOperation({
        phase: "worktree_prepare",
        cwd: repoRoot,
        metadata: {
          repoRoot,
          worktreePath: reusablePath,
          branchName: effectiveBranchName,
          baseRef,
          currentBaseRefSha: baseDrift.currentBaseRefSha,
          branchBaseRefSha: baseDrift.branchBaseRefSha,
          created: false,
          reused: true,
        },
        run: async () => ({
          status: "succeeded",
          exitCode: 0,
          system: `Reused existing git worktree at ${reusablePath}\n`,
        }),
      });
    }
    await provisionExecutionWorktree({
      strategy: rawStrategy,
      base: input.base,
      repoRoot,
      worktreePath: reusablePath,
      branchName: effectiveBranchName,
      issue: input.issue,
      agent: input.agent,
      created: false,
      recorder: input.recorder ?? null,
    });
    return {
      ...input.base,
      repoRef: baseRef,
      strategy: "git_worktree" as const,
      cwd: reusablePath,
      branchName: effectiveBranchName,
      worktreePath: reusablePath,
      warnings: [...extraWarnings, ...baseRepoHygiene.warnings, ...baseDrift.warnings],
      created: false,
      baseRefSha: refresh.baseRefSha ?? baseDrift.branchBaseRefSha ?? baseDrift.currentBaseRefSha,
      pendingForwardBranchReconcile,
    };
  }

  async function validateReusableWorktree(reusablePath: string) {
    // SUP-10665 originally reset a clean reused worktree to its recorded branch here, before
    // validation. That erased the very state validation exists to inspect: a diverged HEAD was
    // checked out away before anything could detect it, so the run proceeded and another run's
    // commits were left behind with no failure, no audit, and no contention check — the checkout
    // even swallowed its own errors. It also preempted forward reconciliation, resetting a branch
    // that was ahead of the record instead of adopting it.
    //
    // Normalisation belongs to ensureGitWorktreeBranchCoherent, which is reached through
    // validateLinkedGitWorktree below and already encodes the safe-repair paths, the contention
    // check, and the audit trail.
    const validation = await validateLinkedGitWorktree({
      repoRoot,
      worktreePath: reusablePath,
      expectedBranchName: branchName,
    }).catch(() => null);
    if (validation && !validation.valid && validation.reasonCode === "branch_mismatch") {
      const coherence = await ensureGitWorktreeBranchCoherent({
        db: input.db ?? null,
        repoRoot,
        worktreePath: reusablePath,
        expectedBranchName: branchName,
        actualBranchName: validation.actualBranchName ?? null,
        sourceIssue: input.issue,
        executionWorkspaceId: null,
        contentionExcludeExecutionWorkspaceId: input.existingExecutionWorkspaceId ?? null,
        heartbeatRunId: input.heartbeatRunId ?? null,
        enableWorkspaceBranchReconcileForward: input.enableWorkspaceBranchReconcileForward === true,
        enableWorkspaceDirtyQuarantineRepair: input.enableWorkspaceDirtyQuarantineRepair === true,
        reconcileOperationPhase: "worktree_prepare",
        recorder: input.recorder ?? null,
      });
      const effectiveBranchName = coherence.branchName ?? branchName;
      if (coherence.reconciledForward) {
        branchName = effectiveBranchName;
        pendingForwardBranchReconcile = coherence.pendingForwardBranchReconcile ?? null;
      }
      const nextValidation = await validateLinkedGitWorktree({
        repoRoot,
        worktreePath: reusablePath,
        expectedBranchName: effectiveBranchName,
      }).catch(() => null);
      return {
        validation: nextValidation,
        branchName: effectiveBranchName,
        warnings: coherence.warnings,
      };
    }
    return { validation, branchName, warnings: [] };
  }

  const existingWorktree = await directoryExists(worktreePath);
  if (existingWorktree) {
    const reusable = await validateReusableWorktree(worktreePath);
    if (reusable.validation?.valid) {
      return await reuseExistingWorktree(worktreePath, reusable.branchName, reusable.warnings);
    }
    const validation = reusable.validation;
    const reason = validation && !validation.valid ? ` (${validation.reason})` : "";
    throw new Error(`Configured worktree path "${worktreePath}" already exists and is not a reusable git worktree${reason}.`);
  }

  const registeredBranchWorktree = await findRegisteredGitWorktreeByBranch(repoRoot, branchName);
  if (registeredBranchWorktree) {
    const reusable = await validateReusableWorktree(registeredBranchWorktree);
    if (reusable.validation?.valid) {
      return await reuseExistingWorktree(registeredBranchWorktree, reusable.branchName, reusable.warnings);
    }
    const validation = reusable.validation;
    const reason = validation && !validation.valid ? ` (${validation.reason})` : "";
    throw new Error(`Registered worktree for branch "${branchName}" at "${registeredBranchWorktree}" is not reusable${reason}.`);
  }

  try {
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["worktree", "add", "-b", branchName, worktreePath, baseRef],
      cwd: repoRoot,
      metadata: {
        repoRoot,
        worktreePath,
        branchName,
        baseRef,
        baseRefSha: currentBaseRefSha,
        created: true,
      },
      successMessage: `Created git worktree at ${worktreePath}\n`,
      failureLabel: `git worktree add ${worktreePath}`,
    });
    await ensureSharedGroupOwnership(worktreePath);
  } catch (error) {
    if (!gitErrorIncludes(error, "already exists")) {
      throw error;
    }
    try {
      await recordGitOperation(input.recorder, {
        phase: "worktree_prepare",
        args: ["worktree", "add", worktreePath, branchName],
        cwd: repoRoot,
        metadata: {
          repoRoot,
          worktreePath,
          branchName,
          baseRef,
          baseRefSha: currentBaseRefSha,
          created: false,
          reusedExistingBranch: true,
        },
        successMessage: `Attached existing branch ${branchName} at ${worktreePath}\n`,
        failureLabel: `git worktree add ${worktreePath}`,
      });
      await ensureSharedGroupOwnership(worktreePath);
    } catch (attachError) {
      if (!gitErrorIncludes(attachError, "already checked out")) {
        throw attachError;
      }
      const reusablePath = await findRegisteredGitWorktreeByBranch(repoRoot, branchName);
      if (!reusablePath || !await isGitCheckout(reusablePath)) {
        throw attachError;
      }
      return await reuseExistingWorktree(reusablePath);
    }
  }
  await provisionExecutionWorktree({
    strategy: rawStrategy,
    base: input.base,
    repoRoot,
    worktreePath,
    branchName,
    issue: input.issue,
    agent: input.agent,
    created: true,
    recorder: input.recorder ?? null,
  });

  return {
    ...input.base,
    repoRef: baseRef,
    strategy: "git_worktree",
    cwd: worktreePath,
    branchName,
    worktreePath,
    warnings: baseRepoHygiene.warnings,
    created: true,
    baseRefSha: currentBaseRefSha,
  };
}

export async function ensurePersistedExecutionWorkspaceAvailable(input: {
  db?: Db | null;
  base: ExecutionWorkspaceInput;
  workspace: {
    id?: string | null;
    mode: string | null | undefined;
    strategyType: string | null | undefined;
    cwd: string | null | undefined;
    providerRef: string | null | undefined;
    projectId: string | null | undefined;
    projectWorkspaceId: string | null | undefined;
    repoUrl: string | null | undefined;
    baseRef: string | null | undefined;
    branchName: string | null | undefined;
    metadata?: Record<string, unknown> | null;
    config?: {
      provisionCommand?: string | null;
      runtimeProvisionCommand?: string | null;
    } | null;
  };
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  heartbeatRunId?: string | null;
  enableWorkspaceBranchReconcileForward?: boolean;
  enableWorkspaceDirtyQuarantineRepair?: boolean;
  recorder?: WorkspaceOperationRecorder | null;
  resolveGitAuth?: GitRemoteAuthProvider | null;
}): Promise<RealizedExecutionWorkspace | null> {
  const cwd = asString(input.workspace.cwd ?? input.workspace.providerRef, "").trim();
  if (!cwd) return null;

  const strategy = input.workspace.strategyType === "git_worktree" ? "git_worktree" : "project_primary";
  const realized: RealizedExecutionWorkspace = {
    baseCwd: input.base.baseCwd,
    source: input.workspace.mode === "shared_workspace" ? "project_primary" : "task_session",
    projectId: input.workspace.projectId ?? input.base.projectId,
    workspaceId: input.workspace.projectWorkspaceId ?? input.base.workspaceId,
    repoUrl: input.workspace.repoUrl ?? input.base.repoUrl,
    repoRef: input.workspace.baseRef ?? input.base.repoRef,
    additionalWorkspaces: input.base.additionalWorkspaces ?? [],
    strategy,
    cwd,
    branchName: input.workspace.branchName ?? null,
    worktreePath: strategy === "git_worktree" ? (input.workspace.providerRef ?? cwd) : null,
    warnings: [],
    created: false,
    baseRefSha: readRecordedBaseRefSha(input.workspace.metadata),
  };
  const provisionCommand = asString(input.workspace.config?.provisionCommand, "").trim();

  if (strategy !== "git_worktree") {
    if (!await directoryExists(cwd)) {
      return null;
    }
    return realized;
  }
  const repoRoot = await runGit(["rev-parse", "--show-toplevel"], input.base.baseCwd);
  const recordedBaseRefSha = readRecordedBaseRefSha(input.workspace.metadata);
  if (await directoryExists(cwd)) {
    const reuseWorktreePath = realized.worktreePath ?? cwd;
    const repairWarnings: string[] = [];
    if (await isGitCheckout(reuseWorktreePath)) {
      const coherence = await ensureGitWorktreeBranchCoherent({
        db: input.db ?? null,
        repoRoot,
        worktreePath: reuseWorktreePath,
        expectedBranchName: realized.branchName,
        sourceIssue: input.issue,
        executionWorkspaceId: input.workspace.id ?? null,
        heartbeatRunId: input.heartbeatRunId ?? null,
        enableWorkspaceBranchReconcileForward: input.enableWorkspaceBranchReconcileForward === true,
        enableWorkspaceDirtyQuarantineRepair: input.enableWorkspaceDirtyQuarantineRepair === true,
        persistForwardReconcile: false,
        reconcileOperationPhase: "worktree_prepare",
        recorder: input.recorder ?? null,
      });
      if (coherence.branchName) {
        realized.branchName = coherence.branchName;
      }
      if (coherence.reconciledForward) {
        realized.pendingForwardBranchReconcile = coherence.pendingForwardBranchReconcile ?? null;
      }
      repairWarnings.push(...coherence.warnings);
    }
    const validation = await validateLinkedGitWorktree({
      repoRoot,
      worktreePath: reuseWorktreePath,
      expectedBranchName: realized.branchName,
    });
    if (!validation.valid) {
      throw new WorkspaceRuntimeValidationFailure(
        `Persisted git worktree "${reuseWorktreePath}" is not reusable (${validation.reason}).`,
        {
          workspaceValidation: {
            reason: "git_worktree_not_reusable",
            reasonCode: validation.reasonCode,
            worktreePath: reuseWorktreePath,
            executionWorkspaceId: input.workspace.id ?? null,
          },
        },
      );
    }
    const reuseBaseRef = input.workspace.baseRef ?? input.base.repoRef ?? null;
    const baseRepoHygiene = reuseBaseRef
      ? await prepareBaseRepoForWorkspace({
          repoRoot,
          configuredBaseRef: reuseBaseRef,
          resolveGitAuth: input.resolveGitAuth ?? null,
          recorder: input.recorder ?? null,
        })
      : { baseRef: reuseBaseRef, baseRefSha: null, warnings: [] };
    const currentBaseRefSha = baseRepoHygiene.baseRefSha;
    const refresh = currentBaseRefSha
      ? await refreshUnstartedWorktreeToBase({
          repoRoot,
          worktreePath: reuseWorktreePath,
          branchName: realized.branchName,
          baseRef: baseRepoHygiene.baseRef,
          currentBaseRefSha,
          recorder: input.recorder ?? null,
        })
      : { refreshed: false, baseRefSha: null };
    const baseDrift = await inspectExecutionWorkspaceBaseDrift({
      repoRoot,
      worktreePath: reuseWorktreePath,
      branchName: realized.branchName,
      baseRef: baseRepoHygiene.baseRef,
      recordedBaseRefSha,
      skipRefresh: true,
    });
    realized.warnings = [...repairWarnings, ...baseRepoHygiene.warnings, ...baseDrift.warnings];
    realized.baseRefSha = refresh.baseRefSha ?? recordedBaseRefSha ?? baseDrift.branchBaseRefSha ?? baseDrift.currentBaseRefSha;
    if (provisionCommand) {
      await provisionExecutionWorktree({
        strategy: {
          type: "git_worktree",
          provisionCommand,
        },
        base: input.base,
        repoRoot,
        worktreePath: realized.worktreePath ?? cwd,
        branchName: realized.branchName ?? "",
        issue: input.issue,
        agent: input.agent,
        created: false,
        recorder: input.recorder ?? null,
      });
    }
    return realized;
  }

  const worktreePath = realized.worktreePath ?? cwd;
  const branchName = asString(input.workspace.branchName, "").trim();
  if (!branchName) {
    throw new Error(`Execution workspace "${cwd}" is missing and cannot be restored because no branch name is recorded.`);
  }

  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await ensureSharedGroupOwnership(path.dirname(worktreePath));
  await runGit(["worktree", "prune"], repoRoot).catch(() => {});
  const restoreBaseRef = input.workspace.baseRef ?? input.base.repoRef ?? null;
  const baseRepoHygiene = restoreBaseRef
    ? await prepareBaseRepoForWorkspace({
        repoRoot,
        configuredBaseRef: restoreBaseRef,
        resolveGitAuth: input.resolveGitAuth ?? null,
        recorder: input.recorder ?? null,
      })
    : { baseRef: restoreBaseRef, baseRefSha: null, warnings: [] };
  const restoreCurrentBaseRefSha = baseRepoHygiene.baseRefSha;

  let created = false;
  try {
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["worktree", "add", worktreePath, branchName],
      cwd: repoRoot,
      metadata: {
        repoRoot,
        worktreePath,
        branchName,
        baseRef: baseRepoHygiene.baseRef,
        currentBaseRefSha: restoreCurrentBaseRefSha,
        created: false,
        restored: true,
      },
      successMessage: `Reattached missing git worktree at ${worktreePath}\n`,
      failureLabel: `git worktree add ${worktreePath}`,
    });
    await ensureSharedGroupOwnership(worktreePath);
  } catch (error) {
    if (
      !gitErrorIncludes(error, "invalid reference")
      && !gitErrorIncludes(error, "not a commit")
      && !gitErrorIncludes(error, "unknown revision")
    ) {
      throw error;
    }
    const baseRef = baseRepoHygiene.baseRef ?? await detectDefaultBranch(repoRoot) ?? "HEAD";
    const recreatedBaseRefSha = await resolveBaseRefSha(repoRoot, baseRef);
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["worktree", "add", "-b", branchName, worktreePath, baseRef],
      cwd: repoRoot,
      metadata: {
        repoRoot,
        worktreePath,
        branchName,
        baseRef,
        baseRefSha: recreatedBaseRefSha,
        created: true,
        restored: true,
      },
      successMessage: `Recreated missing git worktree at ${worktreePath}\n`,
      failureLabel: `git worktree add ${worktreePath}`,
    });
    await ensureSharedGroupOwnership(worktreePath);
    created = true;
  }

  const baseDrift = await inspectExecutionWorkspaceBaseDrift({
    repoRoot,
    worktreePath,
    branchName,
    baseRef: baseRepoHygiene.baseRef,
    recordedBaseRefSha,
    skipRefresh: true,
  });

  await provisionExecutionWorktree({
    strategy: {
      type: "git_worktree",
      ...(provisionCommand ? { provisionCommand } : {}),
    },
    base: input.base,
    repoRoot,
    worktreePath,
    branchName,
    issue: input.issue,
    agent: input.agent,
    created,
    recorder: input.recorder ?? null,
  });

  return {
    ...realized,
    cwd: worktreePath,
    worktreePath,
    warnings: [...baseRepoHygiene.warnings, ...baseDrift.warnings],
    created,
    baseRefSha:
      recordedBaseRefSha
      ?? (created ? restoreCurrentBaseRefSha : baseDrift.branchBaseRefSha)
      ?? baseDrift.currentBaseRefSha,
  };
}

/** Namespace for refs that keep rescued work reachable after its worktree is gone. */
export const WORKTREE_RESCUE_REF_PREFIX = "refs/paperclip/rescue";

/**
 * How long a rescue ref is kept. A ref keeps its whole commit reachable, so without expiry every
 * dirty teardown would pin another tree in the base repo forever and `git gc` could never reclaim
 * any of it. Long enough that a lost diff is still recoverable days later by a human who noticed.
 */
export const WORKTREE_RESCUE_REF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Identity plus an explicit signing opt-out: a host with `commit.gpgsign=true` in global config
// would otherwise block this commit on a passphrase it can never be given, and the work the
// commit exists to save would be destroyed by the removal below anyway.
const RESCUE_COMMIT_IDENTITY = [
  "-c",
  "user.name=Paperclip",
  "-c",
  "user.email=paperclip@localhost",
  "-c",
  "commit.gpgsign=false",
];

/**
 * Drops rescue refs older than the TTL. Best-effort and never throws: failing to prune is not a
 * reason to fail the preservation that just succeeded.
 */
async function pruneExpiredWorktreeRescueRefs(cwd: string, ttlMs = WORKTREE_RESCUE_REF_TTL_MS) {
  try {
    const listed = await runGit(
      ["for-each-ref", "--format=%(refname) %(committerdate:unix)", WORKTREE_RESCUE_REF_PREFIX],
      cwd,
    );
    const cutoffSeconds = (Date.now() - ttlMs) / 1000;
    for (const line of listed.split("\n")) {
      const [refName, committedAt] = line.trim().split(/\s+/);
      if (!refName || !committedAt) continue;
      const committedSeconds = Number(committedAt);
      if (!Number.isFinite(committedSeconds) || committedSeconds >= cutoffSeconds) continue;
      await runGit(["update-ref", "-d", refName], cwd);
    }
  } catch {
    // Pruning is housekeeping; a failure here must not surface as a preservation failure.
  }
}

const WORKTREE_PRESERVATION_REF_PREFIX = "refs/preserved";

export async function preserveUnpushedWorktreeCommits(input: {
  workspacePath: string;
  branchName: string;
  issueIdentifier: string | null;
  repoRoot: string;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<{
  preserved: boolean;
  preservedRef: string | null;
  commitSha: string | null;
  warning: string | null;
}> {
  const notPreserved = { preserved: false, preservedRef: null, commitSha: null, warning: null } as const;
  try {
    const revList = await runGit(["rev-list", "HEAD", "--not", "--remotes"], input.workspacePath);
    if (!revList.trim()) return notPreserved;

    const commitSha = await runGit(["rev-parse", "HEAD"], input.workspacePath);
    const safeIdentifier = (input.issueIdentifier ?? "unknown").replace(/[^a-zA-Z0-9._\-]/g, "_");
    const safeBranchName = input.branchName.replace(/[^a-zA-Z0-9._\-]/g, "_");
    const preservedRef = `${WORKTREE_PRESERVATION_REF_PREFIX}/${safeIdentifier}/${safeBranchName}`;

    try {
      // paperclip:allow-git-push: worktree cleanup would otherwise destroy unpushed commits; this
      // preserves them under refs/<preservation prefix>/, never a branch, and is the last step
      // before the worktree is removed.
      await runGit(["push", "origin", `${commitSha}:${preservedRef}`], input.repoRoot);
    } catch (pushErr) {
      const pushMessage = pushErr instanceof Error ? pushErr.message : String(pushErr);
      return {
        preserved: false,
        preservedRef: null,
        commitSha,
        warning: `Could not push unpushed commits to preservation ref ${preservedRef}: ${pushMessage}`,
      };
    }

    if (input.recorder) {
      await input.recorder.recordOperation({
        phase: "worktree_cleanup",
        // paperclip:allow-git-push: display string for the preservation push above, not a push.
        command: formatCommandForDisplay("git", ["push", "origin", `${commitSha}:${preservedRef}`]),
        cwd: input.repoRoot,
        metadata: {
          workspacePath: input.workspacePath,
          branchName: input.branchName,
          issueIdentifier: input.issueIdentifier,
          cleanupAction: "preserve_unpushed_commits",
          commitSha,
          preservedRef,
        },
        run: async () => ({
          status: "succeeded",
          exitCode: 0,
          system:
            `Preserved unpushed commits as ${commitSha} before removing the worktree ` +
            `(recoverable from ${preservedRef})\n`,
        }),
      });
    }

    return { preserved: true, preservedRef, commitSha, warning: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      preserved: false,
      preservedRef: null,
      commitSha: null,
      warning: `Could not preserve unpushed commits in "${input.workspacePath}" before removal: ${message}`,
    };
  }
}

/**
 * Commits whatever is sitting uncommitted in a worktree before the worktree is destroyed.
 *
 * `git worktree remove --force` discards the working tree unconditionally, so a run that produced a
 * real diff but stopped before committing loses it with no warning. Committing first puts the work
 * in the base repo's object store, where two things keep it reachable: the follow-on `git branch -d`
 * is the *safe* delete and refuses an unmerged branch, and a `refs/paperclip/rescue/<workspaceId>`
 * ref covers the detached-HEAD and merged-branch cases where the branch alone would not.
 *
 * Preservation is best-effort by construction: every failure is returned as a warning and teardown
 * continues, because a worktree that cannot be cleaned up is a worse failure than a lost diff.
 */
async function preserveUncommittedWorktreeWork(input: {
  workspacePath: string;
  workspaceId: string;
  branchName: string | null;
  sourceIssueId: string | null;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<{ preserved: boolean; commitSha: string | null; warning: string | null }> {
  const notPreserved = { preserved: false, commitSha: null, warning: null } as const;
  try {
    const status = await runGit(["status", "--porcelain", "--untracked-files=all"], input.workspacePath);
    if (!status.trim()) return notPreserved;

    const rescueRef = `${WORKTREE_RESCUE_REF_PREFIX}/${input.workspaceId}`;
    const message =
      `wip(paperclip): preserve uncommitted work from workspace ${input.workspaceId}` +
      `${input.sourceIssueId ? `\n\nIssue: ${input.sourceIssueId}` : ""}` +
      `\nRescue ref: ${rescueRef}` +
      "\n\nCommitted automatically before the worktree was removed. This is not a reviewed change.";

    await runGit(["add", "--all"], input.workspacePath);
    await runGit(
      [...RESCUE_COMMIT_IDENTITY, "commit", "--no-verify", "--message", message],
      input.workspacePath,
    );
    const commitSha = await runGit(["rev-parse", "HEAD"], input.workspacePath);
    await runGit(["update-ref", rescueRef, commitSha], input.workspacePath);
    await pruneExpiredWorktreeRescueRefs(input.workspacePath);

    if (input.recorder) {
      await input.recorder.recordOperation({
        phase: "worktree_cleanup",
        command: formatCommandForDisplay("git", ["commit", "--all"]),
        cwd: input.workspacePath,
        metadata: {
          workspaceId: input.workspaceId,
          workspacePath: input.workspacePath,
          branchName: input.branchName,
          cleanupAction: "preserve_uncommitted_work",
          commitSha,
          rescueRef,
        },
        run: async () => ({
          status: "succeeded",
          exitCode: 0,
          system:
            `Preserved uncommitted work as ${commitSha} before removing the worktree ` +
            `(recoverable from ${rescueRef}${input.branchName ? ` or branch ${input.branchName}` : ""})\n`,
        }),
      });
    }

    return { preserved: true, commitSha, warning: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      preserved: false,
      commitSha: null,
      warning: `Could not preserve uncommitted work in "${input.workspacePath}" before removal: ${message}`,
    };
  }
}

export async function acquireGitWorktreeCleanupLock(worktreePath: string) {
  const branchRef = await runGit(["symbolic-ref", "--quiet", "HEAD"], worktreePath).catch(() => null);
  const rawLocks = await Promise.all([
    runGit(["rev-parse", "--git-path", "index.lock"], worktreePath)
      .then((lockPath) => ({ kind: "index" as const, lockPath })),
    runGit(["rev-parse", "--git-path", "HEAD.lock"], worktreePath)
      .then((lockPath) => ({ kind: "head" as const, lockPath })),
    ...(branchRef
      ? [runGit(["rev-parse", "--git-path", `${branchRef}.lock`], worktreePath)
          .then((lockPath) => ({ kind: "branch" as const, lockPath }))]
      : []),
  ]);
  const locks = [...new Map(rawLocks.map(({ kind, lockPath }) => {
    const resolvedLockPath = path.isAbsolute(lockPath)
      ? lockPath
      : path.resolve(worktreePath, lockPath);
    return [resolvedLockPath, { kind, lockPath: resolvedLockPath }];
  })).values()];
  const lockHandles: Array<{
    handle: fs.FileHandle;
    kind: "index" | "head" | "branch";
    lockPath: string;
  }> = [];

  async function releaseLocks(kind?: "branch") {
    for (let index = lockHandles.length - 1; index >= 0; index -= 1) {
      const lock = lockHandles[index];
      if (!lock || (kind && lock.kind !== kind)) continue;
      lockHandles.splice(index, 1);
      await lock.handle.close().catch(() => {});
      await fs.rm(lock.lockPath, { force: true }).catch(() => {});
    }
  }

  try {
    for (const lock of locks) {
      lockHandles.push({
        ...lock,
        handle: await fs.open(lock.lockPath, "wx", 0o600),
      });
    }
  } catch (error) {
    await releaseLocks();
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("git worktree cleanup lock is already held");
    }
    throw error;
  }

  return {
    // Branch deletion must acquire this native ref lock itself. Callers release
    // only that lock after the guarded worktree removal, while retaining the
    // index and HEAD locks until the whole cleanup transaction finishes.
    releaseBranchRefLock: () => releaseLocks("branch"),
    release: () => releaseLocks(),
  };
}

async function deleteGitBranchAtVerifiedTip(input: {
  repoRoot: string;
  branchName: string;
  expectedHeadSha: string;
  recorder?: WorkspaceOperationRecorder | null;
  metadata: Record<string, unknown>;
}) {
  const commonDirRaw = await runGit(["rev-parse", "--git-common-dir"], input.repoRoot);
  const commonDir = path.isAbsolute(commonDirRaw)
    ? commonDirRaw
    : path.resolve(input.repoRoot, commonDirRaw);
  const detachedGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-branch-delete-"));
  const detachedWorktree = `${detachedGitDir}-worktree`;

  try {
    // `git branch -d` refuses branches checked out by another worktree and its
    // ref transaction fails if the tip changes concurrently. A detached HEAD
    // at the delivered SHA additionally lets squash/cross-branch deliveries
    // delete only the exact branch history that was verified before cleanup.
    await Promise.all([
      fs.writeFile(path.join(detachedGitDir, "HEAD"), `${input.expectedHeadSha}\n`, "utf8"),
      fs.writeFile(path.join(detachedGitDir, "commondir"), `${commonDir}\n`, "utf8"),
    ]);
    await recordGitOperation(input.recorder, {
      phase: "worktree_cleanup",
      args: [
        `--git-dir=${detachedGitDir}`,
        `--work-tree=${detachedWorktree}`,
        "branch",
        "-d",
        input.branchName,
      ],
      cwd: input.repoRoot,
      metadata: input.metadata,
      successMessage: `Deleted branch ${input.branchName}\n`,
      failureLabel: `git branch -d ${input.branchName}`,
    });
  } finally {
    await fs.rm(detachedGitDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function cleanupExecutionWorkspaceArtifacts(input: {
  workspace: {
    id: string;
    cwd: string | null;
    providerType: string;
    providerRef: string | null;
    branchName: string | null;
    repoUrl: string | null;
    baseRef: string | null;
    projectId: string | null;
    projectWorkspaceId: string | null;
    sourceIssueId: string | null;
    metadata?: Record<string, unknown> | null;
  };
  projectWorkspace?: {
    cwd: string | null;
    cleanupCommand: string | null;
  } | null;
  cleanupCommand?: string | null;
  teardownCommand?: string | null;
  recorder?: WorkspaceOperationRecorder | null;
  assertSafeToCleanup?: (() => Promise<void>) | null;
  beforeBranchDelete?: (() => Promise<void>) | null;
  expectedBranchHeadSha?: string | null;
  runCleanupCommands?: boolean;
  forceWorktreeRemoval?: boolean;
}) {
  const warnings: string[] = [];
  const workspacePath = input.workspace.providerRef ?? input.workspace.cwd;
  const repoRoot = input.workspace.providerType === "git_worktree" && workspacePath
    ? await resolveGitRepoRootForWorkspaceCleanup(
      workspacePath,
      input.projectWorkspace?.cwd ?? null,
    )
    : null;
  const cleanupEnv = buildExecutionWorkspaceCleanupEnv({
    workspace: input.workspace,
    projectWorkspaceCwd: input.projectWorkspace?.cwd ?? null,
  });
  // Callers can require the workspace to match an assessed snapshot before
  // cleanup begins. Destructive paths recheck immediately before removal.
  await input.assertSafeToCleanup?.();
  let worktreeInstancePointer: WorktreeInstancePointer | null = null;
  let expectedWorktreeInstanceId: string | null = null;
  if (input.workspace.providerType === "git_worktree" && workspacePath) {
    expectedWorktreeInstanceId = deriveWorktreeInstanceId(workspacePath);
    try {
      // Capture the pointer before custom cleanup commands can remove the repo-local env file.
      worktreeInstancePointer = await readWorktreeInstancePointer(workspacePath);
    } catch (err) {
      warnings.push(`Could not read worktree instance pointer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const createdByRuntime = input.workspace.metadata?.createdByRuntime === true;
  const cleanupCommands = input.runCleanupCommands === false
    ? []
    : [
        input.cleanupCommand ?? null,
        input.projectWorkspace?.cleanupCommand ?? null,
        input.teardownCommand ?? null,
      ]
        .map((value) => asString(value, "").trim())
        .filter(Boolean);

  for (const command of cleanupCommands) {
    try {
      const resolvedCommand = repoRoot
        ? resolveRepoManagedWorkspaceCommand(command, repoRoot)
        : command;
      await recordWorkspaceCommandOperation(input.recorder, {
        phase: "workspace_teardown",
        command,
        resolvedCommand,
        cwd: workspacePath ?? input.projectWorkspace?.cwd ?? process.cwd(),
        env: cleanupEnv,
        label: `Execution workspace cleanup command "${command}"`,
        metadata: {
          workspaceId: input.workspace.id,
          workspacePath,
          branchName: input.workspace.branchName,
          providerType: input.workspace.providerType,
          resolvedCommand: resolvedCommand === command ? null : resolvedCommand,
        },
        successMessage: `Completed cleanup command "${command}"\n`,
      });
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (worktreeInstancePointer && workspacePath && expectedWorktreeInstanceId) {
    try {
      const result = await cleanupWorktreeInstanceArtifacts({
        pointer: worktreeInstancePointer,
        workspaceId: input.workspace.id,
        workspacePath,
        expectedInstanceId: expectedWorktreeInstanceId,
        expectedInstanceRoot:
          typeof input.workspace.metadata?.[WORKTREE_INSTANCE_ROOT_METADATA_KEY] === "string"
            ? input.workspace.metadata[WORKTREE_INSTANCE_ROOT_METADATA_KEY]
            : null,
        recorder: input.recorder,
      });
      if (result.status === "refused") warnings.push(result.warning);
    } catch (err) {
      warnings.push(`Failed to clean worktree instance: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (input.workspace.providerType === "git_worktree" && workspacePath) {
    const worktreeExists = await directoryExists(workspacePath);
    if (worktreeExists) {
      // Runs regularly stop before committing; `worktree remove --force` below would discard that
      // work silently, so put it in the object store first.
      const preservation = await preserveUncommittedWorktreeWork({
        workspacePath,
        workspaceId: input.workspace.id,
        branchName: input.workspace.branchName,
        sourceIssueId: input.workspace.sourceIssueId,
        recorder: input.recorder,
      });
      if (preservation.warning) warnings.push(preservation.warning);

      if (!repoRoot) {
        warnings.push(`Could not resolve git repo root for "${workspacePath}".`);
      } else {
        try {
          await input.assertSafeToCleanup?.();
          await recordGitOperation(input.recorder, {
            phase: "worktree_cleanup",
            args: [
              "worktree",
              "remove",
              ...(input.forceWorktreeRemoval === false ? [] : ["--force"]),
              workspacePath,
            ],
            cwd: repoRoot,
            metadata: {
              workspaceId: input.workspace.id,
              workspacePath,
              branchName: input.workspace.branchName,
              cleanupAction: "worktree_remove",
            },
            successMessage: `Removed git worktree ${workspacePath}\n`,
            failureLabel: `git worktree remove ${workspacePath}`,
          });
        } catch (err) {
          warnings.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
    if (createdByRuntime && input.workspace.branchName) {
      if (!repoRoot) {
        warnings.push(`Could not resolve git repo root to delete branch "${input.workspace.branchName}".`);
      } else {
        try {
          await input.beforeBranchDelete?.();
          const metadata = {
            workspaceId: input.workspace.id,
            workspacePath,
            branchName: input.workspace.branchName,
            cleanupAction: "branch_delete",
          };
          if (input.expectedBranchHeadSha) {
            await deleteGitBranchAtVerifiedTip({
              repoRoot,
              branchName: input.workspace.branchName,
              expectedHeadSha: input.expectedBranchHeadSha,
              recorder: input.recorder,
              metadata,
            });
          } else {
            await recordGitOperation(input.recorder, {
              phase: "worktree_cleanup",
              args: ["branch", "-d", input.workspace.branchName],
              cwd: repoRoot,
              metadata,
              successMessage: `Deleted branch ${input.workspace.branchName}\n`,
              failureLabel: `git branch -d ${input.workspace.branchName}`,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          warnings.push(`Skipped deleting branch "${input.workspace.branchName}": ${message}`);
        }
      }
    }
  } else if (input.workspace.providerType === "local_fs" && createdByRuntime && workspacePath) {
    const projectWorkspaceCwd = input.projectWorkspace?.cwd ? path.resolve(input.projectWorkspace.cwd) : null;
    const resolvedWorkspacePath = path.resolve(workspacePath);
    const containsProjectWorkspace = projectWorkspaceCwd
      ? (
          resolvedWorkspacePath === projectWorkspaceCwd ||
          projectWorkspaceCwd.startsWith(`${resolvedWorkspacePath}${path.sep}`)
        )
      : false;
    if (containsProjectWorkspace) {
      warnings.push(`Refusing to remove path "${workspacePath}" because it contains the project workspace.`);
    } else {
      await input.assertSafeToCleanup?.();
      await fs.rm(resolvedWorkspacePath, { recursive: true, force: true });
      if (input.recorder) {
        await input.recorder.recordOperation({
          phase: "workspace_teardown",
          cwd: projectWorkspaceCwd ?? process.cwd(),
          metadata: {
            workspaceId: input.workspace.id,
            workspacePath: resolvedWorkspacePath,
            cleanupAction: "remove_local_fs",
          },
          run: async () => ({
            status: "succeeded",
            exitCode: 0,
            system: `Removed local workspace directory ${resolvedWorkspacePath}\n`,
          }),
        });
      }
    }
  }

  const cleaned =
    !workspacePath ||
    !(await directoryExists(workspacePath));

  return {
    cleanedPath: workspacePath,
    cleaned,
    warnings,
  };
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("Failed to allocate port"));
          return;
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

function buildTemplateData(input: {
  workspace: RealizedExecutionWorkspace;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  adapterEnv: Record<string, string>;
  port: number | null;
}) {
  return {
    workspace: {
      cwd: input.workspace.cwd,
      branchName: input.workspace.branchName ?? "",
      worktreePath: input.workspace.worktreePath ?? "",
      repoUrl: input.workspace.repoUrl ?? "",
      repoRef: input.workspace.repoRef ?? "",
      env: input.adapterEnv,
    },
    issue: {
      id: input.issue?.id ?? "",
      identifier: input.issue?.identifier ?? "",
      title: input.issue?.title ?? "",
    },
    agent: {
      id: input.agent.id ?? "",
      name: input.agent.name,
    },
    port: input.port ?? "",
  };
}

function renderRuntimeServiceEnv(input: {
  envConfig: Record<string, unknown>;
  templateData: ReturnType<typeof buildTemplateData>;
}) {
  const rendered: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.envConfig)) {
    if (typeof value !== "string") continue;
    rendered[key] = renderTemplate(value, input.templateData);
  }
  return rendered;
}

function resolveRuntimeServiceReuseIdentity(input: {
  service: Record<string, unknown>;
  workspace: RealizedExecutionWorkspace;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  adapterEnv: Record<string, string>;
  scopeType: RuntimeServiceRef["scopeType"];
  scopeId: string | null;
}): {
  serviceName: string;
  lifecycle: RuntimeServiceRef["lifecycle"];
  command: string;
  serviceCwd: string;
  envConfig: Record<string, unknown>;
  envFingerprint: string;
  explicitPort: number;
  identityPort: number | null;
  reuseKey: string | null;
} {
  const serviceName = asString(input.service.name, "service");
  const lifecycle = asString(input.service.lifecycle, "shared") === "ephemeral" ? "ephemeral" : "shared";
  const command = asString(input.service.command, "");
  const serviceCwdTemplate = asString(input.service.cwd, ".");
  const portConfig = parseObject(input.service.port);
  const envConfig = parseObject(input.service.env);
  const explicitPort = asNumber(portConfig.value, asNumber(input.service.port, 0));
  const identityPort = explicitPort > 0 ? explicitPort : null;
  const templateData = buildTemplateData({
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    port: identityPort,
  });
  const serviceCwd = resolveConfiguredPath(renderTemplate(serviceCwdTemplate, templateData), input.workspace.cwd);
  const renderedEnv = renderRuntimeServiceEnv({
    envConfig,
    templateData,
  });
  const envFingerprint = createHash("sha256").update(stableStringify(renderedEnv)).digest("hex");
  const reuseKey =
    lifecycle === "shared"
      ? createHash("sha256")
          .update(
            stableStringify({
              scopeType: input.scopeType,
              scopeId: input.scopeId,
              serviceName,
              command,
              cwd: serviceCwd,
              port: identityPort,
              env: renderedEnv,
            }),
          )
          .digest("hex")
      : null;

  return {
    serviceName,
    lifecycle,
    command,
    serviceCwd,
    envConfig,
    envFingerprint,
    explicitPort,
    identityPort,
    reuseKey,
  };
}

function resolveWorkspaceCommandExecution(input: {
  command: Record<string, unknown>;
  workspace: RealizedExecutionWorkspace;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  adapterEnv: Record<string, string>;
}) {
  const name =
    asString(input.command.name, "")
    || asString(input.command.label, "")
    || asString(input.command.title, "")
    || "workspace command";
  const command = asString(input.command.command, "");
  const templateData = buildTemplateData({
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    port: null,
  });
  const cwd = resolveConfiguredPath(
    renderTemplate(asString(input.command.cwd, "."), templateData),
    input.workspace.cwd,
  );
  const env = {
    ...sanitizeRuntimeServiceBaseEnv(process.env),
    ...input.adapterEnv,
    ...renderRuntimeServiceEnv({
      envConfig: parseObject(input.command.env),
      templateData,
    }),
  } as Record<string, string>;

  return {
    name,
    command,
    cwd,
    env,
  };
}

export async function runWorkspaceJobForControl(input: {
  actor: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  command: Record<string, unknown>;
  adapterEnv?: Record<string, string>;
  recorder?: WorkspaceOperationRecorder | null;
  metadata?: Record<string, unknown> | null;
}) {
  const resolved = resolveWorkspaceCommandExecution({
    command: input.command,
    workspace: input.workspace,
    agent: input.actor,
    issue: input.issue,
    adapterEnv: input.adapterEnv ?? {},
  });
  if (!resolved.command) {
    throw new Error(`Workspace job "${resolved.name}" is missing command`);
  }

  await ensureServerWorkspaceLinksCurrent(resolved.cwd);
  return await recordWorkspaceCommandOperation(input.recorder, {
    phase: "workspace_provision",
    command: resolved.command,
    cwd: resolved.cwd,
    env: resolved.env,
    label: `Workspace job "${resolved.name}"`,
    metadata: {
      workspaceCommandKind: "job",
      workspaceCommandName: resolved.name,
      ...(input.metadata ?? {}),
    },
    successMessage: `Completed workspace job "${resolved.name}"\n`,
  });
}

function resolveServiceScopeId(input: {
  service: Record<string, unknown>;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  issue: ExecutionWorkspaceIssueRef | null;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
}): {
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
} {
  const scopeTypeRaw = asString(input.service.reuseScope, input.service.lifecycle === "shared" ? "project_workspace" : "run");
  const scopeType =
    scopeTypeRaw === "project_workspace" ||
    scopeTypeRaw === "execution_workspace" ||
    scopeTypeRaw === "agent"
      ? scopeTypeRaw
      : "run";
  if (scopeType === "project_workspace") return { scopeType, scopeId: input.workspace.workspaceId ?? input.workspace.projectId };
  if (scopeType === "execution_workspace") {
    return { scopeType, scopeId: input.executionWorkspaceId ?? input.workspace.cwd };
  }
  if (scopeType === "agent") return { scopeType, scopeId: input.agent.id };
  return { scopeType: "run" as const, scopeId: input.runId };
}

function looksLikeWorkspaceDevServerCommand(command: string) {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return false;
  return /(?:^|\s)(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?dev(?:\s|$)/.test(normalized);
}

export function resolveWorkspaceRuntimeReadinessTimeoutSec(service: Record<string, unknown>) {
  const readiness = parseObject(service.readiness);
  const explicitTimeoutSec = asNumber(readiness.timeoutSec, 0);
  if (explicitTimeoutSec > 0) {
    return Math.max(1, explicitTimeoutSec);
  }
  return looksLikeWorkspaceDevServerCommand(asString(service.command, "")) ? 90 : 30;
}

function isReadinessProbeTimeout(err: unknown) {
  // AbortSignal.timeout rejects with a TimeoutError DOMException; undici can
  // also surface the abort as a plain AbortError.
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

// Exported for tests only, alongside resolveWorkspaceRuntimeReadinessTimeoutSec.
export async function waitForReadiness(input: {
  service: Record<string, unknown>;
  serviceName?: string | null;
  command?: string | null;
  url: string | null;
  readinessUrl: string | null;
}) {
  const readiness = parseObject(input.service.readiness);
  const readinessType = asString(readiness.type, "");
  const readinessTargetUrl = input.readinessUrl ?? input.url;
  if (readinessType !== "http" || !readinessTargetUrl) return;
  const readinessUrl = resolveRuntimeServiceHealthUrl(readinessTargetUrl, {
    serviceName: input.serviceName,
    command: input.command,
  });
  if (!readinessUrl) {
    throw new Error(`Readiness check failed: could not resolve health URL for ${input.url}`);
  }
  const timeoutSec = resolveWorkspaceRuntimeReadinessTimeoutSec(input.service);
  const intervalMs = Math.max(100, asNumber(readiness.intervalMs, 500));
  // Each probe needs its own bound. `fetch` has no default timeout, and a
  // connect to a not-yet-listening port can stall for tens of seconds on a
  // loaded host instead of refusing immediately. The loop only re-checks the
  // deadline between attempts, so one stalled probe consumed the entire budget
  // and reported a service dead after a single attempt — while it was in fact
  // listening and healthy. Capping well under the total makes a stall cost one
  // retry instead of the whole window.
  const probeBudgetMs = Math.max(1_000, intervalMs * 4);
  // A probe also needs enough budget left to mean anything. The loop clamps the
  // per-probe bound to the time remaining, so an attempt that starts a
  // millisecond before the deadline is aborted before the socket can answer and
  // then overwrites the real diagnostic (`received HTTP 503`, a refused
  // connection) with a misleading `probe timed out after 1ms`. Give every probe
  // at least one interval, and stop early rather than issue one that can only
  // fail.
  const minProbeBudgetMs = Math.min(probeBudgetMs, intervalMs);
  const deadline = Date.now() + timeoutSec * 1000;
  let lastError = "service did not become ready";
  let probed = false;
  while (Date.now() < deadline) {
    const probeTimeoutMs = Math.min(probeBudgetMs, deadline - Date.now());
    if (probed && probeTimeoutMs < minProbeBudgetMs) break;
    probed = true;
    try {
      const response = await fetch(readinessUrl, { signal: AbortSignal.timeout(probeTimeoutMs) });
      if (response.ok) return;
      lastError = `received HTTP ${response.status}`;
    } catch (err) {
      lastError = isReadinessProbeTimeout(err)
        ? `probe timed out after ${probeTimeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    }
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Readiness check failed for ${readinessUrl}: ${lastError}`);
}

function isPaperclipDevRuntimeService(input: { serviceName?: string | null; command?: string | null }) {
  const serviceName = (input.serviceName ?? "").trim().toLowerCase();
  const command = (input.command ?? "").trim().toLowerCase();
  return (
    serviceName === "paperclip-dev"
    || serviceName === "paperclip-dev-once"
    || (command.includes("dev:once") && command.includes("tailscale-auth"))
  );
}

function resolveRuntimeServiceHealthUrl(
  url: string | null,
  input?: { serviceName?: string | null; command?: string | null },
) {
  if (!url || !isPaperclipDevRuntimeService(input ?? {})) return url;
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "/" || parsed.pathname === "") {
      parsed.pathname = "/api/health";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
  } catch {
    return url;
  }
  return url;
}

async function isRuntimeServiceUrlHealthy(
  url: string | null,
  input?: { serviceName?: string | null; command?: string | null },
) {
  if (!url) return true;
  const healthUrl = resolveRuntimeServiceHealthUrl(url, input);
  if (!healthUrl) return false;
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function toPersistedWorkspaceRuntimeService(record: RuntimeServiceRecord): typeof workspaceRuntimeServices.$inferInsert {
  return {
    id: record.id,
    companyId: record.companyId,
    projectId: record.projectId,
    projectWorkspaceId: record.projectWorkspaceId,
    executionWorkspaceId: record.executionWorkspaceId,
    issueId: record.issueId,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    serviceName: record.serviceName,
    status: record.status,
    lifecycle: record.lifecycle,
    reuseKey: record.reuseKey,
    command: record.command,
    cwd: record.cwd,
    port: record.port,
    url: record.url,
    provider: record.provider,
    providerRef: record.providerRef,
    ownerAgentId: record.ownerAgentId,
    startedByRunId: record.startedByRunId,
    lastUsedAt: new Date(record.lastUsedAt),
    startedAt: new Date(record.startedAt),
    stoppedAt: record.stoppedAt ? new Date(record.stoppedAt) : null,
    stopPolicy: record.stopPolicy,
    healthStatus: record.healthStatus,
    updatedAt: new Date(),
  };
}

async function persistRuntimeServiceRecord(db: Db | undefined, record: RuntimeServiceRecord) {
  if (!db) return;
  const values = toPersistedWorkspaceRuntimeService(record);
  await db
    .insert(workspaceRuntimeServices)
    .values(values)
    .onConflictDoUpdate({
      target: workspaceRuntimeServices.id,
      set: {
        projectId: values.projectId,
        projectWorkspaceId: values.projectWorkspaceId,
        executionWorkspaceId: values.executionWorkspaceId,
        issueId: values.issueId,
        scopeType: values.scopeType,
        scopeId: values.scopeId,
        serviceName: values.serviceName,
        status: values.status,
        lifecycle: values.lifecycle,
        reuseKey: values.reuseKey,
        command: values.command,
        cwd: values.cwd,
        port: values.port,
        url: values.url,
        provider: values.provider,
        providerRef: values.providerRef,
        ownerAgentId: values.ownerAgentId,
        startedByRunId: values.startedByRunId,
        lastUsedAt: values.lastUsedAt,
        startedAt: values.startedAt,
        stoppedAt: values.stoppedAt,
        stopPolicy: values.stopPolicy,
        healthStatus: values.healthStatus,
        updatedAt: values.updatedAt,
      },
    });
}

async function findStoppedRuntimeServiceReuseCandidate(input: {
  db?: Db;
  companyId: string;
  reuseKey: string | null;
  serviceName: string;
  command: string;
  cwd: string;
  scopeType: RuntimeServiceRef["scopeType"];
  scopeId: string | null;
}): Promise<StoppedRuntimeServiceReuseCandidate | null> {
  if (!input.db) return null;
  if (input.reuseKey) {
    const row = await input.db
      .select({
        id: workspaceRuntimeServices.id,
        port: workspaceRuntimeServices.port,
      })
      .from(workspaceRuntimeServices)
      .where(
        and(
          eq(workspaceRuntimeServices.companyId, input.companyId),
          eq(workspaceRuntimeServices.reuseKey, input.reuseKey),
          eq(workspaceRuntimeServices.provider, "local_process"),
          eq(workspaceRuntimeServices.status, "stopped"),
        ),
      )
      .orderBy(desc(workspaceRuntimeServices.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (row) return row;
  }

  const scopeIdCondition = input.scopeId === null
    ? isNull(workspaceRuntimeServices.scopeId)
    : eq(workspaceRuntimeServices.scopeId, input.scopeId);
  const row = await input.db
    .select({
      id: workspaceRuntimeServices.id,
      port: workspaceRuntimeServices.port,
    })
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.companyId, input.companyId),
        eq(workspaceRuntimeServices.provider, "local_process"),
        eq(workspaceRuntimeServices.status, "stopped"),
        eq(workspaceRuntimeServices.scopeType, input.scopeType),
        scopeIdCondition,
        eq(workspaceRuntimeServices.serviceName, input.serviceName),
        eq(workspaceRuntimeServices.command, input.command),
        eq(workspaceRuntimeServices.cwd, input.cwd),
      ),
    )
    .orderBy(desc(workspaceRuntimeServices.updatedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return row ?? null;
}

function clearIdleTimer(record: RuntimeServiceRecord) {
  if (!record.idleTimer) return;
  clearTimeout(record.idleTimer);
  record.idleTimer = null;
}

export function normalizeAdapterManagedRuntimeServices(input: {
  adapterType: string;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  reports: AdapterRuntimeServiceReport[];
  now?: Date;
}): RuntimeServiceRef[] {
  const nowIso = (input.now ?? new Date()).toISOString();
  return input.reports.map((report) => {
    const scopeType = report.scopeType ?? "run";
    const scopeId =
      report.scopeId ??
      (scopeType === "project_workspace"
        ? input.workspace.workspaceId
        : scopeType === "execution_workspace"
          ? input.executionWorkspaceId ?? input.workspace.cwd
          : scopeType === "agent"
            ? input.agent.id
            : input.runId) ??
      null;
    const serviceName = asString(report.serviceName, "").trim() || "service";
    const status = report.status ?? "running";
    const lifecycle = report.lifecycle ?? "ephemeral";
    const healthStatus =
      report.healthStatus ??
      (status === "running" ? "healthy" : status === "failed" ? "unhealthy" : "unknown");
    return {
      id: stableRuntimeServiceId({
        adapterType: input.adapterType,
        runId: input.runId,
        scopeType,
        scopeId,
        serviceName,
        reportId: report.id ?? null,
        providerRef: report.providerRef ?? null,
        reuseKey: report.reuseKey ?? null,
      }),
      companyId: input.agent.companyId,
      projectId: report.projectId ?? input.workspace.projectId,
      projectWorkspaceId: report.projectWorkspaceId ?? input.workspace.workspaceId,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      issueId: report.issueId ?? input.issue?.id ?? null,
      serviceName,
      status,
      lifecycle,
      scopeType,
      scopeId,
      reuseKey: report.reuseKey ?? null,
      command: report.command ?? null,
      cwd: report.cwd ?? null,
      port: report.port ?? null,
      url: report.url ?? null,
      provider: "adapter_managed",
      providerRef: report.providerRef ?? null,
      ownerAgentId: report.ownerAgentId ?? input.agent.id ?? null,
      startedByRunId: input.runId,
      lastUsedAt: nowIso,
      startedAt: nowIso,
      stoppedAt: status === "running" || status === "starting" ? null : nowIso,
      stopPolicy: report.stopPolicy ?? null,
      healthStatus,
      reused: false,
    };
  });
}

type StartLocalRuntimeServiceInput = {
  db?: Db;
  runId: string;
  leaseRunId?: string | null;
  startedByRunId?: string | null;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  adapterEnv: Record<string, string>;
  service: Record<string, unknown>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  runtimeProvisionCommand?: string | null;
  recorder?: WorkspaceOperationRecorder | null;
  provisionCoordinator?: RuntimeProvisionCoordinator;
  preparedProvisioningRecord?: RuntimeServiceRecord | null;
  runtimeServiceId?: string;
  reuseKey: string | null;
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
};

type RuntimeProvisionCoordinator = {
  promise: Promise<void> | null;
};

function createRuntimeProvisionCoordinator(): RuntimeProvisionCoordinator {
  return { promise: null };
}

function readRuntimeProvisionCommand(config: Record<string, unknown>) {
  const workspaceStrategy = parseObject(config.workspaceStrategy);
  return asString(
    config.runtimeProvisionCommand,
    asString(workspaceStrategy.runtimeProvisionCommand, ""),
  ).trim();
}

export function resolveRuntimeProvisionCommand(input: {
  config: Record<string, unknown>;
  workspace: RealizedExecutionWorkspace;
}) {
  const configuredCommand = readRuntimeProvisionCommand(input.config);
  if (configuredCommand) return configuredCommand;

  if (input.workspace.strategy !== "git_worktree") return "";

  const stateDir = path.join(input.workspace.cwd, ".paperclip");
  const pendingMarker = path.join(stateDir, "seed-pending");
  const completeMarker = path.join(stateDir, "seed-complete");
  const provisionScript = path.join(
    input.workspace.baseCwd,
    "scripts",
    "provision-worktree-runtime.sh",
  );
  if (
    !existsSync(pendingMarker)
    || existsSync(completeMarker)
    || !existsSync(provisionScript)
  ) {
    return "";
  }

  return "bash ./scripts/provision-worktree-runtime.sh";
}

function runtimeProvisionWorkspaceKey(input: StartLocalRuntimeServiceInput) {
  return input.executionWorkspaceId
    ? `execution-workspace:${input.executionWorkspaceId}`
    : input.workspace.workspaceId
      ? `project-workspace:${input.workspace.workspaceId}`
      : `cwd:${path.resolve(input.workspace.cwd)}`;
}

async function runRuntimeProvisionWithWorkspaceMutex(input: StartLocalRuntimeServiceInput) {
  const command = asString(input.runtimeProvisionCommand, "").trim();
  if (!command) return;

  const workspaceKey = runtimeProvisionWorkspaceKey(input);
  const existing = runtimeProvisionByWorkspace.get(workspaceKey);
  if (existing) {
    await existing;
    return;
  }

  const recorder = input.recorder ?? (input.db
    ? workspaceOperationService(input.db).createRecorder({
        companyId: input.agent.companyId,
        heartbeatRunId: input.startedByRunId === undefined ? input.runId : input.startedByRunId,
        executionWorkspaceId: input.executionWorkspaceId ?? null,
        issueId: input.issue?.id ?? null,
      })
    : null);
  const resolvedCommand = resolveRepoManagedWorkspaceCommand(command, input.workspace.baseCwd);
  const promise = recordWorkspaceCommandOperation(recorder, {
    phase: "workspace_runtime_provision",
    command,
    resolvedCommand,
    cwd: input.workspace.cwd,
    env: buildWorkspaceCommandEnv({
      base: input.workspace,
      repoRoot: input.workspace.baseCwd,
      worktreePath: input.workspace.cwd,
      branchName: input.workspace.branchName ?? "",
      issue: input.issue,
      agent: input.agent,
      created: input.workspace.created,
    }),
    label: `Runtime provision command "${command}"`,
    metadata: {
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      projectWorkspaceId: input.workspace.workspaceId,
      serviceName: asString(input.service.name, "service"),
      resolvedCommand: resolvedCommand === command ? null : resolvedCommand,
    },
    successMessage: `Provisioned runtime dependencies for ${input.workspace.cwd}\n`,
    onLog: input.onLog,
  }).then(() => undefined);

  runtimeProvisionByWorkspace.set(workspaceKey, promise);
  try {
    await promise;
  } finally {
    if (runtimeProvisionByWorkspace.get(workspaceKey) === promise) {
      runtimeProvisionByWorkspace.delete(workspaceKey);
    }
  }
}

function createProvisioningRuntimeServiceRecord(
  input: StartLocalRuntimeServiceInput,
  identity: ReturnType<typeof resolveRuntimeServiceReuseIdentity>,
): RuntimeServiceRecord {
  const nowIso = new Date().toISOString();
  const id = input.runtimeServiceId ?? randomUUID();
  return {
    id,
    companyId: input.agent.companyId,
    projectId: input.workspace.projectId,
    projectWorkspaceId: input.workspace.workspaceId,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    issueId: input.issue?.id ?? null,
    serviceName: identity.serviceName,
    status: "provisioning",
    lifecycle: identity.lifecycle,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    reuseKey: input.reuseKey,
    command: identity.command,
    cwd: identity.serviceCwd,
    port: identity.identityPort,
    url: null,
    provider: "local_process",
    providerRef: null,
    ownerAgentId: input.agent.id ?? null,
    startedByRunId: input.startedByRunId === undefined ? input.runId : input.startedByRunId,
    lastUsedAt: nowIso,
    startedAt: nowIso,
    stoppedAt: null,
    stopPolicy: parseObject(input.service.stopPolicy),
    healthStatus: "unknown",
    reused: false,
    db: input.db,
    child: null,
    leaseRunIds: new Set(),
    idleTimer: null,
    envFingerprint: identity.envFingerprint,
    serviceKey: `runtime-provision:${runtimeProvisionWorkspaceKey(input)}:${id}`,
    profileKind: "workspace-runtime",
    processGroupId: null,
  };
}

async function spawnLocalRuntimeService(input: StartLocalRuntimeServiceInput): Promise<LocalRuntimeServiceStart> {
  const leaseRunId = input.leaseRunId === undefined ? input.runId : input.leaseRunId;
  const startedByRunId = input.startedByRunId === undefined ? input.runId : input.startedByRunId;
  const identity = resolveRuntimeServiceReuseIdentity({
    service: input.service,
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
  });
  const serviceName = identity.serviceName;
  const lifecycle = identity.lifecycle;
  const command = identity.command;
  if (!command) throw new Error(`Runtime service "${serviceName}" is missing command`);
  const portConfig = parseObject(input.service.port);
  const envConfig = identity.envConfig;
  const envFingerprint = identity.envFingerprint;
  const serviceIdentityFingerprint = input.reuseKey ?? envFingerprint;
  const explicitPort = identity.explicitPort;
  const identityPort = identity.identityPort;
  const stoppedReuseCandidate = await findStoppedRuntimeServiceReuseCandidate({
    db: input.db,
    companyId: input.agent.companyId,
    reuseKey: input.reuseKey,
    serviceName,
    command,
    cwd: identity.serviceCwd,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
  });
  let reusableStoppedPort: number | null = null;
  if (asString(portConfig.type, "") === "auto" && stoppedReuseCandidate?.port) {
    const ownerPid = await readLocalServicePortOwner(stoppedReuseCandidate.port);
    reusableStoppedPort = ownerPid ? null : stoppedReuseCandidate.port;
  }
  const port =
    asString(portConfig.type, "") === "auto"
      ? (reusableStoppedPort ?? await allocatePort())
      : explicitPort > 0
        ? explicitPort
        : null;
  const templateData = buildTemplateData({
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    port,
  });
  const serviceCwd =
    port === identityPort
      ? identity.serviceCwd
      : resolveConfiguredPath(renderTemplate(asString(input.service.cwd, "."), templateData), input.workspace.cwd);
  const env: Record<string, string> = {
    ...sanitizeRuntimeServiceBaseEnv(process.env),
    ...input.adapterEnv,
  } as Record<string, string>;
  for (const [key, value] of Object.entries(renderRuntimeServiceEnv({ envConfig, templateData }))) {
    env[key] = value;
  }
  if (port) {
    const portEnvKey = asString(portConfig.envKey, "PORT");
    env[portEnvKey] = String(port);
  }

  const expose = parseObject(input.service.expose);
  const readiness = parseObject(input.service.readiness);
  const urlTemplate =
    asString(expose.urlTemplate, "") ||
    asString(readiness.urlTemplate, "");
  const url = urlTemplate ? renderTemplate(urlTemplate, templateData) : null;
  const readinessUrlTemplate = asString(readiness.urlTemplate, "");
  const readinessUrl = readinessUrlTemplate ? renderTemplate(readinessUrlTemplate, templateData) : null;
  const stopPolicy = parseObject(input.service.stopPolicy);
  const serviceKey = createLocalServiceKey({
    profileKind: "workspace-runtime",
    serviceName,
    cwd: serviceCwd,
    command,
    envFingerprint: serviceIdentityFingerprint,
    port: identityPort,
    scope: {
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      reuseKey: input.reuseKey,
    },
  });
  const adoptedRecord = await findAdoptableLocalService({
    serviceKey,
    profileKind: "workspace-runtime",
    serviceName,
    command,
    cwd: serviceCwd,
    envFingerprint: serviceIdentityFingerprint,
    port: port ?? identityPort,
    url,
  });
  if (adoptedRecord) {
    const adoptedUrl = adoptedRecord.url ?? url;
    if (!(await isRuntimeServiceUrlHealthy(adoptedUrl, { serviceName, command }))) {
      await terminateLocalService(adoptedRecord);
      await removeLocalServiceRegistryRecord(adoptedRecord.serviceKey);
    } else {
      return {
        record: {
          id: adoptedRecord.runtimeServiceId ?? randomUUID(),
          companyId: input.agent.companyId,
          projectId: input.workspace.projectId,
          projectWorkspaceId: input.workspace.workspaceId,
          executionWorkspaceId: input.executionWorkspaceId ?? null,
          issueId: input.issue?.id ?? null,
          serviceName,
          status: "running",
          lifecycle,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          reuseKey: input.reuseKey,
          command,
          cwd: serviceCwd,
          port: adoptedRecord.port ?? port,
          url: adoptedRecord.url ?? url,
          provider: "local_process",
          providerRef: String(adoptedRecord.pid),
          ownerAgentId: input.agent.id ?? null,
          startedByRunId,
          lastUsedAt: new Date().toISOString(),
          startedAt: adoptedRecord.startedAt,
          stoppedAt: null,
          stopPolicy,
          healthStatus: "healthy",
          reused: true,
          db: input.db,
          child: null,
          leaseRunIds: leaseRunId ? new Set([leaseRunId]) : new Set(),
          idleTimer: null,
          envFingerprint,
          serviceKey,
          profileKind: "workspace-runtime",
          processGroupId: adoptedRecord.processGroupId ?? null,
        },
        readiness: Promise.resolve(),
      };
    }
  }
  if (identityPort) {
      const ownerPid = await readLocalServicePortOwner(identityPort);
    if (ownerPid) {
      const ownerCwd = await readLocalServiceProcessCwd(ownerPid);
      const ownerIsInWorkspace = ownerCwd
        ? await isLocalServiceProcessInWorkspace(ownerCwd, serviceCwd)
        : null;
      const ownerDescription = ownerCwd ? `pid ${ownerPid} (cwd: ${ownerCwd})` : `pid ${ownerPid} (cwd unavailable)`;
      if (ownerIsInWorkspace === false) {
        throw new Error(
          `Runtime service "${serviceName}" could not start because port ${identityPort} has a cross-workspace port conflict with ${ownerDescription}; requested workspace: ${serviceCwd}. Stop the other service or configure a different port.`,
        );
      }
      throw new Error(
        `Runtime service "${serviceName}" could not start because port ${identityPort} is already in use by ${ownerDescription}`,
      );
    }
  }

  await ensureServerWorkspaceLinksCurrent(serviceCwd, {
    onLog: input.onLog,
  });

  const shell = resolveShell();
  const child = spawn(shell, ["-lc", command], {
    cwd: serviceCwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const spawnErrorPromise = new Promise<never>((_, reject) => {
    child.once("error", (err) => {
      reject(err);
    });
  });
  let stderrExcerpt = "";
  let stdoutExcerpt = "";
  child.stdout?.on("data", async (chunk) => {
    const text = String(chunk);
    stdoutExcerpt = (stdoutExcerpt + text).slice(-4096);
    if (input.onLog) await input.onLog("stdout", `[service:${serviceName}] ${text}`);
  });
  child.stderr?.on("data", async (chunk) => {
    const text = String(chunk);
    stderrExcerpt = (stderrExcerpt + text).slice(-4096);
    if (input.onLog) await input.onLog("stderr", `[service:${serviceName}] ${text}`);
  });

  const nowIso = new Date().toISOString();
  const record: RuntimeServiceRecord = {
    id: input.runtimeServiceId ?? stoppedReuseCandidate?.id ?? randomUUID(),
    companyId: input.agent.companyId,
    projectId: input.workspace.projectId,
    projectWorkspaceId: input.workspace.workspaceId,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    issueId: input.issue?.id ?? null,
    serviceName,
    status: "starting",
    lifecycle,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    reuseKey: input.reuseKey,
    command,
    cwd: serviceCwd,
    port,
    url,
    provider: "local_process",
    providerRef: child.pid ? String(child.pid) : null,
    ownerAgentId: input.agent.id ?? null,
    startedByRunId,
    lastUsedAt: nowIso,
    startedAt: nowIso,
    stoppedAt: null,
    stopPolicy,
    healthStatus: "unknown",
    reused: false,
    db: input.db,
    child,
    leaseRunIds: leaseRunId ? new Set([leaseRunId]) : new Set(),
    idleTimer: null,
    envFingerprint,
    serviceKey,
    profileKind: "workspace-runtime",
    processGroupId: child.pid ?? null,
  };

  if (child.pid) {
    await writeLocalServiceRegistryRecord({
      version: 1,
      serviceKey,
      profileKind: "workspace-runtime",
      serviceName,
      command,
      cwd: serviceCwd,
      envFingerprint: serviceIdentityFingerprint,
      port,
      url,
      pid: child.pid,
      processGroupId: child.pid,
      provider: "local_process",
      runtimeServiceId: record.id,
      reuseKey: input.reuseKey,
      startedAt: record.startedAt,
      lastSeenAt: record.lastUsedAt,
      metadata: {
        projectId: record.projectId,
        projectWorkspaceId: record.projectWorkspaceId,
        executionWorkspaceId: record.executionWorkspaceId,
        issueId: record.issueId,
        scopeType: record.scopeType,
        scopeId: record.scopeId,
      },
    });
  }

  const readinessPromise = Promise.race([
    waitForReadiness({ service: input.service, serviceName, command, url, readinessUrl }),
    spawnErrorPromise,
  ]).then(async () => {
    record.status = "running";
    record.healthStatus = "healthy";
    record.lastUsedAt = new Date().toISOString();
    record.stoppedAt = null;
    await touchLocalServiceRegistryRecord(record.serviceKey, {
      runtimeServiceId: record.id,
      lastSeenAt: record.lastUsedAt,
    });
  }).catch(async (err) => {
    terminateChildProcess(child);
    record.status = "stopped";
    record.healthStatus = "unhealthy";
    record.lastUsedAt = new Date().toISOString();
    record.stoppedAt = new Date().toISOString();
    await removeLocalServiceRegistryRecord(record.serviceKey).catch(() => undefined);
    throw new Error(
      `Failed to start runtime service "${serviceName}": ${err instanceof Error ? err.message : String(err)}${stderrExcerpt ? ` | stderr: ${stderrExcerpt.trim()}` : ""}`,
    );
  });

  return { record, readiness: readinessPromise };
}

async function prepareRuntimeProvisioning(
  input: StartLocalRuntimeServiceInput,
): Promise<RuntimeServiceRecord | null> {
  const runtimeProvisionCommand = asString(input.runtimeProvisionCommand, "").trim();
  if (!runtimeProvisionCommand) return null;
  const coordinator = input.provisionCoordinator ?? createRuntimeProvisionCoordinator();
  if (coordinator.promise) {
    await coordinator.promise;
    return null;
  }

  const identity = resolveRuntimeServiceReuseIdentity({
    service: input.service,
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
  });
  if (!identity.command) throw new Error(`Runtime service "${identity.serviceName}" is missing command`);
  const provisioningRecord = createProvisioningRuntimeServiceRecord(input, identity);
  await persistRuntimeServiceRecord(input.db, provisioningRecord);
  if (input.onLog) {
    await input.onLog(
      "stdout",
      `[service:${identity.serviceName}] provisioning runtime dependencies...\n`,
    );
  }

  try {
    coordinator.promise = runRuntimeProvisionWithWorkspaceMutex(input);
    await coordinator.promise;
    provisioningRecord.status = "starting";
    provisioningRecord.lastUsedAt = new Date().toISOString();
    await persistRuntimeServiceRecord(input.db, provisioningRecord);
    return provisioningRecord;
  } catch (error) {
    const nowIso = new Date().toISOString();
    provisioningRecord.status = "failed";
    provisioningRecord.healthStatus = "unhealthy";
    provisioningRecord.lastUsedAt = nowIso;
    provisioningRecord.stoppedAt = nowIso;
    await persistRuntimeServiceRecord(input.db, provisioningRecord).catch(() => undefined);
    if (input.onLog) {
      await input.onLog(
        "stderr",
        `[service:${provisioningRecord.serviceName}] runtime provisioning failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    throw error;
  }
}

async function startLocalRuntimeService(
  input: StartLocalRuntimeServiceInput,
  options?: { deferReadiness?: boolean },
): Promise<LocalRuntimeServiceStart> {
  const runtimeProvisionCommand = asString(input.runtimeProvisionCommand, "").trim();
  const provisioningRecord = input.preparedProvisioningRecord === undefined
    ? await prepareRuntimeProvisioning(input)
    : input.preparedProvisioningRecord;
  let started: LocalRuntimeServiceStart | null = null;

  try {
    started = await spawnLocalRuntimeService({
      ...input,
      runtimeServiceId: provisioningRecord?.id ?? input.runtimeServiceId,
    });
    if (runtimeProvisionCommand) {
      await persistRuntimeServiceRecord(input.db, started.record);
    }
    if (provisioningRecord && started.record.id !== provisioningRecord.id && input.db) {
      await input.db
        .delete(workspaceRuntimeServices)
        .where(eq(workspaceRuntimeServices.id, provisioningRecord.id));
    }
    if (!options?.deferReadiness) {
      await started.readiness;
    }
    return started;
  } catch (error) {
    if (!started && provisioningRecord && provisioningRecord.status === "starting") {
      const nowIso = new Date().toISOString();
      provisioningRecord.status = "failed";
      provisioningRecord.healthStatus = "unhealthy";
      provisioningRecord.lastUsedAt = nowIso;
      provisioningRecord.stoppedAt = nowIso;
      await persistRuntimeServiceRecord(input.db, provisioningRecord).catch(() => undefined);
    }
    throw error;
  }
}

function scheduleIdleStop(record: RuntimeServiceRecord) {
  clearIdleTimer(record);
  const stopType = asString(record.stopPolicy?.type, "manual");
  if (stopType !== "idle_timeout") return;
  const idleSeconds = Math.max(1, asNumber(record.stopPolicy?.idleSeconds, 1800));
  record.idleTimer = setTimeout(() => {
    stopRuntimeService(record.id).catch(() => undefined);
  }, idleSeconds * 1000);
}

async function stopRuntimeService(serviceId: string) {
  const record = runtimeServicesById.get(serviceId);
  if (!record) return;
  clearIdleTimer(record);
  record.status = "stopped";
  record.healthStatus = "unknown";
  record.lastUsedAt = new Date().toISOString();
  record.stoppedAt = new Date().toISOString();
  runtimeServicesById.delete(serviceId);
  if (record.reuseKey && runtimeServicesByReuseKey.get(record.reuseKey) === record.id) {
    runtimeServicesByReuseKey.delete(record.reuseKey);
  }
  if (record.child && record.child.pid) {
    await terminateLocalService({
      pid: record.child.pid,
      processGroupId: record.processGroupId ?? record.child.pid,
    });
  } else if (record.providerRef) {
    const pid = parseInt(record.providerRef, 10);
    if (Number.isInteger(pid) && pid > 0) {
      await terminateLocalService({
        pid,
        processGroupId: record.processGroupId,
      });
    }
  }
  await removeLocalServiceRegistryRecord(record.serviceKey);
  await persistRuntimeServiceRecord(record.db, record);
}

async function markPersistedRuntimeServicesStoppedForExecutionWorkspace(input: {
  db: Db;
  executionWorkspaceId: string;
}) {
  const now = new Date();
  await input.db
    .update(workspaceRuntimeServices)
    .set({
      status: "stopped",
      healthStatus: "unknown",
      stoppedAt: now,
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(workspaceRuntimeServices.executionWorkspaceId, input.executionWorkspaceId),
        inArray(workspaceRuntimeServices.status, ["provisioning", "starting", "running"]),
      ),
    );
}

function registerRuntimeService(db: Db | undefined, record: RuntimeServiceRecord) {
  record.db = db;
  runtimeServicesById.set(record.id, record);
  if (record.reuseKey) {
    runtimeServicesByReuseKey.set(record.reuseKey, record.id);
  }

  record.child?.on("exit", (code, signal) => {
    const current = runtimeServicesById.get(record.id);
    if (!current) return;
    clearIdleTimer(current);
    current.status = code === 0 || signal === "SIGTERM" ? "stopped" : "failed";
    current.healthStatus = current.status === "failed" ? "unhealthy" : "unknown";
    current.lastUsedAt = new Date().toISOString();
    current.stoppedAt = new Date().toISOString();
    runtimeServicesById.delete(current.id);
    if (current.reuseKey && runtimeServicesByReuseKey.get(current.reuseKey) === current.id) {
      runtimeServicesByReuseKey.delete(current.reuseKey);
    }
    void removeLocalServiceRegistryRecord(current.serviceKey);
    void persistRuntimeServiceRecord(db, current);
  });
}

function readRuntimeServiceEntries(config: Record<string, unknown>) {
  return listWorkspaceServiceCommandDefinitions(parseObject(config.workspaceRuntime))
    .map((command) => command.rawConfig);
}

export function listConfiguredRuntimeServiceEntries(config: Record<string, unknown>) {
  return readRuntimeServiceEntries(config);
}

function readConfiguredServiceStates(config: Record<string, unknown>) {
  const raw = parseObject(config.serviceStates);
  const states: WorkspaceRuntimeServiceStateMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === "running" || value === "stopped" || value === "manual") {
      states[key] = value;
    }
  }
  return states;
}

function readDesiredRuntimeState(value: unknown): WorkspaceRuntimeDesiredState | null {
  return value === "running" || value === "stopped" || value === "manual" ? value : null;
}

export function buildWorkspaceRuntimeDesiredStatePatch(input: {
  config: Record<string, unknown>;
  currentDesiredState: WorkspaceRuntimeDesiredState | null;
  currentServiceStates: WorkspaceRuntimeServiceStateMap | null | undefined;
  action: "start" | "stop" | "restart";
  serviceIndex?: number | null;
}): {
  desiredState: WorkspaceRuntimeDesiredState;
  serviceStates: WorkspaceRuntimeServiceStateMap | null;
} {
  const configuredServices = listConfiguredRuntimeServiceEntries(input.config);
  const fallbackState: WorkspaceRuntimeDesiredState = readDesiredRuntimeState(input.currentDesiredState) ?? "stopped";
  const nextServiceStates: WorkspaceRuntimeServiceStateMap = {};

  for (let index = 0; index < configuredServices.length; index += 1) {
    nextServiceStates[String(index)] = input.currentServiceStates?.[String(index)] ?? fallbackState;
  }

  const nextState: WorkspaceRuntimeDesiredState = input.action === "stop" ? "stopped" : "running";
  const applyActionState = (index: number) => {
    const key = String(index);
    // Manual services are intentionally left under operator control even when
    // an API action targets that individual service.
    if (nextServiceStates[key] === "manual") return;
    nextServiceStates[key] = nextState;
  };
  if (input.serviceIndex === undefined || input.serviceIndex === null) {
    for (let index = 0; index < configuredServices.length; index += 1) {
      applyActionState(index);
    }
  } else if (input.serviceIndex >= 0 && input.serviceIndex < configuredServices.length) {
    applyActionState(input.serviceIndex);
  }

  const desiredState = Object.values(nextServiceStates).some((state) => state === "running")
    ? "running"
    : Object.values(nextServiceStates).some((state) => state === "manual")
      ? "manual"
      : "stopped";

  return {
    desiredState,
    serviceStates: Object.keys(nextServiceStates).length > 0 ? nextServiceStates : null,
  };
}

function selectRuntimeServiceEntries(input: {
  config: Record<string, unknown>;
  serviceIndex?: number | null;
  respectDesiredStates?: boolean;
  defaultDesiredState?: WorkspaceRuntimeDesiredState | null;
  serviceStates?: WorkspaceRuntimeServiceStateMap | null;
}) {
  const entries = listConfiguredRuntimeServiceEntries(input.config);
  const states = input.serviceStates ?? readConfiguredServiceStates(input.config);
  const fallbackState: WorkspaceRuntimeDesiredState = readDesiredRuntimeState(input.defaultDesiredState) ?? "stopped";

  return entries.filter((_, index) => {
    if (input.serviceIndex !== undefined && input.serviceIndex !== null) {
      return index === input.serviceIndex;
    }
    if (!input.respectDesiredStates) return true;
    return (states[String(index)] ?? fallbackState) === "running";
  });
}

export async function ensureRuntimeServicesForRun(input: {
  db?: Db;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  config: Record<string, unknown>;
  adapterEnv: Record<string, string>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<RuntimeServiceRef[]> {
  const rawServices = selectRuntimeServiceEntries({
    config: input.config,
    respectDesiredStates: true,
    defaultDesiredState: readDesiredRuntimeState(input.config.desiredState) ?? "running",
    serviceStates: readConfiguredServiceStates(input.config),
  });
  const acquiredServiceIds: string[] = [];
  const refs: RuntimeServiceRef[] = [];
  const runtimeProvisionCommand = resolveRuntimeProvisionCommand(input);
  const provisionCoordinator = createRuntimeProvisionCoordinator();
  runtimeServiceLeasesByRun.set(input.runId, acquiredServiceIds);

  try {
    for (const service of rawServices) {
      const { scopeType, scopeId } = resolveServiceScopeId({
        service,
        workspace: input.workspace,
        executionWorkspaceId: input.executionWorkspaceId,
        issue: input.issue,
        runId: input.runId,
        agent: input.agent,
      });
      const reuseKey = resolveRuntimeServiceReuseIdentity({
        service,
        workspace: input.workspace,
        agent: input.agent,
        issue: input.issue,
        adapterEnv: input.adapterEnv,
        scopeType,
        scopeId,
      }).reuseKey;

      if (reuseKey) {
        const existingId = runtimeServicesByReuseKey.get(reuseKey);
        const existing = existingId ? runtimeServicesById.get(existingId) : null;
        if (existing && existing.status === "running") {
          existing.leaseRunIds.add(input.runId);
          existing.lastUsedAt = new Date().toISOString();
          existing.stoppedAt = null;
          clearIdleTimer(existing);
          void touchLocalServiceRegistryRecord(existing.serviceKey, {
            runtimeServiceId: existing.id,
            lastSeenAt: existing.lastUsedAt,
          });
          await persistRuntimeServiceRecord(input.db, existing);
          acquiredServiceIds.push(existing.id);
          refs.push(toRuntimeServiceRef(existing, { reused: true }));
          continue;
        }
      }

      const started = await startLocalRuntimeService({
        db: input.db,
        runId: input.runId,
        agent: input.agent,
        issue: input.issue,
        workspace: input.workspace,
        executionWorkspaceId: input.executionWorkspaceId,
        adapterEnv: input.adapterEnv,
        service,
        onLog: input.onLog,
        runtimeProvisionCommand,
        recorder: input.recorder,
        provisionCoordinator,
        reuseKey,
        scopeType,
        scopeId,
      });
      const record = started.record;
      registerRuntimeService(input.db, record);
      await persistRuntimeServiceRecord(input.db, record);
      acquiredServiceIds.push(record.id);
      refs.push(toRuntimeServiceRef(record));
    }
  } catch (err) {
    await releaseRuntimeServicesForRun(input.runId);
    throw err;
  }

  return refs;
}

type StartRuntimeServicesForWorkspaceControlInput = {
  db?: Db;
  invocationId?: string;
  actor: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  config: Record<string, unknown>;
  adapterEnv: Record<string, string>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  recorder?: WorkspaceOperationRecorder | null;
  serviceIndex?: number | null;
  respectDesiredStates?: boolean;
};

type WorkspaceControlStartBatch = {
  refs: RuntimeServiceRef[];
  pendingReadiness: LocalRuntimeServiceStart[];
  startedServiceIds: string[];
};

async function startRuntimeServicesForWorkspaceControlUnlocked(
  input: StartRuntimeServicesForWorkspaceControlInput,
  rawServices: Record<string, unknown>[],
  invocationId: string,
  persistenceDb = input.db,
  registryDb = input.db,
  options?: {
    deferReadiness?: boolean;
    runtimeProvisionCommand?: string;
    provisionCoordinator?: RuntimeProvisionCoordinator;
    preparedProvisioning?: {
      service: Record<string, unknown>;
      record: RuntimeServiceRecord;
    } | null;
  },
): Promise<WorkspaceControlStartBatch> {
  const refs: RuntimeServiceRef[] = [];
  const pendingReadiness: LocalRuntimeServiceStart[] = [];
  const startedServiceIds: string[] = [];

  for (const service of rawServices) {
    const { scopeType, scopeId } = resolveServiceScopeId({
      service,
      workspace: input.workspace,
      executionWorkspaceId: input.executionWorkspaceId,
      issue: input.issue,
      runId: invocationId,
      agent: input.actor,
    });
    const reuseKey = resolveRuntimeServiceReuseIdentity({
      service,
      workspace: input.workspace,
      agent: input.actor,
      issue: input.issue,
      adapterEnv: input.adapterEnv,
      scopeType,
      scopeId,
    }).reuseKey;

    if (reuseKey) {
      const existingId = runtimeServicesByReuseKey.get(reuseKey);
      const existing = existingId ? runtimeServicesById.get(existingId) : null;
      if (existing && existing.status === "running") {
        const prepared = options?.preparedProvisioning;
        if (prepared?.service === service && prepared.record.id !== existing.id && persistenceDb) {
          await persistenceDb
            .delete(workspaceRuntimeServices)
            .where(eq(workspaceRuntimeServices.id, prepared.record.id));
        }
        existing.lastUsedAt = new Date().toISOString();
        existing.stoppedAt = null;
        clearIdleTimer(existing);
        void touchLocalServiceRegistryRecord(existing.serviceKey, {
          runtimeServiceId: existing.id,
          lastSeenAt: existing.lastUsedAt,
        });
        await persistRuntimeServiceRecord(persistenceDb, existing);
        refs.push(toRuntimeServiceRef(existing, { reused: true }));
        continue;
      }
    }

    const startInput: StartLocalRuntimeServiceInput = {
      db: persistenceDb,
      runId: invocationId,
      leaseRunId: null,
      startedByRunId: null,
      agent: input.actor,
      issue: input.issue,
      workspace: input.workspace,
      executionWorkspaceId: input.executionWorkspaceId,
      adapterEnv: input.adapterEnv,
      service,
      onLog: input.onLog,
      runtimeProvisionCommand: options?.runtimeProvisionCommand,
      recorder: input.recorder,
      provisionCoordinator: options?.provisionCoordinator,
      preparedProvisioningRecord:
        options?.preparedProvisioning?.service === service
          ? options.preparedProvisioning.record
          : undefined,
      reuseKey,
      scopeType,
      scopeId,
    };

    // Manually controlled services are not tied to a heartbeat run lifecycle, so they do not
    // retain a run lease and never persist a startedByRunId foreign key.
    const started = await startLocalRuntimeService(startInput, {
      deferReadiness: options?.deferReadiness,
    });
    registerRuntimeService(registryDb, started.record);
    await persistRuntimeServiceRecord(persistenceDb, started.record);
    refs.push(toRuntimeServiceRef(started.record));

    if (options?.deferReadiness && !started.record.reused) {
      // Attach a rejection handler immediately; the caller awaits the same promise after
      // the DB transaction commits, but transaction failures may skip that wait path.
      started.readiness.catch(() => undefined);
      pendingReadiness.push(started);
      startedServiceIds.push(started.record.id);
    }
  }

  return { refs, pendingReadiness, startedServiceIds };
}

export async function startRuntimeServicesForWorkspaceControl(
  input: StartRuntimeServicesForWorkspaceControlInput,
): Promise<RuntimeServiceRef[]> {
  const rawServices = selectRuntimeServiceEntries({
    config: input.config,
    serviceIndex: input.serviceIndex,
    respectDesiredStates: input.respectDesiredStates,
    defaultDesiredState: readDesiredRuntimeState(input.config.desiredState) ?? "stopped",
    serviceStates: readConfiguredServiceStates(input.config),
  });
  const invocationId = input.invocationId ?? randomUUID();
  const runtimeProvisionCommand = resolveRuntimeProvisionCommand(input);
  const provisionCoordinator = createRuntimeProvisionCoordinator();

  if (rawServices.length === 0 || !input.db || (!input.executionWorkspaceId && !input.workspace.workspaceId)) {
    const batch = await startRuntimeServicesForWorkspaceControlUnlocked(
      input,
      rawServices,
      invocationId,
      input.db,
      input.db,
      { runtimeProvisionCommand, provisionCoordinator },
    );
    return batch.refs;
  }

  let startBatch: WorkspaceControlStartBatch = {
    refs: [],
    pendingReadiness: [],
    startedServiceIds: [],
  };
  let preparedProvisioning: {
    service: Record<string, unknown>;
    record: RuntimeServiceRecord;
  } | null = null;
  try {
    if (runtimeProvisionCommand) {
      for (const service of rawServices) {
        const { scopeType, scopeId } = resolveServiceScopeId({
          service,
          workspace: input.workspace,
          executionWorkspaceId: input.executionWorkspaceId,
          issue: input.issue,
          runId: invocationId,
          agent: input.actor,
        });
        const reuseKey = resolveRuntimeServiceReuseIdentity({
          service,
          workspace: input.workspace,
          agent: input.actor,
          issue: input.issue,
          adapterEnv: input.adapterEnv,
          scopeType,
          scopeId,
        }).reuseKey;
        const existingId = reuseKey ? runtimeServicesByReuseKey.get(reuseKey) : null;
        const existing = existingId ? runtimeServicesById.get(existingId) : null;
        if (existing?.status === "running") continue;

        const record = await prepareRuntimeProvisioning({
          db: input.db,
          runId: invocationId,
          leaseRunId: null,
          startedByRunId: null,
          agent: input.actor,
          issue: input.issue,
          workspace: input.workspace,
          executionWorkspaceId: input.executionWorkspaceId,
          adapterEnv: input.adapterEnv,
          service,
          onLog: input.onLog,
          runtimeProvisionCommand,
          recorder: input.recorder,
          provisionCoordinator,
          reuseKey,
          scopeType,
          scopeId,
        });
        if (record) preparedProvisioning = { service, record };
        break;
      }
    }

    await input.db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;

      if (input.executionWorkspaceId) {
        const [lockedExecutionWorkspace] = await tx
          .select({ id: executionWorkspaces.id })
          .from(executionWorkspaces)
          .where(
            and(
              eq(executionWorkspaces.id, input.executionWorkspaceId),
              eq(executionWorkspaces.companyId, input.actor.companyId),
            ),
          )
          .for("update");
        if (!lockedExecutionWorkspace) throw new Error("Execution workspace not found before starting runtime services");
      }

      if (input.workspace.workspaceId) {
        const [lockedProjectWorkspace] = await tx
          .select({ id: projectWorkspaces.id })
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.id, input.workspace.workspaceId),
              eq(projectWorkspaces.companyId, input.actor.companyId),
            ),
          )
          .for("update");
        if (!lockedProjectWorkspace) throw new Error("Project workspace not found before starting runtime services");
      }

      // Branch reconciliation takes these same parent row locks before mutating
      // a recorded branch. Persisting a `starting` service row before commit closes
      // the process-start window without holding the DB transaction for readiness.
      startBatch = await startRuntimeServicesForWorkspaceControlUnlocked(
        { ...input, db: txDb },
        rawServices,
        invocationId,
        txDb,
        input.db,
        {
          deferReadiness: true,
          runtimeProvisionCommand,
          provisionCoordinator,
          preparedProvisioning,
        },
      );
    });

    for (const pending of startBatch.pendingReadiness) {
      try {
        await pending.readiness;
        await persistRuntimeServiceRecord(input.db, pending.record);
      } catch (error) {
        await persistRuntimeServiceRecord(input.db, pending.record).catch(() => undefined);
        throw error;
      }
    }

    return startBatch.refs.map((ref) => {
      const record = runtimeServicesById.get(ref.id);
      return record ? toRuntimeServiceRef(record, { reused: ref.reused }) : ref;
    });
  } catch (error) {
    for (const serviceId of startBatch.startedServiceIds) {
      await stopRuntimeService(serviceId).catch(() => undefined);
    }
    if (preparedProvisioning && startBatch.startedServiceIds.length === 0) {
      const nowIso = new Date().toISOString();
      preparedProvisioning.record.status = "failed";
      preparedProvisioning.record.healthStatus = "unhealthy";
      preparedProvisioning.record.lastUsedAt = nowIso;
      preparedProvisioning.record.stoppedAt = nowIso;
      await persistRuntimeServiceRecord(input.db, preparedProvisioning.record).catch(() => undefined);
    }
    throw error;
  }
}

export async function releaseRuntimeServicesForRun(runId: string) {
  const acquired = runtimeServiceLeasesByRun.get(runId) ?? [];
  runtimeServiceLeasesByRun.delete(runId);
  for (const serviceId of acquired) {
    const record = runtimeServicesById.get(serviceId);
    if (!record) continue;
    record.leaseRunIds.delete(runId);
    record.lastUsedAt = new Date().toISOString();
    const stopType = asString(record.stopPolicy?.type, record.lifecycle === "ephemeral" ? "on_run_finish" : "manual");
    await persistRuntimeServiceRecord(record.db, record);
    if (record.leaseRunIds.size === 0) {
      if (record.lifecycle === "ephemeral" || stopType === "on_run_finish") {
        await stopRuntimeService(serviceId);
        continue;
      }
      scheduleIdleStop(record);
    }
  }
}

export async function stopRuntimeServicesForExecutionWorkspace(input: {
  db?: Db;
  executionWorkspaceId: string;
  workspaceCwd?: string | null;
  runtimeServiceId?: string | null;
}) {
  const normalizedWorkspaceCwd = input.workspaceCwd ? path.resolve(input.workspaceCwd) : null;
  const matchingServiceIds = Array.from(runtimeServicesById.values())
    .filter((record) => {
      if (input.runtimeServiceId) return record.id === input.runtimeServiceId;
      if (record.executionWorkspaceId === input.executionWorkspaceId) return true;
      if (!normalizedWorkspaceCwd || !record.cwd) return false;
      const resolvedCwd = path.resolve(record.cwd);
      return (
        resolvedCwd === normalizedWorkspaceCwd ||
        resolvedCwd.startsWith(`${normalizedWorkspaceCwd}${path.sep}`)
      );
    })
    .map((record) => record.id);

  for (const serviceId of matchingServiceIds) {
    await stopRuntimeService(serviceId);
  }

  if (input.db) {
    if (input.runtimeServiceId) {
      const now = new Date();
      await input.db
        .update(workspaceRuntimeServices)
        .set({
          status: "stopped",
          healthStatus: "unknown",
          stoppedAt: now,
          lastUsedAt: now,
          updatedAt: now,
        })
        .where(eq(workspaceRuntimeServices.id, input.runtimeServiceId));
    } else {
      await markPersistedRuntimeServicesStoppedForExecutionWorkspace({
        db: input.db,
        executionWorkspaceId: input.executionWorkspaceId,
      });
    }
  }
}

export async function stopRuntimeServicesForProjectWorkspace(input: {
  db?: Db;
  projectWorkspaceId: string;
  runtimeServiceId?: string | null;
}) {
  const matchingServiceIds = Array.from(runtimeServicesById.values())
    .filter((record) => {
      if (input.runtimeServiceId) return record.id === input.runtimeServiceId;
      return record.projectWorkspaceId === input.projectWorkspaceId && record.scopeType === "project_workspace";
    })
    .map((record) => record.id);

  for (const serviceId of matchingServiceIds) {
    await stopRuntimeService(serviceId);
  }

  if (input.db) {
    const now = new Date();
    await input.db
      .update(workspaceRuntimeServices)
      .set({
        status: "stopped",
        healthStatus: "unknown",
        stoppedAt: now,
        lastUsedAt: now,
        updatedAt: now,
      })
      .where(
        input.runtimeServiceId
          ? eq(workspaceRuntimeServices.id, input.runtimeServiceId)
          : and(
              eq(workspaceRuntimeServices.projectWorkspaceId, input.projectWorkspaceId),
              eq(workspaceRuntimeServices.scopeType, "project_workspace"),
              inArray(workspaceRuntimeServices.status, ["provisioning", "starting", "running"]),
            ),
      );
  }
}

export async function listWorkspaceRuntimeServicesForProjectWorkspaces(
  db: Db,
  companyId: string,
  projectWorkspaceIds: string[],
) {
  if (projectWorkspaceIds.length === 0) return new Map<string, typeof workspaceRuntimeServices.$inferSelect[]>();
  const rows = await db
    .select()
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.companyId, companyId),
        inArray(workspaceRuntimeServices.projectWorkspaceId, projectWorkspaceIds),
        eq(workspaceRuntimeServices.scopeType, "project_workspace"),
      ),
    )
    .orderBy(desc(workspaceRuntimeServices.updatedAt), desc(workspaceRuntimeServices.createdAt));

  const grouped = new Map<string, typeof workspaceRuntimeServices.$inferSelect[]>();
  for (const row of rows) {
    if (!row.projectWorkspaceId) continue;
    const existing = grouped.get(row.projectWorkspaceId);
    if (existing) existing.push(row);
    else grouped.set(row.projectWorkspaceId, [row]);
  }
  return grouped;
}

export async function reconcilePersistedRuntimeServicesOnStartup(db: Db) {
  const rows = await db
    .select()
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.provider, "local_process"),
        inArray(workspaceRuntimeServices.status, ["provisioning", "starting", "running", "stopped"]),
      ),
    );

  if (rows.length === 0) return { reconciled: 0, adopted: 0, stopped: 0 };

  let reconciled = 0;
  let adopted = 0;
  let stopped = 0;
  for (const row of rows) {
    let adoptedRecord = await findLocalServiceRegistryRecordByRuntimeServiceId({
      runtimeServiceId: row.id,
      profileKind: "workspace-runtime",
    });
    if (
      adoptedRecord
      && (
        adoptedRecord.command !== row.command
        || adoptedRecord.serviceName !== row.serviceName
        || adoptedRecord.envFingerprint !== (row.reuseKey ?? "")
        || adoptedRecord.port !== (row.port ?? null)
        || (row.cwd !== null && path.resolve(adoptedRecord.cwd) !== path.resolve(row.cwd))
      )
    ) {
      await removeLocalServiceRegistryRecord(adoptedRecord.serviceKey);
      adoptedRecord = null;
    }
    if (!adoptedRecord && row.command && row.cwd) {
      adoptedRecord = await findAdoptableLocalService({
        serviceKey: createLocalServiceKey({
          profileKind: "workspace-runtime",
          serviceName: row.serviceName,
          cwd: row.cwd,
          command: row.command,
          envFingerprint: row.reuseKey ?? "",
          port: null,
          scope: {
            scopeType: row.scopeType as RuntimeServiceRecord["scopeType"],
            scopeId: row.scopeId ?? null,
            executionWorkspaceId: row.executionWorkspaceId ?? null,
            reuseKey: row.reuseKey ?? null,
          },
        }),
        profileKind: "workspace-runtime",
        serviceName: row.serviceName,
        command: row.command,
        cwd: row.cwd,
        envFingerprint: row.reuseKey ?? "",
        port: row.port ?? null,
        url: row.url ?? null,
      });
    }
    if (adoptedRecord) {
      const adoptedUrl = adoptedRecord.url ?? row.url ?? null;
      if (!(await isRuntimeServiceUrlHealthy(adoptedUrl, { serviceName: row.serviceName, command: row.command }))) {
        await removeLocalServiceRegistryRecord(adoptedRecord.serviceKey);
      } else {
        const record: RuntimeServiceRecord = {
          id: row.id,
          companyId: row.companyId,
          projectId: row.projectId ?? null,
          projectWorkspaceId: row.projectWorkspaceId ?? null,
          executionWorkspaceId: row.executionWorkspaceId ?? null,
          issueId: row.issueId ?? null,
          serviceName: row.serviceName,
          status: "running",
          lifecycle: row.lifecycle as RuntimeServiceRecord["lifecycle"],
          scopeType: row.scopeType as RuntimeServiceRecord["scopeType"],
          scopeId: row.scopeId ?? null,
          reuseKey: row.reuseKey ?? null,
          command: row.command ?? null,
          cwd: row.cwd ?? null,
          port: adoptedRecord.port ?? row.port ?? null,
          url: adoptedRecord.url ?? row.url ?? null,
          provider: "local_process",
          providerRef: String(adoptedRecord.pid),
          ownerAgentId: row.ownerAgentId ?? null,
          startedByRunId: row.startedByRunId ?? null,
          lastUsedAt: new Date().toISOString(),
          startedAt: row.startedAt.toISOString(),
          stoppedAt: null,
          stopPolicy: (row.stopPolicy as Record<string, unknown> | null) ?? null,
          healthStatus: "healthy",
          reused: true,
          db,
          child: null,
          leaseRunIds: new Set(),
          idleTimer: null,
          envFingerprint: row.reuseKey ?? "",
          serviceKey: adoptedRecord.serviceKey,
          profileKind: "workspace-runtime",
          processGroupId: adoptedRecord.processGroupId ?? null,
        };
        registerRuntimeService(db, record);
        await touchLocalServiceRegistryRecord(adoptedRecord.serviceKey, {
          runtimeServiceId: row.id,
          lastSeenAt: record.lastUsedAt,
        });
        await persistRuntimeServiceRecord(db, record);
        reconciled += 1;
        adopted += 1;
        continue;
      }
    }

    if (row.status === "stopped") {
      continue;
    }

    const now = new Date();
    await db
      .update(workspaceRuntimeServices)
      .set({
        status: "stopped",
        healthStatus: "unknown",
        stoppedAt: now,
        lastUsedAt: now,
        updatedAt: now,
      })
      .where(eq(workspaceRuntimeServices.id, row.id));
    const registryRecord = await findLocalServiceRegistryRecordByRuntimeServiceId({
      runtimeServiceId: row.id,
      profileKind: "workspace-runtime",
    });
    if (registryRecord) {
      await removeLocalServiceRegistryRecord(registryRecord.serviceKey);
    }
    reconciled += 1;
    stopped += 1;
  }

  return { reconciled, adopted, stopped };
}

export async function restartDesiredRuntimeServicesOnStartup(db: Db) {
  let restarted = 0;
  let failed = 0;

  const projectWorkspaceRows = await db
    .select()
    .from(projectWorkspaces);
  const projectWorkspaceRowsById = new Map(projectWorkspaceRows.map((row) => [row.id, row] as const));

  for (const row of projectWorkspaceRows) {
    const runtimeConfig = readProjectWorkspaceRuntimeConfig((row.metadata as Record<string, unknown> | null) ?? null);
    if (runtimeConfig?.desiredState !== "running" || !runtimeConfig.workspaceRuntime || !row.cwd) continue;

    try {
      const refs = await startRuntimeServicesForWorkspaceControl({
        db,
        actor: { id: null, name: "Paperclip", companyId: row.companyId },
        issue: null,
        workspace: {
          baseCwd: row.cwd,
          source: "project_primary",
          projectId: row.projectId,
          workspaceId: row.id,
          repoUrl: row.repoUrl ?? null,
          repoRef: row.repoRef ?? null,
          strategy: "project_primary",
          cwd: row.cwd,
          branchName: row.defaultRef ?? row.repoRef ?? null,
          worktreePath: null,
          warnings: [],
          created: false,
        },
        config: {
          workspaceRuntime: runtimeConfig.workspaceRuntime,
          desiredState: runtimeConfig.desiredState,
          serviceStates: runtimeConfig.serviceStates ?? null,
        },
        adapterEnv: {},
        respectDesiredStates: true,
      });
      if (refs.length > 0) restarted += refs.filter((ref) => !ref.reused).length;
    } catch {
      failed += 1;
    }
  }

  const executionWorkspaceRows = await db
    .select()
    .from(executionWorkspaces)
    .where(inArray(executionWorkspaces.status, ["active", "idle", "in_review", "cleanup_failed"]));

  for (const row of executionWorkspaceRows) {
    const config = readExecutionWorkspaceConfig((row.metadata as Record<string, unknown> | null) ?? null);
    const inheritedRuntimeConfig = row.projectWorkspaceId
      ? readProjectWorkspaceRuntimeConfig(
          (projectWorkspaceRowsById.get(row.projectWorkspaceId)?.metadata as Record<string, unknown> | null) ?? null,
        )?.workspaceRuntime ?? null
      : null;
    const effectiveRuntimeConfig = config?.workspaceRuntime ?? inheritedRuntimeConfig;
    if (config?.desiredState !== "running" || !effectiveRuntimeConfig || !row.cwd) continue;

    try {
      const refs = await startRuntimeServicesForWorkspaceControl({
        db,
        actor: { id: null, name: "Paperclip", companyId: row.companyId },
        issue: row.sourceIssueId
          ? {
              id: row.sourceIssueId,
              identifier: null,
              title: row.name,
            }
          : null,
        workspace: {
          baseCwd: row.cwd,
          source: row.mode === "shared_workspace" ? "project_primary" : "task_session",
          projectId: row.projectId,
          workspaceId: row.projectWorkspaceId ?? null,
          repoUrl: row.repoUrl ?? null,
          repoRef: row.baseRef ?? null,
          strategy: row.strategyType === "git_worktree" ? "git_worktree" : "project_primary",
          cwd: row.cwd,
          branchName: row.branchName ?? null,
          worktreePath: row.strategyType === "git_worktree" ? row.cwd : null,
          warnings: [],
          created: false,
        },
        executionWorkspaceId: row.id,
        config: {
          workspaceRuntime: effectiveRuntimeConfig,
          runtimeProvisionCommand: config.runtimeProvisionCommand,
          desiredState: config.desiredState,
          serviceStates: config.serviceStates ?? null,
        },
        adapterEnv: {},
        respectDesiredStates: true,
      });
      if (refs.length > 0) restarted += refs.filter((ref) => !ref.reused).length;
    } catch {
      failed += 1;
    }
  }

  return { restarted, failed };
}

export async function persistAdapterManagedRuntimeServices(input: {
  db: Db;
  adapterType: string;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  reports: AdapterRuntimeServiceReport[];
}) {
  const refs = normalizeAdapterManagedRuntimeServices(input);
  if (refs.length === 0) return refs;

  const existingRows = await input.db
    .select()
    .from(workspaceRuntimeServices)
    .where(inArray(workspaceRuntimeServices.id, refs.map((ref) => ref.id)));
  const existingById = new Map(existingRows.map((row) => [row.id, row]));

  for (const ref of refs) {
    const existing = existingById.get(ref.id);
    const startedAt = existing?.startedAt ?? new Date(ref.startedAt);
    const createdAt = existing?.createdAt ?? new Date();
    await input.db
      .insert(workspaceRuntimeServices)
      .values({
        id: ref.id,
        companyId: ref.companyId,
        projectId: ref.projectId,
        projectWorkspaceId: ref.projectWorkspaceId,
        executionWorkspaceId: ref.executionWorkspaceId,
        issueId: ref.issueId,
        scopeType: ref.scopeType,
        scopeId: ref.scopeId,
        serviceName: ref.serviceName,
        status: ref.status,
        lifecycle: ref.lifecycle,
        reuseKey: ref.reuseKey,
        command: ref.command,
        cwd: ref.cwd,
        port: ref.port,
        url: ref.url,
        provider: ref.provider,
        providerRef: ref.providerRef,
        ownerAgentId: ref.ownerAgentId,
        startedByRunId: ref.startedByRunId,
        lastUsedAt: new Date(ref.lastUsedAt),
        startedAt,
        stoppedAt: ref.stoppedAt ? new Date(ref.stoppedAt) : null,
        stopPolicy: ref.stopPolicy,
        healthStatus: ref.healthStatus,
        createdAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: workspaceRuntimeServices.id,
        set: {
          projectId: ref.projectId,
          projectWorkspaceId: ref.projectWorkspaceId,
          executionWorkspaceId: ref.executionWorkspaceId,
          issueId: ref.issueId,
          scopeType: ref.scopeType,
          scopeId: ref.scopeId,
          serviceName: ref.serviceName,
          status: ref.status,
          lifecycle: ref.lifecycle,
          reuseKey: ref.reuseKey,
          command: ref.command,
          cwd: ref.cwd,
          port: ref.port,
          url: ref.url,
          provider: ref.provider,
          providerRef: ref.providerRef,
          ownerAgentId: ref.ownerAgentId,
          startedByRunId: ref.startedByRunId,
          lastUsedAt: new Date(ref.lastUsedAt),
          startedAt,
          stoppedAt: ref.stoppedAt ? new Date(ref.stoppedAt) : null,
          stopPolicy: ref.stopPolicy,
          healthStatus: ref.healthStatus,
          updatedAt: new Date(),
        },
      });
  }

  return refs;
}

type WorkspaceReadyCommentInput = {
  workspace: RealizedExecutionWorkspace;
  runtimeServices: RuntimeServiceRef[];
};

const COMMENT_METADATA_LABEL_MAX_LENGTH = 120;

function workspaceReadyServiceLabel(serviceName: string): string {
  const label = serviceName.trim() || "Service";
  return label.length > COMMENT_METADATA_LABEL_MAX_LENGTH
    ? `${label.slice(0, COMMENT_METADATA_LABEL_MAX_LENGTH - 1)}…`
    : label;
}

export function buildWorkspaceReadyPresentation(
  input: WorkspaceReadyCommentInput,
): IssueCommentPresentation {
  const workspaceLabel = input.workspace.branchName ?? input.workspace.strategy;
  const title = `Workspace ready · ${workspaceLabel}`;
  const hasWarnings = input.workspace.warnings.length > 0;

  return {
    kind: "system_notice",
    tone: hasWarnings ? "warning" : "info",
    title: title.length > 160 ? `${title.slice(0, 159)}…` : title,
    density: "compact",
    detailsDefaultOpen: hasWarnings,
  };
}

// Workspace warnings are unbounded provider text (git output, provisioning
// diagnostics), but issueCommentMetadataSchema caps a metadata row at
// ISSUE_COMMENT_METADATA_TEXT_MAX_LENGTH. An over-long warning made the whole
// workspace-ready comment fail zod validation with
// {"code":"too_big","path":["sections",1,"rows",0,"text"]}, so the
// workspace-ready signal never landed on the issue at all - on every run of an
// affected agent. Clamp the row the same way the presentation title is
// clamped, and keep the full text in the markdown body, which has no cap.
function clampWorkspaceReadyRowText(text: string) {
  const trimmed = text.trim();
  return trimmed.length > ISSUE_COMMENT_METADATA_TEXT_MAX_LENGTH
    ? `${trimmed.slice(0, ISSUE_COMMENT_METADATA_TEXT_MAX_LENGTH - 1)}\u2026`
    : trimmed;
}

export function buildWorkspaceReadyMetadata(
  input: WorkspaceReadyCommentInput,
): IssueCommentMetadata {
  const workspaceRows: IssueCommentMetadata["sections"][number]["rows"] = [
    { type: "key_value", label: "Strategy", value: input.workspace.strategy },
    ...(input.workspace.branchName
      ? [{ type: "key_value" as const, label: "Branch", value: input.workspace.branchName }]
      : []),
    { type: "key_value", label: "CWD", value: input.workspace.cwd },
    ...(input.workspace.worktreePath && input.workspace.worktreePath !== input.workspace.cwd
      ? [{ type: "key_value" as const, label: "Worktree", value: input.workspace.worktreePath }]
      : []),
  ];
  const serviceRows: IssueCommentMetadata["sections"][number]["rows"] = input.runtimeServices.map(
    (service) => ({
      type: "key_value",
      label: workspaceReadyServiceLabel(service.serviceName),
      value: `${service.url ?? "running"}${service.reused ? " (reused)" : ""}`,
    }),
  );

  return {
    version: 1,
    sections: [
      { title: "Workspace", rows: workspaceRows },
      ...(serviceRows.length > 0 ? [{ title: "Services", rows: serviceRows }] : []),
      ...(input.workspace.warnings.length > 0
        ? [{
            title: "Warnings",
            rows: input.workspace.warnings.map((warning) => ({
              type: "text" as const,
              text: clampWorkspaceReadyRowText(warning),
            })),
          }]
        : []),
    ],
  };
}

export function buildWorkspaceReadyComment(input: WorkspaceReadyCommentInput) {
  const lines = ["## Workspace Ready", ""];
  lines.push(`- Strategy: \`${input.workspace.strategy}\``);
  if (input.workspace.branchName) lines.push(`- Branch: \`${input.workspace.branchName}\``);
  lines.push(`- CWD: \`${input.workspace.cwd}\``);
  if (input.workspace.worktreePath && input.workspace.worktreePath !== input.workspace.cwd) {
    lines.push(`- Worktree: \`${input.workspace.worktreePath}\``);
  }
  for (const warning of input.workspace.warnings) {
    lines.push(`- Warning: ${warning}`);
  }
  for (const service of input.runtimeServices) {
    const detail = service.url ? `${service.serviceName}: ${service.url}` : `${service.serviceName}: running`;
    const suffix = service.reused ? " (reused)" : "";
    lines.push(`- Service: ${detail}${suffix}`);
  }
  return lines.join("\n");
}
