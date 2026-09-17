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
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// SUP-16607: inject a raw, non-HttpError fault at the guard boundary. On the live
// incident (SUP-16602, 01:05Z) a done-close PATCH died with a bare
// `{"error":"Internal server error"}` and left ZERO durable rows -- no activity
// entry, no execution decision -- because the guard runs before the close
// transaction and nothing records an unhandled termination. The route must now
// (a) attribute the fault in the response and (b) persist what threw, while
// leaving typed refusals exactly as they were.
const guardHolder = vi.hoisted(() => ({
  real: undefined as
    | undefined
    | ((...args: unknown[]) => unknown),
}));
const mockEvaluateDoneTransitionGuard = vi.hoisted(() => vi.fn());
const mockResolveSecretValue = vi.hoisted(() => vi.fn());
const mockGetByName = vi.hoisted(() => vi.fn());
const mockGhFetch = vi.hoisted(() => vi.fn());

vi.mock("../services/done-transition-guard.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/done-transition-guard.js")>();
  guardHolder.real = actual.evaluateDoneTransitionGuard as (...args: unknown[]) => unknown;
  return { ...actual, evaluateDoneTransitionGuard: mockEvaluateDoneTransitionGuard };
});

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
    `Skipping issue-patch unhandled-error tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres(
  "issues PATCH records and attributes an unhandled non-HttpError (SUP-16607)",
  () => {
    let db!: Db;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
    let app!: express.Express;
    let currentActor!: Express.Request["actor"];
    let previousSchedulingSuppression: string | undefined;

    beforeAll(async () => {
      previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
      process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-patch-error-");
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
      mockResolveSecretValue.mockReset();
      mockGetByName.mockReset();
      mockGhFetch.mockReset();
      mockEvaluateDoneTransitionGuard.mockReset();
      // Default: exercise the real guard. Individual tests override with a fault.
      mockEvaluateDoneTransitionGuard.mockImplementation((...args: unknown[]) =>
        (guardHolder.real as (...a: unknown[]) => unknown)(...args),
      );
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

    async function seedIssue(issuePrefix: string) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const executionWorkspaceId = randomUUID();
      const projectId = randomUUID();
      const projectWorkspaceId = randomUUID();
      const identifier = `${issuePrefix}-1`;
      const branchName = `${identifier}-test-branch`;
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
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Implementer",
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
      await db.insert(issues).values({
        id: issueId,
        companyId,
        identifier,
        issueNumber: 1,
        title: "Unhandled guard fault must leave a durable trace",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        createdByUserId: "cloud-user-1",
        executionWorkspaceId,
        executionPolicy: null,
        executionState: null,
      });
      await db
        .update(executionWorkspaces)
        .set({ sourceIssueId: issueId })
        .where(eq(executionWorkspaces.id, executionWorkspaceId));

      return { companyId, agentId, issueId, identifier };
    }

    function boardActor(companyId: string): Express.Request["actor"] {
      return {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
        runId: randomUUID(),
      };
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

    async function errorRows(companyId: string, issueId: string) {
      return db
        .select({ action: activityLog.action, details: activityLog.details })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityId, issueId),
            eq(activityLog.action, "issue.patch_unhandled_error"),
          ),
        );
    }

    it("PATCH: attributes the fault and persists the error class when the guard throws a raw Error", async () => {
      const { companyId, issueId, identifier } = await seedIssue("D16607A");
      currentActor = boardActor(companyId);
      mockEvaluateDoneTransitionGuard.mockRejectedValue(
        new TypeError("fetch failed: socket hang up"),
      );

      const res = await request(app)
        .patch(`/api/issues/${identifier}`)
        .send({ status: "done", comment: "Closed at Tier 2 (live): plain close." });

      // Never a bare 500 body: the caller gets a code and details it can quote.
      expect(res.status).toBe(500);
      expect(res.body.error).not.toBe("Internal server error");
      expect(res.body.code).toBe("issue_patch_unhandled_error");
      expect(res.body.details.issueId).toBe(issueId);
      expect(res.body.details.errorClass).toBe("TypeError");
      expect(res.body.details.message).toContain("fetch failed");

      // The transition must not have landed.
      expect(await statusOf(issueId)).toBe("in_progress");

      // And the fault is durable, not just in the response.
      const rows = await vi.waitFor(
        async () => {
          const found = await errorRows(companyId, issueId);
          if (found.length === 0) throw new Error("waiting for the recorder row");
          return found;
        },
        { timeout: 5000 },
      );
      const details = rows[0]?.details as Record<string, unknown>;
      expect(details.errorClass).toBe("TypeError");
      expect(details.identifier).toBe(identifier);
      expect(details.message).toContain("fetch failed");
    });

    it("PATCH: a typed HttpError refusal keeps its own status and body (recorder is scoped to 500s)", async () => {
      const { companyId, issueId, identifier } = await seedIssue("D16607B");
      currentActor = boardActor(companyId);
      mockUnmergedBranch();

      const res = await request(app)
        .patch(`/api/issues/${identifier}`)
        .send({ status: "done", comment: "Closed by the board, no decision attached." });

      // The real guard blocks the unlanded branch with a typed 409; the recorder
      // must not rewrite it and must not fire on a non-500.
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe("done_transition_missing_delivery");
      expect(res.body.details.decisionCarried).toBe(false);
      expect(res.body.details.aheadBy).toBe(3);
      expect(await statusOf(issueId)).toBe("in_progress");
      expect(await errorRows(companyId, issueId)).toHaveLength(0);
    });
  },
);
