import type { Db } from "@paperclipai/db";
import { GITHUB_APP_PRIVATE_KEY_SECRET_NAME, resolveAppInstallationToken } from "./github-credential.js";
import { ghFetch, isGitHubDotCom } from "./github-fetch.js";
import { secretService } from "./secrets.js";

/**
 * Server-side git credentials for managed project checkouts and execution-workspace base
 * refreshes. Resolution prefers the GitHub App installation token scoped to the remote's
 * owner/repo, then company secrets under the well-known names below (the same convention the
 * GitHub external-object provider reads), falling through any candidate GitHub rejects
 * (401/403), then the server env; the winner is turned into a git invocation that
 * authenticates clone/fetch against github.com over HTTPS without ever placing the token in
 * argv, URLs, or on disk.
 *
 * The provider factory is deliberately the single seam for future credential sources (for
 * example a brokered GitHub connection): swap the factory, keep every call site unchanged.
 */

/** Company-secret names probed for a GitHub token, in priority order. */
export const DEFAULT_GITHUB_TOKEN_SECRET_NAMES = ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"] as const;

/** Env var the credential helper reads the token from; never appears in argv. */
export const GIT_CREDENTIAL_TOKEN_ENV_KEY = "PAPERCLIP_GIT_TOKEN";

// `!`-prefixed helpers run via `sh -c` with the credential action appended as "$1". Only the
// `get` action answers; store/erase drain stdin and exit 0 silently. `x-access-token`
// authenticates classic PATs, fine-grained PATs, and GitHub App installation tokens alike.
//
// The helper re-validates the credential request from its stdin description and answers only
// for `protocol=https` + `host=github.com`/`www.github.com`. The pre-invocation URL check
// runs before git applies configuration like repository-local `url.<base>.insteadOf`
// rewrites, so a rewritten remote could otherwise request the token for an arbitrary host.
// The helper is additionally installed URL-scoped (`credential.https://github.com.helper`)
// so git does not consult it for other hosts in the first place — two independent gates.
const GIT_CREDENTIAL_HELPER =
  `!f() { ok=; proto=; while IFS= read -r l && [ -n "$l" ]; do case "$l" in host=github.com|host=www.github.com) ok=1;; protocol=https) proto=1;; esac; done; if [ "$1" = get ] && [ -n "$ok" ] && [ -n "$proto" ]; then printf 'username=x-access-token\\npassword=%s\\n' "$PAPERCLIP_GIT_TOKEN"; fi; }; f`;

export type GitCredential = {
  token: string;
  source: "app_installation" | "company_secret" | "server_env";
  /** The secret name the token came from; null for a server-environment token. */
  secretName: string | null;
};

/** A prepared, credential-bearing git invocation: config args plus the env that carries the token. */
export type GitAuthInvocation = {
  configArgs: string[];
  env: Record<string, string>;
  source: GitCredential["source"];
  secretName: string | null;
};

/**
 * Resolve auth for one remote URL. Returns null when the URL is out of scope (non-GitHub,
 * ssh, or already credentialed) or when no token is available — callers then run git with
 * ambient behavior, exactly as before this module existed.
 */
export type GitRemoteAuthProvider = (remoteUrl: string) => Promise<GitAuthInvocation | null>;

/**
 * True only for `https://github.com/...` (or `www.`) URLs without inline userinfo. GHES and
 * other hosts are out of scope for now — sending a github.com token to an arbitrary host
 * would leak it, and an operator's inline URL credential must never be overridden.
 */
export function isGitHubHttpsRemoteUrl(remoteUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  return isGitHubDotCom(parsed.hostname);
}

/**
 * Mask credential material embedded in URLs so it never reaches warnings, run errors, or
 * persisted payloads: userinfo on any scheme (`https://user:token@host`,
 * `ssh://user:pass@host`) and the entire query string of any URL (`?access_token=…` and
 * every other parameter — masked wholesale rather than by an inevitably incomplete
 * parameter-name list). Scp-style remotes (`git@host:path`) carry no password and are left
 * alone.
 */
export function scrubGitCredentialText(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s"'?]*)\?[^\s"']*/gi, "$1?***");
}

export function buildGitAuthInvocation(credential: GitCredential): GitAuthInvocation {
  return {
    // The leading empty helper clears ambient helpers (gh, osxkeychain, credential-store) so
    // they neither outrank the resolved token nor receive store/erase callbacks for it. The
    // token helper is installed URL-scoped: git consults it only for credential requests
    // whose context matches github.com over https, so an `insteadOf`-rewritten remote never
    // reaches it (and the helper itself re-checks the request host — see above).
    configArgs: [
      "-c", "credential.helper=",
      "-c", `credential.https://github.com.helper=${GIT_CREDENTIAL_HELPER}`,
      "-c", `credential.https://www.github.com.helper=${GIT_CREDENTIAL_HELPER}`,
    ],
    env: {
      [GIT_CREDENTIAL_TOKEN_ENV_KEY]: credential.token,
      GIT_TERMINAL_PROMPT: "0",
    },
    source: credential.source,
    secretName: credential.secretName,
  };
}

const GIT_AUTH_FAILURE_PATTERN =
  /authentication failed|could not read username|could not read password|invalid username or password|terminal prompts disabled|repository not found|not accessible|permission denied|HTTP 40[13]|The requested URL returned error: 40[13]/i;

/**
 * Turn a failed git network operation into an actionable suffix for the error message.
 * Returns null when the failure does not look auth-related — a credential that was merely
 * present during an unrelated failure (network outage, target-path collision) must not be
 * blamed for it.
 */
export function describeGitAuthFailure(input: {
  error: string;
  used: { source: GitCredential["source"]; secretName: string | null } | null;
}): string | null {
  if (!GIT_AUTH_FAILURE_PATTERN.test(input.error)) {
    return null;
  }
  if (input.used) {
    const label =
      input.used.source === "app_installation"
        ? "the GitHub App installation credential"
        : input.used.secretName
          ? `the ${input.used.secretName} company-secret GitHub credential`
          : "the server-environment GitHub credential";
    return `The operation authenticated with ${label}, which was rejected or lacks access to this repository.`;
  }
  return "No GitHub credential is configured — add a GITHUB_TOKEN or GH_TOKEN company secret in Settings → Secrets, or configure a local checkout cwd for this project workspace.";
}

type SecretServiceLike = ReturnType<typeof secretService>;

type GitCredentialSecretsDeps = {
  getByName: (
    companyId: string,
    name: string,
  ) => Promise<{ id: string } | null | undefined> | ReturnType<SecretServiceLike["getByName"]>;
  resolveSecretValue: SecretServiceLike["resolveSecretValue"];
};

/**
 * Parse `owner`/`repo` from a github.com HTTPS remote URL (only called after
 * `isGitHubHttpsRemoteUrl` has gated it): the first two pathname segments, trailing `.git`
 * dropped. Null when the URL carries no owner/repo path.
 */
function parseOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  let repo = segments[1] ?? "";
  if (repo.endsWith(".git")) repo = repo.slice(0, -".git".length);
  const owner = segments[0] ?? "";
  return owner && repo ? { owner, repo } : null;
}

/**
 * Probe whether a candidate token is usable for one repo via the GitHub API. Only an
 * explicit 401/403 rejection counts: any other outcome (200/404/429/5xx) leaves the real
 * decision to git itself.
 */
async function probeGitHubTokenUsable(token: string, owner: string, repo: string): Promise<boolean> {
  const response = await ghFetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "paperclip-workspace-git",
      "x-github-api-version": "2022-11-28",
      authorization: `Bearer ${token}`,
    },
  });
  return response.status !== 401 && response.status !== 403;
}

/**
 * Build the credential provider for one run. Resolution order: the GitHub App installation
 * token scoped to the remote's owner/repo, then company secrets by well-known name, falling
 * through any candidate GitHub rejects (401/403), then the server process env
 * (`GITHUB_TOKEN`/`GH_TOKEN`) for self-hosted operators, then null. Resolution is memoized
 * per provider instance and per owner/repo so one run performs at most one credential
 * resolution (and writes at most one audit event) per repository no matter how many git
 * operations it authenticates.
 */
export function createGitRemoteAuthProvider(
  db: Db,
  companyId: string,
  context?: {
    issueId?: string | null;
    heartbeatRunId?: string | null;
    responsibleUserId?: string | null;
  },
  deps?: {
    secrets?: GitCredentialSecretsDeps;
    env?: NodeJS.ProcessEnv;
    secretNames?: readonly string[];
    /** Probe a candidate token against the repo; true = accept/usable. */
    probeToken?: (token: string, owner: string, repo: string) => Promise<boolean>;
  },
): GitRemoteAuthProvider {
  const secrets: GitCredentialSecretsDeps = deps?.secrets ?? secretService(db);
  const env = deps?.env ?? process.env;
  const secretNames = deps?.secretNames ?? DEFAULT_GITHUB_TOKEN_SECRET_NAMES;
  const probeToken = deps?.probeToken ?? probeGitHubTokenUsable;
  const accessContext = {
    consumerType: "system",
    consumerId: "workspace-git-credential",
    actorType: "system",
    issueId: context?.issueId ?? null,
    heartbeatRunId: context?.heartbeatRunId ?? null,
    responsibleUserId: context?.responsibleUserId ?? null,
  } as const;
  const credentialPromises = new Map<string, Promise<GitCredential | null>>();

  const resolveCredential = async (owner?: string, repo?: string): Promise<GitCredential | null> => {
    // Probe each candidate in order. Only an explicit GitHub rejection (401/403) moves on to
    // the next candidate; any other outcome (200/404/429/5xx, or a probe that throws) accepts
    // the candidate and lets git make the real decision.
    const acceptIfUsable = async (token: string): Promise<boolean> =>
      owner && repo ? probeToken(token, owner, repo).catch(() => true) : true;

    // App installation first: a scoped installation token must beat any company PAT, so a
    // dead company secret can no longer shadow a healthy installation.
    const appResult = await resolveAppInstallationToken(companyId, secrets, owner, repo, accessContext).catch(
      () => null,
    );
    if (appResult && (await acceptIfUsable(appResult.token))) {
      return {
        token: appResult.token,
        source: "app_installation",
        secretName: GITHUB_APP_PRIVATE_KEY_SECRET_NAME,
      };
    }

    for (const secretName of secretNames) {
      const secret = await Promise.resolve(secrets.getByName(companyId, secretName)).catch(() => null);
      if (!secret) continue;
      // A resolution failure (inactive secret, provider outage) records its own failure audit
      // event; fall through to the next source instead of failing the whole git operation here.
      const token = await secrets
        .resolveSecretValue(companyId, secret.id, "latest", { accessContext })
        .then((value) => value.trim())
        .catch(() => "");
      if (!token) continue;
      if (await acceptIfUsable(token)) return { token, source: "company_secret", secretName };
    }

    const envToken = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || "";
    if (envToken) return { token: envToken, source: "server_env", secretName: null };
    return null;
  };

  return async (remoteUrl: string) => {
    if (!isGitHubHttpsRemoteUrl(remoteUrl)) return null;
    const ownerRepo = parseOwnerRepo(remoteUrl);
    const key = ownerRepo ? `${ownerRepo.owner}/${ownerRepo.repo}` : "unscoped";
    let credentialPromise = credentialPromises.get(key);
    if (!credentialPromise) {
      credentialPromise = resolveCredential(ownerRepo?.owner, ownerRepo?.repo);
      credentialPromises.set(key, credentialPromise);
    }
    const credential = await credentialPromise;
    if (!credential) return null;
    return buildGitAuthInvocation(credential);
  };
}
