import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  externalObjectMentions,
  externalObjects,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueWorkProducts,
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
import { actorMiddleware } from "../middleware/auth.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { PaperclipApiClient } from "../../../packages/mcp-server/src/client.js";
import { createToolDefinitions } from "../../../packages/mcp-server/src/tools.js";
import { issueRoutes } from "../routes/issues.js";
import { evaluateDoneTransitionGuard, prepareLandingDebtClose } from "../services/done-transition-guard.js";

// SUP-25193: a board-attached, GitHub-verified merged-PR landing proof for a
// delivered card whose completed review stage names only a user and which has no
// deliveryIdentity. Real embedded Postgres; GitHub is a faked reader.

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
  ghFetch: (url: string, init?: RequestInit) => mockGhFetch(url, init),
  gitHubApiBase: (hostname: string) =>
    hostname === "github.com" || hostname === "www.github.com"
      ? "https://api.github.com"
      : `https://${hostname}/api/v3`,
}));

const OWNER = "TEA-Core";
const REPO = "paperclip";
const BASE = "main";
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const MERGE_ON_BASE = sha("a1");
const HEAD_OF_MERGED = sha("b2");
const MERGE_OFF_BASE = sha("c3");
const OTHER_SHA = sha("d4");
const FEATURE_HEAD = sha("e5");
const OTHER_CARD_MERGE = sha("f6");
const LINKED_MERGE = sha("a7");
const RECORDED_PR_HEAD = sha("b8");
const RECORDED_PR_MERGE = sha("c9");
const RECORDED_DELIVERY = sha("d0");
const MENTIONED_MERGE = sha("e8");
const REPO_ID = 1001;

interface FakePr {
  state: "open" | "closed";
  merged: boolean;
  merge_commit_sha: string | null;
  head: { sha: string; ref: string; repo: { full_name: string } };
  base: { ref: string; repo: { id: number; node_id: string; full_name: string } };
  draft: boolean;
}

/** The faked GitHub reader: PRs by number, base branch heads, and commits contained in base. */
const github = {
  prs: new Map<number, FakePr>(),
  branches: new Map<string, string>(),
  onBase: new Set<string>(),
  compareStatus: null as number | null,
  /** The live identity GET /repos/{owner}/{repo} returns (a rename or transfer changes full_name). */
  repo: { id: REPO_ID, node_id: `R_${REPO_ID}`, full_name: `${OWNER}/${REPO}` },
  /** Each PR's own commits (GET /pulls/{n}/commits); a PR absent here lists only its head commit. */
  prCommits: new Map<number, string[]>(),
  prCommitsStatus: null as number | null,
  /** Commit ancestry: container commit -> commits reachable from it (answered by compare). */
  ancestors: new Map<string, Set<string>>(),
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function fakeGitHub(url: string): Promise<Response> {
  const { pathname } = new URL(url);
  const prefix = `/repos/${OWNER}/${REPO}`;
  if (!pathname.startsWith(prefix)) return json({ message: "Not Found" }, 404);
  const rest = decodeURIComponent(pathname.slice(prefix.length));
  if (rest === "") return json(github.repo);
  const pull = /^\/pulls\/(\d+)$/.exec(rest);
  if (pull) {
    const pr = github.prs.get(Number(pull[1]));
    if (!pr) return json({ message: "Not Found" }, 404);
    return json({ number: Number(pull[1]), ...pr });
  }
  const pullCommits = /^\/pulls\/(\d+)\/commits$/.exec(rest);
  if (pullCommits) {
    const number = Number(pullCommits[1]);
    const pr = github.prs.get(number);
    if (!pr) return json({ message: "Not Found" }, 404);
    if (github.prCommitsStatus !== null) return json({ message: "Server Error" }, github.prCommitsStatus);
    return json((github.prCommits.get(number) ?? [pr.head.sha]).map((commitSha) => ({ sha: commitSha })));
  }
  const ref = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
  if (ref) {
    const head = github.branches.get(ref[1]!);
    return head ? json({ ref: `refs/heads/${ref[1]}`, object: { sha: head } }) : json({ message: "Not Found" }, 404);
  }
  const commit = /^\/commits\/(.+)$/.exec(rest);
  if (commit) {
    const head = github.branches.get(commit[1]!);
    return head ? json({ sha: head }) : json({ message: "Not Found" }, 404);
  }
  const compare = /^\/compare\/(.+)\.\.\.(.+)$/.exec(rest);
  if (compare) {
    if (github.ancestors.get(compare[2]!)?.has(compare[1]!)) return json({ status: "ahead", ahead_by: 1, behind_by: 0 });
    if (!github.branches.has(compare[1]!)) return json({ message: "Not Found" }, 404);
    if (github.compareStatus !== null) return json({ message: "Server Error" }, github.compareStatus);
    return github.onBase.has(compare[2]!)
      ? json({ status: "behind", ahead_by: 0 })
      : json({ status: "diverged", ahead_by: 2 });
  }
  // Open-PR listing and search used by the guard's live PR discovery.
  if (/^\/pulls$/.test(rest)) return json([]);
  return json({ message: "Not Found" }, 404);
}

function resetGitHub() {
  github.prs.clear();
  github.branches.clear();
  github.onBase.clear();
  github.compareStatus = null;
  github.repo = { id: REPO_ID, node_id: `R_${REPO_ID}`, full_name: `${OWNER}/${REPO}` };
  github.prCommits.clear();
  github.prCommitsStatus = null;
  github.ancestors.clear();
  github.branches.set(BASE, MERGE_ON_BASE);
  github.onBase.add(MERGE_ON_BASE);
  for (const onBase of [OTHER_CARD_MERGE, LINKED_MERGE, RECORDED_PR_MERGE, MENTIONED_MERGE]) github.onBase.add(onBase);
  const pr = (over: Partial<FakePr>): FakePr => ({
    state: "closed",
    merged: true,
    merge_commit_sha: MERGE_ON_BASE,
    head: { sha: HEAD_OF_MERGED, ref: "deleted-after-merge", repo: { full_name: `${OWNER}/${REPO}` } },
    base: { ref: BASE, repo: { id: REPO_ID, node_id: `R_${REPO_ID}`, full_name: `${OWNER}/${REPO}` } },
    draft: false,
    ...over,
  });
  github.prs.set(501, pr({}));
  github.prs.set(502, pr({ state: "open", merged: false, merge_commit_sha: null }));
  github.prs.set(503, pr({ state: "closed", merged: false, merge_commit_sha: null }));
  github.prs.set(504, pr({ merge_commit_sha: MERGE_OFF_BASE }));
  // Another card's merged PR: on base, but nothing ties it to the card under test.
  github.prs.set(505, pr({
    merge_commit_sha: OTHER_CARD_MERGE,
    head: { sha: sha("e6"), ref: "OTHERCARD-7-delivery", repo: { full_name: `${OWNER}/${REPO}` } },
  }));
  // The card's own PR, tied only by a work product recorded on the card.
  github.prs.set(506, pr({
    merge_commit_sha: LINKED_MERGE,
    head: { sha: sha("e7"), ref: "unrelated-branch", repo: { full_name: `${OWNER}/${REPO}` } },
  }));
  // An open draft PR, used to link a draft to the card after the attach.
  github.prs.set(509, pr({
    state: "open", merged: false, merge_commit_sha: null, draft: true,
    head: { sha: sha("e9"), ref: "draft-follow-up", repo: { full_name: `${OWNER}/${REPO}` } },
  }));
  // The card's own PR, tied only by listing the card's recorded delivery commit among its own commits.
  github.prs.set(507, pr({
    merge_commit_sha: RECORDED_PR_MERGE,
    head: { sha: RECORDED_PR_HEAD, ref: "another-unrelated-branch", repo: { full_name: `${OWNER}/${REPO}` } },
  }));
  // The card's own PR, tied only by an external-object mention on the card.
  github.prs.set(508, pr({
    merge_commit_sha: MENTIONED_MERGE,
    head: { sha: sha("e9"), ref: "mention-only-branch", repo: { full_name: `${OWNER}/${REPO}` } },
  }));
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("SUP-25193 board landing proof route", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let authApp!: express.Express;
  let authServer: Server | null = null;
  let authApiUrl = "";
  let currentActor!: Express.Request["actor"];
  let seq = 0;
  let previousSchedulingSuppression: string | undefined;

  beforeAll(async () => {
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-landing-proof-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = currentActor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);

    // The real bearer path: hashed API keys resolved by the auth middleware,
    // served over HTTP so the MCP client reaches the route as a caller would.
    authApp = express();
    authApp.use(express.json());
    authApp.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    authApp.use("/api", issueRoutes(db, {} as any));
    authApp.use(errorHandler);
    authServer = await new Promise<Server>((resolve) => {
      const server = authApp.listen(0, "127.0.0.1", () => resolve(server));
    });
    authApiUrl = `http://127.0.0.1:${(authServer.address() as AddressInfo).port}/api`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (authServer ? authServer.close(() => resolve()) : resolve()));
    await tempDb?.cleanup();
    if (previousSchedulingSuppression === undefined) delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    else process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = previousSchedulingSuppression;
  });

  beforeEach(() => {
    resetGitHub();
    mockGhFetch.mockReset();
    mockGhFetch.mockImplementation(fakeGitHub);
    mockGetByName.mockReset();
    mockResolveSecretValue.mockReset();
    mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
    mockResolveSecretValue.mockResolvedValue("test-token");
    board();
  });

  function board() {
    currentActor = { type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" } as Express.Request["actor"];
  }

  const stageId = "cccccccc-0000-4000-8000-000000000001";

  /** The stuck shape: completed user-only review stage, no deliveryIdentity, no execution workspace. */
  async function seedStuckCard(options: {
    participant?: "user" | "agent";
    workflow?: "completed" | "pending";
    executionBranchAhead?: boolean;
    /**
     * The PR the board linked to the card before the attach: a url-only
     * `pull_request` work product whose create activity row names a board
     * user. It defaults to PR #501. Null links nothing.
     */
    boardLinkedPr?: number | null;
    /** An `executionState.deliveredHeadSha`, which the active run writes. Default none. */
    deliveredHeadSha?: string | null;
    /**
     * For an agent review stage: the durable decision on the completed stage.
     * `independent` (default) is an approval recorded by a separate reviewer agent
     * that is a stage participant. The others are the shapes the proof must refuse.
     */
    reviewDecision?:
      | "independent" | "none" | "executor" | "board_user" | "board_in_place" | "superseded" | "non_participant";
  } = {}) {
    seq += 1;
    const prefix = `LP${seq}`;
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const identifier = `${prefix}-1`;
    const now = new Date();
    await db.insert(companies).values({
      id: companyId, name: "Paperclip", issuePrefix: prefix, issueCounter: 1, requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "local-board", status: "active", membershipRole: "owner", updatedAt: now,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Fork", status: "active", createdAt: now, updatedAt: now });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId, companyId, projectId, name: "Primary", cwd: "/tmp/landing-proof", isPrimary: true,
      repoUrl: `https://github.com/${OWNER}/${REPO}`, defaultRef: BASE, createdAt: now, updatedAt: now,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const executionWorkspaceId = options.executionBranchAhead ? randomUUID() : null;
    if (options.executionBranchAhead) {
      github.branches.set(`deliver/${identifier}`, FEATURE_HEAD);
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId!, companyId, projectId, projectWorkspaceId, sourceIssueId: null,
        mode: "isolated_workspace", strategyType: "git_worktree", name: "landing-proof-ws", status: "active",
        cwd: "/tmp/landing-proof-ws", repoUrl: `https://github.com/${OWNER}/${REPO}`, baseRef: BASE,
        branchName: `deliver/${identifier}`, providerType: "git_worktree", providerRef: "/tmp/landing-proof-ws",
        lastUsedAt: now, openedAt: now, createdAt: now, updatedAt: now,
      });
    }
    const deliveredHeadSha = options.deliveredHeadSha ?? null;
    const reviewDecision = options.reviewDecision ?? "independent";
    const reviewerId = reviewDecision === "executor" ? agentId : randomUUID();
    if (options.participant === "agent" && reviewerId !== agentId) {
      await db.insert(agents).values({
        id: reviewerId, companyId, name: "Reviewer", role: "reviewer", status: "active", adapterType: "codex_local",
        adapterConfig: {}, runtimeConfig: {}, permissions: {},
      });
    }
    const participant = options.participant === "agent"
      ? { type: "agent", agentId: reviewerId }
      : { type: "user", userId: "local-board" };
    await db.insert(issues).values({
      id: issueId, companyId, identifier, title: "Delivered card with a user-only review stage",
      status: "in_progress", priority: "medium", assigneeAgentId: agentId, createdByUserId: "local-board",
      projectId, projectWorkspaceId, executionWorkspaceId, deliveryRequirement: "repository_delivery",
      executionPolicy: {
        mode: "normal", commentRequired: true,
        stages: [{ id: stageId, type: "review", participants: [participant] }],
      },
      executionState: options.workflow === "pending"
        ? {
          status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
          currentParticipant: participant, returnAssignee: null, completedStageIds: [], skippedStageIds: [],
          lastDecisionId: null, lastDecisionOutcome: null, deliveredHeadSha,
        }
        : {
          status: "completed", currentStageId: null, currentStageIndex: null, currentStageType: null,
          currentParticipant: null, returnAssignee: null, completedStageIds: [stageId], skippedStageIds: [],
          lastDecisionId: null, lastDecisionOutcome: "approved", deliveredHeadSha,
        },
    });
    if (options.participant === "agent" && options.workflow !== "pending" && reviewDecision !== "none") {
      const decision = (over: Partial<typeof issueExecutionDecisions.$inferInsert>) => ({
        companyId, issueId, stageId, stageType: "review", actorAgentId: reviewerId, actorUserId: null,
        outcome: "approved", body: "Approved.", ...over,
      });
      const at = (secondsAgo: number) => new Date(now.getTime() - secondsAgo * 1000);
      if (reviewDecision === "board_user") {
        await db.insert(issueExecutionDecisions).values(decision({
          actorAgentId: null, actorUserId: "local-board", createdAt: at(5),
        }));
      } else if (reviewDecision === "board_in_place") {
        await db.insert(issueExecutionDecisions).values(decision({ actorUserId: "local-board", createdAt: at(5) }));
      } else if (reviewDecision === "non_participant") {
        await db.insert(issueExecutionDecisions).values(decision({ actorAgentId: agentId, createdAt: at(5) }));
      } else if (reviewDecision === "superseded") {
        await db.insert(issueExecutionDecisions).values([
          decision({ createdAt: at(10) }),
          decision({ outcome: "changes_requested", body: "Reopened.", createdAt: at(5) }),
        ]);
      } else {
        await db.insert(issueExecutionDecisions).values(decision({ createdAt: at(5) }));
      }
    }
    const card = { companyId, agentId, issueId, identifier };
    const boardLinkedPr = options.boardLinkedPr === undefined ? 501 : options.boardLinkedPr;
    if (boardLinkedPr !== null) await linkPr(card, boardLinkedPr);
    return card;
  }

  /**
   * Records a `pull_request` work product on the card the way a writer leaves
   * it: the row (url only, so the attach adds its own row) plus the
   * `issue.work_product_created` activity row that names the writer.
   */
  async function linkPr(
    card: { companyId: string; issueId: string; agentId: string },
    prNumber: number,
    options: { actorType?: "user" | "agent" | "system"; metadata?: Record<string, unknown> } = {},
  ) {
    const actorType = options.actorType ?? "user";
    const [product] = await db.insert(issueWorkProducts).values({
      companyId: card.companyId, issueId: card.issueId, type: "pull_request", provider: "github",
      title: `PR #${prNumber}`, url: `https://github.com/${OWNER}/${REPO}/pull/${prNumber}`, status: "merged",
      reviewState: "none", isPrimary: false, healthStatus: "unknown", metadata: options.metadata ?? {},
    }).returning();
    await db.insert(activityLog).values({
      companyId: card.companyId, actorType,
      actorId: actorType === "user" ? "local-board" : actorType === "agent" ? card.agentId : "pr-delivery",
      agentId: actorType === "agent" ? card.agentId : null,
      action: "issue.work_product_created", entityType: "issue", entityId: card.issueId,
      details: { workProductId: product!.id, type: "pull_request", provider: "github" },
    });
    return product!.id;
  }

  /** Puts the assignee agent on a live run and makes it the request actor. */
  async function actAsAssigneeRun(card: { companyId: string; agentId: string; issueId: string }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: card.companyId, agentId: card.agentId, status: "running", contextSnapshot: { issueId: card.issueId },
    });
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, card.issueId));
    currentActor = { type: "agent", agentId: card.agentId, companyId: card.companyId, source: "agent_key", runId } as Express.Request["actor"];
    return runId;
  }

  const patch = (id: string, body: object) => request(app).patch(`/api/issues/${id}`).send(body);
  const attach = (id: string, body: object) => request(app).post(`/api/issues/${id}/landing-proof`).send(body);
  const goodProof = (over: object = {}) => ({
    owner: OWNER, repo: REPO, pullRequestNumber: 501, mergeCommitSha: MERGE_ON_BASE,
    reason: "Delivered by fork PR #501; merged on main.", ...over,
  });

  async function reclassifyRecordOnly(id: string) {
    const flipped = await patch(id, { deliveryRequirement: "record_only" });
    expect(flipped.status, JSON.stringify(flipped.body)).toBe(200);
  }

  const debtDispositions = async (id: string) =>
    (await db.select({ details: activityLog.details }).from(activityLog).where(and(
      eq(activityLog.entityId, id), eq(activityLog.action, "issue.repository_landing_debt"),
    ))).map((row) => row.details as Record<string, any>);
  const proofRows = (id: string) => db.select().from(activityLog).where(and(
    eq(activityLog.entityId, id), eq(activityLog.action, "issue.landing_proof_attached"),
  ));
  /** The work products the attach route wrote (a seeded board link is not one). */
  const workProducts = async (id: string) =>
    (await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, id)))
      .filter((row) => typeof (row.metadata as Record<string, unknown> | null)?.landingProofActivityId === "string");
  const statusOf = async (id: string) => (await db.select({ status: issues.status }).from(issues).where(eq(issues.id, id)))[0]?.status;

  it("(a)(d) a stuck card with record_only landing debt is refused 409, then closes done after a board proof, and only the close discharges the debt", async () => {
    const { issueId } = await seedStuckCard();
    await reclassifyRecordOnly(issueId);

    const before = await patch(issueId, { status: "done" });
    expect(before.status, JSON.stringify(before.body)).toBe(409);
    expect(before.body.code).toBe("done_transition_missing_delivery");

    const attached = await attach(issueId, goodProof());
    expect(attached.status, JSON.stringify(attached.body)).toBe(201);
    expect(attached.body).toMatchObject({ landingDebtOwed: true, landingDebtDischarged: false, replayed: false });
    // Attaching alone never discharges debt.
    expect((await debtDispositions(issueId)).map((d) => d.landingDebtDisposition)).toEqual(["outstanding"]);
    expect(await statusOf(issueId)).toBe("in_progress");

    const [proof] = await proofRows(issueId);
    expect(proof).toMatchObject({ actorType: "user", actorId: "local-board" });
    expect(proof!.details).toMatchObject({
      owner: OWNER, repo: REPO, pullRequestNumber: 501, mergeCommitSha: MERGE_ON_BASE, headSha: HEAD_OF_MERGED,
      baseRef: BASE, reason: "Delivered by fork PR #501; merged on main.", landingDebtOwed: true,
    });
    const [product] = await workProducts(issueId);
    expect(product).toMatchObject({ type: "pull_request", status: "merged", externalId: `${OWNER}/${REPO}#501` });
    expect(product!.metadata).toMatchObject({ mergeCommitSha: MERGE_ON_BASE, headSha: HEAD_OF_MERGED });

    const closed = await patch(issueId, { status: "done", comment: "Landing proven by the board-attached PR." });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("done");
    const [debt] = await debtDispositions(issueId);
    expect(debt).toMatchObject({
      landingDebtDisposition: "discharged",
      landingProof: { head: MERGE_ON_BASE, source: "board_merged_pr", pullRequestNumber: 501, proofActivityId: proof!.id, baseRef: BASE },
    });
  });

  it("accepts a headSha-only proof and replays identical evidence without a second record", async () => {
    const { issueId } = await seedStuckCard();
    await reclassifyRecordOnly(issueId);
    const first = await attach(issueId, goodProof({ mergeCommitSha: undefined, headSha: HEAD_OF_MERGED }));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await attach(issueId, goodProof({ mergeCommitSha: undefined, headSha: HEAD_OF_MERGED }));
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, proofActivityId: first.body.proofActivityId });
    expect(await proofRows(issueId)).toHaveLength(1);
    expect(await workProducts(issueId)).toHaveLength(1);
  });

  it.each([
    ["forged PR number", goodProof({ pullRequestNumber: 999 }), 422, "landing_proof_pr_not_found"],
    ["unmerged (open) PR", goodProof({ pullRequestNumber: 502 }), 422, "landing_proof_pr_not_merged"],
    ["closed-unmerged PR", goodProof({ pullRequestNumber: 503 }), 422, "landing_proof_pr_closed_unmerged"],
    ["wrong repository", goodProof({ owner: "someone-else" }), 422, "landing_proof_wrong_repo"],
    ["wrong merge sha", goodProof({ mergeCommitSha: OTHER_SHA }), 422, "landing_proof_sha_mismatch"],
    ["wrong head sha", goodProof({ mergeCommitSha: undefined, headSha: OTHER_SHA }), 422, "landing_proof_sha_mismatch"],
    ["merge commit not on base", goodProof({ pullRequestNumber: 504, mergeCommitSha: MERGE_OFF_BASE }), 422, "landing_proof_not_on_base"],
    ["no sha at all", goodProof({ mergeCommitSha: undefined }), 400, undefined],
  ] as const)("(b) refuses a %s and records nothing", async (_label, body, status, code) => {
    // The board linked the named PR, so each case reaches its own check.
    const pullRequestNumber = (body as { pullRequestNumber?: number }).pullRequestNumber ?? 501;
    const { issueId } = await seedStuckCard({ boardLinkedPr: pullRequestNumber });
    await reclassifyRecordOnly(issueId);
    const refused = await attach(issueId, body);
    expect(refused.status, JSON.stringify(refused.body)).toBe(status);
    if (code) expect(refused.body.code).toBe(code);
    expect(await proofRows(issueId)).toHaveLength(0);
    expect(await workProducts(issueId)).toHaveLength(0);
    const close = await patch(issueId, { status: "done" });
    expect(close.status, JSON.stringify(close.body)).toBe(409);
    expect((await debtDispositions(issueId)).map((d) => d.landingDebtDisposition)).toEqual(["outstanding"]);
  });

  it("refuses a transient compare failure as unverifiable, not as off-base, and records nothing", async () => {
    const { issueId } = await seedStuckCard();
    await reclassifyRecordOnly(issueId);
    github.compareStatus = 502;
    const refused = await attach(issueId, goodProof());
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.code).toBe("landing_proof_unverifiable");
    expect(await proofRows(issueId)).toHaveLength(0);
    expect(await workProducts(issueId)).toHaveLength(0);
  });

  it("refuses with landing_proof_cannot_close when the card owes no landing debt, and records nothing", async () => {
    const { issueId } = await seedStuckCard();
    const refused = await attach(issueId, goodProof());
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.code).toBe("landing_proof_cannot_close");
    expect(await proofRows(issueId)).toHaveLength(0);
    expect(await workProducts(issueId)).toHaveLength(0);
  });

  it("refuses with landing_proof_cannot_close when the execution branch is ahead of base with no merged PR, and records nothing", async () => {
    const { issueId } = await seedStuckCard({ executionBranchAhead: true });
    await reclassifyRecordOnly(issueId);
    const close = await patch(issueId, { status: "done" });
    expect(close.status, JSON.stringify(close.body)).toBe(409);
    expect(close.body.error).toContain("has no merged PR");
    const refused = await attach(issueId, goodProof());
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.code).toBe("landing_proof_cannot_close");
    expect(refused.body.error).toContain("has no merged PR");
    expect(await proofRows(issueId)).toHaveLength(0);
    expect(await workProducts(issueId)).toHaveLength(0);
    expect((await debtDispositions(issueId)).map((d) => d.landingDebtDisposition)).toEqual(["outstanding"]);
  });

  it("(c) refuses an agent key, including the assignee holding a live run, and records nothing", async () => {
    const { companyId, agentId, issueId } = await seedStuckCard();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    currentActor = { type: "agent", agentId, companyId, source: "agent_key", runId } as Express.Request["actor"];
    const refused = await attach(issueId, goodProof());
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(await proofRows(issueId)).toHaveLength(0);
    expect(await workProducts(issueId)).toHaveLength(0);
  });

  it("(d) a proof that no longer verifies at the close boundary cannot discharge debt", async () => {
    const { issueId } = await seedStuckCard();
    await reclassifyRecordOnly(issueId);
    expect((await attach(issueId, goodProof())).status).toBe(201);
    // The base branch is rewritten after the attach: the merge commit is no longer contained.
    github.onBase.delete(MERGE_ON_BASE);
    const close = await patch(issueId, { status: "done" });
    expect(close.status, JSON.stringify(close.body)).toBe(409);
    expect(close.body.code).toBe("done_transition_missing_delivery");
    expect(close.body.error).toContain("landing_proof_not_on_base");
    expect((await debtDispositions(issueId)).map((d) => d.landingDebtDisposition)).toEqual(["outstanding"]);
    expect(await statusOf(issueId)).toBe("in_progress");
  });

  it("(e) a non-board close door does not accept the board proof", async () => {
    const { issueId } = await seedStuckCard();
    await reclassifyRecordOnly(issueId);
    expect((await attach(issueId, goodProof())).status).toBe(201);
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    const debt = await prepareLandingDebtClose(db, row as any);
    expect(debt.owed).toBe(true);
    const agentDoor = await evaluateDoneTransitionGuard(db, row as any, null, false, undefined, true);
    expect(agentDoor).toMatchObject({ allowed: false, mechanism: "delivery" });
    const boardDoor = await evaluateDoneTransitionGuard(db, row as any, null, false, undefined, true, {
      acceptBoardLandingProof: true,
    });
    expect(boardDoor).toMatchObject({ allowed: true, landingVerified: true, landingProof: { source: "board_merged_pr" } });
  });

  it("(e) a stuck card without landing debt still closes done exactly as before, with no proof", async () => {
    const { issueId } = await seedStuckCard();
    const closed = await patch(issueId, { status: "done" });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await proofRows(issueId)).toHaveLength(0);
  });

  it.each([
    ["an agent review stage on a repository_delivery card", { participant: "agent" as const }],
    ["a live (pending) review workflow", { workflow: "pending" as const }],
  ])("refuses a card with %s as not applicable", async (_label, options) => {
    const { issueId } = await seedStuckCard(options);
    const refused = await attach(issueId, goodProof());
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.code).toBe("landing_proof_not_applicable");
    expect(await proofRows(issueId)).toHaveLength(0);
  });

  describe("an agent-reviewed record_only card whose review stage is completed", () => {
    it("accepts a live-verified merged PR, and the board close then discharges the debt", async () => {
      const { issueId } = await seedStuckCard({ participant: "agent" });
      await reclassifyRecordOnly(issueId);
      const attached = await attach(issueId, goodProof());
      expect(attached.status, JSON.stringify(attached.body)).toBe(201);
      expect(attached.body).toMatchObject({ landingDebtOwed: true, landingDebtDischarged: false, replayed: false });
      const [proof] = await proofRows(issueId);
      expect(proof).toMatchObject({ actorType: "user", actorId: "local-board" });
      const closed = await patch(issueId, { status: "done", comment: "Landing proven by the board-attached PR." });
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
      expect(await statusOf(issueId)).toBe("done");
      const [debt] = await debtDispositions(issueId);
      expect(debt).toMatchObject({
        landingDebtDisposition: "discharged",
        landingProof: { head: MERGE_ON_BASE, source: "board_merged_pr", pullRequestNumber: 501 },
      });
    });

    it.each([
      ["the card's own executor reviewed its own work", "executor" as const],
      ["only an old board-user approval is recorded on the stage", "board_user" as const],
      ["the board recorded the approval in the reviewer agent's place", "board_in_place" as const],
      ["the approval was superseded by a later changes_requested decision", "superseded" as const],
      ["an agent that is not a stage participant approved", "non_participant" as const],
      ["no decision is recorded on the completed stage", "none" as const],
    ])("refuses when %s, and records nothing", async (_label, reviewDecision) => {
      const { issueId } = await seedStuckCard({ participant: "agent", reviewDecision });
      await reclassifyRecordOnly(issueId);
      const refused = await attach(issueId, goodProof());
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.code).toBe("landing_proof_not_applicable");
      expect(await proofRows(issueId)).toHaveLength(0);
      expect(await workProducts(issueId)).toHaveLength(0);
      expect((await patch(issueId, { status: "done" })).status).toBe(409);
    });

    it("refuses while the review workflow is not completed", async () => {
      const { issueId } = await seedStuckCard({ participant: "agent", workflow: "pending" });
      await db.update(issues).set({ deliveryRequirement: "record_only" }).where(eq(issues.id, issueId));
      const refused = await attach(issueId, goodProof());
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.code).toBe("landing_proof_not_applicable");
      expect(await proofRows(issueId)).toHaveLength(0);
    });

    it("refuses while a second policy stage is neither approved nor skipped", async () => {
      const { issueId } = await seedStuckCard({ participant: "agent" });
      await reclassifyRecordOnly(issueId);
      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      const policy = row!.executionPolicy as { stages: unknown[] };
      await db.update(issues).set({
        executionPolicy: {
          ...policy,
          stages: [
            ...policy.stages,
            { id: "cccccccc-0000-4000-8000-000000000002", type: "approval", participants: [{ type: "user", userId: "local-board" }] },
          ],
        },
      }).where(eq(issues.id, issueId));
      const refused = await attach(issueId, goodProof());
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.code).toBe("landing_proof_not_applicable");
      expect(await proofRows(issueId)).toHaveLength(0);
    });

    it("refuses a record_only card whose completed review stage has no participants", async () => {
      const { issueId } = await seedStuckCard({ participant: "agent" });
      await reclassifyRecordOnly(issueId);
      await db.update(issues).set({
        executionPolicy: {
          mode: "normal", commentRequired: true,
          stages: [{ id: stageId, type: "review", participants: [] }],
        },
      }).where(eq(issues.id, issueId));
      const refused = await attach(issueId, goodProof());
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.code).toBe("landing_proof_not_applicable");
      expect(await proofRows(issueId)).toHaveLength(0);
    });

    it("refuses an agent key, including the assignee holding a live run", async () => {
      const card = await seedStuckCard({ participant: "agent" });
      await reclassifyRecordOnly(card.issueId);
      await actAsAssigneeRun(card);
      const refused = await attach(card.issueId, goodProof());
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(await proofRows(card.issueId)).toHaveLength(0);
      expect(await workProducts(card.issueId)).toHaveLength(0);
    });

    it.each([
      ["an unmerged (open) PR", goodProof({ pullRequestNumber: 502 }), "landing_proof_pr_not_merged", 502],
      ["a wrong repository", goodProof({ owner: "someone-else" }), "landing_proof_wrong_repo", 501],
      ["a merge commit not on base", goodProof({ pullRequestNumber: 504, mergeCommitSha: MERGE_OFF_BASE }), "landing_proof_not_on_base", 504],
    ] as const)("still refuses %s and records nothing", async (_label, body, code, linkedPr) => {
      const { issueId } = await seedStuckCard({ participant: "agent", boardLinkedPr: linkedPr });
      await reclassifyRecordOnly(issueId);
      const refused = await attach(issueId, body);
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body.code).toBe(code);
      expect(await proofRows(issueId)).toHaveLength(0);
      expect(await workProducts(issueId)).toHaveLength(0);
    });
  });

  it("refuses a card that already records a deliveryIdentity or is closed", async () => {
    const recorded = await seedStuckCard();
    const [row] = await db.select().from(issues).where(eq(issues.id, recorded.issueId));
    await db.update(issues).set({
      executionState: { ...(row!.executionState as object), delivery: { branch: "x", headSha: HEAD_OF_MERGED } },
    }).where(eq(issues.id, recorded.issueId));
    expect((await attach(recorded.issueId, goodProof())).body.code).toBe("landing_proof_not_applicable");
    const cancelled = await seedStuckCard();
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, cancelled.issueId));
    const refused = await attach(cancelled.issueId, goodProof());
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("landing_proof_not_applicable");
  });
  describe("the merged PR must be this card's own delivery, shown by evidence the board wrote", () => {
    const expectRefusedNotCardDelivery = async (issueId: string, response: request.Response) => {
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.code).toBe("landing_proof_not_card_delivery");
      expect(await proofRows(issueId)).toHaveLength(0);
      expect(await workProducts(issueId)).toHaveLength(0);
      expect((await patch(issueId, { status: "done" })).status).toBe(409);
      expect((await debtDispositions(issueId)).map((d) => d.landingDebtDisposition)).toEqual(["outstanding"]);
    };

    it("refuses another card's merged PR with landing_proof_not_card_delivery and records nothing", async () => {
      const { issueId } = await seedStuckCard();
      await reclassifyRecordOnly(issueId);
      await expectRefusedNotCardDelivery(issueId, await attach(issueId, goodProof({ pullRequestNumber: 505, mergeCommitSha: OTHER_CARD_MERGE })));
    });

    it("accepts a PR the board linked through the work-product API, and the close discharges the debt", async () => {
      const { issueId } = await seedStuckCard({ boardLinkedPr: null });
      const linked = await request(app).post(`/api/issues/${issueId}/work-products`).send({
        type: "pull_request", provider: "github", title: "Delivery PR", url: `https://github.com/${OWNER}/${REPO}/pull/506`,
        status: "merged",
      });
      expect(linked.status, JSON.stringify(linked.body)).toBe(201);
      await reclassifyRecordOnly(issueId);
      const attached = await attach(issueId, goodProof({ pullRequestNumber: 506, mergeCommitSha: LINKED_MERGE }));
      expect(attached.status, JSON.stringify(attached.body)).toBe(201);
      expect(attached.body.proof.possession).toMatchObject({ kind: "linked_work_product" });
      const closed = await patch(issueId, { status: "done" });
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
      expect((await debtDispositions(issueId))[0]).toMatchObject({
        landingDebtDisposition: "discharged", landingProof: { source: "board_merged_pr", pullRequestNumber: 506 },
      });
    });

    it("refuses a PR the card's own agent linked through the work-product API", async () => {
      const card = await seedStuckCard({ boardLinkedPr: null });
      await reclassifyRecordOnly(card.issueId);
      await actAsAssigneeRun(card);
      const linked = await request(app).post(`/api/issues/${card.issueId}/work-products`).send({
        type: "pull_request", provider: "github", title: "Unrelated PR", url: `https://github.com/${OWNER}/${REPO}/pull/505`,
        status: "merged",
      });
      expect(linked.status, JSON.stringify(linked.body)).toBe(201);
      board();
      await expectRefusedNotCardDelivery(card.issueId, await attach(card.issueId, goodProof({ pullRequestNumber: 505, mergeCommitSha: OTHER_CARD_MERGE })));
    });

    it("refuses a board link that the card's agent edited afterwards", async () => {
      const card = await seedStuckCard({ boardLinkedPr: null });
      const linked = await request(app).post(`/api/issues/${card.issueId}/work-products`).send({
        type: "pull_request", provider: "github", title: "Delivery PR", url: `https://github.com/${OWNER}/${REPO}/pull/506`,
        status: "merged",
      });
      expect(linked.status, JSON.stringify(linked.body)).toBe(201);
      await reclassifyRecordOnly(card.issueId);
      await actAsAssigneeRun(card);
      const edited = await request(app).patch(`/api/work-products/${linked.body.id}`).send({ title: "Delivery PR (edited)" });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      board();
      await expectRefusedNotCardDelivery(card.issueId, await attach(card.issueId, goodProof({ pullRequestNumber: 506, mergeCommitSha: LINKED_MERGE })));
    });

    async function boardLinkOpenPrThenPrDeliveryUpdate(status: "merged" | "ready_for_review") {
      const card = await seedStuckCard({ boardLinkedPr: null });
      const linked = await request(app).post(`/api/issues/${card.issueId}/work-products`).send({
        type: "pull_request", provider: "github", title: "Delivery PR", url: `https://github.com/${OWNER}/${REPO}/pull/506`,
        status: "ready_for_review",
      });
      expect(linked.status, JSON.stringify(linked.body)).toBe(201);
      await db.update(issueWorkProducts).set({ status }).where(eq(issueWorkProducts.id, linked.body.id));
      await db.insert(activityLog).values({
        companyId: card.companyId, actorType: "system", actorId: "pr-delivery", agentId: null,
        action: "issue.work_product_updated", entityType: "issue", entityId: card.issueId,
        details: {
          workProductId: linked.body.id, type: "pull_request", provider: "github",
          externalId: `${OWNER}/${REPO}#506`, prNumber: 506, status,
          ...(status === "merged" ? { mergeCommitSha: LINKED_MERGE } : {}),
        },
      });
      await reclassifyRecordOnly(card.issueId);
      return card;
    }

    it("keeps a board link after the merge sweep records the PR's merge", async () => {
      const { issueId } = await boardLinkOpenPrThenPrDeliveryUpdate("merged");
      const attached = await attach(issueId, goodProof({ pullRequestNumber: 506, mergeCommitSha: LINKED_MERGE }));
      expect(attached.status, JSON.stringify(attached.body)).toBe(201);
      expect(attached.body.proof.possession).toMatchObject({ kind: "linked_work_product" });
    });

    it("refuses a board link that pr-delivery re-delivery rewrote", async () => {
      const { issueId } = await boardLinkOpenPrThenPrDeliveryUpdate("ready_for_review");
      await expectRefusedNotCardDelivery(issueId, await attach(issueId, goodProof({ pullRequestNumber: 506, mergeCommitSha: LINKED_MERGE })));
    });

    it.each([
      ["an agent", "agent" as const],
      ["the server's carrier fan-out", "system" as const],
    ])("refuses a link that %s wrote", async (_label, actorType) => {
      const card = await seedStuckCard({ boardLinkedPr: null });
      await linkPr(card, 506, { actorType });
      await reclassifyRecordOnly(card.issueId);
      await expectRefusedNotCardDelivery(card.issueId, await attach(card.issueId, goodProof({ pullRequestNumber: 506, mergeCommitSha: LINKED_MERGE })));
    });

    it("refuses a link that has no activity record of who wrote it", async () => {
      const { companyId, issueId } = await seedStuckCard({ boardLinkedPr: null });
      await db.insert(issueWorkProducts).values({
        companyId, issueId, type: "pull_request", provider: "github", externalId: `${OWNER}/${REPO}#506`,
        title: "PR #506", url: `https://github.com/${OWNER}/${REPO}/pull/506`, status: "merged",
        reviewState: "none", isPrimary: true, healthStatus: "unknown",
        metadata: { prNumber: 506, repository: `${OWNER}/${REPO}` },
      });
      await reclassifyRecordOnly(issueId);
      const refused = await attach(issueId, goodProof({ pullRequestNumber: 506, mergeCommitSha: LINKED_MERGE }));
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body.code).toBe("landing_proof_not_card_delivery");
    });

    async function mentionInComment(card: { companyId: string; issueId: string; agentId: string }, author: "user" | "agent") {
      const commentId = randomUUID();
      await db.insert(issueComments).values({
        id: commentId, companyId: card.companyId, issueId: card.issueId, body: `Delivered in ${OWNER}/${REPO}#508`,
        ...(author === "user" ? { authorUserId: "local-board", authorType: "user" } : { authorAgentId: card.agentId, authorType: "agent" }),
      } as typeof issueComments.$inferInsert);
      const [object] = await db.insert(externalObjects).values({
        companyId: card.companyId, providerKey: "github", objectType: "pull_request", externalId: `${OWNER}/${REPO}#pull/508`,
        data: { state: "closed", merged: true, merge_commit_sha: MENTIONED_MERGE },
      }).returning();
      await db.insert(externalObjectMentions).values({
        companyId: card.companyId, sourceIssueId: card.issueId, sourceKind: "comment", sourceRecordId: commentId,
        objectId: object!.id, providerKey: "github", objectType: "pull_request",
      });
    }

    it("accepts a merged PR that a board user's comment on the card names, cached as closed", async () => {
      const card = await seedStuckCard({ boardLinkedPr: null });
      await mentionInComment(card, "user");
      await reclassifyRecordOnly(card.issueId);
      const attached = await attach(card.issueId, goodProof({ pullRequestNumber: 508, mergeCommitSha: MENTIONED_MERGE }));
      expect(attached.status, JSON.stringify(attached.body)).toBe(201);
      expect(attached.body.proof.possession).toMatchObject({ kind: "linked_external_object" });
      const closed = await patch(card.issueId, { status: "done" });
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
      expect((await debtDispositions(card.issueId))[0]).toMatchObject({
        landingDebtDisposition: "discharged", landingProof: { source: "board_merged_pr", pullRequestNumber: 508 },
      });
    });

    it("refuses a merged PR that only an agent's comment on the card names", async () => {
      const card = await seedStuckCard({ boardLinkedPr: null });
      await mentionInComment(card, "agent");
      await reclassifyRecordOnly(card.issueId);
      await expectRefusedNotCardDelivery(card.issueId, await attach(card.issueId, goodProof({ pullRequestNumber: 508, mergeCommitSha: MENTIONED_MERGE })));
    });

    it("refuses a run-written delivery commit (executionState.deliveredHeadSha) as a tie", async () => {
      // The active run writes deliveredHeadSha; here it even equals PR #501's head.
      const { issueId } = await seedStuckCard({ boardLinkedPr: null, deliveredHeadSha: HEAD_OF_MERGED });
      await reclassifyRecordOnly(issueId);
      await expectRefusedNotCardDelivery(issueId, await attach(issueId, goodProof()));
    });

    it("accepts a merged PR that lists a commit recorded on a board-written work product among its own commits", async () => {
      const card = await seedStuckCard({ boardLinkedPr: null });
      // The board recorded an earlier PR of this card with its head commit.
      await linkPr(card, 400, { metadata: { headSha: RECORDED_DELIVERY } });
      github.prCommits.set(507, [RECORDED_DELIVERY, RECORDED_PR_HEAD]);
      await reclassifyRecordOnly(card.issueId);
      const attached = await attach(card.issueId, goodProof({ pullRequestNumber: 507, mergeCommitSha: RECORDED_PR_MERGE }));
      expect(attached.status, JSON.stringify(attached.body)).toBe(201);
      expect(attached.body.proof.possession).toMatchObject({ kind: "recorded_delivery_commit" });
      // The same commit recorded on an agent-written work product is not a tie.
      const other = await seedStuckCard({ boardLinkedPr: null });
      await linkPr(other, 400, { actorType: "agent", metadata: { headSha: RECORDED_DELIVERY } });
      await reclassifyRecordOnly(other.issueId);
      await expectRefusedNotCardDelivery(other.issueId, await attach(other.issueId, goodProof({ pullRequestNumber: 507, mergeCommitSha: RECORDED_PR_MERGE })));
    });

    it("refuses an unrelated later merged PR whose merge commit only has the recorded delivery commit as an ancestor", async () => {
      const card = await seedStuckCard({ boardLinkedPr: null });
      // The board-recorded delivery commit is already on base (it is the base head).
      await linkPr(card, 400, { metadata: { headSha: MERGE_ON_BASE } });
      await reclassifyRecordOnly(card.issueId);
      // PR #505 merged later: its merge commit descends from the recorded commit,
      // but the recorded commit is not one of the PR's own commits.
      github.ancestors.set(OTHER_CARD_MERGE, new Set([MERGE_ON_BASE]));
      github.ancestors.set(sha("e6"), new Set([MERGE_ON_BASE]));
      await expectRefusedNotCardDelivery(card.issueId, await attach(card.issueId, goodProof({ pullRequestNumber: 505, mergeCommitSha: OTHER_CARD_MERGE })));
    });

    it("refuses as unverifiable when the PR commit list cannot be read, and records nothing", async () => {
      const card = await seedStuckCard({ boardLinkedPr: null });
      await linkPr(card, 400, { metadata: { headSha: RECORDED_DELIVERY } });
      await reclassifyRecordOnly(card.issueId);
      github.prCommitsStatus = 502;
      const refused = await attach(card.issueId, goodProof({ pullRequestNumber: 507, mergeCommitSha: RECORDED_PR_MERGE }));
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body.code).toBe("landing_proof_unverifiable");
      expect(await proofRows(card.issueId)).toHaveLength(0);
      expect(await workProducts(card.issueId)).toHaveLength(0);
    });

    it("refuses the close once an agent edits the board link, because the attach's own work product never counts", async () => {
      const card = await seedStuckCard();
      await reclassifyRecordOnly(card.issueId);
      expect((await attach(card.issueId, goodProof())).status).toBe(201);
      const [seeded] = (await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, card.issueId)))
        .filter((row) => !(row.metadata as Record<string, unknown> | null)?.landingProofActivityId);
      await db.insert(activityLog).values({
        companyId: card.companyId, actorType: "agent", actorId: card.agentId, agentId: card.agentId,
        action: "issue.work_product_updated", entityType: "issue", entityId: card.issueId,
        details: { workProductId: seeded!.id, changedKeys: ["title"] },
      });
      const close = await patch(card.issueId, { status: "done" });
      expect(close.status, JSON.stringify(close.body)).toBe(409);
      expect(close.body.error).toContain("landing_proof_not_card_delivery");
      expect((await debtDispositions(card.issueId)).map((d) => d.landingDebtDisposition)).toEqual(["outstanding"]);
    });
  });

  describe("the live repository identity must be the card's delivery repo", () => {
    it.each([
      ["renamed", `${OWNER}/${REPO}-renamed`],
      ["transferred", `another-org/${REPO}`],
    ])("refuses a %s repository with landing_proof_repo_identity_mismatch and records nothing", async (_label, fullName) => {
      const { issueId } = await seedStuckCard();
      await reclassifyRecordOnly(issueId);
      github.repo = { ...github.repo, full_name: fullName };
      const refused = await attach(issueId, goodProof());
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body.code).toBe("landing_proof_repo_identity_mismatch");
      expect(await proofRows(issueId)).toHaveLength(0);
      expect(await workProducts(issueId)).toHaveLength(0);
    });

    it("refuses a PR whose base repository id is not the live repository id", async () => {
      const { issueId } = await seedStuckCard();
      await reclassifyRecordOnly(issueId);
      github.repo = { ...github.repo, id: 2002 };
      const refused = await attach(issueId, goodProof());
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body.code).toBe("landing_proof_repo_identity_mismatch");
    });

    it("records the repository id and refuses the close when the repository is replaced after the attach", async () => {
      const { issueId } = await seedStuckCard();
      await reclassifyRecordOnly(issueId);
      const attached = await attach(issueId, goodProof());
      expect(attached.status, JSON.stringify(attached.body)).toBe(201);
      expect((await proofRows(issueId))[0]!.details).toMatchObject({ repositoryId: REPO_ID, repositoryNodeId: `R_${REPO_ID}` });
      // A new repository now holds the name; its PR #501 reports the new id.
      github.repo = { id: 3003, node_id: "R_3003", full_name: `${OWNER}/${REPO}` };
      github.prs.get(501)!.base.repo = { id: 3003, node_id: "R_3003", full_name: `${OWNER}/${REPO}` };
      const close = await patch(issueId, { status: "done" });
      expect(close.status, JSON.stringify(close.body)).toBe(409);
      expect(close.body.error).toContain("landing_proof_repo_identity_mismatch");
      expect((await debtDispositions(issueId)).map((d) => d.landingDebtDisposition)).toEqual(["outstanding"]);
    });
  });
  describe("a head branch name is not a tie to the card", () => {
    it.each([
      ["carries the exact card identifier", (identifier: string) => `attacker/${identifier}/unrelated`],
      ["carries the identifier without its hyphen", (identifier: string) => `${identifier.replace("-", "").toLowerCase()}-fix`],
      ["starts with the identifier in upper case", (identifier: string) => `${identifier.toUpperCase()}-delivery`],
    ])("refuses an unrelated merged PR whose head branch %s, and the debt stays owed", async (_label, branchFor) => {
      const { issueId, identifier } = await seedStuckCard({ boardLinkedPr: null });
      await reclassifyRecordOnly(issueId);
      github.prs.get(505)!.head.ref = branchFor(identifier);
      const refused = await attach(issueId, goodProof({ pullRequestNumber: 505, mergeCommitSha: OTHER_CARD_MERGE }));
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body.code).toBe("landing_proof_not_card_delivery");
      expect(await proofRows(issueId)).toHaveLength(0);
      expect(await workProducts(issueId)).toHaveLength(0);
      expect((await patch(issueId, { status: "done" })).status).toBe(409);
      expect((await debtDispositions(issueId)).map((d) => d.landingDebtDisposition)).toEqual(["outstanding"]);
      expect(await statusOf(issueId)).toBe("in_progress");
    });
  });

  describe("the debt discharge is atomic with the accepted close", () => {
    it("rolls the discharge back when a later step of the same close fails", async () => {
      const { issueId } = await seedStuckCard();
      await reclassifyRecordOnly(issueId);
      expect((await attach(issueId, goodProof())).status).toBe(201);
      // The comment's attachment receipt is bound inside the close transaction,
      // after the debt finalizer ran. An unknown receipt fails that step.
      const failed = await patch(issueId, {
        status: "done",
        comment: "Closing on the attached landing proof.",
        attachmentIds: [randomUUID()],
      });
      expect(failed.status, JSON.stringify(failed.body)).toBeGreaterThanOrEqual(400);
      expect(failed.status).toBeLessThan(500);
      expect(await statusOf(issueId)).toBe("in_progress");
      const debt = await debtDispositions(issueId);
      expect(debt.map((d) => d.landingDebtDisposition)).toEqual(["outstanding"]);
      expect(debt[0]!.landingProof ?? null).toBeNull();
      // The same card then closes cleanly and the discharge commits with it.
      const closed = await patch(issueId, { status: "done" });
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
      expect((await debtDispositions(issueId)).map((d) => d.landingDebtDisposition)).toEqual(["discharged"]);
    });

    it("serializes two concurrent board closes: the card closes once and the debt is discharged once", async () => {
      const { issueId } = await seedStuckCard();
      await reclassifyRecordOnly(issueId);
      const attached = await attach(issueId, goodProof());
      expect(attached.status).toBe(201);
      const responses = await Promise.all([patch(issueId, { status: "done" }), patch(issueId, { status: "done" })]);
      for (const response of responses) expect(response.status, JSON.stringify(response.body)).toBeLessThan(500);
      expect(responses.some((response) => response.status === 200)).toBe(true);
      expect(await statusOf(issueId)).toBe("done");
      const debt = await debtDispositions(issueId);
      expect(debt).toHaveLength(1);
      expect(debt[0]).toMatchObject({
        landingDebtDisposition: "discharged",
        landingProof: { source: "board_merged_pr", proofActivityId: attached.body.proofActivityId },
      });
    });

    it("serializes two concurrent attaches of the same evidence: one record and one replay", async () => {
      const { issueId } = await seedStuckCard();
      await reclassifyRecordOnly(issueId);
      const responses = await Promise.all([attach(issueId, goodProof()), attach(issueId, goodProof())]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
      expect(responses.find((response) => response.status === 200)!.body.replayed).toBe(true);
      expect(await proofRows(issueId)).toHaveLength(1);
      expect(await workProducts(issueId)).toHaveLength(1);
      expect((await debtDispositions(issueId)).map((d) => d.landingDebtDisposition)).toEqual(["outstanding"]);
    });
  });

  describe("an attached proof never overrides another close guard", () => {
    // Each cell attaches a valid proof first, then adds one other close blocker.
    // The board close must refuse with that blocker, the card must stay open, and
    // the debt must stay owed. The stash and zero-delta close guards do not exist
    // on this base, so they have no cell here.
    const RECORD_ONLY_EVIDENCE =
      "record-only probe `curl -fsS https://ops.example.com/api/sweep/healthz` target https://ops.example.com observed 2026-11-04T09:15:00Z result: pass the sweep consumption point served 42 fresh records";
    const cells: Array<{
      name: string;
      block: (card: { companyId: string; issueId: string; identifier: string; agentId: string }) => Promise<void>;
      body?: object;
      status: number;
      code?: string;
      error?: string;
    }> = [
      {
        name: "an execution branch ahead of base with no merged PR (done tier 0)",
        block: async ({ companyId, issueId, identifier }) => {
          const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
          const workspaceId = randomUUID();
          const now = new Date();
          github.branches.set(`deliver/${identifier}`, FEATURE_HEAD);
          await db.insert(executionWorkspaces).values({
            id: workspaceId, companyId, projectId: row!.projectId!, projectWorkspaceId: row!.projectWorkspaceId!,
            sourceIssueId: null, mode: "isolated_workspace", strategyType: "git_worktree", name: "late-ws",
            status: "active", cwd: "/tmp/landing-proof-late-ws", repoUrl: `https://github.com/${OWNER}/${REPO}`,
            baseRef: BASE, branchName: `deliver/${identifier}`, providerType: "git_worktree",
            providerRef: "/tmp/landing-proof-late-ws", lastUsedAt: now, openedAt: now, createdAt: now, updatedAt: now,
          });
          await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
        },
        status: 409,
        code: "done_transition_missing_delivery",
      },
      {
        name: "the card's own open draft PR linked to it (draft)",
        block: async ({ companyId, issueId, identifier }) => {
          // The draft guard counts only the card's own draft: its head branch starts with the card identifier.
          const headRef = `${identifier.toLowerCase()}-follow-up`;
          github.prs.get(509)!.head.ref = headRef;
          const [object] = await db.insert(externalObjects).values({
            companyId, providerKey: "github", objectType: "pull_request", externalId: `${OWNER}/${REPO}#pull/509`,
            data: {
              state: "open", draft: true, headRef, headRepoFullName: `${OWNER}/${REPO}`, title: `${identifier}: follow-up`,
            },
          }).returning();
          await db.insert(externalObjectMentions).values({
            companyId, sourceIssueId: issueId, sourceKind: "comment", objectId: object!.id,
            providerKey: "github", objectType: "pull_request",
          });
        },
        status: 409,
        error: "head_draft",
      },
      {
        name: "a conflicting dual-source done-tier declaration (done tier)",
        block: async () => {},
        body: {
          comment: `Closing on live probe evidence.\n\nClosed at Tier 2 (live): ${RECORD_ONLY_EVIDENCE}`,
          doneTier: { tier: "tier2", probeEvidence: "Re-ran the sweep probe and it passed." },
        },
        status: 422,
        code: "done_tier_dual_source_conflict",
      },
      {
        name: "two laddered children and no approval stage (approvals)",
        block: async ({ companyId, issueId, identifier, agentId }) => {
          const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
          for (const n of [2, 3]) {
            await db.insert(issues).values({
              id: randomUUID(), companyId, identifier: identifier.replace(/-1$/, `-${n}`), parentId: issueId,
              title: `Laddered child ${n}`, status: "done", priority: "medium", assigneeAgentId: agentId,
              createdByUserId: "local-board", projectId: row!.projectId, deliveryRequirement: "record_only",
              executionPolicy: row!.executionPolicy, executionState: row!.executionState, completedAt: new Date(),
            });
          }
        },
        status: 409,
        code: "done_transition_missing_approval_stage",
      },
    ];

    it.each(cells)("refuses the close on $name", async (cell) => {
      const card = await seedStuckCard();
      await reclassifyRecordOnly(card.issueId);
      const attached = await attach(card.issueId, goodProof());
      expect(attached.status, JSON.stringify(attached.body)).toBe(201);
      await cell.block(card);
      const close = await patch(card.issueId, { status: "done", ...(cell.body ?? {}) });
      expect(close.status, JSON.stringify(close.body)).toBe(cell.status);
      if (cell.code) expect(close.body.code).toBe(cell.code);
      if (cell.error) expect(close.body.error).toContain(cell.error);
      expect(await statusOf(card.issueId)).toBe("in_progress");
      const debt = await debtDispositions(card.issueId);
      expect(debt.map((d) => d.landingDebtDisposition)).toEqual(["outstanding"]);
      expect(debt[0]!.landingProof ?? null).toBeNull();
    });
  });

  describe("the real bearer-token and MCP path", () => {
    const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
    let boardToken = "";
    let foreignBoardToken = "";

    beforeAll(async () => {
      // The board API key belongs to the board user that the seeded companies list as owner.
      await db.insert(authUsers).values({
        id: "local-board", name: "Board", email: "board@example.com", createdAt: new Date(), updatedAt: new Date(),
      }).onConflictDoNothing();
      boardToken = `pcp_board_${randomUUID()}`;
      await db.insert(boardApiKeys).values({
        id: randomUUID(), userId: "local-board", name: "landing-proof-board", keyHash: hashToken(boardToken), scope: "all_access",
      });
      // A board user with no membership in any seeded company.
      const foreignUserId = `foreign-${randomUUID()}`;
      await db.insert(authUsers).values({
        id: foreignUserId, name: "Foreign", email: `${foreignUserId}@example.com`, createdAt: new Date(), updatedAt: new Date(),
      });
      foreignBoardToken = `pcp_board_${randomUUID()}`;
      await db.insert(boardApiKeys).values({
        id: randomUUID(), userId: foreignUserId, name: "landing-proof-foreign", keyHash: hashToken(foreignBoardToken), scope: "all_access",
      });
    });

    let previousJwtSecret: string | undefined;
    beforeAll(() => {
      previousJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
      process.env.PAPERCLIP_AGENT_JWT_SECRET = `landing-proof-jwt-${randomUUID()}`;
    });
    afterAll(() => {
      if (previousJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousJwtSecret;
    });

    function mcpAttach(
      apiKey: string,
      card: { companyId: string; issueId: string; agentId?: string },
      body: object,
      options: { path?: string; runId?: string | null } = {},
    ) {
      const client = new PaperclipApiClient({
        apiUrl: authApiUrl, apiKey, companyId: card.companyId, agentId: card.agentId ?? null, runId: options.runId ?? null,
      });
      const tool = createToolDefinitions(client).find((candidate) => candidate.name === "paperclipApiRequest")!;
      return tool.execute({
        method: "POST", path: options.path ?? `/api/issues/${card.issueId}/landing-proof`, jsonBody: JSON.stringify(body),
      }).then((response) => JSON.parse(response.content[0]!.text) as Record<string, any>);
    }

    it("attaches through paperclipApiRequest with a board API key, and the audit carries no token", async () => {
      const card = await seedStuckCard();
      await reclassifyRecordOnly(card.issueId);
      const result = await mcpAttach(boardToken, card, goodProof());
      expect(result.error, JSON.stringify(result)).toBeUndefined();
      expect(result.proof).toMatchObject({ owner: OWNER, repo: REPO, pullRequestNumber: 501 });
      const rows = await proofRows(card.issueId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorType: "user", actorId: "local-board" });
      for (const text of [JSON.stringify(rows), JSON.stringify(result), JSON.stringify(await workProducts(card.issueId))]) {
        expect(text).not.toContain(boardToken);
        expect(text).not.toContain("test-token");
      }
    });

    it("refuses an agent API key through paperclipApiRequest with 403 and records nothing", async () => {
      const card = await seedStuckCard();
      await reclassifyRecordOnly(card.issueId);
      const agentToken = `pcp_agent_${randomUUID()}`;
      await db.insert(agentApiKeys).values({
        id: randomUUID(), agentId: card.agentId, companyId: card.companyId, name: "landing-proof-agent",
        keyHash: hashToken(agentToken), responsibleUserId: "local-board",
      });
      const result = await mcpAttach(agentToken, card, goodProof());
      expect(result.status, JSON.stringify(result)).toBe(403);
      expect(await proofRows(card.issueId)).toHaveLength(0);
      expect(await workProducts(card.issueId)).toHaveLength(0);
    });

    it("refuses a board API key from outside the card's company, and records nothing", async () => {
      const card = await seedStuckCard();
      await reclassifyRecordOnly(card.issueId);
      const result = await mcpAttach(foreignBoardToken, card, goodProof());
      expect([403, 404], JSON.stringify(result)).toContain(result.status);
      expect(await proofRows(card.issueId)).toHaveLength(0);
    });

    it("refuses the assignee's run-scoped agent JWT, on the id and on the identifier alias, and records nothing", async () => {
      const card = await seedStuckCard();
      await reclassifyRecordOnly(card.issueId);
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId, companyId: card.companyId, agentId: card.agentId, status: "running", contextSnapshot: { issueId: card.issueId },
      });
      await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, card.issueId));
      const runToken = createLocalAgentJwt(card.agentId, card.companyId, "codex_local", runId);
      expect(runToken).toBeTruthy();
      for (const path of [`/api/issues/${card.issueId}/landing-proof`, `/api/issues/${card.identifier}/landing-proof`]) {
        const result = await mcpAttach(runToken!, card, goodProof(), { path, runId });
        expect(result.status, JSON.stringify(result)).toBe(403);
      }
      expect(await proofRows(card.issueId)).toHaveLength(0);
      expect(await workProducts(card.issueId)).toHaveLength(0);
    });

    it("treats the identifier alias as the same card: a board key attaches there, and the id replays it", async () => {
      const card = await seedStuckCard();
      await reclassifyRecordOnly(card.issueId);
      const viaAlias = await mcpAttach(boardToken, card, goodProof(), { path: `/api/issues/${card.identifier}/landing-proof` });
      expect(viaAlias.error, JSON.stringify(viaAlias)).toBeUndefined();
      expect(viaAlias.replayed ?? false).toBe(false);
      const viaId = await mcpAttach(boardToken, card, goodProof());
      expect(viaId.replayed, JSON.stringify(viaId)).toBe(true);
      expect(await proofRows(card.issueId)).toHaveLength(1);
    });

    it("refuses a call with a missing or unknown bearer token, and records nothing", async () => {
      const card = await seedStuckCard();
      await reclassifyRecordOnly(card.issueId);
      const anonymous = await fetch(`${authApiUrl}/issues/${card.issueId}/landing-proof`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(goodProof()),
      });
      expect([401, 403]).toContain(anonymous.status);
      const unknown = await mcpAttach(`pcp_board_${randomUUID()}`, card, goodProof());
      expect([401, 403], JSON.stringify(unknown)).toContain(unknown.status);
      expect(await proofRows(card.issueId)).toHaveLength(0);
    });
  });
});
