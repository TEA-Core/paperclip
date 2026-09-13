import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
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

/**
 * SUP-16081 fix #2 (round-1 support-CR, finding
 * total-publish-outcome-skips-prepublish-guards): the three pre-publish guards in
 * runApprovalMergeArming (issues.ts) each refuse to stamp/arm and then RETURN.
 * Before this fix they returned WITHOUT recording anything on
 * executionState.approvalStatus, so a card with no existing approvalStatus could
 * close with the key still absent — the exact silent drop SUP-16041 suffered and
 * the total-outcome contract (AC1) demands a record on EVERY path.
 *
 * This suite drives the POST /issues/:id/execution-stage/board-decision route
 * (which calls runApprovalMergeArming post-commit, identically to the status
 * PATCH path) with a controlled evaluateStageIntegrity to fire each pre-publish
 * guard, then reads the persisted card back to prove the named record landed:
 *   - stage-integrity finding  -> publishSkipped (status:skipped:stage_integrity:*)
 *   - stage-integrity throw    -> publishFailure (status:failed:stage_integrity_check_threw:*)
 *   - non-terminal ladder      -> publishSkipped (status:skipped:non-terminal-ladder:*)
 */
const guardControl = vi.hoisted(() => ({
  mode: "pass" as "pass" | "finding" | "throw",
}));

vi.mock("../services/approval-status-reconciler.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../services/approval-status-reconciler.js")
  >();
  return {
    ...actual,
    evaluateStageIntegrity: (_db: unknown, _row: unknown, _options?: unknown) => {
      if (guardControl.mode === "throw") {
        return Promise.reject(new Error("injected stage-integrity guard exception"));
      }
      if (guardControl.mode === "finding") {
        return Promise.resolve({
          reason: "guard-c:test-finding",
          detail: "injected stage-integrity finding",
        });
      }
      return Promise.resolve(null);
    },
  };
});

// SUP-16081 (comment a78bf2d2): the anchor must be written BEFORE the publish
// attempt. To exercise the WIRING in runApprovalMergeArming (issues.ts) without
// seeding a full GitHub delivery identity + token + PR head, we drive
// resolveApprovalDecisionHead to a resolved head and stub publishApprovalStatus
// to fail / throw — while keeping the REAL recordApprovalAnchor and
// recordApprovalPublishOutcome (spread from the module) so the anchor write and
// the outcome record run exactly as in production.
const mergeArmingControl = vi.hoisted(() => ({
  publishMode: "fail" as "fail" | "throw",
  headSha: "approved00000000000000000000000000000000001",
}));

vi.mock("../services/merge-arming.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/merge-arming.js")>();
  return {
    ...actual,
    resolveApprovalDecisionHead: async () => ({
      kind: "resolved",
      headSha: mergeArmingControl.headSha,
      displayName: "TEA-Core/paperclip#448",
    }),
    publishApprovalStatus: async () => {
      if (mergeArmingControl.publishMode === "throw") {
        throw new Error("injected first-publish exception");
      }
      return {
        kind: "failed",
        message:
          "status:failed:scope_missing: HTTP 403 Resource not accessible by integration",
        headSha: mergeArmingControl.headSha,
      } as unknown as import("../services/merge-arming.js").ArmingOutcome;
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping merge-arming guard-outcome route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// issue_execution_decisions.stage_id is a uuid column, so stage ids must be valid
// UUIDs (they are also the JSONB keys shared with executionPolicy.stages /
// executionState.completedStageIds).
const STAGE_A = "22222222-2222-4222-8222-222222222222";
const STAGE_B = "33333333-3333-4333-8333-333333333333";
const USER_ID = "board-user-1";

describeEmbeddedPostgres("runApprovalMergeArming pre-publish guards record every outcome (SUP-16081 fix #2)", () => {
  let db: Db;
  let app: express.Express;
  let currentActor: Express.Request["actor"];
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousSchedulingSuppression: string | undefined;
  let previousBoardOverride: string | undefined;

  beforeAll(async () => {
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    previousBoardOverride = process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE;
    process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-merge-arming-guard-");
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
    if (previousBoardOverride === undefined) {
      delete process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE;
    } else {
      process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE = previousBoardOverride;
    }
  });

  beforeEach(async () => {
    guardControl.mode = "pass";
    mergeArmingControl.publishMode = "fail";
    await db.delete(issueExecutionDecisions);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(activityLog);
    // The board-decision route enqueues an assignment wakeup referencing the card's
    // assignee agent; clear it before the agent rows it references.
    await db.delete(agentWakeupRequests);
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

  /**
   * Seed a live card in `in_review` sitting on stage A of a review ladder, with a
   * declared return assignee DISTINCT from the stage participant (so the board
   * self-approval gate passes — the board user is neither the return assignee nor
   * a delivery author). `twoStages` appends stage B so the ladder is non-terminal
   * after approving A.
   */
  async function seedLiveCard(opts: { twoStages?: boolean } = {}) {
    const companyId = randomUUID();
    const reviewerAgentId = randomUUID();
    const returnAssigneeAgentId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Guard Outcome Co",
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
      name: "Guard Outcome/paperclip",
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
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated",
      strategyType: "git_worktree",
      name: "card-workspace",
      status: "active",
      branchName: "SUP-16081-delivery",
      repoUrl: "https://github.com/TEA-Core/paperclip",
      createdAt: now,
      updatedAt: now,
    });

    const participant = { type: "agent" as const, agentId: reviewerAgentId };
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "SUP-16081-1",
      issueNumber: 1,
      title: "Guard outcome card",
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
        returnAssigneeAgentId,
        stages: [
          { id: STAGE_A, type: "review", approvalsNeeded: 1, participants: [participant] },
          ...(opts.twoStages
            ? [{ id: STAGE_B, type: "review", approvalsNeeded: 1, participants: [participant] }]
            : []),
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: STAGE_A,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: participant,
        returnAssignee: { type: "agent", agentId: returnAssigneeAgentId },
        completedStageIds: [],
        skippedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
        changesRequestedCount: 0,
      },
    });

    return { companyId, issueId };
  }

  async function readApprovalStatus(issueId: string) {
    const [row] = await db
      .select({ executionState: issues.executionState, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(row).toBeTruthy();
    return (row!.executionState ?? {}) as Record<string, unknown>;
  }

  it("records a stage-integrity finding refusal as a publishSkipped record (guard refusal)", async () => {
    guardControl.mode = "finding";
    const { companyId, issueId } = await seedLiveCard();
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "Approved by board" });

    expect(res.status).toBe(200);
    // The guard refusal happens post-commit: the decision still succeeds (the card
    // is never refused to close — ADR-073 D3 / ADR-092 D5), only the stamp/arm is
    // skipped.
    expect(res.body.outcome).toBe("approved");

    const executionState = await readApprovalStatus(issueId);
    const approvalStatus = executionState.approvalStatus as Record<string, unknown> | undefined;
    // The total-record contract: the key is PRESENT and names the refusal.
    expect(approvalStatus).toBeDefined();
    const skipped = approvalStatus!.publishSkipped as Record<string, unknown> | undefined;
    expect(skipped).toBeDefined();
    expect(String(skipped!.reason)).toMatch(/^status:skipped:stage_integrity:/);
    expect(String(skipped!.reason)).toContain("guard-c:test-finding");
    expect(skipped!.headSha).toBeNull();
  });

  it("records an injected stage-integrity guard throw as a publishFailure record (guard exception)", async () => {
    guardControl.mode = "throw";
    const { companyId, issueId } = await seedLiveCard();
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "Approved by board" });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("approved");

    const executionState = await readApprovalStatus(issueId);
    const approvalStatus = executionState.approvalStatus as Record<string, unknown> | undefined;
    expect(approvalStatus).toBeDefined();
    const failure = approvalStatus!.publishFailure as Record<string, unknown> | undefined;
    expect(failure).toBeDefined();
    expect(String(failure!.reason)).toMatch(/^status:failed:stage_integrity_check_threw:/);
    expect(String(failure!.reason)).toContain("injected stage-integrity guard exception");
    expect(failure!.headSha).toBeNull();
  });

  it("records a non-terminal-ladder refusal as a publishSkipped record (ladder not terminal)", async () => {
    guardControl.mode = "pass";
    // Two stages: approving A leaves B outstanding, so the ladder is not terminally
    // approved and the first publish is refused as a skip (not a failure).
    const { companyId, issueId } = await seedLiveCard({ twoStages: true });
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "Approved by board" });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("approved");

    const executionState = await readApprovalStatus(issueId);
    const approvalStatus = executionState.approvalStatus as Record<string, unknown> | undefined;
    expect(approvalStatus).toBeDefined();
    const skipped = approvalStatus!.publishSkipped as Record<string, unknown> | undefined;
    expect(skipped).toBeDefined();
    expect(String(skipped!.reason)).toMatch(/^status:skipped:non-terminal-ladder:/);
    expect(skipped!.headSha).toBeNull();
  });

  // SUP-16081 (comment a78bf2d2): the approval anchor (approvedHeadSha +
  // approvedAt) must be written durably BEFORE the first-publish status write is
  // attempted. On SUP-16041 a dropped/failed publish left approvedHeadSha absent,
  // so both recovery paths (backfill D-B fallback, merge-arming/republish) were
  // structurally unable to run. Stubbing the status write to fail must still leave
  // a real anchor on the card.
  it("a failing first publish still leaves the approval anchor on the card (a78bf2d2: anchor before publish)", async () => {
    guardControl.mode = "pass";
    mergeArmingControl.publishMode = "fail";
    const { companyId, issueId } = await seedLiveCard();
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "Approved by board" });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("approved");

    const executionState = await readApprovalStatus(issueId);
    const approvalStatus = executionState.approvalStatus as Record<string, unknown> | undefined;
    expect(approvalStatus).toBeDefined();
    // The anchor was written BEFORE the publish attempt and survived its failure.
    expect(approvalStatus!.approvedHeadSha).toBe(mergeArmingControl.headSha);
    expect(typeof approvalStatus!.approvedAt).toBe("string");
    // The failed publish is recorded as a named failure, not silently dropped.
    const failure = approvalStatus!.publishFailure as Record<string, unknown> | undefined;
    expect(failure).toBeDefined();
    expect(String(failure!.reason)).toMatch(/^status:failed:/);
    expect(failure!.headSha).toBe(mergeArmingControl.headSha);
    // No published head — the stamp never landed.
    expect(approvalStatus!.publishedHeadSha).toBeUndefined();
  });

  it("a throwing first publish still leaves the approval anchor on the card (a78bf2d2: hard-kill backstop)", async () => {
    guardControl.mode = "pass";
    mergeArmingControl.publishMode = "throw";
    const { companyId, issueId } = await seedLiveCard();
    currentActor = boardActor(companyId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "Approved by board" });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("approved");

    const executionState = await readApprovalStatus(issueId);
    const approvalStatus = executionState.approvalStatus as Record<string, unknown> | undefined;
    expect(approvalStatus).toBeDefined();
    // The pre-publish anchor write ran before the throw; the catch backstop
    // rewrites the same head, so approvedHeadSha is present either way.
    expect(approvalStatus!.approvedHeadSha).toBe(mergeArmingControl.headSha);
    expect(typeof approvalStatus!.approvedAt).toBe("string");
    const failure = approvalStatus!.publishFailure as Record<string, unknown> | undefined;
    expect(failure).toBeDefined();
    expect(String(failure!.reason)).toMatch(/^status:failed:internal:/);
    expect(String(failure!.reason)).toContain("injected first-publish exception");
  });
});
