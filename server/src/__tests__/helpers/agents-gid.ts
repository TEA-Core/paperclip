import fs from "node:fs";
import { promisify } from "node:util";
import type * as ChildProcess from "node:child_process";

/**
 * Test control of the named `agents` group lookup. `undefined` passes the
 * lookup through to the host, `null` makes the name not resolve, and a number
 * makes `getent group agents` resolve to that gid.
 */
export const agentsGroup: { gid: number | null | undefined } = { gid: undefined };

const isAgentsLookup = (file: unknown, args: unknown) =>
  file === "getent" && Array.isArray(args) && args[0] === "group" && args[1] === "agents";

/**
 * Wrap `node:child_process` so only the agents group lookup is controlled by
 * `agentsGroup`. Use inside a test file:
 * `vi.mock("node:child_process", async (importOriginal) => (await import("./helpers/agents-gid.js")).mockAgentsGroupLookup(await importOriginal()))`.
 */
export function mockAgentsGroupLookup(actual: typeof ChildProcess): typeof ChildProcess {
  const notFound = () => Object.assign(new Error("agents group not found"), { code: 2 });
  const answer = () => `agents:x:${agentsGroup.gid}:\n`;
  const execFile = ((...args: unknown[]) => {
    if (agentsGroup.gid === undefined || !isAgentsLookup(args[0], args[1])) {
      return (actual.execFile as (...values: unknown[]) => unknown)(...args);
    }
    const callback = args.find((value) => typeof value === "function") as
      | ((error: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    queueMicrotask(() => agentsGroup.gid === null ? callback?.(notFound(), "", "") : callback?.(null, answer(), ""));
    return undefined;
  }) as unknown as typeof actual.execFile;
  const promised = promisify(actual.execFile) as (...values: unknown[]) => Promise<{ stdout: string; stderr: string }>;
  Object.defineProperty(execFile, promisify.custom, {
    value: async (...args: unknown[]) => {
      if (agentsGroup.gid === undefined || !isAgentsLookup(args[0], args[1])) return promised(...args);
      if (agentsGroup.gid === null) throw notFound();
      return { stdout: answer(), stderr: "" };
    },
  });
  return { ...actual, execFile };
}

function hostAgentsGid(): number | undefined {
  try {
    const line = fs.readFileSync("/etc/group", "utf8").split("\n").find((entry) => entry.startsWith("agents:"));
    const field = line?.split(":")[2];
    return field && /^\d+$/.test(field) ? Number(field) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A gid this process may assign as the agents group: the host's `agents`
 * group when it has one, otherwise a supplementary group that is neither gid 0
 * nor the primary group. Undefined when the host has none.
 */
export function assignableAgentsGid(): number | undefined {
  const primary = new Set([process.getgid?.(), process.getegid?.()]);
  const groups = process.getgroups?.() ?? [];
  const usable = (gid: number) => gid !== 0 && !primary.has(gid) && (process.getuid?.() === 0 || groups.includes(gid));
  const named = hostAgentsGid();
  if (named !== undefined) return usable(named) ? named : undefined;
  // Root may assign any group; pick an otherwise unused one.
  return groups.find(usable) ?? (process.getuid?.() === 0 ? 65_533 : undefined);
}

/** Run `fn` while the named agents group resolves to `gid` (null: does not resolve). */
export async function withAgentsGid<T>(gid: number | null, fn: () => Promise<T>): Promise<T> {
  const previous = agentsGroup.gid;
  agentsGroup.gid = gid;
  try {
    return await fn();
  } finally {
    agentsGroup.gid = previous;
  }
}

/** Run `fn` with `PAPERCLIP_AGENTS_GID` set, restoring the previous value. */
export async function withAgentsGidOverride<T>(value: number | string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PAPERCLIP_AGENTS_GID;
  process.env.PAPERCLIP_AGENTS_GID = String(value);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PAPERCLIP_AGENTS_GID;
    else process.env.PAPERCLIP_AGENTS_GID = previous;
  }
}
