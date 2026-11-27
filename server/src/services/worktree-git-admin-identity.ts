import { lstat } from "node:fs/promises";
import path from "node:path";

export const PROVISIONED_GIT_ADMIN_IDENTITY_KEY = "provisionedGitAdminIdentity";

export interface GitAdminIdentity {
  path: string;
  device: string;
  inode: string;
}

/** The caller resolves the admin path with the hardened Git runner and realpath. */
export async function readGitAdminDirectoryIdentity(canonicalPath: string): Promise<GitAdminIdentity> {
  const info = await lstat(canonicalPath, { bigint: true });
  if (!path.isAbsolute(canonicalPath) || !info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("The Git admin directory is not a canonical directory.");
  }
  return { path: canonicalPath, device: info.dev.toString(), inode: info.ino.toString() };
}

export function parseGitAdminIdentity(value: unknown): GitAdminIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const identity = value as Record<string, unknown>;
  if (typeof identity.path !== "string" || !path.isAbsolute(identity.path) ||
      typeof identity.device !== "string" || !/^\d+$/.test(identity.device) ||
      typeof identity.inode !== "string" || !/^\d+$/.test(identity.inode)) return null;
  return value as GitAdminIdentity;
}
