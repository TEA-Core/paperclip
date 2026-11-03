import { and, eq, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, issueComments, issues } from "@paperclipai/db";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivityInTransaction } from "./activity-log.js";
import {
  countLadderedChildren,
  findMissingAdr072CloseLadderStages,
} from "./done-transition-guard.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

export const ADR072_CLOSE_LADDER_ADVISORY_ACTION =
  "issue.adr072_close_ladder_incomplete";
export const ADR072_CLOSE_LADDER_ESCALATION_ACTION =
  "issue.adr072_close_ladder_escalated";
export const ADR072_CLOSE_LADDER_ESCALATION_MARKER =
  "[ADR-072 close ladder escalation]";
export const ADR072_CLOSE_LADDER_ESCALATION_DELAY_MS = 120 * 60 * 1000;
export const ADR072_CLOSE_LADDER_ESCALATION_ACTOR_ID =
  "adr072-close-ladder-escalation";

const EXEC_CTO_URL_KEY = "exec-cto";

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

type Adr072CloseLadderEscalationOutcome =
  | "escalated"
  | "already_escalated"
  | "not_due"
  | "deferred_no_recipient"
  | "failed";

async function escalateDueParent(
  db: Db,
  opts: {
    wakeup: Adr072CloseLadderEscalationWakeup;
    issueId: string;
    companyId: string;
    delayMinutes: number;
  },
): Promise<Adr072CloseLadderEscalationOutcome> {
  const recipientAgentId = await resolveExecCtoAgentId(db, opts.companyId);
  if (!recipientAgentId) return "deferred_no_recipient";
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
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
        createdByAgentId: issues.createdByAgentId,
      })
      .from(issues)
      .where(eq(issues.id, opts.issueId));
    if (!current) return "not_due" as const;
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
    const alreadyEscalated = await txDb
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, current.companyId),
          eq(activityLog.action, ADR072_CLOSE_LADDER_ESCALATION_ACTION),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, current.id),
        ),
      );
    if (alreadyEscalated.length > 0) return "already_escalated" as const;
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
    await txDb.insert(issueComments).values({
      companyId: current.companyId,
      issueId: current.id,
      body: buildAdr072CloseLadderEscalation({
        identifier: current.identifier ?? null,
        missingStageLabels: shape.missingStageLabels,
        outOfOrderStageLabels: shape.outOfOrderStageLabels,
        ladderedChildCount: laddered.count,
        ladderedChildIdentifiers: laddered.identifiers,
        delayMinutes: opts.delayMinutes,
      }),
      authorType: "system",
    });
    return "escalated" as const;
  });
  if (outcome !== "escalated" && outcome !== "already_escalated") return outcome;
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
  alreadyEscalated: number;
  notDue: number;
  deferredNoRecipient: number;
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
        alreadyEscalated: 0,
        notDue: 0,
        deferredNoRecipient: 0,
        failed: 0,
      };
      const cutoff = new Date(atNow - escalationDelayMs);
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
          });
          if (outcome === "escalated") result.escalated += 1;
          else if (outcome === "already_escalated") result.alreadyEscalated += 1;
          else if (outcome === "deferred_no_recipient") result.deferredNoRecipient += 1;
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
