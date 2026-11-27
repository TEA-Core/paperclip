import { and, desc, eq } from "drizzle-orm";
import { activityLog, issueWorkProducts, issues, type Db } from "@paperclipai/db";
import { resolveGitHubTokenCandidatesForRepo } from "./github-credential.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import {
  fetchPullRequestHeadSha,
  resolveLinkedPullRequestsWithState,
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
 * stage names only a user (the board seat) and is already completed, and no
 * deliveryIdentity is recorded. Repository landing debt left by a record_only
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
      lastFailure = "the recorded delivery commit containment check could not be read";
      break;
    }
    if (!possession) {
      return refuse(
        "landing_proof_not_card_delivery",
        `pull request #${evidence.pullRequestNumber} is not this card's delivery: it is not linked to the card, ` +
          "and it contains none of the card's recorded delivery commits",
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

/**
 * The merged PR must be THIS card's own delivery. Only two ties count:
 *  - the PR is linked to the card on record: a `pull_request` work product the
 *    attach route did not create, or a cached external-object link;
 *  - the PR head or merge commit contains a delivery commit recorded on the card
 *    (work-product head/merge commits, `executionState.deliveredHeadSha`),
 *    checked live with the GitHub compare API.
 * A head branch name is not a tie: any merged PR can carry the card identifier
 * in its branch name, so the name proves nothing about delivery.
 * Returns null when nothing ties the PR to the card, or "unverifiable" when a
 * needed live containment check could not be read.
 */
async function resolveCardDeliveryPossession(
  db: Db,
  issue: { id: string; companyId: string },
  pr: {
    token: string; owner: string; repo: string; pullRequestNumber: number;
    headSha: string; mergeCommitSha: string;
  },
): Promise<BoardLandingProofPossession | null | "unverifiable"> {
  const [card] = await db
    .select({ executionState: issues.executionState })
    .from(issues)
    .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)));
  const prKey = `${pr.owner}/${pr.repo}#${pr.pullRequestNumber}`.toLowerCase();
  const products = await db
    .select({ externalId: issueWorkProducts.externalId, url: issueWorkProducts.url, metadata: issueWorkProducts.metadata })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, issue.companyId),
      eq(issueWorkProducts.issueId, issue.id),
      eq(issueWorkProducts.type, "pull_request"),
    ));
  const recordedShas = new Set<string>();
  const prUrl = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.pullRequestNumber}`.toLowerCase();
  for (const product of products) {
    const metadata = (product.metadata ?? {}) as Record<string, unknown>;
    if (metadata.source === BOARD_LANDING_PROOF_WORK_PRODUCT_SOURCE) continue;
    const repository = typeof metadata.repository === "string" ? metadata.repository.toLowerCase() : null;
    const sameRepo = repository === `${pr.owner}/${pr.repo}`.toLowerCase();
    const linked =
      product.externalId?.toLowerCase() === prKey ||
      product.url?.toLowerCase().replace(/\/+$/, "") === prUrl ||
      (sameRepo && metadata.prNumber === pr.pullRequestNumber);
    if (linked) return { kind: "linked_work_product", detail: `work product ${product.externalId ?? product.url}` };
    for (const key of ["headSha", "mergeCommitSha"] as const) {
      const value = typeof metadata[key] === "string" ? (metadata[key] as string).trim().toLowerCase() : "";
      if (/^[0-9a-f]{40}$/.test(value)) recordedShas.add(value);
    }
  }
  const linkedPrs = await resolveLinkedPullRequestsWithState(db, issue.companyId, issue.id, { includeDrafts: true });
  const linkedPr = linkedPrs.find((candidate) =>
    candidate.owner.toLowerCase() === pr.owner.toLowerCase() &&
    candidate.repo.toLowerCase() === pr.repo.toLowerCase() &&
    candidate.number === pr.pullRequestNumber);
  if (linkedPr) return { kind: "linked_external_object", detail: `linked ${linkedPr.displayName}` };
  const state = card?.executionState && typeof card.executionState === "object"
    ? (card.executionState as Record<string, unknown>)
    : null;
  const delivered = typeof state?.deliveredHeadSha === "string" ? state.deliveredHeadSha.trim().toLowerCase() : "";
  if (/^[0-9a-f]{40}$/.test(delivered)) recordedShas.add(delivered);
  let unreadable = false;
  for (const recorded of [...recordedShas].slice(0, MAX_RECORDED_DELIVERY_COMMITS)) {
    if (recorded === pr.headSha || recorded === pr.mergeCommitSha) {
      return { kind: "recorded_delivery_commit", detail: `recorded delivery commit ${recorded.slice(0, 12)} is the PR commit` };
    }
    for (const target of [pr.headSha, pr.mergeCommitSha]) {
      const contained = await commitContains(pr.token, pr.owner, pr.repo, target, recorded);
      if (contained === null) { unreadable = true; continue; }
      if (contained) {
        return {
          kind: "recorded_delivery_commit",
          detail: `PR commit ${target.slice(0, 12)} contains recorded delivery commit ${recorded.slice(0, 12)}`,
        };
      }
    }
  }
  return unreadable ? "unverifiable" : null;
}

/** True when `container` contains `commit` (compare commit...container is ahead or identical). Null when unreadable. */
async function commitContains(token: string, owner: string, repo: string, container: string, commit: string): Promise<boolean | null> {
  let response: Response;
  try {
    response = await ghFetch(
      `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(commit)}...${encodeURIComponent(container)}`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } },
    );
  } catch {
    return null;
  }
  if (response.status === 404) return false;
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (typeof body?.behind_by === "number") return body.behind_by === 0;
  const status = typeof body?.status === "string" ? body.status : null;
  if (status === "ahead" || status === "identical") return true;
  if (status === "behind" || status === "diverged") return false;
  return null;
}

/**
 * The stuck shape this proof exists for. The workflow is completed, at least one
 * completed review stage names only users, no deliveryIdentity is recorded, and
 * the card is not closed. Returns null when eligible, else the refusal reason.
 */
export function boardLandingProofIneligibility(issue: {
  status: string;
  executionPolicy: unknown;
  executionState: unknown;
}): string | null {
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
  const policy = issue.executionPolicy && typeof issue.executionPolicy === "object"
    ? (issue.executionPolicy as { stages?: unknown })
    : null;
  const stages = Array.isArray(policy?.stages) ? policy.stages : [];
  const userOnlyCompletedReview = stages.some((stage) => {
    if (!stage || typeof stage !== "object") return false;
    const { id, type, participants } = stage as { id?: unknown; type?: unknown; participants?: unknown };
    if (type !== "review" || typeof id !== "string" || !completed.has(id)) return false;
    return Array.isArray(participants) && participants.length > 0 &&
      participants.every((participant) =>
        !!participant && typeof participant === "object" && (participant as { type?: unknown }).type === "user");
  });
  if (!userOnlyCompletedReview) {
    return "the card has no completed review stage that names only a user";
  }
  return null;
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
