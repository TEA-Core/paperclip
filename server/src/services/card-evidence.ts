/**
 * The one parser for a no-workspace close.
 *
 * It is total: every input returns a finding or null, and it never throws.
 * A finding names a label only. It never carries the matched text, so a
 * secret in a scanned row cannot reach a 422 body or an audit row.
 *
 * Prose (a title, a description, a comment, a document) is evidence by a
 * citation shape. An unknown host with an ordinary path is not. Machine
 * columns add the key rule. A word, including "gerrit", is never evidence.
 */

export const CARD_EVIDENCE_PARSER_VERSION = 1;

export type EvidenceSurface = "prose" | "machine";

export interface EvidenceFinding {
  label: string;
  arm:
    | "scheme"
    | "forge-domain"
    | "forge-label"
    | "forge-path"
    | "scp"
    | "change-request"
    | "repository-reference"
    | "git-ref"
    | "sha"
    | "key";
}

const FORGE_DOMAINS = [
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "dev.azure.com",
  "visualstudio.com",
  "sr.ht",
  "codeberg.org",
  "gitea.com",
  "gitee.com",
  "sourceforge.net",
  "launchpad.net",
  "googlesource.com",
  "gerrithub.io",
];

const FORGE_LABEL = /^(git|gitlab|github|gerrit|gitea|gogs|forgejo|bitbucket|stash|scm|hg|svn|phabricator|code|cgit|gitweb)\d*$/;
const FORGE_PATH = /\/(pulls?|pull-requests?|pullrequests?|merge_requests|merge-requests|changes|commits?|tree|blob|compare|branches|tags|releases|_git)(\/|$)|\/c\/.+\/\+\/\d+|\/\+\/\d+|\.git(\/|$|[?#])|\/-\/(commit|tree|blob|merge_requests)/i;
const TAIL = String.raw`\s*(?:(?:no\.?|number|num\.?|id)\s*)?[:#!№]?\s*[#!]?\s*\d+`;
const CHANGE_REQUEST_LONG = new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:pull[\s_-]*requests?|merge[\s_-]*requests?)` + TAIL, "iu");
const CHANGE_REQUEST_ABBR = new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:PR|MR)` + TAIL, "u");
const REPOSITORY_REFERENCE = /(?<![\w/.-])[\w.-]+\/[\w.-]+[#!]\d+\b/;
const GIT_REF = /\brefs\/(?:heads|remotes|tags|pull|changes|merge-requests)\//;
const SCP_ADDRESS = /\b[\w.-]+@[\w.-]+:[\w.~-]+\/[\w.-]+/;
const URL_IN_TEXT = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`]+/gi;
const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SHA_PROSE = /(?<![\w-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w-])/i;
const SHA_CUE = /(?:commit|sha|rev|HEAD|merged|pushed|cherry-pick).{0,24}(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w-])/i;
const SHA_BARE_40 = /(?<![\w-])[0-9a-f]{40}(?![\w-])/i;
const KEY_CONTAINS = ["workspace", "worktree", "repository", "branch", "pullrequest", "mergerequest", "commit", "project"];
const KEY_EXACT: Record<string, true> = {
  pr: true, mr: true, sha: true, ref: true, baseref: true, headref: true, headsha: true, repo: true,
};
const PROSE_COLUMNS = new Set([
  "issues.title",
  "issues.description",
  "issue_comments.body",
  "documents.title",
  "documents.latest_body",
  "document_revisions.body",
]);

export function evidenceSurface(table: string, column: string): EvidenceSurface {
  return PROSE_COLUMNS.has(`${table}.${column}`) ? "prose" : "machine";
}

export function normalizeEvidenceText(raw: string): string {
  let text = raw.normalize("NFKC").replace(/\p{Cf}/gu, "");
  for (let depth = 0; depth < 3; depth += 1) {
    const next = text
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\([/"'\\])/g, "$1")
      .replace(/\\[nrt]/g, " ");
    if (next === text) break;
    text = next;
  }
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  });
}

function finding(label: string, arm: EvidenceFinding["arm"]): EvidenceFinding {
  return { label, arm };
}

function hostLabel(host: string): string {
  const normalized = host.toLowerCase();
  if (normalized === "github.com" || normalized.endsWith(".github.com")) return "a GitHub address";
  if (normalized.includes("gitlab")) return "a GitLab address";
  if (normalized === "bitbucket.org" || normalized.endsWith(".bitbucket.org")) return "a Bitbucket address";
  if (normalized === "dev.azure.com" || normalized.endsWith(".visualstudio.com") || normalized === "visualstudio.com") return "an Azure DevOps address";
  if (normalized === "sr.ht" || normalized.endsWith(".sr.ht")) return "a sourcehut address";
  return "a code host address";
}

function pathLabel(pathname: string, host: string): string | null {
  if (/\/c\/.+\/\+\/\d+|\/\+\/\d+/.test(pathname)) return "a Gerrit change";
  if (/\/pulls?\//i.test(pathname) || /\/pull-requests?\//i.test(pathname) || /\/pullrequests?\//i.test(pathname) || /pullrequest/i.test(pathname)) return "a pull request URL";
  if (/merge_requests|merge-requests/i.test(pathname)) return "a merge request URL";
  if (/\.git(\/|$|[?#])/i.test(pathname)) return "a repository clone URL";
  if (FORGE_PATH.test(pathname)) return "a repository path";
  return null;
}

function forgeDomain(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return FORGE_DOMAINS.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

function urlCitation(candidate: string): EvidenceFinding | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(":", "").toLowerCase();
  if (!["http", "https"].includes(scheme)) {
    return ["git", "ssh", "git+ssh", "svn", "svn+ssh", "hg", "rsync"].includes(scheme)
      ? finding("an SSH repository address", "scheme")
      : null;
  }
  const host = url.hostname.toLowerCase();
  const citedPath = pathLabel(url.pathname, "");
  if (citedPath && citedPath !== "a repository path") return finding(citedPath, "forge-path");
  if (forgeDomain(host)) return finding(hostLabel(host), "forge-domain");
  if (host.split(".").some((label) => FORGE_LABEL.test(label))) return finding(hostLabel(host), "forge-label");
  return citedPath ? finding(citedPath, "forge-path") : null;
}

function shaFinding(text: string, surface: EvidenceSurface): EvidenceFinding | null {
  const withoutUuids = text.replace(UUID_TEXT, " ");
  if (surface === "prose") {
    return SHA_PROSE.test(withoutUuids) ? finding("a commit SHA", "sha") : null;
  }
  if (SHA_BARE_40.test(withoutUuids) || SHA_CUE.test(withoutUuids)) return finding("a commit SHA", "sha");
  return null;
}

export function normalizedEvidenceKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function evidenceKey(key: string): boolean {
  const normalized = normalizedEvidenceKey(key);
  if (normalized.length === 0) return false;
  if (Object.hasOwn(KEY_EXACT, normalized)) return true;
  if (KEY_CONTAINS.some((token) => normalized.includes(token))) return true;
  // The abbreviation is a field-name word, not the start of "report".
  // Preserve compact spellings of the usual reference fields as well.
  if (/repo(?:id|url|path|name|root|dir|ref|slug|branch)$/.test(normalized)) return true;
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).includes("repo");
}

function provablyEmpty(value: unknown): boolean {
  if (value === null || value === false) return true;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    return trimmed === "" || trimmed === "null" || trimmed === "false" || trimmed === "[]" || trimmed === "{}";
  }
  if (Array.isArray(value)) return value.length === 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function benignMachineValue(key: string, value: unknown): boolean {
  const normalized = normalizedEvidenceKey(key);
  // This is the close audit's typed proof container, not a repository
  // binding. detectEvidence still recursively scans every carried field.
  if (normalized === "norepositorylanding" && value !== null && typeof value === "object" && !Array.isArray(value)) {
    return (value as Record<string, unknown>).proof === "never_had_execution_workspace";
  }
  if (normalized === "paperclipworkspace" || normalized === "paperclipworkspaces") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return provablyEmpty(value);
    const record = value as Record<string, unknown>;
    const carried = ["projectId", "projectWorkspaceId", "workspaceId", "executionWorkspaceId", "repoUrl", "repositoryUrl", "branchName", "worktreePath", "baseRef"];
    return carried.every((field) => provablyEmpty(record[field] ?? null));
  }
  return false;
}

function lexicalKeyFinding(text: string): EvidenceFinding | null {
  const pattern = /([A-Za-z][A-Za-z0-9_-]*)["']?\s*[:=]\s*["']?([^\s,}\]"']*)/g;
  for (const match of text.matchAll(pattern)) {
    const key = match[1] ?? "";
    if (!evidenceKey(key) || benignMachineValue(key, match[2] ?? "")) continue;
    const value = match[2] ?? "";
    const atEnd = match.index !== undefined && match.index + match[0].length >= text.trimEnd().length;
    if (!provablyEmpty(value) || (atEnd && value === "")) return finding("a workspace or repository key", "key");
  }
  if (/"([A-Za-z][A-Za-z0-9_-]*)"\s*:\s*"?\s*$/.test(text)) {
    const key = text.match(/"([A-Za-z][A-Za-z0-9_-]*)"\s*:\s*"?\s*$/)?.[1] ?? "";
    if (evidenceKey(key)) return finding("a workspace or repository key", "key");
  }
  return null;
}

function textFinding(text: string, surface: EvidenceSurface): EvidenceFinding | null {
  const normalized = normalizeEvidenceText(text);
  for (const match of normalized.matchAll(URL_IN_TEXT)) {
    const cited = urlCitation(match[0] ?? "");
    if (cited) return cited;
  }
  for (const domain of FORGE_DOMAINS) {
    if (new RegExp(`(^|[^\\w.-])${domain.replace(/\./g, "\\.")}(?![\\w-])`, "i").test(normalized)) {
      return finding(hostLabel(domain), "forge-domain");
    }
  }
  const scp = normalized.match(SCP_ADDRESS);
  if (scp) {
    const host = scp[0]?.split("@")[1]?.split(":")[0] ?? "";
    return finding(host.includes("github") || host.includes("gitlab") ? hostLabel(host) : "an SSH repository address", "scp");
  }
  if (CHANGE_REQUEST_LONG.test(normalized) || CHANGE_REQUEST_ABBR.test(normalized)) {
    return finding(/merge/i.test(normalized) && !/pull/i.test(normalized) ? "a merge request number" : "a pull request number", "change-request");
  }
  if (REPOSITORY_REFERENCE.test(normalized)) return finding("a repository issue or pull request reference", "repository-reference");
  if (GIT_REF.test(normalized)) return finding("a Git ref", "git-ref");
  if (FORGE_PATH.test(normalized)) return finding("a repository path", "forge-path");
  const sha = shaFinding(normalized, surface);
  if (sha) return sha;
  return surface === "machine" ? lexicalKeyFinding(normalized) : null;
}

export function detectEvidence(value: unknown, surface: EvidenceSurface): EvidenceFinding | null {
  if (typeof value === "string") return textFinding(value, surface);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = detectEvidence(item, surface);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (surface === "machine" && evidenceKey(key) && !provablyEmpty(item) && !benignMachineValue(key, item)) {
        return finding("a workspace or repository key", "key");
      }
      const found = detectEvidence(item, surface);
      if (found) return found;
    }
  }
  return null;
}
