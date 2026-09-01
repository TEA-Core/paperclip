import type { Db } from "@paperclipai/db";
import { and, eq, ilike } from "drizzle-orm";
import {
  externalObjectMentions,
  externalObjects,
  issues,
  executionWorkspaces,
  projectWorkspaces,
} from "@paperclipai/db";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import {
  isGitHubTokenResolution,
  resolveGitHubTokenCandidatesForRepo,
  resolveGitHubTokenForRepo,
  type GitHubTokenResolution,
} from "./github-credential.js";

export {
  isGitHubTokenResolution,
  resolveGitHubTokenCandidatesForRepo,
  resolveGitHubTokenForRepo,
  type GitHubTokenResolution,
  type GitHubTokenResolutionFailure,
  type GitHubTokenResult,
  type GitHubTokenScope,
} from "./github-credential.js";

export interface MergeArmingDecision {
  stageId: string;
  stageType: string;
  outcome: string;
  body: string;
}

export function shouldPublishApprovalStatus<T extends Pick<MergeArmingDecision, "outcome">>(
  decision: T | null | undefined,
): decision is T {
  return decision != null && decision.outcome === "approved";
}

export interface ArmingOutcome {
  kind: "armed" | "skipped" | "failed";
  message: string;
  /**
   * The PR head SHA the paperclip/approved status was written to, when known
   * (armed). The approval transition persists this so the reconciler can later
   * verify content identity before any re-publish (SUP-13714 Guard A).
   */
  headSha?: string | null;
}

export interface LinkedPullRequest {
  id: string;
  owner: string;
  repo: string;
  number: number;
  nodeId: string | null;
  headRefName: string | null;
  displayName: string;
  /**
   * The PR title as recorded on the cached external-object payload, or null
   * when the object has never been hydrated from the provider. Shared-branch
   * child PRs carry the approving card's identifier in the title rather than
   * the branch name (SUP-13361), so title-OR-branch ownership matches over
   * this field. Stale cached rows without a title rehydrate on TTL.
   */
  title: string | null;
  /**
   * The `state` recorded on the cached external-object payload, or null when the
   * object has never been hydrated from the provider. Callers that need positive
   * evidence a PR is open (rather than "not known to be closed") must check for
   * the literal "open" — an unhydrated row carries null, not "open".
   */
  cachedState: string | null;
  /**
   * The error code persisted by the last failed refresh of the external object
   * (e.g. "github_auth_required" when the refresh 401'd under a missing company
   * token), or null when the last refresh succeeded. A cached "open" whose last
   * refresh errored "github_auth_required" could not be re-verified and is not
   * positively proven open (SUP-13234).
   */
  lastErrorCode: string | null;
  /**
   * The live GraphQL `reviewDecision` of the PR, resolved during hydration for
   * open PRs (e.g. "CHANGES_REQUESTED", "APPROVED", "REVIEW_REQUIRED"), or null
   * when it could not be resolved (no token, non-2xx, network failure, PR not
   * fetchable). Callers must fail open on null: an unresolvable decision is an
   * unknown, not a refusal (SUP-14429).
   */
  reviewDecision: string | null;
}

export interface IssueRepoContext {
  branch: string | null;
  defaultRef: string | null;
  repoUrl: string | null;
  providerType: string | null;
  worktreePath: string | null;
}

export function parseRepoUrl(repoUrl: string | null): { hostname: string; owner: string; repo: string } | null {
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

export async function resolveIssueRepoContext(
  db: Db,
  issue: {
    companyId: string;
    projectId: string | null;
    projectWorkspaceId: string | null;
    executionWorkspaceId: string | null;
  },
): Promise<IssueRepoContext | null> {
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

export const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

export async function resolveLinkedPullRequests(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<LinkedPullRequest[]> {
  const rows = await db
    .select({
      id: externalObjects.id,
      externalId: externalObjects.externalId,
      sanitizedCanonicalUrl: externalObjects.sanitizedCanonicalUrl,
      data: externalObjects.data,
      lastErrorCode: externalObjects.lastErrorCode,
    })
    .from(externalObjectMentions)
    .innerJoin(externalObjects, eq(externalObjects.id, externalObjectMentions.objectId))
    .where(
      and(
        eq(externalObjectMentions.companyId, companyId),
        eq(externalObjectMentions.sourceIssueId, issueId),
        eq(externalObjectMentions.objectType, "pull_request"),
        eq(externalObjects.providerKey, "github"),
      ),
    );

  const results: LinkedPullRequest[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const state = row.data?.state as string | undefined;
    const draft = row.data?.draft as boolean | undefined;
    if (draft === true) continue;
    if (state !== undefined && state !== "open") continue;

    const match = /^([^/]+)\/([^/]+)#(pull|issues)\/([1-9][0-9]*)$/.exec(row.externalId);
    if (!match) continue;

    const owner = match[1]!;
    const repo = match[2]!;
    const number = Number(match[4]);
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const nodeId = row.data?.node_id as string | undefined | null;
    const headRefName =
      (row.data?.head as Record<string, unknown> | undefined | null)?.ref as string | undefined ??
      (row.data?.headRefName as string | undefined);

      results.push({
        id: row.id,
        owner,
        repo,
        number,
        nodeId: nodeId ?? null,
        headRefName: headRefName ?? null,
        title: (row.data?.title as string | undefined) ?? null,
        displayName: `${owner}/${repo}#${number}`,
        cachedState: state ?? null,
        lastErrorCode: row.lastErrorCode ?? null,
        reviewDecision: null,
      });
  }

  return results;
}

export async function resolveLinkedPullRequestsWithState(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<LinkedPullRequest[]> {
  const rows = await db
    .select({
      id: externalObjects.id,
      externalId: externalObjects.externalId,
      sanitizedCanonicalUrl: externalObjects.sanitizedCanonicalUrl,
      data: externalObjects.data,
      lastErrorCode: externalObjects.lastErrorCode,
    })
    .from(externalObjectMentions)
    .innerJoin(externalObjects, eq(externalObjects.id, externalObjectMentions.objectId))
    .where(
      and(
        eq(externalObjectMentions.companyId, companyId),
        eq(externalObjectMentions.sourceIssueId, issueId),
        eq(externalObjectMentions.objectType, "pull_request"),
        eq(externalObjects.providerKey, "github"),
      ),
    );

  const results: LinkedPullRequest[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const state = row.data?.state as string | undefined;
    const draft = row.data?.draft as boolean | undefined;
    if (draft === true) continue;

    const match = /^([^/]+)\/([^/]+)#(pull|issues)\/([1-9][0-9]*)$/.exec(row.externalId);
    if (!match) continue;

    const owner = match[1]!;
    const repo = match[2]!;
    const number = Number(match[4]);
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const nodeId = row.data?.node_id as string | undefined | null;
    const headRefName =
      (row.data?.head as Record<string, unknown> | undefined | null)?.ref as string | undefined ??
      (row.data?.headRefName as string | undefined);

      results.push({
        id: row.id,
        owner,
        repo,
        number,
        nodeId: nodeId ?? null,
        headRefName: headRefName ?? null,
        title: (row.data?.title as string | undefined) ?? null,
        displayName: `${owner}/${repo}#${number}`,
        cachedState: state ?? null,
        lastErrorCode: row.lastErrorCode ?? null,
        reviewDecision: null,
      });
  }

  return results;
}

export interface GitHubFetchResult {
  ok: boolean;
  status: number;
  message: string | null;
}

export interface GitHubNodeIdResult extends GitHubFetchResult {
  nodeId: string | null;
}

/**
 * Resolves a pull request's GraphQL node id via the REST pulls endpoint.
 * Exported so the carrier promotion sweep can fall back to it when a cached
 * external object row has no node id.
 */
export async function fetchGitHubNodeId(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<GitHubNodeIdResult> {
  const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-merge-arming",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };

  let response: Response;
  try {
    response = await ghFetch(url, { headers });
  } catch {
    return { ok: false, status: 0, message: "network_error", nodeId: null };
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const message = body?.message as string | undefined;
    return { ok: false, status: response.status, message: message ?? null, nodeId: null };
  }

  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return { ok: false, status: response.status, message: "empty_response", nodeId: null };

  const nodeId = typeof body.node_id === "string" ? body.node_id : null;
  return { ok: true, status: response.status, message: null, nodeId };
}

async function enableAutoMerge(
  token: string,
  nodeId: string,
): Promise<{ success: boolean; alreadyQueued: boolean; error: string | null; status: number }> {
  const query = `mutation { enablePullRequestAutoMerge(input: { pullRequestId: "${nodeId}" }) { clientMutationId } }`;

  try {
    const response = await ghFetch(GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      const errors = body?.errors as Array<{ message?: string }> | undefined;
      const firstError = errors?.[0]?.message ?? "";
      if (firstError.toLowerCase().includes("already") && firstError.toLowerCase().includes("merge")) {
        return { success: true, alreadyQueued: true, error: null, status: response.status };
      }
      return { success: false, alreadyQueued: false, error: firstError || `HTTP ${response.status}`, status: response.status };
    }

    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const errors = body?.errors as Array<{ message?: string }> | undefined;
    if (errors && errors.length > 0) {
      const firstError = errors[0]?.message ?? "";
      if (firstError.toLowerCase().includes("already") && firstError.toLowerCase().includes("merge")) {
        return { success: true, alreadyQueued: true, error: null, status: response.status };
      }
      return { success: false, alreadyQueued: false, error: firstError, status: response.status };
    }

    return { success: true, alreadyQueued: false, error: null, status: response.status };
  } catch {
    return { success: false, alreadyQueued: false, error: "network_error", status: 0 };
  }
}

export interface MarkPullRequestReadyForReviewResult {
  success: boolean;
  alreadyReady: boolean;
  error: string | null;
  status: number;
}

/**
 * PR-CARRIER-3: flip a draft carrier PR to ready-for-review. Same GraphQL
 * transport, URL and bearer-token handling as `enableAutoMerge`. A PR that is
 * already ready counts as success (GitHub rejects the mutation with
 * "Pull request is not a draft"), mirroring the already-queued path.
 */
export async function markPullRequestReadyForReview(
  token: string,
  nodeId: string,
): Promise<MarkPullRequestReadyForReviewResult> {
  const query = `mutation { markPullRequestReadyForReview(input: { pullRequestId: "${nodeId}" }) { clientMutationId } }`;

  try {
    const response = await ghFetch(GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      const errors = body?.errors as Array<{ message?: string }> | undefined;
      const firstError = errors?.[0]?.message ?? "";
      if (firstError.toLowerCase().includes("not a draft")) {
        return { success: true, alreadyReady: true, error: null, status: response.status };
      }
      return { success: false, alreadyReady: false, error: firstError || `HTTP ${response.status}`, status: response.status };
    }

    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const errors = body?.errors as Array<{ message?: string }> | undefined;
    if (errors && errors.length > 0) {
      const firstError = errors[0]?.message ?? "";
      if (firstError.toLowerCase().includes("not a draft")) {
        return { success: true, alreadyReady: true, error: null, status: response.status };
      }
      return { success: false, alreadyReady: false, error: firstError, status: response.status };
    }

    return { success: true, alreadyReady: false, error: null, status: response.status };
  } catch {
    return { success: false, alreadyReady: false, error: "network_error", status: 0 };
  }
}

export interface PublishApprovalStatusOptions {
  /**
   * SUP-13714 TOCTOU pin. When set, the live head re-resolved just before the
   * write MUST equal this SHA or the publish is refused (`skipped`, head_moved)
   * with zero writes. The reconciler passes the head it validated with Guard A
   * so a head that moves between validation and the delegated write is never
   * stamped.
   */
  expectedHeadSha?: string;
  /**
   * SUP-13831: the zero-mention-row live-discovery fallback (derive the repo
   * pair from the issue's own workspace context and ask GitHub for open PRs)
   * is a delivery probe. It runs only for a CLOSING transition — a requested
   * `done` that resolves to `done`. A stage approval that the policy redirects
   * to a later stage (`in_review`) must make no delivery probe at all, so
   * callers passing `closingTransition: false` skip the fallback and keep the
   * no-PR outcome a plain negative. Defaults to true for callers acting on
   * already-closed cards (the approval-status reconciler).
   */
  closingTransition?: boolean;
  /**
   * ADR-091 D1 (SUP-14676): enforce the delivery-identity gate at the
   * authorization site. When true, the authorizing candidate set is narrowed to
   * PRs this card actually delivered — the PR's head repo is the card's project
   * repo AND the PR's head ref equals the card's own execution-workspace
   * delivery branch — before the length arithmetic. A card that merely CITES a
   * PR (a bare PR URL in the title/description/comment/document creates the
   * mention row) it did not deliver is refused, not stamped. Unresolvable
   * delivery identity fails closed (ADR-091 D4). Callers that already certify
   * the head by another mechanism — the approval-status reconciler's Guard A
   * re-publish — leave this unset so their delegated write is unchanged.
   */
  enforceDeliveryIdentity?: boolean;
}

/**
 * ADR-091 D1 (SUP-14676): the card's own delivery identity — the repo it was
 * assigned and the branch it delivered on. Both the cached-mention path and the
 * SUP-13313/SUP-13831 live-discovery path authorize against this, so it is
 * resolved through one helper: a gate that only covers one of the two stamp
 * paths is not a gate.
 */
async function resolveDeliveryIdentity(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<{ branch: string | null; repo: { owner: string; repo: string } | null }> {
  const [issueRow] = await db
    .select({
      projectId: issues.projectId,
      projectWorkspaceId: issues.projectWorkspaceId,
      executionWorkspaceId: issues.executionWorkspaceId,
    })
    .from(issues)
    .where(eq(issues.id, issueId));
  const ctx = await resolveIssueRepoContext(db, {
    companyId,
    projectId: issueRow?.projectId ?? null,
    projectWorkspaceId: issueRow?.projectWorkspaceId ?? null,
    executionWorkspaceId: issueRow?.executionWorkspaceId ?? null,
  });
  return {
    branch: ctx?.branch ?? null,
    repo: ctx?.repoUrl ? parseRepoUrl(ctx.repoUrl) : null,
  };
}

/** ADR-091 D4: the fail-closed refusal when delivery identity is unresolvable. */
function deliveryIdentityUnresolvedOutcome(branch: string | null): ArmingOutcome {
  const missing = !branch
    ? "no delivery branch recorded on this card's execution workspace"
    : "no delivery repo resolvable for this card's execution workspace";
  return {
    kind: "skipped",
    message: `status:skipped:delivery_identity_unresolved: ${missing}; refusing to stamp a PR this card cannot be proven to have delivered (ADR-091 D4, fail closed)`,
  };
}

/** True when the PR's head repo AND head ref are this card's delivery identity. */
function isDeliveredByCard(
  pr: { owner: string; repo: string; headRefName: string | null },
  deliveryRepo: { owner: string; repo: string },
  deliveryBranch: string,
): boolean {
  if (pr.owner.toLowerCase() !== deliveryRepo.owner.toLowerCase()) return false;
  if (pr.repo.toLowerCase() !== deliveryRepo.repo.toLowerCase()) return false;
  return pr.headRefName !== null && pr.headRefName.toLowerCase() === deliveryBranch.toLowerCase();
}

/** The named `not_delivered` refusal, listing every candidate that failed the gate. */
function notDeliveredOutcome(
  rejected: Array<{ displayName: string; owner: string; repo: string; headRefName: string | null }>,
  deliveryBranch: string,
): ArmingOutcome {
  const failed = rejected
    .map(
      (pr) =>
        `${pr.displayName} head ${pr.owner}/${pr.repo}:${pr.headRefName ?? "(unreadable)"} is not this card's delivery branch ${deliveryBranch}`,
    )
    .join("; ");
  return { kind: "skipped", message: `status:skipped:not_delivered: ${failed}` };
}

export async function publishApprovalStatus(
  db: Db,
  companyId: string,
  issueId: string,
  issueIdentifier: string,
  options?: PublishApprovalStatusOptions,
): Promise<ArmingOutcome> {
  const linkedPRs = await resolveLinkedPullRequests(db, companyId, issueId);

  // ADR-091 D1 (SUP-14676): delivery-identity gate. A mention row is created by
  // prose — a bare PR URL in the card's title/description/comment/document — so
  // selecting candidates by sourceIssueId alone lets any card that merely CITES
  // a PR stamp it. Narrow the authorizing candidate set to PRs this card actually
  // delivered (the head repo is the card's project repo AND the head ref equals
  // the card's own execution-workspace delivery branch), dropping non-delivered
  // candidates BEFORE the length arithmetic. Opt-in: the approval-status
  // reconciler's Guard A re-publish certifies the head by content identity and
  // leaves enforceDeliveryIdentity unset.
  let authorizingPRs = linkedPRs;
  if (options?.enforceDeliveryIdentity && linkedPRs.length > 0) {
    const { branch: deliveryBranch, repo: deliveryRepo } = await resolveDeliveryIdentity(
      db,
      companyId,
      issueId,
    );

    // ADR-091 D4: fail closed when the card's delivery identity cannot be
    // positively resolved — refuse to stamp on an unverified branch.
    if (!deliveryBranch || !deliveryRepo) {
      return deliveryIdentityUnresolvedOutcome(deliveryBranch);
    }

    const delivered = linkedPRs.filter((pr) => isDeliveredByCard(pr, deliveryRepo, deliveryBranch));
    if (delivered.length === 0) {
      return notDeliveredOutcome(linkedPRs, deliveryBranch);
    }

    authorizingPRs = delivered;
  }

  if (linkedPRs.length === 0) {
    // SUP-13313: an empty cached open-PR set means "the PR I know about is
    // stale", not "this issue has no PR". Ask GitHub for open, non-draft PRs
    // that carry the issue identifier before giving up.
    const withState = await resolveLinkedPullRequestsWithState(db, companyId, issueId);

    const pairs: Array<{ owner: string; repo: string }> = [];
    const seenPairs = new Set<string>();
    for (const row of withState) {
      const key = `${row.owner.toLowerCase()}/${row.repo.toLowerCase()}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      pairs.push({ owner: row.owner, repo: row.repo });
    }

    if (pairs.length === 0 && (options?.closingTransition ?? true)) {
      // SUP-13831: zero cached mention rows (the PR was never posted with its
      // full URL in-thread) leave the live re-resolve with no owner/repo pair
      // to ask GitHub. Derive one from the issue's own repo context instead of
      // giving up with skipped:no-pr. This is a delivery probe, so it runs
      // only for closing transitions (closingTransition); a stage approval
      // that advances to a LATER stage must make no delivery probe at all.
      const [issueRow] = await db
        .select({
          projectId: issues.projectId,
          projectWorkspaceId: issues.projectWorkspaceId,
          executionWorkspaceId: issues.executionWorkspaceId,
        })
        .from(issues)
        .where(eq(issues.id, issueId));
      const ctx = await resolveIssueRepoContext(db, {
        companyId,
        projectId: issueRow?.projectId ?? null,
        projectWorkspaceId: issueRow?.projectWorkspaceId ?? null,
        executionWorkspaceId: issueRow?.executionWorkspaceId ?? null,
      });
      const parsed = ctx?.repoUrl ? parseRepoUrl(ctx.repoUrl) : null;
      if (parsed) {
        pairs.push({ owner: parsed.owner, repo: parsed.repo });
      }
    }

    let matched: Array<{
      owner: string;
      repo: string;
      number: number;
      displayName: string;
      headRefName: string | null;
      candidate: GitHubTokenResolution;
    }> = [];
    const needle = issueIdentifier.toLowerCase();

    for (const pair of pairs) {
      const candidates = await resolveGitHubTokenCandidatesForRepo(db, companyId, pair.owner, pair.repo);
      if (candidates.length === 0) {
        const tokenResult = await resolveGitHubTokenForRepo(db, companyId, pair.owner, pair.repo);
        if (!isGitHubTokenResolution(tokenResult)) {
          return {
            kind: "failed",
            message: `status:failed:auth_required: ${tokenResult.reason} (scope=null, secretName=null)`,
          };
        }
        return {
          kind: "failed",
          message: `status:failed:auth_required: No GitHub token resolvable for ${pair.owner}/${pair.repo} (scope=null, secretName=null)`,
        };
      }

      for (const candidate of candidates) {
        const listResult = await fetchOpenPullRequests(candidate.token, pair.owner, pair.repo);
        if (!listResult.ok) {
          const { status, message } = listResult;
          if (status === 401 || status === 403) {
            if (candidate === candidates[candidates.length - 1]) {
              if (candidates.length === 1) {
                return {
                  kind: "failed",
                  message: `status:failed:pr_auth: HTTP ${status} ${message ?? ""} (scope=${candidate.scope}, secretName=${candidate.secretName})`,
                };
              }
              const tried = candidates.map((c) => `${c.scope}/${c.secretName}`).join(", ");
              return {
                kind: "failed",
                message: `status:failed:pr_auth: HTTP ${status} ${message ?? ""} (tried: ${tried})`,
              };
            }
            continue;
          }
          if (status === 404) {
            return { kind: "failed", message: `status:failed:pr_not_found: HTTP 404 ${message ?? ""}` };
          }
          if (status === 429) {
            return { kind: "failed", message: `status:failed:pr_rate_limited: HTTP 429 ${message ?? ""}` };
          }
          if (status === 0) {
            return { kind: "failed", message: `status:failed:pr_network: ${message ?? "network_error"}` };
          }
          return { kind: "failed", message: `status:failed:pr_error: HTTP ${status} ${message ?? ""}` };
        }

        for (const item of listResult.items) {
          if (item.draft === true) continue;
          const headRef = (item.headRef ?? "").toLowerCase();
          const title = (item.title ?? "").toLowerCase();
          const body = (item.body ?? "").toLowerCase();
          if (!headRef.includes(needle) && !title.includes(needle) && !body.includes(needle)) continue;
          matched.push({
            owner: pair.owner,
            repo: pair.repo,
            number: item.number,
            displayName: `${pair.owner}/${pair.repo}#${item.number}`,
            headRefName: item.headRef ?? null,
            candidate,
          });
        }
        break;
      }
    }

    // ADR-091 D1 (SUP-14676): the live-discovery candidates above are matched by
    // identifier SUBSTRING on head ref / title / body — pure citation. They are
    // authorizing candidates just like the cached mentions, so they take the same
    // delivery-identity gate, applied BEFORE the length arithmetic. Without this a
    // card with zero cached mentions could stamp any open PR whose prose merely
    // names it — the exact failure D1 exists to kill. A card that delivered its own
    // PR has head ref === its delivery branch, so the SUP-13313 happy path stands.
    if (options?.enforceDeliveryIdentity && matched.length > 0) {
      const { branch: deliveryBranch, repo: deliveryRepo } = await resolveDeliveryIdentity(
        db,
        companyId,
        issueId,
      );
      // ADR-091 D4: no branch (or no repo) recorded → refuse, never fall back to
      // identifier-substring authorization.
      if (!deliveryBranch || !deliveryRepo) {
        return deliveryIdentityUnresolvedOutcome(deliveryBranch);
      }
      const delivered = matched.filter((pr) => isDeliveredByCard(pr, deliveryRepo, deliveryBranch));
      if (delivered.length === 0) {
        return notDeliveredOutcome(matched, deliveryBranch);
      }
      matched = delivered;
    }

    if (matched.length > 1) {
      const prList = matched.map((pr) => pr.displayName).join(", ");
      return {
        kind: "skipped",
        message: `status:skipped:ambiguous: Multiple linked PRs (${matched.length}): ${prList}`,
      };
    }

    if (matched.length === 1) {
      const pr = matched[0]!;
      const headShaResult = await fetchPullRequestHeadSha(pr.candidate.token, pr.owner, pr.repo, pr.number);
      if (!headShaResult.ok) {
        const { status, message } = headShaResult;
        if (status === 401 || status === 403) {
          return {
            kind: "failed",
            message: `status:failed:pr_auth: HTTP ${status} ${message ?? ""} (scope=${pr.candidate.scope}, secretName=${pr.candidate.secretName})`,
          };
        }
        if (status === 404) {
          return { kind: "failed", message: `status:failed:pr_not_found: HTTP 404 ${message ?? ""}` };
        }
        if (status === 429) {
          return { kind: "failed", message: `status:failed:pr_rate_limited: HTTP 429 ${message ?? ""}` };
        }
        if (status === 0) {
          return { kind: "failed", message: `status:failed:pr_network: ${message ?? "network_error"}` };
        }
        return { kind: "failed", message: `status:failed:pr_error: HTTP ${status} ${message ?? ""}` };
      }

      const headSha = headShaResult.headSha;
      if (options?.expectedHeadSha && headSha !== options.expectedHeadSha) {
        return {
          kind: "skipped",
          message: `status:skipped:head_moved: ${pr.displayName} head moved to ${headSha.slice(0, 7)} after content-identity validation (expected ${options.expectedHeadSha.slice(0, 7)}); not re-stamped`,
          headSha,
        };
      }
      const result = await writeCommitStatus(pr.candidate.token, pr.owner, pr.repo, headSha, issueIdentifier);
      if (result.success) {
        return {
          kind: "armed",
          message: `status:published (live re-resolve): paperclip/approved status written to ${pr.displayName} head ${headSha.slice(0, 7)}`,
          headSha,
        };
      }

      const safeError = result.error ?? "unknown_error";
      const truncated = safeError.length > 200 ? safeError.slice(0, 200) + "..." : safeError;
      return { kind: "failed", message: `status:failed:${truncated}` };
    }

    const filteredList =
      withState.length > 0
        ? withState.map((row) => `${row.displayName} state=${row.cachedState ?? "unhydrated"}`).join(", ")
        : "none";
    return {
      kind: "skipped",
      message: `status:skipped:no-pr: no OPEN linked PR (cached mentions filtered: ${filteredList}; live re-resolve found 0)`,
    };
  }

  if (authorizingPRs.length > 1) {
    const prList = authorizingPRs.map((pr) => pr.displayName).join(", ");
    return {
      kind: "skipped",
      message: `status:skipped:ambiguous: Multiple linked PRs (${authorizingPRs.length}): ${prList}`,
    };
  }

  const pr = authorizingPRs[0]!;
  const candidates = await resolveGitHubTokenCandidatesForRepo(db, companyId, pr.owner, pr.repo);
  if (candidates.length === 0) {
    const tokenResult = await resolveGitHubTokenForRepo(db, companyId, pr.owner, pr.repo);
    if (!isGitHubTokenResolution(tokenResult)) {
      return {
        kind: "failed",
        message: `status:failed:auth_required: ${tokenResult.reason} (scope=null, secretName=null)`,
      };
    }
    return {
      kind: "failed",
      message: `status:failed:auth_required: No GitHub token resolvable for ${pr.owner}/${pr.repo} (scope=null, secretName=null)`,
    };
  }

  for (const candidate of candidates) {
    const token = candidate.token;
    const headShaResult = await fetchPullRequestHeadSha(token, pr.owner, pr.repo, pr.number);
    if (!headShaResult.ok) {
      const { status, message } = headShaResult;
      if (status === 401 || status === 403) {
        if (candidate === candidates[candidates.length - 1]) {
          if (candidates.length === 1) {
            return {
              kind: "failed",
              message: `status:failed:pr_auth: HTTP ${status} ${message ?? ""} (scope=${candidate.scope}, secretName=${candidate.secretName})`,
            };
          }
          const tried = candidates.map((c) => `${c.scope}/${c.secretName}`).join(", ");
          return {
            kind: "failed",
            message: `status:failed:pr_auth: HTTP ${status} ${message ?? ""} (tried: ${tried})`,
          };
        }
        continue;
      }
      if (status === 404) {
        return { kind: "failed", message: `status:failed:pr_not_found: HTTP 404 ${message ?? ""}` };
      }
      if (status === 429) {
        return { kind: "failed", message: `status:failed:pr_rate_limited: HTTP 429 ${message ?? ""}` };
      }
      if (status === 0) {
        return { kind: "failed", message: `status:failed:pr_network: ${message ?? "network_error"}` };
      }
      return { kind: "failed", message: `status:failed:pr_error: HTTP ${status} ${message ?? ""}` };
    }

    const headSha = headShaResult.headSha;
    if (options?.expectedHeadSha && headSha !== options.expectedHeadSha) {
      return {
        kind: "skipped",
        message: `status:skipped:head_moved: ${pr.displayName} head moved to ${headSha.slice(0, 7)} after content-identity validation (expected ${options.expectedHeadSha.slice(0, 7)}); not re-stamped`,
        headSha,
      };
    }
    const result = await writeCommitStatus(token, pr.owner, pr.repo, headSha, issueIdentifier);
    if (result.success) {
      return {
        kind: "armed",
        message: `status:published: paperclip/approved status written to ${pr.displayName} head ${headSha.slice(0, 7)}`,
        headSha,
      };
    }

    const safeError = result.error ?? "unknown_error";
    const truncated = safeError.length > 200 ? safeError.slice(0, 200) + "..." : safeError;
    return { kind: "failed", message: `status:failed:${truncated}` };
  }

  return { kind: "failed", message: "status:failed:internal: exhausted GitHub token candidates" };
}

export type DecisionHeadResolution =
  | { kind: "resolved"; headSha: string; displayName: string }
  | { kind: "unresolvable"; reason: string };

/**
 * ADR-091 D2a — decision-time head pin. Resolves the PR head the approving
 * decision was rendered against, using the same candidate walk
 * publishApprovalStatus uses (cached linked PRs first, then the zero-mention-row
 * live re-resolve for closing transitions, SUP-13313 / SUP-13831).
 * runApprovalMergeArming passes this head to publishApprovalStatus as
 * expectedHeadSha so a head that moves between the decision and the delegated
 * write refuses (skipped:head_moved, zero writes) instead of stamping a
 * never-reviewed head. Any case that cannot positively resolve a single head is
 * "unresolvable"; the caller must refuse with a named skipped reason, never
 * fall back to the live head (ADR-091 D4: cannot verify -> refuse).
 */
export async function resolveApprovalDecisionHead(
  db: Db,
  companyId: string,
  issueId: string,
  issueIdentifier: string,
  closingTransition: boolean,
): Promise<DecisionHeadResolution> {
  const linkedPRs = await resolveLinkedPullRequests(db, companyId, issueId);

  if (linkedPRs.length > 1) {
    const prList = linkedPRs.map((pr) => pr.displayName).join(", ");
    return {
      kind: "unresolvable",
      reason: `ambiguous: multiple linked PRs (${linkedPRs.length}): ${prList}`,
    };
  }

  if (linkedPRs.length === 1) {
    const pr = linkedPRs[0]!;
    const head = await fetchHeadViaTokenCandidates(db, companyId, pr.owner, pr.repo, pr.number);
    return head.ok
      ? { kind: "resolved", headSha: head.headSha, displayName: pr.displayName }
      : { kind: "unresolvable", reason: head.reason };
  }

  // Zero cached linked PRs: mirror publishApprovalStatus's live re-resolve so
  // the decision-time head matches what the publish would have resolved.
  const withState = await resolveLinkedPullRequestsWithState(db, companyId, issueId);
  const pairs: Array<{ owner: string; repo: string }> = [];
  const seenPairs = new Set<string>();
  for (const row of withState) {
    const key = `${row.owner.toLowerCase()}/${row.repo.toLowerCase()}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    pairs.push({ owner: row.owner, repo: row.repo });
  }

  if (pairs.length === 0 && closingTransition) {
    const [issueRow] = await db
      .select({
        projectId: issues.projectId,
        projectWorkspaceId: issues.projectWorkspaceId,
        executionWorkspaceId: issues.executionWorkspaceId,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    const ctx = await resolveIssueRepoContext(db, {
      companyId,
      projectId: issueRow?.projectId ?? null,
      projectWorkspaceId: issueRow?.projectWorkspaceId ?? null,
      executionWorkspaceId: issueRow?.executionWorkspaceId ?? null,
    });
    const parsed = ctx?.repoUrl ? parseRepoUrl(ctx.repoUrl) : null;
    if (parsed) pairs.push({ owner: parsed.owner, repo: parsed.repo });
  }

  const needle = issueIdentifier.toLowerCase();
  const matched: Array<{ owner: string; repo: string; number: number; displayName: string }> = [];

  for (const pair of pairs) {
    const candidates = await resolveGitHubTokenCandidatesForRepo(db, companyId, pair.owner, pair.repo);
    if (candidates.length === 0) {
      const tokenResult = await resolveGitHubTokenForRepo(db, companyId, pair.owner, pair.repo);
      const reason = isGitHubTokenResolution(tokenResult)
        ? `auth_required: no GitHub token resolvable for ${pair.owner}/${pair.repo}`
        : `auth_required: ${tokenResult.reason}`;
      return { kind: "unresolvable", reason };
    }
    for (const candidate of candidates) {
      const listResult = await fetchOpenPullRequests(candidate.token, pair.owner, pair.repo);
      if (!listResult.ok) {
        const { status, message } = listResult;
        if (status === 401 || status === 403) {
          if (candidate !== candidates[candidates.length - 1]) continue;
          return { kind: "unresolvable", reason: `pr_auth: HTTP ${status} ${message ?? ""}` };
        }
        if (status === 404) return { kind: "unresolvable", reason: "pr_not_found: HTTP 404" };
        if (status === 429) return { kind: "unresolvable", reason: "pr_rate_limited: HTTP 429" };
        if (status === 0) {
          return { kind: "unresolvable", reason: `pr_network: ${message ?? "network_error"}` };
        }
        return { kind: "unresolvable", reason: `pr_error: HTTP ${status} ${message ?? ""}` };
      }
      for (const item of listResult.items) {
        if (item.draft === true) continue;
        const headRef = (item.headRef ?? "").toLowerCase();
        const title = (item.title ?? "").toLowerCase();
        const body = (item.body ?? "").toLowerCase();
        if (!headRef.includes(needle) && !title.includes(needle) && !body.includes(needle)) continue;
        matched.push({
          owner: pair.owner,
          repo: pair.repo,
          number: item.number,
          displayName: `${pair.owner}/${pair.repo}#${item.number}`,
        });
      }
      break;
    }
  }

  if (matched.length > 1) {
    const prList = matched.map((pr) => pr.displayName).join(", ");
    return {
      kind: "unresolvable",
      reason: `ambiguous: multiple live-resolved PRs (${matched.length}): ${prList}`,
    };
  }
  if (matched.length === 1) {
    const pr = matched[0]!;
    const head = await fetchHeadViaTokenCandidates(db, companyId, pr.owner, pr.repo, pr.number);
    return head.ok
      ? { kind: "resolved", headSha: head.headSha, displayName: pr.displayName }
      : { kind: "unresolvable", reason: head.reason };
  }
  return { kind: "unresolvable", reason: "no-pr: no open linked PR resolvable at decision time" };
}

async function fetchHeadViaTokenCandidates(
  db: Db,
  companyId: string,
  owner: string,
  repo: string,
  number: number,
): Promise<{ ok: true; headSha: string } | { ok: false; reason: string }> {
  const candidates = await resolveGitHubTokenCandidatesForRepo(db, companyId, owner, repo);
  if (candidates.length === 0) {
    const tokenResult = await resolveGitHubTokenForRepo(db, companyId, owner, repo);
    const reason = isGitHubTokenResolution(tokenResult)
      ? `auth_required: no GitHub token resolvable for ${owner}/${repo}`
      : `auth_required: ${tokenResult.reason}`;
    return { ok: false, reason };
  }
  for (const candidate of candidates) {
    const headShaResult = await fetchPullRequestHeadSha(candidate.token, owner, repo, number);
    if (headShaResult.ok) return { ok: true, headSha: headShaResult.headSha };
    const { status, message } = headShaResult;
    if (status === 401 || status === 403) {
      if (candidate !== candidates[candidates.length - 1]) continue;
      const scopeDetail =
        candidates.length === 1
          ? `(scope=${candidate.scope}, secretName=${candidate.secretName})`
          : `(tried: ${candidates.map((c) => `${c.scope}/${c.secretName}`).join(", ")})`;
      return { ok: false, reason: `pr_auth: HTTP ${status} ${message ?? ""} ${scopeDetail}` };
    }
    if (status === 404) return { ok: false, reason: "pr_not_found: HTTP 404" };
    if (status === 429) return { ok: false, reason: "pr_rate_limited: HTTP 429" };
    if (status === 0) return { ok: false, reason: `pr_network: ${message ?? "network_error"}` };
    return { ok: false, reason: `pr_error: HTTP ${status} ${message ?? ""}` };
  }
  return { ok: false, reason: "internal: exhausted GitHub token candidates" };
}

export interface HeadShaSuccess extends GitHubFetchResult {
  ok: true;
  headSha: string;
}

export interface HeadShaFailure extends GitHubFetchResult {
  ok: false;
  headSha: null;
}

export type HeadShaResult = HeadShaSuccess | HeadShaFailure;

async function fetchPullRequestHeadSha(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<HeadShaResult> {
  const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-merge-arming",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };

  let response: Response;
  try {
    response = await ghFetch(url, { headers });
  } catch {
    return { ok: false, status: 0, message: "network_error", headSha: null };
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const message = body?.message as string | undefined;
    return { ok: false, status: response.status, message: message ?? null, headSha: null };
  }

  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return { ok: false, status: response.status, message: "empty_response", headSha: null };

  const head = body.head as Record<string, unknown> | undefined;
  const sha = head?.sha as string | undefined;
  if (typeof sha === "string" && sha.length > 0) {
    return { ok: true, status: response.status, message: null, headSha: sha };
  }
  return { ok: false, status: response.status, message: "head.sha missing from response", headSha: null };
}

export interface OpenPullRequestListItem {
  number: number;
  draft: boolean | null;
  headRef: string | null;
  title: string | null;
  body: string | null;
}

export interface OpenPullRequestsSuccess extends GitHubFetchResult {
  ok: true;
  items: OpenPullRequestListItem[];
}

export interface OpenPullRequestsFailure extends GitHubFetchResult {
  ok: false;
  items: never[];
}

export type OpenPullRequestsResult = OpenPullRequestsSuccess | OpenPullRequestsFailure;

export async function fetchOpenPullRequests(
  token: string,
  owner: string,
  repo: string,
  hostname: string = "github.com",
): Promise<OpenPullRequestsResult> {
  const url = `${gitHubApiBase(hostname)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo,
  )}/pulls?state=open&per_page=100`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-merge-arming",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };

  let response: Response;
  try {
    response = await ghFetch(url, { headers });
  } catch {
    return { ok: false, status: 0, message: "network_error", items: [] };
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const message = body?.message as string | undefined;
    return { ok: false, status: response.status, message: message ?? null, items: [] };
  }

  const body = await response.json().catch(() => null);
  if (!Array.isArray(body)) {
    return { ok: false, status: response.status, message: "empty_response", items: [] };
  }

  const items: OpenPullRequestListItem[] = [];
  for (const raw of body) {
    if (typeof raw !== "object" || raw === null) continue;
    const pr = raw as Record<string, unknown>;
    if (typeof pr.number !== "number") continue;
    const head = pr.head as Record<string, unknown> | undefined | null;
    items.push({
      number: pr.number,
      draft: typeof pr.draft === "boolean" ? pr.draft : null,
      headRef: typeof head?.ref === "string" ? head.ref : null,
      title: typeof pr.title === "string" ? pr.title : null,
      body: typeof pr.body === "string" ? pr.body : null,
    });
  }
  return { ok: true, status: response.status, message: null, items };
}

async function writeCommitStatus(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  issueIdentifier: string,
): Promise<{ success: boolean; error: string | null }> {
  const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/statuses/${encodeURIComponent(headSha)}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-merge-arming",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };

  const body = JSON.stringify({
    state: "success",
    context: "paperclip/approved",
    description: `${issueIdentifier} approved via Paperclip`,
    target_url: `https://paperclip.example.com/issues/${issueIdentifier}`,
  });

  let response: Response;
  try {
    response = await ghFetch(url, {
      method: "POST",
      headers,
      body,
    });
  } catch {
    return { success: false, error: "network_error" };
  }

  if (response.ok) {
    return { success: true, error: null };
  }

  const responseBody = await response.json().catch(() => null) as Record<string, unknown> | null;
  const message = responseBody?.message as string | undefined;

  if (response.status === 403 || response.status === 422) {
    const detail = message ?? "";
    return { success: false, error: `scope_missing: HTTP ${response.status} ${detail}` };
  }

  return { success: false, error: message ?? `HTTP ${response.status}` };
}

export interface PostPullRequestCommentResult {
  success: boolean;
  status: number;
  error: string | null;
}

/**
 * SUP-14049: post a comment on a PR's conversation (the issues-comments
 * endpoint covers pull requests). Advisory-only by construction: this is a
 * plain comment and never creates, mocks, or writes the paperclip/approved
 * status — that context stays owned by the control-plane publish path alone
 * (the check-paperclip-approved.sh consume-contract).
 */
export async function postPullRequestComment(
  token: string,
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<PostPullRequestCommentResult> {
  const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo,
  )}/issues/${number}/comments`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-merge-arming",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };

  let response: Response;
  try {
    response = await ghFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ body }),
    });
  } catch {
    return { success: false, status: 0, error: "network_error" };
  }

  if (response.ok) {
    return { success: true, status: response.status, error: null };
  }

  const responseBody = await response.json().catch(() => null) as Record<string, unknown> | null;
  const message = responseBody?.message as string | undefined;
  return { success: false, status: response.status, error: message ?? `HTTP ${response.status}` };
}

export async function armMergeOnApproval(
  db: Db,
  companyId: string,
  issueId: string,
  decision: MergeArmingDecision,
): Promise<ArmingOutcome> {
  if (decision.outcome !== "approved") {
    return { kind: "skipped", message: `skipped:not-approved: Decision outcome is "${decision.outcome}", not "approved"` };
  }

  const linkedPRs = await resolveLinkedPullRequests(db, companyId, issueId);

  if (linkedPRs.length === 0) {
    return { kind: "skipped", message: "skipped:no-pr: No linked pull request found" };
  }

  if (linkedPRs.length > 1) {
    const prList = linkedPRs.map((pr) => pr.displayName).join(", ");
    return {
      kind: "skipped",
      message: `skipped:ambiguous: Multiple linked PRs (${linkedPRs.length}): ${prList}`,
    };
  }

  const pr = linkedPRs[0]!;

  // SUP-13361: title-OR-branch ownership. Shared-branch child PRs carry the
  // approving card's identifier in the PR title, so the branch prefix alone
  // refuses every shared-branch PR. A card that merely MENTIONS a PR still
  // owns neither its title nor its branch, so SUP-12417 stays fixed.
  const titleIds = (pr.title ?? "").match(/SUP-\d+/g) ?? [];
  const branchMatch = /^(SUP-\d+)/.exec(pr.headRefName ?? "");
  const branchId = branchMatch ? branchMatch[1]! : null;

  const candidateIdentifiers: string[] = [];
  for (const candidate of [...titleIds, ...(branchId ? [branchId] : [])]) {
    if (!candidateIdentifiers.includes(candidate)) {
      candidateIdentifiers.push(candidate);
    }
  }

  if (candidateIdentifiers.length === 0) {
    return {
      kind: "skipped",
      message: "skipped:unowned-branch: PR title and headRefName do not name a SUP-\\d+ owner",
    };
  }

  let ownerRow:
    | { id: string; executionPolicy: unknown; executionState: unknown }
    | undefined;
  for (const candidateIdentifier of candidateIdentifiers) {
    const [candidateRow] = await db
      .select({
        id: issues.id,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(
        and(eq(issues.companyId, companyId), eq(issues.identifier, candidateIdentifier)),
      )
      .limit(1);
    if (!candidateRow) continue;
    if (candidateRow.id === issueId) {
      ownerRow = candidateRow;
      break;
    }
  }

  if (!ownerRow) {
    return {
      kind: "skipped",
      message: `skipped:not-pr-owner: PR ${pr.number} title=[${titleIds.length > 0 ? titleIds.join(", ") : "(none)"}] branch=${branchId ?? "(none)"} — none is the transitioning issue`,
    };
  }

  const policy = ownerRow.executionPolicy as { stages?: Array<{ id: string }> } | undefined;
  const state = ownerRow.executionState as
    | { completedStageIds?: string[]; lastDecisionOutcome?: string | null }
    | undefined;

  const policyStages = policy?.stages ?? [];
  const completedIds = state?.completedStageIds ?? [];
  const allCompleted = policyStages.every((s) => completedIds.includes(s.id));
  const isApproved = state?.lastDecisionOutcome === "approved";

  if (!allCompleted || !isApproved) {
    const incompleteIds = policyStages.filter((s) => !completedIds.includes(s.id)).map((s) => s.id);
    return {
      kind: "skipped",
      message: `skipped:owner-not-approved: incomplete review/approval stages: ${incompleteIds.join(", ")}`,
    };
  }

  const candidates = await resolveGitHubTokenCandidatesForRepo(db, companyId, pr.owner, pr.repo);
  if (candidates.length === 0) {
    const tokenResult = await resolveGitHubTokenForRepo(db, companyId, pr.owner, pr.repo);
    if (!isGitHubTokenResolution(tokenResult)) {
      return {
        kind: "failed",
        message: `failed:auth_required: ${tokenResult.reason} (scope=null, secretName=null)`,
      };
    }
    return {
      kind: "failed",
      message: `failed:auth_required: No GitHub token resolvable for ${pr.owner}/${pr.repo} (scope=null, secretName=null)`,
    };
  }

  for (const candidate of candidates) {
    const token = candidate.token;

    let nodeId = pr.nodeId;
    if (!nodeId) {
      const nodeIdResult = await fetchGitHubNodeId(token, pr.owner, pr.repo, pr.number);
      if (!nodeIdResult.ok || !nodeIdResult.nodeId) {
        if (nodeIdResult.status === 401 || nodeIdResult.status === 403) {
          if (candidate === candidates[candidates.length - 1]) {
            if (candidates.length === 1) {
              return {
                kind: "failed",
                message: `failed:pr_auth: HTTP ${nodeIdResult.status} ${nodeIdResult.message ?? ""} (scope=${candidate.scope}, secretName=${candidate.secretName})`,
              };
            }
            const tried = candidates.map((c) => `${c.scope}/${c.secretName}`).join(", ");
            return {
              kind: "failed",
              message: `failed:pr_auth: HTTP ${nodeIdResult.status} ${nodeIdResult.message ?? ""} (tried: ${tried})`,
            };
          }
          continue;
        }
        return { kind: "failed", message: `failed:node_id_missing: Could not resolve GitHub node ID for linked PR (HTTP ${nodeIdResult.status})` };
      }
      nodeId = nodeIdResult.nodeId;
    }

    const result = await enableAutoMerge(token, nodeId);
    if (result.success) {
      if (result.alreadyQueued) {
        return {
          kind: "skipped",
          message: `skipped:already-queued: ${pr.displayName} already queued to merge`,
        };
      }
      return {
        kind: "armed",
        message: `armed: Auto-merge enabled for ${pr.displayName}`,
      };
    }

    if (result.status === 401 || result.status === 403) {
      if (candidate === candidates[candidates.length - 1]) {
        if (candidates.length === 1) {
          return {
            kind: "failed",
            message: `failed:pr_auth: HTTP ${result.status} ${result.error ?? ""} (scope=${candidate.scope}, secretName=${candidate.secretName})`,
          };
        }
        const tried = candidates.map((c) => `${c.scope}/${c.secretName}`).join(", ");
        return {
          kind: "failed",
          message: `failed:pr_auth: HTTP ${result.status} ${result.error ?? ""} (tried: ${tried})`,
        };
      }
      continue;
    }

    const safeError = result.error ?? "unknown_error";
    const truncated = safeError.length > 200 ? safeError.slice(0, 200) + "..." : safeError;
    return { kind: "failed", message: `failed:${truncated}` };
  }

  return { kind: "failed", message: "failed:internal: exhausted GitHub token candidates" };
}
