import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { agents, environmentLeases, environments, agentInstructionWorkingCopies as copies, type Db } from "@paperclipai/db";
import { syncDirectoryToSsh, restoreWorkspaceFromSshExecution } from "@paperclipai/adapter-utils/ssh";
import { prepareAdapterExecutionTargetRuntime, runAdapterExecutionTargetShellCommand, type AdapterExecutionTarget, type PreparedAdapterExecutionTargetRuntime } from "@paperclipai/adapter-utils/execution-target";
import { withDirectoryMergeLock, directorySnapshotSha256, parseDirectorySnapshot, serializeDirectorySnapshot, type DirectoryMergeLockOperation, type DirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { AGENT_FILES_CONTRACT, AgentFileLimitError, agentFileStore, agentStorageWarning, inspectAgentDirectory } from "./agent-file-store.js";
import { agentInstructionsBundleMode, deriveBundleState, resolveManagedInstructionsRoot } from "./agent-instructions.js";
import { instructionGitExcludeProgram } from "./agent-instruction-files.js";
import { resolveInstructionActor } from "./agent-instruction-authorization.js";
import { HttpError, conflict, notFound, unprocessable } from "../errors.js";
import type { AuthorizationActor } from "./authorization.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { cachedAgentFileManifest, captureAgentFileCheckpoint, checkpointBaseline, checkpointSnapshot, type AgentFileManifest } from "./agent-file-checkpoints.js";
import { logger } from "../middleware/logger.js";

type Copy = typeof copies.$inferSelect;
export class AgentDirectoryReuseInvalidatedError extends Error {}
const completed = new Set(["saved", "unchanged", "resolved", "unavailable"]);
const transports = new Map<string, PreparedAdapterExecutionTargetRuntime>();
const key = (row: Pick<Copy, "companyId" | "runId">) => `${row.companyId}:${row.runId}`;
const execFileAsync = promisify(execFile);

async function workingCopyGid(): Promise<number | null> {
  // Share the live tree only with the fork runtime's agents group, and only
  // when this process may assign it. Otherwise keep the owner-only layout.
  let gid: number | null = null;
  const configured = process.env.PAPERCLIP_AGENTS_GID?.trim();
  if (configured) gid = /^\d+$/.test(configured) ? Number(configured) : null;
  else {
    const { stdout } = await execFileAsync("getent", ["group", "agents"], { timeout: 5000, maxBuffer: 4096 }).catch(() => ({ stdout: "" }));
    const named = stdout.trim().split(":")[2];
    if (named && /^\d+$/.test(named)) gid = Number(named);
  }
  if (gid === null || process.platform === "win32") return null;
  return process.getuid?.() === 0 || process.getegid?.() === gid || process.getgroups?.().includes(gid) ? gid : null;
}

// Group readability is opt-in via the canonical group-read bit, never inferred
// from owner access alone. Strip write access for every non-owner.
const stagedMode = (mode: number) => (mode & ~0o7777) | (mode & 0o700) |
  (mode & 0o400 && mode & 0o040 ? 0o040 | (mode & 0o100 ? 0o010 : 0) : 0);
const STAGED_MODE_VERSION = 3;
const legacyStagedMode = (mode: number) => (mode & ~0o7777) | (mode & 0o100 ? 0o750 : 0o640);
const ownerOnlyMode = (mode: number) => (mode & ~0o7777) | (mode & 0o700);

const LINK_REFUSAL = "Agent directories support regular files and directories, without links or special files";

async function workingCopyPermissions(filename: string, gid: number | null, recursive = true, parentFd?: number): Promise<void> {
  // Windows has no POSIX modes or groups to stage.
  if (process.platform === "win32") return;
  // Linux pins each parent through /proc/self/fd while walking. Other POSIX
  // hosts open each entry without following links and verify its identity.
  const pinned = process.platform === "linux";
  const fdPath = (fd: number) => path.join("/proc/self/fd", String(fd));
  const entryPath = parentFd === undefined ? filename : path.join(fdPath(parentFd), path.basename(filename));
  const expected = await fs.lstat(entryPath);
  if (!expected.isDirectory() && !expected.isFile()) throw unprocessable(LINK_REFUSAL);
  const handle = await fs.open(entryPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK |
    (expected.isDirectory() ? constants.O_DIRECTORY : 0));
  try {
    const stat = await handle.stat();
    if (stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw new Error("Agent working copy entry changed during permission assignment");
    }
    if (stat.isFile() && stat.nlink !== 1) throw unprocessable(LINK_REFUSAL);
    if (pinned && await fs.realpath(fdPath(handle.fd)) !== await fs.realpath(filename)) {
      throw new Error("Agent working copy entry moved during permission assignment");
    }
    if (gid !== null && stat.gid !== gid) await handle.chown(stat.uid, gid);
    // chmod must follow chown (which can clear setgid) and bypass mkdir's umask.
    const owner = stat.mode & 0o700;
    const mode = gid === null ? owner : stat.isDirectory()
      ? owner | ((owner >> 3) & 0o050) | (recursive ? 0o2000 : 0)
      : stagedMode(stat.mode) & 0o7777;
    if (gid !== null || mode !== (stat.mode & 0o7777)) await handle.chmod(mode);
    if (recursive && stat.isDirectory()) {
      for (const entry of await fs.readdir(pinned ? fdPath(handle.fd) : filename)) {
        await workingCopyPermissions(path.join(filename, entry), gid, true, pinned ? handle.fd : undefined);
      }
    }
  } finally { await handle.close(); }
}

const permissionDenied = (error: unknown) => ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");

async function workingCopyParents(agentRoot: string): Promise<number | null> {
  let gid = await workingCopyGid();
  let parent = agentRoot;
  for (const segment of ["file-sync", "runs"]) {
    parent = path.join(parent, segment);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await workingCopyPermissions(parent, gid, false).catch(async error => {
      if (!permissionDenied(error)) throw error;
      gid = null;
      await workingCopyPermissions(parent, null, false);
    });
  }
  return gid;
}

async function stageWorkingCopy(canonical: string, localRoot: string, gid: number | null): Promise<number | null> {
  const runDir = path.dirname(localRoot);
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  // A retry may reuse a previously published run directory. Close it before
  // copying any canonical modes, including group/world-writable entries.
  await fs.chmod(runDir, 0o700);
  await fs.cp(canonical, localRoot, { recursive: true, preserveTimestamps: true });
  try {
    await workingCopyPermissions(localRoot, gid);
    if (gid === null) return null;
    // Publish last: no group member can reach a partially hardened tree.
    await workingCopyPermissions(runDir, gid, false);
    return gid;
  } catch (error) {
    if (!permissionDenied(error)) throw error;
    await fs.chmod(runDir, 0o700);
    await fs.rm(localRoot, { recursive: true, force: true });
    await fs.cp(canonical, localRoot, { recursive: true, preserveTimestamps: true });
    await workingCopyPermissions(localRoot, null);
    return null;
  }
}

function canonicalMode<T extends { kind: string; mode?: number }>(name: string, entry: T, base: DirectorySnapshot, staged: (mode: number) => number): T {
  // A live file still at its staged mode keeps the canonical mode on save;
  // only a mode the run itself set is written back. A file the run created
  // gets the staged rule (owner bits, group read at most), never group write.
  if (entry.kind !== "file" || entry.mode === undefined) return entry;
  const before = base.entries.get(name);
  if (before?.kind !== "file") return { ...entry, mode: stagedMode(entry.mode) };
  return entry.mode === staged(before.mode) || stagedMode(entry.mode) === before.mode ? { ...entry, mode: before.mode } : entry;
}
function stagingFormula(row: Copy): (mode: number) => number {
  if (typeof row.receipt?.stagedGid !== "number") {
    return row.receipt?.stagedModeVersion === STAGED_MODE_VERSION ? ownerOnlyMode : mode => mode;
  }
  return typeof row.receipt?.stagedModeVersion === "number" ? stagedMode : legacyStagedMode;
}
function canonicalSnapshot(snapshot: DirectorySnapshot, base: DirectorySnapshot, staged: (mode: number) => number): DirectorySnapshot {
  return { ...snapshot, entries: new Map([...snapshot.entries].map(([name, entry]) => [name, canonicalMode(name, entry, base, staged)])) };
}
function canonicalManifest(manifest: AgentFileManifest, base: DirectorySnapshot, staged: (mode: number) => number): AgentFileManifest {
  return { ...manifest, entries: manifest.entries.map(([name, entry]) => [name, canonicalMode(name, entry, base, staged)]) };
}
export function isAgentDirectoryCopy(row: Pick<Copy, "receipt"> | null): boolean {
  return row?.receipt?.schema === AGENT_FILES_CONTRACT;
}
function baseline(row: Copy) {
  const snapshot = parseDirectorySnapshot(row.receipt?.baseline);
  if (!snapshot || directorySnapshotSha256(snapshot) !== row.baseHash) throw new Error("Agent directory baseline is invalid");
  return snapshot;
}
function actor(row: Copy): AuthorizationActor {
  return { type: "agent", companyId: row.companyId, agentId: row.agentId, runId: row.runId, onBehalfOfUserId: row.responsibleUserId };
}
export function agentDirectoryWorkingCopyService(db: Db, get: (companyId: string, runId: string) => Promise<Copy | null>, patch: (row: Copy, values: Partial<typeof copies.$inferInsert>) => Promise<Copy>, environmentRuntime?: EnvironmentRuntimeService) {
  const store = agentFileStore(db);
  const ownerFile = (row: Copy) => path.join(path.dirname(row.localRoot), "owner.json");
  async function writeOwner(row: Copy, runId: string) {
    const filename = ownerFile(row);
    const temporary = `${filename}.${randomUUID()}`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ runId }), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, filename);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  async function owns(row: Copy) {
    if (row.receipt?.warm !== true) return true;
    return await fs.readFile(ownerFile(row), "utf8").then(s => JSON.parse(s).runId === row.runId).catch(error => error.code === "ENOENT" && row.processStoppedAt !== null);
  }
  async function canReuse(companyId: string, agentId: string, runId: string) {
    const row = await get(companyId, runId);
    if (!row || row.agentId !== agentId || row.state !== "warm_saved" || row.errorCode || !await owns(row)) return false;
    const entry = baseline(row).entries.get(row.entryFile);
    if (entry?.kind !== "file" || entry.hash !== row.receipt?.sessionEntryHash) return false;
    return store.locked(companyId, agentId, actor(row), false, async (_tx, _agent, root) =>
      directorySnapshotSha256(checkpointSnapshot(await cachedAgentFileManifest(root))) === row.baseHash);
  }
  async function transport(row: Copy, target: AdapterExecutionTarget, recovering: boolean) {
    if (target.kind !== "remote" || row.location !== `remote:${target.environmentId ?? ""}`) throw new Error("Agent directory environment changed");
    if (recovering && target.transport === "ssh") throw new Error("The original SSH collector is unavailable");
    if (target.transport === "ssh") {
      // Reuse SSH's plain directory transfer without its task-workspace suffix
      // or Git-history discovery. The registered root is the exact writable root.
      await syncDirectoryToSsh({ spec: target.spec, localDir: row.localRoot, remoteDir: row.executionRoot, exclude: [".paperclip-runtime"] });
      return { target, workspaceRemoteDir: row.executionRoot, runtimeRootDir: null,
        assetDirs: {}, additionalSourceDirs: {}, additionalSourceFailures: [], workspaceSyncSnapshot: null,
        restoreWorkspace: () => restoreWorkspaceFromSshExecution({ spec: target.spec, localDir: row.localRoot,
          remoteDir: row.executionRoot, baselineSnapshot: { ...baseline(row), exclude: [".paperclip-runtime"] }, restoreGitHistory: false }) };
    }
    return prepareAdapterExecutionTargetRuntime({ target, runId: row.runId, adapterKey: "agent-files",
      workspaceLocalDir: row.localRoot, workspaceRemoteDir: row.executionRoot,
      syncWorkspace: true, workspaceInboundMode: recovering ? "adopt_remote" : undefined,
      workspaceBaseline: baseline(row), workspaceGitSnapshot: null, workspaceFileMode: "all",
      workspaceExclude: [".paperclip-runtime", ".paperclip-runtime/**"] });
  }
  async function prepareCopy(input: { companyId: string; agentId: string; runId: string; target?: AdapterExecutionTarget | null; cwd: string; warm?: boolean; reuseRunId?: string; onWarmHandoff?: (copy: Copy) => void }, serialHeld = false): Promise<Copy | null> {
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
    if (!agent) throw notFound("Agent not found");
    if (agentInstructionsBundleMode(agent) !== "managed") return null;
    const bound = await resolveInstructionActor(db, { type: "agent", companyId: input.companyId, agentId: input.agentId, runId: input.runId });
    const root = resolveManagedInstructionsRoot(agent);
    if (input.reuseRunId) {
      const prior = await get(input.companyId, input.reuseRunId);
      if (!prior || prior.agentId !== input.agentId) throw conflict("Managed warm directory owner changed");
      return serial(prior, async current => {
        if (current.state !== "warm_saved" || current.errorCode || !await owns(current) || current.location !== (input.target?.kind === "remote" ? `remote:${input.target.environmentId ?? ""}` : "local")) throw conflict("Managed warm directory is not reusable");
        const receipt = { ...current.receipt, cleanup: input.target?.kind === "remote" ? { leaseId: input.target.leaseId ?? null, remoteCwd: input.target.remoteCwd } : undefined };
        // Insert before taking the agent-row lock: this foreign key needs an
        // independent transaction, and must survive post-handoff failures.
        const [successor] = await db.insert(copies).values({ runId: input.runId, companyId: input.companyId, agentId: input.agentId, responsibleUserId: bound.onBehalfOfUserId!,
          entryFile: current.entryFile, baseHash: current.baseHash, localRoot: current.localRoot, executionRoot: current.executionRoot, location: current.location, state: "prepared", receipt }).returning();
        let handedOff = false;
        try { return await store.locked(input.companyId, input.agentId, bound, false, async (_tx, lockedAgent, canonical) => {
          // The reservation's earlier check is only a hint. Serialize this last
          // validation and ownership transfer with every canonical writer.
          if (current.entryFile !== deriveBundleState(lockedAgent).entryFile ||
              directorySnapshotSha256(checkpointSnapshot(await cachedAgentFileManifest(canonical))) !== current.baseHash) {
            throw new AgentDirectoryReuseInvalidatedError("Managed agent files changed before warm directory handoff");
          }
          // The controller-owned marker fences old callbacks. Attach the new
          // collector immediately after it moves, before fallible bookkeeping.
          await writeOwner(current, input.runId);
          handedOff = true;
          input.onWarmHandoff?.(successor!);
          const runtime = transports.get(key(current));
          if (runtime) transports.set(key(successor!), runtime);
          transports.delete(key(current));
          await patch(current, { state: "superseded", receipt: { schema: AGENT_FILES_CONTRACT, warm: true, successorRunId: input.runId } });
          return successor!;
        }); } catch (error) {
          // No process used this proposed owner. Remove it after the canonical
          // lock releases so the same run can restore a fresh directory.
          if (!handedOff) await db.delete(copies).where(and(eq(copies.companyId, input.companyId), eq(copies.runId, input.runId)));
          throw error;
        }
      }, "agent_directory_handoff");
    }
    const localRoot = path.join(path.dirname(root), "file-sync", "runs", input.runId, "live");
    // Local copies live outside the task cwd. Remote copies use the reserved,
    // excluded runtime area inside the provider's confined workspace. They are
    // synchronized independently; provider HOME is never reinterpreted.
    const executionRoot = input.target?.kind === "remote"
      ? path.posix.join(input.target.remoteCwd, ".paperclip-runtime", "agent-files", input.agentId, input.runId)
      : localRoot;
    const location = input.target?.kind === "remote" ? `remote:${input.target.environmentId ?? ""}` : "local";
    let row = await get(input.companyId, input.runId);
    if (row && (row.localRoot !== localRoot || row.executionRoot !== executionRoot || row.agentId !== input.agentId || row.location !== location)) throw conflict("Agent directory belongs to a different execution environment");
    if (row && !serialHeld) {
      // Restart preparation can replace a completed copy under the same run ID.
      // Join cleanup's lock before resetting its receipt or creating new bytes.
      // Interrupted admission may have registered the row before making this root.
      await workingCopyParents(path.dirname(root));
      return serial(row, () => prepareCopy(input, true), "agent_directory_prepare");
    }
    if (row && !completed.has(row.state) && row.state !== "preparing") {
      if (input.target?.kind === "remote" && !transports.has(key(row))) transports.set(key(row), await transport(row, input.target, true));
      return row;
    }
    // Register ownership before creating any bytes, so a crash during the copy
    // leaves a recoverable preparing receipt instead of an orphan directory.
    const preparing = { entryFile: deriveBundleState(agent).entryFile, baseRevisionId: null, baseHash: "preparing",
      localRoot, executionRoot, location, state: "preparing", candidateBase64: null, candidateHash: null,
      receipt: { schema: AGENT_FILES_CONTRACT, ...(input.warm ? { warm: true, directoryRunId: input.runId } : {}), ...(input.target?.kind === "remote"
        ? { cleanup: { leaseId: input.target.leaseId ?? null, remoteCwd: input.target.remoteCwd } } : {}) }, processStoppedAt: null, attempts: 0,
      nextAttemptAt: null, errorCode: null, errorMessage: null };
    if (row) row = await patch(row, preparing);
    else {
      await db.insert(copies).values({ runId: input.runId, companyId: input.companyId, agentId: input.agentId, responsibleUserId: bound.onBehalfOfUserId!, ...preparing });
      row = (await get(input.companyId, input.runId))!;
    }
    const { snapshot, storageWarning, stagedGid } = await store.locked(input.companyId, input.agentId, bound, false, async (_tx, _agent, canonical) => {
      // Storage quotas govern saves, never admission to a future run. Restore
      // existing bytes so the agent can work normally and remove excess files.
      // Path/link validation remains mandatory even for an over-quota folder.
      const inspected = await inspectAgentDirectory(canonical, false);
      // A stopped lifecycle has already accounted for all its bytes. No live
      // or pending candidate ever enters this replacement path.
      await fs.rm(localRoot, { recursive: true, force: true });
      const gid = await workingCopyParents(path.dirname(root));
      try {
        return { ...inspected, stagedGid: await stageWorkingCopy(canonical, localRoot, gid) };
      } catch (error) {
        await fs.rm(path.dirname(localRoot), { recursive: true, force: true });
        throw error;
      }
    }).catch(async error => {
      await fs.rm(path.dirname(localRoot), { recursive: true, force: true });
      throw error;
    });
    const loadedEntry = snapshot.entries.get(deriveBundleState(agent).entryFile);
    const values = { entryFile: deriveBundleState(agent).entryFile, baseRevisionId: null, baseHash: directorySnapshotSha256(snapshot),
      localRoot, executionRoot, location, state: "preparing", candidateBase64: null, candidateHash: null,
      receipt: { ...preparing.receipt, baseline: serializeDirectorySnapshot(snapshot), storageWarning, stagedModeVersion: STAGED_MODE_VERSION, ...(stagedGid !== null ? { stagedGid } : {}),
        ...(input.warm ? { sessionEntryHash: loadedEntry?.kind === "file" ? loadedEntry.hash : null } : {}) },
      processStoppedAt: null, attempts: 0, nextAttemptAt: null, errorCode: null, errorMessage: null };
    try {
      row = await patch(row, values);
      if (input.warm) await writeOwner(row, row.runId);
    } catch (error) {
      await fs.rm(path.dirname(localRoot), { recursive: true, force: true });
      throw error;
    }
    try {
      if (input.target?.kind === "remote") {
        const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
        const excluded = await runAdapterExecutionTargetShellCommand(input.runId, input.target,
          `node -e ${quote(instructionGitExcludeProgram)} ${quote(input.target.remoteCwd)}`,
          { cwd: input.target.remoteCwd, env: {}, timeoutSec: 15 });
        if (excluded.exitCode !== 0 || excluded.timedOut) throw new Error("Could not exclude agent files from task Git staging");
        transports.set(key(row), await transport(row, input.target, false));
      }
      return await patch(row, { state: "prepared" });
    } catch (error) {
      // Preparation failed before a provider could start using this copy.
      row = await patch(row, { state: "unavailable", processStoppedAt: new Date(), errorCode: "AGENT_FILES_PREPARE_FAILED",
        errorMessage: "Agent files could not be staged. The temporary copy was discarded.", nextAttemptAt: null });
      await release(row, input.target);
      throw error;
    }
  }

  async function retrieve(row: Copy, target?: AdapterExecutionTarget | null) {
    if (row.location !== "local") {
      let runtime = transports.get(key(row));
      if (!runtime) {
        if (!target) throw new Error("Agent directory transport is unavailable");
        runtime = await transport(row, target, true);
        transports.set(key(row), runtime);
      }
      // The restore helper preserves remote modes and mkdir's umask. Fence the
      // entire apply, including its temporary files, until the staging rule has
      // removed non-owner write access from every restored entry.
      const runDir = path.dirname(row.localRoot);
      await fs.chmod(runDir, 0o700);
      await runtime.restoreWorkspace();
      const gid = typeof row.receipt?.stagedGid === "number" ? row.receipt.stagedGid : null;
      await workingCopyPermissions(row.localRoot, gid);
      if (gid !== null) await workingCopyPermissions(runDir, gid, false);
    }
    return inspectAgentDirectory(row.localRoot);
  }
  async function hasChanges(_row: Copy, _target?: AdapterExecutionTarget | null) {
    // A whole-directory collector needs a quiescent provider, including its
    // child processes. Checkpoint and close at the turn boundary before reading
    // either local or remote files. The provider conversation remains resumable;
    // ordinary file edits do not change the session configuration digest.
    return true;
  }
  async function checkpoint(row: Copy, target?: AdapterExecutionTarget | null, stopped = false): Promise<Copy> {
    if (!await owns(row) || row.state === "superseded") return row;
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      let captured: Awaited<ReturnType<typeof captureAgentFileCheckpoint>> | undefined;
      try {
        const previous = row.receipt?.checkpointManifest as AgentFileManifest | undefined ?? checkpointBaseline(baseline(row));
        captured = await captureAgentFileCheckpoint({ runId: row.runId, localRoot: row.localRoot, executionRoot: row.executionRoot, previous, target });
        const manifest = canonicalManifest(captured.manifest, baseline(row), stagingFormula(row));
        const snapshot = checkpointSnapshot(manifest);
        const nextHash = directorySnapshotSha256(snapshot);
        const changed = nextHash !== row.baseHash;
        const { storageWarning } = changed
          ? await store.apply({ companyId: row.companyId, agentId: row.agentId, sourceDir: path.join(captured.directory, "files"), baseline: baseline(row), checkpoint: manifest }, actor(row))
          : await store.locked(row.companyId, row.agentId, actor(row), true, async () => ({
            storageWarning: typeof row.receipt?.storageWarning === "string" ? row.receipt.storageWarning : null,
          }));
        row = await patch(row, { state: stopped ? (changed ? "saved" : "unchanged") : "warm_saved", baseHash: nextHash,
          candidateHash: nextHash, errorCode: null, errorMessage: null, attempts: 0, nextAttemptAt: null,
          ...(stopped ? { processStoppedAt: new Date() } : {}),
          receipt: { ...row.receipt, baseline: serializeDirectorySnapshot(snapshot), checkpointManifest: captured.manifest,
            checkpointState: changed ? "saved" : "unchanged", checkpointStats: captured.stats, storageWarning } });
        return row;
      } catch (error) {
        failure = error;
        logger.warn({ err: error, runId: row.runId, attempt: attempt + 1, stopped }, "Agent file checkpoint failed");
        if (error instanceof HttpError && error.status < 500) break;
      }
      finally {
        await captured?.cleanup().catch(error => logger.warn({ err: error, runId: row.runId }, "Agent checkpoint scratch cleanup deferred to session retirement"));
      }
    }
    const rejection = failure instanceof HttpError && failure.status === 403 ? failure.message : null;
    if (!stopped) return patch(row, { errorCode: "AGENT_FILES_CHECKPOINT_UNSTABLE",
      errorMessage: rejection ? `Agent-file save rejected: ${rejection} Changes were not saved.` : "Incremental checkpoint could not be validated; collecting after provider stop.", nextAttemptAt: null });
    const storageLimit = failure instanceof AgentFileLimitError || String(failure).includes("LIMIT_EXCEEDED");
    return patch(row, { state: "unavailable", processStoppedAt: new Date(), errorCode: storageLimit ? "AGENT_FILES_LIMIT_EXCEEDED" : "AGENT_FILES_SAVE_FAILED",
      errorMessage: rejection ? `Agent-file save rejected: ${rejection} Changes were not saved.` : "Agent-file synchronization failed after provider stop. No successful save is claimed.", nextAttemptAt: null,
      receipt: { ...row.receipt, storageWarning: storageLimit ? agentStorageWarning(failure instanceof AgentFileLimitError ? failure.message : "Agent folder exceeds a storage limit") : null } });
  }
  async function collectStopped(row: Copy, target?: AdapterExecutionTarget | null) {
    if (!await owns(row) || row.state === "superseded") return row;
    if (row.receipt?.warm === true && !completed.has(row.state)) {
      row = await checkpoint(row, target, true);
      await release(row, target);
      return (await get(row.companyId, row.runId))!;
    }
    if (completed.has(row.state)) { await release(row); return (await get(row.companyId, row.runId))!; }
    row = await patch(row, { processStoppedAt: row.processStoppedAt ?? new Date() });
    // The stopped working copy is the only temporary tree. Retry transient I/O
    // at this boundary, then clean it up; there are no preserved run snapshots.
    let inspected: Awaited<ReturnType<typeof retrieve>> | undefined;
    for (;;) {
      row = await patch(row, { attempts: row.attempts + 1 });
      try {
        inspected ??= await retrieve(row, target);
        const snapshot = canonicalSnapshot(inspected.snapshot, baseline(row), stagingFormula(row));
        const candidateHash = directorySnapshotSha256(snapshot);
        let storageWarning = inspected.storageWarning;
        if (candidateHash === row.baseHash) {
          row = await patch(row, { state: "unchanged", errorCode: null, errorMessage: null, nextAttemptAt: null });
        } else {
          ({ storageWarning } = await store.apply({ companyId: row.companyId, agentId: row.agentId, sourceDir: row.localRoot, baseline: baseline(row), snapshot }, actor(row)));
          row = await patch(row, { state: "saved", candidateHash, errorCode: null, errorMessage: null, nextAttemptAt: null });
        }
        row = await patch(row, { receipt: { ...row.receipt, storageWarning } });
        break;
      } catch (error) {
        const retryable = !(error instanceof HttpError) || error.status >= 500;
        if (retryable && row.attempts < 3) continue;
        row = await patch(row, { state: "unavailable", nextAttemptAt: null,
          receipt: { ...row.receipt, storageWarning: error instanceof AgentFileLimitError ? agentStorageWarning(error.message) : row.receipt?.storageWarning ?? null },
          errorCode: error instanceof AgentFileLimitError ? "AGENT_FILES_LIMIT_EXCEEDED" : "AGENT_FILES_SAVE_FAILED",
          errorMessage: error instanceof HttpError && (error.status === 403 || error.status === 422)
            ? `${error.message}. This run's agent-folder changes were not saved; the temporary copy is discarded.`
            : "Agent-file synchronization failed. No successful save is claimed; the temporary copy is discarded.",
        });
        break;
      }
    }
    await release(row);
    return (await get(row.companyId, row.runId))!;
  }
  function releaseIsNoop(row: Copy) {
    return row.state === "superseded" || !row.processStoppedAt ||
      completed.has(row.state) && row.receipt?.cleanupPending === false;
  }
  async function release(row: Copy, target?: AdapterExecutionTarget | null) {
    if (releaseIsNoop(row) || !await owns(row)) return;
    const destroyedOnly = row.receipt?.cleanupDestroyedOnly === true;
    const runtime = transports.get(key(row));
    transports.delete(key(row));
    let cleanupPending = false;
    await runtime?.cleanupWorkspaceSnapshot?.().catch(() => { cleanupPending = true; });
    const cleanupTarget = target ?? runtime?.target;
    if (!destroyedOnly && row.processStoppedAt && completed.has(row.state) && cleanupTarget?.kind === "remote") {
      const expected = path.posix.join(cleanupTarget.remoteCwd, ".paperclip-runtime", "agent-files", row.agentId, String(row.receipt?.directoryRunId ?? row.runId));
      if (row.executionRoot !== expected) throw new Error("Agent directory cleanup path changed");
      const quoted = `'${expected.replaceAll("'", `'"'"'`)}'`;
      const remoteCleanupFailed = await runAdapterExecutionTargetShellCommand(row.runId, cleanupTarget, `rm -rf -- ${quoted}`,
        { cwd: cleanupTarget.remoteCwd, env: {}, timeoutSec: 15 }).then(result => result.exitCode !== 0 || result.timedOut, () => true);
      cleanupPending ||= remoteCleanupFailed;
    } else if (row.processStoppedAt && completed.has(row.state) && row.location !== "local") {
      // Rebind only the original host-owned lease. Never acquire a replacement
      // sandbox or persist transport credentials in a working-copy receipt.
      cleanupPending ||= !await cleanupRemoteAfterRestart(row, destroyedOnly).catch(() => false);
    }
    if (completed.has(row.state) && row.processStoppedAt) {
      try { await fs.rm(path.dirname(row.localRoot), { recursive: true, force: true }); }
      catch {
        // Leave the baseline marker so restart recovery retries failed cleanup.
        await patch(row, { receipt: { ...row.receipt, cleanupPending: true } });
        return;
      }
      await patch(row, { receipt: { schema: AGENT_FILES_CONTRACT, state: row.state, appliedCandidateHash: row.candidateHash, storageWarning: row.receipt?.storageWarning ?? null, cleanupPending,
        ...(row.receipt?.directoryRunId ? { directoryRunId: row.receipt.directoryRunId } : {}),
        ...(cleanupPending ? { cleanup: row.receipt?.cleanup, ...(destroyedOnly ? { cleanupDestroyedOnly: true } : {}) } : {}) },
        nextAttemptAt: cleanupPending ? new Date(Date.now() + 30_000) : null });
    }
  }
  async function destroyedRemoteCopy(row: Copy): Promise<boolean> {
    const cleanup = row.receipt?.cleanup as { leaseId?: string; remoteCwd?: string } | undefined;
    const leases = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, row.companyId), eq(environmentLeases.heartbeatRunId, row.runId),
      cleanup?.leaseId ? eq(environmentLeases.id, cleanup.leaseId)
        : eq(environmentLeases.environmentId, row.location.slice("remote:".length)),
    ));
    if (leases.length !== 1) return false;
    const lease = leases[0]!;
    if (lease.environmentId !== null && row.location !== `remote:${lease.environmentId}`) return false;
    const remoteCwd = cleanup?.remoteCwd ?? lease.metadata?.remoteCwd;
    return typeof remoteCwd === "string" &&
      row.executionRoot === path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", row.agentId, String(row.receipt?.directoryRunId ?? row.runId)) &&
      hasRemoteTerminationReceipt(lease) && (lease.metadata?.remoteExecutionTermination as { state?: string }).state === "destroyed";
  }
  async function recoverUnavailable(row: Copy) {
    const eligible = (current: Copy) => isAgentDirectoryCopy(current) && current.location.startsWith("remote:") &&
      current.state === "unavailable" && !current.processStoppedAt;
    // Do not wait for a directory lock when no cleanup can be authorized.
    if (!eligible(row) || !await destroyedRemoteCopy(row)) return;
    await serial(row, async current => {
      if (!eligible(current) || !await destroyedRemoteCopy(current)) return;
      // The no-execute authority must survive a crash after this update. Every
      // later release, including one with a cached transport, honors it.
      const confirmed = await patch(current, { processStoppedAt: new Date(),
        receipt: { ...current.receipt, cleanupDestroyedOnly: true } });
      // A concurrent preparation can win the receipt CAS. Its bytes stay live.
      if (confirmed.state === "unavailable" && confirmed.processStoppedAt) await release(confirmed);
    }, "agent_directory_release");
  }
  async function cleanupRemoteAfterRestart(row: Copy, destroyedOnly = false): Promise<boolean> {
    // Newly recovered loss receipts permit no command that could wake a stopped
    // provider. Recheck the exact destruction binding even after lock acquisition.
    if (destroyedOnly) return destroyedRemoteCopy(row);
    const cleanup = row.receipt?.cleanup as { leaseId?: string; remoteCwd?: string } | undefined;
    // Older preview receipts did not record the lease ID. Accept only a unique
    // lease still bound to this run and environment in that compatibility case.
    const leases = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, row.companyId),
      cleanup?.leaseId ? eq(environmentLeases.id, cleanup.leaseId) : and(
        eq(environmentLeases.environmentId, row.location.slice("remote:".length)), eq(environmentLeases.heartbeatRunId, row.runId)),
    ));
    if (leases.length !== 1) return false;
    const lease = leases[0]!;
    const termination = lease.metadata?.remoteExecutionTermination as { state?: string } | undefined;
    if (hasRemoteTerminationReceipt(lease) && termination?.state === "destroyed") return true;
    if (!environmentRuntime || !lease.environmentId || row.location !== `remote:${lease.environmentId}`) return false;
    const [environment] = await db.select().from(environments).where(eq(environments.id, lease.environmentId));
    if (!environment) return false;
    const remoteCwd = cleanup?.remoteCwd ?? lease.metadata?.remoteCwd;
    if (typeof remoteCwd !== "string" || row.executionRoot !== path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", row.agentId, String(row.receipt?.directoryRunId ?? row.runId))) return false;
    const result = await environmentRuntime.execute({ environment: environment as Environment, lease: lease as EnvironmentLease, command: "rm", args: ["-rf", "--", row.executionRoot],
      cwd: remoteCwd, env: {}, timeoutMs: 15_000, bypassSession: true });
    return result.exitCode === 0 && !result.timedOut;
  }
  async function serial<T>(row: Copy, fn: (current: Copy) => Promise<T>, operation: DirectoryMergeLockOperation): Promise<T> {
    // Duplicate stop callbacks and restart recovery must not race while moving
    // the stopped working copy. This lock is outside the writable tree.
    return withDirectoryMergeLock(path.resolve(row.localRoot, "../../.."), async () => {
      const current = await get(row.companyId, row.runId);
      if (!current) throw notFound("Agent directory copy not found");
      return fn(current);
    }, process.env, operation);
  }
  return { prepare: (input: Parameters<typeof prepareCopy>[0]) => prepareCopy(input), hasChanges, canReuse, recoverUnavailable,
    checkpointWarm: (row: Copy, target?: AdapterExecutionTarget | null) => serial(row, current => current.receipt?.warm === true ? checkpoint(current, target) : Promise.resolve(current), "agent_directory_checkpoint"),
    collectStopped: (row: Copy, target?: AdapterExecutionTarget | null) => serial(row, current => collectStopped(current, target), "agent_directory_collect"),
    release: async (row: Copy) => {
      const current = await get(row.companyId, row.runId);
      // This check changes no receipt or bytes. A concurrent stop merely leaves
      // cleanup to its owner or the recovery sweep; it grants no new authority.
      if (!current || releaseIsNoop(current)) return;
      await serial(current, release, "agent_directory_release");
    },
  };
}
