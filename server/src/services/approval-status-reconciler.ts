import type { Db } from "@paperclipai/db";
import {
  externalObjectMentions,
  externalObjects,
  issueExecutionDecisions,
  issues,
} from "@paperclipai/db";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import {
  resolveGitHubTokenCandidatesForRepo,
  type GitHubTokenResolution,
} from "./github-credential.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import {
  postPullRequestComment,
  publishApprovalStatus,
  resolveLinkedPullRequestsWithState,
  type ApprovalCandidateAnchor,
  type LinkedPullRequest,
} from "./merge-arming.js";

// SUP-13535. The paperclip/approved commit status is written exactly once, on
// the PR head that existed when the card was approved. When that head later
// moves (conflict resolution, update-branch) the status is stranded on the
// old head and the merge queue loses it. This service re-publishes it on the
// live head, and only when:
//
//   - the card's recorded approval decision is still `approved` in the
//     control-plane DB (the SQL trigger below). Approval is never inferred
//     from the commit, from GitHub's reviewDecision, or from the card status;
//   - stage integrity holds (ADR-073): no auto-skipped stage, every completed
//     stage has a decision row, and no completed stage's latest decision was
//     made by the card's author or its returnAssignee. Self-approved or
//     auto-skipped stages are not approvals;
//   - the linked PR is still open and unmerged (live field-read from GitHub);
//   - the head does not already carry paperclip/approved=success. The head's
//     combined status is read first, so idempotent re-runs perform zero
//     writes;
//   - Guard A (SUP-13714): the live head is only re-published when the PR's
//     diff-vs-base is unchanged in substance from the head that was approved
//     (exec-CTO ruling). The approval transition persists the certified head
//     SHA: publishedHeadSha when the stamp was written, and — since SUP-14715
//     D-B — approvedHeadSha on a skipped/failed first publish, so a skipped
//     first publish leaves a real anchor this service can recover instead of a
//     permanent guard-a:no-approved-head dead-end. The anchor head is read from
//     publishedHeadSha, falling back to approvedHeadSha; when it came from
//     approvedHeadSha the delegated publish below enforces the ADR-091 D1
//     delivery-identity gate (a first publish), a re-publish does not. When the
//     live head differs, the PR's base commit is resolved and the three-dot
//     compare
//     (merge-base-resolved) is fetched at each head; the per-file blob SHAs of
//     the two diffs-vs-base are compared. This is what makes update-branch and
//     rebase inert (the head tree gains the base's new files, but the PR's own
//     diff-vs-base is stable), and what catches a content push, a renumber, or
//     any added/removed file. No persisted head, an unverifiable compare
//     (failure, missing file list, truncated), or any map difference refuses
//     the re-publish — the paperclip/approved stamp is an authorization, and
//     may only certify content that was actually reviewed.
//
// SUP-14602. When the approval transition itself was skipped as ambiguous
// (two linked open PRs), no publishedHeadSha was ever persisted and Guard A
// could never fire. The producer now persists the per-candidate approval-time
// heads in executionState.approvalStatus.pendingCandidates. When
// publishedHeadSha is absent but pendingCandidates is present, the reconciler
// live-checks every candidate: exactly one still open and unmerged selects
// that candidate's headShaAtApproval as the approved head and the UNMODIFIED
// Guard A diff-vs-base comparison runs against it. Every other shape — zero
// open, still more than one open, an unverifiable live state, or a candidate
// without a persisted anchor — refuses with a recorded reason and zero writes.
// A successful recovery re-publish persists publishedHeadSha for that head so
// the normal path takes over; the idempotency pre-check keeps re-runs at zero
// writes.
//
// The write itself is delegated to publishApprovalStatus() from merge-arming.
// The TOCTOU window (the delegated write re-resolves the head live) is closed
// by pinning the delegated write to the head validated here
// (expectedHeadSha): a head that moves in that window makes the delegated
// publish refuse (skipped, head_moved) with zero writes instead of stamping
// unreviewed content.
//
// SUP-14049. When the live head moved off the persisted approved head and
// Guard A positively proves the diff-vs-base changed in substance
// (changed-blob), the published paperclip/approved stamp is stranded on the
// old head and the PR reads green on its own page until the merge queue
// ejects it. The refusal itself is already recorded in this service's
// summary; the void is additionally surfaced ON the PR as an advisory
// comment naming both SHAs ("this PR was approved at <sha>; head <new-sha>
// voids that approval"). The warning:
//   - is advisory only — it is a plain PR comment and never creates, mocks,
//     or writes the paperclip/approved status (the consume-contract);
//   - fires only on positive evidence (changed-blob). Guard A's
//     can-not-verify refusals (compare failure, truncated/missing file
//     list, no base sha) self-heal or retry on the next tick and must not
//     manufacture a false "voided" claim;
//   - is deduplicated by an embedded marker carrying the exact
//     approved->head pair, so a head that stays voided across ticks posts
//     at most one comment per (approved, voiding) pair;
//   - fails soft: a failed read or post is recorded in the tick summary and
//     the PR-conversation detail, never fatal to the reconcile tick — the
//     Guard A refusal is the primary verdict.
// There is no GitHub webhook receiver in this control plane: the reconciler
// tick IS the synchronize observer (it live-reads the linked PR each tick),
// so the warning lands the first tick after the voiding push.

const PAPERCLIP_APPROVED_CONTEXT = "paperclip/approved";
const DEFAULT_MAX_CANDIDATES = 20;
const DEFAULT_INITIAL_DELAY_MS = 60 * 1000;
const MAX_DETAIL_ENTRIES = 25;
const USER_AGENT = "paperclip-approval-status-reconciler";
// SUP-14747: bound on the PR-timeline fan-out for the pre-D-B anchor backfill.
const MAX_BACKFILL_TIMELINE_PAGES = 5;
const BACKFILL_TIMELINE_PER_PAGE = 100;

export interface ApprovalStatusReconcilerTickOptions {
  /** Upper bound on candidates handled in one tick. Excess is reported as `capped`. */
  maxCandidates?: number;
}

export interface ApprovalStatusReconcilerTickSummary {
  /** Candidates that were processed this tick. */
  scanned: number;
  /** Candidates whose paperclip/approved status was (re)published. */
  republished: number;
  /** Skip counts by stable reason key. */
  skipped: Record<string, number>;
  /** Bounded "IDENTIFIER: detail" skip reasons. */
  skippedDetails: string[];
  /** Candidates that could not be resolved or published. */
  failed: number;
  /** Bounded "IDENTIFIER: detail" failure reasons. */
  failedDetails: string[];
  /** Candidates dropped by the per-tick cap. */
  capped: number;
  /**
   * SUP-14049: voids observed this tick whose PR warning was ensured
   * (posted now, or already present from an earlier tick).
   */
  voidWarnings: number;
  /** Bounded "IDENTIFIER: detail" void-warning outcomes. */
  voidWarningDetails: string[];
  /**
   * SUP-14747: stranded pre-D-B first-publish cards whose approval anchor was
   * recovered from the PR timeline this tick (the delegated first publish then
   * proceeds; a backfilled card also counts under `republished` when it stamps).
   */
  backfilled: number;
  /** Bounded "IDENTIFIER: detail" backfill outcomes. */
  backfilledDetails: string[];
}

export interface CandidateRow {
  id: string;
  companyId: string;
  identifier: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionState: Record<string, unknown> | null;
  executionPolicy: Record<string, unknown> | null;
}

type CandidateResult =
  | { kind: "republished"; detail: string; backfilledDetail?: string }
  | { kind: "skipped"; reason: string; detail: string; backfilledDetail?: string; voidWarning?: "posted" | "already-posted" }
  | { kind: "failed"; detail: string; backfilledDetail?: string };

interface GitHubReadOutcome {
  ok: boolean;
  status: number;
  message: string | null;
  body: unknown;
}

interface ApprovedHeadRecord {
  /** The anchor head the card's approval certified (publishedHeadSha, or the D-B approvedHeadSha fallback). */
  anchorHeadSha: string;
  publishedAt?: string;
  /**
   * SUP-14715 D-B: true when the anchor head came from
   * approvalStatus.approvedHeadSha — a head the approval certified but whose
   * paperclip/approved status was never written (a skipped/failed FIRST
   * publish). The delegated publish below is then a first publish and must
   * enforce the ADR-091 D1 delivery-identity gate, because that gate never
   * successfully ran for this head. False when the anchor is publishedHeadSha
   * (a re-publish that certifies by content identity and leaves the gate
   * unset, exactly as before).
   */
  firstPublish: boolean;
}

/**
 * The approved head the card's approval certified, or null when the card was
 * approved before SUP-13714 shipped / the SUP-14715 D-B anchor, or the record
 * was never written. A null here is Guard A's approved-head-unrecoverable case:
 * the reconciler refuses to re-publish, because it cannot prove the live head
 * was ever reviewed.
 *
 * Two anchors are distinguished (SUP-14715 D-B): publishedHeadSha (the status
 * was actually written here — a re-publish, firstPublish: false) and, when that
 * is absent, approvedHeadSha (certified at approval time but never published —
 * a first publish, firstPublish: true). Guard A's content-identity compare is
 * identical in both cases; only the delegated publish's delivery-identity gate
 * differs.
 */
function readApprovedHead(state: Record<string, unknown> | null | undefined): ApprovedHeadRecord | null {
  const approvalStatus = state?.approvalStatus as Record<string, unknown> | null | undefined;
  if (!approvalStatus || typeof approvalStatus !== "object") return null;

  const publishedHeadSha = approvalStatus.publishedHeadSha;
  if (typeof publishedHeadSha === "string" && publishedHeadSha.length > 0) {
    return {
      anchorHeadSha: publishedHeadSha,
      publishedAt: typeof approvalStatus.publishedAt === "string" ? approvalStatus.publishedAt : undefined,
      firstPublish: false,
    };
  }

  const approvedHeadSha = approvalStatus.approvedHeadSha;
  if (typeof approvedHeadSha === "string" && approvedHeadSha.length > 0) {
    return {
      anchorHeadSha: approvedHeadSha,
      publishedAt: typeof approvalStatus.approvedAt === "string" ? approvalStatus.approvedAt : undefined,
      firstPublish: true,
    };
  }

  return null;
}

/**
 * SUP-14602: the pending candidate anchors persisted by an ambiguous
 * approval-time skip (executionState.approvalStatus.pendingCandidates). Any
 * entry that does not carry a positive owner/repo/number is dropped — a
 * partially-shaped record is indistinguishable from a tampered one and must
 * fail closed, not be inferred.
 */
function readPendingCandidates(state: Record<string, unknown> | null | undefined): ApprovalCandidateAnchor[] {
  const approvalStatus = state?.approvalStatus as Record<string, unknown> | null | undefined;
  if (!approvalStatus || typeof approvalStatus !== "object") return [];
  const raw = approvalStatus.pendingCandidates;
  if (!Array.isArray(raw)) return [];
  const out: ApprovalCandidateAnchor[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.owner !== "string" ||
      typeof record.repo !== "string" ||
      record.owner.length === 0 ||
      record.repo.length === 0 ||
      typeof record.number !== "number" ||
      !Number.isInteger(record.number)
    ) {
      continue;
    }
    const key = `${record.owner.toLowerCase()}/${record.repo.toLowerCase()}#${record.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      owner: record.owner,
      repo: record.repo,
      number: record.number,
      headShaAtApproval:
        typeof record.headShaAtApproval === "string" && record.headShaAtApproval.length > 0
          ? record.headShaAtApproval
          : null,
    });
  }
  return out;
}

/** Stable, case-insensitive identity key for a candidate PR (used to compare candidate sets). */
function candidateKey(pr: { owner: string; repo: string; number: number }): string {
  return `${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}#${pr.number}`;
}

/** Human-readable owner/repo#number label for a candidate PR, used in skip/fail reason strings. */
function candidateDisplayName(pr: { owner: string; repo: string; number: number }): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

type PendingCandidateSelection =
  | { anchor: string }
  | { reason: string; detail: string };

/**
 * SUP-14602: pick the certified head for a card that was approved on the
 * skipped:ambiguous path. Exactly one pending candidate must be positively
 * proven open and unmerged, and it must be the target itself — a certified
 * head from a different PR must never be paired with the target's live
 * diff. The target has already been live-verified open
 * and unmerged earlier in the tick, so only the other candidates are re-read.
 * Anything the live read cannot positively prove refuses with a recorded
 * reason — zero writes.
 */
async function selectOpenPendingCandidate(
  db: Db,
  row: CandidateRow,
  pending: ApprovalCandidateAnchor[],
  target: LinkedPullRequest,
): Promise<PendingCandidateSelection> {
  const targetKey = candidateKey(target);
  const openUnmerged: ApprovalCandidateAnchor[] = [];

  for (const candidate of pending) {
    if (candidateKey(candidate) === targetKey) {
      openUnmerged.push(candidate);
      continue;
    }
    const read = await ghReadJson(
      db,
      row.companyId,
      candidate.owner,
      candidate.repo,
      `/pulls/${candidate.number}`,
    );
    const body = (read.body ?? null) as Record<string, unknown> | null;
    const state = typeof body?.state === "string" ? (body.state as string) : null;
    if (!read.ok || state === null) {
      const suffix = read.message ? `${read.message}`.trim() : "";
      return {
        reason: "guard-a:ambiguity-unresolved",
        detail:
          `guard-a: live state of pending candidate ${candidateDisplayName(candidate)} is ` +
          `unverifiable (HTTP ${read.status}${suffix ? ` ${suffix}` : ""}); ` +
          `cannot prove exactly one candidate open; refusing`,
      };
    }
    if (body?.merged === true || state !== "open") continue;
    openUnmerged.push(candidate);
  }

  if (openUnmerged.length === 0) {
    return {
      reason: "guard-a:candidate-resolved",
      detail:
        `guard-a: all ${pending.length} pending candidate(s) are closed or merged; ` +
        `nothing was approved that can be recovered — refusing to stamp unreviewed content`,
    };
  }
  if (openUnmerged.length > 1) {
    return {
      reason: "guard-a:ambiguity-unresolved",
      detail:
        `guard-a: ${openUnmerged.length} pending candidates still open ` +
        `(${openUnmerged.map(candidateDisplayName).join(", ")}); refusing until a human or ` +
        `agent closes the duplicate PR`,
    };
  }
  const surviving = openUnmerged[0]!;
  if (candidateKey(surviving) !== targetKey) {
    // The live target is open but was never an approval-time candidate, while
    // exactly one certified candidate is still open. Pairing that candidate's
    // certified head with the target's live diff would compare two different
    // PRs — refuse with a recorded reason instead of a misleading
    // changed-blob / void warning on the target.
    return {
      reason: "guard-a:candidate-not-target",
      detail:
        `guard-a: the only open pending candidate (${candidateDisplayName(surviving)}) is not the ` +
        `live target (${candidateDisplayName(target)}); its certified head belongs to a different PR; ` +
        `refusing to pair a foreign approved head`,
    };
  }
  if (!surviving.headShaAtApproval) {
    return {
      reason: "guard-a:no-approved-head",
      detail:
        `guard-a: surviving candidate ${candidateDisplayName(surviving)} has no persisted ` +
        `approval-time head anchor; refusing to re-publish unverified head`,
    };
  }
  return { anchor: surviving.headShaAtApproval };
}

/**
 * Build a `filename -> blob sha` map from a GitHub compare response, or null
 * when the response is unusable. `files` entries carry the blob SHA of each
 * side of the diff; equality of two maps therefore means byte-identical
 * content per file. A `truncated` compare (GitHub caps `files` at 300) is not
 * a complete diff and must fail closed.
 */
function fileMapFromCompare(body: unknown): Map<string, string> | null {
  const record = body as Record<string, unknown> | null;
  if (!record || record.truncated === true) return null;
  const files = record.files;
  if (!Array.isArray(files)) return null;
  const map = new Map<string, string>();
  for (const file of files as Array<Record<string, unknown>>) {
    const filename = file.filename;
    const sha = file.sha;
    if (typeof filename !== "string" || typeof sha !== "string") return null;
    map.set(filename, sha);
  }
  return map;
}

/**
 * Bounded, human-readable summary of the difference between the approved and
 * live diff-vs-base maps, or null when the two maps are identical.
 */
function diffSubstanceChange(
  approved: Map<string, string>,
  live: Map<string, string>,
): string | null {
  const changed: string[] = [];
  for (const [filename, sha] of approved) {
    const liveSha = live.get(filename);
    if (liveSha === undefined) {
      changed.push(`${filename} (removed)`);
    } else if (liveSha !== sha) {
      changed.push(`${filename} (changed)`);
    }
  }
  for (const filename of live.keys()) {
    if (!approved.has(filename)) {
      changed.push(`${filename} (added)`);
    }
  }
  if (changed.length === 0) return null;
  const shown = changed.slice(0, 3).join(", ");
  return changed.length > 3
    ? `${shown}, ... (${changed.length} file(s) differ)`
    : `${shown} (${changed.length} file(s) differ)`;
}

/**
 * GET a GitHub REST endpoint as JSON, trying each resolvable token in order
 * (mirrors publishApprovalStatus's candidate walk: 401/403 advances to the
 * next candidate, everything else is final).
 */
async function ghReadJson(
  db: Db,
  companyId: string,
  owner: string,
  repo: string,
  path: string,
): Promise<GitHubReadOutcome> {
  const candidates = await resolveGitHubTokenCandidatesForRepo(db, companyId, owner, repo);
  if (candidates.length === 0) {
    return { ok: false, status: 0, message: "no_token_candidates", body: null };
  }

  let last: GitHubReadOutcome | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidate: GitHubTokenResolution = candidates[i]!;
    const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;
    let response: Response;
    try {
      response = await ghFetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": USER_AGENT,
          "x-github-api-version": "2022-11-28",
          authorization: `Bearer ${candidate.token}`,
        },
      });
    } catch {
      last = { ok: false, status: 0, message: "network_error", body: null };
      continue;
    }

    const body = await response.json().catch(() => null);
    const message = response.ok
      ? null
      : typeof (body as Record<string, unknown> | null)?.message === "string"
        ? ((body as Record<string, unknown>).message as string)
        : "";

    if (!response.ok && (response.status === 401 || response.status === 403) && i < candidates.length - 1) {
      last = { ok: false, status: response.status, message, body: null };
      continue;
    }

    last = { ok: response.ok, status: response.status, message, body };
    break;
  }

  return last!;
}

/**
 * SUP-14049: the machine-checkable marker embedded at the end of the void
 * warning comment. It carries the full approved -> voiding head pair, so the
 * marker is a content-key: re-runs for the same pair dedupe, while a later
 * voiding head posts its own comment instead of being swallowed.
 */
function voidWarningMarker(approvedHeadSha: string, headSha: string): string {
  return `[paperclip:approval-voided ${approvedHeadSha} -> ${headSha}]`;
}

/**
 * SUP-14049: the body of the void warning, landed on the PR itself so the
 * stranded stamp is visible where the PR reads green — not only in
 * control-plane logs. Advisory only: it names both SHAs and states what
 * happens next (a human or the review stage decides; no auto re-approval).
 */
function voidWarningBody(
  identifier: string,
  approvedHeadSha: string,
  headSha: string,
  substanceChange: string,
): string {
  return (
    `[Paperclip approval voided] This PR was approved at ${approvedHeadSha} (${identifier}); ` +
    `head ${headSha} voids that approval.\n\n` +
    `The paperclip/approved stamp is stranded on ${approvedHeadSha} and no longer covers this head: ` +
    `the PR's diff-vs-base changed in substance after approval (${substanceChange}). ` +
    `The approval-status reconciler refuses to re-stamp content that was never reviewed ` +
    `(Guard A) and does not auto re-approve — a human or the review stage decides next steps.\n\n` +
    voidWarningMarker(approvedHeadSha, headSha)
  );
}

/**
 * SUP-14049: surface the void on the PR. Dedupes by re-reading the newest
 * page of the PR conversation for this exact approved->head marker before
 * posting, so a head that stays voided across ticks posts at most one
 * comment (the marker we posted is the most recent comment, hence
 * direction=desc). A failed read fails the post (a write we cannot dedup
 * must not be attempted); a failed post is reported, never fatal — the
 * Guard A refusal is the primary verdict and the warning is advisory.
 */
async function postApprovalVoidWarning(
  db: Db,
  row: CandidateRow,
  target: LinkedPullRequest,
  approvedHeadSha: string,
  headSha: string,
  substanceChange: string,
): Promise<{ kind: "posted" } | { kind: "already-posted" } | { kind: "failed"; detail: string }> {
  const marker = voidWarningMarker(approvedHeadSha, headSha);
  const listing = await ghReadJson(
    db,
    row.companyId,
    target.owner,
    target.repo,
    `/issues/${target.number}/comments?per_page=100&direction=desc`,
  );
  if (!listing.ok) {
    return {
      kind: "failed",
      detail: `void warning comment check failed: HTTP ${listing.status} ${listing.message ?? ""}`.trim(),
    };
  }
  const comments = Array.isArray(listing.body)
    ? (listing.body as Array<Record<string, unknown>>)
    : [];
  if (comments.some((c) => typeof c.body === "string" && c.body.includes(marker))) {
    return { kind: "already-posted" };
  }

  const candidates = await resolveGitHubTokenCandidatesForRepo(db, row.companyId, target.owner, target.repo);
  if (candidates.length === 0) {
    return { kind: "failed", detail: "void warning post skipped: no GitHub token candidates" };
  }
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const result = await postPullRequestComment(
      candidate.token,
      target.owner,
      target.repo,
      target.number,
      voidWarningBody(row.identifier ?? row.id, approvedHeadSha, headSha, substanceChange),
    );
    if (result.success) return { kind: "posted" };
    if ((result.status === 401 || result.status === 403) && i < candidates.length - 1) continue;
    return {
      kind: "failed",
      detail: `void warning post failed: HTTP ${result.status} ${result.error ?? ""}`.trim(),
    };
  }
  return { kind: "failed", detail: "void warning post failed: exhausted GitHub token candidates" };
}

/**
 * Cards whose recorded approval decision is still `approved`, that are not
 * cancelled, and that carry at least one linked GitHub PR. The trigger is the
 * control-plane record alone — nothing is inferred from commits or GitHub.
 */
async function findApprovalCandidates(db: Db, limit: number): Promise<CandidateRow[]> {
  return db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      createdByAgentId: issues.createdByAgentId,
      createdByUserId: issues.createdByUserId,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      executionState: issues.executionState,
      executionPolicy: issues.executionPolicy,
    })
    .from(issues)
    .where(
      and(
        ne(issues.status, "cancelled"),
        sql`(${issues.executionState} ->> 'lastDecisionOutcome') = 'approved'`,
        sql`${issues.identifier} is not null`,
        sql`(exists (
          select 1
          from ${externalObjectMentions}
          inner join ${externalObjects} on ${externalObjects.id} = ${externalObjectMentions.objectId}
          where ${externalObjectMentions.companyId} = ${issues.companyId}
            and ${externalObjectMentions.sourceIssueId} = ${issues.id}
            and ${externalObjectMentions.objectType} = 'pull_request'
            and ${externalObjects.providerKey} = 'github'
        ))`,
      ),
    )
    .orderBy(issues.identifier)
    .limit(limit);
}

/**
 * ADR-073 / ADR-092 stage-integrity audit of the recorded approval. Returns a
 * skip verdict when the "approved" record is not backed by a real, non-self
 * decision: an auto-skipped review stage writes no decision row and lands in
 * skippedStageIds, so it must never be treated as an approval. The gated
 * principal is the resolved return assignee (ADR-092 D3):
 * policy.returnAssigneeAgentId ?? state.returnAssignee ?? assigneeAgentId.
 */
export async function evaluateStageIntegrity(
  db: Db,
  row: CandidateRow,
): Promise<{ reason: string; detail: string } | null> {
  const state: Record<string, unknown> = row.executionState ?? {};
  const policy: Record<string, unknown> = row.executionPolicy ?? {};

  const skippedStageIds = Array.isArray(state.skippedStageIds)
    ? (state.skippedStageIds as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  if (skippedStageIds.length > 0) {
    return {
      reason: "guard-b:skipped-stage",
      detail: `skipped stages present: ${skippedStageIds.join(", ")}`,
    };
  }

  const policyStageIds = new Set(
    (Array.isArray(policy.stages)
      ? (policy.stages as Array<Record<string, unknown> | null | undefined>)
      : []
    )
      .map((stage) => (stage && typeof stage.id === "string" ? stage.id : null))
      .filter((id): id is string => id !== null),
  );

  const completedStageIds = Array.isArray(state.completedStageIds)
    ? (state.completedStageIds as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  if (completedStageIds.length === 0) {
    return {
      reason: "guard-b:no-completed-stage",
      detail: "no completed stages recorded in executionState",
    };
  }
  for (const stageId of completedStageIds) {
    if (!policyStageIds.has(stageId)) {
      return {
        reason: "guard-b:stage-not-in-policy",
        detail: `completed stage ${stageId} is not in executionPolicy.stages`,
      };
    }
  }

  const decisions = await db
    .select({
      stageId: issueExecutionDecisions.stageId,
      actorAgentId: issueExecutionDecisions.actorAgentId,
      actorUserId: issueExecutionDecisions.actorUserId,
      createdAt: issueExecutionDecisions.createdAt,
    })
    .from(issueExecutionDecisions)
    .where(eq(issueExecutionDecisions.issueId, row.id));

  const latestByStage = new Map<string, { actorAgentId: string | null; actorUserId: string | null; createdAt: Date }>();
  for (const decision of decisions) {
    const existing = latestByStage.get(decision.stageId);
    if (!existing || decision.createdAt.getTime() >= existing.createdAt.getTime()) {
      latestByStage.set(decision.stageId, {
        actorAgentId: decision.actorAgentId,
        actorUserId: decision.actorUserId,
        createdAt: decision.createdAt,
      });
    }
  }
  for (const stageId of completedStageIds) {
    if (!latestByStage.has(stageId)) {
      return {
        reason: "guard-b:stage-without-decision",
        detail: `completed stage ${stageId} has no issue_execution_decisions row`,
      };
    }
  }

  const forbiddenAgents = new Set<string>();
  const forbiddenUsers = new Set<string>();
  if (typeof policy.returnAssigneeAgentId === "string" && policy.returnAssigneeAgentId) {
    forbiddenAgents.add(policy.returnAssigneeAgentId);
  } else {
    const returnAssignee = state.returnAssignee as
      | { type?: unknown; agentId?: unknown; userId?: unknown }
      | null
      | undefined;
    if (returnAssignee && typeof returnAssignee === "object") {
      if (returnAssignee.type === "agent" && typeof returnAssignee.agentId === "string") {
        forbiddenAgents.add(returnAssignee.agentId);
      } else if (returnAssignee.type === "user" && typeof returnAssignee.userId === "string") {
        forbiddenUsers.add(returnAssignee.userId);
      }
    }
    if (forbiddenAgents.size === 0 && forbiddenUsers.size === 0) {
      if (row.assigneeAgentId) forbiddenAgents.add(row.assigneeAgentId);
      if (row.assigneeUserId) forbiddenUsers.add(row.assigneeUserId);
    }
  }

  for (const stageId of completedStageIds) {
    const latest = latestByStage.get(stageId)!;
    if ((latest.actorAgentId && forbiddenAgents.has(latest.actorAgentId)) ||
        (latest.actorUserId && forbiddenUsers.has(latest.actorUserId))) {
      return {
        reason: "guard-b:decision-by-return-assignee",
        detail: `stage ${stageId} decided by the resolved return assignee`,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// SUP-14747 (D-E): pre-D-B approval-anchor backfill.
//
// A first publish that ran before SUP-14715 D-B landed (or whose D-B write
// failed) leaves no publishedHeadSha and no approvedHeadSha — a stranded card
// that the Guard A no-approved-head dead-end can never recover. The approval
// itself is still recorded (issue_execution_decisions), and the PR's head at
// approval time is derivable from the PR timeline. This recovers the lost D-B
// anchor so the UNMODIFIED first-publish path below can certify it with the
// ADR-091 D1 delivery-identity gate enforced.
//
// The anchor is the last head-mutating event (committed / head_ref_force_pushed)
// at or before the approval decision's createdAt — the head that was actually
// reviewed. Fail-closed invariant: the backfill only writes when that head
// equals the live PR head. A head that moved after approval is refused (the
// reviewed code is no longer the head), leaving the card stranded for re-review.
// Any unverifiable timeline (read failure, truncation, unparseable event, or no
// head-mutating event at/before the approval) is a recorded refusal, zero writes.
// ---------------------------------------------------------------------------

type HeadEvidence =
  | { kind: "force_pushed"; sha: string; timeMs: number }
  | { kind: "committed"; sha: string }
  | { kind: "unparseable" };

/**
 * Extract a head-mutating event's evidence. `head_ref_force_pushed` events carry
 * a server-recorded `created_at` (the moment the push reached GitHub) and are the
 * only events trusted to place the head "at or before the approval time".
 * `committed` events carry only client-set `committer.date` / `author.date` and
 * NO server `created_at` — the API returns none for them, and GitHub orders the
 * timeline by commit timestamp, not push time — so they are recorded but never
 * trusted to place the head: a head provable only through committed events is
 * refused as unverifiable (the backfill-committed-event-timing review finding). A
 * head-mutating event that cannot be placed (a force-push missing its
 * `created_at`/`commit_id`, a commit missing its sha) is `unparseable` — a
 * fail-closed refusal, never a silent skip. Non head-mutating events return null.
 */
function extractHeadEvidence(event: Record<string, unknown>): HeadEvidence | null {
  const kind = typeof event.event === "string" ? event.event : null;
  if (kind === "head_ref_force_pushed") {
    const sha =
      typeof event.commit_id === "string" && event.commit_id.length > 0 ? event.commit_id : null;
    const createdStr = typeof event.created_at === "string" ? event.created_at : null;
    const timeMs = createdStr ? Date.parse(createdStr) : NaN;
    return sha && !Number.isNaN(timeMs) ? { kind: "force_pushed", sha, timeMs } : { kind: "unparseable" };
  }
  if (kind === "committed") {
    const sha = typeof event.sha === "string" && event.sha.length > 0 ? event.sha : null;
    // No server timestamp: the sha is recorded, but the event cannot place the
    // head at a trustworthy time.
    return sha ? { kind: "committed", sha } : { kind: "unparseable" };
  }
  return null;
}

type TimelineHeadEvents =
  | { kind: "ok"; headAtApproval: string | null; sawCommittedHeadEvent: boolean }
  | { kind: "truncated"; headAtApproval: string | null; sawCommittedHeadEvent: boolean }
  | { kind: "failed"; detail: string };

/**
 * Fetch the PR timeline and recover the verified head-at-approval: the newest
 * `head_ref_force_pushed` event whose server-recorded `created_at` is at or
 * before `cutoffMs` (in chronological order — the PR timeline's own order). The
 * loop reads oldest-first and stops as soon as it reaches a force-push past the
 * approval time, so every at/before-approval push is already captured. `committed`
 * events are recorded (`sawCommittedHeadEvent`) but never trusted to place the
 * head. A bounded fan-out that exhausts its pages without reaching the end of the
 * timeline (or passing the approval time via a force-push) is reported
 * `truncated` so the caller refuses rather than anchoring a head it cannot prove.
 */
async function readPrTimelineHeadEvents(
  db: Db,
  companyId: string,
  owner: string,
  repo: string,
  number: number,
  cutoffMs: number,
): Promise<TimelineHeadEvents> {
  let headAtApproval: string | null = null;
  let sawCommittedHeadEvent = false;
  let complete = false;

  outer: for (let page = 1; page <= MAX_BACKFILL_TIMELINE_PAGES; page++) {
    const read = await ghReadJson(
      db,
      companyId,
      owner,
      repo,
      `/issues/${number}/timeline?per_page=${BACKFILL_TIMELINE_PER_PAGE}&page=${page}`,
    );
    if (!read.ok) {
      return { kind: "failed", detail: `timeline-read-failed: HTTP ${read.status} ${read.message ?? ""}`.trim() };
    }
    const items = Array.isArray(read.body) ? (read.body as Array<Record<string, unknown>>) : null;
    if (!items) {
      return { kind: "failed", detail: "timeline-read-failed: unexpected non-array body" };
    }
    for (const event of items) {
      if (!event || typeof event !== "object") continue;
      const info = extractHeadEvidence(event);
      if (info === null) continue;
      if (info.kind === "unparseable") {
        return {
          kind: "failed",
          detail: "timeline-read-failed: unparseable head-mutating event; refusing to anchor",
        };
      }
      if (info.kind === "committed") {
        sawCommittedHeadEvent = true;
        continue;
      }
      // force_pushed — the only events with a trustworthy server timestamp.
      if (info.timeMs <= cutoffMs) {
        headAtApproval = info.sha;
      } else {
        complete = true;
        break outer;
      }
    }
    if (items.length < BACKFILL_TIMELINE_PER_PAGE) {
      complete = true;
      break;
    }
  }

  return complete
    ? { kind: "ok", headAtApproval, sawCommittedHeadEvent }
    : { kind: "truncated", headAtApproval, sawCommittedHeadEvent };
}

type BackfillOutcome =
  | { kind: "backfilled"; anchorHeadSha: string; detail: string }
  | { kind: "skipped"; reason: string; detail: string };

/**
 * A stable backfill refusal persisted on the card's executionState.approvalStatus
 * so the next reconciler tick can re-report it without re-reading the PR
 * timeline while the live head is unchanged (the backfill-repeat-fanout review
 * finding). `observedHeadSha` is the live head the refusal was derived against.
 */
type BackfillRefusal = {
  reason: string;
  observedHeadSha: string;
  observedAt: string;
};

function readBackfillRefusal(row: CandidateRow): BackfillRefusal | null {
  const approvalStatus =
    (row.executionState?.approvalStatus as Record<string, unknown> | null | undefined) ?? null;
  if (!approvalStatus || typeof approvalStatus !== "object") return null;
  const raw = approvalStatus.backfillRefusal;
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.reason !== "string" ||
    typeof obj.observedHeadSha !== "string" ||
    obj.observedHeadSha.length === 0
  ) {
    return null;
  }
  return {
    reason: obj.reason,
    observedHeadSha: obj.observedHeadSha,
    observedAt: typeof obj.observedAt === "string" ? obj.observedAt : "",
  };
}

async function persistBackfillRefusal(
  db: Db,
  row: CandidateRow,
  refusal: BackfillRefusal,
): Promise<void> {
  const currentState = row.executionState ?? {};
  const existing = (currentState.approvalStatus as Record<string, unknown> | null | undefined) ?? {};
  const nextExecutionState: Record<string, unknown> = {
    ...currentState,
    approvalStatus: { ...existing, backfillRefusal: refusal },
  };
  await db
    .update(issues)
    .set({ executionState: nextExecutionState })
    .where(eq(issues.id, row.id));
  row.executionState = nextExecutionState;
}

/**
 * SUP-14747: recover the D-B approval anchor for a stranded pre-D-B first
 * publish. Reads the card's approval time (latest approved decision), derives
 * the verified head-at-approval-time from the PR timeline (the newest force-push
 * whose server-recorded `created_at` is at/before the approval), and — only when
 * that head still equals the live head — writes approvalStatus.approvedHeadSha +
 * approvedAt so the unmodified first-publish path certifies it. A head provable
 * only through committed (client-timed) events, or any head we cannot verify to a
 * server timestamp, is refused with a recorded reason and zero writes. A stable
 * refusal is persisted on the card so the next tick skips the timeline re-read
 * while the live head is unchanged (backfill-repeat-fanout).
 */
async function backfillPreDBApprovalAnchor(
  db: Db,
  row: CandidateRow,
  target: LinkedPullRequest,
  currentHeadSha: string,
): Promise<BackfillOutcome> {
  const label = row.identifier ?? row.id;

  const [decision] = await db
    .select({ createdAt: issueExecutionDecisions.createdAt })
    .from(issueExecutionDecisions)
    .where(
      and(
        eq(issueExecutionDecisions.issueId, row.id),
        eq(issueExecutionDecisions.outcome, "approved"),
      ),
    )
    .orderBy(desc(issueExecutionDecisions.createdAt))
    .limit(1);
  if (!decision || !(decision.createdAt instanceof Date) || Number.isNaN(decision.createdAt.getTime())) {
    return {
      kind: "skipped",
      reason: "backfill:no-approval-decision",
      detail: `backfill: no approved issue_execution_decisions row for ${label}; cannot determine the approval time; refusing`,
    };
  }
  const approvalTimeMs = decision.createdAt.getTime();

  // Finding 3 (backfill-repeat-fanout): a stable refusal is a deterministic
  // function of (timeline, live head, approval time). While the live head is the
  // same one the last refusal was derived against, re-report it and skip the
  // timeline re-read. A new live head clears the marker (observedHeadSha
  // mismatch) and forces a fresh read.
  const cached = readBackfillRefusal(row);
  if (cached && cached.observedHeadSha === currentHeadSha) {
    return {
      kind: "skipped",
      reason: cached.reason,
      detail: `backfill: stable refusal ${cached.reason} (observed head ${cached.observedHeadSha.slice(0, 7)} unchanged since ${cached.observedAt || "an earlier tick"}); skipping the timeline re-read for ${target.displayName}`,
    };
  }

  const timeline = await readPrTimelineHeadEvents(
    db,
    row.companyId,
    target.owner,
    target.repo,
    target.number,
    approvalTimeMs,
  );
  if (timeline.kind === "failed") {
    await persistBackfillRefusal(db, row, {
      reason: "backfill:timeline-read-failed",
      observedHeadSha: currentHeadSha,
      observedAt: new Date().toISOString(),
    });
    return { kind: "skipped", reason: "backfill:timeline-read-failed", detail: `backfill: ${timeline.detail}` };
  }
  if (timeline.kind === "truncated") {
    await persistBackfillRefusal(db, row, {
      reason: "backfill:timeline-truncated",
      observedHeadSha: currentHeadSha,
      observedAt: new Date().toISOString(),
    });
    return {
      kind: "skipped",
      reason: "backfill:timeline-truncated",
      detail: `backfill: PR timeline for ${target.displayName} is incomplete and cannot be positively read up to the approval time; refusing to anchor an unverifiable head`,
    };
  }

  if (timeline.headAtApproval === null) {
    const reason = timeline.sawCommittedHeadEvent
      ? "backfill:head-unverifiable"
      : "backfill:no-head-mutating-event";
    const detail = timeline.sawCommittedHeadEvent
      ? `backfill: ${target.displayName} shows only committed (client-timed) head events at or before the approval ${decision.createdAt.toISOString()} and no force-pushed (server-timed) head; the head-at-approval cannot be verified to a server timestamp; refusing to anchor an unverifiable head`
      : `backfill: no committed / head_ref_force_pushed event at or before the approval time for ${target.displayName}; refusing to anchor an unverifiable head`;
    await persistBackfillRefusal(db, row, {
      reason,
      observedHeadSha: currentHeadSha,
      observedAt: new Date().toISOString(),
    });
    return { kind: "skipped", reason, detail };
  }

  if (timeline.headAtApproval !== currentHeadSha) {
    await persistBackfillRefusal(db, row, {
      reason: "backfill:head-moved-since-approval",
      observedHeadSha: currentHeadSha,
      observedAt: new Date().toISOString(),
    });
    return {
      kind: "skipped",
      reason: "backfill:head-moved-since-approval",
      detail: `backfill: verified head at approval time ${timeline.headAtApproval.slice(0, 7)} differs from the live head ${currentHeadSha.slice(0, 7)}; the reviewed code is no longer the head; refusing and leaving the card for re-review`,
    };
  }

  const existingApprovalStatus =
    ((row.executionState?.approvalStatus as Record<string, unknown> | null | undefined) ?? {});
  const nextApprovalStatus: Record<string, unknown> = {
    ...existingApprovalStatus,
    approvedHeadSha: timeline.headAtApproval,
    approvedAt: decision.createdAt.toISOString(),
  };
  delete nextApprovalStatus.backfillRefusal;
  const nextExecutionState: Record<string, unknown> = {
    ...(row.executionState ?? {}),
    approvalStatus: nextApprovalStatus,
  };
  await db
    .update(issues)
    .set({ executionState: nextExecutionState })
    .where(eq(issues.id, row.id));
  row.executionState = nextExecutionState;

  return {
    kind: "backfilled",
    anchorHeadSha: timeline.headAtApproval,
    detail: `backfill: anchored ${timeline.headAtApproval.slice(0, 7)} from the ${target.displayName} timeline (approved ${decision.createdAt.toISOString()})`,
  };
}

async function reconcileCandidate(db: Db, row: CandidateRow): Promise<CandidateResult> {
  const label = row.identifier ?? row.id;

  const integrity = await evaluateStageIntegrity(db, row);
  if (integrity) {
    return { kind: "skipped", reason: integrity.reason, detail: `guard-b ${integrity.detail}` };
  }

  const linked = await resolveLinkedPullRequestsWithState(db, row.companyId, row.id);
  const openPrs = linked.filter((pr) => pr.cachedState === "open");
  const unhydratedPrs = linked.filter((pr) => pr.cachedState === null);
  let target: LinkedPullRequest | null = null;
  if (openPrs.length === 1) {
    target = openPrs[0];
  } else if (openPrs.length === 0 && unhydratedPrs.length === 1) {
    target = unhydratedPrs[0];
  }
  if (!target) {
    const reason =
      openPrs.length > 1 || (openPrs.length === 0 && unhydratedPrs.length > 1)
        ? "ambiguous-pr"
        : "no-open-pr";
    const cached =
      linked.length > 0
        ? linked.map((pr) => `${pr.displayName} state=${pr.cachedState ?? "unhydrated"}`).join(", ")
        : "none";
    return { kind: "skipped", reason, detail: `${reason}: linked mentions: ${cached}` };
  }

  const prRead = await ghReadJson(db, row.companyId, target.owner, target.repo, `/pulls/${target.number}`);
  if (!prRead.ok) {
    return { kind: "failed", detail: `pr-fetch-failed: HTTP ${prRead.status} ${prRead.message ?? ""}`.trim() };
  }
  const prBody = prRead.body as Record<string, unknown> | null;
  const headSha = ((prBody?.head as Record<string, unknown> | undefined)?.sha as string | undefined) ?? null;
  if (!headSha) {
    return { kind: "failed", detail: "pr-fetch-failed: no head sha in PR payload" };
  }
  if (prBody?.merged === true) {
    return { kind: "skipped", reason: "pr-merged", detail: `pr-merged: ${target.displayName} is merged` };
  }
  if (typeof prBody?.state === "string" && prBody.state !== "open") {
    return { kind: "skipped", reason: "pr-closed", detail: `pr-closed: ${target.displayName} state=${prBody.state}` };
  }

  // Idempotency pre-check: read the head's combined status. A 404 means the
  // ref itself is not resolvable (the sha was just read from the live PR, so
  // this is not the "no statuses yet" case) — treat it as a failure, never as
  // a publish trigger.
  const headStatus = await ghReadJson(
    db,
    row.companyId,
    target.owner,
    target.repo,
    `/commits/${encodeURIComponent(headSha)}/status`,
  );
  if (!headStatus.ok) {
    return {
      kind: "failed",
      detail: `head-status-check-failed: HTTP ${headStatus.status} ${headStatus.message ?? ""}`.trim(),
    };
  }
  const statuses = Array.isArray((headStatus.body as Record<string, unknown> | null)?.statuses)
    ? ((headStatus.body as Record<string, unknown>).statuses as Array<Record<string, unknown>>)
    : [];
  if (statuses.some((s) => s.context === PAPERCLIP_APPROVED_CONTEXT && s.state === "success")) {
    return {
      kind: "skipped",
      reason: "already-success",
      detail: `already-success: ${target.displayName} head ${headSha.slice(0, 7)} already carries ${PAPERCLIP_APPROVED_CONTEXT}=success`,
    };
  }

  // Guard A — content-identity anti-laundering check (SUP-13714). The
  // paperclip/approved status is an authorization: it may only certify content
  // that was actually reviewed. The approval transition persisted the exact
  // head it certified — publishedHeadSha when the stamp was written, or the
  // SUP-14715 D-B approvedHeadSha fallback on a skipped/failed first publish.
  // When the live head differs, re-publish only if the PR's diff-vs-base is
  // unchanged in substance from the approved head (exec-CTO ruling): resolve
  // the PR's base commit, fetch the three-dot compare (merge-base-resolved) at
  // each head, and compare the per-file blob SHAs. This makes update-branch and
  // rebase inert (the head tree gains the base's new files, but the PR's own
  // diff-vs-base is stable) and catches a content push, a renumber, or any
  // added/removed file. Any case we cannot positively verify is a refusal with
  // a recorded reason — never a re-publish.
  const approvedHead = readApprovedHead(row.executionState);
  let approvedHeadSha: string | null = approvedHead ? approvedHead.anchorHeadSha : null;
  // SUP-14715 D-B: the anchor came from approvalStatus.approvedHeadSha (a
  // certified but never-published FIRST publish) when approvedHead.firstPublish —
  // the ADR-091 D1 delivery-identity gate never ran for that head, so the
   // delegated publish below enforces it. A re-publish (anchor from
   // publishedHeadSha) and a SUP-14602 pending-candidate recovery
   // (approvedHead === null) both certify by content identity without the gate.
   // A SUP-14747 backfill recovers a never-published anchor, so it too is a
   // first publish that enforces the gate.
   let enforceDeliveryIdentity = approvedHead ? approvedHead.firstPublish : false;
   let backfilledDetail: string | undefined;
   if (approvedHeadSha === null) {
     // SUP-14602: no published head, but the approval-time certification may
     // have survived the skipped:ambiguous transition as pending candidates.
     const pending = readPendingCandidates(row.executionState);
     if (pending.length === 0) {
       // SUP-14747 (D-E): a stranded pre-D-B first publish (no publishedHeadSha,
       // no approvedHeadSha, no pendingCandidates) has a lost anchor. Recover it
       // from the PR timeline — the last head-mutating event at/before the
       // approval decision — and only when that head still equals the live head.
       // On success the unmodified first-publish path below certifies it; on any
       // refusal the card is left exactly as found for re-review.
       const backfill = await backfillPreDBApprovalAnchor(db, row, target, headSha);
       if (backfill.kind === "backfilled") {
         approvedHeadSha = backfill.anchorHeadSha;
         enforceDeliveryIdentity = true;
         backfilledDetail = backfill.detail;
       } else {
         return { kind: "skipped", reason: backfill.reason, detail: backfill.detail };
       }
     } else {
       const selection = await selectOpenPendingCandidate(db, row, pending, target);
       if ("anchor" in selection) {
         approvedHeadSha = selection.anchor;
       } else {
         return { kind: "skipped", reason: selection.reason, detail: selection.detail };
       }
     }
   }
  if (approvedHeadSha !== headSha) {
    const baseSha = ((prBody?.base as Record<string, unknown> | undefined)?.sha as string | undefined) ?? null;
    if (!baseSha) {
      return {
        kind: "skipped",
        reason: "guard-a:no-base-ref",
        detail: `guard-a: PR payload for ${target.displayName} carries no base sha; cannot compute diff-vs-base for ${headSha.slice(0, 7)}; refusing to re-publish`,
      };
    }
    const approvedDiff = await ghReadJson(
      db,
      row.companyId,
      target.owner,
      target.repo,
      `/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(approvedHeadSha)}`,
    );
    if (!approvedDiff.ok) {
      return {
        kind: "skipped",
        reason: "guard-a:compare-failed",
        detail: `guard-a: approved diff-vs-base ${baseSha.slice(0, 7)}...${approvedHeadSha.slice(0, 7)} failed (HTTP ${approvedDiff.status} ${approvedDiff.message ?? ""}); refusing to re-publish`,
      };
    }
    const approvedFiles = fileMapFromCompare(approvedDiff.body);
    if (!approvedFiles) {
      return {
        kind: "skipped",
        reason: "guard-a:unverifiable",
        detail: `guard-a: approved diff-vs-base ${baseSha.slice(0, 7)}...${approvedHeadSha.slice(0, 7)} returned no usable file list; cannot prove ${headSha.slice(0, 7)} was reviewed; refusing to re-publish`,
      };
    }
    const liveDiff = await ghReadJson(
      db,
      row.companyId,
      target.owner,
      target.repo,
      `/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`,
    );
    if (!liveDiff.ok) {
      return {
        kind: "skipped",
        reason: "guard-a:compare-failed",
        detail: `guard-a: live diff-vs-base ${baseSha.slice(0, 7)}...${headSha.slice(0, 7)} failed (HTTP ${liveDiff.status} ${liveDiff.message ?? ""}); refusing to re-publish`,
      };
    }
    const liveFiles = fileMapFromCompare(liveDiff.body);
    if (!liveFiles) {
      return {
        kind: "skipped",
        reason: "guard-a:unverifiable",
        detail: `guard-a: live diff-vs-base ${baseSha.slice(0, 7)}...${headSha.slice(0, 7)} returned no usable file list; refusing to re-publish`,
      };
    }
    const substanceChange = diffSubstanceChange(approvedFiles, liveFiles);
    if (substanceChange) {
      // SUP-14049: positive evidence the new head voids the published
      // approval — surface it on the PR itself, advisory-only.
      const voidWarning = await postApprovalVoidWarning(
        db,
        row,
        target,
        approvedHeadSha,
        headSha,
        substanceChange,
      );
      const voidNote =
        voidWarning.kind === "posted"
          ? "; void warning posted on the PR"
          : voidWarning.kind === "already-posted"
            ? "; void warning already posted on the PR"
            : `; ${voidWarning.detail}`;
      return {
        kind: "skipped",
        reason: "guard-a:changed-blob",
        detail: `guard-a: diff-vs-base substance changed for ${label} (${substanceChange}); head ${headSha.slice(0, 7)} was never reviewed; refusing to re-publish${voidNote}`,
        voidWarning:
          voidWarning.kind === "posted" || voidWarning.kind === "already-posted"
            ? voidWarning.kind
            : undefined,
      };
    }
  }

  const publishOptions: { expectedHeadSha: string; enforceDeliveryIdentity?: boolean } = {
    expectedHeadSha: headSha,
  };
  // SUP-14715 D-B: when the anchor came from approvedHeadSha, the ADR-091 D1
  // delivery-identity gate never successfully ran for this head — the arming
  // attempt that certified it skipped/failed before the stamp was written. So
  // this delegated write is a FIRST publish and enforces the delivery-identity
  // gate, taking the same integrity gate as any other first publish. A
  // re-publish (anchor from publishedHeadSha) and a SUP-14602 pending-candidate
  // recovery (approvedHead === null) certify by content identity and leave the
  // gate unset.
  if (enforceDeliveryIdentity) {
    publishOptions.enforceDeliveryIdentity = true;
  }
  const outcome = await publishApprovalStatus(db, row.companyId, row.id, row.identifier ?? "", publishOptions);
  if (outcome.kind === "armed") {
    if (approvedHead === null) {
      // SUP-14602: the recovery path certified this head through the same
      // unmodified Guard A comparison, so the normal publishedHeadSha path
      // takes over from here. pendingCandidates stays as the historical
      // record; the idempotency pre-check keeps re-runs at zero writes.
      const currentState = row.executionState ?? {};
      const existingApprovalStatus =
        (currentState.approvalStatus as Record<string, unknown> | null | undefined) ?? {};
      await db
        .update(issues)
        .set({
          executionState: {
            ...currentState,
            approvalStatus: {
              ...existingApprovalStatus,
              publishedHeadSha: headSha,
              publishedAt: new Date().toISOString(),
            },
          },
        })
        .where(eq(issues.id, row.id));
    }
    return { kind: "republished", detail: `republished ${target.displayName}: ${outcome.message}`, backfilledDetail };
  }
  if (outcome.kind === "skipped") {
    const reason = outcome.message.startsWith("status:skipped:head_moved")
      ? "guard-a:head-moved-during-write"
      : "publish:skipped";
    return { kind: "skipped", reason, detail: `publish skipped: ${outcome.message}`, backfilledDetail };
  }
  const truncated = outcome.message.length > 200 ? `${outcome.message.slice(0, 200)}...` : outcome.message;
  return { kind: "failed", detail: `publish failed: ${truncated}`, backfilledDetail };
}

export async function runApprovalStatusReconcilerTick(
  db: Db,
  options: ApprovalStatusReconcilerTickOptions = {},
): Promise<ApprovalStatusReconcilerTickSummary> {
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const rows = await findApprovalCandidates(db, maxCandidates + 1);
  const capped = Math.max(0, rows.length - maxCandidates);
  const batch = capped > 0 ? rows.slice(0, maxCandidates) : rows;

  const summary: ApprovalStatusReconcilerTickSummary = {
    scanned: 0,
    republished: 0,
    skipped: {},
    skippedDetails: [],
    failed: 0,
    failedDetails: [],
    capped,
    voidWarnings: 0,
    voidWarningDetails: [],
    backfilled: 0,
    backfilledDetails: [],
  };

  for (const row of batch) {
    summary.scanned += 1;
    const label = row.identifier ?? row.id;
    try {
      const result = await reconcileCandidate(db, row);
      if (result.kind === "republished") {
        summary.republished += 1;
      } else if (result.kind === "skipped") {
        summary.skipped[result.reason] = (summary.skipped[result.reason] ?? 0) + 1;
        if (summary.skippedDetails.length < MAX_DETAIL_ENTRIES) {
          summary.skippedDetails.push(`${label}: ${result.detail}`);
        }
        if (result.voidWarning) {
          summary.voidWarnings += 1;
          if (summary.voidWarningDetails.length < MAX_DETAIL_ENTRIES) {
            summary.voidWarningDetails.push(`${label}: ${result.voidWarning}`);
          }
        }
      } else {
        summary.failed += 1;
        if (summary.failedDetails.length < MAX_DETAIL_ENTRIES) {
          summary.failedDetails.push(`${label}: ${result.detail}`);
        }
      }
      if (result.backfilledDetail !== undefined) {
        summary.backfilled += 1;
        if (summary.backfilledDetails.length < MAX_DETAIL_ENTRIES) {
          summary.backfilledDetails.push(`${label}: ${result.backfilledDetail}`);
        }
      }
    } catch (err) {
      summary.failed += 1;
      if (summary.failedDetails.length < MAX_DETAIL_ENTRIES) {
        summary.failedDetails.push(
          `${label}: tick_error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  logger.info(
    {
      scanned: summary.scanned,
      republished: summary.republished,
      skipped: summary.skipped,
      skippedDetails: summary.skippedDetails,
      failed: summary.failed,
      failedDetails: summary.failedDetails,
      capped: summary.capped,
      voidWarnings: summary.voidWarnings,
      voidWarningDetails: summary.voidWarningDetails,
      backfilled: summary.backfilled,
      backfilledDetails: summary.backfilledDetails,
    },
    "approval status reconciler tick",
  );
  return summary;
}

export interface ApprovalStatusReconcilerSchedule {
  intervalMs: number;
  maxCandidates?: number;
  /**
   * Delay before the first tick. Not zero, so a restart does not add GitHub
   * fan-out to the boot path; not the whole interval, because a server that
   * restarts more often than the interval would otherwise never reconcile.
   */
  initialDelayMs?: number;
  /** Seam for tests. */
  runTick?: (
    options: ApprovalStatusReconcilerTickOptions,
  ) => Promise<ApprovalStatusReconcilerTickSummary>;
}

/**
 * Start the periodic reconcile. Returns a stop function.
 *
 * Overlapping ticks are refused here: a slow tick (rate-limited GitHub fan-out)
 * must not queue behind itself.
 */
export function startApprovalStatusReconciler(
  db: Db,
  schedule: ApprovalStatusReconcilerSchedule,
): () => void {
  const runTick = schedule.runTick ?? ((tickOptions) => runApprovalStatusReconcilerTick(db, tickOptions));
  const tickOptions: ApprovalStatusReconcilerTickOptions = { maxCandidates: schedule.maxCandidates };
  let inFlight = false;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    if (inFlight) {
      logger.info("approval status reconciler still running; skipping this tick");
      return;
    }
    inFlight = true;
    void Promise.resolve(runTick(tickOptions))
      .catch((err) => {
        logger.warn({ err }, "approval status reconciler tick threw");
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const initialTimer = setTimeout(tick, schedule.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
  initialTimer.unref?.();
  const timer = setInterval(tick, schedule.intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearTimeout(initialTimer);
    clearInterval(timer);
  };
}
