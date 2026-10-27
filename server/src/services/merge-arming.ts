import type { Db } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { IssueExecutionStage } from "@paperclipai/shared";
import { and, eq, ilike, inArray, sql, type SQL } from "drizzle-orm";
import {
  agents,
  authUsers,
  companyMemberships,
  externalObjectMentions,
  externalObjects,
  issueExecutionDecisions,
  issueDeliveryReceiptLinks,
  issueDeliveryReceipts,
  issues,
  executionWorkspaces,
  projectWorkspaces,
} from "@paperclipai/db";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import {
  isGitHubTokenResolution,
  resolveControlPlaneGitHubToken,
  resolveGitHubTokenCandidatesForRepo,
  resolveGitHubTokenForRepo,
  type GitHubTokenResolution,
} from "./github-credential.js";
import { inheritedExecutionWorkspaceBranchExempt } from "./execution-workspace-policy.js";
import { isStrictAncestorIssueIdOf } from "./issues.js";
import {
  claimDeliveryReceiptForPublication,
  consumeDeliveryReceipt,
  invalidateDeliveryReceipt,
  type DeliveryReceiptClaim,
} from "./delivery-receipt-recovery.js";

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

/**
 * Stamp eligibility requires every pre-merge review/approval stage to be
 * completed and the last recorded decision to be approved. Omitted phases are
 * pre-merge for existing policies. Post-merge stages still gate card completion,
 * but must not hold the merge stamp pending evidence that requires a merge.
 *
 * Shared by the post-approval hook, reconciler, and merge actuator; pure read of
 * policy/state with no I/O.
 */
export function ladderIsTerminallyApproved(
  policy: { stages?: Array<Pick<IssueExecutionStage, "id" | "phase">> } | null | undefined,
  state: { completedStageIds?: string[]; lastDecisionOutcome?: string | null } | null | undefined,
): boolean {
  return ladderIncompleteStageIds(policy, state).length === 0 && state?.lastDecisionOutcome === "approved";
}

export function ladderIncompleteStageIds(
  policy: { stages?: Array<Pick<IssueExecutionStage, "id" | "phase">> } | null | undefined,
  state: { completedStageIds?: string[] } | null | undefined,
): string[] {
  const completedIds = state?.completedStageIds ?? [];
  return (policy?.stages ?? [])
    .filter((s) => s.phase !== "post_merge" && !completedIds.includes(s.id))
    .map((s) => s.id);
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
  /**
   * SUP-15394: the PR this `armed` outcome CERTIFIED — the exact
   * owner/repo/number (plus the fields the arming actuator needs) that
   * publishApprovalStatus resolved, delivery-identity-gated, and stamped
   * paperclip/approved on. The post-approval close hook hands it to
   * armMergeOnApproval so the actuator arms EXACTLY the PR the publisher
   * certified. A second, independent resolveLinkedPullRequests call was the
   * SUP-15393 root cause: on the zero-mention card the two resolvers disagreed
   * and the arming refused a PR the publisher had already stamped.
   *
   * Optional: callers that do not arm (the reconciler's Guard A re-publish)
   * ignore it, and armMergeOnApproval falls back to its own cached resolve when
   * no certified subject is supplied.
   */
  certifiedPr?: LinkedPullRequest | null;
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

/**
 * SUP-15016: the `no-pr` certification anchor. When an approval's PR resolution
 * is `no-pr` (no open linked PR resolvable at decision time) but the card has an
 * OWN, readable delivery branch, the delivery-branch head is certified at
 * approval time and persisted under executionState.approvalStatus.pendingCandidates
 * exactly like the ambiguous class — giving the approval-status reconciler a
 * concrete anchor to verify against instead of falling back to the
 * always-unsatisfiable temporal sha-existence proof (SUP-14844). `headSha` is
 * null when the branch ref cannot be read; the consumer must fail closed on
 * null, never guess.
 */
export interface NoPrBranchAnchor {
  owner: string;
  repo: string;
  branch: string;
  /** The delivery-branch head SHA captured at approval time, or null when the ref could not be read. */
  headSha: string | null;
  /** ISO-8601 timestamp of the approval-time certification. */
  certifiedAt: string;
  /** Discriminator: this anchor was produced by the no-pr delivery-branch certification. */
  source: "no-pr-branch";
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
  /**
   * True when the cached/live PR is a draft. Populated by the card resolvers
   * (`resolveLinkedPullRequests` / `resolveLinkedPullRequestsWithState` /
   * `resolveCardPullRequest`); absent on arming-path constructions that do not
   * care about draft-ness. The done-close-landing backstop reads this to report
   * a draft-stranded `done` card (SUP-16689); treat absent as non-draft.
   */
  draft?: boolean;
  /** Live head repository of a hydrated PR; absent on cached mention rows. */
  headRepoFullName?: string | null;
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
  options: { includeDrafts?: boolean } = {},
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
    if (!options.includeDrafts && draft === true) continue;
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
        draft: draft === true,
        headRepoFullName: readString(row.data?.headRepoFullName),
      });
  }

  return results;
}

export async function resolveLinkedPullRequestsWithState(
  db: Db,
  companyId: string,
  issueId: string,
  options: { includeDrafts?: boolean } = {},
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
    if (!options.includeDrafts && draft === true) continue;

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
        draft: draft === true,
        headRepoFullName: readString(row.data?.headRepoFullName),
      });
  }

  return results;
}

// ---------------------------------------------------------------------------
// SUP-14917: card pull-request resolution.
//
// A card's PR could be resolved two ways that lived in DIFFERENT places:
//   - merge-arming's zero-mention live re-resolve (derive the repo pair from the
//     card's own workspace context and ask GitHub for open PRs naming the
//     card's identifier), and
//   - the approval-status reconciler / done-close-landing backstop, which only
//     looked at cached external-object mentions and therefore could NOT see a
//     card whose PR was delivered from a workspace with zero external-object
//     mentions ever posted (the SUP-14737 / PR 455 shape).
// This unifies the live discovery into one function the three call sites share,
// so they can no longer disagree about WHICH PR a card delivered.
// ---------------------------------------------------------------------------

/**
 * One open PR discovered by the shared live workspace re-resolve, tagged with
 * the token candidate that read it so a caller can issue a follow-up (head SHA,
 * commit-status write) under the same credential.
 */
export interface WorkspacePullRequestMatch {
  owner: string;
  repo: string;
  number: number;
  displayName: string;
  headRefName: string | null;
  /** The PR title as GitHub reported it in the open-PR list, or null. Carried so a certified subject can reproduce the SUP-13361 title-OR-branch ownership check (SUP-15394). */
  title: string | null;
  /** True when the live open PR is a draft (SUP-16689: the backstop reports a draft-stranded `done` card instead of arming it). */
  draft: boolean;
  candidate: GitHubTokenResolution;
}

/**
 * A terminal failure of the shared live workspace discovery, captured as DATA
 * (not an outcome) so each caller maps it to ITS OWN message/verdict form
 * (publishApprovalStatus's `status:failed:` strings vs
 * resolveApprovalDecisionHead's bare reasons) without the discovery code
 * knowing either format.
 */
export interface WorkspaceDiscoveryFailure {
  owner: string;
  repo: string;
  /** GitHub HTTP status; -1 sentinel for the no-token case. */
  status: number;
  message: string | null;
  /** True when no usable token candidate resolved for the pair. */
  noToken: boolean;
  /** tokenResult.reason when noToken && !isGitHubTokenResolution. */
  tokenReason: string | null;
  /** True when noToken && isGitHubTokenResolution ("no GitHub token resolvable"). */
  tokenUnresolvable: boolean;
  /** Terminal 401/403 candidate's scope/secretName (single-candidate suffix form). */
  terminalScope: string | null;
  terminalSecretName: string | null;
  /** `${scope}/${secretName}` per candidate, for the multi-candidate "(tried: ...)" form. */
  tried: string[];
  /** Number of token candidates at the failure point (single vs multi). */
  candidateCount: number;
}

export interface WorkspaceDiscoveryResult {
  matched: WorkspacePullRequestMatch[];
  terminalFailure: WorkspaceDiscoveryFailure | null;
}

/**
 * SUP-17162: the discovery-side ownership boundary. A PR is a candidate for a
 * card ONLY when it is ANCHORED to that card. An identifier CITED anywhere —
 * mid-slug in a branch, mid-string in a title, or anywhere in the body — is a
 * cross-reference, not a delivery claim, and must never by itself establish
 * ownership (the SUP-17075 -> #760 false re-open: a sibling's PR whose branch
 * slug and body both cite the card's identifier). This brings discovery under the
 * same boundary the ADR-091 D1 publish gate already enforces:
 *   - branch: the head ref carries the card's identifier PREFIX (`{identifier}-`),
 *     or IS the card's own legitimate delivery branch (exact-branch, the
 *     `branchIsOwn` half of the D1 gate); and
 *   - title: the identifier LEADS the title (the SUP-13361 shared-branch shape,
 *     where a child PR carries the approving card's identifier in the title, not
 *     the branch).
 * `deliveryBranch` is the card's control-plane delivery branch (its legitimate
 * execution-workspace branch), lowercased, or null when it has no such branch.
 * `branchIsOwn` mirrors the publish gate: only the card's OWN delivery branch uses
 * the exact-branch predicate; a shared carrier branch resolves by prefix, never by
 * an exact match on a branch this card does not own. `headRef`/`title`/`identifier`
 * are pre-lowercased by the caller.
 */
export function isAnchoredCardPullRequest(
  headRef: string,
  title: string,
  identifier: string,
  deliveryBranch: string | null,
  branchIsOwn: boolean,
): boolean {
  if (headRef.startsWith(`${identifier}-`)) return true;
  if (branchIsOwn && deliveryBranch !== null && deliveryBranch !== "" && headRef === deliveryBranch) {
    return true;
  }
  return isTitleLedByIdentifier(title, identifier);
}

/**
 * SUP-17162: true when the identifier LEADS the title — the conventional leading
 * form, not a citation anywhere in the string. Accepts the identifier at the very
 * head ("SUP-42: ..." / "sup-42 ...") and the conventional-commit leading verb
 * form ("fix(SUP-42): ..."). A longer identifier that merely shares the prefix
 * (sup-17075 vs sup-170750) is rejected by the non-digit boundary. Lowercased.
 */
function isTitleLedByIdentifier(title: string, identifier: string): boolean {
  const boundaryOk = (s: string) => {
    const next = s.charAt(identifier.length);
    return next === "" || !/\d/.test(next);
  };
  if (title.startsWith(identifier) && boundaryOk(title)) return true;
  const conventional = /^[a-z0-9]+\(/.exec(title);
  if (conventional) {
    const rest = title.slice(conventional[0].length);
    if (rest.startsWith(identifier) && boundaryOk(rest)) return true;
  }
  return false;
}

/**
 * SUP-14917: the shared live workspace re-resolve. Derives candidate
 * owner/repo pairs from the card's cached mentions (any state) and, when there
 * are none, from the card's own repo context (closing transitions only). For
 * each pair it walks the resolvable GitHub token candidates and asks GitHub for
 * open, non-draft PRs whose head ref / title / body names the card's
 * identifier. This is EXACTLY the loop merge-arming's two zero-mention
 * fallbacks used to inline; it now returns the matches + a terminal failure as
 * data so all three call sites share one discovery algorithm.
 *
 * `withState` is the card's cached external-object PR rows in ALL states
 * (drafts already dropped) — the caller resolves them so the discovery derives
 * pairs without a second query and so `resolveCardPullRequest` can cross-check
 * the mention set against the live result.
 */
async function discoverCardPullRequestByWorkspace(
  db: Db,
  companyId: string,
  issueId: string,
  issueIdentifier: string,
  closingTransition: boolean,
  withState: LinkedPullRequest[],
  includeDrafts = false,
): Promise<WorkspaceDiscoveryResult> {
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
  // SUP-17162: resolve the card's control-plane delivery branch ONCE so the
  // per-PR ownership test below is anchored to the same boundary the ADR-091 D1
  // publish gate enforces. `legitimate`/`branchIsOwn` mirror the gate: only the
  // card's own legitimate delivery branch contributes the exact-branch half.
  const deliveryOwnership = await resolveCardDeliveryBranchOwnership(db, companyId, issueId);
  const deliveryBranch =
    deliveryOwnership.legitimate && deliveryOwnership.branch !== null
      ? deliveryOwnership.branch.toLowerCase()
      : null;
  const deliveryBranchIsOwn = deliveryOwnership.branchIsOwn;
  const matched: WorkspacePullRequestMatch[] = [];
  let terminalFailure: WorkspaceDiscoveryFailure | null = null;

  for (const pair of pairs) {
    const candidates = await resolveGitHubTokenCandidatesForRepo(db, companyId, pair.owner, pair.repo);
    if (candidates.length === 0) {
      const tokenResult = await resolveGitHubTokenForRepo(db, companyId, pair.owner, pair.repo);
      const unresolvable = isGitHubTokenResolution(tokenResult);
      terminalFailure = {
        owner: pair.owner,
        repo: pair.repo,
        status: -1,
        message: null,
        noToken: true,
        tokenUnresolvable: unresolvable,
        tokenReason: unresolvable ? null : tokenResult.reason,
        terminalScope: null,
        terminalSecretName: null,
        tried: [],
        candidateCount: 0,
      };
      break;
    }

    for (const candidate of candidates) {
      const listResult = await fetchOpenPullRequests(candidate.token, pair.owner, pair.repo);
      if (!listResult.ok) {
        const { status, message } = listResult;
        const isLast = candidate === candidates[candidates.length - 1];
        const tried = candidates.map((c) => `${c.scope}/${c.secretName}`);
        if (status === 401 || status === 403) {
          if (isLast) {
            terminalFailure = {
              owner: pair.owner,
              repo: pair.repo,
              status,
              message,
              noToken: false,
              tokenUnresolvable: false,
              tokenReason: null,
              terminalScope: candidate.scope,
              terminalSecretName: candidate.secretName,
              tried,
              candidateCount: candidates.length,
            };
          }
          if (!isLast) continue;
        } else {
          terminalFailure = {
            owner: pair.owner,
            repo: pair.repo,
            status,
            message,
            noToken: false,
            tokenUnresolvable: false,
            tokenReason: null,
            terminalScope: null,
            terminalSecretName: null,
            tried,
            candidateCount: candidates.length,
          };
        }
        break;
      }

      for (const item of listResult.items) {
        if (!includeDrafts && item.draft === true) continue;
        const headRef = (item.headRef ?? "").toLowerCase();
        const title = (item.title ?? "").toLowerCase();
        // SUP-17162: an identifier cited anywhere — mid-slug in the branch,
        // mid-string in the title, or anywhere in the body — is a cross-reference,
        // not a delivery claim, and must never by itself establish ownership. A PR
        // is a candidate only when it is ANCHORED to the card: the branch carries
        // the card's identifier prefix (or IS its own legitimate delivery branch),
        // or the title leads with the card's identifier (the SUP-13361
        // shared-branch shape). This mirrors the ADR-091 D1 publish gate.
        if (!isAnchoredCardPullRequest(headRef, title, needle, deliveryBranch, deliveryBranchIsOwn)) {
          continue;
        }
        matched.push({
          owner: pair.owner,
          repo: pair.repo,
          number: item.number,
          displayName: `${pair.owner}/${pair.repo}#${item.number}`,
          headRefName: item.headRef ?? null,
          title: item.title ?? null,
          draft: item.draft === true,
          candidate,
        });
      }
      break;
    }
    if (terminalFailure) break;
  }

  return { matched, terminalFailure };
}

/**
 * SUP-14917: map a shared live-discovery terminal failure to
 * publishApprovalStatus's `status:failed:` outcome form. Byte-identical to the
 * strings the publisher used to emit inline, so the publisher's message
 * contract is unchanged whether or not the discovery is extracted.
 */
function armingFailureFromWorkspaceDiscovery(f: WorkspaceDiscoveryFailure): ArmingOutcome {
  if (f.noToken) {
    if (f.tokenUnresolvable) {
      return {
        kind: "failed",
        message: `status:failed:auth_required: No GitHub token resolvable for ${f.owner}/${f.repo} (scope=null, secretName=null)`,
      };
    }
    return {
      kind: "failed",
      message: `status:failed:auth_required: ${f.tokenReason} (scope=null, secretName=null)`,
    };
  }
  if (f.status === 404) {
    return { kind: "failed", message: `status:failed:pr_not_found: HTTP 404 ${f.message ?? ""}` };
  }
  if (f.status === 429) {
    return { kind: "failed", message: `status:failed:pr_rate_limited: HTTP 429 ${f.message ?? ""}` };
  }
  if (f.status === 0) {
    return { kind: "failed", message: `status:failed:pr_network: ${f.message ?? "network_error"}` };
  }
  if (f.status === 401 || f.status === 403) {
    if (f.candidateCount === 1) {
      return {
        kind: "failed",
        message: `status:failed:pr_auth: HTTP ${f.status} ${f.message ?? ""} (scope=${f.terminalScope}, secretName=${f.terminalSecretName})`,
      };
    }
    return {
      kind: "failed",
      message: `status:failed:pr_auth: HTTP ${f.status} ${f.message ?? ""} (tried: ${f.tried.join(", ")})`,
    };
  }
  return { kind: "failed", message: `status:failed:pr_error: HTTP ${f.status} ${f.message ?? ""}` };
}

/**
 * SUP-14917: map a shared live-discovery terminal failure to
 * resolveApprovalDecisionHead's bare `reason` form. These are deliberately
 * SHORTER than the publisher's strings (no `status:failed:` prefix, no
 * scope/secretName suffix, no `${message}` on 404/429) — matching the
 * resolver's existing reason contract byte-for-byte.
 */
function decisionHeadFailureFromWorkspaceDiscovery(f: WorkspaceDiscoveryFailure): DecisionHeadResolution {
  if (f.noToken) {
    if (f.tokenUnresolvable) {
      return {
        kind: "unresolvable",
        reason: `auth_required: no GitHub token resolvable for ${f.owner}/${f.repo}`,
      };
    }
    return { kind: "unresolvable", reason: `auth_required: ${f.tokenReason}` };
  }
  if (f.status === 404) return { kind: "unresolvable", reason: "pr_not_found: HTTP 404" };
  if (f.status === 429) return { kind: "unresolvable", reason: "pr_rate_limited: HTTP 429" };
  if (f.status === 0) {
    return { kind: "unresolvable", reason: `pr_network: ${f.message ?? "network_error"}` };
  }
  if (f.status === 401 || f.status === 403) {
    return { kind: "unresolvable", reason: `pr_auth: HTTP ${f.status} ${f.message ?? ""}` };
  }
  return { kind: "unresolvable", reason: `pr_error: HTTP ${f.status} ${f.message ?? ""}` };
}

/**
 * SUP-14917: the card-level "which PR did this card deliver?" verdict, shared by
 * the approval-status reconciler and the done-close-landing backstop so they can
 * no longer disagree with merge-arming about the card's PR.
 *
 *   - mention-resolved: the cached OPEN-mention set is authoritative. Exactly one
 *     open mention -> `single` (source "mention"); more than one -> `ambiguous`.
 *     NO live GitHub call is made on this path.
 *   - workspace-resolved: zero cached open mentions -> run the shared live
 *     workspace discovery. A terminal live failure -> `undetermined` (the caller
 *     skips transiently, never treats it as "no PR"); zero matches -> `none`;
 *     one match with no conflicting cached mention -> `single` (source
 *     "workspace"); two or more matches, or a cached mention (closed/unhydrated)
 *     that DISAGREES with the single live match -> `ambiguous` (AC4).
 */
export type CardPullRequestResolution =
  | {
      kind: "single";
      owner: string;
      repo: string;
      number: number;
      displayName: string;
      headRefName: string | null;
      source: "mention" | "workspace";
      /** True when the resolved PR is a draft (SUP-16689). */
      draft: boolean;
    }
  | { kind: "ambiguous"; reason: string; displayNames: string[] }
  | { kind: "none" }
  | { kind: "undetermined"; reason: string; failure: WorkspaceDiscoveryFailure };

export async function resolveCardPullRequest(
  db: Db,
  companyId: string,
  issueId: string,
  issueIdentifier: string,
  options: { closingTransition?: boolean; includeDrafts?: boolean } = {},
): Promise<CardPullRequestResolution> {
  const includeDrafts = options.includeDrafts ?? false;
  const openMentions = await resolveLinkedPullRequests(db, companyId, issueId, { includeDrafts });

  if (openMentions.length > 0) {
    if (openMentions.length === 1) {
      const pr = openMentions[0]!;
      return {
        kind: "single",
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
        displayName: pr.displayName,
        headRefName: pr.headRefName,
        source: "mention",
        draft: pr.draft === true,
      };
    }
    return {
      kind: "ambiguous",
      reason: "multiple-cached-open-mentions",
      displayNames: openMentions.map((pr) => pr.displayName),
    };
  }

  const withState = await resolveLinkedPullRequestsWithState(db, companyId, issueId, { includeDrafts });
  const discovery = await discoverCardPullRequestByWorkspace(
    db,
    companyId,
    issueId,
    issueIdentifier,
    options.closingTransition ?? true,
    withState,
    includeDrafts,
  );
  if (discovery.terminalFailure) {
    return {
      kind: "undetermined",
      reason: "live-discovery-failed",
      failure: discovery.terminalFailure,
    };
  }
  if (discovery.matched.length === 0) {
    return { kind: "none" };
  }
  if (discovery.matched.length > 1) {
    return {
      kind: "ambiguous",
      reason: "multiple-live-matches",
      displayNames: discovery.matched.map((pr) => pr.displayName),
    };
  }

  const single = discovery.matched[0]!;
  const singleKey = `${single.owner.toLowerCase()}/${single.repo.toLowerCase()}#${single.number}`;
  // AC4: a cached mention (closed or unhydrated — hence filtered out of the open
  // set above) that points at a DIFFERENT PR than the one the live workspace
  // discovery found means the mention-resolved and workspace-resolved answers
  // disagree. That is ambiguous, not a single.
  for (const row of withState) {
    const key = `${row.owner.toLowerCase()}/${row.repo.toLowerCase()}#${row.number}`;
    if (key !== singleKey && row.cachedState !== "open") {
      return {
        kind: "ambiguous",
        reason: "mention-workspace-disagreement",
        displayNames: [single.displayName, row.displayName],
      };
    }
  }
  return {
    kind: "single",
    owner: single.owner,
    repo: single.repo,
    number: single.number,
    displayName: single.displayName,
    headRefName: single.headRefName,
    source: "workspace",
    draft: single.draft === true,
  };
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
 *
 * SUP-17273: the approval-time node-id read is a head/PR resolution read, so it
 * gets the same bounded transient retry as the PR-head reads. A transient
 * 500/502/503/504 or network error is retried on the SAME token; a 4xx (incl.
 * 401/403/404) is deterministic and returns immediately, so the caller's
 * candidate rotation and the `failed:node_id_missing` / `failed:pr_auth`
 * message prefixes are preserved exactly.
 */
export async function fetchGitHubNodeId(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<GitHubNodeIdResult> {
  return withTransientReadRetry(() => fetchGitHubNodeIdOnce(token, owner, repo, number));
}

async function fetchGitHubNodeIdOnce(
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

/**
 * Each enable request is given up on (and its HTTP request aborted) after this long, so a call is over within
 * `ENABLE_WORST_CASE_MS` (attempts, back-off included), well under the in-flight record's grace (`disarmTiming.inFlightGraceMs`).
 */
export const ENABLE_ATTEMPT_TIMEOUT_MS = 10_000;
export const ENABLE_WORST_CASE_MS = 3 * ENABLE_ATTEMPT_TIMEOUT_MS + 250 + 500;
/** The deadline an enable call gets when the caller names none (a mutable object so a test can shorten it). */
export const enableTiming: { attemptTimeoutMs: number } = { attemptTimeoutMs: ENABLE_ATTEMPT_TIMEOUT_MS };

export interface EnableAutoMergeOptions {
  /** Per-request bound in ms (the request is aborted at it); defaults to ENABLE_ATTEMPT_TIMEOUT_MS. */
  attemptTimeoutMs?: number;
  /** Total attempts for the arming mutation; the first call counts as attempt 1. Defaults to 3. */
  maxAttempts?: number;
  /** Base delay between attempts in ms; doubles on each retry. Defaults to 250. */
  retryDelayMs?: number;
  /** Injectable sleep, for tests. Defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * The head the arm is authorized for. GitHub then refuses the mutation if the PR's head is
   * something else, so an authorization given for one head cannot arm another (SUP-20772).
   */
  expectedHeadOid?: string;
  /**
   * Called before EVERY attempt, the first and each retry. A non-null answer (why the authority no longer
   * holds) stops the call with that reason and the mutation is not sent: a retry must not be the moment an
   * approval that was revoked in between gets armed.
   */
  beforeAttempt?: () => Promise<string | null>;
}

/**
 * SUP-16088: the arming mutation is retried on a TRANSIENT transport failure —
 * a 5xx gateway error or a 429 rate-limit. The located cause of the SUP-16050
 * miss was exactly this: a real `HTTP 502` response (not a thrown error) landed
 * in the `!response.ok` branch as `{ success: false, status: 5xx }` and was
 * returned to the caller as a terminal `failed:HTTP 502`, so #676 sat stamped
 * and authorized but unqueued until the hourly backstop re-armed it 1h46m later.
 *
 * `enablePullRequestAutoMerge` is idempotent: replaying it on an already-queued
 * PR returns `alreadyQueued`/success, so retrying a transient 5xx is safe.
 *
 * Deliberately NOT retried: 401/403 — the caller's candidate loop rotates tokens
 * on those, so surfacing them immediately is required; other 4xx — a permanent
 * client error a retry cannot clear; and status 0 (a thrown ghFetch /
 * `network_error`) — a hard connection reset is not the located cause, and
 * retrying it inside the mutation would change the existing `failed:network_error`
 * contract the tests pin.
 */
function isTransientArmingStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * An accepted arm that the card's authority no longer backs, and that could not be turned off at once
 * (a 403, a 5xx, a timeout). It is kept on the card (`executionState.approvalStatus.autoMergeDisarm`) and
 * retried on every reconciler tick until GitHub confirms auto-merge is off, so an accepted arm is never
 * left silently in force.
 */
export interface PendingAutoMergeDisarm {
  owner: string;
  repo: string;
  number: number;
  nodeId: string;
  headSha: string | null;
  reason: string;
  since: string;
  attempts: number;
  lastError: string | null;
  lastAttemptAt?: string | null;
  /**
   * `in_flight`: written BEFORE the enable call, so an arm GitHub accepts is covered even if this process dies or the
   * database is unreachable right after (once its grace is over the sweep takes it back unconditionally, whether or not
   * the authority changed). `pending` (or absent): the arm is known to be in force without authority and is taken back.
   */
  state?: "in_flight" | "pending";
  /** Names one arm attempt, so a finished attempt clears only its own record. */
  token?: string;
  /** The authority fingerprint the arm was authorized against (in_flight records only; kept for whoever reads the card, no code decides from it). */
  baseline?: string | null;
  requireApprovedLadder?: boolean;
  /** Set once, when the take-back has stayed unconfirmed for `disarmEscalation.afterMs`: the card needs a human (see disarmEscalation). */
  escalatedAt?: string | null;
  /** Set once GitHub accepted the `paperclip/approved` failure on the head (see fenceRevokedHead): the head cannot merge while the arm stays on. */
  fencedAt?: string | null;
  /** Why the last fence write failed, until one is accepted. */
  fenceError?: string | null;
  /**
   * The arm is settled (auto-merge is off, or it stands with its authority) and only the arm gate (see ARM_GATE_CONTEXT) is
   * still open: the sweep writes the closing success until GitHub accepts it, and the record goes with it.
   */
  gateClosing?: boolean;
}

/** The reason a swept in-flight record is rewritten with: nothing says the authority changed, only that the arm was never settled. */
export const INTERRUPTED_ARM_REASON = "arm interrupted before it was settled";

/**
 * The second route for a take-back GitHub does not confirm. Turning auto-merge off is one GraphQL mutation; when it keeps
 * failing the arm stays on, but GitHub merges on required checks, and the newest `paperclip/approved` status decides
 * (also in scripts/ci/check-paperclip-approved.sh, which is what a merge-queue run asks). So the head's status is
 * overwritten with a control-plane `failure` over REST: a different endpoint and permission (statuses, not pull-request
 * auto-merge), after which the armed PR cannot land until a fresh approval or board release writes a newer success.
 * Bounded per token; answers whether GitHub accepted it. Never throws.
 */
export const FENCE_ATTEMPT_TIMEOUT_MS = 10_000;
export const REVOKED_HEAD_STATUS_DESCRIPTION = "revoked: the approval no longer holds and auto-merge could not be turned off; needs a new approval";

/**
 * Writes one control-plane commit status on a head over REST, bounded per token (10 s for the whole try, retries included).
 * `headSha` null: the PR's live head is read first. 401/403 and any other refusal move on to the next token. Never throws.
 */
async function writeHeadStatus(
  tokens: string[],
  record: { owner: string; repo: string; number: number; headSha: string | null },
  status: { context: string; state: "success" | "failure"; description: string },
): Promise<{ written: boolean; error: string | null }> {
  let error: string | null = "no GitHub token candidate";
  for (const token of tokens) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FENCE_ATTEMPT_TIMEOUT_MS);
      try {
        const bounded = async (): Promise<{ written: boolean; error: string | null }> => {
          let head = record.headSha && /^[0-9a-f]{40}$/i.test(record.headSha) ? record.headSha : null;
          if (!head) {
            const live = await fetchPullRequestHeadSha(token, record.owner, record.repo, record.number, controller.signal);
            if (!live.ok) return { written: false, error: `could not read the PR head (${live.message ?? `HTTP ${live.status}`})` };
            head = live.headSha;
          }
          const written = await writeCommitStatusWithRetry(token, record.owner, record.repo, head, "", {
            description: status.description, state: status.state, context: status.context, attempts: 2, delayMs: 250, signal: controller.signal,
          });
          return written.success ? { written: true, error: null } : { written: false, error: written.error ?? `HTTP ${written.status}` };
        };
        const answer = await Promise.race([
          bounded(),
          new Promise<{ written: false; error: string }>((resolve) => controller.signal.addEventListener("abort", () => resolve({ written: false, error: `timeout after ${FENCE_ATTEMPT_TIMEOUT_MS}ms` }), { once: true })),
        ]);
        if (answer.written) return answer;
        error = answer.error;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  return { written: false, error };
}

export async function fenceRevokedHead(
  tokens: string[],
  record: { owner: string; repo: string; number: number; headSha: string | null },
): Promise<{ fenced: boolean; error: string | null }> {
  const result = await writeHeadStatus(tokens, record, { context: "paperclip/approved", state: "failure", description: REVOKED_HEAD_STATUS_DESCRIPTION });
  return { fenced: result.written, error: result.error };
}

/**
 * The arm gate: the status that keeps a head unmergeable for as long as an arm of it is unsettled, written BEFORE the
 * enable call, while GitHub is demonstrably reachable (the take-back and the fence are both GitHub writes made AFTER the
 * arm, so a provider that refuses both would leave nothing on GitHub). `failure` is written first and is replaced by a
 * `success` only once the arm is settled (taken back and confirmed off, or standing with its authority). The CI check
 * (scripts/ci/check-paperclip-approved.sh) refuses a head whose newest control-plane `paperclip/arm-gate` is not a success,
 * and nothing but the control plane's own identity can clear it. A head with no such status is judged as before.
 */
export const ARM_GATE_CONTEXT = "paperclip/arm-gate";
export const ARM_GATE_OPEN_DESCRIPTION = "an auto-merge arm of this head is unsettled; not mergeable until the control plane confirms it";
export const ARM_GATE_CLOSED_DESCRIPTION = "arm settled: auto-merge is off or stands with its authority";

export async function writeArmGate(
  tokens: string[],
  record: { owner: string; repo: string; number: number; headSha: string | null },
  state: "open" | "closed",
): Promise<{ written: boolean; error: string | null }> {
  return writeHeadStatus(tokens, record, {
    context: ARM_GATE_CONTEXT,
    state: state === "open" ? "failure" : "success",
    description: state === "open" ? ARM_GATE_OPEN_DESCRIPTION : ARM_GATE_CLOSED_DESCRIPTION,
  });
}

/**
 * The finite bound on how long an unconfirmed take-back is just retried. A record older than `afterMs` (measured from its
 * `since`, read at the moment it is looked at, so it holds with no sweep or scheduler running) is escalated: every
 * control-plane arm of that card is refused (`failed:disarm-escalated`), the sweep marks it `escalatedAt` and raises the
 * `issue.merge_disarm_escalated` alert, and a human has to turn auto-merge off (the retries go on, so a confirmation
 * still clears it). A mutable object so a test can lower it.
 */
export const disarmEscalation: { afterMs: number } = { afterMs: 15 * 60_000 };

export function disarmRecordEscalated(record: { since?: string | null; escalatedAt?: string | null }, now = Date.now()): boolean {
  if (record.escalatedAt) return true;
  const since = Date.parse(record.since ?? "");
  return !Number.isNaN(since) && now - since >= disarmEscalation.afterMs;
}

/**
 * Most records (in flight or pending) the instance holds at once (a mutable object so a test can lower it). It is a hard
 * cap: admission is serialised by an advisory lock, so the backlog never exceeds it and a sweep, which takes this many,
 * tries every record each time: a disable is never dropped and never starved.
 */
export const disarmBacklog: { cap: number } = { cap: 50 };

const RECORD_PATH = sql`(${issues.executionState} -> 'approvalStatus' -> 'autoMergeDisarm')`;

/**
 * Writes the in-flight record before an enable call, in one statement (under the admission lock) that also checks there
 * is no record on the card yet and fewer than `disarmBacklog.cap` on the instance. `exists`: a take-back or another arm
 * already holds the card. `escalated`: the record on the card has outlived `disarmEscalation.afterMs`. `full`: the
 * backlog is at its cap. In every case nothing may be armed.
 */
export async function openArmInFlight(db: Db, companyId: string, issueId: string, record: PendingAutoMergeDisarm): Promise<"recorded" | "exists" | "escalated" | "full"> {
  const patch = JSON.stringify({ autoMergeDisarm: record });
  const rows = await db.transaction(async (tx) => {
    // One admission at a time, so the count below cannot be raced past the cap.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('paperclip:auto-merge-disarm-admission'))`);
    return tx
      .update(issues)
      .set({
        executionState: sql`jsonb_set(coalesce(${issues.executionState}, '{}'::jsonb), '{approvalStatus}',
        coalesce(${issues.executionState} -> 'approvalStatus', '{}'::jsonb) || ${patch}::jsonb)`,
      })
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.id, issueId),
        sql`${RECORD_PATH} is null`,
        sql`(select count(*) from "issues" as other where other."execution_state" -> 'approvalStatus' -> 'autoMergeDisarm' is not null) < ${disarmBacklog.cap}`,
      ))
      .returning({ id: issues.id });
  });
  if (rows.length > 0) return "recorded";
  const [row] = await db.select({ executionState: issues.executionState }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  const existing = ((row?.executionState as Record<string, unknown> | null)?.approvalStatus as Record<string, unknown> | undefined)?.autoMergeDisarm;
  if (!existing) return "full";
  return disarmRecordEscalated(existing as { since?: string; escalatedAt?: string }) ? "escalated" : "exists";
}

/** Removes the card's record; with a token, only when it is the record of that arm attempt. */
export async function clearAutoMergeDisarmRecord(db: Db, companyId: string, issueId: string, token?: string): Promise<void> {
  await db
    .update(issues)
    .set({
      executionState: sql`jsonb_set(coalesce(${issues.executionState}, '{}'::jsonb), '{approvalStatus}',
        coalesce(${issues.executionState} -> 'approvalStatus', '{}'::jsonb) - 'autoMergeDisarm')`,
    })
    .where(and(
      eq(issues.companyId, companyId),
      eq(issues.id, issueId),
      ...(token ? [sql`${RECORD_PATH} ->> 'token' = ${token}`] : []),
    ));
}

/** Writes the record into the card's approvalStatus subtree atomically (other keys are preserved). */
export async function recordPendingAutoMergeDisarm(db: Db, companyId: string, issueId: string, record: PendingAutoMergeDisarm): Promise<void> {
  const patch = JSON.stringify({ autoMergeDisarm: record });
  await db
    .update(issues)
    .set({
      executionState: sql`jsonb_set(coalesce(${issues.executionState}, '{}'::jsonb), '{approvalStatus}',
        coalesce(${issues.executionState} -> 'approvalStatus', '{}'::jsonb) || ${patch}::jsonb)`,
    })
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
}

/** True for the outcome of an arm that `openArmRecord` refused: nothing was sent to GitHub. */
export function isArmRecordRefusal(message: string): boolean {
  return /^(?:failed:disarm-record-unavailable|skipped:arm-in-progress|failed:disarm-escalated|failed:disarm-backlog-full|failed:arm-gate-unavailable):/.test(message);
}

export type ArmRecordOpening =
  | { ok: true; forget: () => Promise<void>; settleEnable: (result: { success: boolean; error: string | null; status: number }) => Promise<void> }
  | { ok: false; kind: "failed" | "skipped"; message: string };

/**
 * Every enable call goes through this first: it writes the in-flight take-back record (see openArmInFlight) and refuses
 * the arm when the record cannot be written, the card already holds one, or the backlog is at its cap. `settleEnable`
 * is told how the enable call ended: an answer that is not an acceptance drops the record (nothing is armed); no
 * answer (a network error, a 5xx) keeps it and starts the prompt retries, because the arm may be in force. `forget`
 * drops the record once the caller knows the arm is settled (it stands with its authority, or it was taken back).
 */
export async function openArmRecord(
  db: Db,
  companyId: string,
  issueId: string,
  pr: { owner: string; repo: string; number: number },
  label: string,
  nodeId: string,
  headSha: string | null,
  guard: AuthorityGuard,
): Promise<ArmRecordOpening> {
  const token = randomUUID();
  // The tokens the arm gate and its closing are written with, and the head they are written to (read live when the
  // caller named none, so the gate and its closing always name the same commit).
  let tokens: string[];
  let head = headSha;
  try {
    tokens = (await resolveGitHubTokenCandidatesForRepo(db, companyId, pr.owner, pr.repo)).map((candidate) => candidate.token);
    for (const candidate of tokens) {
      if (head) break;
      const live = await fetchPullRequestHeadSha(candidate, pr.owner, pr.repo, pr.number);
      if (live.ok) head = live.headSha;
    }
  } catch (error) {
    return { ok: false, kind: "failed", message: `failed:arm-gate-unavailable: ${label} — the arm gate could not be prepared (${error instanceof Error ? error.message : String(error)}); nothing was armed` };
  }
  if (!head) {
    return { ok: false, kind: "failed", message: `failed:arm-gate-unavailable: ${label} — the head the arm gate names could not be read; nothing was armed` };
  }
  const since = new Date().toISOString();
  let opened: "recorded" | "exists" | "escalated" | "full";
  try {
    opened = await openArmInFlight(db, companyId, issueId, {
      owner: pr.owner, repo: pr.repo, number: pr.number, nodeId, headSha: head,
      reason: "arm in flight", since, attempts: 0, lastError: null,
      state: "in_flight", token, baseline: guard.baseline, requireApprovedLadder: guard.requireApprovedLadder,
    });
  } catch (error) {
    return { ok: false, kind: "failed", message: `failed:disarm-record-unavailable: ${label} — the take-back record could not be written (${error instanceof Error ? error.message : String(error)}); nothing was armed` };
  }
  if (opened === "exists") {
    return { ok: false, kind: "skipped", message: `skipped:arm-in-progress: ${label} — a take-back or another arm is already recorded on this card; nothing was armed, the next pass tries again` };
  }
  if (opened === "escalated") {
    return { ok: false, kind: "failed", message: `failed:disarm-escalated: ${label} — a take-back on this card has gone unconfirmed for over ${Math.round(disarmEscalation.afterMs / 60_000)} minutes and needs a human to turn auto-merge off; nothing was armed` };
  }
  if (opened === "full") {
    return { ok: false, kind: "failed", message: `failed:disarm-backlog-full: ${label} — ${disarmBacklog.cap} auto-merge take-backs are already waiting to be confirmed; nothing was armed` };
  }
  const gateTarget = { owner: pr.owner, repo: pr.repo, number: pr.number, headSha: head };
  const startRetries = async () => { try { (await import("./auto-merge-disarm.js")).startPromptDisarmRetries(db, companyId, issueId); } catch { /* the tick still settles it */ } };
  // Closes the gate, then drops the record. If GitHub will not take the closing write the record stays, marked
  // `gateClosing`, and the sweep keeps writing it: the head stays unmergeable meanwhile (fail closed).
  const settle = async (): Promise<void> => {
    const closed = await writeArmGate(tokens, gateTarget, "closed").catch((error) => ({ written: false, error: String(error) }));
    if (closed.written) {
      await clearAutoMergeDisarmRecord(db, companyId, issueId, token).catch(() => undefined);
      return;
    }
    await recordPendingAutoMergeDisarm(db, companyId, issueId, {
      owner: pr.owner, repo: pr.repo, number: pr.number, nodeId, headSha: head, reason: "arm settled; the arm gate is still open",
      since, attempts: 1, lastError: closed.error, lastAttemptAt: new Date().toISOString(), state: "pending", token, gateClosing: true,
    }).catch(() => undefined);
    await startRetries();
  };
  // Written before the enable call, while GitHub answers: from here until `settle` the head is not mergeable.
  const gate = await writeArmGate(tokens, gateTarget, "open").catch((error) => ({ written: false, error: String(error) }));
  if (!gate.written) {
    // The write may have landed without an answer: the record stays, marked so the sweep closes the gate.
    await recordPendingAutoMergeDisarm(db, companyId, issueId, {
      owner: pr.owner, repo: pr.repo, number: pr.number, nodeId, headSha: head, reason: "the arm gate could not be opened; nothing was armed",
      since, attempts: 1, lastError: gate.error, lastAttemptAt: new Date().toISOString(), state: "pending", token, gateClosing: true,
    }).catch(() => undefined);
    await startRetries();
    return { ok: false, kind: "failed", message: `failed:arm-gate-unavailable: ${label} — the arm gate could not be written (${gate.error ?? "unknown"}); nothing was armed` };
  }
  return {
    ok: true,
    forget: settle,
    settleEnable: async (result) => {
      if (result.success) return;
      if (result.error === "network_error" || result.error?.startsWith("timeout after ") || isTransientArmingStatus(result.status)) {
        await startRetries();
      } else {
        await settle();
      }
    },
  };
}

/**
 * Keeps an arm that could not be turned off on the card, to be retried every reconciler tick until GitHub
 * confirms it is off. Answers a sentence for the outcome message. Never throws.
 */
export async function keepAutoMergeDisarmPending(
  db: Db,
  companyId: string,
  issueId: string,
  pr: { owner: string; repo: string; number: number },
  nodeId: string,
  headSha: string | null,
  reason: string,
  error: string | null,
): Promise<string> {
  const record: PendingAutoMergeDisarm = {
    owner: pr.owner, repo: pr.repo, number: pr.number, nodeId, headSha, reason,
    since: new Date().toISOString(), attempts: 1, lastError: error, lastAttemptAt: new Date().toISOString(), state: "pending",
  };
  try {
    await recordPendingAutoMergeDisarm(db, companyId, issueId, record);
  } catch (err) {
    // The in-flight record written before the arm is still on the card: the sweep takes the arm back from it.
    return `; the take-back record could not be updated (${err instanceof Error ? err.message : String(err)}); the record written before the arm stays on the card and the sweep takes the arm back from it`;
  }
  // The arm is in force without authority and GitHub would not turn it off: fence the head now, over the second route,
  // so the PR cannot merge while the take-back is retried (no scheduler needed: this runs in the arming process itself).
  let fence = "";
  try {
    const candidates = await resolveGitHubTokenCandidatesForRepo(db, companyId, pr.owner, pr.repo);
    const fenced = await fenceRevokedHead(candidates.map((candidate) => candidate.token), record);
    await recordPendingAutoMergeDisarm(db, companyId, issueId, fenced.fenced
      ? { ...record, fencedAt: new Date().toISOString(), fenceError: null }
      : { ...record, fenceError: fenced.error });
    fence = fenced.fenced
      ? "; the head's paperclip/approved status was set to failure, so the PR cannot merge while auto-merge stays on"
      : `; the head's paperclip/approved status could NOT be set to failure (${fenced.error ?? "unknown"}), so nothing but the take-back stops a merge`;
  } catch (err) {
    fence = `; the head could not be fenced (${err instanceof Error ? err.message : String(err)})`;
  }
  // Do not wait for the first reconciler tick: retry within seconds (a restart falls back to the tick).
  // Loaded here, not at the top, because that module imports this one.
  try { (await import("./auto-merge-disarm.js")).startPromptDisarmRetries(db, companyId, issueId); } catch { /* the tick still retries it */ }
  return `; the take-back is recorded on the card and retried within seconds and then on every reconciler tick until GitHub confirms auto-merge is off${fence}`;
}

/**
 * Turns auto-merge back off. Used only to take back an arm whose authority was revoked while the
 * enable call was in flight (a revocation that commits inside the GitHub call cannot be seen before it).
 * Every attempt is bounded (a provider call that never answers is given up on, and its request aborted),
 * a transient failure is retried, and the answer says plainly whether auto-merge is off: `success` is
 * true only when GitHub accepted the disable or said auto-merge was not enabled.
 */
export async function disableAutoMerge(
  token: string,
  nodeId: string,
  options: { timeoutMs?: number; attempts?: number; retryDelayMs?: number } = {},
): Promise<{ success: boolean; error: string | null }> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const attempts = options.attempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const query = `mutation { disablePullRequestAutoMerge(input: { pullRequestId: "${nodeId}" }) { clientMutationId } }`;
  const once = async (): Promise<{ success: boolean; error: string | null; transient: boolean }> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve("timeout"); }, timeoutMs);
    });
    try {
      const work = (async () => {
        const response = await ghFetch(GITHUB_GRAPHQL_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ query }),
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null) as Record<string, unknown> | null;
        const errors = body?.errors as Array<{ message?: string }> | undefined;
        if (!response.ok) return { success: false, error: errors?.[0]?.message ?? `HTTP ${response.status}`, transient: isTransientArmingStatus(response.status) };
        if (errors && errors.length > 0) {
          const message = errors[0]?.message ?? "";
          // Nothing to take back: GitHub says auto-merge is not enabled. ("already merged" is NOT this: the
          // merge happened, and the answer must say auto-merge was not turned off.)
          if (/auto[- ]?merge (?:is )?not (?:currently )?enabled|is not enabled/i.test(message)) return { success: true, error: null, transient: false };
          return { success: false, error: message, transient: false };
        }
        return { success: true, error: null, transient: false };
      })();
      work.catch(() => undefined);
      const result = await Promise.race([work, timedOut]);
      return result === "timeout" ? { success: false, error: `timeout after ${timeoutMs}ms`, transient: true } : result;
    } catch {
      return { success: false, error: "network_error", transient: true };
    } finally {
      clearTimeout(timer);
    }
  };
  let result = await once();
  for (let attempt = 1; attempt < attempts && !result.success && result.transient; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)));
    result = await once();
  }
  return { success: result.success, error: result.error };
}

export async function enableAutoMerge(
  token: string,
  nodeId: string,
  options: EnableAutoMergeOptions = {},
): Promise<{ success: boolean; alreadyQueued: boolean; error: string | null; status: number }> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelay = options.retryDelayMs ?? 250;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? enableTiming.attemptTimeoutMs;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  if (options.expectedHeadOid !== undefined && !/^[0-9a-f]{40}$/i.test(options.expectedHeadOid)) {
    return { success: false, alreadyQueued: false, error: "invalid expectedHeadOid", status: 0 };
  }
  const attempt = async (): Promise<{ success: boolean; alreadyQueued: boolean; error: string | null; status: number }> => {
    const refusal = await options.beforeAttempt?.();
    if (refusal) return { success: false, alreadyQueued: false, error: `authority_changed: ${refusal}`, status: 0 };
    const headBinding = options.expectedHeadOid ? `, expectedHeadOid: "${options.expectedHeadOid}"` : "";
    const query = `mutation { enablePullRequestAutoMerge(input: { pullRequestId: "${nodeId}"${headBinding} }) { clientMutationId } }`;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve("timeout"); }, attemptTimeoutMs);
    });
    type Answer = { success: boolean; alreadyQueued: boolean; error: string | null; status: number };
    const work = (async (): Promise<Answer> => {
      try {
        const response = await ghFetch(GITHUB_GRAPHQL_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ query }),
          signal: controller.signal,
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
    })();
    work.catch(() => undefined);
    try {
      const answer = await Promise.race([work, timedOut]);
      return answer === "timeout" ? { success: false, alreadyQueued: false, error: `timeout after ${attemptTimeoutMs}ms`, status: 0 } : answer;
    } finally {
      clearTimeout(timer);
    }
  };

  let result = await attempt();
  for (let attemptNo = 1; attemptNo < maxAttempts && isTransientArmingStatus(result.status); attemptNo++) {
    await sleep(baseDelay * 2 ** (attemptNo - 1));
    result = await attempt();
  }
  return result;
}

/**
 * SUP-16921: narrow matcher for the clean-status refusal. GitHub returns
 * `errors[0].message = "Pull request Pull request is in clean status"` in a 200
 * body when the PR is already immediately mergeable on a queue-less branch and
 * `enablePullRequestAutoMerge` has nothing to defer. This matcher is
 * deliberately specific: a `success === false` catch-all would swallow every
 * unrecognised provider error and mask it behind the fallback merge.
 */
function isCleanStatusRefusal(error: string | null | undefined): boolean {
  return error?.toLowerCase().includes("is in clean status") ?? false;
}

/**
 * SUP-16921: resolve the repository's default merge method via the REST API so
 * the fallback `mergePullRequest` mutation lands the same commit shape
 * `enablePullRequestAutoMerge` (no explicit mergeMethod) would have used.
 * Returns the uppercased enum value ("MERGE", "SQUASH", "REBASE") or null.
 */
async function fetchDefaultMergeMethod(
  token: string,
  owner: string,
  repo: string,
): Promise<string | null> {
  const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-merge-arming",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };
  try {
    const response = await ghFetch(url, { headers });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const method = body?.default_merge_method;
    return typeof method === "string" ? method.toUpperCase() : null;
  } catch {
    return null;
  }
}

export interface MergePullRequestOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * SUP-16921: head-pinned direct merge via the GraphQL `mergePullRequest`
 * mutation. Retries transient 429/5xx using the same `isTransientArmingStatus`
 * policy as `enableAutoMerge` (SUP-16088 contract). A 200-body provider error
 * is terminal, not transient.
 */
export async function mergePullRequest(
  token: string,
  nodeId: string,
  expectedHeadOid: string,
  mergeMethod: string,
  options: MergePullRequestOptions = {},
): Promise<{ success: boolean; error: string | null; status: number }> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelay = options.retryDelayMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const attempt = async (): Promise<{ success: boolean; error: string | null; status: number }> => {
    const query = `mutation { mergePullRequest(input: { pullRequestId: "${nodeId}", expectedHeadOid: "${expectedHeadOid}", mergeMethod: ${mergeMethod} }) { clientMutationId pullRequest { merged } } }`;

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
        return { success: false, error: firstError || `HTTP ${response.status}`, status: response.status };
      }

      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      const errors = body?.errors as Array<{ message?: string }> | undefined;
      if (errors && errors.length > 0) {
        return { success: false, error: errors[0]?.message ?? "", status: response.status };
      }

      return { success: true, error: null, status: response.status };
    } catch {
      return { success: false, error: "network_error", status: 0 };
    }
  };

  let result = await attempt();
  for (let attemptNo = 1; attemptNo < maxAttempts && isTransientArmingStatus(result.status); attemptNo++) {
    await sleep(baseDelay * 2 ** (attemptNo - 1));
    result = await attempt();
  }
  return result;
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

type DeliveryReceiptPublicationContext = {
  claim: DeliveryReceiptClaim;
};

async function claimReceiptForPublication(
  db: Db,
  companyId: string,
  issueId: string,
  pr: LinkedPullRequest,
  headSha: string,
  requireDeliveryReceipt: boolean,
): Promise<DeliveryReceiptPublicationContext | ArmingOutcome | null> {
  const receipts = await db
    .select({ id: issueDeliveryReceipts.id, headSha: issueDeliveryReceipts.headSha })
    .from(issueDeliveryReceipts)
    .innerJoin(
      issueDeliveryReceiptLinks,
      and(
        eq(issueDeliveryReceiptLinks.companyId, issueDeliveryReceipts.companyId),
        eq(issueDeliveryReceiptLinks.receiptId, issueDeliveryReceipts.id),
        eq(issueDeliveryReceiptLinks.sourceIssueId, issueDeliveryReceipts.sourceIssueId),
        eq(issueDeliveryReceiptLinks.headSha, issueDeliveryReceipts.headSha),
      ),
    )
    .where(and(
      eq(issueDeliveryReceipts.companyId, companyId),
      eq(issueDeliveryReceipts.sourceIssueId, issueId),
      eq(issueDeliveryReceipts.provider, "github"),
      eq(issueDeliveryReceipts.owner, pr.owner.toLowerCase()),
      eq(issueDeliveryReceipts.repo, pr.repo.toLowerCase()),
      eq(issueDeliveryReceipts.pullRequestNumber, pr.number),
      eq(issueDeliveryReceiptLinks.provider, "github"),
      eq(issueDeliveryReceiptLinks.owner, pr.owner.toLowerCase()),
      eq(issueDeliveryReceiptLinks.repo, pr.repo.toLowerCase()),
      eq(issueDeliveryReceiptLinks.pullRequestNumber, pr.number),
    ));
  if (receipts.length === 0) {
    return requireDeliveryReceipt
      ? { kind: "skipped", message: `status:skipped:delivery-receipt-missing: ${pr.displayName} has no board delivery receipt for head ${headSha.slice(0, 7)}`, headSha }
      : null;
  }
  if (!receipts.some((receipt) => receipt.headSha === headSha)) {
    await db
      .update(issueDeliveryReceipts)
      .set({ state: "invalidated", invalidatedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(issueDeliveryReceipts.companyId, companyId),
        inArray(issueDeliveryReceipts.id, receipts.map((receipt) => receipt.id)),
        eq(issueDeliveryReceipts.state, "ready"),
      ));
    return {
      kind: "skipped",
      message: `status:skipped:delivery-receipt-head_mismatch: ${pr.displayName} is not authorized for head ${headSha.slice(0, 7)}`,
      headSha,
    };
  }
  const lookup = await claimDeliveryReceiptForPublication(db, {
    companyId,
    issueId,
    owner: pr.owner,
    repo: pr.repo,
    pullRequestNumber: pr.number,
    headSha,
  });
  if (lookup.kind === "claimed") {
    return { claim: lookup.claim };
  }
  if (lookup.kind === "missing") {
    return requireDeliveryReceipt
      ? { kind: "skipped", message: `status:skipped:delivery-receipt-missing: ${pr.displayName} has no board delivery receipt for head ${headSha.slice(0, 7)}`, headSha }
      : null;
  }
  return {
    kind: "skipped",
    message: `status:skipped:delivery-receipt-${lookup.reason}: ${pr.displayName} is not authorized for head ${headSha.slice(0, 7)}`,
    headSha,
  };
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
  /** Final preflight identity; a same-SHA sibling is not approval. */
  expectedPr?: { owner: string; repo: string; number: number };
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
  includeDrafts?: boolean;
  /** Legacy or mismatched decision binding: require a board delivery receipt. */
  requireDeliveryReceipt?: boolean;
  /** Guard A or an authorized done-card delta review certifies this exact PR/head.
   * Replaces only the stale head of an existing delivery binding, never its
   * repository, branch, source card, or PR identity. Requires expectedHeadSha.
   */
  headCertification?: { owner: string; repo: string; number: number; headSha: string };
}

/** Only the current decision's complete final preflight can replace a receipt. */
export function readCertifiedFinalDelivery(executionState: Record<string, unknown> | null | undefined):
  | { owner: string; repo: string; number: number; headSha: string; displayName: string; decisionId: string }
  | undefined {
  const delivery = (executionState?.approvalStatus as Record<string, unknown> | null | undefined)?.finalDelivery;
  if (!delivery || typeof delivery !== "object") return undefined;
  const fields = delivery as Record<string, unknown>;
  if (
    typeof executionState?.lastDecisionId !== "string" ||
    fields.decisionId !== executionState.lastDecisionId ||
    typeof fields.owner !== "string" || !fields.owner ||
    typeof fields.repo !== "string" || !fields.repo ||
    typeof fields.number !== "number" || !Number.isSafeInteger(fields.number) || fields.number <= 0 ||
    typeof fields.headSha !== "string" || !fields.headSha
  ) return undefined;
  return {
    owner: fields.owner,
    repo: fields.repo,
    number: fields.number,
    headSha: fields.headSha,
    displayName: typeof fields.displayName === "string" && fields.displayName
      ? fields.displayName : `${fields.owner}/${fields.repo}#${fields.number}`,
    decisionId: fields.decisionId,
  };
}

/** The board release the publisher CONFIRMED on a card: which status it was, and which PR and head it covered. */
export interface ConfirmedRelease {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  /** GitHub's id of the success status the release wrote. */
  statusId: string;
}

/** The confirmed release recorded on the card (`approvalStatus.releaseConfirmation`), if well formed. */
export function readConfirmedRelease(executionState: Record<string, unknown> | null | undefined): ConfirmedRelease | undefined {
  const raw = (executionState?.approvalStatus as Record<string, unknown> | null | undefined)?.releaseConfirmation;
  if (!raw || typeof raw !== "object") return undefined;
  const f = raw as Record<string, unknown>;
  if (
    typeof f.owner !== "string" || !f.owner ||
    typeof f.repo !== "string" || !f.repo ||
    typeof f.number !== "number" || !Number.isSafeInteger(f.number) || f.number <= 0 ||
    typeof f.headSha !== "string" || !f.headSha ||
    typeof f.statusId !== "string" || !f.statusId
  ) return undefined;
  return { owner: f.owner, repo: f.repo, number: f.number, headSha: f.headSha, statusId: f.statusId };
}

/**
 * Whether the card carries a board-release confirmation for `headSha`: the head was released through the
 * head-bound release path. `headSha` defaults to the card's published head. Inside that path (and only
 * there) a paused agent decider no longer stands behind the approval, and a direct merge is never used.
 */
export function isBoardReleasedHead(executionState: Record<string, unknown> | null | undefined, headSha?: string | null): boolean {
  const confirmed = readConfirmedRelease(executionState);
  if (!confirmed) return false;
  const approval = (executionState?.approvalStatus ?? {}) as Record<string, unknown>;
  const head = headSha ?? (typeof approval.publishedHeadSha === "string" ? approval.publishedHeadSha : null);
  return !!head && confirmed.headSha === head;
}

/**
 * The id of the board-release status a consumer may act on for this exact repository, PR and head, or
 * null. It requires BOTH the card's certified final delivery for that triple (a release only stands in
 * for the review on a certified card) and a release the publisher confirmed for the same triple. A
 * release whose confirmation is unknown (a write that timed out, a status that could not be confirmed or
 * voided) has no such record, so it is never consumed.
 */
export function consumableReleaseStatusId(
  executionState: Record<string, unknown> | null | undefined,
  target: { owner: string; repo: string; number: number; headSha: string },
): string | null {
  const same = (a: { owner: string; repo: string; number: number; headSha: string }) =>
    a.number === target.number && a.headSha === target.headSha &&
    a.owner.toLowerCase() === target.owner.toLowerCase() && a.repo.toLowerCase() === target.repo.toLowerCase();
  const certified = readCertifiedFinalDelivery(executionState);
  const confirmed = readConfirmedRelease(executionState);
  return certified && confirmed && same(certified) && same(confirmed) ? confirmed.statusId : null;
}

/**
 * Records, on the publication lock's own connection, that the release wrote and confirmed exactly this
 * status. It is the last write of a release, so a status that is never confirmed never has a record.
 */
export async function recordReleaseConfirmation(
  conn: Db,
  companyId: string,
  issueId: string,
  confirmation: ConfirmedRelease,
): Promise<void> {
  const patch = JSON.stringify({ releaseConfirmation: { ...confirmation, at: new Date().toISOString() } });
  const updated = await conn
    .update(issues)
    .set({
      executionState: sql`jsonb_set(coalesce(${issues.executionState}, '{}'::jsonb), '{approvalStatus}',
        coalesce(${issues.executionState} -> 'approvalStatus', '{}'::jsonb) || ${patch}::jsonb)`,
    })
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .returning({ id: issues.id });
  if (updated.length === 0) throw new Error("card not found while recording the release confirmation");
}

/**
 * ADR-091 D1 (SUP-15909): the branch half of a card's delivery identity is a
 * security boundary. A lease-holding run entering in_review must not be able to
 * name ANY same-repo branch and have paperclip/approved published on a PR it
 * never delivered (the SUP-15896 -> SUP-15908 laundering vector). The repo half
 * (D5) is already a control-plane fact; this closes the card-boundary half (D1)
 * WITHIN the repo.
 *
 * The delivery branch is ALWAYS the card's execution-workspace row's branch_name
 * (a control-plane fact, never the record). It is LEGITIMATE for this card to
 * arm on when it is EITHER:
 *   - the card's OWN workspace row (sourceless, or sourceIssueId === the card), or
 *   - a legitimate ADR-083 CARRIER owner's branch: the row's sourceIssueId is a
 *     STRICT ANCESTOR of the card AND the row passes the ADR-083 carrier gate
 *     (inheritedExecutionWorkspaceBranchExempt — a shared_workspace plan carrier,
 *     or an isolated_workspace redo carrier whose branch is anchored at that
 *     ancestor at depth <= 2).
 *
 * Any other owner — a sibling, an unrelated issue, a non-ancestor, an
 * operator_branch row, an ancestor deeper than 2, or an unanchored isolated
 * branch — is NOT a legitimate delivery branch for this card and must be
 * refused. `branchIsOwn` is true only for the card's own row; a legitimate
 * carrier row is NOT the card's own branch and routes to the identifier-prefix
 * predicate rather than the exact-branch one.
 */
export interface CardDeliveryBranchOwnership {
 /** The card's execution-workspace row branch_name, or null when it has no such row/branch. */
 branch: string | null;
 /** True iff the card's own row (sourceless or self-sourced) backs the branch. */
 branchIsOwn: boolean;
 /** True iff the branch is borrowed from a legitimate ADR-083 carrier owner. */
 carrier: boolean;
 /** True iff the branch is the card's own branch OR a legitimate carrier branch. */
 legitimate: boolean;
 /** The owning issue when the branch is borrowed (null for the card's own row). */
 ownerIssueId: string | null;
 /** Named refusal reason when `legitimate` is false. */
 refusalReason: string | null;
}

/**
 * SUP-15837-style recursive-CTE walk over issues.parent_id returning an issue's
 * identifier + strict-ancestor depth (root = 0). Same shape as
 * execution-workspace-provisioning's private copy; inlined here so the D1 branch
 * gate stays self-contained on the two ADR-083 inputs the isolated-carrier arm
 * needs (D11 branch anchor + D6 depth bound).
 */
async function resolveSourceIdentifierAndDepth(
 db: Pick<Db, "execute">,
 companyId: string,
 issueId: string,
): Promise<{ identifier: string | null; depth: number } | null> {
 if (!issueId) return null;
 const result = await db.execute(sql`
   WITH RECURSIVE ancestors(id) AS (
     SELECT parent_id
     FROM issues
     WHERE id = ${issueId} AND company_id = ${companyId}
     UNION
     SELECT i.parent_id
     FROM issues i
     JOIN ancestors a ON i.id = a.id
     WHERE i.parent_id IS NOT NULL AND i.company_id = ${companyId}
   )
   SELECT
     (SELECT identifier FROM issues WHERE id = ${issueId} AND company_id = ${companyId} LIMIT 1) AS identifier,
     (SELECT COUNT(*) FROM ancestors WHERE id IS NOT NULL) AS depth
 `);
 const rows: unknown[] = Array.isArray(result)
   ? result
   : ((result as { rows?: unknown[] }).rows ?? []);
 const row = rows[0] as { identifier?: unknown; depth?: unknown } | undefined;
 if (!row) return null;
 const identifier =
   typeof row.identifier === "string" && row.identifier.trim().length > 0 ? row.identifier : null;
 const depth = Number(row.depth ?? 0);
 return { identifier, depth: Number.isFinite(depth) ? depth : 0 };
}

/**
 * ADR-091 D1 (SUP-15909): resolve whether a card's execution-workspace delivery
 * branch is one this card may lawfully arm on. Shared by the write-time branch
 * gate (routes/issues.ts) and the approval-time gate (resolveDeliveryIdentity),
 * so the two halves of D1 never disagree on which owners are legitimate.
 */
export async function resolveCardDeliveryBranchOwnership(
 db: Db,
 companyId: string,
 issueId: string,
): Promise<CardDeliveryBranchOwnership> {
 const [issueRow] = await db
   .select({ executionWorkspaceId: issues.executionWorkspaceId })
   .from(issues)
   .where(eq(issues.id, issueId));
 const executionWorkspaceId = issueRow?.executionWorkspaceId ?? null;
 if (!executionWorkspaceId) {
   return {
     branch: null,
     branchIsOwn: true,
     carrier: false,
     legitimate: false,
     ownerIssueId: null,
     refusalReason: "card has no execution-workspace delivery branch to validate the recorded branch against",
   };
 }
 const [wsRow] = await db
   .select({
     branchName: executionWorkspaces.branchName,
     sourceIssueId: executionWorkspaces.sourceIssueId,
     mode: executionWorkspaces.mode,
   })
   .from(executionWorkspaces)
   .where(eq(executionWorkspaces.id, executionWorkspaceId));
 const branch = wsRow?.branchName ?? null;
 const source = wsRow?.sourceIssueId?.trim() ?? "";

 // Own / sourceless row: the card's own delivery branch. Ownership is legitimate;
 // whether a branch exists at all is a separate axis the caller checks.
 if (!source || source === issueId) {
   return { branch, branchIsOwn: true, carrier: false, legitimate: true, ownerIssueId: null, refusalReason: null };
 }

 // Borrowed row: legitimate ONLY when the source is a strict ancestor of the card
 // AND the ADR-083 carrier gate admits that row. An unrelated/sibling/non-ancestor
 // owner is the laundering vector D1 exists to close.
 const sourceIsAncestor = await isStrictAncestorIssueIdOf(db, companyId, issueId, source);
 let sourceIdentifier: string | null = null;
 let sourceDepth: number | null = null;
 if (wsRow?.mode === "isolated_workspace") {
   const ref = await resolveSourceIdentifierAndDepth(db, companyId, source);
   sourceIdentifier = ref?.identifier ?? null;
   sourceDepth = ref?.depth ?? null;
 }
 const carrier = inheritedExecutionWorkspaceBranchExempt({
   workspaceMode: wsRow?.mode ?? null,
   workspaceSourceIssueId: source,
   sourceIssueIsAncestorOfBoundIssue: sourceIsAncestor,
   workspaceBranchName: branch,
   workspaceSourceIssueIdentifier: sourceIdentifier,
   sourceIssueDepth: sourceDepth,
 });
  if (carrier) {
    // SUP-16896: a carrier whose owning card is already terminal (done/cancelled)
    // can never be stamped — the owner's final-stage approve cannot re-fire on a
    // completed/cancelled card — and can never be promoted, because the carrier
    // sweep skips terminal owners (carrier-promotion-sweep.ts). Delivering onto it
    // mints an ownerless, unstampable head (the live PR #746 fault), so the delivery
    // is refused fail-closed instead of silently arming on a dead carrier. The
    // commits remain on the branch for the board/operator to disposition; the
    // refusal names where the content goes so nothing is silently stranded.
    const [ownerRow] = await db
      .select({ status: issues.status, identifier: issues.identifier })
      .from(issues)
      .where(eq(issues.id, source))
      .limit(1);
    const ownerStatus = ownerRow?.status ?? null;
    if (ownerStatus === "done" || ownerStatus === "cancelled") {
      return {
        branch,
        branchIsOwn: false,
        carrier: true,
        legitimate: false,
        ownerIssueId: source,
        refusalReason:
          `ADR-083 carrier owner ${ownerRow?.identifier ?? source} is already ${ownerStatus}; a terminal owner can never stamp or promote this carrier, so the delivery is refused (SUP-16896). The commits remain on branch '${branch}' — re-file the work on a live card's branch, or have the board/operator disposition the orphan carrier PR.`,
      };
    }
    return { branch, branchIsOwn: false, carrier: true, legitimate: true, ownerIssueId: source, refusalReason: null };
  }
 return {
   branch,
   branchIsOwn: false,
   carrier: false,
   legitimate: false,
   ownerIssueId: source,
   refusalReason:
     "this card's execution-workspace branch is owned by another issue that is not its ADR-083 carrier owner (not a strict ancestor passing the carrier gate); refusing to arm on a branch this card cannot be proven to have delivered (ADR-091 D1)",
 };
}

/**
 * ADR-091 D1 (SUP-14676): the card's own delivery identity — the repo it was
 * assigned and the branch it delivered on. Both the cached-mention path and the
 * SUP-13313/SUP-13831 live-discovery path authorize against this, so it is
 * resolved through one helper: a gate that only covers one of the two stamp
 * paths is not a gate.
 *
 * ADR-091 D1 (SUP-14824): prefers the recorded delivery identity
 * (executionState.delivery) over the execution-workspace row. Only the branch
 * half is taken from the record; the repo is always the card's PROJECT repo
 * (resolveIssueRepoContext, a control-plane fact) and the record is
 * cross-checked against it (SUP-14824 F1 — the agent-asserted repo can never
 * substitute the repo half, so D5's cross-repo closure holds). A recorded
 * identity that is present but unusable — not a usable object (F3), missing or
 * empty branch/headSha, a repo that does not resolve, cannot be anchored to the
 * project repo, or a repo that differs from the project repo (F1) — fails
 * closed with a named reason and never falls back to the workspace row.
 *
 * ADR-091 D1 (SUP-15909): the recorded BRANCH half is validated the same way —
 * it must equal the card's control-plane delivery branch (the execution-workspace
 * row's branch_name: the card's own branch, or a carrier owner's branch for an
 * ADR-083 child). `branchIsOwn` is resolved from that row's sourceIssueId, never
 * hard-coded true, so a borrowed (carrier) record routes to the identifier-prefix
 * predicate exactly like the fallback path.
 */
interface DeliveryBinding {
  branch: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  sourceIssueId?: string;
}

export async function resolveDeliveryIdentity(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<{
   branch: string | null;
   // `hostname` is the project repository host (parseRepoUrl); callers that must stay on github.com check it.
   repo: { owner: string; repo: string; hostname?: string } | null;
   binding?: DeliveryBinding;
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

  // ADR-091 D5 (SUP-14824 F1): the delivery repo is ALWAYS the card's project
  // repo, resolved from the project binding — a control-plane fact. It is never
  // taken from the agent-asserted recorded delivery identity, which would
  // re-open the cross-repo laundering vector D1 exists to block. Both the
  // recorded-identity path and the workspace-row path resolve it from here.
  const ctx = await resolveIssueRepoContext(db, {
    companyId,
    projectId: issueRow?.projectId ?? null,
    projectWorkspaceId: issueRow?.projectWorkspaceId ?? null,
    executionWorkspaceId: issueRow?.executionWorkspaceId ?? null,
  });
  const projectRepo = ctx?.repoUrl ? parseRepoUrl(ctx.repoUrl) : null;
  const identifier = issueRow?.identifier ?? null;

  // ADR-091 D1 (SUP-14824): prefer the recorded delivery identity. Only the
  // BRANCH half is taken from the record; the repo is always the project repo,
  // and the record is cross-checked against it (never trusted to carry the repo
  // half). A recorded identity that is present but unusable fails closed with a
  // named reason and never falls back to the workspace row.
  const delivery = issueRow?.executionState?.delivery;
  const isRecordedObject =
    delivery !== undefined && delivery !== null && typeof delivery === "object" && !Array.isArray(delivery);
  if (delivery !== undefined && delivery !== null && !isRecordedObject) {
    // SUP-14824 F3: present but not an object (string/array/number) is the
    // record being unusable — fail closed, never silently fall back to the row.
    return {
      branch: null,
      repo: null,
      recordedUnusable: "recorded delivery identity is not a usable object",
      branchIsOwn: true,
      identifier,
    };
  }
  if (isRecordedObject) {
    const record = delivery as Record<string, unknown>;
    const branch = typeof record.branch === "string" && record.branch.length > 0 ? record.branch : null;
    const headSha = typeof record.headSha === "string" && record.headSha.length > 0 ? record.headSha : null;
    const prNumber = typeof record.prNumber === "number" && Number.isInteger(record.prNumber) && record.prNumber > 0
      ? record.prNumber
      : null;
    const prUrl = typeof record.prUrl === "string" && record.prUrl.length > 0 ? record.prUrl : null;
    const sourceIssueId = typeof record.sourceIssueId === "string" && record.sourceIssueId.length > 0
      ? record.sourceIssueId
      : undefined;
    const recordedRepoRaw = record.repo;
    const recordedRepo =
      recordedRepoRaw !== undefined &&
      recordedRepoRaw !== null &&
      typeof recordedRepoRaw === "object" &&
      !Array.isArray(recordedRepoRaw)
        ? (() => {
            const r = recordedRepoRaw as Record<string, unknown>;
            if (typeof r.owner !== "string" || r.owner.length === 0 || typeof r.repo !== "string" || r.repo.length === 0)
              return null;
            return { owner: r.owner, repo: r.repo };
          })()
        : null;
    if (!branch) {
      return {
        branch: null,
        repo: null,
        recordedUnusable: "recorded delivery identity has no branch",
        branchIsOwn: true,
        identifier,
      };
    }
    if (!headSha) {
      return {
        branch: null,
        repo: null,
        recordedUnusable: "recorded delivery identity has no headSha",
        branchIsOwn: true,
        identifier,
      };
    }
    if (prNumber !== null || prUrl !== null || sourceIssueId !== undefined) {
      if (prNumber === null || prUrl === null) {
        return {
          branch: null,
          repo: null,
          recordedUnusable: "recorded delivery identity has incomplete PR binding",
          branchIsOwn: true,
          identifier,
        };
      }
    }
    if (recordedRepo === null) {
      return {
        branch: null,
        repo: null,
        recordedUnusable: "recorded delivery identity has no resolvable repo",
        branchIsOwn: true,
        identifier,
      };
    }
    if (projectRepo === null) {
      return {
        branch: null,
        repo: null,
        recordedUnusable: "recorded delivery identity cannot be anchored to this card's project repo",
        branchIsOwn: true,
        identifier,
      };
    }
    // SUP-14824 F1: the recorded repo must equal the project-bound repo
    // (case-insensitive, same comparison as isDeliveredByCard). A recorded repo
    // that differs is the recorded identity being unusable — fail closed, never
    // prefer either side.
    if (
      recordedRepo.owner.toLowerCase() !== projectRepo.owner.toLowerCase() ||
      recordedRepo.repo.toLowerCase() !== projectRepo.repo.toLowerCase()
    ) {
      return {
        branch: null,
        repo: null,
        recordedUnusable: "recorded delivery identity's repo does not match this card's project repo",
        branchIsOwn: true,
        identifier,
      };
    }
    // ADR-091 D1 (SUP-15909): the recorded BRANCH half is a security boundary, not
    // a passthrough. It must equal the card's control-plane delivery branch AND that
    // branch must be one this card may lawfully arm on — its own execution-workspace
    // branch, or an ADR-083 carrier owner's branch. resolveCardDeliveryBranchOwnership
    // resolves both from the control plane (the execution-workspace row plus the
    // card's ancestor chain), never from the record. A recorded branch naming a
    // branch owned by an UNRELATED issue would let the card stamp a PR it never
    // delivered (the SUP-15896 -> SUP-15908 laundering vector), so it fails closed —
    // never fall back to the workspace row.
    const branchOwnership = await resolveCardDeliveryBranchOwnership(db, companyId, issueId);
    if (
      branchOwnership.branch === null ||
      // Git refs are case-sensitive: the recorded branch is an exact match, not case-folded.
      branch !== branchOwnership.branch
    ) {
      return {
        branch: null,
        repo: null,
        recordedUnusable:
          "recorded delivery identity's branch does not match this card's control-plane delivery branch",
        branchIsOwn: true,
        identifier,
      };
    }
    // ADR-091 D1 (SUP-15909): an unrelated owner (neither this card nor an ADR-083
    // carrier-owner ancestor) is a foreign same-repo branch. Refuse to arm on it even
    // when the row is already in the DB — the gate asserts a named refusal, not just
    // the absence of a stamp.
    if (!branchOwnership.legitimate) {
      return {
        branch: null,
        repo: null,
        recordedUnusable:
          branchOwnership.refusalReason ?? "recorded delivery branch is owned by an unrelated issue",
        branchIsOwn: false,
        identifier,
      };
    }
    // ADR-091 D1 (SUP-15909): `branchIsOwn` is a control-plane fact, never a default.
    // A legitimate carrier record (the owner's branch) routes to the identifier-prefix
    // predicate exactly like the fallback path; only the card's own branch uses the
    // exact-branch predicate.
    return {
      branch,
      repo: projectRepo,
      binding: prNumber !== null && prUrl !== null ? { branch, prNumber, prUrl, headSha, sourceIssueId } : undefined,
      branchIsOwn: branchOwnership.branchIsOwn,
      identifier,
    };
  }

  // ADR-091 D1 (SUP-15909): even with no recorded identity the card arms on its
  // control-plane branch, which must still be a branch it may lawfully arm on. A
  // no-record card riding an UNRELATED issue's execution-workspace row is the same
  // laundering vector, so it fails closed with a named reason. Own cards and
  // legitimate ADR-083 carriers arm exactly as before (accept-set parity).
  const branchOwnership = await resolveCardDeliveryBranchOwnership(db, companyId, issueId);
  if (!branchOwnership.legitimate && branchOwnership.ownerIssueId !== null) {
    return {
      branch: null,
      repo: null,
      recordedUnusable: branchOwnership.refusalReason ?? "delivery branch is owned by an unrelated issue",
      branchIsOwn: false,
      identifier,
    };
  }
  return {
    branch: ctx?.branch ?? null,
    repo: projectRepo,
    branchIsOwn: branchOwnership.branchIsOwn,
    identifier,
  };
}

function deliveryBindingValidationError(
  binding: DeliveryBinding,
  repo: { owner: string; repo: string },
  issueId: string,
): string | null {
  if (binding.sourceIssueId && binding.sourceIssueId !== issueId) {
    return "recorded delivery identity source issue does not match this card";
  }
  const expectedUrl = `https://github.com/${repo.owner}/${repo.repo}/pull/${binding.prNumber}`;
  if (binding.prUrl !== expectedUrl) {
    return "recorded delivery identity PR URL does not match its PR number";
  }
  return null;
}

async function resolveExactBoundPullRequest(
  db: Db,
  companyId: string,
  issueId: string,
  binding: DeliveryBinding,
  repo: { owner: string; repo: string },
): Promise<{ pr: LinkedPullRequest | null; reason?: string }> {
  const candidates = await resolveGitHubTokenCandidatesForRepo(db, companyId, repo.owner, repo.repo);
  if (candidates.length === 0) {
    return { pr: null, reason: "recorded delivery identity PR cannot be verified without a GitHub token" };
  }
  const cached = (await resolveLinkedPullRequests(db, companyId, issueId, { includeDrafts: true }))
    .find((pr) => pr.owner.toLowerCase() === repo.owner.toLowerCase()
      && pr.repo.toLowerCase() === repo.repo.toLowerCase()
      && pr.number === binding.prNumber);
  for (const candidate of candidates) {
    const result = await fetchPullRequestHeadSha(candidate.token, repo.owner, repo.repo, binding.prNumber);
    if (!result.ok) {
      if ((result.status === 401 || result.status === 403) && candidate !== candidates[candidates.length - 1]) continue;
      return { pr: null, reason: `recorded delivery identity PR open-state verification failed: HTTP ${result.status}` };
    }
    if (result.open !== true || result.draft === true) {
      return { pr: null, reason: result.draft === true ? "recorded delivery identity PR is a draft" : "recorded delivery identity PR is not open" };
    }
    if (result.headRef !== binding.branch) {
      return {
        pr: null,
        reason: `recorded delivery identity branch ${binding.branch} does not match the bound PR's live branch ${result.headRef ?? "(unreadable)"}`,
      };
    }
    if (result.headSha !== binding.headSha) {
      return {
        pr: null,
        reason: `recorded delivery identity head SHA ${binding.headSha} does not match the bound PR's current head ${result.headSha}`,
      };
    }
    return {
      pr: {
        id: "",
        owner: repo.owner,
        repo: repo.repo,
        number: binding.prNumber,
        headRefName: result.headRef,
        title: null,
        displayName: `${repo.owner}/${repo.repo}#${binding.prNumber}`,
        cachedState: "open",
        lastErrorCode: null,
        reviewDecision: null,
        draft: result.draft,
        nodeId: cached?.nodeId ?? null,
      },
    };
  }

  return { pr: null, reason: "recorded delivery identity PR open-state verification failed" };
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
export function notDeliveredReasonForPr(
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
 * SUP-16579: the stranded-card alarm (approval-status-reconciler) routes through
 * this too, so "is this PR the card's delivery PR" has exactly one source of
 * truth across the arming write, the decision pin, and the alarm.
 */
export type DeliveryNarrow<T> =
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

export async function narrowToDelivered<
  T extends {
    id?: string;
    number: number;
    owner: string;
    repo: string;
    headRefName: string | null;
    displayName: string;
    cachedState?: string | null;
  },
>(db: Db, companyId: string, issueId: string, candidates: T[]): Promise<DeliveryNarrow<T>> {
  const { branch, repo, binding, recordedUnusable, branchIsOwn, identifier } = await resolveDeliveryIdentity(db, companyId, issueId);
  if (recordedUnusable) return { outcome: "identity-unresolved", branch: null, recordedUnusable };
  if (!branch || !repo) return { outcome: "identity-unresolved", branch };
  if (binding) {
    if (binding.sourceIssueId && binding.sourceIssueId !== issueId) {
      return {
        outcome: "identity-unresolved",
        branch,
        recordedUnusable: "recorded delivery identity source issue does not match this card",
      };
    }
    const expectedUrl = `https://github.com/${repo.owner}/${repo.repo}/pull/${binding.prNumber}`;
    if (binding.prUrl !== expectedUrl) {
      return {
        outcome: "identity-unresolved",
        branch,
        recordedUnusable: "recorded delivery identity PR URL does not match its PR number",
      };
    }
    const live = await resolveExactBoundPullRequest(db, companyId, issueId, binding, repo);
    if (!live.pr) {
      return {
        outcome: "identity-unresolved",
        branch,
        recordedUnusable: live.reason ?? "recorded delivery identity PR cannot be verified",
      };
    }
    return { outcome: "narrowed", delivered: [live.pr as unknown as T], deliveryBranch: branch };
  }
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
  // The card is blocked while an auto-merge arm of it is unsettled: a control-plane success written now would sit on top of
  // the fence and the arm gate. It publishes again once GitHub has confirmed auto-merge off (or the arm settled).
  const [blockRow] = await db.select({ executionState: issues.executionState }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  const unsettled = ((blockRow?.executionState as Record<string, unknown> | null | undefined)?.approvalStatus as Record<string, unknown> | undefined)?.autoMergeDisarm;
  if (unsettled && typeof unsettled === "object") {
    return { kind: "skipped", message: "status:skipped:arm-unsettled: an auto-merge take-back is unconfirmed on this card; nothing is published until GitHub confirms auto-merge is off" };
  }
  const deliveryIdentity = await resolveDeliveryIdentity(db, companyId, issueId);
  const certification = options?.headCertification;
  if (certification) {
    if (!options.expectedHeadSha || certification.headSha !== options.expectedHeadSha
      || (deliveryIdentity.repo && (
        certification.owner.toLowerCase() !== deliveryIdentity.repo.owner.toLowerCase()
        || certification.repo.toLowerCase() !== deliveryIdentity.repo.repo.toLowerCase()))
      || (deliveryIdentity.binding && certification.number !== deliveryIdentity.binding.prNumber)) {
      return { kind: "skipped", message: "status:skipped:invalid-head-certification" };
    }
    if (deliveryIdentity.binding) {
      deliveryIdentity.binding = { ...deliveryIdentity.binding, headSha: certification.headSha };
    }
  }
  const linkedPRs = await resolveLinkedPullRequests(db, companyId, issueId, {
    includeDrafts: options?.includeDrafts === true,
  });
  let boundPR: LinkedPullRequest | null = null;
  if (deliveryIdentity.binding && deliveryIdentity.repo) {
    const bindingError = deliveryBindingValidationError(deliveryIdentity.binding, deliveryIdentity.repo, issueId);
    if (bindingError) return deliveryIdentityUnresolvedOutcome(deliveryIdentity.branch, bindingError);
    boundPR = linkedPRs.find((pr) => pr.number === deliveryIdentity.binding?.prNumber) ?? null;
    const exact = await resolveExactBoundPullRequest(db, companyId, issueId, deliveryIdentity.binding, deliveryIdentity.repo);
    if (!exact.pr) return deliveryIdentityUnresolvedOutcome(deliveryIdentity.branch, exact.reason);
    boundPR = { ...exact.pr, nodeId: boundPR?.nodeId ?? null };
  }
  const authorizingLinkedPRs = boundPR ? [boundPR] : linkedPRs;

  // ADR-091 D1 (SUP-14676): delivery-identity gate. A mention row is created by
  // prose — a bare PR URL in the card's title/description/comment/document — so
  // selecting candidates by sourceIssueId alone lets any card that merely CITES
  // a PR stamp it. Narrow the authorizing candidate set to PRs this card actually
  // delivered (the head repo is the card's project repo AND the head ref equals
  // the card's own execution-workspace delivery branch), dropping non-delivered
  // candidates BEFORE the length arithmetic. Opt-in: the approval-status
  // reconciler's Guard A re-publish certifies the head by content identity and
  // leaves enforceDeliveryIdentity unset.
  let authorizingPRs = authorizingLinkedPRs;
  if (deliveryIdentity.recordedUnusable) {
    return deliveryIdentityUnresolvedOutcome(null, deliveryIdentity.recordedUnusable);
  }
  if (options?.enforceDeliveryIdentity && linkedPRs.length > 0 && !boundPR) {
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
  if (certification && authorizingPRs.length > 0 && (authorizingPRs.length !== 1
    || authorizingPRs[0]!.number !== certification.number
    || authorizingPRs[0]!.owner.toLowerCase() !== certification.owner.toLowerCase()
    || authorizingPRs[0]!.repo.toLowerCase() !== certification.repo.toLowerCase())) {
    return { kind: "skipped", message: "status:skipped:head-certification-pr-mismatch" };
  }

  if (authorizingLinkedPRs.length === 0) {
    // SUP-13313: an empty cached open-PR set means "the PR I know about is
    // stale", not "this issue has no PR". Ask GitHub for open, non-draft PRs
    // that carry the issue identifier before giving up.
    const withState = await resolveLinkedPullRequestsWithState(db, companyId, issueId, {
      includeDrafts: options?.includeDrafts === true,
    });

    // SUP-14917: the shared live workspace re-resolve (formerly inlined here).
    // It returns the matches + a terminal failure as data, so this publisher maps
    // the failure to its own `status:failed:` strings via
    // armingFailureFromWorkspaceDiscovery — the same strings the inline loop
    // used to emit, byte-for-byte.
    const discovery = await discoverCardPullRequestByWorkspace(
      db,
      companyId,
      issueId,
      issueIdentifier,
      options?.closingTransition ?? true,
      withState,
    );
    if (discovery.terminalFailure) {
      return armingFailureFromWorkspaceDiscovery(discovery.terminalFailure);
    }
    let matched = discovery.matched;

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
    if (certification && matched.length > 0 && (matched.length !== 1
      || matched[0]!.number !== certification.number
      || matched[0]!.owner.toLowerCase() !== certification.owner.toLowerCase()
      || matched[0]!.repo.toLowerCase() !== certification.repo.toLowerCase())) {
      return { kind: "skipped", message: "status:skipped:head-certification-pr-mismatch" };
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
      if (options?.expectedPr && !samePullRequest(pr, options.expectedPr)) {
        return { kind: "skipped", message: "status:skipped:delivery_moved: resolved PR differs from final preflight" };
      }
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
      if (headShaResult.merged || (headShaResult.state !== null && headShaResult.state !== "open") || headShaResult.draft) {
        return {
          kind: "skipped",
          message: `status:skipped:pr-not-eligible: ${pr.displayName} is ${headShaResult.draft ? "a draft" : headShaResult.merged ? "merged" : `state=${headShaResult.state}`}; not re-stamped`,
          headSha,
        };
      }
      if (deliveryIdentity.binding && headSha !== deliveryIdentity.binding.headSha) {
        return deliveryIdentityUnresolvedOutcome(
          deliveryIdentity.branch,
          `recorded delivery identity head SHA ${deliveryIdentity.binding.headSha} does not match the bound PR's current head ${headSha}`,
        );
      }
      if (options?.expectedHeadSha && headSha !== options.expectedHeadSha) {
        return {
          kind: "skipped",
          message: `status:skipped:head_moved: ${pr.displayName} head moved to ${headSha.slice(0, 7)} after content-identity validation (expected ${options.expectedHeadSha.slice(0, 7)}); not re-stamped`,
          headSha,
        };
      }
      const receipt = certification && options?.requireDeliveryReceipt !== true ? null : await claimReceiptForPublication(
        db,
        companyId,
        issueId,
        {
          id: "",
          owner: pr.owner,
          repo: pr.repo,
          number: pr.number,
          nodeId: null,
          headRefName: pr.headRefName,
          title: pr.title,
          displayName: pr.displayName,
          cachedState: "open",
          lastErrorCode: null,
          reviewDecision: null,
          draft: pr.draft,
        },
        headSha,
        options?.requireDeliveryReceipt === true,
      );
      if (receipt && "kind" in receipt) return receipt;
      // SUP-16081 fix #2: retry the transient class (network/5xx/429) before
      // recording a failure; a deterministic refusal returns after one attempt.
      const result = await writeCommitStatusWithRetry(
        pr.candidate.token,
        pr.owner,
        pr.repo,
        headSha,
        issueIdentifier,
      );
      if (result.success) {
        if (receipt) {
          const consumed = await consumeDeliveryReceipt(db, receipt.claim);
          if (!consumed) {
            await invalidateDeliveryReceipt(db, receipt.claim);
            return { kind: "failed", message: "status:failed:delivery-receipt-consume: receipt could not be consumed after status publication" };
          }
        }
        return {
          kind: "armed",
          message: `status:published (live re-resolve): paperclip/approved status written to ${pr.displayName} head ${headSha.slice(0, 7)}`,
          headSha,
          // SUP-15394: hand the certified PR to the actuator. The discovery match
          // has no cached external object, so id is empty and nodeId/head-ref are
          // what the live read reported; the actuator re-fetches the node id when
          // absent. cachedState is "open" — discovery only ever returns open PRs.
          certifiedPr: {
            id: "",
            owner: pr.owner,
            repo: pr.repo,
            number: pr.number,
            nodeId: null,
            headRefName: pr.headRefName,
            displayName: pr.displayName,
            title: pr.title,
            cachedState: "open",
            lastErrorCode: null,
            reviewDecision: null,
          },
        };
      }

      if (receipt) await invalidateDeliveryReceipt(db, receipt.claim);
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
  if (options?.expectedPr && !samePullRequest(pr, options.expectedPr)) {
    return { kind: "skipped", message: "status:skipped:delivery_moved: resolved PR differs from final preflight" };
  }
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
    if (headShaResult.merged || headShaResult.state !== null && headShaResult.state !== "open" || headShaResult.draft) {
      return {
        kind: "skipped",
        message: `status:skipped:pr-not-eligible: ${pr.displayName} is ${headShaResult.draft ? "a draft" : headShaResult.merged ? "merged" : `state=${headShaResult.state}`}; not re-stamped`,
        headSha,
      };
    }
    if (deliveryIdentity.binding && headSha !== deliveryIdentity.binding.headSha) {
      return deliveryIdentityUnresolvedOutcome(
        deliveryIdentity.branch,
        `recorded delivery identity head SHA ${deliveryIdentity.binding.headSha} does not match the bound PR's current head ${headSha}`,
      );
    }
    if (options?.expectedHeadSha && headSha !== options.expectedHeadSha) {
      return {
        kind: "skipped",
        message: `status:skipped:head_moved: ${pr.displayName} head moved to ${headSha.slice(0, 7)} after content-identity validation (expected ${options.expectedHeadSha.slice(0, 7)}); not re-stamped`,
        headSha,
      };
    }
    const receipt = certification && options?.requireDeliveryReceipt !== true ? null : await claimReceiptForPublication(
      db,
      companyId,
      issueId,
      pr,
      headSha,
      options?.requireDeliveryReceipt === true,
    );
    if (receipt && "kind" in receipt) return receipt;
    // SUP-16081 fix #2: retry the transient class (network/5xx/429) before
    // recording a failure; a deterministic refusal returns after one attempt.
    const result = await writeCommitStatusWithRetry(token, pr.owner, pr.repo, headSha, issueIdentifier);
    if (result.success) {
      if (receipt) {
        const consumed = await consumeDeliveryReceipt(db, receipt.claim);
        if (!consumed) {
          await invalidateDeliveryReceipt(db, receipt.claim);
          return { kind: "failed", message: "status:failed:delivery-receipt-consume: receipt could not be consumed after status publication" };
        }
      }
      return {
        kind: "armed",
        message: `status:published: paperclip/approved status written to ${pr.displayName} head ${headSha.slice(0, 7)}`,
        headSha,
        // SUP-15394: the cached-mention path already resolved a LinkedPullRequest,
        // so hand it over verbatim as the certified subject.
        certifiedPr: pr,
      };
    }

    if (receipt) await invalidateDeliveryReceipt(db, receipt.claim);
    const safeError = result.error ?? "unknown_error";
    const truncated = safeError.length > 200 ? safeError.slice(0, 200) + "..." : safeError;
    return { kind: "failed", message: `status:failed:${truncated}` };
  }

  return { kind: "failed", message: "status:failed:internal: exhausted GitHub token candidates" };
}

export type DecisionHeadResolution =
  | { kind: "resolved"; headSha: string; displayName: string; pr: { owner: string; repo: string; number: number } }
  | {
      kind: "unresolvable";
      reason: string;
      /**
       * Present when the unresolvable outcome still carries certifiable head
       * evidence the caller should persist (executionState.approvalStatus
       * .pendingCandidates). Two producers:
       *
       * - The AMBIGUOUS class (SUP-14602): several candidate PRs are all still
       *   open, so the resolver certifies each candidate PR head at approval
       *   time (`ApprovalCandidateAnchor[]`) so the approval-status reconciler
       *   can re-run Guard A against a certified head once the ambiguity
       *   resolves.
       *
       * - The no-pr class (SUP-15016): no open linked PR is resolvable at
       *   decision time, but the card has an OWN delivery branch. The
       *   delivery-branch head is certified (`NoPrBranchAnchor`,
       *   `source: "no-pr-branch"`) so the reconciler has a concrete anchor to
       *   verify against instead of the temporal sha-existence proof.
       *
       * Absent for the `not-delivered` and `delivery_identity` unresolvable
       * reasons, which have no branch to certify.
       */
      pendingCandidates?: Array<ApprovalCandidateAnchor | NoPrBranchAnchor>;
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
  const deliveryIdentity = await resolveDeliveryIdentity(db, companyId, issueId);
  if (deliveryIdentity.binding && deliveryIdentity.repo) {
    const bindingError = deliveryBindingValidationError(deliveryIdentity.binding, deliveryIdentity.repo, issueId);
    if (bindingError) {
      return unresolvableFromNarrowing({
        outcome: "identity-unresolved",
        branch: deliveryIdentity.branch,
        recordedUnusable: bindingError,
      });
    }
    const exact = await resolveExactBoundPullRequest(db, companyId, issueId, deliveryIdentity.binding, deliveryIdentity.repo);
    if (!exact.pr) {
      return unresolvableFromNarrowing({
        outcome: "identity-unresolved",
        branch: deliveryIdentity.branch,
        recordedUnusable: exact.reason ?? "recorded delivery identity PR cannot be verified",
      });
    }
    return {
      kind: "resolved",
      headSha: deliveryIdentity.binding.headSha,
      displayName: exact.pr.displayName,
      pr: { owner: exact.pr.owner, repo: exact.pr.repo, number: exact.pr.number },
    };
  }
  if (deliveryIdentity.recordedUnusable) {
    return unresolvableFromNarrowing({
      outcome: "identity-unresolved",
      branch: null,
      recordedUnusable: deliveryIdentity.recordedUnusable,
    });
  }

  // SUP-16667: resolve the card's linked PRs with drafts INCLUDED so a head that
  // is only unresolvable because it is a draft is refused with its own named
  // reason (`head_draft`) instead of the misleading `no-pr` — which reads as a
  // missing link and sends the reader to the wrong place (the `draft` state key
  // lives in external_objects.data, not in any arming message). Drafts are then
  // EXCLUDED from the authorizing set below: arming a draft is wrong (GitHub
  // refuses auto-merge on a draft), so every arming decision is unchanged and
  // only the refusal vocabulary is sharpened.
  const linkedPRsWithDrafts = await resolveLinkedPullRequests(db, companyId, issueId, { includeDrafts: true });
  const draftLinkedPRs = linkedPRsWithDrafts.filter((pr) => pr.draft === true);
  const linkedPRs = linkedPRsWithDrafts.filter((pr) => pr.draft !== true);

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
      ? { kind: "resolved", headSha: head.headSha, displayName: pr.displayName, pr: { owner: pr.owner, repo: pr.repo, number: pr.number } }
      : { kind: "unresolvable", reason: head.reason };
  }

  // Zero cached linked PRs: mirror publishApprovalStatus's live re-resolve so
  // the decision-time head matches what the publish would have resolved.
  const withState = await resolveLinkedPullRequestsWithState(db, companyId, issueId);

  // SUP-14917: the shared live workspace re-resolve (formerly inlined here). It
  // returns the matches + a terminal failure as data, so this resolver maps the
  // failure to its own bare `reason` form via
  // decisionHeadFailureFromWorkspaceDiscovery — the same reasons the inline loop
  // used to return, byte-for-byte.
  const discovery = await discoverCardPullRequestByWorkspace(
    db,
    companyId,
    issueId,
    issueIdentifier,
    closingTransition,
    withState,
    // SUP-16667: include drafts so a workspace-discovered draft-only head is
    // reported as `head_draft`; drafts are excluded from the authorizing set
    // immediately below, so arming semantics are unchanged.
    true,
  );
  if (discovery.terminalFailure) {
    return decisionHeadFailureFromWorkspaceDiscovery(discovery.terminalFailure);
  }
  const draftMatched = discovery.matched.filter((pr) => pr.draft === true);
  const matched = discovery.matched.filter((pr) => pr.draft !== true);

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
      ? { kind: "resolved", headSha: head.headSha, displayName: pr.displayName, pr: { owner: pr.owner, repo: pr.repo, number: pr.number } }
      : { kind: "unresolvable", reason: head.reason };
  }
  // SUP-16667: the only unresolved candidate is an open DRAFT. That is not
  // "no PR" — the link exists and the PR is live; it simply cannot be armed
  // until it is promoted out of draft (GitHub refuses auto-merge on a draft).
  // Name it so the refusal is diagnosable from the message alone. No
  // pendingCandidates here on purpose: attaching the no-pr delivery-branch
  // anchor would let the approval-status reconciler stamp the draft head by
  // content identity — re-introducing the arming-of-a-draft this refusal exists
  // to prevent. Once the PR is promoted, the ordinary republish path re-resolves
  // the head and arms normally (the #717 recovery).
  const draftNames = [
    ...new Set([...draftLinkedPRs, ...draftMatched].map((pr) => pr.displayName)),
  ];
  if (draftNames.length > 0) {
    const verb = draftNames.length === 1 ? "is an open draft PR" : "are open draft PRs";
    return {
      kind: "unresolvable",
      reason: `head_draft: ${draftNames.join(", ")} ${verb}; a draft head cannot be armed (GitHub refuses auto-merge on a draft) — promote it out of draft, then republish`,
    };
  }

  // SUP-15016: no-pr is unresolvable at decision time, but on a CLOSING transition
  // the certification the producer had in hand must not be discarded. The card's OWN
  // delivery branch is resolvable even with no PR (resolveDeliveryIdentity), so
  // certify its live head now — the same fail-open-to-null convention as the
  // ambiguous class. Gated on closingTransition exactly like the live discovery
  // above (discoverCardPullRequestByWorkspace): a stage approval that redirects a
  // requested `done` to a later stage (in_review) is not a delivery transition and
  // must make no delivery probe — certifying here would wedge every multi-stage
  // review. A card with no own branch certifies nothing (acceptance #3) and behaves
  // exactly as today.
  const noPrAnchor = closingTransition
    ? await certifyNoPrDeliveryBranchHead(db, companyId, issueId)
    : null;
  return {
    kind: "unresolvable",
    reason: "no-pr: no open linked PR resolvable at decision time",
    pendingCandidates: noPrAnchor ? [noPrAnchor] : undefined,
  };
}

function samePullRequest(
  left: { owner: string; repo: string; number: number },
  right: { owner: string; repo: string; number: number },
): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase() && left.number === right.number;
}

const finalDeliveryLiveSchema = z.object({
  state: z.string(), draft: z.boolean(), merged: z.boolean(), title: z.string(),
  head: z.object({ sha: z.string().min(1), ref: z.string(), repo: z.object({ full_name: z.string() }) }),
});

/** Read-only final-stage certification; no approval or status writes. */
export async function preflightFinalDelivery(
  db: Db, companyId: string, issueId: string, identifier: string,
): Promise<DecisionHeadResolution> {
  const resolved = await resolveApprovalDecisionHead(db, companyId, issueId, identifier, true);
  if (resolved.kind !== "resolved") return resolved;
  const { pr } = resolved;
  const candidates = await resolveGitHubTokenCandidatesForRepo(db, companyId, pr.owner, pr.repo);
  for (const candidate of candidates) {
    const response = await ghFetch(
      `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}`,
      { headers: { authorization: `Bearer ${candidate.token}`, accept: "application/vnd.github+json" } },
    );
    if (response.status === 401 || response.status === 403) continue;
    if (!response.ok) return { kind: "unresolvable", reason: `head_unverifiable: HTTP ${response.status}` };
    const parsed = finalDeliveryLiveSchema.safeParse(await response.json());
    if (!parsed.success) return { kind: "unresolvable", reason: "head_unverifiable: incomplete live PR response" };
    const live = parsed.data;
    if (live.state !== "open" || live.merged !== false) {
      return { kind: "unresolvable", reason: "head_not_open: delivery must be OPEN and unmerged" };
    }
    if (live.draft !== false) {
      return { kind: "unresolvable", reason: "head_draft: promote the owner PR out of draft, then submit a fresh final review" };
    }
    if (live.head?.sha !== resolved.headSha) {
      return { kind: "unresolvable", reason: "head_moved: delivery changed during final preflight; review the new head" };
    }
    const narrowed = await narrowToDelivered(db, companyId, issueId, [{
      ...pr, headRefName: live.head.ref, displayName: resolved.displayName,
    }]);
    if (live.head.repo?.full_name?.toLowerCase() !== `${pr.owner}/${pr.repo}`.toLowerCase() ||
        narrowed.outcome !== "narrowed") {
      return { kind: "unresolvable", reason: "not_delivered: live PR is not the owner's recorded repo delivery" };
    }
    return resolved;
  }
  return { kind: "unresolvable", reason: "head_unverifiable: no credential can verify the live delivery" };
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

/**
 * SUP-15016: certifies the card's OWN delivery-branch head at approval time for a
 * `no-pr` unresolvable decision. Returns a single `NoPrBranchAnchor`, or null when
 * there is nothing to certify: no recorded branch, no resolvable delivery repo, or
 * the recorded branch belongs to another issue (`branchIsOwn: false`). A readable
 * branch ref yields its live head sha; an unreadable ref yields `headSha: null`
 * (the consumer fails closed on null) rather than dropping the certification.
 */
async function certifyNoPrDeliveryBranchHead(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<NoPrBranchAnchor | null> {
  const identity = await resolveDeliveryIdentity(db, companyId, issueId);
  if (identity.branch === null || identity.repo === null) return null;
  if (!identity.branchIsOwn) return null;
  const headSha = await fetchBranchHeadShaAcrossCandidates(
    db,
    companyId,
    identity.repo.owner,
    identity.repo.repo,
    identity.branch,
  );
  return {
    owner: identity.repo.owner,
    repo: identity.repo.repo,
    branch: identity.branch,
    headSha,
    certifiedAt: new Date().toISOString(),
    source: "no-pr-branch",
  };
}

/**
 * SUP-15016: resolve a delivery-branch ref's live head SHA across a list of token
 * candidates (401/403 advances to the next candidate), or null when none could
 * fetch it. Fail-open-to-null, matching the ambiguous-class convention: an
 * unreadable ref is anchored to null (the reconciler fails closed on it) rather
 * than dropped.
 */
async function fetchBranchHeadShaAcrossCandidates(
  db: Db,
  companyId: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  const candidates = await resolveGitHubTokenCandidatesForRepo(db, companyId, owner, repo);
  if (candidates.length === 0) return null;
  for (let i = 0; i < candidates.length; i++) {
    const result = await fetchBranchHeadSha(candidates[i]!.token, owner, repo, branch);
    if (result.ok) return result.headSha;
    if ((result.status === 401 || result.status === 403) && i < candidates.length - 1) continue;
    return null;
  }
  return null;
}

/**
 * Reads one delivery-branch ref's live head SHA from the GitHub refs API.
 * SUP-17273: the no-PR approval path certifies the delivery-branch head through
 * this read, so it gets the same bounded transient retry as the PR-head reads.
 * A transient 500/502/503/504 or network error is retried on the SAME token; a
 * 4xx (incl. 404) is deterministic and returns immediately so
 * fetchBranchHeadShaAcrossCandidates' candidate rotation is preserved.
 * Exported so the no-PR approval-time branch-head read's retry is directly
 * testable (mirrors the other exported arming reads).
 */
export async function fetchBranchHeadSha(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ ok: true; headSha: string; status: number } | { ok: false; status: number }> {
  return withTransientReadRetry(() => fetchBranchHeadShaOnce(token, owner, repo, branch));
}

async function fetchBranchHeadShaOnce(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ ok: true; headSha: string; status: number } | { ok: false; status: number }> {
  const refPath = branch.split("/").map(encodeURIComponent).join("/");
  const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo,
  )}/git/refs/heads/${refPath}`;
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
    return { ok: false, status: 0 };
  }

  if (!response.ok) return { ok: false, status: response.status };

  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  const object = body?.object as Record<string, unknown> | undefined | null;
  const sha = object?.sha as string | undefined;
  if (typeof sha === "string" && sha.length > 0) return { ok: true, headSha: sha, status: response.status };
  return { ok: false, status: response.status };
}

/**
 * SUP-15315: resolves one PR's live head SHA across the resolvable token
 * candidates (401/403 advances to the next candidate). Exposed so the
 * done-close-landing backstop's head-authorization gate can read a head without
 * re-deriving the token path: a positive SHA on success, a named `reason`
 * (never a guessed head) when it cannot be read.
 */
export async function fetchHeadViaTokenCandidates(
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

/**
 * SUP-15315: reads whether a PR's live head carries a `paperclip/approved`
 * commit status with state `success`, across the resolvable token candidates
 * (401/403 advances to the next candidate). A 2xx with zero or non-matching
 * statuses resolves to `{ ok: true, approved: false }` — the head is positively
 * UNSTAMPED, which the caller treats as a refusal. A terminal transport, auth,
 * rate-limit, or 4xx/5xx error resolves to `{ ok: false, reason }` —
 * unresolvable, which the caller defers (fail closed). Reuses the shared
 * ghFetch transport and writes nothing.
 */
export async function fetchHeadApprovedStatusViaTokenCandidates(
  db: Db,
  companyId: string,
  owner: string,
  repo: string,
  headSha: string,
  options: HeadStatusReadOptions = {},
): Promise<{ ok: true; approved: boolean; controlPlaneApproved: boolean } | { ok: false; reason: string }> {
  const candidates = await resolveGitHubTokenCandidatesForRepo(db, companyId, owner, repo);
  if (candidates.length === 0) {
    const tokenResult = await resolveGitHubTokenForRepo(db, companyId, owner, repo);
    const reason = isGitHubTokenResolution(tokenResult)
      ? `auth_required: no GitHub token resolvable for ${owner}/${repo}`
      : `auth_required: ${tokenResult.reason}`;
    return { ok: false, reason };
  }
  let lastStatus = 0;
  let lastMessage: string | null = null;
  for (const candidate of candidates) {
    const result = await fetchHeadCommitStatuses(candidate.token, owner, repo, headSha, options);
    if (result.ok) return { ok: true, approved: result.approved, controlPlaneApproved: result.controlPlaneApproved };
    lastStatus = result.status;
    lastMessage = result.message;
    if ((result.status === 401 || result.status === 403) && candidate !== candidates[candidates.length - 1]) {
      continue;
    }
    break;
  }
  if (lastStatus === 404) return { ok: false, reason: "pr_not_found: HTTP 404" };
  if (lastStatus === 429) return { ok: false, reason: "pr_rate_limited: HTTP 429" };
  if (lastStatus === 0) return { ok: false, reason: `pr_network: ${lastMessage ?? "network_error"}` };
  if (lastStatus === 401 || lastStatus === 403) {
    const scopeDetail =
      candidates.length === 1
        ? `(scope=${candidates[0]!.scope}, secretName=${candidates[0]!.secretName})`
        : `(tried: ${candidates.map((c) => `${c.scope}/${c.secretName}`).join(", ")})`;
    return { ok: false, reason: `pr_auth: HTTP ${lastStatus} ${lastMessage ?? ""} ${scopeDetail}` };
  }
  return { ok: false, reason: `pr_error: HTTP ${lastStatus} ${lastMessage ?? ""}` };
}

/**
 * SUP-15953: the ejection reason the merge queue removed a PR for. `reason` is
 * nullable because GitHub returns the field as `String` and a malformed event
 * must never be read as "not a conflict" — the caller defers on null.
 */
export interface MergeQueueEjectionEvent {
  reason: string | null;
  createdAt: string | null;
  /**
   * The merge-queue GROUP commit oid the queue held at ejection. This is a
   * synthetic commit that is structurally DISTINCT from the PR's own head — it
   * is retained as audit context only, NEVER compared by oid to the live head to
   * prove the head moved. Finding:
   * merge-conflict-ejection-compares-head-to-queue-group-commit.
   */
  beforeCommitOid: string | null;
}

export type MergeQueueEjectionReadResult =
  | {
      ok: true;
      headRefOid: string;
      /** The live head commit's creation time, or null when the head target is not a commit. */
      headCommitAt: string | null;
      lastEjection: MergeQueueEjectionEvent | null;
    }
  | { ok: false; reason: string };

type MergeQueueEjectionFetch =
  | {
      ok: true;
      headRefOid: string;
      headCommitAt: string | null;
      lastEjection: MergeQueueEjectionEvent | null;
      status: number;
      message: string | null;
    }
  | { ok: false; status: number; message: string | null };

// SUP-15953: a PR's most recent merge-queue ejection PLUS its current head, in
// one GraphQL round-trip. The ejection `reason` is available ONLY here — the REST
// timeline omits it — so this read has no REST fallback. `beforeCommit.oid` is
// the merge-queue GROUP commit the queue held (NOT the PR head); it is read for
// audit context only. The head-movement predicate instead reads the live head
// commit's `committedDate` and compares it to the ejection `createdAt` — the
// head has moved iff that commit postdates the ejection.
const MERGE_QUEUE_EJECTION_QUERY = `query PaperclipMergeQueueEjection($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      headRef {
        target {
          ... on Commit {
            committedDate
          }
        }
      }
      timelineItems(last: 50, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        nodes {
          ... on RemovedFromMergeQueueEvent {
            reason
            createdAt
            beforeCommit {
              oid
            }
          }
        }
      }
    }
  }
}`;

// SUP-15953: pick the most recent ejection from a GraphQL
// `timelineItems(last:)` node list. GitHub returns those nodes in chronological
// order (oldest first), so the most recent ejection is the LAST non-null node.
// Recency is established by ARRAY POSITION ONLY: a parsed timestamp is never used
// for ordering, so a malformed/missing `createdAt` (or a null reason) on the
// newest event can never make an OLDER, readable event win — that would be
// fail-open (e.g. picking an older `failed_checks` event over a newer,
// unreadable one and re-enqueueing a `merge_conflict` head). When the picked
// event's `reason` is unreadable, `reason` stays null and the caller defers
// (fail closed). Finding: latest-ejection-invalid-timestamp-fail-open.
export function pickMostRecentMergeQueueEjection(
  nodes: Array<Record<string, unknown> | null>,
): MergeQueueEjectionEvent | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (!node || typeof node !== "object") continue;
    const createdAt = typeof node.createdAt === "string" ? node.createdAt : null;
    const beforeCommit = node.beforeCommit as Record<string, unknown> | undefined;
    return {
      reason: typeof node.reason === "string" && node.reason.length > 0 ? node.reason : null,
      createdAt,
      beforeCommitOid:
        typeof beforeCommit?.oid === "string" && beforeCommit.oid.length > 0
          ? beforeCommit.oid
          : null,
    };
  }
  return null;
}

async function fetchMergeQueueEjection(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<MergeQueueEjectionFetch> {
  let response: Response;
  try {
    response = await ghFetch(GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/vnd.github+json",
        "user-agent": "paperclip-merge-arming",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: MERGE_QUEUE_EJECTION_QUERY,
        variables: { owner, repo, number },
      }),
    });
  } catch {
    return { ok: false, status: 0, message: "network_error" };
  }

  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  const errors = body?.errors as Array<{ message?: string }> | undefined;
  if (!response.ok || (errors && errors.length > 0)) {
    const message =
      errors?.[0]?.message
      ?? readString(body?.message)
      ?? `HTTP ${response.status}`;
    return { ok: false, status: response.status, message };
  }

  const data = body?.data as Record<string, unknown> | undefined;
  const repository = data?.repository as Record<string, unknown> | undefined;
  const pullRequest = repository?.pullRequest as Record<string, unknown> | undefined;
  if (!pullRequest) {
    return { ok: false, status: response.status, message: "pull_request_missing" };
  }
  const headRefOid =
    typeof pullRequest.headRefOid === "string" && pullRequest.headRefOid.length > 0
      ? pullRequest.headRefOid
      : null;
  if (headRefOid === null) {
    return { ok: false, status: response.status, message: "head_oid_missing" };
  }
  // The live head commit's creation time — the "has the head moved since the
  // ejection" signal. Null when the head ref target is not a Commit (e.g. a tag
  // object); the caller then fails closed rather than assuming head movement.
  const headRef = pullRequest.headRef as Record<string, unknown> | undefined;
  const headTarget = headRef?.target as Record<string, unknown> | undefined;
  const headCommitAt = readString(headTarget?.committedDate);

  const timelineItems = pullRequest.timelineItems as Record<string, unknown> | undefined;
  const nodes = Array.isArray(timelineItems?.nodes)
    ? (timelineItems!.nodes as Array<Record<string, unknown> | null>)
    : [];
  // Recency is decided by array position only (chronological); an unreadable
  // newest event never yields to an older readable one — see
  // `pickMostRecentMergeQueueEjection`.
  const lastEjection = pickMostRecentMergeQueueEjection(nodes);

  return { ok: true, headRefOid, headCommitAt, lastEjection, status: response.status, message: null };
}

/**
 * SUP-15953: resolves a PR's current head oid and its most recent
 * `RemovedFromMergeQueueEvent` across the resolvable token candidates (401/403
 * advances to the next candidate). A terminal failure returns
 * `{ ok: false, reason }` so the caller fails closed — it must never re-enqueue
 * on an assumption about why the queue ejected a PR.
 */
export async function fetchLastMergeQueueEjectionViaTokenCandidates(
  db: Db,
  companyId: string,
  owner: string,
  repo: string,
  number: number,
): Promise<MergeQueueEjectionReadResult> {
  const candidates = await resolveGitHubTokenCandidatesForRepo(db, companyId, owner, repo);
  if (candidates.length === 0) {
    const tokenResult = await resolveGitHubTokenForRepo(db, companyId, owner, repo);
    const reason = isGitHubTokenResolution(tokenResult)
      ? `auth_required: no GitHub token resolvable for ${owner}/${repo}`
      : `auth_required: ${tokenResult.reason}`;
    return { ok: false, reason };
  }
  let lastStatus = 0;
  let lastMessage: string | null = null;
  for (const candidate of candidates) {
    const result = await fetchMergeQueueEjection(candidate.token, owner, repo, number);
    if (result.ok) {
      return { ok: true, headRefOid: result.headRefOid, headCommitAt: result.headCommitAt, lastEjection: result.lastEjection };
    }
    lastStatus = result.status;
    lastMessage = result.message;
    if ((result.status === 401 || result.status === 403) && candidate !== candidates[candidates.length - 1]) {
      continue;
    }
    break;
  }
  if (lastStatus === 404) return { ok: false, reason: "pr_not_found: HTTP 404" };
  if (lastStatus === 429) return { ok: false, reason: "pr_rate_limited: HTTP 429" };
  if (lastStatus === 0) return { ok: false, reason: `pr_network: ${lastMessage ?? "network_error"}` };
  if (lastStatus === 401 || lastStatus === 403) {
    const scopeDetail =
      candidates.length === 1
        ? `(scope=${candidates[0]!.scope}, secretName=${candidates[0]!.secretName})`
        : `(tried: ${candidates.map((c) => `${c.scope}/${c.secretName}`).join(", ")})`;
    return { ok: false, reason: `pr_auth: HTTP ${lastStatus} ${lastMessage ?? ""} ${scopeDetail}` };
  }
  return { ok: false, reason: `pr_error: HTTP ${lastStatus} ${lastMessage ?? ""}` };
}

// The `tea-core` App; the only identity scripts/ci/check-paperclip-approved.sh accepts as the
// producer of `paperclip/approved` (its APPROVED_STATUS_CREATOR_ID default).
export const CONTROL_PLANE_STATUS_CREATOR_ID = "317012809";

/**
 * SUP-15315: reads one head SHA's commit statuses from the GitHub statuses API
 * (GET, read-only) and reports whether a `paperclip/approved` status with state
 * `success` is present. Uses the shared ghFetch transport — no new HTTP layer.
 */
/**
 * How a head's `paperclip/approved` statuses are read. `strict` is for deciding whether to arm a merge:
 * only the NEWEST status counts, and it must be a control-plane success. A board release (SUP-20772) is a
 * human decision on one head and not a review, so under `strict` it counts only when it is the status the
 * publisher CONFIRMED: `confirmedReleaseStatusId` is that status's id, and any other release status (one
 * whose confirmation is unknown, a later duplicate, a voided one) is not consumed.
 */
export interface HeadStatusReadOptions {
  strict?: boolean;
  confirmedReleaseStatusId?: string | null;
  signal?: AbortSignal;
}

interface HeadStatusRead {
  ok: boolean;
  approved: boolean;
  controlPlaneApproved: boolean;
  /** The newest status, when it is a control-plane success: its id, whether it is a board release, and its description. */
  newest: { id: string | null; release: boolean; description: string | null } | null;
  /** Ids of the release statuses the control plane has marked confirmed on this head (see RELEASE_CONFIRMED_CONTEXT). */
  confirmedMarkers: string[];
  status: number;
  message: string | null;
}

async function fetchHeadCommitStatusesOnce(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  options: HeadStatusReadOptions = {},
): Promise<HeadStatusRead> {
  const url =
    `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/statuses/${encodeURIComponent(headSha)}?per_page=100`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-merge-arming",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };

  let response: Response;
  try {
    response = await ghFetch(url, { headers, signal: options.signal });
  } catch {
    return { ok: false, approved: false, controlPlaneApproved: false, newest: null, confirmedMarkers: [], status: 0, message: "network_error" };
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const message = body?.message as string | undefined;
    return { ok: false, approved: false, controlPlaneApproved: false, newest: null, confirmedMarkers: [], status: response.status, message: message ?? null };
  }

  const body = await response.json().catch(() => null);
  const list = Array.isArray(body) ? body : [];
  const confirmedMarkers: string[] = [];
  let approved = false;
  let newestSeen = false;
  let controlPlaneApproved = false;
  let newest: HeadStatusRead["newest"] = null;
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const status = raw as Record<string, unknown>;
    if (status.context === RELEASE_CONFIRMED_CONTEXT) {
      const markerCreator = status.creator as Record<string, unknown> | null | undefined;
      const confirmed = typeof status.description === "string" ? /^confirms status (\d+)$/.exec(status.description)?.[1] : undefined;
      if (status.state === "success" && String(markerCreator?.id ?? "") === CONTROL_PLANE_STATUS_CREATOR_ID && confirmed) confirmedMarkers.push(confirmed);
      continue;
    }
    if (status.context !== "paperclip/approved") continue;
    if (!options.strict && status.state === "success") approved = true;
    if (!newestSeen) {
      newestSeen = true;
      const creator = status.creator as Record<string, unknown> | null | undefined;
      controlPlaneApproved = status.state === "success" && String(creator?.id ?? "") === CONTROL_PLANE_STATUS_CREATOR_ID;
      const id = status.id === undefined || status.id === null ? null : String(status.id);
      const release = isHeadBoundReleaseDescription(status.description);
      if (controlPlaneApproved) newest = { id, release, description: typeof status.description === "string" ? status.description : null };
      // Strict reading, for deciding whether to arm a merge: only the NEWEST paperclip/approved status
      // counts (a later failure revokes an earlier success), it must have been written by the control
      // plane (a success from any other identity is a forgery, not a stamp), and a board release counts
      // only when it is the one the publisher confirmed (SUP-20772).
      if (options.strict) {
        approved = controlPlaneApproved &&
          (!release || (id !== null && options.confirmedReleaseStatusId != null && id === options.confirmedReleaseStatusId));
      }
    }
  }
  return { ok: true, approved, controlPlaneApproved, newest, confirmedMarkers, status: response.status, message: null };
}

/**
 * SUP-17273: read a head's commit statuses, retrying transient transport
 * failures (network error / 5xx) with a bounded backoff before yielding the
 * terminal result. A deterministic result (success, 4xx) returns after the first
 * attempt — byte-for-byte unchanged from the single-attempt read.
 */
async function fetchHeadCommitStatuses(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  options: HeadStatusReadOptions = {},
): Promise<HeadStatusRead> {
  return withTransientReadRetry(() => fetchHeadCommitStatusesOnce(token, owner, repo, headSha, options), { signal: options.signal });
}

export interface HeadShaSuccess extends GitHubFetchResult {
  ok: true;
  headSha: string;
  state: string | null;
  headRef: string | null;
  open: boolean;
  draft: boolean;
  merged: boolean;
}

export interface HeadShaFailure extends GitHubFetchResult {
  ok: false;
  headSha: null;
  state?: null;
  headRef: null;
  open: null;
  draft: null;
  merged: null;
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

async function fetchPullRequestHeadShaOnce(
  token: string,
  owner: string,
  repo: string,
  number: number,
  signal?: AbortSignal,
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
    response = await ghFetch(url, { headers, signal });
  } catch {
    return { ok: false, status: 0, message: "network_error", headSha: null, headRef: null, open: null, draft: null, merged: null };
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const message = body?.message as string | undefined;
    return { ok: false, status: response.status, message: message ?? null, headSha: null, headRef: null, open: null, draft: null, merged: null };
  }

  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) {
    return {
      ok: false,
      status: response.status,
      message: "empty_response",
      headSha: null,
      headRef: null,
      open: null,
      draft: null,
      merged: null,
    };
  }

  const head = body.head as Record<string, unknown> | undefined;
  const sha = head?.sha as string | undefined;
  const ref = typeof head?.ref === "string" && head.ref.length > 0 ? head.ref : null;
  if (typeof sha === "string" && sha.length > 0) {
    return {
      ok: true,
      status: response.status,
      message: null,
      headSha: sha,
      state: typeof body.state === "string" ? body.state : null,
      headRef: ref,
      open: body.state === "open" && body.merged !== true,
      draft: body.draft === true,
      merged: body.merged === true,
    };
  }
  return {
    ok: false,
    status: response.status,
      message: "head.sha missing from response",
      headSha: null,
      headRef: null,
      open: null,
      draft: null,
      merged: null,
    };
}

/**
 * SUP-17273: one PR's live head SHA, retrying transient transport failures
 * (network error / 5xx) with a bounded backoff before yielding the terminal
 * HeadShaResult. A deterministic result (success, 4xx, malformed body) returns
 * after the first attempt — byte-for-byte unchanged from the single-attempt read.
 */
async function fetchPullRequestHeadSha(
  token: string,
  owner: string,
  repo: string,
  number: number,
  signal?: AbortSignal,
): Promise<HeadShaResult> {
  return withTransientReadRetry(() => fetchPullRequestHeadShaOnce(token, owner, repo, number, signal), { signal });
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

/**
 * Lists a repo's open PRs for the approval-time discovery loop.
 * SUP-17273: this is a head/PR resolution read, so it gets the same bounded
 * transient retry as the other arming reads. A transient 500/502/503/504 or
 * network error is retried on the SAME token; a 4xx (incl. 404/429) is
 * deterministic and returns immediately.
 */
export async function fetchOpenPullRequests(
  token: string,
  owner: string,
  repo: string,
  hostname: string = "github.com",
): Promise<OpenPullRequestsResult> {
  return withTransientReadRetry(() => fetchOpenPullRequestsOnce(token, owner, repo, hostname));
}

async function fetchOpenPullRequestsOnce(
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
  description?: string,
  state: "success" | "failure" = "success",
  signal?: AbortSignal,
  context: string = "paperclip/approved",
): Promise<{ success: boolean; error: string | null; status: number; transient: boolean; statusId?: string | null }> {
  const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/statuses/${encodeURIComponent(headSha)}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-merge-arming",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };

  const body = JSON.stringify({
    state,
    context,
    description: description ?? `${issueIdentifier} approved via Paperclip`,
    ...(issueIdentifier ? { target_url: `https://paperclip.example.com/issues/${issueIdentifier}` } : {}),
  });

  let response: Response;
  try {
    response = await ghFetch(url, {
      method: "POST",
      headers,
      body,
      signal,
    });
  } catch {
    // No response at all — the request never reached GitHub. Transient by
    // definition: the network path is the only thing standing between us and a
    // write, so a retry is warranted (SUP-16081 fix #2).
    return { success: false, error: "network_error", status: 0, transient: true };
  }

  if (response.ok) {
    const created = await response.json().catch(() => null) as Record<string, unknown> | null;
    const id = created?.id;
    return {
      success: true,
      error: null,
      status: response.status,
      transient: false,
      statusId: typeof id === "number" || (typeof id === "string" && id.length > 0) ? String(id) : null,
    };
  }

  const responseBody = await response.json().catch(() => null) as Record<string, unknown> | null;
  const message = responseBody?.message as string | undefined;

  if (response.status === 403 || response.status === 422) {
    // A scope/permission/shape refusal is a deterministic operator signal — the
    // same token and payload will refuse again, so retrying is wrong.
    const detail = message ?? "";
    return {
      success: false,
      error: `scope_missing: HTTP ${response.status} ${detail}`,
      status: response.status,
      transient: false,
    };
  }

  return {
    success: false,
    error: message ?? `HTTP ${response.status}`,
    status: response.status,
    transient: isTransientHttpStatus(response.status),
  };
}

/**
 * SUP-16081 fix #2. Transient-vs-deterministic split for a failed GitHub status
 * write. Transient = the write may succeed if retried: no response (network
 * error, status 0), rate-limited (429), server-error (5xx), or request-timeout
 * (408). Every other 4xx (401/403/404/422/400/...) is a deterministic refusal —
 * the same request will refuse again — and must NOT be retried: it is operator
 * signal (a missing scope, a bad head, a forbidden path).
 */
export function isTransientHttpStatus(status: number): boolean {
  if (status === 0) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500 && status <= 599;
}

/**
 * SUP-17273: transient-vs-deterministic split for a head/PR RESOLUTION read.
 * Transient = the transport may succeed if retried: no response (network error,
 * status 0) or one of the four gateway/server-unavailable errors a short wait can
 * clear — 500, 502, 503, 504. This is the EXACT allowlist the arming read retry is
 * contracted to: the other 5xx (501 Not Implemented, 505 HTTP Version Not
 * Supported, 599) are deterministic and must NOT be retried. Every 4xx — including
 * 401/403/404/429 — is a deterministic refusal and must NOT be retried on the read
 * path: the candidate loops already advance tokens on 401/403 and treat 404/429 as
 * terminal. This is intentionally NARROWER than isTransientHttpStatus, which also
 * treats 408/429 and the full 5xx band as retryable for the status-WRITE path.
 */
export function isTransientReadStatus(status: number): boolean {
  if (status === 0) return true;
  return status === 500 || status === 502 || status === 503 || status === 504;
}

export interface TransientReadRetryOptions {
  /** Total attempts (default 3). */
  attempts?: number;
  /** Milliseconds between attempts (default 1000). */
  delayMs?: number;
  /** Injectable delay seam for tests (defaults to a real setTimeout). */
  delay?: (ms: number) => Promise<void>;
  /** A caller's deadline: once aborted, no further attempt is made and the wait between attempts ends. */
  signal?: AbortSignal;
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * SUP-17273. Wrap a head/PR resolution READ with a bounded retry over the
 * transient class only (network error / 500/502/503/504 — see
 * isTransientReadStatus). A non-transient result — success (2xx), a
 * deterministic 4xx or non-allowlisted 5xx, or a malformed body — returns after
 * the first attempt. A transient failure is retried on the SAME token up to
 * `attempts` total times with `delayMs` between attempts; the loop stops the
 * moment a non-transient result is observed. The retry never advances token
 * candidates (that is the caller's job on 401/403) — a transient failure is
 * transport, not auth, so re-reading with the same token is the correct recovery.
 */
export async function withTransientReadRetry<T extends { status: number }>(
  fetchOnce: () => Promise<T>,
  options: TransientReadRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delayMs = options.delayMs ?? 1000;
  const delay = options.delay ?? ((ms: number) => abortableDelay(ms, options.signal));

  let result = await fetchOnce();
  let made = 1;
  while (isTransientReadStatus(result.status) && made < attempts && !options.signal?.aborted) {
    await delay(delayMs);
    if (options.signal?.aborted) break;
    result = await fetchOnce();
    made += 1;
  }
  return result;
}

export interface WriteCommitStatusRetryOptions {
  /** Total attempts (default 3). */
  attempts?: number;
  /** Milliseconds between attempts (default 1000). */
  delayMs?: number;
  /** Injectable delay seam for tests (defaults to a real setTimeout). */
  delay?: (ms: number) => Promise<void>;
  /** Overrides the default "<issue> approved via Paperclip" status description. */
  description?: string;
  /** The status state to write (default success). */
  state?: "success" | "failure";
  /** A caller's deadline: cancels the request in flight and stops further attempts. */
  signal?: AbortSignal;
  /** The status context to write (default `paperclip/approved`). */
  context?: string;
}

export interface WriteCommitStatusResult {
  success: boolean;
  error: string | null;
  /** The last attempt's HTTP status code (0 = network error / no response). */
  status: number;
  /** Whether the last attempt's failure was transient. */
  transient: boolean;
  /** How many attempts were actually made (1 for a deterministic refusal). */
  attempts: number;
  /** GitHub's id for the status it accepted, when the answer carried one. */
  statusId?: string | null;
}

/**
 * SUP-16081 fix #2. Wrap {@link writeCommitStatus} with a bounded retry over the
 * transient class only. A deterministic refusal (403 scope_missing, 404, 422,
 * ...) returns after the first attempt — it is operator signal and must not be
 * retried. A transient failure (network error, 429, 5xx, 408) is retried up to
 * `attempts` total times with `delayMs` between attempts; the moment a write
 * succeeds or a deterministic refusal is observed, the loop stops.
 */
export async function writeCommitStatusWithRetry(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  issueIdentifier: string,
  options: WriteCommitStatusRetryOptions = {},
): Promise<WriteCommitStatusResult> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delayMs = options.delayMs ?? 1000;
  const delay = options.delay ?? ((ms: number) => abortableDelay(ms, options.signal));

  let result = await writeCommitStatus(token, owner, repo, headSha, issueIdentifier, options.description, options.state, options.signal, options.context);
  let made = 1;
  while (!result.success && result.transient && made < attempts && !options.signal?.aborted) {
    await delay(delayMs);
    if (options.signal?.aborted) break;
    result = await writeCommitStatus(token, owner, repo, headSha, issueIdentifier, options.description, options.state, options.signal, options.context);
    made += 1;
  }
  return { ...result, attempts: made };
}

// GitHub rejects a commit-status description over 140 characters.
const COMMIT_STATUS_DESCRIPTION_MAX = 140;

/** `released by <actor> for <sha>: <reason>`, with the reason cut to fit GitHub's limit. */
export function headBoundReleaseDescription(actor: string, headSha: string, reason: string): string {
  const prefix = `released by ${actor} for ${headSha}: `;
  const text = reason.replace(/\s+/g, " ").trim();
  const room = Math.max(COMMIT_STATUS_DESCRIPTION_MAX - prefix.length, 0);
  return `${prefix}${text.length > room ? `${text.slice(0, Math.max(room - 1, 0))}…` : text}`.slice(0, COMMIT_STATUS_DESCRIPTION_MAX);
}

/**
 * The second control-plane status of a board release. The CI check holds no control-plane credential, so
 * it cannot ask the database which release was confirmed; the control plane tells it, on GitHub, by
 * writing this status AFTER the confirmation is committed. CI accepts a release-described success only
 * when this marker names that very status (fail closed). Nothing else writes it.
 */
export const RELEASE_CONFIRMED_CONTEXT = "paperclip/release-confirmed";
export function releaseConfirmedDescription(statusId: string): string {
  return `confirms status ${statusId}`;
}

/** True for a status description written by {@link headBoundReleaseDescription}. */
export function isHeadBoundReleaseDescription(description: unknown): boolean {
  return typeof description === "string" && description.startsWith("released by ");
}

export type HeadBoundReleaseOutcome =
  | { kind: "released" | "already_approved"; headSha: string; message: string; confirmationMarker?: "written" | "pending" }
  /** The status was written, but the PR head had moved on by the time the write was confirmed. */
  | { kind: "stale"; headSha: string; message: string }
  | { kind: "refused" | "failed"; message: string };

/** Why a release was allowed: a certified delivery or completed ladder, or the explicit override. */
export type ReleaseBasis = "certified_delivery" | "approved_ladder" | "override";

/**
 * The PR a board release may target: the one the card's verified delivery identity names. The
 * recorded `executionState.delivery` is cross-checked against the project repo and the card's
 * control-plane delivery branch (resolveDeliveryIdentity), so a PR that was merely cited on the card
 * is never a target. The recorded head is not compared: a release is the board's decision on the
 * live head, and the live PR's branch is matched to the bound branch at publish time instead.
 */
export async function resolveReleaseDeliveryTarget(
  db: Db,
  companyId: string,
  issueId: string,
  opts: {
    headSha: string;
    mode: "standard" | "override";
    /** Null when the card's stage decisions pass the approval path's integrity check, else why not. */
    ladderIntegrity: (conn: Db, issueId: string) => Promise<string | null>;
    /** Null when the decision the certified delivery names was an eligible approval, else why not. */
    certificateProvenance: (conn: Db, issueId: string, decisionId: string) => Promise<string | null>;
  },
): Promise<
  | { ok: true; target: { owner: string; repo: string; number: number; displayName: string; branch: string }; basis: ReleaseBasis }
  | { ok: false; reason: string }
> {
  const identity = await resolveDeliveryIdentity(db, companyId, issueId);
  if (identity.recordedUnusable) return { ok: false, reason: identity.recordedUnusable };
  if (!identity.binding || !identity.repo) {
    return { ok: false, reason: "card has no verified delivery PR binding; a cited PR is not a release target" };
  }
  const bindingError = deliveryBindingValidationError(identity.binding, identity.repo, issueId);
  if (bindingError) return { ok: false, reason: bindingError };
  const { owner, repo } = identity.repo;
  const number = identity.binding.prNumber;
  const [issueRow] = await db
    .select({ status: issues.status, executionPolicy: issues.executionPolicy, executionState: issues.executionState })
    .from(issues)
    .where(eq(issues.id, issueId));
  const state = issueRow?.executionState as Record<string, unknown> | null | undefined;
  // The card is blocked while an auto-merge arm of it is unsettled (a take-back not yet confirmed, or the arm gate still open):
  // a release writes a control-plane success on the head, and that must not happen on top of an arm nobody has settled.
  // Both routes, the override included; it clears when the take-back is confirmed.
  const unsettled = (state?.approvalStatus as Record<string, unknown> | undefined)?.autoMergeDisarm;
  if (unsettled && typeof unsettled === "object") {
    return { ok: false, reason: "an auto-merge take-back is unconfirmed on this card; it is blocked until GitHub confirms auto-merge is off (or the arm settles)" };
  }
  // A card whose review certified one PR for delivery keeps that boundary, on both routes: the release may
  // not move to another PR just because the recorded delivery binding was later pointed elsewhere.
  const certified = readCertifiedFinalDelivery(state);
  const samePrAsCertified = certified !== undefined &&
    certified.number === number &&
    certified.owner.toLowerCase() === owner.toLowerCase() &&
    certified.repo.toLowerCase() === repo.toLowerCase();
  if (certified && !samePrAsCertified) {
    return {
      ok: false,
      reason: `the card's certified final delivery is ${certified.displayName}, not ${owner}/${repo}#${number}; a release may not change the certified PR`,
    };
  }
  const target = { owner, repo, number, displayName: `${owner}/${repo}#${number}`, branch: identity.binding.branch };
  if (opts.mode === "override") return { ok: true, target, basis: "override" };

  // The default route only re-publishes what the card's own review already decided on this exact head.
  if (issueRow?.status === "cancelled") {
    return { ok: false, reason: "the card is cancelled; only the explicit override can release it" };
  }
  let ladderWhy = "the ladder is not complete, or not approved on this head";
  if (samePrAsCertified && certified!.headSha === opts.headSha) {
    // The certificate stands in for the ladder only while the decision that minted it was a genuine
    // approval by someone who is still eligible: it is not exempt from the decider rules.
    const provenance = await opts.certificateProvenance(db, issueId, certified!.decisionId);
    if (provenance === null) return { ok: true, target, basis: "certified_delivery" };
    ladderWhy = provenance;
  }
  // A completed approving ladder, as the approval path (approve-head) understands it: a done card, an
  // approving last decision, a non-empty policy whose every stage is completed, stage decisions that pass
  // the same integrity check (no missing decision, no skipped stage, no self-approval), and an approved
  // head equal to the head being released.
  const approvalStatus = state?.approvalStatus as Record<string, unknown> | null | undefined;
  const decidedHeadMatches = opts.headSha.length > 0 &&
    [approvalStatus?.publishedHeadSha, approvalStatus?.approvedHeadSha].includes(opts.headSha);
  const stages = Array.isArray((issueRow?.executionPolicy as { stages?: unknown } | null)?.stages)
    ? (issueRow!.executionPolicy as { stages: Array<{ id?: unknown } | null> }).stages
    : [];
  const completedIds = Array.isArray(state?.completedStageIds) ? (state!.completedStageIds as unknown[]) : [];
  if (
    issueRow?.status === "done" &&
    state?.lastDecisionOutcome === "approved" &&
    stages.length > 0 &&
    stages.every((stage) => stage !== null && typeof stage === "object" && typeof stage.id === "string" && completedIds.includes(stage.id)) &&
    decidedHeadMatches
  ) {
    const integrity = await opts.ladderIntegrity(db, issueId);
    if (integrity === null) return { ok: true, target, basis: "approved_ladder" };
    ladderWhy = integrity;
  }
  return {
    ok: false,
    reason:
      `the card has no completed approving ladder or certified delivery bound to head ${opts.headSha} (${ladderWhy}); ` +
      "the explicit override (merge-arming/release-override) is the only way to release it",
  };
}

/**
 * Board-triggered merge release: publish `paperclip/approved` on exactly `headSha` of one PR, as
 * the control plane's own App token and no other credential (CI accepts only that creator, so a
 * fallback write would look released and not be). Whether the card may be released at all is decided
 * by the caller (resolveReleaseDeliveryTarget); this function only publishes. The status is keyed by
 * SHA, so a head that moves after the live read cannot inherit it. The live PR is read first and must
 * be open, non-draft, on `expectedBranch` and at `headSha`, even when the head already carries a
 * control-plane success (which is then left alone). Releases of one head are serialized.
 */
/** Bounds on the release path: a hung GitHub call or database wait must not hold the publication lock for ever. */
export interface ReleaseDeadlines {
  /** One GitHub call. */
  fetchMs: number;
  /** Waiting for the publication lock. */
  lockMs: number;
  /** One SQL statement on the lock connection. */
  statementMs: number;
  /**
   * Idle in the lock transaction (it idles while GitHub is called). A backstop that frees the lock if
   * this process dies mid-release; it does not bound the release (every statement resets it).
   */
  idleInTransactionMs: number;
  /**
   * The release as a whole, from the credential lookup to the last write. Its abort signal cancels the
   * GitHub requests in flight and ends every wait, and no further write is started once it has fired.
   */
  totalMs: number;
  /** What the compensating failure writes may still spend after `totalMs` has fired. */
  compensationMs: number;
}
export const DEFAULT_RELEASE_DEADLINES: ReleaseDeadlines = {
  fetchMs: 10_000,
  lockMs: 20_000,
  statementMs: 30_000,
  idleInTransactionMs: 180_000,
  totalMs: 60_000,
  compensationMs: 15_000,
};

/** The advisory-lock key that serializes releases of one head (statuses are repository and SHA scoped). */
export function releaseLockKey(companyId: string, owner: string, repo: string, headSha: string): string {
  return `merge-release:${companyId}:${owner}/${repo}@${headSha}`.toLowerCase();
}

export async function publishHeadBoundRelease(
  db: Db,
  companyId: string,
  target: { owner: string; repo: string; number: number },
  input: {
    headSha: string;
    description: string;
    expectedBranch: string;
    retryDelayMs?: number;
    deadlines?: Partial<ReleaseDeadlines>;
    /** The caller's own end-to-end deadline, when it started the clock earlier (it is combined with `totalMs`). */
    signal?: AbortSignal;
    /** Cancels the late-landing checks that outlive the answer (their timers are cleared and their requests aborted). */
    afterAnswerSignal?: AbortSignal;
    /**
     * Re-resolves eligibility and target from the card as it is now. Called inside the publication
     * lock, right before the write, so a cancel, a reversed decision or a retarget after the first
     * read cannot still release the old target.
     */
    revalidate: (conn: Db) => Promise<
      | { ok: true; target: { owner: string; repo: string; number: number; branch: string } }
      | { ok: false; reason: string }
    >;
    /**
     * Destroys the request's database connection (see createRequestScopedDb). Called when the release is
     * abandoned: an open transaction then rolls back on the server and its lock is freed, so work that was
     * waiting on the database cannot commit after the answer. Absent for a shared-pool client.
     */
    abandon?: () => void | Promise<void>;
    /** The id of the release status the card has CONFIRMED for this head, as it is now, or null. */
    confirmedStatusId: (conn: Db) => Promise<string | null>;
    /**
     * Records that the release wrote and confirmed exactly this status. It runs last, on the lock's own
     * connection: a status that is never confirmed (a write that timed out, a head that could not be
     * re-read, a failed void) has no record, and no consumer acts on a release without one.
     */
    recordConfirmation: (conn: Db, statusId: string) => Promise<void>;
  },
): Promise<HeadBoundReleaseOutcome> {
  const { owner, repo, number } = target;
  const deadlines = { ...DEFAULT_RELEASE_DEADLINES, ...input.deadlines };
  // One clock for the whole release. Its signal is handed to every GitHub request, so a request that
  // outlives the deadline is cancelled and a retry loop stops instead of running on after we return.
  const envelope = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(deadlines.totalMs)]);
  // Where the release is. `open`: nothing is committed and the deadline abandons it. `sealing`: the
  // confirmation is being written and committed; the deadline no longer abandons it (the write is bounded
  // by the connection's statement timeout), so the answer and the committed state cannot disagree.
  // `abandoned`: the deadline fired first; the connection is destroyed and nothing may commit.
  let phase: "open" | "sealing" | "abandoned" | "done" = "open";
  // A success status may be on the head and has not been voided or confirmed (and committed) yet.
  let statusMayExist = false;
  const abandon = () => {
    if (phase !== "open") return;
    phase = "abandoned";
    // A success status that may be on the head is voided while the session, and with it the publication
    // lock, is still held, so a concurrent release of the head cannot write its own success before this
    // release's failure lands. Only then is the session ended.
    Promise.resolve()
      .then(() => (statusMayExist ? voidSuccess(`the deadline passed (${deadlines.totalMs}ms)`) : undefined))
      .catch(() => undefined)
      .then(() => input.abandon?.())
      .catch(() => undefined);
  };
  if (envelope.aborted) abandon();
  else envelope.addEventListener("abort", abandon, { once: true });
  const deadlineOutcome = (): HeadBoundReleaseOutcome => ({
    kind: "failed",
    message: `status:failed:deadline: the release did not finish within ${deadlines.totalMs}ms; a status write that was in flight has an unknown outcome and is not consumable`,
  });
  const aborted = Symbol("aborted");
  // Waits for `work`, or gives up when the envelope fires. Work that cannot be cancelled (a database
  // wait, the secret store) is abandoned, not awaited, and its late failure is swallowed.
  const raceEnvelope = <T>(work: Promise<T>): Promise<T | typeof aborted> => {
    work.catch(() => undefined);
    return Promise.race([
      work,
      new Promise<typeof aborted>((resolve) => {
        if (envelope.aborted) resolve(aborted);
        else envelope.addEventListener("abort", () => resolve(aborted), { once: true });
      }),
    ]);
  };
  const credential = await raceEnvelope(resolveControlPlaneGitHubToken(db, companyId, owner, repo, envelope));
  if (credential === aborted || (!credential && envelope.aborted)) {
    phase = "done";
    return deadlineOutcome();
  }
  if (!credential) {
    phase = "done";
    return { kind: "failed", message: `status:failed:auth_required: control-plane GitHub App credential unavailable for ${owner}/${repo}` };
  }
  // One GitHub call, cancelled and given up on after `fetchMs` or when `parent` fires.
  let compensationSignal: AbortSignal | undefined;
  // The compensating failure writes outlive `totalMs`, so they run on their own, later, clock.
  const compensation = () => (compensationSignal ??= AbortSignal.timeout(deadlines.compensationMs));
  const bounded = async <T>(run: (signal: AbortSignal) => Promise<T>, onTimeout: T, parent: AbortSignal = envelope): Promise<T> => {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(deadlines.fetchMs)]);
    const gaveUp = new Promise<T>((resolve) => {
      if (signal.aborted) resolve(onTimeout);
      else signal.addEventListener("abort", () => resolve(onTimeout), { once: true });
    });
    return Promise.race([run(signal), gaveUp]);
  };
  const failureStatusWrite = (headSha: string, description: string) =>
    bounded(
      (signal) => writeCommitStatusWithRetry(credential.token, owner, repo, headSha, "", {
        description,
        state: "failure",
        attempts: 2,
        delayMs: input.retryDelayMs ?? 1000,
        signal,
      }),
      { success: false, error: `timeout: the status write did not answer within ${deadlines.fetchMs}ms; it may have been written`, status: 0, transient: false, attempts: 1 },
      compensation(),
    );
  const timedOut = (what: string) => ({ ok: false as const, status: 0, message: `timeout: ${what} did not answer within ${deadlines.fetchMs}ms` });
  const readPullRequest = () =>
    bounded(
      (signal) => fetchPullRequestHeadSha(credential.token, owner, repo, number, signal),
      { ...timedOut("the PR read"), headSha: null, headRef: null, open: null, draft: null, merged: null } as HeadShaResult,
    );
  // Re-read the live PR and refuse unless it is still the open PR on the bound branch at `headSha`.
  const liveRefusal = async (afterWrite = false): Promise<HeadBoundReleaseOutcome | null> => {
    const live = await readPullRequest();
    if (!live.ok) return { kind: "failed", message: `status:failed:pr_read: HTTP ${live.status} ${live.message ?? ""}`.trim() };
    if (afterWrite && live.merged && live.headRef === input.expectedBranch && live.headSha === input.headSha) return null;
    if (live.merged || live.draft || live.state !== "open") {
      return { kind: "refused", message: `status:refused:pr-not-open: ${owner}/${repo}#${number} is not an open, non-draft PR` };
    }
    if (live.headRef !== input.expectedBranch) {
      return {
        kind: "refused",
        message: `status:refused:branch-mismatch: ${owner}/${repo}#${number} is on ${live.headRef ?? "(unreadable)"}, not the card's delivery branch ${input.expectedBranch}`,
      };
    }
    if (live.headSha !== input.headSha) {
      return {
        kind: "refused",
        message: `status:refused:head-mismatch: ${owner}/${repo}#${number} head is ${live.headSha}, not ${input.headSha}`,
      };
    }
    return null;
  };
  const eligibilityRefusal = async (conn: Db): Promise<HeadBoundReleaseOutcome | null> => {
    const again = await input.revalidate(conn);
    if (!again.ok) {
      return { kind: "refused", message: `status:refused:eligibility-changed: ${again.reason}` };
    }
    const t = again.target;
    if (t.owner !== owner || t.repo !== repo || t.number !== number || t.branch !== input.expectedBranch) {
      return {
        kind: "refused",
        message: `status:refused:eligibility-changed: the card's delivery now targets ${t.owner}/${t.repo}#${t.number}, not ${owner}/${repo}#${number}`,
      };
    }
    return null;
  };
  // The PR's liveness and the card's eligibility, both as they are now.
  // `conn` is the lock's own connection: eligibility is read on it, never on a second pool connection.
  const recheck = async (conn: Db): Promise<HeadBoundReleaseOutcome | null> => (await liveRefusal()) ?? (await eligibilityRefusal(conn));
  // A success that cannot be confirmed is voided by a failure status; the answer says whether that worked.
  // Single-flight: the deadline's void and the release's own never both write a failure status.
  let voiding: Promise<string> | undefined;
  const voidSuccess = (why: string): Promise<string> =>
    (voiding ??= (async () => {
      const voided = await failureStatusWrite(input.headSha, `voided: ${why}`);
      if (voided.success) statusMayExist = false;
      return voided.success ? "it was voided by a failure status" : `it could NOT be voided (${voided.error ?? `HTTP ${voided.status}`}), and is not consumable without a recorded confirmation`;
    })());
  // The only things that may still happen after the answer: a status write the release gave up on lands as a
  // success on top of the void. If it is then still the newest status of the head and this release never
  // confirmed it, a failure is written over it, once, on a clock of its own. Two triggers: the write answers
  // late with a success (compensateLateSuccess), or it ended with no answer, e.g. an aborted request that
  // GitHub nevertheless accepted (recheckAfterNoAnswer: the head is read again after `fetchMs` and
  // `compensationMs`). Residuals: the time until the landing is seen, a process that ends before it, and a
  // concurrent release of the same user with the same description that could be voided again (availability only).
  const writeLateVoid = (signal: AbortSignal) =>
    writeCommitStatusWithRetry(credential.token, owner, repo, input.headSha, "", {
      description: "voided: a status write the release had given up on landed after it",
      state: "failure",
      attempts: 2,
      delayMs: input.retryDelayMs ?? 1000,
      signal,
    });
  const afterAnswerClock = () =>
    AbortSignal.any([AbortSignal.timeout(deadlines.compensationMs), ...(input.afterAnswerSignal ? [input.afterAnswerSignal] : [])]);
  const compensateLateSuccess = (inFlight: Promise<Awaited<ReturnType<typeof writeCommitStatusWithRetry>>>) => {
    void inFlight.then(async (landed) => {
      if (!landed.success || input.afterAnswerSignal?.aborted) return;
      const landedId = "statusId" in landed && typeof landed.statusId === "string" ? landed.statusId : null;
      if (landedId !== null && landedId === confirmedStatusId) return;
      const signal = afterAnswerClock();
      const newest = await fetchHeadCommitStatuses(credential.token, owner, repo, input.headSha, { signal });
      const stillNewest = newest.ok
        ? newest.controlPlaneApproved && newest.newest?.release === true && (landedId === null || newest.newest.id === landedId)
        : true; // unreadable: fail closed
      if (!stillNewest) return;
      await writeLateVoid(signal);
    }).catch(() => undefined);
  };
  const recheckAfterNoAnswer = () => {
    for (const delay of [deadlines.fetchMs, deadlines.compensationMs]) {
      const timer = setTimeout(() => {
        void (async () => {
          if (confirmedStatusId || input.afterAnswerSignal?.aborted) return;
          await voiding?.catch(() => undefined);
          const signal = afterAnswerClock();
          const read = await fetchHeadCommitStatuses(credential.token, owner, repo, input.headSha, { signal });
          // Unreadable: fail closed. Otherwise only this release's own unconfirmed success is voided.
          const ours = read.ok
            ? read.newest?.release === true && read.newest.description === input.description && read.newest.id !== confirmedStatusId
            : true;
          if (!ours || confirmedStatusId) return;
          await writeLateVoid(signal);
        })().catch(() => undefined);
      }, delay);
      timer.unref();
      input.afterAnswerSignal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
    }
  };
  // The marker CI requires beside a release success (RELEASE_CONFIRMED_CONTEXT). It is written only after
  // the confirmation is committed, on the compensation clock.
  const writeConfirmationMarker = (statusId: string) =>
    bounded(
      (signal) => writeCommitStatusWithRetry(credential.token, owner, repo, input.headSha, "", {
        description: releaseConfirmedDescription(statusId),
        context: RELEASE_CONFIRMED_CONTEXT,
        attempts: 2,
        delayMs: input.retryDelayMs ?? 1000,
        signal,
      }),
      { success: false, error: `timeout: the marker write did not answer within ${deadlines.fetchMs}ms`, status: 0, transient: false, attempts: 1 },
      compensation(),
    );
  let confirmedStatusId: string | null = null;
  const publishLocked = async (conn: Db): Promise<HeadBoundReleaseOutcome> => {
    if (envelope.aborted) return deadlineOutcome();
    // The live PR is checked before anything else, so an "already approved" answer is never given for a
    // PR that is stale, a draft, closed, merged or off its branch.
    const firstRefusal = await recheck(conn);
    if (firstRefusal) return firstRefusal;
    const existing = await bounded(
      (signal) => fetchHeadCommitStatuses(credential.token, owner, repo, input.headSha, { signal }),
      { ...timedOut("the status read"), approved: false, controlPlaneApproved: false, newest: null, confirmedMarkers: [] } as Awaited<ReturnType<typeof fetchHeadCommitStatuses>>,
    );
    if (!existing.ok) return { kind: "failed", message: `status:failed:status_read: HTTP ${existing.status} ${existing.message ?? ""}`.trim() };
    if (existing.controlPlaneApproved) {
      // A release status counts as "already published" only when this card CONFIRMED it. One whose
      // confirmation is unknown (a write that timed out, a failed void) is not a release: the write
      // below replaces it with one that is confirmed.
      const unconfirmedRelease = existing.newest?.release === true &&
        (existing.newest.id === null || existing.newest.id !== (await input.confirmedStatusId(conn)));
      if (!unconfirmedRelease) {
        // The status lookup took time: look at the head again before answering that it is approved.
        const stillLive = await recheck(conn);
        if (stillLive) return stillLive;
        // A release this card confirmed whose marker never reached GitHub (the write failed after the
        // commit) gets it now, so CI can accept it. The write is idempotent.
        let markerNote = "";
        if (existing.newest?.release && existing.newest.id && !existing.confirmedMarkers.includes(existing.newest.id)) {
          const marker = await writeConfirmationMarker(existing.newest.id);
          markerNote = marker.success ? "; the confirmation marker was re-written" : `; the confirmation marker could NOT be re-written (${marker.error ?? `HTTP ${marker.status}`})`;
        }
        return { kind: "already_approved", headSha: input.headSha, message: `paperclip/approved already published by the control plane on this head${markerNote}` };
      }
    }
    // GitHub has no compare-and-swap on a commit status, so a push landing between the last live read and
    // the POST can still leave one status on the old SHA. It is keyed by SHA, so the new head does not
    // inherit it, and the head is read once more after the write: a head that moved is reported as stale
    // (and the status written to the old head is set to failure, so no success stays on it), never as a
    // release. A transient failure is retried only after the live head and eligibility are checked again.
    const attempts = 3;
    for (let attempt = 1; ; attempt += 1) {
      const refusal = await recheck(conn);
      if (refusal) return refusal;
      // Nothing is written once the release's clock has run out.
      if (envelope.aborted) return deadlineOutcome();
      statusMayExist = true;
      let inFlight: ReturnType<typeof writeCommitStatusWithRetry> | undefined;
      const write = await bounded(
        (signal) => (inFlight = writeCommitStatusWithRetry(credential.token, owner, repo, input.headSha, "", {
          description: input.description,
          attempts: 1,
          signal,
        })),
        { success: false, error: `timeout: the status write did not answer within ${deadlines.fetchMs}ms; it may have been written`, status: 0, transient: false, attempts: 1 },
      );
      if (write.success) {
        // Confirm the PR is still the live, open, non-draft head on the bound branch, not only the SHA.
        const after = await liveRefusal(true);
        if (after && after.kind === "failed") {
          // The success cannot be confirmed to cover the live head, so it is voided: nothing may consume it.
          // The board can release again, which writes a fresh success (the newest status then decides).
          const outcome = await voidSuccess(`the head of ${number} could not be confirmed after the release`);
          return {
            kind: "failed",
            message: `status:failed:post_write_pr_read: ${after.message}; the status on ${input.headSha} WAS written but the head could not be confirmed; ${outcome}`,
          };
        }
        if (after) {
          const marked = await failureStatusWrite(input.headSha, `superseded: ${number} is no longer the live head ${input.headSha.slice(0, 12)} the release covered`);
          if (marked.success) statusMayExist = false;
          return {
            kind: "stale",
            headSha: input.headSha,
            message:
              `status:stale:head-moved-after-write: ${after.message}; ` +
              (marked.success
                ? `the status written to ${input.headSha} was followed by a failure status`
                : `a failure status on ${input.headSha} could NOT be written (${marked.error ?? `HTTP ${marked.status}`})`),
          };
        }
        // The head is still live, but the card's authority is read once more: a decision reversed, a card
        // cancelled or a delivery retargeted while the write was in flight must not stay released.
        const revoked = await eligibilityRefusal(conn);
        if (revoked) {
          const outcome = await voidSuccess("the card's eligibility changed while the release was written");
          return { kind: "stale", headSha: input.headSha, message: `status:stale:eligibility-changed-after-write: ${revoked.message}; ${outcome}` };
        }
        // Confirmed: the live head is still the one released. Record that, last, so only a confirmed
        // status is ever consumable.
        const statusId = "statusId" in write && typeof write.statusId === "string" ? write.statusId : null;
        if (!statusId) {
          const outcome = await voidSuccess("GitHub did not say which status it accepted");
          return { kind: "failed", message: `status:failed:unconfirmed: GitHub did not return the id of the status it accepted on ${input.headSha}; ${outcome}` };
        }
        // Past this point the deadline does not abandon the release: either the confirmation commits and
        // the answer says released, or it does not and the answer says failed. A release the deadline
        // already abandoned never reaches the write.
        if (phase !== "open") {
          const outcome = await voidSuccess("the release was abandoned before it was confirmed");
          return { kind: "failed", message: `status:failed:deadline: the release was abandoned before it could be confirmed; ${outcome}` };
        }
        phase = "sealing";
        try {
          // The deadline does not reach this write, so it gets a shorter statement bound of its own.
          await conn.execute(sql`select set_config('statement_timeout', ${`${Math.min(deadlines.statementMs, deadlines.compensationMs)}ms`}, true)`);
          await input.recordConfirmation(conn, statusId);
          confirmedStatusId = statusId;
        } catch (error) {
          const outcome = await voidSuccess("the release could not be recorded as confirmed");
          return {
            kind: "failed",
            message: `status:failed:confirmation_not_recorded: ${error instanceof Error ? error.message : String(error)}; the status on ${input.headSha} WAS written; ${outcome}`,
          };
        }
        return { kind: "released", headSha: input.headSha, message: input.description };
      }
      if (!write.transient || attempt >= attempts || envelope.aborted) {
        if (write.status === 0) {
          // No answer at all (a timeout, a dropped connection, the deadline): GitHub may still have
          // accepted the write, so the success is voided rather than left for a consumer to find.
          // GitHub may still accept that write later, and it then sits on top of the void. Commit statuses have no
          // compare-and-set, so the void cannot be made to outrank it; it is voided again if it lands. Armed only
          // here, where the release ends on the write, never for a failure the loop goes on to retry.
          if (inFlight) {
            compensateLateSuccess(inFlight);
            recheckAfterNoAnswer();
          }
          const outcome = await voidSuccess("the release's status write did not answer");
          return { kind: "failed", message: `status:failed:status_write: ${write.error ?? "no answer"}; the status may have been written; ${outcome}` };
        }
        statusMayExist = false;
        return { kind: "failed", message: `status:failed:status_write: ${write.error ?? `HTTP ${write.status}`}` };
      }
      statusMayExist = false;
      await new Promise<void>((resolve) => setTimeout(resolve, input.retryDelayMs ?? 1000));
    }
  };
  // At most one release per company/repo/head at a time: the second caller waits, then sees the first
  // one's status and answers already_approved instead of writing again.
  const lockKey = releaseLockKey(companyId, owner, repo, input.headSha);
  // Even a release stuck where the signal cannot reach it (the pool, the lock, a database call) answers
  // by `totalMs` plus the compensation window; the abandoned work ends at its next checkpoint.
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<HeadBoundReleaseOutcome>((resolve) => {
    // A release that is sealing (writing its confirmation) is never answered as failed from here: its
    // own result decides, and the statement timeout on its connection bounds it.
    const arm = () => { hardStop = setTimeout(() => { if (phase !== "sealing") resolve(deadlineOutcome()); }, deadlines.compensationMs); };
    if (envelope.aborted) arm();
    else envelope.addEventListener("abort", arm, { once: true });
  });
  try {
    const run = db
      .transaction(async (tx) => {
        if (envelope.aborted) return deadlineOutcome();
        // Bounded: a waiter gives up instead of queueing for ever, a hung statement is cancelled, and a
        // release that stalls while idle in its transaction is cut off by the server, which frees the lock.
        await tx.execute(sql`select
          set_config('lock_timeout', ${`${deadlines.lockMs}ms`}, true),
          set_config('statement_timeout', ${`${deadlines.statementMs}ms`}, true),
          set_config('idle_in_transaction_session_timeout', ${`${deadlines.idleInTransactionMs}ms`}, true)`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        return publishLocked(tx as unknown as Db);
      })
      .catch(async (error): Promise<HeadBoundReleaseOutcome> => {
        // The transaction ended abnormally (the deadline destroyed its connection, a statement timed out,
        // the commit failed): nothing it wrote is committed. A success that may already be on the head is
        // voided, since no confirmation will ever exist for it.
        if (!statusMayExist) {
          if (phase === "abandoned") return deadlineOutcome();
          throw error;
        }
        const outcome = await voidSuccess("the release did not complete");
        const why = phase === "abandoned" ? `the deadline passed (${deadlines.totalMs}ms)` : (error instanceof Error ? error.message : String(error));
        return {
          kind: "failed",
          message: `status:failed:deadline: the release was interrupted: ${why}; a status on ${input.headSha} may have been written; ${outcome}`,
        };
      });
    run.catch(() => undefined);
    const outcome = await Promise.race([run, stopped]);
    // Only a release that really committed its confirmation tells CI so: the marker is written after the
    // commit, never before, and a failed marker write leaves the release unconfirmed for CI (fail closed).
    if (outcome.kind === "released" && confirmedStatusId) {
      statusMayExist = false;
      const marker = await writeConfirmationMarker(confirmedStatusId);
      return {
        ...outcome,
        confirmationMarker: marker.success ? "written" : "pending",
        message: marker.success
          ? outcome.message
          : `${outcome.message} (the CI confirmation marker could NOT be written: ${marker.error ?? `HTTP ${marker.status}`}; CI does not accept this release until it is, and a repeat release or the reconciler writes it)`,
      };
    }
    return outcome;
  } catch (error) {
    // The transaction is rolled back (which frees the lock) before we get here.
    const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code === "55P03") {
      return { kind: "failed", message: `status:failed:lock_timeout: another release of this head held the publication lock for more than ${deadlines.lockMs}ms` };
    }
    if (code === "57014") {
      return { kind: "failed", message: `status:failed:statement_timeout: a database statement of the release ran for more than ${deadlines.statementMs}ms` };
    }
    throw error;
  } finally {
    phase = "done";
    if (hardStop) clearTimeout(hardStop);
  }
}

/**
 * SUP-16081 fix #1. Persist the outcome of a FIRST `paperclip/approved` publish
 * to `issues.executionState.approvalStatus` so a dropped publish is never silent.
 *
 * This writer is TOTAL within its own scope: after a closing transition the
 * `approvalStatus` key is never absent FROM THE MINT ITSELF. Every terminating
 * outcome leaves a named record carrying the publisher's own refusal
 * vocabulary, the attempted/certified head, and a timestamp:
 *
 * Its real scope (SUP-16977): the invariant holds against the atomic subtree
 * helpers (jsonb_set writers) and, after the SUP-16977 control-plane patch,
 * against the whole-object ladder writers, which now preserve the key across
 * schema round-trips and re-apply the live subtree. It was never total
 * against a FAILED PARSE of the column — a schema strip or a parse that
 * returns null could still drop the key, which is exactly the residue the
 * SUP-16977 patch closes on the control plane.
 *
 *   - `armed`   -> `publishedHeadSha` + `publishedAt` (the success shape, as today)
 *   - `skipped` -> `publishSkipped` { reason, headSha, at }; when
 *                  `pendingCandidates` is supplied (an unresolvable ambiguous or
 *                  no-pr-head outcome) it additionally persists
 *                  `pendingCandidates` / `skipReason` / `certifiedAt` so the
 *                  reconciler can later recover it
 *   - `failed`  -> `publishFailure` { reason, headSha, at }
 *
 * A positively-resolved head (`resolvedHeadSha !== null`) additionally writes the
 * SUP-14715 D-B anchor `approvedHeadSha` + `approvedAt`, exactly as the previous
 * inline block did. When the head resolved, the record is a FRESH object (a stale
 * `publishedHeadSha` from a prior cycle must not survive a new certification);
 * when it did not resolve, the record MERGES into any existing `approvalStatus`
 * so a prior `pendingCandidates` / `backfillRefusal` is preserved. The certified
 * `finalDelivery` survives either outcome from the live subtree.
 * `pendingCandidates` is only ever written when no head resolved — matching the
 * prior inline block.
 *
 * SUP-16081 stage-3 finding (publish-outcome-root-state-lost-update): the
 * record is written atomically against the LIVE `executionState.approvalStatus`
 * subtree (`jsonb_set` on the root + a jsonb `||`/replace on the subtree), the
 * same shape {@link recordApprovalAnchor} and the reconciler's
 * `mergeApprovalStatus` use. The `baseExecutionState` argument is the route's
 * client snapshot and is no longer read — rebuilding the whole column from it
 * reverted every root key a concurrent writer committed after the snapshot.
 *
 * This helper only WRITES the card's durable record. It does not decide whether
 * a stamp is published (that stays in {@link publishApprovalStatus} / the
 * consume-contract) and it never itself re-stamps.
 */
export async function recordApprovalPublishOutcome(
  db: Db,
  issueId: string,
  baseExecutionState: Record<string, unknown> | null | undefined,
  resolvedHeadSha: string | null,
  outcome: ArmingOutcome,
  pendingCandidates?: Array<ApprovalCandidateAnchor | NoPrBranchAnchor> | null,
): Promise<void> {
  // SUP-16081 stage-3 finding (publish-outcome-root-state-lost-update): write
  // against the LIVE executionState.approvalStatus subtree, not the route's
  // stale client snapshot. This helper is reached from the post-publish record,
  // the catch backstop, and four guard-refusal paths (recordGuardOutcome in
  // routes/issues.ts), each of which used to rebuild the entire executionState
  // column from `baseExecutionState` — silently reverting every root key a
  // concurrent writer committed after that snapshot (monitor, currentStageId,
  // completedStageIds, pendingSince). Touching ONLY the approvalStatus key via
  // the same atomic jsonb_set + subtree shape recordApprovalAnchor and the
  // reconciler's mergeApprovalStatus already use keeps those root siblings
  // live. baseExecutionState is retained for call-site stability; it is no
  // longer read — the live subtree is authoritative.
  const nowIso = new Date().toISOString();

  // Outcome-specific fields, computed in JS so the record shape is identical to
  // the previous inline block (every value is JSON-serializable).
  const patch: Record<string, unknown> = {};
  switch (outcome.kind) {
    case "armed":
      if (typeof outcome.headSha === "string") {
        patch.publishedHeadSha = outcome.headSha;
        patch.publishedAt = nowIso;
      }
      break;
    case "skipped":
      patch.publishSkipped = {
        reason: outcome.message,
        headSha: resolvedHeadSha,
        at: nowIso,
      };
      if (
        resolvedHeadSha === null &&
        Array.isArray(pendingCandidates) &&
        pendingCandidates.length > 0
      ) {
        patch.pendingCandidates = pendingCandidates;
        patch.skipReason = outcome.message;
        patch.certifiedAt = nowIso;
      }
      break;
    case "failed":
      patch.publishFailure = {
        reason: outcome.message,
        headSha: resolvedHeadSha,
        at: nowIso,
      };
      break;
  }

  // A positively-resolved head FRESHENS the subtree (a stale publishedHeadSha
  // from a prior cycle must not survive a new certification); an unresolvable
  // outcome MERGES into the live subtree so a prior pendingCandidates /
  // backfillRefusal is preserved. Either way only approvalStatus is rewritten.
  let approvalStatusExpr: SQL;
  if (resolvedHeadSha !== null) {
    const freshSubtree: Record<string, unknown> = {
      approvedHeadSha: resolvedHeadSha,
      approvedAt: nowIso,
      ...patch,
    };
    // Freshen old publication fields without dropping the decision's certified
    // PR identity. Read it from the live row so concurrent updates are not lost.
    approvalStatusExpr = sql`(
      case when coalesce(${issues.executionState} -> 'approvalStatus', '{}'::jsonb) ? 'finalDelivery'
        then jsonb_build_object('finalDelivery', ${issues.executionState} -> 'approvalStatus' -> 'finalDelivery')
        else '{}'::jsonb end
      || ${JSON.stringify(freshSubtree)}::jsonb
    )`;
  } else {
    approvalStatusExpr = sql`(
      coalesce(${issues.executionState} -> 'approvalStatus', '{}'::jsonb)
      || ${JSON.stringify(patch)}::jsonb
    )`;
  }

  const executionStateExpr: SQL = sql`(
    jsonb_set(coalesce(${issues.executionState}, '{}'::jsonb), '{approvalStatus}', ${approvalStatusExpr})
  )`;
  await db
    .update(issues)
    .set({ executionState: executionStateExpr })
    .where(eq(issues.id, issueId));
}

/**
 * SUP-16081 (comment a78bf2d2): write the approval anchor — `approvedHeadSha`
 * + `approvedAt` — durably BEFORE the first-publish status write is attempted.
 *
 * On SUP-16041 the anchor was only written AFTER the publish succeeded (or in
 * the post-publish `recordApprovalPublishOutcome` call), so a dropped/throwing
 * status write left `approvedHeadSha` absent and BOTH recovery paths were
 * structurally unable to run: the backfill D-B fallback needs `approvedHeadSha`,
 * and `merge-arming/republish` bails with `head_unresolvable` when the card has
 * no published head AND no recorded anchor.
 *
 * SUP-16141 (finding prepublish-anchor-lost-update): the anchor is merged into
 * the LIVE `executionState.approvalStatus` subtree atomically on the server —
 * a `jsonb_set` on the root plus a jsonb `||` on the live subtree, the same
 * shape the reconciler's `mergeApprovalStatus` uses. The previous
 * SELECT-then-whole-row UPDATE rebuilt the entire column from a client
 * snapshot, so a concurrent writer that committed between the SELECT and the
 * UPDATE (a `publishFailure`, `backfillRefusal`, `publishedHeadSha`, ...) was
 * silently clobbered. Overwriting only `approvedHeadSha` + `approvedAt` here
 * preserves every other execution-state and approval-status key and never
 * decides whether a stamp is published. It is safe to call twice (idempotent):
 * the post-publish `recordApprovalPublishOutcome` re-writes the same two fields.
 */
export async function recordApprovalAnchor(
  db: Db,
  issueId: string,
  resolvedHeadSha: string,
): Promise<void> {
  const anchorPatch: Record<string, unknown> = {
    approvedHeadSha: resolvedHeadSha,
    approvedAt: new Date().toISOString(),
  };
  const approvalStatusExpr: SQL = sql`(
    coalesce(${issues.executionState} -> 'approvalStatus', '{}'::jsonb)
    || ${JSON.stringify(anchorPatch)}::jsonb
  )`;
  const executionStateExpr: SQL = sql`(
    jsonb_set(coalesce(${issues.executionState}, '{}'::jsonb), '{approvalStatus}', ${approvalStatusExpr})
  )`;
  await db
    .update(issues)
    .set({ executionState: executionStateExpr })
    .where(eq(issues.id, issueId));
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

/**
 * Everything that is the authority for arming one card, as a string to compare before and after: the
 * card's own record (cancelled, done or reopened, stage ladder, completed stages, last decision, approved and published
 * heads, the certified delivery, the recorded release confirmation), every decision row of the card
 * (outcome, decider) and the standing of each decider (whether an agent is a current agent of the company, a user's
 * membership and existence). A decision reversed, a certificate removed, a reviewer terminated or a
 * member removed after it was taken changes the answer. Two reads of it that differ mean the authority a
 * caller acted on is not the authority that exists now.
 */
export async function computeAuthorityFingerprint(db: Db, companyId: string, issueId: string, headSha?: string | null): Promise<string> {
  const [row] = await db
    .select({ status: issues.status, executionPolicy: issues.executionPolicy, executionState: issues.executionState })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
    .limit(1);
  if (!row) return "missing";
  const state = (row.executionState && typeof row.executionState === "object" ? row.executionState : {}) as Record<string, unknown>;
  const approval = (state.approvalStatus && typeof state.approvalStatus === "object" ? state.approvalStatus : {}) as Record<string, unknown>;
  // On a board-released head a paused agent has lapsed; on any other head paused is ordinary churn.
  const lapsePaused = isBoardReleasedHead(state, headSha);
  const policy = (row.executionPolicy && typeof row.executionPolicy === "object" ? row.executionPolicy : {}) as { stages?: Array<{ id?: unknown; phase?: unknown }> };
  const decisions = await db
    .select({
      id: issueExecutionDecisions.id,
      stageId: issueExecutionDecisions.stageId,
      outcome: issueExecutionDecisions.outcome,
      actorAgentId: issueExecutionDecisions.actorAgentId,
      actorUserId: issueExecutionDecisions.actorUserId,
    })
    .from(issueExecutionDecisions)
    .where(and(eq(issueExecutionDecisions.issueId, issueId), eq(issueExecutionDecisions.companyId, companyId)));
  decisions.sort((a, b) => a.id.localeCompare(b.id));
  const agentIds = [...new Set(decisions.map((d) => d.actorAgentId).filter((id): id is string => !!id))].sort();
  const userIds = [...new Set(decisions.map((d) => d.actorUserId).filter((id): id is string => !!id))].sort();
  const certificate = approval.finalDelivery ?? null;
  if (typeof certificate === "object" && certificate !== null) {
    const decisionId = (certificate as { decisionId?: unknown }).decisionId;
    if (typeof decisionId === "string" && !decisions.some((d) => d.id === decisionId)) {
      // A certificate naming a decision that does not exist is itself a difference worth recording.
      agentIds.push(`certificate-decision-missing:${decisionId}`);
    }
  }
  const agentRows = agentIds.length === 0 ? [] : await db
    .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
    .from(agents)
    .where(inArray(agents.id, agentIds.filter((id) => !id.startsWith("certificate-decision-missing:"))));
  const memberRows = userIds.length === 0 ? [] : await db
    .select({ principalId: companyMemberships.principalId, status: companyMemberships.status })
    .from(companyMemberships)
    .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      inArray(companyMemberships.principalId, userIds),
    ));
  const agentStanding = agentIds.map((id) => {
    const agent = agentRows.find((candidate) => candidate.id === id);
    return [id, !!agent && agent.companyId === companyId && agent.status !== "terminated" && agent.status !== "pending_approval" && !(lapsePaused && agent.status === "paused")];
  });
  memberRows.sort((a, b) => a.principalId.localeCompare(b.principalId));
  return JSON.stringify([
    // cancelled, done or anything else: a reopened (or cancelled) card is a different card.
    row.status === "cancelled" ? "cancelled" : row.status === "done" ? "done" : "open",
    lapsePaused,
    (policy.stages ?? []).map((stage) => [stage?.id, stage?.phase ?? null]),
    state.completedStageIds ?? null,
    state.lastDecisionId ?? null,
    state.lastDecisionOutcome ?? null,
    approval.publishedHeadSha ?? null,
    approval.approvedHeadSha ?? null,
    certificate,
    (approval.releaseConfirmation as { statusId?: unknown } | undefined)?.statusId ?? null,
    decisions,
    agentStanding,
    memberRows,
  ]);
}

/**
 * Why the deciders of a card no longer stand behind its approval, or null. For each pre-merge stage of
 * the policy that has decision rows, the newest decision (every decision at the newest instant) must be an
 * approval, and an agent that decided it must still be a current agent of the company (not terminated or
 * awaiting approval). A stage with no decision rows (an auto-skipped one) is left to the stage-integrity
 * checks the consumers already run, and users are not checked here (a local board has no user row).
 */
async function decisionStandingProblem(db: Db, companyId: string, issueId: string, policy: unknown, lapsePaused = false): Promise<string | null> {
  const stages = (policy && typeof policy === "object" && Array.isArray((policy as { stages?: unknown }).stages)
    ? (policy as { stages: Array<{ id?: unknown; phase?: unknown }> }).stages : []);
  const preMerge = new Set(stages.filter((st) => typeof st?.id === "string" && st.phase !== "post_merge").map((st) => st.id as string));
  const decisions = await db
    .select({
      stageId: issueExecutionDecisions.stageId,
      outcome: issueExecutionDecisions.outcome,
      actorAgentId: issueExecutionDecisions.actorAgentId,
      createdAt: issueExecutionDecisions.createdAt,
    })
    .from(issueExecutionDecisions)
    .where(and(eq(issueExecutionDecisions.issueId, issueId), eq(issueExecutionDecisions.companyId, companyId)));
  const byStage = new Map<string, typeof decisions>();
  for (const decision of decisions) {
    if (!preMerge.has(decision.stageId)) continue;
    byStage.set(decision.stageId, [...(byStage.get(decision.stageId) ?? []), decision]);
  }
  for (const [stageId, list] of byStage) {
    const newest = Math.max(...list.map((d) => d.createdAt.getTime()));
    for (const decision of list.filter((d) => d.createdAt.getTime() === newest)) {
      if (decision.outcome !== "approved") return `the latest decision of stage ${stageId} is ${decision.outcome}, not approved`;
      if (decision.actorAgentId) {
        const [agent] = await db
          .select({ companyId: agents.companyId, status: agents.status })
          .from(agents)
          .where(eq(agents.id, decision.actorAgentId));
        if (!agent || agent.companyId !== companyId || agent.status === "terminated" || agent.status === "pending_approval") {
          return `the agent that decided stage ${stageId} is no longer a current agent of the company`;
        }
        if (lapsePaused && agent.status === "paused") {
          return `the agent that decided stage ${stageId} is paused, and a paused agent's approval does not stand on a board-released head`;
        }
      }
    }
  }
  return null;
}

/**
 * The authority a merge actuator acts on, captured when it is created and checked again whenever
 * `stillHolds` is called: before every enable attempt (retries included), before a direct merge and
 * after an accepted enable. A consumer creates it just before its own final read of the card, so a change
 * after that read is a difference. `stillHolds` answers why the authority no longer holds, or null.
 */
export interface AuthorityGuard {
  stillHolds(): Promise<string | null>;
  /** What the guard compares against, so a record can rebuild the same guard later (after a restart). */
  readonly baseline: string;
  readonly requireApprovedLadder: boolean;
  readonly headSha: string | null;
}
export async function createAuthorityGuard(
  db: Db,
  companyId: string,
  issueId: string,
  options: { requireApprovedLadder?: boolean; headSha?: string | null; baseline?: string } = {},
): Promise<AuthorityGuard> {
  const baseline = options.baseline ?? await computeAuthorityFingerprint(db, companyId, issueId, options.headSha);
  return {
    baseline,
    requireApprovedLadder: options.requireApprovedLadder === true,
    headSha: options.headSha ?? null,
    async stillHolds() {
      const [fresh] = await db
        .select({ status: issues.status, executionPolicy: issues.executionPolicy, executionState: issues.executionState })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
        .limit(1);
      if (!fresh) return "the card no longer exists";
      if (options.requireApprovedLadder) {
        if (fresh.status === "cancelled") return "the card was cancelled";
        if (!ladderIsTerminallyApproved(
          fresh.executionPolicy as Parameters<typeof ladderIsTerminallyApproved>[0],
          fresh.executionState as Parameters<typeof ladderIsTerminallyApproved>[1],
        )) {
          return "the card's ladder is no longer approved";
        }
      }
      const lapsePaused = isBoardReleasedHead(fresh.executionState as Record<string, unknown> | null, options.headSha);
      const standing = await decisionStandingProblem(db, companyId, issueId, fresh.executionPolicy, lapsePaused);
      if (standing) return standing;
      return (await computeAuthorityFingerprint(db, companyId, issueId, options.headSha)) === baseline
        ? null
        : "the card's approval record, its decisions or a decider's standing changed";
    },
  };
}

export async function armMergeOnApproval(
  db: Db,
  companyId: string,
  issueId: string,
  decision: MergeArmingDecision,
  certifiedPr?: LinkedPullRequest | null,
  /**
   * The head the caller authorized. GitHub then refuses to enable auto-merge on a PR whose head is
   * anything else, so a push landing after the caller's last read cannot be armed by this call.
   */
  options: {
    expectedHeadOid?: string;
    /**
     * The authority guard the caller created just before its own final read of the card. Without one, the
     * authority as this call first reads it is the baseline. A difference before an enable attempt, a retry
     * or a direct merge stops the arm, and one found after an accepted enable turns auto-merge back off.
     */
    authorityGuard?: AuthorityGuard;
  } = {},
): Promise<ArmingOutcome> {
  if (decision.outcome !== "approved") {
    return { kind: "skipped", message: `skipped:not-approved: Decision outcome is "${decision.outcome}", not "approved"` };
  }

  // The authority this call acts on is captured before its first read: the delivery, owner and token
  // lookups take time, and a card whose decision, ladder, head, certificate or release changed in that
  // time is not what was authorized. It is read again right before the merge lever is pulled.
  const guard = options.authorityGuard ?? await createAuthorityGuard(db, companyId, issueId, { requireApprovedLadder: true, headSha: options.expectedHeadOid });
  const authorityChanged = () => guard.stillHolds();

  const deliveryIdentity = await resolveDeliveryIdentity(db, companyId, issueId);
  if (deliveryIdentity.recordedUnusable) {
    return deliveryIdentityUnresolvedOutcome(null, deliveryIdentity.recordedUnusable);
  }
  if (deliveryIdentity.binding) {
    if (certifiedPr && certifiedPr.number !== deliveryIdentity.binding.prNumber) {
      return deliveryIdentityUnresolvedOutcome(
        deliveryIdentity.branch,
        "recorded delivery identity PR does not match the certified PR",
      );
    }
    const candidates = certifiedPr ? [certifiedPr] : await resolveLinkedPullRequestsWithState(db, companyId, issueId);
    const narrowed = await narrowToDelivered(db, companyId, issueId, candidates);
    if (narrowed.outcome === "identity-unresolved") {
      return deliveryIdentityUnresolvedOutcome(narrowed.branch, narrowed.recordedUnusable);
    }
    if (narrowed.outcome === "not-delivered") {
      return deliveryIdentityUnresolvedOutcome(
        narrowed.deliveryBranch,
        "recorded delivery identity PR is not the authorizing delivery",
      );
    }
    if (!certifiedPr || narrowed.delivered[0]?.number !== deliveryIdentity.binding.prNumber) {
      return deliveryIdentityUnresolvedOutcome(
        narrowed.deliveryBranch,
        "recorded delivery identity PR does not match the certified PR",
      );
    }
  }

  // SUP-15394: when the close hook hands over the PR that publishApprovalStatus
  // already resolved, delivery-identity-gated, and stamped, arm THAT PR as the
  // authoritative subject instead of re-resolving it. A second, independent
  // resolveLinkedPullRequests is what let the two resolvers disagree on the
  // zero-mention card (SUP-15393) and refuse a PR the publisher had already
  // stamped. No new authorization surface: the certified PR was already gated
  // by the publisher, and every gate below (owner-approved, SUP-13361
  // title-OR-branch, stage-completion) still runs against this subject. When no
  // certified subject is supplied (the reconciler / any other caller), fall back
  // to the historical cached resolve — unchanged.
  const linkedPRs = certifiedPr ? [certifiedPr] : await resolveLinkedPullRequests(db, companyId, issueId);

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
        status: issues.status,
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

  // SUP-15459: the ladder-terminality decision is the shared predicate, not an
  // inline copy — the same check that gates the routes arming write and the
  // reconciler's delegated re-publish.
  if (!ladderIsTerminallyApproved(policy, state)) {
    return {
      kind: "skipped",
      message: `skipped:owner-not-approved: incomplete review/approval stages: ${ladderIncompleteStageIds(policy, state).join(", ")}`,
    };
  }

  // Right now, before anything is sent: a card whose authority already differs from what the caller checked.
  const changedAtStart = await authorityChanged();
  if (changedAtStart) {
    return { kind: "skipped", message: `skipped:authority-changed: ${pr.displayName} — ${changedAtStart}; nothing was armed` };
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

    // Written BEFORE the enable call: an arm GitHub accepts is then covered even if this process dies, or the
    // database fails, right after (see PendingAutoMergeDisarm). If it cannot be written, nothing is armed.
    const armRecord = await openArmRecord(db, companyId, ownerRow.id, pr, pr.displayName, nodeId, options.expectedHeadOid ?? null, guard);
    if (!armRecord.ok) return { kind: armRecord.kind, message: armRecord.message };
    const forget = armRecord.forget;

    const result = await enableAutoMerge(token, nodeId, {
      ...(options.expectedHeadOid ? { expectedHeadOid: options.expectedHeadOid } : {}),
      // Before the first attempt and before every retry.
      beforeAttempt: authorityChanged,
    });
    await armRecord.settleEnable(result);
    if (result.success) {
      // A revocation that committed while the call was in flight could not be seen before it: look again,
      // and take the arm back if the authority is no longer what was checked.
      // A recheck that cannot be completed is treated as a change: an arm that cannot be re-verified is taken back.
      const changedDuringArm = await authorityChanged().catch((error) =>
        `the authority could not be re-verified (${error instanceof Error ? error.message : String(error)})`);
      if (changedDuringArm) {
        const disabled = await disableAutoMerge(token, nodeId);
        if (disabled.success) await forget();
        const kept = disabled.success ? "" : await keepAutoMergeDisarmPending(db, companyId, ownerRow.id, pr, nodeId, options.expectedHeadOid ?? null, changedDuringArm, disabled.error);
        return {
          kind: "failed",
          message: `failed:authority-revoked: ${pr.displayName} — ${changedDuringArm} while auto-merge was being enabled; ` +
            (disabled.success ? "auto-merge was disabled again" : `auto-merge could NOT be disabled (${disabled.error ?? "unknown"}) and is STILL ENABLED${kept}`),
        };
      }
      await forget();
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
    if (result.error?.startsWith("authority_changed:")) {
      return { kind: "skipped", message: `skipped:authority-changed: ${pr.displayName} — ${result.error.slice("authority_changed:".length).trim()}; nothing was armed` };
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

    if (isCleanStatusRefusal(safeError)) {
      const executionState = ownerRow.executionState as Record<string, unknown> | null;
      const approvalStatus = executionState?.approvalStatus as Record<string, unknown> | null;
      const publishedHeadSha =
        typeof approvalStatus?.publishedHeadSha === "string" ? approvalStatus.publishedHeadSha : null;

      if (!publishedHeadSha) {
        return {
          kind: "skipped",
          message: `skipped:no-approved-head: ${pr.displayName} — publishedHeadSha is null, cannot pin the direct merge`,
        };
      }
      // A caller that verified a head (the live head, with a current approval) merges THAT head and no
      // other: the card's recorded head can be an older one, and a direct merge has no second chance.
      if (options.expectedHeadOid && options.expectedHeadOid !== publishedHeadSha) {
        return {
          kind: "skipped",
          message: `skipped:head-mismatch: ${pr.displayName} — the verified head ${options.expectedHeadOid} is not the card's published head ${publishedHeadSha}; no direct merge`,
        };
      }
      const mergeHead = options.expectedHeadOid ?? publishedHeadSha;
      // A direct merge cannot be taken back, so a head the board released is armed through auto-merge only.
      if (isBoardReleasedHead(executionState, mergeHead)) {
        return {
          kind: "skipped",
          message: `skipped:direct-merge-not-used: ${pr.displayName} — head ${mergeHead} was released by the board and auto-merge could not be enabled (clean status); a direct merge cannot be taken back, so merge it through the queue or by hand`,
        };
      }

      const defaultMergeMethod = await fetchDefaultMergeMethod(token, pr.owner, pr.repo) ?? "MERGE";
      const changedBeforeMerge = await authorityChanged();
      if (changedBeforeMerge) {
        return { kind: "skipped", message: `skipped:authority-changed: ${pr.displayName} — ${changedBeforeMerge}; no direct merge` };
      }
      const mergeResult = await mergePullRequest(token, nodeId, mergeHead, defaultMergeMethod);

      if (mergeResult.success) {
        return {
          kind: "armed",
          message: `armed:direct-merge: ${pr.displayName} (head ${mergeHead})`,
        };
      }

      const mergeSafeError = mergeResult.error ?? "unknown_error";
      const mergeTruncated = mergeSafeError.length > 200 ? mergeSafeError.slice(0, 200) + "..." : mergeSafeError;
      return { kind: "failed", message: `failed:direct_merge:${mergeTruncated}` };
    }

    const truncated = safeError.length > 200 ? safeError.slice(0, 200) + "..." : safeError;
    return { kind: "failed", message: `failed:${truncated}` };
  }

  return { kind: "failed", message: "failed:internal: exhausted GitHub token candidates" };
}
