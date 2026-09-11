import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRecoveryActions, issues, summarySlots } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";
import {
  queueIssueAssignmentWakeup,
  type IssueAssignmentWakeupDeps,
} from "./issue-assignment-wakeup.js";
import { summarySlotService } from "./summary-slots.js";
import type {
  SummarySlotKey,
  SummarySlotScopeKind,
  SummarySlotStatus,
} from "@paperclipai/shared";

/**
 * Summary-slot refresh sweep (SUP-12426, shape 2).
 *
 * Summary generation is gated to board operators in
 * `routes/summary-slots.ts` (`assertCanGenerateSummary`), so there is no
 * non-board path that can ask a slot to regenerate. As a result a stale slot
 * (never generated, or generated more than the staleness threshold ago) and a
 * failed slot can never be re-claimed: the only writer is the board, and the
 * board's manual trigger requires a board-typed credential. This sweep
 * recovers that path the same way the carrier-promotion and
 * done-close-landing backstops do: it is fired by the heartbeat tick every
 * 30s and a min-interval gate makes every non-due tick a cheap no-op.
 *
 * A candidate is:
 *   - a `failed` slot (always retried), or
 *   - a `generating` slot (the service re-checks the linked issue: an active,
 *     progressing issue means in-flight and is left alone; a dead/wedged issue
 *     is re-claimed — see below), or
 *   - an `idle` slot that is stale: `lastGeneratedAt` is null, or older than
 *     the staleness threshold. Fresh idle slots are excluded at the query so
 *     a recently-written summary is never re-fired.
 *
 * For each candidate the sweep calls `summarySlotService(db).generate` at the
 * service layer — the exact consume-contract the HTTP route uses. For a fresh
 * claim it records the route-equivalent `summary_slot.generate_requested`
 * activity entry and fires the same assignment wakeup the route fires so the
 * Summarizer claims it. For a slot that is already `generating` with an active,
 * progressing issue it does not re-fire `generate`, but re-delivers the
 * assignee wake so a wake that was rejected on the minting tick is retried
 * instead of leaving the slot stranded unwoken. The route's board gate is left
 * untouched: this path is board-side, in-process, and does not introduce any
 * new credential or auth branch.
 *
 * Wedged-generation recovery (SUP-15764): `generate` treats a `generating`
 * slot as in-flight while its generation issue is *active* (`status` not in
 * `{done, cancelled}`), and `blocked` counts as active. A slot pinned behind a
 * permanently-`blocked` generation issue — e.g. one parked on a board
 * `missing_disposition` recovery action — would otherwise be re-woken on every
 * due tick, forever, and logged nothing. Before claiming such a `generating`
 * candidate the sweep classifies it as *wedged* when EITHER:
 *   - its generation issue is `blocked` and carries an active recovery action
 *     in status `escalated` (`reason: "blocked_escalated_recovery"`), or
 *   - the slot has been `generating` for longer than the bounded, env-tunable
 *     window `SUMMARY_SLOT_REFRESH_WEDGED_MS` (default 6h)
 *     (`reason: "generating_age_exceeded"`).
 * A wedged slot is re-claimed: the sweep clears the stale `generating` link so
 * `generate` mints a fresh issue instead of short-circuiting to
 * `alreadyGenerating`, and records a `summary_slot.generate_requested` entry
 * flagged `wedgedRecovery: true` so the recovery is visible in the activity
 * log instead of a silent strand. A slot that is merely in-flight (progressing
 * or recently updated) is never re-claimed, so live generations are not thrashed.
 */

const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_WEDGED_MS = 6 * 60 * 60 * 1000;

export const SUMMARY_SLOT_REFRESH_ACTOR_ID = "system:summary-slot-refresh";

export interface SummarySlotRefreshSweepOptions {
  /** How old (ms since `lastGeneratedAt`) a summary must be before it counts as stale. */
  staleMs?: number;
  /** Minimum spacing between actual measurement runs. */
  sweepIntervalMs?: number;
  /**
   * How long (ms since `updatedAt`) a `generating` slot may stay pinned behind
   * its generation issue before the sweep treats it as wedged and re-claims it,
   * even if the issue is not `blocked`. Read from `SUMMARY_SLOT_REFRESH_WEDGED_MS`
   * when omitted (default 6h).
   */
  wedgedMs?: number;
  now?: () => Date;
  /**
   * The heartbeat wakeup dispatcher. Injected so the sweep can wake the
   * Summarizer to claim each freshly-minted generation task — the same wake
   * the HTTP route fires after `generate`. When omitted (e.g. in unit tests),
   * generation tasks are still created but not explicitly woken.
   */
  wakeup?: IssueAssignmentWakeupDeps["wakeup"];
}

export interface SummarySlotRefreshSweepResult {
  /** False when the min-interval gate short-circuited the tick (no-op). */
  due: boolean;
  /** True when the instance `experimental.enableSummaries` gate passed; false means the tick was a settings no-op. */
  summariesEnabled: boolean;
  /** Slots selected this tick that needed a generation claim. */
  candidates: number;
  /** Slots whose `generate` minted a fresh task AND whose assignee wake was delivered (or no wake dispatcher was configured). */
  claimed: number;
  /** Slots already in flight: a live generation issue existed, so no re-fire; the assignee wake is re-delivered so a previously-rejected wake is retried. */
  inFlight: number;
  /** Slots whose `generate`, its assignee wake, or an in-flight re-wake threw (Summarizer not configured, target gone, wake rejected, etc.); retried next sweep. */
  failed: number;
}

type SummarySlotRefreshCandidate = {
  companyId: string;
  scopeKind: SummarySlotScopeKind;
  slotKey: SummarySlotKey;
  scopeId: string | null;
  status: SummarySlotStatus;
  generatingIssueId: string | null;
  updatedAt: Date;
};

/** Why a `generating` candidate was classified as wedged and re-claimed. */
type WedgedReason = "blocked_escalated_recovery" | "generating_age_exceeded";

/** Reads a positive-integer millisecond env var, falling back to `fallbackMs` on missing or invalid values. */
function readMsEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallbackMs;
}

/** Session task key mirroring `summarySlotSessionTaskKey` in routes/summary-slots.ts. */
function summarySlotRefreshTaskKey(c: SummarySlotRefreshCandidate): string {
  return `summary-slot:${c.companyId}:${c.scopeKind}:${c.scopeId ?? "company"}:${c.slotKey}`;
}

/**
 * Builds the summary-slot refresh sweep service. `sweep` is meant to be fired
 * by the heartbeat tick every 30s; the min-interval gate inside makes
 * non-due ticks cheap no-ops.
 */
export function createSummarySlotRefreshSweepService(
  db: Db,
  opts: SummarySlotRefreshSweepOptions = {},
) {
  const staleMs = opts.staleMs ?? readMsEnv("SUMMARY_SLOT_REFRESH_STALE_MS", DEFAULT_STALE_MS);
  const sweepIntervalMs =
    opts.sweepIntervalMs ?? readMsEnv("SUMMARY_SLOT_REFRESH_SWEEP_INTERVAL_MS", DEFAULT_SWEEP_INTERVAL_MS);
  const wedgedMs = opts.wedgedMs ?? readMsEnv("SUMMARY_SLOT_REFRESH_WEDGED_MS", DEFAULT_WEDGED_MS);
  const now = opts.now ?? (() => new Date());
  let lastRunAt: number | null = null;

  /** Runs one sweep pass: gate on cadence, check the summaries flag, then discover and claim. */
  async function sweep(): Promise<SummarySlotRefreshSweepResult> {
    const checkedAt = now();
    // The heartbeat tick fires every 30s; generation is expensive, so every
    // non-due tick is a no-op.
    if (lastRunAt !== null && checkedAt.getTime() - lastRunAt < sweepIntervalMs) {
      return { due: false, summariesEnabled: false, candidates: 0, claimed: 0, inFlight: 0, failed: 0 };
    }
    lastRunAt = checkedAt.getTime();

    const experimental = await instanceSettingsService(db).getExperimental();
    if (experimental.enableSummaries !== true) {
      return { due: true, summariesEnabled: false, candidates: 0, claimed: 0, inFlight: 0, failed: 0 };
    }

    const result: SummarySlotRefreshSweepResult = {
      due: true,
      summariesEnabled: true,
      candidates: 0,
      claimed: 0,
      inFlight: 0,
      failed: 0,
    };

    const staleCutoff = new Date(checkedAt.getTime() - staleMs);
    const candidates = await db
      .select({
        companyId: summarySlots.companyId,
        scopeKind: summarySlots.scopeKind,
        slotKey: summarySlots.slotKey,
        scopeId: summarySlots.scopeId,
        status: summarySlots.status,
        generatingIssueId: summarySlots.generatingIssueId,
        updatedAt: summarySlots.updatedAt,
      })
      .from(summarySlots)
      .where(
        or(
          eq(summarySlots.status, "failed"),
          eq(summarySlots.status, "generating"),
          and(
            eq(summarySlots.status, "idle"),
            or(isNull(summarySlots.lastGeneratedAt), lt(summarySlots.lastGeneratedAt, staleCutoff)),
          ),
        ),
      );

    if (candidates.length === 0) return result;

    const slotService = summarySlotService(db);

    /**
     * Delivers the assignee wake for a (fresh or in-flight) generation issue,
     * mirroring the HTTP route. Rethrows when the wake is rejected so the caller
     * can count it a failure and retry on the next sweep instead of silently
     * claiming a slot whose Summarizer was never woken.
     */
    async function fireWakeFor(
      generatingIssue: { id: string; assigneeAgentId?: string | null; status: string },
      taskKey: string,
    ): Promise<void> {
      if (!opts.wakeup) return;
      await queueIssueAssignmentWakeup({
        heartbeat: { wakeup: opts.wakeup },
        issue: {
          id: generatingIssue.id,
          assigneeAgentId: generatingIssue.assigneeAgentId ?? null,
          status: generatingIssue.status,
        },
        reason: "summary_slot_generation_requested",
        mutation: "summary_slot.generate",
        contextSource: "summary-slot-refresh-sweep",
        requestedByActorType: "system",
        taskKey,
        // Mirror the HTTP route (routes/summary-slots.ts): a rejected assignee
        // wake must surface as a failure, not resolve silently. Without this the
        // helper logs-and-resolves on a rejected wake and this tick would count a
        // claim for a slot whose Summarizer was never woken.
        rethrowOnError: true,
      });
    }

    /**
     * Decides whether a `generating` candidate is wedged behind a
     * non-progressing generation issue (SUP-15764). Two independent rules,
     * either of which marks the slot for re-claim:
     *   - the generation issue is `blocked` and has an active recovery action
     *     in status `escalated` — definitively parked on a human, so it will
     *     never progress on its own; or
     *   - the slot has been `generating` longer than the bounded `wedgedMs`
     *     window (an LLM summary should not take hours; a slot this old is
     *     not progressing).
     * A slot whose issue is merely active and recent (e.g. `in_review` just
     * updated) is NOT wedged, so live generations are left alone.
     */
    async function classifyGeneratingCandidate(
      candidate: SummarySlotRefreshCandidate,
      checkedAt: Date,
    ): Promise<{ wedged: boolean; reason: WedgedReason | null; supersededIssueId: string | null }> {
      const supersededIssueId = candidate.generatingIssueId;
      if (
        candidate.updatedAt &&
        checkedAt.getTime() - candidate.updatedAt.getTime() > wedgedMs
      ) {
        return { wedged: true, reason: "generating_age_exceeded", supersededIssueId };
      }
      if (supersededIssueId) {
        const issue = await db
          .select({ status: issues.status })
          .from(issues)
          .where(and(eq(issues.id, supersededIssueId), eq(issues.companyId, candidate.companyId)))
          .then((rows) => rows[0] ?? null);
        if (issue?.status === "blocked") {
          const escalated = await db
            .select({ id: issueRecoveryActions.id })
            .from(issueRecoveryActions)
            .where(
              and(
                eq(issueRecoveryActions.companyId, candidate.companyId),
                eq(issueRecoveryActions.sourceIssueId, supersededIssueId),
                eq(issueRecoveryActions.status, "escalated"),
              ),
            )
            .then((rows) => rows.length > 0);
          if (escalated) {
            return { wedged: true, reason: "blocked_escalated_recovery", supersededIssueId };
          }
        }
      }
      return { wedged: false, reason: null, supersededIssueId };
    }

    /**
     * Clears a wedged slot's stale `generating` link so the next `generate` call
     * mints a fresh generation issue instead of short-circuiting to
     * `alreadyGenerating` (the dedupe in `summarySlotService.generate` only
     * guards `status === "generating" && generatingIssueId`). This is the
     * minimal, in-process recovery write the board-side sweep owns; it never
     * touches `lastGeneratedAt` or `documentId`.
     */
    async function clearStaleGenerationLink(candidate: SummarySlotRefreshCandidate, checkedAt: Date): Promise<void> {
      await db
        .update(summarySlots)
        .set({
          status: "idle",
          generatingIssueId: null,
          failureReason: null,
          updatedAt: checkedAt,
        })
        .where(
          and(
            eq(summarySlots.companyId, candidate.companyId),
            eq(summarySlots.scopeKind, candidate.scopeKind),
            eq(summarySlots.slotKey, candidate.slotKey),
            candidate.scopeId === null ? isNull(summarySlots.scopeId) : eq(summarySlots.scopeId, candidate.scopeId),
          ),
        );
    }

    for (const candidate of candidates) {
      result.candidates += 1;
      try {
        // A `generating` slot pinned behind a non-progressing issue would
        // otherwise be re-woken on every due tick and logged nothing
        // (SUP-15764). Classify it; if it is wedged, clear the stale link so the
        // `generate` below re-claims the slot with a fresh issue instead of
        // returning `alreadyGenerating`.
        let wedgedRecovery: { reason: WedgedReason; supersededIssueId: string | null } | null = null;
        if (candidate.status === "generating") {
          const verdict = await classifyGeneratingCandidate(candidate, checkedAt);
          if (verdict.wedged && verdict.reason) {
            wedgedRecovery = { reason: verdict.reason, supersededIssueId: verdict.supersededIssueId };
            await clearStaleGenerationLink(candidate, checkedAt);
          }
        }

        const res = await slotService.generate(
          {
            companyId: candidate.companyId,
            scopeKind: candidate.scopeKind,
            slotKey: candidate.slotKey,
            scopeId: candidate.scopeId,
          },
          { agentId: null, userId: null, runId: null },
        );
        if (res.alreadyGenerating) {
          // A live generation issue already owns this slot: do not re-fire
          // `generate` (no second issue). But re-deliver the assignee wake — a
          // wake that was rejected on the tick that minted the issue would
          // otherwise strand the slot: it stays `generating` with an active
          // issue, so it is a candidate on every sweep, and without a re-wake the
          // Summarizer is never told to claim it. A rejected re-wake throws into
          // the catch below and counts `failed`, so the slot is retried, not
          // stranded.
          await fireWakeFor(res.generatingIssue, summarySlotRefreshTaskKey(candidate));
          // In-flight only when the re-wake was delivered (or no dispatcher is
          // configured); a rejected re-wake lands in the catch -> `failed`.
          result.inFlight += 1;
          continue;
        }
        // Fresh claim: a generation issue was minted and the slot flipped to
        // `generating`. Record the route-equivalent audit entry (AGENTS.md:
        // "activity logging for mutating actions") before firing the wake, so
        // the claim is audited even if the wake then fails. A wedged re-claim
        // is flagged so the recovery is visible in the log instead of a silent
        // strand.
        await logActivity(db, {
          companyId: candidate.companyId,
          actorType: "system",
          actorId: SUMMARY_SLOT_REFRESH_ACTOR_ID,
          action: "summary_slot.generate_requested",
          entityType: "summary_slot",
          entityId: res.slot.id,
          issueId: res.generatingIssue.id,
          details: {
            scopeKind: res.slot.scopeKind,
            scopeId: res.slot.scopeId,
            slotKey: res.slot.slotKey,
            generatingIssueId: res.generatingIssue.id,
            alreadyGenerating: res.alreadyGenerating,
            source: "summary-slot-refresh-sweep",
            ...(wedgedRecovery
              ? {
                  wedgedRecovery: true,
                  wedgedReason: wedgedRecovery.reason,
                  supersededGenerationIssueId: wedgedRecovery.supersededIssueId,
                }
              : {}),
          },
        });
        await fireWakeFor(res.generatingIssue, summarySlotRefreshTaskKey(candidate));
        // Count the claim only after the wake has been delivered (or no wake
        // dispatcher was configured). A rejected wake throws and lands in the
        // catch below, so it counts `failed` and is retried next sweep — never
        // a false `claimed`.
        result.claimed += 1;
      } catch (err) {
        result.failed += 1;
        logger.warn(
          { err, actorId: SUMMARY_SLOT_REFRESH_ACTOR_ID, companyId: candidate.companyId, scopeKind: candidate.scopeKind, slotKey: candidate.slotKey },
          "summary slot refresh sweep: generate failed; will retry next sweep",
        );
      }
    }

    return result;
  }

  return { sweep };
}
