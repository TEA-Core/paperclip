import { execFile } from "node:child_process";
import type { Db } from "@paperclipai/db";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import {
  resolveGitHubToken,
  type GitHubTokenScope,
} from "./github-credential.js";
import { logActivity } from "./activity-log.js";
import {
  fetchOpenPullRequests,
  GITHUB_GRAPHQL_URL,
  parseRepoUrl,
  resolveIssueRepoContext,
  resolveLinkedPullRequestsWithState,
  type IssueRepoContext,
  type LinkedPullRequest,
} from "./merge-arming.js";
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

function appendSkipReason(current: string | null, piece: string): string {
  return current ? `${current}; ${piece}` : piece;
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
  // baseRef is a local git ref (e.g. "origin/main", "origin/fold/tea-patches-...").
  // The GitHub compare API takes the bare remote branch name and 404s on the
  // remote-tracking prefix (SUP-13691). Strip it for this call only — the local
  // git attribution probes below keep the full ref, where it is correct.
  const compareBase =
    defaultRef.startsWith("origin/") && defaultRef.length > "origin/".length
      ? defaultRef.slice("origin/".length)
      : defaultRef;
  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(compareBase)}...${encodeURIComponent(branch)}`;
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

/**
 * Dedicated branch-existence probe for the compare API. The compare endpoint
 * 404s when either the base or the head ref is unresolvable on the remote
 * (SUP-13831), so a compare-404 is not positive evidence the head branch is
 * absent. This ref probe distinguishes the two: a 200 here proves the branch
 * exists and the compare 404 was about the base ref (or a transient API
 * state). 401/403 is classified as auth_failed with the status; every other
 * unmeasurable outcome (network failure, unexpected status) is "error" so
 * callers fail open.
 */
type BranchProbeOutcome =
  | { outcome: "present" }
  | { outcome: "absent" }
  | { outcome: "error" }
  | { outcome: "auth_failed"; status: number };

async function githubBranchExists(
  hostname: string,
  owner: string,
  repo: string,
  branch: string,
  token: string,
): Promise<BranchProbeOutcome> {
  const apiBase = gitHubApiBase(hostname);
  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo,
  )}/git/ref/heads/${encodeURIComponent(branch)}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-done-transition-guard",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };
  try {
    const response = await ghFetch(url, { headers });
    if (response.status === 401 || response.status === 403) {
      return { outcome: "auth_failed", status: response.status };
    }
    if (response.status === 404) return { outcome: "absent" };
    if (response.ok) return { outcome: "present" };
    return { outcome: "error" };
  } catch {
    return { outcome: "error" };
  }
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
 * Whether the worktree at `worktreePath` carries uncommitted content
 * (modified, staged, or untracked non-ignored files). This is the owed-diff
 * discriminator for the foreign-branch block: a clean worktree with zero
 * attributable commits and no merged PR owes no observable repo content — the
 * no-repo-deliverable shape (design/spec cards whose acceptance is a recorded
 * decision, SUP-13873). Returns null when the probe is unreachable (path
 * missing, git failure) so callers fail open instead of blocking on an
 * unmeasured signal.
 */
async function worktreeHasUncommittedContent(worktreePath: string): Promise<boolean | null> {
  try {
    const out = await runGit(["status", "--porcelain"], worktreePath);
    return out.split(/\r?\n/).some((line) => line.trim().length > 0);
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

/**
 * SUP-14429 (mechanism B): resolve the live GraphQL `reviewDecision` of an open
 * linked PR. This is the only signal that an external reviewer is currently
 * holding the PR open — an undismissed CHANGES_REQUESTED is a pre-existing,
 * externally-visible refusal, not the card observing its own merge (the
 * SUP-13207 deadlock the decision-carrying waiver exists for).
 *
 * Every unresolvable outcome — no token handled by the caller, non-2xx, GraphQL
 * errors, a null pullRequest, malformed body, transport throw — returns null.
 * Callers must treat null as "not refused" and fail open, matching the
 * `stale_open_unverifiable` precedent: never fail closed on a GitHub outage.
 */
async function fetchPullRequestReviewDecision(
  pr: LinkedPullRequest,
  token: string,
): Promise<string | null> {
  const query =
    "query prReviewDecision($owner: String!, $name: String!, $number: Int!) { " +
    "repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewDecision } } }";
  try {
    const response = await ghFetch(GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "paperclip-done-transition-guard",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query,
        variables: { owner: pr.owner, name: pr.repo, number: pr.number },
      }),
    });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return null;
    if (Array.isArray(body.errors) && body.errors.length > 0) return null;
    const repository = (body.data as Record<string, unknown> | null | undefined)?.repository as
      | Record<string, unknown>
      | null
      | undefined;
    const pullRequest = repository?.pullRequest as Record<string, unknown> | null | undefined;
    const reviewDecision = pullRequest?.reviewDecision;
    return typeof reviewDecision === "string" ? reviewDecision : null;
  } catch {
    return null;
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
      // proven again. For open PRs, resolve the review decision in the same
      // hydration pass (SUP-14429) — a PR that is not open owes no decision
      // probe, and any probe failure degrades to null (fail open).
      const reviewDecision =
        state === "open" ? await fetchPullRequestReviewDecision(pr, token) : null;
      return { ...pr, cachedState: state, lastErrorCode: null, reviewDecision };
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
    // SUP-14368: no comment and no run id means there is no evidence to verify — a
    // missing declaration, not a verified pass. The bare no-evidence allow rendered
    // "cannot verify" as "transition allowed", the fail-open exec-CTO ruled against
    // on SUP-13094. It is now treated on the same terms as any other missing
    // declaration: a 422 done_transition_missing_tier_declaration whose remedy names
    // the accepted forms (the declaration is always writable, so no close deadlocks).
    return {
      allowed: false,
      reason:
        "No accompanying comment and no run id to look up a same-run comment; no done-tier declaration found. " +
        `Accepted forms: "Closed at Tier 2 (live): <probe evidence>"` +
        ` or ` +
        `"Closed at Tier 1 (landed, not liveness-probed): <reason>. Liveness unverified."` +
        ` — per SUP-12693.`,
      tier: null,
      skipped: false,
      skipReason: null,
    };
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

/**
 * SUP-13831: live discovery of open PRs when the issue has zero cached
 * mention rows. Mention rows are only created when a comment posts a full PR
 * URL; repos that name a PR without the URL (e.g. "PR #3264") leave the
 * external-object table empty, so the cached resolver sees nothing even when
 * an open PR blocks. Ask GitHub directly for open, non-draft PRs that carry
 * the issue identifier in the head ref, title, or body — the same ownership
 * rule the live re-resolve in merge-arming uses.
 *
 * Failures never throw: they surface as `error` so the caller can count them
 * in skipReason, and the guard falls back to the cached-empty state plus the
 * compare flow below.
 */
async function liveDiscoverOpenLinkedPullRequests(
  db: Db,
  issue: { companyId: string; identifier: string | null },
  ctx: IssueRepoContext | null,
): Promise<{ prs: LinkedPullRequest[]; error: string | null }> {
  if (!issue.identifier || !ctx?.repoUrl) return { prs: [], error: null };
  const parsed = parseRepoUrl(ctx.repoUrl);
  if (!parsed) return { prs: [], error: null };

  let token: string | null;
  try {
    const tokenResult = await resolveGitHubToken(db, issue.companyId);
    token = tokenResult.token;
  } catch {
    // Token resolution failure is already counted by the main flow's own
    // token_resolution_failed / token_missing fallback; do not double-report.
    return { prs: [], error: null };
  }
  if (!token) return { prs: [], error: null };

  const listResult = await fetchOpenPullRequests(
    token,
    parsed.owner,
    parsed.repo,
    parsed.hostname,
  );
  if (!listResult.ok) {
    return {
      prs: [],
      error: listResult.status === 0 ? "network" : `HTTP${listResult.status}`,
    };
  }

  const needle = issue.identifier.toLowerCase();
  const seen = new Set<string>();
  const prs: LinkedPullRequest[] = [];
  for (const item of listResult.items) {
    if (item.draft === true) continue;
    const headRef = (item.headRef ?? "").toLowerCase();
    const title = (item.title ?? "").toLowerCase();
    const body = (item.body ?? "").toLowerCase();
    if (!headRef.includes(needle) && !title.includes(needle) && !body.includes(needle)) {
      continue;
    }
    const key = `${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}#${item.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    prs.push({
      id: `live:${key}`,
      owner: parsed.owner,
      repo: parsed.repo,
      number: item.number,
      nodeId: null,
      headRefName: item.headRef,
      title: item.title,
      displayName: `${parsed.owner}/${parsed.repo}#${item.number}`,
      cachedState: "open",
      lastErrorCode: null,
      reviewDecision: null,
    });
  }
  return { prs, error: null };
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
  let prSkipReason: string | null = null;
  let cachedCtx: IssueRepoContext | null | undefined;
  const getCtx = async (): Promise<IssueRepoContext | null> => {
    if (cachedCtx === undefined) {
      cachedCtx = await resolveIssueRepoContext(db, issue);
    }
    return cachedCtx;
  };

  let resolvedPrs = await resolveLinkedPullRequestsWithState(db, issue.companyId, issue.id);

  // SUP-13831: zero cached mention rows is a false negative when the PR was
  // never posted with its full URL. Live-discover open PRs carrying the issue
  // identifier; failures are counted in skipReason and the compare flow below
  // still applies.
  if (resolvedPrs.length === 0) {
    let live: { prs: LinkedPullRequest[]; error: string | null } = { prs: [], error: null };
    try {
      const liveCtx = await getCtx();
      live = await liveDiscoverOpenLinkedPullRequests(db, issue, liveCtx);
    } catch {
      live = { prs: [], error: "ctx" };
    }
    if (live.prs.length > 0) {
      resolvedPrs = live.prs;
      prSkipReason = appendSkipReason(prSkipReason, `live_linked_pr_discovered:${live.prs.length}`);
    } else if (live.error !== null) {
      prSkipReason = appendSkipReason(prSkipReason, `live_pr_discovery_failed:${live.error}`);
    }
  }

  // Best-effort synchronous hydration: attempt to fetch current state from GitHub for
  // any unhydrated (cachedState === null) rows and any cached-"open" rows. A cached
  // "open" is positive proof only as of the last successful refresh; a PR merged
  // since then (e.g. the merge→sweep-rehydration window) must not block `done` on
  // stale state. A thrown/failed hydration must NOT throw — degrade to the cached
  // state. We only hydrate if a company token is available; if token resolution
  // itself fails, we keep the cached states as-is.
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
      // SUP-14429 (mechanism B): narrow the D6 waiver to what it actually covers.
      // An open linked PR held by an undismissed external CHANGES_REQUESTED review
      // is a pre-existing, externally-visible refusal — it is NOT the card
      // observing its own merge (the SUP-13207 deadlock the waiver below exists
      // for). Waiving it would close the card done over a PR that can never merge
      // and arm a merge against a head that will not land, leaving the PR open
      // forever with no trace on the issue. Only a live GraphQL reviewDecision of
      // exactly CHANGES_REQUESTED refuses; every other outcome (APPROVED,
      // REVIEW_REQUIRED, null — including "could not be resolved") keeps the
      // waiver, per the fail-open-on-unknown contract (SUP-14429 AC4).
      const refused = openPrs.filter((p) => p.reviewDecision === "CHANGES_REQUESTED");
      if (refused.length > 0) {
        const refusalToken = `open_linked_prs_changes_requested:${refused.length}`;
        const refusedNames = refused.map((p) => p.displayName).join(", ");
        void writeAuditLog(db, issue, "issue.done_transition_guard_skipped", {
          reason: refusalToken,
          skipReason: refusalToken,
          prs: refusedNames,
        });
        return {
          allowed: false,
          reason:
            `Issue has ${refused.length} open linked PR${refused.length === 1 ? "" : "s"} ` +
            `held unmergeable by an undismissed external CHANGES_REQUESTED review (${refusedNames}). ` +
            "Dismiss or resolve the external review and re-approve, or set doneTransitionOverride to a " +
            `sanctioned no-deliverable-head disposition (${[...NO_DELIVERABLE_HEAD_DISPOSITIONS].join(" / ")}). ` +
            "The decision-carrying carve-out does not waive a PR an external reviewer is refusing.",
          aheadBy: null,
          branch: null,
          defaultRef: null,
          owner: null,
          repo: null,
          skipped: false,
          skipReason: refusalToken,
        };
      }
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

  const ctx = await getCtx();
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
      //
      // A compare 404 is ambiguous (SUP-13831): it fires when the BASE ref is
      // unresolvable on the remote just as it does when the head branch is
      // absent. Probe the head ref directly before classifying the 404.
      const probe = await githubBranchExists(
        parsed.hostname,
        parsed.owner,
        parsed.repo,
        branch,
        token,
      );
      if (probe.outcome === "auth_failed") {
        return fallback(
          `GitHub ref probe rejected the credential (HTTP ${probe.status}); transition allowed`,
          true,
          `auth_failed:branch_probe:${probe.status}`,
        );
      }
      if (probe.outcome === "error") {
        return fallback(
          `Branch ${branch} ref probe could not be measured; transition allowed`,
          true,
          `branch_probe_failed:${branch}`,
        );
      }
      if (probe.outcome === "present") {
        // The head ref exists on the remote: the compare 404 was about the base
        // ref (unresolvable/stale on the remote) or a transient API state, not
        // the deliverable branch. Never report this as branch-absent.
        if (decisionCarried) {
          void writeAuditLog(db, issue, "issue.done_transition_guard_skipped", {
            reason: `compare_404_base_ref_unresolvable_decision_carried:${branch}`,
            skipReason: prSkipReason,
            branch,
            defaultRef: ctx.defaultRef,
            owner: parsed.owner,
            repo: parsed.repo,
          });
          return {
            allowed: true,
            reason:
              `Decision-carrying transition allowed: compare 404 for branch ${branch} but the branch exists on the remote ` +
              `(the base ref ${ctx.defaultRef} could not be resolved on the remote). ` +
              "The approval arms the merge rather than closing the issue — the branch lands with delivery.",
            aheadBy: null,
            branch,
            defaultRef: ctx.defaultRef,
            owner: parsed.owner,
            repo: parsed.repo,
            skipped: false,
            skipReason: prSkipReason,
          };
        }
        return fallback(
          `Branch ${branch} exists on the remote; the compare 404 indicates the base ref ${ctx.defaultRef} could not be resolved on the remote. Transition allowed`,
          true,
          `compare_404_base_ref_unresolvable:${branch}`,
        );
      }
      // probe.outcome === "absent": the dedicated ref probe confirms the branch
      // is genuinely absent from the remote. Existing attribution logic below.
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
        if (decisionCarried) {
          // Defense-in-depth (SUP-13691): a 404 here means the branch was not
          // pushed (or the base ref did not resolve on the remote). The review
          // approval that arms the merge must not be blocked by the unpushed
          // branch it is approving (SUP-13207/13290 precedent); a plain close
          // still lands the deliverable first.
          void writeAuditLog(db, issue, "issue.done_transition_guard_skipped", {
            reason: `branch_absent_decision_carried:${branch}`,
            skipReason: `branch_absent_decision_carried:${branch}`,
            branch,
            defaultRef: ctx.defaultRef,
            owner: parsed.owner,
            repo: parsed.repo,
            aheadCount: attribution.aheadCount,
            attributableCommitCount: attribution.attributableCount,
            mergedPrCount,
          });
          return {
            allowed: true,
            reason:
              `Decision-carrying transition exempted from the branch-absent-on-remote block: ` +
              `Branch ${branch} is absent from the remote while the execution workspace carries ` +
              `${attribution.attributableCount} commit${attribution.attributableCount === 1 ? "" : "s"} attributable to ` +
              `${issue.identifier} and no merged PR references it. ` +
              "The approval arms the merge rather than closing the issue — the branch lands with delivery.",
            aheadBy: null,
            branch,
            defaultRef: ctx.defaultRef,
            owner: parsed.owner,
            repo: parsed.repo,
            skipped: false,
            skipReason: prSkipReason,
          };
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

  const identifier = issue.identifier;
  const branchReferencesIdentifier =
    identifier !== null && branch.toLowerCase().includes(identifier.toLowerCase());

  // SUP-13337: when the workspace branch does not reference the issue identifier, it
  // may belong to a different issue (shared/inherited worktrees, merge-X cards,
  // corrective children on a parent branch). The branch's own ahead/merged state is
  // then somebody else's delivery — it must not pass or fail THIS issue. Decide on
  // identifier-attributed commits and identifier-referencing merged PRs instead,
  // reusing the #294 helpers. Every such evaluation, allowed or blocked, records
  // `foreign_workspace_branch:<branch>:<identifier>` in skipReason so it is countable.
  if (identifier !== null && !branchReferencesIdentifier) {
    const foreignToken = `foreign_workspace_branch:${branch}:${identifier}`;
    const attribution = ctx.worktreePath
      ? await countIssueAttributableCommits(ctx.worktreePath, ctx.defaultRef, identifier)
      : null;
    const attributableCount = attribution?.attributableCount ?? 0;

    if (attributableCount > 0) {
      return {
        allowed: true,
        reason:
          `Branch ${branch} does not reference ${identifier} (foreign/workspace-shared branch), ` +
          `but ${attributableCount} commit${attributableCount === 1 ? "" : "s"} on it are attributable to ${identifier}; transition allowed`,
        aheadBy,
        branch,
        defaultRef: ctx.defaultRef,
        owner: parsed.owner,
        repo: parsed.repo,
        skipped: false,
        skipReason: appendSkipReason(prSkipReason, foreignToken),
      };
    }

    if (decisionCarried) {
      // Same deadlock shape as the open-linked-PR block above, firing when the
      // open PR is unlinked/unhydrated: the approval that arms the merge must
      // not be blocked by the unmerged branch it is approving (SUP-13207).
      void writeAuditLog(db, issue, "issue.done_transition_guard_skipped", {
        reason: `ahead_by_no_merged_pr_decision_carried:${aheadBy}`,
        skipReason: appendSkipReason(
          foreignToken,
          `ahead_by_no_merged_pr_decision_carried:${aheadBy}`,
        ),
        branch,
        defaultRef: ctx.defaultRef,
        aheadBy,
      });
      return {
        allowed: true,
        reason:
          `Decision-carrying transition exempted from the ahead-of-base-without-merged-PR block: ` +
          `Branch ${branch} is ahead of ${ctx.defaultRef} by ${aheadBy} commits, does not reference ` +
          `${identifier} (foreign/workspace-shared branch), and carries no commit attributable to ${identifier}. ` +
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

    const mergedPrCount = await githubMergedPrCountForIdentifier(
      parsed.hostname,
      parsed.owner,
      parsed.repo,
      identifier,
      token,
    );

    if (mergedPrCount !== null && mergedPrCount > 0) {
      return {
        allowed: true,
        reason:
          `Branch ${branch} does not reference ${identifier} (foreign/workspace-shared branch), ` +
          `but ${mergedPrCount} merged PR${mergedPrCount === 1 ? "" : "s"} reference${mergedPrCount === 1 ? "s" : ""} ${identifier} (carrier delivery); transition allowed`,
        aheadBy,
        branch,
        defaultRef: ctx.defaultRef,
        owner: parsed.owner,
        repo: parsed.repo,
        skipped: false,
        skipReason: appendSkipReason(prSkipReason, foreignToken),
      };
    }

    if (attribution === null || mergedPrCount === null) {
      const unmeasured = attribution === null ? "attribution" : "merged_pr";
      return fallback(
        `Branch ${branch} does not reference ${identifier} (foreign/workspace-shared branch) ` +
          `and the attribution probe could not be fully measured (${unmeasured}); transition allowed`,
        true,
        appendSkipReason(foreignToken, `foreign_workspace_branch_probe_failed:${unmeasured}`),
      );
    }

    // SUP-13873: with attribution and merged-PR probes both measured at zero,
    // the branch still owes no observable repo content only when the issue's
    // worktree itself is clean. A design/spec card whose acceptance is a
    // recorded decision (a done-tier disposition, SUP-12693) leaves no
    // attributable commit, no merged PR, and no uncommitted work — that is the
    // sanctioned no-repo-deliverable close. A dirty worktree means content
    // exists that was never delivered: keep the block and name the owed step.
    const uncommitted = ctx.worktreePath
      ? await worktreeHasUncommittedContent(ctx.worktreePath)
      : null;
    if (uncommitted === null) {
      return fallback(
        `Branch ${branch} does not reference ${identifier} (foreign/workspace-shared branch) ` +
          `and the worktree status probe could not be measured; transition allowed`,
        true,
        appendSkipReason(foreignToken, "foreign_workspace_branch_status_probe_failed"),
      );
    }
    if (!uncommitted) {
      return {
        allowed: true,
        reason:
          `Branch ${branch} does not reference ${identifier} (foreign/workspace-shared branch); ` +
          `no commit on it is attributable to ${identifier}, no merged PR references ${identifier}, ` +
          "and the issue's worktree is clean — no repo deliverable is owed. " +
          "This is the sanctioned no-repo-deliverable close; the done-tier disposition " +
          "records the outcome.",
        aheadBy,
        branch,
        defaultRef: ctx.defaultRef,
        owner: parsed.owner,
        repo: parsed.repo,
        skipped: false,
        skipReason: appendSkipReason(
          foreignToken,
          `no_repo_deliverable_clean_worktree:${identifier}`,
        ),
      };
    }

    void writeAuditLog(db, issue, "issue.done_transition_guard_skipped", {
      reason: "foreign_workspace_branch",
      skipReason: foreignToken,
      branch,
      defaultRef: ctx.defaultRef,
      owner: parsed.owner,
      repo: parsed.repo,
      aheadBy,
      attributableCommitCount: attribution.attributableCount,
      mergedPrCount,
      worktreeDirty: true,
    });
    return {
      allowed: false,
      reason:
        `Branch ${branch} is ahead of ${ctx.defaultRef} by ${aheadBy} commits and does not reference ` +
        `${identifier} (foreign/workspace-shared branch); no commit on it is attributable to ` +
        `${identifier} and no merged PR references ${identifier}, but the issue's worktree holds ` +
        "uncommitted work that was never delivered. Deliver that work via its own branch and " +
        "deliver.sh (or record the disposition, e.g. as a design/spec card whose acceptance is a " +
        "done-tier decision) before marking the issue done.",
      aheadBy,
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
