import type { Db } from "@paperclipai/db";
import {
  externalObjectMentions,
  externalObjects,
  issueExecutionDecisions,
  issues,
} from "@paperclipai/db";
import { and, desc, eq, ne, sql, type SQL } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  resolveGitHubTokenCandidatesForRepo,
  type GitHubTokenResolution,
} from "./github-credential.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import {
  postPullRequestComment,
  publishApprovalStatus,
  resolveCardPullRequest,
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
// voids that approval"). The warning (SUP-14996):
//   - is advisory only — it is a plain PR comment and never creates, mocks,
//     or writes the paperclip/approved status (the consume-contract);
//   - names both SHAs, the owning card identifier, and the approval
//     timestamp (when the card persisted one) — enough to act without
//     re-deriving anything from GitHub;
//   - states both remedies: re-approve at the live head (a fresh review), or
//     move the late commit to its own PR and reset the branch back to the
//     already-stamped SHA (a reset needs no new review);
//   - fires only on positive evidence (changed-blob). Guard A's
//     can-not-verify refusals (compare failure, truncated/missing file
//     list, no base sha) self-heal or retry on the next tick and must not
//     manufacture a false "voided" claim;
//   - stays quiet on the Guard-A-recoverable case (rebase / update-branch,
//     diff-vs-base unchanged): the reconciler re-publishes there, so a
//     warning would be noise ignored within a week;
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
  /**
   * SUP-14736. Resume the scan after this candidate identifier (keyset
   * cursor), so consecutive ticks advance past the window instead of
   * re-scanning the same lexicographic head forever. Omit / null to start
   * from the beginning of the candidate set.
   */
  resumeAfter?: string | null;
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
   * SUP-14736. The candidate identifier to pass back as `resumeAfter` on the
   * next tick so the scan advances. Null when this tick reached the end of
   * the candidate set — the next tick wraps around to the beginning.
   */
  nextScanKey: string | null;
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
  /**
   * SUP-15212: the issue's status, projected only by the audit selector
   * (findStageIntegrityAuditCandidates). Absent on the reconciler's
   * re-publish candidates and the decision-time arming candidate, both of
   * which operate on closed/approved cards — there the terminal-only guards
   * keep their existing behavior. Only the audit route distinguishes a live
   * ladder (`in_review` / `blocked`) from a terminal close.
   */
  status?: string;
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

/**
 * SUP-15017: a certified `no-pr` branch anchor persisted by the producer child
 * (SUP-15016) on `executionState.approvalStatus.pendingCandidates` when an
 * approval resolved to `no-pr` (no open linked PR). The producer reuses the
 * `pendingCandidates` array but records a BRANCH (not a PR), so the entry has
 * `source: "no-pr-branch"`, a `branch`, and `headSha` (the branch head sha
 * read at approval time) instead of a PR `number` + `headShaAtApproval`. It
 * therefore does NOT satisfy `readPendingCandidates` (which requires an integer
 * `number`) and is read here, independently, by its `source` marker.
 *
 * `headSha` is null when the branch ref could not be read at approval time;
 * the consumer fails closed on null and never attempts the content-identity
 * proof without a certified anchor sha.
 */
interface NoPrBranchAnchor {
  owner: string;
  repo: string;
  branch: string | null;
  headSha: string | null;
}

/**
 * SUP-15017: duck-type the `no-pr` branch anchor out of the card's
 * `executionState.approvalStatus.pendingCandidates` without depending on the
 * producer child's type changes (the two land in separate branches and the
 * `source` / `headSha` / `branch` fields are not yet on the shared
 * `ApprovalCandidateAnchor` type). An entry that is not a well-formed
 * `no-pr-branch` record (missing owner/repo) is ignored; only one such anchor
 * is ever written per card, so the first valid one wins. Returns null when no
 * well-formed no-pr anchor is present.
 */
function findNoPrBranchAnchor(state: Record<string, unknown> | null | undefined): NoPrBranchAnchor | null {
  const approvalStatus = state?.approvalStatus as Record<string, unknown> | null | undefined;
  if (!approvalStatus || typeof approvalStatus !== "object") return null;
  const raw = approvalStatus.pendingCandidates;
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.source !== "no-pr-branch") continue;
    if (typeof record.owner !== "string" || record.owner.length === 0) continue;
    if (typeof record.repo !== "string" || record.repo.length === 0) continue;
    return {
      owner: record.owner,
      repo: record.repo,
      branch: typeof record.branch === "string" ? record.branch : null,
      headSha:
        typeof record.headSha === "string" && record.headSha.length > 0 ? record.headSha : null,
    };
  }
  return null;
}

/** Stable, case-insensitive identity key for a candidate PR (used to compare candidate sets). */
function candidateKey(pr: { owner: string; repo: string; number: number }): string {
  return `${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}#${pr.number}`;
}

/** Human-readable owner/repo#number label for a candidate PR, used in skip/fail reason strings. */
function candidateDisplayName(pr: { owner: string; repo: string; number: number }): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

/**
 * SUP-14911: a lastErrorCode that indicates the external object is
 * terminally unresolvable — the provider answered that the credentials
 * cannot access this repo (401 = no installation, 403 = forbidden). These
 * errors will not clear on retry; they mean the repo does not exist or has
 * no App installation. Transient errors (rate_limit, unreachable, network)
 * are NOT terminal: the next refresh may succeed.
 */
function isTerminalResolutionError(code: string | null): boolean {
  if (code === null) return false;
  return code === "github_auth_required" || code === "github_forbidden";
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
 * SUP-14049 / SUP-14996: the body of the void warning, landed on the PR itself
 * so the stranded stamp is visible where the PR reads green — not only in
 * control-plane logs. Advisory only: it names both SHAs, the owning card, the
 * approval timestamp (when persisted), the substance change, and the two
 * remedies (a fresh approval at the live head, or splitting the late commit
 * out and resetting to the already-stamped SHA). It never re-stamps — a human
 * or the review stage decides next steps.
 */
function voidWarningBody(
  identifier: string,
  approvedHeadSha: string,
  headSha: string,
  substanceChange: string,
  approvedAtLabel: string | null | undefined,
): string {
  const approvedAt = approvedAtLabel ? `, ${approvedAtLabel}` : "";
  return (
    `[Paperclip approval voided] This PR was approved at ${approvedHeadSha} (${identifier}${approvedAt}); ` +
    `head ${headSha} voids that approval.\n\n` +
    `The paperclip/approved stamp is stranded on ${approvedHeadSha} and no longer covers this head: ` +
    `the PR's diff-vs-base changed in substance after approval (${substanceChange}), so the merge ` +
    `queue will reject this PR. Guard A refuses to re-stamp content that was never reviewed and the ` +
    `reconciler does not auto re-approve.\n\n` +
    `To make the merge queue accept this PR again, either:\n` +
    `- re-approve at the live head ${headSha} — a fresh review of the current content; or\n` +
    `- move the late commit to its own PR and reset this branch back to ${approvedHeadSha} — that ` +
    `head already carries paperclip/approved=success, so a reset needs no new review.\n\n` +
    voidWarningMarker(approvedHeadSha, headSha)
  );
}

/**
 * SUP-14049 / SUP-14996: surface the void on the PR. Dedupes by re-reading the
 * newest page of the PR conversation for this exact approved->head marker
 * before posting, so a head that stays voided across ticks posts at most one
 * comment (the marker we posted is the most recent comment, hence
 * direction=desc). A failed read fails the post (a write we cannot dedup
 * must not be attempted); a failed post is reported, never fatal — the
 * Guard A refusal is the primary verdict and the warning is advisory.
 * `approvedAtLabel` is the persisted stamp/certification timestamp when the
 * card carries one (SUP-14996); null/undefined when the anchor was recovered
 * without a persisted time — the comment then simply omits it.
 */
async function postApprovalVoidWarning(
  db: Db,
  row: CandidateRow,
  target: LinkedPullRequest,
  approvedHeadSha: string,
  headSha: string,
  substanceChange: string,
  approvedAtLabel: string | null | undefined,
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
      voidWarningBody(row.identifier ?? row.id, approvedHeadSha, headSha, substanceChange, approvedAtLabel),
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
 * cancelled, and that carry a linked GitHub PR the reconciler can still act
 * on. The trigger is the control-plane record alone — nothing is inferred from
 * commits or GitHub.
 *
 * SUP-14736: two fixes to `findApprovalCandidates`, which had been permanently
 * wedged on the lexicographic first N candidates:
 *
 *   - The linked-PR EXISTS now requires at least one linked, non-draft PR whose
 *     cached state is `open` or still unhydrated (null). Cards whose linked PRs
 *     are all closed/merged were selected on every tick only to be disposed of
 *     as `no-open-pr` after a pointless GitHub fan-out; nothing about a closed
 *     PR ever changes, so they never left the set and consumed the whole window.
 *     This mirrors the in-memory `resolveLinkedPullRequestsWithState` filter
 *     (draft PRs are dropped there too) so the SQL set and the in-memory set
 *     agree on which cards can act.
 *   - A keyset cursor (`afterIdentifier`) pages the scan forward. `issues.identifier`
 *     is globally unique, so `identifier > afterIdentifier ORDER BY identifier`
 *     advances a bounded window across ticks instead of re-reading the same dead
 *     head. When a tick reaches the end of the set the caller passes null to wrap
 *     around, giving a round-robin over the live candidate set.
 */
async function findApprovalCandidates(
  db: Db,
  limit: number,
  afterIdentifier: string | null = null,
): Promise<CandidateRow[]> {
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
        // SUP-14736: the card is scannable when it has a linked, non-draft PR
        // whose cached state is `open` or still unhydrated (null) — mirroring
        // the in-memory `resolveLinkedPullRequestsWithState` filter.
        // SUP-14917: OR it carries an approval anchor (the decision certified a
        // head / a publish was written / ambiguous candidates were persisted)
        // AND a workspace context to discover a PR from — the shape whose PR was
        // delivered from a workspace with zero external-object mentions ever
        // posted. Widening DISCOVERY only: the Guard A / Guard B gates below are
        // untouched, so a wider scan cannot authorize a stamp it would refuse.
        // SUP-14926: the OR arm has no mention row to carry PR state, so a
        // zero-mention card whose discovery already returned `none` would match
        // forever. Exclude it once a terminal `none` verdict is persisted, and
        // re-admit it when the card is updated again (a new PR arrived).
        // SUP-14959: the OR arm must not disagree with the mention arm's cached
        // state. A card whose linked PRs are ALL closed/merged has a mention row
        // (so it is not the zero-mention shape) yet matches the anchor + workspace
        // clauses above and would be re-admitted on every tick only to be disposed
        // as `no-open-pr` — the mention arm already declined to scan it. The OR
        // arm therefore admits a card only when it has NO linked pull_request
        // mention at all (the genuine SUP-14917 zero-mention shape, disposal still
        // handled by SUP-14926's marker); a card with at least one open/unhydrated
        // mention is admitted by the mention arm's EXISTS above, so this NOT-EXISTS
        // is the complete disposal path. It mirrors the mention arm's
        // `object_type = 'pull_request'` filter.
        sql`(
          (exists (
            select 1
            from ${externalObjectMentions}
            inner join ${externalObjects} on ${externalObjects.id} = ${externalObjectMentions.objectId}
            where ${externalObjectMentions.companyId} = ${issues.companyId}
              and ${externalObjectMentions.sourceIssueId} = ${issues.id}
              and ${externalObjectMentions.objectType} = 'pull_request'
              and ${externalObjects.providerKey} = 'github'
              and (${externalObjects.data} ->> 'state' = 'open'
                or ${externalObjects.data} ->> 'state' is null)
              and ${externalObjects.data} ->> 'draft' is distinct from 'true'
          ))
          or (
            (
              ${issues.executionState} -> 'approvalStatus' ->> 'approvedHeadSha' is not null
              or ${issues.executionState} -> 'approvalStatus' ->> 'publishedHeadSha' is not null
              or jsonb_array_length(
                coalesce(${issues.executionState} -> 'approvalStatus' -> 'pendingCandidates', '[]'::jsonb)
              ) > 0
            )
            and (
              ${issues.executionWorkspaceId} is not null
              or ${issues.projectWorkspaceId} is not null
              or ${issues.projectId} is not null
            )
            and (
              ${issues.executionState} -> 'approvalStatus' -> 'workspaceDiscovery' ->> 'verdict' is distinct from 'none'
              or ${issues.updatedAt} > (${issues.executionState} -> 'approvalStatus' -> 'workspaceDiscovery' ->> 'at')::timestamptz
            )
            and not exists (
              select 1
              from ${externalObjectMentions}
              where ${externalObjectMentions.companyId} = ${issues.companyId}
                and ${externalObjectMentions.sourceIssueId} = ${issues.id}
                and ${externalObjectMentions.objectType} = 'pull_request'
            )
          )
        )`,
        afterIdentifier != null ? sql`${issues.identifier} > ${afterIdentifier}` : undefined,
      ),
    )
    .orderBy(issues.identifier)
    .limit(limit);
}

/**
 * SUP-14923 / ADR-073 D3. Candidate selector for the on-demand
 * stage-integrity audit route. Unlike {@link findApprovalCandidates} it is
 * gated on **status** rather than on the recorded approval + a linked open PR:
 *
 *   - no `lastDecisionOutcome = 'approved'` gate — a no-deliverable-head close
 *     typically carries a null `executionState`, so that condition excludes it;
 *   - no linked-`pull_request` EXISTS — the override fires precisely because
 *     there is no PR, so that condition independently excludes it.
 *
 * Both complementary, non-overlapping controls of {@link findApprovalCandidates}
 * therefore leave the class this audit must see entirely unexamined. This
 * selector takes every terminal (`done`) issue in the company that carries a
 * non-empty `executionPolicy.stages`, PLUS — since SUP-15212 — every live
 * ladder (`in_review` / `blocked`) that also carries a non-empty
 * `executionPolicy.stages` and at least one execution decision. `done` cards
 * are admitted unconditionally (the original behavior); live cards are admitted
 * only when they have a decision, so a card that never decided anything is not
 * audited. It returns the same row shape {@link evaluateStageIntegrity} consumes
 * (plus `completedAt`, which the caller uses to exclude pre-decision-table
 * closes as indeterminate — a live card's null `completedAt` never trips that
 * boundary). It never re-implements the check: the caller feeds each row to
 * {@link evaluateStageIntegrity} verbatim.
 */
export type StageIntegrityAuditCandidate = CandidateRow & {
  completedAt: Date | null;
};

export async function findStageIntegrityAuditCandidates(
  db: Db,
  companyId: string,
  limit?: number,
): Promise<StageIntegrityAuditCandidate[]> {
  const query = db
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
      completedAt: issues.completedAt,
      // SUP-15212: projected so evaluateStageIntegrity can tell a live ladder
      // (in_review / blocked) from a terminal close and suppress the
      // close-presupposing guards on live cards (see isLiveLadder there).
      status: issues.status,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        // SUP-15212: admit terminal (`done`) closes AND the live ladders that jam
        // before closing (`in_review` / `blocked`). The jam-in-progress case is
        // the one still cheap to repair, so it must be visible — the old
        // `done`-only selector could only find integrity defects after the card
        // had already closed (the damage unrecoverable). `cancelled` and the
        // other non-ladder states stay out. This widening is additive: it cannot
        // suppress a finding the `done`-only selector reported.
        sql`${issues.status} in ('done', 'in_review', 'blocked')`,
        sql`${issues.identifier} is not null`,
        sql`jsonb_typeof(${issues.executionPolicy} -> 'stages') = 'array'
             and jsonb_array_length(${issues.executionPolicy} -> 'stages') > 0`,
        // `done` keeps its prior behavior (admitted unconditionally); a live
        // card is admitted only when it carries at least one execution decision
        // — a card that never decided anything has no ladder integrity to audit.
        sql`(
          ${issues.status} = 'done'
          or exists (
            select 1
            from ${issueExecutionDecisions}
            where ${issueExecutionDecisions.companyId} = ${issues.companyId}
              and ${issueExecutionDecisions.issueId} = ${issues.id}
          )
        )`,
      ),
    )
    .orderBy(issues.identifier);

  // SUP-15212 (F3): the default call is unbounded, so the widened selector is a
  // strict superset of the old done-only one and cannot suppress a finding it
  // reported before. A bounded call (?limit=N) is different: it truncates after
  // the lexical identifier ordering, so newly admitted live cards compete for
  // the same N slots and can crowd out done rows that would have fit in an
  // unbounded scan. The audit route defaults to no limit, so the invariant the
  // caller relies on holds; note it here rather than re-order done-first, which
  // would change the identifier ordering existing consumers see.
  if (limit !== undefined && limit > 0) {
    return query.limit(limit);
  }
  return query;
}

/**
 * ADR-073 / ADR-092 stage-integrity audit of the recorded approval. Returns a
 * skip verdict when the "approved" record is not backed by a real, non-self
 * decision: an auto-skipped review stage writes no decision row and lands in
 * skippedStageIds, so it must never be treated as an approval. The gated
 * principal is the resolved return assignee (ADR-092 D3):
 * policy.returnAssigneeAgentId ?? state.returnAssignee ?? state.deliveryAuthor ??
 * createdByAgentId ?? (unresolvable — refused under guard-b:return-assignee-unresolved).
 */
export async function evaluateStageIntegrity(
  db: Db,
  row: CandidateRow,
): Promise<{ reason: string; detail: string } | null> {
  const state: Record<string, unknown> = row.executionState ?? {};
  const policy: Record<string, unknown> = row.executionPolicy ?? {};

  // SUP-15212: the widened audit selector now admits live ladders
  // (in_review / blocked), not just terminal closes. Two guards in this
  // cascade presuppose a close, so they must NOT fire on a live card or they
  // (a) report a false positive and (b) — because the cascade returns on the
  // first match — shadow the inverse (orphaned-decision) guard that is the
  // reason the selector was widened to reach these rows:
  //   - `no-completed-stage`: on a done card it means "closed without ever
  //     completing a stage" (a defect); on a live ladder it just means the
  //     ladder has not completed a stage yet (the normal pre-completion state).
  //   - `return-assignee-unresolved`: on a live card the gated principal is not
  //     expected to be set up yet, so an unresolvable one is not a defect.
  // row.status is projected only by the audit selector; the reconciler and
  // decision-time candidates leave it unset, so their behavior is unchanged.
  const isLiveLadder = row.status === "in_review" || row.status === "blocked";

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
  // SUP-15212: `no-completed-stage` presupposes a close. On a live ladder an
  // empty completedStageIds is the normal pre-completion state, not a defect —
  // so suppress it there and fall through to the inverse guard, which is the
  // check this card exists to add. A done card keeps its existing finding.
  if (completedStageIds.length === 0 && !isLiveLadder) {
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
      id: issueExecutionDecisions.id,
      stageId: issueExecutionDecisions.stageId,
      outcome: issueExecutionDecisions.outcome,
      actorAgentId: issueExecutionDecisions.actorAgentId,
      actorUserId: issueExecutionDecisions.actorUserId,
      createdAt: issueExecutionDecisions.createdAt,
    })
    .from(issueExecutionDecisions)
    .where(
      and(
        eq(issueExecutionDecisions.issueId, row.id),
        eq(issueExecutionDecisions.companyId, row.companyId),
      ),
    );

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
      const deliveryAuthor = state.deliveryAuthor as
        | { type?: unknown; agentId?: unknown; userId?: unknown }
        | null
        | undefined;
      if (deliveryAuthor && typeof deliveryAuthor === "object") {
        if (deliveryAuthor.type === "agent" && typeof deliveryAuthor.agentId === "string") {
          forbiddenAgents.add(deliveryAuthor.agentId);
        } else if (deliveryAuthor.type === "user" && typeof deliveryAuthor.userId === "string") {
          forbiddenUsers.add(deliveryAuthor.userId);
        }
      }
    }
    if (forbiddenAgents.size === 0 && forbiddenUsers.size === 0) {
      if (row.createdByAgentId) forbiddenAgents.add(row.createdByAgentId);
    }
    if (forbiddenAgents.size === 0 && forbiddenUsers.size === 0) {
      // SUP-15212: a live ladder is not expected to have its gated principal
      // resolved yet, so an unresolvable one is not a finding there. On a done
      // card it still refuses (the terminal card's approval cannot be
      // attributed to a non-gated actor). Suppressed on live cards this also
      // stops it from shadowing the inverse guard (the cascade returns on the
      // first match).
      if (!isLiveLadder) {
        return {
          reason: "guard-b:return-assignee-unresolved",
          detail: "no return assignee, delivery author, or creator agent recorded",
        };
      }
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

  // SUP-15212: the INVERSE of the forward `stage-without-decision` check above.
  // Walk the decision rows and ask the opposite question: is there a durable
  // `approved` verdict whose stage is declared in executionPolicy.stages yet
  // landed in NEITHER completedStageIds NOR skippedStageIds? That is an
  // orphaned decision the completion projection dropped — an approval the card's
  // recorded completion does not reflect (the SUP-15120 shape). It is a
  // ladder-integrity finding even on a card that is still live (in_review /
  // blocked), which the widened audit selector now admits. A lawfully
  // auto-skipped stage sits in skippedStageIds and is a legitimate exclusion, so
  // it is never reported here.
  //
  // This check runs LAST in the cascade so it is strictly additive: any card
  // already reported by an earlier guard (skipped-stage, no-completed-stage,
  // stage-not-in-policy, stage-without-decision, decision-by-return-assignee,
  // return-assignee-unresolved) keeps that reason unchanged, and the new
  // `guard-b:decision-without-completed-stage` only surfaces for cards that pass
  // every prior guard yet still hold an orphaned decision. That preserves the
  // existing reason counts (no regression in existing detection).
  const completedStageIdSet = new Set(completedStageIds);
  const skippedStageIdSet = new Set(skippedStageIds);
  for (const decision of decisions) {
    if (decision.outcome !== "approved") continue;
    if (!policyStageIds.has(decision.stageId)) continue;
    if (completedStageIdSet.has(decision.stageId)) continue;
    if (skippedStageIdSet.has(decision.stageId)) continue;
    return {
      reason: "guard-b:decision-without-completed-stage",
      detail:
        `decision ${decision.id} (stage ${decision.stageId}, approved at ` +
        `${decision.createdAt.toISOString()}) is a durable approval, but stage ${decision.stageId} ` +
        `is in executionPolicy.stages yet in neither completedStageIds nor skippedStageIds`,
    };
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
  | { kind: "ok"; headAtApproval: string | null; sawCommittedHeadEvent: boolean; sawPostApprovalForcePush: boolean }
  | { kind: "truncated"; headAtApproval: string | null; sawCommittedHeadEvent: boolean; sawPostApprovalForcePush: boolean }
  | { kind: "failed"; detail: string }
  | { kind: "unparseable"; detail: string };

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
  let sawPostApprovalForcePush = false;
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
        // A structurally malformed head-mutating event is DETERMINISTIC, not a
        // transient read failure. Report it as its own outcome so the caller can
        // apply a different caching policy than the HTTP/network `failed` case
        // (backfill-unparseable-event-misclassified-transient).
        return {
          kind: "unparseable",
          detail: "unparseable head-mutating event; refusing to anchor",
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
        sawPostApprovalForcePush = true;
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
    ? { kind: "ok", headAtApproval, sawCommittedHeadEvent, sawPostApprovalForcePush }
    : { kind: "truncated", headAtApproval, sawCommittedHeadEvent, sawPostApprovalForcePush };
}

type ShaServerTimestampResult =
  | { ok: true; minTimestampMs: number }
  | { ok: false; transient: boolean; detail: string };

/**
 * SUP-14844 (round 1): read `/commits/{sha}/check-runs` and return the minimum
 * server-assigned `created_at` across the check runs GitHub triggered on this
 * PR's own head branch (`check_suite.head_branch === headRefName`). That is the
 * server-attested evidence that the sha existed on this branch at/before that
 * time.
 *
 * Two guards keep the proof honest (round-1 review findings):
 *   - `check_run.started_at` is CLIENT-supplied and is deliberately ignored;
 *     only the server-assigned `check_run.created_at` counts.
 *   - A check run only counts as THIS PR's evidence when its check suite's head
 *     branch equals the card's PR head ref. A commit reachable from another
 *     branch otherwise lends its older, unrelated cross-branch check-run
 *     timestamps to this sha and would wrongly anchor it (the laundering trace:
 *     head A approved, branch fast-forwarded to a pre-existing sha B whose CI
 *     ran on a different branch before the approval).
 *
 * A read failure (HTTP / network error) or an unreadable head ref is TRANSIENT
 * (`transient: true`): reported as a skip, not persisted, so the next tick
 * retries. The ABSENCE of any branch-bound server-timed evidence is a
 * DETERMINISTIC refusal (`transient: false`) — the check runs for a given sha on
 * a given branch are immutable history, so it is persisted as a stable refusal.
 */
async function readShaServerTimestamp(
  db: Db,
  companyId: string,
  owner: string,
  repo: string,
  sha: string,
  headRefName: string | null,
): Promise<ShaServerTimestampResult> {
  // Without the PR's head ref we cannot prove a check run belongs to this
  // branch, so the binding cannot be established. Treat as transient: the
  // cached head ref may populate on the next external-object refresh.
  if (headRefName === null || headRefName === "") {
    return {
      ok: false,
      transient: true,
      detail: "sha-branch-binding: PR head ref is unavailable; cannot establish branch-bound check-run evidence",
    };
  }

  const checkRunsRead = await ghReadJson(
    db,
    companyId,
    owner,
    repo,
    `/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
  );
  if (!checkRunsRead.ok) {
    return {
      ok: false,
      transient: true,
      detail: `check-runs-read-failed: HTTP ${checkRunsRead.status} ${checkRunsRead.message ?? ""}`.trim(),
    };
  }

  let minTimestampMs: number | null = null;
  let sawBranchBoundRun = false;

  const checkRunsBody = checkRunsRead.body as Record<string, unknown> | null;
  const checkRuns = Array.isArray(checkRunsBody?.check_runs)
    ? (checkRunsBody!.check_runs as Array<Record<string, unknown>>)
    : [];
  for (const run of checkRuns) {
    const suite = run.check_suite as Record<string, unknown> | null | undefined;
    const runHeadBranch = suite && typeof suite.head_branch === "string" ? suite.head_branch : null;
    if (runHeadBranch !== headRefName) continue;
    sawBranchBoundRun = true;
    // Only the server-assigned created_at counts; started_at is client-supplied.
    const createdAt = typeof run.created_at === "string" ? run.created_at : null;
    if (!createdAt) continue;
    const ms = Date.parse(createdAt);
    if (!Number.isNaN(ms) && (minTimestampMs === null || ms < minTimestampMs)) {
      minTimestampMs = ms;
    }
  }

  if (!sawBranchBoundRun) {
    // No check run triggered on this PR's head branch for this sha: we cannot
    // show the sha existed on this branch, so the binding cannot be shown. This
    // is deterministic (immutable check-run history), not a read failure.
    return {
      ok: false,
      transient: false,
      detail: `sha-branch-binding: no check run on the PR head branch (${headRefName}) found for head sha ${sha.slice(0, 7)}`,
    };
  }

  if (minTimestampMs === null) {
    // Branch-bound runs exist but carry no parseable server created_at: treat as
    // a read/parse blip to retry rather than strand the card (fail toward retry).
    return {
      ok: false,
      transient: true,
      detail: "sha-server-timestamp: no parseable server created_at on the branch-bound check runs",
    };
  }

  return { ok: true, minTimestampMs };
}

/**
 * SUP-15017: GitHub's `GET /repos/{owner}/{repo}/commits/{sha}` caps the
 * returned `files` array at 300 entries. A commit that changed that many files
 * cannot have its full changed-file set positively verified through this
 * endpoint, so the content-identity proof refuses rather than risk comparing
 * two identically-truncated prefixes (a false-positive match on content that
 * was never reviewed).
 */
const MAX_COMMIT_CHANGED_FILES = 300;

type CommitFilesRead =
  | { ok: true; files: Map<string, string>; fileCount: number; parentCount: number }
  | { ok: false; status: number; detail: string };

/**
 * SUP-15017: read a commit's changed-file set over its own parent from
 * `GET /commits/{sha}`. The commit detail's `files` array is exactly the change
 * the commit introduces over its parent: each entry's `sha` is the RESULTING
 * blob sha, `status` is added/removed/modified/renamed/copied, and `filename`
 * is unique within a commit. The result is a `Map<filename, status + "\0" +
 * blobSha>` so two sets are equal iff they introduce the same byte-identical
 * changes. The parent count is returned so the caller can fail closed on a
 * merge commit (>1 parent) or a root commit (0 parents).
 *
 * A non-2xx read returns `{ ok: false, status }` with the HTTP status so the
 * caller can classify 404 (a lost anchor) as deterministic and every other
 * failure as transient. A 200 whose body is not an object, has no `files`
 * array, or carries a file with no filename is treated as an unreadable payload
 * (status 200, transient) — the same bytes may be readable on the next tick.
 */
async function readCommitChangedFiles(
  db: Db,
  companyId: string,
  owner: string,
  repo: string,
  sha: string,
): Promise<CommitFilesRead> {
  const read = await ghReadJson(db, companyId, owner, repo, `/commits/${encodeURIComponent(sha)}`);
  if (!read.ok) {
    return {
      ok: false,
      status: read.status,
      detail: `commit-read-failed: HTTP ${read.status} ${read.message ?? ""}`.trim(),
    };
  }
  const body = read.body as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return { ok: false, status: 200, detail: "commit payload is not an object" };
  }
  const parents = Array.isArray(body.parents)
    ? (body.parents as Array<Record<string, unknown>>)
    : [];
  if (!Array.isArray(body.files)) {
    return { ok: false, status: 200, detail: "commit payload carries no files array" };
  }
  const files = new Map<string, string>();
  for (const entry of body.files as Array<Record<string, unknown>>) {
    const filename = typeof entry?.filename === "string" ? entry.filename : null;
    if (!filename) {
      return { ok: false, status: 200, detail: "commit file entry carries no filename" };
    }
    const status = typeof entry.status === "string" ? entry.status : "";
    const blobSha = typeof entry.sha === "string" ? entry.sha : "";
    files.set(filename, `${status}\0${blobSha}`);
  }
  return { ok: true, files, fileCount: files.size, parentCount: parents.length };
}

type NoPrContentIdentityOutcome =
  | { kind: "match"; fileCount: number }
  | { kind: "refused"; detail: string }
  | { kind: "transient"; detail: string };

/**
 * SUP-15017: the second admissible backfill proof. Where the temporal proof
 * asks "did this live head exist on this branch at/before the approval?" (which
 * a PR opened after the approval can never answer), the content-identity proof
 * asks "is the reviewed content byte-identical to the certified anchor's?" If
 * the live head introduces the same set of byte-identical changed files as the
 * certified `no-pr` anchor commit, the bytes that would merge are the bytes that
 * were approved, and stamping is sound.
 *
 * Fail closed, refusing with `backfill:head-unverifiable` (the caller's
 * `refused` case) whenever: the anchor sha is no longer reachable (404 — it can
 * be gc'd; this proof is best-effort by nature); either commit has more than
 * one parent (a merge) or zero (a root), so "over its own parent" is not
 * decidable; a commit changed so many files the set is not positively
 * verifiable (truncation); or the two changed-file sets differ in any way.
 * Only an actual API read failure that is NOT an anchor 404 is transient
 * (not persisted, retried next tick), mirroring `backfill:timeline-read-failed`.
 */
async function verifyNoPrContentIdentity(
  db: Db,
  companyId: string,
  owner: string,
  repo: string,
  anchorSha: string,
  liveHeadSha: string,
): Promise<NoPrContentIdentityOutcome> {
  const anchorRead = await readCommitChangedFiles(db, companyId, owner, repo, anchorSha);
  if (!anchorRead.ok) {
    // The anchor is the certified head. If GitHub no longer resolves it (404 —
    // it can be gc'd), the proof is lost: a DETERMINISTIC refusal. Any other
    // read failure (5xx / network / final auth) is TRANSIENT.
    if (anchorRead.status === 404) {
      return {
        kind: "refused",
        detail: `content-identity: certified no-pr anchor ${anchorSha.slice(0, 7)} is no longer reachable in ${owner}/${repo} (HTTP 404); cannot prove content identity`,
      };
    }
    return {
      kind: "transient",
      detail: `content-identity: ${anchorRead.detail}; will retry on the next tick`,
    };
  }

  const liveRead = await readCommitChangedFiles(db, companyId, owner, repo, liveHeadSha);
  if (!liveRead.ok) {
    // The live head was just read from the live PR payload, so it exists; a 404
    // or other failure here is a blip, not a lost head. Every live-head read
    // failure is TRANSIENT — never strand the card on one blip.
    return {
      kind: "transient",
      detail: `content-identity: live-head ${liveHeadSha.slice(0, 7)} read failed (${liveRead.detail}); will retry on the next tick`,
    };
  }

  if (anchorRead.parentCount !== 1 || liveRead.parentCount !== 1) {
    return {
      kind: "refused",
      detail: `content-identity: anchor has ${anchorRead.parentCount} parent(s) and live head has ${liveRead.parentCount} parent(s); single-parent change-over-parent is not decidable; refusing to anchor an unverifiable head`,
    };
  }

  if (
    anchorRead.fileCount >= MAX_COMMIT_CHANGED_FILES ||
    liveRead.fileCount >= MAX_COMMIT_CHANGED_FILES
  ) {
    return {
      kind: "refused",
      detail: `content-identity: a commit changed ${MAX_COMMIT_CHANGED_FILES}+ files; the full changed-file set is not positively verifiable; refusing to anchor an unverifiable head`,
    };
  }

  if (!changedFileSetsEqual(anchorRead.files, liveRead.files)) {
    return {
      kind: "refused",
      detail: `content-identity: live head ${liveHeadSha.slice(0, 7)} changed-file set differs from certified no-pr anchor ${anchorSha.slice(0, 7)}; refusing to anchor an unverifiable head`,
    };
  }

  return { kind: "match", fileCount: anchorRead.fileCount };
}

function changedFileSetsEqual(
  a: Map<string, string>,
  b: Map<string, string>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [filename, entry] of a) {
    if (b.get(filename) !== entry) return false;
  }
  return true;
}

type BackfillOutcome =
  | { kind: "backfilled"; anchorHeadSha: string; detail: string }
  | { kind: "skipped"; reason: string; detail: string };

/**
 * A stable backfill refusal persisted on the card's executionState.approvalStatus
 * so the next reconciler tick can re-report it without re-reading the PR
 * timeline (the backfill-repeat-fanout review finding). A refusal is a function
 * of the (live head, approval time) pair, so BOTH are stored: `observedHeadSha`
 * is the live head the refusal was derived against and `approvedAtMs` is the
 * approval decision's createdAt it was derived against. Either changing
 * invalidates the cache and forces a fresh timeline read (a moved head, or a
 * re-approval at a later time, can change the head-at-approval-time).
 *
 * Only DETERMINISTIC refusals are persisted. A transient timeline read failure
 * (HTTP / network error, or an unparseable head-mutating event) is reported as a
 * skip but NOT persisted, so the next tick retries the read instead of stranding
 * a recoverable card on one transient error (backfill-refusal-caches-transient-
 * failures).
 */
type BackfillRefusal = {
  reason: string;
  observedHeadSha: string;
  approvedAtMs: number;
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
  // The approval-time key must be a finite number to be trusted; a missing or
  // non-finite value means the cache entry is not a valid keyed refusal, so it
  // is ignored and the timeline is re-read (fail toward a fresh read, never a
  // stale refusal).
  if (typeof obj.approvedAtMs !== "number" || !Number.isFinite(obj.approvedAtMs)) {
    return null;
  }
  return {
    reason: obj.reason,
    observedHeadSha: obj.observedHeadSha,
    approvedAtMs: obj.approvedAtMs,
    observedAt: typeof obj.observedAt === "string" ? obj.observedAt : "",
  };
}

/**
 * SUP-15211. Every reconciler write of `executionState.approvalStatus` goes through this
 * helper so no write ever rebuilds the whole `executionState` column from the batch-load
 * snapshot. The snapshot is stale by the time the write lands — the candidate was loaded
 * by `findApprovalCandidates`, and a concurrent writer (a ladder advance,
 * `currentStageIndex`, `lastDecisionId`, …) may have committed a sibling key since. The
 * old sites rebuilt `{ ...snapshot, approvalStatus: … }` and wrote the whole column, so the
 * sibling advance was silently reverted with no audit event (the SUP-15120 lost update).
 *
 * Instead this merges the patch into the LIVE column on the server: `jsonb_set` on the root,
 * a jsonb `||` on the live `approvalStatus` subtree, and an optional `- 'key'` for removals.
 * No sibling key is ever read into the write. `row.executionState` is hydrated from the
 * statement's RETURNING value (never a locally-built object), and — because these writes
 * previously skipped the audit trail entirely — every call emits an `issue.updated` entry
 * naming the issue and the changed subtree.
 */
export async function mergeApprovalStatus(
  db: Db,
  row: CandidateRow,
  patch: Record<string, unknown>,
  options: { source: string; removeKeys?: string[] },
): Promise<void> {
  const removeKeys = options.removeKeys ?? [];
  let approvalStatusExpr: SQL = sql`(
    coalesce(${issues.executionState} -> 'approvalStatus', '{}'::jsonb)
    || ${JSON.stringify(patch)}::jsonb
  )`;
  for (const key of removeKeys) {
    approvalStatusExpr = sql`${approvalStatusExpr} - ${key}`;
  }
  const executionStateExpr: SQL = sql`(
    jsonb_set(coalesce(${issues.executionState}, '{}'::jsonb), '{approvalStatus}', ${approvalStatusExpr})
  )`;
  const setValues: { executionState: SQL } = { executionState: executionStateExpr };
  const updated = await db
    .update(issues)
    .set(setValues)
    .where(eq(issues.id, row.id))
    .returning({ executionState: issues.executionState });
  row.executionState =
    (updated[0]?.executionState as Record<string, unknown> | null) ?? null;

  await logActivity(db, {
    companyId: row.companyId,
    actorType: "system",
    actorId: "system",
    agentId: null,
    runId: null,
    action: "issue.updated",
    entityType: "issue",
    entityId: row.id,
    issueId: row.id,
    details: {
      identifier: row.identifier,
      source: options.source,
      changedSubtree: "executionState.approvalStatus",
      setKeys: Object.keys(patch),
      ...(removeKeys.length > 0 ? { removedKeys: removeKeys } : {}),
    },
  });
}

export async function persistBackfillRefusal(
  db: Db,
  row: CandidateRow,
  refusal: BackfillRefusal,
): Promise<void> {
  await mergeApprovalStatus(db, row, { backfillRefusal: refusal }, {
    source: "approval-status-reconciler.persist_backfill_refusal",
  });
}

type TemporalBackfillOutcome =
  | { kind: "backfilled"; anchorHeadSha: string; detail: string }
  | { kind: "refused"; reason: string; detail: string; transient: boolean };

/**
 * SUP-15017: the primary backfill proof — does the live head provably exist on
 * this branch at/before the approval, per the PR timeline (+ the server-timed
 * branch-bound sha-existence proof)? This performs every GitHub read and
 * classifies the outcome, but performs NO writes: persistence (the stable
 * refusal, or the stamped anchor) is owned by the caller,
 * `backfillPreDBApprovalAnchor`, so the caller can escalate a deterministic
 * temporal refusal to the content-identity proof before deciding what to
 * persist. `transient` mirrors the old "report a skip but do NOT persist"
 * branches (a failed / unreadable read that the next tick should retry).
 */
async function temporalBackfillOutcome(
  db: Db,
  companyId: string,
  target: LinkedPullRequest,
  currentHeadSha: string,
  approvalTimeMs: number,
  decisionCreatedAt: Date,
): Promise<TemporalBackfillOutcome> {
  const timeline = await readPrTimelineHeadEvents(
    db,
    companyId,
    target.owner,
    target.repo,
    target.number,
    approvalTimeMs,
  );
  if (timeline.kind === "failed") {
    // A failed read is a TRANSIENT condition (HTTP / network error, or an
    // unparseable head-mutating event). Reported as a skip; the caller does not
    // persist it, so the next tick retries (backfill-refusal-caches-transient-failures).
    return {
      kind: "refused",
      reason: "backfill:timeline-read-failed",
      transient: true,
      detail: `backfill: ${timeline.detail}`,
    };
  }
  if (timeline.kind === "unparseable") {
    // A structurally malformed but stable event (e.g. a head_ref_force_pushed
    // with a null commit_id) is a DETERMINISTIC refusal: the same bytes are read
    // on every tick, so the caller persists a named refusal keyed on (live head,
    // approval time) and skips the re-read while neither changes.
    return {
      kind: "refused",
      reason: "backfill:unparseable-force-push",
      transient: false,
      detail: `backfill: ${timeline.detail}`,
    };
  }
  if (timeline.kind === "truncated") {
    return {
      kind: "refused",
      reason: "backfill:timeline-truncated",
      transient: false,
      detail: `backfill: PR timeline for ${target.displayName} is incomplete and cannot be positively read up to the approval time; refusing to anchor an unverifiable head`,
    };
  }

  if (timeline.headAtApproval === null) {
    if (!timeline.sawCommittedHeadEvent) {
      return {
        kind: "refused",
        reason: "backfill:no-head-mutating-event",
        transient: false,
        detail: `backfill: no committed / head_ref_force_pushed event at or before the approval time for ${target.displayName}; refusing to anchor an unverifiable head`,
      };
    }

    if (timeline.sawPostApprovalForcePush) {
      return {
        kind: "refused",
        reason: "backfill:head-unverifiable",
        transient: false,
        detail: `backfill: ${target.displayName} shows a post-approval force-push event; the head-at-approval cannot be verified via sha existence (the push-A/push-B/force-push-back-to-A hole); refusing to anchor an unverifiable head`,
      };
    }

    // SUP-14844: the timeline carries only committed (client-timed) head events
    // at/before the approval — no force-push. Attempt the server-timed,
    // branch-bound sha existence proof: if the live head sha has a check run
    // GitHub triggered on THIS PR's head branch (check_suite.head_branch === the
    // card's PR head ref) whose server-assigned created_at is at/before the
    // approval time, the sha provably existed on this branch at that time and no
    // force-push moved it, so it was the head at approval.
    const shaTimestamp = await readShaServerTimestamp(
      db,
      companyId,
      target.owner,
      target.repo,
      currentHeadSha,
      target.headRefName,
    );
    if (!shaTimestamp.ok) {
      if (shaTimestamp.transient) {
        // A failed read (or an unreadable head ref) is TRANSIENT — report a skip
        // but do NOT persist, so the next tick retries (mirror the
        // timeline-read-failed branch).
        return {
          kind: "refused",
          reason: "backfill:sha-existence-read-failed",
          transient: true,
          detail: `backfill: ${shaTimestamp.detail}; will retry on the next tick`,
        };
      }
      // No branch-bound server-timed evidence is a DETERMINISTIC refusal: the
      // sha cannot be shown to have existed on this branch at/before the
      // approval.
      return {
        kind: "refused",
        reason: "backfill:head-unverifiable",
        transient: false,
        detail: `backfill: ${shaTimestamp.detail}; refusing to anchor an unverifiable head`,
      };
    }

    if (shaTimestamp.minTimestampMs > approvalTimeMs) {
      return {
        kind: "refused",
        reason: "backfill:head-unverifiable",
        transient: false,
        detail: `backfill: ${target.displayName} head ${currentHeadSha.slice(0, 7)} has no server-timestamped evidence at or before the approval ${decisionCreatedAt.toISOString()} (earliest: ${new Date(shaTimestamp.minTimestampMs).toISOString()}); refusing to anchor an unverifiable head`,
      };
    }

    // The sha has server-attested existence at/before the approval time, and no
    // post-approval force-push moved it.
    return {
      kind: "backfilled",
      anchorHeadSha: currentHeadSha,
      detail: `backfill: anchored ${currentHeadSha.slice(0, 7)} via server-timed sha existence (earliest ${new Date(shaTimestamp.minTimestampMs).toISOString()}) on the ${target.displayName} timeline (approved ${decisionCreatedAt.toISOString()})`,
    };
  }

  if (timeline.headAtApproval !== currentHeadSha) {
    return {
      kind: "refused",
      reason: "backfill:head-moved-since-approval",
      transient: false,
      detail: `backfill: verified head at approval time ${timeline.headAtApproval.slice(0, 7)} differs from the live head ${currentHeadSha.slice(0, 7)}; the reviewed code is no longer the head; refusing and leaving the card for re-review`,
    };
  }

  return {
    kind: "backfilled",
    anchorHeadSha: timeline.headAtApproval,
    detail: `backfill: anchored ${timeline.headAtApproval.slice(0, 7)} from the ${target.displayName} timeline (approved ${decisionCreatedAt.toISOString()})`,
  };
}

/**
 * SUP-14747: persist the D-B approval anchor for a verified backfill. Sets
 * `approvalStatus.approvedHeadSha` + `approvedAt` (and clears any prior
 * `backfillRefusal`) so the unmodified first-publish path certifies the head.
 * Shared by the temporal-proof and SUP-15017 content-identity success paths.
 */
export async function anchorBackfilledHead(
  db: Db,
  row: CandidateRow,
  anchorHeadSha: string,
  decisionCreatedAt: Date,
): Promise<void> {
  await mergeApprovalStatus(
    db,
    row,
    {
      approvedHeadSha: anchorHeadSha,
      approvedAt: decisionCreatedAt.toISOString(),
    },
    {
      source: "approval-status-reconciler.anchor_backfilled_head",
      // A backfilled anchor supersedes any earlier stable refusal; drop it so the
      // subtree stops reporting the card as unbackfillable.
      removeKeys: ["backfillRefusal"],
    },
  );
}

/**
 * SUP-14747: recover the D-B approval anchor for a stranded pre-D-B first
 * publish. Reads the card's approval time (latest approved decision), derives
 * the verified head-at-approval-time from the PR timeline (the newest force-push
 * whose server-recorded `created_at` is at/before the approval), and — only when
 * that head still equals the live head — writes approvalStatus.approvedHeadSha +
 * approvedAt so the unmodified first-publish path certifies it. A head provable
 * only through committed (client-timed) events, or any head we cannot verify to a
 * server timestamp, is refused with a recorded reason and zero writes. A
 * DETERMINISTIC refusal is persisted on the card, keyed on both the live head and
 * the approval time, so the next tick skips the timeline re-read while neither
 * changes (backfill-repeat-fanout). A transient timeline read failure is NOT
 * persisted, so it retries on the next tick instead of stranding the card on one
 * transient error (backfill-refusal-caches-transient-failures).
 *
 * SUP-15017: when the card was approved via a certified `no-pr` branch anchor and
 * the PR was opened AFTER the approval, the temporal proof can never certify the
 * post-approval head. In that case the caller escalates a deterministic temporal
 * refusal to the second admissible proof — the certified anchor's content
 * identity — before persisting anything (see the escalation below).
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
  const decisionCreatedAt = decision.createdAt;

  // A stable refusal is a deterministic function of (timeline, live head,
  // approval time). It is cached against BOTH the live head and the approval
  // time: while neither changes, re-report it and skip the timeline re-read
  // (backfill-repeat-fanout). A new live head OR a re-approval at a later time
  // invalidates the cache (either can change the head-at-approval-time) and
  // forces a fresh read. A transient read failure is never cached.
  const cached = readBackfillRefusal(row);
  if (
    cached &&
    cached.observedHeadSha === currentHeadSha &&
    cached.approvedAtMs === approvalTimeMs
  ) {
    return {
      kind: "skipped",
      reason: cached.reason,
      detail: `backfill: stable refusal ${cached.reason} (observed head ${cached.observedHeadSha.slice(0, 7)} / approval ${new Date(cached.approvedAtMs).toISOString()} unchanged); skipping the timeline re-read for ${target.displayName}`,
    };
  }

  const temporal = await temporalBackfillOutcome(
    db,
    row.companyId,
    target,
    currentHeadSha,
    approvalTimeMs,
    decisionCreatedAt,
  );

  if (temporal.kind === "backfilled") {
    await anchorBackfilledHead(db, row, temporal.anchorHeadSha, decisionCreatedAt);
    return {
      kind: "backfilled",
      anchorHeadSha: temporal.anchorHeadSha,
      detail: temporal.detail,
    };
  }

  // The primary (temporal) proof did not certify the live head.
  if (temporal.transient) {
    // A transient read failure is reported as a skip but deliberately NOT
    // persisted, so the next tick retries the read instead of stranding a
    // recoverable card on one transient error
    // (backfill-refusal-caches-transient-failures).
    return { kind: "skipped", reason: temporal.reason, detail: temporal.detail };
  }

  // SUP-15017: a deterministic temporal refusal. When the card was approved via
  // a certified `no-pr` branch anchor and the PR was opened AFTER the approval,
  // the temporal proof can never certify the post-approval head (no head-mutating
  // event at/before the approval, or the only server-timed evidence is
  // post-approval). Fall back to the second admissible proof — the certified
  // anchor's content identity. Reached ONLY when a well-formed no-pr anchor with
  // a non-null certified head sha is present; a null headSha means the anchor
  // was never certified, so the temporal refusal stands (fail closed).
  const noPrAnchor = findNoPrBranchAnchor(row.executionState);
  if (noPrAnchor && noPrAnchor.headSha !== null) {
    const content = await verifyNoPrContentIdentity(
      db,
      row.companyId,
      noPrAnchor.owner,
      noPrAnchor.repo,
      noPrAnchor.headSha,
      currentHeadSha,
    );
    if (content.kind === "match") {
      // The live head introduces the same byte-identical changed files as the
      // certified anchor, so the bytes that would merge are the bytes that were
      // approved. Stamp the live head; the caller proceeds to the first-publish
      // path with enforceDeliveryIdentity (Guard A is a same-sha fast path).
      await anchorBackfilledHead(db, row, currentHeadSha, decisionCreatedAt);
      return {
        kind: "backfilled",
        anchorHeadSha: currentHeadSha,
        detail: `backfill: anchored ${currentHeadSha.slice(0, 7)} via certified no-pr anchor content identity (${content.fileCount} changed files byte-identical to anchor ${noPrAnchor.headSha.slice(0, 7)}; approved ${decisionCreatedAt.toISOString()})`,
      };
    }
    if (content.kind === "refused") {
      // The content does not match (or the anchor is lost / not decidable). A
      // DETERMINISTIC refusal with the existing `backfill:head-unverifiable`
      // reason, persisted so the next tick skips the re-read.
      await persistBackfillRefusal(db, row, {
        reason: "backfill:head-unverifiable",
        observedHeadSha: currentHeadSha,
        approvedAtMs: approvalTimeMs,
        observedAt: new Date().toISOString(),
      });
      return {
        kind: "skipped",
        reason: "backfill:head-unverifiable",
        detail: content.detail,
      };
    }
    // content.kind === "transient": an API read failed that is not a lost anchor
    // (e.g. a live-head read 5xx). NOT persisted — the next tick retries.
    return {
      kind: "skipped",
      reason: "backfill:content-identity-read-failed",
      detail: content.detail,
    };
  }

  // No no-pr anchor (or it carries no certified head sha): the deterministic
  // temporal refusal stands and is persisted as a stable refusal keyed on the
  // live head and approval time.
  await persistBackfillRefusal(db, row, {
    reason: temporal.reason,
    observedHeadSha: currentHeadSha,
    approvedAtMs: approvalTimeMs,
    observedAt: new Date().toISOString(),
  });
  return { kind: "skipped", reason: temporal.reason, detail: temporal.detail };
}

/**
 * SUP-14926: persist a terminal `none` workspace-discovery verdict on the card.
 * A zero-mention approved card has no mention row to carry PR state, so once the
 * live workspace discovery concludes there is no open PR, nothing about the card
 * changes on its own and it would be re-scanned (and re-fan-out to GitHub) on
 * every tick. The persisted verdict lets the candidate SQL exclude it until the
 * card is updated again (a new PR arrives), which re-admits it. Only the
 * deterministic `none` outcome is persisted — `undetermined` (transient
 * auth/HTTP) and `ambiguous` (operator attention) must keep retrying and are
 * never silenced.
 */
export async function persistWorkspaceDiscoveryVerdict(
  db: Db,
  row: CandidateRow,
): Promise<void> {
  // Read the anchor from the snapshot before the merge; it is only needed to
  // record which head the "none" verdict was reached against.
  const anchorHeadSha = readApprovedHead(row.executionState)?.anchorHeadSha ?? null;
  const marker = {
    verdict: "none",
    at: new Date().toISOString(),
    headSha: anchorHeadSha,
  };
  await mergeApprovalStatus(db, row, { workspaceDiscovery: marker }, {
    source: "approval-status-reconciler.persist_workspace_discovery_verdict",
  });
}

async function reconcileCandidate(db: Db, row: CandidateRow): Promise<CandidateResult> {
  const label = row.identifier ?? row.id;

  const integrity = await evaluateStageIntegrity(db, row);
  if (integrity) {
    return { kind: "skipped", reason: integrity.reason, detail: `guard-b ${integrity.detail}` };
  }

  const linked = await resolveLinkedPullRequestsWithState(db, row.companyId, row.id);
  const openPrs = linked.filter((pr) => pr.cachedState === "open");
  // SUP-14911: an object whose last refresh failed with a terminal auth error
  // (the repo does not exist or has no App installation) will never hydrate.
  // A null cachedState with a terminal error code means "hydration was
  // attempted and is impossible", not "not hydrated yet". Only objects with no
  // terminal error are genuinely pending hydration and worth selecting.
  const unhydratedPrs = linked.filter(
    (pr) => pr.cachedState === null && !isTerminalResolutionError(pr.lastErrorCode),
  );
  let target: LinkedPullRequest | null = null;
  if (openPrs.length === 1) {
    target = openPrs[0];
  } else if (openPrs.length === 0 && unhydratedPrs.length === 1) {
    target = unhydratedPrs[0];
  } else if (linked.length === 0) {
    // SUP-14917: zero cached mentions — the PR was delivered from a workspace and
    // never posted in-thread, so the reconciler used to wedge this card forever as
    // no-open-pr. Resolve it the SAME way merge-arming does (shared live workspace
    // discovery), so the two call sites can no longer disagree about which PR the
    // card delivered. Multi/closed-mention cards keep the existing verdict above.
    const resolution = await resolveCardPullRequest(db, row.companyId, row.id, row.identifier ?? "", {
      closingTransition: true,
    });
    if (resolution.kind === "undetermined") {
      const failure = resolution.failure;
      const why = failure.noToken
        ? `auth_required for ${failure.owner}/${failure.repo}`
        : `HTTP ${failure.status} ${failure.message ?? ""}`.trim();
      return {
        kind: "skipped",
        reason: "pr-undetermined",
        detail: `pr-undetermined: live workspace discovery failed (${why}); skipping transiently, not treating as no-open-pr`,
      };
    }
    if (resolution.kind === "none") {
      await persistWorkspaceDiscoveryVerdict(db, row);
      return {
        kind: "skipped",
        reason: "no-open-pr",
        detail: "no-open-pr: no linked mentions and no open workspace PR resolvable",
      };
    }
    if (resolution.kind === "ambiguous") {
      return {
        kind: "skipped",
        reason: "ambiguous-pr",
        detail: `ambiguous-pr: ${resolution.reason}: ${resolution.displayNames.join(", ")}`,
      };
    }
    target = {
      id: "workspace-discovered",
      owner: resolution.owner,
      repo: resolution.repo,
      number: resolution.number,
      nodeId: null,
      headRefName: resolution.headRefName,
      displayName: resolution.displayName,
      title: null,
      cachedState: null,
      lastErrorCode: null,
      reviewDecision: null,
    };
  }
  if (!target) {
    const deadUnhydrated = linked.filter(
      (pr) => pr.cachedState === null && isTerminalResolutionError(pr.lastErrorCode),
    );
    const reason =
      openPrs.length > 1 || (openPrs.length === 0 && unhydratedPrs.length > 1)
        ? "ambiguous-pr"
        : deadUnhydrated.length > 0
          ? "dead-unhydrated-pr"
          : "no-open-pr";
    const cached =
      linked.length > 0
        ? linked.map((pr) => `${pr.displayName} state=${pr.cachedState ?? "unhydrated"}${pr.lastErrorCode ? ` err=${pr.lastErrorCode}` : ""}`).join(", ")
        : "none";
    return { kind: "skipped", reason, detail: `${reason}: linked mentions: ${cached}` };
  }

  const prRead = await ghReadJson(db, row.companyId, target.owner, target.repo, `/pulls/${target.number}`);
  if (!prRead.ok) {
    return {
      kind: "failed",
      detail: `pr-fetch-failed: ${target.displayName} HTTP ${prRead.status} ${prRead.message ?? ""}`.trim(),
    };
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
      // SUP-14049 / SUP-14996: positive evidence the new head voids the
      // published approval — surface it on the PR itself, advisory-only,
      // naming the approved timestamp when the card persisted one.
      const voidWarning = await postApprovalVoidWarning(
        db,
        row,
        target,
        approvedHeadSha,
        headSha,
        substanceChange,
        approvedHead?.publishedAt ?? null,
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
      await mergeApprovalStatus(
        db,
        row,
        {
          publishedHeadSha: headSha,
          publishedAt: new Date().toISOString(),
        },
        {
          source: "approval-status-reconciler.republish",
        },
      );
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
  const resumeAfter = options.resumeAfter ?? null;
  const rows = await findApprovalCandidates(db, maxCandidates + 1, resumeAfter);
  const capped = Math.max(0, rows.length - maxCandidates);
  const batch = capped > 0 ? rows.slice(0, maxCandidates) : rows;

  // SUP-14736: advance the keyset cursor past the candidates this tick
  // consumed so the next tick resumes after them instead of re-reading the
  // same lexicographic head. When this tick reached the end of the set
  // (rows.length <= maxCandidates) the cursor wraps to null; the scheduler
  // feeds the returned value back via `resumeAfter`.
  const nextScanKey =
    capped > 0 && batch.length > 0 ? (batch[batch.length - 1]?.identifier ?? null) : null;

  const summary: ApprovalStatusReconcilerTickSummary = {
    scanned: 0,
    republished: 0,
    skipped: {},
    skippedDetails: [],
    failed: 0,
    failedDetails: [],
    capped,
    nextScanKey,
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
  const baseOptions: ApprovalStatusReconcilerTickOptions = { maxCandidates: schedule.maxCandidates };
  // SUP-14736: in-process keyset cursor. The candidate scan walks the set in
  // identifier order; when a tick consumes a full window the summary's
  // `nextScanKey` tells the next tick where to resume, so the set is traversed
  // round-robin instead of re-reading the same lexicographic head every
  // interval. When a tick reaches the end of the set the cursor wraps to null.
  let cursor: string | null = null;
  let inFlight = false;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    if (inFlight) {
      logger.info("approval status reconciler still running; skipping this tick");
      return;
    }
    inFlight = true;
    void Promise.resolve(runTick({ ...baseOptions, resumeAfter: cursor }))
      .then((summary) => {
        cursor = summary && typeof summary.nextScanKey === "string" ? summary.nextScanKey : null;
      })
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
