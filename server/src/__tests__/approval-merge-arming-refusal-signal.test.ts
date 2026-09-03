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
import {
  MERGE_ARMING_ACTOR_ID,
  MERGE_ARMING_REFUSED_ON_CLOSE_ACTION,
} from "../services/merge-arming.js";

// SUP-14900: a CLOSING transition whose merge arming REFUSED (a principled
// refusal, `statusOutcome.kind === "skipped"`) must not rest the card in quiet
// `done`. The post-approval hook records a durable, first-class signal
// (`issue.merge_arming_refused_on_close`) the card-side done-close-landing
// backstop keys on. These tests drive the REAL route hook through the PATCH
// decision door on a SINGLE-stage review ladder, where approving the only stage
// leaves the requested `done` in place (a closing transition, closingTransition
// === true) — the exact ghost-PASS path SUP-14849 / PR#364 hit.
//
// The service layer is mocked at the module boundary (armMergeOnApproval,
// resolveApprovalDecisionHead, publishApprovalStatus) to pin a specific outcome;
// `shouldPublishApprovalStatus` is left real so the approved-decision gate
// behaves as in production. `logActivity` is NOT mocked: the embedded Postgres
// persists the signal and the assertion queries the real `activity_log` table.
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
    `Skipping approval-arming refusal-signal route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("approval-arming refusal on a closing transition (SUP-14900)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let currentActor!: Express.Request["actor"];

  beforeAll(async () => {
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-arming-refusal-signal-");
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
    mockEvaluateStageIntegrity.mockReset();
    mockEvaluateStageIntegrity.mockImplementation(
      async (inputDb: unknown, row: unknown) => realEvaluateStageIntegrity.fn!(inputDb, row),
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
   * Seeds an issue parked on a PENDING single-stage review ladder with the
   * company's `mergeArmingEnabled` flag TRUE. Approving the only stage has no
   * `nextStage`, so the requested `done` is left in place — a CLOSING transition
   * (`closingTransition === true`). That is the path where a refusal would
   * otherwise rest the card in quiet `done`.
   */
  async function seedIssueClosing(issuePrefix: string) {
    const companyId = randomUUID();
    const reviewerAgentId = randomUUID();
    const implementerAgentId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const stageId = randomUUID();
    const identifier = `${issuePrefix}-1`;
    const branchName = `${identifier}-test-branch`;
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
      repoUrl: "https://github.com/TEA-Core/paperclip",
      baseRef: "fold/tea-patches-v2026.722.0",
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
        id: stageId,
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
      title: "Approval-arming refusal on a closing transition must signal, not rest quiet",
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
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: implementerAgentId, userId: null },
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

  /** All `issue.merge_arming_refused_on_close` signals the hook recorded. */
  async function refusalSignals(issueId: string) {
    const rows = await db
      .select({ details: activityLog.details, actorId: activityLog.actorId, action: activityLog.action })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.action, MERGE_ARMING_REFUSED_ON_CLOSE_ACTION),
        ),
      );
    return rows;
  }

  async function mergeArmingComments(issueId: string) {
    const rows = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    return rows.filter((r) => typeof r.body === "string" && r.body.startsWith("[Merge-arming]"));
  }

  /** Approves the single (final) stage through the PATCH decision door. */
  async function approveClosingStage(identifier: string) {
    return request(app)
      .patch(`/api/issues/${identifier}`)
      .send({
        status: "done",
        comment:
          "Closed at Tier 1 (landed, not liveness-probed): decision approved the only review stage. Liveness unverified.\n\nkind: review\ndecision: approved",
      });
  }

  it("head_unresolvable on a CLOSING transition: card still closes done AND a first-class refusal signal is recorded (AC#1)", async () => {
    const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueClosing("DSIG1");
    currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));

    mockResolveApprovalDecisionHead.mockResolvedValue({
      kind: "unresolvable",
      reason: "no-pr: no open linked PR resolvable at decision time",
    });
    mockArmMergeOnApproval.mockResolvedValue({ kind: "skipped", message: "skipped: must-not-run" });

    const res = await approveClosingStage(identifier);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // ADR-073 D3: a refusal never refuses to close. The card lands `done`.
    expect(await statusOf(issueId)).toBe("done");

    // The refusal is first-class and durable, not a quiet done.
    const signals = await refusalSignals(issueId);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.actorId).toBe(MERGE_ARMING_ACTOR_ID);
    expect(signals[0]!.details).toMatchObject({
      identifier,
      decisionOutcome: "approved",
      headSha: null,
    });
    expect(signals[0]!.details?.refusalReason).toEqual(
      expect.stringContaining("status:skipped:head_unresolvable:"),
    );

    // armMergeOnApproval is never reached on a refusal.
    expect(mockArmMergeOnApproval).toHaveBeenCalledTimes(0);
  });

  it("normally armed on a CLOSING transition: card closes done with NO refusal signal (AC#3 negative)", async () => {
    const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueClosing("DSIG2");
    currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));

    mockResolveApprovalDecisionHead.mockResolvedValue({
      kind: "resolved",
      headSha: "deadbeefcafe",
      displayName: "TEA-Core/paperclip#364",
    });
    mockPublishApprovalStatus.mockResolvedValue({
      kind: "armed",
      message: "armed: paperclip/paperclip#364 auto-merge armed at deadbeefcafe",
      headSha: "deadbeefcafe",
    });
    mockArmMergeOnApproval.mockResolvedValue({ kind: "armed", message: "armed" });

    const res = await approveClosingStage(identifier);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("done");

    // No refusal: the arming succeeded, so no refusal signal is recorded.
    expect(await refusalSignals(issueId)).toHaveLength(0);
    // ...and the arm step ran.
    expect(mockArmMergeOnApproval).toHaveBeenCalledTimes(1);
  });

  it("arming service THROWS on a CLOSING transition: transition still lands done, no refusal signal, no crash (AC#4)", async () => {
    const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueClosing("DSIG3");
    currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));

    // A genuine hook failure (the decision-head resolution rejects) is NOT a
    // principled refusal: the hook's catch swallows it, the transition is
    // unaffected, and no refusal signal is raised.
    mockResolveApprovalDecisionHead.mockRejectedValue(new Error("github 500 during head resolution"));

    const res = await approveClosingStage(identifier);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("done");
    expect(await refusalSignals(issueId)).toHaveLength(0);
    expect(mockArmMergeOnApproval).toHaveBeenCalledTimes(0);
  });
});
