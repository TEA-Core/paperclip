import { and, eq, gt, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";

/**
 * SUP-22272: how long a review participant's most recent run keeps the
 * stranded-review detectors suppressed. Suppress-with-expiry: once the
 * participant has not run anywhere for this long, the detector mints exactly
 * as it did before this guard existed, so a genuinely wedged reviewer still
 * surfaces.
 */
export const REVIEW_PARTICIPANT_LIVE_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * True when the agent has any heartbeat run (on any issue) whose start or
 * finish is newer than max(sinceMs, now - windowMs).
 *
 * Agent-scoped on purpose: the parent incident (SUP-21921) had the reviewer
 * heartbeating on other cards while a sweep re-minted its stranded-review
 * action and churned attemptCount to exhaustion. Issue-scoped liveness checks
 * elsewhere in the sweep already missed that shape, so this key only on the
 * participant and time, never the issue.
 *
 * Pure over the injected db — no service deps, no clocks other than the
 * single `Date.now()` window anchor.
 */
export async function participantRanSince(
  db: Db,
  companyId: string,
  agentId: string,
  sinceMs: number,
  windowMs: number,
): Promise<boolean> {
  const thresholdMs = Math.max(sinceMs, Date.now() - windowMs);
  const threshold = new Date(thresholdMs);
  const rows = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
        or(
          gt(heartbeatRuns.startedAt, threshold),
          gt(heartbeatRuns.finishedAt, threshold),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
