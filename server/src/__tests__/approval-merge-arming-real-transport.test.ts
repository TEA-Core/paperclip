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

// SUP-16130: exercise the REAL `armMergeOnApproval` actuator end-to-end. The
// round-1 refusal test (finding `final-stage-route-regression-not-exercised`)
// mocks `armMergeOnApproval` itself, so it cannot catch a regression where the
// actuator never fires the `enablePullRequestAutoMerge` GraphQL mutation. This
// file keeps the actuator, head resolver, and publisher REAL and mocks only the
// two boundaries they funnel through:
//   - `../services/github-fetch.js` -> ghFetch + gitHubApiBase
//   - `../services/secrets.js`      -> secretService (getByName + resolveSecretValue)
//
// Fixture: a terminal two-stage ladder driven to `done` through the real PATCH
// decision door, with a delivery-linked PR on the card's own branch that names
// `SUP-676` in both title and head ref (the `SUP-\d+` ownership check, SUP-13361).
// Asserts the mutation hit the transport AND `armOutcome.kind === "armed"` persisted.
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
  ghFetch: mockGhFetch,
  gitHubApiBase: (hostname: string) =>
    hostname === "github.com" ? "https://api.github.com" : `https://${hostname}/api/v3`,
}));

const GITHUB_TOKEN = "ghp_real_transport_test_token";
const OWNER = "TEA-Core";
const REPO = "paperclip";
const PR_NUMBER = 676;
const NODE_ID = "PR_node_676";
const DELIVERY_BRANCH = "SUP-676-branch";
const HEAD_SHA = "approved00000000000000000000000000000000001";
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

  beforeEach(() => {
    mockGhFetch.mockReset();
    mockGetByName.mockReset();
    mockResolveSecretValue.mockReset();

    // Skip the GitHub App installation arm (no private key) and resolve the
    // company-scope GITHUB_TOKEN the way a real deployment would — the single
    // token candidate the actuator's candidate loop will use.
    mockGetByName.mockImplementation(async (_companyId: string, name: string) => {
      if (name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME) return null;
      if ((GITHUB_TOKEN_SECRET_NAMES as readonly string[]).includes(name)) {
        return { id: "secret-1", name };
      }
      return null;
    });
    mockResolveSecretValue.mockResolvedValue(GITHUB_TOKEN);

    // Default transport: the PR head read (decision pin + publish) and the
    // commit-status write succeed; the GraphQL arming mutation succeeds and is
    // recorded. Any URL not matched here fails loudly so an unexpected transport
    // call is a regression, not a silent 200.
    mockGhFetch.mockImplementation(async (url: string) => {
      if (url === PR_URL) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ state: "open", head: { ref: DELIVERY_BRANCH, sha: HEAD_SHA } }),
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

  /**
   * Seeds a terminal two-stage ladder parked on the pending final stage, bound to
   * an execution workspace whose delivery branch is `SUP-676-branch` on
   * `TEA-Core/paperclip`, plus a delivery-linked open PR that names `SUP-676` in
   * both title and head ref and carries a known node id.
   */
  async function seedFinalStageCard() {
    const companyId = randomUUID();
    const reviewerAgentId = randomUUID();
    const implementerAgentId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const firstStageId = randomUUID();
    const secondStageId = randomUUID();
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
      },
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId: issueId })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));

    // The pre-completed first stage must be backed by a decision row or
    // evaluateStageIntegrity (guard-b:stage-without-decision) refuses the card
    // before the arming hook.
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

    // Delivery-linked open PR on the card's own branch in the project repo,
    // naming SUP-676 in both title and head ref, with a known node id so the
    // actuator goes straight to the arming mutation (no node-id REST fetch).
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

    return { companyId, reviewerAgentId, issueId, identifier };
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

  /** The `armOutcome` the real arming hook persisted onto executionState. */
  async function armOutcomeOf(issueId: string): Promise<{ kind: string; message: string; at: string } | undefined> {
    const rows = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId));
    const state = (rows[0]?.executionState ?? {}) as Record<string, unknown>;
    const approvalStatus = (state.approvalStatus ?? {}) as Record<string, unknown>;
    return approvalStatus.armOutcome as { kind: string; message: string; at: string } | undefined;
  }

  /** All `[Merge-arming]` comments the hook posted for the issue. */
  async function mergeArmingComments(issueId: string) {
    const rows = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    return rows.filter((r) => typeof r.body === "string" && r.body.startsWith("[Merge-arming]"));
  }

  /**
   * The GraphQL arming mutation the real actuator made against the transport.
   * The route also issues OTHER GraphQL round-trips on the same endpoint during
   * the transition (e.g. a `prReviewDecision` read), so filter to the calls
   * whose body is specifically the `enablePullRequestAutoMerge` mutation.
   */
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
          "Stage approved.\nClosed at Tier 1 (landed, not liveness-probed): review stage approved. Liveness unverified.\n\nkind: review\ndecision: approved",
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("done");

    // The REAL actuator fired the enablePullRequestAutoMerge mutation against
    // the transport — this is the regression the round-1 mock could not catch.
    // The route also issues an unrelated `prReviewDecision` GraphQL read on the
    // same endpoint during the transition, so the helper filters to the arming
    // mutation specifically. Exactly one arming round-trip reaches the transport,
    // and it targets the delivered PR's node id.
    const armCalls = graphqlArmCalls();
    expect(armCalls).toHaveLength(1);
    const armBody = JSON.parse(String(armCalls[0]![1]!.body)) as { query: string };
    expect(armBody.query).toContain("enablePullRequestAutoMerge");
    expect(armBody.query).toContain(NODE_ID);

    // The arming outcome was persisted onto the card as `armed`, with a durable
    // ISO timestamp — diagnosable from GET /api/issues/{id} alone.
    const outcome = await armOutcomeOf(issueId);
    expect(outcome?.kind).toBe("armed");
    expect(outcome?.message).toContain("Auto-merge enabled");
    expect(outcome?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    // The hook's [Merge-arming] trace records the armed result too.
    const comments = await mergeArmingComments(issueId);
    expect(comments.some((c) => c.body!.includes("armed"))).toBe(true);
  });
});
