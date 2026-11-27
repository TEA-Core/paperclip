import { execFileSync } from "node:child_process";

/**
 * A gid this process may assign as the runtime agents group: the named
 * `agents` group when the host has one, otherwise a supplementary group that
 * is neither gid 0 nor the primary group. Undefined when the host has none.
 */
export function assignableAgentsGid(): number | undefined {
  const primary = new Set([process.getgid?.(), process.getegid?.()]);
  const groups = process.getgroups?.() ?? [];
  const usable = (gid: number) => gid !== 0 && !primary.has(gid) && (process.getuid?.() === 0 || groups.includes(gid));
  let named: number | undefined;
  try {
    const field = execFileSync("getent", ["group", "agents"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(":")[2];
    if (field && /^\d+$/.test(field)) named = Number(field);
  } catch {
    named = undefined;
  }
  if (named !== undefined) return usable(named) ? named : undefined;
  // Root may assign any group; pick an otherwise unused one.
  return groups.find(usable) ?? (process.getuid?.() === 0 ? 65_533 : undefined);
}

/** Run `fn` with `PAPERCLIP_AGENTS_GID` set, restoring the previous value. */
export async function withAgentsGid<T>(gid: number | string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PAPERCLIP_AGENTS_GID;
  process.env.PAPERCLIP_AGENTS_GID = String(gid);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PAPERCLIP_AGENTS_GID;
    else process.env.PAPERCLIP_AGENTS_GID = previous;
  }
}
