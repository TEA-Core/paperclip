import type { Db } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { executionWorkspaces, projectWorkspaces } from "@paperclipai/db";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { secretService } from "./secrets.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

const GITHUB_TOKEN_SECRET_NAMES = ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"] as const;

const NO_DELIVERABLE_HEAD_DISPOSITIONS = new Set([
  "upstream-equivalent-fix-no-deliverable-head",
  "child-delivery-parent-close",
  "merged-elsewhere",
]);

export interface DoneTransitionGuardResult {
  allowed: boolean;
  reason: string;
  aheadBy: number | null;
  branch: string | null;
  defaultRef: string | null;
  owner: string | null;
  repo: string | null;
  skipped: boolean;
  skipReason: string | null;
}

export interface DoneTransitionOverride {
  disposition: string;
  reason?: string;
}

function parseRepoUrl(repoUrl: string | null): { hostname: string; owner: string; repo: string } | null {
  if (!repoUrl) return null;
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  if (!owner || !repo) return null;
  return { hostname: url.hostname, owner, repo };
}

async function resolveGitHubToken(db: Db, companyId: string): Promise<string | null> {
  const secrets = secretService(db);
  for (const secretName of GITHUB_TOKEN_SECRET_NAMES) {
    const secret = await secrets.getByName(companyId, secretName);
    if (!secret) continue;
    const token = await secrets.resolveSecretValue(companyId, secret.id, "latest");
    const trimmed = token.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

async function resolveIssueRepoContext(
  db: Db,
  issue: {
    companyId: string;
    projectId: string | null;
    projectWorkspaceId: string | null;
    executionWorkspaceId: string | null;
  },
): Promise<{
  branch: string | null;
  defaultRef: string | null;
  repoUrl: string | null;
} | null> {
  if (issue.executionWorkspaceId) {
    const row = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, issue.executionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (row) {
      return {
        branch: row.branchName ?? null,
        defaultRef: row.baseRef ?? null,
        repoUrl: row.repoUrl ?? null,
      };
    }
  }

  if (issue.projectWorkspaceId) {
    const row = await db
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, issue.projectWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (row) {
      return {
        branch: null,
        defaultRef: row.defaultRef ?? row.repoRef ?? null,
        repoUrl: row.repoUrl ?? null,
      };
    }
  }

  if (issue.projectId) {
    const primaryWorkspace = await db
      .select()
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.projectId, issue.projectId),
          eq(projectWorkspaces.companyId, issue.companyId),
          eq(projectWorkspaces.isPrimary, true),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (primaryWorkspace) {
      return {
        branch: null,
        defaultRef: primaryWorkspace.defaultRef ?? primaryWorkspace.repoRef ?? null,
        repoUrl: primaryWorkspace.repoUrl ?? null,
      };
    }
  }

  return null;
}

async function githubCompareAheadBy(
  hostname: string,
  owner: string,
  repo: string,
  defaultRef: string,
  branch: string,
  token: string,
): Promise<number | null> {
  const apiBase = gitHubApiBase(hostname);
  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(defaultRef)}...${encodeURIComponent(branch)}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-done-transition-guard",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };
  const response = await ghFetch(url, { headers });
  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`GitHub compare API returned ${response.status}`);
  }
  const body = await response.json().catch(() => null);
  const ahead = (body as Record<string, unknown> | null)?.ahead_by;
  if (typeof ahead === "number") return ahead;
  return null;
}

async function githubBranchHasMergedPr(
  hostname: string,
  owner: string,
  repo: string,
  branch: string,
  token: string,
): Promise<boolean> {
  const apiBase = gitHubApiBase(hostname);
  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=closed&per_page=100`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-done-transition-guard",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };
  const response = await ghFetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub pulls API returned ${response.status}`);
  }
  const body = await response.json().catch(() => null);
  const pulls = Array.isArray(body) ? body : [];
  return pulls.some((pr) => {
    const record = pr as Record<string, unknown>;
    const merged = record.merged === true || typeof record.merged_at === "string";
    return merged;
  });
}

async function writeAuditLog(
  db: Db,
  issue: { id: string; companyId: string; identifier: string | null },
  action: string,
  details: Record<string, unknown>,
) {
  try {
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "done-transition-guard",
      agentId: null,
      runId: null,
      agentApiKeyId: null,
      action,
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier ?? null,
        ...details,
      },
    });
  } catch (err) {
    logger.warn({ err, issueId: issue.id, action }, "failed to write done-transition audit log");
  }
}

export async function evaluateDoneTransitionGuard(
  db: Db,
  issue: {
    id: string;
    companyId: string;
    identifier: string | null;
    projectId: string | null;
    projectWorkspaceId: string | null;
    executionWorkspaceId: string | null;
  },
  override: DoneTransitionOverride | null,
): Promise<DoneTransitionGuardResult> {
  const fallback = (reason: string, skipped = false, skipReason: string | null = null): DoneTransitionGuardResult => ({
    allowed: true,
    reason,
    aheadBy: null,
    branch: null,
    defaultRef: null,
    owner: null,
    repo: null,
    skipped,
    skipReason,
  });

  if (override && NO_DELIVERABLE_HEAD_DISPOSITIONS.has(override.disposition)) {
    void writeAuditLog(db, issue, "issue.done_transition_override", {
      disposition: override.disposition,
      overrideReason: override.reason ?? null,
      source: "done_transition_guard",
    });
    return {
      allowed: true,
      reason: `Override accepted: ${override.disposition}`,
      aheadBy: null,
      branch: null,
      defaultRef: null,
      owner: null,
      repo: null,
      skipped: false,
      skipReason: null,
    };
  }

  const ctx = await resolveIssueRepoContext(db, issue);
  if (!ctx || !ctx.repoUrl || !ctx.defaultRef) {
    return fallback("No resolvable execution workspace or repo context; transition allowed");
  }

  const parsed = parseRepoUrl(ctx.repoUrl);
  if (!parsed) {
    return fallback(
      `Could not parse repo URL from execution workspace; transition allowed`,
      true,
      `unparseable_repo_url:${ctx.repoUrl}`,
    );
  }

  const branch = ctx.branch;
  if (!branch) {
    return fallback("Execution workspace has no recorded branch; transition allowed");
  }

  let token: string | null;
  try {
    token = await resolveGitHubToken(db, issue.companyId);
  } catch (err) {
    return fallback(
      "GitHub token resolution failed; transition allowed",
      true,
      `token_resolution_failed:${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  if (!token) {
    return fallback(
      "GitHub token not configured for company; transition allowed",
      true,
      "token_missing",
    );
  }

  let aheadBy: number | null;
  try {
    aheadBy = await githubCompareAheadBy(parsed.hostname, parsed.owner, parsed.repo, ctx.defaultRef, branch, token);
  } catch (err) {
    return fallback(
      "GitHub compare API call failed; transition allowed",
      true,
      `compare_api_failed:${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  if (aheadBy === null) {
    return fallback(
      `GitHub compare returned no ahead_by for branch ${branch}; transition allowed`,
      true,
      `compare_no_ahead_by:branch=${branch}`,
    );
  }

  if (aheadBy === 0) {
    return {
      allowed: true,
      reason: `Branch ${branch} is not ahead of ${ctx.defaultRef}`,
      aheadBy: 0,
      branch,
      defaultRef: ctx.defaultRef,
      owner: parsed.owner,
      repo: parsed.repo,
      skipped: false,
      skipReason: null,
    };
  }

  let hasMergedPr: boolean;
  try {
    hasMergedPr = await githubBranchHasMergedPr(parsed.hostname, parsed.owner, parsed.repo, branch, token);
  } catch (err) {
    return fallback(
      "GitHub merged-PR lookup failed; transition allowed",
      true,
      `merged_pr_lookup_failed:${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  if (hasMergedPr) {
    return {
      allowed: true,
      reason: `Branch ${branch} has a merged PR; transition allowed`,
      aheadBy,
      branch,
      defaultRef: ctx.defaultRef,
      owner: parsed.owner,
      repo: parsed.repo,
      skipped: false,
      skipReason: null,
    };
  }

  return {
    allowed: false,
    reason: `Branch ${branch} is ahead of ${ctx.defaultRef} by ${aheadBy} commits and has no merged PR. Use deliver.sh to deliver this work before marking the issue done.`,
    aheadBy,
    branch,
    defaultRef: ctx.defaultRef,
    owner: parsed.owner,
    repo: parsed.repo,
    skipped: false,
    skipReason: null,
  };
}

export { writeAuditLog };
