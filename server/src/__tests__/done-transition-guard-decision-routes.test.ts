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
    `Skipping done-transition decision route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * SUP-13185: a `done` transition that carried an execution-policy decision (a board
 * review approval) used to skip BOTH done-guards and every activity_log row, because
 * the predicate was `requestedStatus === "done" && ... && !transition.decision`.
 *
 * Net effect: approval-closed cards went `done` regardless of whether their PR merged
 * (SUP-13176/PR #285, SUP-13181/PR #286) and, because the path wrote nothing at all,
 * they were invisible to the ghost-PASS census by construction — making the SUP-13140
 * figure a floor rather than the population.
 */
describeEmbeddedPostgres("done-transition guards on decision-carrying transitions (SUP-13185)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let currentActor!: Express.Request["actor"];
  let previousSchedulingSuppression: string | undefined;

  beforeAll(async () => {
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-done-transition-decision-");
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

  /**
   * Seeds an issue parked on a pending review stage, exactly as a card awaiting board
   * review sits: status `in_review`, assignee = the reviewer, returnAssignee = the
   * implementer. `stageCount: 2` leaves a second stage pending so an approval of the
   * first stage advances to `in_review` instead of resolving to `done`.
   */
  async function seedIssueAwaitingReview(issuePrefix: string, opts: { stageCount?: 1 | 2 } = {}) {
    const stageCount = opts.stageCount ?? 1;
    const companyId = randomUUID();
    const reviewerAgentId = randomUUID();
    const implementerAgentId = randomUUID();
    const secondReviewerAgentId = randomUUID();
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
      [secondReviewerAgentId, "SecondReviewer"],
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
      ...(stageCount === 2
        ? [
            {
              id: secondStageId,
              type: "review" as const,
              approvalsNeeded: 1 as const,
              participants: [{ type: "agent" as const, agentId: secondReviewerAgentId, userId: null }],
            },
          ]
        : []),
    ];

    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier,
      issueNumber: 1,
      title: "Approval-closed card must still clear the delivery guard",
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
        currentStageId: firstStageId,
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

    return { companyId, reviewerAgentId, implementerAgentId, issueId, identifier };
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, source: "agent_key", runId };
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

  async function auditRows(companyId: string, issueId: string, action: string) {
    return db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, issueId), eq(activityLog.action, action)));
  }

  /** Branch is ahead of the default ref with no merged PR: nothing landed. */
  function mockUnmergedBranch() {
    mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
    mockResolveSecretValue.mockResolvedValue("test-token");
    mockGhFetch.mockImplementation(async (url: string) => {
      if (url.includes("/compare/")) return new Response(JSON.stringify({ ahead_by: 3 }), { status: 200 });
      if (url.includes("/pulls?")) return new Response(JSON.stringify([{ merged: false, merged_at: null }]), { status: 200 });
      return new Response(JSON.stringify({}), { status: 404 });
    });
  }

  /** Nothing left to land. */
  function mockMergedBranch() {
    mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
    mockResolveSecretValue.mockResolvedValue("test-token");
    mockGhFetch.mockImplementation(async (url: string) => {
      if (url.includes("/compare/")) return new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 404 });
    });
  }

  it("PATCH: a final-stage approval on an UNMERGED branch now goes through (decision-carrying carve-out, SUP-13290)", async () => {
    const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueAwaitingReview("D13185A");
    currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));
    mockUnmergedBranch();

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({
        status: "done",
        comment:
          "Looks good.\n\nkind: review\ndecision: approved\n\nClosed at Tier 2 (live): reviewer probe re-hit the changed endpoint and it no longer regresses.",
      });

    // The approval arms the merge (armMergeOnApproval); blocking it on the
    // unmerged branch it is approving deadlocked the circuit (SUP-13207). The
    // delivery carve-out is intact (SUP-14367 kept it); the tier line above is
    // what now carries the close evidence.
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("done");

    const stateRows = await db.select({ executionState: issues.executionState }).from(issues).where(eq(issues.id, issueId));
    expect((stateRows[0]?.executionState as { lastDecisionOutcome?: string } | null)?.lastDecisionOutcome).toBe("approved");

    // The carve-out must be auditable: a skip row naming the exemption.
    const rows = await vi.waitFor(
      async () => {
        const found = await auditRows(companyId, issueId, "issue.done_transition_guard_skipped");
        if (found.length === 0) throw new Error("waiting for audit row");
        return found;
      },
      { timeout: 5000 },
    );
    expect(
      rows.some((r) => (r.details as Record<string, unknown>).skipReason === "ahead_by_no_merged_pr_decision_carried:3"),
    ).toBe(true);
  });

  it("PATCH: a final-stage PLAIN close (no decision) on an UNMERGED branch is still blocked (SUP-13290)", async () => {
    const { companyId, issueId, identifier } = await seedIssueAwaitingReview("D13185G");
    // A board close carries no execution-policy decision, so the carve-out must
    // not apply: the plain close still must land the branch first.
    currentActor = {
      type: "board",
      userId: "cloud-user-1",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      source: "cloud_tenant",
      isInstanceAdmin: false,
      runId: randomUUID(),
    };
    mockUnmergedBranch();

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({ status: "done", comment: "Closed by the board, no decision attached." });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe("done_transition_missing_delivery");
    expect(res.body.details.decisionCarried).toBe(false);
    expect(res.body.details.aheadBy).toBe(3);
    expect(await statusOf(issueId)).toBe("in_review");
  });

  it("PATCH: a final-stage approval that skips the guard still writes an activity_log row (census visibility)", async () => {
    const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueAwaitingReview("D13185B");
    currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));

    // No credential at all -> the guard skips rather than blocks. Before this fix the
    // decision path wrote nothing here, which is precisely why approval-closed cards
    // never appeared in the SUP-13140 census.
    mockGetByName.mockResolvedValue(null);
    mockResolveSecretValue.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({
        status: "done",
        comment:
          "Looks good.\n\nkind: review\ndecision: approved\n\nClosed at Tier 1 (landed, not liveness-probed): delivery guard skipped, no credentials. Liveness unverified.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("done");

    const rows = await vi.waitFor(
      async () => {
        const found = await auditRows(companyId, issueId, "issue.done_transition_guard_skipped");
        if (found.length === 0) throw new Error("waiting for audit row");
        return found;
      },
      { timeout: 5000 },
    );
    expect(rows).toHaveLength(1);
    expect((rows[0]?.details as Record<string, unknown>).decisionCarried).toBe(true);
    expect((rows[0]?.details as Record<string, unknown>).skipReason).toBeTruthy();
  });

  it("PATCH: a decision-carrying close without a tier declaration is rejected with 422 (SUP-14367)", async () => {
    const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueAwaitingReview("D14367A");
    currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));
    mockMergedBranch();

    // SUP-14367: the SUP-13290 carve-out scoped to the delivery guard only. A missing
    // tier declaration is a 422 on the decision-carrying path exactly as on the direct
    // path — and the waiver audit row must no longer exist.
    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({ status: "done", comment: "Looks good.\n\nkind: review\ndecision: approved" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe("done_transition_missing_tier_declaration");
    expect(res.body.details.remedy).toContain('"Closed at Tier 2 (live): <probe evidence>"');
    expect(await statusOf(issueId)).toBe("in_review");

    const rows = await auditRows(companyId, issueId, "issue.done_tier_declaration_skipped");
    expect(rows).toHaveLength(0);
  });

  it("PATCH: a decision-carrying close carrying a verbatim tier line goes through (SUP-14367)", async () => {
    for (const [suffix, tierLine] of [
      [
        "T2",
        "Closed at Tier 2 (live): reviewer probe re-hit the changed endpoint and it no longer regresses.",
      ],
      [
        "T1",
        "Closed at Tier 1 (landed, not liveness-probed): delivery guard skipped on auth failure. Liveness unverified.",
      ],
    ] as const) {
      const { companyId, reviewerAgentId, issueId, identifier } =
        await seedIssueAwaitingReview(`D14367${suffix}`);
      currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));
      mockMergedBranch();

      const res = await request(app)
        .patch(`/api/issues/${identifier}`)
        .send({ status: "done", comment: `Looks good.\n\nkind: review\ndecision: approved\n\n${tierLine}` });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await statusOf(issueId)).toBe("done");
    }
  });

  it("PATCH: an approval that advances to a LATER stage resolves to in_review and is not delivery-guarded", async () => {
    // Guards key on the status the transition RESOLVES to. A requested `done` that the
    // policy redirects to `in_review` is not a close and must not be blocked by an
    // unmerged branch — otherwise the fix would wedge every multi-stage review.
    const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueAwaitingReview("D13185D", {
      stageCount: 2,
    });
    currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));
    mockUnmergedBranch();

    const res = await request(app)
      .patch(`/api/issues/${identifier}`)
      .send({ status: "done", comment: "Stage 1 approved.\n\nkind: review\ndecision: approved" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("in_review");
    // No delivery probe should have been made at all for a non-closing transition.
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("POST comment: auto-approval onto done on an UNMERGED branch now goes through (decision-carrying carve-out, SUP-13290)", async () => {
    // The comment auto-approval path is a second door onto `done` that runs the same
    // guards with the same decision: it is the same decision-carrying approval as the
    // PATCH door, so it gets the same carve-out (SUP-13207 direction B).
    const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueAwaitingReview("D13185E");
    currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));
    mockUnmergedBranch();

    const res = await request(app)
      .post(`/api/issues/${identifier}/comments`)
      .send({
        body: "## Review: APPROVED\n\nShip it.\n\nClosed at Tier 2 (live): reviewer probe verified the patched path on the PR head.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await statusOf(issueId)).toBe("done");
  });

  it("POST comment: auto-approval still closes the card when the branch has landed", async () => {
    const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueAwaitingReview("D13185F");
    currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));
    mockMergedBranch();

    const res = await request(app)
      .post(`/api/issues/${identifier}/comments`)
      .send({
        body: "## Review: APPROVED\n\nShip it.\n\nClosed at Tier 1 (landed, not liveness-probed): nothing to land. Liveness unverified.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await statusOf(issueId)).toBe("done");
  });

    it("POST comment: a decision-carrying approval without a tier declaration 422s with nothing written (SUP-14367)", async () => {
      // The guard runs BEFORE the comment+status transaction (the pre-transaction
      // contract): a 422 must leave both the comment and the status change unwritten,
      // so the close is retryable as-is.
      const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueAwaitingReview("D14367B");
      currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));
      mockMergedBranch();

      const res = await request(app)
        .post(`/api/issues/${identifier}/comments`)
        .send({ body: "## Review: APPROVED\n\nShip it." });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.code).toBe("done_transition_missing_tier_declaration");
      expect(await statusOf(issueId)).toBe("in_review");
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(0);
    });

    // SUP-14429 (mechanism B): an open linked PR held by an undismissed external
    // CHANGES_REQUESTED review must NOT be waived by the decision-carrying
    // carve-out. The refusal leaves both the comment and the status change
    // unwritten on both doors (pre-transaction contract), and the audit row
    // carries the stable refusal token the retroactive audit keys on.
    function mockOpenPrHeldByChangesRequested(branchName: string, identifier: string) {
      mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
      mockResolveSecretValue.mockResolvedValue("test-token");
      mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes("/compare/")) return new Response(JSON.stringify({ ahead_by: 3 }), { status: 200 });
        if (url.includes("/pulls?")) {
          return new Response(
            JSON.stringify([
              { number: 42, draft: false, head: { ref: branchName }, title: `${identifier}: the carrier PR`, body: null },
            ]),
            { status: 200 },
          );
        }
        if (url.includes("/pulls/42")) return new Response(JSON.stringify({ state: "open" }), { status: 200 });
        if (url === "https://api.github.com/graphql") {
          return new Response(
            JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: "CHANGES_REQUESTED" } } } }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });
    }

    it("PATCH: a final-stage approval over an open PR held by CHANGES_REQUESTED is refused 409 with nothing written (SUP-14429 AC2/AC5)", async () => {
      const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueAwaitingReview("D14429A");
      const branchName = `${identifier}-test-branch`;
      currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));
      mockOpenPrHeldByChangesRequested(branchName, identifier);

      const res = await request(app)
        .patch(`/api/issues/${identifier}`)
        .send({
          status: "done",
          comment:
            "Looks good.\n\nkind: review\ndecision: approved\n\nClosed at Tier 2 (live): reviewer probe re-hit the changed endpoint.",
        });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe("done_transition_missing_delivery");
      expect(res.body.details.decisionCarried).toBe(true);
      expect(await statusOf(issueId)).toBe("in_review");
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(0);

      // The retroactive-audit consume-contract: the stable refusal token on both
      // reason and skipReason, with the held PR display name.
      const rows = await vi.waitFor(
        async () => {
          const found = await auditRows(companyId, issueId, "issue.done_transition_guard_skipped");
          const hit = found.filter(
            (r) => (r.details as Record<string, unknown>).reason === "open_linked_prs_changes_requested:1",
          );
          if (hit.length === 0) throw new Error("waiting for refusal audit row");
          return hit;
        },
        { timeout: 5000 },
      );
      expect((rows[0]!.details as Record<string, unknown>).skipReason).toBe("open_linked_prs_changes_requested:1");
      expect(String((rows[0]!.details as Record<string, unknown>).prs)).toContain("TEA-Core/paperclip#42");
    });

    it("POST comment: auto-approval over an open PR held by CHANGES_REQUESTED is refused 409 with nothing written (SUP-14429 AC5)", async () => {
      const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueAwaitingReview("D14429B");
      const branchName = `${identifier}-test-branch`;
      currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));
      mockOpenPrHeldByChangesRequested(branchName, identifier);

      const res = await request(app)
        .post(`/api/issues/${identifier}/comments`)
        .send({
          body: "## Review: APPROVED\n\nShip it.\n\nClosed at Tier 2 (live): reviewer probe verified the patched path on the PR head.",
        });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe("done_transition_missing_delivery");
      expect(await statusOf(issueId)).toBe("in_review");
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(0);

      const rows = await vi.waitFor(
        async () => {
          const found = await auditRows(companyId, issueId, "issue.done_transition_guard_skipped");
          const hit = found.filter(
            (r) => (r.details as Record<string, unknown>).reason === "open_linked_prs_changes_requested:1",
          );
          if (hit.length === 0) throw new Error("waiting for refusal audit row");
          return hit;
        },
        { timeout: 5000 },
      );
      expect((rows[0]!.details as Record<string, unknown>).skipReason).toBe("open_linked_prs_changes_requested:1");
    });

    it("PATCH: a final-stage approval over an open PR whose review decision is APPROVED keeps the D6 waiver (SUP-14429 AC3, SUP-13207 regression)", async () => {
      const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueAwaitingReview("D14429C");
      const branchName = `${identifier}-test-branch`;
      currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));
      mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
      mockResolveSecretValue.mockResolvedValue("test-token");
      mockGhFetch.mockImplementation(async (url: string) => {
        if (url.includes("/pulls?")) {
          return new Response(
            JSON.stringify([
              { number: 42, draft: false, head: { ref: branchName }, title: `${identifier}: the carrier PR`, body: null },
            ]),
            { status: 200 },
          );
        }
        if (url.includes("/pulls/42")) return new Response(JSON.stringify({ state: "open" }), { status: 200 });
        if (url === "https://api.github.com/graphql") {
          return new Response(
            JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });

      const res = await request(app)
        .patch(`/api/issues/${identifier}`)
        .send({
          status: "done",
          comment:
            "Looks good.\n\nkind: review\ndecision: approved\n\nClosed at Tier 2 (live): reviewer probe re-hit the changed endpoint.",
        });

      // The open mergeable PR stays open until the merge lands (ADR-074 D6):
      // the waiver fires and the close goes through.
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await statusOf(issueId)).toBe("done");
      const rows = await vi.waitFor(
        async () => {
          const found = await auditRows(companyId, issueId, "issue.done_transition_guard_skipped");
          if (found.length === 0) throw new Error("waiting for waiver audit row");
          return found;
        },
        { timeout: 5000 },
      );
      expect(
        rows.some((r) => (r.details as Record<string, unknown>).reason === "open_linked_prs_decision_carried:1"),
      ).toBe(true);
    });

  it("POST comment: auto-approval publishes paperclip/approved and persists the Guard A head (SUP-13904)", async () => {
    // The comment door is a second door onto an approved review decision. Before
    // the shared post-hook it closed the card WITHOUT publishing
    // paperclip/approved and WITHOUT persisting executionState.approvalStatus —
    // the PR stranded open at the fail-closed merge enforcer and the
    // approval-status reconciler's Guard A had no certified head to re-publish
    // from (guard-a:no-approved-head on every tick).
    // Prefix "SUP" mirrors the issueIdentifier the hook builds (`SUP-<number>`),
    // so the live PR head ref (`SUP-1-test-branch`) carries the match needle.
    const { companyId, reviewerAgentId, issueId, identifier } = await seedIssueAwaitingReview("SUP");
    currentActor = agentActor(companyId, reviewerAgentId, await seedRun(companyId, reviewerAgentId, issueId));

    const branchName = `${identifier}-test-branch`;
    const headSha = "9f8e7d6c5b4a39281706f5e4d3c2b1a09876543210fedcba9876543210";
    mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
    mockResolveSecretValue.mockResolvedValue("test-token");
    mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      // done-guard delivery probe: branch ahead of the default ref, PR open and unmerged.
      if (url.includes("/compare/")) return new Response(JSON.stringify({ ahead_by: 3 }), { status: 200 });
      if (url.includes("/pulls?")) {
        return new Response(
          JSON.stringify([
            {
              number: 42,
              draft: false,
              merged: false,
              merged_at: null,
              head: { ref: branchName },
              title: `${identifier}: fix the thing`,
              body: null,
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes(`/pulls/42`)) return new Response(JSON.stringify({ head: { sha: headSha } }), { status: 200 });
      if (url.includes("/statuses/")) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      return new Response(JSON.stringify({}), { status: 404 });
    });

    // Exercise the merge-arming gate as well (armMergeOnApproval is called for
    // 0 linked PRs in the DB and reports skipped:no-pr without touching GitHub).
    await db.update(companies).set({ mergeArmingEnabled: true }).where(eq(companies.id, companyId));

    const res = await request(app)
      .post(`/api/issues/${identifier}/comments`)
      .send({
        body: "## Review: APPROVED\n\nShip it.\n\nClosed at Tier 2 (live): reviewer probe verified the patched path on the PR head.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await statusOf(issueId)).toBe("done");

    // The paperclip/approved commit status was written to the live PR head.
    const statusCalls = mockGhFetch.mock.calls.filter(
      ([url, init]) => String(url).includes("/statuses/") && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(statusCalls.length).toBe(1);
    expect(String(statusCalls[0]![0])).toContain(headSha);

    // Guard A persistence: the approval certified a head, so the reconciler can
    // verify content identity before any later re-publish.
    const stateRows = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId));
    const approvalStatus = (stateRows[0]?.executionState as Record<string, any> | null)?.approvalStatus;
    expect(approvalStatus?.publishedHeadSha).toBe(headSha);
    expect(typeof approvalStatus?.publishedAt).toBe("string");
  });
});
