import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  clearAutoMergeDisarmRecord, disarmRecordEscalated, disableAutoMerge, fenceRevokedHead, INTERRUPTED_ARM_REASON,
  recordPendingAutoMergeDisarm, resolveGitHubTokenCandidatesForRepo, writeArmGate, type PendingAutoMergeDisarm,
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
    fencedAt: typeof r.fencedAt === "string" ? r.fencedAt : null,
    fenceError: typeof r.fenceError === "string" ? r.fenceError : null,
    gateClosing: r.gateClosing === true,
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
export const disarmTiming: { promptDelaysMs: number[]; inFlightGraceMs: number; disableTimeoutMs: number } = {
  promptDelaysMs: [2_000, 5_000, 15_000, 30_000, 60_000, 120_000],
  /** Each disable request is given up on (and aborted) after this long; a test shortens it. */
  disableTimeoutMs: 10_000,
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
  const tokensFor = async (): Promise<string[]> => {
    try { return (await resolveGitHubTokenCandidatesForRepo(db, row.companyId, record!.owner, record!.repo)).map((candidate) => candidate.token); } catch { return []; }
  };
  // Only the arm gate is left open (the arm is settled): write the closing success; the record goes with it.
  if (record.gateClosing) {
    const closed = await writeArmGate(await tokensFor(), record, "closed");
    const gateWhere = { issueId: row.id, identifier: row.identifier, pr: `${record.owner}/${record.repo}#${record.number}`, since: record.since };
    if (closed.written) {
      await clearRecord(db, row.companyId, row.id);
      logger.warn(gateWhere, "arm gate closed: the arm is settled and the head is mergeable again");
      await logActivity(db, {
        companyId: row.companyId, actorType: "system", actorId: "system", agentId: null, runId: null,
        action: "issue.merge_gate_closed", entityType: "issue", entityId: row.id, issueId: row.id,
        details: { ...gateWhere, attempts: record.attempts + 1 },
      });
      return "disabled";
    }
    await recordPendingAutoMergeDisarm(db, row.companyId, row.id, { ...record, attempts: record.attempts + 1, lastError: closed.error, lastAttemptAt: new Date().toISOString() });
    logger.error({ ...gateWhere, error: closed.error, attempts: record.attempts + 1 }, "arm gate could not be closed: the arm is settled but the head stays unmergeable until the closing status is written; it will be retried");
    return "still-armed";
  }
  if (record.state === "in_flight") {
    // Written before an enable call. While its arm call may still be running it is left alone; after that the arm is
    // taken back whatever the authority is now (a surviving arm is simply re-armed by the next pass), so the take-back
    // never rests on knowing whether the call was accepted. Assumption, stated in the docs: no enable request this
    // process sent is accepted by GitHub after the grace (its calls are aborted after ENABLE_ATTEMPT_TIMEOUT_MS each, ENABLE_WORST_CASE_MS in all).
    if (Date.now() - Date.parse(record.since) < disarmTiming.inFlightGraceMs) return "waiting";
    record = { ...record, state: "pending", reason: INTERRUPTED_ARM_REASON };
    await recordPendingAutoMergeDisarm(db, row.companyId, row.id, record);
  }
  const where = { issueId: row.id, identifier: row.identifier, pr: `${record.owner}/${record.repo}#${record.number}`, since: record.since };
  let error: string | null = "no GitHub token candidate";
  let tokens: string[] = [];
  try {
    const candidates = await resolveGitHubTokenCandidatesForRepo(db, row.companyId, record.owner, record.repo);
    tokens = candidates.map((candidate) => candidate.token);
    for (const token of tokens) {
      const result = await disableAutoMerge(token, record.nodeId, { timeoutMs: disarmTiming.disableTimeoutMs });
      if (result.success) { error = null; break; }
      error = result.error ?? "unknown error";
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const attempts = record.attempts + 1;
  if (error === null) {
    // Off is confirmed: the arm gate is closed first, and the record goes only once GitHub has taken that write (else the
    // sweep goes on with `gateClosing` and the head stays unmergeable).
    const closed = await writeArmGate(tokens, record, "closed");
    if (!closed.written) {
      await recordPendingAutoMergeDisarm(db, row.companyId, row.id, { ...record, attempts: record.attempts + 1, lastError: closed.error, lastAttemptAt: new Date().toISOString(), gateClosing: true, reason: "auto-merge is off; the arm gate is still open" });
      logger.error({ ...where, error: closed.error }, "pending auto-merge disarm: GitHub confirmed auto-merge is off but the arm gate could not be closed; the head stays unmergeable until it is");
      return "still-armed";
    }
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
  // Closed without merging: the PR can be reopened on this head, so the gate the arm opened is closed before the record goes (a merged PR needs none).
  if (moot && !/\bmerged\b/i.test(error)) {
    const closed = await writeArmGate(tokens, record, "closed");
    if (!closed.written) {
      await recordPendingAutoMergeDisarm(db, row.companyId, row.id, { ...record, attempts, lastError: closed.error, lastAttemptAt: new Date().toISOString(), gateClosing: true, reason: "the PR is closed; the arm gate is still open" });
      logger.error({ ...where, error: closed.error }, "pending auto-merge disarm: the PR is closed but the arm gate could not be closed; the head stays unmergeable until it is");
      return "still-armed";
    }
  }
  // Past `disarmEscalation.afterMs` the card needs a human: marked once, alerted once, and every control-plane arm of it is refused.
  const escalating = !moot && !record.escalatedAt && disarmRecordEscalated(record);
  // The second route (see fenceRevokedHead): while GitHub will not turn auto-merge off, the head's paperclip/approved is set to
  // failure so the armed PR cannot merge. A record that is known to be an arm without authority is fenced at its first failed
  // take-back; one that was only left in flight (nothing says the authority changed) waits for the escalation deadline.
  const fencing = !moot && !record.fencedAt && (record.reason !== INTERRUPTED_ARM_REASON || disarmRecordEscalated(record));
  const fence = fencing ? await fenceRevokedHead(tokens, record) : null;
  const fenceFields = fence ? (fence.fenced ? { fencedAt: new Date().toISOString(), fenceError: null } : { fenceError: fence.error }) : {};
  if (moot) await clearRecord(db, row.companyId, row.id);
  else await recordPendingAutoMergeDisarm(db, row.companyId, row.id, { ...record, attempts, lastError: error, lastAttemptAt: new Date().toISOString(), ...fenceFields, ...(escalating ? { escalatedAt: new Date().toISOString() } : {}) });
  if (fence?.fenced) {
    logger.warn({ ...where, attempts }, "pending auto-merge disarm: the head's paperclip/approved is now failure, so the armed PR cannot merge while the take-back is retried");
    await logActivity(db, {
      companyId: row.companyId, actorType: "system", actorId: "system", agentId: null, runId: null,
      action: "issue.merge_disarm_fenced", entityType: "issue", entityId: row.id, issueId: row.id,
      details: { ...where, attempts, reason: record.reason, headSha: record.headSha },
    });
  }
  logger.error(
    { ...where, error, attempts, reason: record.reason, fenced: Boolean(record.fencedAt || fence?.fenced), fenceError: fence && !fence.fenced ? fence.error : record.fenceError ?? null },
    moot
      ? "pending auto-merge disarm ended: the PR is already merged or closed, so the arm could not be taken back before that"
      : "pending auto-merge disarm FAILED again: auto-merge is still enabled on a PR whose authority was revoked; it will be retried",
  );
  if (escalating) {
    logger.error({ ...where, error, attempts }, "pending auto-merge disarm ESCALATED: auto-merge is still enabled on a PR whose authority was revoked and GitHub has not confirmed it off; a human must turn it off, and the control plane arms nothing on this card meanwhile");
    await logActivity(db, {
      companyId: row.companyId, actorType: "system", actorId: "system", agentId: null, runId: null,
      action: "issue.merge_disarm_escalated", entityType: "issue", entityId: row.id, issueId: row.id,
      details: { ...where, error, attempts, reason: record.reason, needsHuman: true, fenced: Boolean(record.fencedAt || fence?.fenced) },
    });
  }
  if (moot || worthARow(attempts)) {
    await logActivity(db, {
      companyId: row.companyId, actorType: "system", actorId: "system", agentId: null, runId: null,
      action: moot ? "issue.merge_disarm_moot" : "issue.merge_disarm_failed", entityType: "issue", entityId: row.id, issueId: row.id,
      details: { ...where, error, attempts, reason: record.reason, ...(moot ? {} : { fenced: Boolean(record.fencedAt || fence?.fenced), fenceError: fence && !fence.fenced ? fence.error : record.fenceError ?? null }) },
    });
  }
  return moot ? "moot" : "still-armed";
}

/**
 * Retries every pending disarm until GitHub confirms auto-merge is off. Every record is tried each sweep (least recently
 * tried first); only a caller that passes `limit` takes fewer, and then more than `limit` waiting is logged at error level.
 */
export async function retryPendingAutoMergeDisarms(db: Db, options: { limit?: number } = {}): Promise<DisarmSweepSummary> {
  const pendingOnly = sql`${issues.executionState} -> 'approvalStatus' -> 'autoMergeDisarm' is not null`;
  const query = db
    .select({ id: issues.id, companyId: issues.companyId, identifier: issues.identifier, executionState: issues.executionState })
    .from(issues)
    .where(pendingOnly)
    .orderBy(sql`coalesce(${issues.executionState} -> 'approvalStatus' -> 'autoMergeDisarm' ->> 'lastAttemptAt', '')`, issues.id);
  // No default limit: every record is tried each sweep, whatever the count (admission holds new ones to the cap, but a
  // record an earlier version or a direct write left above it is not skipped). `limit` is for a caller that wants fewer.
  const rows = options.limit === undefined ? await query : await query.limit(options.limit);
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
