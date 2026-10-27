import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  clearAutoMergeDisarmRecord, disarmBacklog, disarmRecordEscalated, disableAutoMerge, recordPendingAutoMergeDisarm,
  resolveGitHubTokenCandidatesForRepo, type PendingAutoMergeDisarm,
} from "./merge-arming.js";

const clearRecord = (db: Db, companyId: string, issueId: string) => clearAutoMergeDisarmRecord(db, companyId, issueId);

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
    state: r.state === "in_flight" ? "in_flight" : "pending",
    ...(typeof r.token === "string" ? { token: r.token } : {}),
    baseline: typeof r.baseline === "string" ? r.baseline : null,
    requireApprovedLadder: r.requireApprovedLadder === true,
    escalatedAt: typeof r.escalatedAt === "string" ? r.escalatedAt : null,
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
export const disarmTiming: { promptDelaysMs: number[]; inFlightGraceMs: number } = {
  promptDelaysMs: [2_000, 5_000, 15_000, 30_000, 60_000, 120_000],
  // An in-flight record younger than this belongs to an arm call that may still be running (its enable call is over within ENABLE_WORST_CASE_MS, under half of it).
  inFlightGraceMs: 120_000,
};

/** Activity rows for a failing record: the first three attempts, then every 12th, so a record GitHub never accepts does not grow the log without end. */
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
): Promise<"disabled" | "still-armed" | "moot" | "waiting" | "none"> {
  let record = readRecord(row.executionState);
  if (!record) return "none";
  if (record.state === "in_flight") {
    // Written before an enable call. While its arm call may still be running it is left alone; after that the arm is
    // taken back whatever the authority is now (a surviving arm is simply re-armed by the next pass), so the take-back
    // never rests on knowing whether the call was accepted. Assumption, stated in the docs: no enable request this
    // process sent is accepted by GitHub after the grace (its calls are aborted after ENABLE_ATTEMPT_TIMEOUT_MS each, ENABLE_WORST_CASE_MS in all).
    if (Date.now() - Date.parse(record.since) < disarmTiming.inFlightGraceMs) return "waiting";
    record = { ...record, state: "pending", reason: "arm interrupted before it was settled" };
    await recordPendingAutoMergeDisarm(db, row.companyId, row.id, record);
  }
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
  // Past `disarmEscalation.afterMs` the card needs a human: marked once, alerted once, and every control-plane arm of it is refused.
  const escalating = !moot && !record.escalatedAt && disarmRecordEscalated(record);
  if (moot) await clearRecord(db, row.companyId, row.id);
  else await recordPendingAutoMergeDisarm(db, row.companyId, row.id, { ...record, attempts, lastError: error, lastAttemptAt: new Date().toISOString(), ...(escalating ? { escalatedAt: new Date().toISOString() } : {}) });
  logger.error(
    { ...where, error, attempts, reason: record.reason },
    moot
      ? "pending auto-merge disarm ended: the PR is already merged or closed, so the arm could not be taken back before that"
      : "pending auto-merge disarm FAILED again: auto-merge is still enabled on a PR whose authority was revoked; it will be retried",
  );
  if (escalating) {
    logger.error({ ...where, error, attempts }, "pending auto-merge disarm ESCALATED: auto-merge is still enabled on a PR whose authority was revoked and GitHub has not confirmed it off; a human must turn it off, and the control plane arms nothing on this card meanwhile");
    await logActivity(db, {
      companyId: row.companyId, actorType: "system", actorId: "system", agentId: null, runId: null,
      action: "issue.merge_disarm_escalated", entityType: "issue", entityId: row.id, issueId: row.id,
      details: { ...where, error, attempts, reason: record.reason, needsHuman: true },
    });
  }
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
    // Admission holds the backlog to the cap (a hard cap), so this takes all of them.
    .limit(options.limit ?? disarmBacklog.cap);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(issues).where(pendingOnly);
  const summary: DisarmSweepSummary = { checked: 0, disabled: 0, stillArmed: 0, pending: n };
  // A few at a time, so one provider that never answers (each try is bounded) cannot hold up the rest of the backlog.
  const CONCURRENCY = 10;
  for (let from = 0; from < rows.length; from += CONCURRENCY) {
    const results = await Promise.all(rows.slice(from, from + CONCURRENCY).map((row) => attemptDisarm(db, row).catch((err) => {
      logger.error({ err, issueId: row.id }, "pending auto-merge disarm attempt threw");
      return "still-armed" as const;
    })));
    for (const result of results) {
      if (result === "none" || result === "waiting") continue;
      summary.checked += 1;
      if (result === "disabled") summary.disabled += 1;
      if (result === "still-armed") summary.stillArmed += 1;
    }
  }
  if (n > rows.length) {
    logger.error({ pending: n, taken: rows.length }, "pending auto-merge disarms exceed one sweep: the rest are tried on the next ticks, least recently tried first");
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
          done = (result !== "still-armed" && result !== "waiting") || index + 1 >= delaysMs.length;
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

/**
 * At boot: tries every record on the cards once now (the in-process retry timers of the last run died with it), and
 * starts the prompt retries for the ones still waiting. Never throws.
 */
export async function resumePendingAutoMergeDisarms(db: Db): Promise<DisarmSweepSummary | null> {
  try {
    const summary = await retryPendingAutoMergeDisarms(db);
    const rows = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(sql`${issues.executionState} -> 'approvalStatus' -> 'autoMergeDisarm' is not null`);
    for (const row of rows) startPromptDisarmRetries(db, row.companyId, row.id);
    if (rows.length > 0) logger.warn({ ...summary, resumed: rows.length }, "resumed pending auto-merge take-backs after boot");
    return summary;
  } catch (err) {
    logger.error({ err }, "could not resume pending auto-merge take-backs at boot; the reconciler tick still tries them");
    return null;
  }
}
