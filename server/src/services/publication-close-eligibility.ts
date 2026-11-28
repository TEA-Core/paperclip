import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { externalObjectMentions, externalObjects, issueDeliveryReceipts, type Db } from "@paperclipai/db";
import type { PublicationCloseEligibility } from "@paperclipai/shared";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

/**
 * The external-id shape `resolveLinkedPullRequests` (merge-arming.ts) accepts,
 * as a PostgreSQL regular expression. Rows that do not match are skipped there,
 * so they are skipped here too.
 */
const LINKED_PULL_REQUEST_EXTERNAL_ID_PATTERN = "^[^/]+/[^/]+#(pull|issues)/[1-9][0-9]*$";

/**
 * The card's cached GitHub pull-request rows that `resolveLinkedPullRequests`
 * reads: company and issue scoped, any cached state, drafts included.
 */
function cachedLinkedPullRequestRowScope(companyId: string, issueId: string): SQL {
  return and(
    eq(externalObjectMentions.companyId, companyId),
    eq(externalObjectMentions.sourceIssueId, issueId),
    eq(externalObjectMentions.objectType, "pull_request"),
    eq(externalObjects.providerKey, "github"),
    sql`${externalObjects.externalId} ~ ${LINKED_PULL_REQUEST_EXTERNAL_ID_PATTERN}`,
  )!;
}

/**
 * The cached-state filter of `resolveLinkedPullRequests` with drafts included:
 * a row counts when its cached `state` key is absent or is the string "open".
 * `-> 'state' IS NULL` is true only when the key is absent (a JSON null value
 * is not SQL NULL), which matches the resolver's `state !== undefined` test.
 */
const CACHED_STATE_OPEN_OR_UNKNOWN = sql`(${externalObjects.data} -> 'state' IS NULL OR ${externalObjects.data} ->> 'state' = 'open')`;

/**
 * Read-only projection of the three card-binding refusals on the accept path.
 * This function never writes and never calls GitHub.
 *
 * `cachedLinkedPullRequest` is cached and advisory. It is the same cached read
 * the accept path uses for its linked-pull-request refusal. The done-close
 * guard instead refreshes pull-request state from GitHub and discovers pull
 * requests that no comment mentions, so the close can decide differently from
 * this value. `cachedLinkedPullRequestFetchedAt` is the oldest GitHub fetch
 * time among the cached rows the value reads. It is null when there is no such
 * row or when one of them was never fetched.
 *
 * Both pull-request reads are scoped existence reads with LIMIT 1; neither
 * loads the cached pull-request payloads.
 */
export async function readPublicationCloseEligibility(
  db: Db,
  issue: { id: string; companyId: string; executionState?: unknown },
): Promise<PublicationCloseEligibility> {
  const storedDelivery = parseIssueExecutionState(issue.executionState ?? null)?.delivery;
  const [receipt] = await db
    .select({ id: issueDeliveryReceipts.id })
    .from(issueDeliveryReceipts)
    .where(and(
      eq(issueDeliveryReceipts.companyId, issue.companyId),
      eq(issueDeliveryReceipts.sourceIssueId, issue.id),
    ))
    .limit(1);
  const rowScope = cachedLinkedPullRequestRowScope(issue.companyId, issue.id);
  const [linkedPullRequest] = await db
    .select({ id: externalObjects.id })
    .from(externalObjectMentions)
    .innerJoin(externalObjects, eq(externalObjects.id, externalObjectMentions.objectId))
    .where(and(rowScope, CACHED_STATE_OPEN_OR_UNKNOWN))
    .limit(1);
  const [oldestFetch] = await db
    .select({ lastResolvedAt: externalObjects.lastResolvedAt })
    .from(externalObjectMentions)
    .innerJoin(externalObjects, eq(externalObjects.id, externalObjectMentions.objectId))
    .where(rowScope)
    .orderBy(sql`${asc(externalObjects.lastResolvedAt)} NULLS FIRST`)
    .limit(1);
  return {
    deliveryIdentity: storedDelivery !== undefined && storedDelivery !== null,
    deliveryReceipt: receipt !== undefined,
    cachedLinkedPullRequest: linkedPullRequest !== undefined,
    cachedLinkedPullRequestFetchedAt: oldestFetch?.lastResolvedAt?.toISOString() ?? null,
  };
}
