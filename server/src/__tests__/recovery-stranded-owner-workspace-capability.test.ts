import { describe, expect, it } from "vitest";
import { canAgentSatisfyIssueWorkspaceSettings } from "../services/execution-workspace-policy.ts";

describe("recovery stranded-owner workspace capability filter", () => {
  it("rejects an isolated git_worktree issue with no project or reusable workspace (the SUP-13078 live case)", () => {
    expect(
      canAgentSatisfyIssueWorkspaceSettings({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree" },
        },
        projectPolicy: null,
      }),
    ).toBe(false);
  });

  it("rejects an isolated issue with project policy specifying git_worktree but no project binding (the live case)", () => {
    // The issue's executionWorkspaceSettings has mode: isolated_workspace but no workspaceStrategy.
    // The project policy specifies workspaceStrategy: { type: "git_worktree" }.
    // The issue has no projectId, so no project workspace is available → agent_home fallback → refusal.
    expect(
      canAgentSatisfyIssueWorkspaceSettings({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        executionWorkspaceSettings: { mode: "isolated_workspace" },
        projectPolicy: {
          enabled: true,
          defaultMode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree" },
          allowIssueOverride: true,
        },
      }),
    ).toBe(false);
  });

  it("accepts an isolated git_worktree issue when a project is bound (positive arm)", () => {
    expect(
      canAgentSatisfyIssueWorkspaceSettings({
        issue: {
          projectId: "project-1",
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree" },
        },
        projectPolicy: null,
      }),
    ).toBe(true);
  });

  it("accepts an isolated git_worktree issue when a reusable execution workspace is bound", () => {
    expect(
      canAgentSatisfyIssueWorkspaceSettings({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: "workspace-1",
          executionWorkspacePreference: "reuse_existing",
        },
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree" },
        },
        projectPolicy: null,
      }),
    ).toBe(true);
  });

  it("accepts a non-worktree mode unconditionally (shared_workspace)", () => {
    expect(
      canAgentSatisfyIssueWorkspaceSettings({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        executionWorkspaceSettings: { mode: "shared_workspace" },
        projectPolicy: null,
      }),
    ).toBe(true);
  });

  it("accepts a non-worktree mode unconditionally (agent_default)", () => {
    expect(
      canAgentSatisfyIssueWorkspaceSettings({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        executionWorkspaceSettings: { mode: "agent_default" },
        projectPolicy: null,
      }),
    ).toBe(true);
  });

  it("accepts an operator_branch git_worktree issue when a prior session workspace is resolvable", () => {
    expect(
      canAgentSatisfyIssueWorkspaceSettings({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        executionWorkspaceSettings: {
          mode: "operator_branch",
          workspaceStrategy: { type: "git_worktree" },
        },
        projectPolicy: null,
        hasResolvablePriorSessionWorkspace: true,
      }),
    ).toBe(true);
  });

  it("operator_branch with project_primary strategy (default) is not blocked by the git_worktree predicate", () => {
    // buildExecutionWorkspaceAdapterConfig deletes workspaceStrategy for operator_branch mode,
    // so the effective strategy is project_primary (not git_worktree). The git_worktree_base_agent_home
    // refusal does not fire; project_primary_base_agent_home is a separate predicate.
    expect(
      canAgentSatisfyIssueWorkspaceSettings({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        executionWorkspaceSettings: {
          mode: "operator_branch",
          workspaceStrategy: { type: "git_worktree" },
        },
        projectPolicy: null,
      }),
    ).toBe(true);
  });

  it("accepts an isolated git_worktree issue when no settings are provided (null)", () => {
    expect(
      canAgentSatisfyIssueWorkspaceSettings({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        executionWorkspaceSettings: null,
        projectPolicy: null,
      }),
    ).toBe(true);
  });

  it("keeps a candidate whose adapterConfig does not restate the issue git_worktree strategy", () => {
    // Dispatch resolves the workspace strategy with buildExecutionWorkspaceAdapterConfig, which
    // puts the agent adapterConfig BELOW the issue settings and the project policy. An empty or
    // project_primary adapterConfig therefore still resolves to the issue's git_worktree strategy
    // and runs, so it must not disqualify the candidate — rejecting on a raw-config mismatch
    // would strand every project-bound worktree issue at board escalation.
    const issue = {
      projectId: "project-1",
      projectWorkspaceId: "ws-1",
      executionWorkspaceId: "exec-1",
      executionWorkspacePreference: "reuse_existing" as const,
    };
    const executionWorkspaceSettings = {
      mode: "isolated_workspace" as const,
      workspaceStrategy: { type: "git_worktree" as const },
    };
    const projectPolicy = {
      enabled: true,
      defaultMode: "isolated_workspace" as const,
      workspaceStrategy: { type: "git_worktree" as const },
      allowIssueOverride: true,
    };
    expect(
      canAgentSatisfyIssueWorkspaceSettings({
        issue,
        executionWorkspaceSettings,
        projectPolicy,
        agentConfig: {},
      }),
    ).toBe(true);
    expect(
      canAgentSatisfyIssueWorkspaceSettings({
        issue,
        executionWorkspaceSettings,
        projectPolicy,
        agentConfig: { workspaceStrategy: { type: "project_primary" } },
      }),
    ).toBe(true);
  });

  it("lets the agent adapterConfig decide the strategy only when neither issue nor project pins one", () => {
    const issue = {
      projectId: null,
      projectWorkspaceId: null,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
    };
    // Nothing pins a strategy, so isolated_workspace defaults to git_worktree with no project
    // and no reusable workspace to base it on: the same combination dispatch refuses.
    expect(
      canAgentSatisfyIssueWorkspaceSettings({
        issue,
        executionWorkspaceSettings: { mode: "isolated_workspace" },
        projectPolicy: null,
        agentConfig: {},
      }),
    ).toBe(false);
    // The candidate pins a non-worktree strategy at the lowest precedence level, so the
    // git_worktree refusal cannot fire and the candidate stays on the ladder.
    expect(
      canAgentSatisfyIssueWorkspaceSettings({
        issue,
        executionWorkspaceSettings: { mode: "isolated_workspace" },
        projectPolicy: null,
        agentConfig: { workspaceStrategy: { type: "adapter_managed" } },
      }),
    ).toBe(true);
  });

  it("keeps a project-bound git_worktree candidate for an isolated git_worktree issue", () => {
    expect(
      canAgentSatisfyIssueWorkspaceSettings({
        issue: {
          projectId: "project-1",
          projectWorkspaceId: "ws-1",
          executionWorkspaceId: "exec-1",
          executionWorkspacePreference: "reuse_existing",
        },
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree" },
        },
        projectPolicy: {
          enabled: true,
          defaultMode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree" },
          allowIssueOverride: true,
        },
        agentConfig: { workspaceStrategy: { type: "git_worktree" } },
      }),
    ).toBe(true);
  });
});
