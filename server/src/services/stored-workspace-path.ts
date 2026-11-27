import { lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";

interface StoredPathResolution {
  path: string;
  missing: boolean;
  uncertain: boolean;
  dangling: boolean;
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
      return { path: resolved, missing: false, uncertain: false, dangling: false, scopeTouched: inScope(resolved) };
    } catch {
      // Missing suffixes may hide a symlink target.
    }
  }
  const pending = candidate.split(path.sep).reverse();
  let resolved = path.parse(candidate).root;
  let missing = false;
  let uncertain = false;
  let dangling = false;
  const targetFloors: number[] = [];
  let scopeTouched = inScope(resolved);
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.pop()!;
    while (targetFloors.length > 0 && pending.length < targetFloors[targetFloors.length - 1]!) targetFloors.pop();
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
        if (++hops > 40) {
          resolved = next;
          uncertain = true;
          break;
        }
        const target = await readlink(next);
        if (path.isAbsolute(target)) resolved = path.parse(target).root;
        targetFloors.push(pending.length);
        pending.push(...target.split(path.sep).reverse());
        continue;
      }
    } catch (error) {
      if (absent(error)) {
        missing = true;
        if (targetFloors.length > 0) dangling = true;
      }
      else uncertain = true;
    }
    resolved = next;
  }
  return { path: resolved, missing, uncertain, dangling, scopeTouched };
}
