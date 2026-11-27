import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { unprocessable } from "../errors.js";

// Group readability is opt-in via the canonical group-read bit, never inferred
// from owner access alone. Strip write access for every non-owner.
export const stagedMode = (mode: number) => (mode & ~0o7777) | (mode & 0o700) |
  (mode & 0o400 && mode & 0o040 ? 0o040 | (mode & 0o100 ? 0o010 : 0) : 0);

const LINK_REFUSAL = "Agent directories support regular files and directories, without links or special files";

export async function workingCopyPermissions(filename: string, gid: number | null, recursive = true, parentFd?: number): Promise<void> {
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
