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
