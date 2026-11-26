import { realpath } from "node:fs/promises";
import path from "node:path";

/** Stored workspace, runtime-service, operation and run paths name the physical
 * directory, so a symlinked alias is recorded (and fenced) as its target. */
export async function canonicalStoredPath<T extends string | null | undefined>(value: T): Promise<T> {
  if (typeof value !== "string" || !path.isAbsolute(value)) return value;
  return (await realpath(value).catch(() => value)) as T;
}
