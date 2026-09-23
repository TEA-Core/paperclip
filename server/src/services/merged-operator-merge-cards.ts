import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issueRelations, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { isGitHubTokenResolution, resolveGitHubTokenForRepo } from "./github-credential.js";
import {
  extractGitHubPullRequestReferences,
  setBoundedPullRequestCacheEntry,
  type GitHubPullRequestReference,
} from "./github-pull-request-merge.js";
import {
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
  buildIssueBlockersResolvedWakeEmittedActivity,
  buildIssueBlockersResolvedWakeStateKey,
  findExistingIssueBlockersResolvedWakeForReadyState,
  type IssueBlockersResolvedWakeup,
} from "./issue-dependency-wakeups.js";
import {
  buildDependencyWakeWithheldActivity,
  DEPENDENCY_WAKE_WITHHELD_ACTION,
  readAttributedLandingDischarge,
  type AttributedLandingDischarge,
} from "./blocker-closure.js";
import {
  executeIssuePostCommitActions,
  issueService,
  type IssuePostCommitAction,
} from "./issues.js";
import {
  logActivity,
  logActivityInTransaction,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";

export const MERGED_OPERATOR_MERGE_CARDS_ACTOR_ID = "system:merged-operator-merge-cards";
export const MERGED_OPERATOR_MERGE_CARDS_CLOSED_ACTION = "issue.merged_operator_merge_card_closed";
export const MERGED_OPERATOR_MERGE_CARDS_WAKE_SOURCE = "issue.merged_operator_merge_card";

const CANDIDATE_ISSUE_STATUSES = ["backlog", "todo", "blocked", "in_progress"] as const;
const TERMINAL_ISSUE_STATUSES: ReadonlySet<string> = new Set(["done", "cancelled"]);
const DEFAULT_PULL_REQUEST_CACHE_TTL_MS = 5 * 60 * 1000;

export type MergedOperatorMergeCardPullRequestState = "merged" | "open" | "closed" | "unknown";

export interface MergedOperatorMergeCardPullRequestEvidence {
  state: MergedOperatorMergeCardPullRequestState;
  mergeCommitSha: string | null;
  mergedAt: string | null;
}

export type MergedOperatorMergeCardPullRequestResolver = (
  companyId: string,
  reference: GitHubPullRequestReference,
) => Promise<MergedOperatorMergeCardPullRequestEvidence>;

export type MergedOperatorMergeCardEnqueueWakeup = (
  agentId: string,
  wakeup: IssueBlockersResolvedWakeup,
) => Promise<unknown>;

export interface MergedOperatorMergeCardsSweepResult {
  /** Non-terminal, agent-unassigned issues the sweep scanned. */
  checked: number;
  /**
   * Candidates passing the full gate: no agent assignee, blocking a non-terminal
   * dependent, and opting in via a `Merge-gate:` marker that names at least one
   * gating pull request. Cards that only cite pull requests in prose (no marker)
   * are excluded and never counted here.
   */
  candidates: number;
  closed: number;
  woken: number;
}

export interface MergedOperatorMergeCardSweepOptions {
  /**
   * Pull-request evidence resolver. Defaults to a live GitHub fetch per
   * reference (see createMergedOperatorMergeCardPullRequestResolver).
   */
  resolvePullRequest?: MergedOperatorMergeCardPullRequestResolver;
  /** Wakeup enqueue, wired to `heartbeat.wakeup` in server/src/index.ts. */
  enqueueWakeup?: MergedOperatorMergeCardEnqueueWakeup;
  /** TTL for the per-process pull-request evidence cache. */
  pullRequestCacheTtlMs?: number;
  now?: () => Date;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function pullRequestEvidenceKey(
  companyId: string,
  reference: GitHubPullRequestReference,
): string {
  return `${companyId}:${reference.owner.toLowerCase()}/${reference.repo.toLowerCase()}#${reference.number}`;
}

/** Per-card advisory-lock key: serializes concurrent closes of the same card. */
function mergedOperatorMergeCardLockKey(companyId: string, cardId: string): string {
  return `merged-operator-merge-card:${companyId}:${cardId}`;
}

const UNMEASURABLE_EVIDENCE: MergedOperatorMergeCardPullRequestEvidence = {
  state: "unknown",
  mergeCommitSha: null,
  mergedAt: null,
};

/**
 * Live GitHub resolver for merge evidence. One GET per pull request returning
 * the fields the evidence comment needs (`merge_commit_sha`, `merged_at`) plus
 * the merged/open/closed state. Unmeasurable (network failure, 404, bad body,
 * stale credential that cannot fall back) resolves to "unknown" so the sweep
 * defers that card to a later pass instead of closing on stale evidence.
 */
export function createMergedOperatorMergeCardPullRequestResolver(
  db: Db,
  fetchImpl: FetchLike = (url, init) => ghFetch(url, init),
): MergedOperatorMergeCardPullRequestResolver {
  return async (companyId, reference) => {
    let token: string | null = null;
    try {
      const result = await resolveGitHubTokenForRepo(db, companyId, reference.owner, reference.repo);
      if (isGitHubTokenResolution(result)) token = result.token.trim() || null;
    } catch (err) {
      logger.warn(
        { err, companyId, reference },
        "merged operator merge-card sweep: GitHub token resolution failed; deferring",
      );
      return { ...UNMEASURABLE_EVIDENCE };
    }

    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "paperclip-merged-operator-merge-cards",
      "x-github-api-version": "2022-11-28",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}/pulls/${reference.number}`;

    let response: Response;
    try {
      response = await fetchImpl(url, { headers });
    } catch (err) {
      logger.warn(
        { err, companyId, reference },
        "merged operator merge-card sweep: pull-request fetch failed; deferring",
      );
      return { ...UNMEASURABLE_EVIDENCE };
    }

    if (response.status === 401 && token) {
      const { authorization: _dropped, ...anonymousHeaders } = headers;
      try {
        const anonymous = await fetchImpl(url, { headers: anonymousHeaders });
        if (anonymous.ok) response = anonymous;
      } catch {
        // Keep the 401 — the card defers this pass.
      }
    }

    if (response.status === 404 || !response.ok) {
      return { ...UNMEASURABLE_EVIDENCE };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      logger.warn(
        { err, companyId, reference },
        "merged operator merge-card sweep: pull-request body was not JSON; deferring",
      );
      return { ...UNMEASURABLE_EVIDENCE };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { ...UNMEASURABLE_EVIDENCE };
    }

    const record = body as Record<string, unknown>;
    const merged =
      record.merged === true ||
      (typeof record.merged_at === "string" && record.merged_at.length > 0);
    const state: MergedOperatorMergeCardPullRequestState = merged
      ? "merged"
      : record.state === "closed"
        ? "closed"
        : record.state === "open"
          ? "open"
          : "unknown";
    return {
      state,
      mergeCommitSha:
        typeof record.merge_commit_sha === "string" && record.merge_commit_sha.length > 0
          ? record.merge_commit_sha
          : null,
      mergedAt: merged && typeof record.merged_at === "string" ? record.merged_at : null,
    };
  };
}

/**
 * Marker a merge card carries to opt in to the sweep. A card is a merge-card
 * candidate only when it names its gating pull request(s) on a line beginning
 * with `Merge-gate:` (case-insensitive, optional list bullet or markdown
 * emphasis). A PR cited anywhere else in the body — Out-of-scope, Context,
 * Supersedes, background prose, a cited precedent — is context, not a gate, and
 * must not make the card a candidate. Absence of the marker means "not a merge
 * card"; the sweep fails closed rather than closing a card on prose context.
 *
 * Reuses `extractGitHubPullRequestReferences` over the marker payload(s) so the
 * accepted reference shapes (owner/repo#N shorthand, full pull URL) are
 * unchanged; only the SOURCE of the references narrows from the whole body to
 * the opt-in marker.
 */
const MERGE_GATE_MARKER_LINE =
  /^\s*(?:[-*+]\s+)?\*{0,2}merge[-_ ]?gate\*{0,2}\s*[:：]\s*(\S.*)$/i;

export function extractMergedOperatorMergeCardGateReferences(
  values: readonly unknown[],
): GitHubPullRequestReference[] {
  const payloads: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    for (const line of value.split(/\r?\n/)) {
      const match = line.match(MERGE_GATE_MARKER_LINE);
      if (match) payloads.push(match[1]!);
    }
  }
  if (payloads.length === 0) return [];
  return extractGitHubPullRequestReferences(payloads);
}

/**
 * Closes satisfied operator merge cards: non-terminal, agent-unassigned issues
 * that opt in via a `Merge-gate:` marker naming one or more pull requests, every
 * one of which has merged, and which are blocking at least one non-terminal
 * dependent. The card is a stale gate — the operator merge already happened —
 * so the sweep records the evidence, closes the card, and fires the standard
 * issue_blockers_resolved wake for each wakeable dependent.
 */
export function createMergedOperatorMergeCardSweepService(
  db: Db,
  opts: MergedOperatorMergeCardSweepOptions = {},
) {
  const pullRequestEvidenceCache = new Map<
    string,
    { evidence: MergedOperatorMergeCardPullRequestEvidence; checkedAt: number }
  >();
  const now = opts.now ?? (() => new Date());
  const cacheTtlMs = opts.pullRequestCacheTtlMs ?? DEFAULT_PULL_REQUEST_CACHE_TTL_MS;
  const resolvePullRequest =
    opts.resolvePullRequest ?? createMergedOperatorMergeCardPullRequestResolver(db);
  const issueSvc = issueService(db);

  type WakeableDependents = Awaited<
    ReturnType<ReturnType<typeof issueService>["listWakeableBlockedDependents"]>
  >;

  async function resolvePullRequestEvidence(
    companyId: string,
    reference: GitHubPullRequestReference,
  ): Promise<MergedOperatorMergeCardPullRequestEvidence> {
    const key = pullRequestEvidenceKey(companyId, reference);
    const checkedAt = now().getTime();
    const cached = pullRequestEvidenceCache.get(key);
    if (cached && checkedAt - cached.checkedAt < cacheTtlMs) {
      return cached.evidence;
    }
    let evidence: MergedOperatorMergeCardPullRequestEvidence;
    try {
      evidence = await resolvePullRequest(companyId, reference);
    } catch (err) {
      logger.warn(
        { err, companyId, reference },
        "merged operator merge-card sweep: pull-request evidence resolution threw; deferring",
      );
      evidence = { ...UNMEASURABLE_EVIDENCE };
    }
    // Unmeasurable evidence is not cached: a transient failure must not defer
    // the close by the full TTL.
    if (evidence.state !== "unknown") {
      setBoundedPullRequestCacheEntry(pullRequestEvidenceCache, key, {
        evidence,
        checkedAt,
      });
    }
    return evidence;
  }

  async function sweepMergedOperatorMergeCards(): Promise<MergedOperatorMergeCardsSweepResult> {
    const result: MergedOperatorMergeCardsSweepResult = {
      checked: 0,
      candidates: 0,
      closed: 0,
      woken: 0,
    };

    const checkedRows = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        description: issues.description,
        status: issues.status,
      })
      .from(issues)
      .where(
        and(
          inArray(issues.status, [...CANDIDATE_ISSUE_STATUSES]),
          isNull(issues.assigneeAgentId),
        ),
      );
    result.checked = checkedRows.length;
    if (checkedRows.length === 0) return result;

    const blockingRelations = await db
      .select({
        blockerId: issueRelations.issueId,
        dependentStatus: issues.status,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
      .where(
        and(
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.issueId, checkedRows.map((row) => row.id)),
        ),
      );
    const blockingCardIds = new Set(
      blockingRelations
        .filter((row) => !TERMINAL_ISSUE_STATUSES.has(row.dependentStatus))
        .map((row) => row.blockerId),
    );

    const candidates = checkedRows
      .filter((row) => blockingCardIds.has(row.id))
      .map((row) => ({
        row,
        references: extractMergedOperatorMergeCardGateReferences([
          row.title,
          row.description,
        ]),
      }))
      .filter((candidate) => candidate.references.length > 0);
    result.candidates = candidates.length;
    if (candidates.length === 0) return result;

    for (const { row, references } of candidates) {
      const evidence = new Map<string, MergedOperatorMergeCardPullRequestEvidence>();
      let allMerged = true;
      for (const reference of references) {
        const item = await resolvePullRequestEvidence(row.companyId, reference);
        evidence.set(pullRequestEvidenceKey(row.companyId, reference), item);
        if (item.state !== "merged") {
          allMerged = false;
          break;
        }
      }
      if (!allMerged) continue;

      const evidenceLines = references.map((reference) => {
        const item = evidence.get(pullRequestEvidenceKey(row.companyId, reference))!;
        const mergedAt = item.mergedAt ? ` at ${item.mergedAt}` : "";
        const sha = item.mergeCommitSha ? `, merge commit \`${item.mergeCommitSha}\`` : "";
        return `- \`${reference.owner}/${reference.repo}#${reference.number}\` — merged${mergedAt}${sha}`;
      });
      const commentBody = [
        `**Merged operator merge card — closed by \`${MERGED_OPERATOR_MERGE_CARDS_ACTOR_ID}\`.**`,
        "",
        "Every pull request named on this card has merged, so the operator action it records has already happened. This sweep only records the accomplished fact and closes the card so its dependent cards stop parking behind a satisfied gate.",
        "",
        ...evidenceLines,
      ].join("\n");

      // The candidate scan is a snapshot; the close happens under a per-card
      // advisory lock so two concurrent sweeps (this process or another) cannot
      // both close the card or both write the withhold audit. Discharge read,
      // comment, terminal write and audit rows share one transaction: a failure
      // anywhere rolls back the whole close, so the card never becomes terminal
      // without its wake/audit decision (SUP-17166 round-2 repair).
      const publications: ActivityPublication[] = [];
      const postCommitActions: IssuePostCommitAction[] = [];
      let decision:
        | { discharge: AttributedLandingDischarge; dependents: WakeableDependents }
        | null;
      try {
        decision = await db.transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          // Hold the per-card advisory lock for the whole transaction so the
          // status re-check, the close, and the audit inserts are one atomic
          // unit at the database write boundary. pg_advisory_xact_lock is
          // released when the transaction commits/rolls back.
          await txDb.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${mergedOperatorMergeCardLockKey(row.companyId, row.id)}, 0))`,
          );
          const current = await txDb
            .select({ id: issues.id, status: issues.status })
            .from(issues)
            .where(eq(issues.id, row.id))
            .then((rows) => rows[0] ?? null);
          if (
            !current ||
            !(CANDIDATE_ISSUE_STATUSES as readonly string[]).includes(current.status)
          ) {
            return null;
          }
          const issueSvcTx = issueService(txDb);
          // SUP-17092/A (ADR-091 D1): this merge-card sweep is an
          // issue_blockers_resolved producer. Withhold each dependent's wake
          // when the RESOLVED BLOCKER's landing was attributed away to a shared
          // carrier: a done card that discharged no delivery on the shared
          // branch must not fire a phantom cascade into the cards blocked on
          // it. The card is the resolved blocker; the discharge is a property
          // of that blocker, shared by all of its dependents.
          //
          // Read/validate the discharge BEFORE the terminal close: if the read
          // throws, the transaction aborts and the card is never left
          // permanently done with its wake/audit decision lost. This is the
          // explicit recoverable failure path — the card stays scannable
          // (CANDIDATE_ISSUE_STATUSES) and the next sweep re-derives the
          // decision from live state. The close runs in the same transaction,
          // so any later failure rolls the terminal write back too.
          // Level-triggered: clause 2 of the predicate reads live
          // executionState, so a later cleared publishSkipped re-emits the
          // wake when the card is reconsidered.
          const discharge = await readAttributedLandingDischarge(
            txDb,
            row.companyId,
            row.id,
          );
          // addComment/update run through the pool-based service with the tx
          // passed explicitly: passing the tx handle as the service's own
          // connection would make update's internal `dbOrTx === db` check open
          // a nested transaction on the tx handle.
          await issueSvc.addComment(row.id, commentBody, {}, {
            authorType: "system",
          }, txDb);
          const updated = await issueSvc.update(
            row.id,
            { status: "done" },
            txDb,
            publications,
            postCommitActions,
          );
          if (!updated) {
            throw new Error("merged operator merge card vanished before close");
          }
          // Dependent readiness requires the card to be done, so read it after
          // the (still uncommitted) terminal write, in this same transaction.
          const dependents =
            await issueSvcTx.listWakeableBlockedDependents(row.id);
          if (discharge.attributed) {
            // Withhold: enqueue zero agent_wakeup_requests for each wakeable
            // dependent and write exactly one durable
            // issue.dependency_wake_withheld row carrying the verbatim refusal
            // reason, the dependent id, the resolved-blocker id, and the
            // carrier identifier. The advisory lock serializes concurrent
            // closes of this card at the database write boundary; the check
            // below keeps re-closes after a re-open to at most one row per
            // (dependent, resolved blocker, producer).
            for (const dependent of dependents) {
              const alreadyWithheld = await txDb
                .select({ id: activityLog.id })
                .from(activityLog)
                .where(
                  and(
                    eq(activityLog.companyId, row.companyId),
                    eq(activityLog.action, DEPENDENCY_WAKE_WITHHELD_ACTION),
                    eq(activityLog.entityType, "issue"),
                    eq(activityLog.entityId, dependent.id),
                    sql`${activityLog.details}->>'resolvedBlockerIssueId' = ${row.id}`,
                    sql`${activityLog.details}->>'producer' = ${MERGED_OPERATOR_MERGE_CARDS_WAKE_SOURCE}`,
                  ),
                )
                .limit(1);
              if (alreadyWithheld.length === 0) {
                await logActivityInTransaction(
                  txDb,
                  buildDependencyWakeWithheldActivity({
                    companyId: row.companyId,
                    agentId: dependent.assigneeAgentId,
                    runId: null,
                    agentApiKeyId: null,
                    dependentIssueId: dependent.id,
                    resolvedBlockerIssueId: row.id,
                    blockerIssueIds: dependent.blockerIssueIds,
                    producer: MERGED_OPERATOR_MERGE_CARDS_WAKE_SOURCE,
                    discharge,
                  }),
                );
              }
            }
          }
          return { discharge, dependents };
        });
      } catch (err) {
        logger.warn(
          { err, cardId: row.id, companyId: row.companyId },
          "merged operator merge-card sweep: close transaction failed; card stays open and the next sweep retries",
        );
        continue;
      }
      if (!decision) continue;
      for (const publication of publications) publishActivity(publication);
      await executeIssuePostCommitActions(db, postCommitActions);
      const { discharge, dependents } = decision;

      const enqueued: Array<{
        dependent: { id: string; assigneeAgentId: string; blockerIssueIds: string[] };
        wakeup: IssueBlockersResolvedWakeup;
      }> = [];
      if (!discharge.attributed) {
        for (const dependent of dependents) {
          // Upstream's level-triggered ready-state key: one wake per dependency-ready
          // state, rather than one per resolved blocker edge. The wake body itself is
          // unchanged, so `issue.blockers_resolved_wake_emitted` consumers still match.
          const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({
            dependentIssueId: dependent.id,
            blockerIssueIds: dependent.blockerIssueIds,
            blockedTransitionAt: dependent.blockedTransitionAt,
          });
          const wakeup: IssueBlockersResolvedWakeup = {
            source: "automation",
            triggerDetail: "system",
            reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
            payload: {
              issueId: dependent.id,
              resolvedBlockerIssueId: row.id,
              blockerIssueIds: dependent.blockerIssueIds,
              mutation: "blocker_done",
            },
            idempotencyKey,
            requestedByActorType: "system",
            requestedByActorId: MERGED_OPERATOR_MERGE_CARDS_ACTOR_ID,
            contextSnapshot: {
              issueId: dependent.id,
              taskId: dependent.id,
              wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
              source: MERGED_OPERATOR_MERGE_CARDS_WAKE_SOURCE,
              resolvedBlockerIssueId: row.id,
              blockerIssueIds: dependent.blockerIssueIds,
            },
          };
          try {
            const existingWake = await findExistingIssueBlockersResolvedWakeForReadyState(db, {
              companyId: row.companyId,
              dependentIssueId: dependent.id,
              blockerIssueIds: dependent.blockerIssueIds,
              blockedTransitionAt: dependent.blockedTransitionAt,
            });
            if (existingWake) continue;
          } catch (err) {
            logger.warn(
              { err, dependentIssueId: dependent.id, idempotencyKey },
              "merged operator merge-card sweep: wake dedupe lookup failed; attempting enqueue",
            );
          }
          if (!opts.enqueueWakeup) continue;
          try {
            await opts.enqueueWakeup(dependent.assigneeAgentId, wakeup);
          } catch (err) {
            logger.warn(
              { err, dependentIssueId: dependent.id },
              "merged operator merge-card sweep: issue_blockers_resolved wake enqueue failed",
            );
            continue;
          }
          result.woken += 1;
          enqueued.push({ dependent, wakeup });
        }
      }

      await logActivity(db, {
        companyId: row.companyId,
        actorType: "system",
        actorId: MERGED_OPERATOR_MERGE_CARDS_ACTOR_ID,
        agentId: null,
        runId: null,
        agentApiKeyId: null,
        action: MERGED_OPERATOR_MERGE_CARDS_CLOSED_ACTION,
        entityType: "issue",
        entityId: row.id,
        issueId: row.id,
        details: {
          identifier: row.identifier ?? null,
          pullRequests: references.map(
            (reference) => `${reference.owner}/${reference.repo}#${reference.number}`,
          ),
          mergeCommits: Object.fromEntries(
            references.map((reference) => {
              const item = evidence.get(pullRequestEvidenceKey(row.companyId, reference))!;
              return [
                `${reference.owner}/${reference.repo}#${reference.number}`,
                { mergeCommitSha: item.mergeCommitSha, mergedAt: item.mergedAt },
              ];
            }),
          ),
          dependentsWoken: enqueued.length,
        },
      });

      for (const { dependent, wakeup } of enqueued) {
        await logActivity(
          db,
          buildIssueBlockersResolvedWakeEmittedActivity({
            companyId: row.companyId,
            emittedBy: MERGED_OPERATOR_MERGE_CARDS_WAKE_SOURCE,
            agentId: dependent.assigneeAgentId,
            runId: null,
            agentApiKeyId: null,
            wakeup,
            wakeupRunId: null,
            fallbackDependentIssueId: dependent.id,
            defaultSource: MERGED_OPERATOR_MERGE_CARDS_WAKE_SOURCE,
          }),
        );
      }

      result.closed += 1;
    }

    return result;
  }

  return { sweepMergedOperatorMergeCards };
}
