// SUP-17514 (ADR-091 D5 cross-repo disposition) regression.
//
// A decision-carried `done` card whose linked PR's head repo is NOT the card's
// delivery repo is structurally not part of this card's landing obligation — the
// card has no deliverable in that repo and never did. Before this fix the
// done-close-landing backstop dispositioned such a PR by escalating it and
// parking the card `blocked` with an unsatisfiable board remedy, which converted
// a fully-landed card into a permanently-parked one (SUP-17092: the card's own
// delivery confirmed, then a body-cited foreign-repo PR escalated and re-opened
// it). The cross-repo reading is now REPORT-ONLY: a durable audit row naming the
// PR, head repo, delivery repo and the ADR-091 D5 reason — no status change, no
// unblockDescriptor, no assignee wake. The genuinely-unlanded SAME-repo
// `not-delivered` PR keeps the escalate+park path, and `identity-unresolved`
// keeps its re-enqueue behaviour (the guard is keyed on `not-delivered`, never
// widened to a second outcome).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDoneCloseLandingBackstopService } from "../services/done-close-landing-backstop.js";
import type { ExternalObjectResolveResult } from "../services/external-objects.js";

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

// Keep the pure delivery-repo predicate REAL so the tests exercise the exact
// ADR-091 D5 rule; stub only the three db-hitting helpers.
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
  deliveryIdentity?: {
    identifier?: string | null;
    projectId?: string | null;
    projectWorkspaceId?: string | null;
    executionWorkspaceId?: string | null;
  };
  workspaceRows?: Array<Record<string, unknown>>;
};

function makeDb(state: DbState) {
  return {
    select: vi.fn((cols?: Record<string, unknown>) => {
      // `resolveIssueRepoContext` reads the execution-workspace row with a no-arg select().
      if (cols === undefined) {
        return {
          from: () => ({
            where: () => Promise.resolve(state.workspaceRows ?? []),
          }),
        };
      }
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
      if ("branchName" in cols) {
        return {
          from: () => ({
            where: () => Promise.resolve(state.workspaceRows ?? []),
          }),
        };
      }
      if ("identifier" in cols) {
        return {
          from: () => ({
            where: () =>
              Promise.resolve([
                {
                  identifier: state.deliveryIdentity?.identifier ?? null,
                  projectId: state.deliveryIdentity?.projectId ?? null,
                  projectWorkspaceId: state.deliveryIdentity?.projectWorkspaceId ?? null,
                  executionWorkspaceId: state.deliveryIdentity?.executionWorkspaceId ?? null,
                  executionState: state.issueExecutionState ?? null,
                },
              ]),
          }),
        };
      }
      if ("executionWorkspaceId" in cols) {
        return {
          from: () => ({
            where: () =>
              Promise.resolve([
                { executionWorkspaceId: state.deliveryIdentity?.executionWorkspaceId ?? null },
              ]),
          }),
        };
      }
      if ("executionState" in cols) {
        return {
          from: () => ({
            where: () =>
              Promise.resolve([
                { executionState: state.issueExecutionState ?? null },
              ]),
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
const LIVE_SHA = "57726532dcd765819df8f76f102d15db68afd99a";

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

// A plain decision-carried `done` card (NOT an ADR-091 D1 shared-carrier refusal).
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

// The card's control-plane delivery identity: an isolated worktree whose branch
// is SUP-13326-branch and whose project repo is TEA-Core/Trading-Signal-Platform.
const delivery = {
  deliveryIdentity: { identifier: "SUP-13326", executionWorkspaceId: "ws-17514" },
  workspaceRows: [
    {
      branchName: "SUP-13326-branch",
      repoUrl: "https://github.com/TEA-Core/Trading-Signal-Platform",
      sourceIssueId: null,
      mode: "isolated_workspace",
    },
  ],
};

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
    headRefOid: LIVE_SHA,
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

describe("SUP-17514: cross-repo linked PR is report-only, never a board park", () => {
  it("AC1: a same-repo MERGED PR confirms while a cross-repo OPEN PR is report-only; the card stays done", async () => {
    const wakeup = vi.fn().mockResolvedValue({ id: "wake" });
    const { service } = makeService(
      {
        candidates: [candidateRow()],
        existingLandingRows: [],
        companyMergeArmingEnabled: true,
        issueExecutionState: { approvalStatus: { approvedHeadSha: LIVE_SHA } },
        ...delivery,
      },
      { wakeup },
    );
    // One same-repo MERGED PR (the card's delivery) and one cross-repo OPEN PR
    // (body-cited foreign deliverable). The resolver answers per PR by externalId.
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([
      linkedPr({
        owner: "TEA-Core",
        repo: "Trading-Signal-Platform",
        number: 514,
        nodeId: "PRNode_514",
        headRefName: "SUP-13326-branch",
        displayName: "TEA-Core/Trading-Signal-Platform#514",
      }),
      linkedPr({
        owner: "tea-core",
        repo: "tsp-obsidian-vault",
        number: 493,
        nodeId: "PRNode_vault493",
        headRefName: "SUP-17047-vault-note",
        displayName: "tea-core/tsp-obsidian-vault#493",
      }),
    ]);
    mockResolver(async (input: unknown) => {
      const ref = ((input as { object?: { externalId?: string } })?.object?.externalId) ?? "";
      return ref.includes("#pull/493") ? openSnapshot : mergedSnapshot;
    });
    // Arming readers/writers that WOULD run if the cross-repo PR were armed.
    mockFetchHeadViaTokenCandidates.mockResolvedValue({ ok: true, headSha: LIVE_SHA });
    mockResolveGitHubTokenForRepo.mockResolvedValue({
      token: "ghp_vault_token",
      scope: "company",
      secretName: "github-token",
    });
    mockEnableAutoMerge.mockResolvedValue({ success: true, alreadyQueued: false, error: null, status: 200 });

    const result = await service.sweep();
    // The merged PR confirms; the cross-repo PR is report-only (no disposition bucket).
    expect(result).toEqual({
      due: true,
      candidates: 1,
      confirmed: 1,
      failed: 0,
      deferred: 0,
      reenqueued: 0,
      escalated: 0,
      draftStranded: 0,
    });

    const confirmed = mockLogActivity.mock.calls.find(
      (call) => (call[1] as { action?: string })?.action === "issue.done_close_landing_confirmed",
    );
    expect(confirmed).toBeDefined();
    expect((confirmed?.[1] as { details?: { pr?: string } })?.details?.pr).toBe(
      "TEA-Core/Trading-Signal-Platform#514",
    );

    const reported = mockLogActivity.mock.calls.find(
      (call) =>
        (call[1] as { action?: string })?.action === "issue.done_close_landing_cross_repo_reported",
    );
    expect(reported).toBeDefined();
    const reportedDetails = (reported?.[1] as { details?: Record<string, unknown> })?.details ?? {};
    expect(reportedDetails.pr).toBe("tea-core/tsp-obsidian-vault#493");
    expect(reportedDetails.headRepo).toBe("tea-core/tsp-obsidian-vault");
    expect(reportedDetails.deliveryRepo).toBe("TEA-Core/Trading-Signal-Platform");
    expect(String(reportedDetails.reason)).toContain("is not this card's delivery repo");

    // The card's own delivery confirmed: no escalation, no board park, no wake.
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.done_close_landing_escalated" }),
    );
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("AC2: a card whose ONLY linked PR is a cross-repo OPEN PR reports it and parks nothing", async () => {
    const wakeup = vi.fn().mockResolvedValue({ id: "wake" });
    const { service } = makeService(
      {
        candidates: [candidateRow()],
        existingLandingRows: [],
        companyMergeArmingEnabled: true,
        issueExecutionState: { approvalStatus: { approvedHeadSha: LIVE_SHA } },
        ...delivery,
      },
      { wakeup },
    );
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([
      linkedPr({
        owner: "tea-core",
        repo: "tsp-obsidian-vault",
        number: 493,
        nodeId: "PRNode_vault493",
        headRefName: "SUP-17047-vault-note",
        displayName: "tea-core/tsp-obsidian-vault#493",
      }),
    ]);
    mockResolver(async () => openSnapshot);
    mockFetchHeadViaTokenCandidates.mockResolvedValue({ ok: true, headSha: LIVE_SHA });
    mockResolveGitHubTokenForRepo.mockResolvedValue({
      token: "ghp_vault_token",
      scope: "company",
      secretName: "github-token",
    });
    mockEnableAutoMerge.mockResolvedValue({ success: true, alreadyQueued: false, error: null, status: 200 });

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      confirmed: 0,
      failed: 0,
      deferred: 0,
      reenqueued: 0,
      escalated: 0,
      draftStranded: 0,
    });

    const reported = mockLogActivity.mock.calls.find(
      (call) =>
        (call[1] as { action?: string })?.action === "issue.done_close_landing_cross_repo_reported",
    );
    expect(reported).toBeDefined();
    expect(
      (reported?.[1] as { details?: { pr?: string } })?.details?.pr,
    ).toBe("tea-core/tsp-obsidian-vault#493");

    // No escalation, no arming, no board park, no assignee wake — the card stays done.
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.done_close_landing_escalated" }),
    );
    expect(mockResolveGitHubTokenForRepo).not.toHaveBeenCalled();
    expect(mockEnableAutoMerge).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("AC3: a same-repo OPEN PR that is NOT the delivery branch still escalates, parks and wakes (report-only keyed only on repo mismatch)", async () => {
    const wakeup = vi.fn().mockResolvedValue({ id: "wake" });
    const { service } = makeService(
      {
        candidates: [candidateRow()],
        existingLandingRows: [],
        companyMergeArmingEnabled: true,
        issueExecutionState: { approvalStatus: { approvedHeadSha: LIVE_SHA } },
        ...delivery,
      },
      { wakeup },
    );
    // Same repo as the delivery repo, but a DIFFERENT branch than the delivery
    // branch: `not-delivered` with a MATCHING head repo. This must NOT be treated
    // as cross-repo — it keeps the escalate + park + wake path.
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([
      linkedPr({
        owner: "TEA-Core",
        repo: "Trading-Signal-Platform",
        number: 599,
        nodeId: "PRNode_599",
        headRefName: "SUP-9999-other-branch",
        displayName: "TEA-Core/Trading-Signal-Platform#599",
      }),
    ]);
    mockResolver(async () => openSnapshot);
    mockFetchHeadViaTokenCandidates.mockResolvedValue({ ok: true, headSha: LIVE_SHA });
    mockResolveGitHubTokenForRepo.mockResolvedValue({
      token: "ghp_test_token",
      scope: "company",
      secretName: "github-token",
    });
    mockEnableAutoMerge.mockResolvedValue({ success: true, alreadyQueued: false, error: null, status: 200 });

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      confirmed: 0,
      failed: 0,
      deferred: 0,
      reenqueued: 0,
      escalated: 1,
      draftStranded: 0,
    });

    // Escalated, NOT reported cross-repo: the guard is keyed on the repo mismatch.
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.done_close_landing_escalated",
        details: expect.objectContaining({ pr: "TEA-Core/Trading-Signal-Platform#599" }),
      }),
    );
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.done_close_landing_cross_repo_reported" }),
    );

    // The existing board park + assignee wake are preserved for the same-repo case.
    expect(mockUpdate).toHaveBeenCalledWith(
      ISSUE,
      expect.objectContaining({
        status: "blocked",
        unblockDescriptor: expect.objectContaining({ owner: "board" }),
      }),
    );
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("AC4: a card with no resolvable delivery identity still re-enqueues (identity-unresolved, never cross-repo)", async () => {
    const { service } = makeService({
      candidates: [candidateRow()],
      existingLandingRows: [],
      companyMergeArmingEnabled: true,
      issueExecutionState: { approvalStatus: { approvedHeadSha: LIVE_SHA } },
      // No deliveryIdentity / workspaceRows -> `narrowToDelivered` returns
      // `identity-unresolved`; the guard keys only on `not-delivered`, so the
      // cross-repo disposition is inert and the re-enqueue path runs.
    });
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([
      linkedPr({ number: 514, nodeId: "PRNode_abc123", displayName: "paperclipai/paperclip#514" }),
    ]);
    mockResolver(async () => openSnapshot);
    mockFetchHeadViaTokenCandidates.mockResolvedValue({ ok: true, headSha: LIVE_SHA });
    mockResolveGitHubTokenForRepo.mockResolvedValue({
      token: "ghp_test_token",
      scope: "company",
      secretName: "github-token",
    });
    mockEnableAutoMerge.mockResolvedValue({ success: true, alreadyQueued: false, error: null, status: 200 });

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      confirmed: 0,
      failed: 0,
      deferred: 0,
      reenqueued: 1,
      escalated: 0,
      draftStranded: 0,
    });

    expect(mockEnableAutoMerge).toHaveBeenCalledTimes(1);
    expect(mockEnableAutoMerge).toHaveBeenCalledWith("ghp_test_token", "PRNode_abc123");
    // No cross-repo report, no escalation, no board park.
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.done_close_landing_cross_repo_reported" }),
    );
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.done_close_landing_escalated" }),
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
