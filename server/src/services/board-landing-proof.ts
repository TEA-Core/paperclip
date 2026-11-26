import { and, desc, eq } from "drizzle-orm";
import { activityLog, type Db } from "@paperclipai/db";
import { resolveGitHubTokenCandidatesForRepo } from "./github-credential.js";
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

export interface BoardLandingProofEvidence {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  mergeCommitSha?: string | null;
  headSha?: string | null;
}

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
}

export type BoardLandingProofRefusalCode =
  | "landing_proof_wrong_repo"
  | "landing_proof_no_base"
  | "landing_proof_unverifiable"
  | "landing_proof_pr_not_found"
  | "landing_proof_pr_not_merged"
  | "landing_proof_pr_closed_unmerged"
  | "landing_proof_sha_mismatch"
  | "landing_proof_not_on_base";

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
    const onBase = await verifyMergedPullRequestOnBaseBranch(token, owner, repo, baseRef, mergeCommitSha, {
      requireVerifiedBranch: true,
    });
    if (onBase.outcome === "auth-failed") {
      if (!last) continue;
      lastFailure = `merge-commit containment check failed: HTTP ${onBase.status}`;
      break;
    }
    if (onBase.outcome !== "proven") {
      return refuse("landing_proof_not_on_base", onBase.reason);
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
      },
    };
  }
  return refuse("landing_proof_unverifiable", lastFailure);
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
  const { owner, repo, pullRequestNumber, mergeCommitSha, headSha } = details;
  if (typeof owner !== "string" || typeof repo !== "string" || typeof pullRequestNumber !== "number") return null;
  return {
    activityId: row.id,
    evidence: {
      owner,
      repo,
      pullRequestNumber,
      mergeCommitSha: typeof mergeCommitSha === "string" ? mergeCommitSha : null,
      headSha: typeof headSha === "string" ? headSha : null,
    },
  };
}
