import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  externalObjectMentions,
  externalObjects,
  heartbeatRuns,
  issueDeliveryReceiptLinks,
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
 * between approval and publish). This mechanical first-publish recovery
 * re-runs publishApprovalStatus verbatim — pinned to the decision-time head,
 * delivery-identity enforced — instead of a human hand-writing the status, which
 * would manufacture a fake approval. Board owner/admin only; an agent caller is
 * refused before any GitHub read or write.
 */

const GITHUB_TOKEN = "ghp_test_token_value";
const HEAD_SHA = "cc64bd51f6f9de495f82dad7e34a056e61209312";
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

    await db.delete(issueDeliveryReceiptLinks);
    await db.delete(issueDeliveryReceipts);
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

  async function rejectActivityLogInserts() {
    await db.execute(sql.raw(
      "alter table activity_log add constraint merge_arming_republish_force_audit_failure check (false) not valid",
    ));
  }

  async function allowActivityLogInserts() {
    await db.execute(sql.raw(
      "alter table activity_log drop constraint if exists merge_arming_republish_force_audit_failure",
    ));
  }

  async function rejectRecoveredExternalObjectUpserts() {
    await db.execute(sql.raw(
      "alter table external_objects add constraint merge_arming_republish_force_external_object_failure check (false) not valid",
    ));
  }

  async function allowRecoveredExternalObjectUpserts() {
    await db.execute(sql.raw(
      "alter table external_objects drop constraint if exists merge_arming_republish_force_external_object_failure",
    ));
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
    /** Omit returnAssigneeAgentId from the execution policy (unresolvable guard-b path). */
    noReturnAssignee?: boolean;
    /** Seed a linked PR external object + mention. */
    pr?: { owner: string; repo: string; number: number; headRefName: string | null } | null;
    deliveryBranch?: string | null;
    deliveryRepoUrl?: string | null;
    /**
     * SUP-14783: make the execution-workspace row a real `shared_workspace`
     * row OWNED BY A DIFFERENT issue (a parent card is seeded to own it), which
     * is the shape every card in a shared-workspace project carries.
     */
    sharedWorkspaceOwnedByParent?: boolean;
    /** Pre-seed executionState.approvalStatus.publishedHeadSha (idempotent path). */
    prePublishedHeadSha?: string | null;
    deliveryReceipt?: boolean;
    certifiedDelivery?: boolean;

    /**
     * SUP-15459: append extra stages to the execution policy that are NOT in
     * completedStageIds — the mid-ladder shape (the ladder is still running, the
     * card merely has one approved stage behind it).
     */
    pendingStageIds?: string[];
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
    // SUP-14783: the owning parent card must exist before the shared workspace
    // row can point at it (execution_workspaces.source_issue_id is a real FK).
    let parentOwnerIssueId: string | null = null;
    if (opts.sharedWorkspaceOwnedByParent) {
      parentOwnerIssueId = randomUUID();
      await db.insert(issues).values({
        id: parentOwnerIssueId,
        companyId,
        projectId,
        title: "Parent card owning the shared workspace",
        status: "in_progress",
        identifier: "SUP-14668",
      });
    }
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      ...(parentOwnerIssueId
        ? { mode: "shared_workspace", sourceIssueId: parentOwnerIssueId }
        : { mode: "isolated" }),
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
      lastDecisionId: opts.certifiedDelivery ? "decision-42" : null,
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
    if (opts.certifiedDelivery && opts.pr) {
      executionState.approvalStatus = {
        finalDelivery: {
          owner: opts.pr.owner, repo: opts.pr.repo, number: opts.pr.number,
          headSha: HEAD_SHA, displayName: `${opts.pr.owner}/${opts.pr.repo}#${opts.pr.number}`,
          decisionId: "decision-42",
        },
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
      // ADR-091 D1 (SUP-15909): the shared-workspace owner is the card's genuine
      // ADR-083 carrier ancestor, so wire it as the card's parent.
      ...(parentOwnerIssueId ? { parentId: parentOwnerIssueId } : {}),
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        // ADR-092 D3: declare a return assignee distinct from the assignee/decision
        // actor so the resolved gated principal does not collide with the reviewer
        // that cast the approval (keeps the happy-path card guard-b-legal).
        ...(opts.noReturnAssignee ? {} : { returnAssigneeAgentId }),
        stages: [
          { id: STAGE_ID, type: "approval", approvalsNeeded: 1 },
          ...(opts.pendingStageIds ?? []).map((id) => ({
            id,
            type: "review",
            approvalsNeeded: 1,
          })),
        ],
      },
      executionState,
    });

    if (opts.seedDecision !== false) {
      // One decision row per COMPLETED stage: guard-b:stage-without-decision
      // refuses any completed stage that has none, so a multi-stage terminal
      // fixture has to carry a real verdict for every stage it claims completed.
      const completedForDecisions = (executionState.completedStageIds as string[]) ?? [STAGE_ID];
      await db.insert(issueExecutionDecisions).values(
        completedForDecisions.map((stageId) => ({
          companyId,
          issueId,
          stageId,
          stageType: stageId === STAGE_ID ? "approval" : "review",
          actorAgentId: opts.returnAssigneeDecides ? returnAssigneeAgentId : reviewerAgentId,
          actorUserId: null,
          outcome: "approved",
          body: "Approved",
          createdAt: now,
          updatedAt: now,
        })),
      );
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
      const mention: typeof externalObjectMentions.$inferInsert = {
        companyId,
        sourceIssueId: issueId,
        sourceKind: "comment",
        objectId: externalObj!.id,
        objectType: "pull_request",
        providerKey: "github",
      };
      await db.insert(externalObjectMentions).values(mention);
      if (opts.deliveryReceipt) {
        const receiptId = randomUUID();
        await db.insert(issueDeliveryReceipts).values({
          id: receiptId,
          companyId,
          sourceIssueId: issueId,
          provider: "github",
          owner: opts.pr.owner.toLowerCase(),
          repo: opts.pr.repo.toLowerCase(),
          pullRequestNumber: opts.pr.number,
          headSha: HEAD_SHA,
          branchName: opts.pr.headRefName ?? DELIVERY_BRANCH,
          sourceDeliveryRecord: { fixture: true },
          recoveryReason: "authorized test publication",
          authorizedByActorType: "user",
          authorizedByActorId: USER_ID,
          idempotencyKey: `fixture-${issueId}-${HEAD_SHA}`,
          state: "ready",
        });
        await db.insert(issueDeliveryReceiptLinks).values({
          companyId,
          receiptId,
          sourceIssueId: issueId,
          externalObjectId: externalObj!.id,
          provider: "github",
          owner: opts.pr.owner.toLowerCase(),
          repo: opts.pr.repo.toLowerCase(),
          pullRequestNumber: opts.pr.number,
          headSha: HEAD_SHA,
        });
      }
    }

    return { companyId, issueId, identifier, reviewerAgentId };
  }

  const REVIEWED_HEAD = "a".repeat(40);
  const REVIEW_HEAD = "b".repeat(40);
  const REVIEW_BASE = "d".repeat(40);

  async function seedHeadReview() {
    const fixture = await seedIssue({
      prePublishedHeadSha: REVIEWED_HEAD,
      pr: { owner: OWNER, repo: REPO, number: PR_NUMBER, headRefName: DELIVERY_BRANCH },
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    await db.update(issues).set({
      status: "done",
      executionState: {
        ...issue!.executionState,
        lastDecisionId: "decision-42",
        approvalStatus: {
          publishedHeadSha: REVIEWED_HEAD, publishedAt: new Date().toISOString(),
          finalDelivery: {
            owner: OWNER, repo: REPO, number: PR_NUMBER, headSha: REVIEWED_HEAD,
            displayName: `${OWNER}/${REPO}#${PR_NUMBER}`, decisionId: "decision-42",
          },
        },
        delivery: {
          branch: DELIVERY_BRANCH, headSha: REVIEWED_HEAD,
          repo: { owner: OWNER, repo: REPO }, prNumber: PR_NUMBER,
          prUrl: `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}`,
          sourceIssueId: fixture.issueId,
        },
      },
    }).where(eq(issues.id, fixture.issueId));
    return fixture;
  }

  async function seedHeadReviewReceipt(companyId: string, issueId: string, headSha: string) {
    const [mention] = await db.select().from(externalObjectMentions).where(eq(externalObjectMentions.sourceIssueId, issueId));
    const receiptId = randomUUID();
    await db.insert(issueDeliveryReceipts).values({
      id: receiptId, companyId, sourceIssueId: issueId, provider: "github",
      owner: OWNER.toLowerCase(), repo: REPO.toLowerCase(), pullRequestNumber: PR_NUMBER, headSha,
      branchName: DELIVERY_BRANCH, sourceDeliveryRecord: { fixture: true },
      recoveryReason: "authorized test publication", authorizedByActorType: "user", authorizedByActorId: USER_ID,
      idempotencyKey: `fixture-${issueId}-${headSha}`, state: "ready",
    });
    await db.insert(issueDeliveryReceiptLinks).values({
      companyId, receiptId, sourceIssueId: issueId, externalObjectId: mention!.objectId, provider: "github",
      owner: OWNER.toLowerCase(), repo: REPO.toLowerCase(), pullRequestNumber: PR_NUMBER, headSha,
    });
  }

  function installHeadReviewTransport(options: { moveAtPublish?: boolean; branch?: string } = {}) {
    let reads = 0;
    mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith(`/pulls/${PR_NUMBER}`)) {
        reads++;
        return createMockResponse({
          state: "open", merged: false, draft: false,
          html_url: `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}`,
          head: { sha: options.moveAtPublish && reads > 1 ? "c".repeat(40) : REVIEW_HEAD, ref: options.branch ?? DELIVERY_BRANCH },
          base: { sha: REVIEW_BASE },
        });
      }
      if (url.includes("/compare/")) {
        return createMockResponse({ files: [{
          filename: "config.txt", status: "modified",
          sha: url.endsWith(REVIEWED_HEAD) ? "reviewed-blob" : "revised-blob",
          additions: 1, deletions: 1,
          patch: `@@ -1 +1 @@\n-original\n+${url.endsWith(REVIEWED_HEAD) ? "reviewed" : "revised"}`,
        }] });
      }
      if (url.includes("/git/commits/")) {
        const sha = url.split("/").at(-1)!;
        return createMockResponse({ sha, tree: { sha: `tree-${sha}` } });
      }
      if (url.endsWith(`/statuses/${REVIEW_HEAD}`) && init?.method === "POST") return createMockResponse({ id: 991 });
      throw new Error(`Unexpected head-review request: ${url}`);
    });
  }

  it("approves exactly the board-reviewed new head without reopening a completed ladder (SUP-20624, SUP-20667)", async () => {
    const { companyId, issueId } = await seedHeadReview();
    currentActor = boardActor(companyId);
    installHeadReviewTransport();
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    const decisionsBefore = await db.select().from(issueExecutionDecisions);

    const preview = await request(app).get(`/api/issues/${issueId}/merge-arming/head-review`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      approvedHeadSha: REVIEWED_HEAD, headSha: REVIEW_HEAD,
      delta: { equivalence: null, files: [{ filename: "config.txt", approved: { sha: "reviewed-blob" }, live: { sha: "revised-blob" } }] },
    });
    expect(mockGhFetch.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([]);

    const response = await request(app).post(`/api/issues/${issueId}/merge-arming/approve-head`).send({
      approvedHeadSha: preview.body.approvedHeadSha, headSha: preview.body.headSha,
      reason: "Reviewed the post-ladder config correction",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: "armed", headSha: REVIEW_HEAD });
    const writes = mockGhFetch.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes.map(([url]) => url)).toEqual([`https://api.github.com/repos/${OWNER}/${REPO}/statuses/${REVIEW_HEAD}`]);
    const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(after!.status).toBe("done");
    expect(after!.executionPolicy).toEqual(before!.executionPolicy);
    const { approvalStatus: beforeApproval, ...beforeLadder } = before!.executionState!;
    const { approvalStatus: afterApproval, ...afterLadder } = after!.executionState!;
    expect(afterLadder).toEqual(beforeLadder);
    expect(afterApproval).toMatchObject({ publishedHeadSha: REVIEW_HEAD, approvedHeadSha: REVIEW_HEAD });
    expect(await db.select().from(issueExecutionDecisions)).toEqual(decisionsBefore);
    const events = await db.select().from(activityLog);
    expect(events.find((event) => event.action === "issue.approval_head_decision")).toMatchObject({
      actorType: "user",
      actorId: USER_ID,
      details: { headSha: REVIEW_HEAD, approvedHeadSha: REVIEWED_HEAD, reason: "Reviewed the post-ladder config correction" },
    });
  });

  it("reviews a new head from a certified but never-published approval (SUP-20624)", async () => {
    const { companyId, issueId } = await seedHeadReview();
    currentActor = boardActor(companyId);
    await db.execute(sql`update ${issues} set execution_state = jsonb_set(execution_state, '{approvalStatus}',
      execution_state -> 'approvalStatus' || ${JSON.stringify({ approvedHeadSha: REVIEWED_HEAD, publishedHeadSha: null })}::jsonb) where id = ${issueId}`);
    installHeadReviewTransport();
    const response = await request(app).post(`/api/issues/${issueId}/merge-arming/approve-head`).send({
      approvedHeadSha: REVIEWED_HEAD, headSha: REVIEW_HEAD, reason: "Reviewed the newly delivered head",
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: "armed", headSha: REVIEW_HEAD });
    const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(after!.executionState!.approvalStatus).toMatchObject({ publishedHeadSha: REVIEW_HEAD });
  });

  it("approves an unbound delivery without authorizing another cited repository (SUP-20624)", async () => {
    const { companyId, issueId } = await seedHeadReview();
    currentActor = boardActor(companyId);
    await db.execute(sql`update ${issues} set execution_state = jsonb_set(execution_state, '{delivery}',
      (execution_state -> 'delivery') - 'prNumber' - 'prUrl' - 'sourceIssueId') where id = ${issueId}`);
    const [citation] = await db.insert(externalObjects).values({
      companyId, providerKey: "github", objectType: "pull_request",
      externalId: "TEA-Core/another-repo#pull/99",
      data: { state: "open", draft: false, headRef: "SUP-99999-other-card-branch" },
    }).returning();
    await db.insert(externalObjectMentions).values({
      companyId, sourceIssueId: issueId, sourceKind: "comment", objectId: citation!.id,
      objectType: "pull_request", providerKey: "github",
    });
    installHeadReviewTransport();
    const response = await request(app).post(`/api/issues/${issueId}/merge-arming/approve-head`).send({
      approvedHeadSha: REVIEWED_HEAD, headSha: REVIEW_HEAD, reason: "Reviewed this card's delivery only",
    });
    expect(response.status).toBe(200);
    expect(mockGhFetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => url))
      .toEqual([`https://api.github.com/repos/${OWNER}/${REPO}/statuses/${REVIEW_HEAD}`]);
  });

  async function makeHeadReviewUncertified(issueId: string) {
    await db.execute(sql`update ${issues} set execution_state = jsonb_set(execution_state, '{approvalStatus}',
      (execution_state -> 'approvalStatus') - 'finalDelivery') where id = ${issueId}`);
  }

  it.each([
    { receipt: "none", reason: "delivery-receipt-missing" },
    { receipt: "prior-head", reason: "delivery-receipt-head_mismatch" },
  ])("refuses head approval of an uncertified card with $receipt receipt without a status write (SUP-20624)", async ({ receipt, reason }) => {
    const { companyId, issueId } = await seedHeadReview();
    currentActor = boardActor(companyId);
    await makeHeadReviewUncertified(issueId);
    if (receipt === "prior-head") await seedHeadReviewReceipt(companyId, issueId, REVIEWED_HEAD);
    installHeadReviewTransport();
    const response = await request(app).post(`/api/issues/${issueId}/merge-arming/approve-head`).send({
      approvedHeadSha: REVIEWED_HEAD, headSha: REVIEW_HEAD, reason: "Reviewed delta",
    });
    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toContain(reason);
    expect(mockGhFetch.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([]);
    const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(after!.executionState!.approvalStatus).toMatchObject({ publishedHeadSha: REVIEWED_HEAD });
  });

  it("refuses head approval when the certified final delivery names a different PR (SUP-20624)", async () => {
    const { companyId, issueId } = await seedHeadReview();
    currentActor = boardActor(companyId);
    await db.execute(sql`update ${issues} set execution_state = jsonb_set(execution_state,
      '{approvalStatus,finalDelivery,number}', ${PR_NUMBER + 1}::int::text::jsonb) where id = ${issueId}`);
    installHeadReviewTransport();
    const response = await request(app).post(`/api/issues/${issueId}/merge-arming/approve-head`).send({
      approvedHeadSha: REVIEWED_HEAD, headSha: REVIEW_HEAD, reason: "Reviewed delta",
    });
    expect(response.status).toBe(409);
    expect(mockGhFetch.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([]);
    const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(after!.executionState!.approvalStatus).toMatchObject({ publishedHeadSha: REVIEWED_HEAD });
  });

  it("does not hold the issue row lock while the head-review preview reads GitHub (SUP-20624)", async () => {
    const { companyId, issueId } = await seedHeadReview();
    currentActor = boardActor(companyId);
    installHeadReviewTransport();
    const transport = mockGhFetch.getMockImplementation()!;
    let entered!: () => void;
    const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const providerHeld = new Promise<void>((resolve) => { release = resolve; });
    mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      entered();
      await providerHeld;
      return transport(url, init);
    });
    const preview = request(app).get(`/api/issues/${issueId}/merge-arming/head-review`).then((res) => res);
    try {
      await providerEntered;
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '3s'`);
        await tx.update(issues).set({ title: "Concurrent writer" }).where(eq(issues.id, issueId));
      });
    } finally {
      release();
    }
    const response = await preview;
    expect(response.status).toBe(200);
    const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(after!.title).toBe("Concurrent writer");
  });

  it("approves an uncertified card head with a board receipt for exactly that head (SUP-20624)", async () => {
    const { companyId, issueId } = await seedHeadReview();
    currentActor = boardActor(companyId);
    await makeHeadReviewUncertified(issueId);
    await seedHeadReviewReceipt(companyId, issueId, REVIEW_HEAD);
    installHeadReviewTransport();
    const response = await request(app).post(`/api/issues/${issueId}/merge-arming/approve-head`).send({
      approvedHeadSha: REVIEWED_HEAD, headSha: REVIEW_HEAD, reason: "Reviewed delta",
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: "armed", headSha: REVIEW_HEAD });
    expect(mockGhFetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => url))
      .toEqual([`https://api.github.com/repos/${OWNER}/${REPO}/statuses/${REVIEW_HEAD}`]);
  });

  it.each(["unrelated-agent", "author", "cross-company", "board-member", "original-reviewer", "original-user-reviewer"])("refuses %s head approval before GitHub access (SUP-20624, SUP-20667)", async (principal) => {
    const { companyId, issueId, reviewerAgentId } = await seedHeadReview();
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const returnAssignee = issue!.executionPolicy!.returnAssigneeAgentId as string;
    const boardMember = principal === "board-member" || principal === "original-user-reviewer";
    currentActor = boardMember
      ? boardActor(companyId)
      : agentActor(principal === "cross-company" ? randomUUID() : companyId,
        principal === "author" ? returnAssignee : principal === "original-reviewer" ? reviewerAgentId : randomUUID());
    if (boardMember) {
      await db.update(companyMemberships).set({ membershipRole: "member" }).where(eq(companyMemberships.companyId, companyId));
    }
    if (principal === "original-user-reviewer") {
      await db.update(issueExecutionDecisions).set({ actorAgentId: null, actorUserId: USER_ID }).where(eq(issueExecutionDecisions.issueId, issueId));
    }
    const response = await request(app).post(`/api/issues/${issueId}/merge-arming/approve-head`).send({
      approvedHeadSha: REVIEWED_HEAD, headSha: REVIEW_HEAD, reason: "Not an authorized board actor",
    });
    expect(response.status).toBe(403);
    expect(mockGhFetch).not.toHaveBeenCalled();
    const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(after!.executionState).toEqual(issue!.executionState);
  });

  it.each(["not-done", "incomplete-ladder", "stale-anchor", "stale-head", "moved-at-publish", "foreign-branch"])("refuses unsafe %s head approval without a status write (SUP-20624)", async (scenario) => {
    const { companyId, issueId } = await seedHeadReview();
    currentActor = boardActor(companyId);
    if (scenario === "not-done") await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
    if (scenario === "incomplete-ladder") await db.execute(sql`update ${issues} set execution_state = jsonb_set(execution_state, '{completedStageIds}', '[]'::jsonb) where id = ${issueId}`);
    installHeadReviewTransport({ moveAtPublish: scenario === "moved-at-publish", branch: scenario === "foreign-branch" ? FOREIGN_BRANCH : undefined });
    const response = await request(app).post(`/api/issues/${issueId}/merge-arming/approve-head`).send({
      approvedHeadSha: scenario === "stale-anchor" ? "e".repeat(40) : REVIEWED_HEAD,
      headSha: scenario === "stale-head" ? "c".repeat(40) : REVIEW_HEAD,
      reason: "Reviewed delta",
    });
    expect(response.status).toBe(409);
    expect(mockGhFetch.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([]);
    const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(after!.executionState!.approvalStatus).toMatchObject({ publishedHeadSha: REVIEWED_HEAD });
  });

  it("does not stamp a new head if its approval decision cannot be audited (SUP-20624)", async () => {
    const { companyId, issueId } = await seedHeadReview();
    currentActor = boardActor(companyId);
    installHeadReviewTransport();
    await rejectActivityLogInserts();
    try {
      const response = await request(app).post(`/api/issues/${issueId}/merge-arming/approve-head`).send({
        approvedHeadSha: REVIEWED_HEAD, headSha: REVIEW_HEAD, reason: "Reviewed delta",
      });
      expect(response.status).toBe(500);
      expect(mockGhFetch.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([]);
    } finally {
      await allowActivityLogInserts();
    }
  });

  it("keeps the head-review audit if storing the published head fails after the external write (SUP-20624)", async () => {
    const { companyId, issueId } = await seedHeadReview();
    currentActor = boardActor(companyId);
    installHeadReviewTransport();
    await db.execute(sql`alter table ${issues} add constraint head_review_force_publish_record_failure
      check (execution_state #>> '{approvalStatus,publishedHeadSha}' <> repeat('b', 40)) not valid`);
    try {
      const response = await request(app).post(`/api/issues/${issueId}/merge-arming/approve-head`).send({
        approvedHeadSha: REVIEWED_HEAD, headSha: REVIEW_HEAD, reason: "Reviewed exact delta before publication",
      });
      expect(response.status).toBe(500);
      expect(mockGhFetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => url))
        .toEqual([`https://api.github.com/repos/${OWNER}/${REPO}/statuses/${REVIEW_HEAD}`]);
      const events = await db.select().from(activityLog);
      expect(events.find((event) => event.action === "issue.approval_head_decision")).toMatchObject({
        actorType: "user", actorId: USER_ID,
        details: { headSha: REVIEW_HEAD, approvedHeadSha: REVIEWED_HEAD, reason: "Reviewed exact delta before publication" },
      });
    } finally {
      await db.execute(sql`alter table ${issues} drop constraint if exists head_review_force_publish_record_failure`);
    }
  });

  it("rejects an agent caller with 403 before any GitHub read or write", async () => {
    const { companyId, issueId, reviewerAgentId } = await seedIssue({
      pr: { owner: OWNER, repo: REPO, number: PR_NUMBER, headRefName: DELIVERY_BRANCH },
    });
    currentActor = agentActor(companyId, reviewerAgentId);

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(403);
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("rejects an agent caller on governed receipt recovery before any GitHub read or persistence", async () => {
    const { companyId, issueId, reviewerAgentId } = await seedIssue();
    currentActor = agentActor(companyId, reviewerAgentId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/delivery-receipt-recovery`)
      .send({
        owner: OWNER,
        repo: REPO,
        pullRequestNumber: 579,
        headSha: HEAD_SHA,
        reason: "restore approved publication",
        idempotencyKey: "recover-agent-refused",
      });

    expect(res.status).toBe(403);
    expect(mockGhFetch).not.toHaveBeenCalled();
    expect(await db.select().from(issueDeliveryReceipts)).toHaveLength(0);
    expect(await db.select().from(issueDeliveryReceiptLinks)).toHaveLength(0);
  });

  it("rejects a non-owner board caller on governed receipt recovery before any GitHub read", async () => {
    const { companyId, issueId } = await seedIssue({ membershipRole: "operator" });
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/delivery-receipt-recovery`)
      .send({
        owner: OWNER,
        repo: REPO,
        pullRequestNumber: 579,
        headSha: HEAD_SHA,
        reason: "restore approved publication",
        idempotencyKey: "recover-operator-refused",
      });

    expect(res.status).toBe(403);
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("rejects a recovery request for a different repository before any GitHub read", async () => {
    const { companyId, issueId } = await seedIssue();
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/delivery-receipt-recovery`)
      .send({
        owner: "other-owner",
        repo: "other-repo",
        pullRequestNumber: 579,
        headSha: HEAD_SHA,
        reason: "restore approved publication",
        idempotencyKey: "recover-wrong-repo",
      });

    expect(res.status).toBe(500);
    expect(mockGhFetch).not.toHaveBeenCalled();
    expect(await db.select().from(issueDeliveryReceipts)).toHaveLength(0);
    expect(await db.select().from(issueDeliveryReceiptLinks)).toHaveLength(0);
  });

  it("recovers an unchanged exact head and replays the same idempotency key without a second GitHub read", async () => {
    const { companyId, issueId } = await seedIssue();
    currentActor = boardActor(companyId);
    mockGhFetch.mockResolvedValueOnce(createMockResponse({
      state: "open",
      merged: false,
      draft: false,
      head: {
        sha: HEAD_SHA,
        ref: DELIVERY_BRANCH,
        repo: { name: REPO, owner: { login: OWNER } },
      },
    }));
    const body = {
      owner: OWNER,
      repo: REPO,
      pullRequestNumber: 579,
      headSha: HEAD_SHA,
      reason: "restore approved publication",
      idempotencyKey: "recover-exact-head",
    };

    const first = await request(app).post(`/api/issues/${issueId}/delivery-receipt-recovery`).send(body);
    expect(first.status).toBe(201);
    expect(first.body.replayed).toBe(false);
    expect(first.body.receipt.state).toBe("ready");
    expect(first.body.receipt.headSha).toBe(HEAD_SHA);
    expect(mockGhFetch).toHaveBeenCalledTimes(1);
    expect(await db.select().from(issueDeliveryReceipts)).toHaveLength(1);
    expect(await db.select().from(issueDeliveryReceiptLinks)).toHaveLength(1);

    const second = await request(app).post(`/api/issues/${issueId}/delivery-receipt-recovery`).send(body);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.receipt.id).toBe(first.body.receipt.id);
    expect(mockGhFetch).toHaveBeenCalledTimes(1);
    expect(await db.select().from(issueDeliveryReceipts)).toHaveLength(1);
    expect(await db.select().from(issueDeliveryReceiptLinks)).toHaveLength(1);
    const receiptRows = await db.select().from(issueDeliveryReceipts);
    expect(receiptRows[0]?.state).toBe("ready");
  });

  it("recovers a receipt for a done card with an approved ladder and an open exact-head PR", async () => {
    const { companyId, issueId } = await seedIssue();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    currentActor = boardActor(companyId);
    mockGhFetch.mockResolvedValueOnce(createMockResponse({
      state: "open",
      merged: false,
      draft: false,
      head: {
        sha: HEAD_SHA,
        ref: DELIVERY_BRANCH,
        repo: { name: REPO, owner: { login: OWNER } },
      },
    }));

    const res = await request(app).post(`/api/issues/${issueId}/delivery-receipt-recovery`).send({
      owner: OWNER,
      repo: REPO,
      pullRequestNumber: 579,
      headSha: HEAD_SHA,
      reason: "restore approved publication on done card",
      idempotencyKey: "recover-done-card",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.receipt.headSha).toBe(HEAD_SHA);
    expect(mockGhFetch).toHaveBeenCalledTimes(1);
    expect(await db.select().from(issueDeliveryReceiptLinks)).toHaveLength(1);
  });

  it("publishes the recovered target head once and consumes its receipt exactly once", async () => {
    const { companyId, issueId } = await seedIssue({
      pr: { owner: OWNER, repo: REPO, number: 579, headRefName: DELIVERY_BRANCH },
    });
    currentActor = boardActor(companyId);
    mockGhFetch
      .mockResolvedValueOnce(createMockResponse({
        state: "open",
        merged: false,
        draft: false,
        head: {
          sha: HEAD_SHA,
          ref: DELIVERY_BRANCH,
          repo: { name: REPO, owner: { login: OWNER } },
        },
      }))
      .mockResolvedValueOnce(createMockResponse({ head: { sha: HEAD_SHA }, html_url: `https://github.com/${OWNER}/${REPO}/pull/579` }))
      .mockResolvedValueOnce(createMockResponse({ head: { sha: HEAD_SHA } }))
      .mockImplementationOnce(async () => {
        const [claimedReceipt] = await db.select().from(issueDeliveryReceipts);
        expect(claimedReceipt?.state).toBe("claimed");
        return createMockResponse({ id: 579 });
      });

    const recovered = await request(app)
      .post(`/api/issues/${issueId}/delivery-receipt-recovery`)
      .send({
        owner: OWNER,
        repo: REPO,
        pullRequestNumber: 579,
        headSha: HEAD_SHA,
        reason: "restore approved publication",
        idempotencyKey: "recover-then-publish",
      });
    expect(recovered.status).toBe(201);
    expect(recovered.body.receipt.state).toBe("ready");

    const published = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);
    expect(published.status).toBe(200);
    expect(published.body.outcome).toBe("armed");
    expect(published.body.headSha).toBe(HEAD_SHA);
    const statusWrites = mockGhFetch.mock.calls.filter(
      (call) => typeof call[0] === "string" && (call[0] as string).includes("/statuses/"),
    );
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0]![0]).toBe(`https://api.github.com/repos/${OWNER}/${REPO}/statuses/${HEAD_SHA}`);
    expect(statusWrites[0]![1]?.method).toBe("POST");
    expect(JSON.parse(statusWrites[0]![1]!.body as string)).toMatchObject({
      context: "paperclip/approved",
      state: "success",
    });
    const [receipt] = await db.select().from(issueDeliveryReceipts);
    expect(receipt?.headSha).toBe(HEAD_SHA);
    expect(receipt?.state).toBe("consumed");

    const replay = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);
    expect(replay.status).toBe(200);
    expect(replay.body.outcome).toBe("already_published");
    expect(mockGhFetch).toHaveBeenCalledTimes(4);
    const [replayedReceipt] = await db.select().from(issueDeliveryReceipts);
    expect(replayedReceipt?.state).toBe("consumed");
  });

  it("invalidates a recovered receipt when the exact-head status write fails", async () => {
    const { companyId, issueId } = await seedIssue({
      pr: { owner: OWNER, repo: REPO, number: PR_NUMBER, headRefName: DELIVERY_BRANCH },
    });
    currentActor = boardActor(companyId);
    mockGhFetch.mockResolvedValueOnce(createMockResponse({
      state: "open",
      merged: false,
      draft: false,
      head: {
        sha: HEAD_SHA,
        ref: DELIVERY_BRANCH,
        repo: { name: REPO, owner: { login: OWNER } },
      },
    }));

    const recovered = await request(app)
      .post(`/api/issues/${issueId}/delivery-receipt-recovery`)
      .send({
        owner: OWNER,
        repo: REPO,
        pullRequestNumber: PR_NUMBER,
        headSha: HEAD_SHA,
        reason: "restore approved publication",
        idempotencyKey: "recover-then-fail-status",
      });
    expect(recovered.status).toBe(201);
    expect(recovered.body.receipt.state).toBe("ready");

    mockGhFetch
      .mockResolvedValueOnce(createMockResponse({ head: { sha: HEAD_SHA } }))
      .mockResolvedValueOnce(createMockResponse({ head: { sha: HEAD_SHA } }))
      .mockResolvedValueOnce(createMockResponse({ message: "forbidden" }, false, 403));

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(409);
    expect(res.body.outcome).toBe("failed");
    expect(res.body.message).toContain("status:failed");
    const statusWrites = mockGhFetch.mock.calls.filter(
      (call) => typeof call[0] === "string" && (call[0] as string).includes("/statuses/"),
    );
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0]![0]).toBe(`https://api.github.com/repos/${OWNER}/${REPO}/statuses/${HEAD_SHA}`);
    expect(statusWrites[0]![1]?.method).toBe("POST");
    const [receipt] = await db.select().from(issueDeliveryReceipts);
    expect(receipt?.state).toBe("invalidated");
    const [row] = await db.select({ executionState: issues.executionState }).from(issues).where(eq(issues.id, issueId));
    expect((row?.executionState as Record<string, unknown> | undefined)?.approvalStatus).toBeUndefined();
  });

  it.each([
    ["closed", { state: "closed", merged: false, draft: false }],
    ["merged", { state: "closed", merged: true, draft: false }],
    ["draft", { state: "open", merged: false, draft: true }],
  ])("refuses a %s PR recovery without writing a receipt", async (_label, pullRequest) => {
    const { companyId, issueId } = await seedIssue();
    currentActor = boardActor(companyId);
    mockGhFetch.mockResolvedValueOnce(createMockResponse({
      ...pullRequest,
      head: {
        sha: HEAD_SHA,
        ref: DELIVERY_BRANCH,
        repo: { name: REPO, owner: { login: OWNER } },
      },
    }));

    const res = await request(app)
      .post(`/api/issues/${issueId}/delivery-receipt-recovery`)
      .send({
        owner: OWNER,
        repo: REPO,
        pullRequestNumber: 579,
        headSha: HEAD_SHA,
        reason: "restore approved publication",
        idempotencyKey: `recover-${_label}`,
      });

    expect(res.status).toBe(500);
    expect(mockGhFetch).toHaveBeenCalledTimes(1);
    expect(mockGhFetch.mock.calls.some(([url]) => typeof url === "string" && url.includes("/statuses/"))).toBe(false);
    expect(await db.select().from(issueDeliveryReceipts)).toHaveLength(0);
    expect(await db.select().from(issueDeliveryReceiptLinks)).toHaveLength(0);
  });

  it.each([
    ["head repository", { owner: "other-owner", repo: REPO, ref: DELIVERY_BRANCH }],
    ["delivery branch", { owner: OWNER, repo: REPO, ref: FOREIGN_BRANCH }],
  ])("refuses a recovery with a mismatched %s without persistence", async (_label, mismatch) => {
    const { companyId, issueId } = await seedIssue();
    currentActor = boardActor(companyId);
    mockGhFetch.mockResolvedValueOnce(createMockResponse({
      state: "open",
      merged: false,
      draft: false,
      head: {
        sha: HEAD_SHA,
        ref: mismatch.ref ?? DELIVERY_BRANCH,
        repo: { name: mismatch.repo, owner: { login: mismatch.owner } },
      },
    }));

    const res = await request(app)
      .post(`/api/issues/${issueId}/delivery-receipt-recovery`)
      .send({
        owner: OWNER,
        repo: REPO,
        pullRequestNumber: 579,
        headSha: HEAD_SHA,
        reason: "restore approved publication",
        idempotencyKey: `recover-mismatch-${_label}`,
      });

    expect(res.status).toBe(500);
    expect(mockGhFetch).toHaveBeenCalledTimes(1);
    expect(await db.select().from(issueDeliveryReceipts)).toHaveLength(0);
    expect(await db.select().from(issueDeliveryReceiptLinks)).toHaveLength(0);
  });

  it("refuses a moved exact-head request with zero status writes and no receipt persistence", async () => {
    const { companyId, issueId } = await seedIssue();
    currentActor = boardActor(companyId);
    mockGhFetch.mockResolvedValueOnce(createMockResponse({
      state: "open",
      merged: false,
      draft: false,
      head: {
        sha: OTHER_HEAD_SHA,
        ref: DELIVERY_BRANCH,
        repo: { name: REPO, owner: { login: OWNER } },
      },
    }));

    const res = await request(app)
      .post(`/api/issues/${issueId}/delivery-receipt-recovery`)
      .send({
        owner: OWNER,
        repo: REPO,
        pullRequestNumber: 579,
        headSha: HEAD_SHA,
        reason: "restore approved publication",
        idempotencyKey: "recover-moved-head",
      });

    expect(res.status).toBe(500);
    expect(mockGhFetch).toHaveBeenCalledTimes(1);
    expect(mockGhFetch.mock.calls.some(([url]) => typeof url === "string" && url.includes("/statuses/"))).toBe(false);
    expect(await db.select().from(issueDeliveryReceipts)).toHaveLength(0);
    expect(await db.select().from(issueDeliveryReceiptLinks)).toHaveLength(0);
  });

  it("rejects an external-object persistence failure before creating a receipt or link", async () => {
    const { companyId, issueId } = await seedIssue();
    currentActor = boardActor(companyId);
    await rejectRecoveredExternalObjectUpserts();
    mockGhFetch.mockResolvedValueOnce(createMockResponse({
      state: "open",
      merged: false,
      draft: false,
      head: {
        sha: HEAD_SHA,
        ref: DELIVERY_BRANCH,
        repo: { name: REPO, owner: { login: OWNER } },
      },
    }));

    try {
      const res = await request(app)
        .post(`/api/issues/${issueId}/delivery-receipt-recovery`)
        .send({
          owner: OWNER,
          repo: REPO,
          pullRequestNumber: 579,
          headSha: HEAD_SHA,
          reason: "restore approved publication",
          idempotencyKey: "recover-external-object-rollback",
        });

      expect(res.status).toBe(500);
      expect(mockGhFetch.mock.calls.some(([url]) => typeof url === "string" && url.includes("/statuses/"))).toBe(false);
      expect(await db.select().from(issueDeliveryReceipts)).toHaveLength(0);
      expect(await db.select().from(issueDeliveryReceiptLinks)).toHaveLength(0);
      expect(await db.select().from(externalObjects)).toHaveLength(0);
      expect(await db.select().from(activityLog)).toHaveLength(0);
    } finally {
      await allowRecoveredExternalObjectUpserts();
    }
  });

  it("rolls back the recovered receipt and link when its audit insert fails", async () => {
    const { companyId, issueId } = await seedIssue();
    currentActor = boardActor(companyId);
    await rejectActivityLogInserts();
    mockGhFetch.mockResolvedValueOnce(createMockResponse({
      state: "open",
      merged: false,
      draft: false,
      head: {
        sha: HEAD_SHA,
        ref: DELIVERY_BRANCH,
        repo: { name: REPO, owner: { login: OWNER } },
      },
    }));

    try {
      const res = await request(app)
        .post(`/api/issues/${issueId}/delivery-receipt-recovery`)
        .send({
          owner: OWNER,
          repo: REPO,
          pullRequestNumber: 579,
          headSha: HEAD_SHA,
          reason: "restore approved publication",
          idempotencyKey: "recover-audit-rollback",
        });

      expect(res.status).toBe(500);
      expect(mockGhFetch.mock.calls.some(([url]) => typeof url === "string" && url.includes("/statuses/"))).toBe(false);
      expect(await db.select().from(issueDeliveryReceipts)).toHaveLength(0);
      expect(await db.select().from(issueDeliveryReceiptLinks)).toHaveLength(0);
      expect(await db.select().from(externalObjects)).toHaveLength(0);
      expect(await db.select().from(activityLog)).toHaveLength(0);
    } finally {
      await allowActivityLogInserts();
    }
  });

  it("rejects a duplicate idempotency key with conflicting coordinates and performs no write", async () => {
    const { companyId, issueId } = await seedIssue();
    currentActor = boardActor(companyId);
    mockGhFetch.mockResolvedValueOnce(createMockResponse({
      state: "open",
      merged: false,
      draft: false,
      head: {
        sha: HEAD_SHA,
        ref: DELIVERY_BRANCH,
        repo: { name: REPO, owner: { login: OWNER } },
      },
    }));
    const idempotencyKey = "recover-conflict";
    const first = await request(app).post(`/api/issues/${issueId}/delivery-receipt-recovery`).send({
      owner: OWNER,
      repo: REPO,
      pullRequestNumber: 579,
      headSha: HEAD_SHA,
      reason: "restore approved publication",
      idempotencyKey,
    });
    expect(first.status).toBe(201);

    const second = await request(app).post(`/api/issues/${issueId}/delivery-receipt-recovery`).send({
      owner: OWNER,
      repo: REPO,
      pullRequestNumber: 580,
      headSha: HEAD_SHA,
      reason: "different recovery",
      idempotencyKey,
    });
    expect(second.status).toBe(500);
    expect(mockGhFetch).toHaveBeenCalledTimes(1);
    expect(await db.select().from(issueDeliveryReceipts)).toHaveLength(1);
    expect(await db.select().from(issueDeliveryReceiptLinks)).toHaveLength(1);
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
    // (policy.returnAssigneeAgentId ?? state.returnAssignee ?? state.deliveryAuthor ??
    //  createdByAgentId ?? unresolved). The card's declared return assignee
    // cast the completed stage's decision, so stage-integrity (Guard B) refuses it.
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

  it("refuses with 409 guard-b:return-assignee-unresolved when no return assignee, delivery author, or creator agent is recorded", async () => {
    // SUP-14826: when policy.returnAssigneeAgentId is absent, executionState
    // has no returnAssignee and no deliveryAuthor, and the issue has no
    // createdByAgentId, Guard B cannot resolve the gated principal and
    // refuses under the distinct "unresolved" reason.
    const { companyId, issueId } = await seedIssue({
      lastDecisionOutcome: "approved",
      noReturnAssignee: true,
    });
    currentActor = boardActor(companyId);

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("guard-b:return-assignee-unresolved");
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("refuses with 409 non_terminal_ladder on a mid-ladder card, with zero GitHub I/O (SUP-15459)", async () => {
    // SUP-15163 shape on the recovery surface: a 4-stage ladder whose FIRST stage
    // was legitimately approved. Guard A passes (a real "approved" decision) and
    // Guard B passes (that one completed stage has a decision row cast by a
    // non-return-assignee) — so before the terminality gate this route would
    // re-stamp paperclip/approved and authorize a merge with three stages never
    // executed. It must refuse before resolving the decision head.
    const { companyId, issueId } = await seedIssue({
      lastDecisionOutcome: "approved",
      pendingStageIds: [
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
      ],
      pr: { owner: OWNER, repo: REPO, number: PR_NUMBER, headRefName: DELIVERY_BRANCH },
    });
    currentActor = boardActor(companyId);

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("non_terminal_ladder");
    expect(res.body.message).toContain("status:skipped:non-terminal-ladder");
    expect(res.body.message).toContain("22222222-2222-4222-8222-222222222222");
    expect(res.body.message).toContain("33333333-3333-4333-8333-333333333333");
    expect(res.body.message).toContain("44444444-4444-4444-8444-444444444444");
    expect(mockGhFetch).not.toHaveBeenCalled();

    // Nothing was recorded as published, so a later sweep cannot read this card
    // as stamped either.
    const [row] = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId));
    const approvalStatus = (row?.executionState ?? {})?.approvalStatus as
      | Record<string, unknown>
      | undefined;
    expect(approvalStatus?.publishedHeadSha).toBeUndefined();
  });

  it("re-publishes on the SAME multi-stage card once every stage is completed (SUP-15459 positive control)", async () => {
    // The over-tight failure mode (SUP-11580 class) is a terminally-approved card
    // that never re-stamps. Same 4-stage policy as the refusal above, with all
    // four ids in completedStageIds: the route must stamp exactly once.
    const pendingStageIds = [
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ];
    const { companyId, issueId } = await seedIssue({
      lastDecisionOutcome: "approved",
      pendingStageIds,
      completedStageIds: [STAGE_ID, ...pendingStageIds],
      pr: { owner: OWNER, repo: REPO, number: PR_NUMBER, headRefName: DELIVERY_BRANCH },
      deliveryReceipt: true,
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
    const statusWrites = mockGhFetch.mock.calls.filter(
      (call) => typeof call[0] === "string" && (call[0] as string).includes("/statuses/"),
    );
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0]![0]).toBe(`https://api.github.com/repos/${OWNER}/${REPO}/statuses/${HEAD_SHA}`);
    expect(statusWrites[0]![1]?.method).toBe("POST");
    expect(JSON.parse(statusWrites[0]![1]!.body as string)).toMatchObject({
      context: "paperclip/approved",
      state: "success",
    });
    const [receipt] = await db.select().from(issueDeliveryReceipts);
    expect(receipt?.headSha).toBe(HEAD_SHA);
    expect(receipt?.state).toBe("consumed");
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

  it.each([
    ["absent", false, 409],
    ["absent", true, 200],
    ["mismatched", false, 409],
    ["mismatched", true, 200],
  ] as const)("requires a board receipt for an %s decision binding (receipt=%s)", async (binding, deliveryReceipt, status) => {
    const { companyId, issueId } = await seedIssue({
      pr: { owner: OWNER, repo: REPO, number: PR_NUMBER, headRefName: DELIVERY_BRANCH },
      deliveryReceipt,
    });
    currentActor = boardActor(companyId);
    if (binding === "mismatched") {
      const [row] = await db.select({ executionState: issues.executionState }).from(issues).where(eq(issues.id, issueId));
      await db.update(issues).set({
        executionState: {
          ...row!.executionState,
          lastDecisionId: "decision-new",
          approvalStatus: {
            finalDelivery: {
              owner: OWNER, repo: REPO, number: PR_NUMBER, headSha: HEAD_SHA,
              decisionId: "decision-old",
            },
          },
        },
      }).where(eq(issues.id, issueId));
    }
    mockGhFetch
      .mockResolvedValueOnce(createMockResponse({ head: { sha: HEAD_SHA } }))
      .mockResolvedValueOnce(createMockResponse({ head: { sha: HEAD_SHA } }));
    if (deliveryReceipt) mockGhFetch.mockResolvedValueOnce(createMockResponse({ id: 12345 }));

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);
    expect(res.status).toBe(status);
    if (!deliveryReceipt) {
      expect(res.body.message).toContain("delivery-receipt-missing");
    } else {
      expect(res.body.outcome).toBe("armed");
    }
    expect(mockGhFetch.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(deliveryReceipt ? 1 : 0);
  });

  it("publishes a deliver-branch approval with no receipt row and persists the certified head", async () => {
    const { companyId, issueId } = await seedIssue({
      pr: { owner: OWNER, repo: REPO, number: PR_NUMBER, headRefName: DELIVERY_BRANCH },
      certifiedDelivery: true,
    });
    currentActor = boardActor(companyId);

    mockGhFetch
      .mockResolvedValueOnce(createMockResponse({ head: { sha: HEAD_SHA } }))
      .mockResolvedValueOnce(createMockResponse({ id: 12345 }));

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("armed");
    expect(res.body.headSha).toBe(HEAD_SHA);
    expect(res.body.message).toContain("paperclip/approved");
    // Certified preflight pins PR/head, so publication needs one head read
    // and one status write, but no receipt.
    expect(mockGhFetch).toHaveBeenCalledTimes(2);
    const statusCall = mockGhFetch.mock.calls[1]!;
    expect(statusCall[0]).toBe(`https://api.github.com/repos/${OWNER}/${REPO}/statuses/${HEAD_SHA}`);
    expect(statusCall[1]).toMatchObject({ method: "POST" });
    const body = JSON.parse(statusCall[1]!.body as string);
    expect(body.context).toBe("paperclip/approved");
    expect(body.state).toBe("success");
    expect(await db.select().from(issueDeliveryReceipts)).toHaveLength(0);

    // The certified head is persisted so Guard A / the enforcer can verify it.
    const [row] = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId));
    const approvalStatus = (row?.executionState ?? {})?.approvalStatus as Record<string, unknown> | undefined;
    expect(approvalStatus?.publishedHeadSha).toBe(HEAD_SHA);
  });

  it.each([false, true])("refuses a retargeted failed first publish without status writes (receipt=%s)", async (deliveryReceipt) => {
    const { companyId, issueId } = await seedIssue({
      pr: { owner: OWNER, repo: REPO, number: 99, headRefName: DELIVERY_BRANCH },
      deliveryReceipt,
    });
    currentActor = boardActor(companyId);
    const [row] = await db.select({ executionState: issues.executionState }).from(issues).where(eq(issues.id, issueId));
    await db.update(issues).set({
      executionState: {
        ...row!.executionState,
        lastDecisionId: "decision-42",
        approvalStatus: {
          approvedHeadSha: OTHER_HEAD_SHA,
          publishFailure: { reason: "status:failed:scope_missing", headSha: OTHER_HEAD_SHA },
          finalDelivery: {
            owner: OWNER, repo: REPO, number: 42, headSha: OTHER_HEAD_SHA,
            displayName: `${OWNER}/${REPO}#42`, decisionId: "decision-42",
          },
        },
      },
    }).where(eq(issues.id, issueId));

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(409);
    expect(res.body.message).toContain("delivery_moved");
    expect(mockGhFetch.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
    const [after] = await db.select({ executionState: issues.executionState }).from(issues).where(eq(issues.id, issueId));
    expect((after?.executionState?.approvalStatus as Record<string, unknown>).publishedHeadSha).toBeUndefined();
  });

  it("recovers a failed first publish on its certified PR/head without a receipt row", async () => {
    const { companyId, issueId } = await seedIssue({
      pr: { owner: OWNER, repo: REPO, number: PR_NUMBER, headRefName: DELIVERY_BRANCH },
    });
    currentActor = boardActor(companyId);
    const [row] = await db.select({ executionState: issues.executionState }).from(issues).where(eq(issues.id, issueId));
    await db.update(issues).set({
      executionState: {
        ...row!.executionState,
        lastDecisionId: "decision-42",
        approvalStatus: {
          approvedHeadSha: HEAD_SHA,
          publishFailure: { reason: "status:failed:scope_missing", headSha: HEAD_SHA },
          finalDelivery: {
            owner: OWNER, repo: REPO, number: PR_NUMBER, headSha: HEAD_SHA,
            displayName: `${OWNER}/${REPO}#${PR_NUMBER}`, decisionId: "decision-42",
          },
        },
      },
    }).where(eq(issues.id, issueId));
    mockGhFetch
      .mockResolvedValueOnce(createMockResponse({ head: { sha: HEAD_SHA } }))
      .mockResolvedValueOnce(createMockResponse({ id: 12345 }));

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("armed");
    expect(mockGhFetch.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    expect(await db.select().from(issueDeliveryReceipts)).toHaveLength(0);
  });

  it("refuses publication when a receipt exists for the PR but its head differs", async () => {
    const { companyId, issueId } = await seedIssue({
      pr: { owner: OWNER, repo: REPO, number: PR_NUMBER, headRefName: DELIVERY_BRANCH },
      deliveryReceipt: true,
    });
    currentActor = boardActor(companyId);
    mockGhFetch
      .mockResolvedValueOnce(createMockResponse({ head: { sha: OTHER_HEAD_SHA } }))
      .mockResolvedValueOnce(createMockResponse({ head: { sha: OTHER_HEAD_SHA } }));

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(409);
    expect(res.body.message).toContain("delivery-receipt-head_mismatch");
    expect(mockGhFetch).toHaveBeenCalledTimes(2);
    const [receipt] = await db.select().from(issueDeliveryReceipts);
    expect(receipt?.state).toBe("invalidated");
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
      .where(eq(issues.id, issueId));
    const approvalStatus = (row?.executionState ?? {})?.approvalStatus as Record<string, unknown> | undefined;
    expect(approvalStatus?.publishedHeadSha).toBeUndefined();
  });

  it("is idempotent: a second invocation after arming answers already_published", async () => {
    const { companyId, issueId } = await seedIssue({
      pr: { owner: OWNER, repo: REPO, number: PR_NUMBER, headRefName: DELIVERY_BRANCH },
      deliveryReceipt: true,
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

  // SUP-14783: the shape every TSP card has — an execution-workspace row shared
  // with (and owned by) a parent issue, whose single branch_name is the
  // parent's. Before this, the route refused 409 on every such card and the
  // ADR-091 first-publish dead-end had no recovery at all in that project.
  it("arms a shared_workspace card whose PR carries its own identifier prefix", async () => {
    const { companyId, issueId } = await seedIssue({
      sharedWorkspaceOwnedByParent: true,
      deliveryBranch: "SUP-14668-parent-architecture-review",
      pr: { owner: OWNER, repo: REPO, number: PR_NUMBER, headRefName: "SUP-14748-1-real-delivery" },
      deliveryReceipt: true,
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
  });

  it("still refuses 409 on a shared_workspace card when the PR carries ANOTHER card's prefix", async () => {
    const { companyId, issueId } = await seedIssue({
      sharedWorkspaceOwnedByParent: true,
      deliveryBranch: "SUP-14668-parent-architecture-review",
      pr: { owner: OWNER, repo: REPO, number: PR_NUMBER, headRefName: FOREIGN_BRANCH },
    });
    currentActor = boardActor(companyId);

    const res = await request(app).post(`/api/issues/${issueId}/merge-arming/republish`);

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("head_unresolvable");
    expect(res.body.message).toContain("does not carry this card's identifier prefix");
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

});

describeEmbeddedPostgres("PATCH /issues/:id delivery identity (ADR-091 D1 SUP-14824)", () => {
  let db: Db;
  let app: express.Express;
  let currentActor: Express.Request["actor"];
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousSchedulingSuppression: string | undefined;

  beforeAll(async () => {
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delivery-identity-write-");
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
    await db.delete(issueDeliveryReceiptLinks);
    await db.delete(issueDeliveryReceipts);
    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(issueExecutionDecisions);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
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

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId,
    } as unknown as Express.Request["actor"];
  }

  interface SeedOpts {
    executionRunId?: string | null;
    status?: string;
    strategyType?: "project_primary" | "git_worktree";
    deliveryBranch?: string | null;
    /**
     * SUP-15909: make the execution-workspace row a real `shared_workspace` row
     * OWNED BY ANOTHER issue, carrying the given carrier branch — the ADR-083
     * carrier-child shape. Default undefined leaves the row isolated.
     */
    sharedWorkspaceOwnerBranch?: string;
    /**
     * ADR-091 D1 (SUP-15909): when true together with sharedWorkspaceOwnerBranch,
     * the owner issue is NOT wired as the card's parent, so it is an UNRELATED
     * (non-ancestor) owner — the laundering shape D1 must refuse.
     */
    unrelatedOwner?: boolean;
  }

  async function seedIssue(opts: SeedOpts = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Delivery Identity Co",
      issuePrefix: "SUP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: USER_ID,
      status: "active",
      membershipRole: "owner",
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
      id: agentId,
      companyId,
      name: "Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    if (opts.executionRunId) {
      await db.insert(heartbeatRuns).values({
        id: opts.executionRunId,
        companyId,
        agentId,
        status: "running",
      });
    }
    // SUP-15909: a carrier child's workspace row is the OWNER's shared row, so
    // the owner card must exist before the FK-bearing row can point at it.
    let carrierOwnerIssueId: string | null = null;
    if (opts.sharedWorkspaceOwnerBranch) {
      carrierOwnerIssueId = randomUUID();
      await db.insert(issues).values({
        id: carrierOwnerIssueId,
        companyId,
        identifier: "SUP-14823-1",
        issueNumber: 2,
        title: "Carrier owner card",
        status: "in_progress",
        priority: "medium",
        assigneeUserId: USER_ID,
        createdByUserId: USER_ID,
        projectId,
        projectWorkspaceId,
      });
    }
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      ...(carrierOwnerIssueId
        ? { mode: "shared_workspace", sourceIssueId: carrierOwnerIssueId }
        : { mode: "isolated" }),
      strategyType: opts.strategyType ?? "git_worktree",
      name: "card-ws",
      status: "active",
      branchName: opts.strategyType === "project_primary"
        ? opts.deliveryBranch ?? null
        : opts.sharedWorkspaceOwnerBranch ?? "SUP-14824-branch",
      repoUrl: REPO_URL,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "SUP-14824-1",
      issueNumber: 1,
      title: "Delivery identity test card",
      status: opts.status ?? "in_progress",
      priority: "medium",
      assigneeUserId: USER_ID,
      createdByUserId: USER_ID,
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      executionRunId: opts.executionRunId ?? null,
      // ADR-091 D1 (SUP-15909): wire the carrier owner as a genuine strict ancestor
      // (the card's parent) so the shared-workspace carrier row passes the ADR-083
      // gate — UNLESS the test explicitly asks for an unrelated (non-ancestor) owner.
      ...(carrierOwnerIssueId && !opts.unrelatedOwner ? { parentId: carrierOwnerIssueId } : {}),
    });

    return { companyId, issueId, agentId };
  }

  it("persists deliveryIdentity on in_review transition from lease holder (AC4)", async () => {
    const runId = randomUUID();
    const { companyId, issueId, agentId } = await seedIssue({ executionRunId: runId });
    currentActor = agentActor(companyId, agentId, runId);

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "in_review",
        deliveryIdentity: {
          repo: { owner: OWNER, repo: REPO },
          branch: "SUP-14824-branch",
          headSha: HEAD_SHA,
        },
      });

    expect(res.status).toBe(200);
    const [row] = await db
      .select({ executionState: issues.executionState, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(row!.status).toBe("in_review");
    const delivery = (row!.executionState ?? {})?.delivery as Record<string, unknown> | undefined;
    expect(delivery).toBeDefined();
    expect(delivery!.repo).toEqual({ owner: OWNER, repo: REPO });
    expect(delivery!.branch).toBe("SUP-14824-branch");
    expect(delivery!.headSha).toBe(HEAD_SHA);
    expect(delivery!.recordedByRunId).toBe(runId);
    expect(typeof delivery!.recordedAt).toBe("string");
  });

  it("records deliveryIdentity for a project_primary workspace with no persisted branch (SUP-18325)", async () => {
    const runId = randomUUID();
    const { companyId, issueId, agentId } = await seedIssue({
      executionRunId: runId,
      strategyType: "project_primary",
      deliveryBranch: null,
    });
    currentActor = agentActor(companyId, agentId, runId);

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "in_review",
        deliveryIdentity: {
          repo: { owner: OWNER, repo: REPO },
          branch: "SUP-14824-project-primary",
          headSha: HEAD_SHA,
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [workspace] = await db
      .select({ branchName: executionWorkspaces.branchName })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, (await db.select({ executionWorkspaceId: issues.executionWorkspaceId }).from(issues).where(eq(issues.id, issueId)))[0]!.executionWorkspaceId!));
    expect(workspace!.branchName).toBe("SUP-14824-project-primary");
  });

  it("records a carrier child delivery identity on its owner's carrier branch (SUP-15909)", async () => {
    const runId = randomUUID();
    const { companyId, issueId, agentId } = await seedIssue({
      executionRunId: runId,
      sharedWorkspaceOwnerBranch: "SUP-14823-carrier-branch",
    });
    currentActor = agentActor(companyId, agentId, runId);

    // ADR-083 carrier child: the card's execution-workspace row is the owner's
    // shared row, so its control-plane delivery branch IS the owner's carrier
    // branch. Recording it must still succeed — no carrier-mode regression.
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "in_review",
        deliveryIdentity: {
          repo: { owner: OWNER, repo: REPO },
          branch: "SUP-14823-carrier-branch",
          headSha: HEAD_SHA,
        },
      });

    expect(res.status).toBe(200);
    const [row] = await db
      .select({ executionState: issues.executionState, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(row!.status).toBe("in_review");
    const delivery = (row!.executionState ?? {})?.delivery as Record<string, unknown> | undefined;
    expect(delivery).toBeDefined();
    expect(delivery!.branch).toBe("SUP-14823-carrier-branch");
  });

  it("rejects deliveryIdentity when the recorded branch is not the card's execution-workspace branch (SUP-15909)", async () => {
    const runId = randomUUID();
    const { companyId, issueId, agentId } = await seedIssue({ executionRunId: runId });
    currentActor = agentActor(companyId, agentId, runId);

    // The card's execution-workspace row names "SUP-14824-branch". Recording a
    // foreign same-repo branch must be rejected BEFORE any write lands — the
    // card-boundary half D1 exists to close.
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "in_review",
        deliveryIdentity: {
          repo: { owner: OWNER, repo: REPO },
          branch: "SUP-999-foreign-branch",
          headSha: HEAD_SHA,
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("delivery_identity_branch_write_rejected");
    expect(res.body.details.recordedBranch).toBe("SUP-999-foreign-branch");
    expect(res.body.details.controlPlaneBranch).toBe("SUP-14824-branch");
    // No partial write: status stays in_progress and no delivery recorded.
    const [row] = await db
      .select({ executionState: issues.executionState, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(row!.status).toBe("in_progress");
    expect((row!.executionState ?? {})?.delivery).toBeUndefined();
  });

  it("rejects deliveryIdentity when the recorded branch is owned by an unrelated (non-ancestor) issue (SUP-15909)", async () => {
    const runId = randomUUID();
    const { companyId, issueId, agentId } = await seedIssue({
      executionRunId: runId,
      sharedWorkspaceOwnerBranch: "SUP-14823-carrier-branch",
      unrelatedOwner: true,
    });
    currentActor = agentActor(companyId, agentId, runId);

    // The card's execution-workspace row is a shared row sourced to an UNRELATED
    // issue (not its ancestor). Even though the recorded branch EXACTLY equals the
    // row's branch_name, the gate must refuse: the card cannot be proven to have
    // delivered on a branch it neither owns nor lawfully inherits. This is the
    // write-time half of the ancestor check (CR: recorded-delivery-branch-ancestor-
    // unvalidated).
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "in_review",
        deliveryIdentity: {
          repo: { owner: OWNER, repo: REPO },
          branch: "SUP-14823-carrier-branch",
          headSha: HEAD_SHA,
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("delivery_identity_branch_write_rejected");
    expect(res.body.details.recordedBranch).toBe("SUP-14823-carrier-branch");
    expect(res.body.details.controlPlaneBranch).toBe("SUP-14823-carrier-branch");
    expect(res.body.details.ownerIssueId).toBeTruthy();
    expect(res.body.details.reason).toMatch(/not its ADR-083 carrier owner/);
    // No partial write: status stays in_progress and no delivery recorded.
    const [row] = await db
      .select({ executionState: issues.executionState, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(row!.status).toBe("in_progress");
    expect((row!.executionState ?? {})?.delivery).toBeUndefined();
  });

  it("rejects deliveryIdentity when actor does not hold the lease (AC4)", async () => {
    const runId = randomUUID();
    const { companyId, issueId, agentId } = await seedIssue({ executionRunId: runId });
    // Use a DIFFERENT run ID — this actor does not hold the lease.
    const otherRunId = randomUUID();
    // Create a heartbeat run for the other runId so the route can resolve it.
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId,
      status: "running",
    });
    currentActor = agentActor(companyId, agentId, otherRunId);

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "in_review",
        deliveryIdentity: {
          repo: { owner: OWNER, repo: REPO },
          branch: "SUP-14824-delivery",
          headSha: HEAD_SHA,
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("delivery_identity_write_rejected");
    expect(res.body.details.holdsLease).toBe(false);
    // No partial write: status stays in_progress and no delivery recorded.
    const [row] = await db
      .select({ executionState: issues.executionState, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(row!.status).toBe("in_progress");
    expect((row!.executionState ?? {})?.delivery).toBeUndefined();
  });

  it("rejects deliveryIdentity on a non-in_review transition (AC4)", async () => {
    const runId = randomUUID();
    const { companyId, issueId, agentId } = await seedIssue({
      executionRunId: runId,
      status: "in_progress",
    });
    currentActor = agentActor(companyId, agentId, runId);

    // Transition to done, NOT in_review — deliveryIdentity must be rejected.
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        deliveryIdentity: {
          repo: { owner: OWNER, repo: REPO },
          branch: "SUP-14824-delivery",
          headSha: HEAD_SHA,
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("delivery_identity_write_rejected");
    expect(res.body.details.enteringReview).toBe(false);
  });

  it("rejects deliveryIdentity when the recorded repo is not the card's project repo (F1)", async () => {
    const runId = randomUUID();
    const { companyId, issueId, agentId } = await seedIssue({ executionRunId: runId });
    currentActor = agentActor(companyId, agentId, runId);

    // The card's project repo is TEA-Core/paperclip (REPO_URL). Naming a sibling
    // repo in deliveryIdentity must be rejected BEFORE any write lands.
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "in_review",
        deliveryIdentity: {
          repo: { owner: "OTHER", repo: "other-repo" },
          branch: "SUP-14824-delivery",
          headSha: HEAD_SHA,
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("delivery_identity_write_rejected");
    expect(res.body.details.holdsLease).toBe(true);
    expect(res.body.details.enteringReview).toBe(true);
    expect(res.body.details.recordedRepo).toBe("OTHER/other-repo");
    expect(res.body.details.projectRepo).toBe("TEA-Core/paperclip");
    // No partial write: status stays in_progress and no delivery recorded.
    const [row] = await db
      .select({ executionState: issues.executionState, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(row!.status).toBe("in_progress");
    expect((row!.executionState ?? {})?.delivery).toBeUndefined();
  });
});
