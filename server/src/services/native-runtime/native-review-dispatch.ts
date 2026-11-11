import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { claimNativeReviewExecutionLock, isNativeReviewRunBoundToCommitterWake, isNativeReviewWakeProvenance, readNativeReviewAssignmentContext } from "./native-review-participant.js";

/** The run, wake, and issue lock form one reviewer admission claim. */
export async function claimQueuedNativeReviewRun(db: Db, input: {
  run: typeof heartbeatRuns.$inferSelect;
  agentNameKey: string | null;
  claimedAt: Date;
  claimValues: PgUpdateSetSource<typeof heartbeatRuns>;
}): Promise<typeof heartbeatRuns.$inferSelect | null> {
  const context = input.run.contextSnapshot as Record<string, unknown> | null;
  const issueId = context?.issueId;
  const reviewContext = readNativeReviewAssignmentContext(context);
  if (typeof issueId !== "string" || !reviewContext) return null;
  return db.transaction(async (tx) => {
    // Match the queue editor's lock order: issue, wake, then run.
    const [issue] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, issueId), eq(issues.companyId, input.run.companyId),
    )).for("update");
    if (!issue) return null;
    if (input.run.wakeupRequestId) {
      const [wake] = await tx.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.id, input.run.wakeupRequestId),
        eq(agentWakeupRequests.companyId, input.run.companyId),
        eq(agentWakeupRequests.agentId, input.run.agentId),
      )).for("update");
      if (!wake || wake.status !== "queued" || wake.runId !== input.run.id) return null;
      if (!isNativeReviewWakeProvenance(wake, { ...reviewContext, issueId })) return null;
    } else {
      return null;
    }
    const siblingCandidates = await tx.select({
      id: heartbeatRuns.id,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    }).from(heartbeatRuns).innerJoin(agentWakeupRequests, and(
      eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId),
      eq(agentWakeupRequests.companyId, input.run.companyId),
      eq(agentWakeupRequests.agentId, heartbeatRuns.agentId),
    )).where(and(
      eq(heartbeatRuns.companyId, input.run.companyId),
      ne(heartbeatRuns.id, input.run.id),
      inArray(heartbeatRuns.status, ["running", "succeeded"]),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
      sql`${heartbeatRuns.contextSnapshot} ->> 'nativeReviewInteractionId' = ${reviewContext.nativeReviewInteractionId}`,
      sql`${heartbeatRuns.contextSnapshot} ->> 'nativeReviewDecisionId' = ${reviewContext.nativeReviewDecisionId}`,
      inArray(agentWakeupRequests.reason, ["native_completion_review", "issue_execution_promoted"]),
      eq(agentWakeupRequests.idempotencyKey, `native-review:${reviewContext.nativeReviewInteractionId}`),
      eq(agentWakeupRequests.requestedByActorType, "system"),
      or(
        eq(agentWakeupRequests.requestedByActorId, "native-status-committer"),
        sql`${agentWakeupRequests.requestedByActorId} like 'native-status-wake-dispatch:%'`,
      ),
      sql`coalesce(${agentWakeupRequests.payload} ->> 'nativeReviewInteractionId', ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'nativeReviewInteractionId') = ${reviewContext.nativeReviewInteractionId}`,
      sql`coalesce(${agentWakeupRequests.payload} ->> 'nativeReviewDecisionId', ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'nativeReviewDecisionId') = ${reviewContext.nativeReviewDecisionId}`,
      sql`coalesce(${agentWakeupRequests.payload} ->> 'issueId', ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId') = ${issueId}`,
    )).orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id)).limit(5);
    for (const candidate of siblingCandidates) {
      if (
        await isNativeReviewRunBoundToCommitterWake(tx as unknown as Db, {
          companyId: input.run.companyId, issueId, runId: candidate.id,
          contextSnapshot: candidate.contextSnapshot,
        })
      ) return null;
    }
    if (!await isNativeReviewRunBoundToCommitterWake(tx as unknown as Db, {
      companyId: input.run.companyId, issueId, runId: input.run.id,
      contextSnapshot: context,
    })) return null;
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.run.id), eq(heartbeatRuns.companyId, input.run.companyId),
      eq(heartbeatRuns.agentId, input.run.agentId),
    )).for("update");
    if (!run || run.status !== "queued" || run.wakeupRequestId !== input.run.wakeupRequestId) return null;
    if ((run.contextSnapshot as Record<string, unknown> | null)?.issueId !== issueId) return null;
    const locked = await claimNativeReviewExecutionLock(tx as unknown as Db, {
      companyId: run.companyId, issueId, agentId: run.agentId, runId: run.id,
      contextSnapshot: context, agentNameKey: input.agentNameKey, claimedAt: input.claimedAt,
    });
    if (!locked) return null;
    const [claimed] = await tx.update(heartbeatRuns).set({
      ...input.claimValues, status: "running", startedAt: run.startedAt ?? input.claimedAt,
      updatedAt: input.claimedAt,
    }).where(eq(heartbeatRuns.id, run.id)).returning();
    if (run.wakeupRequestId) await tx.update(agentWakeupRequests).set({
      status: "claimed", claimedAt: input.claimedAt, updatedAt: input.claimedAt,
    }).where(eq(agentWakeupRequests.id, run.wakeupRequestId));
    return claimed ?? null;
  });
}
