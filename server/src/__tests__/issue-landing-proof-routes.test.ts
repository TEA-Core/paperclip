import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
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

interface FakePr {
  state: "open" | "closed";
  merged: boolean;
  merge_commit_sha: string | null;
  head: { sha: string; ref: string; repo: { full_name: string } };
  base: { ref: string };
  draft: boolean;
}

/** The faked GitHub reader: PRs by number, base branch heads, and commits contained in base. */
const github = {
  prs: new Map<number, FakePr>(),
  branches: new Map<string, string>(),
  onBase: new Set<string>(),
  compareStatus: null as number | null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function fakeGitHub(url: string): Promise<Response> {
  const { pathname } = new URL(url);
  const prefix = `/repos/${OWNER}/${REPO}`;
  if (!pathname.startsWith(prefix)) return json({ message: "Not Found" }, 404);
  const rest = decodeURIComponent(pathname.slice(prefix.length));
  const pull = /^\/pulls\/(\d+)$/.exec(rest);
  if (pull) {
    const pr = github.prs.get(Number(pull[1]));
    return pr ? json({ number: Number(pull[1]), ...pr }) : json({ message: "Not Found" }, 404);
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
  github.branches.set(BASE, MERGE_ON_BASE);
  github.onBase.add(MERGE_ON_BASE);
  const pr = (over: Partial<FakePr>): FakePr => ({
    state: "closed",
    merged: true,
    merge_commit_sha: MERGE_ON_BASE,
    head: { sha: HEAD_OF_MERGED, ref: "deleted-after-merge", repo: { full_name: `${OWNER}/${REPO}` } },
    base: { ref: BASE },
    draft: false,
    ...over,
  });
  github.prs.set(501, pr({}));
  github.prs.set(502, pr({ state: "open", merged: false, merge_commit_sha: null }));
  github.prs.set(503, pr({ state: "closed", merged: false, merge_commit_sha: null }));
  github.prs.set(504, pr({ merge_commit_sha: MERGE_OFF_BASE }));
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("SUP-25193 board landing proof route", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
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
  }, 60_000);

  afterAll(async () => {
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
    const participant = options.participant === "agent"
      ? { type: "agent", agentId }
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
          lastDecisionId: null, lastDecisionOutcome: null,
        }
        : {
          status: "completed", currentStageId: null, currentStageIndex: null, currentStageType: null,
          currentParticipant: null, returnAssignee: null, completedStageIds: [stageId], skippedStageIds: [],
          lastDecisionId: null, lastDecisionOutcome: "approved",
        },
    });
    return { companyId, agentId, issueId, identifier };
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
  const workProducts = (id: string) => db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, id));
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
    const { issueId } = await seedStuckCard();
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
    ["an agent review stage", { participant: "agent" as const }],
    ["a live (pending) review workflow", { workflow: "pending" as const }],
  ])("refuses a card with %s as not applicable", async (_label, options) => {
    const { issueId } = await seedStuckCard(options);
    const refused = await attach(issueId, goodProof());
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.code).toBe("landing_proof_not_applicable");
    expect(await proofRows(issueId)).toHaveLength(0);
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
});
