import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  issues,
  projectWorkspaces,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockResolveSecretValue = vi.hoisted(() => vi.fn());
const mockGetByName = vi.hoisted(() => vi.fn());
const mockGhFetch = vi.hoisted(() => vi.fn());

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    getByName: mockGetByName,
    resolveSecretValue: mockResolveSecretValue,
  }),
}));

vi.mock("../services/github-fetch.js", () => ({
  ghFetch: mockGhFetch,
  gitHubApiBase: (hostname: string) =>
    hostname === "github.com" || hostname === "www.github.com"
      ? "https://api.github.com"
      : `https://${hostname}/api/v3`,
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping done-transition ordering route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("done-transition guard ordering (SUP-12686 before tier declaration)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let currentActor!: Express.Request["actor"];
  let previousSchedulingSuppression: string | undefined;

  beforeAll(async () => {
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-done-transition-ordering-");
    db = createDb(tempDb.connectionString);
    app = createApp();
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousSchedulingSuppression === undefined) {
      delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    } else {
      process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = previousSchedulingSuppression;
    }
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = currentActor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedIssue(issuePrefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const identifier = `${issuePrefix}-1`;
    const branchName = "SUP-12686-test-branch";
    const repoUrl = "https://github.com/TEA-Core/paperclip";
    const defaultRef = "fold/tea-patches-v2026.722.0";
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: now,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test Project",
      status: "active",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "HEAD",
          branchTemplate: "{{issue.identifier}}-recorded",
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: "/tmp/test",
      isPrimary: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: null,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: branchName,
      status: "active",
      cwd: "/tmp/test",
      repoUrl,
      baseRef: defaultRef,
      branchName,
      providerType: "git_worktree",
      providerRef: "/tmp/test",
      lastUsedAt: now,
      openedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier,
      title: "Tier-0 guard must fire before tier declaration check",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "cloud-user-1",
      executionWorkspaceId,
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId: issueId })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));

    return { companyId, agentId, issueId, identifier, branchName, repoUrl, defaultRef };
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId,
    };
  }

  function unresolvableRunId() {
    return randomUUID();
  }

  it("Tier-0 409 (done_transition_missing_delivery) fires before tier declaration check on a branch-ahead/no-merged-PR issue with no declaration", async () => {
    const { companyId, agentId, issueId, identifier } = await seedIssue("ORD");
    const runId = unresolvableRunId();
    currentActor = agentActor(companyId, agentId, runId);

    mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
    mockResolveSecretValue.mockResolvedValue("test-token");
    mockGhFetch.mockImplementation(async (url: string) => {
      if (url.includes("/compare/")) {
        return new Response(JSON.stringify({ ahead_by: 3 }), { status: 200 });
      }
      if (url.includes("/pulls?")) {
        return new Response(JSON.stringify([{ merged: false, merged_at: null }]), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe("done_transition_missing_delivery");
    expect(res.body.code).not.toBe("done_transition_missing_tier_declaration");
    expect(typeof res.body.details.aheadBy).toBe("number");
    expect(res.body.details.aheadBy).toBe(3);

    const statusRows = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(statusRows[0]?.status).toBe("todo");
  });
});
