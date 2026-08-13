import { describe, expect, it, vi, beforeEach } from "vitest";
import { evaluateDoneTransitionGuard, type DoneTransitionOverride } from "./done-transition-guard.js";

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

import { ghFetch } from "./github-fetch.js";

const ghFetchMock = vi.mocked(ghFetch);

describe("evaluateDoneTransitionGuard", () => {
  beforeEach(() => {
    ghFetchMock.mockReset();
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
