import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  activityLog,
  externalObjectMentions,
  externalObjects,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueWorkProducts,
  type Db,
} from "@paperclipai/db";
import { latestDecisionPerStage, resolveSelfApprovalPrincipals } from "./approval-status-reconciler.js";
import { resolveGitHubTokenCandidatesForRepo } from "./github-credential.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import {
  fetchPullRequestHeadSha,
  parseRepoUrl,
  resolveCardDeliveryBaseRef,
  resolveIssueRepoContext,
  verifyMergedPullRequestOnBaseBranch,
} from "./merge-arming.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

/**
 * SUP-25193 (option a): a board-attached landing proof.
 *
 * Some delivered cards cannot reach `done` with any landing proof. Their review
 * stage names only a user (the board seat) and is already completed, or the card
 * was reclassified `record_only` after an agent-reviewed review workflow
 * completed. No deliveryIdentity is recorded. Repository landing debt left by a record_only
 * reclassification can be discharged only by a proof that `prepareLandingDebtClose`
 * re-measures at the close, and every existing proof needs a live
 * execution-workspace branch. A merged PR's head branch is usually deleted.
 *
 * A board actor names a merged pull request in the card's project repository.
 * The server verifies it against GitHub (PR merged, supplied sha matches, merge
 * commit contained in the card's control-plane base branch) and records it.
 * Recording alone discharges nothing. A later board close re-verifies the same
 * evidence live, and the debt rows are discharged in the close transaction.
 */
export const BOARD_LANDING_PROOF_ACTION = "issue.landing_proof_attached";
export const BOARD_LANDING_PROOF_SOURCE = "board_merged_pr";
/** Marks a `pull_request` work product the attach route created, so it never counts as prior card evidence. */
export const BOARD_LANDING_PROOF_WORK_PRODUCT_SOURCE = "board_landing_proof";

export interface BoardLandingProofEvidence {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  mergeCommitSha?: string | null;
  headSha?: string | null;
  /** The immutable GitHub repository id recorded at attach; the close re-checks it. */
  repositoryId?: number | null;
}

/** How the merged PR was tied to this card (it must be the card's own delivery). */
export type BoardLandingProofPossession =
  | { kind: "linked_work_product"; detail: string }
  | { kind: "linked_external_object"; detail: string }
  | { kind: "recorded_delivery_commit"; detail: string };

export interface VerifiedBoardLandingProof {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  prUrl: string;
  mergeCommitSha: string;
  headSha: string;
  headRef: string | null;
  headRepoFullName: string | null;
  baseRef: string;
  repoUrl: string;
  repositoryId: number;
  repositoryNodeId: string | null;
  possession: BoardLandingProofPossession;
}

export type BoardLandingProofRefusalCode =
  | "landing_proof_wrong_repo"
  | "landing_proof_no_base"
  | "landing_proof_unverifiable"
  | "landing_proof_pr_not_found"
  | "landing_proof_pr_not_merged"
  | "landing_proof_pr_closed_unmerged"
  | "landing_proof_sha_mismatch"
  | "landing_proof_not_on_base"
  | "landing_proof_repo_identity_mismatch"
  | "landing_proof_not_card_delivery";

export type BoardLandingProofVerification =
  | { ok: true; proof: VerifiedBoardLandingProof }
  | { ok: false; code: BoardLandingProofRefusalCode; reason: string };

type RepoBindingFields = {
  id: string;
  companyId: string;
  projectId?: string | null;
  projectWorkspaceId?: string | null;
  executionWorkspaceId?: string | null;
};

const refuse = (code: BoardLandingProofRefusalCode, reason: string): BoardLandingProofVerification => ({
  ok: false,
  code,
  reason,
});

const normalizeSha = (value: string | null | undefined) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : null;

/**
 * Verify board landing evidence live against GitHub. The repository and the base
 * branch always come from the control plane (the card's project binding), never
 * from the evidence. The supplied owner/repo must name that repository.
 */
export async function verifyBoardLandingProof(
  db: Db,
  issue: RepoBindingFields,
  evidence: BoardLandingProofEvidence,
): Promise<BoardLandingProofVerification> {
  const ctx = await resolveIssueRepoContext(db, {
    companyId: issue.companyId,
    projectId: issue.projectId ?? null,
    projectWorkspaceId: issue.projectWorkspaceId ?? null,
    executionWorkspaceId: issue.executionWorkspaceId ?? null,
  });
  const projectRepo = ctx?.repoUrl ? parseRepoUrl(ctx.repoUrl) : null;
  if (!ctx?.repoUrl || !projectRepo || projectRepo.hostname !== "github.com") {
    return refuse("landing_proof_wrong_repo", "this card has no GitHub project repository to verify a landing against");
  }
  if (
    evidence.owner.trim().toLowerCase() !== projectRepo.owner.toLowerCase() ||
    evidence.repo.trim().toLowerCase() !== projectRepo.repo.toLowerCase()
  ) {
    return refuse(
      "landing_proof_wrong_repo",
      `pull request repository ${evidence.owner}/${evidence.repo} is not this card's project repository ${projectRepo.owner}/${projectRepo.repo}`,
    );
  }
  const baseRef = await resolveCardDeliveryBaseRef(db, issue.companyId, issue.id);
  if (!baseRef) {
    return refuse("landing_proof_no_base", "this card resolves no control-plane base branch to prove the merge commit on");
  }
  const suppliedMerge = normalizeSha(evidence.mergeCommitSha);
  const suppliedHead = normalizeSha(evidence.headSha);
  if (!suppliedMerge && !suppliedHead) {
    return refuse("landing_proof_sha_mismatch", "the proof must name the pull request's mergeCommitSha or headSha");
  }
  const owner = projectRepo.owner;
  const repo = projectRepo.repo;
  let candidates: Awaited<ReturnType<typeof resolveGitHubTokenCandidatesForRepo>>;
  try {
    candidates = await resolveGitHubTokenCandidatesForRepo(db, issue.companyId, owner, repo);
  } catch (err) {
    return refuse(
      "landing_proof_unverifiable",
      `GitHub credential resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (candidates.length === 0) {
    return refuse("landing_proof_unverifiable", "no GitHub credential is configured for this repository");
  }
  let lastFailure = "pull request could not be read";
  for (let index = 0; index < candidates.length; index += 1) {
    const token = candidates[index]!.token;
    const last = index === candidates.length - 1;
    const pr = await fetchPullRequestHeadSha(token, owner, repo, evidence.pullRequestNumber);
    if (!pr.ok) {
      if ((pr.status === 401 || pr.status === 403) && !last) continue;
      if (pr.status === 404) {
        return refuse(
          "landing_proof_pr_not_found",
          `pull request ${owner}/${repo}#${evidence.pullRequestNumber} does not exist`,
        );
      }
      lastFailure = `pull request read failed: HTTP ${pr.status}`;
      break;
    }
    if (pr.merged !== true) {
      return pr.state === "closed"
        ? refuse(
          "landing_proof_pr_closed_unmerged",
          `pull request ${owner}/${repo}#${evidence.pullRequestNumber} was closed without merging`,
        )
        : refuse(
          "landing_proof_pr_not_merged",
          `pull request ${owner}/${repo}#${evidence.pullRequestNumber} is not merged`,
        );
    }
    const mergeCommitSha = normalizeSha(pr.mergeCommitSha);
    const headSha = normalizeSha(pr.headSha);
    if (!mergeCommitSha || !headSha) {
      return refuse("landing_proof_unverifiable", "the merged pull request has no readable merge commit or head commit");
    }
    if ((suppliedMerge && suppliedMerge !== mergeCommitSha) || (suppliedHead && suppliedHead !== headSha)) {
      return refuse(
        "landing_proof_sha_mismatch",
        `the supplied commit does not match pull request #${evidence.pullRequestNumber} (merge commit ${mergeCommitSha.slice(0, 12)}, head ${headSha.slice(0, 12)})`,
      );
    }
    // The live repository identity must be the card's delivery repo. GitHub
    // redirects a renamed or transferred repository, so the live full name is
    // compared with the card's repo, and the PR's base repository must carry the
    // same immutable id. A recorded id (from the attach) must still match.
    const identity = await fetchGitHubRepositoryIdentity(token, owner, repo);
    if (!identity.ok) {
      if ((identity.status === 401 || identity.status === 403) && !last) continue;
      lastFailure = `repository identity read failed: ${identity.status ? `HTTP ${identity.status}` : identity.message}`;
      break;
    }
    const cardRepo = `${owner}/${repo}`.toLowerCase();
    if (identity.fullName.toLowerCase() !== cardRepo) {
      return refuse(
        "landing_proof_repo_identity_mismatch",
        `GitHub resolves ${owner}/${repo} to ${identity.fullName} (renamed or transferred); it is not this card's delivery repository`,
      );
    }
    if (pr.baseRepoId == null || pr.baseRepoId !== identity.id ||
      (pr.baseRepoFullName ?? "").toLowerCase() !== cardRepo) {
      return refuse(
        "landing_proof_repo_identity_mismatch",
        `pull request #${evidence.pullRequestNumber} targets repository ${pr.baseRepoFullName ?? "(unreadable)"} (id ${pr.baseRepoId ?? "unknown"}), not this card's repository ${owner}/${repo} (id ${identity.id})`,
      );
    }
    if (evidence.repositoryId != null && evidence.repositoryId !== identity.id) {
      return refuse(
        "landing_proof_repo_identity_mismatch",
        `repository ${owner}/${repo} now has id ${identity.id}, not the id ${evidence.repositoryId} recorded with the proof`,
      );
    }
    const possession = await resolveCardDeliveryPossession(db, issue, {
      token, owner, repo, pullRequestNumber: evidence.pullRequestNumber,
      headSha, mergeCommitSha,
    });
    if (possession === "unverifiable") {
      lastFailure = "the pull request commit list could not be read";
      break;
    }
    if (!possession) {
      return refuse(
        "landing_proof_not_card_delivery",
        `pull request #${evidence.pullRequestNumber} is not this card's delivery: it is not linked to the card, ` +
          "and none of the card's recorded delivery commits is one of its own commits",
      );
    }
    const onBase = await verifyMergedPullRequestOnBaseBranch(token, owner, repo, baseRef, mergeCommitSha, {
      requireVerifiedBranch: true,
    });
    if (onBase.outcome === "auth-failed") {
      if (!last) continue;
      lastFailure = `merge-commit containment check failed: HTTP ${onBase.status}`;
      break;
    }
    if (onBase.outcome !== "proven") {
      return refuse(onBase.notOnBase ? "landing_proof_not_on_base" : "landing_proof_unverifiable", onBase.reason);
    }
    return {
      ok: true,
      proof: {
        owner,
        repo,
        pullRequestNumber: evidence.pullRequestNumber,
        prUrl: `https://github.com/${owner}/${repo}/pull/${evidence.pullRequestNumber}`,
        mergeCommitSha,
        headSha,
        headRef: pr.headRef,
        headRepoFullName: pr.headRepoFullName ?? null,
        baseRef,
        repoUrl: ctx.repoUrl,
        repositoryId: identity.id,
        repositoryNodeId: identity.nodeId,
        possession,
      },
    };
  }
  return refuse("landing_proof_unverifiable", lastFailure);
}

type RepositoryIdentityRead =
  | { ok: true; id: number; nodeId: string | null; fullName: string }
  | { ok: false; status: number; message: string };

/** The live repository identity. fetch follows GitHub's rename/transfer redirect. */
async function fetchGitHubRepositoryIdentity(token: string, owner: string, repo: string): Promise<RepositoryIdentityRead> {
  let response: Response;
  try {
    response = await ghFetch(`${gitHubApiBase("github.com")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch {
    return { ok: false, status: 0, message: "network error" };
  }
  if (!response.ok) return { ok: false, status: response.status, message: `HTTP ${response.status}` };
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  const id = body?.id;
  const fullName = body?.full_name;
  if (typeof id !== "number" || typeof fullName !== "string" || fullName.length === 0) {
    return { ok: false, status: 0, message: "unreadable repository identity" };
  }
  return { ok: true, id, nodeId: typeof body?.node_id === "string" ? body.node_id : null, fullName };
}

const MAX_RECORDED_DELIVERY_COMMITS = 10;

const WORK_PRODUCT_WRITE_ACTIONS = ["issue.work_product_created", "issue.work_product_updated"] as const;

/**
 * The card's `pull_request` work products that only the board wrote. A row
 * counts when its `issue.work_product_created` activity row exists and that row
 * and every `issue.work_product_updated` row for it name a `user` actor. An
 * agent may create or edit a work product on its own card, and the server's
 * carrier fan-out (`system`) mirrors rows an agent wrote on another card, so
 * neither is evidence the board can rely on. A row with no activity record
 * does not count. `source_trust` and `created_by_run_id` cannot tell these
 * writers apart (both are null for a board write and for a default-trust
 * agent write, and an agent can leave `created_by_run_id` null).
 */
async function boardWrittenWorkProductIds(db: Db, issue: { id: string; companyId: string }, productIds: string[]) {
  if (productIds.length === 0) return new Set<string>();
  const rows = await db
    .select({
      action: activityLog.action,
      actorType: activityLog.actorType,
      actorId: activityLog.actorId,
      details: activityLog.details,
    })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, issue.companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issue.id),
      inArray(activityLog.action, [...WORK_PRODUCT_WRITE_ACTIONS]),
    ));
  const created = new Set<string>();
  const tainted = new Set<string>();
  for (const row of rows) {
    const id = typeof row.details?.workProductId === "string" ? row.details.workProductId : null;
    if (!id || !productIds.includes(id)) continue;
    const mergeRecord =
      row.action === "issue.work_product_updated" &&
      row.actorType === "system" &&
      row.actorId === "pr-delivery" &&
      row.details?.status === "merged";
    if (mergeRecord) continue;
    if (row.actorType !== "user") tainted.add(id);
    else if (row.action === "issue.work_product_created") created.add(id);
  }
  return new Set(productIds.filter((id) => created.has(id) && !tainted.has(id)));
}

/**
 * True when a board user's comment on the card names the PR. Only a comment
 * mention counts: a user wrote it (no agent author and no derived agent
 * author) and no plugin created the mention. A mention from an agent's comment,
 * the description or a document does not count.
 */
async function boardCommentMentionsPullRequest(
  db: Db,
  issue: { id: string; companyId: string },
  pr: { owner: string; repo: string; pullRequestNumber: number },
) {
  const rows = await db
    .select({
      externalId: externalObjects.externalId,
      authorUserId: issueComments.authorUserId,
      authorAgentId: issueComments.authorAgentId,
      derivedAuthorAgentId: issueComments.derivedAuthorAgentId,
    })
    .from(externalObjectMentions)
    .innerJoin(externalObjects, eq(externalObjects.id, externalObjectMentions.objectId))
    .innerJoin(issueComments, eq(issueComments.id, externalObjectMentions.sourceRecordId))
    .where(and(
      eq(externalObjectMentions.companyId, issue.companyId),
      eq(externalObjectMentions.sourceIssueId, issue.id),
      eq(externalObjectMentions.sourceKind, "comment"),
      eq(externalObjectMentions.objectType, "pull_request"),
      isNull(externalObjectMentions.createdByPluginId),
      eq(externalObjects.providerKey, "github"),
      eq(issueComments.companyId, issue.companyId),
      eq(issueComments.issueId, issue.id),
    ));
  const wanted = `${pr.owner}/${pr.repo}#pull/${pr.pullRequestNumber}`.toLowerCase();
  return rows.some((row) =>
    row.externalId.toLowerCase() === wanted &&
    !!row.authorUserId && !row.authorAgentId && !row.derivedAuthorAgentId);
}

/**
 * The merged PR must be THIS card's own delivery, shown by evidence the board
 * wrote. Only two ties count:
 *  - the board linked the PR to the card: a `pull_request` work product only the
 *    board wrote (not the one the attach route creates), or a board user's
 *    comment on the card that names the PR;
 *  - a head or merge commit recorded on such a board-written work product is
 *    the PR head or merge commit, or is one of the PR's own commits, listed
 *    live from GitHub.
 * Evidence an agent can write does not count: an agent can link any PR to its
 * own card, and the active run writes the card's delivery identity, so
 * `executionState.deliveredHeadSha` is not a source. A head branch name is not
 * a tie either: any merged PR can carry the card identifier in its branch name.
 * Returns null when nothing ties the PR to the card, or "unverifiable" when the
 * PR's commit list could not be read.
 */
async function resolveCardDeliveryPossession(
  db: Db,
  issue: { id: string; companyId: string },
  pr: {
    token: string; owner: string; repo: string; pullRequestNumber: number;
    headSha: string; mergeCommitSha: string;
  },
): Promise<BoardLandingProofPossession | null | "unverifiable"> {
  const prKey = `${pr.owner}/${pr.repo}#${pr.pullRequestNumber}`.toLowerCase();
  const allProducts = await db
    .select({
      id: issueWorkProducts.id,
      externalId: issueWorkProducts.externalId,
      url: issueWorkProducts.url,
      metadata: issueWorkProducts.metadata,
    })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, issue.companyId),
      eq(issueWorkProducts.issueId, issue.id),
      eq(issueWorkProducts.type, "pull_request"),
    ));
  const candidates = allProducts.filter((product) =>
    ((product.metadata ?? {}) as Record<string, unknown>).source !== BOARD_LANDING_PROOF_WORK_PRODUCT_SOURCE);
  const boardWritten = await boardWrittenWorkProductIds(db, issue, candidates.map((product) => product.id));
  const recordedShas = new Set<string>();
  const prUrl = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.pullRequestNumber}`.toLowerCase();
  for (const product of candidates) {
    if (!boardWritten.has(product.id)) continue;
    const metadata = (product.metadata ?? {}) as Record<string, unknown>;
    const repository = typeof metadata.repository === "string" ? metadata.repository.toLowerCase() : null;
    const sameRepo = repository === `${pr.owner}/${pr.repo}`.toLowerCase();
    const linked =
      product.externalId?.toLowerCase() === prKey ||
      product.url?.toLowerCase().replace(/\/+$/, "") === prUrl ||
      (sameRepo && metadata.prNumber === pr.pullRequestNumber);
    if (linked) return { kind: "linked_work_product", detail: `board-written work product ${product.externalId ?? product.url}` };
    for (const key of ["headSha", "mergeCommitSha"] as const) {
      const value = typeof metadata[key] === "string" ? (metadata[key] as string).trim().toLowerCase() : "";
      if (/^[0-9a-f]{40}$/.test(value)) recordedShas.add(value);
    }
  }
  if (await boardCommentMentionsPullRequest(db, issue, pr)) {
    return { kind: "linked_external_object", detail: `board comment names ${pr.owner}/${pr.repo}#${pr.pullRequestNumber}` };
  }
  const recorded = [...recordedShas].slice(0, MAX_RECORDED_DELIVERY_COMMITS);
  for (const sha of recorded) {
    if (sha === pr.headSha || sha === pr.mergeCommitSha) {
      return { kind: "recorded_delivery_commit", detail: `board-recorded delivery commit ${sha.slice(0, 12)} is the PR commit` };
    }
  }
  if (recorded.length === 0) return null;
  const prCommits = await listPullRequestCommits(pr.token, pr.owner, pr.repo, pr.pullRequestNumber);
  if (prCommits === null) return "unverifiable";
  const member = recorded.find((sha) => prCommits.has(sha));
  if (member) {
    return {
      kind: "recorded_delivery_commit",
      detail: `board-recorded delivery commit ${member.slice(0, 12)} is one of the PR's own commits`,
    };
  }
  return null;
}

const PULL_REQUEST_COMMITS_PAGE_SIZE = 100;
const MAX_PULL_REQUEST_COMMIT_PAGES = 3;

/** The PR's own commit shas (lowercase), or null when unreadable. */
async function listPullRequestCommits(
  token: string, owner: string, repo: string, pullRequestNumber: number,
): Promise<Set<string> | null> {
  const shas = new Set<string>();
  for (let page = 1; page <= MAX_PULL_REQUEST_COMMIT_PAGES; page += 1) {
    let response: Response;
    try {
      response = await ghFetch(
        `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullRequestNumber}/commits?per_page=${PULL_REQUEST_COMMITS_PAGE_SIZE}&page=${page}`,
        { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } },
      );
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const body = await response.json().catch(() => null) as unknown;
    if (!Array.isArray(body)) return null;
    for (const entry of body) {
      const sha = entry && typeof entry === "object" ? (entry as { sha?: unknown }).sha : null;
      if (typeof sha === "string") shas.add(sha.toLowerCase());
    }
    if (body.length < PULL_REQUEST_COMMITS_PAGE_SIZE) break;
  }
  return shas;
}

type EligibilityIssue = {
  id: string;
  companyId: string;
  status: string;
  deliveryRequirement?: string | null;
  assigneeAgentId?: string | null;
  createdByAgentId?: string | null;
  executionRunId?: string | null;
  checkoutRunId?: string | null;
  executionPolicy: unknown;
  executionState: unknown;
};

type ParticipantRef = { type?: unknown; agentId?: unknown };

/**
 * The stuck shape this proof exists for. The workflow is completed, no
 * deliveryIdentity is recorded, and the card is not closed. Either at least one
 * completed review stage names only users, or the card is `record_only`, every
 * stage is completed or skipped, and an agent-reviewed completed review stage
 * carries a durable independent approval ({@link judgeAgentReviewedStages}).
 * With `mergedHeadSha` (the live-verified PR head) the approval must also be
 * bound to that head; the caller passes it once the PR is verified. Returns null
 * when eligible, else the refusal reason.
 */
export async function boardLandingProofIneligibility(
  db: Db,
  issue: EligibilityIssue,
  mergedHeadSha?: string,
): Promise<string | null> {
  if (issue.status === "done" || issue.status === "cancelled") {
    return `the card is already ${issue.status}`;
  }
  const rawState = issue.executionState && typeof issue.executionState === "object"
    ? (issue.executionState as Record<string, unknown>)
    : null;
  if (rawState?.delivery) {
    return "the card already records a deliveryIdentity; close it through its recorded delivery";
  }
  const state = parseIssueExecutionState(issue.executionState);
  if (state?.status !== "completed") {
    return "the card's execution workflow is not completed; it still has a live review path";
  }
  const completed = new Set(state.completedStageIds ?? []);
  const skipped = new Set(state.skippedStageIds ?? []);
  const policy = issue.executionPolicy && typeof issue.executionPolicy === "object"
    ? (issue.executionPolicy as { stages?: unknown })
    : null;
  const stages = Array.isArray(policy?.stages) ? policy.stages : [];
  const completedReviewStages = stages.flatMap((stage) => {
    if (!stage || typeof stage !== "object") return [];
    const { id, type, participants } = stage as { id?: unknown; type?: unknown; participants?: unknown };
    if (type !== "review" || typeof id !== "string" || !completed.has(id)) return [];
    return [{ id, participants }];
  });
  const userOnlyCompletedReview = completedReviewStages.some(({ participants }) =>
    Array.isArray(participants) && participants.length > 0 &&
    participants.every((participant) =>
      !!participant && typeof participant === "object" && (participant as ParticipantRef).type === "user"));
  if (userOnlyCompletedReview) return null;
  const agentParticipantIds = (participants: unknown): Set<string> => new Set(
    Array.isArray(participants)
      ? participants.flatMap((participant) => {
        if (!participant || typeof participant !== "object") return [];
        const { type, agentId } = participant as ParticipantRef;
        return type === "agent" && typeof agentId === "string" && agentId.length > 0 ? [agentId] : [];
      })
      : [],
  );
  const agentReviewedStages = completedReviewStages
    .map(({ id, participants }) => ({ id, agentIds: agentParticipantIds(participants) }))
    .filter((stage) => stage.agentIds.size > 0);
  if (issue.deliveryRequirement !== "record_only" || agentReviewedStages.length === 0) {
    return "the card has no completed review stage that names only a user, and is not a record_only card with a completed agent review stage";
  }
  const everyStageSettled = stages.every((stage) => {
    const id = stage && typeof stage === "object" ? (stage as { id?: unknown }).id : null;
    return typeof id === "string" && (completed.has(id) || skipped.has(id));
  });
  if (!everyStageSettled) {
    return "the card's review workflow still has a stage that is neither approved nor skipped";
  }
  const judged = await judgeAgentReviewedStages(db, issue, policy, rawState, agentReviewedStages, mergedHeadSha);
  if (judged === "no_independent_approval") {
    return "the card has no completed agent review stage whose latest decision is an approval by an agent participant " +
      "other than the card's executor, assignee or author, recorded by that agent and not by the board in its place";
  }
  if (judged === "not_bound_to_merged_head") {
    return "the card's agent approval is not bound to the merged pull request head; an unbound, legacy or old-head approval does not qualify";
  }
  return null;
}

/**
 * Judges the agent review of a completed agent-reviewed stage. Genuine review
 * means the stage's LATEST durable decision is `approved`, names an agent that is
 * a participant of that stage, was not recorded by the board in the agent's
 * place (no `actorUserId`), and the agent is not the card's executor. The
 * executor set is the self-approval principal union (policy and state return
 * assignee, delivery author, creating agent) plus the current assignee and the
 * agents of the card's execution and checkout runs. A stage with no decision
 * row, a superseded approval and a board-user approval all fail.
 *
 * When `mergedHeadSha` is given, the approval must also be bound to that head:
 * its `deliveredHeadSha` (the head the decision recorded) equals the merged PR
 * head. An unbound or legacy decision has no head and fails.
 */
async function judgeAgentReviewedStages(
  db: Db,
  issue: EligibilityIssue,
  policy: { stages?: unknown } | null,
  rawState: Record<string, unknown> | null,
  agentReviewedStages: Array<{ id: string; agentIds: Set<string> }>,
  mergedHeadSha: string | undefined,
): Promise<"ok" | "no_independent_approval" | "not_bound_to_merged_head"> {
  const decisions = await db
    .select({
      id: issueExecutionDecisions.id,
      stageId: issueExecutionDecisions.stageId,
      outcome: issueExecutionDecisions.outcome,
      actorAgentId: issueExecutionDecisions.actorAgentId,
      actorUserId: issueExecutionDecisions.actorUserId,
      deliveredHeadSha: issueExecutionDecisions.deliveredHeadSha,
      createdAt: issueExecutionDecisions.createdAt,
    })
    .from(issueExecutionDecisions)
    .where(and(
      eq(issueExecutionDecisions.issueId, issue.id),
      eq(issueExecutionDecisions.companyId, issue.companyId),
    ));
  const latest = latestDecisionPerStage(decisions);
  const executors = resolveSelfApprovalPrincipals(
    (policy ?? {}) as Record<string, unknown>,
    rawState ?? {},
    issue.createdByAgentId ?? null,
  ).agentIds;
  if (issue.assigneeAgentId) executors.add(issue.assigneeAgentId);
  const runIds = [issue.executionRunId, issue.checkoutRunId].filter((id): id is string => typeof id === "string");
  if (runIds.length > 0) {
    const runs = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, issue.companyId), inArray(heartbeatRuns.id, runIds)));
    for (const run of runs) executors.add(run.agentId);
  }
  const independentApprovals = agentReviewedStages.flatMap((stage) => {
    const decision = latest.get(stage.id);
    return decision &&
        decision.outcome === "approved" &&
        decision.actorUserId === null &&
        typeof decision.actorAgentId === "string" &&
        stage.agentIds.has(decision.actorAgentId) &&
        !executors.has(decision.actorAgentId)
      ? [decision]
      : [];
  });
  if (independentApprovals.length === 0) return "no_independent_approval";
  if (mergedHeadSha === undefined) return "ok";
  const mergedHead = normalizeSha(mergedHeadSha);
  return mergedHead !== null && independentApprovals.some((decision) => normalizeSha(decision.deliveredHeadSha) === mergedHead)
    ? "ok"
    : "not_bound_to_merged_head";
}

export interface AttachedBoardLandingProof {
  activityId: string;
  evidence: BoardLandingProofEvidence;
}

/** The latest board landing proof attached to this card, or null. */
export async function loadAttachedBoardLandingProof(
  db: Db,
  issue: { id: string; companyId: string },
): Promise<AttachedBoardLandingProof | null> {
  const [row] = await db
    .select({ id: activityLog.id, details: activityLog.details })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, issue.companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issue.id),
      eq(activityLog.action, BOARD_LANDING_PROOF_ACTION),
    ))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(1);
  const details = (row?.details ?? null) as Record<string, unknown> | null;
  if (!row || !details) return null;
  const { owner, repo, pullRequestNumber, mergeCommitSha, headSha, repositoryId } = details;
  if (typeof owner !== "string" || typeof repo !== "string" || typeof pullRequestNumber !== "number") return null;
  return {
    activityId: row.id,
    evidence: {
      owner,
      repo,
      pullRequestNumber,
      mergeCommitSha: typeof mergeCommitSha === "string" ? mergeCommitSha : null,
      headSha: typeof headSha === "string" ? headSha : null,
      repositoryId: typeof repositoryId === "number" ? repositoryId : null,
    },
  };
}
