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
import { issueService } from "./issues.js";

/**
 * Carrier stranded surface (PR-CARRIER-7, ADR-083 D14).
 *
 * A cancelled parent whose carrier holds completed child commits is
 * stranded work. The terminal sweep's descendant guard kept the carrier
 * safe while descendants were live; once the last one went terminal the
 * local branch was deleted, but Paperclip never closes a PR and never
 * deletes a remote branch — so the carrier sits open forever holding
 * work. Whether that work is worth merging is a judgement, and stays one:
 * this service SURFACES it to an operator as a single card. It never
 * promotes, merges, closes or deletes anything.
 *
 * The deletion path is the janitor in `carrier-orphan-janitor.ts`. The
 * two are separate services — separately testable, separately
 * disableable — and a cancelled parent with a done descendant can never
 * be a janitor candidate, so this path's card is the only disposition a
 * stranded carrier receives.
 *
 * Cadence is the done-close-landing-backstop cadence: the heartbeat tick
 * fires the call every 30 s and the min-interval gate inside `sweep`
 * makes every non-due tick a no-op.
 */

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const CARRIER_STRANDED_SURFACE_SWEEP_INTERVAL_ENV = "CARRIER_STRANDED_SURFACE_SWEEP_INTERVAL_MS";
const CARRIER_STRANDED_SURFACE_ENABLED_ENV = "CARRIER_STRANDED_SURFACE_ENABLED";

export const CARRIER_STRANDED_SURFACE_ACTOR_ID = "system:carrier-stranded-surface";
export const CARRIER_STRANDED_SURFACE_ACTION = "issue.carrier_stranded_surfaced";

/** Copied from the terminal sweep's `TERMINAL_ISSUE_STATUSES` — do not diverge. */
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

const EXTERNAL_PR_PATTERN = /^([^/]+)\/([^/]+)#(pull|issues)\/([1-9][0-9]*)$/;

/** Operator cards parked for a decision: not terminal, and not cancelled by the operator. */
const OPEN_CARD_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];

export interface CarrierStrandedSurfaceSweepResult {
  /** False when the enable flag or the min-interval gate short-circuited the tick (no-op). */
  due: boolean;
  /** Cancelled parents with completed (done) descendants and an open carrier PR. */
  candidates: number;
  /** Operator cards created this tick. */
  surfaced: number;
  /** Candidates that already carry an open card: one card per stranded parent. */
  alreadySurfaced: number;
  /** Candidates whose live carrier PR measured a 200 that does not read open: a genuinely closed or merged carrier. */
  prNotOpen: number;
  /** Candidates whose live state could not be measured: no token candidate, a network error, or a non-OK response. */
  failed: number;
}

export interface CarrierStrandedSurfaceOptions {
  /** Minimum spacing between actual measurement runs. */
  sweepIntervalMs?: number;
  /** Runtime kill switch for this path only; defaults to the env flag (enabled). */
  enabled?: boolean;
  now?: () => Date;
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
  const raw = env[CARRIER_STRANDED_SURFACE_ENABLED_ENV];
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

/** Measures a pull request's live state; the card is only created on a measured-open carrier. */
async function fetchLivePullRequestState(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<{ open: boolean; headRef: string | null; status: number }> {
  const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-carrier-stranded-surface",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };

  let response: Response;
  try {
    response = await ghFetch(url, { headers });
  } catch {
    return { open: false, headRef: null, status: 0 };
  }
  if (!response.ok) {
    return { open: false, headRef: null, status: response.status };
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || body.state !== "open") {
    return { open: false, headRef: null, status: response.status };
  }
  const head = body.head as Record<string, unknown> | undefined | null;
  return { open: true, headRef: typeof head?.ref === "string" ? head.ref : null, status: response.status };
}

interface OpenCarrierRow {
  sourceIssueId: string;
  owner: string;
  repo: string;
  number: number;
  headRefName: string | null;
}

/** Builds the deterministic operator-card title for one stranded parent. */
export function buildStrandedCardTitle(identifier: string): string {
  return `Stranded carrier: ${identifier} — operator decision required`;
}

/** Builds the operator card's description: the evidence and the two decisions an operator can make. */
export function buildStrandedCardDescription(input: {
  identifier: string | null;
  pr: string;
  branch: string | null;
  completedChildren: string[];
}): string {
  const children = input.completedChildren.length > 0
    ? input.completedChildren.map((child) => `- ${child}`).join("\n")
    : "- (none recorded)";
  return [
    "The carrier branch of a cancelled parent still holds completed child work.",
    "",
    `- Parent: **${input.identifier ?? "?"}** (cancelled)`,
    `- Carrier PR: ${input.pr}`,
    `- Head branch: ${input.branch ?? "(unknown)"}`,
    `- Completed children (done):`,
    children,
    "",
    "ADR-083 D14: this work is surfaced, not automated. Whether it is worth merging is a judgement.",
    "Decide one of:",
    "1. Keep the work: merge or rebase the completed commits into the target, then close this PR and delete the branch.",
    "2. Discard the work: close the PR and delete the branch.",
    "",
    "Paperclip will not close this PR or delete this branch on its own.",
  ].join("\n");
}

/**
 * Builds the carrier stranded surface service. `sweep` is meant to be
 * fired by the heartbeat tick; the min-interval gate inside makes
 * non-due ticks cheap no-ops.
 */
export function createCarrierStrandedSurfaceService(db: Db, opts: CarrierStrandedSurfaceOptions = {}) {
  const sweepIntervalMs = opts.sweepIntervalMs ?? readMsEnv(CARRIER_STRANDED_SURFACE_SWEEP_INTERVAL_ENV, DEFAULT_SWEEP_INTERVAL_MS);
  const enabled = opts.enabled ?? readEnabledFlag();
  const now = opts.now ?? (() => new Date());
  let lastRunAt: number | null = null;

  /** The source issue plus all transitive descendants, company-scoped. */
  async function listIssueTree(companyId: string, rootIssueId: string) {
    return db
      .select({ id: issues.id, status: issues.status, identifier: issues.identifier })
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

  /** Runs one sweep pass: gate on cadence, then discover, classify and surface. */
  async function sweep(): Promise<CarrierStrandedSurfaceSweepResult> {
    const checkedAt = now();
    // The heartbeat tick fires every 30s; GitHub measurement is expensive,
    // so every non-due tick and every disabled tick is a no-op.
    if (!enabled || (lastRunAt !== null && checkedAt.getTime() - lastRunAt < sweepIntervalMs)) {
      return { due: false, candidates: 0, surfaced: 0, alreadySurfaced: 0, prNotOpen: 0, failed: 0 };
    }
    lastRunAt = checkedAt.getTime();
    const result: CarrierStrandedSurfaceSweepResult = {
      due: true,
      candidates: 0,
      surfaced: 0,
      alreadySurfaced: 0,
      prNotOpen: 0,
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
        await surfaceParent(parentId, parentPrs, result);
      } catch (err) {
        logger.warn(
          { err, parentId },
          "carrier stranded surface: parent sweep failed; will retry next sweep",
        );
      }
    }
    return result;
  }

  /** Surfaces one cancelled parent's stranded carrier as a single operator card. */
  async function surfaceParent(parentId: string, parentPrs: OpenCarrierRow[], result: CarrierStrandedSurfaceSweepResult) {
    const [parent] = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        identifier: issues.identifier,
      })
      .from(issues)
      .where(eq(issues.id, parentId));
    // Only cancelled parents strand a carrier; every other status has a
    // normal disposition path.
    if (!parent || parent.status !== "cancelled") return;
    const prefix = (parent.identifier ?? "").toLowerCase();
    if (!prefix) return;
    const carrierBranchPrefix = `${prefix}-`;
    const carrierPrs = parentPrs
      .filter((pr) => pr.headRefName !== null && pr.headRefName.toLowerCase().startsWith(carrierBranchPrefix))
      .sort((a, b) => a.number - b.number);
    if (carrierPrs.length === 0) return;

    const tree = await listIssueTree(parent.companyId, parent.id);
    const completedChildren = tree.filter((issue) => issue.status === "done");
    // No completed descendant: the carrier holds no completed work, so
    // there is nothing to surface (or the janitor owns it as a clean
    // orphan).
    if (completedChildren.length === 0) return;

    // One card per stranded parent: an open card under the parent with the
    // deterministic title means this parent was already surfaced.
    const title = buildStrandedCardTitle(parent.identifier ?? "");
    const existingCards = await db
      .select({ id: issues.id, status: issues.status, title: issues.title })
      .from(issues)
      .where(and(
        eq(issues.companyId, parent.companyId),
        eq(issues.parentId, parent.id),
        eq(issues.title, title),
        inArray(issues.status, OPEN_CARD_STATUSES),
      ));
    if (existingCards.length > 0) {
      result.alreadySurfaced += 1;
      return;
    }

    // The lowest-numbered open carrier PR is the one to name in the card;
    // its live state must read open before the card is created — a carrier
    // that has already been dispositioned by an operator is not stranded.
    const primary = carrierPrs[0]!;
    const prKey = `${primary.owner}/${primary.repo}#${primary.number}`;

    const candidates = await resolveGitHubTokenCandidatesForRepo(db, parent.companyId, primary.owner, primary.repo);
    let live: { open: boolean; headRef: string | null; status: number };
    if (candidates.length === 0) {
      const tokenResult = await resolveGitHubTokenForRepo(db, parent.companyId, primary.owner, primary.repo);
      const reason = isGitHubTokenResolution(tokenResult)
        ? "No GitHub token resolvable"
        : tokenResult.reason;
      logger.warn({ pr: prKey, reason }, "carrier stranded surface: no GitHub token candidates");
      live = { open: false, headRef: null, status: 0 };
    } else {
      live = { open: false, headRef: null, status: 0 };
      for (const candidate of candidates) {
        live = await fetchLivePullRequestState(candidate.token, primary.owner, primary.repo, primary.number);
        if (live.open) break;
        const retriable = live.status === 401 || live.status === 403;
        if (!retriable || candidate === candidates[candidates.length - 1]) break;
      }
    }
    if (!live.open) {
      // A 200 that does not read open is a genuinely closed/merged carrier
      // (prNotOpen); a 0 or non-OK status is a measurement failure. The two
      // must not share a counter or operator reporting cannot distinguish
      // a closed carrier from an unmeasurable one.
      if (live.status === 200) result.prNotOpen += 1;
      else result.failed += 1;
      return;
    }
    result.candidates += 1;

    const branch = live.headRef ?? primary.headRefName;
    const completedIdentifiers = completedChildren.map(
      (issue) => (issue.identifier ?? issue.id) as string,
    );
    const description = buildStrandedCardDescription({
      identifier: parent.identifier ?? null,
      pr: prKey,
      branch,
      completedChildren: completedIdentifiers,
    });

    const created = await issueService(db).create(parent.companyId, {
      title,
      description,
      parentId: parent.id,
      status: "backlog",
      // SUP-14154: an operator-only card carries no agent assignee.
      assigneeAgentId: null,
      assigneeUserId: null,
      // Deterministic key: a race between two ticks cannot double-create
      // within the retention window; the title check above is the durable
      // one-card-per-parent guarantee.
      idempotencyKey: `carrier-stranded-surface:${parent.id}`,
    });

    await logActivity(db, {
      companyId: parent.companyId,
      actorType: "system",
      actorId: CARRIER_STRANDED_SURFACE_ACTOR_ID,
      agentId: null,
      runId: null,
      agentApiKeyId: null,
      action: CARRIER_STRANDED_SURFACE_ACTION,
      entityType: "issue",
      entityId: parent.id,
      issueId: parent.id,
      details: {
        identifier: parent.identifier ?? null,
        pr: prKey,
        branch: branch ?? null,
        cardId: created?.id ?? null,
        completedChildren: completedIdentifiers,
      },
    });
    result.surfaced += 1;
  }

  return { sweep };
}
