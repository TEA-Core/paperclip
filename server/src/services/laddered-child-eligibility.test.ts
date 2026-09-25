import { describe, expect, it } from "vitest";
import {
  isLadderArmingParentEdge,
  LADDERED_CHILD_CARVE_OUT_LABEL_NAMES,
} from "./laddered-child-eligibility.js";
import { TASK_WATCHDOG_ORIGIN_KIND } from "./task-watchdog-scope.js";

/**
 * The predicate both sides of the close-ladder machinery run on a parent edge:
 * `countLadderedChildren` on the EXISTING children, and the ADR-103 M4
 * create/re-parent gate on the INCOMING edge. These cases pin the exact
 * population each rule covers, because the defect this predicate exists to fix
 * was the two sides disagreeing about that population rather than either rule
 * being wrong on its own.
 */
describe("isLadderArmingParentEdge", () => {
  it("counts an ordinary manual decomposition child", () => {
    expect(
      isLadderArmingParentEdge({
        originKind: "manual",
        status: "todo",
        parentLinkKind: "decomposition",
      }),
    ).toBe(true);
  });

  it("counts an edge that states nothing, matching the column defaults", () => {
    // `origin_kind` is notNull-defaulted to 'manual' and `parent_link_kind` to
    // 'decomposition', so an edge that declares neither is an ordinary
    // manually-filed decomposition child and must count. This is what keeps the
    // gate fail-closed for a create payload that omits both.
    expect(isLadderArmingParentEdge({})).toBe(true);
    expect(
      isLadderArmingParentEdge({ originKind: null, parentLinkKind: null }),
    ).toBe(true);
  });

  it("does not count a card the platform itself drew (SUP-15451)", () => {
    // The measured casualty: the task watchdog parents its review card to the
    // watched card and fires exactly when that parent's ladder has advanced.
    expect(
      isLadderArmingParentEdge({
        originKind: TASK_WATCHDOG_ORIGIN_KIND,
        status: "todo",
      }),
    ).toBe(false);
    for (const originKind of [
      "issue_productivity_review",
      "stale_active_run_evaluation",
      "task_watchdog",
    ]) {
      expect(isLadderArmingParentEdge({ originKind })).toBe(false);
    }
  });

  it("counts a plugin-authored card, which is ordinary work", () => {
    expect(isLadderArmingParentEdge({ originKind: "plugin:llm-wiki" })).toBe(
      true,
    );
  });

  it("does not count a cancelled child (SUP-16025)", () => {
    expect(
      isLadderArmingParentEdge({ originKind: "manual", status: "cancelled" }),
    ).toBe(false);
  });

  it("does not count an edge declared procedural (ADR-103 M2)", () => {
    expect(
      isLadderArmingParentEdge({
        originKind: "manual",
        status: "todo",
        parentLinkKind: "process",
      }),
    ).toBe(false);
  });

  it("does not count a carve-out-labelled child (SUP-15464 / SUP-15533 / SUP-16586 / SUP-17177 / SUP-17553)", () => {
    // The arm round 1 of this fix left out. `countLadderedChildren` excludes a
    // child carrying any of the five carve-out labels, so the gate must not
    // refuse one for a count that side would never have produced. A redo child
    // is the common case: it is manual, not cancelled, and an ordinary
    // `decomposition` edge — every other arm passes it through.
    expect(
      isLadderArmingParentEdge({
        originKind: "manual",
        status: "todo",
        parentLinkKind: "decomposition",
        hasCarveOutLabel: true,
      }),
    ).toBe(false);
  });

  it("reads an absent or false carve-out flag as 'no carve-out', keeping the gate fail-closed", () => {
    // A caller that cannot resolve labels at all (or an edge that names none)
    // must not thereby become exempt: the flag only ever EXCLUDES.
    expect(
      isLadderArmingParentEdge({ originKind: "manual", status: "todo" }),
    ).toBe(true);
    expect(
      isLadderArmingParentEdge({
        originKind: "manual",
        status: "todo",
        hasCarveOutLabel: false,
      }),
    ).toBe(true);
  });

  it("pins the five carve-out label names as one shared list", () => {
    // These names are matched by string against company-scoped label rows in
    // two places (the close-time counter and the edge-time resolver). A second
    // copy of the list is exactly the drift that produced the M4 defect, so the
    // list is pinned here and imported everywhere else.
    expect([...LADDERED_CHILD_CARVE_OUT_LABEL_NAMES]).toEqual([
      "work-type:redo",
      "work-type:delivery",
      "work-type:architecture-review",
      "work-type:process",
      "work-type:recovery",
    ]);
  });

  it("applies each exclusion independently, so no one field can rescue an edge", () => {
    // A platform-drawn card does not become countable by declaring itself a
    // decomposition edge, and a decomposition edge does not become countable by
    // being manual once it is cancelled. Each rule is sufficient on its own.
    expect(
      isLadderArmingParentEdge({
        originKind: TASK_WATCHDOG_ORIGIN_KIND,
        status: "todo",
        parentLinkKind: "decomposition",
      }),
    ).toBe(false);
    expect(
      isLadderArmingParentEdge({
        originKind: "manual",
        status: "cancelled",
        parentLinkKind: "decomposition",
      }),
    ).toBe(false);
    expect(
      isLadderArmingParentEdge({
        originKind: "manual",
        status: "todo",
        parentLinkKind: "decomposition",
        hasCarveOutLabel: true,
      }),
    ).toBe(false);
  });
});
