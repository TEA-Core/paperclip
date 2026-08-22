import type { Db } from "@paperclipai/db";
import {
  externalObjectMentions,
  externalObjects,
  issueExecutionDecisions,
  issues,
} from "@paperclipai/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import {
  resolveGitHubTokenCandidatesForRepo,
  type GitHubTokenResolution,
} from "./github-credential.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import {
  publishApprovalStatus,
  resolveLinkedPullRequestsWithState,
  type LinkedPullRequest,
} from "./merge-arming.js";

// SUP-13535. The paperclip/approved commit status is written exactly once, on
// the PR head that existed when the card was approved. When that head later
// moves (conflict resolution, update-branch) the status is stranded on the
// old head and the merge queue loses it. This service re-publishes it on the
// live head, and only when:
//
//   - the card's recorded approval decision is still `approved` in the
//     control-plane DB (the SQL trigger below). Approval is never inferred
//     from the commit, from GitHub's reviewDecision, or from the card status;
//   - stage integrity holds (ADR-073): no auto-skipped stage, every completed
//     stage has a decision row, and no completed stage's latest decision was
//     made by the card's author or its returnAssignee. Self-approved or
//     auto-skipped stages are not approvals;
//   - the linked PR is still open and unmerged (live field-read from GitHub);
//   - the head does not already carry paperclip/approved=success. The head's
//     combined status is read first, so idempotent re-runs perform zero
//     writes.
//
// The write itself is delegated to publishApprovalStatus() from merge-arming
// (live re-resolves the head, SUP-13313); this service only decides whether a
// re-publish is warranted. A head that moves between the combined-status
// check and the delegated write is harmless: the write lands on the newer
// head of the same approved card's open PR, which needs the signal just as
// much, and the next tick verifies it.

const PAPERCLIP_APPROVED_CONTEXT = "paperclip/approved";
const DEFAULT_MAX_CANDIDATES = 20;
const DEFAULT_INITIAL_DELAY_MS = 60 * 1000;
const MAX_DETAIL_ENTRIES = 25;
const USER_AGENT = "paperclip-approval-status-reconciler";

export interface ApprovalStatusReconcilerTickOptions {
  /** Upper bound on candidates handled in one tick. Excess is reported as `capped`. */
  maxCandidates?: number;
}

export interface ApprovalStatusReconcilerTickSummary {
  /** Candidates that were processed this tick. */
  scanned: number;
  /** Candidates whose paperclip/approved status was (re)published. */
  republished: number;
  /** Skip counts by stable reason key. */
  skipped: Record<string, number>;
  /** Bounded "IDENTIFIER: detail" skip reasons. */
  skippedDetails: string[];
  /** Candidates that could not be resolved or published. */
  failed: number;
  /** Bounded "IDENTIFIER: detail" failure reasons. */
  failedDetails: string[];
  /** Candidates dropped by the per-tick cap. */
  capped: number;
}

interface CandidateRow {
  id: string;
  companyId: string;
  identifier: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  executionState: Record<string, unknown> | null;
  executionPolicy: Record<string, unknown> | null;
}

type CandidateResult =
  | { kind: "republished"; detail: string }
  | { kind: "skipped"; reason: string; detail: string }
  | { kind: "failed"; detail: string };

interface GitHubReadOutcome {
  ok: boolean;
  status: number;
  message: string | null;
  body: unknown;
}

/**
 * GET a GitHub REST endpoint as JSON, trying each resolvable token in order
 * (mirrors publishApprovalStatus's candidate walk: 401/403 advances to the
 * next candidate, everything else is final).
 */
async function ghReadJson(
  db: Db,
  companyId: string,
  owner: string,
  repo: string,
  path: string,
): Promise<GitHubReadOutcome> {
  const candidates = await resolveGitHubTokenCandidatesForRepo(db, companyId, owner, repo);
  if (candidates.length === 0) {
    return { ok: false, status: 0, message: "no_token_candidates", body: null };
  }

  let last: GitHubReadOutcome | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidate: GitHubTokenResolution = candidates[i]!;
    const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;
    let response: Response;
    try {
      response = await ghFetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": USER_AGENT,
          "x-github-api-version": "2022-11-28",
          authorization: `Bearer ${candidate.token}`,
        },
      });
    } catch {
      last = { ok: false, status: 0, message: "network_error", body: null };
      continue;
    }

    const body = await response.json().catch(() => null);
    const message = response.ok
      ? null
      : typeof (body as Record<string, unknown> | null)?.message === "string"
        ? ((body as Record<string, unknown>).message as string)
        : "";

    if (!response.ok && (response.status === 401 || response.status === 403) && i < candidates.length - 1) {
      last = { ok: false, status: response.status, message, body: null };
      continue;
    }

    last = { ok: response.ok, status: response.status, message, body };
    break;
  }

  return last!;
}

/**
 * Cards whose recorded approval decision is still `approved`, that are not
 * cancelled, and that carry at least one linked GitHub PR. The trigger is the
 * control-plane record alone — nothing is inferred from commits or GitHub.
 */
async function findApprovalCandidates(db: Db, limit: number): Promise<CandidateRow[]> {
  return db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      createdByAgentId: issues.createdByAgentId,
      createdByUserId: issues.createdByUserId,
      executionState: issues.executionState,
      executionPolicy: issues.executionPolicy,
    })
    .from(issues)
    .where(
      and(
        ne(issues.status, "cancelled"),
        sql`(${issues.executionState} ->> 'lastDecisionOutcome') = 'approved'`,
        sql`${issues.identifier} is not null`,
        sql`(exists (
          select 1
          from ${externalObjectMentions}
          inner join ${externalObjects} on ${externalObjects.id} = ${externalObjectMentions.objectId}
          where ${externalObjectMentions.companyId} = ${issues.companyId}
            and ${externalObjectMentions.sourceIssueId} = ${issues.id}
            and ${externalObjectMentions.objectType} = 'pull_request'
            and ${externalObjects.providerKey} = 'github'
        ))`,
      ),
    )
    .orderBy(issues.identifier)
    .limit(limit);
}

/**
 * ADR-073 stage-integrity audit of the recorded approval. Returns a skip
 * verdict when the "approved" record is not backed by a real, non-self
 * decision: an auto-skipped review stage writes no decision row and lands in
 * skippedStageIds, so it must never be treated as an approval.
 */
async function evaluateStageIntegrity(db: Db, row: CandidateRow): Promise<{ reason: string; detail: string } | null> {
  const state: Record<string, unknown> = row.executionState ?? {};
  const policy: Record<string, unknown> = row.executionPolicy ?? {};

  const skippedStageIds = Array.isArray(state.skippedStageIds)
    ? (state.skippedStageIds as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  if (skippedStageIds.length > 0) {
    return {
      reason: "guard-b:skipped-stage",
      detail: `skipped stages present: ${skippedStageIds.join(", ")}`,
    };
  }

  const policyStageIds = new Set(
    (Array.isArray(policy.stages)
      ? (policy.stages as Array<Record<string, unknown> | null | undefined>)
      : []
    )
      .map((stage) => (stage && typeof stage.id === "string" ? stage.id : null))
      .filter((id): id is string => id !== null),
  );

  const completedStageIds = Array.isArray(state.completedStageIds)
    ? (state.completedStageIds as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  if (completedStageIds.length === 0) {
    return {
      reason: "guard-b:no-completed-stage",
      detail: "no completed stages recorded in executionState",
    };
  }
  for (const stageId of completedStageIds) {
    if (!policyStageIds.has(stageId)) {
      return {
        reason: "guard-b:stage-not-in-policy",
        detail: `completed stage ${stageId} is not in executionPolicy.stages`,
      };
    }
  }

  const decisions = await db
    .select({
      stageId: issueExecutionDecisions.stageId,
      actorAgentId: issueExecutionDecisions.actorAgentId,
      actorUserId: issueExecutionDecisions.actorUserId,
      createdAt: issueExecutionDecisions.createdAt,
    })
    .from(issueExecutionDecisions)
    .where(eq(issueExecutionDecisions.issueId, row.id));

  const latestByStage = new Map<string, { actorAgentId: string | null; actorUserId: string | null; createdAt: Date }>();
  for (const decision of decisions) {
    const existing = latestByStage.get(decision.stageId);
    if (!existing || decision.createdAt.getTime() >= existing.createdAt.getTime()) {
      latestByStage.set(decision.stageId, {
        actorAgentId: decision.actorAgentId,
        actorUserId: decision.actorUserId,
        createdAt: decision.createdAt,
      });
    }
  }
  for (const stageId of completedStageIds) {
    if (!latestByStage.has(stageId)) {
      return {
        reason: "guard-b:stage-without-decision",
        detail: `completed stage ${stageId} has no issue_execution_decisions row`,
      };
    }
  }

  const forbiddenAgents = new Set<string>();
  const forbiddenUsers = new Set<string>();
  if (row.createdByAgentId) forbiddenAgents.add(row.createdByAgentId);
  if (row.createdByUserId) forbiddenUsers.add(row.createdByUserId);
  if (typeof policy.returnAssigneeAgentId === "string" && policy.returnAssigneeAgentId) {
    forbiddenAgents.add(policy.returnAssigneeAgentId);
  }
  const returnAssignee = state.returnAssignee as
    | { type?: unknown; agentId?: unknown; userId?: unknown }
    | null
    | undefined;
  if (returnAssignee && typeof returnAssignee === "object") {
    if (returnAssignee.type === "agent" && typeof returnAssignee.agentId === "string") {
      forbiddenAgents.add(returnAssignee.agentId);
    }
    if (returnAssignee.type === "user" && typeof returnAssignee.userId === "string") {
      forbiddenUsers.add(returnAssignee.userId);
    }
  }

  for (const stageId of completedStageIds) {
    const latest = latestByStage.get(stageId)!;
    if ((latest.actorAgentId && forbiddenAgents.has(latest.actorAgentId)) ||
        (latest.actorUserId && forbiddenUsers.has(latest.actorUserId))) {
      return {
        reason: "guard-b:decision-by-author-or-return-assignee",
        detail: `stage ${stageId} decided by the card's author or returnAssignee`,
      };
    }
  }

  return null;
}

async function reconcileCandidate(db: Db, row: CandidateRow): Promise<CandidateResult> {
  const label = row.identifier ?? row.id;

  const integrity = await evaluateStageIntegrity(db, row);
  if (integrity) {
    return { kind: "skipped", reason: integrity.reason, detail: `guard-b ${integrity.detail}` };
  }

  const linked = await resolveLinkedPullRequestsWithState(db, row.companyId, row.id);
  const openPrs = linked.filter((pr) => pr.cachedState === "open");
  const unhydratedPrs = linked.filter((pr) => pr.cachedState === null);
  let target: LinkedPullRequest | null = null;
  if (openPrs.length === 1) {
    target = openPrs[0];
  } else if (openPrs.length === 0 && unhydratedPrs.length === 1) {
    target = unhydratedPrs[0];
  }
  if (!target) {
    const reason =
      openPrs.length > 1 || (openPrs.length === 0 && unhydratedPrs.length > 1)
        ? "ambiguous-pr"
        : "no-open-pr";
    const cached =
      linked.length > 0
        ? linked.map((pr) => `${pr.displayName} state=${pr.cachedState ?? "unhydrated"}`).join(", ")
        : "none";
    return { kind: "skipped", reason, detail: `${reason}: linked mentions: ${cached}` };
  }

  const prRead = await ghReadJson(db, row.companyId, target.owner, target.repo, `/pulls/${target.number}`);
  if (!prRead.ok) {
    return { kind: "failed", detail: `pr-fetch-failed: HTTP ${prRead.status} ${prRead.message ?? ""}`.trim() };
  }
  const prBody = prRead.body as Record<string, unknown> | null;
  const headSha = ((prBody?.head as Record<string, unknown> | undefined)?.sha as string | undefined) ?? null;
  if (!headSha) {
    return { kind: "failed", detail: "pr-fetch-failed: no head sha in PR payload" };
  }
  if (prBody?.merged === true) {
    return { kind: "skipped", reason: "pr-merged", detail: `pr-merged: ${target.displayName} is merged` };
  }
  if (typeof prBody?.state === "string" && prBody.state !== "open") {
    return { kind: "skipped", reason: "pr-closed", detail: `pr-closed: ${target.displayName} state=${prBody.state}` };
  }

  // Idempotency pre-check: read the head's combined status. A 404 means the
  // ref itself is not resolvable (the sha was just read from the live PR, so
  // this is not the "no statuses yet" case) — treat it as a failure, never as
  // a publish trigger.
  const headStatus = await ghReadJson(
    db,
    row.companyId,
    target.owner,
    target.repo,
    `/commits/${encodeURIComponent(headSha)}/status`,
  );
  if (!headStatus.ok) {
    return {
      kind: "failed",
      detail: `head-status-check-failed: HTTP ${headStatus.status} ${headStatus.message ?? ""}`.trim(),
    };
  }
  const statuses = Array.isArray((headStatus.body as Record<string, unknown> | null)?.statuses)
    ? ((headStatus.body as Record<string, unknown>).statuses as Array<Record<string, unknown>>)
    : [];
  if (statuses.some((s) => s.context === PAPERCLIP_APPROVED_CONTEXT && s.state === "success")) {
    return {
      kind: "skipped",
      reason: "already-success",
      detail: `already-success: ${target.displayName} head ${headSha.slice(0, 7)} already carries ${PAPERCLIP_APPROVED_CONTEXT}=success`,
    };
  }

  const outcome = await publishApprovalStatus(db, row.companyId, row.id, row.identifier ?? "");
  if (outcome.kind === "armed") {
    return { kind: "republished", detail: `republished ${target.displayName}: ${outcome.message}` };
  }
  if (outcome.kind === "skipped") {
    return { kind: "skipped", reason: "publish:skipped", detail: `publish skipped: ${outcome.message}` };
  }
  const truncated = outcome.message.length > 200 ? `${outcome.message.slice(0, 200)}...` : outcome.message;
  return { kind: "failed", detail: `publish failed: ${truncated}` };
}

export async function runApprovalStatusReconcilerTick(
  db: Db,
  options: ApprovalStatusReconcilerTickOptions = {},
): Promise<ApprovalStatusReconcilerTickSummary> {
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const rows = await findApprovalCandidates(db, maxCandidates + 1);
  const capped = Math.max(0, rows.length - maxCandidates);
  const batch = capped > 0 ? rows.slice(0, maxCandidates) : rows;

  const summary: ApprovalStatusReconcilerTickSummary = {
    scanned: 0,
    republished: 0,
    skipped: {},
    skippedDetails: [],
    failed: 0,
    failedDetails: [],
    capped,
  };

  for (const row of batch) {
    summary.scanned += 1;
    const label = row.identifier ?? row.id;
    try {
      const result = await reconcileCandidate(db, row);
      if (result.kind === "republished") {
        summary.republished += 1;
      } else if (result.kind === "skipped") {
        summary.skipped[result.reason] = (summary.skipped[result.reason] ?? 0) + 1;
        if (summary.skippedDetails.length < MAX_DETAIL_ENTRIES) {
          summary.skippedDetails.push(`${label}: ${result.detail}`);
        }
      } else {
        summary.failed += 1;
        if (summary.failedDetails.length < MAX_DETAIL_ENTRIES) {
          summary.failedDetails.push(`${label}: ${result.detail}`);
        }
      }
    } catch (err) {
      summary.failed += 1;
      if (summary.failedDetails.length < MAX_DETAIL_ENTRIES) {
        summary.failedDetails.push(
          `${label}: tick_error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  logger.info(
    {
      scanned: summary.scanned,
      republished: summary.republished,
      skipped: summary.skipped,
      skippedDetails: summary.skippedDetails,
      failed: summary.failed,
      failedDetails: summary.failedDetails,
      capped: summary.capped,
    },
    "approval status reconciler tick",
  );
  return summary;
}

export interface ApprovalStatusReconcilerSchedule {
  intervalMs: number;
  maxCandidates?: number;
  /**
   * Delay before the first tick. Not zero, so a restart does not add GitHub
   * fan-out to the boot path; not the whole interval, because a server that
   * restarts more often than the interval would otherwise never reconcile.
   */
  initialDelayMs?: number;
  /** Seam for tests. */
  runTick?: (
    options: ApprovalStatusReconcilerTickOptions,
  ) => Promise<ApprovalStatusReconcilerTickSummary>;
}

/**
 * Start the periodic reconcile. Returns a stop function.
 *
 * Overlapping ticks are refused here: a slow tick (rate-limited GitHub fan-out)
 * must not queue behind itself.
 */
export function startApprovalStatusReconciler(
  db: Db,
  schedule: ApprovalStatusReconcilerSchedule,
): () => void {
  const runTick = schedule.runTick ?? ((tickOptions) => runApprovalStatusReconcilerTick(db, tickOptions));
  const tickOptions: ApprovalStatusReconcilerTickOptions = { maxCandidates: schedule.maxCandidates };
  let inFlight = false;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    if (inFlight) {
      logger.info("approval status reconciler still running; skipping this tick");
      return;
    }
    inFlight = true;
    void Promise.resolve(runTick(tickOptions))
      .catch((err) => {
        logger.warn({ err }, "approval status reconciler tick threw");
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const initialTimer = setTimeout(tick, schedule.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
  initialTimer.unref?.();
  const timer = setInterval(tick, schedule.intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearTimeout(initialTimer);
    clearInterval(timer);
  };
}
