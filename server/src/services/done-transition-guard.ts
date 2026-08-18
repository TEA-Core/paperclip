import { execFile } from "node:child_process";
import type { Db } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { executionWorkspaces, projectWorkspaces } from "@paperclipai/db";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import {
  resolveGitHubToken,
  type GitHubTokenScope,
} from "./github-credential.js";
import { logActivity } from "./activity-log.js";
import { resolveLinkedPullRequestsWithState, type LinkedPullRequest } from "./merge-arming.js";
import { logger } from "../middleware/logger.js";
import type { IssueComment } from "@paperclipai/shared";

export class GitHubAuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubAuthError";
    this.status = status;
  }
}

export class GitHubBranchNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubBranchNotFoundError";
  }
}

const NO_DELIVERABLE_HEAD_DISPOSITIONS = new Set([
  "upstream-equivalent-fix-no-deliverable-head",
  "child-delivery-parent-close",
  "merged-elsewhere",
]);

const TIER_2_PREFIX = "Closed at Tier 2 (live):";
const TIER_1_PREFIX = "Closed at Tier 1 (landed, not liveness-probed):";
const TIER_1_SUFFIX = "Liveness unverified.";

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

export interface DoneTierDeclarationResult {
  allowed: boolean;
  reason: string;
  tier: "tier1" | "tier2" | null;
  skipped: boolean;
  skipReason: string | null;
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

function appendSkipReason(current: string | null, piece: string): string {
  return current ? `${current}; ${piece}` : piece;
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
  providerType: string | null;
  worktreePath: string | null;
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
        providerType: row.providerType ?? null,
        worktreePath: row.providerRef ?? row.cwd ?? null,
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
        providerType: null,
        worktreePath: null,
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
        providerType: null,
        worktreePath: null,
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
      throw new GitHubBranchNotFoundError(
        `GitHub compare API returned 404 for ${owner}/${repo}; branch ${branch} absent on remote`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new GitHubAuthError(response.status, `GitHub compare API returned ${response.status}`);
    }
    throw new Error(`GitHub compare API returned ${response.status}`);
  }
  const body = await response.json().catch(() => null);
  const ahead = (body as Record<string, unknown> | null)?.ahead_by;
  if (typeof ahead === "number") return ahead;
  return null;
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * Count commits ahead of the remote base ref that are attributable to the given
 * issue identifier (subject or trailer match). Returns null when the probe is
 * unreachable (missing worktree, git failure, unresolvable base ref) so callers
 * can fail open instead of blocking on a signal they could not measure.
 */
async function countIssueAttributableCommits(
  worktreePath: string,
  defaultRef: string,
  identifier: string | null,
): Promise<{ aheadCount: number; attributableCount: number } | null> {
  if (!identifier) return null;
  try {
    const range = `${defaultRef}..HEAD`;
    const aheadRaw = await runGit(["rev-list", "--count", range], worktreePath);
    const attributableRaw = await runGit(
      ["rev-list", "--fixed-strings", "--count", "--grep", identifier, range],
      worktreePath,
    );
    const aheadCount = Number.parseInt(aheadRaw.trim(), 10);
    const attributableCount = Number.parseInt(attributableRaw.trim(), 10);
    if (Number.isNaN(aheadCount) || Number.isNaN(attributableCount)) return null;
    return { aheadCount, attributableCount };
  } catch {
    return null;
  }
}

/**
 * Count merged PRs in the repo whose title or body references the issue identifier.
 *
 * This is the carrier-delivery discriminator: work is routinely landed on a shared
 * carrier branch (or a differently-named head) while the issue's own execution
 * branch is never pushed, so the compare call 404s even though the deliverable is
 * merged and live. A merged PR naming the identifier is positive evidence the work
 * landed, and must not be blocked.
 *
 * Returns null when the probe could not be measured (non-OK response, malformed
 * body, transport failure) so callers fail open rather than blocking on an
 * unmeasured signal.
 */
async function githubMergedPrCountForIdentifier(
  hostname: string,
  owner: string,
  repo: string,
  identifier: string,
  token: string,
): Promise<number | null> {
  const apiBase = gitHubApiBase(hostname);
  const query = `repo:${owner}/${repo} is:pr is:merged in:title,body "${identifier}"`;
  const url = `${apiBase}/search/issues?q=${encodeURIComponent(query)}&per_page=1`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-done-transition-guard",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };
  try {
    const response = await ghFetch(url, { headers });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    const total = (body as Record<string, unknown> | null)?.total_count;
    return typeof total === "number" ? total : null;
  } catch {
    return null;
  }
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
    if (response.status === 401 || response.status === 403) {
      throw new GitHubAuthError(response.status, `GitHub pulls API returned ${response.status}`);
    }
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

async function hydrateLinkedPrState(
  pr: LinkedPullRequest,
  token: string,
): Promise<LinkedPullRequest> {
  const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-done-transition-guard",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };
  try {
    const response = await ghFetch(url, { headers });
    if (!response.ok) {
      return pr;
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return pr;
    const state = body.state as string | undefined;
    if (typeof state === "string") {
      // The live call just succeeded: the persisted refresh error code (if any)
      // no longer describes this object, and the PR state below is positively
      // proven again.
      return { ...pr, cachedState: state, lastErrorCode: null };
    }
    return pr;
  } catch {
    return pr;
  }
}

function parseTier2Declaration(body: string): { matched: boolean; evidence: string } {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(TIER_2_PREFIX)) {
      const evidence = trimmed.slice(TIER_2_PREFIX.length).trim();
      if (evidence.length > 0) {
        return { matched: true, evidence };
      }
      const idx = lines.indexOf(line);
      const nextLine = idx >= 0 && idx + 1 < lines.length ? lines[idx + 1] : undefined;
      if (nextLine !== undefined) {
        const nextTrimmed = nextLine.trim();
        if (nextTrimmed.length > 0) {
          return { matched: true, evidence: nextTrimmed };
        }
      }
      return { matched: false, evidence: "" };
    }
  }
  return { matched: false, evidence: "" };
}

function parseTier1Declaration(body: string): { matched: boolean; reason: string } {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(TIER_1_PREFIX)) {
      const rest = trimmed.slice(TIER_1_PREFIX.length).trim();
      const suffixIdx = rest.lastIndexOf(TIER_1_SUFFIX);
      if (suffixIdx === -1) {
        return { matched: false, reason: "" };
      }
      const reason = rest.slice(0, suffixIdx).trim();
      return { matched: true, reason };
    }
  }
  return { matched: false, reason: "" };
}

export async function evaluateDoneTierDeclaration(
  db: Db,
  issue: { id: string; companyId: string; identifier: string | null },
  accompanyingComment: string | null,
  runId: string | null,
  listComments: (issueId: string) => Promise<IssueComment[]>,
): Promise<DoneTierDeclarationResult> {
  const fallback = (reason: string, skipped = false, skipReason: string | null = null): DoneTierDeclarationResult => ({
    allowed: true,
    reason,
    tier: null,
    skipped,
    skipReason,
  });

  if (accompanyingComment && accompanyingComment.trim().length > 0) {
    const tier2 = parseTier2Declaration(accompanyingComment);
    if (tier2.matched) {
      return {
        allowed: true,
        reason: `Tier 2 declaration found: ${tier2.evidence.slice(0, 200)}`,
        tier: "tier2",
        skipped: false,
        skipReason: null,
      };
    }
    const tier1 = parseTier1Declaration(accompanyingComment);
    if (tier1.matched) {
      if (tier1.reason.length === 0) {
        return {
          allowed: false,
          reason: `Tier 1 declaration found but <reason> is empty. Use: "Closed at Tier 1 (landed, not liveness-probed): <reason>. Liveness unverified."`,
          tier: null,
          skipped: false,
          skipReason: null,
        };
      }
      return {
        allowed: true,
        reason: `Tier 1 declaration found: ${tier1.reason.slice(0, 200)}`,
        tier: "tier1",
        skipped: false,
        skipReason: null,
      };
    }
    return {
      allowed: false,
      reason:
        "Close comment is missing a done-tier declaration. Accepted forms: " +
        `"Closed at Tier 2 (live): <probe evidence>"` +
        ` or ` +
        `"Closed at Tier 1 (landed, not liveness-probed): <reason>. Liveness unverified."` +
        ` — per SUP-12693.`,
      tier: null,
      skipped: false,
      skipReason: null,
    };
  }

  if (!runId) {
    return fallback(
      "No accompanying comment and no run id to look up same-run comment; transition allowed",
      true,
      "no_accompanying_comment_no_run_id",
    );
  }

  let comments: IssueComment[];
  try {
    comments = await listComments(issue.id);
  } catch (err) {
    return fallback(
      "Comment store lookup failed; transition allowed",
      true,
      `comment_store_failed:${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  const sameRunComment = comments.find((c) => {
    const commentRunId = c.createdByRunId ?? c.derivedCreatedByRunId;
    return commentRunId === runId;
  });

  if (!sameRunComment || !sameRunComment.body || sameRunComment.body.trim().length === 0) {
    return {
      allowed: false,
      reason:
        "No done-tier declaration found in the accompanying comment or the most recent same-run comment. " +
        `Accepted forms: "Closed at Tier 2 (live): <probe evidence>"` +
        ` or ` +
        `"Closed at Tier 1 (landed, not liveness-probed): <reason>. Liveness unverified."` +
        ` — per SUP-12693.`,
      tier: null,
      skipped: false,
      skipReason: null,
    };
  }

  const tier2 = parseTier2Declaration(sameRunComment.body);
  if (tier2.matched) {
    return {
      allowed: true,
      reason: `Tier 2 declaration found in same-run comment: ${tier2.evidence.slice(0, 200)}`,
      tier: "tier2",
      skipped: false,
      skipReason: null,
    };
  }

  const tier1 = parseTier1Declaration(sameRunComment.body);
  if (tier1.matched) {
    if (tier1.reason.length === 0) {
      return {
        allowed: false,
        reason:
          "Tier 1 declaration found in same-run comment but <reason> is empty. " +
          `Use: "Closed at Tier 1 (landed, not liveness-probed): <reason>. Liveness unverified."`,
        tier: null,
        skipped: false,
        skipReason: null,
      };
    }
    return {
      allowed: true,
      reason: `Tier 1 declaration found in same-run comment: ${tier1.reason.slice(0, 200)}`,
      tier: "tier1",
      skipped: false,
      skipReason: null,
    };
  }

  return {
    allowed: false,
    reason:
      "Same-run comment does not contain a done-tier declaration. " +
      `Accepted forms: "Closed at Tier 2 (live): <probe evidence>"` +
      ` or ` +
      `"Closed at Tier 1 (landed, not liveness-probed): <reason>. Liveness unverified."` +
      ` — per SUP-12693.`,
    tier: null,
    skipped: false,
    skipReason: null,
  };
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
  decisionCarried: boolean = false,
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
    skipReason: skipReason && prSkipReason ? `${skipReason}; ${prSkipReason}` : (skipReason ?? prSkipReason),
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

  // Only PRs we can positively prove are open may block `done`. An external-object
  // row is created from a mere URL mention with `data` NULL, and is hydrated later by
  // a refresh that calls the GitHub API — the same call that 401s under SUP-13038.
  // Treating an unhydrated row as open would block `done` on any issue that merely
  // links a PR (including already-merged or unrelated ones) in exactly the
  // credential-less configuration this guard is built for. Fail open on unknown.
  let resolvedPrs = await resolveLinkedPullRequestsWithState(db, issue.companyId, issue.id);

  // Best-effort synchronous hydration: attempt to fetch current state from GitHub for
  // any unhydrated (cachedState === null) rows and any cached-"open" rows. A cached
  // "open" is positive proof only as of the last successful refresh; a PR merged
  // since then (e.g. the merge→sweep-rehydration window) must not block `done` on
  // stale state. A thrown/failed hydration must NOT throw — degrade to the cached
  // state. We only hydrate if a company token is available; if token resolution
  // itself fails, we keep the cached states as-is.
  let prSkipReason: string | null = null;
  try {
    const tokenResult = await resolveGitHubToken(db, issue.companyId);
    if (tokenResult.token !== null) {
      const toHydrate = resolvedPrs.filter((p) => p.cachedState === null || p.cachedState === "open");
      if (toHydrate.length > 0) {
        const hydrated = await Promise.all(
          toHydrate.map((p) => hydrateLinkedPrState(p, tokenResult.token)),
        );
        const hydratedMap = new Map(hydrated.map((p) => [p.id, p] as const));
        resolvedPrs = resolvedPrs.map((p) => hydratedMap.get(p.id) ?? p);
      }
    }
  } catch {
    // Token resolution failed — keep cached states, proceed to skipReason below.
  }

  // Only positively-proven-open PRs may block `done`. A cached "open" whose last
  // refresh errored github_auth_required could not be re-verified: the refresh path
  // persists that code when the provider rejects the credential (missing company
  // token, SUP-12987), and the guard above could not re-hydrate it either (no token,
  // or the live call failed). It is not positive proof the PR is open now, so — like
  // an unhydrated row — it fails open on unknown. A successful live re-hydration
  // clears lastErrorCode, so only genuinely unverified rows are excluded.
  const staleOpenUnverifiable = resolvedPrs.filter(
    (p) => p.cachedState === "open" && p.lastErrorCode === "github_auth_required",
  );
  if (staleOpenUnverifiable.length > 0) {
    prSkipReason = appendSkipReason(prSkipReason, `stale_open_unverifiable:${staleOpenUnverifiable.length}`);
    void writeAuditLog(db, issue, "issue.done_transition_guard_failed_open", {
      reason: `stale_open_unverifiable:${staleOpenUnverifiable.length}`,
      prs: staleOpenUnverifiable.map((p) => p.displayName).join(", "),
    });
  }
  const openPrs = resolvedPrs.filter(
    (p) => p.cachedState === "open" && p.lastErrorCode !== "github_auth_required",
  );
  const unhydratedCount = resolvedPrs.filter((p) => p.cachedState === null).length;
  if (unhydratedCount > 0) {
    prSkipReason = appendSkipReason(prSkipReason, `unhydrated_linked_prs:${unhydratedCount}`);
  }

  if (openPrs.length > 0) {
    const prNames = openPrs.map((p) => p.displayName).join(", ");
    if (decisionCarried) {
      // A review approval is exactly what arms the merge (armMergeOnApproval):
      // blocking the approval on the open PR it approves deadlocks the
      // approval circuit (SUP-13207, board direction B). Plain (non-decision)
      // closes must still land the PRs first.
      void writeAuditLog(db, issue, "issue.done_transition_guard_skipped", {
        reason: `open_linked_prs_decision_carried:${openPrs.length}`,
        skipReason: `open_linked_prs_decision_carried:${openPrs.length}`,
        prs: prNames,
      });
      return {
        allowed: true,
        reason:
          `Decision-carrying transition exempted from the open-linked-PR block: ` +
          `Issue has ${openPrs.length} open linked PR${openPrs.length === 1 ? "" : "s"} (${prNames}). ` +
          "The approval arms the merge rather than closing the issue — the PR(s) stay open until the merge lands.",
        aheadBy: null,
        branch: null,
        defaultRef: null,
        owner: null,
        repo: null,
        skipped: false,
        skipReason: prSkipReason,
      };
    }
    void writeAuditLog(db, issue, "issue.done_transition_guard_skipped", {
      reason: `open_linked_prs:${openPrs.length}`,
      skipReason: `open_linked_prs:${openPrs.length}`,
      prs: prNames,
    });
    return {
      allowed: false,
      reason:
        `Issue has ${openPrs.length} open linked PR${openPrs.length === 1 ? "" : "s"} (${prNames}). ` +
        "Land them (merge or close the PRs) before marking done, or set doneTransitionOverride to a " +
        `sanctioned no-deliverable-head disposition (${[...NO_DELIVERABLE_HEAD_DISPOSITIONS].join(" / ")}). ` +
        "A done-tier declaration alone does not clear this block — the tier check runs after this guard.",
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
  let tokenScope: GitHubTokenScope | null = null;
  let tokenSecretName: string | null = null;
  try {
    const tokenResult = await resolveGitHubToken(db, issue.companyId);
    token = tokenResult.token;
    if (tokenResult.token !== null) {
      tokenScope = tokenResult.scope;
      tokenSecretName = tokenResult.secretName;
    }
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
    if (err instanceof GitHubAuthError) {
      return fallback(
        `GitHub compare API rejected the credential (HTTP ${err.status}); transition allowed`,
        true,
        `auth_failed:compare:${err.status}:scope=${tokenScope ?? "unknown"}:secretName=${tokenSecretName ?? "unknown"}`,
      );
    }
    if (err instanceof GitHubBranchNotFoundError) {
      // A 404 on the compare call means the branch does not exist on the remote.
      // Block only when the local worktree carries at least one commit that is
      // attributable to this issue: reachable from the workspace head, not
      // reachable from the remote base ref, and whose subject or trailer
      // references the issue identifier (matching the `fix(SUP-NNNNN):`
      // convention deliver.sh emits). Base drift alone — a worktree several
      // commits ahead of a stale local base with none attributable — must fail
      // open, because that state is a property of the checkout mechanism, not of
      // the issue's work (SUP-13205).
      const attribution = ctx.worktreePath
        ? await countIssueAttributableCommits(ctx.worktreePath, ctx.defaultRef, issue.identifier)
        : null;
      if (attribution && attribution.attributableCount > 0) {
        // Carrier delivery: the deliverable is routinely merged from a shared
        // carrier branch or a differently-named head while this issue's own
        // execution branch is never pushed. The local worktree still carries the
        // pre-merge, issue-attributable commits, so attribution alone would block
        // work that is already merged and live. A merged PR naming the identifier
        // is positive evidence of landing — fail open on it. An unmeasurable probe
        // also fails open: never block on a signal we could not measure (SUP-13199).
        const mergedPrCount = issue.identifier
          ? await githubMergedPrCountForIdentifier(
              parsed.hostname,
              parsed.owner,
              parsed.repo,
              issue.identifier,
              token,
            )
          : null;
        if (mergedPrCount === null) {
          return fallback(
            `Branch ${branch} is absent from the remote and the merged-PR probe for ${issue.identifier ?? "the issue"} could not be measured; transition allowed`,
            true,
            `branch_absent_merged_pr_probe_failed:${branch}`,
          );
        }
        if (mergedPrCount > 0) {
          return fallback(
            `Branch ${branch} is absent from the remote, but ${mergedPrCount} merged PR${mergedPrCount === 1 ? "" : "s"} reference ${issue.identifier} (carrier delivery); transition allowed`,
            true,
            `branch_absent_landed_via_merged_pr:${issue.identifier}:${mergedPrCount}`,
          );
        }
        void writeAuditLog(db, issue, "issue.done_transition_guard_skipped", {
          reason: "branch_absent_on_remote",
          branch,
          defaultRef: ctx.defaultRef,
          owner: parsed.owner,
          repo: parsed.repo,
          aheadCount: attribution.aheadCount,
          attributableCommitCount: attribution.attributableCount,
          mergedPrCount,
        });
        return {
          allowed: false,
          reason:
            `Branch ${branch} does not exist on the remote (${parsed.owner}/${parsed.repo}) ` +
            `while the execution workspace carries ${attribution.attributableCount} commit${attribution.attributableCount === 1 ? "" : "s"} ` +
            `attributable to ${issue.identifier} (subject/trailer reference) not reachable from the remote base ${ctx.defaultRef}, ` +
            `and no merged PR in ${parsed.owner}/${parsed.repo} references ${issue.identifier}. ` +
            "Push the branch and deliver via deliver.sh, or set doneTransitionOverride to a " +
            "sanctioned no-deliverable-head disposition.",
          aheadBy: null,
          branch,
          defaultRef: ctx.defaultRef,
          owner: parsed.owner,
          repo: parsed.repo,
          skipped: false,
          skipReason: null,
        };
      }
      return fallback(
        `Branch ${branch} is absent from the remote; transition allowed`,
        true,
        `branch_absent_on_remote:${branch}`,
      );
    }
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
      skipReason: prSkipReason,
    };
  }

  let hasMergedPr: boolean;
  try {
    hasMergedPr = await githubBranchHasMergedPr(parsed.hostname, parsed.owner, parsed.repo, branch, token);
  } catch (err) {
    if (err instanceof GitHubAuthError) {
      return fallback(
        `GitHub merged-PR lookup rejected the credential (HTTP ${err.status}); transition allowed`,
        true,
        `auth_failed:merged_pr:${err.status}:scope=${tokenScope ?? "unknown"}:secretName=${tokenSecretName ?? "unknown"}`,
      );
    }
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
      skipReason: prSkipReason,
    };
  }

  if (decisionCarried) {
    // Same deadlock shape as the open-linked-PR block above, firing when the
    // open PR is unlinked/unhydrated: the approval that arms the merge must
    // not be blocked by the unmerged branch it is approving (SUP-13207).
    void writeAuditLog(db, issue, "issue.done_transition_guard_skipped", {
      reason: `ahead_by_no_merged_pr_decision_carried:${aheadBy}`,
      skipReason: `ahead_by_no_merged_pr_decision_carried:${aheadBy}`,
      branch,
      defaultRef: ctx.defaultRef,
      aheadBy,
    });
    return {
      allowed: true,
      reason:
        `Decision-carrying transition exempted from the ahead-of-base-without-merged-PR block: ` +
        `Branch ${branch} is ahead of ${ctx.defaultRef} by ${aheadBy} commits and has no merged PR. ` +
        "The approval arms the merge rather than closing the issue — the branch stays unmerged until the PR lands.",
      aheadBy,
      branch,
      defaultRef: ctx.defaultRef,
      owner: parsed.owner,
      repo: parsed.repo,
      skipped: false,
      skipReason: prSkipReason,
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
    skipReason: prSkipReason,
  };
}

export { writeAuditLog };
