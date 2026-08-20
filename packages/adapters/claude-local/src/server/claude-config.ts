import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext, AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import {
  runAdapterExecutionTargetShellCommand,
  type AdapterExecutionTarget,
  type AdapterExecutionTargetShellOptions,
} from "@paperclipai/adapter-utils/execution-target";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";

const SEEDED_SHARED_FILES = ["settings.json", "CLAUDE.md"] as const;

interface SeedFile {
  name: string;
  sourcePath: string;
  contents: Buffer;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : null;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

function sanitizeRemoteClaudeSettings(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return JSON.stringify({ permissions: { defaultMode: "default" } });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return JSON.stringify({ permissions: { defaultMode: "default" } });
  }

  const settings = { ...(parsed as Record<string, unknown>) };
  settings.permissions = { defaultMode: "default" };
  delete settings.hooks;
  delete settings.mcpServers;
  delete settings.permissionMode;
  delete settings.skipDangerousModePermissionPrompt;
  return JSON.stringify(settings);
}

async function collectSeedFiles(sourceDir: string): Promise<SeedFile[]> {
  const files: SeedFile[] = [];
  for (const name of SEEDED_SHARED_FILES) {
    const sourcePath = path.join(sourceDir, name);
    if (!(await pathExists(sourcePath))) continue;
    const rawContents = await fs.readFile(sourcePath);
    const contents = name === "settings.json"
      ? Buffer.from(sanitizeRemoteClaudeSettings(rawContents.toString("utf8")), "utf8")
      : rawContents;
    files.push({ name, sourcePath, contents });
  }
  return files;
}

async function buildSeedSnapshotKey(files: SeedFile[]): Promise<string> {
  if (files.length === 0) return "empty";
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Deliberately NOT widened to the shared `agents` group (SUP-13487).
 *
 * `mkdtemp` fixes the staging dir at 0700 and `fs.rename` preserves that mode, so
 * the promoted `targetDir` is 0700 too — which under M1 (agent uid 1001, server uid
 * 1000) is the shape that broke every `opencode_local` run in SUP-13484. It is
 * correct here, because this snapshot never reaches an agent child:
 *
 *   execute.ts:569  claudeConfigSeedDir = useManagedRemoteClaudeConfig ? … : null
 *   execute.ts:562  useManagedRemoteClaudeConfig = executionTargetIsRemote && …
 *
 * It is `null` for every local target, and its only consumers are `localDir:` on an
 * upload asset (execute.ts:602) and the remote path computation (execute.ts:653) —
 * both read by the server process that owns the directory. The sandbox receives its
 * own copy; nothing at uid 1001 ever traverses this path.
 *
 * Widening it would be a downgrade, not a fix: these files are credential-bearing
 * Claude config staged in a world-readable tmpdir parent, so group-readable here
 * means readable by the very principal the uid split exists to exclude. If a LOCAL
 * lane ever starts consuming this seed, that is when it needs
 * `ensureAgentAccessibleDir` — not before.
 */
async function materializeSeedSnapshot(input: {
  rootDir: string;
  snapshotKey: string;
  files: SeedFile[];
}): Promise<string> {
  const targetDir = path.join(input.rootDir, input.snapshotKey);
  if (await pathExists(targetDir)) {
    return targetDir;
  }

  await fs.mkdir(input.rootDir, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(input.rootDir, ".tmp-"));
  try {
    for (const file of input.files) {
      await fs.writeFile(path.join(stagingDir, file.name), file.contents);
    }
    try {
      await fs.rename(stagingDir, targetDir);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return targetDir;
}

export function resolveSharedClaudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CLAUDE_CONFIG_DIR);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".claude");
}

export function resolveManagedClaudeConfigSeedDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return companyId
    ? path.resolve(instanceRoot, "companies", companyId, "claude-config-seed")
    : path.resolve(instanceRoot, "claude-config-seed");
}

export function resolveManagedClaudeRuntimeStateDir(
  env: NodeJS.ProcessEnv,
  companyId: string,
  agentId: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.join(instanceRoot, "companies", companyId, "agents", agentId, "claude-runtime");
}

export async function writePaperclipClaudeMcpConfig(input: {
  stateDir: string;
  runId: string;
  servers: AdapterRuntimeMcpServer[];
}): Promise<string> {
  const configDir = path.join(input.stateDir, "runs", input.runId, "mcp");
  const configPath = path.join(configDir, "mcp-config.json");
  const usedNames = new Set<string>();
  const mcpServers: Record<string, unknown> = {};
  for (const server of input.servers) {
    let name = server.name;
    if (usedNames.has(name)) name = `${name}-${server.connectionId.slice(0, 8)}`;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${server.name}-${server.connectionId.slice(0, 8)}-${suffix}`;
      suffix += 1;
    }
    usedNames.add(name);
    mcpServers[name] = {
      type: "http",
      url: server.url,
      headers: { Authorization: `Bearer ${server.token}` },
    };
  }
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
  return configPath;
}

export async function prepareClaudeConfigSeed(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
): Promise<string> {
  const sourceDir = resolveSharedClaudeConfigDir(env);
  const targetRootDir = resolveManagedClaudeConfigSeedDir(env, companyId);

  if (path.resolve(sourceDir) === path.resolve(targetRootDir)) {
    return targetRootDir;
  }

  const copiedFiles = await collectSeedFiles(sourceDir);
  const snapshotKey = await buildSeedSnapshotKey(copiedFiles);
  const targetDir = await materializeSeedSnapshot({
    rootDir: targetRootDir,
    snapshotKey,
    files: copiedFiles,
  });

  if (copiedFiles.length > 0) {
    await onLog(
      "stdout",
      `[paperclip] Prepared Claude config seed "${targetDir}" from "${sourceDir}" (${copiedFiles.map((file) => file.name).join(", ")}).\n`,
    );
  } else {
    await onLog(
      "stdout",
      `[paperclip] No local Claude config seed files were found in "${sourceDir}". Remote Claude auth may still require login.\n`,
    );
  }

  return targetDir;
}

export function resolveAgentSideClaudeConfigDir(
  env: NodeJS.ProcessEnv,
  companyId: string,
  agentId: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
  });
  return path.join(instanceRoot, "companies", companyId, "agents", agentId, "claude-config");
}

// The docker image fixes the principal layout (Dockerfile ARGs +
// docker/agent-spawn-shim/spawn-agent.c): the server runs as uid 1000 (`node`)
// and the agent principal as uid 1001 (`node-agent`); both belong to the
// `agents` group (gid 1002). The agent-side home is therefore made
// group-`agents` readable so the agent uid can reach it without any uid change
// on the lane.
const AGENTS_GROUP_GID = 1002;

/**
 * Best-effort group-ownership handover to the shared `agents` group. The
 * server owns every path it creates, so it may chgrp to any group it belongs
 * to; when it cannot (non-docker dev hosts without the `agents` group), the
 * lane still works for same-uid setups and the degradation is logged, not
 * fatal.
 */
async function chownToAgentsGroup(
  candidate: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<void> {
  if (typeof process.getuid !== "function") return;
  try {
    await fs.chown(candidate, process.getuid(), AGENTS_GROUP_GID);
  } catch (error) {
    await onLog(
      "stderr",
      `[paperclip] agent-side Claude config: could not chgrp ${candidate} to agents (gid ${AGENTS_GROUP_GID}): ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/**
 * Atomically replace `target` with a copy of `source`, landing at 0o660 with
 * the `agents` group. The temp+rename shape means the credential file is never
 * briefly world-readable (plain copyFile would create at 0666&~umask first).
 */
async function copyFileToAgentSideHome(
  source: string,
  target: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<void> {
  const contents = await fs.readFile(source);
  const tempPath = `${target}.tmp-${process.pid}`;
  const handle = await fs.open(tempPath, "wx", 0o660);
  try {
    await handle.writeFile(contents);
    await handle.close();
    await chownToAgentsGroup(tempPath, onLog);
    await fs.rename(tempPath, target);
    await fs.chmod(target, 0o660).catch(() => {});
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function seedAgentSideClaudeConfig(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId: string,
  agentId: string,
): Promise<void> {
  const configDir = resolveAgentSideClaudeConfigDir(env, companyId, agentId);
  await fs.mkdir(configDir, { recursive: true, mode: 0o2770 });
  // mkdir masks the mode with the process umask (and skips existing dirs), so
  // enforce the full 0o2770 explicitly: the agent uid (1001) writes SDK
  // session state into this home through its `agents` group membership.
  await fs.chmod(configDir, 0o2770);
  await chownToAgentsGroup(configDir, onLog);

  // Pre-create the SDK subdirectories at 0o2770 so a run writing into the home
  // starts from group-writable dirs instead of 0700 SDK-created ones.
  const subdirs: string[] = ["projects", "session-env", "sessions", "shell-snapshots", "statsig"];
  for (const subdir of subdirs) {
    const subdirPath = path.join(configDir, subdir);
    await fs.mkdir(subdirPath, { recursive: true, mode: 0o2770 });
    await fs.chmod(subdirPath, 0o2770);
    await chownToAgentsGroup(subdirPath, onLog);
  }

  // Refresh the two credential artifacts from the server's shared home (the
  // server uid can read its own 0600 files; this copy never touches them).
  const sourceDir = resolveSharedClaudeConfigDir(env);
  const seededFiles: string[] = [".credentials.json", ".claude.json"];
  for (const name of seededFiles) {
    const sourcePath = path.join(sourceDir, name);
    if (!(await pathExists(sourcePath))) continue;
    await copyFileToAgentSideHome(sourcePath, path.join(configDir, name), onLog);
  }

  await onLog(
    "stdout",
    `[paperclip] Seeded agent-side Claude config at ${configDir}\n`,
  );
}

export function buildRemoteClaudeConfigMaterializationCommand(input: {
  remoteClaudeConfigDir: string;
  remoteClaudeConfigSeedDir: string;
}): string {
  return `mkdir -p ${shellQuote(input.remoteClaudeConfigDir)} && ` +
    `if [ -d ${shellQuote(input.remoteClaudeConfigSeedDir)} ]; then ` +
    `cp -R ${shellQuote(`${input.remoteClaudeConfigSeedDir}/.`)} ${shellQuote(input.remoteClaudeConfigDir)}/; ` +
    `fi; ` +
    `for file in .credentials.json credentials.json; do ` +
    `if [ -n "\${HOME:-}" ] && [ -f "\${HOME}/.claude/\${file}" ] && [ ! -f ${shellQuote(input.remoteClaudeConfigDir)}/"\${file}" ]; then ` +
    `cp "\${HOME}/.claude/\${file}" ${shellQuote(input.remoteClaudeConfigDir)}/"\${file}"; ` +
    `fi; ` +
    `done`;
}

export async function materializeRemoteClaudeConfig(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  remoteClaudeConfigDir: string;
  remoteClaudeConfigSeedDir: string;
  options: AdapterExecutionTargetShellOptions;
}): Promise<void> {
  await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    buildRemoteClaudeConfigMaterializationCommand({
      remoteClaudeConfigDir: input.remoteClaudeConfigDir,
      remoteClaudeConfigSeedDir: input.remoteClaudeConfigSeedDir,
    }),
    input.options,
  );
}
