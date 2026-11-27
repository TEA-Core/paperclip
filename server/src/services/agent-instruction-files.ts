import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const execFileAsync = promisify(execFile);

export const MAX_INSTRUCTION_BYTES = 1024 * 1024;
export function instructionPath(value: string): string {
  if (
    !value ||
    value.length > 512 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    /^[a-z]:/i.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw unprocessable("Use a relative instructions path without traversal", {
      code: "INSTRUCTION_PATH_INVALID",
    });
  }
  return value;
}

export function instructionBytes(content: string | Uint8Array): Buffer {
  const byteLength =
    typeof content === "string"
      ? Buffer.byteLength(content, "utf8")
      : content.byteLength;
  if (byteLength > MAX_INSTRUCTION_BYTES) {
    throw unprocessable("Instructions exceed the 1 MiB limit", {
      code: "INSTRUCTION_CONTENT_INVALID",
    });
  }
  const bytes =
    typeof content === "string"
      ? Buffer.from(content, "utf8")
      : Buffer.from(content);
  try {
    // Preserve BOM; reject invalid UTF-8 and unpaired JS surrogates instead of replacing bytes.
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (typeof content === "string" && decoded !== content)
      throw new Error("invalid Unicode");
  } catch {
    throw unprocessable("Instructions must be valid UTF-8", {
      code: "INSTRUCTION_CONTENT_INVALID",
    });
  }
  return bytes;
}

export async function assertInstructionPathSafe(
  root: string,
  entryFile: string,
) {
  instructionPath(entryFile);
  let absolute = path.resolve(root, entryFile);
  // macOS exposes its system temporary directories through root-owned aliases.
  // Resolve only those fixed OS aliases, never a link in operator/agent storage.
  if (process.platform === "darwin") {
    const alias = absolute.split(path.sep)[1];
    if (alias === "var" || alias === "tmp" || alias === "etc") {
      const systemPath = `/${alias}`;
      const stat = await fs.lstat(systemPath);
      if (stat.isSymbolicLink() && stat.uid === 0 && await fs.realpath(systemPath) === `/private/${alias}`) {
        absolute = `/private${absolute}`;
      }
    }
  }
  let current = path.parse(absolute).root;
  const parts = absolute.slice(current.length).split(path.sep);
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await fs
      .lstat(current)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (!stat) continue;
    if (
      stat.isSymbolicLink() ||
      (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())
    ) {
      throw unprocessable(
        "Instructions require regular files and directories without symlinks",
        { code: "INSTRUCTION_PATH_INVALID" },
      );
    }
  }
  return absolute;
}

export async function readInstructionBytes(
  root: string,
  entryFile: string,
): Promise<Buffer | null> {
  const absolute = await assertInstructionPathSafe(root, entryFile);
  const file = await fs
    .open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (!file) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_INSTRUCTION_BYTES) {
      throw unprocessable(
        "Instructions must be a regular UTF-8 file of at most 1 MiB",
        { code: "INSTRUCTION_CONTENT_INVALID" },
      );
    }
    const buffer = Buffer.alloc(MAX_INSTRUCTION_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    return instructionBytes(buffer.subarray(0, length));
  } finally {
    await file.close();
  }
}

const AGENTS_GROUP = "agents";
const warnedGroups = new Set<string>();

function warnGroupOnce(key: string, details: Record<string, unknown>, message: string) {
  if (warnedGroups.has(key)) return;
  warnedGroups.add(key);
  logger.warn(details, message);
}

async function namedAgentsGid(): Promise<number | null> {
  const { stdout } = await execFileAsync("getent", ["group", AGENTS_GROUP], { timeout: 5000, maxBuffer: 4096 })
    .catch(() => ({ stdout: "" }));
  const field = String(stdout).trim().split(":")[2];
  return field && /^\d+$/.test(field) ? Number(field) : null;
}

/**
 * Resolve the runtime's `agents` group by name. When the name does not resolve
 * (no group, no `getent`, or a lookup timeout) no group is used, whatever
 * `PAPERCLIP_AGENTS_GID` says. The override is accepted only when it equals the
 * named group's gid and is neither gid 0 nor this process's primary group.
 * Returns null (owner-only access) when no valid group resolves or this
 * process may not assign it: group access is never granted to another group.
 * Resolve once per operation and pass the result as `gid`.
 */
export async function resolveAgentsGid(): Promise<number | null> {
  const named = await namedAgentsGid();
  const configured = process.env.PAPERCLIP_AGENTS_GID?.trim();
  if (named === null) {
    warnGroupOnce(`missing:${configured ?? ""}`, { configured },
      "The agents group does not resolve by name; instruction files stay owner-only");
    return null;
  }
  if (configured && (
    configured !== String(named) || named === 0 ||
    named === process.getgid?.() || named === process.getegid?.()
  )) {
    warnGroupOnce(`override:${configured}:${named}`, { configured, named },
      "PAPERCLIP_AGENTS_GID refused: it must equal the agents group's gid and not be gid 0 or the server's primary group");
    return null;
  }
  if (named === 0) return null;
  return process.getuid?.() === 0 || process.getegid?.() === named || process.getgroups?.().includes(named) ? named : null;
}

export interface InstructionAccessOptions {
  /** Directories and files stay owner-only even when the agents group resolves. */
  privateTree?: boolean;
  /** The file stays owner-only; its directories follow the shared layout. */
  privateFile?: boolean;
  /** Resolved agents gid; omit to resolve it now. */
  gid?: number | null;
}

const within = (root: string, candidate: string) =>
  candidate === root || candidate.startsWith(root + path.sep);

type UnsafeStorageReason = "foreign-owner" | "world-writable-ancestor" | "cannot-tighten";

function unsafeStorage(directory: string, reason: UnsafeStorageReason, code?: string) {
  logger.warn({ directory, reason, code }, "Refusing instruction write: unsafe instruction storage");
  return unprocessable("Instruction storage permissions are unsafe", { code: "INSTRUCTION_STORAGE_UNSAFE", reason });
}

const serverUid = () => process.geteuid?.() ?? process.getuid?.();

async function openDirectory(directory: string) {
  return fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ELOOP" || error.code === "ENOTDIR") {
        throw unprocessable("Instructions require regular files and directories without symlinks", { code: "INSTRUCTION_PATH_INVALID" });
      }
      throw error;
    });
}

const permissionDenied = (error: unknown) => ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");

/**
 * For canonical storage under `<instance>/companies/`, check the existing
 * directories from the instance root down to just above the instruction root,
 * by handle and without following symlinks. Each must be owned by the server
 * uid and not world-writable. A server-owned directory that is only
 * group-writable loses group write in place. Nothing outside the instance root
 * is checked or changed. Other roots (an external bundle, a run's private copy
 * inside a task workspace) have no managed ancestors.
 */
async function assertInstructionAncestorsSafe(root: string) {
  const instanceRoot = path.resolve(resolvePaperclipInstanceRoot());
  const companies = path.join(instanceRoot, "companies");
  if (root === companies || !within(companies, root)) return;
  for (let current = instanceRoot; current !== root; current = path.join(current, path.relative(current, root).split(path.sep)[0]!)) {
    const handle = await openDirectory(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!handle) return;
    try {
      const stat = await handle.stat();
      if (stat.uid !== serverUid()) throw unsafeStorage(current, "foreign-owner");
      if (stat.mode & 0o002) throw unsafeStorage(current, "world-writable-ancestor");
      if (stat.mode & 0o020) {
        await handle.chmod(stat.mode & 0o7757).catch((error: unknown) => {
          if (!permissionDenied(error)) throw error;
          throw unsafeStorage(current, "cannot-tighten", (error as NodeJS.ErrnoException).code);
        });
      }
    } finally {
      await handle.close();
    }
  }
}

/**
 * Force one directory to the instruction layout by handle, never following a
 * symlink: owner rwx, agents group r-x, nothing for others; owner-only when
 * gid is null. Refuse the write when the directory is not owned by the server
 * uid or an unsafe mode cannot be tightened.
 */
async function secureInstructionDirectory(directory: string, gid: number | null) {
  const mode = gid === null ? 0o700 : 0o750;
  const handle = await openDirectory(directory);
  try {
    const stat = await handle.stat();
    if (stat.uid !== serverUid()) throw unsafeStorage(directory, "foreign-owner");
    try {
      if (gid !== null && stat.gid !== gid) await handle.chown(-1, gid);
      // chmod follows chown, which may clear mode bits, and bypasses the umask.
      if ((stat.mode & 0o7777) !== mode || (gid !== null && stat.gid !== gid)) await handle.chmod(mode);
    } catch (error) {
      if (!permissionDenied(error)) throw error;
      throw unsafeStorage(directory, "cannot-tighten", (error as NodeJS.ErrnoException).code);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Create `directory` and force every managed directory to the instruction
 * layout: from `root` (default: `directory` itself) down to `directory`, plus
 * any ancestors this call created. Existing loose directories are tightened.
 * Existing ancestors inside the instance root are checked first.
 */
export async function createInstructionDirectory(
  directory: string,
  options: InstructionAccessOptions & { root?: string } = {},
) {
  const gid = options.privateTree ? null : options.gid === undefined ? await resolveAgentsGid() : options.gid;
  const target = path.resolve(directory);
  const root = path.resolve(options.root ?? directory);
  if (!within(root, target)) throw new Error("Instruction directory is outside its root");
  await assertInstructionAncestorsSafe(root);
  const created = await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const first = created && !within(root, path.resolve(created)) ? path.resolve(created) : root;
  const chain: string[] = [];
  for (let current = target; ; current = path.dirname(current)) {
    chain.unshift(current);
    if (current === first || current === path.dirname(current)) break;
  }
  for (const current of chain) await secureInstructionDirectory(current, gid);
}

/** Call while holding the canonical agent lock. Never writes through a symlink. */
export async function materializeInstructionBytes(
  root: string,
  entryFile: string,
  bytes: Buffer,
  options: InstructionAccessOptions = {},
) {
  const gid = options.privateTree ? null : options.gid === undefined ? await resolveAgentsGid() : options.gid;
  const shared = gid !== null && !options.privateFile && !options.privateTree;
  const absolute = await assertInstructionPathSafe(root, entryFile);
  // Derive the root from the checked path so OS alias resolution stays consistent.
  const resolvedRoot = path.resolve(absolute, ...entryFile.split("/").map(() => ".."));
  await createInstructionDirectory(path.dirname(absolute), { root: resolvedRoot, gid });
  await assertInstructionPathSafe(root, entryFile);
  const temporary = path.join(
    path.dirname(absolute),
    `.instruction-${randomUUID()}.tmp`,
  );
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      if (shared) await file.chown(-1, gid);
      await file.chmod(shared ? 0o640 : 0o600);
      await file.sync();
    } finally {
      await file.close();
    }
    await assertInstructionPathSafe(root, entryFile);
    await fs.rename(temporary, absolute);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

// Keep the reserved runtime directory out of Git using a self-ignoring file
// inside that directory. Never write to a gitdir or exclude path derived from
// repository-controlled metadata; legitimate worktrees can keep external gitdirs.
export const instructionGitExcludeProgram = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const cwd=fs.realpathSync(process.argv[1]);
const root=path.join(cwd,'.paperclip-runtime'),filename=path.join(root,'.gitignore');
const stat=(name)=>{try{return fs.lstatSync(name)}catch(e){if(e.code==='ENOENT')return null;throw e}};
const directory=stat(root);
if(directory && (directory.isSymbolicLink() || !directory.isDirectory()))throw Error('Unsafe runtime exclusion directory');
if(!directory)fs.mkdirSync(root,{mode:0o700});
const existing=stat(filename);
if(existing && (existing.isSymbolicLink() || !existing.isFile()))throw Error('Unsafe runtime exclusion file');
const temporary=path.join(root,'.ignore-'+crypto.randomUUID()+'.tmp');
try{fs.writeFileSync(temporary,'*\n',{flag:'wx',mode:0o600});fs.renameSync(temporary,filename)}finally{fs.rmSync(temporary,{force:true})}
`;
