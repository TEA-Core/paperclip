import { describe, expect, it, vi } from "vitest";
import {
  isSharedCarrierRefusal,
  SHARED_CARRIER_REFUSAL_MARKER,
  listNonTerminalRootCauseBlockersPure,
  issueInBlockerClosurePure,
  createDbBlockerFetchers,
  resolveCarrierOwner,
  type BlockerFetchers,
} from "./blocker-closure.js";

const CARRIER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// Stub fetchers: a fixed `blockedBy` adjacency plus a status map. The walk is
// pure over these, so no drizzle `where` parsing is needed here.
function makeFetchers(
  blockedBy: Record<string, string[]>,
  statuses: Record<string, string>,
  identifiers: Record<string, string | null> = {},
): BlockerFetchers {
  return {
    async fetchBlockersFor(ids) {
      const map = new Map<string, string[]>();
      for (const id of ids) map.set(id, blockedBy[id] ?? []);
      return map;
    },
    async fetchIssues(ids) {
      const map = new Map<string, { status: string; identifier: string | null }>();
      for (const id of ids) {
        if (statuses[id] !== undefined) {
          map.set(id, { status: statuses[id], identifier: identifiers[id] ?? null });
        }
      }
      return map;
    },
  };
}

describe("isSharedCarrierRefusal (ADR-091 D1 marker)", () => {
  it("matches the exact prefix-predicate marker", () => {
    const reason = `status:skipped:not_delivered: PR #455 head r/p:SUP-15098-branch ${SHARED_CARRIER_REFUSAL_MARKER} SUP-15098-; this card shares execution workspace branch (ADR-091 D1)`;
    expect(isSharedCarrierRefusal(reason)).toBe(true);
  });

  it("does not match a single-card head_unresolvable refusal", () => {
    expect(isSharedCarrierRefusal("status:skipped:head_unresolvable: no open PR carries the approved head")).toBe(false);
  });

  it("does not match a repo-mismatch refusal", () => {
    expect(isSharedCarrierRefusal("PR #1 head r/p is not this card's delivery repo q/q (ADR-091 D5)")).toBe(false);
  });

  it("does not match an exact-branch refusal", () => {
    expect(isSharedCarrierRefusal("PR #1 head r/p:b is not this card's delivery branch b")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isSharedCarrierRefusal(null)).toBe(false);
    expect(isSharedCarrierRefusal(undefined)).toBe(false);
    expect(isSharedCarrierRefusal("")).toBe(false);
  });
});

describe("listNonTerminalRootCauseBlockersPure (AC4 report surface)", () => {
  it("returns the deepest non-terminal leaf of a linear blocker strand", async () => {
    // root -> A (in_progress) -> B (in_progress): B is the root cause, A is an intermediate.
    const fetchers = makeFetchers(
      { root: ["A"], A: ["B"], B: [] },
      { A: "in_progress", B: "in_progress" },
      { A: "SUP-A", B: "SUP-B" },
    );
    const roots = await listNonTerminalRootCauseBlockersPure("root", fetchers);
    expect(roots).toEqual([{ id: "B", identifier: "SUP-B", status: "in_progress" }]);
  });

  it("skips terminal nodes and does not descend through them", async () => {
    // root -> C (done) -> D (in_progress): C is terminal, so D is never reached and
    // C itself is not a root cause. Nothing live remains.
    const fetchers = makeFetchers({ root: ["C"], C: ["D"], D: [] }, { C: "done", D: "in_progress" });
    const roots = await listNonTerminalRootCauseBlockersPure("root", fetchers);
    expect(roots).toEqual([]);
  });

  it("returns multiple parallel leaf blockers", async () => {
    const fetchers = makeFetchers(
      { root: ["A", "B"], A: [], B: [] },
      { A: "blocked", B: "todo" },
      { A: "SUP-A", B: "SUP-B" },
    );
    const roots = await listNonTerminalRootCauseBlockersPure("root", fetchers);
    expect(roots).toEqual([
      { id: "A", identifier: "SUP-A", status: "blocked" },
      { id: "B", identifier: "SUP-B", status: "todo" },
    ]);
  });

  it("treats a cancelled node as terminal", async () => {
    const fetchers = makeFetchers({ root: ["A"] }, { A: "cancelled" });
    const roots = await listNonTerminalRootCauseBlockersPure("root", fetchers);
    expect(roots).toEqual([]);
  });

  it("terminates on a blocker cycle (no live leaf)", async () => {
    // A <-> B, both live: each has a live blocker, so neither is a leaf.
    const fetchers = makeFetchers({ root: ["A"], A: ["B"], B: ["A"] }, { A: "in_progress", B: "in_progress" });
    const roots = await listNonTerminalRootCauseBlockersPure("root", fetchers);
    expect(roots).toEqual([]);
  });

  it("respects maxDepth", async () => {
    // root -> A -> B -> C, all live. maxDepth 1 reaches only A; A is a leaf of the
    // truncated graph, so it is reported even though B/C exist beyond the bound.
    const fetchers = makeFetchers(
      { root: ["A"], A: ["B"], B: ["C"], C: [] },
      { A: "in_progress", B: "in_progress", C: "in_progress" },
    );
    const roots = await listNonTerminalRootCauseBlockersPure("root", fetchers, { maxDepth: 1 });
    expect(roots.map((r) => r.id)).toEqual(["A"]);
  });
});

describe("issueInBlockerClosurePure (deadlock predicate)", () => {
  it("is true when the target is reachable from the root", async () => {
    const fetchers = makeFetchers({ root: ["A"], A: ["B"] }, { A: "in_progress", B: "in_progress" });
    await expect(issueInBlockerClosurePure("root", "B", fetchers)).resolves.toBe(true);
  });

  it("is false when the target is not reachable", async () => {
    const fetchers = makeFetchers({ root: ["A"], A: [] }, { A: "in_progress", B: "in_progress" });
    await expect(issueInBlockerClosurePure("root", "B", fetchers)).resolves.toBe(false);
  });

  it("is true for the root itself", async () => {
    const fetchers = makeFetchers({}, {});
    await expect(issueInBlockerClosurePure("root", "root", fetchers)).resolves.toBe(true);
  });

  it("is false when the target is only reachable through a terminal node", async () => {
    // root -> C (done) -> B: the walk stops at C, so B is not in the live closure.
    const fetchers = makeFetchers({ root: ["C"], C: ["B"] }, { C: "done", B: "in_progress" });
    await expect(issueInBlockerClosurePure("root", "B", fetchers)).resolves.toBe(false);
  });
});

// A where-ignoring db mock: each query is independent and the code only reads the
// row set, so the fixtures are keyed by the selected column shape.
function makeDb(overrides: {
  relations?: Array<{ blockerId: string; blockedId: string }>;
  issues?: Array<{ id: string; status: string; identifier: string | null }>;
  executionWorkspaceId?: string | null;
  sourceIssueId?: string | null;
  ownerFound?: boolean;
} = {}) {
  const calls: string[] = [];
  return {
    select: vi.fn((cols: Record<string, unknown>) => {
      if ("blockedId" in cols) {
        calls.push("relations");
        return { from: () => ({ where: () => Promise.resolve(overrides.relations ?? []) }) };
      }
      if ("status" in cols) {
        calls.push("issues");
        return { from: () => ({ where: () => Promise.resolve(overrides.issues ?? []) }) };
      }
      if ("executionWorkspaceId" in cols) {
        calls.push("card-ws");
        return {
          from: () => ({
            where: () => Promise.resolve([{ executionWorkspaceId: overrides.executionWorkspaceId ?? null }]),
          }),
        };
      }
      if ("sourceIssueId" in cols) {
        calls.push("ws-source");
        return { from: () => ({ where: () => Promise.resolve([{ sourceIssueId: overrides.sourceIssueId ?? null }]) }) };
      }
      if ("identifier" in cols) {
        calls.push("owner");
        const id = overrides.sourceIssueId ?? null;
        const found = overrides.ownerFound !== false && id;
        return {
          from: () => ({ where: () => Promise.resolve(found ? [{ id, identifier: "SUP-OWNER" }] : []) }),
        };
      }
      throw new Error("unexpected select cols: " + Object.keys(cols).join(","));
    }),
    _calls: calls,
  };
}

describe("createDbBlockerFetchers (drizzle row mapping)", () => {
  it("groups blocker ids under the blocked id", async () => {
    const db = makeDb({
      relations: [
        { blockerId: "A", blockedId: "root" },
        { blockerId: "B", blockedId: "root" },
        { blockerId: "C", blockedId: "A" },
      ],
    });
    const fetchers = createDbBlockerFetchers(db as never, "company");
    const map = await fetchers.fetchBlockersFor(["root", "A"]);
    expect(map.get("root")).toEqual(["A", "B"]);
    expect(map.get("A")).toEqual(["C"]);
  });

  it("returns an empty map for no ids without querying", async () => {
    const db = makeDb();
    const fetchers = createDbBlockerFetchers(db as never, "company");
    const map = await fetchers.fetchBlockersFor([]);
    expect(map.size).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("maps issue ids to status + identifier", async () => {
    const db = makeDb({
      issues: [
        { id: "A", status: "in_progress", identifier: "SUP-A" },
        { id: "B", status: "done", identifier: null },
      ],
    });
    const fetchers = createDbBlockerFetchers(db as never, "company");
    const map = await fetchers.fetchIssues(["A", "B"]);
    expect(map.get("A")).toEqual({ status: "in_progress", identifier: "SUP-A" });
    expect(map.get("B")).toEqual({ status: "done", identifier: null });
  });
});

describe("resolveCarrierOwner (ADR-091 D1 carrier resolution)", () => {
  it("resolves the parent that owns a shared workspace", async () => {
    const db = makeDb({ executionWorkspaceId: "ws-1", sourceIssueId: CARRIER });
    const owner = await resolveCarrierOwner(db as never, "company", "child-1");
    expect(owner).toEqual({ ownerId: CARRIER, identifier: "SUP-OWNER" });
  });

  it("returns null when the card owns its own workspace row", async () => {
    const db = makeDb({ executionWorkspaceId: "ws-1", sourceIssueId: "child-1" });
    const owner = await resolveCarrierOwner(db as never, "company", "child-1");
    expect(owner).toBeNull();
  });

  it("returns null when the card has no execution workspace", async () => {
    const db = makeDb({ executionWorkspaceId: null });
    const owner = await resolveCarrierOwner(db as never, "company", "child-1");
    expect(owner).toBeNull();
  });

  it("returns null when the source owner does not resolve to an issue", async () => {
    const db = makeDb({ executionWorkspaceId: "ws-1", sourceIssueId: "ghost", ownerFound: false });
    const owner = await resolveCarrierOwner(db as never, "company", "child-1");
    expect(owner).toBeNull();
  });
});

