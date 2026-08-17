import type { Db } from "@paperclipai/db";
import { and, eq, ilike } from "drizzle-orm";
import { projectWorkspaces, projects } from "@paperclipai/db";
import type { SecretVersionSelector } from "@paperclipai/shared";
import { secretService } from "./secrets.js";

export const GITHUB_TOKEN_SECRET_NAMES = ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"] as const;

export type GitHubTokenScope = "project_env" | "company";

export interface GitHubTokenResolution {
  token: string;
  scope: GitHubTokenScope;
  secretName: string;
}

export interface GitHubTokenResolutionFailure {
  token: null;
  reason: string;
}

export type GitHubTokenResult = GitHubTokenResolution | GitHubTokenResolutionFailure;

export function isGitHubTokenResolution(r: GitHubTokenResult): r is GitHubTokenResolution {
  return r.token !== null;
}

export async function resolveGitHubToken(
  db: Db,
  companyId: string,
): Promise<GitHubTokenResult> {
  const secrets = secretService(db);
  for (const secretName of GITHUB_TOKEN_SECRET_NAMES) {
    const secret = await secrets.getByName(companyId, secretName);
    if (!secret) continue;
    const token = await secrets.resolveSecretValue(companyId, secret.id, "latest");
    const trimmed = token.trim();
    if (trimmed) return { token: trimmed, scope: "company", secretName };
  }
  return { token: null, reason: `No GitHub token resolvable for company ${companyId}` };
}

export async function resolveGitHubTokenForRepo(
  db: Db,
  companyId: string,
  owner: string,
  repo: string,
): Promise<GitHubTokenResult> {
  const secrets = secretService(db);
  const repoUrl = `${owner}/${repo}`;
  const escapedRepoUrl = repoUrl.replace(/[\\%_]/g, (c) => `\\${c}`);

  const projectRows = await db
    .select({
      id: projectWorkspaces.id,
      projectId: projectWorkspaces.projectId,
      repoUrl: projectWorkspaces.repoUrl,
      projectEnv: projects.env,
    })
    .from(projectWorkspaces)
    .innerJoin(projects, eq(projects.id, projectWorkspaces.projectId))
    .where(
      and(
        eq(projectWorkspaces.companyId, companyId),
        ilike(projectWorkspaces.repoUrl, `%${escapedRepoUrl}%`),
      ),
    );

  for (const row of projectRows) {
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
      if (trimmed) return { token: trimmed, scope: "project_env", secretName: key };
    }
  }

  const companyResult = await resolveGitHubToken(db, companyId);
  if (isGitHubTokenResolution(companyResult)) {
    return companyResult;
  }

  if (projectRows.length > 0) {
    return { token: null, reason: `No GitHub token bound to project for ${owner}/${repo}` };
  }
  return {
    token: null,
    reason: `No GitHub token resolvable for ${owner}/${repo} (repo not found at company or project scope)`,
  };
}
