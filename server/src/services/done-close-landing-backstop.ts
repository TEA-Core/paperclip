import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companies, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { issueService } from "./issues.js";
import {
  enableAutoMerge,
  fetchGitHubNodeId,
  isGitHubTokenResolution,
  resolveCardPullRequest,
  resolveGitHubTokenForRepo,
  resolveLinkedPullRequestsWithState,
  fetchHeadViaTokenCandidates,
  fetchHeadApprovedStatusViaTokenCandidates,
  fetchLastMergeQueueEjectionViaTokenCandidates,
  narrowToDelivered,
  notDeliveredReasonForPr,
  MERGE_ARMING_REFUSED_ON_CLOSE_ACTION,
  type LinkedPullRequest,
} from "./merge-arming.js";
import { createGitHubExternalObjectProvider } from "./github-external-object-provider.js";
import {
  isSharedCarrierRefusal,
  resolveCarrierOwner,
  issueInBlockerClosure,
  listNonTerminalRootCauseBlockers,
} from "./blocker-closure.js";
import type {
  ExternalObjectResolveResult,
  ExternalObjectResolver,
} from "./external-objects.js";

/**
 * Backstop sweep for decision-carried `done` closes (SUP-13352).
 *
 * The SUP-13207 board direction B exemption lets a review approval land `done`
 * while its linked PRs are still open, because the approval is exactly what
 * arms the merge. Nothing after that transition checks that the armed merge
 * actually LANDED: an hourly re-arm sweep re-arms merges but never audits
 * closed-unmerged PRs on already-`done` issues (measured 2026-08-18: SUP-13326
 * sat `done` with #3158 closed-unmerged and the branch deleted).
 *
 * This sweep periodically finds decision-carried skips recorded by the
 * done-transition guard, measures the linked PRs live, and emits an audit row
 * per (issue, PR): `issue.done_close_landing_confirmed` when merged,
 * `issue.done_close_landing_failed` when closed-unmerged or still open past
 * the grace window (the latter also gets a system comment + assignee wake,
 * because a comment alone never wakes a closed/done issue). Unmeasurable PRs
 * are deferred to a later sweep — nothing unmeasured is ever reported.
 */

const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
// SUP-15953: the re-enqueue leg gets its OWN eligibility window. The landing
// VERDICT must wait the full DEFAULT_GRACE_MS (24h) — a merge deserves time to
// land before it is called failed — but a queue EJECTION happens in minutes, and
// a 24h gate on the re-enqueue leg left the platform with no re-arm path at all
// for the first day (support-RE filled the hole by hand, cycle after cycle). One
// sweep interval is the floor: an ejected PR is visible to the re-enqueue leg a
// sweep or two after it is ejected, while the verdict still waits its full 24h.
const DEFAULT_REENQUEUE_GRACE_MS = 60 * 60 * 1000;
// A PR re-enqueued into the merge queue can be EJECTED by the queue (failing
// checks, conflicts, behind the base branch) and left `open` again — in which
// case the confirm/failed/escalated branches are all unreachable for it. So the
// "already re-enqueued, skip" behavior is bounded to this many total re-enqueue
// attempts PER PULL REQUEST (company-wide): beyond it, a still-open PR is
// re-examined on the next sweep and escalates instead of being re-enqueued
// (or skipped) forever.
//
// The bound is on the PR, NOT on (issue, PR). A shared carrier PR can be linked
// from N `done` sibling cards, and scoping the counter to the issue would give
// each sibling its own quota of 3 — an effective bound of 3xN that grows with
// every sibling that closes `done` (measured 2026-09-07: 3 cards / 5 adds on
// #3443). So the cap and the single escalation are counted across the whole
// company on the PR key (see sweepCandidate). The hourly sweep interval spaces
// the attempts out; the cap bounds the total PER PR, so the sweep cannot
// re-enqueue in a tight loop.
export const MAX_REENQUEUE_ATTEMPTS = 3;

export const DONE_CLOSE_LANDING_ACTOR_ID = "system:done-close-landing-backstop";
export const DONE_CLOSE_LANDING_CONFIRMED_ACTION = "issue.done_close_landing_confirmed";
export const DONE_CLOSE_LANDING_FAILED_ACTION = "issue.done_close_landing_failed";
export const DONE_CLOSE_LANDING_REENQUEUED_ACTION = "issue.done_close_landing_reenqueued";
export const DONE_CLOSE_LANDING_REENQUEUE_REFUSED_ACTION = "issue.done_close_landing_reenqueue_refused";
export const DONE_CLOSE_LANDING_ESCALATED_ACTION = "issue.done_close_landing_escalated";
// SUP-16689: a decision-carried `done` card whose (only) linked PR is a still-open
// DRAFT. A draft can never auto-merge, so the re-enqueue / confirmed / failed legs
// all miss it, and the resolvers are draft-blind by default — leaving the card
// silently unaudited until the 7-day discovery window ages its skip row out. This
// row makes the strand visible and owned (report only: no re-enqueue, no quota).
export const DONE_CLOSE_LANDING_DRAFT_STRANDED_ACTION = "issue.done_close_landing_draft_stranded";
// SUP-15381 (ADR-091 D1): a shared-carrier child whose close was refused by the
// prefix predicate cannot land through its own card. Instead of re-opening it
// into a board park that its own parent blocks on, the landing obligation is
// attributed to the card that owns the carrier branch and the child is left
// done. This row is the only record for that disposition (mirrors the
// superseded-carrier ledger: an audit row, no status change).
export const DONE_CLOSE_LANDING_ATTRIBUTED_ACTION = "issue.done_close_landing_attributed";
// SUP-17514 (ADR-091 D5 cross-repo disposition): a decision-carried `done` card
// whose linked PR's head repo is NOT the card's delivery repo. The SUP-17133
// delivery-repo guard refuses to arm it (correct — the card has no deliverable
// in that repo), but its disposition used to be "escalate + park the card
// `blocked`", converting a fully-landed card into a permanently-parked one with
// an unsatisfiable board remedy (SUP-17092: the card's own delivery confirmed
// 8ms earlier, then a body-cited foreign-repo PR escalated and re-opened it).
// The cross-repo reading is therefore report-only: a durable audit row naming
// the PR, head repo, delivery repo and the D5 reason. No status change, no
// unblockDescriptor, no assignee wake. This row is the only record for that
// disposition (mirrors draft_stranded: an audit row, no status change).
export const DONE_CLOSE_LANDING_CROSS_REPO_REPORTED_ACTION = "issue.done_close_landing_cross_repo_reported";
const DECISION_CARRIED_SKIP_REASON_PREFIX = "open_linked_prs_decision_carried:";
const SKIPPED_ACTION = "issue.done_transition_guard_skipped";

export type DoneCloseLandingWakeup = (agentId: string, options: {
  source: "automation";
  triggerDetail: "system";
  reason: "issue_commented";
  payload: Record<string, unknown>;
}) => Promise<unknown>;

export interface DoneCloseLandingBackstopOptions {
  /** Wake shape matching the merged-PR confirmation sweep (issue_commented). */
  wakeup?: DoneCloseLandingWakeup;
  /** How long after the decision-carried skip a merge had to land. */
  graceMs?: number;
  /**
   * SUP-15953: how long after the decision-carried skip a RE-ENQUEUE is
   * permitted. Deliberately far shorter than `graceMs` (the landing-verdict
   * window) because a queue ejection happens in minutes. A candidate inside this
   * window but outside `graceMs` is eligible for re-enqueue ONLY — never for a
   * confirmed / failed / escalated verdict. Defaults to one sweep interval.
   */
  reenqueueGraceMs?: number;
  /** Oldest skip the sweep will consider (bounds the first run). */
  lookbackMs?: number;
  /** Minimum spacing between actual measurement runs. */
  sweepIntervalMs?: number;
  now?: () => Date;
}

export interface DoneCloseLandingSweepResult {
  /** False when the min-interval gate short-circuited the tick (no-op). */
  due: boolean;
  /** Distinct done issues with an in-window latest decision-carried skip. */
  candidates: number;
  confirmed: number;
  failed: number;
  deferred: number;
  reenqueued: number;
  escalated: number;
  draftStranded: number;
}

export type MeasuredPullRequestState = "merged" | "closed" | "open";

/**
 * SUP-15315: outcome of the re-enqueue head-authorization gate.
 *  - `authorized`: the live head is covered by the card's pinned approval stamp
 *    OR carries its own `paperclip/approved` success status — safe to re-enqueue.
 *  - `refused`: the head is positively UNSTAMPED (stamp stranded or absent and no
 *    live status) — never re-enqueue; write the refusal and escalate.
 *  - `deferred`: the live head or its approval status could not be read this tick
 *    (network/auth/404) — fail closed, defer to a later sweep, never report.
 */
export type RequeueAuthorization =
  | { kind: "authorized" }
  | { kind: "refused"; headSha: string; approvedHeadSha: string | null; reason: string }
  | { kind: "deferred"; reason: string };

interface CandidateIssue {
  id: string;
  companyId: string;
  status: string;
  identifier: string | null;
  assigneeAgentId: string | null;
}

interface CandidateRow {
  details: Record<string, unknown> | null;
  createdAt: Date;
  issue: CandidateIssue;
}

interface SweepCounts {
  confirmed: number;
  failed: number;
  deferred: number;
  reenqueued: number;
  escalated: number;
  draftStranded: number;
}

/** A live-measured PR, captured in the first pass before any disposition. */
interface MeasuredLanding {
  pr: LinkedPullRequest;
  prKey: string;
  state: MeasuredPullRequestState;
  // Live provider `data.draft`; `"unknown"` when the snapshot carries no readable
  // draft flag. Only the OPEN branch consumes it (merged/closed need no draft),
  // where `"unknown"` fails closed and defers.
  draft: boolean | "unknown";
  closedAt: string | null;
}

function readMsEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallbackMs;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** SUP-15953: idempotency key for one (PR, head, ejection-reason) refusal. */
function refusalKey(pr: string, headSha: string, ejectionReason: string): string {
  return `${pr}\u0000${headSha}\u0000${ejectionReason}`;
}

/**
 * Build (but do not execute) the discovery query for done cards whose linked PR
 * may not have landed. Extracted so the exact WHERE predicate can be asserted in
 * isolation (AC1) rather than only through an injected candidate set.
 *
 * Two candidate sources, both first-class activity rows:
 *   1. decision-carried close: `issue.done_transition_guard_skipped` whose
 *      `details->>'reason'` carries the `open_linked_prs_decision_carried:`
 *      prefix (SUP-13352). The guard writes this row on a decision-carrying close
 *      with an open linked PR regardless of `mergeArmingEnabled`, so a
 *      never-armed card still produces it (SUP-14959/#514 carries exactly this row).
 *   2. arming refusal on close (SUP-14900): `issue.merge_arming_refused_on_close`.
 */
export function buildDiscoveryQuery(db: Db, windowStart: Date, discoveryCutoff: Date) {
  const issueIdAsText = sql<string>`${issues.id}::text`;
  return db
    .select({
      details: activityLog.details,
      createdAt: activityLog.createdAt,
      issue: {
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        identifier: issues.identifier,
        assigneeAgentId: issues.assigneeAgentId,
      },
    })
    .from(activityLog)
    .innerJoin(
      issues,
      and(
        eq(activityLog.entityId, issueIdAsText),
        eq(activityLog.companyId, issues.companyId),
      ),
    )
    .where(
      and(
        eq(activityLog.entityType, "issue"),
        or(
          and(
            eq(activityLog.action, SKIPPED_ACTION),
            sql`${activityLog.details}->>'reason' LIKE 'open_linked_prs_decision_carried:%'`,
          ),
          eq(activityLog.action, MERGE_ARMING_REFUSED_ON_CLOSE_ACTION),
        ),
        gte(activityLog.createdAt, windowStart),
        lte(activityLog.createdAt, discoveryCutoff),
        eq(issues.status, "done"),
      ),
    );
}

/**
 * Qualify raw discovery rows into candidate cards: keep only the LATEST
 * transition-of-record per issue, require it to be `done` and inside the
 * lookback/discovery window, and require it to carry a decision-carried skip
 * reason or an arming-refusal reason. Mirrors the discovery WHERE so a row the
 * query returns is always re-validated before it is measured.
 *
 * SUP-15953: `discoveryCutoff` is the WIDER of the verdict grace and the
 * re-enqueue grace, so a recently ejected PR is a candidate here. Verdict
 * eligibility is a separate, later check against `graceCutoff` (passed to
 * `sweepCandidate`); this function only qualifies candidacy, not disposition.
 */
export function selectLandingCandidates(
  rows: CandidateRow[],
  windowStart: Date,
  graceCutoff: Date,
  discoveryCutoff: Date = graceCutoff,
): CandidateRow[] {
  const latestByIssue = new Map<string, CandidateRow>();
  for (const row of rows) {
    const existing = latestByIssue.get(row.issue.id);
    if (!existing || row.createdAt.getTime() > existing.createdAt.getTime()) {
      latestByIssue.set(row.issue.id, row);
    }
  }
  return [...latestByIssue.values()].filter((row) => {
    if (row.issue.status !== "done") return false;
    const createdAt = row.createdAt.getTime();
    if (createdAt < windowStart.getTime() || createdAt > discoveryCutoff.getTime()) return false;
    const details = readRecord(row.details);
    const isDecisionCarried =
      readString(details?.reason)?.startsWith(DECISION_CARRIED_SKIP_REASON_PREFIX) === true;
    const isArmingRefused = readString(details?.refusalReason) !== null;
    return isDecisionCarried || isArmingRefused;
  });
}

/**
 * Classify a LIVE provider snapshot into a landing state, measured from the raw
 * snapshot rather than `createPullRequestMergeDetailsResolver`, which conflates
 * closed-unmerged with open (`merged | open | unknown`). Anything not
 * positively proven returns `"unknown"` and the pair is deferred.
 */
export function classifyPullRequestLanding(
  result: ExternalObjectResolveResult,
): MeasuredPullRequestState | "unknown" {
  if (!result.ok) return "unknown";
  const snapshot = result.snapshot;
  const data = readRecord(snapshot.data);
  if (
    snapshot.statusKey === "merged"
    || data?.merged === true
    || data?.merged_at != null
  ) return "merged";
  if (data?.state === "closed") return "closed";
  if (data?.state === "open") return "open";
  return "unknown";
}

export function createDoneCloseLandingBackstopService(
  db: Db,
  opts: DoneCloseLandingBackstopOptions = {},
) {
  const graceMs = opts.graceMs ?? readMsEnv("DONE_CLOSE_LANDING_GRACE_MS", DEFAULT_GRACE_MS);
  const reenqueueGraceMs =
    opts.reenqueueGraceMs
    ?? readMsEnv("DONE_CLOSE_LANDING_REENQUEUE_GRACE_MS", DEFAULT_REENQUEUE_GRACE_MS);
  const lookbackMs = opts.lookbackMs ?? readMsEnv("DONE_CLOSE_LANDING_LOOKBACK_MS", DEFAULT_LOOKBACK_MS);
  const sweepIntervalMs = opts.sweepIntervalMs ?? readMsEnv("DONE_CLOSE_LANDING_SWEEP_INTERVAL_MS", DEFAULT_SWEEP_INTERVAL_MS);
  const now = opts.now ?? (() => new Date());
  let lastRunAt: number | null = null;

  async function sweep(): Promise<DoneCloseLandingSweepResult> {
    const checkedAt = now();
    // The heartbeat tick fires every 30s; GitHub measurement is expensive, so
    // every non-due tick is a no-op.
    if (lastRunAt !== null && checkedAt.getTime() - lastRunAt < sweepIntervalMs) {
      return { due: false, candidates: 0, confirmed: 0, failed: 0, deferred: 0, reenqueued: 0, escalated: 0, draftStranded: 0 };
    }
    lastRunAt = checkedAt.getTime();
    const result: DoneCloseLandingSweepResult = {
      due: true,
      candidates: 0,
      confirmed: 0,
      failed: 0,
      deferred: 0,
      reenqueued: 0,
      escalated: 0,
      draftStranded: 0,
    };

    const windowStart = new Date(checkedAt.getTime() - lookbackMs);
    const graceCutoff = new Date(checkedAt.getTime() - graceMs);
    const reenqueueCutoff = new Date(checkedAt.getTime() - reenqueueGraceMs);
    // SUP-15953: discovery widens to the LESS restrictive of the two cutoffs so a
    // recently ejected PR is visible to the re-enqueue leg. The verdict legs
    // still require the unchanged 24h `graceCutoff` (checked per candidate).
    const discoveryCutoff = new Date(
      Math.max(graceCutoff.getTime(), reenqueueCutoff.getTime()),
    );
    const rows = await buildDiscoveryQuery(db, windowStart, discoveryCutoff);
    const candidates = selectLandingCandidates(rows, windowStart, graceCutoff, discoveryCutoff);
    result.candidates = candidates.length;
    if (candidates.length === 0) return result;

    const provider = createGitHubExternalObjectProvider(db);
    const resolver = provider.resolvers.find((candidate) => candidate.objectType === "pull_request") ?? null;
    const svc = issueService(db);

    for (const row of candidates) {
      const counts: SweepCounts = { confirmed: 0, failed: 0, deferred: 0, reenqueued: 0, escalated: 0, draftStranded: 0 };
      try {
        await sweepCandidate(row, counts, { resolver, svc, graceCutoff });
      } catch (err) {
        logger.warn(
          { err, issueId: row.issue.id },
          "done-close landing backstop: candidate sweep failed; will retry next sweep",
        );
      }
      result.confirmed += counts.confirmed;
      result.failed += counts.failed;
      result.deferred += counts.deferred;
      result.reenqueued += counts.reenqueued;
      result.escalated += counts.escalated;
      result.draftStranded += counts.draftStranded;
    }
    return result;
  }

  async function sweepCandidate(
    row: CandidateRow,
    counts: SweepCounts,
    deps: { resolver: ExternalObjectResolver | null; svc: ReturnType<typeof issueService>; graceCutoff: Date },
  ) {
    const issue = row.issue;
    const details = readRecord(row.details);
    // SUP-15953: verdicts (confirmed/failed/escalated) require the full landing
    // grace. A candidate inside the wider re-enqueue window but outside this
    // bound is eligible for the re-enqueue leg ONLY.
    const verdictEligible = row.createdAt.getTime() <= deps.graceCutoff.getTime();
    // SUP-14900: an arming-refusal candidate carries `refusalReason` (there is no
    // guard `skipReason`/`reason` for it); a decision-carried candidate carries the
    // guard's skipReason/reason. Prefer the refusal reason so the report names the
    // actual cause.
    const refusalReason = readString(details?.refusalReason);
    const isArmingRefusal = refusalReason !== null;
    const skipReason =
      refusalReason ?? readString(details?.skipReason) ?? readString(details?.reason);

    const companyRow = await db
      .select({ mergeArmingEnabled: companies.mergeArmingEnabled })
      .from(companies)
      .where(eq(companies.id, issue.companyId));
    const mergeArmingEnabled = companyRow[0]?.mergeArmingEnabled === true;

    const prs: LinkedPullRequest[] = await resolveLinkedPullRequestsWithState(
      db,
      issue.companyId,
      issue.id,
      { includeDrafts: true },
    );
    if (prs.length === 0) {
      // SUP-14917: zero cached mentions — the PR was delivered from a workspace and
      // never posted in-thread, so this sweep used to see nothing. Resolve it the
      // SAME way merge-arming does (shared live workspace discovery) so the card is
      // visible here too instead of silently unaudited forever.
      const resolution = await resolveCardPullRequest(
        db,
        issue.companyId,
        issue.id,
        issue.identifier ?? "",
        { closingTransition: true, includeDrafts: true },
      );
      if (resolution.kind === "none") return;
      if (resolution.kind === "undetermined" || resolution.kind === "ambiguous") {
        // Not positively provable this tick; defer to a later sweep — never report.
        counts.deferred += 1;
        return;
      }
      prs.push({
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
        draft: resolution.draft,
      });
    }

    // Idempotency with no new column/table, split by the scope each disposition
    // actually owns (SUP-15316):
    //   • CONFIRMED / FAILED are the PER-CARD landing ledger. A merged/closed PR
    //     linked from N `done` cards must record one audit row PER card, so they
    //     stay scoped to this card (entityId = issue.id). Do NOT widen these —
    //     widening them would suppress the per-card ledger row whenever a sibling
    //     card lands the same PR first.
    //   • REENQUEUED / ESCALATED are the PR-SCOPED shared bound. The resource the
    //     cap protects is the PR, not the card: a shared carrier PR linked from N
    //     `done` siblings would otherwise get N × MAX_REENQUEUE_ATTEMPTS adds and
    //     N independent board escalations (measured 2026-09-07: 3 cards / 5 adds
    //     on #3443, two duplicate board unblockDescriptors on one PR). So the
    //     re-enqueue count and the single escalation are read company-wide,
    //     matched on the PR key, never on entityId = issue.id.
    //   • A refused attempt (SUP-15315,
    //     issue.done_close_landing_reenqueue_refused) is a DIFFERENT action and is
    //     deliberately never counted here, so it cannot consume cap quota.
    const prKeys = prs.map((pr) => `${pr.owner}/${pr.repo}#${pr.number}`);
    const prText = sql<string>`${activityLog.details}->>'pr'`;
    const existing = await db
      .select({
        details: activityLog.details,
        action: activityLog.action,
        entityId: activityLog.entityId,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "issue"),
          inArray(
            activityLog.action,
            [
              DONE_CLOSE_LANDING_CONFIRMED_ACTION,
              DONE_CLOSE_LANDING_FAILED_ACTION,
              DONE_CLOSE_LANDING_REENQUEUED_ACTION,
              DONE_CLOSE_LANDING_ESCALATED_ACTION,
              DONE_CLOSE_LANDING_ATTRIBUTED_ACTION,
              DONE_CLOSE_LANDING_REENQUEUE_REFUSED_ACTION,
              DONE_CLOSE_LANDING_DRAFT_STRANDED_ACTION,
              DONE_CLOSE_LANDING_CROSS_REPO_REPORTED_ACTION,
            ],
          ),
          // This card's own rows (per-card ledger) OR any company row that
          // dispositions one of this card's PRs (PR-scoped shared bound).
          or(
            eq(activityLog.entityId, issue.id),
            and(
              eq(activityLog.companyId, issue.companyId),
              inArray(prText, prKeys),
            ),
          ),
        ),
      );
    // Per-card ledger: only THIS card's confirmed/failed rows count, so a sibling
    // card landing the same PR does not suppress this card's audit row (AC3).
    const alreadyConfirmed = new Set(
      existing
        .filter(
          (r) =>
            r.action === DONE_CLOSE_LANDING_CONFIRMED_ACTION && r.entityId === issue.id,
        )
        .map((r) => readString(readRecord(r.details)?.pr))
        .filter((value): value is string => value !== null),
    );
    const alreadyFailed = new Set(
      existing
        .filter(
          (r) =>
            r.action === DONE_CLOSE_LANDING_FAILED_ACTION && r.entityId === issue.id,
        )
        .map((r) => readString(readRecord(r.details)?.pr))
        .filter((value): value is string => value !== null),
    );
    // SUP-15381: per-card attribution ledger. Each shared-carrier child is a
    // distinct done issue; once ITS attribution row exists it must not be
    // re-attributed on every sweep (no status change, so the per-card scope —
    // like confirmed/failed — is what bounds the spam).
    const alreadyAttributed = new Set(
      existing
        .filter(
          (r) =>
            r.action === DONE_CLOSE_LANDING_ATTRIBUTED_ACTION && r.entityId === issue.id,
        )
        .map((r) => readString(readRecord(r.details)?.pr))
        .filter((value): value is string => value !== null),
    );
    // SUP-16689: per-card draft-stranded ledger. A draft PR is un-mergeable, so a
    // `done` card whose only linked PR is an open draft is reported once per card;
    // the per-card scope (entityId = issue.id) bounds the report like confirmed/failed.
    const alreadyDraftStranded = new Set(
      existing
        .filter(
          (r) =>
            r.action === DONE_CLOSE_LANDING_DRAFT_STRANDED_ACTION && r.entityId === issue.id,
        )
        .map((r) => readString(readRecord(r.details)?.pr))
        .filter((value): value is string => value !== null),
    );
    // SUP-17514: per-card cross-repo report-only ledger. A cross-repo PR is a
    // structural attribution (like the D1 `attributed` row, grace-independent),
    // so it is reported once per card; the per-card scope (entityId = issue.id)
    // bounds the report like confirmed/failed/draft_stranded. No status change,
    // so the bound lives entirely in this ledger.
    const alreadyCrossRepoReported = new Set(
      existing
        .filter(
          (r) =>
            r.action === DONE_CLOSE_LANDING_CROSS_REPO_REPORTED_ACTION && r.entityId === issue.id,
        )
        .map((r) => readString(readRecord(r.details)?.pr))
        .filter((value): value is string => value !== null),
    );
    // PR-scoped bound: count prior re-enqueues across the whole company for each
    // of this card's PRs, so MAX_REENQUEUE_ATTEMPTS caps TOTAL re-enqueues per PR
    // regardless of how many `done` cards link it.
    const reenqueueCounts = new Map<string, number>();
    for (const r of existing) {
      if (r.action !== DONE_CLOSE_LANDING_REENQUEUED_ACTION) continue;
      const prKey = readString(readRecord(r.details)?.pr);
      if (prKey === null) continue;
      reenqueueCounts.set(prKey, (reenqueueCounts.get(prKey) ?? 0) + 1);
    }
    // PR-scoped: at most one card is set `blocked` per PR per exhaustion; later
    // sibling cards see the escalated row and do not re-escalate the same PR.
    const alreadyEscalated = new Set(
      existing
        .filter((r) => r.action === DONE_CLOSE_LANDING_ESCALATED_ACTION)
        .map((r) => readString(readRecord(r.details)?.pr))
        .filter((value): value is string => value !== null),
    );
    // SUP-15953: an ejection refusal is keyed on (PR, head, ejectionReason) so a
    // PR that is conflict-ejected on an unchanged head records ONE refusal row,
    // not one per sweep. The refusal never consumes a MAX_REENQUEUE_ATTEMPTS slot.
    const alreadyRefused = new Set<string>();
    for (const r of existing) {
      if (r.action !== DONE_CLOSE_LANDING_REENQUEUE_REFUSED_ACTION) continue;
      const refusal = readRecord(r.details);
      const pr = readString(refusal?.pr);
      const head = readString(refusal?.headSha);
      const ejectionReason = readString(refusal?.ejectionReason);
      if (pr !== null && head !== null && ejectionReason !== null) {
        alreadyRefused.add(refusalKey(pr, head, ejectionReason));
      }
    }

    // Two-pass reconciliation (SUP-14971): measure EVERY linked PR on the card
    // before dispositioning any of them. The card-level question is "did this
    // card's work land ANYWHERE?" — a `merged` sibling means a closed-unmerged
    // sibling is a superseded carrier (its work was re-delivered and merged as
    // the sibling), not a landing failure. The old single loop dispositioned each
    // PR in isolation and reported the carrier as failed, telling the assignee to
    // re-merge work that had already landed.
    const measured: MeasuredLanding[] = [];

    // SUP-15315: head-authorization gate. The re-enqueue path must not arm a
    // merge on a head the merge boundary has not authorized. Fetch the card's
    // pinned approval stamp once per candidate so the per-PR gate can compare
    // the live head against it. Only needed when the re-enqueue lane is open.
    const approvedHeadSha = mergeArmingEnabled
      ? await readApprovedHeadSha(db, issue.id)
      : null;

    for (const pr of prs) {
      const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
      if (alreadyConfirmed.has(prKey) || alreadyFailed.has(prKey)) continue;

      if (!deps.resolver) {
        counts.deferred += 1;
        continue;
      }
      let state: MeasuredPullRequestState | "unknown" = "unknown";
      let draft: boolean | "unknown" = "unknown";
      let data: Record<string, unknown> | null = null;
      try {
        const resolved = await deps.resolver.resolve({
          companyId: issue.companyId,
          object: {
            externalId: `${pr.owner}/${pr.repo}#pull/${pr.number}`,
            sanitizedCanonicalUrl: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
          } as never,
        });
        state = classifyPullRequestLanding(resolved);
        data = resolved.ok ? readRecord(resolved.snapshot.data) : null;
        const liveDraft = data?.draft;
        draft = typeof liveDraft === "boolean" ? liveDraft : "unknown";
      } catch {
        state = "unknown";
      }
      if (state === "unknown") {
        // Never disposition an unmeasured PR; retry on a later sweep.
        counts.deferred += 1;
        continue;
      }

      const closedAt =
        state === "merged"
          ? readString(data?.merged_at)
          : state === "closed"
            ? readString(data?.closed_at)
            : null;

      measured.push({ pr, prKey, state, draft, closedAt });
    }

    // Did ANY linked PR on this card merge? If so, a closed-unmerged sibling is a
    // superseded carrier. The still-open-past-grace arm is intentionally left
    // unchanged (out of scope for this fix): it still takes the re-enqueue/escalate
    // path.
    const mergedSiblingKeys = measured
      .filter((m) => m.state === "merged")
      .map((m) => m.prKey);
    const hasMergedSibling = mergedSiblingKeys.length > 0;

    for (const { pr, prKey, state, draft, closedAt } of measured) {
      const isSupersededCarrier = state === "closed" && hasMergedSibling;

      if (state === "merged") {
        if (!verdictEligible) {
          // Visible to the re-enqueue leg's widened window, but the landing
          // VERDICT still waits the full grace (SUP-15953) — defer, never report.
          counts.deferred += 1;
          continue;
        }
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: DONE_CLOSE_LANDING_ACTOR_ID,
          agentId: null,
          runId: null,
          agentApiKeyId: null,
          action: DONE_CLOSE_LANDING_CONFIRMED_ACTION,
          entityType: "issue",
          entityId: issue.id,
          issueId: issue.id,
          details: {
            identifier: issue.identifier ?? null,
            pr: prKey,
            prState: state,
            closedAt,
            skipReason: skipReason ?? null,
            refusal: isArmingRefusal,
          },
        });
        counts.confirmed += 1;
        continue;
      }

      if (state === "closed") {
        if (!verdictEligible) {
          // No PR is reported failed before the full landing grace (SUP-15953).
          counts.deferred += 1;
          continue;
        }
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: DONE_CLOSE_LANDING_ACTOR_ID,
          agentId: null,
          runId: null,
          agentApiKeyId: null,
          action: DONE_CLOSE_LANDING_FAILED_ACTION,
          entityType: "issue",
          entityId: issue.id,
          issueId: issue.id,
          details: {
            identifier: issue.identifier ?? null,
            pr: prKey,
            prState: state,
            closedAt,
            skipReason: skipReason ?? null,
            refusal: isArmingRefusal,
            ...(isSupersededCarrier
              ? { supersededBy: mergedSiblingKeys.join(", ") }
              : {}),
          },
        });
        if (isSupersededCarrier) {
          // The card's work provably landed via the merged sibling. The audit row
          // above (with `supersededBy`) is the only record: neither the comment
          // nor the assignee wake fires, and it does not count as failed.
          continue;
        }
        // Closed-unmerged, no merged sibling: surface attention (existing behavior).
        const cause = isArmingRefusal
          ? `merge arming was REFUSED at close (${refusalReason}) and the approved head was never certified`
          : "the decision-carried merge never landed";
        await deps.svc.addComment(
          issue.id,
          `[Done-close landing] ${issue.identifier ?? "(unknown issue)"}: PR ${prKey} is closed-unmerged past the done-close grace window — ${cause}. Re-open/merge the PR and verify the deliverable.`,
          {},
          { authorType: "system" },
        );
        if (opts.wakeup && issue.assigneeAgentId) {
          await opts.wakeup(issue.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_commented",
            payload: { issueId: issue.id, mutation: "comment" },
          });
        }
        counts.failed += 1;
        continue;
      }

      // SUP-16689: a still-OPEN DRAFT can never land on its own — GitHub will not
      // auto-merge a draft, so the re-enqueue / confirmed / failed legs all miss
      // it. The resolvers are draft-blind by default; this sweep now passes
      // `includeDrafts: true` specifically to SEE these, and reports the strand
      // explicitly instead of letting the card age silently out of the 7-day
      // discovery window. Report only: no re-enqueue, no escalation, and no
      // MAX_REENQUEUE_ATTEMPTS quota consumed (a draft cannot be armed).
      //
      // The draft flag is read from the LIVE snapshot (`data.draft`), never the
      // cached mention: a PR promoted out of draft must not be reported stranded,
      // and a PR converted into draft must not enter the re-enqueue/escalate lane.
      // When the live flag is unreadable, fail closed and defer — guessing either
      // way would mis-disposition an open PR.
      if (draft === "unknown") {
        counts.deferred += 1;
        continue;
      }
      if (state === "open" && draft === true) {
        if (!verdictEligible) {
          // A freshly-closed card gets the landing grace before naming a draft
          // stranded (same conservatism as _failed); defer to a later sweep.
          counts.deferred += 1;
          continue;
        }
        if (alreadyDraftStranded.has(prKey)) {
          // This card+PR was already reported as draft-stranded on a prior sweep.
          continue;
        }
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: DONE_CLOSE_LANDING_ACTOR_ID,
          agentId: null,
          runId: null,
          agentApiKeyId: null,
          action: DONE_CLOSE_LANDING_DRAFT_STRANDED_ACTION,
          entityType: "issue",
          entityId: issue.id,
          issueId: issue.id,
          details: {
            identifier: issue.identifier ?? null,
            pr: prKey,
            prState: state,
            draft: true,
            skipReason: skipReason ?? null,
            refusal: isArmingRefusal,
          },
        });
        await deps.svc.addComment(
          issue.id,
          `[Done-close landing] ${issue.identifier ?? "(unknown issue)"}: PR ${prKey} is still an open DRAFT past the done-close grace window. A draft cannot be auto-merged, so this card cannot land until the PR is un-drafted (or merged another way). Promote the PR out of draft and re-verify the deliverable.`,
          {},
          { authorType: "system" },
        );
        if (opts.wakeup && issue.assigneeAgentId) {
          await opts.wakeup(issue.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_commented",
            payload: { issueId: issue.id, mutation: "comment" },
          });
        }
        counts.draftStranded += 1;
        continue;
      }

      // SUP-15381 (ADR-091 D1): a shared-carrier child whose close was refused by
      // the prefix predicate can NEVER land through its own card — the head ref
      // belongs to the parent's shared branch and can never carry this card's
      // identifier prefix (SUP-15098 / SUP-15126 / SUP-15203).
      //
      // Split on `deadlocked` (SUP-17092/B): when the child sits inside the carrier
      // owner's OWN blocker closure, the attribution is provably a deadlock — no
      // agent has a live path to land it, and resting the card `done` is a false
      // terminal (it removes the board's only button and, pre-SUP-17098, discharged
      // the card as a resolved dependency, waking dependents on a delivery that
      // provably never landed). The deadlocked case therefore PARKS the card
      // `blocked` with a first-class unblock descriptor. When the carrier owner
      // still has a live actionable path (`deadlocked === false`), SUP-15381's
      // rationale stands — attribute and leave done; SUP-17098's predicate keys on
      // the attribution row below to withhold the dependent wake in that case.
      if (isSharedCarrierRefusal(refusalReason)) {
        const carrier = await resolveCarrierOwner(db, issue.companyId, issue.id);
        if (carrier) {
          // SUP-17092/B round-1 (deadlocked-attribution-row-skips-required-park):
          // the deadlocked disposition is a LIVE property — re-derive it on every
          // sweep instead of freezing it from a prior attribution row. A prior row
          // bounds RE-LOGGING / re-commenting only, never the park itself: a card
          // is only ever a sweep candidate while it is `done` (discovery selects
          // status = done), so a deadlocked card still sitting `done` here means the
          // park it implies has not stuck (the `svc.update` threw, or the run was
          // interrupted right after the log). The prior early-continue skipped that
          // card forever, leaving a false terminal `done` and keeping its dependent
          // wake suppressed — the exact ghost pass this removes.
          const alreadyAttributedForPr = alreadyAttributed.has(prKey);
          const deadlocked = await issueInBlockerClosure(
            db,
            issue.companyId,
            carrier.ownerId,
            issue.id,
          );
          const carrierName = carrier.identifier ?? carrier.ownerId;
          if (deadlocked) {
            // SUP-17092/B: provable deadlock — park `blocked` with a first-class
            // unblock descriptor naming the carrier owner and its root-cause
            // non-terminal blockers, instead of leaving the card a false `done`.
            const rootCauseNames = (
              await listNonTerminalRootCauseBlockers(db, issue.companyId, carrier.ownerId)
            ).map((r) => r.identifier ?? r.id);
            if (!alreadyAttributedForPr) {
              await logActivity(db, {
                companyId: issue.companyId,
                actorType: "system",
                actorId: DONE_CLOSE_LANDING_ACTOR_ID,
                agentId: null,
                runId: null,
                agentApiKeyId: null,
                action: DONE_CLOSE_LANDING_ATTRIBUTED_ACTION,
                entityType: "issue",
                entityId: issue.id,
                issueId: issue.id,
                details: {
                  identifier: issue.identifier ?? null,
                  pr: prKey,
                  prState: "open",
                  sharedCarrier: true,
                  refusal: isArmingRefusal,
                  skipReason: skipReason ?? null,
                  carrierOwnerId: carrier.ownerId,
                  carrierIdentifier: carrier.identifier,
                  deadlocked: true,
                  rootCauseBlockers: rootCauseNames,
                },
              });
            }
            // A candidate is only ever `done`; if it is not already `blocked`, the
            // park has not (yet) stuck — apply it now. Idempotent: once parked the
            // card leaves the `done` candidate set, so a later sweep is a no-op.
            if (issue.status !== "blocked") {
              const rootCauseSuffix =
                rootCauseNames.length > 0
                  ? ` Root-cause non-terminal blockers: ${rootCauseNames.join(", ")}.`
                  : "";
              await deps.svc.update(issue.id, {
                status: "blocked",
                unblockDescriptor: {
                  owner: "board",
                  action:
                    `Park resolved by the board: land the shared-carrier branch ${prKey} owned by ${carrierName} ` +
                    `(this card's delivery was refused at the ADR-091 D1 prefix predicate and sits inside ${carrierName}'s own blocker closure, so it is parked, not done). ` +
                    `Unblock by resolving ${carrierName} so its shared head can carry ${issue.identifier ?? "this card"}'s identifier prefix and merge; this card is not a live dependency until it lands.${rootCauseSuffix}`,
                },
              });
              await deps.svc.addComment(
                issue.id,
                `[Done-close landing] ${issue.identifier ?? "(unknown issue)"}: PR ${prKey} is a shared-carrier deliverable refused at the ADR-091 D1 prefix predicate — its head belongs to the shared branch owned by ${carrierName}, so this card cannot land on its own. This card sits inside ${carrierName}'s own blocker closure, so the attribution is a provable deadlock: it is parked (status blocked) with a first-class unblock descriptor rather than left terminal, because a terminal done would remove the board's only button and, pre-SUP-17098, discharge it as a resolved dependency. A re-open/park IS recorded here: the attribution row plus this block.${rootCauseSuffix}`,
                {},
                { authorType: "system" },
              );
            }
            continue;
          }
          // deadlocked === false: SUP-15381's disposition stands — attribute and
          // leave done (no status change). SUP-17098's predicate keys on the
          // attribution row to stop the phantom dependency discharge. Idempotent:
          // a prior row already recorded the attribution, so do not re-log/re-comment.
          if (!alreadyAttributedForPr) {
            await logActivity(db, {
              companyId: issue.companyId,
              actorType: "system",
              actorId: DONE_CLOSE_LANDING_ACTOR_ID,
              agentId: null,
              runId: null,
              agentApiKeyId: null,
              action: DONE_CLOSE_LANDING_ATTRIBUTED_ACTION,
              entityType: "issue",
              entityId: issue.id,
              issueId: issue.id,
              details: {
                identifier: issue.identifier ?? null,
                pr: prKey,
                prState: "open",
                sharedCarrier: true,
                refusal: isArmingRefusal,
                skipReason: skipReason ?? null,
                carrierOwnerId: carrier.ownerId,
                carrierIdentifier: carrier.identifier,
                deadlocked: false,
                rootCauseBlockers: [],
              },
            });
            await deps.svc.addComment(
              issue.id,
              `[Done-close landing] ${issue.identifier ?? "(unknown issue)"}: PR ${prKey} is a shared-carrier deliverable refused at the ADR-091 D1 prefix predicate — its head belongs to the shared branch owned by ${carrierName}, so this card cannot land on its own. The landing obligation is attributed to ${carrierName} and this card is left done. No re-open or park is recorded here.`,
              {},
              { authorType: "system" },
            );
          }
          continue;
        }
      }

      // state === "open" past the grace window: re-enqueue (bounded) or escalate.
      // A prior re-enqueue does NOT mean the PR will land: the merge queue ejects
      // PRs (failing checks, conflicts, behind the base branch) and an ejected PR
      // is `open` again — at which point the confirm/failed branches can't fire.
      // So "already re-enqueued → skip forever" is replaced with a bounded attempt
      // count: re-examine on every sweep, re-enqueue only while under the cap, and
      // once exhausted let a still-open PR fall through to the _escalated path.
      const priorReenqueues = reenqueueCounts.get(prKey) ?? 0;
      const reenqueueExhausted = priorReenqueues >= MAX_REENQUEUE_ATTEMPTS;

      // SUP-17133: delivery-repo guard. Merge-arming refuses to stamp a PR whose
      // head repo is not this card's delivery repo (`notDeliveredReasonForPr`,
      // ADR-091 D5), but the re-enqueue leg had no such check — it would call
      // `enableAutoMerge` on the very PR arming had deliberately refused, and
      // report the structural cross-repo case to the board as a token/API fault.
      // Apply the IDENTICAL merge-arming predicate (single source of truth —
      // `narrowToDelivered`), BEFORE any ejection/head/token/node-id/enableAutoMerge
      // work, and spend no MAX_REENQUEUE_ATTEMPTS slot on a cross-repo head. A
      // predicate that cannot be evaluated (`identity-unresolved`: the card has no
      // resolvable delivery identity) preserves the pre-existing re-enqueue
      // behaviour — it is never a silent widen to arming an unproven head.
      let deliveryRefusal: { reason: string; headRepo: string; deliveryRepo: string } | null = null;
      const delivery = await narrowToDelivered(db, issue.companyId, issue.id, [pr]);
      if (delivery.outcome === "not-delivered") {
        deliveryRefusal = {
          reason: notDeliveredReasonForPr(
            pr,
            delivery.deliveryRepo,
            delivery.deliveryBranch,
            delivery.requiredIdentifier,
          ),
          headRepo: `${pr.owner}/${pr.repo}`,
          deliveryRepo: `${delivery.deliveryRepo.owner}/${delivery.deliveryRepo.repo}`,
        };
      }

      // SUP-17514 (ADR-091 D5 cross-repo disposition): a linked PR whose head repo
      // is NOT this card's delivery repo is structurally not part of this card's
      // landing obligation — the card has no deliverable in that repo and never
      // did. SUP-17133's guard refuses to arm it (correct), but the disposition it
      // chose was "escalate + park the card `blocked`" with an unsatisfiable board
      // remedy ("file the deliverable under a project bound to that repo"), which
      // converted a fully-landed card into a permanently-parked one (SUP-17092:
      // the card's own delivery confirmed 8ms earlier, then a body-cited
      // foreign-repo PR escalated and re-opened it). The cross-repo reading is
      // therefore REPORT-ONLY: a durable audit row naming the PR, the head repo,
      // the delivery repo and the D5 reason. No `svc.update(status: "blocked")`,
      // no `unblockDescriptor`, no assignee wake. This is a structural attribution
      // (like the D1 `attributed` row), so it is reported grace-independently and
      // idempotently. The genuinely-unlanded SAME-repo `not-delivered` PR (head
      // repo matches the delivery repo) falls through to the escalate+park path
      // below, and `identity-unresolved` keeps SUP-17133's re-enqueue behaviour —
      // the guard is keyed on `not-delivered`, never widened to a second outcome.
      const headRepoIsDeliveryRepo =
        delivery.outcome === "not-delivered" &&
        pr.owner.toLowerCase() === delivery.deliveryRepo.owner.toLowerCase() &&
        pr.repo.toLowerCase() === delivery.deliveryRepo.repo.toLowerCase();
      if (delivery.outcome === "not-delivered" && !headRepoIsDeliveryRepo) {
        if (!alreadyCrossRepoReported.has(prKey)) {
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: "system",
            actorId: DONE_CLOSE_LANDING_ACTOR_ID,
            agentId: null,
            runId: null,
            agentApiKeyId: null,
            action: DONE_CLOSE_LANDING_CROSS_REPO_REPORTED_ACTION,
            entityType: "issue",
            entityId: issue.id,
            issueId: issue.id,
            details: {
              identifier: issue.identifier ?? null,
              pr: prKey,
              prState: "open",
              disposition: "cross_repo_report_only",
              headRepo: `${pr.owner}/${pr.repo}`,
              deliveryRepo: `${delivery.deliveryRepo.owner}/${delivery.deliveryRepo.repo}`,
              reason: notDeliveredReasonForPr(
                pr,
                delivery.deliveryRepo,
                delivery.deliveryBranch,
                delivery.requiredIdentifier,
              ),
              skipReason: skipReason ?? null,
              refusal: isArmingRefusal,
            },
          });
        }
        // Drop this PR from the card's landing set: no re-enqueue, no escalation,
        // no board park, no assignee wake.
        continue;
      }

      // SUP-15315: head-authorization gate. Set when the live head is positively
      // UNSTAMPED (refused); the pair then falls through to the escalation path
      // below with the head-moved cause instead of being armed.
      let refusedHead: { headSha: string; approvedHeadSha: string | null; reason: string } | null = null;
      // SUP-15953: set when the last merge-queue ejection was `merge_conflict` and
      // the head has NOT moved since. The re-enqueue is refused (recorded, bounded
      // to one row per PR+head), and no MAX_REENQUEUE_ATTEMPTS slot is consumed.
      let ejectionRefusal: { headSha: string; reason: string; ejectedAt: string | null } | null = null;

      if (deliveryRefusal === null && !reenqueueExhausted && mergeArmingEnabled) {
        // SUP-15953 predicate FIRST: a conflict-ejected PR cannot be landed by
        // re-enqueueing the same head, so never spend a head-authorization read or
        // a queue add on it. An unreadable ejection read or reason fails closed.
        const ejectionGate = await authorizeReenqueueAfterEjection(issue.companyId, pr);
        if (ejectionGate.kind === "deferred") {
          counts.deferred += 1;
          continue;
        }
        if (ejectionGate.kind === "refused") {
          ejectionRefusal = ejectionGate;
          await recordEjectionRefusal(issue, prKey, ejectionGate, alreadyRefused);
        } else {
          const gate = await authorizeReenqueueHead(issue.companyId, pr, approvedHeadSha);
          if (gate.kind === "deferred") {
            // AC4: unresolvable head or approval status — fail closed, never
            // re-enqueue and never report; retry on a later sweep.
            counts.deferred += 1;
            continue;
          }
          if (gate.kind === "refused") {
            // AC2/AC3: head positively unstamped — record the refusal and fall
            // through to the escalation path below with the head-moved cause.
            refusedHead = gate;
          } else {
            const reenqueueSucceeded = await attemptReenqueue(
              issue.companyId,
              pr,
            );
            if (reenqueueSucceeded) {
              await logActivity(db, {
                companyId: issue.companyId,
                actorType: "system",
                actorId: DONE_CLOSE_LANDING_ACTOR_ID,
                agentId: null,
                runId: null,
                agentApiKeyId: null,
                action: DONE_CLOSE_LANDING_REENQUEUED_ACTION,
                entityType: "issue",
                entityId: issue.id,
                issueId: issue.id,
                details: {
                  identifier: issue.identifier ?? null,
                  pr: prKey,
                  prState: "open",
                  skipReason: skipReason ?? null,
                  refusal: isArmingRefusal,
                },
              });
              counts.reenqueued += 1;
              continue;
            }
          }
        }
      }

      // SUP-15953: a candidate inside the widened re-enqueue window but outside
      // the landing-verdict window gets NO verdict yet — including escalation.
      // Only the re-enqueue leg above runs for it; everything else waits for the
      // unchanged 24h graceCutoff.
      if (!verdictEligible) {
        counts.deferred += 1;
        continue;
      }

      // Escalate: the PR's head repo is not this card's delivery repo (SUP-17133,
      // ADR-091 D5), the re-enqueue cap is exhausted (still open), the lane is
      // closed, the re-enqueue attempt failed this tick, or the live head was
      // positively UNSTAMPED (head-authorization refusal).
      if (!alreadyEscalated.has(prKey)) {
        const reason = deliveryRefusal
          ? deliveryRefusal.reason
          : reenqueueExhausted
            ? `the PR has been re-enqueued ${priorReenqueues} times and is still open past the done-close grace window — the merge queue is not landing it (e.g. failing checks, conflicts, or it is behind the base branch)`
            : refusedHead
              ? refusedHead.reason
              : ejectionRefusal
                ? ejectionRefusal.reason
                : mergeArmingEnabled
                  ? "re-enqueue attempt failed (no resolvable GitHub token or API error)"
                  : "merge arming lane is closed for this company (mergeArmingEnabled=false) — no agent can re-enqueue the PR into the merge queue";
        if (refusedHead) {
          // SUP-15315 (AC2): durable refusal row — the live head is not covered
          // by an authorized head, so no re-enqueue row is written for it.
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: "system",
            actorId: DONE_CLOSE_LANDING_ACTOR_ID,
            agentId: null,
            runId: null,
            agentApiKeyId: null,
            action: DONE_CLOSE_LANDING_REENQUEUE_REFUSED_ACTION,
            entityType: "issue",
            entityId: issue.id,
            issueId: issue.id,
            details: {
              identifier: issue.identifier ?? null,
              pr: prKey,
              headSha: refusedHead.headSha,
              approvedHeadSha: refusedHead.approvedHeadSha,
              reason: refusedHead.reason,
            },
          });
        }
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: DONE_CLOSE_LANDING_ACTOR_ID,
          agentId: null,
          runId: null,
          agentApiKeyId: null,
          action: DONE_CLOSE_LANDING_ESCALATED_ACTION,
          entityType: "issue",
          entityId: issue.id,
          issueId: issue.id,
          details: {
            identifier: issue.identifier ?? null,
            pr: prKey,
            prState: "open",
            reason,
            skipReason: skipReason ?? null,
            refusal: isArmingRefusal,
          },
        });
        await deps.svc.addComment(
          issue.id,
          deliveryRefusal
            ? `[Done-close landing] ${issue.identifier ?? "(unknown issue)"}: PR ${prKey} cannot be re-enqueued — ${deliveryRefusal.reason}. The backstop will not arm a merge on a PR this card did not deliver.`
            : reenqueueExhausted
              ? `[Done-close landing] ${issue.identifier ?? "(unknown issue)"}: PR ${prKey} is still open past the done-close grace window after ${MAX_REENQUEUE_ATTEMPTS} re-enqueue attempts — the merge queue is not landing it (${reason}). Board/operator must fix the PR (checks/conflicts/rebase) and merge it, or re-open the card.`
              : refusedHead
                ? `[Done-close landing] ${issue.identifier ?? "(unknown issue)"}: PR ${prKey} cannot be re-enqueued — ${refusedHead.reason}. Re-review and re-approve the PR at its current head to re-stamp paperclip/approved (or land it through the review lane); the merge queue will not arm an unauthorized head.`
                : ejectionRefusal
                  ? `[Done-close landing] ${issue.identifier ?? "(unknown issue)"}: PR ${prKey} cannot be re-enqueued — ${ejectionRefusal.reason}. Rebase the branch onto the base branch to produce a new head; the sweep re-enqueues a conflict-ejected PR automatically once its head has moved.`
                  : `[Done-close landing] ${issue.identifier ?? "(unknown issue)"}: PR ${prKey} is still open past the done-close grace window and cannot be re-enqueued by an agent — ${reason}. Board/operator must manually enable merge arming or merge the PR.`,
          {},
          { authorType: "system" },
        );
        await deps.svc.update(issue.id, {
          status: "blocked",
          unblockDescriptor: {
            owner: "board",
            action: deliveryRefusal
              ? `File the deliverable under a project bound to ${deliveryRefusal.headRepo} (ADR-091 D5); ${prKey} is not this card's delivery repo (${deliveryRefusal.deliveryRepo}), so the backstop will not re-enqueue it`
              : reenqueueExhausted
                ? `Fix and merge PR ${prKey} (re-enqueued ${MAX_REENQUEUE_ATTEMPTS}x, still not landing — check CI checks, conflicts, or rebase onto the base branch) or re-open the card`
                : refusedHead
                  ? `Re-approve PR ${prKey} at its current head ${refusedHead.headSha.slice(0, 7)} to re-stamp paperclip/approved (approval stamp is ${refusedHead.approvedHeadSha ? `stranded on ${refusedHead.approvedHeadSha.slice(0, 7)}` : "missing"}) — re-review, not rebase/CI, is the unblock; the merge queue will not arm an unauthorized head`
                  : ejectionRefusal
                    ? `Rebase PR ${prKey} onto its base branch to produce a new head (last merge_conflict ejection left head ${ejectionRefusal.headSha.slice(0, 7)} unchanged) — the sweep re-enqueues it automatically once the head has moved`
                    : `Manually merge or re-enqueue PR ${prKey} into the merge queue (merge arming lane is ${mergeArmingEnabled ? "open but re-enqueue failed" : "closed for this company"})`,
          },
        });
        if (opts.wakeup && issue.assigneeAgentId) {
          await opts.wakeup(issue.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_commented",
            payload: { issueId: issue.id, mutation: "comment" },
          });
        }
        counts.escalated += 1;
      }
    }
  }

  /**
   * Reads the card's pinned approval-stamp head
   * (`executionState.approvalStatus.approvedHeadSha`), or null when the card has
   * no stamped head (e.g. an arming-refusal candidate).
   */
  async function readApprovedHeadSha(
    db: Db,
    issueId: string,
  ): Promise<string | null> {
    const row = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId));
    const state = row[0]?.executionState as Record<string, unknown> | null | undefined;
    const approvalStatus = state?.approvalStatus as
      | Record<string, unknown>
      | null
      | undefined;
    const sha = approvalStatus?.approvedHeadSha;
    return typeof sha === "string" && sha.length > 0 ? sha : null;
  }

  /**
   * SUP-15315: authorizes a PR's live head for the re-enqueue path. Resolves the
   * live head SHA; if it is covered by the card's pinned approval stamp it is
   * `authorized` without a second read (AC5). Otherwise the live head must carry
   * its own `paperclip/approved` success status, else the head is positively
   * UNSTAMPED → `refused`. Any unreadable head or status → `deferred` (fail
   * closed, AC4).
   */
  async function authorizeReenqueueHead(
    companyId: string,
    pr: LinkedPullRequest,
    approvedHeadSha: string | null,
  ): Promise<RequeueAuthorization> {
    const head = await fetchHeadViaTokenCandidates(
      db,
      companyId,
      pr.owner,
      pr.repo,
      pr.number,
    );
    if (!head.ok) return { kind: "deferred", reason: head.reason };
    const liveHeadSha = head.headSha;
    if (approvedHeadSha !== null && liveHeadSha === approvedHeadSha) {
      return { kind: "authorized" };
    }
    const status = await fetchHeadApprovedStatusViaTokenCandidates(
      db,
      companyId,
      pr.owner,
      pr.repo,
      liveHeadSha,
    );
    if (!status.ok) return { kind: "deferred", reason: status.reason };
    if (status.approved) return { kind: "authorized" };
    return {
      kind: "refused",
      headSha: liveHeadSha,
      approvedHeadSha,
      reason:
        approvedHeadSha !== null
          ? `approval stamp stranded: the card approved head ${approvedHeadSha.slice(0, 7)} but the live head is ${liveHeadSha.slice(0, 7)}, and that head carries no paperclip/approved success status`
          : `no valid approval on head: the live head ${liveHeadSha.slice(0, 7)} carries no paperclip/approved success status and the card has no pinned approvedHeadSha`,
    };
  }

  /**
   * SUP-15953: decide whether a still-open PR may be re-enqueued given its last
   * merge-queue ejection. A `merge_conflict` ejection on an UNCHANGED head cannot
   * be discharged by re-enqueueing — the same conflict ejects it again — so the
   * re-enqueue is refused until the head moves. "Head moved" is proven by the
   * live head commit's creation time POSTDATING the ejection (the same
   * head-changed-since-ejection predicate the SUP-15952 sweep uses), NOT by
   * comparing the head to the merge-queue group commit. `failed_checks` and every
   * other reason stay on the old behaviour (re-enqueue is the remedy). Fails
   * CLOSED (deferred) when the ejection read cannot be trusted.
   */
  async function authorizeReenqueueAfterEjection(
    companyId: string,
    pr: LinkedPullRequest,
  ): Promise<
    | { kind: "allow" }
    | { kind: "deferred" }
    | { kind: "refused"; headSha: string; reason: string; ejectedAt: string | null }
  > {
    const ejection = await fetchLastMergeQueueEjectionViaTokenCandidates(
      db,
      companyId,
      pr.owner,
      pr.repo,
      pr.number,
    );
    if (!ejection.ok) return { kind: "deferred" };
    if (ejection.lastEjection === null) return { kind: "allow" };
    // An ejection event whose reason could not be read is NOT evidence of a
    // non-conflict reason — fail closed rather than blind re-enqueue.
    if (ejection.lastEjection.reason === null) return { kind: "deferred" };
    if (ejection.lastEjection.reason !== "merge_conflict") return { kind: "allow" };
    // A `merge_conflict` ejection is discharged only by a NEW head: the live
    // head commit must postdate the ejection. `beforeCommit.oid` is the
    // merge-queue GROUP commit — a synthetic commit structurally distinct from
    // the PR head — so it is deliberately NOT compared here by oid; doing so
    // would treat every unchanged head as "moved" and blind-re-enqueue the
    // conflict. Finding:
    // merge-conflict-ejection-compares-head-to-queue-group-commit.
    const liveHeadSha = ejection.headRefOid;
    const headCommitAt = ejection.headCommitAt;
    const ejectedAt = ejection.lastEjection.createdAt;
    const headCommitMs = headCommitAt !== null ? Date.parse(headCommitAt) : NaN;
    const ejectedMs = ejectedAt !== null ? Date.parse(ejectedAt) : NaN;
    if (Number.isNaN(headCommitMs) || Number.isNaN(ejectedMs)) {
      // We cannot prove whether the head moved since the ejection — fail closed
      // rather than risk a blind re-enqueue of a conflict-ejected head.
      return { kind: "deferred" };
    }
    if (headCommitMs > ejectedMs) return { kind: "allow" };
    const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
    const shortHead = liveHeadSha.slice(0, 7);
    return {
      kind: "refused",
      headSha: liveHeadSha,
      ejectedAt,
      reason:
        `PR ${prKey} was ejected from the merge queue with reason "merge_conflict"` +
        `${ejectedAt ? ` at ${ejectedAt}` : ""}` +
        ` and its head ${shortHead} has not been re-pushed since — re-enqueueing the same head would hit the same conflict`,
    };
  }

  async function recordEjectionRefusal(
    issue: CandidateRow["issue"],
    prKey: string,
    refusal: { headSha: string; reason: string; ejectedAt: string | null },
    alreadyRefused: Set<string>,
  ): Promise<void> {
    const key = refusalKey(prKey, refusal.headSha, "merge_conflict");
    if (alreadyRefused.has(key)) return;
    alreadyRefused.add(key);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: DONE_CLOSE_LANDING_ACTOR_ID,
      agentId: null,
      runId: null,
      agentApiKeyId: null,
      action: DONE_CLOSE_LANDING_REENQUEUE_REFUSED_ACTION,
      entityType: "issue",
      entityId: issue.id,
      issueId: issue.id,
      details: {
        identifier: issue.identifier ?? null,
        pr: prKey,
        headSha: refusal.headSha,
        reason: refusal.reason,
        ejectionReason: "merge_conflict",
        ejectedAt: refusal.ejectedAt,
        refusalKind: "merge_conflict_head_unchanged",
      },
    });
  }

  async function attemptReenqueue(
    companyId: string,
    pr: LinkedPullRequest,
  ): Promise<boolean> {
    const tokenResult = await resolveGitHubTokenForRepo(db, companyId, pr.owner, pr.repo);
    if (!isGitHubTokenResolution(tokenResult)) {
      logger.info(
        { companyId, owner: pr.owner, repo: pr.repo, reason: tokenResult.reason },
        "done-close backstop: re-enqueue skipped — no GitHub token",
      );
      return false;
    }
    const nodeId = pr.nodeId
      ?? (await fetchGitHubNodeId(tokenResult.token, pr.owner, pr.repo, pr.number)).nodeId;
    if (!nodeId) {
      logger.info(
        { companyId, pr: `${pr.owner}/${pr.repo}#${pr.number}` },
        "done-close backstop: re-enqueue skipped — could not resolve PR node ID",
      );
      return false;
    }
    const result = await enableAutoMerge(tokenResult.token, nodeId);
    if (!result.success) {
      logger.info(
        { companyId, pr: `${pr.owner}/${pr.repo}#${pr.number}`, error: result.error },
        "done-close backstop: re-enqueue failed",
      );
      return false;
    }
    logger.info(
      { companyId, pr: `${pr.owner}/${pr.repo}#${pr.number}`, alreadyQueued: result.alreadyQueued },
      "done-close backstop: re-enqueued PR into merge queue",
    );
    return true;
  }

  return { sweep };
}
