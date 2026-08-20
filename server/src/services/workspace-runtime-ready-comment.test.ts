import {
  ISSUE_COMMENT_METADATA_TEXT_MAX_LENGTH,
  issueCommentMetadataSchema,
} from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  buildWorkspaceReadyComment,
  buildWorkspaceReadyMetadata,
  buildWorkspaceReadyPresentation,
  type RealizedExecutionWorkspace,
  type RuntimeServiceRef,
} from "./workspace-runtime.js";

function workspace(
  overrides: Partial<RealizedExecutionWorkspace> = {},
): RealizedExecutionWorkspace {
  return {
    baseCwd: "/repo",
    source: "project_primary",
    projectId: "project-id",
    workspaceId: "project-workspace-id",
    repoUrl: null,
    repoRef: "main",
    strategy: "git_worktree",
    cwd: "/repo/.paperclip/worktrees/PAP-16051",
    branchName: "PAP-16051-workspace-ready-notice",
    worktreePath: "/repo/.paperclip/worktrees/PAP-16051",
    warnings: [],
    created: true,
    ...overrides,
  };
}

function runtimeService(
  overrides: Partial<RuntimeServiceRef> = {},
): RuntimeServiceRef {
  return {
    id: "service-id",
    companyId: "company-id",
    projectId: "project-id",
    projectWorkspaceId: "project-workspace-id",
    executionWorkspaceId: "execution-workspace-id",
    issueId: "issue-id",
    serviceName: "web",
    status: "running",
    lifecycle: "ephemeral",
    scopeType: "run",
    scopeId: "run-id",
    reuseKey: null,
    command: "pnpm dev",
    cwd: "/repo/.paperclip/worktrees/PAP-16051",
    port: 3100,
    url: "http://localhost:3100",
    provider: "local_process",
    providerRef: null,
    ownerAgentId: "agent-id",
    startedByRunId: "run-id",
    lastUsedAt: "2026-08-01T00:00:00.000Z",
    startedAt: "2026-08-01T00:00:00.000Z",
    stoppedAt: null,
    stopPolicy: null,
    healthStatus: "healthy",
    reused: false,
    ...overrides,
  };
}

describe("workspace-ready comment builders", () => {
  it("uses a compact info notice that is collapsed when the workspace has no warnings", () => {
    const input = { workspace: workspace(), runtimeServices: [] };

    expect(buildWorkspaceReadyPresentation(input)).toEqual({
      kind: "system_notice",
      tone: "info",
      title: "Workspace ready · PAP-16051-workspace-ready-notice",
      density: "compact",
      detailsDefaultOpen: false,
    });
  });

  it("uses a warning notice that is expanded when warnings are present", () => {
    const input = {
      workspace: workspace({ warnings: ["The worktree was restored from a stale reference."] }),
      runtimeServices: [],
    };

    expect(buildWorkspaceReadyPresentation(input)).toMatchObject({
      tone: "warning",
      detailsDefaultOpen: true,
    });
    expect(buildWorkspaceReadyMetadata(input).sections.at(-1)).toEqual({
      title: "Warnings",
      rows: [{ type: "text", text: "The worktree was restored from a stale reference." }],
    });
  });

  it("truncates the presentation title to 160 characters", () => {
    const presentation = buildWorkspaceReadyPresentation({
      workspace: workspace({ branchName: "b".repeat(200) }),
      runtimeServices: [],
    });

    expect(presentation.title).toHaveLength(160);
    expect(presentation.title).toBe(`${`Workspace ready · ${"b".repeat(200)}`.slice(0, 159)}…`);
  });

  it("falls back to the workspace strategy when no branch is available", () => {
    const presentation = buildWorkspaceReadyPresentation({
      workspace: workspace({ branchName: null, strategy: "project_primary" }),
      runtimeServices: [],
    });

    expect(presentation.title).toBe("Workspace ready · project_primary");
  });

  it("builds structured workspace and service sections without an empty warnings section", () => {
    const input = {
      workspace: workspace(),
      runtimeServices: [
        runtimeService(),
        runtimeService({
          id: "worker-service-id",
          serviceName: "worker",
          url: null,
          reused: true,
        }),
      ],
    };

    expect(buildWorkspaceReadyMetadata(input)).toEqual({
      version: 1,
      sections: [
        {
          title: "Workspace",
          rows: [
            { type: "key_value", label: "Strategy", value: "git_worktree" },
            { type: "key_value", label: "Branch", value: "PAP-16051-workspace-ready-notice" },
            { type: "key_value", label: "CWD", value: "/repo/.paperclip/worktrees/PAP-16051" },
          ],
        },
        {
          title: "Services",
          rows: [
            { type: "key_value", label: "web", value: "http://localhost:3100" },
            { type: "key_value", label: "worker", value: "running (reused)" },
          ],
        },
      ],
    });
  });

  it("keeps service labels within the comment metadata boundary", () => {
    const metadata = buildWorkspaceReadyMetadata({
      workspace: workspace(),
      runtimeServices: [runtimeService({ serviceName: `  ${"s".repeat(150)}  ` })],
    });
    const serviceLabel = metadata.sections[1]?.rows[0];

    expect(serviceLabel).toEqual({
      type: "key_value",
      label: `${"s".repeat(119)}…`,
      value: "http://localhost:3100",
    });
  });

  it("includes a distinct worktree row and preserves the existing markdown body", () => {
    const input = {
      workspace: workspace({
        cwd: "/repo/runtime",
        worktreePath: "/repo/.paperclip/worktrees/PAP-16051",
        warnings: ["Warning text"],
      }),
      runtimeServices: [runtimeService({ reused: true })],
    };

    expect(buildWorkspaceReadyMetadata(input).sections[0]).toEqual({
      title: "Workspace",
      rows: [
        { type: "key_value", label: "Strategy", value: "git_worktree" },
        { type: "key_value", label: "Branch", value: "PAP-16051-workspace-ready-notice" },
        { type: "key_value", label: "CWD", value: "/repo/runtime" },
        { type: "key_value", label: "Worktree", value: "/repo/.paperclip/worktrees/PAP-16051" },
      ],
    });
    expect(buildWorkspaceReadyComment(input)).toBe([
      "## Workspace Ready",
      "",
      "- Strategy: `git_worktree`",
      "- Branch: `PAP-16051-workspace-ready-notice`",
      "- CWD: `/repo/runtime`",
      "- Worktree: `/repo/.paperclip/worktrees/PAP-16051`",
      "- Warning: Warning text",
      "- Service: web: http://localhost:3100 (reused)",
    ].join("\n"));
  });
  // A workspace warning is unbounded provider text. When one exceeded the
  // metadata row cap the whole comment failed zod validation with
  // {"code":"too_big","maximum":2000,"path":["sections",1,"rows",0,"text"]},
  // so the workspace-ready signal never landed on the issue - on every run of
  // an affected agent.
  it("clamps an over-long warning so the metadata still validates", () => {
    const longWarning = `head ${"w".repeat(5_000)} tail`;
    const input = {
      workspace: workspace({ warnings: [longWarning] }),
      runtimeServices: [],
    };

    const metadata = buildWorkspaceReadyMetadata(input);
    const warningsSection = metadata.sections.at(-1);

    expect(warningsSection?.title).toBe("Warnings");
    const row = warningsSection?.rows[0];
    expect(row?.type).toBe("text");
    const text = row && row.type === "text" ? row.text : "";
    expect(text.length).toBe(ISSUE_COMMENT_METADATA_TEXT_MAX_LENGTH);
    expect(text.startsWith("head ")).toBe(true);
    expect(text.endsWith("\u2026")).toBe(true);
    expect(() => issueCommentMetadataSchema.parse(metadata)).not.toThrow();

    // The markdown body has no cap, so nothing is lost.
    expect(buildWorkspaceReadyComment(input)).toContain(longWarning);
  });
});
