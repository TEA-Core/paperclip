import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import {
  countLadderedChildren,
  findMissingAdr072CloseLadderStages,
} from "./done-transition-guard.js";
import {
  isLadderArmingParentEdge,
  type LadderArmingParentEdge,
} from "./laddered-child-eligibility.js";

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
 *
 * The same "never a second copy" rule applies to the `+ 1` this gate adds for
 * the incoming edge: whether that edge would itself be counted is decided by
 * {@link isLadderArmingParentEdge}, the predicate `countLadderedChildren` runs
 * against the existing rows. M4 shipped without that, adding the incoming child
 * to the count unconditionally, which 409'd the platform's own watchdog and
 * recovery cards — see laddered-child-eligibility.ts for the measured defect and
 * for which exclusions are deliberately left fail-closed on an incoming edge.
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
 * The incoming edge, described by the facts the gate can judge it on. Both
 * write paths can supply all four: on create they come off the insert payload
 * (including `labelIds`, resolved through `edgeCarriesLadderCarveOutLabel`), on
 * re-parent off the existing child row plus whatever this PATCH restates.
 */
export type IncomingParentEdge = LadderArmingParentEdge;

/**
 * Evaluate whether writing a decomposition edge onto `newParentId` would add an
 * undischargeable close ladder. Returns `{ ok: true }` to allow the edge, or a
 * structured rejection.
 *
 * Rejection requires ALL of the following to hold:
 *   1. the incoming edge would itself be counted as a laddered child by
 *      `countLadderedChildren` — it is not procedural (`parentLinkKind` is not
 *      `'process'`; the ADR-103 default is decomposition, so the gate stays
 *      fail-closed for an omitted kind), not platform-drawn (`originKind` is
 *      `'manual'` or `plugin:*`), not cancelled, and carries none of the four
 *      carve-out labels (`hasCarveOutLabel`, resolved by the caller through
 *      `edgeCarriesLadderCarveOutLabel` before this is called);
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
  incomingEdge: IncomingParentEdge,
): Promise<UndischargeableLadderEdgeVerdict> {
  if (!newParentId) return { ok: true };
  // Condition 1, run through the same predicate `countLadderedChildren` applies
  // to the existing rows, so the `+ 1` below can only ever be added for an edge
  // that side would have counted. This is checked first because it needs no
  // read at all, so a procedural, platform-drawn, cancelled or carve-out-labelled
  // edge costs neither the parent row lock nor the child scan. (The one read the
  // carve-out arm does need — names to ids — is the caller's, and it is skipped
  // outright when the edge names no labels.)
  if (!isLadderArmingParentEdge(incomingEdge)) return { ok: true };

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
  // only reject when the count reaches the >=2 threshold. The `+ 1` is sound
  // only because condition 1 above already established, through the SAME
  // predicate this counter uses, that the incoming edge is one this counter
  // would count.
  const { count } = await countLadderedChildren(db, companyId, newParentId);
  const wouldReachCount = count + 1;
  if (wouldReachCount < 2) return { ok: true };

  // Condition 3: the parent's policy must lack a conforming close ladder.
  const shape = await findMissingAdr072CloseLadderStages(
    db,
    companyId,
    newParentId,
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
