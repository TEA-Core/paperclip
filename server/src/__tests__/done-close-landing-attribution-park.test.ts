import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDoneCloseLandingBackstopService,
} from "../services/done-close-landing-backstop.js";
import type { ExternalObjectResolveResult } from "../services/external-objects.js";
// SUP-17092/B (AC#5): the exact SUP-16951 exemption predicate the
// blocked_without_blockers heal lane uses. Proving the parked card's descriptor
// satisfies it means the heal lane will NOT re-dispatch the assignee into the
// same no-op.
import { hasUsableUnblockDescriptor } from "../services/recovery/service.js";

const mockResolveLinkedPullRequestsWithState = vi.hoisted(() => vi.fn());
const mockResolveCardPullRequest = vi.hoisted(() => vi.fn());
const mockResolveGitHubTokenForRepo = vi.hoisted(() => vi.fn());
const mockEnableAutoMerge = vi.hoisted(() => vi.fn());
const mockFetchGitHubNodeId = vi.hoisted(() => vi.fn());
const mockFetchHeadViaTokenCandidates = vi.hoisted(() => vi.fn());
const mockFetchHeadApprovedStatusViaTokenCandidates = vi.hoisted(() => vi.fn());
const mockFetchLastMergeQueueEjectionViaTokenCandidates = vi.hoisted(() => vi.fn());
vi.mock("../services/merge-arming.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/merge-arming.js")>();
  return {
    ...orig,
    resolveLinkedPullRequestsWithState: mockResolveLinkedPullRequestsWithState,
    resolveCardPullRequest: mockResolveCardPullRequest,
    resolveGitHubTokenForRepo: mockResolveGitHubTokenForRepo,
    enableAutoMerge: mockEnableAutoMerge,
    fetchGitHubNodeId: mockFetchGitHubNodeId,
    fetchHeadViaTokenCandidates: mockFetchHeadViaTokenCandidates,
    fetchHeadApprovedStatusViaTokenCandidates: mockFetchHeadApprovedStatusViaTokenCandidates,
    fetchLastMergeQueueEjectionViaTokenCandidates: mockFetchLastMergeQueueEjectionViaTokenCandidates,
  };
});

const mockCreateGitHubExternalObjectProvider = vi.hoisted(() => vi.fn());
vi.mock("../services/github-external-object-provider.js", () => ({
  createGitHubExternalObjectProvider: mockCreateGitHubExternalObjectProvider,
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "activity-row" }));
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));

const mockAddComment = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "comment-row" }));
const mockUpdate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "issue-row" }));
vi.mock("../services/issues.js", () => ({
  issueService: () => ({ addComment: mockAddComment, update: mockUpdate }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Keep the pure predicate `isSharedCarrierRefusal` REAL so the tests exercise the
// exact ADR-091 D1 marker; stub only the three db-hitting helpers.
const mockResolveCarrierOwner = vi.hoisted(() => vi.fn());
const mockIssueInBlockerClosure = vi.hoisted(() => vi.fn());
const mockListNonTerminalRootCauseBlockers = vi.hoisted(() => vi.fn());
vi.mock("../services/blocker-closure.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/blocker-closure.js")>();
  return {
    ...orig,
    resolveCarrierOwner: mockResolveCarrierOwner,
    issueInBlockerClosure: mockIssueInBlockerClosure,
    listNonTerminalRootCauseBlockers: mockListNonTerminalRootCauseBlockers,
  };
});

type DbState = {
  candidates: Array<Record<string, unknown>>;
  existingLandingRows: Array<Record<string, unknown>>;
  companyMergeArmingEnabled?: boolean;
  sweptIssueId?: string;
  issueExecutionState?: Record<string, unknown> | null;
};

function makeDb(state: DbState) {
  return {
    select: vi.fn((cols: Record<string, unknown>) => {
      if ("issue" in cols) {
        return {
          from: () => ({
            innerJoin: () => ({
              where: () => Promise.resolve(state.candidates),
            }),
          }),
        };
      }
      if ("mergeArmingEnabled" in cols) {
        return {
          from: () => ({
            where: () => Promise.resolve(
              state.companyMergeArmingEnabled !== undefined
                ? [{ mergeArmingEnabled: state.companyMergeArmingEnabled }]
                : [],
            ),
          }),
        };
      }
      if ("executionState" in cols) {
        return {
          from: () => ({
            where: () => Promise.resolve([{ executionState: state.issueExecutionState ?? null }]),
          }),
        };
      }
      const landingRows =
        "entityId" in cols
          ? state.existingLandingRows
          : state.existingLandingRows.filter(
              (row) => state.sweptIssueId === undefined || row.entityId === state.sweptIssueId,
            );
      return {
        from: () => ({
          where: () => Promise.resolve(landingRows),
        }),
      };
    }),
  };
}

function mockResolver(implementation: (input: unknown) => Promise<unknown>) {
  const resolve = vi.fn(implementation);
  mockCreateGitHubExternalObjectProvider.mockReset();
  mockCreateGitHubExternalObjectProvider.mockReturnValue({
    detector: {},
    resolvers: [{ providerKey: "github", objectType: "pull_request", resolve }],
  });
  return resolve;
}

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ISSUE = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-08-19T00:00:00Z";
const fixedNow = () => new Date(NOW);
// 3 days old: past the 24h grace, inside the 7d lookback.
const IN_WINDOW = "2026-08-16T00:00:00Z";

function linkedPr(overrides: Record<string, unknown> = {}) {
  return {
    id: "eo-3158",
    owner: "paperclipai",
    repo: "paperclip",
    number: 3158,
    nodeId: null,
    headRefName: "SUP-branch",
    displayName: "paperclipai/paperclip#3158",
    cachedState: "open",
    lastErrorCode: null,
    ...overrides,
  };
}

// A plain decision-carried candidate — NOT an ADR-091 D1 shared-carrier refusal.
function candidateRow(overrides: { identifier?: string | null } = {}) {
  return {
    details: {
      identifier: "SUP-13326",
      reason: "open_linked_prs_decision_carried:1",
      skipReason: "open_linked_prs_decision_carried:1",
      prs: "paperclipai/paperclip#3158",
    },
    createdAt: new Date(IN_WINDOW),
    issue: {
      id: ISSUE,
      companyId: COMPANY,
      status: "done",
      identifier: overrides.identifier ?? "SUP-13326",
      assigneeAgentId: AGENT,
    },
  };
}

// A shared-carrier child whose close was refused by the ADR-091 D1 prefix
// predicate. The refusalReason carries the EXACT marker the monitor keys on —
// `does not carry this card's identifier prefix` — emitted ONLY by the D1
// shared-workspace narrowing.
function sharedCarrierRefusalCandidateRow(overrides: { identifier?: string | null } = {}) {
  const refusalReason =
    "status:skipped:not_delivered: PR #455 head paperclipai/paperclip:SUP-15098-branch does not carry this card's identifier prefix SUP-15098-; this card shares execution workspace branch SUP-15098-branch with another issue, so that branch is not its delivery branch (ADR-091 D1)";
  return {
    details: {
      identifier: "SUP-15098",
      refusalReason,
      headSha: null,
      decisionOutcome: "approved",
    },
    createdAt: new Date(IN_WINDOW),
    issue: {
      id: ISSUE,
      companyId: COMPANY,
      status: "done",
      identifier: overrides.identifier ?? "SUP-15098",
      assigneeAgentId: AGENT,
    },
  };
}

const mergedSnapshot = {
  ok: true,
  snapshot: {
    statusKey: "merged",
    statusCategory: "succeeded",
    statusTone: "success",
    data: { state: "closed", merged: true, merged_at: "2026-08-18T20:34:57Z" },
  },
} as unknown as ExternalObjectResolveResult;
// Still open past the grace window.
const openSnapshot = {
  ok: true,
  snapshot: {
    statusKey: "open",
    statusCategory: "open",
    statusTone: "info",
    data: { state: "open", merged: false, draft: false },
  },
} as unknown as ExternalObjectResolveResult;

function makeService(
  state: DbState,
  opts: { now?: () => Date; wakeup?: unknown; sweepIntervalMs?: number } = {},
) {
  const db = makeDb(state);
  const service = createDoneCloseLandingBackstopService(db as never, {
    now: opts.now ?? fixedNow,
    sweepIntervalMs: opts.sweepIntervalMs ?? 0,
    ...(opts.wakeup ? { wakeup: opts.wakeup as never } : {}),
  });
  return { db, state, service };
}

beforeEach(() => {
  mockLogActivity.mockReset();
  mockLogActivity.mockResolvedValue({ id: "activity-row" });
  mockAddComment.mockClear();
  mockUpdate.mockClear();
  mockResolveLinkedPullRequestsWithState.mockReset();
  mockResolveCardPullRequest.mockReset();
  mockResolveGitHubTokenForRepo.mockReset();
  mockEnableAutoMerge.mockReset();
  mockFetchGitHubNodeId.mockReset();
  mockFetchHeadViaTokenCandidates.mockReset();
  mockFetchHeadApprovedStatusViaTokenCandidates.mockReset();
  mockFetchLastMergeQueueEjectionViaTokenCandidates.mockReset();
  mockFetchLastMergeQueueEjectionViaTokenCandidates.mockResolvedValue({
    ok: true,
    headRefOid: "57726532dcd765819df8f76f102d15db68afd99a",
    headCommitAt: "2026-08-18T16:07:16Z",
    lastEjection: null,
  });
  mockCreateGitHubExternalObjectProvider.mockReset();
  mockResolveCarrierOwner.mockReset();
  mockResolveCarrierOwner.mockResolvedValue(null);
  mockIssueInBlockerClosure.mockReset();
  mockIssueInBlockerClosure.mockResolvedValue(false);
  mockListNonTerminalRootCauseBlockers.mockReset();
  mockListNonTerminalRootCauseBlockers.mockResolvedValue([]);
});

describe("SUP-17092/B: deadlocked shared-carrier attribution parks instead of resting done", () => {
  it("(a) shared-carrier refusal + deadlocked → card parked `blocked` with a first-class unblock descriptor naming the carrier + root-cause blockers", async () => {
    mockResolveCarrierOwner.mockResolvedValue({ ownerId: "cc", identifier: "SUP-15000" });
    mockIssueInBlockerClosure.mockResolvedValue(true);
    mockListNonTerminalRootCauseBlockers.mockResolvedValue([
      { id: "rrrrrrrr-0000-4000-8000-000000000000", identifier: "SUP-15001", status: "in_progress" },
      { id: "ssssssss-0000-4000-8000-000000000000", identifier: "SUP-15002", status: "todo" },
    ]);
    const wakeup = vi.fn().mockResolvedValue({ id: "wake" });
    const { service } = makeService(
      { candidates: [sharedCarrierRefusalCandidateRow()], existingLandingRows: [], companyMergeArmingEnabled: true },
      { wakeup },
    );
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([
      linkedPr({ number: 455, displayName: "paperclipai/paperclip#455", headRefName: "SUP-15098-branch" }),
    ]);
    mockResolver(async () => openSnapshot);

    const result = await service.sweep();

    // Parked, not left done: no re-enqueue, no ordinary escalation.
    expect(result.escalated).toBe(0);
    expect(result.reenqueued).toBe(0);
    expect(result.confirmed).toBe(0);
    expect(mockEnableAutoMerge).not.toHaveBeenCalled();

    // AC#1: a first-class unblock descriptor whose action names the carrier AND
    // every root-cause non-terminal blocker.
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(
      ISSUE,
      expect.objectContaining({
        status: "blocked",
        unblockDescriptor: expect.objectContaining({ owner: "board" }),
      }),
    );
    const [, parkPatch] = mockUpdate.mock.calls[0]!;
    expect(parkPatch.unblockDescriptor.action).toContain("SUP-15000");
    expect(parkPatch.unblockDescriptor.action).toContain("SUP-15001");
    expect(parkPatch.unblockDescriptor.action).toContain("SUP-15002");
    expect(parkPatch.unblockDescriptor.action).toContain("paperclipai/paperclip#455");

    // The attribution ledger row is still written (with deadlocked=true).
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.done_close_landing_attributed",
      details: expect.objectContaining({
        pr: "paperclipai/paperclip#455",
        sharedCarrier: true,
        deadlocked: true,
        rootCauseBlockers: ["SUP-15001", "SUP-15002"],
      }),
    }));

    // The [Done-close landing] comment no longer claims "left done" / "no re-open
    // or park is recorded here".
    expect(mockAddComment).toHaveBeenCalledTimes(1);
    const [, commentBody] = mockAddComment.mock.calls[0]!;
    expect(commentBody).toContain("SUP-15000");
    expect(commentBody).not.toContain("left done");
    expect(commentBody).not.toContain("No re-open or park is recorded here");

    // AC#5: the park is not re-dispatchable. The descriptor satisfies the exact
    // SUP-16951 blocked_without_blockers exemption, so the heal lane leaves the
    // card alone; and the backstop records no assignee wakeup for the parked card.
    expect(hasUsableUnblockDescriptor(parkPatch.unblockDescriptor)).toBe(true);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("(b) shared-carrier refusal + not deadlocked → still `done` + attribution row, no status change (preserved SUP-15381 path)", async () => {
    mockResolveCarrierOwner.mockResolvedValue({ ownerId: "cc", identifier: "SUP-15000" });
    mockIssueInBlockerClosure.mockResolvedValue(false);
    const { service } = makeService(
      { candidates: [sharedCarrierRefusalCandidateRow()], existingLandingRows: [], companyMergeArmingEnabled: true },
    );
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([
      linkedPr({ number: 455, displayName: "paperclipai/paperclip#455", headRefName: "SUP-15098-branch" }),
    ]);
    mockResolver(async () => openSnapshot);

    const result = await service.sweep();

    // AC#2: preserved disposition — attribution row, NO status change, NO park.
    expect(result.escalated).toBe(0);
    expect(result.reenqueued).toBe(0);
    expect(result.confirmed).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.done_close_landing_attributed",
      details: expect.objectContaining({
        carrierOwnerId: "cc",
        deadlocked: false,
        rootCauseBlockers: [],
      }),
    }));
    // Root-cause walk only runs when deadlocked.
    expect(mockListNonTerminalRootCauseBlockers).not.toHaveBeenCalled();
    // Positive assertion on the preserved path: the report still says "left done".
    expect(mockAddComment).toHaveBeenCalledTimes(1);
    const [, commentBody] = mockAddComment.mock.calls[0]!;
    expect(commentBody).toContain("left done");
    expect(commentBody).toContain("No re-open or park is recorded here");
  });

  it("(c) non-shared-carrier open PR that is CONFLICTING past grace → the existing conflict-ejection refusal + escalate-and-park path fires; the attribution branch is NOT entered", async () => {
    // No carrier owner + a plain decision-carried candidate (not an ADR-091 D1
    // marker) → isSharedCarrierRefusal is false. With merge arming OPEN and the
    // PR conflict-ejected from the merge queue on an UNCHANGED head, the code
    // must traverse the existing conflict-ejection refusal path (bounded
    // re-enqueue refused → escalate-and-park at the :888-1052 shape), unchanged
    // by the split, and never enter the shared-carrier attribution branch.
    const wakeup = vi.fn().mockResolvedValue({ id: "wake" });
    const { service } = makeService(
      {
        candidates: [candidateRow()],
        existingLandingRows: [],
        companyMergeArmingEnabled: true,
        issueExecutionState: {
          approvalStatus: { approvedHeadSha: "57726532dcd765819df8f76f102d15db68afd99a" },
        },
      },
      { wakeup },
    );
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([
      linkedPr({ number: 3145, displayName: "paperclipai/paperclip#3145" }),
    ]);
    mockResolver(async () => openSnapshot);
    // The PR is DIRTY/conflicting: the merge queue ejected it with
    // merge_conflict and the head has NOT moved since (head commit predates the
    // ejection) — the #662 shape the SUP-15953 ejection predicate refuses.
    mockFetchLastMergeQueueEjectionViaTokenCandidates.mockResolvedValue({
      ok: true,
      headRefOid: "57726532dcd765819df8f76f102d15db68afd99a",
      headCommitAt: "2026-08-18T16:07:16Z",
      lastEjection: { reason: "merge_conflict", createdAt: "2026-08-18T20:00:00Z" },
    });

    const result = await service.sweep();

    expect(result.escalated).toBe(1);
    expect(result.confirmed).toBe(0);
    expect(result.reenqueued).toBe(0);
    // The ejection gate refuses BEFORE the head-authorization gate: no queue
    // add, and no wasted head read either.
    expect(mockEnableAutoMerge).not.toHaveBeenCalled();
    expect(mockFetchHeadViaTokenCandidates).not.toHaveBeenCalled();

    // Durable ejection-refusal row keyed on the conflict.
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.done_close_landing_reenqueue_refused",
      details: expect.objectContaining({
        pr: "paperclipai/paperclip#3145",
        ejectionReason: "merge_conflict",
        refusalKind: "merge_conflict_head_unchanged",
        reason: expect.stringContaining("merge_conflict"),
      }),
    }));
    // Escalation names the conflict, parks the card, and wakes the assignee.
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.done_close_landing_escalated",
      details: expect.objectContaining({
        pr: "paperclipai/paperclip#3145",
        prState: "open",
        reason: expect.stringContaining("merge_conflict"),
      }),
    }));
    const [, commentBody] = mockAddComment.mock.calls[0]!;
    expect(commentBody).toContain("Rebase the branch onto the base branch");
    expect(mockUpdate).toHaveBeenCalledWith(ISSUE, expect.objectContaining({
      status: "blocked",
      unblockDescriptor: expect.objectContaining({
        owner: "board",
        action: expect.stringContaining("Rebase PR paperclipai/paperclip#3145"),
      }),
    }));
    expect(wakeup).toHaveBeenCalledTimes(1);

    // The shared-carrier attribution branch was never entered.
    expect(mockResolveCarrierOwner).not.toHaveBeenCalled();
    expect(mockIssueInBlockerClosure).not.toHaveBeenCalled();
    const actions = mockLogActivity.mock.calls.map((call) => (call[1] as { action?: string })?.action);
    expect(actions).not.toContain("issue.done_close_landing_attributed");
  });

  it("(d) exact-head delivery whose PR merged → confirmed; the attribution branch is never entered", async () => {
    const { service } = makeService({
      candidates: [candidateRow()],
      existingLandingRows: [],
    });
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([linkedPr()]);
    mockResolver(async () => mergedSnapshot);

    const result = await service.sweep();

    expect(result).toMatchObject({ confirmed: 1, escalated: 0, reenqueued: 0 });
    // A merged PR is dispositioned on the confirm path, before the shared-carrier
    // branch — the attribution helpers are never touched.
    expect(mockResolveCarrierOwner).not.toHaveBeenCalled();
    expect(mockIssueInBlockerClosure).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.done_close_landing_confirmed",
      details: expect.objectContaining({ pr: "paperclipai/paperclip#3158", prState: "merged" }),
    }));
  });
});
