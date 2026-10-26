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
  };
}

export interface DisarmSweepSummary {
  checked: number;
  disabled: number;
  stillArmed: number;
}

/**
 * Retries every pending disarm until GitHub confirms auto-merge is off. A round that fails keeps the record,
 * logs at error level and writes an activity row, so it is seen; a PR that merged or closed in the meantime
 * ends the record loudly (the merge cannot be taken back).
 */
export async function retryPendingAutoMergeDisarms(db: Db, options: { limit?: number } = {}): Promise<DisarmSweepSummary> {
  const rows = await db
    .select({ id: issues.id, companyId: issues.companyId, identifier: issues.identifier, executionState: issues.executionState })
    .from(issues)
    .where(sql`${issues.executionState} -> 'approvalStatus' -> 'autoMergeDisarm' is not null`)
    .limit(options.limit ?? 50);
  const summary: DisarmSweepSummary = { checked: 0, disabled: 0, stillArmed: 0 };
  for (const row of rows) {
    const record = readRecord(row.executionState);
    if (!record) continue;
    summary.checked += 1;
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
    if (error === null) {
      await clearRecord(db, row.companyId, row.id);
      summary.disabled += 1;
      logger.warn(where, "pending auto-merge disarm: GitHub confirmed auto-merge is off");
      await logActivity(db, {
        companyId: row.companyId, actorType: "system", actorId: "system", agentId: null, runId: null,
        action: "issue.merge_disarm_confirmed", entityType: "issue", entityId: row.id, issueId: row.id,
        details: { ...where, attempts: record.attempts + 1, reason: record.reason },
      });
      continue;
    }
    // The PR is gone from the open set: there is nothing left to turn off, and what happened is stated.
    const moot = /\b(merged|closed)\b/i.test(error);
    summary.stillArmed += moot ? 0 : 1;
    if (moot) await clearRecord(db, row.companyId, row.id);
    else await recordPendingAutoMergeDisarm(db, row.companyId, row.id, { ...record, attempts: record.attempts + 1, lastError: error });
    logger.error(
      { ...where, error, attempts: record.attempts + 1, reason: record.reason },
      moot
        ? "pending auto-merge disarm ended: the PR is already merged or closed, so the arm could not be taken back before that"
        : "pending auto-merge disarm FAILED again: auto-merge is still enabled on a PR whose authority was revoked; it will be retried on the next tick",
    );
    await logActivity(db, {
      companyId: row.companyId, actorType: "system", actorId: "system", agentId: null, runId: null,
      action: moot ? "issue.merge_disarm_moot" : "issue.merge_disarm_failed", entityType: "issue", entityId: row.id, issueId: row.id,
      details: { ...where, error, attempts: record.attempts + 1, reason: record.reason },
    });
  }
  return summary;
}
