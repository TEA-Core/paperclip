import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, externalObjectMentions, externalObjects, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import {
  isGitHubTokenResolution,
  resolveGitHubTokenCandidatesForRepo,
  resolveGitHubTokenForRepo,
} from "./github-credential.js";

/**
 * Carrier orphan janitor (PR-CARRIER-7).
 *
 * ADR-083 D14: cancel touches no workspace, branch or PR. Once the last
 * child goes terminal, the terminal sweep archives the workspace and
 * deletes the LOCAL branch, while Paperclip never deletes a remote branch
 * and never closes a PR — leaving a permanent orphaned draft and remote
 * branch. Measured at ~10.6/week and unbounded. This janitor is that
 * cleanup, and it owns the control plane's first PR-close and
 * branch-delete writes.
 *
 * It cleans up exactly one shape: an open carrier pull request whose
 * parent is `cancelled`, whose whole issue tree is terminal, and whose
 * tree holds no `done` issue. A cancelled parent with any completed
 * (done) descendant is holding completed child work — the stranded case.
 * That path is `carrier-stranded-surface.ts`, which surfaces it to an
 * operator and never auto-dispositions. The two paths are separate
 * services with separate cadence and enable knobs, and conflating them
 * is the failure mode: an auto-disposition on the stranded path destroys
 * completed work.
 *
 * The janitor NEVER touches a carrier whose parent has non-terminal
 * descendants. That is the terminal sweep's descendant guard
 * (`sweepTerminalWorkspaces` in execution-workspaces.ts), copied, not
 * re-derived: the same terminal status set, the same recursive
 * company-scoped `parent_id` tree, and the same fail-closed discipline —
 * the sweep embeds a `NOT EXISTS (non-terminal descendant)` clause in
 * its mutating SQL, and this janitor re-queries the tree immediately
 * before its GitHub write instead, aborting when the tree moved.
 *
 * Cadence is the done-close-landing-backstop cadence: the heartbeat tick
 * fires the call every 30 s and the min-interval gate inside `sweep`
 * makes every non-due tick a no-op.
 */

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const CARRIER_ORPHAN_JANITOR_SWEEP_INTERVAL_ENV = "CARRIER_ORPHAN_JANITOR_SWEEP_INTERVAL_MS";
const CARRIER_ORPHAN_JANITOR_ENABLED_ENV = "CARRIER_ORPHAN_JANITOR_ENABLED";

export const CARRIER_ORPHAN_JANITOR_ACTOR_ID = "system:carrier-orphan-janitor";
export const CARRIER_ORPHAN_JANITOR_CLOSED_ACTION = "issue.carrier_orphan_closed";

/** Copied from the terminal sweep's `TERMINAL_ISSUE_STATUSES` — do not diverge. */
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

const EXTERNAL_PR_PATTERN = /^([^/]+)\/([^/]+)#(pull|issues)\/([1-9][0-9]*)$/;

export interface CarrierOrphanJanitorSweepResult {
  /** False when the enable flag or the min-interval gate short-circuited the tick (no-op). */
  due: boolean;
  /** Open carrier PRs of a cancelled parent that passed the orphan classification. */
  candidates: number;
  /** Carriers held by the descendant guard: a non-terminal issue in the parent's tree. */
  skippedNonTerminalTree: number;
  /** Carriers holding completed (done) descendant work: the stranded surface path's job, never deleted here. */
  stranded: number;
  /** PRs a prior sweep already closed, or that live state no longer reads open. */
  alreadyClosed: number;
  /** PRs closed and remote carrier branches deleted this tick. */
  closed: number;
  failed: number;
}

export interface CarrierOrphanJanitorOptions {
  /** Minimum spacing between actual measurement runs. */
  sweepIntervalMs?: number;
  /** Runtime kill switch for this path only; defaults to the env flag (enabled). */
  enabled?: boolean;
  now?: () => Date;
}

export interface ClosePullRequestResult {
  success: boolean;
  status: number;
  error: string | null;
}

export interface DeleteBranchResult {
  success: boolean;
  /** True when the branch was already gone: a deleted head is success, it is the converged state of a retried sweep. */
  alreadyDeleted: boolean;
  status: number;
  error: string | null;
}

export interface LivePullRequestState {
  state: "open" | "closed" | "merged" | "unknown";
  headRef: string | null;
  status: number;
}

/** Returns the value when it is a non-empty string, else null. */
function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Reads a positive-integer millisecond env var, falling back to `fallbackMs` on missing or invalid values. */
function readMsEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallbackMs;
}

/** Reads the enable flag for this path: unset means enabled; 0/false/off/no disable it. */
function readEnabledFlag(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[CARRIER_ORPHAN_JANITOR_ENABLED_ENV];
  if (raw === undefined || raw === "") return true;
  return !/^(0|false|off|no)$/i.test(raw.trim());
}

/** Splits a `owner/repo#pull/123` external id into owner/repo/number, or null when not a pull request. */
function parseExternalPullRequest(externalId: string): { owner: string; repo: string; number: number } | null {
  const match = EXTERNAL_PR_PATTERN.exec(externalId);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!, number: Number(match[4]) };
}

/**
 * Extracts the head branch ref from a cached external object's data. The
 * canonical shape is the flat `headRef` key the GitHub external-object
 * provider writes; nested `head.ref` and flat `headRefName` are tolerated
 * for legacy cached rows.
 */
function headRefFromData(data: Record<string, unknown>): string | null {
  const flat = readString(data.headRef);
  if (flat) return flat;
  const head = data.head;
  if (head && typeof head === "object" && !Array.isArray(head)) {
    const ref = (head as Record<string, unknown>).ref;
    if (typeof ref === "string" && ref.length > 0) return ref;
  }
  return readString(data.headRefName);
}

/**
 * Closes an open pull request. The first PR-close write the control plane
 * owns (ADR-083 D14); the caller is responsible for the descendant-guard
 * re-check that makes this safe.
 */
export async function closeGitHubPullRequest(
  token: string,
  owner: string,
  repo: string,
  number: number,
  hostname: string = "github.com",
): Promise<ClosePullRequestResult> {
  const url = `${gitHubApiBase(hostname)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/close`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-carrier-orphan-janitor",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };

  let response: Response;
  try {
    response = await ghFetch(url, { method: "POST", headers });
  } catch {
    return { success: false, status: 0, error: "network_error" };
  }

  if (response.ok) {
    return { success: true, status: response.status, error: null };
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  const message = body?.message as string | undefined;
  return { success: false, status: response.status, error: message ?? `HTTP ${response.status}` };
}

/**
 * Deletes a remote branch. A missing ref is success-with-alreadyDeleted:
 * the janitor deletes the branch before closing the PR so that a failed
 * close leaves a visible open PR whose head retry converges, while a
 * closed PR whose head delete failed would fall out of discovery and
 * leak the branch.
 */
export async function deleteGitHubBranch(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  hostname: string = "github.com",
): Promise<DeleteBranchResult> {
  const refPath = branch.split("/").map(encodeURIComponent).join("/");
  const url = `${gitHubApiBase(hostname)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${refPath}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-carrier-orphan-janitor",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };

  let response: Response;
  try {
    response = await ghFetch(url, { method: "DELETE", headers });
  } catch {
    return { success: false, alreadyDeleted: false, status: 0, error: "network_error" };
  }

  if (response.ok) {
    return { success: true, alreadyDeleted: false, status: response.status, error: null };
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  const message = (body?.message as string | undefined) ?? "";
  if (response.status === 404 || /already (deleted|removed)|not found/i.test(message)) {
    return { success: true, alreadyDeleted: true, status: response.status, error: null };
  }
  return { success: false, alreadyDeleted: false, status: response.status, error: message ?? `HTTP ${response.status}` };
}

/**
 * Measures a pull request's live state. Discovery rides the cached
 * external-object row, but every write decision re-measures: a cached row
 * can be arbitrarily stale and the janitor's only excuse for a write is
 * fresh evidence.
 */
export async function fetchGitHubPullRequestState(
  token: string,
  owner: string,
  repo: string,
  number: number,
  hostname: string = "github.com",
): Promise<LivePullRequestState> {
  const url = `${gitHubApiBase(hostname)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-carrier-orphan-janitor",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };

  let response: Response;
  try {
    response = await ghFetch(url, { headers });
  } catch {
    return { state: "unknown", headRef: null, status: 0 };
  }

  if (!response.ok) {
    return { state: "unknown", headRef: null, status: response.status };
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.state !== "string") {
    return { state: "unknown", headRef: null, status: response.status };
  }
  const state = body.state === "open" || body.state === "closed" || body.state === "merged"
    ? body.state
    : "unknown";
  const head = body.head as Record<string, unknown> | undefined | null;
  return { state, headRef: typeof head?.ref === "string" ? head.ref : null, status: response.status };
}

interface OpenCarrierRow {
  sourceIssueId: string;
  owner: string;
  repo: string;
  number: number;
  headRefName: string | null;
}

type DispositionOutcome = "closed" | "alreadyClosed" | "guardHeld" | "failed";

/**
 * Builds the carrier orphan janitor. `sweep` is meant to be fired by the
 * heartbeat tick; the min-interval gate inside makes non-due ticks cheap
 * no-ops.
 */
export function createCarrierOrphanJanitorService(db: Db, opts: CarrierOrphanJanitorOptions = {}) {
  const sweepIntervalMs = opts.sweepIntervalMs ?? readMsEnv(CARRIER_ORPHAN_JANITOR_SWEEP_INTERVAL_ENV, DEFAULT_SWEEP_INTERVAL_MS);
  const enabled = opts.enabled ?? readEnabledFlag();
  const now = opts.now ?? (() => new Date());
  let lastRunAt: number | null = null;

  /** The source issue plus all transitive descendants, company-scoped — the same recursive `parent_id` walk the terminal sweep guards on. */
  async function listIssueTree(companyId: string, rootIssueId: string) {
    return db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        sql<boolean>`
          ${issues.id} IN (
            WITH RECURSIVE issue_tree(id) AS (
              SELECT ${issues.id}
              FROM ${issues}
              WHERE ${issues.companyId} = ${companyId}
                AND ${issues.id} = ${rootIssueId}
              UNION ALL
              SELECT child.id
              FROM ${issues} child
              JOIN issue_tree parent ON child.parent_id = parent.id
              WHERE child.company_id = ${companyId}
            )
            SELECT id FROM issue_tree
          )
        `,
      ));
  }

  /** True when the tree is all terminal with no completed (done) issue — the orphan classification. */
  function isCleanOrphanTree(tree: Array<{ status: string }>): boolean {
    if (!tree.every((issue) => TERMINAL_ISSUE_STATUSES.has(issue.status))) return false;
    return !tree.some((issue) => issue.status === "done");
  }

  /** Runs one sweep pass: gate on cadence, then discover, classify, guard and dispose. */
  async function sweep(): Promise<CarrierOrphanJanitorSweepResult> {
    const checkedAt = now();
    // The heartbeat tick fires every 30s; GitHub measurement is expensive,
    // so every non-due tick and every disabled tick is a no-op.
    if (!enabled || (lastRunAt !== null && checkedAt.getTime() - lastRunAt < sweepIntervalMs)) {
      return { due: false, candidates: 0, skippedNonTerminalTree: 0, stranded: 0, alreadyClosed: 0, closed: 0, failed: 0 };
    }
    lastRunAt = checkedAt.getTime();
    const result: CarrierOrphanJanitorSweepResult = {
      due: true,
      candidates: 0,
      skippedNonTerminalTree: 0,
      stranded: 0,
      alreadyClosed: 0,
      closed: 0,
      failed: 0,
    };

    // Discovery rides the cached external-object rows: every open GitHub
    // pull request (draft or ready). Which one is whose carrier is decided
    // per parent by status and the branch prefix below.
    const rows = await db
      .select({
        sourceIssueId: externalObjectMentions.sourceIssueId,
        externalId: externalObjects.externalId,
        data: externalObjects.data,
      })
      .from(externalObjectMentions)
      .innerJoin(externalObjects, eq(externalObjects.id, externalObjectMentions.objectId))
      .where(
        and(
          eq(externalObjectMentions.objectType, "pull_request"),
          eq(externalObjects.providerKey, "github"),
          sql`${externalObjects.data}->>'state' = 'open'`,
        ),
      );

    const open: OpenCarrierRow[] = [];
    for (const row of rows) {
      const parsed = parseExternalPullRequest(row.externalId);
      if (!parsed) continue;
      open.push({
        sourceIssueId: row.sourceIssueId,
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
        headRefName: headRefFromData(row.data),
      });
    }
    if (open.length === 0) return result;

    // A carrier belongs to the source issue's parent, or to the source
    // issue when it has no parent (same mapping as the promotion sweep).
    const sourceIds = [...new Set(open.map((row) => row.sourceIssueId))];
    const sourceIssues = await db
      .select({ id: issues.id, parentId: issues.parentId })
      .from(issues)
      .where(inArray(issues.id, sourceIds));
    const parentBySource = new Map(sourceIssues.map((row) => [row.id, row.parentId ?? row.id]));

    const byParent = new Map<string, OpenCarrierRow[]>();
    for (const row of open) {
      const parentId = parentBySource.get(row.sourceIssueId);
      if (!parentId) continue;
      const list = byParent.get(parentId);
      if (list) list.push(row);
      else byParent.set(parentId, [row]);
    }

    for (const [parentId, parentPrs] of byParent) {
      try {
        await janitorParent(parentId, parentPrs, result);
      } catch (err) {
        logger.warn(
          { err, parentId },
          "carrier orphan janitor: parent sweep failed; will retry next sweep",
        );
      }
    }
    return result;
  }

  /** Classifies one parent's open carrier PRs and disposes the clean orphans. */
  async function janitorParent(parentId: string, parentPrs: OpenCarrierRow[], result: CarrierOrphanJanitorSweepResult) {
    const [parent] = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        identifier: issues.identifier,
      })
      .from(issues)
      .where(eq(issues.id, parentId));
    // Only cancelled parents orphan a carrier: done parents ship through
    // the normal promotion/merge flow, and live parents are not ours.
    if (!parent || parent.status !== "cancelled") return;
    const prefix = (parent.identifier ?? "").toLowerCase();
    if (!prefix) return;
    const carrierBranchPrefix = `${prefix}-`;
    const carrierPrs = parentPrs
      .filter((pr) => pr.headRefName !== null && pr.headRefName.toLowerCase().startsWith(carrierBranchPrefix))
      .sort((a, b) => a.number - b.number);
    if (carrierPrs.length === 0) return;

    // Descendant guard, first pass: the parent's whole recursive tree must
    // be terminal, and a single done descendant moves the parent to the
    // stranded path instead.
    const tree = await listIssueTree(parent.companyId, parent.id);
    if (!tree.every((issue) => TERMINAL_ISSUE_STATUSES.has(issue.status))) {
      result.skippedNonTerminalTree += carrierPrs.length;
      return;
    }
    if (tree.some((issue) => issue.status === "done")) {
      result.stranded += carrierPrs.length;
      return;
    }

    // Idempotence with no new column/table: any prior closed row for this
    // (parent, PR) means the carrier was already dispositioned by an
    // earlier sweep and must not be re-dispositioned.
    const existing = await db
      .select({ details: activityLog.details, action: activityLog.action })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, parent.id),
          eq(activityLog.action, CARRIER_ORPHAN_JANITOR_CLOSED_ACTION),
        ),
      );
    const alreadyClosed = new Set(
      existing
        .map((row) => readString(row.details?.pr))
        .filter((value): value is string => value !== null),
    );

    for (const pr of carrierPrs) {
      const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
      if (alreadyClosed.has(prKey)) {
        result.alreadyClosed += 1;
        continue;
      }
      result.candidates += 1;
      const outcome = await disposeOrphan(parent, pr, prKey);
      if (outcome === "closed") result.closed += 1;
      else if (outcome === "alreadyClosed") result.alreadyClosed += 1;
      else if (outcome === "guardHeld") result.skippedNonTerminalTree += 1;
      else result.failed += 1;
    }
  }

  /**
   * Disposes one orphan carrier: live-measure, re-check the guard, delete
   * the branch, close the PR, log the disposition.
   */
  async function disposeOrphan(
    parent: { companyId: string; id: string; identifier: string | null },
    pr: OpenCarrierRow,
    prKey: string,
  ): Promise<DispositionOutcome> {
    const candidates = await resolveGitHubTokenCandidatesForRepo(db, parent.companyId, pr.owner, pr.repo);
    if (candidates.length === 0) {
      const tokenResult = await resolveGitHubTokenForRepo(db, parent.companyId, pr.owner, pr.repo);
      const reason = isGitHubTokenResolution(tokenResult)
        ? "No GitHub token resolvable"
        : tokenResult.reason;
      logger.warn({ pr: prKey, reason }, "carrier orphan janitor: no GitHub token candidates");
      return "failed";
    }

    for (const candidate of candidates) {
      const token = candidate.token;

      const live = await fetchGitHubPullRequestState(token, pr.owner, pr.repo, pr.number);
      if (live.state === "unknown") {
        if (live.status === 401 || live.status === 403) {
          if (candidate !== candidates[candidates.length - 1]) continue;
        }
        logger.warn(
          { pr: prKey, status: live.status },
          "carrier orphan janitor: live PR state unmeasurable; will retry next sweep",
        );
        return "failed";
      }
      if (live.state !== "open") return "alreadyClosed";

      // Fail-closed re-check immediately before the write: the terminal
      // sweep's descendant guard, embedded in its archive SQL, re-queried
      // here. If any descendant came back to life since discovery, or
      // completed, the tree no longer classifies as a clean orphan and the
      // write is refused.
      const rechecked = await listIssueTree(parent.companyId, parent.id);
      if (!isCleanOrphanTree(rechecked)) {
        logger.warn({ pr: prKey }, "carrier orphan janitor: descendant guard re-check failed; refusing write");
        return "guardHeld";
      }

      // Branch first, PR second: a failed close then leaves a visible open
      // PR whose head retry converges (the delete reports alreadyDeleted),
      // while a failed delete after a close would orphan the branch beyond
      // discovery.
      const branch = live.headRef ?? null;
      if (branch) {
        const branchResult = await deleteGitHubBranch(token, pr.owner, pr.repo, branch);
        if (!branchResult.success) {
          if (branchResult.status === 401 || branchResult.status === 403) {
            if (candidate !== candidates[candidates.length - 1]) continue;
          }
          logger.warn(
            { pr: prKey, branch, status: branchResult.status, error: branchResult.error },
            "carrier orphan janitor: branch delete failed; will retry next sweep",
          );
          return "failed";
        }
      }

      const closeResult = await closeGitHubPullRequest(token, pr.owner, pr.repo, pr.number);
      if (closeResult.success) {
        await logActivity(db, {
          companyId: parent.companyId,
          actorType: "system",
          actorId: CARRIER_ORPHAN_JANITOR_ACTOR_ID,
          agentId: null,
          runId: null,
          agentApiKeyId: null,
          action: CARRIER_ORPHAN_JANITOR_CLOSED_ACTION,
          entityType: "issue",
          entityId: parent.id,
          issueId: parent.id,
          details: {
            identifier: parent.identifier ?? null,
            pr: prKey,
            branch: branch ?? null,
            prState: "closed",
          },
        });
        return "closed";
      }

      if (closeResult.status === 401 || closeResult.status === 403) {
        if (candidate !== candidates[candidates.length - 1]) continue;
      }
      logger.warn(
        { pr: prKey, status: closeResult.status, error: closeResult.error },
        "carrier orphan janitor: PR close failed; will retry next sweep",
      );
      return "failed";
    }

    return "failed";
  }

  return { sweep };
}
