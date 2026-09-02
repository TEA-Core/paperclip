import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  externalObjectMentions,
  externalObjects,
  issueExecutionDecisions,
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
    `Skipping merge-arming republish route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * SUP-14748: POST /issues/:id/merge-arming/republish — an operator-invocable
 * first-publish re-arm for a card whose `paperclip/approved` stamp was skipped.
 *
 * The first publish can skip for reasons only a human understands (a hand-merged
 * PR, a closed PR, a coordinating card that merely cited a PR, a head that moved
 * between approval and publish). This route is the only sanctioned recovery: it
 * re-runs publishApprovalStatus verbatim — pinned to the decision-time head,
 * delivery-identity enforced — instead of a human hand-writing the status, which
 * would manufacture a fake approval. Board owner/admin only; an agent caller is
 * refused before any GitHub read or write.
 */

const GITHUB_TOKEN = "ghp_test_token_value";
const HEAD_SHA = "abc123def456789012345678901234567890abcd";
const OTHER_HEAD_SHA = "def456abc789012345678901234567890abc1234";
const DELIVERY_BRANCH = "SUP-14748-delivery";
const FOREIGN_BRANCH = "SUP-99999-other-card-branch";
const REPO_URL = "https://github.com/TEA-Core/paperclip";
const OWNER = "TEA-Core";
const REPO = "paperclip";
const PR_NUMBER = 42;
// issue_execution_decisions.stage_id is a uuid column, so the stage id must be a
// valid UUID (it is also the JSONB key shared with executionPolicy.stages and
// executionState.completedStageIds).
const STAGE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "cloud-user-1";

function createMockResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describeEmbeddedPostgres("POST /issues/:id/merge-arming/republish (SUP-14748)", () => {
  let db: Db;
  let app: express.Express;
  let currentActor: Express.Request["actor"];
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousSchedulingSuppression: string | undefined;

  beforeAll(async () => {
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-merge-arming-republish-");
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

  beforeEach(async () => {
    mockGhFetch.mockReset();
    mockGetByName.mockReset();
    mockResolveSecretValue.mockReset();
    mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
    mockResolveSecretValue.mockResolvedValue(GITHUB_TOKEN);

    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(issueExecutionDecisions);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
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

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: USER_ID,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      source: "cloud_tenant",
    } as unknown as Express.Request["actor"];
  }

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: randomUUID(),
    } as unknown as Express.Request["actor"];
  }

  interface SeedOptions {
    membershipRole?: string;
    lastDecisionOutcome?: string | null;
    skippedStageIds?: string[];
    completedStageIds?: string[];
    seedDecision?: boolean;
    /**
     * ADR-092: cast the approving decision row from the resolved return assignee
     * (the guard-b illegal shape) instead of the default reviewer. With the seed's
     * declared `returnAssigneeAgentId`, this makes the return assignee decide its
     * own completed stage — the shape guard-b refuses.
     */
    returnAssigneeDecides?: boolean;
    /** Seed a linked PR external object + mention. */
    pr?: { owner: string; repo: string; number: number; headRefName: string | null } | null;
    deliveryBranch?: string | null;
    deliveryRepoUrl?: string | null;
    /** Pre-seed executionState.approvalStatus.publishedHeadSha (idempotent path). */
    prePublishedHeadSha?: string | null;
  }

  async function seedIssue(opts: SeedOptions = {}) {
    const companyId = randomUUID();
    const reviewerAgentId = randomUUID();
    const returnAssigneeAgentId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const identifier = "SUP-14748-1";
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Republish Co",
      issuePrefix: "SUP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: USER_ID,
      status: "active",
      membershipRole: opts.membershipRole ?? "owner",
      updatedAt: now,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "TEA-Core/paperclip",
      status: "in_progress",
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
      id: reviewerAgentId,
      companyId,
      name: "Reviewer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // ADR-092: the card carries a declared return assignee distinct from the
    // reviewer/assignee that casts the approving decision, so the seed is a
    // guard-b-legal card by default and the happy-path tests reach their intended
    // head-resolution / publish behaviors instead of tripping the D3 fallback.
    await db.insert(agents).values({
      id: returnAssigneeAgentId,
      companyId,
      name: "Return Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const deliveryBranch = opts.deliveryBranch === undefined ? DELIVERY_BRANCH : opts.deliveryBranch;
    const deliveryRepoUrl =
      opts.deliveryRepoUrl === undefined ? REPO_URL : opts.deliveryRepoUrl;
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated",
      strategyType: "git_worktree",
      name: "card-workspace",
      status: "active",
      branchName: deliveryBranch,
      repoUrl: deliveryRepoUrl,
      createdAt: now,
      updatedAt: now,
    });

    const executionState: Record<string, unknown> = {
      status: "completed",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: null,
      completedStageIds: opts.completedStageIds ?? [STAGE_ID],
      skippedStageIds: opts.skippedStageIds ?? [],
      lastDecisionId: null,
      lastDecisionOutcome:
        opts.lastDecisionOutcome === undefined ? "approved" : opts.lastDecisionOutcome,
      monitor: null,
      changesRequestedCount: 0,
    };
    if (opts.prePublishedHeadSha) {
      executionState.approvalStatus = {
        publishedHeadSha: opts.prePublishedHeadSha,
        publishedAt: now.toISOString(),
      };
    }

    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier,
      issueNumber: 1,
      title: "Republish target card",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: reviewerAgentId,
      createdByUserId: USER_ID,
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        // ADR-092 D3: declare a return assignee distinct from the assignee/decision
        // actor so the resolved gated principal does not collide with the reviewer
        // that cast the approval (keeps the happy-path card guard-b-legal).
        returnAssigneeAgentId,
        stages: [{ id: STAGE_ID, type: "approval", approvalsNeeded: 1 }],
      },
      executionState,
    });

    if (opts.seedDecision !== false) {
      await db.insert(issueExecutionDecisions).values({
        companyId,
        issueId,
        stageId: STAGE_ID,
        stageType: "approval",
        actorAgentId: opts.returnAssigneeDecides ? returnAssigneeAgentId : reviewerAgentId,
        actorUserId: null,
        outcome: "approved",
        body: "Approved",
        createdAt: now,
        updatedAt: now,
      });
    }

    if (opts.pr) {
      const obj = {
        companyId,
        providerKey: "github",
        objectType: "pull_request" as const,
        externalId: `${opts.pr.owner}/${opts.pr.repo}#pull/${opts.pr.number}`,
        data: {
          state: "open",
          draft: false,
          node_id: "PR_node_id_12345",
          ...(opts.pr.headRefName !== null ? { headRef: opts.pr.headRefName } : {}),
        },
      };
      const [externalObj] = await db.insert(externalObjects).values(obj).returning();
      await db.insert(externalObjectMentions).values({
        companyId,
        sourceIssueId: issueId,
        sourceKind: "issue_comment",
        objectId: externalObj!.id,
        objectType: "pull_request",
        providerKey: "github",
      });
    }

    return { companyId, issueId, identifier, reviewerAgentId };
  }

  it("rejects an agent caller with 403 before any GitHub read or write", async () => {
    const { companyId, issueId, reviewerAgentId } = await seedIssue({
      pr: { owner: OWNER, repo: REPO, number: PR_NUMBER, headRefName: DELIVERY_BRANCH },
    });
    currentActor = agentActor(companyId, reviewerAgentId);

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(403);
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("rejects a board caller without owner/admin membership with 403", async () => {
    const { companyId, issueId } = await seedIssue({
      membershipRole: "operator",
      pr: { owner: OWNER, repo: REPO, number: PR_NUMBER, headRefName: DELIVERY_BRANCH },
    });
    currentActor = boardActor(companyId);

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(403);
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("refuses with 409 when the card has no recorded approved decision", async () => {
    const { companyId, issueId } = await seedIssue({
      lastDecisionOutcome: "changes_requested",
    });
    currentActor = boardActor(companyId);

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("no_approved_decision");
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("refuses with 409 when the approval record fails ADR-073 stage-integrity (skipped stage)", async () => {
    const { companyId, issueId } = await seedIssue({
      lastDecisionOutcome: "approved",
      skippedStageIds: [STAGE_ID],
    });
    currentActor = boardActor(companyId);

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("guard-b:skipped-stage");
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("refuses with 409 when a completed stage has no recorded decision row", async () => {
    // lastDecisionOutcome is approved (Guard A passes) but the completed stage has
    // no issue_execution_decisions row: the "approval" is not backed by a real
    // decision, so stage-integrity (Guard B) refuses before any GitHub read.
    const { companyId, issueId } = await seedIssue({
      lastDecisionOutcome: "approved",
      seedDecision: false,
    });
    currentActor = boardActor(companyId);

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("guard-b:stage-without-decision");
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("refuses with 409 when the resolved return assignee decided its own completed stage", async () => {
    // ADR-092: guard-b gates on the resolved return assignee
    // (policy.returnAssigneeAgentId ?? state.returnAssignee ?? assignee). The card's
    // creator term is no longer an input (D2), so an author self-approval no longer
    // trips this guard; instead, when the declared return assignee cast the
    // completed stage's decision, stage-integrity (Guard B) refuses it.
    const { companyId, issueId } = await seedIssue({
      lastDecisionOutcome: "approved",
      returnAssigneeDecides: true,
    });
    currentActor = boardActor(companyId);

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("guard-b:decision-by-return-assignee");
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("answers 200 already_published when the stamp is already published, with no GitHub writes", async () => {
    const { companyId, issueId } = await seedIssue({
      lastDecisionOutcome: "approved",
      prePublishedHeadSha: HEAD_SHA,
    });
    currentActor = boardActor(companyId);

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("already_published");
    expect(res.body.headSha).toBe(HEAD_SHA);
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("refuses with 409 head_unresolvable when no open linked PR can be resolved", async () => {
    // No linked PR and no delivery repo to probe: the decision head cannot be
    // positively resolved, so the route fails closed without touching GitHub.
    const { companyId, issueId } = await seedIssue({
      pr: null,
      deliveryBranch: null,
      deliveryRepoUrl: null,
    });
    currentActor = boardActor(companyId);

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("head_unresolvable");
    expect(res.body.message).toContain("no-pr");
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("refuses with 409 when the linked PR is not this card's delivery branch", async () => {
    // The card cited a PR on a different branch: the delivery-identity gate
    // refuses before any GitHub read (narrowing is DB-only).
    const { companyId, issueId } = await seedIssue({
      pr: { owner: OWNER, repo: REPO, number: PR_NUMBER, headRefName: FOREIGN_BRANCH },
    });
    currentActor = boardActor(companyId);

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("head_unresolvable");
    expect(res.body.message).toContain("not_delivered");
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("re-publishes and persists the certified head when the card is approvable and delivered", async () => {
    const { companyId, issueId } = await seedIssue({
      pr: { owner: OWNER, repo: REPO, number: PR_NUMBER, headRefName: DELIVERY_BRANCH },
    });
    currentActor = boardActor(companyId);

    mockGhFetch
      .mockResolvedValueOnce(createMockResponse({ head: { sha: HEAD_SHA }, html_url: `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}` }))
      .mockResolvedValueOnce(createMockResponse({ head: { sha: HEAD_SHA } }))
      .mockResolvedValueOnce(createMockResponse({ id: 12345 }));

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("armed");
    expect(res.body.headSha).toBe(HEAD_SHA);
    expect(res.body.message).toContain("paperclip/approved");
    // resolve head (1) + publish fetch head (1) + write status (1)
    expect(mockGhFetch).toHaveBeenCalledTimes(3);
    const statusCall = mockGhFetch.mock.calls[2]!;
    expect(statusCall[0]).toBe(`https://api.github.com/repos/${OWNER}/${REPO}/statuses/${HEAD_SHA}`);
    expect(statusCall[1]).toMatchObject({ method: "POST" });
    const body = JSON.parse(statusCall[1]!.body as string);
    expect(body.context).toBe("paperclip/approved");
    expect(body.state).toBe("success");

    // The certified head is persisted so Guard A / the enforcer can verify it.
    const [row] = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(issues.id === issueId);
    const approvalStatus = (row?.executionState ?? {})?.approvalStatus as Record<string, unknown> | undefined;
    expect(approvalStatus?.publishedHeadSha).toBe(HEAD_SHA);
  });

  it("refuses with 409 head_moved when the head moves between resolve and publish, zero status writes", async () => {
    const { companyId, issueId } = await seedIssue({
      pr: { owner: OWNER, repo: REPO, number: PR_NUMBER, headRefName: DELIVERY_BRANCH },
    });
    currentActor = boardActor(companyId);

    // The decision-time head resolves to HEAD_SHA, but by publish time the PR head
    // has moved to OTHER_HEAD_SHA — the publish must refuse (head_moved), no status
    // written.
    mockGhFetch
      .mockResolvedValueOnce(createMockResponse({ head: { sha: HEAD_SHA } }))
      .mockResolvedValueOnce(createMockResponse({ head: { sha: OTHER_HEAD_SHA } }));

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(409);
    expect(res.body.outcome).toBe("skipped");
    expect(res.body.message).toContain("head_moved");
    // Only the two head reads; the status write is never reached.
    expect(mockGhFetch).toHaveBeenCalledTimes(2);
    const [row] = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(issues.id === issueId);
    const approvalStatus = (row?.executionState ?? {})?.approvalStatus as Record<string, unknown> | undefined;
    expect(approvalStatus?.publishedHeadSha).toBeUndefined();
  });

  it("is idempotent: a second invocation after arming answers already_published", async () => {
    const { companyId, issueId } = await seedIssue({
      pr: { owner: OWNER, repo: REPO, number: PR_NUMBER, headRefName: DELIVERY_BRANCH },
    });
    currentActor = boardActor(companyId);

    mockGhFetch
      .mockResolvedValueOnce(createMockResponse({ head: { sha: HEAD_SHA } }))
      .mockResolvedValueOnce(createMockResponse({ head: { sha: HEAD_SHA } }))
      .mockResolvedValueOnce(createMockResponse({ id: 12345 }));

    const first = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);
    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe("armed");

    mockGhFetch.mockClear();
    const second = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);
    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe("already_published");
    expect(second.body.headSha).toBe(HEAD_SHA);
    // The second call short-circuits before touching GitHub.
    expect(mockGhFetch).not.toHaveBeenCalled();
  });
});
