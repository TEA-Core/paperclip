import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterEnvironmentCheck,
  AdapterRuntimeMcpServer,
} from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetUsesManagedHome,
  maybeRunSandboxInstallCommand,
  prepareAdapterExecutionTargetRuntime,
  runAdapterExecutionTargetShellCommand,
  type AdapterExecutionTarget,
  type AdapterExecutionTargetShellOptions,
} from "@paperclipai/adapter-utils/execution-target";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { classifyThrownErrorClass, logSandboxProbeDiagnostic } from "./probe-diagnostics.js";

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

function toTimestampMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // Claude Code stores expiresAt/refreshTokenExpiresAt as seconds since epoch
  // with fractional millis. Treat values below 1e12 as seconds.
  return value < 1e12 ? value * 1000 : value;
}

function readJwtExp(accessToken: string): number | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload?.exp === "number" && Number.isFinite(payload.exp) ? payload.exp : null;
  } catch {
    return null;
  }
}

interface ClaudeConfigCredentialHealth {
  status:
    | "ok"
    | "access_expired"
    | "refresh_expiring"
    | "refresh_expired"
    | "missing"
    | "unparseable"
    | "no_oauth_token";
  /** Safe metadata only; never a token value. */
  detail: string;
  modifiedAtMs: number | null;
  accessExpiresAtMs: number | null;
  refreshExpiresAtMs: number | null;
}

export async function probeClaudeConfigCredentialHealth(
  configDir: string,
): Promise<ClaudeConfigCredentialHealth> {
  let targetPath: string | null = null;
  let stat: { mtimeMs: number } | null = null;
  let raw: string | null = null;
  for (const name of [".credentials.json", "credentials.json"]) {
    const candidate = path.join(configDir, name);
    if (!(await pathExists(candidate))) continue;
    try {
      const [content, s] = await Promise.all([fs.readFile(candidate, "utf8"), fs.stat(candidate)]);
      targetPath = candidate;
      raw = content;
      stat = s;
      break;
    } catch {
      continue;
    }
  }
  if (!targetPath || raw == null || stat == null) {
    return {
      status: "missing",
      detail: `No credentials file found in ${configDir}`,
      modifiedAtMs: null,
      accessExpiresAtMs: null,
      refreshExpiresAtMs: null,
    };
  }
  const modifiedAtMs = stat.mtimeMs;
  const modifiedAtIso = new Date(modifiedAtMs).toISOString();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      status: "unparseable",
      detail: `Credentials file at ${targetPath} is not valid JSON: ${reason}`,
      modifiedAtMs,
      accessExpiresAtMs: null,
      refreshExpiresAtMs: null,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      status: "unparseable",
      detail: `Credentials file at ${targetPath} is not a JSON object`,
      modifiedAtMs,
      accessExpiresAtMs: null,
      refreshExpiresAtMs: null,
    };
  }
  const oauth = (parsed as Record<string, unknown>)["claudeAiOauth"];
  if (typeof oauth !== "object" || oauth === null) {
    return {
      status: "no_oauth_token",
      detail: `Credentials file at ${targetPath} has no claudeAiOauth section`,
      modifiedAtMs,
      accessExpiresAtMs: null,
      refreshExpiresAtMs: null,
    };
  }
  const oauthRecord = oauth as Record<string, unknown>;
  const accessToken = oauthRecord["accessToken"];
  const refreshToken = oauthRecord["refreshToken"];
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof refreshToken !== "string" ||
    refreshToken.length === 0
  ) {
    return {
      status: "no_oauth_token",
      detail: `Credentials file at ${targetPath} is missing access/refresh token keys`,
      modifiedAtMs,
      accessExpiresAtMs: null,
      refreshExpiresAtMs: null,
    };
  }
  const accessExpiresAtMs = toTimestampMs(oauthRecord["expiresAt"]) ?? toTimestampMs(readJwtExp(accessToken));
  const refreshExpiresAtMs = toTimestampMs(oauthRecord["refreshTokenExpiresAt"]);
  const now = Date.now();
  const accessInMins = accessExpiresAtMs != null ? Math.floor((accessExpiresAtMs - now) / 60_000) : null;
  const refreshInMins = refreshExpiresAtMs != null ? Math.floor((refreshExpiresAtMs - now) / 60_000) : null;

  if (refreshExpiresAtMs != null && refreshExpiresAtMs <= now) {
    return {
      status: "refresh_expired",
      detail:
        `Refresh token expired at ${new Date(refreshExpiresAtMs).toISOString()}` +
        ` (credentials file modified ${modifiedAtIso}); re-login required`,
      modifiedAtMs,
      accessExpiresAtMs,
      refreshExpiresAtMs,
    };
  }
  if (refreshExpiresAtMs != null && refreshExpiresAtMs <= now + 24 * 60 * 60 * 1000) {
    return {
      status: "refresh_expiring",
      detail:
        `Refresh token expires in ${refreshInMins} minutes` +
        ` (credentials file modified ${modifiedAtIso}); schedule re-login`,
      modifiedAtMs,
      accessExpiresAtMs,
      refreshExpiresAtMs,
    };
  }
  if (accessExpiresAtMs != null && accessExpiresAtMs <= now) {
    return {
      status: "access_expired",
      detail:
        `Access token expired at ${new Date(accessExpiresAtMs).toISOString()}` +
        ` (credentials file modified ${modifiedAtIso}); refresh will be attempted`,
      modifiedAtMs,
      accessExpiresAtMs,
      refreshExpiresAtMs,
    };
  }
  return {
    status: "ok",
    detail:
      `Credentials file modified ${modifiedAtIso}; ` +
      `access expires in ${accessInMins ?? "unknown"} minutes; ` +
      `refresh expires in ${refreshInMins ?? "unknown"} minutes`,
    modifiedAtMs,
    accessExpiresAtMs,
    refreshExpiresAtMs,
  };
}

export async function seedAgentSideClaudeConfig(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId: string,
  agentId: string,
  options?: { skipSdkSubdirs?: boolean },
): Promise<void> {
  const configDir = resolveAgentSideClaudeConfigDir(env, companyId, agentId);
  await fs.mkdir(configDir, { recursive: true, mode: 0o2770 });
  // mkdir masks the mode with the process umask (and skips existing dirs), so
  // enforce the full 0o2770 explicitly: the agent uid (1001) writes SDK
  // session state into this home through its `agents` group membership.
  // Group ownership is set BEFORE the widening chmod: the dir may exist under
  // a foreign group, and 0o2770 must never be opened to a group that is not
  // `agents`.
  await chownToAgentsGroup(configDir, onLog);
  await fs.chmod(configDir, 0o2770);

  // Pre-create the SDK subdirectories at 0o2770 so a run writing into the home
  // starts from group-writable dirs instead of 0700 SDK-created ones. When the
  // lane is armed the agent uid (1001) creates and owns these dirs itself —
  // pre-creating them as the server uid would only mint a subtree the server
  // cannot hand over (chown across uids needs CAP_CHOWN), so the seed skips
  // them and guarantees only the home root + the two credential files below.
  if (options?.skipSdkSubdirs) {
    await onLog(
      "stdout",
      `[paperclip] agent-side Claude config: uid split armed — leaving the SDK subdirs of ${configDir} to the agent uid\n`,
    );
  } else {
    const subdirs: string[] = ["projects", "session-env", "sessions", "shell-snapshots", "statsig"];
    for (const subdir of subdirs) {
      const subdirPath = path.join(configDir, subdir);
      await fs.mkdir(subdirPath, { recursive: true, mode: 0o2770 });
      // Group ownership before the widening chmod (same rationale as the
      // root above); chownToAgentsGroup is itself best-effort.
      await chownToAgentsGroup(subdirPath, onLog);
      try {
        await fs.chmod(subdirPath, 0o2770);
      } catch (error) {
        // Best-effort, the same contract as the run-end re-normalize: a subdir
        // this uid cannot chmod (e.g. a uid-1001-owned dir on an armed lane)
        // is logged and skipped, never fatal — the run must not fail at prep.
        await onLog(
          "stderr",
          `[paperclip] agent-side Claude config: could not chmod ${subdirPath} to 0o2770: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        continue;
      }
    }
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

/**
 * Re-normalize the agent-side Claude config home's directory tree to 0o2770 +
 * the `agents` group after a run.
 *
 * The claude CLI re-creates SDK state dirs with owner-only modes DURING a run —
 * notably `sessions/` at explicit 0o700 and per-worktree `projects/<cwd>/` at
 * 0o700 (→ 0o2700 under the setgid home) — which defeats the one-shot 0o2770
 * seed from `seedAgentSideClaudeConfig`. Walking the tree and re-applying 0o2770
 * + the group after the turn restores the group-`agents`-reachable shape the
 * agent uid (1001) reaches, keeping zero 0700 dirs in the home.
 *
 * Symlinks are not followed: every directory is opened no-follow and mutated
 * through its open fd, so a symlink — present at readdir time or swapped in
 * behind it — can never redirect the walk out of the home. Best-effort by
 * construction: a chmod/chgrp fault on one dir is logged and skipped, never
 * thrown — a re-normalize miss degrades to the next run's seed, not a failed
 * run. Files are left untouched (the seeded credentials are already 0o660;
 * CLI-owned session files are the agent uid's own to read).
 */
export async function normalizeAgentSideClaudeConfigDirPermissions(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId: string,
  agentId: string,
): Promise<void> {
  const configDir = resolveAgentSideClaudeConfigDir(env, companyId, agentId);
  await normalizeClaudeConfigDirTree(configDir, onLog);
}

/**
 * Path-shape guard for the standalone agent-uid normalizer's argv (SUP-13872):
 * the target must resolve to exactly
 * `<instanceRoot>/companies/<companyId>/agents/<agentId>/claude-config` — one
 * company segment, one agent segment, the fixed leaf name. Anything else (a
 * sibling dir, a deeper path, `..` traversal, another tree entirely) is
 * refused before the walk touches the filesystem.
 */
export function isAgentSideClaudeConfigPath(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof target !== "string" || target.trim().length === 0) return false;
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  const rel = path.relative(instanceRoot, path.resolve(target));
  return /^companies\/[^/]+\/agents\/[^/]+\/claude-config$/.test(rel);
}

/**
 * Re-normalize a directory tree to 0o2770 + the `agents` group. Shared by the
 * in-process pass (server uid) and the standalone agent-uid pass, so both
 * walks keep byte-identical semantics:
 *
 *   - descriptor-based no-follow recursion: every directory is opened with
 *     O_NOFOLLOW | O_DIRECTORY and every mutation goes through the open fd
 *     (fstat/fchmod/fchown), so an entry that is swapped for a symlink after
 *     the parent's readdir is refused (ELOOP) instead of re-resolved and
 *     followed — the old path-string recursion re-stat-ed every child from
 *     scratch, and a second uid writing the home could point that
 *     stat/chmod/chown at any path the walk's uid owns,
 *   - on Linux each child is opened against its parent's open fd
 *     (`/proc/self/fd/<fd>/<name>`, openat semantics), so no component under
 *     the opened home is ever re-resolved through the filesystem; elsewhere
 *     the child is opened from the joined path with the same no-follow open
 *     (the M1 uid split — the only topology where another uid writes the
 *     home — is docker/Linux, which takes the fd-anchored branch),
 *   - per-dir best-effort (a fchmod fault is logged and skips that subtree;
 *     a vanished/unopenable dir stops quietly),
 *   - files untouched,
 *   - fstat-and-skip of dirs the running uid does not own, while still
 *     recursing through them: on a mixed-ownership tree each pass fixes every
 *     dir it owns wherever nested and leaves the other uid's dirs alone, so
 *     neither pass emits EPERM noise on the other's dirs every run.
 */
export async function normalizeClaudeConfigDirTree(
  dirPath: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<void> {
  const handle = await openNoFollowDir(dirPath);
  if (!handle) return;
  try {
    await normalizeOpenDirTree(handle, dirPath, onLog);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// Child-entry opens are anchored to the parent's open fd only where procfs is
// available: on Linux `/proc/self/fd/<fd>/<name>` resolves against the inode
// the fd holds — `openat(parent, name, O_NOFOLLOW)` semantics — so a name the
// agent uid re-points under the home between the parent's readdir and the
// child's open cannot redirect the open. The M1 uid split (docker, always
// Linux, procfs always mounted) is the only topology where another uid writes
// the home; off-Linux or no-procfs dev hosts fall back to the joined path,
// which still carries the no-follow open.
const ANCHOR_CHILD_OPENS_TO_PARENT_FD =
  process.platform === "linux" && fsSync.existsSync("/proc/self/fd");

/**
 * O_RDONLY | O_DIRECTORY | O_NOFOLLOW open. Returns null (not a throw) when
 * the path is gone, not a directory, or a symlink: a symlink is refused with
 * ELOOP and must never redirect the walk; a vanished entry has nothing left
 * to normalize.
 */
async function openNoFollowDir(dirPath: string): Promise<fs.FileHandle | null> {
  try {
    return await fs.open(
      dirPath,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    return null;
  }
}

/** Path a child entry is opened through; see ANCHOR_CHILD_OPENS_TO_PARENT_FD. */
function openChildPath(dirPath: string, parentHandle: fs.FileHandle, name: string): string {
  return ANCHOR_CHILD_OPENS_TO_PARENT_FD
    ? `/proc/self/fd/${parentHandle.fd}/${name}`
    : path.join(dirPath, name);
}

async function normalizeOpenDirTree(
  handle: fs.FileHandle,
  dirPath: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<void> {
  let self: Awaited<ReturnType<typeof fs.stat>>;
  try {
    // fstat on the held fd: the ownership check targets the inode we hold,
    // never a path the agent uid can re-point between checks.
    self = await handle.stat();
  } catch {
    // The dir vanished; nothing left to do here.
    return;
  }
  const ownsDir =
    typeof process.getuid !== "function" || self.uid === process.getuid();
  if (ownsDir) {
    try {
      await handle.chmod(0o2770);
    } catch (error) {
      await onLog(
        "stderr",
        `[paperclip] agent-side Claude config: could not chmod ${dirPath} to 0o2770: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return;
    }
    if (typeof process.getuid === "function") {
      try {
        await handle.chown(process.getuid(), AGENTS_GROUP_GID);
      } catch (error) {
        await onLog(
          "stderr",
          `[paperclip] agent-side Claude config: could not chgrp ${dirPath} to agents (gid ${AGENTS_GROUP_GID}): ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    // The dir vanished or is unreadable between the fstat and the readdir; the
    // fchmod above already did what it could. Nothing left to walk.
    return;
  }
  for (const entry of entries) {
    // Only recurse into real directories. A symlink dirent reports
    // isDirectory() === false (the link's own type, not its target's), so the
    // walk never follows a link out of the home; and the child open below is
    // no-follow on the entry's name, so a swap that lands after this readdir
    // is refused there (ELOOP) instead of re-resolved.
    if (!entry.isDirectory()) continue;
    const child = await openNoFollowDir(openChildPath(dirPath, handle, entry.name));
    if (!child) continue;
    try {
      await normalizeOpenDirTree(child, path.join(dirPath, entry.name), onLog);
    } finally {
      await child.close().catch(() => undefined);
    }
  }
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Prepare the sandbox runtime that a Claude hello probe needs. The step
 * installs the Claude CLI in the sandbox when the CLI is absent, and it
 * materializes the Paperclip-managed Claude config directory. Both the CLI
 * Test lane and the ACP Test lane call this helper, so the two lanes probe
 * the same login state. The Claude CLI and the Claude ACP engine share the
 * same stored Claude login.
 *
 * The function mutates `env`: it sets `CLAUDE_CONFIG_DIR` to the managed
 * remote config directory when it materializes one. It returns the checks to
 * add to the Test result. An operator-provided `CLAUDE_CONFIG_DIR` wins, so
 * the function keeps it and skips the managed materialization.
 */
export async function prepareSandboxClaudeProbeRuntime(input: {
  runId: string;
  target: AdapterExecutionTarget | null;
  cwd: string;
  companyId?: string;
  env: Record<string, string>;
  installCommand: string;
  detectCommand: string;
  targetIsRemote: boolean;
  targetIsSandbox: boolean;
  helloProbeTimeoutSec: number;
}): Promise<AdapterEnvironmentCheck[]> {
  const checks: AdapterEnvironmentCheck[] = [];
  const installCheck = await maybeRunSandboxInstallCommand({
    runId: input.runId,
    target: input.target,
    adapterKey: "claude",
    installCommand: input.installCommand,
    detectCommand: input.detectCommand,
    env: input.env,
  });
  if (installCheck) checks.push(installCheck);

  const hasExplicitClaudeConfigDir = isNonEmptyString(input.env.CLAUDE_CONFIG_DIR);
  if (
    input.targetIsRemote &&
    adapterExecutionTargetUsesManagedHome(input.target) &&
    !hasExplicitClaudeConfigDir
  ) {
    let tempWorkspaceDir: string | null = null;
    let preparedRuntime: Awaited<ReturnType<typeof prepareAdapterExecutionTargetRuntime>> | null = null;
    try {
      const seedDir = await prepareClaudeConfigSeed(process.env, async () => {}, input.companyId);
      const managedRemoteCwd =
        input.target?.kind === "remote" ? input.target.remoteCwd : input.cwd;
      tempWorkspaceDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "paperclip-claude-envtest-workspace-"),
      );
      preparedRuntime = await prepareAdapterExecutionTargetRuntime({
        runId: input.runId,
        target: input.target,
        adapterKey: "claude",
        workspaceLocalDir: tempWorkspaceDir,
        workspaceRemoteDir: managedRemoteCwd,
        timeoutSec: Math.max(1, input.helloProbeTimeoutSec),
        assets: [
          {
            key: "config-seed",
            localDir: seedDir,
            followSymlinks: true,
          },
        ],
      });
      const runtimeRootDir =
        preparedRuntime.runtimeRootDir ??
        path.posix.join(managedRemoteCwd, ".paperclip-runtime", "claude");
      const remoteClaudeConfigSeedDir =
        preparedRuntime.assetDirs["config-seed"] ??
        path.posix.join(runtimeRootDir, "config-seed");
      const remoteClaudeConfigDir = path.posix.join(runtimeRootDir, "config");
      input.env.CLAUDE_CONFIG_DIR = remoteClaudeConfigDir;
      await materializeRemoteClaudeConfig({
        runId: input.runId,
        target: input.target,
        remoteClaudeConfigDir,
        remoteClaudeConfigSeedDir,
        options: {
          cwd: input.cwd,
          env: input.env,
          timeoutSec: Math.max(15, input.helloProbeTimeoutSec),
          graceSec: 5,
          onLog: async () => {},
        },
      });
      checks.push({
        code: "claude_managed_config_dir",
        level: "info",
        message: "The environment probe is using Paperclip-managed Claude config materialization.",
        detail: remoteClaudeConfigDir,
      });
    } catch (err) {
      // Keep the raw error out of the Test-result check and the server log. Log
      // only the fixed context, the allowlisted classification, and a safe
      // error class name.
      logSandboxProbeDiagnostic(
        "Could not materialize Paperclip-managed Claude config for the environment probe",
        "spawn_error",
        { errorClass: classifyThrownErrorClass(err) },
      );
      checks.push({
        code: "claude_managed_config_dir_failed",
        level: "error",
        message: "Could not materialize Paperclip-managed Claude config for the environment probe.",
        hint: "Retry the Test. If the failure repeats, check the server log for the redacted diagnostic.",
      });
    } finally {
      await preparedRuntime?.restoreWorkspace().catch(() => undefined);
      if (tempWorkspaceDir) {
        await fs.rm(tempWorkspaceDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  return checks;
}
