import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

/**
 * A run found without an issue may gain one (its context names the issue it
 * works on once it checks one out), so that answer is reused only briefly. A
 * run's issue, once found, does not change.
 */
const UNASSOCIATED_RUN_TTL_MS = 1_000;
const RUN_ISSUE_CACHE_LIMIT = 1_024;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolves the issue a heartbeat run event concerns: the `issueId` its payload
 * names, else the run's `contextSnapshot.issueId`, else `null`.
 */
export function createRunIssueLookup(db: Db) {
  const lookups = new Map<string, { issueId: Promise<string | null>; expiresAt: number }>();

  return function runIssueId(companyId: string, payload: Record<string, unknown>): Promise<string | null> {
    const named = nonEmptyString(payload.issueId);
    if (named) return Promise.resolve(named);
    const runId = nonEmptyString(payload.runId);
    if (!runId || !isUuidLike(runId)) return Promise.resolve(null);
    const key = `${companyId}:${runId}`;
    const now = Date.now();
    const cached = lookups.get(key);
    if (cached && cached.expiresAt > now) return cached.issueId;
    if (lookups.size >= RUN_ISSUE_CACHE_LIMIT) lookups.clear();
    const issueId = db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)))
      .then((rows) => nonEmptyString(rows[0]?.contextSnapshot?.issueId));
    const entry = { issueId, expiresAt: now + UNASSOCIATED_RUN_TTL_MS };
    lookups.set(key, entry);
    issueId.then(
      (found) => {
        if (found) entry.expiresAt = Number.POSITIVE_INFINITY;
      },
      () => lookups.delete(key),
    );
    return issueId;
  };
}
