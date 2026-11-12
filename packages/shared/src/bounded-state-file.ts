/**
 * Bounded, regular-file-only, no-follow access to small worktree state files
 * (manifests and similar records under a private `.paperclip` directory).
 *
 * `existsSync` followed by `readFileSync` blocks forever on a FIFO with no
 * writer and follows symlinks and hard-link aliases. This reader instead:
 *
 * 1. takes a trusted state root (normally the directory that holds
 *    `.paperclip`, see {@link resolveWorktreeStateRoot}). Only the root may be
 *    reached through links. Every directory between the root and the file is
 *    opened one component at a time and must be a real directory, never a
 *    symbolic link, so a `.paperclip` or `uid-<uid>` link cannot redirect the
 *    read or the write to the state of another instance. Where the platform
 *    exposes descriptor paths (`/proc/self/fd` on Linux), the walk and every
 *    later step resolve through the opened directory descriptors, so a
 *    directory swapped for a link after its check is not followed either;
 * 2. `lstat`s the entry and rejects anything that is not a regular file
 *    (symlinks, directories, sockets, devices, FIFOs) without opening it;
 * 3. opens with `O_NOFOLLOW | O_NONBLOCK | O_NOCTTY`, so a path swapped to a
 *    symlink fails and a path swapped to a FIFO opens without waiting;
 * 4. `fstat`s the opened descriptor (regular file, same inode as the `lstat`,
 *    trusted owner, exactly one link, size within the limit) before reading;
 * 5. reads at most `maxBytes + 1` bytes and rejects growth, oversize and
 *    truncation; every descriptor is closed on every path.
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
  | "parent_symlink"
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
  /**
   * Absolute directory the caller trusts. It may be reached through links;
   * every directory between it and the file must be a real directory.
   */
  trustedRoot: string;
  maxBytes?: number;
  /**
   * Test seams for check/use races. `afterDirectoryCheck` runs after the
   * directory walk and before the entry `lstat`; `afterPathCheck` runs after
   * the `lstat` checks and before the open; `afterDescriptorCheck` runs after
   * the `fstat` checks and before the read.
   */
  hooks?: {
    afterDirectoryCheck?: () => void;
    afterPathCheck?: () => void;
    afterDescriptorCheck?: () => void;
  };
};

export type StateFileWriteOptions = {
  /** Absolute directory the caller trusts; see {@link BoundedStateFileReadOptions.trustedRoot}. */
  trustedRoot: string;
};

const UID_SCOPED_STATE_DIRECTORY = /^uid-\d+$/;

/**
 * The trusted root for a worktree state file: the directory that holds
 * `.paperclip`, for `<root>/.paperclip/<file>` and for the uid-scoped
 * `<root>/.paperclip/uid-<uid>/<file>` (SUP-14087). The state directories
 * below the root are then checked, so a `.paperclip` or `uid-<uid>` link to
 * another instance is refused. Any other layout trusts only the file's own
 * directory.
 */
export function resolveWorktreeStateRoot(filePath: string): string {
  const stateDirectory = path.dirname(path.resolve(filePath));
  if (path.basename(stateDirectory) === ".paperclip") return path.dirname(stateDirectory);
  const parent = path.dirname(stateDirectory);
  if (UID_SCOPED_STATE_DIRECTORY.test(path.basename(stateDirectory)) && path.basename(parent) === ".paperclip") {
    return path.dirname(parent);
  }
  return stateDirectory;
}

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

type OpenFlags = { noFollow: number; nonBlock: number; noCtty: number; directory: number };

function requireNoFollowFlags(filePath: string): OpenFlags {
  const { O_NOFOLLOW, O_NONBLOCK, O_NOCTTY, O_DIRECTORY } = fs.constants;
  // Without O_NOFOLLOW/O_NONBLOCK/O_DIRECTORY an open could follow a swapped
  // symlink, block on a FIFO, or accept a non-directory as a parent, so fail
  // closed rather than degrade.
  if (typeof O_NOFOLLOW !== "number" || typeof O_NONBLOCK !== "number" || typeof O_DIRECTORY !== "number") {
    throw new BoundedStateFileError(
      "unsupported_platform",
      filePath,
      "this platform cannot open files without following links and without blocking.",
    );
  }
  return {
    noFollow: O_NOFOLLOW,
    nonBlock: O_NONBLOCK,
    noCtty: typeof O_NOCTTY === "number" ? O_NOCTTY : 0,
    directory: O_DIRECTORY,
  };
}

function trustedOwners(directoryStat: fs.BigIntStats): Set<number> | null {
  const euid = typeof process.geteuid === "function" ? process.geteuid() : null;
  if (euid === null) return null;
  // The directory owner controls the directory's entries, so a file it owns is
  // as trustworthy as the directory itself; anyone else's file is refused.
  return new Set([euid, Number(directoryStat.uid)]);
}

type TrustedDirectory = {
  fd: number;
  stat: fs.BigIntStats;
  /** A path that names `name` inside this directory. */
  entry: (name: string) => string;
};

/**
 * The Linux descriptor path of an open directory, when it resolves to that same
 * directory. A path through it stays inside the directory the descriptor holds
 * even after the directory is renamed or replaced by a link, which gives
 * `openat`-style traversal without native bindings.
 */
function descriptorDirectoryPath(fd: number, stat: fs.BigIntStats): string | null {
  if (process.platform !== "linux") return null;
  const candidate = `/proc/self/fd/${fd}`;
  try {
    return isSameFileIdentity(fs.statSync(candidate, { bigint: true }), stat) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Open the directory that holds `filePath`, walking down from `trustedRoot` one
 * component at a time. Returns `null` when the root or a directory below it
 * does not exist. The caller owns and must close the returned descriptor.
 */
function openTrustedDirectory(filePath: string, trustedRoot: string, flags: OpenFlags): TrustedDirectory | null {
  if (typeof trustedRoot !== "string" || !path.isAbsolute(trustedRoot)) {
    throw new BoundedStateFileError("not_absolute", filePath, "its trusted state root must be an absolute path.");
  }
  const root = path.resolve(trustedRoot);
  const relativeDirectory = path.relative(root, path.dirname(path.resolve(filePath)));
  if (
    relativeDirectory === ".."
    || relativeDirectory.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeDirectory)
  ) {
    throw new BoundedStateFileError("parent_invalid", filePath, "it is outside its trusted state root.");
  }
  const components = relativeDirectory === "" ? [] : relativeDirectory.split(path.sep);
  const directoryFlags = fs.constants.O_RDONLY | flags.directory | flags.nonBlock;

  let fd: number;
  let directoryPath: string;
  try {
    // The root is trusted, so links in it are followed; nothing below it is.
    directoryPath = fs.realpathSync(root);
    fd = fs.openSync(directoryPath, directoryFlags);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return null;
    if (code === "ENOTDIR") {
      throw new BoundedStateFileError("parent_invalid", filePath, "its trusted state root is not a directory.");
    }
    throw new BoundedStateFileError("io_error", filePath, "its trusted state root could not be opened.");
  }

  let owned: number | null = fd;
  try {
    let stat = fs.fstatSync(fd, { bigint: true });
    const anchored = descriptorDirectoryPath(fd, stat) !== null;
    const entryPath = (directoryFd: number, directory: string, name: string) =>
      anchored ? `/proc/self/fd/${directoryFd}/${name}` : path.join(directory, name);

    for (const component of components) {
      const componentPath = entryPath(fd, directoryPath, component);
      let componentStat: fs.BigIntStats;
      try {
        componentStat = fs.lstatSync(componentPath, { bigint: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw new BoundedStateFileError("io_error", filePath, "a directory below its trusted state root could not be inspected.");
      }
      if (componentStat.isSymbolicLink()) {
        throw new BoundedStateFileError("parent_symlink", filePath, "a directory below its trusted state root is a symbolic link.");
      }
      if (!componentStat.isDirectory()) {
        throw new BoundedStateFileError("parent_invalid", filePath, "a path below its trusted state root is not a directory.");
      }

      let next: number;
      try {
        next = fs.openSync(componentPath, directoryFlags | flags.noFollow);
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT") return null;
        if (code === "ELOOP" || code === "ENOTDIR") {
          throw new BoundedStateFileError(
            "changed",
            filePath,
            "a directory below its trusted state root was replaced while being opened.",
          );
        }
        throw new BoundedStateFileError("io_error", filePath, "a directory below its trusted state root could not be opened.");
      }
      fs.closeSync(fd);
      fd = next;
      owned = next;
      stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isDirectory() || !isSameFileIdentity(stat, componentStat)) {
        throw new BoundedStateFileError(
          "changed",
          filePath,
          "a directory below its trusted state root was replaced while being opened.",
        );
      }
      directoryPath = path.join(directoryPath, component);
    }

    const directoryFd = fd;
    const directory = directoryPath;
    owned = null;
    return { fd: directoryFd, stat, entry: (name) => entryPath(directoryFd, directory, name) };
  } catch (error) {
    if (error instanceof BoundedStateFileError) throw error;
    throw new BoundedStateFileError("io_error", filePath, "its directory could not be inspected.");
  } finally {
    if (owned !== null) fs.closeSync(owned);
  }
}

/**
 * Read a small state file without following links or blocking.
 *
 * Returns `null` when the path does not exist. Throws
 * {@link BoundedStateFileError} for every other refusal; the message names the
 * path and the reason but never the file's contents.
 */
export function readBoundedStateFile(filePath: string, options: BoundedStateFileReadOptions): Buffer | null {
  const maxBytes = options.maxBytes ?? STATE_FILE_MAX_BYTES;
  if (!path.isAbsolute(filePath)) {
    throw new BoundedStateFileError("not_absolute", filePath, "state file paths must be absolute.");
  }
  const flags = requireNoFollowFlags(filePath);
  const directory = openTrustedDirectory(filePath, options.trustedRoot, flags);
  if (directory === null) return null;

  try {
    options.hooks?.afterDirectoryCheck?.();
    const entryPath = directory.entry(path.basename(filePath));

    // BigInt stats keep `dev`/`ino` exact; Number stats lose precision above
    // 2^53, which could make two distinct files compare as the same inode.
    let pathStat: fs.BigIntStats;
    try {
      pathStat = fs.lstatSync(entryPath, { bigint: true });
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
      fd = fs.openSync(entryPath, fs.constants.O_RDONLY | flags.noFollow | flags.nonBlock | flags.noCtty);
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
      const owners = trustedOwners(directory.stat);
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
  } finally {
    fs.closeSync(directory.fd);
  }
}

/**
 * Atomically replace a state file inside an existing private directory:
 * exclusive temporary file (mode 0600), fsync, rename over the target, then
 * fsync the directory so the rename itself is durable. The directory is reached
 * through the same trusted-root walk as {@link readBoundedStateFile}, so a
 * linked state directory is refused before anything is written. The temporary
 * file is removed on any failure, so a reader sees either the old or the new
 * contents.
 */
export function writeStateFileAtomic(
  filePath: string,
  contents: string | Uint8Array,
  options: StateFileWriteOptions,
): void {
  if (!path.isAbsolute(filePath)) {
    throw new BoundedStateFileError("not_absolute", filePath, "state file paths must be absolute.");
  }
  const flags = requireNoFollowFlags(filePath);
  const directory = openTrustedDirectory(filePath, options.trustedRoot, flags);
  if (directory === null) {
    throw new BoundedStateFileError("parent_invalid", filePath, "its directory does not exist.");
  }
  const name = path.basename(filePath);
  const temporaryPath = directory.entry(
    `.${name}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`,
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
    fs.renameSync(temporaryPath, directory.entry(name));
    renamed = true;
    fs.fsyncSync(directory.fd);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    if (!renamed) fs.rmSync(temporaryPath, { force: true });
    fs.closeSync(directory.fd);
  }
}
