import { badRequest } from "../errors.js";

function invalidRunId() {
  return badRequest("Run ID must be a UUID string.", { code: "invalid_run_id" });
}

/** Validate a supplied run UUID; only absent optional context returns null. */
export function canonicalizeUuid(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw invalidRunId();
  let text = value;
  if (/^urn:uuid:/i.test(text)) text = text.slice(9);
  if (text.startsWith("{") && text.endsWith("}")) text = text.slice(1, -1);
  // PostgreSQL also permits omitted hyphens or hyphens after any four hex
  // digits. Require exactly 128 bits and matched optional braces/prefix.
  if (!/^[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}$/i.test(text)) throw invalidRunId();
  const hex = text.replaceAll("-", "").toLowerCase();
  // `$` can match before a final newline; never silently discard that suffix.
  if (hex.length !== 32) throw invalidRunId();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
