export const GIT_BRANCH_OWNERSHIP_METADATA_VERSION = 1;
export const GIT_BRANCH_OWNERSHIP_METADATA_KEY = "gitBranchOwnershipVersion";

function hasCurrentGitBranchOwnershipMetadata(
  metadata: Record<string, unknown> | null | undefined,
) {
  return metadata?.[GIT_BRANCH_OWNERSHIP_METADATA_KEY] === GIT_BRANCH_OWNERSHIP_METADATA_VERSION;
}

const MAX_PERCENT_DECODE_PASSES = 3;

function hasValidGitRefShape(name: string): boolean {
  if (name.length === 0 || name === "@") return false;
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(name)) return false;
  if (name.includes("..") || name.includes("@{")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) return false;
  if (name.endsWith(".")) return false;
  for (const component of name.split("/")) {
    if (component.length === 0 || component.startsWith(".") || component.endsWith(".lock")) return false;
  }
  return true;
}

/**
 * `git check-ref-format` branch semantics: a name git itself would accept as
 * a branch. Rejects empty names, control characters (including NUL), space
 * and `~^:?*[\`, `..`, `@{`, a lone `@`, leading/trailing or doubled slashes,
 * trailing dots, and any component starting with a dot or ending in `.lock`.
 * Valid Unicode names are accepted. A percent-encoded form that decodes to an
 * invalid name (for example `%2F` for a slash, building `../` after decoding)
 * is equally invalid: well-formed ASCII `%HH` escapes are decoded for at most
 * `MAX_PERCENT_DECODE_PASSES` passes, each pass is checked, a lone `%` stays
 * literal, and a name still changing after the last pass is refused.
 */
export function isValidGitBranchName(name: string): boolean {
  let candidate = name;
  for (let pass = 0; ; pass += 1) {
    if (!hasValidGitRefShape(candidate)) return false;
    const decoded = candidate.replace(/%([0-7][0-9a-fA-F])/g, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
    if (decoded === candidate) return true;
    if (pass === MAX_PERCENT_DECODE_PASSES) return false;
    candidate = decoded;
  }
}

export function isRuntimeOwnedGitBranch(
  metadata: Record<string, unknown> | null | undefined,
) {
  return hasCurrentGitBranchOwnershipMetadata(metadata) && metadata?.createdByRuntime === true;
}
