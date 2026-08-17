import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  externalObjectMentions,
  externalObjects,
  heartbeatRuns,
  issueComments,
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
const mockAddComment = vi.hoisted(() => vi.fn());
const realAddCommentRef = vi.hoisted(() => ({ current: null as ((...args: any[]) => any) | null }));

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

vi.mock("../services/issues.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issues.js")>();
  return {
    ...actual,
    issueService: (db: Db) => {
      const real = actual.issueService(db);
      realAddCommentRef.current = real.addComment;
      mockAddComment.mockImplementation(real.addComment);
      return {
        ...real,
        addComment: mockAddComment,
      };
    },
  };
});

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

  beforeEach(() => {
    mockGhFetch.mockReset();
    mockGetByName.mockReset();
    mockResolveSecretValue.mockReset();
    mockAddComment.mockImplementation(realAddCommentRef.current!);
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

  async function seedLinkedPrs(
    companyId: string,
    issueId: string,
    prs: Array<{ owner: string; repo: string; number: number; state: string; draft: boolean }>,
  ) {
    for (const pr of prs) {
      const externalId = `${pr.owner}/${pr.repo}#pull/${pr.number}`;
      const [obj] = await db
        .insert(externalObjects)
        .values({
          companyId,
          providerKey: "github",
          objectType: "pull_request",
          externalId,
          sanitizedCanonicalUrl: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
          canonicalIdentityHash: `gh-pr-${pr.owner}/${pr.repo}/${pr.number}`,
          displayKey: externalId,
          displayTitle: `PR #${pr.number}`,
          data: {
            state: pr.state,
            draft: pr.draft,
            node_id: `PR_${pr.owner}_${pr.repo}_${pr.number}`,
            head: { ref: `SUP-${pr.number}-branch` },
            headRefName: `SUP-${pr.number}-branch`,
          },
        })
        .returning();
      await db.insert(externalObjectMentions).values({
        companyId,
        sourceIssueId: issueId,
        sourceKind: "description",
        matchedTextRedacted: externalId,
        sanitizedDisplayUrl: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
        canonicalIdentityHash: `gh-pr-${pr.owner}/${pr.repo}/${pr.number}`,
        canonicalIdentity: { url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}` },
        objectId: obj!.id,
        providerKey: "github",
        detectorKey: "github_pr",
        objectType: "pull_request",
      });
    }
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

  /**
   * A run this instance can resolve, anchored on the issue under test.
   *
   * Agent writes are contained per heartbeat run, and that guard runs ahead of
   * the done-transition guards this test is about — an unresolvable run gets a
   * 403 before either of them is reached. Anchoring the run on the same issue
   * also keeps the write off the cross-issue path entirely.
   */
  async function seedRun(companyId: string, agentId: string, issueId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId },
    });
    return runId;
  }

  it("Tier-0 409 (done_transition_missing_delivery) fires before tier declaration check on a branch-ahead/no-merged-PR issue with no declaration", async () => {
    const { companyId, agentId, issueId, identifier } = await seedIssue("ORD");
    currentActor = agentActor(companyId, agentId, await seedRun(companyId, agentId, issueId));

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

  it("auth_failed:compare:401 skip posts exactly one system comment with HTTP status and operator remedy, no token leak", async () => {
    const { companyId, agentId, issueId, identifier } = await seedIssue("AU1");
    currentActor = agentActor(companyId, agentId, await seedRun(companyId, agentId, issueId));

    mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
    mockResolveSecretValue.mockResolvedValue("test-token");
    mockGhFetch.mockImplementation(async (url: string) => {
      if (url.includes("/compare/")) {
        return new Response("", { status: 401 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({
        status: "done",
        comment:
          "Closed at Tier 1 (landed, not liveness-probed): guard skipped on auth failure. Liveness unverified.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const statusRows = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(statusRows[0]?.status).toBe("done");

    const comments = await vi.waitFor(
      async () => {
        const rows = await db
          .select({
            body: issueComments.body,
            authorType: issueComments.authorType,
          })
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId));
        const systemComments = rows.filter((r) => r.authorType === "system");
        if (systemComments.length === 0) throw new Error("waiting for system comment");
        return systemComments;
      },
      { timeout: 5000 },
    );

    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("401");
    expect(comments[0]?.body).toContain("SUP-13038");
    expect(comments[0]?.body).not.toContain("test-token");
  });

  it("non-auth skip (502 from compare) posts zero system comments", async () => {
    const { companyId, agentId, issueId, identifier } = await seedIssue("AU2");
    currentActor = agentActor(companyId, agentId, await seedRun(companyId, agentId, issueId));

    mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
    mockResolveSecretValue.mockResolvedValue("test-token");
    mockGhFetch.mockImplementation(async (url: string) => {
      if (url.includes("/compare/")) {
        return new Response(JSON.stringify({}), { status: 502 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({
        status: "done",
        comment:
          "Closed at Tier 1 (landed, not liveness-probed): guard skipped on auth failure. Liveness unverified.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const statusRows = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(statusRows[0]?.status).toBe("done");

    const comments = await db
      .select({ body: issueComments.body, authorType: issueComments.authorType })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    const systemComments = comments.filter((r) => r.authorType === "system");
    expect(systemComments).toHaveLength(0);
  });

  it("rejecting addComment does not prevent the done transition (fail-open)", async () => {
    const { companyId, agentId, issueId, identifier } = await seedIssue("AU3");
    currentActor = agentActor(companyId, agentId, await seedRun(companyId, agentId, issueId));

    mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
    mockResolveSecretValue.mockResolvedValue("test-token");
    mockGhFetch.mockImplementation(async (url: string) => {
      if (url.includes("/compare/")) {
        return new Response("", { status: 401 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    mockAddComment.mockImplementation(async (
      _issueId: string,
      _body: string,
      _actor: object,
      options?: { authorType?: string | null },
    ) => {
      if (options?.authorType === "system") {
        throw new Error("boom");
      }
      return realAddCommentRef.current!(_issueId, _body, _actor, options);
    });

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({
        status: "done",
        comment:
          "Closed at Tier 1 (landed, not liveness-probed): guard skipped on auth failure. Liveness unverified.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const statusRows = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(statusRows[0]?.status).toBe("done");

    const comments = await db
      .select({ body: issueComments.body, authorType: issueComments.authorType })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    const systemComments = comments.filter((r) => r.authorType === "system");
    expect(systemComments).toHaveLength(0);
    expect(comments.some((r) => r.body.includes("Tier 1"))).toBe(true);
  });

  it("SUP-13152 fixture: 5 open linked PRs block done with 409 even when GitHub token is 401 (token_missing path)", async () => {
    const { companyId, agentId, issueId, identifier } = await seedIssue("SUP13152");
    currentActor = agentActor(companyId, agentId, await seedRun(companyId, agentId, issueId));

    await seedLinkedPrs(companyId, issueId, [
      { owner: "TEA-Core", repo: "paperclip", number: 274, state: "open", draft: false },
      { owner: "TEA-Core", repo: "paperclip", number: 275, state: "open", draft: false },
      { owner: "TEA-Core", repo: "Trading-Signal-Platform", number: 3124, state: "open", draft: false },
      { owner: "TEA-Core", repo: "Trading-Signal-Platform", number: 3125, state: "open", draft: false },
      { owner: "TEA-Core", repo: "Trading-Signal-Platform", number: 3126, state: "open", draft: false },
    ]);

    mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
    mockResolveSecretValue.mockResolvedValue("test-token");
    mockGhFetch.mockImplementation(async (url: string) => {
      if (url.includes("/compare/")) {
        return new Response("", { status: 401 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({
        status: "done",
        comment:
          "Closed at Tier 1 (landed, not liveness-probed): guard skipped on auth failure. Liveness unverified.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe("done_transition_missing_delivery");
    expect(res.body.error).toContain("5 open linked PRs");
    expect(mockGhFetch).not.toHaveBeenCalled();

    const statusRows = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(statusRows[0]?.status).toBe("todo");
  });

  it("SUP-13152 fixture: 5 open linked PRs block done on auth_failed:compare:401 path (not skipped)", async () => {
    const { companyId, agentId, issueId, identifier } = await seedIssue("SUP13152B");
    currentActor = agentActor(companyId, agentId, await seedRun(companyId, agentId, issueId));

    await seedLinkedPrs(companyId, issueId, [
      { owner: "TEA-Core", repo: "paperclip", number: 274, state: "open", draft: false },
      { owner: "TEA-Core", repo: "paperclip", number: 275, state: "open", draft: false },
      { owner: "TEA-Core", repo: "Trading-Signal-Platform", number: 3124, state: "open", draft: false },
      { owner: "TEA-Core", repo: "Trading-Signal-Platform", number: 3125, state: "open", draft: false },
      { owner: "TEA-Core", repo: "Trading-Signal-Platform", number: 3126, state: "open", draft: false },
    ]);

    mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
    mockResolveSecretValue.mockResolvedValue("test-token");
    mockGhFetch.mockImplementation(async (url: string) => {
      if (url.includes("/compare/")) {
        return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({
        status: "done",
        comment:
          "Closed at Tier 1 (landed, not liveness-probed): guard skipped on auth failure. Liveness unverified.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe("done_transition_missing_delivery");
    expect(res.body.error).toContain("5 open linked PRs");

    const statusRows = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(statusRows[0]?.status).toBe("todo");
  });

  it("Tier 1 declaration override allows done with open linked PRs present", async () => {
    const { companyId, agentId, issueId, identifier } = await seedIssue("TIER1PR");
    currentActor = agentActor(companyId, agentId, await seedRun(companyId, agentId, issueId));

    await seedLinkedPrs(companyId, issueId, [
      { owner: "TEA-Core", repo: "paperclip", number: 274, state: "open", draft: false },
    ]);

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({
        status: "done",
        doneTransitionOverride: { disposition: "upstream-equivalent-fix-no-deliverable-head", reason: "Tier 1" },
        comment:
          "Closed at Tier 1 (landed, not liveness-probed): override path. Liveness unverified.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const statusRows = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(statusRows[0]?.status).toBe("done");
  });

  it("no linked PRs allows done transition to proceed to tier declaration check (green path)", async () => {
    const { companyId, agentId, issueId, identifier } = await seedIssue("NOPR");
    currentActor = agentActor(companyId, agentId, await seedRun(companyId, agentId, issueId));

    mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
    mockResolveSecretValue.mockResolvedValue("test-token");
    mockGhFetch.mockImplementation(async (url: string) => {
      if (url.includes("/compare/")) {
        return new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({
        status: "done",
        comment: "Closed at Tier 2 (live): probe confirms fix.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const statusRows = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(statusRows[0]?.status).toBe("done");
  });
});
