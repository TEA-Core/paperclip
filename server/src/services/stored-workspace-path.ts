import { lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { conflict } from "../errors.js";

interface StoredPathResolution {
  path: string;
  missing: boolean;
  uncertain: boolean;
  followedSymlink: boolean;
  scopeTouched: boolean;
}

const absent = (error: unknown) => error !== null && typeof error === "object" &&
  "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

/** Resolve existing components before consuming `..`, including symlink
 * targets followed by a not-yet-created suffix. Never collapse raw input first.
 */
export async function resolveStoredPath(candidate: string, scopeRoot?: string): Promise<StoredPathResolution> {
  const inScope = (value: string) => scopeRoot !== undefined &&
    (value === scopeRoot || value.startsWith(`${scopeRoot}${path.sep}`));
  if (!/(?:^|\/)\.\.(?:\/|$)/.test(candidate)) {
    try {
      const resolved = await realpath(candidate);
      return { path: resolved, missing: false, uncertain: false, followedSymlink: false, scopeTouched: inScope(resolved) };
    } catch {
      // Missing suffixes may hide a symlink target.
    }
  }
  const pending = candidate.split(path.sep).reverse();
  let resolved = path.parse(candidate).root;
  let missing = false;
  let uncertain = false;
  let followedSymlink = false;
  let scopeTouched = inScope(resolved);
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.pop()!;
    if (!part || part === ".") continue;
    if (part === "..") {
      resolved = path.dirname(resolved);
      scopeTouched ||= inScope(resolved);
      continue;
    }
    const next = path.join(resolved, part);
    scopeTouched ||= inScope(next);
    try {
      const info = await lstat(next);
      if (info.isSymbolicLink()) {
        followedSymlink = true;
        if (++hops > 40) {
          resolved = next;
          uncertain = true;
          break;
        }
        const target = await readlink(next);
        if (path.isAbsolute(target)) resolved = path.parse(target).root;
        pending.push(...target.split(path.sep).reverse());
        continue;
      }
    } catch (error) {
      if (absent(error)) missing = true;
      else uncertain = true;
    }
    resolved = next;
  }
  return { path: resolved, missing, uncertain, followedSymlink, scopeTouched };
}

/** Store the physical spelling, including future descendants of a symlink. */
export async function canonicalStoredPath<T extends string | null | undefined>(value: T): Promise<T> {
  if (typeof value !== "string" || !path.isAbsolute(value)) return value;
  const resolved = await resolveStoredPath(value);
  if (resolved.uncertain) {
    throw conflict("A local workspace path cannot be normalized safely.", { code: "review_entry_path_unverified" });
  }
  return resolved.path as T;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

const workspacePathKeys = ["cwd", "worktreePath"] as const;
const contextPathKeys = ["cwd", "workspaceCwd"] as const;

async function canonicalPathFields(source: Record<string, unknown>, keys: readonly string[]) {
  let result = source;
  for (const key of keys) {
    const value = source[key];
    if (typeof value !== "string") continue;
    const normalized = await canonicalStoredPath(value);
    if (normalized !== value) {
      if (result === source) result = { ...source };
      result[key] = normalized;
    }
  }
  return result;
}

/** Normalize every local run-context producer before persistence. Atomic
 * metadata-only JSONB patches preserve these fields; remote paths stay remote.
 */
export async function canonicalRunContextSnapshot<T>(value: T): Promise<T> {
  const source = record(value);
  if (!source) return value;
  const driver = record(source.paperclipEnvironment)?.driver;
  if (driver != null && driver !== "local") return value;
  let result = await canonicalPathFields(source, contextPathKeys);
  const workspace = record(source.paperclipWorkspace);
  if (workspace) {
    const normalized = await canonicalPathFields(workspace, workspacePathKeys);
    if (normalized !== workspace) {
      if (result === source) result = { ...source };
      result.paperclipWorkspace = normalized;
    }
  }
  if (Array.isArray(source.paperclipWorkspaces)) {
    const original = source.paperclipWorkspaces;
    let hints = original;
    for (let index = 0; index < original.length; index += 1) {
      const hint = record(original[index]);
      if (!hint) continue;
      const normalized = await canonicalPathFields(hint, workspacePathKeys);
      if (normalized !== hint) {
        if (hints === original) hints = [...original];
        hints[index] = normalized;
      }
    }
    if (hints !== original) {
      if (result === source) result = { ...source };
      result.paperclipWorkspaces = hints;
    }
  }
  return result as T;
}
