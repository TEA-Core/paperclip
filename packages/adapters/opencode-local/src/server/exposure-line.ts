import type { OpenCodeSkillIsolationMode } from "./skills.js";

/**
 * The per-run exposure line, format v2. It is a frozen run-log
 * contract: run-log readers parse it to learn which skills a run could load,
 * and a prune monitor compares N between runs. Change it only together with
 * those readers.
 *
 *   [paperclip] skillIsolation=<mode>: run exposes <N> skill(s) via <via> <location> names=<list>[ +<K> more]
 *
 * - The text up to and including <location> is unchanged from SUP-17881.
 * - <N> counts every entry of the exposed skills directory, listed or not.
 * - <list> is the entry names sorted by UTF-16 code unit, each escaped by
 *   escapeOpenCodeExposureName and joined with ",". It is the longest sorted
 *   prefix whose UTF-8 length is at most OPENCODE_EXPOSURE_NAMES_MAX_BYTES, so
 *   no listed name ever follows a name that did not fit.
 * - " +<K> more" is present only when K = N - (listed names) is above 0.
 *
 * The persisted run log can still mask parts of this line. The secret
 * redactors replace a name shaped like a secret value (for example "hf_" or
 * "sk-" followed by a long tail) with a marker, and the instance setting
 * censorUsernameInLogs masks the home directory and the OS user name. Every
 * marker they write contains a raw "*" or "[". A name can never carry those
 * characters raw, because they are escaped here, so a reader can always see
 * that an item was masked.
 */
export const OPENCODE_EXPOSURE_NAMES_MAX_BYTES = 4096;

const EXPOSURE_NAME_ESCAPE_RE = /[%,=:*\[\]\s\p{Cc}]/gu;

/** "%XX" for each UTF-8 byte, upper-case hex: the same output as encodeURIComponent, but "*" is encoded too. */
function percentEncode(character: string): string {
  let encoded = "";
  for (const byte of Buffer.from(character, "utf8")) {
    encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/**
 * Percent-encode "%", ",", "=", ":", "*", "[", "]", whitespace and control
 * characters. The list then never contains a separator, a space or a line
 * break. No name can form the NAME=VALUE or NAME: VALUE shape that the run-log
 * secret redactors rewrite. A raw "*" or "[" in a persisted list can only come
 * from a redaction marker. decodeURIComponent reverses the escape exactly.
 */
export function escapeOpenCodeExposureName(name: string): string {
  return name.replace(EXPOSURE_NAME_ESCAPE_RE, (character) => percentEncode(character));
}

export function formatOpenCodeSkillExposureLine(input: {
  mode: OpenCodeSkillIsolationMode;
  names: readonly string[];
  location: string;
}): string {
  // Default sort compares UTF-16 code units, so the order is locale-independent.
  const sorted = [...input.names].sort();
  const via = input.mode === "desired-only" ? "per-run HOME" : "shared skills home";
  const listed: string[] = [];
  let listBytes = 0;
  for (const name of sorted) {
    const escaped = escapeOpenCodeExposureName(name);
    const cost = Buffer.byteLength(escaped, "utf8") + (listed.length > 0 ? 1 : 0);
    if (listBytes + cost > OPENCODE_EXPOSURE_NAMES_MAX_BYTES) break;
    listed.push(escaped);
    listBytes += cost;
  }
  const notListed = sorted.length - listed.length;
  const suffix = notListed > 0 ? ` +${notListed} more` : "";
  return `[paperclip] skillIsolation=${input.mode}: run exposes ${sorted.length} skill(s) via ${via} ${input.location} names=${listed.join(",")}${suffix}\n`;
}
