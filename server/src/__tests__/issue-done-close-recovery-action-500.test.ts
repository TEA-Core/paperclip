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
  issueRecoveryActions,
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
import { authorizationService } from "../services/authorization.js";
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// SUP-16607: rebuild the live shape that produced the bare 500 on SUP-16602 at
// 01:05Z -- a done-close PATCH sent by the stage's OWN current participant to a
// card that had drifted to `in_progress` while an ACTIVE recovery action
// (`review_stage_armed_stranded`) sat on it, with a `checkoutRunId` belonging to
// a different run. The four earlier probes and two prior runs established that
// this shape does NOT deterministically reproduce a bare 500 against the current
// build (see PR body); the fixture is committed so the contract it does hold --
// "never a bare 500 on the governed close path" -- is pinned as a regression.
// The general non-HttpError recorder is exercised separately in
// issue-patch-unhandled-error-record.test.ts.
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
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue done-close recovery-action tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres(
  "done-close PATCH while a recovery action is active (SUP-16607)",
  () => {
    let db!: Db;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
    let app!: express.Express;
    let currentActor!: Express.Request["actor"];
    let previousSchedulingSuppression: string | undefined;

    beforeAll(async () => {
      previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
      process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-done-close-recovery-");
      db = createDb(tempDb.connectionString);
      app = createApp();
    }, 60_000);

    afterAll(async () => {
      if (db) await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
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
      const localApp = express();
      localApp.use(express.json());
      localApp.use((req, _res, next) => {
        req.actor = currentActor;
        next();
      });
      localApp.use("/api", issueRoutes(db, {} as any));
      localApp.use(errorHandler);
      return localApp;
    }

    async function seedRun(
      companyId: string,
      agentId: string,
      issueId: string,
      status: "running" | "succeeded" = "running",
    ) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status,
        contextSnapshot: { issueId },
        ...(status === "succeeded" ? { finishedAt: new Date(), startedAt: new Date() } : {}),
      });
      return runId;
    }

    /**
     * The live shape: a card on a pending review stage whose current participant
     * is the acting agent, drifted to `in_progress`, with a checkout/execution run
     * that belongs to a different run. `withRecoveryAction` toggles the one state
     * that changed between the 422 attempts and the 500 attempts.
     *
     * SUP-16705 adds two knobs so the same shape can prove the self-management
     * waiver is closed at the call site:
     *  - `conflictingRunOwner` picks whose run holds the checkout. `"assignee"`
     *    (the AC1' shape) is a *sibling run of the same agent*; `"other"` is the
     *    legacy foreign-run fixture.
     *  - `withManager` seeds a third agent the assignee reports to, so a
     *    DIFFERENT managing agent can be the actor (the AC3' shape).
     */
    async function seedLiveShape(
      issuePrefix: string,
      opts: {
        withRecoveryAction: boolean;
        conflictingRunOwner?: "assignee" | "other";
        withManager?: boolean;
      },
    ) {
      const companyId = randomUUID();
      const actorAgentId = randomUUID();
      const otherAgentId = randomUUID();
      const managerAgentId = randomUUID();
      const issueId = randomUUID();
      const executionWorkspaceId = randomUUID();
      const projectId = randomUUID();
      const projectWorkspaceId = randomUUID();
      const stageId = randomUUID();
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
        [actorAgentId, "Reviewer"],
        [otherAgentId, "Other"],
        [managerAgentId, "Manager"],
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
      if (opts.withManager) {
        await db
          .update(agents)
          .set({ reportsTo: managerAgentId })
          .where(eq(agents.id, actorAgentId));
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

      const conflictingRunAgentId =
        opts.conflictingRunOwner === "other" ? otherAgentId : actorAgentId;
      const actorRunId = await seedRun(companyId, actorAgentId, issueId);
      const managerRunId = await seedRun(companyId, managerAgentId, issueId);
      const conflictingCheckoutRunId = await seedRun(
        companyId,
        conflictingRunAgentId,
        issueId,
        "succeeded",
      );
      const conflictingExecutionRunId = await seedRun(
        companyId,
        conflictingRunAgentId,
        issueId,
        "succeeded",
      );

      await db.insert(issues).values({
        id: issueId,
        companyId,
        identifier,
        issueNumber: 1,
        title: "Done-close while a recovery action is active",
        // The drift: the stage is pending but the card sits in_progress.
        status: "in_progress",
        priority: "high",
        assigneeAgentId: actorAgentId,
        createdByUserId: "cloud-user-1",
        executionWorkspaceId,
        checkoutRunId: conflictingCheckoutRunId,
        executionRunId: conflictingExecutionRunId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [
            {
              id: stageId,
              type: "review",
              approvalsNeeded: 1,
              participants: [{ type: "agent", agentId: actorAgentId, userId: null }],
            },
          ],
          returnAssigneeAgentId: actorAgentId,
        },
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: actorAgentId, userId: null },
          returnAssignee: { type: "agent", agentId: actorAgentId, userId: null },
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

      if (opts.withRecoveryAction) {
        await db.insert(issueRecoveryActions).values({
          companyId,
          sourceIssueId: issueId,
          kind: "review_stage_armed_stranded",
          status: "active",
          ownerType: "agent",
          ownerAgentId: actorAgentId,
          cause: "review_stage_armed_stranded",
          fingerprint: `held:${issueId}`,
          nextAction: "Resolve the armed review stage.",
        });
      }

      return {
        companyId,
        actorAgentId,
        managerAgentId,
        issueId,
        identifier,
        actorRunId,
        managerRunId,
        conflictingCheckoutRunId,
      };
    }

    function agentActor(
      companyId: string,
      agentId: string,
      runId: string,
    ): Express.Request["actor"] {
      return { type: "agent", agentId, companyId, source: "agent_key", runId };
    }

    /** Branch is ahead of the default ref with no merged PR: nothing landed. */
    function mockUnmergedBranch() {
      mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
      mockResolveSecretValue.mockResolvedValue("test-token");
      mockGhFetch.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) {
          return new Response(JSON.stringify({ ahead_by: 3 }), { status: 200 });
        }
        if (url.includes("/pulls?")) {
          return new Response(JSON.stringify([{ merged: false, merged_at: null }]), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });
    }

    async function statusOf(issueId: string) {
      const rows = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, issueId));
      return rows[0]?.status;
    }

    async function guardedRows(companyId: string, issueId: string) {
      return db
        .select({ action: activityLog.action, details: activityLog.details })
        .from(activityLog)
        .where(
          and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, issueId)),
        );
    }

    const liveCloseComment =
      "Looks good.\n\nkind: review\ndecision: approved\n\n" +
      "Closed at Tier 2 (live): the stage participant re-ran the close against the " +
      "armed card and the delivery ref is unchanged.";

    it("AC1': an assignee cannot waive its own conflicting run lock via the management grant", async () => {
      const {
        companyId,
        issueId,
        identifier,
        actorAgentId,
        actorRunId,
        conflictingCheckoutRunId,
      } = await seedLiveShape("D16607A1", {
        withRecoveryAction: true,
        conflictingRunOwner: "assignee",
      });
      currentActor = agentActor(companyId, actorAgentId, actorRunId);
      mockUnmergedBranch();

      const res = await request(app)
        .patch(`/api/issues/${identifier}`)
        .send({ status: "done", comment: liveCloseComment });

      // The historical shape now resolves to a typed conflict instead of a bare
      // 500: the actor IS the assignee, so its own checkout run is a foreign run
      // it must not be able to waive. Before SUP-16705 this returned 200/done
      // because `isManagerOf(X, X)` made the management grant self-vacuous.
      expect(
        res.body?.error ?? "",
        `unexpected bare 500 body: ${JSON.stringify(res.body)}`,
      ).not.toBe("Internal server error");
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.details?.code).toBe("recovery_source_run_lock");
      expect(res.body.details?.checkoutRunId).toBe(conflictingCheckoutRunId);
      expect(await statusOf(issueId)).toBe("in_progress");
    });

    it("AC2': the waiver is re-scoped at the call site, not by narrowing agentIsInSubtree", async () => {
      const { companyId, actorAgentId } = await seedLiveShape("D16607A2", {
        withRecoveryAction: true,
      });

      // The authorization primitive is deliberately untouched: an agent is still
      // "in its own subtree" (`agentIsInSubtree` short-circuits on
      // rootAgentId === targetAgentId), so `isManagerOf(X, X)` remains true. That
      // is exactly why the run-lock waiver has to be scoped where it is consumed.
      await expect(
        authorizationService(db).isManagerOf(companyId, actorAgentId, actorAgentId),
      ).resolves.toBe(true);
    });

    it("AC3': a different managing agent still waives the run lock and closes the card", async () => {
      const { companyId, issueId, identifier, managerAgentId, managerRunId } =
        await seedLiveShape("D16607A3", {
          withRecoveryAction: true,
          conflictingRunOwner: "assignee",
          withManager: true,
        });
      // The assignee (the run holder) reports to this actor, so the grant is held
      // over a DIFFERENT agent and must keep working.
      currentActor = agentActor(companyId, managerAgentId, managerRunId);
      mockUnmergedBranch();

      // The manager reaches the card through the ancestor escape hatch, which
      // forbids a comment -- so the close carries only `status`. If the manager
      // grant did not waive the run lock, this would 409 recovery_source_run_lock
      // before the update persisted.
      const res = await request(app)
        .patch(`/api/issues/${identifier}`)
        .send({ status: "done" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.details?.code).not.toBe("recovery_source_run_lock");
      // The mutation persisted and the governed close advanced the drifted card
      // to its pending review stage (it does not jump straight to `done`); the
      // point is that the manager's grant waived the lock instead of 409ing.
      expect(await statusOf(issueId)).toBe("in_review");
    });

    it("NO-RECOVERY CONTROL: the same shape without the recovery action behaves identically (AC5)", async () => {
      const { companyId, issueId, identifier, actorAgentId, actorRunId } =
        await seedLiveShape("D16607N", { withRecoveryAction: false });
      currentActor = agentActor(companyId, actorAgentId, actorRunId);
      mockUnmergedBranch();

      const res = await request(app)
        .patch(`/api/issues/${identifier}`)
        .send({ status: "done", comment: liveCloseComment });

      // AC5: with no active recovery action the same close behaves identically
      // and never trips the unhandled-error recorder.
      expect(
        res.body?.error ?? "",
        `unexpected bare 500 body: ${JSON.stringify(res.body)}`,
      ).not.toBe("Internal server error");
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await statusOf(issueId)).toBe("done");

      const rows = await guardedRows(companyId, issueId);
      expect(rows.some((row) => row.action === "issue.patch_unhandled_error")).toBe(false);
    });
  },
);