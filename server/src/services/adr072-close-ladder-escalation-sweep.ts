import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, issues } from "@paperclipai/db";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { HttpError } from "../errors.js";
import { logActivityInTransaction } from "./activity-log.js";
import { issueService } from "./issues.js";
import {
  countLadderedChildren,
  findMissingAdr072CloseLadderStages,
} from "./done-transition-guard.js";
import {
  applyIssueMonitorPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";

export const ADR072_CLOSE_LADDER_ADVISORY_ACTION =
  "issue.adr072_close_ladder_incomplete";
export const ADR072_CLOSE_LADDER_ESCALATION_ACTION =
  "issue.adr072_close_ladder_escalated";
export const ADR072_CLOSE_LADDER_ESCALATION_WAKE_DELIVERED_ACTION =
  "issue.adr072_close_ladder_escalation_wake_delivered";
export const ADR072_CLOSE_LADDER_BOARD_ESCALATION_ACTION =
  "issue.adr072_close_ladder_escalated_to_board";
export const ADR072_CLOSE_LADDER_ESCALATION_MARKER =
  "[ADR-072 close ladder escalation]";
export const ADR072_CLOSE_LADDER_ESCALATION_DELAY_MS = 120 * 60 * 1000;
export const ADR072_CLOSE_LADDER_ESCALATION_ACTOR_ID =
  "adr072-close-ladder-escalation";

const EXEC_CTO_URL_KEY = "exec-cto";
const ADR072_CLOSE_LADDER_ESCALATION_RETENTION_MS = 24 * 60 * 60 * 1000;
// Mirrors the exhausted-action board decision monitor (SUP-21344,
// recovery/service.ts): 1h between board checks, board gives up after 3.
const ADR072_CLOSE_LADDER_BOARD_MONITOR_INTERVAL_MS = 60 * 60 * 1000;
const ADR072_CLOSE_LADDER_BOARD_MONITOR_MAX_ATTEMPTS = 3;
const BOARD_MONITORABLE_STATUSES = new Set(["in_progress", "in_review", "blocked"]);

export type Adr072CloseLadderEscalationWakeup = (
  agentId: string,
  options: {
    source: "automation";
    triggerDetail: "system";
    reason: string;
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<unknown>;

export function buildAdr072CloseLadderEscalation(input: {
  identifier: string | null;
  missingStageLabels: string[];
  outOfOrderStageLabels: string[];
  ladderedChildCount: number;
  ladderedChildIdentifiers: string[];
  delayMinutes: number;
}): string {
  const lines = [
    ADR072_CLOSE_LADDER_ESCALATION_MARKER,
    "",
    `Escalated to exec-CTO: this card${input.identifier ? ` (${input.identifier})` : ""} ` +
      `remains an incomplete ADR-072 close-ladder parent over ` +
      `${input.ladderedChildCount} laddered child issue(s) ` +
      `(${input.ladderedChildIdentifiers.join(", ")}) after ` +
      `${input.delayMinutes} minutes, and its close-ladder pointer has not advanced.`,
  ];
  if (input.missingStageLabels.length > 0) {
    lines.push("", `Missing close-ladder stage(s): ${input.missingStageLabels.join(", ")}`);
  }
  if (input.outOfOrderStageLabels.length > 0) {
    lines.push("", `Out-of-order close-ladder stage(s): ${input.outOfOrderStageLabels.join(", ")}`);
  }
  lines.push(
    "",
    "Advisory only: no execution policy, status, assignee, or stage pointer was changed.",
  );
  return lines.join("\n");
}

async function resolveExecCtoAgentId(db: Db, companyId: string): Promise<string | null> {
  const rows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  return rows.find((row) => normalizeAgentUrlKey(row.name) === EXEC_CTO_URL_KEY)?.id ?? null;
}

export function buildAdr072CloseLadderBoardEscalation(input: {
  identifier: string | null;
  ladderedChildCount: number;
  ladderedChildIdentifiers: string[];
  delayMinutes: number;
  boardMonitorNextCheckAt: Date | null;
}): string {
  const lines = [
    ADR072_CLOSE_LADDER_ESCALATION_MARKER,
    "",
    `Escalated to the board: this card${input.identifier ? ` (${input.identifier})` : ""} ` +
      `remains an incomplete ADR-072 close-ladder parent over ` +
      `${input.ladderedChildCount} laddered child issue(s) ` +
      `(${input.ladderedChildIdentifiers.join(", ")}) after ` +
      `${input.delayMinutes} minutes, its close-ladder pointer has not advanced, and this ` +
      `company has no exec-CTO agent to route the escalation to.`,
    "",
    "The board should seat an exec-CTO agent (or another accountable owner), complete or " +
      "skip the missing close-ladder stage(s), or record an intentional manual resolution.",
  ];
  if (input.boardMonitorNextCheckAt) {
    lines.push(
      "",
      `Board decision item armed: the board monitor re-checks this card at ` +
        `${input.boardMonitorNextCheckAt.toISOString()}.`,
    );
  } else {
    lines.push(
      "",
      "This card cannot host a scheduler monitor (no agent assignee or not a monitorable " +
        "status), so no board monitor was armed; this comment is the board's decision item.",
    );
  }
  lines.push(
    "",
    "No status, assignee, or stage pointer was changed; only the board decision monitor " +
      "(when armed) was added to the execution policy.",
  );
  return lines.join("\n");
}

// Mirrors `isMonitorableIssueShape` in recovery/host-restart-strand-sweep.ts:
// a card can host a scheduler monitor only when it is agent-assigned (no user
// assignee) and in a monitorable status — the heartbeat claim predicate. Kept
// local so this sweep adds no dependency on the recovery module graph.
function isBoardMonitorableIssueShape(shape: {
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}): boolean {
  return (
    Boolean(shape.assigneeAgentId) &&
    !shape.assigneeUserId &&
    BOARD_MONITORABLE_STATUSES.has(shape.status)
  );
}

// Mirrors `exhaustedBoardMonitorNextCheckAt` (recovery/service.ts, SUP-21344):
// a newly armed check is floored strictly into the future so the shared
// scheduler tick can never treat the arm itself as already due.
function boardMonitorNextCheckAtFloor(now: Date): Date {
  return new Date(now.getTime() + ADR072_CLOSE_LADDER_BOARD_MONITOR_INTERVAL_MS);
}

function hasFutureMonitorCheck(
  monitorNextCheckAt: Date | string | null | undefined,
  now: Date,
): boolean {
  if (!monitorNextCheckAt) return false;
  return new Date(monitorNextCheckAt).getTime() > now.getTime();
}

// Mirrors `isDueSelfArmedBoardMonitor` (recovery/service.ts): true when a
// board-scheduled monitor is due or already claimed and must be left for the
// monitor tick instead of being re-armed over.
function isDueSelfArmedBoardMonitor(
  issue: {
    monitorNextCheckAt: Date | string | null | undefined;
    monitorScheduledBy: string | null | undefined;
    monitorWakeRequestedAt: Date | string | null | undefined;
  },
  now: Date,
): boolean {
  if (issue.monitorScheduledBy !== "board") return false;
  if (issue.monitorWakeRequestedAt) return true;
  if (!issue.monitorNextCheckAt) return false;
  return new Date(issue.monitorNextCheckAt).getTime() <= now.getTime();
}

type Adr072BoardEscalationIssueRow = {
  id: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionPolicy: Record<string, unknown> | null;
  executionState: Record<string, unknown> | null;
  monitorNextCheckAt: Date | null;
  monitorWakeRequestedAt: Date | null;
  monitorScheduledBy: string | null;
};

// Arm a board decision monitor on the no-exec-CTO escalation parent, mirroring
// `armExhaustedBoardMonitor` (recovery/service.ts, SUP-21344). Returns the
// armed (or already-present) board check time, or null when the card cannot
// host a scheduler monitor or the policy module refused the arm.
async function armAdr072BoardEscalationMonitor(
  txDb: Db,
  issue: Adr072BoardEscalationIssueRow,
  opts: { identifier: string | null; now: Date },
): Promise<Date | null> {
  const now = opts.now;
  if (
    !isBoardMonitorableIssueShape({
      status: issue.status,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
    })
  ) {
    return null;
  }
  // Never clobber another subsystem's live monitor: a future check stays as
  // the board item's check time, and a due/claimed board monitor is left for
  // the monitor tick. Only a cold row gets a fresh arm.
  if (hasFutureMonitorCheck(issue.monitorNextCheckAt, now)) {
    return new Date(issue.monitorNextCheckAt!);
  }
  if (isDueSelfArmedBoardMonitor(issue, now)) {
    return new Date(issue.monitorNextCheckAt!);
  }
  const nextCheckAt = boardMonitorNextCheckAtFloor(now);
  const normalized = issue.executionPolicy
    ? (normalizeIssueExecutionPolicy(issue.executionPolicy) ?? undefined)
    : undefined;
  const policy = {
    ...(normalized ?? { mode: "normal" as const, commentRequired: true, stages: [] }),
    monitor: {
      nextCheckAt: nextCheckAt.toISOString(),
      notes:
        `Board decision required: ADR-072 close-ladder escalation on ` +
        `${opts.identifier ?? issue.id} — no exec-CTO agent is seated. Seat an exec-CTO ` +
        `agent or another accountable owner, complete/skip the missing close-ladder ` +
        `stage(s), or record an intentional manual resolution.`,
      scheduledBy: "board" as const,
      kind: null,
      serviceName: null,
      externalRef: null,
      timeoutAt: null,
      maxAttempts: ADR072_CLOSE_LADDER_BOARD_MONITOR_MAX_ATTEMPTS,
      recoveryPolicy: null,
    },
  };
  let transition: ReturnType<typeof applyIssueMonitorPolicyTransition>;
  try {
    transition = applyIssueMonitorPolicyTransition({
      issue,
      policy,
      previousPolicy: normalized,
      requestedStatus: issue.status,
      requestedAssigneePatch: {},
      actor: { agentId: null, userId: null },
      monitorExplicitlyUpdated: true,
    });
  } catch (err) {
    // A bounds-exhausted arm must never kill the sweep: treat it as "no
    // monitor armed" so the escalation comment stays the board's item.
    // Anything else is a real failure and must surface.
    const clearReason =
      err instanceof HttpError && err.status === 422 && typeof err.details === "object" && err.details !== null
        ? (err.details as { clearReason?: unknown }).clearReason
        : undefined;
    if (typeof clearReason !== "string" || clearReason.length === 0) throw err;
    logger.warn(
      { issueId: issue.id, clearReason },
      "adr072 close-ladder board monitor arm refused: monitor bounds exhausted",
    );
    return null;
  }
  if (
    transition.patch.monitorNextCheckAt === undefined
    || transition.patch.monitorNextCheckAt === null
  ) {
    logger.warn(
      { issueId: issue.id },
      "adr072 close-ladder board monitor transition scheduled no check; escalation comment remains the decision item",
    );
    return null;
  }
  await issueService(txDb).update(issue.id, { ...transition.patch, executionPolicy: policy }, txDb);
  return nextCheckAt;
}

type Adr072CloseLadderEscalationOutcome =
  | "escalated"
  | "escalated_to_board"
  | "already_escalated"
  | "not_due"
  | "failed";

async function escalateDueParent(
  db: Db,
  opts: {
    wakeup: Adr072CloseLadderEscalationWakeup;
    issueId: string;
    companyId: string;
    delayMinutes: number;
    nowMs: number;
  },
): Promise<Adr072CloseLadderEscalationOutcome> {
  let recipientAgentId: string | null = null;
  const outcome = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await txDb
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.id, opts.issueId))
      .for("update");
    const [current] = await txDb
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        status: issues.status,
        hiddenAt: issues.hiddenAt,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
        createdByAgentId: issues.createdByAgentId,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
        monitorScheduledBy: issues.monitorScheduledBy,
      })
      .from(issues)
      .where(eq(issues.id, opts.issueId));
    if (
      !current
      || current.status === "done"
      || current.status === "cancelled"
      || current.hiddenAt
    ) {
      return "not_due" as const;
    }
    const laddered = await countLadderedChildren(txDb, current.companyId, current.id, {
      requireCompletedLadder: false,
    });
    if (laddered.count < 2) return "not_due" as const;
    const shape = await findMissingAdr072CloseLadderStages(
      txDb,
      current.companyId,
      current.id,
      current.executionPolicy,
      current.executionState,
      current.createdByAgentId,
    );
    if (shape.missingStageLabels.length === 0 && shape.outOfOrderStageLabels.length === 0) {
      return "not_due" as const;
    }
    const state = parseIssueExecutionState(current.executionState);
    const pointerAdvanced =
      (state?.completedStageIds?.length ?? 0) > 0 ||
      (state?.skippedStageIds?.length ?? 0) > 0;
    if (pointerAdvanced) return "not_due" as const;
    const markerRows = await txDb
      .select({ id: activityLog.id, action: activityLog.action })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, current.companyId),
          inArray(activityLog.action, [
            ADR072_CLOSE_LADDER_ESCALATION_ACTION,
            ADR072_CLOSE_LADDER_ESCALATION_WAKE_DELIVERED_ACTION,
            ADR072_CLOSE_LADDER_BOARD_ESCALATION_ACTION,
          ]),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, current.id),
        ),
      );
    if (
      markerRows.some(
        (row) => row.action === ADR072_CLOSE_LADDER_ESCALATION_WAKE_DELIVERED_ACTION,
      )
    ) {
      return "already_escalated" as const;
    }
    const resolvedRecipientAgentId = await resolveExecCtoAgentId(txDb, current.companyId);
    if (!resolvedRecipientAgentId) {
      // adr072-no-board-fallback: with no exec-CTO seat the escalation must
      // still reach a board-owned decision item (SUP-21344 shape), not park on
      // a deferred marker forever. Exactly-once via the board escalation
      // activity marker; legacy `escalation_deferred` rows are inert so stale
      // deferrals heal into the board path.
      if (
        markerRows.some(
          (row) => row.action === ADR072_CLOSE_LADDER_BOARD_ESCALATION_ACTION,
        )
      ) {
        return "already_escalated" as const;
      }
      const boardMonitorNextCheckAt = await armAdr072BoardEscalationMonitor(txDb, current, {
        identifier: current.identifier ?? null,
        now: new Date(opts.nowMs),
      });
      await logActivityInTransaction(txDb, {
        companyId: current.companyId,
        actorType: "system",
        actorId: ADR072_CLOSE_LADDER_ESCALATION_ACTOR_ID,
        action: ADR072_CLOSE_LADDER_BOARD_ESCALATION_ACTION,
        entityType: "issue",
        entityId: current.id,
        issueId: current.id,
        details: {
          identifier: current.identifier ?? null,
          ladderedChildCount: laddered.count,
          ladderedChildIdentifiers: laddered.identifiers,
          excludedChildIdentifiers: laddered.excludedChildIdentifiers,
          missingStageLabels: shape.missingStageLabels,
          outOfOrderStageLabels: shape.outOfOrderStageLabels,
          pointerAdvanced,
          currentStageIndex: state?.currentStageIndex ?? null,
          deadlineMinutes: opts.delayMinutes,
          routedTo: "board",
          reason: "exec_cto_not_found",
          boardMonitorNextCheckAt: boardMonitorNextCheckAt?.toISOString() ?? null,
          boardMonitorDispatchable: boardMonitorNextCheckAt !== null,
        },
      });
      await issueService(txDb).addComment(
        current.id,
        buildAdr072CloseLadderBoardEscalation({
          identifier: current.identifier ?? null,
          ladderedChildCount: laddered.count,
          ladderedChildIdentifiers: laddered.identifiers,
          delayMinutes: opts.delayMinutes,
          boardMonitorNextCheckAt,
        }),
        {},
        { authorType: "system" },
        txDb,
      );
      return "escalated_to_board" as const;
    }
    recipientAgentId = resolvedRecipientAgentId;
    if (
      markerRows.some((row) => row.action === ADR072_CLOSE_LADDER_ESCALATION_ACTION)
    ) {
      return "already_escalated" as const;
    }
    await logActivityInTransaction(txDb, {
      companyId: current.companyId,
      actorType: "system",
      actorId: ADR072_CLOSE_LADDER_ESCALATION_ACTOR_ID,
      action: ADR072_CLOSE_LADDER_ESCALATION_ACTION,
      entityType: "issue",
      entityId: current.id,
      issueId: current.id,
      details: {
        identifier: current.identifier ?? null,
        ladderedChildCount: laddered.count,
        ladderedChildIdentifiers: laddered.identifiers,
        excludedChildIdentifiers: laddered.excludedChildIdentifiers,
        missingStageLabels: shape.missingStageLabels,
        outOfOrderStageLabels: shape.outOfOrderStageLabels,
        pointerAdvanced,
        currentStageIndex: state?.currentStageIndex ?? null,
        deadlineMinutes: opts.delayMinutes,
        routedToAgentId: recipientAgentId,
      },
    });
    await issueService(txDb).addComment(
      current.id,
      buildAdr072CloseLadderEscalation({
        identifier: current.identifier ?? null,
        missingStageLabels: shape.missingStageLabels,
        outOfOrderStageLabels: shape.outOfOrderStageLabels,
        ladderedChildCount: laddered.count,
        ladderedChildIdentifiers: laddered.identifiers,
        delayMinutes: opts.delayMinutes,
      }),
      {},
      { authorType: "system" },
      txDb,
    );
    return "escalated" as const;
  });
  if (
    (outcome !== "escalated" && outcome !== "already_escalated")
    || !recipientAgentId
  ) {
    return outcome;
  }
  try {
    await opts.wakeup(recipientAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_adr072_close_ladder_escalated",
      payload: {
        issueId: opts.issueId,
        mutation: "adr072_close_ladder_escalation",
      },
      idempotencyKey: `adr072-close-ladder-escalation:${opts.issueId}`,
      requestedByActorType: "system",
      requestedByActorId: ADR072_CLOSE_LADDER_ESCALATION_ACTOR_ID,
      contextSnapshot: {
        issueId: opts.issueId,
        source: "issue.adr072_close_ladder_escalated",
      },
    });
    await db.transaction(async (tx) => {
      await logActivityInTransaction(tx as unknown as Db, {
        companyId: opts.companyId,
        actorType: "system",
        actorId: ADR072_CLOSE_LADDER_ESCALATION_ACTOR_ID,
        action: ADR072_CLOSE_LADDER_ESCALATION_WAKE_DELIVERED_ACTION,
        entityType: "issue",
        entityId: opts.issueId,
        issueId: opts.issueId,
        details: { routedToAgentId: recipientAgentId },
      });
    });
  } catch (err) {
    logger.warn(
      { err, issueId: opts.issueId, companyId: opts.companyId },
      "failed to wake exec-CTO for ADR-072 close-ladder escalation",
    );
    return "failed";
  }
  return outcome;
}

export interface Adr072CloseLadderEscalationSweepResult {
  candidates: number;
  escalated: number;
  escalatedToBoard: number;
  alreadyEscalated: number;
  notDue: number;
  failed: number;
}

export function createAdr072CloseLadderEscalationSweepService(
  db: Db,
  opts: {
    wakeup: Adr072CloseLadderEscalationWakeup;
    escalationDelayMs?: number;
    now?: () => number;
  },
) {
  const escalationDelayMs =
    opts.escalationDelayMs ?? ADR072_CLOSE_LADDER_ESCALATION_DELAY_MS;
  return {
    async sweep(
      atNow: number = opts.now?.() ?? Date.now(),
    ): Promise<Adr072CloseLadderEscalationSweepResult> {
      const result: Adr072CloseLadderEscalationSweepResult = {
        candidates: 0,
        escalated: 0,
        escalatedToBoard: 0,
        alreadyEscalated: 0,
        notDue: 0,
        failed: 0,
      };
      const cutoff = new Date(atNow - escalationDelayMs);
      const retentionCutoff = new Date(
        atNow - escalationDelayMs - ADR072_CLOSE_LADDER_ESCALATION_RETENTION_MS,
      );
      const due = await db
        .select({
          id: activityLog.id,
          companyId: activityLog.companyId,
          entityId: activityLog.entityId,
          createdAt: activityLog.createdAt,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.action, ADR072_CLOSE_LADDER_ADVISORY_ACTION),
            eq(activityLog.entityType, "issue"),
            gte(activityLog.createdAt, retentionCutoff),
            lte(activityLog.createdAt, cutoff),
          ),
        );
      const seenIssueIds = new Set<string>();
      for (const row of due) {
        if (seenIssueIds.has(row.entityId)) continue;
        seenIssueIds.add(row.entityId);
        result.candidates += 1;
        try {
          const outcome = await escalateDueParent(db, {
            wakeup: opts.wakeup,
            issueId: row.entityId,
            companyId: row.companyId,
            delayMinutes: escalationDelayMs / 60000,
            nowMs: atNow,
          });
          if (outcome === "escalated") result.escalated += 1;
          else if (outcome === "escalated_to_board") result.escalatedToBoard += 1;
          else if (outcome === "already_escalated") result.alreadyEscalated += 1;
          else if (outcome === "failed") result.failed += 1;
          else result.notDue += 1;
        } catch (err) {
          result.failed += 1;
          logger.warn(
            { err, issueId: row.entityId, companyId: row.companyId },
            "adr072 close-ladder escalation sweep failed for a candidate",
          );
        }
      }
      return result;
    },
  };
}
