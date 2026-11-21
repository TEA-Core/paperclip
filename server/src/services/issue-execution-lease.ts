import { and, asc, eq, inArray, isNull, notInArray, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentWakeupRequests, heartbeatRuns, issues } from "@paperclipai/db";

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

/** A silent author holds a card for at most the no-output hard-stop window. */
export const ISSUE_LESS_AUTHOR_HOLDER_SILENCE_BOUND_MS = 90 * 60 * 1000;

/**
 * SUP-20121: `runId` created the `issues` row in scope (`originRunId`) or
 * changed its assignee to the current assignee (its latest `issue.updated`
 * activity records an `assigneeAgentId` change to that assignee). An older
 * row is not proof once a later assignee-change row exists. A write that only
 * names the current assignee, with no change, is not proof. Callers add the
 * agent and issue-scope conditions.
 */
function runAuthoredIssueAssignment(runId: SQLWrapper | string): SQL {
  return sql`(
    ${runId}::text = ${issues.originRunId}
    or exists (
      select 1 from ${activityLog}
      where ${activityLog.runId} = ${runId}
        and ${activityLog.companyId} = ${issues.companyId}
        and ${activityLog.entityType} = 'issue'
        and ${activityLog.entityId} = ${issues.id}::text
        and ${activityLog.action} = 'issue.updated'
        and ${activityLog.details} -> 'changes' -> 'assigneeAgentId' ->> 'to' = ${issues.assigneeAgentId}::text
        and not exists (
          select 1 from activity_log later
          where later.company_id = ${activityLog.companyId}
            and later.entity_type = 'issue'
            and later.entity_id = ${activityLog.entityId}
            and later.action = 'issue.updated'
            and later.details -> 'changes' -> 'assigneeAgentId' ->> 'to' is not null
            and (later.created_at, later.id) > (${activityLog.createdAt}, ${activityLog.id})
        )
    )
  )`;
}

/**
 * SUP-20121: true when `runId` is the card's recorded author — it created the
 * card (`originRunId`) or changed its assignee to the current assignee. This
 * is the same server-recorded proof `findLiveIssueExecutionHolder` uses; a
 * claimed run id alone is never proof.
 */
export async function runIsIssueAuthor(
  db: Pick<Db, "select">,
  companyId: string,
  issueId: string,
  runId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      eq(issues.id, issueId),
      runAuthoredIssueAssignment(runId),
    ));
  return rows.length > 0;
}

/**
 * A still-running issue-less author no longer occupies a dispatch slot only
 * after the silence lapse has released its hold on an open card it authored.
 * A done or cancelled card is not that release: the author still occupies the
 * slot, so a wake for a different card cannot start a second run. Any other
 * silent issue-less run, including a busy-slot fixture that authored nothing,
 * still counts toward maxConcurrentRuns.
 */
export function releasedSilentAuthorDoesNotOccupyDispatchSlot(): SQL {
  return sql`(
    nullif(btrim(${heartbeatRuns.contextSnapshot} ->> 'issueId'), '') is null
    and coalesce(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt})
      <= clock_timestamp() - (${ISSUE_LESS_AUTHOR_HOLDER_SILENCE_BOUND_MS} * interval '1 millisecond')
    and not exists (
      select 1 from ${issues}
      where ${issues.companyId} = ${heartbeatRuns.companyId}
        and (
          ${issues.executionRunId} = ${heartbeatRuns.id}
          or ${issues.checkoutRunId} = ${heartbeatRuns.id}
        )
    )
    and exists (
      select 1 from ${issues}
      where ${issues.companyId} = ${heartbeatRuns.companyId}
        and ${issues.status} not in ('done', 'cancelled')
        and ${runAuthoredIssueAssignment(heartbeatRuns.id)}
    )
  )`;
}

/**
 * Finds the owner before acquiring an issue execution lock. The caller must
 * hold the issue row lock until its stamp commits. Include legacy
 * context-only owners and queued reservations, not just running direct leases.
 * Do not exclude the caller: its running issuer must win over an older queue.
 *
 * SUP-20121: a running run of the card's assignee that has no issue scope of
 * its own also owns the card when it created it (`originRunId`) or changed
 * the assignee to its own agent (its `issue.updated` activity records that
 * change), and it has not been silent past the bound above. Neither pointer is set for such a run, so without this term every
 * start gate saw the card as unowned and started a second run of the same
 * agent, which took the checkout and locked the author out of its own card.
 * A run whose context names another issue is not included (SUP-16052).
 */
export async function findLiveIssueExecutionHolder(
  db: Pick<Db, "select">,
  companyId: string,
  issueId: string,
): Promise<LiveExecutionLease | null> {
  return db
    .select({
      runId: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
    })
    .from(issues)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.companyId, issues.companyId))
    .where(and(
      eq(issues.companyId, companyId),
      eq(issues.id, issueId),
      inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
      or(
        eq(heartbeatRuns.id, issues.executionRunId),
        eq(heartbeatRuns.id, issues.checkoutRunId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        and(
          eq(heartbeatRuns.status, "running"),
          eq(heartbeatRuns.agentId, issues.assigneeAgentId),
          notInArray(issues.status, ["done", "cancelled"]),
          sql`nullif(btrim(${heartbeatRuns.contextSnapshot} ->> 'issueId'), '') is null`,
          sql`coalesce(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) > clock_timestamp() - interval '90 minutes'`,
          runAuthoredIssueAssignment(heartbeatRuns.id),
        ),
      ),
    ))
    .orderBy(
      sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
      sql`case when ${heartbeatRuns.id} = ${issues.executionRunId} then 0 when ${heartbeatRuns.id} = ${issues.checkoutRunId} then 1 else 2 end`,
      asc(heartbeatRuns.createdAt),
      asc(heartbeatRuns.id),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/**
 * SUP-20121: cards an issue-less run of `agentId` owned through
 * `findLiveIssueExecutionHolder` (it created or self-assigned them) that no
 * longer carry an execution lock but still hold that agent's deferred wakes.
 * A status write clears the lock while the run is live, and the finishing
 * run's release would otherwise never visit the card, so these wakes are
 * promoted when the run finishes. A done or cancelled card is excluded: promoting
 * a held wake onto it reopens the card, and the base leaves that card closed.
 */
export async function listUnlockedIssuesWithDeferredWakesForRun(
  db: Pick<Db, "select">,
  input: { companyId: string; runId: string; agentId: string },
): Promise<string[]> {
  return db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.assigneeAgentId, input.agentId),
      isNull(issues.executionRunId),
      notInArray(issues.status, ["done", "cancelled"]),
      runAuthoredIssueAssignment(input.runId),
      sql`exists (
        select 1 from ${agentWakeupRequests}
        where ${agentWakeupRequests.companyId} = ${issues.companyId}
          and ${agentWakeupRequests.agentId} = ${input.agentId}
          and ${agentWakeupRequests.status} = 'deferred_issue_execution'
          and ${agentWakeupRequests.payload} ->> 'issueId' = ${issues.id}::text
      )`,
    ))
    .orderBy(asc(issues.id))
    .then((rows) => rows.map((row) => row.id));
}
