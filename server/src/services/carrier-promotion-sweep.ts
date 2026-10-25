import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, externalObjectMentions, externalObjects, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { logActivity } from "./activity-log.js";
import { issueService } from "./issues.js";
import {
  isGitHubTokenResolution,
  markPullRequestReadyForReview,
  parseRepoUrl,
  resolveIssueRepoContext,
  resolveGitHubTokenCandidatesForRepo,
  resolveGitHubTokenForRepo,
} from "./merge-arming.js";

/**
 * Carrier promotion sweep (PR-CARRIER-3).
 *
 * This sweep flips a parent's draft carrier PR to ready-for-review when one
 * of two triggers fires: the parent's last child reaching terminal, via the
 * existing `getWakeableParentAfterChildCompletion`, or three-day age-cap
 * expiry. The age cap also covers parents that became done before their linked
 * draft was promoted. Cadence is the 1 h sweep slot: the heartbeat
 * tick fires the call every 30 s and the min-interval gate inside `sweep`
 * makes every non-due tick a no-op, as in `done-close-landing-backstop.ts`.
 *
 * A PR only counts as the parent's carrier when its cached head branch starts
 * with the parent's identifier (the carrier branch is the parent's
 * `{{identifier}}-{{slug}}` name, no prefix) and its base repository is the
 * parent's delivery repo. Immediately before promotion, a live read must
 * confirm that repository, head repository, exact branch and unchanged SHA.
 * The sequencing guard holds carrier N+1 while carrier N's external object still reads `open` —
 * merge-queue membership is unobservable, and a queued PR is still open.
 * Idempotence rides an activity row per (parent, PR): a carrier an earlier
 * sweep dispositioned is never re-promoted.
 */

const DEFAULT_AGE_CAP_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export const CARRIER_PROMOTION_ACTOR_ID = "system:carrier-promotion-sweep";
export const CARRIER_PROMOTION_READY_ACTION = "issue.carrier_promotion_ready";

const EXTERNAL_PR_PATTERN = /^([^/]+)\/([^/]+)#(pull|issues)\/([1-9][0-9]*)$/;

export interface CarrierPromotionSweepOptions {
  /** How long a draft carrier may sit before the age cap fires. */
  ageCapMs?: number;
  /** Minimum spacing between actual measurement runs. */
  sweepIntervalMs?: number;
  now?: () => Date;
}

export interface CarrierPromotionSweepResult {
  /** False when the min-interval gate short-circuited the tick (no-op). */
  due: boolean;
  /** Draft carrier PRs evaluated this tick. */
  candidates: number;
  promoted: number;
  /** Drafts already ready, or already dispositioned by an earlier sweep. */
  alreadyReady: number;
  /** Drafts held by the sequencing guard: an earlier carrier still reads open. */
  blocked: number;
  /** Drafts with no trigger yet (children not all terminal, age cap not reached). */
  noTrigger: number;
  failed: number;
}

interface DraftCarrierRow {
  sourceIssueId: string;
  mentionCreatedAt: Date;
  owner: string;
  repo: string;
  number: number;
  headRefName: string | null;
  prCreatedAt: string | null;
  headSha: string | null;
}

interface SiblingPullRequest {
  number: number;
  cachedState: string | null;
  headRefName: string | null;
}

type PromotionOutcome = "promoted" | "alreadyReady" | "failed";

/** Reads a positive-integer millisecond env var, falling back to `fallbackMs` on missing or invalid values. */
function readMsEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallbackMs;
}

/** Returns the value when it is a non-empty string, else null. */
function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Splits a `owner/repo#pull/123` external id into owner/repo/number, or null when not a pull request. */
function parseExternalPullRequest(externalId: string): { owner: string; repo: string; number: number } | null {
  const match = EXTERNAL_PR_PATTERN.exec(externalId);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!, number: Number(match[4]) };
}

/**
 * Extracts the head branch ref from a cached external object's data. The
 * canonical shape is the flat `headRef` key the GitHub external-object
 * provider writes (`pullRequestSnapshot` in
 * `github-external-object-provider.ts`); nested `head.ref` and flat
 * `headRefName` are tolerated for legacy cached rows.
 */
function headRefFromData(data: Record<string, unknown>): string | null {
  const flat = readString(data.headRef);
  if (flat) return flat;
  const head = data.head;
  if (head && typeof head === "object" && !Array.isArray(head)) {
    const ref = (head as Record<string, unknown>).ref;
    if (typeof ref === "string" && ref.length > 0) return ref;
  }
  return readString(data.headRefName);
}

/**
 * Builds the carrier promotion sweep service. `sweep` is meant to be fired by
 * the heartbeat tick every 30s; the min-interval gate inside makes non-due
 * ticks cheap no-ops.
 */
export function createCarrierPromotionSweepService(
  db: Db,
  opts: CarrierPromotionSweepOptions = {},
) {
  const ageCapMs = opts.ageCapMs ?? readMsEnv("CARRIER_PROMOTION_AGE_CAP_MS", DEFAULT_AGE_CAP_MS);
  const sweepIntervalMs = opts.sweepIntervalMs ?? readMsEnv("CARRIER_PROMOTION_SWEEP_INTERVAL_MS", DEFAULT_SWEEP_INTERVAL_MS);
  const now = opts.now ?? (() => new Date());
  let lastRunAt: number | null = null;

  /** Runs one sweep pass: gate on cadence, then discover, group, guard and promote. */
  async function sweep(): Promise<CarrierPromotionSweepResult> {
    const checkedAt = now();
    // The heartbeat tick fires every 30s; GitHub measurement is expensive, so
    // every non-due tick is a no-op.
    if (lastRunAt !== null && checkedAt.getTime() - lastRunAt < sweepIntervalMs) {
      return { due: false, candidates: 0, promoted: 0, alreadyReady: 0, blocked: 0, noTrigger: 0, failed: 0 };
    }
    lastRunAt = checkedAt.getTime();
    const result: CarrierPromotionSweepResult = {
      due: true,
      candidates: 0,
      promoted: 0,
      alreadyReady: 0,
      blocked: 0,
      noTrigger: 0,
      failed: 0,
    };

    const draftRows = await db
      .select({
        sourceIssueId: externalObjectMentions.sourceIssueId,
        mentionCreatedAt: externalObjectMentions.createdAt,
        externalId: externalObjects.externalId,
        data: externalObjects.data,
      })
      .from(externalObjectMentions)
      .innerJoin(externalObjects, eq(externalObjects.id, externalObjectMentions.objectId))
      .where(
        and(
          eq(externalObjectMentions.objectType, "pull_request"),
          eq(externalObjects.providerKey, "github"),
          sql`${externalObjects.data}->>'draft' = 'true'`,
          sql`${externalObjects.data}->>'state' = 'open'`,
        ),
      );

    const drafts: DraftCarrierRow[] = [];
    for (const row of draftRows) {
      const parsed = parseExternalPullRequest(row.externalId);
      if (!parsed) continue;
      drafts.push({
        sourceIssueId: row.sourceIssueId,
        mentionCreatedAt: row.mentionCreatedAt,
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
        headRefName: headRefFromData(row.data),
        headSha: readString(row.data.headSha),
        prCreatedAt: readString(row.data.created_at),
      });
    }
    if (drafts.length === 0) return result;

    // A carrier PR is mentioned on the child that first delivered it (or on
    // the parent itself); the carrier belongs to the source issue's parent,
    // or to the source issue when it has no parent.
    const sourceIds = [...new Set(drafts.map((draft) => draft.sourceIssueId))];
    const sourceIssues = await db
      .select({ id: issues.id, parentId: issues.parentId })
      .from(issues)
      .where(inArray(issues.id, sourceIds));
    const carrierParentBySource = new Map(
      sourceIssues.map((row) => [row.id, row.parentId ?? row.id]),
    );

    const draftsByParent = new Map<string, DraftCarrierRow[]>();
    for (const draft of drafts) {
      const parentId = carrierParentBySource.get(draft.sourceIssueId);
      if (!parentId) continue;
      const list = draftsByParent.get(parentId);
      if (list) list.push(draft);
      else draftsByParent.set(parentId, [draft]);
    }

    for (const [parentId, parentDrafts] of draftsByParent) {
      try {
        await sweepParent(parentId, parentDrafts, result, checkedAt);
      } catch (err) {
        logger.warn(
          { err, parentId },
          "carrier promotion sweep: parent sweep failed; will retry next sweep",
        );
      }
    }
    return result;
  }

  /** Evaluates one parent's draft carriers: sequencing guard, triggers, idempotence, then promotion. */
  async function sweepParent(
    parentId: string,
    parentDrafts: DraftCarrierRow[],
    result: CarrierPromotionSweepResult,
    checkedAt: Date,
  ) {
    const [parent] = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        identifier: issues.identifier,
        projectId: issues.projectId,
        projectWorkspaceId: issues.projectWorkspaceId,
        executionWorkspaceId: issues.executionWorkspaceId,
      })
      .from(issues)
      .where(eq(issues.id, parentId));
    if (!parent) return;
    // Done parents can still own a stranded draft carrier, so the age cap stays
    // available. Cancelled parents are the cancelled-parent case (PR-CARRIER-7), out of scope.
    if (parent.status === "cancelled") return;
    const prefix = (parent.identifier ?? "").toLowerCase();
    const repoContext = await resolveIssueRepoContext(db, parent);
    const deliveryRepo = parseRepoUrl(repoContext?.repoUrl ?? null);
    if (deliveryRepo?.hostname !== "github.com") return;
    if (!prefix) return;
    const carrierBranchPrefix = `${prefix}-`;
    const isCarrierBranch = (headRefName: string | null) =>
      headRefName !== null && headRefName.toLowerCase().startsWith(carrierBranchPrefix);

    const children = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, parent.companyId), eq(issues.parentId, parent.id)));
    const sourceIssueIds = [parent.id, ...children.map((child) => child.id)];

    // The sequencing guard needs the full sibling set (promoted carriers read
    // draft=false and are invisible to the draft-only discovery above).
    const siblingRows = await db
      .select({ externalId: externalObjects.externalId, data: externalObjects.data })
      .from(externalObjectMentions)
      .innerJoin(externalObjects, eq(externalObjects.id, externalObjectMentions.objectId))
      .where(
        and(
          inArray(externalObjectMentions.sourceIssueId, sourceIssueIds),
          eq(externalObjectMentions.companyId, parent.companyId),
          eq(externalObjectMentions.objectType, "pull_request"),
          eq(externalObjects.providerKey, "github"),
        ),
      );
    const siblings = new Map<number, SiblingPullRequest>();
    for (const row of siblingRows) {
      const parsed = parseExternalPullRequest(row.externalId);
      if (!parsed || siblings.has(parsed.number)) continue;
      siblings.set(parsed.number, {
        number: parsed.number,
        cachedState: readString(row.data.state),
        headRefName: headRefFromData(row.data),
      });
    }

    const candidates = parentDrafts
      .filter((draft) =>
        isCarrierBranch(draft.headRefName)
        && draft.owner.toLowerCase() === deliveryRepo.owner.toLowerCase()
        && draft.repo.toLowerCase() === deliveryRepo.repo.toLowerCase())
      .sort((a, b) => a.number - b.number);
    if (candidates.length === 0) return;
    result.candidates += candidates.length;

    // Trigger 1 — the parent's last child reached terminal. Evaluated once per
    // parent; null when any child is still live or the parent is not wakeable.
    const wakeable = await issueService(db).getWakeableParentAfterChildCompletion(parent.id);

    // Idempotence with no new column/table: any prior ready row for this
    // (parent, PR) means the carrier was already dispositioned by an earlier
    // sweep and must not be re-promoted.
    const existing = await db
      .select({ details: activityLog.details, action: activityLog.action })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, parent.id),
          eq(activityLog.action, CARRIER_PROMOTION_READY_ACTION),
        ),
      );
    const alreadyMeasured = new Set(
      existing
        .filter((row) => row.action === CARRIER_PROMOTION_READY_ACTION)
        .map((row) => readString(row.details?.pr))
        .filter((value): value is string => value !== null),
    );

    for (const draft of candidates) {
      const prKey = `${draft.owner}/${draft.repo}#${draft.number}`;
      if (alreadyMeasured.has(prKey)) {
        result.alreadyReady += 1;
        continue;
      }

      const earlierOpenCarrier = [...siblings.values()].find(
        (sibling) =>
          sibling.number < draft.number
          && sibling.cachedState === "open"
          && isCarrierBranch(sibling.headRefName),
      );
      if (earlierOpenCarrier) {
        result.blocked += 1;
        continue;
      }

      // Age anchors on the PR's created_at; a never-hydrated cached row falls
      // back to when the PR first appeared in-thread.
      const parsedCreated = draft.prCreatedAt ? new Date(draft.prCreatedAt) : null;
      const ageAnchor =
        parsedCreated !== null && !Number.isNaN(parsedCreated.getTime())
          ? parsedCreated
          : draft.mentionCreatedAt;
      const ageCapExpired = checkedAt.getTime() - ageAnchor.getTime() >= ageCapMs;
      if (!wakeable && !ageCapExpired) {
        result.noTrigger += 1;
        continue;
      }
      const trigger = wakeable ? "last_child_terminal" : "age_cap";

      const outcome = await promoteCarrier(draft, prKey, parent, trigger);
      if (outcome === "promoted") result.promoted += 1;
      else if (outcome === "alreadyReady") result.alreadyReady += 1;
      else result.failed += 1;
    }
  }

  /** Promotes one verified carrier PR: read live identity and head, flip to ready, log the activity row. */
  async function promoteCarrier(
    draft: DraftCarrierRow,
    prKey: string,
    parent: { companyId: string; id: string; identifier: string | null },
    trigger: "last_child_terminal" | "age_cap",
  ): Promise<PromotionOutcome> {
    const candidates = await resolveGitHubTokenCandidatesForRepo(db, parent.companyId, draft.owner, draft.repo);
    if (candidates.length === 0) {
      const tokenResult = await resolveGitHubTokenForRepo(db, parent.companyId, draft.owner, draft.repo);
      const reason = isGitHubTokenResolution(tokenResult)
        ? "No GitHub token resolvable"
        : tokenResult.reason;
      logger.warn({ pr: prKey, reason }, "carrier promotion sweep: no GitHub token candidates");
      return "failed";
    }

    for (const candidate of candidates) {
      const token = candidate.token;
      // The external-object row is a discovery hint, not permission to mutate:
      // read the live target immediately before the GraphQL write. The cached
      // head SHA is a compare-before-write anchor; a moved head retries only
      // after the provider refreshes the snapshot on a later sweep.
      const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(draft.owner)}/${encodeURIComponent(draft.repo)}/pulls/${draft.number}`;
      let response: Response;
      try {
        response = await ghFetch(url, {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "paperclip-carrier-promotion-sweep",
            "x-github-api-version": "2022-11-28",
            authorization: `Bearer ${token}`,
          },
        });
      } catch {
        return "failed";
      }
      if (!response.ok) {
        if ((response.status === 401 || response.status === 403) && candidate !== candidates[candidates.length - 1]) continue;
        return "failed";
      }
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      const head = body?.head as Record<string, unknown> | null | undefined;
      const headRepo = head?.repo as Record<string, unknown> | null | undefined;
      const deliveryRepo = `${draft.owner}/${draft.repo}`.toLowerCase();
      if (
        body?.state !== "open" || body.draft !== true ||
        typeof head?.ref !== "string" || head.ref !== draft.headRefName ||
        typeof headRepo?.full_name !== "string" || headRepo.full_name.toLowerCase() !== deliveryRepo ||
        typeof head?.sha !== "string" || !draft.headSha || head.sha !== draft.headSha ||
        typeof body.node_id !== "string" || !body.node_id
      ) return "failed";
      const outcome = await markPullRequestReadyForReview(token, body.node_id);
      if (outcome.success) {
        await logActivity(db, {
          companyId: parent.companyId,
          actorType: "system",
          actorId: CARRIER_PROMOTION_ACTOR_ID,
          agentId: null,
          runId: null,
          agentApiKeyId: null,
          action: CARRIER_PROMOTION_READY_ACTION,
          entityType: "issue",
          entityId: parent.id,
          issueId: parent.id,
          details: {
            identifier: parent.identifier ?? null,
            pr: prKey,
            trigger,
            prState: "ready",
          },
        });
        return outcome.alreadyReady ? "alreadyReady" : "promoted";
      }

      if (outcome.status === 401 || outcome.status === 403) {
        if (candidate !== candidates[candidates.length - 1]) continue;
      }
      logger.warn(
        { pr: prKey, status: outcome.status, error: outcome.error },
        "carrier promotion sweep: markPullRequestReadyForReview failed; will retry next sweep",
      );
      return "failed";
    }

    return "failed";
  }

  return { sweep };
}
