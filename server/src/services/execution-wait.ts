import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";
import { isDeferrableWakeSkipReason } from "./wake-skip-classification.js";

type WakeRequest = typeof agentWakeupRequests.$inferInsert;

/**
 * Record a known gate without inventing an execution attempt. The caller holds
 * the company-scoped issue row lock. Only replaceable automatic signals may
 * coalesce; messages and authorized interaction receipts keep their identity.
 * These receipts are diagnostics, never authority to suppress a future wake:
 * admission must read the current gate again before calling this function.
 *
 * The pending/finished marker follows the SAME classification the replay sweep
 * reads (wake-skip-classification.ts). A deferrable reason describes a transient
 * instance condition — e.g. `execution_reconciliation_required`, a resolved
 * execution hold that is explicitly cleared only by later actual evidence — so
 * it must be written `finishedAt: null` and stay selectable by
 * `reconcileDeferredWakeupReplay`. Hard-coding `finishedAt: new Date()` here
 * wrote every execution-wait skip terminal, which is exactly the defect this
 * receipt path used to reintroduce after the classification was added
 * (SUP-16697). A terminal reason keeps its historical finished marker.
 */
export async function recordExecutionWait(
  tx: Db,
  input: {
    issueId: string;
    request: WakeRequest;
    condition: Record<string, unknown>;
    coalesce: boolean;
  },
): Promise<{ created: boolean }> {
  const { request, issueId, condition } = input;
  const digest = createHash("sha256")
    .update(JSON.stringify([request.companyId, request.agentId, issueId, request.reason, condition]))
    .digest("hex");
  const key = `execution-wait:${digest}`;
  // A deferrable receipt is pending (finishedAt null) and is the replay sweep's
  // CAS target. Only a still-pending one may absorb a repeat: coalescing into a
  // retired row would bump a finished diagnostic and let the sweep re-select the
  // same id. Terminal receipts keep their historical coalesce-into-the-row
  // behaviour, so this guard is scoped to the deferrable class.
  const coalesceIntoPendingOnly = isDeferrableWakeSkipReason(request.reason);
  if (input.coalesce) {
    const [existing] = await tx.select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, request.companyId),
        eq(agentWakeupRequests.agentId, request.agentId),
        eq(agentWakeupRequests.status, "skipped"),
        ...(coalesceIntoPendingOnly ? [isNull(agentWakeupRequests.finishedAt)] : []),
        eq(agentWakeupRequests.idempotencyKey, key),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
      )).limit(1);
    if (existing) {
      await tx.update(agentWakeupRequests).set({
        coalescedCount: sql`${agentWakeupRequests.coalescedCount} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(agentWakeupRequests.companyId, request.companyId),
        eq(agentWakeupRequests.id, existing.id),
      ));
      return { created: false };
    }
  }
  await tx.insert(agentWakeupRequests).values({
    ...request,
    status: "skipped",
    runId: null,
    finishedAt: isDeferrableWakeSkipReason(request.reason) ? null : new Date(),
    idempotencyKey: input.coalesce ? key : request.idempotencyKey,
    payload: {
      ...request.payload,
      issueId,
      executionWait: { ...condition, requestedIdempotencyKey: request.idempotencyKey ?? null },
    },
  });
  return { created: true };
}
