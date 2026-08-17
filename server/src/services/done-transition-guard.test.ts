import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  evaluateDoneTransitionGuard,
  evaluateDoneTierDeclaration,
  GitHubAuthError,
  type DoneTransitionOverride,
} from "./done-transition-guard.js";
import { logActivity } from "./activity-log.js";

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

function setupDbMock(rows: { executionWorkspaces?: Record<string, unknown>[]; projectWorkspaces?: Record<string, unknown>[]; projects?: Record<string, unknown>[] }) {
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
  (mockDb.select as any).mockImplementation((_cols?: any) => {
    let callCount = 0;
    const chains = [selectChain, selectChain2, selectChain3, selectChain4];
    return {
      from: function() {
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
vi.mock("./merge-arming.js", () => ({
  resolveLinkedPullRequestsWithState: mockResolveLinkedPullRequestsWithState,
}));

import { ghFetch } from "./github-fetch.js";

const ghFetchMock = vi.mocked(ghFetch);

describe("evaluateDoneTransitionGuard", () => {
  beforeEach(() => {
    ghFetchMock.mockReset();
    mockResolveLinkedPullRequestsWithState.mockReset();
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([]);
    vi.mocked(logActivity).mockClear();
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
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockResolvedValue(new Response(JSON.stringify({ ahead_by: 1 }), { status: 200 }));
      const result = await evaluateDoneTransitionGuard(mockDb, issue, override);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("deliver.sh");
    });
  });

  describe("open linked PRs block", () => {
    it("blocks transition when resolveLinkedPullRequests yields 1 PR, with no GitHub token configured (zero outbound fetch)", async () => {
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        { id: "pr-1", owner: "TEA-Core", repo: "paperclip-agent-tools", number: 274, nodeId: null, headRefName: null, displayName: "TEA-Core/paperclip-agent-tools#274", cachedState: "open" },
      ]);
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
        executionWorkspaces: [mockExecutionWorkspaceRow()],
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
        executionWorkspaces: [mockExecutionWorkspaceRow()],
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
        executionWorkspaces: [mockExecutionWorkspaceRow()],
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
        executionWorkspaces: [mockExecutionWorkspaceRow()],
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
  });

  describe("fail-open on errors", () => {
    it("allows transition when compare API returns 404", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
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
        executionWorkspaces: [mockExecutionWorkspaceRow()],
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
        executionWorkspaces: [mockExecutionWorkspaceRow()],
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
        executionWorkspaces: [mockExecutionWorkspaceRow()],
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

    it("404 from compare API still returns null ahead_by (not auth_failed)", async () => {
      setupDbMock({
        executionWorkspaces: [mockExecutionWorkspaceRow()],
      });
      ghFetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const result = await evaluateDoneTransitionGuard(mockDb, issue, null);
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).not.toContain("auth_failed");
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
        executionWorkspaces: [mockExecutionWorkspaceRow()],
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

    it("rejects when no run id and no accompanying comment", async () => {
      const result = await evaluateDoneTierDeclaration(
        mockDb,
        tierIssue,
        null,
        null,
        () => Promise.resolve([]),
      );
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("no_accompanying_comment_no_run_id");
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
