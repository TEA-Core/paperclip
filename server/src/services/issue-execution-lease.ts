import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";

export interface LiveExecutionLease {
  runId: string;
  agentId: string;
  status: string;
  startedAt: Date | null;
}

/**
 * Resolves the live execution leases for the given issues.
 *
 * An issue is leased when either `issues.executionRunId` or
 * `issues.checkoutRunId` references a `heartbeatRuns` row whose status is
 * `running`. `queued` and `scheduled_retry` runs do NOT count: they are not
 * executing anything, and treating them as holders would deadlock two
 * mutually-deferring queued runs with no tie-break — each would defer to the
 * other and neither would ever start. `startNextQueuedRunForAgent` claims
 * sequentially under `withAgentStartLock`, so the first of a pair is already
 * `running` in the database by the time the second is evaluated. (Same
 * rationale documented above `findRunningIssueRunForAgent` in
 * `services/heartbeat.ts`.)
 *
 * When both pointers resolve to live runs, `executionRunId` (the execution
 * lock) wins, because it is the stronger claim on the issue.
 *
 * The returned map is keyed by issue id and only contains leased issues.
 * `opts.excludeRunId` removes a single run from consideration — e.g. the
 * caller's own run, which must not count as a foreign lease.
 */
export async function resolveLiveExecutionLeases(
  db: Db,
  companyId: string,
  issueIds: string[],
  opts?: { excludeRunId?: string },
): Promise<Map<string, LiveExecutionLease>> {
  const leases = new Map<string, LiveExecutionLease>();
  if (issueIds.length === 0) return leases;

  const issueRows = await db
    .select({
      id: issues.id,
      executionRunId: issues.executionRunId,
      checkoutRunId: issues.checkoutRunId,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));

  const candidateRunIds = new Set<string>();
  for (const row of issueRows) {
    if (row.executionRunId && row.executionRunId !== opts?.excludeRunId) {
      candidateRunIds.add(row.executionRunId);
    }
    if (row.checkoutRunId && row.checkoutRunId !== opts?.excludeRunId) {
      candidateRunIds.add(row.checkoutRunId);
    }
  }
  if (candidateRunIds.size === 0) return leases;

  const liveRuns = await db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      inArray(heartbeatRuns.id, [...candidateRunIds]),
      eq(heartbeatRuns.status, "running"),
    ));
  const liveById = new Map(liveRuns.map((run) => [run.id, run]));

  for (const row of issueRows) {
    const lease =
      (row.executionRunId ? liveById.get(row.executionRunId) : undefined) ??
      (row.checkoutRunId ? liveById.get(row.checkoutRunId) : undefined);
    if (!lease) continue;
    leases.set(row.id, {
      runId: lease.id,
      agentId: lease.agentId,
      status: lease.status,
      startedAt: lease.startedAt,
    });
  }
  return leases;
}
