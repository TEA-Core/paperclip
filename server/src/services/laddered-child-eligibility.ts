import { and, eq, inArray } from "drizzle-orm";
import { labels, type Db } from "@paperclipai/db";

/**
 * The edge-time half of the laddered-child predicate, shared by the two sides
 * of the ADR-072 / ADR-103 close-ladder machinery so they cannot drift.
 *
 * `countLadderedChildren` (done-transition-guard.ts) decides which EXISTING
 * children of a parent count toward the `>= 2` decomposition threshold that
 * arms the ADR-072 close ladder. `evaluateUndischargeableLadderEdge`
 * (parent-edge-close-ladder-gate.ts, ADR-103 M4 / SUP-17183) has to make the
 * same decision about an INCOMING edge before that edge is written, because it
 * refuses the write when `count + 1` reaches the threshold. Those two answers
 * must agree: an edge the counter would never have counted must not be refused
 * for the count it would supposedly produce.
 *
 * M4 shipped without that agreement. The gate added the incoming child to the
 * count unconditionally while the counter already skipped every platform-drawn
 * row (SUP-15451), so the two disagreed on exactly the population the counter
 * was narrowed to exclude. The concrete casualty is the task watchdog: it
 * creates its review card with `parent_id` pointing at the watched card and
 * `origin_kind = 'task_watchdog'` (task-watchdogs.ts / task-watchdog-scope.ts),
 * and it fires precisely when that parent has advanced — so a watchdog on a
 * decomposed, advanced, non-conforming parent would have taken a 409 from the
 * gate, the one moment the platform most needs the card to land. The same holds
 * for every other platform origin kind (`issue_productivity_review`,
 * `stale_active_run_evaluation`, ...). Routing both sides through this one
 * predicate is what stops the drift returning.
 *
 * SCOPE — what lives here and what deliberately does not. Read end to end,
 * `countLadderedChildren` applies SIX exclusions, in this order: cancelled
 * status; platform-drawn origin; `executionPolicy == null`; the ladder-run gate
 * (no completed/skipped stage under the default `requireCompletedLadder`, or a
 * stage-less policy under the SUP-17158 acquisition relaxation); a carve-out
 * label; and `parent_link_kind = 'process'`. FOUR of those six are knowable
 * about an edge at the moment it is written, and all four are mirrored here:
 *
 *   - cancelled status (SUP-16025) — a cancelled card is not a decomposition
 *     signal; known for an incoming edge from the status the write will leave.
 *   - platform-drawn origin (SUP-15451) — `origin_kind` is set at create and is
 *     immutable afterwards, so it is known on both write paths.
 *   - a procedural edge (ADR-103 M2, `parent_link_kind = 'process'`) — the kind
 *     is declared by the write itself.
 *   - a carve-out label (SUP-15464 / SUP-15533 / SUP-16586 / SUP-17177) — the
 *     labels are on the create payload (`labelIds`) and on the PATCH body, and
 *     the stored set is on the child row, so both write paths can resolve them.
 *     See {@link LADDERED_CHILD_CARVE_OUT_LABEL_NAMES} and
 *     {@link edgeCarriesLadderCarveOutLabel}. Round 1 of this fix mirrored only
 *     the first three and left this one out, which kept the original defect
 *     alive for its single largest population: a `work-type:redo` child is the
 *     ordinary product of an LE bounce (ADR-041), it is `manual`, it is not
 *     cancelled, it is a `decomposition` edge — and the counter demonstrably
 *     does not count it. Mirroring three of four exclusions is the same drift
 *     this module exists to end, one arm smaller.
 *
 * The other two — `executionPolicy == null`, and the ladder-run gate ("a
 * completed or skipped stage", relaxed by SUP-17158 to "carries a non-empty
 * ladder") — are NOT mirrored here, and that omission is deliberate rather than
 * an oversight:
 *
 *   - `executionPolicy == null` is not knowable ON A CREATE, because a child's
 *     policy is routinely attached AFTER the insert that creates it (the
 *     create payload may carry none at all, and the seeding/arming paths PATCH
 *     it on afterwards). Reading the payload's policy would therefore measure
 *     the order of two writes rather than the child's nature. The resulting
 *     error falls toward REFUSING: the gate assumes an incoming ordinary
 *     decomposition edge will eventually carry a policy, so a child that never
 *     acquires one is refused although the counter would not have counted it.
 *   - the ladder-run gate is not knowable ON A CREATE by construction: a child
 *     being created has run no stage at all. Reading it would make the answer
 *     "has this child's ladder run YET", which is false for every create. The
 *     resulting error falls the same way, toward REFUSING.
 *
 * BE PRECISE ABOUT THE RE-PARENT PATH: on a re-parent the child already exists,
 * so BOTH of those facts are readable, and "not knowable" would be false there.
 * The reason they are still not consulted on that path is a DELIBERATE REFUSAL,
 * not an absence of information. Consulting them would let a caller move a
 * policy-less or not-yet-run child under an advanced parent and have the gate
 * wave it through, which is precisely the laundering route around the create
 * gate that the re-parent call site's own comment refuses. Both paths therefore
 * judge an edge by the same four facts, and an edge that would be refused on
 * create cannot be admitted by being created elsewhere and moved.
 *
 * Mirroring either would return `{ ok: true }` for essentially every create and
 * make the gate a permanent no-op that never sees the SUP-16872 case it exists
 * to refuse. So the gate stays FAIL-CLOSED on exactly those two dimensions and
 * on nothing else.
 *
 * That choice picks its error direction knowingly. The residual false positive
 * is now narrow: a manual, non-cancelled, un-carved-out decomposition child
 * filed under an advanced non-conforming parent that then never acquires a
 * policy or never runs a stage. The gate refuses an edge the counter would not
 * have counted, and that caller is a human or agent who reads the 409 and has
 * two documented remedies (declare the edge procedural, or re-file under the
 * programme). The error we refuse to make is the opposite one — letting a real
 * decomposition edge through and stranding a parent that can no longer
 * discharge its close ladder, which is silent, is discovered only at close, and
 * has no remedy left by then.
 */

/**
 * The company-scoped label names that carve a child out of the decomposition
 * count. This is the SINGLE copy: `countLadderedChildren` resolves these names
 * to ids in one read at close, and {@link edgeCarriesLadderCarveOutLabel}
 * resolves the same names at edge time. A second copy of this list is precisely
 * the drift that produced the M4 defect, so there must never be one.
 *
 * SUP-15464 — `work-type:redo`: a redo card re-delivers the same deliverable
 * its parent already gated (ADR-041 / Plan BRW), so it is not a decomposition
 * child.
 * SUP-15533 — `work-type:delivery`: a carrier/delivery helper child (the
 * SUP-15410 / SUP-15405 shape over the coding leaf SUP-15140) that lands and
 * re-delivers the parent's already-gated deliverable.
 * SUP-16586 — `work-type:architecture-review`: a card filed to adjudicate a
 * parent's close gate (SUP-16569 over SUP-15805; SUP-16584). Per escalation.md
 * an architecture review is a chain TERMINATOR — it is never sub-work at any
 * depth, so the gate it exists to correct must not be armed by it.
 * SUP-17177 / SUP-17167 — `work-type:process`: a procedurally-filed process
 * child (courier / review-routing / unblock card parented to a work card during
 * a rough round: the SUP-16872 shape over SUP-16900 + SUP-16884). It gates no
 * slice of the parent's deliverable. Two such children silently arm mechanism D
 * on an otherwise-normal work card and can make its final `paperclip/approved`
 * transition unreachable.
 *
 * All four are matched by NAME and resolved company-scoped, because the label id
 * is company-scoped and these predicates are not. The carve-out is label-gated,
 * not column-gated: a child whose edge is `process` but which carries no label
 * is excluded by the `parent_link_kind` arm instead, and a child carrying any of
 * these labels is treated as procedural regardless of the column value, which is
 * the back-compat that made ADR-103 M2 shippable without a relabelling campaign.
 */
export const LADDERED_CHILD_CARVE_OUT_LABEL_NAMES = [
  "work-type:redo",
  "work-type:delivery",
  "work-type:architecture-review",
  "work-type:process",
] as const;

export type LadderArmingParentEdge = {
  /**
   * The child's `origin_kind`. Absent/null is read as `'manual'`, matching the
   * column's notNull `'manual'` default: a missing value is an ordinary
   * manually-filed card and counts.
   */
  originKind?: string | null;
  /**
   * The child's status. On an incoming edge this is the status the write will
   * LEAVE the child at, not necessarily the one it had before.
   */
  status?: string | null;
  /**
   * The edge's own kind (ADR-103 M2). Absent/null is read as the column's
   * `'decomposition'` default, so the predicate stays fail-closed for an
   * omitted kind.
   */
  parentLinkKind?: string | null;
  /**
   * Whether the child carries any of {@link LADDERED_CHILD_CARVE_OUT_LABEL_NAMES},
   * resolved by the caller through {@link edgeCarriesLadderCarveOutLabel}. Absent
   * is read as `false` — an unresolved label set is treated as "no carve-out",
   * which keeps the predicate fail-closed for a caller that cannot see labels at
   * all.
   */
  hasCarveOutLabel?: boolean;
};

/**
 * Does this parent edge count toward the parent's laddered-child total, as far
 * as can be decided from the edge itself?
 *
 * `true` means "not excluded by any edge-time rule the caller supplied facts
 * for" — for an existing row the remaining ladder-state checks still apply on
 * top; for an incoming edge the gate treats `true` as "this edge will arm the
 * ladder" (see the fail-closed reasoning in the module comment above).
 *
 * Each field is independently sufficient to exclude, and a field the caller
 * omits is simply not applied. `countLadderedChildren` deliberately passes only
 * `status` and `originKind`, applying the `parentLinkKind` and carve-out-label
 * arms itself so that an exclusion by either of those two lands in its
 * `excludedChildIdentifiers` audit trail; folding them into this call there
 * would drop them from that trail silently. The gate passes all four, because
 * an incoming edge has no audit trail to land in — it is either written or
 * refused.
 */
export function isLadderArmingParentEdge(
  edge: LadderArmingParentEdge,
): boolean {
  // SUP-16025: a cancelled row is not a decomposition signal even when it
  // carries a qualifying policy and an advanced pointer.
  if (edge.status === "cancelled") return false;
  // SUP-15451: only decomposition children count. A card the platform itself
  // drew (task_watchdog, issue_productivity_review, stale_active_run_evaluation,
  // ...) is not an answer to "which child gated this work?". Plugin-authored
  // cards (`plugin:*`) are ordinary work and do count.
  const originKind = edge.originKind ?? "manual";
  if (originKind !== "manual" && !originKind.startsWith("plugin:")) return false;
  // ADR-103 M2: an edge declared procedural gates no slice of the parent's
  // deliverable, so it is not a decomposition signal regardless of the parent's
  // ladder state.
  if (edge.parentLinkKind === "process") return false;
  // SUP-15464 / SUP-15533 / SUP-16586 / SUP-17177: a carve-out-labelled child is
  // a redo, a delivery carrier, an architecture-review terminator, or a process
  // courier — none of them answers "which child gated this work?".
  if (edge.hasCarveOutLabel === true) return false;
  return true;
}

/**
 * Resolve, for an incoming parent edge, whether the child carries any carve-out
 * label — the edge-time counterpart of the labels read `countLadderedChildren`
 * performs at close.
 *
 * The two reads are shaped differently because they answer different questions.
 * The counter starts from a parent and does not know its children's labels, so
 * it resolves the four names to ids and then scans `issue_labels` for every
 * child. Here the caller already HAS the child's label ids (the create payload's
 * `labelIds`, or the PATCH's restated set falling back to the stored one), so a
 * single read over `labels` — scoped to the company, the four names, and those
 * ids — settles it with no `issue_labels` round trip at all.
 *
 * An empty or absent label set short-circuits to `false` with no query, so the
 * ordinary child create that names no labels pays nothing for this check.
 *
 * Direction of error: labels can be attached after the create, exactly as
 * policies can. A `work-type:redo` child created bare and labelled a moment
 * later is still refused, because at the instant the edge is written it is
 * indistinguishable from an ordinary decomposition child. That is the same
 * fail-closed direction documented for the two unmirrored exclusions above, and
 * the remedy is the same: name the label on the create (which every automated
 * redo/delivery/architecture-review filer already does), or declare the edge
 * procedural.
 */
export async function edgeCarriesLadderCarveOutLabel(
  db: Db,
  companyId: string,
  labelIds: readonly string[] | null | undefined,
): Promise<boolean> {
  if (!labelIds || labelIds.length === 0) return false;
  const rows = await db
    .select({ id: labels.id })
    .from(labels)
    .where(
      and(
        eq(labels.companyId, companyId),
        inArray(labels.id, [...new Set(labelIds)]),
        inArray(labels.name, [...LADDERED_CHILD_CARVE_OUT_LABEL_NAMES]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
