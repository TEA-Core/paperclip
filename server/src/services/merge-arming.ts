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

// SUP-14900: a closing transition whose merge arming REFUSED (a principled
// refusal, `statusOutcome.kind === "skipped"`) must not rest the card in quiet
// `done`. The post-approval hook records this durable, first-class signal; the
// card-side done-close-landing backstop keys on it to surface a linked PR that
// is still open/unmerged. A genuine hook failure (`kind === "failed"` or a throw
// in the hook's catch) is NOT this signal (SUP-13904's original intent).
export const MERGE_ARMING_REFUSED_ON_CLOSE_ACTION = "issue.merge_arming_refused_on_close";
export const MERGE_ARMING_ACTOR_ID = "system:merge-arming";

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
  /**
   * SUP-14602: for a `skipped:ambiguous` outcome, every candidate PR that made
   * the card ambiguous, each carrying the head SHA captured at approval time
   * (null when no resolvable credential could fetch it). The approval
   * transition persists these in executionState.approvalStatus.pendingCandidates
   * so that after a human or agent closes the duplicate PR, the
   * approval-status reconciler can re-run Guard A against a certified head
   * instead of failing closed forever on guard-a:no-approved-head.
   */
  skipCandidates?: ApprovalCandidateAnchor[];
}

/**
 * SUP-14602: a certification anchor for one candidate PR of an ambiguous
 * approval. The approval-status reconciler uses it to re-run Guard A against a
 * head it knows was certified at approval time, rather than re-resolving the
 * ambiguous candidate set live.
 */
export interface ApprovalCandidateAnchor {
  owner: string;
  repo: string;
  number: number;
  /** The PR head SHA captured at approval time, or null when unresolvable. */
  headShaAtApproval: string | null;
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

/** Returns the value when it is a non-empty string, else null. */
function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Extracts the head branch ref from a cached external object's data. The
 * canonical shape is the flat `headRef` key the GitHub external-object
 * provider writes (`pullRequestSnapshot` in
 * `github-external-object-provider.ts`); nested `head.ref` and flat
 * `headRefName` are tolerated for legacy cached rows.
 */
function headRefFromData(data: Record<string, unknown> | null | undefined): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const flat = readString(data.headRef);
  if (flat) return flat;
  const head = data.head;
  if (head && typeof head === "object" && !Array.isArray(head)) {
    const ref = (head as Record<string, unknown>).ref;
    if (typeof ref === "string" && ref.length > 0) return ref;
  }
  return readString(data.headRefName);
}

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
    const headRefName = headRefFromData(row.data);

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
    const headRefName = headRefFromData(row.data);

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
 *
 * ADR-091 D1 (SUP-14824): prefers the recorded delivery identity
 * (executionState.delivery) over the execution-workspace row. A recorded
 * identity that is present but unusable (no resolvable repo, missing/empty
 * branch or headSha) fails closed with a named reason and never falls back to
 * the workspace row.
 */
async function resolveDeliveryIdentity(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<{
   branch: string | null;
   repo: { owner: string; repo: string } | null;
   recordedUnusable?: string;
   /**
    * ADR-091 D1 (SUP-14783): false ONLY when the execution-workspace row backing
    * `branch` provably belongs to a DIFFERENT issue — a `shared_workspace` row
    * inherited from a parent. The row carries one `branch_name`, so under
    * sharing that name is the parent's branch and is NOT this card's delivery
    * branch. Defaults to TRUE whenever ownership is unknown (`sourceIssueId`
    * null, or no execution-workspace row at all) so the pre-existing verdict and
    * refusal text stay byte-identical on every path that already worked.
    */
   branchIsOwn: boolean;
   identifier: string | null;
 }> {
  const [issueRow] = await db
    .select({
      identifier: issues.identifier,
      projectId: issues.projectId,
      projectWorkspaceId: issues.projectWorkspaceId,
      executionWorkspaceId: issues.executionWorkspaceId,
      executionState: issues.executionState,
    })
    .from(issues)
    .where(eq(issues.id, issueId));

  // ADR-091 D1 (SUP-14824): prefer the recorded delivery identity.
  const delivery = issueRow?.executionState?.delivery;
  if (delivery && typeof delivery === "object" && !Array.isArray(delivery)) {
    const record = delivery as Record<string, unknown>;
    const branch = typeof record.branch === "string" && record.branch.length > 0 ? record.branch : null;
    const headSha = typeof record.headSha === "string" && record.headSha.length > 0 ? record.headSha : null;
    const repoRaw = record.repo;
    const repo =
      repoRaw && typeof repoRaw === "object" && !Array.isArray(repoRaw)
        ? (() => {
            const r = repoRaw as Record<string, unknown>;
            if (typeof r.owner !== "string" || r.owner.length === 0 || typeof r.repo !== "string" || r.repo.length === 0)
              return null;
            return { owner: r.owner, repo: r.repo };
          })()
        : null;
    if (!branch || !repo || !headSha) {
      const reason = !repo
        ? "recorded delivery identity has no resolvable repo"
        : !branch
          ? "recorded delivery identity has no branch"
          : "recorded delivery identity has no headSha";
      return { branch: null, repo: null, recordedUnusable: reason, branchIsOwn: true, identifier: issueRow?.identifier ?? null };
    }
    return { branch, repo, branchIsOwn: true, identifier: issueRow?.identifier ?? null };
  }

  const ctx = await resolveIssueRepoContext(db, {
    companyId,
    projectId: issueRow?.projectId ?? null,
    projectWorkspaceId: issueRow?.projectWorkspaceId ?? null,
    executionWorkspaceId: issueRow?.executionWorkspaceId ?? null,
  });
  let branchIsOwn = true;
  if (issueRow?.executionWorkspaceId) {
    const [wsRow] = await db
      .select({ sourceIssueId: executionWorkspaces.sourceIssueId })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, issueRow.executionWorkspaceId));
    if (wsRow?.sourceIssueId && wsRow.sourceIssueId !== issueId) branchIsOwn = false;
  }
  return {
    branch: ctx?.branch ?? null,
    repo: ctx?.repoUrl ? parseRepoUrl(ctx.repoUrl) : null,
    branchIsOwn,
    identifier: issueRow?.identifier ?? null,
  };
}

/**
 * ADR-091 D1 (SUP-14783): the delivery predicate for a card whose recorded
 * workspace branch belongs to a shared parent. The repo half is UNCHANGED and
 * still decisive — D5's cross-repo closure is untouched. Only the branch half
 * is substituted: the head ref must carry this card's own identifier prefix.
 *
 * Measured before adopting this, over the live corpus: on all 434 rows where
 * the existing exact-branch gate ACCEPTS, this predicate agrees (434/434, no
 * counterexample), while 3892 cited-PR mention rows carry a foreign `SUP-`
 * prefix and stay refused. It is therefore not a widening of the accept set on
 * any card that can already be armed — it is the same verdict, reached from the
 * one piece of delivery evidence a shared-workspace card actually owns.
 *
 * It is deliberately WEAKER evidence than the exact-branch check, because a
 * shared-workspace card has no control-plane-created branch of its own to
 * compare against: the head ref is agent-authored via deliver.sh. That is the
 * honest cost, and it is why this path is entered only when ownership of the
 * recorded branch is positively disproven, never by default.
 */
function isDeliveredByCardIdentifierPrefix(
  pr: { owner: string; repo: string; headRefName: string | null },
  deliveryRepo: { owner: string; repo: string },
  identifier: string,
): boolean {
  if (pr.owner.toLowerCase() !== deliveryRepo.owner.toLowerCase()) return false;
  if (pr.repo.toLowerCase() !== deliveryRepo.repo.toLowerCase()) return false;
  if (pr.headRefName === null) return false;
  return pr.headRefName.toLowerCase().startsWith(`${identifier.toLowerCase()}-`);
}

/** ADR-091 D4: the fail-closed refusal when delivery identity is unresolvable. */
function deliveryIdentityUnresolvedOutcome(
  branch: string | null,
  recordedUnusable?: string,
  missingIdentifier?: boolean,
): ArmingOutcome {
  const missing = recordedUnusable
    ? recordedUnusable
    : missingIdentifier
      ? "this card's execution-workspace branch belongs to another issue and the card has no readable identifier to authorize against"
      : !branch
      ? "no delivery branch recorded on this card's execution workspace"
      : "no delivery repo resolvable for this card's execution workspace";
  return {
    kind: "skipped",
    message: `status:skipped:delivery_identity_unresolved: ${missing}; refusing to stamp a PR this card cannot be proven to have delivered (ADR-091 D4, fail closed)`,
  };
}

/**
 * True when the PR's head repo AND head ref are this card's delivery identity.
 * ADR-091 D5 (SUP-14733): the gate STAYS CLOSED ACROSS REPOS — a card's
 * delivery repo is structurally its project's repo, and branch-only matching
 * would re-open the laundering vector D1 exists to block. This boolean is
 * load-bearing: SUP-14734 is a message-only change and the accept/refuse
 * verdict must stay byte-identical before and after.
 */
function isDeliveredByCard(
  pr: { owner: string; repo: string; headRefName: string | null },
  deliveryRepo: { owner: string; repo: string },
  deliveryBranch: string,
): boolean {
  if (pr.owner.toLowerCase() !== deliveryRepo.owner.toLowerCase()) return false;
  if (pr.repo.toLowerCase() !== deliveryRepo.repo.toLowerCase()) return false;
  return pr.headRefName !== null && pr.headRefName.toLowerCase() === deliveryBranch.toLowerCase();
}

/**
 * ADR-091 D5 (SUP-14733): the single source of truth for one rejected
 * candidate's fragment in a `not_delivered` refusal. When the head REPO differs
 * from the delivery repo it names the repo mismatch and the remedy (file the
 * deliverable under a project bound to that repo) instead of the misleading
 * "branch X is not branch X" that reads as a control-plane bug. When the repo
 * matches and only the head ref differs it keeps today's branch language. Both
 * publishApprovalStatus and resolveApprovalDecisionHead route through this so
 * the decision-time and publish-time refusals stay identical — a second copy of
 * this rule is how the D2a round-1 regression happened. The repo comparison is
 * case-insensitive, mirroring isDeliveredByCard, so the message half and the
 * verdict never disagree on which half mismatched.
 */
function notDeliveredReasonForPr(
  pr: { displayName: string; owner: string; repo: string; headRefName: string | null },
  deliveryRepo: { owner: string; repo: string },
  deliveryBranch: string,
  requiredIdentifier?: string | null,
): string {
  const repoMatches =
    pr.owner.toLowerCase() === deliveryRepo.owner.toLowerCase() &&
    pr.repo.toLowerCase() === deliveryRepo.repo.toLowerCase();
  if (!repoMatches) {
    const headRepo = `${pr.owner}/${pr.repo}`;
    const delivery = `${deliveryRepo.owner}/${deliveryRepo.repo}`;
    return `${pr.displayName} head repo ${headRepo} is not this card's delivery repo ${delivery}; a deliverable in ${headRepo} must be filed under a project bound to that repo (ADR-091 D5)`;
  }
  // ADR-091 D1 (SUP-14783): naming the exact-branch requirement here would be a
  // lie when the prefix predicate is what actually ran — `deliveryBranch` is a
  // sibling card's branch, and telling an operator to match it would send them
  // to stamp the wrong PR.
  if (requiredIdentifier) {
    return `${pr.displayName} head ${pr.owner}/${pr.repo}:${pr.headRefName ?? "(unreadable)"} does not carry this card's identifier prefix ${requiredIdentifier}-; this card shares execution workspace branch ${deliveryBranch} with another issue, so that branch is not its delivery branch (ADR-091 D1)`;
  }
  return `${pr.displayName} head ${pr.owner}/${pr.repo}:${pr.headRefName ?? "(unreadable)"} is not this card's delivery branch ${deliveryBranch}`;
}

/** The named `not_delivered` refusal, listing every candidate that failed the gate. */
function notDeliveredOutcome(
  rejected: Array<{ displayName: string; owner: string; repo: string; headRefName: string | null }>,
  deliveryRepo: { owner: string; repo: string },
  deliveryBranch: string,
  requiredIdentifier?: string | null,
): ArmingOutcome {
  const failed = rejected
    .map((pr) => notDeliveredReasonForPr(pr, deliveryRepo, deliveryBranch, requiredIdentifier))
    .join("; ");
  return { kind: "skipped", message: `status:skipped:not_delivered: ${failed}` };
}

/**
 * ADR-091 D1 shared delivery-identity narrowing. Resolves this card's delivery
 * identity and keeps only the PRs it actually delivered, BEFORE any length
 * arithmetic. publishApprovalStatus and resolveApprovalDecisionHead both route
 * through this so the head a decision pins is always the head the publish will
 * stamp — a second copy of this rule is how the D2a round-1 regression happened.
 * The generic result lets each caller map a refusal to its own outcome type
 * (ArmingOutcome vs DecisionHeadResolution) without duplicating the rule.
 */
type DeliveryNarrow<T> =
  | { outcome: "narrowed"; delivered: T[]; deliveryBranch: string }
  | { outcome: "identity-unresolved"; branch: string | null; recordedUnusable?: string; missingIdentifier?: boolean }
  | {
      outcome: "not-delivered";
      rejected: T[];
      deliveryRepo: { owner: string; repo: string };
      deliveryBranch: string;
      /** Set only when the SUP-14783 shared-workspace prefix predicate was the one applied. */
      requiredIdentifier?: string | null;
    };

async function narrowToDelivered<
  T extends { owner: string; repo: string; headRefName: string | null; displayName: string },
>(db: Db, companyId: string, issueId: string, candidates: T[]): Promise<DeliveryNarrow<T>> {
  const { branch, repo, recordedUnusable, branchIsOwn, identifier } = await resolveDeliveryIdentity(db, companyId, issueId);
  if (recordedUnusable) return { outcome: "identity-unresolved", branch: null, recordedUnusable };
  if (!branch || !repo) return { outcome: "identity-unresolved", branch };
  // ADR-091 D1 (SUP-14783): a `shared_workspace` row belongs to the parent
  // issue and carries exactly one branch_name, so for every OTHER issue on that
  // row the exact-branch check compares against a sibling's branch and is
  // structurally guaranteed to refuse. Substitute the identifier-prefix
  // predicate for those cards only. Fail closed when ownership is disproven but
  // no identifier is readable — never silently fall back to a check that cannot
  // pass.
  const usePrefixPredicate = !branchIsOwn && Boolean(identifier);
  if (!branchIsOwn && !identifier) {
    return { outcome: "identity-unresolved", branch, missingIdentifier: true };
  }
  const delivered = usePrefixPredicate
    ? candidates.filter((pr) => isDeliveredByCardIdentifierPrefix(pr, repo, identifier as string))
    : candidates.filter((pr) => isDeliveredByCard(pr, repo, branch));
  if (delivered.length === 0) {
    return {
      outcome: "not-delivered",
      rejected: candidates,
      deliveryRepo: repo,
      deliveryBranch: branch,
      requiredIdentifier: usePrefixPredicate ? identifier : null,
    };
  }
  return { outcome: "narrowed", delivered, deliveryBranch: branch };
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
    const narrowed = await narrowToDelivered(db, companyId, issueId, linkedPRs);
    // ADR-091 D4: fail closed when the card's delivery identity cannot be
    // positively resolved — refuse to stamp on an unverified branch.
    if (narrowed.outcome === "identity-unresolved") {
      return deliveryIdentityUnresolvedOutcome(narrowed.branch, narrowed.recordedUnusable, narrowed.missingIdentifier);
    }
    if (narrowed.outcome === "not-delivered") {
      return notDeliveredOutcome(
          narrowed.rejected,
          narrowed.deliveryRepo,
          narrowed.deliveryBranch,
          narrowed.requiredIdentifier,
        );
    }

    authorizingPRs = narrowed.delivered;
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
      const narrowed = await narrowToDelivered(db, companyId, issueId, matched);
      // ADR-091 D4: no branch (or no repo) recorded → refuse, never fall back to
      // identifier-substring authorization.
       if (narrowed.outcome === "identity-unresolved") {
         return deliveryIdentityUnresolvedOutcome(narrowed.branch, narrowed.recordedUnusable, narrowed.missingIdentifier);
       }
      if (narrowed.outcome === "not-delivered") {
        return notDeliveredOutcome(
          narrowed.rejected,
          narrowed.deliveryRepo,
          narrowed.deliveryBranch,
          narrowed.requiredIdentifier,
        );
      }
      matched = narrowed.delivered;
    }

    if (matched.length > 1) {
      const prList = matched.map((pr) => pr.displayName).join(", ");
      // SUP-14602: certify every candidate head at approval time. The skip
      // must not discard the certification the producer had in hand — once the
      // ambiguity resolves, the reconciler needs a head Guard A can verify.
      const skipCandidates: ApprovalCandidateAnchor[] = [];
      for (const pr of matched) {
        skipCandidates.push({
          owner: pr.owner,
          repo: pr.repo,
          number: pr.number,
          headShaAtApproval: await fetchHeadShaAcrossCandidates([pr.candidate], pr.owner, pr.repo, pr.number),
        });
      }
      return {
        kind: "skipped",
        message: `status:skipped:ambiguous: Multiple linked PRs (${matched.length}): ${prList}`,
        skipCandidates,
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
    // SUP-14602: certify every candidate head at approval time (see the live
    // re-resolve branch above) so the skip is recoverable by the reconciler.
    // Certify the AUTHORIZING (post delivery-identity-narrowing) candidates —
    // the same set the ambiguity was decided on — so the reconciler recovers
    // against exactly the PRs the producer considered.
    const skipCandidates: ApprovalCandidateAnchor[] = [];
    for (const pr of authorizingPRs) {
      const candidates = await resolveGitHubTokenCandidatesForRepo(db, companyId, pr.owner, pr.repo);
      skipCandidates.push({
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
        headShaAtApproval:
          candidates.length > 0
            ? await fetchHeadShaAcrossCandidates(candidates, pr.owner, pr.repo, pr.number)
            : null,
      });
    }
    return {
      kind: "skipped",
      message: `status:skipped:ambiguous: Multiple linked PRs (${authorizingPRs.length}): ${prList}`,
      skipCandidates,
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
  | {
      kind: "unresolvable";
      reason: string;
      /**
       * SUP-14602: present only for the AMBIGUOUS unresolvable outcomes. When the
       * decision cannot resolve a single head because several candidate PRs are
       * all still open, the resolver certifies each candidate head at approval
       * time so the caller can persist them (executionState.approvalStatus
       * .pendingCandidates) and the approval-status reconciler can re-run Guard A
       * against a certified head once the ambiguity resolves. Absent for every
       * other unresolvable reason (no-pr / not-delivered / delivery_identity).
       */
      pendingCandidates?: ApprovalCandidateAnchor[];
    };

/**
 * ADR-091 D2a — map a shared-narrowing refusal to the resolver's unresolvable
 * form. Carries the SAME named reasons the publisher surfaces (not_delivered /
 * delivery_identity_unresolved) so the decision-time refusal is consistent with
 * what publishApprovalStatus would have done.
 */
function unresolvableFromNarrowing(
  narrowed:
    | { outcome: "identity-unresolved"; branch: string | null; recordedUnusable?: string; missingIdentifier?: boolean }
    | {
        outcome: "not-delivered";
        rejected: Array<{
          displayName: string;
          owner: string;
          repo: string;
          headRefName: string | null;
        }>;
        deliveryRepo: { owner: string; repo: string };
        deliveryBranch: string;
        requiredIdentifier?: string | null;
      },
): DecisionHeadResolution {
  if (narrowed.outcome === "identity-unresolved") {
    const missing = narrowed.recordedUnusable
      ? narrowed.recordedUnusable
      : narrowed.missingIdentifier
        ? "this card's execution-workspace branch belongs to another issue and the card has no readable identifier to authorize against"
        : !narrowed.branch
          ? "no delivery branch recorded on this card's execution workspace"
          : "no delivery repo resolvable for this card's execution workspace";
    return {
      kind: "unresolvable",
      reason: `delivery_identity_unresolved: ${missing}; refusing to stamp a PR this card cannot be proven to have delivered (ADR-091 D4, fail closed)`,
    };
  }
  const failed = narrowed.rejected
    .map((pr) =>
      notDeliveredReasonForPr(pr, narrowed.deliveryRepo, narrowed.deliveryBranch, narrowed.requiredIdentifier),
    )
    .join("; ");
  return { kind: "unresolvable", reason: `not_delivered: ${failed}` };
}

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

  // ADR-091 D1 (SUP-14676): this resolver pins the FIRST publish, and that path
  // always runs publishApprovalStatus with enforceDeliveryIdentity: true — so it
  // must apply the SAME delivery-identity narrowing, BEFORE the length
  // arithmetic, or it would pin a head the publish never stamps. A card that
  // delivered one PR and merely cited a second must pin the DELIVERED one; an
  // unresolvable delivery identity fails closed (D4), never an unnarrowed set.
  let authorizingPRs = linkedPRs;
  if (linkedPRs.length > 0) {
    const narrowed = await narrowToDelivered(db, companyId, issueId, linkedPRs);
    if (narrowed.outcome !== "narrowed") return unresolvableFromNarrowing(narrowed);
    authorizingPRs = narrowed.delivered;
  }

  if (authorizingPRs.length > 1) {
    const prList = authorizingPRs.map((pr) => pr.displayName).join(", ");
    // SUP-14602: ambiguity is unresolvable at decision time, but the certification
    // the producer had in hand must not be discarded. Certify every AUTHORIZING
    // candidate head now so the caller persists pendingCandidates and the
    // reconciler can recover once the duplicate PR closes.
    const pendingCandidates = await certifyCandidateHeads(db, companyId, authorizingPRs);
    return {
      kind: "unresolvable",
      reason: `ambiguous: multiple linked PRs (${authorizingPRs.length}): ${prList}`,
      pendingCandidates,
    };
  }

  if (authorizingPRs.length === 1) {
    const pr = authorizingPRs[0]!;
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
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
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
  const matched: Array<{
    owner: string;
    repo: string;
    number: number;
    displayName: string;
    headRefName: string | null;
  }> = [];

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
          headRefName: item.headRef ?? null,
        });
      }
      break;
    }
  }

  // ADR-091 D1 (SUP-14676): the live-discovery candidates above are matched by
  // identifier substring — pure citation. They take the SAME delivery-identity
  // gate as the cached path (and as publishApprovalStatus) BEFORE the length
  // arithmetic, so the pinned head is always the head the publish will stamp.
  let authorizingMatched = matched;
  if (matched.length > 0) {
    const narrowed = await narrowToDelivered(db, companyId, issueId, matched);
    if (narrowed.outcome !== "narrowed") return unresolvableFromNarrowing(narrowed);
    authorizingMatched = narrowed.delivered;
  }

  if (authorizingMatched.length > 1) {
    const prList = authorizingMatched.map((pr) => pr.displayName).join(", ");
    // SUP-14602: same as the cached branch above — certify every surviving
    // candidate head at approval time so the skipped:ambiguous decision does not
    // discard the certification (see DecisionHeadResolution.pendingCandidates).
    const pendingCandidates = await certifyCandidateHeads(db, companyId, authorizingMatched);
    return {
      kind: "unresolvable",
      reason: `ambiguous: multiple live-resolved PRs (${authorizingMatched.length}): ${prList}`,
      pendingCandidates,
    };
  }
  if (authorizingMatched.length === 1) {
    const pr = authorizingMatched[0]!;
    const head = await fetchHeadViaTokenCandidates(db, companyId, pr.owner, pr.repo, pr.number);
    return head.ok
      ? { kind: "resolved", headSha: head.headSha, displayName: pr.displayName }
      : { kind: "unresolvable", reason: head.reason };
  }
  return { kind: "unresolvable", reason: "no-pr: no open linked PR resolvable at decision time" };
}

/**
 * SUP-14602: certifies each candidate's head at approval time so a
 * skipped:ambiguous decision can be persisted as pendingCandidates and later
 * recovered by the approval-status reconciler. A candidate whose head cannot be
 * read is anchored to null (the reconciler fails closed on it —
 * guard-a:no-approved-head) rather than dropping the whole certification.
 */
async function certifyCandidateHeads(
  db: Db,
  companyId: string,
  candidates: Array<{ owner: string; repo: string; number: number }>,
): Promise<ApprovalCandidateAnchor[]> {
  const anchors: ApprovalCandidateAnchor[] = [];
  for (const pr of candidates) {
    const head = await fetchHeadViaTokenCandidates(db, companyId, pr.owner, pr.repo, pr.number);
    anchors.push({
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
      headShaAtApproval: head.ok ? head.headSha : null,
    });
  }
  return anchors;
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

/**
 * SUP-14602: resolve one PR's live head SHA across a list of token candidates
 * (401/403 advances to the next candidate), or null when none could fetch it.
 * Used to certify each candidate of an ambiguous skip at approval time so the
 * certification is not thrown away with the skip.
 */
async function fetchHeadShaAcrossCandidates(
  candidates: GitHubTokenResolution[],
  owner: string,
  repo: string,
  number: number,
): Promise<string | null> {
  for (let i = 0; i < candidates.length; i++) {
    const headShaResult = await fetchPullRequestHeadSha(candidates[i]!.token, owner, repo, number);
    if (headShaResult.ok) return headShaResult.headSha;
    if ((headShaResult.status === 401 || headShaResult.status === 403) && i < candidates.length - 1) continue;
    return null;
  }
  return null;
}

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
