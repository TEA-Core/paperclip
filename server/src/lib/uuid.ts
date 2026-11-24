/** Parse UUID text without turning malformed identifiers into another run. */
export function canonicalizeUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value;
  if (/^urn:uuid:/i.test(text)) text = text.slice(9);
  if (text.startsWith("{") && text.endsWith("}")) text = text.slice(1, -1);
  // PostgreSQL also permits omitted hyphens or hyphens after any four hex
  // digits. Require exactly 128 bits and matched optional braces/prefix.
  if (!/^[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}$/i.test(text)) return null;
  const hex = text.replaceAll("-", "").toLowerCase();
  // `$` can match before a final newline; never silently discard that suffix.
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
