import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";
import { reportUnexpectedRouteError } from "./helpers/report-unexpected-route-error.js";

// SUP-15878 / SUP-15958: the in-scope predicate is the canonical shared
// `countLadderedChildren` (post-exclusion, `>= 2` mechanism-D count). A card
// whose only children are redo/delivery or otherwise excluded does NOT owe a
// close ladder and is not diagnosed; a card with two or more laddered children
// and no `approval` stage is refused with a typed 409 and a durable activity
// row on both the `done` and `in_review` paths, carrying the canonical
// ladderedChildCount / ladderedChildIdentifiers / excludedChildIdentifiers.

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  findOpenAncestorCreatedByAgent: vi.fn(async () => null),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(async () => []),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getAncestors: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  listBlockerAttention: vi.fn(),
  listReviewAttention: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  getActiveInboxArchiveFields: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  decide: vi.fn(),
  hasPermission: vi.fn(async () => false),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
// SUP-15878: both durable missing-approval-stage signals are now written through
// the transactional logger (logActivityInTransaction), which propagates
// persistence errors, so the test asserts against that call rather than the
// fire-and-forget logActivity.
const mockLogActivityInTransaction = vi.hoisted(() => vi.fn(async () => undefined));
// Non-`cancelled` child rows the child-count query resolves. Per-test override
// switches between open children, cancelled-only children, and no children.
const childRowsState = vi.hoisted(() => ({ rows: [] as unknown[] }));
// SUP-15958: the carve-out label rows (`work-type:redo` / `work-type:delivery`)
// and the issue_labels mapping they resolve to. `countLadderedChildren` reads
// these to exclude redo/delivery children from the laddered count; empty by
// default so the carve-out is inert unless a test arms it.
const carveOutLabelRowsState = vi.hoisted(() => ({ rows: [] as unknown[] }));
const carveOutIssueLabelRowsState = vi.hoisted(() => ({ rows: [] as unknown[] }));
// SUP-17158 (acquisition-flag-dedup-race / -not-durable): the durable
// acquisition-flag dedup read. The flag serializes on the parent row and
// dedups by reading the activity table for a prior
// `issue.missing_approval_stage_acquired` row on this parent — a
// history-independent uniqueness check (never a bounded comment scan). Empty by
// default so a fresh acquisition is not deduped.
const activityFlagState = vi.hoisted(() => ({ rows: [] as unknown[] }));
// SUP-17538: the ADR-072 close-ladder shape read (`findMissingAdr072CloseLadderStages`)
// resolves participant agent urlKeys from the agents table via an `{id, name}`
// projection. Empty by default — like the handoff-agent default, whose rows
// carry no `name`, every rung resolves as unsatisfied, which is the
// conservative shape the non-SUP-17538 tests in this file expect. Arm it only
// to model a parent whose ladder already satisfies ADR-072.
const agentNameRowsState = vi.hoisted(() => ({ rows: [] as unknown[] }));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  listForIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  create: vi.fn(async () => ({ id: "77777777-7777-4777-8777-777777777777" })),
  getForIssue: vi.fn(),
  acceptInteraction: vi.fn(),
  rejectInteraction: vi.fn(),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));

const mockDbSelect = vi.hoisted(() => vi.fn());
const mockTxWriteChain = vi.hoisted(() => {
  const chain = (resolves: unknown[] = []) => {
    const self: Record<string, unknown> = {
      returning: () => chain(resolves),
      where: () => chain(resolves),
      set: () => chain(resolves),
      values: () => chain(resolves),
    };
    self.then = (onF?: unknown, onR?: unknown) =>
      Promise.resolve(resolves).then(
        onF as (v: unknown) => unknown,
        onR as (r: unknown) => unknown,
      );
    self.catch = (fn: (r: unknown) => unknown) => Promise.resolve(resolves).catch(fn);
    return self;
  };
  return chain;
});
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (callback: (tx: Record<string, unknown>) => Promise<unknown>) =>
    callback({
      select: mockDbSelect,
      insert: () => mockTxWriteChain([{}]),
      update: () => mockTxWriteChain([]),
      delete: () => mockTxWriteChain([]),
    })),
}));

const mockResolveSummaryGenerationReturnAssignee = vi.hoisted(() => vi.fn(async () => null));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1" })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async (agentId: string) => ({
        id: agentId,
        companyId: "company-1",
        permissions: null,
      })),
      resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
        ambiguous: false,
        agent: {
          id: reference,
          companyId: "company-1",
          name: `agent-${reference.slice(0, 8)}`,
          status: "idle",
          orgChainHealth: { status: "healthy" },
        },
      })),
    }),
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({
      getIssueDocumentPayload: vi.fn(async () => ({})),
    }),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({
      getDefaultCompanyGoal: vi.fn(async () => null),
    }),
    heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({
      getById: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      getExperimental: vi.fn(async () => ({ enableExternalObjects: false })),
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    logActivityInTransaction: mockLogActivityInTransaction,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({
      listForIssue: vi.fn(async () => []),
    }),
  }));
  vi.doMock("../services/external-objects.js", () => ({
    externalObjectService: () => ({
      syncCommentSafely: vi.fn(async () => undefined),
      syncDocumentSafely: vi.fn(async () => undefined),
      syncIssueSafely: vi.fn(async () => undefined),
      listForIssue: vi.fn(async () => []),
      getIssueSummary: vi.fn(async () => null),
      getIssueSummaries: vi.fn(async () => []),
      refreshIssueObjects: vi.fn(async () => []),
    }),
  }));
  vi.doMock("../services/summary-slots.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../services/summary-slots.js")>();
    return {
      ...actual,
      resolveSummaryGenerationReturnAssignee: mockResolveSummaryGenerationReturnAssignee,
    };
  });
}

type TestActor =
  | {
      type: "board";
      userId: string;
      companyIds: string[];
      source: "local_implicit" | "oauth";
      isInstanceAdmin: boolean;
    }
  | {
      type: "agent";
      agentId: string;
      companyId: string;
      runId: string | null;
    };

async function createApp(actor?: TestActor) {
  const { errorHandler } = await import("../middleware/index.js");
  const { issueRoutes } = await import("../routes/issues.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(reportUnexpectedRouteError("issue-execution-policy-missing-approval-stage"));
  app.use(errorHandler);
  return app;
}

const HANDOFF_AGENT_ROWS = [{
  id: "55555555-5555-4555-8555-555555555555",
  companyId: "company-1",
  agentId: "33333333-3333-4333-8333-333333333333",
  contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  permissions: null,
}];

function dbChainNode(rows: unknown[]): Record<string, unknown> {
  return {
    where: () => dbChainNode(rows),
    for: () => dbChainNode(rows),
    orderBy: () => dbChainNode([]),
    limit: () => dbChainNode([]),
    offset: () => dbChainNode([]),
    innerJoin: () => dbChainNode([]),
    leftJoin: () => dbChainNode([]),
    returning: () => dbChainNode([]),
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(onFulfilled, onRejected),
    catch: (onRejected: (reason: unknown) => unknown) => Promise.resolve(rows).catch(onRejected),
  };
}

// SUP-17158: read a drizzle table's name without object-identity assumptions.
// The guard's `@paperclipai/db` module instance differs from this test's, so
// `table === labels` is always false — but the table name is stored under the
// GLOBAL symbol registry (`Symbol.for("drizzle:Name")`), so the string is
// reliable across instances. Used to route the acquisition-flag dedup read
// (a 1-key `id` projection on the activity_log table, indistinguishable from
// the carve-out label read by projection signature alone).
const DRIZZLE_TABLE_NAME = Symbol.for("drizzle:Name");
function drizzleTableName(table: unknown): string | undefined {
  if (!table || typeof table !== "object") return undefined;
  const name = (table as Record<PropertyKey, unknown>)[DRIZZLE_TABLE_NAME];
  return typeof name === "string" ? name : undefined;
}

// SUP-16586: `countLadderedChildren` resolves the carve-out label names through
// `inArray(labels.name, [...])`. A plain mock that returns every seeded label
// row regardless of that predicate would make the new carve-out look honored
// BEFORE the change and let the route-level regression pass while pinning
// nothing. Emulate the name filter instead: keep only the seeded label rows
// whose `name` is among the string params the guard actually requested
// (drizzle stores `inArray` values as `Param` chunks under `queryChunks`).
function requestedLabelNames(condition: unknown): Set<string> {
  const values = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const anyNode = node as { queryChunks?: unknown[]; value?: unknown };
    if (Array.isArray(anyNode.queryChunks)) {
      for (const chunk of anyNode.queryChunks) visit(chunk);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (anyNode.constructor?.name === "Param" && typeof anyNode.value === "string") {
      values.add(anyNode.value);
    }
  };
  visit(condition);
  return values;
}

function filterLabelRowsByName(rows: unknown[], condition: unknown): unknown[] {
  const requested = requestedLabelNames(condition);
  return rows.filter(
    (row) =>
      row &&
      typeof row === "object" &&
      typeof (row as Record<string, unknown>).name === "string" &&
      requested.has((row as Record<string, unknown>).name as string),
  );
}

const PARENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD_PARTICIPANT_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "55555555-5555-4555-8555-555555555555";

// A decomposition child that counts toward the laddered count: manual origin,
// a non-null executionPolicy, and at least one completed stage — exactly the
// row shape `countLadderedChildren` reads from the issues table. `status`
// defaults to a non-cancelled value; pass "cancelled" to model a row the
// SUP-16025 non-cancelled-child scope must exclude.
function ladderedChildRow(
  id: string,
  identifier: string,
  originKind: string = "manual",
  status: string = "in_review",
) {
  return {
    id,
    identifier,
    status,
    executionPolicy: {
      stages: [{ id: "stage-x", type: "review", participants: [{ type: "agent", agentId: AGENT_ID }] }],
    },
    executionState: {
      status: "completed",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: null,
      deliveryAuthor: null,
        reviewRequest: null,
        completedStageIds: ["11111111-1111-4111-8111-111111111111"],
        skippedStageIds: [],
      lastDecisionId: "22222222-2222-4222-8222-222222222222",
      lastDecisionOutcome: "approved",
      monitor: null,
      changesRequestedCount: 0,
    },
    originKind,
  };
}

// SUP-17158: a decomposition child that CARRIES a ladder but has not yet run it
// (executionState still null) — the shape the proactive acquisition flag counts
// while the children are still open. Distinct from `ladderedChildRow`, whose
// completed stage models the close-guard's "ladder has run" state.
function openLadderedChildRow(id: string, identifier: string, originKind: string = "manual") {
  return {
    id,
    identifier,
    status: "todo",
    executionPolicy: {
      stages: [{ id: "stage-x", type: "review", participants: [{ type: "agent", agentId: AGENT_ID }] }],
    },
    executionState: null,
    originKind,
  };
}

// SUP-17158 (acquisition-counts-stage-less-child): a child whose executionPolicy
// carries no stages. It is not a laddered child and must NOT be counted by the
// acquisition flag, even though the "has the ladder run" gate is relaxed.
function stageLessChildRow(id: string, identifier: string) {
  return {
    id,
    identifier,
    status: "todo",
    executionPolicy: { stages: [] },
    executionState: null,
    originKind: "manual",
  };
}

// Arm the `work-type:redo` carve-out so the named child is excluded from the
// laddered count by the real helper (the label-name read returns the redo
// label and the issue_labels read maps it onto that child).
function armRedoCarveOutFor(childId: string) {
  carveOutLabelRowsState.rows = [{ id: "label-work-type-redo", name: "work-type:redo" }];
  carveOutIssueLabelRowsState.rows = [{ issueId: childId }];
}

// SUP-16586: arm the `work-type:architecture-review` carve-out so the named child
// is excluded from the laddered count by the real helper, identically to the
// redo/delivery carve-outs.
function armArchitectureReviewCarveOutFor(childId: string) {
  carveOutLabelRowsState.rows = [
    { id: "label-work-type-architecture-review", name: "work-type:architecture-review" },
  ];
  carveOutIssueLabelRowsState.rows = [{ issueId: childId }];
}

// SUP-17177: arm the `work-type:process` carve-out so the named child is excluded
// from the laddered count by the real helper, identically to the redo/delivery/
// architecture-review carve-outs.
function armProcessCarveOutFor(childId: string) {
  carveOutLabelRowsState.rows = [
    { id: "label-work-type-process", name: "work-type:process" },
  ];
  carveOutIssueLabelRowsState.rows = [{ issueId: childId }];
}

function reviewOnlyPolicy() {
  return normalizeIssueExecutionPolicy({
    stages: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        type: "review",
        participants: [{ type: "agent", agentId: CHILD_PARTICIPANT_ID }],
      },
    ],
  })!;
}

function reviewPlusApprovalPolicy() {
  return normalizeIssueExecutionPolicy({
    stages: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        type: "review",
        participants: [{ type: "agent", agentId: CHILD_PARTICIPANT_ID }],
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        type: "approval",
        participants: [{ type: "agent", agentId: CHILD_PARTICIPANT_ID }],
      },
    ],
  })!;
}

function parentIssue(executionPolicy: unknown) {
  return {
    id: PARENT_ID,
    companyId: "company-1",
    status: "todo",
    reviewPolicy: null,
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-1587",
    title: "Parent with open children",
    executionPolicy,
    executionState: null,
  };
}

function gapActivityInputs() {
  // Both durable signals are written through logActivityInTransaction (the
  // error-propagating, transactional logger). Asserting against that call is what
  // proves the signals are no longer fire-and-forget.
  return mockLogActivityInTransaction.mock.calls
    .map((call) => call[1] as Record<string, unknown> | undefined)
    .filter((input): input is Record<string, unknown> =>
      typeof input?.action === "string" && input.action.includes("missing_approval_stage"));
}

function gapActivityInput(action: string) {
  return gapActivityInputs().find((input) => input.action === action);
}

describe("issue execution policy missing approval stage", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/external-objects.js");
    registerModuleMocks();
    vi.clearAllMocks();
    childRowsState.rows = [];
    carveOutLabelRowsState.rows = [];
    carveOutIssueLabelRowsState.rows = [];
    activityFlagState.rows = [];
    agentNameRowsState.rows = [];
    mockResolveSummaryGenerationReturnAssignee.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.addComment.mockImplementation(async (_id: string, body: string) => ({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      body,
    }));
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockIssueService.listBlockerAttention.mockResolvedValue(new Map());
    mockIssueService.listReviewAttention.mockResolvedValue(new Map());
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.getActiveInboxArchiveFields.mockResolvedValue({});
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueThreadInteractionService.create.mockResolvedValue({ id: "77777777-7777-4777-8777-777777777777" });
    mockIssueThreadInteractionService.getForIssue.mockResolvedValue(null);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockDbSelect.mockImplementation((columns: unknown) => {
      const keys =
        columns && typeof columns === "object" && !Array.isArray(columns)
          ? Object.keys(columns as object)
          : [];
      // SUP-15958: `countLadderedChildren` runs up to three indexed reads on the
      // PATCH path. Route each to its own state so the real helper's exclusions
      // are exercised; every other select keeps the hoisted handoff-agent-row
      // default. The child decomposition is the only 7-key projection on the
      // path, so it is matched by signature alone (no table-identity assumption);
      // the carve-out label reads are matched by table + single-key projection.
      // ADR-103 M2b added `parentLinkKind` to this projection, so the signature
      // tracks the current column set.
      const childSignature =
        keys.length === 7
        && keys.includes("id")
        && keys.includes("identifier")
        && keys.includes("status")
        && keys.includes("executionPolicy")
        && keys.includes("executionState")
        && keys.includes("originKind")
        && keys.includes("parentLinkKind");
      return {
        from: (table: unknown) => {
          let rows: unknown[] = HANDOFF_AGENT_ROWS;
          let filterLabelNames = false;
          if (childSignature) {
            rows = childRowsState.rows;
          } else if (keys.length === 2 && keys.includes("id") && keys.includes("name")) {
            // SUP-17538: the ADR-072 shape read resolves participant agent
            // urlKeys from the agents table. Armed per-test; empty by default
            // (conservative — every rung unsatisfied), exactly as the
            // handoff-agent default behaves since its rows carry no `name`.
            rows = agentNameRowsState.rows;
          } else if (drizzleTableName(table) === "activity_log") {
            // SUP-17158: the acquisition-flag dedup is a 1-key `id` projection on
            // the activity_log table, signature-colliding with the carve-out
            // label read. It is routed by drizzle table name, which is reliable
            // across module instances even when object identity is not.
            rows = activityFlagState.rows;
          } else if (keys.length === 1 && keys[0] === "id") {
            // The carve-out labels read is the only single-key `id` projection on
            // this route path (the child decomposition is a 6-key projection and
            // the issue read is a 3-key projection), so it is matched by
            // signature alone. Table-identity matching is unreliable here: the
            // guard's `@paperclipai/db` instance is a different module instance
            // than this test's, so `table === labels` is always false.
            rows = carveOutLabelRowsState.rows;
            filterLabelNames = true;
          } else if (keys.length === 1 && keys[0] === "issueId") {
            rows = carveOutIssueLabelRowsState.rows;
          }
          return {
            where: (condition: unknown) =>
              dbChainNode(filterLabelNames ? filterLabelRowsByName(rows, condition) : rows),
            innerJoin: () => dbChainNode([]),
          };
        },
      };
    });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
      const allowed = input.actor?.type === "board" && input.actor.source === "local_implicit"
        ? true
        : input.actor?.type === "agent" && [
            "company_scope:read",
            "issue:read",
            "issue:mutate",
            "runtime:manage",
            "tasks:assign",
          ].includes(input.action ?? "")
        ? true
        : Boolean(await mockAccessService.canUser() || await mockAccessService.hasPermission());
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  function agentActor(): TestActor {
    return { type: "agent", agentId: AGENT_ID, companyId: "company-1", runId: RUN_ID };
  }

  it("refuses done on an in-scope card with the typed ladder-gap signal", async () => {
    const issue = parentIssue(reviewOnlyPolicy());
    childRowsState.rows = [
      ladderedChildRow("child-a-id", "PAP-2"),
      ladderedChildRow("child-b-id", "PAP-3"),
    ];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("no approval stage"),
      code: "done_transition_missing_approval_stage",
      remediation: expect.stringContaining("approval"),
      details: {
        issueId: PARENT_ID,
        identifier: "PAP-1587",
        ladderedChildCount: 2,
        ladderedChildIdentifiers: ["PAP-2", "PAP-3"],
        excludedChildIdentifiers: [],
        stageTypes: ["review"],
      },
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(gapActivityInput("issue.done_missing_approval_stage_refused")).toMatchObject({
      entityId: PARENT_ID,
      issueId: PARENT_ID,
      details: {
        ladderedChildCount: 2,
        ladderedChildIdentifiers: ["PAP-2", "PAP-3"],
        excludedChildIdentifiers: [],
        stageTypes: ["review"],
        source: "done",
      },
    });
  });

  // SUP-17125 (the SUP-16420 incident, measured cause): a bare `done` PATCH on a
  // card with >=2 laddered children and no approval stage is refused 409 with
  // `done_transition_missing_approval_stage`. The refusal names its own remedy,
  // yet it reached the agent's report 0 of 27 times — nothing in the thread
  // recorded it. A refused terminal status write must now leave a readable
  // system record (guard code + remediation) so the NEXT run sees WHY the close
  // was refused before re-deriving it. This pins the ACTUAL-cause path, which
  // the tier/delivery refusal tests do not cover. Fails without the route's
  // postTerminalStatusRefusalComment call on this path.
  it("leaves a readable thread refusal record on the missing-approval-stage 409 (SUP-17125)", async () => {
    const issue = parentIssue(reviewOnlyPolicy());
    childRowsState.rows = [
      ladderedChildRow("child-a-id", "PAP-2"),
      ladderedChildRow("child-b-id", "PAP-3"),
    ];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));
    mockIssueService.listComments.mockResolvedValue([]);

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe("done_transition_missing_approval_stage");
    expect(res.body.details.ladderedChildCount).toBe(2);
    expect(mockIssueService.update).not.toHaveBeenCalled();

    const refusalCall = mockIssueService.addComment.mock.calls.find(
      (call) => typeof call[1] === "string" && call[1].includes("[Terminal status refused]"),
    );
    expect(refusalCall, JSON.stringify(mockIssueService.addComment.mock.calls)).toBeDefined();
    const body = refusalCall![1] as string;
    expect(body).toContain("[Terminal status refused] done_transition_missing_approval_stage");
    expect(body).toContain("HTTP 409");
    expect(body).toContain("Remedy:");
    expect(body).toContain(`Refusing run: ${RUN_ID}`);
    expect(refusalCall![3]).toMatchObject({ authorType: "system" });
  });

  // Distinguishing regression (SUP-15878 R2 / SUP-16024): the durable refusal
  // row is REQUIRED evidence, not best-effort. If its write cannot persist, the
  // route must fail closed — it may not return the typed 409 (which claims the
  // signal was emitted) when no `issue.done_missing_approval_stage_refused`
  // row actually committed. Forcing the transactional logger to reject proves
  // the persistence error is surfaced as a 5xx rather than swallowed and the
  // original 409 rethrown. The normal 409 path above already pins the
  // committed-row success behaviour.
  it("fails closed with an error (not the typed 409) when the refusal audit row cannot persist", async () => {
    const issue = parentIssue(reviewOnlyPolicy());
    childRowsState.rows = [
      ladderedChildRow("child-a-id", "PAP-2"),
      ladderedChildRow("child-b-id", "PAP-3"),
    ];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));
    mockLogActivityInTransaction.mockRejectedValueOnce(new Error("audit row insert failed"));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    // No successful-looking 409 may coexist with a missing durable row: the
    // persistence error surfaces as a 5xx and the missing-stage diagnosis is
    // not claimed as emitted.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.code).not.toBe("done_transition_missing_approval_stage");
    expect(res.body.error).not.toContain("no approval stage");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // SUP-17125 (HIGH finding, round-1 self-repair): the thread refusal record is what
  // the NEXT run reads, so persisting it is part of the refusal guarantee, not
  // best-effort. If the record write cannot persist, the route must fail closed — it
  // may not return the typed 409 (which claims the refusal was recorded) when no
  // thread-readable code or remedy actually landed. Forcing the record write to
  // reject proves the persistence error surfaces as a 5xx rather than being swallowed
  // and the 409 returned. This pins the write-failure behavior of the shared
  // postTerminalStatusRefusalComment helper (delivery 409 / tier 422 /
  // missing-approval-stage 409 all call it); the audit-row fail-closed test above
  // covers the durable row, this covers the thread record.
  it("fails closed with an error (not the typed 409) when the thread refusal record cannot persist", async () => {
    const issue = parentIssue(reviewOnlyPolicy());
    childRowsState.rows = [
      ladderedChildRow("child-a-id", "PAP-2"),
      ladderedChildRow("child-b-id", "PAP-3"),
    ];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.addComment.mockRejectedValueOnce(new Error("refusal record write failed"));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    // No successful-looking 409 may coexist with a missing thread record: the
    // persistence error surfaces as a 5xx and the refusal is not claimed as recorded.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.code).not.toBe("done_transition_missing_approval_stage");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // Regression: a `done` request that does not otherwise require a transaction
  // (no execution policy at all, so no decision, no relay stop, no review
  // activity) must STILL be refused with the typed signal. Pre-fix this took the
  // non-transactional `updateIssue()` branch, skipped the delivery catchall (the
  // gap was present), and closed the card successfully with neither guard.
  it("refuses a stage-less in-scope done that otherwise needs no transaction", async () => {
    const issue = parentIssue(null);
    childRowsState.rows = [
      ladderedChildRow("child-a-id", "PAP-2"),
      ladderedChildRow("child-b-id", "PAP-3"),
    ];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "done_transition_missing_approval_stage",
      details: {
        issueId: PARENT_ID,
        identifier: "PAP-1587",
        ladderedChildCount: 2,
        ladderedChildIdentifiers: ["PAP-2", "PAP-3"],
        excludedChildIdentifiers: [],
        stageTypes: [],
      },
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(gapActivityInput("issue.done_missing_approval_stage_refused")).toMatchObject({
      entityId: PARENT_ID,
      issueId: PARENT_ID,
      details: {
        ladderedChildCount: 2,
        ladderedChildIdentifiers: ["PAP-2", "PAP-3"],
        excludedChildIdentifiers: [],
        stageTypes: [],
        source: "done",
      },
    });
  });

  it("refuses a done on a review-only card whose review is already completed", async () => {
    const issue = {
      ...parentIssue(reviewOnlyPolicy()),
      status: "in_review",
      executionState: {
        status: "completed",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        deliveryAuthor: null,
        reviewRequest: null,
        completedStageIds: ["11111111-1111-4111-8111-111111111111"],
        skippedStageIds: [],
        lastDecisionId: "22222222-2222-4222-8222-222222222222",
        lastDecisionOutcome: "approved",
        monitor: null,
        changesRequestedCount: 0,
      },
    };
    childRowsState.rows = [
      ladderedChildRow("child-a-id", "PAP-2"),
      ladderedChildRow("child-b-id", "PAP-3"),
    ];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "done_transition_missing_approval_stage",
      details: {
        issueId: PARENT_ID,
        identifier: "PAP-1587",
        ladderedChildCount: 2,
        ladderedChildIdentifiers: ["PAP-2", "PAP-3"],
        excludedChildIdentifiers: [],
        stageTypes: ["review"],
      },
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(gapActivityInput("issue.done_missing_approval_stage_refused")).toMatchObject({
      entityId: PARENT_ID,
      issueId: PARENT_ID,
      details: {
        ladderedChildCount: 2,
        ladderedChildIdentifiers: ["PAP-2", "PAP-3"],
        excludedChildIdentifiers: [],
        stageTypes: ["review"],
        source: "done",
      },
    });
  });

  it("completes an in_review transition on an in-scope card and records the signal", async () => {
    const issue = parentIssue(reviewOnlyPolicy());
    childRowsState.rows = [
      ladderedChildRow("child-a-id", "PAP-2"),
      ladderedChildRow("child-b-id", "PAP-3"),
    ];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      PARENT_ID,
      expect.objectContaining({
        status: "in_review",
        executionState: expect.objectContaining({
          status: "pending",
          currentParticipant: expect.objectContaining({
            type: "agent",
            agentId: CHILD_PARTICIPANT_ID,
          }),
        }),
      }),
      expect.anything(),
    );
    expect(gapActivityInput("issue.in_review_missing_approval_stage")).toMatchObject({
      entityId: PARENT_ID,
      issueId: PARENT_ID,
      details: {
        ladderedChildCount: 2,
        ladderedChildIdentifiers: ["PAP-2", "PAP-3"],
        excludedChildIdentifiers: [],
        stageTypes: ["review"],
        source: "in_review",
      },
    });
  });

  it("leaves a childless card's done transition unchanged", async () => {
    const issue = parentIssue(reviewOnlyPolicy());
    childRowsState.rows = [];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(gapActivityInputs()).toEqual([]);
  });

  // Distinguishing regression (SUP-15958): the SUP-15826 / SUP-15813 shape — a
  // card whose ONLY child is a work-type:redo child. The redo child is itself a
  // genuine laddered child (manual origin, a policy, a completed stage), so under
  // the old raw parent_id count it armed the diagnosis (1 child, no approval
  // stage → 409 refusal + spurious in_review row). The canonical
  // countLadderedChildren predicate excludes it via the work-type:redo
  // carve-out, so the laddered count is 0, the card owes no close ladder, and the
  // `done` transition is unchanged with neither signal.
  it("does not diagnose a redo-only child set and leaves the done transition unchanged", async () => {
    const issue = parentIssue(reviewOnlyPolicy());
    childRowsState.rows = [ladderedChildRow("child-redo-id", "PAP-2")];
    armRedoCarveOutFor("child-redo-id");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(gapActivityInputs()).toEqual([]);
  });

  // Distinguishing regression (SUP-16586): the SUP-16569 shape — a card whose
  // children are ONE work-type:architecture-review child (a chain terminator
  // filed to adjudicate THIS parent's close gate) plus ONE ordinary laddered
  // child. The arch child is excluded by the shared countLadderedChildren
  // predicate, so the laddered count is 1 (< 2): the card does not owe a close
  // ladder and the `done` transition is NOT refused. This exercises the SUP-15878
  // route call site directly (not the shared helper in isolation), proving the
  // route gap inherits the carve-out. It fails against the pre-change code,
  // where the `work-type:architecture-review` name is not in the carve-out set
  // so both children count (2) and the route refuses with
  // `done_transition_missing_approval_stage`.
  it("does not refuse done on a card whose children are one architecture-review child + one ordinary child (SUP-16586 route regression)", async () => {
    const issue = parentIssue(reviewOnlyPolicy());
    childRowsState.rows = [
      ladderedChildRow("child-arch-id", "PAP-2"),
      ladderedChildRow("child-genuine-id", "PAP-3"),
    ];
    armArchitectureReviewCarveOutFor("child-arch-id");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.code).not.toBe("done_transition_missing_approval_stage");
    expect(gapActivityInputs()).toEqual([]);
  });

  // Distinguishing regression (SUP-17177): the SUP-16872 shape — a work card whose
  // children are a pair of procedurally-filed process children (courier /
  // review-routing / unblock), not slices of its deliverable. Both carry the
  // `work-type:process` label, so the shared countLadderedChildren predicate
  // excludes them and the laddered count is 0 (< 2): the card does not owe a
  // close ladder and the `done` transition is NOT refused. This exercises the
  // SUP-15878 route call site directly (not the shared helper in isolation),
  // proving the route gap inherits the process carve-out. It fails against the
  // pre-change code, where the `work-type:process` name is not in the carve-out
  // set so both process children count (2) and the route refuses with
  // `done_transition_missing_approval_stage`.
  it("does not refuse done on a work card whose children are two process children (SUP-17177 route regression)", async () => {
    const issue = parentIssue(reviewOnlyPolicy());
    childRowsState.rows = [
      ladderedChildRow("child-process-1", "PAP-2"),
      ladderedChildRow("child-process-2", "PAP-3"),
    ];
    armProcessCarveOutFor("child-process-1");
    carveOutIssueLabelRowsState.rows.push({ issueId: "child-process-2" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.code).not.toBe("done_transition_missing_approval_stage");
    expect(gapActivityInputs()).toEqual([]);
  });

  // Distinguishing regression (SUP-15878 R2 / SUP-16025): the child scope is
  // NON-cancelled qualifying children only. Two cancelled children that still
  // carry a qualifying policy and a completed stage must NOT arm the diagnosis
  // — a cancelled row is not a decomposition signal — so both `done` and
  // `in_review` keep their existing behavior: no typed diagnosis, no
  // missing-approval activity row. This contrasts with the two non-cancelled
  // qualifying rows in the tests above, which still produce the diagnosis.
  it("leaves a cancelled-only child set's done transition unchanged", async () => {
    const issue = parentIssue(reviewOnlyPolicy());
    childRowsState.rows = [
      ladderedChildRow("child-a-id", "PAP-2", "manual", "cancelled"),
      ladderedChildRow("child-b-id", "PAP-3", "manual", "cancelled"),
    ];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(gapActivityInputs()).toEqual([]);
  });

  it("leaves a cancelled-only child set's in_review transition unchanged", async () => {
    const issue = parentIssue(reviewOnlyPolicy());
    childRowsState.rows = [
      ladderedChildRow("child-a-id", "PAP-2", "manual", "cancelled"),
      ladderedChildRow("child-b-id", "PAP-3", "manual", "cancelled"),
    ];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(gapActivityInputs()).toEqual([]);
  });

  it("does not diagnose a card whose policy already has an approval stage", async () => {
    const issue = parentIssue(reviewPlusApprovalPolicy());
    childRowsState.rows = [
      ladderedChildRow("child-a-id", "PAP-2"),
      ladderedChildRow("child-b-id", "PAP-3"),
    ];
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${PARENT_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      PARENT_ID,
      expect.objectContaining({ status: "in_review" }),
      expect.anything(),
    );
    expect(gapActivityInputs()).toEqual([]);
  });

  describe("SUP-17158 acquisition-time missing-approval-stage flag (review SUP-17139)", () => {
    // The proactive flag is written through the SAME transactional logger the
    // close guard uses, but under its own acquisition action — so it is
    // distinguishable from the close-guard's refused/recorded signals.
    function acquisitionFlagInputs() {
      return mockLogActivityInTransaction.mock.calls
        .map((call) => (call as unknown[])[1] as Record<string, unknown> | undefined)
        .filter((input): input is Record<string, unknown> =>
          input?.action === "issue.missing_approval_stage_acquired");
    }

    function createChildFixture() {
      mockIssueService.createChild.mockResolvedValue({
        issue: {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          companyId: "company-1",
          identifier: "PAP-NEW",
          title: "New child",
          status: "todo",
        },
        parentBlockerAdded: false,
      });
    }

    it("F1: does not flag a parent whose open children carry no stages (no predicate drift from the close guard)", async () => {
      createChildFixture();
      mockIssueService.getById.mockResolvedValue(parentIssue(reviewOnlyPolicy()));
      childRowsState.rows = [
        stageLessChildRow("child-a-id", "PAP-2"),
        stageLessChildRow("child-b-id", "PAP-3"),
      ];

      const res = await request(await createApp(agentActor()))
        .post(`/api/issues/${PARENT_ID}/children`)
        .send({ title: "New child", status: "todo" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      // Two open, non-cancelled children that are NOT laddered: the relaxed
      // completion gate must still require an actual ladder, so the count is 0
      // and no gap is diagnosed.
      expect(acquisitionFlagInputs()).toEqual([]);
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
    });

    it("flags a parent that now carries two ladder-carrying open children with no approval stage", async () => {
      createChildFixture();
      mockIssueService.getById.mockResolvedValue(parentIssue(reviewOnlyPolicy()));
      childRowsState.rows = [
        openLadderedChildRow("child-a-id", "PAP-2"),
        openLadderedChildRow("child-b-id", "PAP-3"),
      ];

      const res = await request(await createApp(agentActor()))
        .post(`/api/issues/${PARENT_ID}/children`)
        .send({ title: "New child", status: "todo" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const flags = acquisitionFlagInputs();
      expect(flags).toHaveLength(1);
      expect(flags[0]!.issueId).toBe(PARENT_ID);
      const details = flags[0]!.details as Record<string, unknown>;
      expect(details.ladderedChildCount).toBe(2);
      expect(details.ladderedChildIdentifiers).toEqual(["PAP-2", "PAP-3"]);
      expect(details.stageTypes).toEqual(["review"]);
      // The remediation string is the done-guard's own, verbatim.
      expect(typeof details.remediation).toBe("string");
      expect(mockIssueService.addComment).toHaveBeenCalledWith(
        PARENT_ID,
        expect.stringContaining("[Missing approval stage acquired]"),
        {},
        { authorType: "system" },
        // SUP-17158: the comment is written INSIDE the fenced transaction
        // (retryable, durable), not as a fire-and-forget side effect.
        expect.anything(),
      );
    });

    it("does not flag when the parent already has an approval stage", async () => {
      createChildFixture();
      mockIssueService.getById.mockResolvedValue(parentIssue(reviewPlusApprovalPolicy()));
      childRowsState.rows = [
        openLadderedChildRow("child-a-id", "PAP-2"),
        openLadderedChildRow("child-b-id", "PAP-3"),
      ];

      const res = await request(await createApp(agentActor()))
        .post(`/api/issues/${PARENT_ID}/children`)
        .send({ title: "New child", status: "todo" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(acquisitionFlagInputs()).toEqual([]);
      // SUP-17538: assert on the SUP-17158 flag's OWN marker rather than "no
      // comment at all". This parent HAS an approval stage, so the
      // missing-approval flag must stay silent — but its review/approval
      // participants are not the ratified support-QAE/coder-LE/exec-CTO rungs,
      // so its ADR-072 close-ladder shape is still incomplete and the distinct
      // child-create advisory legitimately fires. A blanket "no comment" would
      // conflate the two independent controls.
      expect(
        mockIssueService.addComment.mock.calls.some((call) =>
          String(call[1] ?? "").includes("[Missing approval stage acquired]"),
        ),
      ).toBe(false);
      expect(
        mockIssueService.addComment.mock.calls.some((call) =>
          String(call[1] ?? "").includes("[ADR-072 close ladder incomplete]"),
        ),
      ).toBe(true);
    });

    it("F2: dedups via the durable activity table — a prior flag on the same parent is a no-op", async () => {
      createChildFixture();
      mockIssueService.getById.mockResolvedValue(parentIssue(reviewOnlyPolicy()));
      childRowsState.rows = [
        openLadderedChildRow("child-a-id", "PAP-2"),
        openLadderedChildRow("child-b-id", "PAP-3"),
      ];
      // A prior durable flag row on this parent: the history-independent dedup
      // read finds it, so a second acquisition is a no-op (no second row, no
      // second comment) — regardless of how old the marker is.
      activityFlagState.rows = [{ id: "99999999-9999-4999-8999-999999999999" }];

      const res = await request(await createApp(agentActor()))
        .post(`/api/issues/${PARENT_ID}/children`)
        .send({ title: "New child", status: "todo" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(acquisitionFlagInputs()).toEqual([]);
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
    });

    it("F3: propagates a durable-flag write failure instead of swallowing it", async () => {
      createChildFixture();
      mockIssueService.getById.mockResolvedValue(parentIssue(reviewOnlyPolicy()));
      childRowsState.rows = [
        openLadderedChildRow("child-a-id", "PAP-2"),
        openLadderedChildRow("child-b-id", "PAP-3"),
      ];
      // The flag's own fenced transaction fails: a swallowed failure would drop
      // the required durable record and turn a successful acquisition back into
      // a silent-unclosable card, so it must surface as a 5xx.
      mockDb.transaction.mockRejectedValueOnce(new Error("durable flag write failed"));

      const res = await request(await createApp(agentActor()))
        .post(`/api/issues/${PARENT_ID}/children`)
        .send({ title: "New child", status: "todo" });

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
    });
  });

  describe("SUP-17538 ADR-072 close-ladder child-create advisory", () => {
    const QAE_AGENT_ID = "a1111111-1111-4111-8111-111111111111";
    const LE_AGENT_ID = "b2222222-2222-4222-8222-222222222222";
    const CTO_AGENT_ID = "c3333333-3333-4333-8333-333333333333";

    function adr072AdvisoryInputs() {
      return mockLogActivityInTransaction.mock.calls
        .map((call) => (call as unknown[])[1] as Record<string, unknown> | undefined)
        .filter((input): input is Record<string, unknown> =>
          input?.action === "issue.adr072_close_ladder_incomplete");
    }

    function advisoryComments() {
      return mockIssueService.addComment.mock.calls.filter((call) =>
        String(call[1] ?? "").includes("[ADR-072 close ladder incomplete]"),
      );
    }

    function createChildFixture() {
      mockIssueService.createChild.mockResolvedValue({
        issue: {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          companyId: "company-1",
          identifier: "PAP-NEW",
          title: "New child",
          status: "todo",
        },
        parentBlockerAdded: false,
      });
    }

    function twoOpenLadderedChildren() {
      childRowsState.rows = [
        openLadderedChildRow("child-a-id", "PAP-2"),
        openLadderedChildRow("child-b-id", "PAP-3"),
      ];
    }

    // The full ratified ADR-072 close ladder, with participants that resolve to
    // the required agent urlKeys.
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

    function armSatisfiedAgents() {
      agentNameRowsState.rows = [
        { id: QAE_AGENT_ID, name: "support-QAE" },
        { id: LE_AGENT_ID, name: "coder-LE" },
        { id: CTO_AGENT_ID, name: "exec-CTO" },
      ];
    }

    // All three rungs present and resolvable, but the exec-CTO approval lands
    // BEFORE the two review rungs — the SUP-16532 ordering violation, which is
    // reported as out-of-order (not missing) by the shared shape helper.
    function outOfOrderAdr072Policy() {
      return normalizeIssueExecutionPolicy({
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
      })!;
    }

    // A schema-valid execution state whose close-ladder pointer has advanced
    // (one completed stage) — the ADR-103 M4 "advanced" shape.
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

    it("posts exactly one advisory naming the missing rungs in ratified order (pointer not advanced)", async () => {
      createChildFixture();
      mockIssueService.getById.mockResolvedValue(parentIssue(reviewOnlyPolicy()));
      twoOpenLadderedChildren();

      const res = await request(await createApp(agentActor()))
        .post(`/api/issues/${PARENT_ID}/children`)
        .send({ title: "New child", status: "todo" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const advisories = adr072AdvisoryInputs();
      expect(advisories).toHaveLength(1);
      expect(advisories[0]!.issueId).toBe(PARENT_ID);
      const details = advisories[0]!.details as Record<string, unknown>;
      // Ratified order, both review rungs before the approval rung.
      expect(details.missingStageLabels).toEqual([
        "review:support-QAE",
        "review:coder-LE",
        "approval:exec-CTO",
      ]);
      expect(details.outOfOrderStageLabels).toEqual([]);
      expect(details.ladderedChildCount).toBe(2);
      expect(details.ladderedChildIdentifiers).toEqual(["PAP-2", "PAP-3"]);
      expect(details.pointerAdvanced).toBe(false);
      const comments = advisoryComments();
      expect(comments).toHaveLength(1);
      const body = String(comments[0]![1]);
      expect(body).toContain("review:support-QAE");
      expect(body).toContain("review:coder-LE");
      expect(body).toContain("approval:exec-CTO");
      expect(body).toContain("free window");
      expect(body).not.toContain("rearmExecutionPolicy");
      // The advisory is the only write to the parent: no policy/status update.
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("names the seat-restricted rearm remedy when the pointer has already advanced", async () => {
      createChildFixture();
      mockIssueService.getById.mockResolvedValue({
        ...parentIssue(reviewOnlyPolicy()),
        executionState: advancedParentState(),
      });
      twoOpenLadderedChildren();

      const res = await request(await createApp(agentActor()))
        .post(`/api/issues/${PARENT_ID}/children`)
        .send({ title: "New child", status: "todo" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const advisories = adr072AdvisoryInputs();
      expect(advisories).toHaveLength(1);
      expect(
        (advisories[0]!.details as Record<string, unknown>).pointerAdvanced,
      ).toBe(true);
      const comments = advisoryComments();
      expect(comments).toHaveLength(1);
      const body = String(comments[0]![1]);
      // An advisory that names an inaccessible remedy is the defect this card
      // removes, so the seat restriction is named alongside rearmExecutionPolicy.
      expect(body).toContain("rearmExecutionPolicy");
      expect(body).toContain("assignee agent");
      expect(body).toContain("board user");
      expect(body).not.toContain("free window");
    });

    it("is idempotent: a prior durable advisory row on the parent is a no-op", async () => {
      createChildFixture();
      mockIssueService.getById.mockResolvedValue(parentIssue(reviewOnlyPolicy()));
      twoOpenLadderedChildren();
      activityFlagState.rows = [{ id: "99999999-9999-4999-8999-999999999999" }];

      const res = await request(await createApp(agentActor()))
        .post(`/api/issues/${PARENT_ID}/children`)
        .send({ title: "New child", status: "todo" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(adr072AdvisoryInputs()).toEqual([]);
      expect(advisoryComments()).toEqual([]);
    });

    it("does not advise a parent whose ladder already satisfies ADR-072", async () => {
      createChildFixture();
      mockIssueService.getById.mockResolvedValue(parentIssue(satisfiedAdr072Policy()));
      armSatisfiedAgents();
      twoOpenLadderedChildren();

      const res = await request(await createApp(agentActor()))
        .post(`/api/issues/${PARENT_ID}/children`)
        .send({ title: "New child", status: "todo" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(adr072AdvisoryInputs()).toEqual([]);
      expect(advisoryComments()).toEqual([]);
    });

    it("advises (and names) an out-of-order ladder even when no rung is missing", async () => {
      createChildFixture();
      mockIssueService.getById.mockResolvedValue(parentIssue(outOfOrderAdr072Policy()));
      armSatisfiedAgents();
      twoOpenLadderedChildren();

      const res = await request(await createApp(agentActor()))
        .post(`/api/issues/${PARENT_ID}/children`)
        .send({ title: "New child", status: "todo" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const advisories = adr072AdvisoryInputs();
      expect(advisories).toHaveLength(1);
      const details = advisories[0]!.details as Record<string, unknown>;
      expect(details.missingStageLabels).toEqual([]);
      expect(details.outOfOrderStageLabels).toEqual(["approval:exec-CTO"]);
      const comments = advisoryComments();
      expect(comments).toHaveLength(1);
      expect(String(comments[0]![1])).toContain("Out-of-order");
    });

    it("never fails the child create when the advisory itself fails (best-effort, AC-7)", async () => {
      createChildFixture();
      // A parent WITH an approval stage so the SUP-17158 flag does not fire and
      // does not consume the injected transaction failure; its ladder is still
      // shape-incomplete (participants are not the ratified rungs), so the
      // ADR-072 advisory runs and its fenced transaction is the one that fails.
      mockIssueService.getById.mockResolvedValue(parentIssue(reviewPlusApprovalPolicy()));
      twoOpenLadderedChildren();
      mockDb.transaction.mockRejectedValueOnce(new Error("advisory tx failed"));

      const res = await request(await createApp(agentActor()))
        .post(`/api/issues/${PARENT_ID}/children`)
        .send({ title: "New child", status: "todo" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(adr072AdvisoryInputs()).toEqual([]);
      expect(advisoryComments()).toEqual([]);
    });
  });
});
