import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLogActivityInTransaction = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./activity-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./activity-log.js")>();
  return { ...actual, logActivityInTransaction: mockLogActivityInTransaction };
});

import {
  ADR072_CLOSE_LADDER_ADVISORY_ACTION,
  ADR072_CLOSE_LADDER_ESCALATION_ACTION,
  ADR072_CLOSE_LADDER_ESCALATION_MARKER,
  createAdr072CloseLadderEscalationSweepService,
  type Adr072CloseLadderEscalationWakeup,
} from "./adr072-close-ladder-escalation-sweep.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";

const DRIZZLE_TABLE_NAME = Symbol.for("drizzle:Name");
function drizzleTableName(table: unknown): string | undefined {
  if (!table || typeof table !== "object") return undefined;
  const name = (table as Record<PropertyKey, unknown>)[DRIZZLE_TABLE_NAME];
  return typeof name === "string" ? name : undefined;
}

const COMPANY = "company-1";
const PARENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const QAE_AGENT_ID = "a1111111-1111-4111-8111-111111111111";
const LE_AGENT_ID = "b2222222-2222-4222-8222-222222222222";
const CTO_AGENT_ID = "c3333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-11-03T12:00:00.000Z");

type DbState = {
  advisoryRows: Array<{ id: string; companyId: string; entityId: string; createdAt: Date }>;
  escalatedMarkerRows: Array<{ id: string }>;
  issueRow: Record<string, unknown> | null;
  childRows: Array<Record<string, unknown>>;
  agentRows: Array<{ id: string; name: string }>;
  decisionRows: Array<Record<string, unknown>>;
  inserts: Array<{ table: string; values: Record<string, unknown> }>;
};

function deadlineCutoff(condition: unknown): Date | null {
  const dates: Date[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (node instanceof Date) {
      dates.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    for (const value of Object.values(node as Record<string, unknown>)) visit(value);
  };
  visit(condition);
  return dates[0] ?? null;
}

function makeDb(state: DbState) {
  const select = vi.fn((columns?: Record<string, unknown>) => {
    const keys =
      columns && typeof columns === "object" && !Array.isArray(columns)
        ? Object.keys(columns)
        : [];
    const childSignature =
      keys.length === 9
      && keys.includes("id")
      && keys.includes("identifier")
      && keys.includes("status")
      && keys.includes("executionPolicy")
      && keys.includes("executionState")
      && keys.includes("originKind")
      && keys.includes("title")
      && keys.includes("description")
      && keys.includes("parentLinkKind");
    return {
      from: (table: unknown) => {
        const name = drizzleTableName(table);
        let rows: unknown[] = [];
        let applyWindow = false;
        if (
          name === "activity_log"
          && keys.length === 4
          && keys.includes("companyId")
          && keys.includes("entityId")
          && keys.includes("createdAt")
        ) {
          rows = state.advisoryRows;
          applyWindow = true;
        } else if (name === "activity_log" && keys.length === 1 && keys[0] === "id") {
          rows = state.escalatedMarkerRows;
        } else if (name === "issues" && childSignature) {
          rows = state.childRows;
        } else if (
          name === "issues"
          && keys.length === 6
          && keys.includes("identifier")
          && keys.includes("createdByAgentId")
        ) {
          rows = state.issueRow ? [state.issueRow] : [];
        } else if (name === "issues" && keys.length === 1 && keys[0] === "id") {
          rows = [{}];
        } else if (name === "agents" && keys.length === 2 && keys.includes("name")) {
          rows = state.agentRows;
        } else if (name === "issue_execution_decisions") {
          rows = state.decisionRows;
        } else if (name === "labels" && keys.length === 1 && keys[0] === "id") {
          rows = [];
        } else if (name === "issue_labels" && keys.length === 1 && keys[0] === "issueId") {
          rows = [];
        }
        return {
          where: (condition: unknown) => {
            const node = {
              for: () => node,
              then: (
                onFulfilled: (value: unknown) => unknown,
                onRejected?: (reason: unknown) => unknown,
              ) =>
                Promise.resolve(
                  applyWindow && deadlineCutoff(condition)
                    ? rows.filter((row) => {
                        const createdAt = (row as { createdAt: Date }).createdAt;
                        return createdAt.getTime() <= deadlineCutoff(condition)!.getTime();
                      })
                    : rows,
                ).then(onFulfilled, onRejected),
              catch: (onRejected: (reason: unknown) => unknown) =>
                Promise.resolve(rows).catch(onRejected),
            };
            return node;
          },
        };
      },
    };
  });
  const insert = vi.fn((table: unknown) => {
    const name = drizzleTableName(table);
    return {
      values: (values: Record<string, unknown>) => {
        const node = {
          then: (
            onFulfilled: (value: unknown) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => {
            state.inserts.push({ table: name ?? "unknown", values });
            return Promise.resolve([{}]).then(onFulfilled, onRejected);
          },
          catch: (onRejected: (reason: unknown) => unknown) =>
            Promise.resolve([{}]).catch(onRejected),
        };
        return node;
      },
    };
  });
  const dbLike = {
    select,
    insert,
    transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ select, insert }),
  };
  return dbLike;
}

function reviewOnlyPolicy() {
  return normalizeIssueExecutionPolicy({
    stages: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        type: "review",
        participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
      },
    ],
  })!;
}

function satisfiedAdr072Policy() {
  return normalizeIssueExecutionPolicy({
    stages: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        type: "review",
        participants: [{ type: "agent", agentId: QAE_AGENT_ID }],
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        type: "review",
        participants: [{ type: "agent", agentId: LE_AGENT_ID }],
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        type: "approval",
        participants: [{ type: "agent", agentId: CTO_AGENT_ID }],
      },
    ],
  })!;
}

function openLadderedChildRow(id: string, identifier: string) {
  return {
    id,
    identifier,
    status: "todo",
    title: `${identifier} title`,
    description: `${identifier} description`,
    executionPolicy: {
      stages: [
        {
          id: "stage-x",
          type: "review",
          participants: [{ type: "agent", agentId: QAE_AGENT_ID }],
        },
      ],
    },
    executionState: null,
    originKind: "manual",
    parentLinkKind: "decomposition",
  };
}

function advancedParentState() {
  return {
    status: "pending",
    currentStageId: "11111111-1111-4111-8111-111111111111",
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: null,
    returnAssignee: null,
    deliveryAuthor: null,
    reviewRequest: null,
    completedStageIds: ["22222222-2222-4222-8222-222222222222"],
    skippedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: null,
    changesRequestedCount: 0,
  };
}

function parentIssueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PARENT_ID,
    companyId: COMPANY,
    identifier: "PAP-1587",
    executionPolicy: reviewOnlyPolicy(),
    executionState: null,
    createdByAgentId: null,
    ...overrides,
  };
}

function dueAdvisoryRow(entityId: string = PARENT_ID) {
  return {
    id: `advisory-${entityId}`,
    companyId: COMPANY,
    entityId,
    createdAt: new Date(NOW - 3 * 60 * 60 * 1000),
  };
}

function escalationMarkerInputs() {
  return mockLogActivityInTransaction.mock.calls
    .map((call) => (call as unknown[])[1] as Record<string, unknown> | undefined)
    .filter(
      (input): input is Record<string, unknown> =>
        input?.action === ADR072_CLOSE_LADDER_ESCALATION_ACTION,
    );
}

function escalationCommentInserts(state: DbState) {
  return state.inserts.filter((insert) => insert.table === "issue_comments");
}

describe("adr072 close-ladder escalation sweep", () => {
  let state: DbState;
  let wakeup: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    state = {
      advisoryRows: [],
      escalatedMarkerRows: [],
      issueRow: null,
      childRows: [],
      agentRows: [
        { id: QAE_AGENT_ID, name: "support-QAE" },
        { id: LE_AGENT_ID, name: "coder-LE" },
        { id: CTO_AGENT_ID, name: "exec-CTO" },
      ],
      decisionRows: [],
      inserts: [],
    };
    wakeup = vi.fn(async () => undefined);
  });

  function makeService(overrides: Record<string, unknown> = {}) {
    return createAdr072CloseLadderEscalationSweepService(makeDb(state) as any, {
      wakeup: wakeup as unknown as Adr072CloseLadderEscalationWakeup,
      ...overrides,
    });
  }

  function armDueIncompleteParent() {
    state.advisoryRows = [dueAdvisoryRow()];
    state.issueRow = parentIssueRow();
    state.childRows = [
      openLadderedChildRow("child-a-id", "PAP-2"),
      openLadderedChildRow("child-b-id", "PAP-3"),
    ];
  }

  it("escalates a due incomplete parent once, routed to the exec-CTO agent", async () => {
    armDueIncompleteParent();
    const service = makeService();

    const result = await service.sweep(NOW);

    expect(result).toEqual({
      candidates: 1,
      escalated: 1,
      alreadyEscalated: 0,
      notDue: 0,
      deferredNoRecipient: 0,
      failed: 0,
    });
    const markers = escalationMarkerInputs();
    expect(markers).toHaveLength(1);
    expect(markers[0]!.entityId).toBe(PARENT_ID);
    expect(markers[0]!.issueId).toBe(PARENT_ID);
    expect((markers[0]!.details as Record<string, unknown>).routedToAgentId).toBe(
      CTO_AGENT_ID,
    );
    const comments = escalationCommentInserts(state);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.values.issueId).toBe(PARENT_ID);
    expect(comments[0]!.values.authorType).toBe("system");
    const body = String(comments[0]!.values.body);
    expect(body).toContain(ADR072_CLOSE_LADDER_ESCALATION_MARKER);
    expect(body).toContain("Escalated to exec-CTO");
    expect(body).toContain("120 minutes");
    expect(body).toContain("approval:exec-CTO");
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(
      CTO_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        triggerDetail: "system",
        reason: "issue_adr072_close_ladder_escalated",
        idempotencyKey: `adr072-close-ladder-escalation:${PARENT_ID}`,
        requestedByActorType: "system",
      }),
    );
  });

  it("is exactly-once: a second sweep over the durable marker neither re-posts nor re-wakes after the ladder is repaired", async () => {
    armDueIncompleteParent();
    const service = makeService();

    await service.sweep(NOW);
    const commentCount = escalationCommentInserts(state).length;
    const markerCount = escalationMarkerInputs().length;
    state.escalatedMarkerRows = [{ id: "marker-1" }];
    state.issueRow = parentIssueRow({ executionPolicy: satisfiedAdr072Policy() });

    const result = await service.sweep(NOW);

    expect(result.notDue).toBe(1);
    expect(result.escalated).toBe(0);
    expect(escalationCommentInserts(state)).toHaveLength(commentCount);
    expect(escalationMarkerInputs()).toHaveLength(markerCount);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("survives a restart: a fresh service instance derives the deadline from the durable advisory row", async () => {
    armDueIncompleteParent();
    const first = makeService();
    expect((await first.sweep(NOW)).escalated).toBe(1);
    state.escalatedMarkerRows = [{ id: "marker-1" }];

    const restarted = makeService();
    const result = await restarted.sweep(NOW);

    expect(result.alreadyEscalated).toBe(1);
    expect(result.escalated).toBe(0);
    expect(escalationCommentInserts(state)).toHaveLength(1);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("does not escalate when the ladder completes before the deadline", async () => {
    state.advisoryRows = [dueAdvisoryRow()];
    state.issueRow = parentIssueRow({ executionPolicy: satisfiedAdr072Policy() });
    state.childRows = [
      openLadderedChildRow("child-a-id", "PAP-2"),
      openLadderedChildRow("child-b-id", "PAP-3"),
    ];
    const service = makeService();

    const result = await service.sweep(NOW);

    expect(result.notDue).toBe(1);
    expect(result.escalated).toBe(0);
    expect(escalationMarkerInputs()).toEqual([]);
    expect(escalationCommentInserts(state)).toEqual([]);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("does not escalate when the pointer advances before the deadline", async () => {
    state.advisoryRows = [dueAdvisoryRow()];
    state.issueRow = parentIssueRow({ executionState: advancedParentState() });
    state.childRows = [
      openLadderedChildRow("child-a-id", "PAP-2"),
      openLadderedChildRow("child-b-id", "PAP-3"),
    ];
    const service = makeService();

    const result = await service.sweep(NOW);

    expect(result.notDue).toBe(1);
    expect(escalationMarkerInputs()).toEqual([]);
    expect(escalationCommentInserts(state)).toEqual([]);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("ignores advisories whose deadline has not yet elapsed", async () => {
    armDueIncompleteParent();
    state.advisoryRows = [
      {
        id: "advisory-young",
        companyId: COMPANY,
        entityId: PARENT_ID,
        createdAt: new Date(NOW - 60 * 1000),
      },
    ];
    const service = makeService();

    const result = await service.sweep(NOW);

    expect(result.candidates).toBe(0);
    expect(wakeup).not.toHaveBeenCalled();
    expect(escalationCommentInserts(state)).toEqual([]);
  });

  it("defers without posting when the company has no exec-CTO agent to route to", async () => {
    armDueIncompleteParent();
    state.agentRows = [
      { id: QAE_AGENT_ID, name: "support-QAE" },
      { id: LE_AGENT_ID, name: "coder-LE" },
    ];
    const service = makeService();

    const result = await service.sweep(NOW);

    expect(result.deferredNoRecipient).toBe(1);
    expect(result.escalated).toBe(0);
    expect(escalationMarkerInputs()).toEqual([]);
    expect(escalationCommentInserts(state)).toEqual([]);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("does not escalate a parent with fewer than two laddered children", async () => {
    state.advisoryRows = [dueAdvisoryRow()];
    state.issueRow = parentIssueRow();
    state.childRows = [openLadderedChildRow("child-a-id", "PAP-2")];
    const service = makeService();

    const result = await service.sweep(NOW);

    expect(result.notDue).toBe(1);
    expect(escalationMarkerInputs()).toEqual([]);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("reports a failed wake but keeps the committed escalation, and the next sweep re-routes it", async () => {
    armDueIncompleteParent();
    wakeup.mockRejectedValueOnce(new Error("wake enqueue failed"));
    const service = makeService();

    const first = await service.sweep(NOW);

    expect(first.failed).toBe(1);
    expect(first.escalated).toBe(0);
    expect(escalationCommentInserts(state)).toHaveLength(1);
    state.escalatedMarkerRows = [{ id: "marker-1" }];

    const second = await service.sweep(NOW);

    expect(second.alreadyEscalated).toBe(1);
    expect(second.failed).toBe(0);
    expect(escalationCommentInserts(state)).toHaveLength(1);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("does not re-wake a stale escalation marker after the close ladder becomes complete", async () => {
    armDueIncompleteParent();
    state.escalatedMarkerRows = [{ id: "marker-1" }];
    state.issueRow = parentIssueRow({ executionPolicy: satisfiedAdr072Policy() });
    const service = makeService();

    const result = await service.sweep(NOW);

    expect(result.notDue).toBe(1);
    expect(result.alreadyEscalated).toBe(0);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("dedupes multiple advisory rows on the same parent into one candidate", async () => {
    armDueIncompleteParent();
    state.advisoryRows = [dueAdvisoryRow(), dueAdvisoryRow()];
    const service = makeService();

    const result = await service.sweep(NOW);

    expect(result.candidates).toBe(1);
    expect(result.escalated).toBe(1);
    expect(escalationCommentInserts(state)).toHaveLength(1);
  });

  it("escalates an out-of-order ladder (no missing rung) the same way", async () => {
    armDueIncompleteParent();
    state.issueRow = parentIssueRow({
      executionPolicy: normalizeIssueExecutionPolicy({
        stages: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            type: "approval",
            participants: [{ type: "agent", agentId: CTO_AGENT_ID }],
          },
          {
            id: "11111111-1111-4111-8111-111111111111",
            type: "review",
            participants: [{ type: "agent", agentId: QAE_AGENT_ID }],
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            type: "review",
            participants: [{ type: "agent", agentId: LE_AGENT_ID }],
          },
        ],
      })!,
    });
    const service = makeService();

    const result = await service.sweep(NOW);

    expect(result.escalated).toBe(1);
    const body = String(escalationCommentInserts(state)[0]!.values.body);
    expect(body).toContain("Out-of-order close-ladder stage(s): approval:exec-CTO");
  });
});
