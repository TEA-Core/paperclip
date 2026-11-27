import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";

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
const refusedOverrides = new Set<string>();

async function namedAgentsGid(): Promise<number | null> {
  const { stdout } = await execFileAsync("getent", ["group", AGENTS_GROUP], { timeout: 5000, maxBuffer: 4096 })
    .catch(() => ({ stdout: "" }));
  const field = String(stdout).trim().split(":")[2];
  return field && /^\d+$/.test(field) ? Number(field) : null;
}

/**
 * Resolve the runtime's `agents` group by name. `PAPERCLIP_AGENTS_GID` may name
 * it numerically where the name does not resolve, but it is refused when it is
 * not numeric, is gid 0, is this process's primary group, or differs from the
 * named group. Returns null (owner-only access) when no valid group resolves or
 * this process may not assign it: group access is never granted to another group.
 */
export async function resolveAgentsGid(): Promise<number | null> {
  const named = await namedAgentsGid();
  const configured = process.env.PAPERCLIP_AGENTS_GID?.trim();
  let gid = named;
  if (configured) {
    const override = /^\d+$/.test(configured) ? Number(configured) : null;
    if (
      override === null || override === 0 ||
      override === process.getgid?.() || override === process.getegid?.() ||
      (named !== null && override !== named)
    ) {
      if (!refusedOverrides.has(configured)) {
        refusedOverrides.add(configured);
        logger.warn({ configured, named }, "PAPERCLIP_AGENTS_GID refused: it must name the agents group, not gid 0 or the server's primary group");
      }
      return null;
    }
    gid = override;
  }
  if (gid === null || gid === 0) return null;
  return process.getuid?.() === 0 || process.getegid?.() === gid || process.getgroups?.().includes(gid) ? gid : null;
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

/**
 * Force one directory to the instruction layout by handle, never following a
 * symlink: owner rwx, agents group r-x, nothing for others; owner-only when
 * gid is null. Refuse the write when an unsafe directory cannot be tightened.
 */
async function secureInstructionDirectory(directory: string, gid: number | null) {
  const mode = gid === null ? 0o700 : 0o750;
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ELOOP" || error.code === "ENOTDIR") {
        throw unprocessable("Instructions require regular files and directories without symlinks", { code: "INSTRUCTION_PATH_INVALID" });
      }
      throw error;
    });
  try {
    const stat = await handle.stat();
    if (gid !== null && stat.gid !== gid) await handle.chown(-1, gid);
    // chmod follows chown, which may clear mode bits, and bypasses the umask.
    if ((stat.mode & 0o7777) !== mode || (gid !== null && stat.gid !== gid)) await handle.chmod(mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EACCES") throw error;
    logger.warn({ directory, code }, "Refusing instruction write: directory permissions cannot be tightened");
    throw unprocessable("Instruction storage permissions are unsafe and cannot be tightened", { code: "INSTRUCTION_STORAGE_UNSAFE" });
  } finally {
    await handle.close();
  }
}

/**
 * Create `directory` and force every managed directory to the instruction
 * layout: from `root` (default: `directory` itself) down to `directory`, plus
 * any ancestors this call created. Existing loose directories are tightened.
 */
export async function createInstructionDirectory(
  directory: string,
  options: InstructionAccessOptions & { root?: string } = {},
) {
  const gid = options.privateTree ? null : options.gid === undefined ? await resolveAgentsGid() : options.gid;
  const target = path.resolve(directory);
  const root = path.resolve(options.root ?? directory);
  if (!within(root, target)) throw new Error("Instruction directory is outside its root");
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
