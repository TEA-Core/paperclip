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
  MERGE_ARMING_REFUSED_ON_CLOSE_ACTION,
  type LinkedPullRequest,
} from "./merge-arming.js";
import { createGitHubExternalObjectProvider } from "./github-external-object-provider.js";
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
// A PR re-enqueued into the merge queue can be EJECTED by the queue (failing
// checks, conflicts, behind the base branch) and left `open` again — in which
// case the confirm/failed/escalated branches are all unreachable for it. So the
// "already re-enqueued, skip" behavior is bounded to this many total re-enqueue
// attempts per (issue, PR): beyond it, a still-open PR is re-examined on the
// next sweep and escalates instead of being re-enqueued (or skipped) forever.
// The hourly sweep interval spaces the attempts out; the cap bounds the total,
// so the sweep cannot re-enqueue in a tight loop.
export const MAX_REENQUEUE_ATTEMPTS = 3;

export const DONE_CLOSE_LANDING_ACTOR_ID = "system:done-close-landing-backstop";
export const DONE_CLOSE_LANDING_CONFIRMED_ACTION = "issue.done_close_landing_confirmed";
export const DONE_CLOSE_LANDING_FAILED_ACTION = "issue.done_close_landing_failed";
export const DONE_CLOSE_LANDING_REENQUEUED_ACTION = "issue.done_close_landing_reenqueued";
export const DONE_CLOSE_LANDING_REENQUEUE_REFUSED_ACTION = "issue.done_close_landing_reenqueue_refused";
export const DONE_CLOSE_LANDING_ESCALATED_ACTION = "issue.done_close_landing_escalated";
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
export function buildDiscoveryQuery(db: Db, windowStart: Date, graceCutoff: Date) {
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
        lte(activityLog.createdAt, graceCutoff),
        eq(issues.status, "done"),
      ),
    );
}

/**
 * Qualify raw discovery rows into candidate cards: keep only the LATEST
 * transition-of-record per issue, require it to be `done` and inside the
 * lookback/grace window, and require it to carry a decision-carried skip reason
 * or an arming-refusal reason. Mirrors the discovery WHERE so a row the query
 * returns is always re-validated before it is measured.
 */
export function selectLandingCandidates(
  rows: CandidateRow[],
  windowStart: Date,
  graceCutoff: Date,
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
    if (createdAt < windowStart.getTime() || createdAt > graceCutoff.getTime()) return false;
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
  const lookbackMs = opts.lookbackMs ?? readMsEnv("DONE_CLOSE_LANDING_LOOKBACK_MS", DEFAULT_LOOKBACK_MS);
  const sweepIntervalMs = opts.sweepIntervalMs ?? readMsEnv("DONE_CLOSE_LANDING_SWEEP_INTERVAL_MS", DEFAULT_SWEEP_INTERVAL_MS);
  const now = opts.now ?? (() => new Date());
  let lastRunAt: number | null = null;

  async function sweep(): Promise<DoneCloseLandingSweepResult> {
    const checkedAt = now();
    // The heartbeat tick fires every 30s; GitHub measurement is expensive, so
    // every non-due tick is a no-op.
    if (lastRunAt !== null && checkedAt.getTime() - lastRunAt < sweepIntervalMs) {
      return { due: false, candidates: 0, confirmed: 0, failed: 0, deferred: 0, reenqueued: 0, escalated: 0 };
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
    };

    const windowStart = new Date(checkedAt.getTime() - lookbackMs);
    const graceCutoff = new Date(checkedAt.getTime() - graceMs);
    const rows = await buildDiscoveryQuery(db, windowStart, graceCutoff);
    const candidates = selectLandingCandidates(rows, windowStart, graceCutoff);
    result.candidates = candidates.length;
    if (candidates.length === 0) return result;

    const provider = createGitHubExternalObjectProvider(db);
    const resolver = provider.resolvers.find((candidate) => candidate.objectType === "pull_request") ?? null;
    const svc = issueService(db);

    for (const row of candidates) {
      const counts: SweepCounts = { confirmed: 0, failed: 0, deferred: 0, reenqueued: 0, escalated: 0 };
      try {
        await sweepCandidate(row, counts, { resolver, svc });
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
    }
    return result;
  }

  async function sweepCandidate(
    row: CandidateRow,
    counts: SweepCounts,
    deps: { resolver: ExternalObjectResolver | null; svc: ReturnType<typeof issueService> },
  ) {
    const issue = row.issue;
    const details = readRecord(row.details);
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
        { closingTransition: true },
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
      });
    }

    // Idempotency with no new column/table: any prior landing row for this
    // (issue, PR) means the pair was already dispositioned by an earlier sweep.
    const existing = await db
      .select({
        details: activityLog.details,
        action: activityLog.action,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issue.id),
          inArray(
            activityLog.action,
            [
              DONE_CLOSE_LANDING_CONFIRMED_ACTION,
              DONE_CLOSE_LANDING_FAILED_ACTION,
              DONE_CLOSE_LANDING_REENQUEUED_ACTION,
              DONE_CLOSE_LANDING_ESCALATED_ACTION,
            ],
          ),
        ),
      );
    const alreadyConfirmed = new Set(
      existing
        .filter((r) => r.action === DONE_CLOSE_LANDING_CONFIRMED_ACTION)
        .map((r) => readString(readRecord(r.details)?.pr))
        .filter((value): value is string => value !== null),
    );
    const alreadyFailed = new Set(
      existing
        .filter((r) => r.action === DONE_CLOSE_LANDING_FAILED_ACTION)
        .map((r) => readString(readRecord(r.details)?.pr))
        .filter((value): value is string => value !== null),
    );
    // SUP-15073: count prior re-enqueues per PR instead of treating the FIRST
    // one as terminal. A re-enqueued PR that the queue ejects is `open` again, so
    // the idempotency set must not suppress re-examination (or escalation)
    // indefinitely — it only caps how many times we attempt a re-enqueue.
    const reenqueueCounts = new Map<string, number>();
    for (const r of existing) {
      if (r.action !== DONE_CLOSE_LANDING_REENQUEUED_ACTION) continue;
      const prKey = readString(readRecord(r.details)?.pr);
      if (prKey === null) continue;
      reenqueueCounts.set(prKey, (reenqueueCounts.get(prKey) ?? 0) + 1);
    }
    const alreadyEscalated = new Set(
      existing
        .filter((r) => r.action === DONE_CLOSE_LANDING_ESCALATED_ACTION)
        .map((r) => readString(readRecord(r.details)?.pr))
        .filter((value): value is string => value !== null),
    );

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
      } catch {
        state = "unknown";
      }
      if (state === "unknown") {
        // Never `…_confirmed` on an unmeasured PR; retry on a later sweep.
        counts.deferred += 1;
        continue;
      }

      const closedAt =
        state === "merged"
          ? readString(data?.merged_at)
          : state === "closed"
            ? readString(data?.closed_at)
            : null;

      if (state === "merged") {
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
        // Closed-unmerged: surface attention (existing behavior).
        const cause = isArmingRefusal
          ? `merge arming was REFUSED at close (${refusalReason}) and the approved head was never certified`
          : "the decision-carried merge never landed";
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
          },
        });
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

      // state === "open" past the grace window: re-enqueue (bounded) or escalate.
      // A prior re-enqueue does NOT mean the PR will land: the merge queue ejects
      // PRs (failing checks, conflicts, behind the base branch) and an ejected PR
      // is `open` again — at which point the confirm/failed branches can't fire.
      // So "already re-enqueued → skip forever" is replaced with a bounded attempt
      // count: re-examine on every sweep, re-enqueue only while under the cap, and
      // once exhausted let a still-open PR fall through to the _escalated path.
      const priorReenqueues = reenqueueCounts.get(prKey) ?? 0;
      const reenqueueExhausted = priorReenqueues >= MAX_REENQUEUE_ATTEMPTS;

      // SUP-15315: head-authorization gate. Set when the live head is positively
      // UNSTAMPED (refused); the pair then falls through to the escalation path
      // below with the head-moved cause instead of being armed.
      let refusedHead: { headSha: string; approvedHeadSha: string | null; reason: string } | null = null;

      if (!reenqueueExhausted && mergeArmingEnabled) {
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

      // Escalate: re-enqueue cap exhausted (still open), lane closed, the
      // re-enqueue attempt failed this tick, or the live head was positively
      // UNSTAMPED (head-authorization refusal).
      if (!alreadyEscalated.has(prKey)) {
        const reason = reenqueueExhausted
          ? `the PR has been re-enqueued ${priorReenqueues} times and is still open past the done-close grace window — the merge queue is not landing it (e.g. failing checks, conflicts, or it is behind the base branch)`
          : refusedHead
            ? refusedHead.reason
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
          reenqueueExhausted
            ? `[Done-close landing] ${issue.identifier ?? "(unknown issue)"}: PR ${prKey} is still open past the done-close grace window after ${MAX_REENQUEUE_ATTEMPTS} re-enqueue attempts — the merge queue is not landing it (${reason}). Board/operator must fix the PR (checks/conflicts/rebase) and merge it, or re-open the card.`
            : refusedHead
              ? `[Done-close landing] ${issue.identifier ?? "(unknown issue)"}: PR ${prKey} cannot be re-enqueued — ${refusedHead.reason}. Re-review and re-approve the PR at its current head to re-stamp paperclip/approved (or land it through the review lane); the merge queue will not arm an unauthorized head.`
              : `[Done-close landing] ${issue.identifier ?? "(unknown issue)"}: PR ${prKey} is still open past the done-close grace window and cannot be re-enqueued by an agent — ${reason}. Board/operator must manually enable merge arming or merge the PR.`,
          {},
          { authorType: "system" },
        );
        await deps.svc.update(issue.id, {
          status: "blocked",
          unblockDescriptor: {
            owner: "board",
            action: reenqueueExhausted
              ? `Fix and merge PR ${prKey} (re-enqueued ${MAX_REENQUEUE_ATTEMPTS}x, still not landing — check CI checks, conflicts, or rebase onto the base branch) or re-open the card`
              : refusedHead
                ? `Re-approve PR ${prKey} at its current head ${refusedHead.headSha.slice(0, 7)} to re-stamp paperclip/approved (approval stamp is ${refusedHead.approvedHeadSha ? `stranded on ${refusedHead.approvedHeadSha.slice(0, 7)}` : "missing"}) — re-review, not rebase/CI, is the unblock; the merge queue will not arm an unauthorized head`
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
