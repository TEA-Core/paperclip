import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
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
  issueDeliveryReceipts,
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
import {
  GITHUB_APP_PRIVATE_KEY_SECRET_NAME,
  GITHUB_TOKEN_SECRET_NAMES,
} from "../services/github-credential.js";

const mockGetByName = vi.hoisted(() => vi.fn());
const mockResolveSecretValue = vi.hoisted(() => vi.fn());
const mockGhFetch = vi.hoisted(() => vi.fn());

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    getByName: mockGetByName,
    resolveSecretValue: mockResolveSecretValue,
  }),
}));

vi.mock("../services/github-fetch.js", () => ({
  ghFetch: (url: string, init?: RequestInit) => {
    // The arming actuator writes a `paperclip/arm-gate` status around every enable; GitHub accepts it here, apart from each test's own fake.
    if (typeof url === "string" && /\/statuses\//.test(url) && init?.method === "POST" && String(init.body ?? "").includes('"paperclip/arm-gate"')) {
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 9000 }) } as unknown as Response);
    }
    // SUP-21902: the done-transition guard resolves the declared probe head and the
    // delivery default branch tip through the commits API; the mocked remote serves
    // the same head for both, so the fixtures' named probe heads match the merge head.
    if (typeof url === "string" && /\/commits\//.test(url)) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ sha: "7d3f9c1e0a25b864d7f2c9e6a18b40c3d5e72f19" }) } as unknown as Response);
    }
    // An arm that names no head reads the PR's live head for the gate; a fake that does not model that read gets one.
    return Promise.resolve(mockGhFetch(url, init)).catch((error: unknown) => {
      if (typeof url === "string" && /\/pulls\/\d+$/.test(url) && /unmocked|unexpected/i.test(String((error as Error)?.message))) {
        return { ok: true, status: 200, json: async () => ({ head: { sha: "c".repeat(40), ref: "live-head" }, state: "open", draft: false, merged: false }) } as unknown as Response;
      }
      throw error;
    });
  },
  gitHubApiBase: (hostname: string) =>
    hostname === "github.com" ? "https://api.github.com" : `https://${hostname}/api/v3`,
}));

const GITHUB_TOKEN = "test-token";
const OWNER = "TEA-Core";
const REPO = "paperclip";
const PR_NUMBER = 676;
const NODE_ID = "PR_node_676";
const DELIVERY_BRANCH = "SUP-676-branch";
const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PR_URL = `https://api.github.com/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`;
const GRAPHQL_URL = "https://api.github.com/graphql";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping real-transport merge-arming route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("approval arming fires the real actuator through transport (SUP-16130)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let currentActor!: Express.Request["actor"];

  beforeAll(async () => {
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-arming-real-");
    db = createDb(tempDb.connectionString);
    app = createApp();
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    mockGhFetch.mockReset();
    mockGetByName.mockReset();
    mockResolveSecretValue.mockReset();

    mockGetByName.mockImplementation(async (_companyId: string, name: string) => {
      if (name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME) return null;
      if ((GITHUB_TOKEN_SECRET_NAMES as readonly string[]).includes(name)) {
        return { id: "secret-1", name };
      }
      return null;
    });
    mockResolveSecretValue.mockResolvedValue(GITHUB_TOKEN);

    mockGhFetch.mockImplementation(async (url: string) => {
      if (url === PR_URL) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            state: "open",
            draft: false,
            merged: false,
            title: `SUP-676: the delivery`,
            head: { ref: DELIVERY_BRANCH, sha: HEAD_SHA, repo: { full_name: `${OWNER}/${REPO}` } },
          }),
        } as unknown as Response;
      }
      if (url === `https://api.github.com/repos/${OWNER}/${REPO}/statuses/${HEAD_SHA}`) {
        return { ok: true, status: 201, json: async () => ({}) } as unknown as Response;
      }
      if (url === GRAPHQL_URL) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { enablePullRequestAutoMerge: { clientMutationId: "mut-676" } } }),
        } as unknown as Response;
      }
      throw new Error(`unmocked ghFetch URL: ${url}`);
    });
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

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, source: "agent_key", runId };
  }

  async function seedFinalStageCard({ postMergeStage = false } = {}) {
    const companyId = randomUUID();
    const reviewerAgentId = randomUUID();
    const implementerAgentId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const firstStageId = randomUUID();
    const secondStageId = randomUUID();
    const postMergeStageId = randomUUID();
    const identifier = "SUP-676";
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "SUP",
      requireBoardApprovalForNewAgents: false,
      mergeArmingEnabled: true,
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
    for (const [agentId, name] of [
      [reviewerAgentId, "Reviewer"],
      [implementerAgentId, "Implementer"],
    ] as const) {
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: null,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: DELIVERY_BRANCH,
      status: "active",
      cwd: "/tmp/test",
      repoUrl: `https://github.com/${OWNER}/${REPO}`,
      baseRef: "fold/tea-patches-v2026.722.0",
      branchName: DELIVERY_BRANCH,
      providerType: "git_worktree",
      providerRef: "/tmp/test",
      lastUsedAt: now,
      openedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const stages = [
      {
        id: firstStageId,
        type: "review" as const,
        approvalsNeeded: 1 as const,
        participants: [{ type: "agent" as const, agentId: reviewerAgentId, userId: null }],
      },
      {
        id: secondStageId,
        type: "review" as const,
        approvalsNeeded: 1 as const,
        participants: [{ type: "agent" as const, agentId: reviewerAgentId, userId: null }],
      },
      ...(postMergeStage ? [{
        id: postMergeStageId,
        type: "approval" as const,
        phase: "post_merge" as const,
        approvalsNeeded: 1 as const,
        participants: [{ type: "user" as const, userId: "cloud-user-1", agentId: null }],
      }] : []),
    ];

    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier,
      issueNumber: PR_NUMBER,
      title: "Real-transport arming regression",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: reviewerAgentId,
      createdByUserId: "cloud-user-1",
      executionWorkspaceId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages,
        returnAssigneeAgentId: implementerAgentId,
      },
      executionState: {
        status: "pending",
        currentStageId: secondStageId,
        currentStageIndex: 1,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: implementerAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [firstStageId],
        lastDecisionId: null,
        lastDecisionOutcome: "approved",
        monitor: null,
        changesRequestedCount: 0,
        delivery: {
          repo: { owner: OWNER, repo: REPO },
          prNumber: PR_NUMBER,
          prUrl: `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}`,
          branch: DELIVERY_BRANCH,
          headSha: HEAD_SHA,
          sourceIssueId: issueId,
        },
      },
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId: issueId })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));

    await db.insert(issueExecutionDecisions).values({
      companyId,
      issueId,
      stageId: firstStageId,
      stageType: "review",
      actorAgentId: reviewerAgentId,
      actorUserId: null,
      outcome: "approved",
      body: "Stage 1 approved",
      createdAt: now,
      updatedAt: now,
    });

    const [externalObj] = await db
      .insert(externalObjects)
      .values({
        companyId,
        providerKey: "github",
        objectType: "pull_request",
        externalId: `${OWNER}/${REPO}#pull/${PR_NUMBER}`,
        data: {
          state: "open",
          draft: false,
          node_id: NODE_ID,
          head: { ref: DELIVERY_BRANCH },
          title: `Fix continuation gate (SUP-${PR_NUMBER}) [base fold/tea-patches-v2026.722.0]`,
        },
      })
      .returning();
    await db.insert(externalObjectMentions).values({
      companyId,
      sourceIssueId: issueId,
      sourceKind: "comment",
      objectId: externalObj!.id,
      objectType: "pull_request",
      providerKey: "github",
    });
    return { companyId, reviewerAgentId, issueId, identifier, secondStageId, postMergeStageId };
  }

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

  async function statusOf(issueId: string) {
    const rows = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    return rows[0]?.status;
  }

  async function armOutcomeOf(issueId: string): Promise<{ kind: string; message: string; at: string } | undefined> {
    const rows = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId));
    const state = (rows[0]?.executionState ?? {}) as Record<string, unknown>;
    const approvalStatus = (state.approvalStatus ?? {}) as Record<string, unknown>;
    return approvalStatus.armOutcome as { kind: string; message: string; at: string } | undefined;
  }

  async function mergeArmingComments(issueId: string) {
    const rows = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    return rows.filter((r) => typeof r.body === "string" && r.body.startsWith("[Merge-arming]"));
  }

  function graphqlArmCalls() {
    return mockGhFetch.mock.calls.filter((call) => {
      const url = String(call[0]);
      const init = call[1] as RequestInit | undefined;
      const body = String(init?.body ?? "");
      return url === GRAPHQL_URL && init?.method === "POST" && body.includes("enablePullRequestAutoMerge");
    });
  }

  it("arms the delivered PR via the real actuator: GraphQL mutation observed + armed outcome persisted", async () => {
    const { companyId, reviewerAgentId, issueId, identifier } = await seedFinalStageCard();
    currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({
        status: "done",
        comment:
          "Stage approved.\nClosed at Tier 2 (live): probe `curl -sf https://tea-core.example/healthz` head 7d3f9c1e0a25b864d7f2c9e6a18b40c3d5e72f19 post-merge: review stage approved and the patched path is live.\n\nkind: review\ndecision: approved",
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("done");
    expect(await db.select().from(issueDeliveryReceipts)).toHaveLength(0);
    const statusWrites = mockGhFetch.mock.calls.filter(
      ([url, init]) => url === `https://api.github.com/repos/${OWNER}/${REPO}/statuses/${HEAD_SHA}` && init?.method === "POST",
    );
    expect(statusWrites).toHaveLength(1);
    expect(JSON.parse(String(statusWrites[0]![1]!.body))).toMatchObject({
      context: "paperclip/approved",
      state: "success",
    });

    const armCalls = graphqlArmCalls();
    expect(armCalls).toHaveLength(1);
    const armBody = JSON.parse(String(armCalls[0]![1]!.body)) as { query: string };
    expect(armBody.query).toContain("enablePullRequestAutoMerge");
    expect(armBody.query).toContain(NODE_ID);

    const outcome = await armOutcomeOf(issueId);
    expect(outcome?.kind).toBe("armed");
    expect(outcome?.message).toContain("Auto-merge enabled");
    expect(outcome?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    const comments = await mergeArmingComments(issueId);
    expect(comments.some((c) => c.body!.includes("armed"))).toBe(true);
  });

  it("stamps the approved pre-merge head but cannot close with a pending post-merge stage", async () => {
    const { companyId, reviewerAgentId, issueId, identifier, secondStageId, postMergeStageId } =
      await seedFinalStageCard({ postMergeStage: true });
    currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({
        status: "done",
        comment: "Diff reviewed; live attestation follows merge.\n\nkind: review\ndecision: approved",
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("in_review");

    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(row!.executionState).toMatchObject({
      status: "pending",
      currentStageId: postMergeStageId,
      completedStageIds: expect.arrayContaining([secondStageId]),
      lastDecisionOutcome: "approved",
    });
    expect(row!.executionState?.completedStageIds).not.toContain(postMergeStageId);

    const statusWrites = mockGhFetch.mock.calls.filter(([url, init]) =>
      url === `https://api.github.com/repos/${OWNER}/${REPO}/statuses/${HEAD_SHA}` && init?.method === "POST",
    );
    expect(statusWrites).toHaveLength(1);
    expect(JSON.parse(String(statusWrites[0]![1]!.body))).toMatchObject({
      context: "paperclip/approved",
      state: "success",
    });
    expect(graphqlArmCalls()).toHaveLength(1);
    expect((await armOutcomeOf(issueId))?.kind).toBe("armed");
  });
});
