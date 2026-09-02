import { createSign } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { projectWorkspaces, projects } from "@paperclipai/db";
import type { SecretVersionSelector } from "@paperclipai/shared";
import { secretService } from "./secrets.js";
import { logger } from "../middleware/logger.js";

export const GITHUB_TOKEN_SECRET_NAMES = ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"] as const;

export const GITHUB_APP_PRIVATE_KEY_SECRET_NAME = "GITHUB_APP_PRIVATE_KEY";

export const GITHUB_APP_ID = "4595159";

/**
 * The identity of a GitHub App for installation-token minting: its numeric App id (used as
 * the JWT `iss`) and the secret-store name holding its private key. `resolveAppInstallationToken`
 * accepts one so a company can mint tokens for more than one installed App; the token cache is
 * keyed by this identity so one App's token is never served to a caller asking for another.
 */
export interface GitHubAppDescriptor {
  appId: string;
  privateKeySecretName: string;
}

/** Default App identity: app 4595159, private key under GITHUB_APP_PRIVATE_KEY. */
export const DEFAULT_GITHUB_APP: GitHubAppDescriptor = {
  appId: GITHUB_APP_ID,
  privateKeySecretName: GITHUB_APP_PRIVATE_KEY_SECRET_NAME,
};

export type GitHubTokenScope = "app_installation" | "project_env" | "company";

export interface GitHubTokenResolution {
  token: string;
  scope: GitHubTokenScope;
  secretName: string;
  installationId?: string;
  /** Epoch millis when the minted installation token expires (present for app_installation scope). */
  expiresAt?: number;
}

export interface GitHubTokenResolutionFailure {
  token: null;
  reason: string;
}

export type GitHubTokenResult = GitHubTokenResolution | GitHubTokenResolutionFailure;

export function isGitHubTokenResolution(r: GitHubTokenResult): r is GitHubTokenResolution {
  return r.token !== null;
}

interface CachedAppToken {
  token: string;
  installationId: string;
  expiresAt: number;
}

export const appTokenCache = new Map<string, CachedAppToken>();

const CACHE_SAFETY_MARGIN_MS = 5 * 60 * 1000;

const GH_API_BASE = "https://api.github.com";

const GH_FETCH_TIMEOUT_MS = 15_000;

function generateAppJWT(privateKey: string, appId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 10, exp: now + 60, iss: appId };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `${header}.${body}`;
  const sig = createSign("RSA-SHA256").update(data).sign(privateKey, "base64url");
  return `${data}.${sig}`;
}

async function ghAppFetch(
  path: string,
  jwt: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`GitHub App API timeout after ${GH_FETCH_TIMEOUT_MS}ms: ${path}`)),
    GH_FETCH_TIMEOUT_MS,
  );
  try {
    const res = await fetch(`${GH_API_BASE}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "POST" && body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GitHub App API ${method} ${path} → ${res.status}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function isExpired(cached: CachedAppToken, now: number): boolean {
  return now >= cached.expiresAt - CACHE_SAFETY_MARGIN_MS;
}

/**
 * The minimal secret-store surface App-token minting needs. Deliberately narrower than
 * `secretService(db)` so a credential provider (e.g. the git remote auth provider) can pass
 * its own secret deps without pulling the whole secret service along.
 */
export interface AppInstallationTokenSecrets {
  getByName: (companyId: string, name: string) => Promise<{ id: string } | null | undefined>;
  resolveSecretValue: (
    companyId: string,
    secretId: string,
    version: number | "latest",
    contextOrOptions?: any,
  ) => Promise<string>;
}

export async function resolveAppInstallationToken(
  companyId: string,
  secrets: AppInstallationTokenSecrets,
  owner?: string,
  repo?: string,
  accessContext?: Record<string, unknown>,
  app: GitHubAppDescriptor = DEFAULT_GITHUB_APP,
  permissions?: Record<string, unknown>,
): Promise<GitHubTokenResolution | null> {
  const permissionsKey = permissions
    ? JSON.stringify(Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b)))
    : "";
  const cacheKey = `${companyId}:${app.appId}:${owner ?? ""}:${repo ?? ""}:${permissionsKey}`;
  const now = Date.now();

  const cached = appTokenCache.get(cacheKey);
  if (cached && !isExpired(cached, now)) {
    return {
      token: cached.token,
      scope: "app_installation",
      secretName: app.privateKeySecretName,
      installationId: cached.installationId,
      expiresAt: cached.expiresAt,
    };
  }

  const secret = await secrets.getByName(companyId, app.privateKeySecretName);
  if (!secret) return null;

  let privateKey: string;
  try {
    privateKey = await secrets.resolveSecretValue(
      companyId,
      secret.id,
      "latest",
      accessContext ? { accessContext } : undefined,
    );
  } catch {
    logger.warn(
      { companyId, secretName: app.privateKeySecretName },
      "Failed to resolve GitHub App private key secret; falling back to PAT",
    );
    return null;
  }

  if (!privateKey || !privateKey.trim()) {
    logger.warn(
      { companyId, secretName: app.privateKeySecretName },
      "GitHub App private key secret is empty; falling back to PAT",
    );
    return null;
  }

  let jwt: string;
  try {
    jwt = generateAppJWT(privateKey, app.appId);
  } catch {
    logger.warn(
      { companyId, secretName: app.privateKeySecretName },
      "Failed to generate GitHub App JWT (malformed PEM); falling back to PAT",
    );
    return null;
  }

  let installationId: string;
  try {
    if (owner && repo) {
      const installation = await ghAppFetch(`/repos/${owner}/${repo}/installation`, jwt);
      installationId = String(installation.id);
    } else {
      const installations = await ghAppFetch(`/app/installations`, jwt);
      if (!installations.length) {
        logger.warn(
          { companyId },
          "No GitHub App installations found; falling back to PAT",
        );
        return null;
      }
      if (installations.length === 1) {
        installationId = String(installations[0].id);
      } else {
        logger.warn(
          { companyId, installationCount: installations.length },
          "Multiple GitHub App installations found without repo context; falling back to PAT",
        );
        return null;
      }
    }
  } catch (err) {
    logger.warn(
      {
        companyId,
        secretName: app.privateKeySecretName,
        error: err instanceof Error ? err.message : "unknown",
      },
      "GitHub App installation resolution failed; falling back to PAT",
    );
    return null;
  }

  // Narrow the minted installation token to the repo the caller was authorized
  // for. Without `repositories` in the mint body GitHub issues an
  // installation-wide token, so the credential would out-reach the repo the
  // request-layer check already granted (owner/repo).
  const mintBody: Record<string, unknown> = {};
  if (permissions) mintBody.permissions = permissions;
  if (owner && repo) mintBody.repositories = [repo];

  let tokenResponse: { token: string; expires_at: string };
  try {
    tokenResponse = await ghAppFetch(
      `/app/installations/${installationId}/access_tokens`,
      jwt,
      "POST",
      Object.keys(mintBody).length > 0 ? mintBody : undefined,
    );
  } catch (err) {
    logger.warn(
      {
        companyId,
        secretName: app.privateKeySecretName,
        error: err instanceof Error ? err.message : "unknown",
      },
      "GitHub App installation token minting failed; falling back to PAT",
    );
    return null;
  }

  if (!tokenResponse.token) {
    logger.warn(
      { companyId, secretName: app.privateKeySecretName },
      "GitHub App returned empty token; falling back to PAT",
    );
    return null;
  }

  const expiresAt = new Date(tokenResponse.expires_at).getTime();
  const safeExpiresAt = isNaN(expiresAt) ? Date.now() + 60 * 60 * 1000 : expiresAt;
  appTokenCache.set(cacheKey, {
    token: tokenResponse.token,
    installationId,
    expiresAt: safeExpiresAt,
  });

  return {
    token: tokenResponse.token,
    scope: "app_installation",
    secretName: app.privateKeySecretName,
    installationId,
    expiresAt: safeExpiresAt,
  };
}

export async function resolveGitHubToken(
  db: Db,
  companyId: string,
): Promise<GitHubTokenResult> {
  const secrets = secretService(db);

  const appResult = await resolveAppInstallationToken(companyId, secrets);
  if (appResult) return appResult;

  for (const secretName of GITHUB_TOKEN_SECRET_NAMES) {
    const secret = await secrets.getByName(companyId, secretName);
    if (!secret) continue;
    const token = await secrets.resolveSecretValue(companyId, secret.id, "latest");
    const trimmed = token.trim();
    if (trimmed) return { token: trimmed, scope: "company", secretName };
  }
  return { token: null, reason: `No GitHub token resolvable for company ${companyId}` };
}

/**
 * Normalize a workspace repoUrl to lowercase `owner/repo` so rows can be
 * compared exactly, regardless of URL scheme, host, `.git` suffix, trailing
 * slash, or casing. GitHub owner/repo references are case-insensitive.
 */
export function normalizeRepoUrl(repoUrl: string): string {
  let normalized = repoUrl.trim();
  normalized = normalized.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, "");
  normalized = normalized.replace(/^[\w.@-]+@[\w.-]+:/, "");
  normalized = normalized.replace(/\/+$/, "");
  normalized = normalized.replace(/\.git$/i, "");
  return normalized.toLowerCase();
}

export async function resolveGitHubTokenCandidatesForRepo(
  db: Db,
  companyId: string,
  owner: string,
  repo: string,
): Promise<GitHubTokenResolution[]> {
  const secrets = secretService(db);
  const normalizedRepo = normalizeRepoUrl(`${owner}/${repo}`);

  const candidates: GitHubTokenResolution[] = [];
  const seenTokens = new Set<string>();

  const appResult = await resolveAppInstallationToken(companyId, secrets, owner, repo);
  if (appResult) {
    candidates.push(appResult);
    seenTokens.add(appResult.token);
  }

  const projectRows = await db
    .select({
      id: projectWorkspaces.id,
      projectId: projectWorkspaces.projectId,
      repoUrl: projectWorkspaces.repoUrl,
      projectEnv: projects.env,
    })
    .from(projectWorkspaces)
    .innerJoin(projects, eq(projects.id, projectWorkspaces.projectId))
    .where(eq(projectWorkspaces.companyId, companyId));

  for (const row of projectRows) {
    if (typeof row.repoUrl !== "string") continue;
    if (normalizeRepoUrl(row.repoUrl) !== normalizedRepo) continue;
    const projectEnv = row.projectEnv as Record<string, unknown> | null;
    if (!projectEnv) continue;
    for (const key of GITHUB_TOKEN_SECRET_NAMES) {
      const binding = projectEnv[key];
      if (!binding || typeof binding !== "object") continue;
      const ref = binding as { type?: unknown; secretId?: unknown; version?: unknown };
      if (ref.type !== "secret_ref") continue;
      if (typeof ref.secretId !== "string") continue;
      const version: SecretVersionSelector = typeof ref.version === "number" ? ref.version : "latest";
      const token = await secrets.resolveSecretValue(companyId, ref.secretId, version);
      const trimmed = token.trim();
      if (!trimmed) continue;
      if (seenTokens.has(trimmed)) continue;
      seenTokens.add(trimmed);
      candidates.push({ token: trimmed, scope: "project_env", secretName: key });
    }
  }

  for (const secretName of GITHUB_TOKEN_SECRET_NAMES) {
    const secret = await secrets.getByName(companyId, secretName);
    if (!secret) continue;
    const token = await secrets.resolveSecretValue(companyId, secret.id, "latest");
    const trimmed = token.trim();
    if (!trimmed) continue;
    if (seenTokens.has(trimmed)) continue;
    seenTokens.add(trimmed);
    candidates.push({ token: trimmed, scope: "company", secretName });
  }

  return candidates;
}

export async function resolveGitHubTokenForRepo(
  db: Db,
  companyId: string,
  owner: string,
  repo: string,
): Promise<GitHubTokenResult> {
  const candidates = await resolveGitHubTokenCandidatesForRepo(db, companyId, owner, repo);
  if (candidates.length > 0) {
    return candidates[0]!;
  }

  const normalizedRepo = normalizeRepoUrl(`${owner}/${repo}`);
  const projectRows = await db
    .select({ repoUrl: projectWorkspaces.repoUrl })
    .from(projectWorkspaces)
    .innerJoin(projects, eq(projects.id, projectWorkspaces.projectId))
    .where(eq(projectWorkspaces.companyId, companyId));

  const hasExactMatch = projectRows.some(
    (row) => typeof row.repoUrl === "string" && normalizeRepoUrl(row.repoUrl) === normalizedRepo,
  );

  if (hasExactMatch) {
    return { token: null, reason: `No GitHub token bound to project for ${owner}/${repo}` };
  }
  return {
    token: null,
    reason: `No GitHub token resolvable for ${owner}/${repo} (repo not found at company or project scope)`,
  };
}
