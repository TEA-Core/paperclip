import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  agents as agentsTable,
  issueExecutionDecisions as issueExecutionDecisionsTable,
  issueRelations as issueRelationsTable,
  issues as issuesTable,
} from "@paperclipai/db";
import {
  evaluateDoneTransitionGuard,
  evaluateDoneTierDeclaration,
  GitHubAuthError,
  type DoneTransitionOverride,
} from "./done-transition-guard.js";
import { logActivity } from "./activity-log.js";
import { mechanismACorpus } from "./done-transition-guard-mechanism-a-fixtures.js";

const mockDb = {
  select: vi.fn(),
} as unknown as Parameters<typeof evaluateDoneTransitionGuard>[0];

const issue = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "SUP-12345",
  projectId: "project-1",
  projectWorkspaceId: "pw-1",
  executionWorkspaceId: "ew-1",
};

function mockExecutionWorkspaceRow(row: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ew-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "pw-1",
    sourceIssueId: "issue-1",
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "test",
    status: "open",
    cwd: "/tmp/test",
    repoUrl: "https://github.com/TEA-Core/paperclip",
    baseRef: "fold/tea-patches-v2026.722.0",
    branchName: "SUP-12686-test-branch",
    providerType: "git_worktree",
    providerRef: "/tmp/test",
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date(),
    openedAt: new Date(),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...row,
  };
}

function mockProjectWorkspaceRow(row: Partial<Record<string, unknown>> = {}) {
  return {
    id: "pw-1",
    companyId: "company-1",
    projectId: "project-1",
    name: "paperclip",
    cwd: "/tmp/paperclip",
    repoUrl: "https://github.com/TEA-Core/paperclip",
    repoRef: "fold/tea-patches-v2026.722.0",
    defaultRef: "fold/tea-patches-v2026.722.0",
    isPrimary: true,
    cleanupCommand: null,
    ...row,
  };
}

function mockProjectRow(row: Partial<Record<string, unknown>> = {}) {
  return {
    id: "project-1",
    companyId: "company-1",
    name: "Paperclip",
    repoUrl: "https://github.com/TEA-Core/paperclip",
    repoRef: "fold/tea-patches-v2026.722.0",
    defaultRef: "fold/tea-patches-v2026.722.0",
    ...row,
  };
}

/**
 * Build the shared `db` mock. Selects are dispatched by table identity when the
 * matching `rows.<table>` is seeded; otherwise every
 * `select().from().where()` resolves to the `executionWorkspaces` rows exactly
 * as the legacy positional chain did, so pre-existing tests are untouched.
 */
function setupDbMock(rows: { executionWorkspaces?: Record<string, unknown>[]; projectWorkspaces?: Record<string, unknown>[]; projects?: Record<string, unknown>[]; issues?: Record<string, unknown>[]; blockedByIssues?: Record<string, unknown>[]; issueRelations?: Record<string, unknown>[]; agents?: Record<string, unknown>[]; issueExecutionDecisions?: Record<string, unknown>[] }) {
  // SUP-15233: the guard reads the issues table twice inside
  // countLadderedChildren: read 1 is the parent_id edge (decomposition
  // children), read 2 is the inArray re-read (blockedBy edge, only present in
  // the buggy 3ed1372d shape). The two-chain dispatch returns rows.issues for
  // read 1 and rows.blockedByIssues for read 2, so the buggy guard's inArray
  // re-read gets the seeded parentless laddered rows and count ≥ 2 → the
  // mechanism fires → the suite discriminates.
  const issuesChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows.issues ?? []),
    then: vi.fn().mockResolvedValue(rows.issues ?? []),
  };
  const blockedByIssuesChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows.blockedByIssues ?? []),
    then: vi.fn().mockResolvedValue(rows.blockedByIssues ?? []),
  };
  const relationsChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows.issueRelations ?? []),
    then: vi.fn().mockResolvedValue(rows.issueRelations ?? []),
  };
  // SUP-14579: the guard now also reads the agents table (close-ladder shape
  // check resolves participant agent ids to urlKeys). Dispatched by table
  // identity when `rows.agents` is seeded.
  const agentsChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows.agents ?? []),
    then: vi.fn().mockResolvedValue(rows.agents ?? []),
  };
  // SUP-14912: the guard reads issue_execution_decisions (approved-decision
  // recovery for a nulled projection). Dispatch by table identity. The guard
  // fetches every decision row for the issue and resolves the LATEST decision
  // per stage in JS (a later changes_requested supersedes an earlier approved),
  // so the mock returns the seeded rows unfiltered and in seed order.
  const decisionsChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows.issueExecutionDecisions ?? []),
    then: vi.fn().mockResolvedValue(rows.issueExecutionDecisions ?? []),
  };
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows.executionWorkspaces ?? []),
    then: vi.fn().mockResolvedValue(rows.executionWorkspaces ?? []),
  };
  const selectChain2 = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue(rows.projectWorkspaces ?? []),
  };
  const selectChain3 = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue(rows.projects ?? []),
  };
  const selectChain4 = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue(rows.projectWorkspaces ?? []),
  };
  let issuesCallCount = 0;
  (mockDb.select as any).mockImplementation((_cols?: any) => {
    let callCount = 0;
    const chains = [selectChain, selectChain2, selectChain3, selectChain4];
    return {
      from: function (table: unknown) {
        if (table === issueRelationsTable) return relationsChain;
        if (table === issuesTable && (rows.issues !== undefined || rows.blockedByIssues !== undefined)) {
          issuesCallCount++;
          return issuesCallCount === 1 ? issuesChain : blockedByIssuesChain;
        }
        if (table === agentsTable && rows.agents !== undefined) return agentsChain;
        if (table === issueExecutionDecisionsTable) return decisionsChain;
        const chain = chains[callCount] ?? selectChain;
        callCount++;
        return chain;
      },
      where: function() {
        const chain = chains[callCount] ?? selectChain;
        callCount++;
        return chain;
      },
      then: function() {
        const chain = chains[callCount] ?? selectChain;
        callCount++;
        return chain;
      },
    };
  });
}

vi.mock("./github-fetch.js", () => ({
  ghFetch: vi.fn(),
  gitHubApiBase: (hostname: string) =>
    hostname === "github.com" || hostname === "www.github.com"
      ? "https://api.github.com"
      : `https://${hostname}/api/v3`,
}));

vi.mock("./secrets.js", () => ({
  secretService: () => ({
    getByName: vi.fn().mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" }),
    resolveSecretValue: vi.fn().mockResolvedValue("test-token"),
  }),
}));

const mockResolveGitHubToken = vi.hoisted(() => vi.fn());
vi.mock("./github-credential.js", () => ({
  resolveGitHubToken: mockResolveGitHubToken,
}));

vi.mock("./activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockResolveLinkedPullRequestsWithState = vi.hoisted(() => vi.fn());
const mockFetchOpenPullRequests = vi.hoisted(() => vi.fn());
vi.mock("./merge-arming.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./merge-arming.js")>();
  return {
    ...actual,
    resolveLinkedPullRequestsWithState: mockResolveLinkedPullRequestsWithState,
    fetchOpenPullRequests: mockFetchOpenPullRequests,
  };
});

const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

import { ghFetch } from "./github-fetch.js";
import { resolveGitHubToken } from "./github-credential.js";

const ghFetchMock = vi.mocked(ghFetch);

function mockGitProbe(aheadCount: string, attributableCount: string, statusOutput = " M server/src/x.ts") {
  mockExecFile.mockImplementation(
    (_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      if (args.includes("status")) {
        cb(null, statusOutput);
        return;
      }
      cb(null, args.includes("--grep") ? attributableCount : aheadCount);
    },
  );
}

function mockGitProbeUnavailable() {
  mockExecFile.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
      cb(new Error("git not available"));
    },
  );
}

describe("evaluateDoneTransitionGuard", () => {
  beforeEach(() => {
    ghFetchMock.mockReset();
    mockResolveLinkedPullRequestsWithState.mockReset();
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([]);
    mockFetchOpenPullRequests.mockReset();
    mockFetchOpenPullRequests.mockResolvedValue({ ok: true, status: 200, message: null, items: [] });
    mockResolveGitHubToken.mockReset();
    mockResolveGitHubToken.mockResolvedValue({ token: "test-token", scope: "company", secretName: "GITHUB_TOKEN" });
    vi.mocked(logActivity).mockClear();
    mockExecFile.mockReset();
    mockGitProbe("0", "0");
    setupDbMock({});
  });

  describe("override path", () => {
    it("allows transition with upstream-equivalent-fix-no-deliverable-head override and writes audit log", async () => {
      const override: DoneTransitionOverride = {
        disposition: "upstream-equivalent-fix-no-deliverable-head",
        reason: "Fix was applied upstream",
      };
      const result = await evaluateDoneTransitionGuard(mockDb, issue, override);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("upstream-equivalent-fix-no-deliverable-head");
    });

    it("allows transition with child-delivery-parent-close override", async () => {
      const override: DoneTransitionOverride = { disposition: "child-delivery-parent-close" };
      const result = await evaluateDoneTransitionGuard(mockDb, issue, override);
      expect(result.allowed).toBe(true);
    });

    it("allows transition with merged-elsewhere override", async () => {
      const override: DoneTransitionOverride = { disposition: "merged-elsewhere" };
      const result = await evaluateDoneTransitionGuard(mockDb, issue, override);
      expect(result.allowed).toBe(true);
    });

    it("does not treat unknown disposition as override", async () => {
      const override: DoneTransitionOverride = { disposition: "some-unknown-disposition" };
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: "SUP-12345-test-branch" })],
      });
      ghFetchMock.mockResolvedValue(new Response(JSON.stringify({ ahead_by: 1 }), { status: 200 }));
      const result = await evaluateDoneTransitionGuard(mockDb, issue, override);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("deliver.sh");
    });
  });

  describe("refusal text does not advertise the unreachable override (SUP-14914)", () => {
    // SUP-14878 moved the no-deliverable-head override to consume AFTER the
    // mechanism C / A / D refusals, so a disposition can no longer reach — and
    // waive — any of those three gates. Their refusal reasons must stop
    // advertising the override (unreachable by construction) and instead name
    // the action that actually clears each gate. Each test below fails against
    // the pre-SUP-14914 text, which ended with the dead override clause.

    it("mechanism C: the ladder refusal stops advertising doneTransitionOverride and names the real remedy", async () => {
      const stageId = "c-stage-00000000000000000001";
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        {
          ...issue,
          executionPolicy: { stages: [{ id: stageId, type: "review" }] },
          executionState: {},
        },
        null,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Review ladder unsatisfied");
      expect(result.reason).not.toContain("doneTransitionOverride");
      // SUP-14912 (#505) landed first and rewrote this same message. Its wording
      // supersedes the one SUP-14914 proposed and already satisfies this card's
      // requirement: it drops the override advertisement and, going further,
      // states outright that an override does not clear a ladder refusal.
      expect(result.reason).toContain("Record the stage's approval (or skip it) before marking the issue done.");
      expect(result.reason).toContain(
        "A no-deliverable-head override does not clear a review-ladder refusal.",
      );
    });

    it("mechanism A: the ungated-decomposed-parent refusal stops advertising doneTransitionOverride and names the real remedy", async () => {
      const f = mechanismACorpus.find((x) => x.identifier === "SUP-14306");
      expect(f).toBeDefined();
      setupDbMock({ issues: f!.children });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, identifier: f!.identifier, executionPolicy: f!.executionPolicy, executionState: f!.executionState },
        null,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Mechanism A");
      expect(result.reason).not.toContain("doneTransitionOverride");
      expect(result.reason).toContain("Attach an execution policy with a review ladder to this issue.");
    });

    it("mechanism D: the close-ladder-shape refusal stops advertising doneTransitionOverride and names the real remedy", async () => {
      // Stage ids must be UUIDs: `parseIssueExecutionState` validates the
      // state schema, so a malformed id silently drops the whole state and the
      // ladder would read as unsatisfied (mechanism C) instead of shape-incomplete.
      const supportQaeId = "aaaaaaa1-0000-4000-8000-000000000001";
      const parentStageId = "30000000-0000-4000-8000-000000000003";
      const child1StageId = "40000000-0000-4000-8000-000000000001";
      const child2StageId = "50000000-0000-4000-8000-000000000002";
      const ladderedState = (stageId: string) => ({
        status: "completed",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        completedStageIds: [stageId],
        skippedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      });
      setupDbMock({
        issues: [
          { identifier: "SUP-9001", executionPolicy: { stages: [{ id: child1StageId, type: "review" }] }, executionState: ladderedState(child1StageId) },
          { identifier: "SUP-9002", executionPolicy: { stages: [{ id: child2StageId, type: "review" }] }, executionState: ladderedState(child2StageId) },
        ],
        agents: [{ id: supportQaeId, name: "support-QAE", role: "support" }],
      });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        {
          ...issue,
          parentId: null,
          executionPolicy: {
            stages: [
              { id: parentStageId, type: "review", participants: [{ type: "agent", agentId: supportQaeId }] },
            ],
          },
          executionState: ladderedState(parentStageId),
        },
        null,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Mechanism D");
      expect(result.reason).toContain("review:coder-LE");
      expect(result.reason).toContain("approval:exec-CTO");
      expect(result.reason).not.toContain("doneTransitionOverride");
      expect(result.reason).toContain("Add the missing review/approval stages to this issue's execution policy.");
    });
  });

  describe("review ladder refusal (SUP-14446 mechanism C)", () => {
    const stageA = "11111111-1111-4111-8111-111111111111";
    const stageB = "22222222-2222-4222-8222-222222222222";
    const stageC = "33333333-3333-4333-8333-333333333333";
    const agentId = "44444444-4444-4444-8444-444444444444";
    const ladderPolicy = {
      stages: [
        { id: stageA, type: "review" },
        { id: stageB, type: "review" },
        { id: stageC, type: "approval" },
      ],
    };

    // Schema-valid state (uuid stage ids / principal) for the satisfied-paths tests.
    const validExecutionState = (overrides: Record<string, unknown> = {}) => ({
      status: "pending",
      currentStageId: stageC,
      currentStageIndex: 2,
      currentStageType: "approval",
      currentParticipant: { type: "agent", agentId },
      returnAssignee: null,
      reviewRequest: null,
      completedStageIds: [stageA, stageB],
      skippedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      ...overrides,
    });

    it("refuses done for the literal SUP-13253 shape: 3-stage ladder with executionState {} (AC1)", async () => {
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, executionPolicy: ladderPolicy, executionState: {} },
        null,
      );
      expect(result.allowed).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.reason).toContain("stage 1 of 3");
      expect(result.reason).toContain(stageA);
      expect(result.reason).toContain("neither completedStageIds nor skippedStageIds");
      // Fail closed BEFORE any external probe: no GitHub call, no PR resolution.
      expect(ghFetchMock).not.toHaveBeenCalled();
      expect(mockResolveLinkedPullRequestsWithState).not.toHaveBeenCalled();
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_ladder_refused",
          details: expect.objectContaining({
            reason: `review_ladder_unsatisfied:${stageA}`,
            stageIndex: 0,
            stageType: "review",
            unsatisfiedStageIds: [stageA, stageB, stageC],
            completedStageIds: [],
            skippedStageIds: [],
          }),
        }),
      );
    });

    it("refuses done for the literal SUP-8098 shape: parked pending on stage 1 with zero decisions (AC2)", async () => {
      // The state as it landed on SUP-8098: pending at stage index 0, no
      // completedStageIds. It does not round-trip the state schema (the
      // persisted row predates returnAssignee), so it parses to the empty case —
      // which is exactly why the ladder had to be checked on the close path.
      const sup8098State = {
        status: "pending",
        currentStageIndex: 0,
        currentStageType: "review",
        currentStageId: "62250a6c-b08f-47da-8222-bafbb9f4f5c8",
        currentParticipant: { type: "agent", agentId: "<support-QAE>" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      };
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        {
          ...issue,
          executionPolicy: {
            stages: [
              { id: "62250a6c-b08f-47da-8222-bafbb9f4f5c8", type: "review" },
              { id: stageC, type: "approval" },
            ],
          },
          executionState: sup8098State,
        },
        null,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("stage 1 of 2");
      expect(result.reason).toContain("62250a6c-b08f-47da-8222-bafbb9f4f5c8");
    });

    it("allows done when every stage id is in completedStageIds or skippedStageIds (AC3)", async () => {
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        {
          ...issue,
          executionPolicy: ladderPolicy,
          executionState: validExecutionState({
            status: "completed",
            completedStageIds: [stageA, stageC],
            skippedStageIds: [stageB],
          }),
        },
        null,
      );
      expect(result.allowed).toBe(true);
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_ladder_refused" }),
      );
    });

    it("allows done when every stage id is in completedStageIds (no skipped stages)", async () => {
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        {
          ...issue,
          executionPolicy: ladderPolicy,
          executionState: validExecutionState({
            status: "completed",
            completedStageIds: [stageA, stageB, stageC],
          }),
        },
        null,
      );
      expect(result.allowed).toBe(true);
    });

    it("does not change behaviour for an issue with no executionPolicy (AC4)", async () => {
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, executionPolicy: null, executionState: null },
        null,
      );
      expect(result.allowed).toBe(true);
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_ladder_refused" }),
      );
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_ladder_override" }),
      );
    });

    it("refuses the override against an unsatisfied review ladder: the disposition cannot waive mechanism C (AC5 / SUP-14878)", async () => {
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, executionPolicy: ladderPolicy, executionState: {} },
        { disposition: "merged-elsewhere", reason: "PR merged on main by ops" },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Review ladder unsatisfied");
      expect(result.reason).toContain("stage 1 of 3");
      // Fail closed BEFORE any external probe: no GitHub call, no PR resolution.
      expect(ghFetchMock).not.toHaveBeenCalled();
      expect(mockResolveLinkedPullRequestsWithState).not.toHaveBeenCalled();
      // The refusal is mechanism C's — not an override.
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_ladder_refused",
          details: expect.objectContaining({
            reason: `review_ladder_unsatisfied:${stageA}`,
            unsatisfiedStageIds: [stageA, stageB, stageC],
          }),
        }),
      );
      // The head-check waiver receipt must NOT be written — the disposition
      // never reached the head zone (SUP-13724 §1).
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_override" }),
      );
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_ladder_override" }),
      );
    });

    it("does not deadlock the in-flight final-stage approval: decisionCarried=true satisfies the pending current stage", async () => {
      // The review approval IS what records the last stage's decision; the guard
      // runs before that write lands, so state.currentStageId (stageC) must be
      // treated as satisfied or the approval circuit deadlocks.
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        {
          ...issue,
          executionPolicy: ladderPolicy,
          executionState: validExecutionState({
            status: "pending",
            currentStageId: stageC,
            currentStageIndex: 2,
            completedStageIds: [stageA, stageB],
          }),
        },
        null,
        true,
      );
      expect(result.allowed).toBe(true);
    });

    it("refuses a plain close while the final stage is still pending (same state, no decision carried)", async () => {
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        {
          ...issue,
          executionPolicy: ladderPolicy,
          executionState: validExecutionState({
            status: "pending",
            currentStageId: stageC,
            currentStageIndex: 2,
            completedStageIds: [stageA, stageB],
          }),
        },
        null,
        false,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("stage 3 of 3");
      expect(result.reason).toContain(stageC);
    });

    it("names the first unsatisfied stage when an earlier stage is missing its decision", async () => {
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        {
          ...issue,
          executionPolicy: ladderPolicy,
          executionState: validExecutionState({
            currentStageId: stageC,
            currentStageIndex: 2,
            completedStageIds: [stageA],
          }),
        },
        null,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("stage 2 of 3");
      expect(result.reason).toContain(stageB);
    });

    it("refuses the ladder before the open-linked-PR block, so the ladder reason wins", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 279, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#279", cachedState: "open", lastErrorCode: null },
      ]);
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, executionPolicy: ladderPolicy, executionState: {} },
        null,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Review ladder unsatisfied");
      expect(result.reason).not.toContain("open linked PR");
    });
  });

  describe("review ladder recovered from issue_execution_decisions (SUP-14912)", () => {
    const stageA = "aaaaaaaa-0000-4000-8000-0000000000aa";
    const stageB = "bbbbbbbb-0000-4000-8000-0000000000bb";

    const decisionRow = (stageId: string, outcome: string, createdAt?: Date, suffix = "") => ({
      id: suffix ? `dec-${stageId}-${suffix}` : `dec-${stageId}`,
      companyId: "company-1",
      issueId: "issue-1",
      stageId,
      stageType: "review",
      outcome,
      body: null,
      createdByRunId: null,
      createdAt: createdAt ?? new Date(),
      updatedAt: createdAt ?? new Date(),
    });

    it("satisfies a nulled-projection stage backed by an approved decision (AC2 / main regression)", async () => {
      setupDbMock({ issueExecutionDecisions: [decisionRow(stageA, "approved")] });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        {
          ...issue,
          executionPolicy: { stages: [{ id: stageA, type: "review" }] },
          executionState: null,
        },
        null,
      );
      expect(result.allowed).toBe(true);
      expect(result.ladderUnsatisfied).toBeUndefined();
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_ladder_recovered_from_decisions",
          details: expect.objectContaining({
            reason: "review_ladder_recovered_from_decisions",
          }),
        }),
      );
    });

    it("does NOT satisfy a stage whose only recorded decision is changes_requested (AC3 — no bypass)", async () => {
      // The stage's latest (and only) decision is changes_requested, so it is
      // not in the recovered set: the stage stays unsatisfied and the close
      // fails closed.
      setupDbMock({ issueExecutionDecisions: [decisionRow(stageA, "changes_requested")] });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        {
          ...issue,
          executionPolicy: { stages: [{ id: stageA, type: "review" }] },
          executionState: null,
        },
        null,
      );
      expect(result.allowed).toBe(false);
      expect(result.ladderUnsatisfied).toBe(true);
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_ladder_recovered_from_decisions",
        }),
      );
    });

    it("does NOT satisfy a stage whose LATEST decision is changes_requested, even though an earlier approved row survives (finding ladder-recovery-matches-any-approved-row-not-latest-decision)", async () => {
      // Repro of the finding: approve stage A (card closes), reopen, re-pend,
      // reviewer requests changes. The earlier approved row still exists, but
      // the LATER changes_requested row supersedes it. Recovering from "any
      // approved row" would resurrect the stage and let the card close despite
      // the open changes_requested — a bypass. Keying on the latest decision
      // keeps the stage unsatisfied.
      const approvedAt = new Date("2026-09-03T19:00:40.775Z");
      const changesRequestedAt = new Date("2026-09-03T19:56:23.986Z");
      setupDbMock({
        issueExecutionDecisions: [
          decisionRow(stageA, "approved", approvedAt, "approved"),
          decisionRow(stageA, "changes_requested", changesRequestedAt, "changes_requested"),
        ],
      });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        {
          ...issue,
          executionPolicy: { stages: [{ id: stageA, type: "review" }] },
          executionState: null,
        },
        null,
      );
      expect(result.allowed).toBe(false);
      expect(result.ladderUnsatisfied).toBe(true);
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_ladder_recovered_from_decisions",
        }),
      );
    });

    it("satisfies a stage when the LATEST decision is approved after an earlier changes_requested", async () => {
      // Inverse of the above: the reviewer first requested changes, then the
      // implementer re-delivered and the stage was re-approved. The latest
      // decision is approved, so the stage recovers even from a nulled
      // projection.
      const changesRequestedAt = new Date("2026-09-03T19:00:40.775Z");
      const approvedAt = new Date("2026-09-03T19:56:23.986Z");
      setupDbMock({
        issueExecutionDecisions: [
          decisionRow(stageA, "changes_requested", changesRequestedAt, "changes_requested"),
          decisionRow(stageA, "approved", approvedAt, "approved"),
        ],
      });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        {
          ...issue,
          executionPolicy: { stages: [{ id: stageA, type: "review" }] },
          executionState: null,
        },
        null,
      );
      expect(result.allowed).toBe(true);
      expect(result.ladderUnsatisfied).toBeUndefined();
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_ladder_recovered_from_decisions",
        }),
      );
    });

    it("still fails closed when the nulled-projection stage has no decision row at all (AC3)", async () => {
      setupDbMock({ issueExecutionDecisions: [] });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        {
          ...issue,
          executionPolicy: { stages: [{ id: stageA, type: "review" }] },
          executionState: null,
        },
        null,
      );
      expect(result.allowed).toBe(false);
      expect(result.ladderUnsatisfied).toBe(true);
    });

    it("recovers only the decided stage, leaving an undecided later stage unsatisfied (AC1 — no blanket satisfy)", async () => {
      // Two-stage ladder, projection nulled; only stage A has an approved
      // decision. Stage B has no decision, so the ladder is still unsatisfied.
      setupDbMock({ issueExecutionDecisions: [decisionRow(stageA, "approved")] });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        {
          ...issue,
          executionPolicy: {
            stages: [
              { id: stageA, type: "review" },
              { id: stageB, type: "review" },
            ],
          },
          executionState: null,
        },
        null,
      );
      expect(result.allowed).toBe(false);
      expect(result.ladderUnsatisfied).toBe(true);
      expect(result.reason).toContain("stage 2 of 2");
      expect(result.reason).toContain(stageB);
    });

    it("no longer advertises doneTransitionOverride for a ladder refusal (AC4)", async () => {
      setupDbMock({ issueExecutionDecisions: [] });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        {
          ...issue,
          executionPolicy: { stages: [{ id: stageA, type: "review" }] },
          executionState: null,
        },
        null,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Review ladder unsatisfied");
      expect(result.reason).toContain("neither completedStageIds nor skippedStageIds");
      expect(result.reason).not.toContain("doneTransitionOverride");
      expect(result.ladderUnsatisfied).toBe(true);
    });
  });

  describe("ADR-072 close-ladder shape (SUP-14579 mechanism D)", () => {
    const supportQaeId = "aaaaaaa1-0000-4000-8000-000000000001";
    const coderLeId = "bbbbbbb2-0000-4000-8000-000000000002";
    const execCtoId = "ccccccc3-0000-4000-8000-000000000003";
    const stage1 = "10000000-0000-4000-8000-000000000001";
    const stage2 = "20000000-0000-4000-8000-000000000002";
    const stage3 = "30000000-0000-4000-8000-000000000003";

    const agents = [
      { id: supportQaeId, name: "support-QAE", role: "support" },
      { id: coderLeId, name: "coder-LE", role: "engineer" },
      { id: execCtoId, name: "exec-CTO", role: "executive" },
    ];

    // The literal SUP-14306 shape: a single review stage (support-QAE only).
    const singleStageLadder = {
      stages: [
        { id: stage1, type: "review", participants: [{ type: "agent", agentId: supportQaeId }] },
      ],
    };

    // The full ADR-072 close-ladder shape.
    const fullLadder = {
      stages: [
        { id: stage1, type: "review", participants: [{ type: "agent", agentId: supportQaeId }] },
        { id: stage2, type: "review", participants: [{ type: "agent", agentId: coderLeId }] },
        { id: stage3, type: "approval", participants: [{ type: "agent", agentId: execCtoId }] },
      ],
    };

    /** A completed execution state over the given stage ids (ladder satisfied). */
    const satisfiedState = (stageIds: string[]) => ({
      status: "completed",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: null,
      completedStageIds: stageIds,
      skippedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    });

    /** One laddered child: a satisfied single-stage ladder under `identifier`. */
    const ladderedChild = (identifier: string, childStageId: string) => ({
      identifier,
      executionPolicy: { stages: [{ id: childStageId, type: "review" }] },
      executionState: satisfiedState([childStageId]),
    });

    const twoLadderedChildren = [
      ladderedChild("SUP-9001", "40000000-0000-4000-8000-000000000001"),
      ladderedChild("SUP-9002", "50000000-0000-4000-8000-000000000002"),
    ];

    it("refuses done for the literal SUP-14306 shape: 1-stage ladder over 2+ laddered children (AC1)", async () => {
      setupDbMock({ issues: twoLadderedChildren, agents });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, parentId: null, executionPolicy: singleStageLadder, executionState: satisfiedState([stage1]) },
        null,
      );
      expect(result.allowed).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.reason).toContain("Mechanism D");
      expect(result.reason).toContain("ADR-072 close-ladder shape");
      // Fail closed before any external probe: no GitHub call, no PR resolution.
      expect(ghFetchMock).not.toHaveBeenCalled();
      expect(mockResolveLinkedPullRequestsWithState).not.toHaveBeenCalled();
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_ladder_shape_refused",
          details: expect.objectContaining({
            reason: "adr072_close_ladder_shape_incomplete",
            missingStageLabels: ["review:coder-LE", "approval:exec-CTO"],
            ladderedChildCount: 2,
            ladderedChildIdentifiers: ["SUP-9001", "SUP-9002"],
          }),
        }),
      );
    });

    it("names the specific missing stages in the refusal reason (AC2)", async () => {
      setupDbMock({ issues: twoLadderedChildren, agents });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, parentId: null, executionPolicy: singleStageLadder, executionState: satisfiedState([stage1]) },
        null,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("review:coder-LE");
      expect(result.reason).toContain("approval:exec-CTO");
      // The stage that IS present is not named as missing.
      expect(result.reason).not.toContain("review:support-QAE");
    });

    it("allows done when the full 3-stage close ladder is present over 2+ laddered children (AC3)", async () => {
      setupDbMock({ issues: twoLadderedChildren, agents });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, parentId: null, executionPolicy: fullLadder, executionState: satisfiedState([stage1, stage2, stage3]) },
        null,
      );
      expect(result.allowed).toBe(true);
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_ladder_shape_refused" }),
      );
    });

    it("refuses done for a nested (non-top-level) decomposed parent over 2+ laddered children (SUP-14640)", async () => {
      // The shape check no longer stops at the tree root: a parent that has its
      // own parent (parentId !== null) yet closes 2+ laddered children over an
      // incomplete close ladder is refused exactly as a top-level one is. Under
      // the pre-SUP-14640 `parentId === null` depth gate this card was exempt,
      // so this test fails against current main.
      setupDbMock({ issues: twoLadderedChildren, agents });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, parentId: "99999999-9999-4999-8999-999999999999", executionPolicy: singleStageLadder, executionState: satisfiedState([stage1]) },
        null,
      );
      expect(result.allowed).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.reason).toContain("Mechanism D");
      expect(result.reason).toContain("ADR-072 close-ladder shape");
      expect(result.reason).toContain("review:coder-LE");
      expect(result.reason).toContain("approval:exec-CTO");
      expect(result.reason).not.toContain("review:support-QAE");
      // Fail closed before any external probe: no GitHub call, no PR resolution.
      expect(ghFetchMock).not.toHaveBeenCalled();
      expect(mockResolveLinkedPullRequestsWithState).not.toHaveBeenCalled();
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_ladder_shape_refused",
          details: expect.objectContaining({
            reason: "adr072_close_ladder_shape_incomplete",
            missingStageLabels: ["review:coder-LE", "approval:exec-CTO"],
            ladderedChildCount: 2,
            ladderedChildIdentifiers: ["SUP-9001", "SUP-9002"],
          }),
        }),
      );
    });

    it("allows done when a nested decomposed parent carries the full 3-stage close ladder (SUP-14640)", async () => {
      // Removing the depth gate must not over-refuse: a nested parent whose
      // ladder carries the full ADR-072 close-ladder shape still closes.
      setupDbMock({ issues: twoLadderedChildren, agents });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, parentId: "99999999-9999-4999-8999-999999999999", executionPolicy: fullLadder, executionState: satisfiedState([stage1, stage2, stage3]) },
        null,
      );
      expect(result.allowed).toBe(true);
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_ladder_shape_refused" }),
      );
    });

    it("exempts a parent with fewer than two laddered children from the shape check (AC4b)", async () => {
      setupDbMock({ issues: [twoLadderedChildren[0]] });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, parentId: null, executionPolicy: singleStageLadder, executionState: satisfiedState([stage1]) },
        null,
      );
      expect(result.allowed).toBe(true);
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_ladder_shape_refused" }),
      );
    });

    it("does not fire the shape check for a ladder-less parent (AC4c)", async () => {
      setupDbMock({ issues: twoLadderedChildren });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, parentId: null, executionPolicy: null, executionState: null },
        null,
      );
      expect(result.allowed).toBe(false);
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_ladder_shape_refused" }),
      );
    });

    it("keeps mechanism A refusing a null-policy parent over 2+ laddered children (AC5 regression)", async () => {
      setupDbMock({ issues: twoLadderedChildren });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, parentId: null, executionPolicy: null, executionState: null },
        null,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Mechanism A");
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_null_policy_refused",
          details: expect.objectContaining({ ladderedChildCount: 2 }),
        }),
      );
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_ladder_shape_refused" }),
      );
    });

    it("refuses the override against a shape-incomplete close ladder: the disposition cannot waive mechanism D (AC6 / SUP-14878)", async () => {
      setupDbMock({ issues: twoLadderedChildren, agents });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, parentId: null, executionPolicy: singleStageLadder, executionState: satisfiedState([stage1]) },
        { disposition: "merged-elsewhere", reason: "closed out by ops" },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Mechanism D");
      expect(result.reason).toContain("review:coder-LE");
      expect(result.reason).toContain("approval:exec-CTO");
      // Fail closed before any external probe: no GitHub call, no PR resolution.
      expect(ghFetchMock).not.toHaveBeenCalled();
      expect(mockResolveLinkedPullRequestsWithState).not.toHaveBeenCalled();
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_ladder_shape_refused",
          details: expect.objectContaining({
            missingStageLabels: ["review:coder-LE", "approval:exec-CTO"],
            ladderedChildCount: 2,
          }),
        }),
      );
      // The head-check waiver receipt must NOT be written — the disposition
      // never reached the head zone (SUP-13724 §1).
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_override" }),
      );
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_ladder_shape_override" }),
      );
    });

    it("does not fire Mechanism D when laddered predecessors are reachable only via blockedBy (SUP-15233 supersedes SUP-15031)", async () => {
      // SUP-15233 supersedes SUP-15031: a `blocks` row is a dependency edge,
      // not a decomposition edge, and a predecessor is not a child at any tree
      // depth. The live shape this originally refused (a parent whose
      // "children" were linked only by `blocks` rows with zero parent_id
      // children — the live SUP-14904 shape) is knowingly excluded: that
      // instance was contained before its blockers cleared (SUP-15032
      // installed the close ladder) and is closed, and the SUP-15031 corpus
      // scan found no other instance (0 of 130 recently completed issues
      // closed with >=2 blockedBy relations). The issue_relations seed below
      // documents the live shape; the guard no longer reads it in the child
      // ladder scan.
      setupDbMock({
        issues: [],
        issueRelations: [
          { id: "rel-1", companyId: "company-1", issueId: "child-1", relatedIssueId: "issue-1", type: "blocks" },
          { id: "rel-2", companyId: "company-1", issueId: "child-2", relatedIssueId: "issue-1", type: "blocks" },
        ],
        agents,
      });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, parentId: null, executionPolicy: singleStageLadder, executionState: satisfiedState([stage1]) },
        null,
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).not.toContain("Mechanism D");
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_ladder_shape_refused" }),
      );
      // The head zone is unreachable with no resolvable repo context, so no
      // branch-compare fetch is issued.
      expect(ghFetchMock).not.toHaveBeenCalled();
    });

    it("does not fire Mechanism D when edge-2 blockers carry a non-null parentId (SUP-15228 sibling shape)", async () => {
      // Reproduces the live SUP-15110 shape: a leaf coding child with two
      // blockedBy predecessors (siblings) that each ran ladders. Before the
      // fix, those siblings were counted as "laddered children" and mechanism D
      // fired with a 409. SUP-15228 excluded siblings carrying a parentId;
      // SUP-15233 supersedes that filter entirely — no blockedBy row
      // contributes to the child count, parented or not, so the sibling shape
      // stays exempt. The issue_relations seed documents the live shape.
      const siblingParentId = "99999999-9999-4999-8999-999999999999";
      setupDbMock({
        issues: [],
        issueRelations: [
          { id: "rel-1", companyId: "company-1", issueId: "sibling-1", relatedIssueId: "issue-1", type: "blocks" },
          { id: "rel-2", companyId: "company-1", issueId: "sibling-2", relatedIssueId: "issue-1", type: "blocks" },
        ],
        agents,
      });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, parentId: siblingParentId, executionPolicy: singleStageLadder, executionState: satisfiedState([stage1]) },
        null,
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).not.toContain("Mechanism D");
      expect(ghFetchMock).not.toHaveBeenCalled();
    });

    it("counts zero for the SUP-15228 live shape: the parentless blocker is a predecessor, not a child (SUP-15233 supersedes the count-1 resolution)", async () => {
      // Superseded by SUP-15233: this test previously documented the count-1
      // resolution of the SUP-15228 filter — the two parented siblings
      // (SUP-15106 / SUP-15109, parent_id = SUP-15099) excluded from edge 2
      // and the one parentless blocker (SUP-15228) counted. After SUP-15233
      // the blockedBy edge is dropped entirely, so this live shape counts 0:
      // a predecessor is not a child at any tree depth. The outcome (close
      // allowed) is unchanged; the documented count is 0, not 1.
      const siblingParentId = "99999999-9999-4999-8999-999999999999";
      setupDbMock({
        issues: [],
        blockedByIssues: [
          { id: "blocker-1", companyId: "company-1", parentId: null, executionPolicy: singleStageLadder, executionState: satisfiedState([stage1]) },
          { id: "blocker-2", companyId: "company-1", parentId: null, executionPolicy: singleStageLadder, executionState: satisfiedState([stage1]) },
        ],
        issueRelations: [
          { id: "rel-1", companyId: "company-1", issueId: "sibling-1", relatedIssueId: "issue-1", type: "blocks" },
          { id: "rel-2", companyId: "company-1", issueId: "sibling-2", relatedIssueId: "issue-1", type: "blocks" },
          { id: "rel-3", companyId: "company-1", issueId: "blocker-3", relatedIssueId: "issue-1", type: "blocks" },
        ],
        agents,
      });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, parentId: siblingParentId, executionPolicy: singleStageLadder, executionState: satisfiedState([stage1]) },
        null,
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).not.toContain("Mechanism D");
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_ladder_shape_refused" }),
      );
      expect(ghFetchMock).not.toHaveBeenCalled();
    });

    it("closes the SUP-15110 live shape with any number of parentless blockedBy predecessors (>= 2) (SUP-15233 regression)", async () => {
      // Superseded by SUP-15233: this test previously asserted the SUP-15228
      // boundary — two parentless blockedBy predecessors fire mechanism D.
      // A predecessor is not a child at any tree depth: a `blocks` row answers
      // "what had to land first?", not "was the work gated at the children?".
      // Counting predecessors as children is what trapped SUP-15110 at count 1
      // of the >= 2 threshold, so attaching one more parentless blocker (a
      // platform card, an ops card, whatever filed top-level) silently
      // re-fired the identical 409 and re-stranded the card. After SUP-15233
      // any number of parentless blockedBy predecessors contributes 0 to the
      // child count and the leaf closes. The issue_relations seed documents
      // the live shape (2 parentless + 2 parented, all laddered).
      const siblingParentId = "99999999-9999-4999-8999-999999999999";
      setupDbMock({
        issues: [],
        blockedByIssues: [
          { id: "parentless-1", companyId: "company-1", parentId: null, executionPolicy: singleStageLadder, executionState: satisfiedState([stage1]) },
          { id: "parentless-2", companyId: "company-1", parentId: null, executionPolicy: singleStageLadder, executionState: satisfiedState([stage1]) },
          { id: "sibling-1", companyId: "company-1", parentId: siblingParentId, executionPolicy: singleStageLadder, executionState: satisfiedState([stage1]) },
          { id: "sibling-2", companyId: "company-1", parentId: siblingParentId, executionPolicy: singleStageLadder, executionState: satisfiedState([stage1]) },
        ],
        issueRelations: [
          { id: "rel-1", companyId: "company-1", issueId: "parentless-1", relatedIssueId: "issue-1", type: "blocks" },
          { id: "rel-2", companyId: "company-1", issueId: "parentless-2", relatedIssueId: "issue-1", type: "blocks" },
          { id: "rel-3", companyId: "company-1", issueId: "sibling-1", relatedIssueId: "issue-1", type: "blocks" },
          { id: "rel-4", companyId: "company-1", issueId: "sibling-2", relatedIssueId: "issue-1", type: "blocks" },
        ],
        agents,
      });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, parentId: siblingParentId, executionPolicy: singleStageLadder, executionState: satisfiedState([stage1]) },
        null,
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).not.toContain("Mechanism D");
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_ladder_shape_refused" }),
      );
      expect(ghFetchMock).not.toHaveBeenCalled();
    });
  });

  describe("ungated decomposed parent (SUP-14561 mechanism A)", () => {
    const stageId = "55555555-5555-4555-8555-555555555555";

    const fixtureIssue = (f: (typeof mechanismACorpus)[number]) => ({
      ...issue,
      identifier: f.identifier,
      executionPolicy: f.executionPolicy,
      executionState: f.executionState,
    });

    const childState = (completed: string[] = [], skipped: string[] = []) => ({
      status: "completed",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: null,
      completedStageIds: completed,
      skippedStageIds: skipped,
      lastDecisionId: null,
      lastDecisionOutcome: null,
    });

    it("refuses the literal SUP-14306 shape and names the mechanism (AC1)", async () => {
      const f = mechanismACorpus.find((x) => x.identifier === "SUP-14306");
      expect(f).toBeDefined();
      setupDbMock({ issues: f!.children });
      const result = await evaluateDoneTransitionGuard(mockDb, fixtureIssue(f!), null);
      expect(result.allowed).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.reason).toContain("Mechanism A");
      expect(result.reason).not.toContain("Review ladder unsatisfied");
      // Fail closed BEFORE any external probe: no GitHub call, no PR resolution.
      expect(ghFetchMock).not.toHaveBeenCalled();
      expect(mockResolveLinkedPullRequestsWithState).not.toHaveBeenCalled();
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_null_policy_refused",
          details: expect.objectContaining({
            reason: "ungated_decomposed_parent",
            ladderedChildCount: 5,
          }),
        }),
      );
    });

    it("allows the literal SUP-13791 shape: null policy over one null-policy child (AC2)", async () => {
      const f = mechanismACorpus.find((x) => x.identifier === "SUP-13791");
      expect(f).toBeDefined();
      setupDbMock({ issues: f!.children });
      const result = await evaluateDoneTransitionGuard(mockDb, fixtureIssue(f!), null);
      expect(result.allowed).toBe(true);
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_null_policy_refused" }),
      );
    });

    it("refuses all 4 historical leak shapes and allows all 11 legitimate ladder-less closes (AC3)", async () => {
      const expectedCounts: Record<string, number> = {
        "SUP-13777": 3,
        "SUP-14023": 3,
        "SUP-14306": 5,
        "SUP-14309": 6,
      };
      const refused = mechanismACorpus.filter((f) => f.expected === "refused");
      const allowed = mechanismACorpus.filter((f) => f.expected === "allowed");
      expect(refused.map((f) => f.identifier).sort()).toEqual(Object.keys(expectedCounts).sort());
      expect(allowed).toHaveLength(11);

      for (const f of refused) {
        vi.mocked(logActivity).mockClear();
        setupDbMock({ issues: f.children });
        const result = await evaluateDoneTransitionGuard(mockDb, fixtureIssue(f), null);
        expect(result.allowed, `${f.identifier} should refuse`).toBe(false);
        expect(result.reason, `${f.identifier} should name the mechanism`).toContain("Mechanism A");
        expect(logActivity).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            action: "issue.done_transition_null_policy_refused",
            details: expect.objectContaining({
              ladderedChildCount: expectedCounts[f.identifier],
            }),
          }),
        );
      }
      for (const f of allowed) {
        vi.mocked(logActivity).mockClear();
        setupDbMock({ issues: f.children });
        const result = await evaluateDoneTransitionGuard(mockDb, fixtureIssue(f), null);
        expect(result.allowed, `${f.identifier} should allow`).toBe(true);
        expect(logActivity).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ action: "issue.done_transition_null_policy_refused" }),
        );
      }
    });

    it("writes an audit row distinct from mechanism C's action names (AC4)", async () => {
      const f = mechanismACorpus.find((x) => x.identifier === "SUP-14309");
      expect(f).toBeDefined();
      setupDbMock({ issues: f!.children });
      await evaluateDoneTransitionGuard(mockDb, fixtureIssue(f!), null);
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_null_policy_refused" }),
      );
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_ladder_refused" }),
      );
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_ladder_override" }),
      );
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_null_policy_override" }),
      );
    });

    it("refuses the override on a null-policy parent over laddered children: the disposition cannot waive mechanism A (AC5 / SUP-14878)", async () => {
      const f = mechanismACorpus.find((x) => x.identifier === "SUP-14023");
      expect(f).toBeDefined();
      setupDbMock({ issues: f!.children });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        fixtureIssue(f!),
        { disposition: "child-delivery-parent-close", reason: "my children delivered this" },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Mechanism A");
      // Fail closed BEFORE any external probe: no GitHub call, no PR resolution.
      expect(ghFetchMock).not.toHaveBeenCalled();
      expect(mockResolveLinkedPullRequestsWithState).not.toHaveBeenCalled();
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_null_policy_refused",
          details: expect.objectContaining({
            reason: "ungated_decomposed_parent",
            ladderedChildCount: 3,
          }),
        }),
      );
      // The head-check waiver receipt must NOT be written — the disposition
      // never reached the head zone (SUP-13724 §1).
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_override" }),
      );
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_null_policy_override" }),
      );
    });

    it("refuses the child-delivery-parent-close override on a null-policy parent over 5 laddered children — the SUP-14668 shape (AC2 / SUP-14878)", async () => {
      // SUP-14306 is the corpus entry whose parent closed exactly like SUP-14668:
      // executionPolicy null, five children each running their own ladder. The
      // disposition that SUP-14668 attached is precisely mechanism A's predicate.
      const f = mechanismACorpus.find((x) => x.identifier === "SUP-14306");
      expect(f).toBeDefined();
      expect(f!.executionPolicy).toBeNull();
      setupDbMock({ issues: f!.children });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        fixtureIssue(f!),
        { disposition: "child-delivery-parent-close", reason: "child-delivery-parent-close" },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Mechanism A");
      expect(ghFetchMock).not.toHaveBeenCalled();
      expect(mockResolveLinkedPullRequestsWithState).not.toHaveBeenCalled();
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_null_policy_refused",
          details: expect.objectContaining({
            reason: "ungated_decomposed_parent",
            ladderedChildCount: 5,
          }),
        }),
      );
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_override" }),
      );
    });

    it("does not fire when the parent carries its own ladder (mechanism C governs)", async () => {
      const f = mechanismACorpus.find((x) => x.identifier === "SUP-14306");
      expect(f).toBeDefined();
      setupDbMock({ issues: f!.children });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, executionPolicy: { stages: [{ id: stageId, type: "review" }] }, executionState: {} },
        null,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Review ladder unsatisfied");
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_null_policy_refused" }),
      );
    });

    it("keeps a null-policy parent legal with exactly one laddered child (count boundary)", async () => {
      setupDbMock({
        issues: [
          { identifier: "SUP-1", executionPolicy: { mode: "normal", stages: [{ id: stageId, type: "review" }] }, executionState: childState([stageId]) },
          { identifier: "SUP-2", executionPolicy: null, executionState: null },
        ],
      });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, executionPolicy: null, executionState: null },
        null,
      );
      expect(result.allowed).toBe(true);
    });

    it("does not count children whose policy never fired a stage (no completed/skipped ids)", async () => {
      setupDbMock({
        issues: [
          { identifier: "SUP-9A", executionPolicy: { mode: "normal", stages: [{ id: stageId, type: "review" }] }, executionState: childState() },
          { identifier: "SUP-9B", executionPolicy: { mode: "normal", stages: [{ id: stageId, type: "review" }] }, executionState: childState() },
        ],
      });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, executionPolicy: null, executionState: null },
        null,
      );
      expect(result.allowed).toBe(true);
    });

    it("fails closed when the child read throws (same store as the transition write)", async () => {
      const f = mechanismACorpus.find((x) => x.identifier === "SUP-14306");
      expect(f).toBeDefined();
      (mockDb.select as any).mockImplementation(() => ({
        from: () => ({
          where: () => {
            throw new Error("postgres down");
          },
        }),
      }));
      await expect(evaluateDoneTransitionGuard(mockDb, fixtureIssue(f!), null)).rejects.toThrow("postgres down");
    });

    // A laddered child row for the issues-table seed (the parent_id edge, the
    // sole child linkage after SUP-15233).
    const blockedByLadderedChild = (id: string, identifier: string) => ({
      id,
      identifier,
      executionPolicy: { mode: "normal", stages: [{ id: stageId, type: "review" }] },
      executionState: childState([stageId]),
    });

    it("does not refuse when laddered predecessors are reachable only via blockedBy relations (SUP-15233 supersedes SUP-15031)", async () => {
      // Knowingly excluded per SUP-15233 AC3: a `blocks` row is a dependency
      // edge, not a decomposition edge, and a predecessor is not a child at any
      // tree depth. The live shape this originally refused — a ladder-less
      // parent whose "children" were linked only by `blocks` rows with zero
      // parent_id children (the live SUP-14904 shape) — is no longer caught.
      // That instance was contained before its blockers cleared (SUP-15032
      // installed the close ladder) and is closed; the SUP-15031 corpus scan
      // found no other instance (0 of 130 recently completed issues closed
      // with >=2 blockedBy relations), and parent_id is the dominant
      // decomposition edge. The issue_relations seed documents the live shape;
      // the guard no longer reads it in the child ladder scan.
      setupDbMock({
        issues: [],
        issueRelations: [
          { id: "rel-1", companyId: "company-1", issueId: "child-1", relatedIssueId: "issue-1", type: "blocks" },
          { id: "rel-2", companyId: "company-1", issueId: "child-2", relatedIssueId: "issue-1", type: "blocks" },
        ],
      });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, executionPolicy: null, executionState: null },
        null,
      );
      expect(result.allowed).toBe(true);
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_null_policy_refused" }),
      );
    });

    it("does not fire Mechanism A when edge-2 blockers carry a non-null parentId (SUP-15228 sibling shape, ladder-less variant)", async () => {
      // Ladder-less variant of the SUP-15110 shape: the issue under evaluation
      // has no execution policy, and its two blockedBy predecessors are siblings
      // (they carry a non-null parentId). SUP-15228 excluded them from edge 2;
      // SUP-15233 supersedes that filter entirely — no blockedBy row
      // contributes to the child count, so mechanism A does not fire. The
      // issue_relations seed documents the live shape.
      const siblingParentId = "99999999-9999-4999-8999-999999999999";
      setupDbMock({
        issues: [],
        issueRelations: [
          { id: "rel-1", companyId: "company-1", issueId: "sibling-1", relatedIssueId: "issue-1", type: "blocks" },
          { id: "rel-2", companyId: "company-1", issueId: "sibling-2", relatedIssueId: "issue-1", type: "blocks" },
        ],
      });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, parentId: siblingParentId, executionPolicy: null, executionState: null },
        null,
      );
      expect(result.allowed).toBe(true);
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_null_policy_refused" }),
      );
    });

    it("closes the SUP-15110 live shape under mechanism A with any number of parentless blockedBy predecessors (>= 2) (SUP-15233 regression)", async () => {
      // Mechanism A consumes the same corrected count as mechanism D
      // (countLadderedChildren is the shared helper). Ladder-less variant of
      // the SUP-15110 trap: two parentless blockedBy predecessors that each
      // ran ladders must NOT fire mechanism A, because a predecessor is not a
      // child at any tree depth. The issue_relations seed documents the live
      // shape; the guard no longer reads it in the child ladder scan.
      setupDbMock({
        issues: [],
        blockedByIssues: [
          { id: "parentless-1", companyId: "company-1", parentId: null, executionPolicy: { mode: "normal", stages: [{ id: stageId, type: "review" }] }, executionState: childState([stageId]) },
          { id: "parentless-2", companyId: "company-1", parentId: null, executionPolicy: { mode: "normal", stages: [{ id: stageId, type: "review" }] }, executionState: childState([stageId]) },
        ],
        issueRelations: [
          { id: "rel-1", companyId: "company-1", issueId: "parentless-1", relatedIssueId: "issue-1", type: "blocks" },
          { id: "rel-2", companyId: "company-1", issueId: "parentless-2", relatedIssueId: "issue-1", type: "blocks" },
        ],
      });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, executionPolicy: null, executionState: null },
        null,
      );
      expect(result.allowed).toBe(true);
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_null_policy_refused" }),
      );
    });

    it("counts a child linked by both parent_id and blockedBy once (SUP-15233: parent_id is the sole linkage edge)", async () => {
      // Superseded by SUP-15233: this test previously proved the two-edge
      // de-dup (childA reachable via both edges, childB only via blockedBy,
      // union counted as 2). With the blockedBy edge dropped, childA is
      // reached once via parent_id and childB — reachable only through a
      // dependency edge — is not a child at all. Count stays 1, below the
      // >= 2 threshold, so the ladder-less parent closes.
      setupDbMock({
        issues: [blockedByLadderedChild("childA", "SUP-A")],
        issueRelations: [
          { id: "rel-1", companyId: "company-1", issueId: "childA", relatedIssueId: "issue-1", type: "blocks" },
          { id: "rel-2", companyId: "company-1", issueId: "childB", relatedIssueId: "issue-1", type: "blocks" },
        ],
      });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, executionPolicy: null, executionState: null },
        null,
      );
      expect(result.allowed).toBe(true);
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_null_policy_refused" }),
      );
    });

    it("does not count blockedBy predecessors that never ran a ladder (SUP-15233: no blockedBy row contributes)", async () => {
      // SUP-15233 supersedes the SUP-15031 "predicate applies to edge 2"
      // assertion: no blockedBy row contributes to the child count at all,
      // laddered or not. The seed documents the live shape; the guard no
      // longer reads it in the child ladder scan.
      setupDbMock({
        issues: [],
        issueRelations: [
          { id: "rel-1", companyId: "company-1", issueId: "child-1", relatedIssueId: "issue-1", type: "blocks" },
          { id: "rel-2", companyId: "company-1", issueId: "child-2", relatedIssueId: "issue-1", type: "blocks" },
        ],
      });
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, executionPolicy: null, executionState: null },
        null,
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("open linked PRs block", () => {
    it("blocks transition when a linked PR is cached open, no GitHub token configured, and the last refresh succeeded (zero outbound fetch)", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip-agent-tools", number: 274, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip-agent-tools#274", cachedState: "open", lastErrorCode: null },
      ]);
      mockResolveGitHubToken.mockResolvedValue({ token: null, scope: null, secretName: null });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.reason).toContain("1 open linked PR");
      expect(result.reason).toContain("TEA-Core/paperclip-agent-tools#274");
      expect(result.reason).toContain("doneTransitionOverride");
      expect(result.reason).toContain("does not clear this block");
      expect(ghFetchMock).not.toHaveBeenCalled();
    });

    it("blocks transition when resolveLinkedPullRequests yields multiple PRs", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip-agent-tools", number: 274, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip-agent-tools#274", cachedState: "open" },
        { id: "pr-2", owner: "TEA-Core", repo: "Trading-Signal-Platform", number: 3124, nodeId: null, headRefName: null, displayName: "TEA-Core/Trading-Signal-Platform#3124", cachedState: "open" },
      ]);
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("2 open linked PRs");
      expect(result.reason).toContain("TEA-Core/paperclip-agent-tools#274");
      expect(result.reason).toContain("TEA-Core/Trading-Signal-Platform#3124");
    });

    it("writes audit log with open_linked_prs:<n> reason and PR display names", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip-agent-tools", number: 274, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip-agent-tools#274", cachedState: "open" },
        { id: "pr-2", owner: "TEA-Core", repo: "Trading-Signal-Platform", number: 3124, nodeId: null, headRefName: null, displayName: "TEA-Core/Trading-Signal-Platform#3124", cachedState: "open" },
      ]);
      await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_guard_skipped",
          details: expect.objectContaining({
            reason: "open_linked_prs:2",
            skipReason: "open_linked_prs:2",
            prs: "TEA-Core/paperclip-agent-tools#274, TEA-Core/Trading-Signal-Platform#3124",
          }),
        }),
      );
    });

    it("allows a DECISION-CARRYING transition past open linked PRs and writes the decision_carried exemption audit row (SUP-13290)", async () => {
      // The review approval is exactly what arms the merge (armMergeOnApproval):
      // blocking it on the open PR it approves deadlocks the approval circuit
      // (SUP-13207, board direction B). The plain-close block below stays intact.
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip-agent-tools", number: 274, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip-agent-tools#274", cachedState: "open", lastErrorCode: null },
      ]);
      mockResolveGitHubToken.mockResolvedValue({ token: null, scope: null, secretName: null });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null, true);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.reason).toContain("arms the merge");
      expect(result.reason).toContain("TEA-Core/paperclip-agent-tools#274");
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_guard_skipped",
          details: expect.objectContaining({
            reason: "open_linked_prs_decision_carried:1",
            skipReason: "open_linked_prs_decision_carried:1",
            prs: "TEA-Core/paperclip-agent-tools#274",
          }),
        }),
      );
    });

    // SUP-14429 (mechanism B): the decisionCarried carve-out must not waive an
    // open linked PR held by an undismissed external CHANGES_REQUESTED review.
    // The hydration pass now resolves the live GraphQL reviewDecision; only that
    // exact decision refuses. Everything else keeps the D6 waiver (fail open on
    // unknown — a GitHub outage must never fail the guard closed).
    describe("open linked PR held by CHANGES_REQUESTED (SUP-14429)", () => {
      const openPr = {
        id: "pr-1",
        owner: "TEA-Core",
        repo: "paperclip-agent-tools",
        number: 274,
        nodeId: null,
        headRefName: null,
        title: null,
        displayName: "TEA-Core/paperclip-agent-tools#274",
        cachedState: "open",
        lastErrorCode: null,
        reviewDecision: null,
      };

      /** Open PR #274 with a review decision resolved via the GraphQL mock. */
      function mockOpenPr274(decision: string | null) {
        mockResolveLinkedPullRequestsWithState.mockResolvedValue([{ ...openPr }]);
        ghFetchMock.mockImplementation(async (url: string) => {
          if (url.includes("/pulls/274")) {
            return new Response(JSON.stringify({ state: "open" }), { status: 200 });
          }
          if (url === "https://api.github.com/graphql") {
            if (decision === null) {
              return new Response(
                JSON.stringify({ data: { repository: { pullRequest: null } } }),
                { status: 200 },
              );
            }
            return new Response(
              JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: decision } } } }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify({}), { status: 404 });
        });
      }

      it("REFUSES a decision-carrying close when an open linked PR is held by an undismissed CHANGES_REQUESTED review (AC2)", async () => {
        mockOpenPr274("CHANGES_REQUESTED");
        const result = await evaluateDoneTransitionGuard(mockDb, issue, null, true);
        expect(result.allowed).toBe(false);
        expect(result.skipped).toBe(false);
        expect(result.skipReason).toBe("open_linked_prs_changes_requested:1");
        expect(result.reason).toContain("CHANGES_REQUESTED");
        expect(result.reason).toContain("TEA-Core/paperclip-agent-tools#274");
        expect(result.reason).toContain("re-approve");
        expect(result.reason).toContain("doneTransitionOverride");
        expect(logActivity).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            action: "issue.done_transition_guard_skipped",
            details: expect.objectContaining({
              reason: "open_linked_prs_changes_requested:1",
              skipReason: "open_linked_prs_changes_requested:1",
              prs: "TEA-Core/paperclip-agent-tools#274",
            }),
          }),
        );
      });

      it.each(["APPROVED", "REVIEW_REQUIRED"] as const)(
        "keeps the D6 waiver for a decision-carrying close over an open PR whose review decision is %s (AC3, SUP-13207 regression)",
        async (decision) => {
          mockOpenPr274(decision);
          const result = await evaluateDoneTransitionGuard(mockDb, issue, null, true);
          expect(result.allowed).toBe(true);
          expect(result.skipped).toBe(false);
          expect(result.reason).toContain("arms the merge");
          expect(result.reason).toContain("TEA-Core/paperclip-agent-tools#274");
          expect(logActivity).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              action: "issue.done_transition_guard_skipped",
              details: expect.objectContaining({
                reason: "open_linked_prs_decision_carried:1",
                skipReason: "open_linked_prs_decision_carried:1",
                prs: "TEA-Core/paperclip-agent-tools#274",
              }),
            }),
          );
        },
      );

      it("keeps the D6 waiver when the GraphQL review decision resolves to null (AC3/AC4)", async () => {
        mockOpenPr274(null);
        const result = await evaluateDoneTransitionGuard(mockDb, issue, null, true);
        expect(result.allowed).toBe(true);
        expect(result.reason).toContain("arms the merge");
        expect(logActivity).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            action: "issue.done_transition_guard_skipped",
            details: expect.objectContaining({ reason: "open_linked_prs_decision_carried:1" }),
          }),
        );
      });

      it.each([
        ["a non-2xx GraphQL response", 500, false],
        ["a GraphQL errors array", 200, true],
      ] as const)(
        "fails OPEN (waiver applies) when the review decision cannot be resolved via %s (AC4)",
        async (_label, status, withErrors) => {
          mockResolveLinkedPullRequestsWithState.mockResolvedValue([{ ...openPr }]);
          ghFetchMock.mockImplementation(async (url: string) => {
            if (url.includes("/pulls/274")) {
              return new Response(JSON.stringify({ state: "open" }), { status: 200 });
            }
            if (url === "https://api.github.com/graphql") {
              return new Response(
                JSON.stringify(withErrors ? { errors: [{ message: "boom" }] } : {}),
                { status },
              );
            }
            return new Response(JSON.stringify({}), { status: 404 });
          });
          const result = await evaluateDoneTransitionGuard(mockDb, issue, null, true);
          expect(result.allowed).toBe(true);
          expect(result.skipped).toBe(false);
          expect(result.reason).toContain("arms the merge");
          expect(logActivity).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              action: "issue.done_transition_guard_skipped",
              details: expect.objectContaining({ reason: "open_linked_prs_decision_carried:1" }),
            }),
          );
        },
      );

      it("does NOT refuse a plain (non-decision-carrying) close — the open_linked_prs block is unchanged (AC6)", async () => {
        mockOpenPr274("CHANGES_REQUESTED");
        const result = await evaluateDoneTransitionGuard(mockDb, issue, null, false);
        expect(result.allowed).toBe(false);
        expect(result.skipped).toBe(false);
        expect(result.skipReason).toBeNull();
        expect(result.reason).toContain("1 open linked PR");
        expect(result.reason).toContain("TEA-Core/paperclip-agent-tools#274");
        expect(logActivity).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            action: "issue.done_transition_guard_skipped",
            details: expect.objectContaining({
              reason: "open_linked_prs:1",
              skipReason: "open_linked_prs:1",
            }),
          }),
        );
      });

      it("counts and names ONLY the held PRs when open PRs mix refused and unrefused decisions", async () => {
        const pr2 = {
          id: "pr-2",
          owner: "TEA-Core",
          repo: "Trading-Signal-Platform",
          number: 3124,
          nodeId: null,
          headRefName: null,
          title: null,
          displayName: "TEA-Core/Trading-Signal-Platform#3124",
          cachedState: "open",
          lastErrorCode: null,
          reviewDecision: null,
        };
        mockResolveLinkedPullRequestsWithState.mockResolvedValue([{ ...openPr }, { ...pr2 }]);
        ghFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
          if (url.includes("/pulls/274") || url.includes("/pulls/3124")) {
            return new Response(JSON.stringify({ state: "open" }), { status: 200 });
          }
          if (url === "https://api.github.com/graphql") {
            const variables = (JSON.parse(String(init?.body)) as {
              variables: { number: number };
            }).variables;
            const decision = variables.number === 274 ? "CHANGES_REQUESTED" : "APPROVED";
            return new Response(
              JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: decision } } } }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify({}), { status: 404 });
        });
        const result = await evaluateDoneTransitionGuard(mockDb, issue, null, true);
        expect(result.allowed).toBe(false);
        expect(result.skipReason).toBe("open_linked_prs_changes_requested:1");
        expect(result.reason).toContain("TEA-Core/paperclip-agent-tools#274");
        expect(result.reason).not.toContain("Trading-Signal-Platform#3124");
        expect(logActivity).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            action: "issue.done_transition_guard_skipped",
            details: expect.objectContaining({
              reason: "open_linked_prs_changes_requested:1",
              skipReason: "open_linked_prs_changes_requested:1",
              prs: "TEA-Core/paperclip-agent-tools#274",
            }),
          }),
        );
      });
    });

    it("does NOT block on an unhydrated linked PR (cachedState null) — a bare URL mention must not freeze done under the 401", async () => {
      // externalObjects rows are inserted from a URL mention with `data` NULL and are
      // hydrated later by a GitHub API refresh — the same call that 401s under
      // SUP-13038. If an unhydrated row counted as open, merely linking any PR
      // (even an already-merged one) would permanently block `done`.
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 279, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#279", cachedState: null },
      ]);
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/repos/TEA-Core/paperclip/pulls/279")) {
          return new Response(JSON.stringify({ state: "closed" }), { status: 200 });
        }
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.reason).not.toContain("open linked PR");
    });

    it("emits unhydrated_linked_prs:<n> skipReason when linked PR row has cachedState null and hydration is not possible (no token)", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 279, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#279", cachedState: null },
      ]);
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipReason).toMatch(/unhydrated_linked_prs:1/);
    });

    it("emits unhydrated_linked_prs:<n> skipReason when linked PR row has cachedState null and hydration fails", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 279, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#279", cachedState: null },
      ]);
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/repos/TEA-Core/paperclip/pulls/279")) {
          throw new Error("network error");
        }
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipReason).toMatch(/unhydrated_linked_prs:1/);
    });

    it("does not emit unhydrated_linked_prs skipReason when cachedState is closed", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 279, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#279", cachedState: "closed" },
      ]);
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockResolvedValue(new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 }));
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipReason).toBeNull();
    });

    it("does not emit unhydrated_linked_prs skipReason when cachedState is merged", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 279, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#279", cachedState: "merged" },
      ]);
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockResolvedValue(new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 }));
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipReason).toBeNull();
    });

    it("best-effort hydration updates cachedState from null to closed and clears skipReason", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 279, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#279", cachedState: null },
      ]);
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/repos/TEA-Core/paperclip/pulls/279")) {
          return new Response(JSON.stringify({ state: "closed" }), { status: 200 });
        }
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipReason).toBeNull();
    });

    it("best-effort hydration updates cachedState from null to open and blocks transition", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 279, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#279", cachedState: null },
      ]);
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/repos/TEA-Core/paperclip/pulls/279")) {
          return new Response(JSON.stringify({ state: "open" }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("1 open linked PR");
      expect(result.reason).toContain("TEA-Core/paperclip#279");
    });

    it("skipReason survives through the branch-not-ahead fail-open path", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 279, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#279", cachedState: null },
      ]);
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.aheadBy).toBe(0);
      expect(result.skipReason).toMatch(/unhydrated_linked_prs:1/);
    });

    it("skipReason survives through the merged-PR fail-open path", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 279, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#279", cachedState: null },
      ]);
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: "SUP-12345-test-branch" })],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 1 }), { status: 200 });
        }
        if (url.includes("/pulls?")) {
          return new Response(JSON.stringify([{ merged: true, merged_at: "2026-08-13T12:00:00Z" }]), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("merged PR");
      expect(result.skipReason).toMatch(/unhydrated_linked_prs:1/);
    });

    it("skipReason survives through the branch-ahead-without-merged-PR path", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 279, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#279", cachedState: null },
      ]);
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: "SUP-12345-test-branch" })],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 3 }), { status: 200 });
        }
        if (url.includes("/pulls?")) {
          return new Response(JSON.stringify([{ merged: false, merged_at: null }]), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("deliver.sh");
      expect(result.skipReason).toMatch(/unhydrated_linked_prs:1/);
    });

    it("blocks only the positively-open PRs when the linked set mixes hydrated and unhydrated rows", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 279, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#279", cachedState: null },
        { id: "pr-2", owner: "TEA-Core", repo: "paperclip-agent-tools", number: 274, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip-agent-tools#274", cachedState: "open" },
      ]);
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("1 open linked PR");
      expect(result.reason).toContain("TEA-Core/paperclip-agent-tools#274");
      expect(result.reason).not.toContain("#279");
    });

    it("allows transition when linked PR set is empty (existing green path)", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([]);
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockResolvedValue(new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 }));
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.aheadBy).toBe(0);
    });

    it("no-deliverable-head override still allows transition with open linked PRs present", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip-agent-tools", number: 274, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip-agent-tools#274", cachedState: "open" },
      ]);
      const override: DoneTransitionOverride = { disposition: "upstream-equivalent-fix-no-deliverable-head", reason: "Tier 1" };
      const result = await evaluateDoneTransitionGuard(mockDb, issue, override);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("upstream-equivalent-fix-no-deliverable-head");
    });

    it("waives only the head check for a no-ladder card: child-delivery-parent-close closes over open linked PRs (SUP-12850/SUP-14470 shapes stay lawful, AC4 / SUP-14878)", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 274, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#274", cachedState: "open", lastErrorCode: null },
      ]);
      // No execution policy, no laddered children: mechanism A count=0,
      // mechanism D not armed. The disposition reaches the head zone and waives
      // the open-PR / branch-ahead checks — it is the disposition's only job now.
      const result = await evaluateDoneTransitionGuard(
        mockDb,
        { ...issue, executionPolicy: null, executionState: null },
        { disposition: "child-delivery-parent-close", reason: "children merged; parent is the rollout record" },
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("Override accepted: child-delivery-parent-close");
      // The head check was waived before any PR resolution or GitHub call.
      expect(mockResolveLinkedPullRequestsWithState).not.toHaveBeenCalled();
      expect(ghFetchMock).not.toHaveBeenCalled();
      // The waiver receipt IS written; no refusal audit row is.
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_override",
          details: expect.objectContaining({ disposition: "child-delivery-parent-close" }),
        }),
      );
      expect(logActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.done_transition_null_policy_refused" }),
      );
    });
  });

  describe("stale cached 'open' under credential gap (SUP-13234)", () => {
    it("fails open when no token is configured and the last refresh errored github_auth_required", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 300, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#300", cachedState: "open", lastErrorCode: "github_auth_required" },
      ]);
      mockResolveGitHubToken.mockResolvedValue({ token: null, scope: null, secretName: null });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("No resolvable");
      expect(result.skipReason).toContain("stale_open_unverifiable:1");
      expect(ghFetchMock).not.toHaveBeenCalled();
    });

    it("fails open when token resolution throws and the last refresh errored github_auth_required", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 300, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#300", cachedState: "open", lastErrorCode: "github_auth_required" },
      ]);
      mockResolveGitHubToken.mockRejectedValue(new Error("github_auth_required"));
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipReason).toContain("stale_open_unverifiable:1");
      expect(ghFetchMock).not.toHaveBeenCalled();
    });

    it("still blocks a cached 'open' PR without a token when the last refresh succeeded (lastErrorCode null)", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 300, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#300", cachedState: "open", lastErrorCode: null },
      ]);
      mockResolveGitHubToken.mockResolvedValue({ token: null, scope: null, secretName: null });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("1 open linked PR");
      expect(ghFetchMock).not.toHaveBeenCalled();
    });

    it("blocks only the re-verifiable open PR in a mixed set under a credential gap", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 300, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#300", cachedState: "open", lastErrorCode: "github_auth_required" },
        { id: "pr-2", owner: "TEA-Core", repo: "paperclip-agent-tools", number: 274, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip-agent-tools#274", cachedState: "open", lastErrorCode: null },
      ]);
      mockResolveGitHubToken.mockResolvedValue({ token: null, scope: null, secretName: null });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("1 open linked PR");
      expect(result.reason).toContain("TEA-Core/paperclip-agent-tools#274");
      expect(result.reason).not.toContain("paperclip#300");
      expect(ghFetchMock).not.toHaveBeenCalled();
    });

    it("writes issue.done_transition_guard_failed_open audit on the stale-open fail-open path", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 300, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#300", cachedState: "open", lastErrorCode: "github_auth_required" },
      ]);
      mockResolveGitHubToken.mockResolvedValue({ token: null, scope: null, secretName: null });
      await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_guard_failed_open",
          details: expect.objectContaining({
            reason: "stale_open_unverifiable:1",
            prs: "TEA-Core/paperclip#300",
          }),
        }),
      );
    });
  });

  describe("stale 'open' re-hydration with token (SUP-13234)", () => {
    it("unblocks when re-hydration shows the cached-'open' PR was merged since the last refresh", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 300, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#300", cachedState: "open", lastErrorCode: "github_auth_required" },
      ]);
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/repos/TEA-Core/paperclip/pulls/300")) {
          return new Response(JSON.stringify({ state: "closed", merged: true }), { status: 200 });
        }
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.aheadBy).toBe(0);
      expect(result.reason).not.toContain("open linked PR");
    });

    it("keeps blocking when re-hydration confirms the PR is still open", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 300, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#300", cachedState: "open", lastErrorCode: null },
      ]);
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/repos/TEA-Core/paperclip/pulls/300")) {
          return new Response(JSON.stringify({ state: "open" }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("1 open linked PR");
      expect(result.reason).toContain("TEA-Core/paperclip#300");
    });

    it("fails open when re-hydration 401s and the last refresh errored github_auth_required", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 300, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#300", cachedState: "open", lastErrorCode: "github_auth_required" },
      ]);
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/repos/TEA-Core/paperclip/pulls/300")) {
          return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipReason).toContain("stale_open_unverifiable:1");
    });
  });

  describe("no repo context", () => {
    it("allows transition when no execution workspace or project context exists", async () => {
      setupDbMock({});
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("No resolvable");
    });
  });

  describe("branch not ahead", () => {
    it("allows transition when ahead_by is 0", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockResolvedValue(new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 }));
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.aheadBy).toBe(0);
    });
  });

  describe("branch ahead with merged PR", () => {
    it("allows transition when branch is ahead and has a merged PR", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: "SUP-12345-test-branch" })],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 1 }), { status: 200 });
        }
        if (url.includes("/pulls?")) {
          return new Response(JSON.stringify([{ merged: true, merged_at: "2026-08-13T12:00:00Z" }]), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.aheadBy).toBe(1);
      expect(result.reason).toContain("merged PR");
    });
  });

  describe("branch ahead without merged PR", () => {
    it("rejects transition with 409 when branch is ahead and has no merged PR", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: "SUP-12345-test-branch" })],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 3 }), { status: 200 });
        }
        if (url.includes("/pulls?")) {
          return new Response(JSON.stringify([{ merged: false, merged_at: null }]), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(false);
      expect(result.aheadBy).toBe(3);
      expect(result.reason).toContain("deliver.sh");
      expect(result.reason).toContain("3");
    });

    it("allows a DECISION-CARRYING transition past an ahead branch with no merged PR (SUP-13290)", async () => {
      // Same deadlock shape as open linked PRs, firing when the open PR is
      // unlinked/unhydrated: the approval that arms the merge must not be
      // blocked by the unmerged branch it is approving.
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: "SUP-12345-test-branch" })],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 3 }), { status: 200 });
        }
        if (url.includes("/pulls?")) {
          return new Response(JSON.stringify([{ merged: false, merged_at: null }]), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null, true);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.aheadBy).toBe(3);
      expect(result.reason).toContain("arms the merge");
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_guard_skipped",
          details: expect.objectContaining({
            reason: "ahead_by_no_merged_pr_decision_carried:3",
            skipReason: "ahead_by_no_merged_pr_decision_carried:3",
          }),
        }),
      );
    });
  });

  describe("foreign workspace branch (SUP-13337)", () => {
    // The workspace branch belongs to a different issue (shared/inherited worktree,
    // merge-X card, corrective child on a parent branch): the branch's own
    // ahead/merged state must not pass or fail THIS issue's `done`.
    const foreignBranch = "SUP-99999-other-issue-branch";

    it("blocks when the branch is foreign and neither commits nor merged PRs are attributable to the issue (allowed:false naming branch and identifier)", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: foreignBranch })],
      });
      mockGitProbe("5", "0", " M server/src/x.ts");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 3 }), { status: 200 });
        }
        if (url.includes("/search/issues")) {
          return new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.aheadBy).toBe(3);
      expect(result.branch).toBe(foreignBranch);
      expect(result.reason).toContain(foreignBranch);
      expect(result.reason).toContain("SUP-12345");
      expect(result.reason).toContain("deliver.sh");
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_guard_skipped",
          details: expect.objectContaining({
            reason: "foreign_workspace_branch",
            skipReason: `foreign_workspace_branch:${foreignBranch}:SUP-12345`,
            branch: foreignBranch,
            attributableCommitCount: 0,
            mergedPrCount: 0,
            worktreeDirty: true,
          }),
        }),
      );
    });

    it("allows the no-repo-deliverable close when the foreign branch owns no commits, no merged PR, and the issue's worktree is clean (SUP-13873)", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: foreignBranch })],
      });
      mockGitProbe("5", "0", "");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 3 }), { status: 200 });
        }
        if (url.includes("/search/issues")) {
          return new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.aheadBy).toBe(3);
      expect(result.branch).toBe(foreignBranch);
      expect(result.reason).toContain(foreignBranch);
      expect(result.reason).toContain("SUP-12345");
      expect(result.reason).toContain("no repo deliverable is owed");
      expect(result.skipReason).toContain(`foreign_workspace_branch:${foreignBranch}:SUP-12345`);
      expect(result.skipReason).toContain("no_repo_deliverable_clean_worktree:SUP-12345");
    });

    it("blocks the no-repo-deliverable close when the issue's worktree holds uncommitted work (owed diff)", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: foreignBranch })],
      });
      mockGitProbe("5", "0", "?? server/docs/design/SPEC-draft.md");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 3 }), { status: 200 });
        }
        if (url.includes("/search/issues")) {
          return new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.reason).toContain(foreignBranch);
      expect(result.reason).toContain("SUP-12345");
      expect(result.reason).toContain("uncommitted work");
      expect(result.reason).toContain("deliver.sh");
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_guard_skipped",
          details: expect.objectContaining({
            reason: "foreign_workspace_branch",
            worktreeDirty: true,
          }),
        }),
      );
    });

    it("fails open when the foreign-branch worktree status probe cannot be measured (SUP-13873)", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: foreignBranch })],
      });
      mockExecFile.mockImplementation(
        (_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
          if (args.includes("status")) {
            cb(new Error("git status failed"), "");
            return;
          }
          cb(null, args.includes("--grep") ? "0" : "5");
        },
      );
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 3 }), { status: 200 });
        }
        if (url.includes("/search/issues")) {
          return new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain(`foreign_workspace_branch:${foreignBranch}:SUP-12345`);
      expect(result.skipReason).toContain("foreign_workspace_branch_status_probe_failed");
    });

    it("allows when the foreign branch carries at least one commit attributable to the issue (shared branch still passes)", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: foreignBranch })],
      });
      mockGitProbe("5", "1");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 3 }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.aheadBy).toBe(3);
      expect(result.reason).toContain(foreignBranch);
      expect(result.reason).toContain("SUP-12345");
      expect(result.skipReason).toContain(`foreign_workspace_branch:${foreignBranch}:SUP-12345`);
      expect(ghFetchMock.mock.calls.some(([url]) => String(url).includes("/search/issues"))).toBe(false);
    });

    it("allows when the foreign branch has no attributable commits but a merged PR references the issue", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: foreignBranch })],
      });
      mockGitProbe("5", "0");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 3 }), { status: 200 });
        }
        if (url.includes("/search/issues")) {
          return new Response(JSON.stringify({ total_count: 2, items: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.reason).toContain("merged PR");
      expect(result.reason).toContain("SUP-12345");
      expect(result.skipReason).toContain(`foreign_workspace_branch:${foreignBranch}:SUP-12345`);
    });

    it("fails open when the foreign-branch attribution probes are unmeasurable", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: foreignBranch })],
      });
      mockGitProbe("5", "0");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 3 }), { status: 200 });
        }
        if (url.includes("/search/issues")) {
          return new Response("upstream error", { status: 502 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain(`foreign_workspace_branch:${foreignBranch}:SUP-12345`);
      expect(result.skipReason).toContain("foreign_workspace_branch_probe_failed");
    });

    it("keeps the decisionCarried carve-out for a foreign workspace branch", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: foreignBranch })],
      });
      mockGitProbe("5", "0");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 3 }), { status: 200 });
        }
        if (url.includes("/search/issues")) {
          return new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null, true);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.aheadBy).toBe(3);
      expect(result.reason).toContain("arms the merge");
      expect(result.skipReason ?? "").not.toContain(`foreign_workspace_branch:${foreignBranch}:SUP-12345`);
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_guard_skipped",
          details: expect.objectContaining({
            reason: "ahead_by_no_merged_pr_decision_carried:3",
            skipReason: expect.stringContaining(`foreign_workspace_branch:${foreignBranch}:SUP-12345`),
          }),
        }),
      );
    });

    it("runs no identifier-attribution probes when the branch references the issue identifier (common path byte-identical)", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: "SUP-12345-test-branch" })],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 1 }), { status: 200 });
        }
        if (url.includes("/pulls?")) {
          return new Response(JSON.stringify([{ merged: true, merged_at: "2026-08-13T12:00:00Z" }]), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.aheadBy).toBe(1);
      expect(result.reason).toContain("merged PR");
      expect(result.skipReason).toBeNull();
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(ghFetchMock.mock.calls.some(([url]) => String(url).includes("/search/issues"))).toBe(false);
    });
  });

  describe("fail-open on errors", () => {
    it("blocks transition when compare API returns 404 and the worktree carries >=1 issue-attributable commit", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      mockGitProbe("5", "1");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/git/ref/heads/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/search/issues")) {
          return new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.skipReason).toBeNull();
      expect(result.aheadBy).toBeNull();
      expect(result.branch).toBe("SUP-12686-test-branch");
      expect(result.defaultRef).toBe("fold/tea-patches-v2026.722.0");
      expect(result.reason).toContain("SUP-12686-test-branch");
      expect(result.reason).toContain("does not exist on the remote");
      expect(result.reason).toContain("attributable to SUP-12345");
      expect(result.reason).toContain("deliver.sh");
      expect(result.reason).not.toContain("deliveryState");
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_guard_skipped",
          details: expect.objectContaining({
            reason: "branch_absent_on_remote",
            branch: "SUP-12686-test-branch",
            defaultRef: "fold/tea-patches-v2026.722.0",
            owner: "TEA-Core",
            repo: "paperclip",
            aheadCount: 5,
            attributableCommitCount: 1,
            mergedPrCount: 0,
          }),
        }),
      );
    });

    it("allows transition when compare API returns 404 with issue-attributable commits but a merged PR references the identifier (carrier delivery)", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      mockGitProbe("5", "1");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/git/ref/heads/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/search/issues")) {
          return new Response(JSON.stringify({ total_count: 2, items: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("branch_absent_landed_via_merged_pr:SUP-12345:2");
      expect(result.skipReason).not.toContain("compare_api_failed");
    });

    it("allows transition when compare API returns 404 with issue-attributable commits and the merged-PR probe is unmeasurable", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      mockGitProbe("5", "1");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/git/ref/heads/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/search/issues")) {
          return new Response("upstream error", { status: 502 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("branch_absent_merged_pr_probe_failed:SUP-12686-test-branch");
    });

    it("allows transition when compare API returns 404 with issue-attributable commits and the merged-PR probe throws", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      mockGitProbe("5", "1");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/git/ref/heads/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/search/issues")) {
          throw new Error("rate limited");
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("branch_absent_merged_pr_probe_failed:SUP-12686-test-branch");
    });

    it("does not call the merged-PR search when there are no issue-attributable commits", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      mockGitProbe("5", "0");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/git/ref/heads/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/search/issues")) {
          return new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipReason).toContain("branch_absent_on_remote:SUP-12686-test-branch");
      expect(ghFetchMock.mock.calls.some(([url]) => String(url).includes("/search/issues"))).toBe(false);
    });

    it("allows transition when compare API returns 404 and the worktree carries zero issue-attributable commits despite being several commits ahead (base drift only)", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      mockGitProbe("5", "0");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/git/ref/heads/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("branch_absent_on_remote:SUP-12686-test-branch");
      expect(result.skipReason).not.toContain("compare_api_failed");
    });

    it("allows transition when compare API returns 404 and the local worktree probe is unreachable", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      mockGitProbeUnavailable();
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/git/ref/heads/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("branch_absent_on_remote:SUP-12686-test-branch");
      expect(result.skipReason).not.toContain("compare_api_failed");
    });

    it("allows transition when compare API returns 404 and the workspace has no local worktree path", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ providerType: "project_primary", providerRef: null, cwd: null })],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/git/ref/heads/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("branch_absent_on_remote:SUP-12686-test-branch");
      expect(result.skipReason).not.toContain("compare_api_failed");
    });

    it("allows transition when compare API throws", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockRejectedValue(new Error("network error"));
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("compare_api_failed");
    });

    it("allows transition when merged-PR lookup throws", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: "SUP-12345-test-branch" })],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 2 }), { status: 200 });
        }
        if (url.includes("/pulls?")) {
          throw new Error("rate limited");
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("merged_pr_lookup_failed");
    });
  });

  describe("origin/ baseRef prefix (SUP-13691)", () => {
    it("strips the origin/ prefix from a slashed baseRef for the GitHub compare call only", async () => {
      setupDbMock({
        executionWorkspaces: [
          mockExecutionWorkspaceRow({
            baseRef: "origin/fold/tea-patches-v2026.722.0",
            branchName: "SUP-12345-test-branch",
          }),
        ],
      });
      ghFetchMock.mockResolvedValue(new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 }));
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.aheadBy).toBe(0);
      const compareUrl = ghFetchMock.mock.calls.map(([url]) => String(url)).find((u) => u.includes("/compare/"));
      expect(compareUrl).toBe(
        "https://api.github.com/repos/TEA-Core/paperclip/compare/fold%2Ftea-patches-v2026.722.0...SUP-12345-test-branch",
      );
      expect(compareUrl).not.toContain("origin%2F");
    });

    it("strips the origin/ prefix from a simple baseRef (origin/main) for the compare call", async () => {
      setupDbMock({
        executionWorkspaces: [
          mockExecutionWorkspaceRow({
            baseRef: "origin/main",
            branchName: "SUP-12345-test-branch",
          }),
        ],
      });
      ghFetchMock.mockResolvedValue(new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 }));
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.aheadBy).toBe(0);
      const compareUrl = ghFetchMock.mock.calls.map(([url]) => String(url)).find((u) => u.includes("/compare/"));
      expect(compareUrl).toBe(
        "https://api.github.com/repos/TEA-Core/paperclip/compare/main...SUP-12345-test-branch",
      );
    });

    it("keeps the full origin/ ref for the local git attribution probe", async () => {
      setupDbMock({
        executionWorkspaces: [
          mockExecutionWorkspaceRow({
            baseRef: "origin/fold/tea-patches-v2026.722.0",
            branchName: "SUP-12345-test-branch",
          }),
        ],
      });
      const ranges: string[] = [];
      mockExecFile.mockImplementation(
        (_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
          ranges.push(args[args.length - 1] as string);
          cb(null, args.includes("--grep") ? "0" : "5");
        },
      );
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/git/ref/heads/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        return new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("branch_absent_on_remote:SUP-12345-test-branch");
      expect(ranges).toEqual([
        "origin/fold/tea-patches-v2026.722.0..HEAD",
        "origin/fold/tea-patches-v2026.722.0..HEAD",
      ]);
    });

    it("allows a DECISION-CARRYING approval for a pushed branch with an open PR when baseRef has the origin/ prefix (SUP-13688 repro)", async () => {
      // The false block: pushed branch + green CI, approval 409'd because the
      // compare call 404'd on the origin/-prefixed base ref and fell into the
      // branch-absent path, which had no decisionCarried carve-out.
      setupDbMock({
        executionWorkspaces: [
          mockExecutionWorkspaceRow({
            baseRef: "origin/fold/tea-patches-v2026.722.0",
            branchName: "SUP-12345-test-branch",
          }),
        ],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 3 }), { status: 200 });
        }
        if (url.includes("/pulls?")) {
          return new Response(JSON.stringify([{ merged: false, merged_at: null }]), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null, true);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.aheadBy).toBe(3);
      expect(result.reason).toContain("arms the merge");
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_guard_skipped",
          details: expect.objectContaining({
            reason: "ahead_by_no_merged_pr_decision_carried:3",
            skipReason: "ahead_by_no_merged_pr_decision_carried:3",
          }),
        }),
      );
    });

    it("allows a DECISION-CARRYING transition on the branch-absent path (defense-in-depth carve-out)", async () => {
      setupDbMock({
        executionWorkspaces: [
          mockExecutionWorkspaceRow({
            baseRef: "origin/fold/tea-patches-v2026.722.0",
          }),
        ],
      });
      mockGitProbe("5", "1");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/git/ref/heads/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/search/issues")) {
          return new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null, true);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.aheadBy).toBeNull();
      expect(result.branch).toBe("SUP-12686-test-branch");
      expect(result.reason).toContain("Decision-carrying transition exempted from the branch-absent-on-remote block");
      expect(result.reason).toContain("arms the merge");
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_guard_skipped",
          details: expect.objectContaining({
            reason: "branch_absent_decision_carried:SUP-12686-test-branch",
            skipReason: "branch_absent_decision_carried:SUP-12686-test-branch",
          }),
        }),
      );
    });

    it("still blocks a plain (non-decision) close on the branch-absent path with an origin/ baseRef", async () => {
      setupDbMock({
        executionWorkspaces: [
          mockExecutionWorkspaceRow({
            baseRef: "origin/fold/tea-patches-v2026.722.0",
          }),
        ],
      });
      mockGitProbe("5", "1");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/git/ref/heads/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/search/issues")) {
          return new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.reason).toContain("does not exist on the remote");
      expect(result.reason).toContain("deliver.sh");
    });
  });

  describe("auth failure classification", () => {
    it("allows transition and emits auth_failed:compare:401 when compare API returns 401", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("auth_failed:compare:401");
      expect(result.skipReason).toContain("scope=company");
      expect(result.skipReason).toContain("secretName=GITHUB_TOKEN");
    });

    it("allows transition and emits auth_failed:compare:403 when compare API returns 403", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("auth_failed:compare:403");
      expect(result.skipReason).toContain("scope=company");
      expect(result.skipReason).toContain("secretName=GITHUB_TOKEN");
    });

    it("allows transition and emits auth_failed:merged_pr:401 when pulls API returns 401", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: "SUP-12345-test-branch" })],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 1 }), { status: 200 });
        }
        if (url.includes("/pulls?")) {
          return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("auth_failed:merged_pr:401");
      expect(result.skipReason).toContain("scope=company");
      expect(result.skipReason).toContain("secretName=GITHUB_TOKEN");
    });

    it("allows transition and emits auth_failed:merged_pr:403 when pulls API returns 403", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: "SUP-12345-test-branch" })],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 1 }), { status: 200 });
        }
        if (url.includes("/pulls?")) {
          return new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("auth_failed:merged_pr:403");
    });

    it("keeps compare_api_failed prefix for 502 (non-auth error)", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Bad gateway" }), { status: 502 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("compare_api_failed");
      expect(result.skipReason).not.toContain("auth_failed");
    });

    it("404 from compare API classifies as branch-absent (not auth_failed, not compare_api_failed), failing open with branch_absent_on_remote when no issue-attributable commits exist", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      mockGitProbe("5", "0");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/git/ref/heads/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("branch_absent_on_remote:SUP-12686-test-branch");
      expect(result.skipReason).not.toContain("auth_failed");
      expect(result.skipReason).not.toContain("compare_api_failed");
    });
  });

  describe("unhydrated_linked_prs survives fail-open paths", () => {
    it("preserves unhydrated_linked_prs:<n> alongside auth_failed:compare:401 on the fail-open path", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 279, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#279", cachedState: null },
      ]);
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipReason).toMatch(/unhydrated_linked_prs:1/);
      expect(result.skipReason).toContain("auth_failed:compare:401");
    });

    it("preserves unhydrated_linked_prs:<n> alongside token_missing on the fail-open path", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip", number: 279, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip#279", cachedState: null },
      ]);
      mockResolveGitHubToken.mockResolvedValue({ token: null, scope: null, secretName: null });
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipReason).toMatch(/unhydrated_linked_prs:1/);
      expect(result.skipReason).toContain("token_missing");
    });
  });

  describe("no branch recorded", () => {
    it("allows transition when execution workspace has no branchName", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: null })],
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("no recorded branch");
    });
  });

  describe("PR #221 shape (squash-merged, ahead_by: 1)", () => {
    it("allows transition for a squash-merged branch reporting ahead_by: 1", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: "SUP-12345-test-branch" })],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 1 }), { status: 200 });
        }
        if (url.includes("/pulls?")) {
          return new Response(
            JSON.stringify([
              { state: "closed", merged: true, merged_at: "2026-08-13T12:00:00Z", draft: false },
            ]),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.aheadBy).toBe(1);
    });
  });

  describe("compare-404 branch probe (SUP-13831)", () => {
    it("classifies compare-404 with an existing remote branch as base-ref-unresolvable, never branch-absent", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      mockGitProbe("5", "1");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/git/ref/heads/")) {
          return new Response(JSON.stringify({ ref: "refs/heads/SUP-12686-test-branch" }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("compare_404_base_ref_unresolvable:SUP-12686-test-branch");
      expect(result.skipReason).not.toContain("branch_absent_on_remote");
      expect(result.reason).toContain("SUP-12686-test-branch exists on the remote");
      expect(result.reason).toContain("fold/tea-patches-v2026.722.0");
    });

    it("lets a DECISION-CARRYING transition through with the branch present and logs the exemption", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      mockGitProbe("5", "1");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/git/ref/heads/")) {
          return new Response(JSON.stringify({ ref: "refs/heads/SUP-12686-test-branch" }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null, true);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.aheadBy).toBeNull();
      expect(result.branch).toBe("SUP-12686-test-branch");
      expect(result.reason).toContain("Decision-carrying transition allowed");
      expect(result.reason).toContain("arms the merge");
      expect(result.skipReason).toBeNull();
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_guard_skipped",
          details: expect.objectContaining({
            reason: "compare_404_base_ref_unresolvable_decision_carried:SUP-12686-test-branch",
          }),
        }),
      );
    });

    it("fails open with branch_probe_failed when the ref probe returns an unexpected status", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      mockGitProbe("5", "1");
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/git/ref/heads/")) {
          return new Response(JSON.stringify({ message: "Bad gateway" }), { status: 502 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("branch_probe_failed:SUP-12686-test-branch");
      expect(result.skipReason).not.toContain("branch_absent_on_remote");
      expect(result.reason).toContain("could not be measured");
    });

    it("classifies a probe credential rejection distinctly as auth_failed:branch_probe", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("/git/ref/heads/")) {
          return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("auth_failed:branch_probe:401");
      expect(result.skipReason).not.toContain("branch_absent_on_remote");
    });
  });

  describe("live open-PR discovery when zero linked rows are cached (SUP-13831)", () => {
    const prItems = [
      {
        number: 3264,
        draft: false,
        headRef: "SUP-12345-work",
        title: "fix(SUP-12345): rework the transition guard",
        body: null,
      },
    ];

    it("discovers the open PR via the live list and lets a DECISION-CARRYING transition through (arms the merge)", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      mockFetchOpenPullRequests.mockResolvedValue({ ok: true, status: 200, message: null, items: prItems });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/pulls/3264")) {
          return new Response(JSON.stringify({ state: "open" }), { status: 200 });
        }
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null, true);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.reason).toContain("1 open linked PR");
      expect(result.reason).toContain("TEA-Core/paperclip#3264");
      expect(result.skipReason).toContain("live_linked_pr_discovered:1");
      expect(logActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.done_transition_guard_skipped",
          details: expect.objectContaining({
            reason: "open_linked_prs_decision_carried:1",
            prs: "TEA-Core/paperclip#3264",
          }),
        }),
      );
    });

    it("blocks a plain close on the live-discovered open PR", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      mockFetchOpenPullRequests.mockResolvedValue({ ok: true, status: 200, message: null, items: prItems });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/pulls/3264")) {
          return new Response(JSON.stringify({ state: "open" }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.reason).toContain("1 open linked PR");
      expect(result.reason).toContain("TEA-Core/paperclip#3264");
      expect(result.skipReason).toBeNull();
    });

    it("counts a failed live list in skipReason and continues with the compare flow", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: "SUP-12345-test-branch" })],
      });
      mockFetchOpenPullRequests.mockResolvedValue({ ok: false, status: 500, message: "internal", items: [] });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.aheadBy).toBe(0);
      expect(result.skipReason).toContain("live_pr_discovery_failed:HTTP500");
    });

    it("stays silent when the live list is empty", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: "SUP-12345-test-branch" })],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.aheadBy).toBe(0);
      expect(result.skipReason).toBeNull();
      expect(mockFetchOpenPullRequests).toHaveBeenCalledTimes(1);
    });

    it("excludes draft and non-matching PRs from the live list", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow({ branchName: "SUP-12345-test-branch" })],
      });
      mockFetchOpenPullRequests.mockResolvedValue({
        ok: true,
        status: 200,
        message: null,
        items: [
          { number: 1, draft: true, headRef: "SUP-12345-draft", title: "draft", body: null },
          { number: 2, draft: false, headRef: "feature/unrelated", title: "unrelated change", body: null },
        ],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.aheadBy).toBe(0);
      expect(result.skipReason).toBeNull();
    });
  });
});

describe("evaluateDoneTierDeclaration", () => {
  const tierIssue = {
    id: "issue-1",
    companyId: "company-1",
    identifier: "SUP-12345",
  };

  function mockComment(body: string, runId: string | null = null) {
    return {
      id: "comment-1",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "agent" as const,
      authorAgentId: "agent-1",
      authorUserId: null,
      createdByRunId: runId,
      derivedCreatedByRunId: runId,
      derivedAuthorSource: null,
      body,
      presentation: null,
      metadata: null,
      deletedAt: null,
      deletedByType: null,
      deletedByAgentId: null,
      deletedByUserId: null,
      deletedByRunId: null,
      sourceTrust: null,
      followUpRequested: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  describe("Tier 2 via accompanying comment", () => {
    it("allows transition with well-formed Tier 2 declaration and non-empty evidence", async () => {
      const result = await evaluateDoneTierDeclaration(
        mockDb,
        tierIssue,
        "Closed at Tier 2 (live): probe output shows the fix is live.",
        null,
        () => Promise.resolve([]),
      );
      expect(result.allowed).toBe(true);
      expect(result.tier).toBe("tier2");
    });

    it("allows transition with Tier 2 declaration and evidence on the following line", async () => {
      const result = await evaluateDoneTierDeclaration(
        mockDb,
        tierIssue,
        "Some context\nClosed at Tier 2 (live):\nProbe output: fix confirmed live.",
        null,
        () => Promise.resolve([]),
      );
      expect(result.allowed).toBe(true);
      expect(result.tier).toBe("tier2");
    });

    it("rejects Tier 2 declaration with empty evidence and no following line", async () => {
      const result = await evaluateDoneTierDeclaration(
        mockDb,
        tierIssue,
        "Closed at Tier 2 (live):",
        null,
        () => Promise.resolve([]),
      );
      expect(result.allowed).toBe(false);
      expect(result.tier).toBe(null);
      expect(result.reason).toContain("Tier 2");
    });

    it("rejects Tier 2 declaration with only whitespace on the following line", async () => {
      const result = await evaluateDoneTierDeclaration(
        mockDb,
        tierIssue,
        "Closed at Tier 2 (live):\n   ",
        null,
        () => Promise.resolve([]),
      );
      expect(result.allowed).toBe(false);
      expect(result.tier).toBe(null);
    });
  });

  describe("Tier 1 via accompanying comment", () => {
    it("allows transition with well-formed Tier 1 substitution and non-empty reason", async () => {
      const result = await evaluateDoneTierDeclaration(
        mockDb,
        tierIssue,
        "Closed at Tier 1 (landed, not liveness-probed): production probe unavailable. Liveness unverified.",
        null,
        () => Promise.resolve([]),
      );
      expect(result.allowed).toBe(true);
      expect(result.tier).toBe("tier1");
    });

    it("rejects Tier 1 substitution with empty reason", async () => {
      const result = await evaluateDoneTierDeclaration(
        mockDb,
        tierIssue,
        "Closed at Tier 1 (landed, not liveness-probed): Liveness unverified.",
        null,
        () => Promise.resolve([]),
      );
      expect(result.allowed).toBe(false);
      expect(result.tier).toBe(null);
      expect(result.reason).toContain("empty");
    });

    it("rejects Tier 1 line missing the suffix", async () => {
      const result = await evaluateDoneTierDeclaration(
        mockDb,
        tierIssue,
        "Closed at Tier 1 (landed, not liveness-probed): some reason",
        null,
        () => Promise.resolve([]),
      );
      expect(result.allowed).toBe(false);
      expect(result.tier).toBe(null);
    });
  });

  describe("no accompanying comment — same-run comment lookup", () => {
    it("allows transition when same-run comment has Tier 2 declaration", async () => {
      const result = await evaluateDoneTierDeclaration(
        mockDb,
        tierIssue,
        null,
        "run-1",
        () => Promise.resolve([mockComment("Closed at Tier 2 (live): probe evidence here.", "run-1")]),
      );
      expect(result.allowed).toBe(true);
      expect(result.tier).toBe("tier2");
    });

    it("allows transition when same-run comment has Tier 1 substitution", async () => {
      const result = await evaluateDoneTierDeclaration(
        mockDb,
        tierIssue,
        null,
        "run-1",
        () => Promise.resolve([
          mockComment(
            "Closed at Tier 1 (landed, not liveness-probed): probe unavailable. Liveness unverified.",
            "run-1",
          ),
        ]),
      );
      expect(result.allowed).toBe(true);
      expect(result.tier).toBe("tier1");
    });

    it("rejects when same-run comment has no tier declaration", async () => {
      const result = await evaluateDoneTierDeclaration(
        mockDb,
        tierIssue,
        null,
        "run-1",
        () => Promise.resolve([mockComment("Fixed the bug.", "run-1")]),
      );
      expect(result.allowed).toBe(false);
      expect(result.tier).toBe(null);
      expect(result.reason).toContain("done-tier declaration");
    });

    it("rejects when no same-run comment exists", async () => {
      const result = await evaluateDoneTierDeclaration(
        mockDb,
        tierIssue,
        null,
        "run-1",
        () => Promise.resolve([mockComment("Fixed the bug.", "run-2")]),
      );
      expect(result.allowed).toBe(false);
      expect(result.tier).toBe(null);
    });

    it("rejects when no run id and no accompanying comment (no bare no-evidence allow)", async () => {
      const result = await evaluateDoneTierDeclaration(
        mockDb,
        tierIssue,
        null,
        null,
        () => Promise.resolve([]),
      );
      expect(result.allowed).toBe(false);
      expect(result.tier).toBe(null);
      expect(result.skipped).toBe(false);
      expect(result.skipReason).toBeNull();
      expect(result.reason).toContain("no done-tier declaration found");
      expect(result.reason).toContain("Closed at Tier 2 (live)");
      expect(result.reason).toContain("Liveness unverified");
    });
  });

  describe("fail-open on comment store errors", () => {
    it("allows transition when listComments throws", async () => {
      const result = await evaluateDoneTierDeclaration(
        mockDb,
        tierIssue,
        null,
        "run-1",
        () => Promise.reject(new Error("store unavailable")),
      );
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("comment_store_failed");
    });
  });

  describe("ordering with SUP-12686", () => {
    it("Tier 2 declaration in accompanying comment is accepted without GitHub API calls", async () => {
      const result = await evaluateDoneTierDeclaration(
        mockDb,
        tierIssue,
        "Closed at Tier 2 (live): probe confirms fix.",
        null,
        () => Promise.resolve([]),
      );
      expect(result.allowed).toBe(true);
      expect(result.tier).toBe("tier2");
    });
  });
});
