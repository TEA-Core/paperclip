import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { issueService } from "./issues.js";
import {
  resolveLinkedPullRequestsWithState,
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

export const DONE_CLOSE_LANDING_ACTOR_ID = "system:done-close-landing-backstop";
export const DONE_CLOSE_LANDING_CONFIRMED_ACTION = "issue.done_close_landing_confirmed";
export const DONE_CLOSE_LANDING_FAILED_ACTION = "issue.done_close_landing_failed";
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
}

export type MeasuredPullRequestState = "merged" | "closed" | "open";

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

  const issueIdAsText = sql<string>`${issues.id}::text`;

  async function sweep(): Promise<DoneCloseLandingSweepResult> {
    const checkedAt = now();
    // The heartbeat tick fires every 30s; GitHub measurement is expensive, so
    // every non-due tick is a no-op.
    if (lastRunAt !== null && checkedAt.getTime() - lastRunAt < sweepIntervalMs) {
      return { due: false, candidates: 0, confirmed: 0, failed: 0, deferred: 0 };
    }
    lastRunAt = checkedAt.getTime();
    const result: DoneCloseLandingSweepResult = {
      due: true,
      candidates: 0,
      confirmed: 0,
      failed: 0,
      deferred: 0,
    };

    const windowStart = new Date(checkedAt.getTime() - lookbackMs);
    const graceCutoff = new Date(checkedAt.getTime() - graceMs);
    // Two candidate sources for a done card whose merge provably cannot enter the
    // merge queue via the approved path, both recorded as first-class, queryable
    // activity rows:
    //   1. decision-carried close: the done-transition guard recorded an
    //      `issue.done_transition_guard_skipped` row whose reason carries the
    //      `open_linked_prs_decision_carried:` prefix (SUP-13352) — the merge was
    //      armed but we now audit whether it landed.
    //   2. arming refusal on close (SUP-14900): the post-approval hook recorded an
    //      `issue.merge_arming_refused_on_close` row when a closing transition's
    //      arming REFUSED (head_unresolvable, …). The guard could not see this case
    //      (no PR resolvable at transition time), so the card-side sweep is the only
    //      thing that can key on it and surface a linked PR that is still open/unmerged.
    const rows = await db
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

    // A card can be approved -> changes-requested -> approved again: keep only
    // the LATEST transition-of-record per issue.
    const latestByIssue = new Map<string, CandidateRow>();
    for (const row of rows) {
      const existing = latestByIssue.get(row.issue.id);
      if (!existing || row.createdAt.getTime() > existing.createdAt.getTime()) {
        latestByIssue.set(row.issue.id, row);
      }
    }
    const candidates = [...latestByIssue.values()].filter((row) => {
      if (row.issue.status !== "done") return false;
      const createdAt = row.createdAt.getTime();
      if (createdAt < windowStart.getTime() || createdAt > graceCutoff.getTime()) return false;
      const details = readRecord(row.details);
      const isDecisionCarried =
        readString(details?.reason)?.startsWith(DECISION_CARRIED_SKIP_REASON_PREFIX) === true;
      const isArmingRefused = readString(details?.refusalReason) !== null;
      return isDecisionCarried || isArmingRefused;
    });
    result.candidates = candidates.length;
    if (candidates.length === 0) return result;

    const provider = createGitHubExternalObjectProvider(db);
    const resolver = provider.resolvers.find((candidate) => candidate.objectType === "pull_request") ?? null;
    const svc = issueService(db);

    for (const row of candidates) {
      const counts: SweepCounts = { confirmed: 0, failed: 0, deferred: 0 };
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
    const prs: LinkedPullRequest[] = await resolveLinkedPullRequestsWithState(
      db,
      issue.companyId,
      issue.id,
    );
    if (prs.length === 0) return;

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
            [DONE_CLOSE_LANDING_CONFIRMED_ACTION, DONE_CLOSE_LANDING_FAILED_ACTION],
          ),
        ),
      );
    const alreadyMeasured = new Set(
      existing
        .filter((r) =>
          r.action === DONE_CLOSE_LANDING_CONFIRMED_ACTION
          || r.action === DONE_CLOSE_LANDING_FAILED_ACTION)
        .map((r) => readString(readRecord(r.details)?.pr))
        .filter((value): value is string => value !== null),
    );

    for (const pr of prs) {
      const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
      if (alreadyMeasured.has(prKey)) continue;

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
      const action =
        state === "merged" ? DONE_CLOSE_LANDING_CONFIRMED_ACTION : DONE_CLOSE_LANDING_FAILED_ACTION;
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: DONE_CLOSE_LANDING_ACTOR_ID,
        agentId: null,
        runId: null,
        agentApiKeyId: null,
        action,
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
      if (state === "merged") {
        counts.confirmed += 1;
        continue;
      }

      // Closed-unmerged or still open past the grace window: surface attention.
      // A comment alone never wakes a closed issue (issues route skipWake), so
      // the assignee wake is required alongside it.
      const cause = isArmingRefusal
        ? `merge arming was REFUSED at close (${refusalReason}) and the approved head was never certified`
        : "the decision-carried merge never landed";
      await deps.svc.addComment(
        issue.id,
        `[Done-close landing] ${issue.identifier ?? "(unknown issue)"}: PR ${prKey} is ${state} past the done-close grace window — ${cause}. Re-open/merge the PR and verify the deliverable.`,
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
    }
  }

  return { sweep };
}
