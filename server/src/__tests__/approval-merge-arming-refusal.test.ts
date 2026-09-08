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

// SUP-14722 (ADR-091 D-D): the merge-arming post-hook in the issues route
// (`runApprovalMergeArming`) must NOT reach `armMergeOnApproval` when the
// approval publish was refused (a non-`armed` statusOutcome). These tests drive
// the REAL route hook through the PATCH decision door and assert on the
// `armMergeOnApproval` spy plus the `[Merge-arming]` comments the hook posts.
//
// The service layer is mocked at the module boundary so each test pins a
// specific resolver/publisher outcome and the assertion is purely about the
// hook's control flow (the defect under test). `shouldPublishApprovalStatus`
// is left real so the hook's approved-decision gate behaves as in production.
//
// A dedicated file (rather than a module-level vi.mock inside
// `__tests__/merge-arming.test.ts`) keeps the file-wide mock from retargeting
// the top-level imports the ~50 existing service tests in that file rely on.
const mockArmMergeOnApproval = vi.hoisted(() => vi.fn());
const mockResolveApprovalDecisionHead = vi.hoisted(() => vi.fn());
const mockPublishApprovalStatus = vi.hoisted(() => vi.fn());

vi.mock("../services/merge-arming.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/merge-arming.js")>();
  return {
    ...orig,
    armMergeOnApproval: mockArmMergeOnApproval,
    resolveApprovalDecisionHead: mockResolveApprovalDecisionHead,
    publishApprovalStatus: mockPublishApprovalStatus,
  };
});

// ADR-092 D4 fail-closed (SUP-14792 round-2, adr-092-d4-enforcement-fails-open):
// the D4 enforcement site must refuse to stamp/arm when `evaluateStageIntegrity`
// THROWS (Path A). That function is otherwise the real predicate, so we mock it
// at the module boundary with a default that DELEGATES to the real
// implementation — keeping the stage-integrity refusal test below exercising the
// production predicate — while letting a specific test force it to reject.
// Path B (a real finding whose [Merge-arming] comment write throws) is covered
// by the same `return`: in the hook the refusal `return` sits OUTSIDE the inner
// addComment try/catch, so a comment-write failure reaches the identical refusal.
const realEvaluateStageIntegrity = vi.hoisted(() => ({
  fn: null as
    | null
    | ((db: unknown, row: unknown) => Promise<{ reason: string; detail: string } | null>),
}));
const mockEvaluateStageIntegrity = vi.hoisted(() => vi.fn());

vi.mock("../services/approval-status-reconciler.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/approval-status-reconciler.js")>();
  realEvaluateStageIntegrity.fn = orig.evaluateStageIntegrity;
  return {
    ...orig,
    evaluateStageIntegrity: mockEvaluateStageIntegrity,
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping approval-arming refusal route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("approval-arming refusal suppresses merge arming (SUP-14722 D-D)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let currentActor!: Express.Request["actor"];

  beforeAll(async () => {
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-arming-refusal-");
    db = createDb(tempDb.connectionString);
    app = createApp();
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
  });

  beforeEach(() => {
    mockArmMergeOnApproval.mockReset();
    mockResolveApprovalDecisionHead.mockReset();
    mockPublishApprovalStatus.mockReset();
    // Default: delegate to the real stage-integrity predicate so the existing
    // stage-integrity refusal test exercises production behavior.
    mockEvaluateStageIntegrity.mockReset();
    mockEvaluateStageIntegrity.mockImplementation(
      async (db: unknown, row: unknown) => realEvaluateStageIntegrity.fn!(db, row),
    );
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
   * Seeds an issue on a two-stage review ladder with the company's
   * `mergeArmingEnabled` flag TRUE (the only flag seeded in the fixture, per the
   * card's out-of-scope rule: never enable the flag on a real company).
   *
   * `preCompleted` controls how far up the ladder the card sits:
   *   - 0 (default): parked on the PENDING first stage. Approving it resolves to
   *     `in_review` (a NON-closing transition) and leaves the ladder MID-LADDER
   *     (completedStageIds=[stage1], stage2 pending) — the SUP-15459 shape that
   *     must refuse to stamp/arm.
   *   - 1: stage 1 is pre-completed (a decision row is seeded for it) and the
   *     card is parked on the PENDING final stage. Approving it resolves to
   *     `done` (a CLOSING transition) and completes the ladder — the terminal
   *     shape that stamps exactly once and arms.
   */
  async function seedIssueAwaitingReview(
    issuePrefix: string,
    { preCompleted = 0 }: { preCompleted?: number } = {},
  ) {
    const companyId = randomUUID();
    const reviewerAgentId = randomUUID();
    const implementerAgentId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const firstStageId = randomUUID();
    const secondStageId = randomUUID();
    const identifier = `${issuePrefix}-1`;
    const branchName = `${identifier}-test-branch`;
    const repoUrl = "https://github.com/TEA-Core/paperclip";
    const defaultRef = "fold/tea-patches-v2026.722.0";
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
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
      issueNumber: 1,
      title: "Approval-arming refusal must suppress merge arming",
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
        currentStageId: preCompleted >= 1 ? secondStageId : firstStageId,
        currentStageIndex: preCompleted >= 1 ? 1 : 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: implementerAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: preCompleted >= 1 ? [firstStageId] : [],
        lastDecisionId: null,
        lastDecisionOutcome: preCompleted >= 1 ? "approved" : null,
        monitor: null,
        changesRequestedCount: 0,
      },
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId: issueId })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));

    // A pre-completed stage must be backed by a decision row or guard-b
    // (stage-without-decision) refuses the card before the merge-arming hook.
    if (preCompleted >= 1) {
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
    }

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

  /** All `[Merge-arming]` comments the hook posted for the issue. */
  async function mergeArmingComments(issueId: string) {
    const rows = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    return rows.filter((r) => typeof r.body === "string" && r.body.startsWith("[Merge-arming]"));
  }

  /** Approves the card's current pending stage through the PATCH decision door. */
  async function approveCurrentStage(identifier: string) {
    // The Tier-1 done declaration (SUP-12693) is only enforced on closing
    // (-> done) transitions; a mid-ladder approval (-> in_review) ignores it, so
    // it is safe to always include it here.
    return request(app)
      .patch(`/api/issues/${identifier}`)
      .send({
        status: "done",
        comment:
          "Stage approved.\nClosed at Tier 1 (landed, not liveness-probed): review stage approved. Liveness unverified.\n\nkind: review\ndecision: approved",
      });
  }

  it("head_unresolvable refusal: armMergeOnApproval is never reached; the refusal comment is still posted", async () => {
    // Terminal ladder (final stage pending, prior stage pre-completed) so the
    // SUP-15459 terminality gate passes and the hook reaches head resolution.
    const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueAwaitingReview("DREF1", {
      preCompleted: 1,
    });
    currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));

    // The decision-time head cannot be resolved -> the hook builds the
    // head_unresolvable statusOutcome and must stop there.
    mockResolveApprovalDecisionHead.mockResolvedValue({
      kind: "unresolvable",
      reason: "no-pr: no open linked PR resolvable at decision time",
    });
    mockArmMergeOnApproval.mockResolvedValue({ kind: "skipped", message: "skipped: must-not-run" });

    const res = await approveCurrentStage(identifier);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("done");

    expect(mockArmMergeOnApproval).toHaveBeenCalledTimes(0);
    const comments = await mergeArmingComments(issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("status:skipped:head_unresolvable:");
  });

  it("publishApprovalStatus skipped:not_delivered: armMergeOnApproval is never reached; exactly one [Merge-arming] comment", async () => {
    // Terminal ladder so the SUP-15459 terminality gate passes and the hook
    // reaches the delegated publish.
    const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueAwaitingReview("DREF2", {
      preCompleted: 1,
    });
    currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));

    // The head IS resolved, but the delegated publish refuses (the card did not
    // deliver that PR) -> a skipped outcome, still a refusal for merge arming.
    mockResolveApprovalDecisionHead.mockResolvedValue({
      kind: "resolved",
      headSha: "deadbeefcafe",
      displayName: "TEA-Core/paperclip#437",
    });
    mockPublishApprovalStatus.mockResolvedValue({
      kind: "skipped",
      message:
        "status:skipped:not_delivered: TEA-Core/paperclip#437 head is not this card's delivery branch; refusing to stamp",
    });
    mockArmMergeOnApproval.mockResolvedValue({ kind: "skipped", message: "skipped: must-not-run" });

    const res = await approveCurrentStage(identifier);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("done");

    expect(mockArmMergeOnApproval).toHaveBeenCalledTimes(0);
    const comments = await mergeArmingComments(issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("status:skipped:not_delivered:");
  });

  it("SUP-15163 terminal card: ladder completes -> publishApprovalStatus and armMergeOnApproval run exactly once, both comments posted", async () => {
    // Terminal ladder (final stage pending, prior stage pre-completed): the
    // SUP-15459 gate passes and the hook reaches the happy path exactly as
    // before — the same fixture with all stages complete arms the card.
    const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueAwaitingReview("DREF3", {
      preCompleted: 1,
    });
    currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));

    // The happy path: head resolves, the publish arms, and merge arming runs.
    mockResolveApprovalDecisionHead.mockResolvedValue({
      kind: "resolved",
      headSha: "deadbeefcafe",
      displayName: "TEA-Core/paperclip#437",
    });
    mockPublishApprovalStatus.mockResolvedValue({
      kind: "armed",
      message: "status:published: paperclip/approved status written to TEA-Core/paperclip#437 head deadbee",
      headSha: "deadbeefcafe",
    });
    mockArmMergeOnApproval.mockResolvedValue({
      kind: "armed",
      message: "armed: Auto-merge enabled for TEA-Core/paperclip#437",
    });

    const res = await approveCurrentStage(identifier);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("done");

    expect(mockPublishApprovalStatus).toHaveBeenCalledTimes(1);
    expect(mockArmMergeOnApproval).toHaveBeenCalledTimes(1);
    const comments = await mergeArmingComments(issueId);
    expect(comments).toHaveLength(2);
    expect(comments[0]!.body).toContain("status:published:");
    expect(comments[1]!.body).toContain("armed:");
  });

  it("SUP-15163 mid-ladder card: approving stage 1 of 2 refuses -> no stamp, no arm, exactly one non-terminal-ladder comment, card stays in_review", async () => {
    // The exact SUP-15163 shape that the bug allowed through: a two-stage card
    // whose first stage is approved but whose second stage is still pending.
    // The terminality gate must refuse before any GitHub write.
    const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueAwaitingReview("DREF4");
    currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));

    mockResolveApprovalDecisionHead.mockResolvedValue({
      kind: "resolved",
      headSha: "deadbeefcafe",
      displayName: "TEA-Core/paperclip#437",
    });
    mockPublishApprovalStatus.mockResolvedValue({
      kind: "skipped",
      message: "status:skipped: must-not-run",
    });
    mockArmMergeOnApproval.mockResolvedValue({ kind: "skipped", message: "skipped: must-not-run" });

    const res = await approveCurrentStage(identifier);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("in_review");

    expect(mockPublishApprovalStatus).toHaveBeenCalledTimes(0);
    expect(mockArmMergeOnApproval).toHaveBeenCalledTimes(0);
    const comments = await mergeArmingComments(issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("status:skipped:non-terminal-ladder:");
  });

  it("stage-integrity refusal at the route (ADR-092 D4): guard-b finding suppresses merge arming, status transition is untouched", async () => {
    const companyId = randomUUID();
    const reviewerAgentId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const firstStageId = randomUUID();
    const secondStageId = randomUUID();
    const identifier = "DINT1-1";
    const branchName = `${identifier}-test-branch`;
    const repoUrl = "https://github.com/TEA-Core/paperclip";
    const defaultRef = "fold/tea-patches-v2026.722.0";
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "DINT1",
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

    // ADR-092 D3: no declared return assignee in the policy, no stored
    // returnAssignee in the state. The assignee IS the participant and will
    // decide their own stage — the D3 coverage gap.
    const stages = [
      {
        id: firstStageId,
        type: "review" as const,
        approvalsNeeded: 1 as const,
        participants: [{ type: "agent" as const, agentId: reviewerAgentId, userId: null }],
      },
      {
        id: secondStageId,
        type: "approval" as const,
        approvalsNeeded: 1 as const,
        participants: [{ type: "user" as const, agentId: null, userId: "cloud-user-1" }],
      },
    ];

    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier,
      issueNumber: 1,
      title: "Stage-integrity refusal must suppress merge arming at the route",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: reviewerAgentId,
      createdByUserId: "cloud-user-1",
      executionWorkspaceId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages,
      },
      executionState: {
        status: "pending",
        currentStageId: firstStageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
        changesRequestedCount: 0,
      },
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId: issueId })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: reviewerAgentId,
      status: "running",
      contextSnapshot: { issueId },
    });
    currentActor = { type: "agent", agentId: reviewerAgentId, companyId, source: "agent_key", runId };

    mockResolveApprovalDecisionHead.mockResolvedValue({
      kind: "resolved",
      headSha: "deadbeefcafe",
      displayName: "TEA-Core/paperclip#999",
    });
    mockPublishApprovalStatus.mockResolvedValue({
      kind: "armed",
      message: "status:published: would-arm-if-reached",
      headSha: "deadbeefcafe",
    });
    mockArmMergeOnApproval.mockResolvedValue({ kind: "armed", message: "armed: must-not-run" });

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({ status: "done", comment: "Stage 1 approved.\n\nkind: review\ndecision: approved" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("in_review");

    expect(mockArmMergeOnApproval).toHaveBeenCalledTimes(0);
    expect(mockPublishApprovalStatus).toHaveBeenCalledTimes(0);
    const comments = await mergeArmingComments(issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("status:skipped:stage_integrity:");
    expect(comments[0]!.body).toContain("guard-b:decision-by-return-assignee");
  });

  it("fail-closed Path A: an evaluateStageIntegrity throw refuses to stamp/arm without touching the transition (adr-092-d4-enforcement-fails-open)", async () => {
    const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueAwaitingReview("DINT3");
    currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));

    // Seed the head/publisher/arming to ARM, so a fall-through past the guard
    // would be detectable (publish + arm called, published/armed comment posted).
    mockResolveApprovalDecisionHead.mockResolvedValue({
      kind: "resolved",
      headSha: "deadbeefcafe",
      displayName: "TEA-Core/paperclip#467",
    });
    mockPublishApprovalStatus.mockResolvedValue({
      kind: "armed",
      message: "status:published: would-stamp-if-reached",
      headSha: "deadbeefcafe",
    });
    mockArmMergeOnApproval.mockResolvedValue({ kind: "armed", message: "armed: must-not-run" });

    // Path A: the guard itself throws before it can positively verify the
    // decision (e.g. a transient DB error). Fail-closed: refuse to stamp/arm
    // instead of falling through to publish/arm.
    mockEvaluateStageIntegrity.mockImplementationOnce(
      async () => Promise.reject(new Error("simulated transient DB error in stage-integrity check")),
    );

    const res = await approveCurrentStage(identifier);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // D5: never refuse to close — approving stage 1 still resolves to in_review.
    expect(await statusOf(issueId)).toBe("in_review");

    // The guard threw, so the hook must not have reached stamp/arm.
    expect(mockPublishApprovalStatus).toHaveBeenCalledTimes(0);
    expect(mockArmMergeOnApproval).toHaveBeenCalledTimes(0);
    const comments = await mergeArmingComments(issueId);
    expect(
      comments.filter((c) => c.body.includes("status:published:") || c.body.includes("armed:")),
    ).toHaveLength(0);
  });
});
