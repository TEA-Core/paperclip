/**
 * Bounded, regular-file-only, no-follow access to small worktree state files
 * (manifests and similar records under a private `.paperclip` directory).
 *
 * `existsSync` followed by `readFileSync` blocks forever on a FIFO with no
 * writer and follows symlinks and hard-link aliases. This reader instead:
 *
 * 1. resolves the parent directory to its canonical path once and uses that
 *    path for every later step;
 * 2. `lstat`s the entry and rejects anything that is not a regular file
 *    (symlinks, directories, sockets, devices, FIFOs) without opening it;
 * 3. opens with `O_NOFOLLOW | O_NONBLOCK | O_NOCTTY`, so a path swapped to a
 *    symlink fails and a path swapped to a FIFO opens without waiting;
 * 4. `fstat`s the opened descriptor (regular file, same inode as the `lstat`,
 *    trusted owner, exactly one link, size within the limit) before reading;
 * 5. reads at most `maxBytes + 1` bytes and rejects growth, oversize and
 *    truncation; the descriptor is closed on every path.
 *
 * This module is self-contained (no relative imports) so the runtime
 * provisioner can load it through Node's type stripping without a build step.
 */
import fs from "node:fs";
import path from "node:path";

export const STATE_FILE_MAX_BYTES = 64 * 1024;

export type BoundedStateFileErrorCode =
  | "not_absolute"
  | "unsupported_platform"
  | "parent_invalid"
  | "not_regular"
  | "changed"
  | "owner_mismatch"
  | "hard_linked"
  | "oversize"
  | "grown"
  | "truncated"
  | "io_error";

export class BoundedStateFileError extends Error {
  code: BoundedStateFileErrorCode;

  constructor(code: BoundedStateFileErrorCode, filePath: string, detail: string) {
    super(`Refusing worktree state file ${filePath}: ${detail}`);
    this.name = "BoundedStateFileError";
    this.code = code;
  }
}

export type BoundedStateFileReadOptions = {
  maxBytes?: number;
  /**
   * Test seams for check/use races. `afterPathCheck` runs after the `lstat`
   * checks and before the open; `afterDescriptorCheck` runs after the `fstat`
   * checks and before the read.
   */
  hooks?: {
    afterPathCheck?: () => void;
    afterDescriptorCheck?: () => void;
  };
};

function describeNonRegular(stat: fs.Stats | fs.BigIntStats): string {
  if (stat.isSymbolicLink()) return "it is a symbolic link";
  if (stat.isDirectory()) return "it is a directory";
  if (stat.isFIFO()) return "it is a FIFO";
  if (stat.isSocket()) return "it is a socket";
  if (stat.isCharacterDevice() || stat.isBlockDevice()) return "it is a device";
  return "it is not a regular file";
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

/**
 * Whether two BigInt stats name the same file. Device and inode numbers are
 * compared as exact bigints; converting them to Number could make distinct
 * files above 2^53 compare equal and accept a swapped file.
 */
export function isSameFileIdentity(
  a: Pick<fs.BigIntStats, "dev" | "ino">,
  b: Pick<fs.BigIntStats, "dev" | "ino">,
): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function requireNoFollowFlags(filePath: string): { noFollow: number; nonBlock: number; noCtty: number } {
  const { O_NOFOLLOW, O_NONBLOCK, O_NOCTTY } = fs.constants;
  // Without O_NOFOLLOW/O_NONBLOCK the open itself could follow a swapped
  // symlink or block on a FIFO, so fail closed rather than degrade.
  if (typeof O_NOFOLLOW !== "number" || typeof O_NONBLOCK !== "number") {
    throw new BoundedStateFileError(
      "unsupported_platform",
      filePath,
      "this platform cannot open files without following links and without blocking.",
    );
  }
  return { noFollow: O_NOFOLLOW, nonBlock: O_NONBLOCK, noCtty: typeof O_NOCTTY === "number" ? O_NOCTTY : 0 };
}

function trustedOwners(parentStat: fs.Stats): Set<number> | null {
  const euid = typeof process.geteuid === "function" ? process.geteuid() : null;
  if (euid === null) return null;
  // The directory owner controls the directory's entries, so a file it owns is
  // as trustworthy as the directory itself; anyone else's file is refused.
  return new Set([euid, parentStat.uid]);
}

/**
 * Read a small state file without following links or blocking.
 *
 * Returns `null` when the path does not exist. Throws
 * {@link BoundedStateFileError} for every other refusal; the message names the
 * path and the reason but never the file's contents.
 */
export function readBoundedStateFile(filePath: string, options: BoundedStateFileReadOptions = {}): Buffer | null {
  const maxBytes = options.maxBytes ?? STATE_FILE_MAX_BYTES;
  if (!path.isAbsolute(filePath)) {
    throw new BoundedStateFileError("not_absolute", filePath, "state file paths must be absolute.");
  }
  const flags = requireNoFollowFlags(filePath);

  // Resolve the directory once to its canonical path and use that path for
  // every later step, so the checks and the open name the same entry. Only the
  // final component is refused when it is a link.
  let canonicalPath: string;
  let parentStat: fs.Stats;
  try {
    const canonicalParent = fs.realpathSync(path.dirname(filePath));
    parentStat = fs.lstatSync(canonicalParent);
    canonicalPath = path.join(canonicalParent, path.basename(filePath));
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null;
    throw new BoundedStateFileError("io_error", filePath, "its directory could not be inspected.");
  }
  if (!parentStat.isDirectory()) {
    throw new BoundedStateFileError("parent_invalid", filePath, "its parent is not a directory.");
  }

  // BigInt stats keep `dev`/`ino` exact; Number stats lose precision above
  // 2^53, which could make two distinct files compare as the same inode.
  let pathStat: fs.BigIntStats;
  try {
    pathStat = fs.lstatSync(canonicalPath, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new BoundedStateFileError("io_error", filePath, "its metadata could not be read.");
  }
  if (!pathStat.isFile()) {
    throw new BoundedStateFileError("not_regular", filePath, `${describeNonRegular(pathStat)}.`);
  }

  options.hooks?.afterPathCheck?.();

  let fd: number;
  try {
    fd = fs.openSync(canonicalPath, fs.constants.O_RDONLY | flags.noFollow | flags.nonBlock | flags.noCtty);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "ENXIO" || code === "EISDIR" || code === "EMLINK") {
      throw new BoundedStateFileError("changed", filePath, "it was replaced by a non-regular file while being opened.");
    }
    throw new BoundedStateFileError("io_error", filePath, "it could not be opened.");
  }

  try {
    const fdStat = fs.fstatSync(fd, { bigint: true });
    if (!fdStat.isFile()) {
      throw new BoundedStateFileError("changed", filePath, `the opened file is not regular (${describeNonRegular(fdStat)}).`);
    }
    if (!isSameFileIdentity(fdStat, pathStat)) {
      throw new BoundedStateFileError("changed", filePath, "it was replaced while being opened.");
    }
    const owners = trustedOwners(parentStat);
    if (owners !== null && !owners.has(Number(fdStat.uid))) {
      throw new BoundedStateFileError("owner_mismatch", filePath, "it is owned by an untrusted user.");
    }
    if (fdStat.nlink !== 1n) {
      throw new BoundedStateFileError("hard_linked", filePath, "it has more than one hard link.");
    }
    if (fdStat.size > BigInt(maxBytes)) {
      throw new BoundedStateFileError("oversize", filePath, `it is larger than ${maxBytes} bytes.`);
    }
    // Bounded by maxBytes above, so the conversion is exact.
    const expectedSize = Number(fdStat.size);

    options.hooks?.afterDescriptorCheck?.();

    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = fs.readSync(fd, buffer, total, buffer.length - total, total);
      if (read === 0) break;
      total += read;
    }
    if (total > maxBytes) {
      throw new BoundedStateFileError("oversize", filePath, `it grew beyond ${maxBytes} bytes while being read.`);
    }
    if (total > expectedSize) {
      throw new BoundedStateFileError("grown", filePath, "it grew while being read.");
    }
    if (total < expectedSize) {
      throw new BoundedStateFileError("truncated", filePath, "it was truncated while being read.");
    }
    return buffer.subarray(0, total);
  } catch (error) {
    if (error instanceof BoundedStateFileError) throw error;
    throw new BoundedStateFileError("io_error", filePath, "it could not be read.");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Atomically replace a state file inside an existing private directory:
 * exclusive temporary file (mode 0600), fsync, rename over the target, then
 * fsync the directory so the rename itself is durable. The temporary file is
 * removed on any failure, so a reader sees either the old or the new contents.
 */
export function writeStateFileAtomic(filePath: string, contents: string | Uint8Array): void {
  if (!path.isAbsolute(filePath)) {
    throw new BoundedStateFileError("not_absolute", filePath, "state file paths must be absolute.");
  }
  const flags = requireNoFollowFlags(filePath);
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  const data = typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;

  let fd: number | null = null;
  let renamed = false;
  try {
    fd = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | flags.noFollow,
      0o600,
    );
    fs.fchmodSync(fd, 0o600);
    let written = 0;
    while (written < data.length) {
      written += fs.writeSync(fd, data, written, data.length - written);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporaryPath, filePath);
    renamed = true;
    const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    if (!renamed) fs.rmSync(temporaryPath, { force: true });
  }
}
