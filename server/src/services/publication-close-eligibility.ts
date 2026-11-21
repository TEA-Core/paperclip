import { and, eq } from "drizzle-orm";
import { issueDeliveryReceipts, type Db } from "@paperclipai/db";
import type { PublicationCloseEligibility } from "@paperclipai/shared";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { resolveLinkedPullRequests } from "./merge-arming.js";

/**
 * Read-only projection of the three card-binding refusals on the accept path.
 * Each boolean uses the same leaf read that path uses, and true means that
 * path would return the matching reason. This function never writes.
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
  const linkedPullRequests = await resolveLinkedPullRequests(db, issue.companyId, issue.id, {
    includeDrafts: true,
  });
  return {
    deliveryIdentity: storedDelivery !== undefined && storedDelivery !== null,
    deliveryReceipt: receipt !== undefined,
    linkedPullRequest: linkedPullRequests.length > 0,
  };
}
