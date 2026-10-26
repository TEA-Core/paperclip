import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { disableAutoMerge, recordPendingAutoMergeDisarm, resolveGitHubTokenCandidatesForRepo, type PendingAutoMergeDisarm } from "./merge-arming.js";

async function clearRecord(db: Db, companyId: string, issueId: string): Promise<void> {
  await db
    .update(issues)
    .set({
      executionState: sql`jsonb_set(coalesce(${issues.executionState}, '{}'::jsonb), '{approvalStatus}',
        coalesce(${issues.executionState} -> 'approvalStatus', '{}'::jsonb) - 'autoMergeDisarm')`,
    })
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
}

function readRecord(executionState: unknown): PendingAutoMergeDisarm | null {
  const raw = ((executionState as Record<string, unknown> | null)?.approvalStatus as Record<string, unknown> | undefined)?.autoMergeDisarm;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.owner !== "string" || typeof r.repo !== "string" || typeof r.number !== "number" || typeof r.nodeId !== "string") return null;
  return {
    owner: r.owner, repo: r.repo, number: r.number, nodeId: r.nodeId,
    headSha: typeof r.headSha === "string" ? r.headSha : null,
    reason: typeof r.reason === "string" ? r.reason : "authority changed",
    since: typeof r.since === "string" ? r.since : new Date(0).toISOString(),
    attempts: typeof r.attempts === "number" ? r.attempts : 0,
    lastError: typeof r.lastError === "string" ? r.lastError : null,
    lastAttemptAt: typeof r.lastAttemptAt === "string" ? r.lastAttemptAt : null,
  };
}

export interface DisarmSweepSummary {
  checked: number;
  disabled: number;
  stillArmed: number;
  /** Records on cards when the sweep started; more than `checked` means the rest wait for the next tick (least recently tried first). */
  pending: number;
}

/**
 * When a take-back that failed at once is tried again without waiting for the first reconciler tick (which can be
 * minutes away). Lives in process memory: a restart falls back to the tick. Tests set it to `[]`.
 */
export const disarmTiming: { promptDelaysMs: number[] } = { promptDelaysMs: [2_000, 5_000, 15_000, 30_000, 60_000, 120_000] };

/** Activity rows for a failing record: every round at first, then about hourly, so a record GitHub never accepts does not grow the log without end. */
function worthARow(attempts: number): boolean {
  return attempts <= 3 || attempts % 12 === 0;
}

/**
 * One try at one pending take-back: ask GitHub to turn auto-merge off with each token the repo has. Success clears the
 * record. A failed try keeps it, logs at error level and writes an activity row (throttled, see worthARow); a PR that
 * merged or closed in the meantime ends the record loudly (the merge cannot be taken back).
 */
async function attemptDisarm(
  db: Db,
  row: { id: string; companyId: string; identifier: string | null; executionState: unknown },
): Promise<"disabled" | "still-armed" | "moot" | "none"> {
  const record = readRecord(row.executionState);
  if (!record) return "none";
  const where = { issueId: row.id, identifier: row.identifier, pr: `${record.owner}/${record.repo}#${record.number}`, since: record.since };
  let error: string | null = "no GitHub token candidate";
  try {
    const candidates = await resolveGitHubTokenCandidatesForRepo(db, row.companyId, record.owner, record.repo);
    for (const candidate of candidates) {
      const result = await disableAutoMerge(candidate.token, record.nodeId);
      if (result.success) { error = null; break; }
      error = result.error ?? "unknown error";
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const attempts = record.attempts + 1;
  if (error === null) {
    await clearRecord(db, row.companyId, row.id);
    logger.warn(where, "pending auto-merge disarm: GitHub confirmed auto-merge is off");
    await logActivity(db, {
      companyId: row.companyId, actorType: "system", actorId: "system", agentId: null, runId: null,
      action: "issue.merge_disarm_confirmed", entityType: "issue", entityId: row.id, issueId: row.id,
      details: { ...where, attempts, reason: record.reason },
    });
    return "disabled";
  }
  // The PR is gone from the open set: there is nothing left to turn off, and what happened is stated.
  const moot = /\b(merged|closed)\b/i.test(error);
  if (moot) await clearRecord(db, row.companyId, row.id);
  else await recordPendingAutoMergeDisarm(db, row.companyId, row.id, { ...record, attempts, lastError: error, lastAttemptAt: new Date().toISOString() });
  logger.error(
    { ...where, error, attempts, reason: record.reason },
    moot
      ? "pending auto-merge disarm ended: the PR is already merged or closed, so the arm could not be taken back before that"
      : "pending auto-merge disarm FAILED again: auto-merge is still enabled on a PR whose authority was revoked; it will be retried",
  );
  if (moot || worthARow(attempts)) {
    await logActivity(db, {
      companyId: row.companyId, actorType: "system", actorId: "system", agentId: null, runId: null,
      action: moot ? "issue.merge_disarm_moot" : "issue.merge_disarm_failed", entityType: "issue", entityId: row.id, issueId: row.id,
      details: { ...where, error, attempts, reason: record.reason },
    });
  }
  return moot ? "moot" : "still-armed";
}

/**
 * Retries every pending disarm until GitHub confirms auto-merge is off. Records are taken least recently tried first, so
 * a handful that GitHub keeps refusing cannot starve the rest, and more than `limit` waiting is logged at error level.
 */
export async function retryPendingAutoMergeDisarms(db: Db, options: { limit?: number } = {}): Promise<DisarmSweepSummary> {
  const pendingOnly = sql`${issues.executionState} -> 'approvalStatus' -> 'autoMergeDisarm' is not null`;
  const rows = await db
    .select({ id: issues.id, companyId: issues.companyId, identifier: issues.identifier, executionState: issues.executionState })
    .from(issues)
    .where(pendingOnly)
    .orderBy(sql`coalesce(${issues.executionState} -> 'approvalStatus' -> 'autoMergeDisarm' ->> 'lastAttemptAt', '')`, issues.id)
    .limit(options.limit ?? 50);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(issues).where(pendingOnly);
  const summary: DisarmSweepSummary = { checked: 0, disabled: 0, stillArmed: 0, pending: n };
  for (const row of rows) {
    const result = await attemptDisarm(db, row);
    if (result === "none") continue;
    summary.checked += 1;
    if (result === "disabled") summary.disabled += 1;
    if (result === "still-armed") summary.stillArmed += 1;
  }
  if (n > summary.checked) {
    logger.error({ pending: n, checked: summary.checked }, "pending auto-merge disarms exceed one sweep: the rest are tried on the next ticks, least recently tried first");
  }
  return summary;
}

const promptRetries = new Set<string>();

/**
 * Starts retrying one pending take-back soon after it failed (see disarmTiming), without waiting for the reconciler tick.
 * One chain per card; it ends when the record is gone (confirmed off, or the PR merged or closed).
 */
export function startPromptDisarmRetries(db: Db, companyId: string, issueId: string, delaysMs: number[] = disarmTiming.promptDelaysMs): void {
  if (delaysMs.length === 0 || promptRetries.has(issueId)) return;
  promptRetries.add(issueId);
  const step = (index: number) => {
    const timer = setTimeout(() => {
      void (async () => {
        let done = true;
        try {
          const [row] = await db
            .select({ id: issues.id, companyId: issues.companyId, identifier: issues.identifier, executionState: issues.executionState })
            .from(issues)
            .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
          const result = row ? await attemptDisarm(db, row) : "none";
          done = result !== "still-armed" || index + 1 >= delaysMs.length;
        } catch (err) {
          logger.error({ err, issueId }, "prompt auto-merge disarm retry failed");
          done = index + 1 >= delaysMs.length;
        }
        if (done) promptRetries.delete(issueId);
        else step(index + 1);
      })();
    }, delaysMs[index]);
    timer.unref?.();
  };
  step(0);
}
