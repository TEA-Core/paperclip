import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import {
  countLadderedChildren,
  findMissingAdr072CloseLadderStages,
} from "./done-transition-guard.js";

/**
 * ADR-103 M4 (SUP-17183): a write-time gate that keeps the `parent_id` edge
 * TOTAL. It refuses, as a validity check, any decomposition edge (create or
 * re-parent) that would arm the ADR-072 close ladder on a parent that can no
 * longer discharge it — a parent whose close-ladder pointer has already
 * advanced and whose policy no longer carries the conforming close ladder.
 *
 * The gate persists no derived value: it only reads the parent and its
 * children, and a rejection makes the caller abort the edge write before it is
 * committed. To keep the count/pointer/ladder snapshot atomic with the edge
 * write it validates, the gate takes an exclusive row lock on the parent
 * (`SELECT ... FOR UPDATE`) so concurrent parent-edge writes into the same
 * parent serialize on it; the lock is released with the surrounding
 * transaction's commit or rollback. Callers must therefore run it inside their
 * write transaction (passing the transaction handle). The two close-guard
 * helpers (`countLadderedChildren` and `findMissingAdr072CloseLadderStages`)
 * are reused verbatim — never a second copy of the counting or the close-
 * ladder shape.
 */
export type UndischargeableLadderEdgeVerdict =
  | { ok: true }
  | {
      ok: false;
      parentIdentifier: string;
      /** The laddered-child count the parent would reach once this edge lands. */
      wouldReachCount: number;
      missingStageLabels: string[];
      outOfOrderStageLabels: string[];
    };

/**
 * Evaluate whether writing a decomposition edge onto `newParentId` would add an
 * undischargeable close ladder. Returns `{ ok: true }` to allow the edge, or a
 * structured rejection.
 *
 * Rejection requires ALL of the following to hold:
 *   1. the incoming edge is a decomposition edge (`incomingEdgeKind` is not
 *      `'process'` — the ADR-103 default is decomposition, so the gate stays
 *      fail-closed for an omitted kind);
 *   2. the parent's close-ladder pointer has already advanced (a completed or
 *      skipped stage);
 *   3. the parent's policy lacks a conforming ADR-072 close ladder (a rung is
 *      missing or out of order); and
 *   4. the edge takes the parent's laddered-child count from <2 to >=2.
 */
export async function evaluateUndischargeableLadderEdge(
  db: Db,
  companyId: string,
  newParentId: string | null | undefined,
  incomingEdgeKind: string | null | undefined,
): Promise<UndischargeableLadderEdgeVerdict> {
  if (!newParentId) return { ok: true };
  // A procedural edge gates no slice of the parent's deliverable, so it is not
  // a decomposition signal regardless of the parent's ladder state.
  if (incomingEdgeKind === "process") return { ok: true };

  const parentRows = await db
    .select({
      identifier: issues.identifier,
      executionPolicy: issues.executionPolicy,
      executionState: issues.executionState,
      createdByAgentId: issues.createdByAgentId,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, newParentId)))
    .for("update");
  const parent = parentRows[0];
  if (!parent) return { ok: true };

  // Condition 2: the pointer must have advanced. A not-advanced parent can
  // still lawfully add the close ladder at close, so the edge is allowed
  // (the mirror case).
  const state = parseIssueExecutionState(parent.executionState);
  const advanced =
    (state?.completedStageIds?.length ?? 0) > 0 ||
    (state?.skippedStageIds?.length ?? 0) > 0;
  if (!advanced) return { ok: true };

  // Condition 4: count the existing laddered children, add this new edge, and
  // only reject when the count reaches the >=2 threshold.
  const { count } = await countLadderedChildren(db, companyId, newParentId);
  const wouldReachCount = count + 1;
  if (wouldReachCount < 2) return { ok: true };

  // Condition 3: the parent's policy must lack a conforming close ladder.
  const shape = await findMissingAdr072CloseLadderStages(
    db,
    companyId,
    parent.executionPolicy,
    parent.executionState,
    parent.createdByAgentId,
  );
  if (
    shape.missingStageLabels.length === 0 &&
    shape.outOfOrderStageLabels.length === 0
  ) {
    return { ok: true };
  }

  return {
    ok: false,
    parentIdentifier: parent.identifier ?? "<unnamed>",
    wouldReachCount,
    missingStageLabels: shape.missingStageLabels,
    outOfOrderStageLabels: shape.outOfOrderStageLabels,
  };
}

/**
 * Build the 409 `conflict(message, details)` payload for a rejected edge. The
 * message names the parent and the count the edge would reach, and offers both
 * lawful resolutions: declare the edge procedural, or file the child under the
 * parent's programme/ancestor.
 */
export function buildUndischargeableLadderEdgeConflict(
  rejection: Extract<UndischargeableLadderEdgeVerdict, { ok: false }>,
  childDescription: string,
): { message: string; details: Record<string, unknown> } {
  const ladderNote =
    rejection.outOfOrderStageLabels.length > 0
      ? `${[...rejection.missingStageLabels, ...rejection.outOfOrderStageLabels]
          .filter((label, index, all) => all.indexOf(label) === index)
          .join(", ")}`
      : rejection.missingStageLabels.join(", ");
  const message =
    `Refused to declare ${childDescription} a decomposition child of ` +
    `${rejection.parentIdentifier} (ADR-103 M4): this edge would bring its ` +
    `laddered-child count to ${rejection.wouldReachCount} (>= 2) and arm the ` +
    `ADR-072 close ladder, but ${rejection.parentIdentifier}'s close ladder ` +
    `has already advanced and no longer carries the required close-ladder ` +
    `stage(s): ${ladderNote || "n/a"}. A decomposed parent that can no longer ` +
    `add those stages must not take another laddered work child. Lawful ` +
    `resolutions: declare the edge procedural by setting parent_link_kind: ` +
    `"'process'", or file the child under ${rejection.parentIdentifier}'s ` +
    `programme/ancestor instead.`;
  const details: Record<string, unknown> = {
    code: "parent_edge_undischargeable_close_ladder",
    parentIdentifier: rejection.parentIdentifier,
    wouldReachCount: rejection.wouldReachCount,
    missingStageLabels: rejection.missingStageLabels,
    outOfOrderStageLabels: rejection.outOfOrderStageLabels,
    resolutions: [
      "declare this edge procedural by setting parent_link_kind: 'process'",
      `file the child under ${rejection.parentIdentifier}'s programme/ancestor instead`,
    ],
  };
  return { message, details };
}
