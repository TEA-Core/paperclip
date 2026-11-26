import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as dbExports from "@paperclipai/db";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  executionWorkspaceRuntimeLeases,
  executionWorkspaces,
  externalObjectMentions,
  costEvents,
  agentTaskSessions,
  agentWakeupRequests,
  externalObjects,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceUserRoles,
  issueComments,
  issueDocuments,
  issueExecutionDecisions,
  issueDeliveryReceipts,
  issues,
  issueWorkProducts,
  nativeRunResults,
  completionContracts,
  projectWorkspaces,
  projects,
  toolRuntimeSlots,
  workspaceOperations,
  workspaceRuntimeServices,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentService } from "../services/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { projectRoutes } from "../routes/projects.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { setPluginEventBus } from "../services/activity-log.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import {
  evaluateDoneTransitionGuardForBackstopClose,
  NO_WORKSPACE_REFERENCE_TABLES,
  type evaluateDoneTierDeclaration,
  type measureNoRepositoryLandingForClose,
} from "../services/done-transition-guard.js";
import type { recheckRecordedWorktree } from "../services/hardened-git-probe.js";
import type { StorageService } from "../storage/types.js";

// SUP-22570: the record_only no-repository close, end to end through
// PATCH /api/issues/{id}, against a real Postgres and a real git checkout laid
// out exactly where the server provisions isolated worktrees.

const mockGetByName = vi.hoisted(() => vi.fn());
const mockResolveSecretValue = vi.hoisted(() => vi.fn());
const mockGhFetch = vi.hoisted(() => vi.fn());
const mockEvaluateDoneTierDeclaration = vi.hoisted(() => vi.fn());
const realEvaluateDoneTierDeclarationRef = vi.hoisted(() => ({
  current: null as typeof evaluateDoneTierDeclaration | null,
}));
const mockRecheckRecordedWorktree = vi.hoisted(() => vi.fn());
const realRecheckRecordedWorktreeRef = vi.hoisted(() => ({
  current: null as typeof recheckRecordedWorktree | null,
}));
const mockMeasureNoRepositoryLanding = vi.hoisted(() => vi.fn());
const realMeasureNoRepositoryLandingRef = vi.hoisted(() => ({
  current: null as typeof measureNoRepositoryLandingForClose | null,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    getByName: mockGetByName,
    resolveSecretValue: mockResolveSecretValue,
  }),
}));

vi.mock("../services/github-fetch.js", () => ({
  ghFetch: mockGhFetch,
  gitHubApiBase: (hostname: string) =>
    hostname === "github.com" || hostname === "www.github.com" ? "https://api.github.com" : `https://${hostname}/api/v3`,
}));

vi.mock("../services/hardened-git-probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/hardened-git-probe.js")>();
  realRecheckRecordedWorktreeRef.current = actual.recheckRecordedWorktree;
  mockRecheckRecordedWorktree.mockImplementation(actual.recheckRecordedWorktree);
  return { ...actual, recheckRecordedWorktree: mockRecheckRecordedWorktree };
});

vi.mock("../services/done-transition-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/done-transition-guard.js")>();
  realEvaluateDoneTierDeclarationRef.current = actual.evaluateDoneTierDeclaration;
  mockEvaluateDoneTierDeclaration.mockImplementation(actual.evaluateDoneTierDeclaration);
  realMeasureNoRepositoryLandingRef.current = actual.measureNoRepositoryLandingForClose;
  mockMeasureNoRepositoryLanding.mockImplementation(actual.measureNoRepositoryLandingForClose);
  return {
    ...actual,
    evaluateDoneTierDeclaration: mockEvaluateDoneTierDeclaration,
    measureNoRepositoryLandingForClose: mockMeasureNoRepositoryLanding,
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping record_only no-repository close route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const gitEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: os.tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    env: gitEnv,
    stdio: "pipe",
  }).toString().trim();
}

const NO_REPOSITORY_DONE_TIER = {
  tier: "tier1",
  reason: "The deliverable is the recorded entry ruling",
  landing: { mode: "noRepositoryLanding" },
} as const;

describeEmbeddedPostgres("record_only no-repository close (SUP-22570)", () => {
  const deletionEventBus = createPluginEventBus();
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let currentActor!: Express.Request["actor"];
  let home!: string;
  let previousHome: string | undefined;
  let previousSchedulingSuppression: string | undefined;
  let seedSequence = 0;
  // The bare repository the latest fixture was cloned from: what GitHub holds.
  // The agent's worktree and the managed checkout's refs cannot write it.
  let currentOrigin = "";
  // What GitHub answers to a read of the repository itself.
  let repositoryAnswer = { status: 200, defaultBranch: "main" };

  beforeAll(async () => {
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    previousHome = process.env.PAPERCLIP_HOME;
    home = mkdtempSync(path.join(os.tmpdir(), "paperclip-no-repository-landing-"));
    process.env.PAPERCLIP_HOME = home;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-no-repository-landing-");
    db = createDb(tempDb.connectionString);
    setPluginEventBus(deletionEventBus);
    app = express();
    app.use(express.json());
    // A request may name its own actor (concurrent closes by different agents).
    app.use((req, _res, next) => {
      const override = req.header("x-test-actor");
      req.actor = override ? (JSON.parse(override) as Express.Request["actor"]) : currentActor;
      next();
    });
    // The close path never touches attachment storage.
    const unusedStorage = {} as unknown as StorageService;
    app.use("/api", issueRoutes(db, unusedStorage));
    app.use("/api", projectRoutes(db));
    app.use("/api", executionWorkspaceRoutes(db));
    app.use(errorHandler);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (previousSchedulingSuppression === undefined) delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    else process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = previousSchedulingSuppression;
  });

  // GitHub compare API stand-in: `compare/<base>...<sha>` answers with the
  // commits `sha` has beyond `<base>` in the origin repository, and 404s for a
  // commit origin has never received (a commit only the local checkout holds).
  function compareAgainstOrigin(url: string): Response {
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return new Response(JSON.stringify({ default_branch: repositoryAnswer.defaultBranch }), {
        status: repositoryAnswer.status,
      });
    }
    const match = /\/compare\/([^/]+)\.\.\.([0-9a-f]{40})$/.exec(url);
    if (!match) return new Response(JSON.stringify({}), { status: 404 });
    try {
      const ahead = Number.parseInt(git(currentOrigin, "rev-list", "--count", `${decodeURIComponent(match[1]!)}..${match[2]}`), 10);
      return new Response(JSON.stringify({ ahead_by: ahead }), { status: 200 });
    } catch {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
  }

  // Replaces GitHub's answer to the compare calls only; reading the repository
  // itself keeps answering as it does by default.
  function answerCompares(answer: (url: string) => Response | Promise<Response>) {
    mockGhFetch.mockImplementation(async (url: string) =>
      /\/compare\//.test(url) ? answer(url) : compareAgainstOrigin(url));
  }

  beforeEach(() => {
    repositoryAnswer = { status: 200, defaultBranch: "main" };
    mockGhFetch.mockReset();
    mockGhFetch.mockImplementation(async (url: string) => compareAgainstOrigin(url));
    mockGetByName.mockReset();
    mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
    mockResolveSecretValue.mockReset();
    mockResolveSecretValue.mockResolvedValue("test-token");
    mockEvaluateDoneTierDeclaration.mockReset();
    mockEvaluateDoneTierDeclaration.mockImplementation(realEvaluateDoneTierDeclarationRef.current!);
    mockMeasureNoRepositoryLanding.mockReset();
    mockMeasureNoRepositoryLanding.mockImplementation(realMeasureNoRepositoryLandingRef.current!);
    mockRecheckRecordedWorktree.mockReset();
    mockRecheckRecordedWorktree.mockImplementation(realRecheckRecordedWorktreeRef.current!);
  });

  async function insertCompany(prefix: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: prefix,
      issueCounter: 1,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function insertAgent(companyId: string, name: string) {
    const agentId = randomUUID();
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
    return agentId;
  }

  async function insertRuling(input: {
    companyId: string;
    issueId: string;
    authorAgentId?: string;
    authorUserId?: string;
    body?: string;
    key?: string;
    linkCompanyId?: string;
    documentCompanyId?: string;
  }) {
    const documentId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId: input.documentCompanyId ?? input.companyId,
      title: "Entry ruling",
      format: "markdown",
      latestBody: input.body ?? "Ruling: this card's deliverable is this recorded decision; no repository change.",
      latestRevisionNumber: 1,
      createdByAgentId: input.authorAgentId ?? null,
      updatedByAgentId: input.authorAgentId ?? null,
      createdByUserId: input.authorUserId ?? null,
      updatedByUserId: input.authorUserId ?? null,
    });
    await db.insert(documentRevisions).values({
      companyId: input.documentCompanyId ?? input.companyId,
      documentId,
      revisionNumber: 1,
      body: input.body ?? "Ruling: this card's deliverable is this recorded decision; no repository change.",
      createdByAgentId: input.authorAgentId ?? null,
      createdByUserId: input.authorUserId ?? null,
    });
    await db.insert(issueDocuments).values({
      companyId: input.linkCompanyId ?? input.companyId,
      issueId: input.issueId,
      documentId,
      key: input.key ?? "entry-ruling",
    });
    return documentId;
  }

  interface SeededIssue {
    companyId: string;
    closerAgentId: string;
    rulerAgentId: string;
    projectId: string;
    projectWorkspaceId: string;
    executionWorkspaceId: string;
    issueId: string;
    identifier: string;
    worktree: string;
    repoRoot: string;
    branch: string;
    actor: Express.Request["actor"];
  }

  /**
   * A record_only issue whose own isolated git worktree lives at the managed
   * path, clean and level with the default branch on the remote, with an entry ruling
   * written by a different agent than the assignee that closes it.
   */
  async function seed(
    options: {
      deliveryRequirement?: "record_only" | "repository_delivery";
      workspace?: Partial<typeof executionWorkspaces.$inferInsert>;
      /** The issue-title slug after the identifier in the worktree's branch (the default template). */
      branchSlug?: string | ((identifier: string) => string);
      projectWorkspace?: Partial<typeof projectWorkspaces.$inferInsert>;
    } = {},
  ): Promise<SeededIssue> {
    seedSequence += 1;
    const prefix = `NRL${seedSequence}`;
    const companyId = await insertCompany(prefix);
    const closerAgentId = await insertAgent(companyId, "Closer");
    const rulerAgentId = await insertAgent(companyId, "Ruler");
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const identifier = `${prefix}-1`;
    const branchSlug = typeof options.branchSlug === "function" ? options.branchSlug(identifier) : options.branchSlug;
    const branch = `${identifier}-${branchSlug ?? "entry-ruling"}`;

    const repoRoot = resolveManagedProjectWorkspaceDir({ companyId, projectId, repoName: "paperclip" });
    const origin = path.join(home, "origins", `${prefix}.git`);
    mkdirSync(path.dirname(origin), { recursive: true });
    git(home, "init", "-q", "--bare", "-b", "main", origin);
    const seedRepo = path.join(home, "seeds", prefix);
    mkdirSync(seedRepo, { recursive: true });
    git(seedRepo, "init", "-q", "-b", "main");
    writeFileSync(path.join(seedRepo, "README.md"), "seed\n");
    git(seedRepo, "add", "README.md");
    git(seedRepo, "commit", "-qm", "seed");
    git(seedRepo, "push", "-q", origin, "main");
    mkdirSync(path.dirname(repoRoot), { recursive: true });
    git(home, "clone", "-q", origin, repoRoot);
    currentOrigin = origin;
    const worktree = path.join(repoRoot, ".paperclip", "worktrees", branch);
    git(repoRoot, "worktree", "add", "-q", "-b", branch, worktree, "origin/main");

    await db.insert(projects).values({ id: projectId, companyId, name: "Records", status: "active" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: repoRoot,
      repoUrl: "https://github.com/TEA-Core/records",
      repoRef: "main",
      defaultRef: "main",
      isPrimary: true,
      ...options.projectWorkspace,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: null,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: branch,
      status: "active",
      cwd: worktree,
      repoUrl: "https://github.com/TEA-Core/records",
      baseRef: "main",
      branchName: branch,
      providerType: "git_worktree",
      providerRef: worktree,
      ...options.workspace,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      identifier,
      title: "Record the entry ruling",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: closerAgentId,
      createdByUserId: "cloud-user-1",
      executionWorkspaceId,
      deliveryRequirement: options.deliveryRequirement ?? "record_only",
    });
    await db.update(executionWorkspaces).set({ sourceIssueId: issueId }).where(eq(executionWorkspaces.id, executionWorkspaceId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: closerAgentId,
      status: "running",
      contextSnapshot: { issueId },
    });
    currentActor = { type: "agent", agentId: closerAgentId, companyId, source: "agent_key", runId };
    return {
      companyId,
      closerAgentId,
      rulerAgentId,
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      issueId,
      identifier,
      worktree,
      repoRoot,
      branch,
      actor: currentActor,
    };
  }

  async function close(identifier: string, doneTier: unknown = NO_REPOSITORY_DONE_TIER) {
    return request(app).patch(`/api/issues/${identifier}`).send({ status: "done", doneTier });
  }

  async function activityCount(issueId: string, action: string) {
    return db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, action)))
      .then((rows) => rows.length);
  }

  async function activityRows(issueId: string, action: string) {
    return db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, action)));
  }

  const refusalRows = (issueId: string) => activityRows(issueId, "issue.done_transition_refused");

  async function statusOf(issueId: string) {
    return db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]?.status);
  }

  const BELONGS_TO_NO_CARD = "belongs to no card: it is not this card's, not one of the project's branches, not registered to another card's workspace, and not another card's rescue branch";

  it("closes a record_only issue whose own worktree is empty and whose entry ruling another agent wrote", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(fixture.issueId)).toBe("done");
    const bodies = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, fixture.issueId))
      .then((rows) => rows.map((row) => row.body));
    expect(bodies.some((body) => body.includes("Closed at Tier 1 (landed, not liveness-probed): no-repository-landing"))).toBe(true);
  });

  // SUP-23925: the close measurement runs AFTER the guard evaluator deferred
  // the tier1 close row and BEFORE the status write. A refusal there must leave
  // NO orphan tier close row behind — the row is only ever written on the same
  // transaction as the terminal write (audit #52: 8 orphan tier1 rows on cards
  // with zero status→done writes and completedAt=null).
  it("leaves no orphan tier close row when the post-guard close measurement refuses", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    mockMeasureNoRepositoryLanding.mockResolvedValue({ ok: false as const, reason: "the recorded worktree is not clean" });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("the recorded worktree is not clean");
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
    expect(await activityCount(fixture.issueId, "issue.done_transition_tier1_close")).toBe(0);
    expect(await activityCount(fixture.issueId, "issue.done_transition_tier2_close")).toBe(0);
  });

  it("writes exactly one tier1 close row, on the terminal write's transaction, when the close commits", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(fixture.issueId)).toBe("done");
    // Same transaction as status→done: the row is committed by the time the
    // response returns, so no wait-for-audit is needed or permitted here.
    expect(await activityCount(fixture.issueId, "issue.done_transition_tier1_close")).toBe(1);
  });

  // SUP-24298: the activity log follows the actual decision. A refused terminal
  // write leaves a refusal row and never the guard's "transition allowed" row.
  it("records a refused missing-declaration close as a refusal row and not as an allowed transition", async () => {
    const fixture = await seed();

    const res = await request(app).patch(`/api/issues/${fixture.identifier}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe("done_transition_missing_tier_declaration");
    expect(await activityCount(fixture.issueId, "issue.done_transition_guard_skipped")).toBe(0);
    const refusals = await refusalRows(fixture.issueId);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.details).toMatchObject({
      code: "done_transition_missing_tier_declaration",
      httpStatus: 422,
      decisionCarried: false,
      runId: fixture.actor.runId,
      reason: res.body.error,
      identifier: fixture.identifier,
      source: "done_transition_guard",
    });
  });

  it("gives every refused write its own row when the remedy comment is deduplicated", async () => {
    const fixture = await seed();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await request(app).patch(`/api/issues/${fixture.identifier}`).send({ status: "done" });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
    }

    const remedies = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, fixture.issueId))
      .then((rows) => rows.filter((row) => row.body.includes("[Terminal status refused] done_transition_missing_tier_declaration")));
    expect(remedies).toHaveLength(1);
    expect(await refusalRows(fixture.issueId)).toHaveLength(2);
    expect(await activityCount(fixture.issueId, "issue.done_transition_guard_skipped")).toBe(0);
  });

  it("still records the guard disposition for a close that is allowed", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const skipped = await activityRows(fixture.issueId, "issue.done_transition_guard_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.details).toMatchObject({
      skipReason: "record_only_delivery_skipped",
      decisionCarried: false,
      source: "done_transition_guard",
    });
    expect(String((skipped[0]!.details as Record<string, unknown>).reason)).toContain("transition allowed");
    expect(await refusalRows(fixture.issueId)).toHaveLength(0);
  });

  it("still records the guard disposition for a board close, which bypasses the tier declaration", async () => {
    const fixture = await seed();
    currentActor = { type: "board", userId: "local-board", source: "local_implicit" } as Express.Request["actor"];

    const res = await request(app).patch(`/api/issues/${fixture.identifier}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await activityCount(fixture.issueId, "issue.done_transition_guard_skipped")).toBe(1);
    expect(await activityCount(fixture.issueId, "issue.done_tier_declaration_skipped")).toBe(1);
    expect(await refusalRows(fixture.issueId)).toHaveLength(0);
  });

  it("reads a refused, refused, allowed sequence as two refusals and one allowed disposition", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });

    expect((await request(app).patch(`/api/issues/${fixture.identifier}`).send({ status: "done" })).status).toBe(422);
    expect((await request(app).patch(`/api/issues/${fixture.identifier}`).send({ status: "done" })).status).toBe(422);
    expect((await close(fixture.identifier)).status).toBe(200);

    expect(await activityCount(fixture.issueId, "issue.done_transition_refused")).toBe(2);
    expect(await activityCount(fixture.issueId, "issue.done_transition_guard_skipped")).toBe(1);
    expect(await statusOf(fixture.issueId)).toBe("done");
  });

  it("names the no-repository form in the missing-declaration remedy only on a record_only issue", async () => {
    const recordOnly = await seed();
    const recordOnlyRes = await request(app).patch(`/api/issues/${recordOnly.identifier}`).send({ status: "done" });
    expect(recordOnlyRes.status, JSON.stringify(recordOnlyRes.body)).toBe(422);
    expect(recordOnlyRes.body.details.remedy).toContain('"landing": { "mode": "noRepositoryLanding" }');
    expect(recordOnlyRes.body.details.remedy).toContain("no-repository-landing — <why Tier 2 was not probed>");

    const repositoryDelivery = await seed({ deliveryRequirement: "repository_delivery" });
    const repositoryRes = await request(app).patch(`/api/issues/${repositoryDelivery.identifier}`).send({ status: "done" });
    expect(repositoryRes.status, JSON.stringify(repositoryRes.body)).toBe(422);
    expect(repositoryRes.body.details.remedy).not.toContain("noRepositoryLanding");
    expect(repositoryRes.body.details.remedy).not.toContain("no-repository-landing");
  });

  it("keeps refusing the form on a repository_delivery issue", async () => {
    const fixture = await seed({ deliveryRequirement: "repository_delivery" });
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("is accepted only on a record_only issue");
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it("refuses a repository_delivery card with no pull request work product, naming the record_only path in the remedy", async () => {
    const fixture = await seed({ deliveryRequirement: "repository_delivery" });
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    const products = await db
      .select({ id: issueWorkProducts.id })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, fixture.issueId));
    expect(products).toHaveLength(0);

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe("done_transition_missing_tier_declaration");
    expect(res.body.error).toContain("is accepted only on a record_only issue");
    expect(res.body.details.remedy).toContain("authorized board user");
    expect(res.body.details.remedy).toContain('{ "deliveryRequirement": "record_only" }');
    expect(res.body.details.remedy).toContain("no-repository-landing form");
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it("refuses a ruling the closing agent wrote", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.closerAgentId });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("written by someone other than the closing actor");
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it("refuses a ruling linked to another issue", async () => {
    const fixture = await seed();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId: fixture.companyId,
      identifier: `${fixture.identifier}0`,
      title: "Another card",
      status: "todo",
      priority: "medium",
      createdByUserId: "cloud-user-1",
    });
    await insertRuling({ companyId: fixture.companyId, issueId: otherIssueId, authorAgentId: fixture.rulerAgentId });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain('requires a non-empty "entry-ruling" document on this issue');
  });

  it.each([
    ["the link row names another company", "link"],
    ["the document belongs to another company", "document"],
  ] as const)("refuses a ruling when %s", async (_label, foreignSide) => {
    const fixture = await seed();
    const otherCompanyId = await insertCompany(`NRX${seedSequence}`);
    await insertRuling({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      authorAgentId: fixture.rulerAgentId,
      ...(foreignSide === "link" ? { linkCompanyId: otherCompanyId } : { documentCompanyId: otherCompanyId }),
    });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain('requires a non-empty "entry-ruling" document on this issue');
  });

  it.each([
    ["shared project_primary", { mode: "shared_workspace", strategyType: "project_primary", providerType: "local_fs" }],
    ["operator branch", { mode: "operator_branch", strategyType: "git_worktree", providerType: "git_worktree" }],
    ["adapter managed", { mode: "adapter_managed", strategyType: "adapter_managed", providerType: "adapter_managed" }],
    ["cloud sandbox", { mode: "isolated_workspace", strategyType: "cloud_sandbox", providerType: "cloud_sandbox" }],
  ] as const)("refuses a %s workspace", async (_label, kind) => {
    const fixture = await seed({ workspace: kind });
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("requires this issue's own isolated git worktree");
  });

  it("refuses a workspace record that points the probe at a clean repository outside the managed layout", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    const elsewhere = path.join(home, "elsewhere", fixture.identifier);
    mkdirSync(elsewhere, { recursive: true });
    git(elsewhere, "init", "-q", "-b", "main");
    writeFileSync(path.join(fixture.worktree, "undelivered.md"), "work\n");
    await db
      .update(executionWorkspaces)
      .set({ cwd: elsewhere, providerRef: elsewhere, baseRef: "HEAD" })
      .where(eq(executionWorkspaces.id, fixture.executionWorkspaceId));

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("outside the project's managed worktree directory");
  });

  it("rejects a doneTier carrying an own __proto__ key", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });

    const res = await request(app)
      .patch(`/api/issues/${fixture.identifier}`)
      .set("content-type", "application/json")
      .send(
        '{"status":"done","doneTier":{"tier":"tier1","reason":"The deliverable is the recorded entry ruling",' +
          '"landing":{"mode":"noRepositoryLanding","__proto__":{"polluted":true}}}}',
      );

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).toContain("doneTier must not carry a __proto__ key");
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  const PROTO_TIER2_DONE_TIER =
    '{"tier":"tier2","probeEvidence":"probe `x` head 3f9c1e0a25b8 post-merge: y","__proto__":{"polluted":true}}';

  it("rejects a doneTier carrying an own __proto__ key on the comment door, persisting no comment", async () => {
    const fixture = await seed();

    const res = await request(app)
      .post(`/api/issues/${fixture.identifier}/comments`)
      .set("content-type", "application/json")
      .send(`{"body":"closing note","doneTier":${PROTO_TIER2_DONE_TIER}}`);

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).toContain("doneTier must not carry a __proto__ key");
    const comments = await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, fixture.issueId));
    expect(comments).toHaveLength(0);
  });

  it("rejects a doneTier carrying an own __proto__ key on the recovery-action resolution door", async () => {
    const fixture = await seed();

    const res = await request(app)
      .post(`/api/issues/${fixture.issueId}/recovery-actions/resolve`)
      .set("content-type", "application/json")
      .send(`{"outcome":"restored","sourceIssueStatus":"in_progress","doneTier":${PROTO_TIER2_DONE_TIER}}`);

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).toContain("doneTier must not carry a __proto__ key");
  });

  it.each([
    ["a pull request number", "Ruling recorded; see PR #42"],
    ["a commit SHA", "Ruling recorded alongside 3f9c1e0a25b8"],
  ])("refuses a declaration that cites %s", async (_label, reason) => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });

    const res = await close(fixture.identifier, { ...NO_REPOSITORY_DONE_TIER, reason });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("a no-repository close carries no repository evidence");
  });

  async function insertPullRequestProduct(fixture: Pick<SeededIssue, "companyId" | "issueId">, metadata?: Record<string, unknown>) {
    await db.insert(issueWorkProducts).values({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      type: "pull_request",
      provider: "github",
      externalId: "TEA-Core/other#9",
      title: "PR #9",
      url: "https://github.com/TEA-Core/other/pull/9",
      status: "merged",
      reviewState: "none",
      isPrimary: false,
      healthStatus: "unknown",
      ...(metadata === undefined ? {} : { metadata }),
    });
  }

  it("refuses an issue that records a pull request work product", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    await insertPullRequestProduct(fixture);

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("records a pull request work product");
  });

  it("discounts a foreign-headRef pull request work product", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    await insertPullRequestProduct(fixture, {
      repository: "TEA-Core/records",
      prNumber: 9,
      headRef: "SUP-99999-foreign",
    });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(fixture.issueId)).toBe("done");
  });

  it("still refuses a pull request work product on this issue's own delivery branch", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    await insertPullRequestProduct(fixture, {
      repository: "TEA-Core/records",
      prNumber: 9,
      headRef: fixture.branch,
    });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("records a pull request work product");
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it("refuses a pull request work product for an issue-owned workspace with no delivery branch", async () => {
    const fixture = await seed({ workspace: { branchName: null } });
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    await insertPullRequestProduct(fixture, {
      repository: "TEA-Core/records",
      prNumber: 9,
      headRef: fixture.branch,
    });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("records a pull request work product");
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  function commitOnIssueBranch(fixture: SeededIssue) {
    writeFileSync(path.join(fixture.worktree, "deliverable.md"), "work\n");
    git(fixture.worktree, "add", "deliverable.md");
    git(fixture.worktree, "commit", "-qm", `${fixture.identifier} undelivered`);
  }

  it.each([
    ["update-ref moves refs/remotes/origin/main onto it", "refs/remotes/origin/main", (fixture: SeededIssue) =>
      git(fixture.repoRoot, "update-ref", "refs/remotes/origin/main", `refs/heads/${fixture.branch}`)],
    ["a local fetch refspec rewrites refs/remotes/origin/main", "refs/remotes/origin/main", (fixture: SeededIssue) =>
      git(fixture.repoRoot, "fetch", "-q", ".", `+refs/heads/${fixture.branch}:refs/remotes/origin/main`)],
    ["the local main branch is moved onto it", "refs/heads/main", (fixture: SeededIssue) =>
      git(fixture.repoRoot, "update-ref", "refs/heads/main", `refs/heads/${fixture.branch}`)],
  ] as const)("refuses a committed, unpushed deliverable when %s", async (_label, movedRef, moveBase) => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    commitOnIssueBranch(fixture);
    moveBase(fixture);
    expect(git(fixture.repoRoot, "rev-parse", movedRef)).toBe(git(fixture.worktree, "rev-parse", "HEAD"));

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("could not be compared with the project's default branch on the remote");
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it("refuses a pushed deliverable that is ahead of the remote default branch", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    commitOnIssueBranch(fixture);
    git(fixture.worktree, "push", "-q", "origin", `${fixture.identifier}-entry-ruling`);

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("has 1 commit(s) not on the project's default branch");
  });

  it("closes a worktree whose tip is already on the remote default branch, even when the checkout never fetched the new head", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    const other = path.join(home, "other-clone", fixture.identifier);
    mkdirSync(path.dirname(other), { recursive: true });
    git(home, "clone", "-q", currentOrigin, other);
    writeFileSync(path.join(other, "later.md"), "merged by someone else\n");
    git(other, "add", "later.md");
    git(other, "commit", "-qm", "later merge");
    git(other, "push", "-q", "origin", "main");

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(fixture.issueId)).toBe("done");
  });

  it.each([
    ["no GitHub credential is configured", () => mockGetByName.mockResolvedValue(null), "requires a configured GitHub credential"],
    ["GitHub answers the compare call with a server error", () =>
      answerCompares(() => new Response("{}", { status: 500 })), "could not be compared with the project's default branch on the remote"],
    ["the compare call answers without a commit count", () =>
      answerCompares(() => new Response(JSON.stringify({}), { status: 200 })), "could not be compared with the project's default branch on the remote"],
    ["the GitHub request cannot connect", () =>
      answerCompares(() => { throw new Error("ECONNREFUSED"); }), "could not be compared with the project's default branch on the remote"],
  ] as const)("fails closed when %s", async (_label, breakBase, expected) => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    breakBase();

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain(expected);
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it("refuses at the status write, not with a 500, when the remote cannot be reached after the declaration was accepted", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    mockEvaluateDoneTierDeclaration.mockImplementation(async (...args: Parameters<typeof evaluateDoneTierDeclaration>) => {
      const result = await realEvaluateDoneTierDeclarationRef.current!(...args);
      expect(result.allowed, result.reason).toBe(true);
      answerCompares(() => { throw new Error("ECONNREFUSED"); });
      return result;
    });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("could not be compared with the project's default branch on the remote");
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  async function storedProjectWorkspaceSource(projectWorkspaceId: string) {
    return db
      .select({
        repoUrl: projectWorkspaces.repoUrl,
        repoRef: projectWorkspaces.repoRef,
        defaultRef: projectWorkspaces.defaultRef,
      })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, projectWorkspaceId))
      .then((rows) => rows[0]!);
  }

  const SEEDED_SOURCE = { repoUrl: "https://github.com/TEA-Core/records", repoRef: "main", defaultRef: "main" };

  it.each([
    ["repoUrl", { repoUrl: "https://github.com/TEA-Core/elsewhere" }],
    ["repoRef", { repoRef: "agent-branch" }],
    ["defaultRef", { defaultRef: "agent-branch" }],
  ] as const)("refuses an agent PATCH of the project workspace %s and leaves the stored row unchanged", async (_field, patch) => {
    const fixture = await seed();

    const res = await request(app)
      .patch(`/api/projects/${fixture.projectId}/workspaces/${fixture.projectWorkspaceId}`)
      .send(patch);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await storedProjectWorkspaceSource(fixture.projectWorkspaceId)).toEqual(SEEDED_SOURCE);
  });

  it("refuses an agent adding a project workspace that names a repository or branch", async () => {
    const fixture = await seed();

    const res = await request(app)
      .post(`/api/projects/${fixture.projectId}/workspaces`)
      .send({ cwd: fixture.repoRoot, defaultRef: "agent-branch" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    const rows = await db.select({ id: projectWorkspaces.id }).from(projectWorkspaces).where(eq(projectWorkspaces.projectId, fixture.projectId));
    expect(rows).toHaveLength(1);
  });

  it("still lets an agent change a project workspace field that is not a repository source", async () => {
    const fixture = await seed();

    const res = await request(app)
      .patch(`/api/projects/${fixture.projectId}/workspaces/${fixture.projectWorkspaceId}`)
      .send({ name: "Renamed by agent" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await storedProjectWorkspaceSource(fixture.projectWorkspaceId)).toEqual(SEEDED_SOURCE);
  });

  it("lets a board user change the project workspace default branch", async () => {
    const fixture = await seed();
    currentActor = { type: "board", userId: "local-board", source: "local_implicit" } as Express.Request["actor"];

    const res = await request(app)
      .patch(`/api/projects/${fixture.projectId}/workspaces/${fixture.projectWorkspaceId}`)
      .send({ defaultRef: "release" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await storedProjectWorkspaceSource(fixture.projectWorkspaceId)).defaultRef).toBe("release");
  });

  it.each([
    ["repoUrl", { repoUrl: "https://github.com/TEA-Core/records" }],
    ["repoRef", { cwd: "/tmp/paperclip-agent-workspace", repoRef: "agent-branch" }],
    ["defaultRef", { cwd: "/tmp/paperclip-agent-workspace", defaultRef: "agent-branch" }],
  ] as const)("refuses an agent project create whose workspace sets %s and persists no project or workspace", async (field, workspace) => {
    const fixture = await seed();
    const name = `Agent-created ${field}`;

    const res = await request(app)
      .post(`/api/companies/${fixture.companyId}/projects`)
      .send({ name, workspace });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    const created = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, fixture.companyId), eq(projects.name, name)));
    expect(created).toHaveLength(0);
    const workspaces = await db.select({ id: projectWorkspaces.id }).from(projectWorkspaces).where(eq(projectWorkspaces.companyId, fixture.companyId));
    expect(workspaces).toHaveLength(1);
  });

  it("still lets an agent create a project from registered repository URLs, which leave the compare base empty", async () => {
    const fixture = await seed();

    const res = await request(app)
      .post(`/api/companies/${fixture.companyId}/projects`)
      .send({ name: "Agent project from URLs", repositoryUrls: ["https://github.com/TEA-Core/records"] });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [created] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, fixture.companyId), eq(projects.name, "Agent project from URLs")));
    const [row] = await db.select({ defaultRef: projectWorkspaces.defaultRef, repoRef: projectWorkspaces.repoRef }).from(projectWorkspaces).where(eq(projectWorkspaces.projectId, created!.id));
    expect(row).toEqual({ defaultRef: null, repoRef: null });
  });

  it("lets a board user create a project whose workspace sets repoUrl, repoRef and defaultRef", async () => {
    const fixture = await seed();
    currentActor = { type: "board", userId: "local-board", source: "local_implicit" } as Express.Request["actor"];

    const res = await request(app)
      .post(`/api/companies/${fixture.companyId}/projects`)
      .send({
        name: "Board project",
        workspace: { repoUrl: "https://github.com/TEA-Core/records", repoRef: "main", defaultRef: "release" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [created] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, fixture.companyId), eq(projects.name, "Board project")));
    const [row] = await db.select({ repoUrl: projectWorkspaces.repoUrl, repoRef: projectWorkspaces.repoRef, defaultRef: projectWorkspaces.defaultRef }).from(projectWorkspaces).where(eq(projectWorkspaces.projectId, created!.id));
    expect(row).toEqual({ repoUrl: "https://github.com/TEA-Core/records", repoRef: "main", defaultRef: "release" });
  });

  async function storedExecutionWorkspaceIdentity(executionWorkspaceId: string) {
    return db
      .select({
        cwd: executionWorkspaces.cwd,
        providerRef: executionWorkspaces.providerRef,
        branchName: executionWorkspaces.branchName,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0]!);
  }

  it.each([
    ["cwd", { cwd: "/tmp/agent-chosen" }],
    ["providerRef", { providerRef: "/tmp/agent-chosen" }],
    ["branchName", { branchName: "agent-chosen" }],
  ] as const)("refuses an agent PATCH of the execution workspace %s and leaves the stored row unchanged", async (_field, patch) => {
    const fixture = await seed();
    const before = await storedExecutionWorkspaceIdentity(fixture.executionWorkspaceId);

    const res = await request(app).patch(`/api/execution-workspaces/${fixture.executionWorkspaceId}`).send(patch);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Agent keys cannot set the worktree or branch an execution workspace is measured against");
    expect(await storedExecutionWorkspaceIdentity(fixture.executionWorkspaceId)).toEqual(before);
  });

  it("still lets an agent change an execution workspace field that is not its worktree identity", async () => {
    const fixture = await seed();

    const res = await request(app)
      .patch(`/api/execution-workspaces/${fixture.executionWorkspaceId}`)
      .send({ name: "Renamed by agent" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("lets a board user change the execution workspace worktree identity", async () => {
    const fixture = await seed();
    currentActor = { type: "board", userId: "local-board", source: "local_implicit" } as Express.Request["actor"];

    const res = await request(app)
      .patch(`/api/execution-workspaces/${fixture.executionWorkspaceId}`)
      .send({ branchName: "board-chosen", providerRef: fixture.worktree, cwd: fixture.worktree });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await storedExecutionWorkspaceIdentity(fixture.executionWorkspaceId)).toEqual({
      cwd: fixture.worktree,
      providerRef: fixture.worktree,
      branchName: "board-chosen",
    });
  });

  it("does not let another company's project-workspace refs block a board branch change (SUP-24409)", async () => {
    const fixture = await seed();
    currentActor = { type: "board", userId: "local-board", source: "local_implicit" } as Express.Request["actor"];
    const otherCompanyId = await insertCompany(`OTH${seedSequence}`);
    await db.insert(projectWorkspaces).values({
      id: randomUUID(),
      companyId: otherCompanyId,
      projectId: fixture.projectId,
      name: "Foreign",
      repoUrl: "https://github.com/TEA-Core/records",
      defaultRef: "board-chosen",
    });

    const res = await request(app)
      .patch(`/api/execution-workspaces/${fixture.executionWorkspaceId}`)
      .send({ branchName: "board-chosen" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("does not let the closing agent redirect the probe to a clean decoy worktree while its deliverable sits in the real one", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    writeFileSync(path.join(fixture.worktree, "deliverable.md"), "undelivered\n");
    git(fixture.worktree, "branch", "-m", "hidden");
    const decoy = path.join(fixture.repoRoot, ".paperclip", "worktrees", `${fixture.identifier}-decoy`);
    git(fixture.repoRoot, "worktree", "add", "-q", "-b", `${fixture.identifier}-decoy`, decoy, "origin/main");

    const redirect = await request(app)
      .patch(`/api/execution-workspaces/${fixture.executionWorkspaceId}`)
      .send({ providerRef: decoy, cwd: decoy });
    expect(redirect.status, JSON.stringify(redirect.body)).toBe(403);

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("uncommitted changes");
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it("does not let the closing agent move the compare base onto its own pushed branch", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    const branch = `${fixture.identifier}-entry-ruling`;
    commitOnIssueBranch(fixture);
    git(fixture.worktree, "push", "-q", "origin", branch);

    const moveBase = await request(app)
      .patch(`/api/projects/${fixture.projectId}/workspaces/${fixture.projectWorkspaceId}`)
      .send({ defaultRef: branch });
    expect(moveBase.status, JSON.stringify(moveBase.body)).toBe(403);

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("has 1 commit(s) not on the project's default branch");
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it.each([
    ["the worktree is dirtied", (fixture: SeededIssue) => {
      writeFileSync(path.join(fixture.worktree, "late.md"), "written after the probe\n");
    }, "has uncommitted changes"],
    ["a commit lands on the issue branch", (fixture: SeededIssue) => {
      writeFileSync(path.join(fixture.worktree, "late.md"), "committed after the probe\n");
      git(fixture.worktree, "add", "late.md");
      git(fixture.worktree, "commit", "-qm", "late");
    }, "could not be compared with the project's default branch on the remote"],
    ["the delivery requirement flips to repository_delivery", async (fixture: SeededIssue) => {
      await db.update(issues).set({ deliveryRequirement: "repository_delivery" }).where(eq(issues.id, fixture.issueId));
    }, "is accepted only on a record_only issue"],
    ["the closer edits the ruling", async (fixture: SeededIssue) => {
      await reviseRuling(fixture, fixture.closerAgentId);
    }, "written by someone other than the closing actor"],
  ] as const)("measures again before the status write: refuses when %s after the declaration was accepted", async (_label, mutate, expected) => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    mockEvaluateDoneTierDeclaration.mockImplementation(async (...args: Parameters<typeof evaluateDoneTierDeclaration>) => {
      const result = await realEvaluateDoneTierDeclarationRef.current!(...args);
      expect(result.allowed, result.reason).toBe(true);
      await mutate(fixture);
      return result;
    });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain(expected);
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  async function reviseRuling(fixture: SeededIssue, authorAgentId: string) {
    const [link] = await db
      .select({ documentId: issueDocuments.documentId })
      .from(issueDocuments)
      .where(and(eq(issueDocuments.issueId, fixture.issueId), eq(issueDocuments.key, "entry-ruling")));
    await db.insert(documentRevisions).values({
      companyId: fixture.companyId,
      documentId: link!.documentId,
      revisionNumber: 2,
      body: "Ruling revised: the deliverable remains this recorded decision, with no repository change.",
      createdByAgentId: authorAgentId,
    });
  }

  async function insertSecondProjectWorkspace(fixture: SeededIssue) {
    const id = randomUUID();
    await db.insert(projectWorkspaces).values({
      id,
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      name: "Secondary",
      cwd: fixture.repoRoot,
      repoUrl: "https://github.com/TEA-Core/records",
      repoRef: "main",
      defaultRef: "main",
      isPrimary: false,
    });
    return id;
  }

  // The measurement runs before the write transaction; anything that moves
  // between it and the write must refuse at the compare-and-set.
  it.each([
    ["a commit lands on the issue branch", (fixture: SeededIssue) => {
      writeFileSync(path.join(fixture.worktree, "late.md"), "committed after the measurement\n");
      git(fixture.worktree, "add", "late.md");
      git(fixture.worktree, "commit", "-qm", "late");
    }, "the recorded worktree's HEAD moved after the close was measured"],
    ["the delivery requirement flips to repository_delivery", async (fixture: SeededIssue) => {
      await db.update(issues).set({ deliveryRequirement: "repository_delivery" }).where(eq(issues.id, fixture.issueId));
    }, "already stored as record_only at the close write"],
    ["another agent revises the ruling", async (fixture: SeededIssue) => {
      await reviseRuling(fixture, fixture.rulerAgentId);
    }, 'the "entry-ruling" document changed after the close was measured'],
    ["the issue moves to another project workspace", async (fixture: SeededIssue) => {
      const other = await insertSecondProjectWorkspace(fixture);
      await db.update(issues).set({ projectWorkspaceId: other }).where(eq(issues.id, fixture.issueId));
    }, "the issue's workspace binding changed after the close was measured"],
    ["the execution workspace's recorded path is rewritten", async (fixture: SeededIssue) => {
      await db
        .update(executionWorkspaces)
        .set({ providerRef: `${fixture.worktree}/` })
        .where(eq(executionWorkspaces.id, fixture.executionWorkspaceId));
    }, "the recorded worktree path changed after the close was measured"],
  ] as const)("compares the measurement inside the status write: refuses when %s after the measurement", async (_label, mutate, expected) => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    mockMeasureNoRepositoryLanding.mockImplementation(async (...args: Parameters<typeof measureNoRepositoryLandingForClose>) => {
      const verdict = await realMeasureNoRepositoryLandingRef.current!(...args);
      expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
      await mutate(fixture);
      return verdict;
    });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain(expected);
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
    // SUP-24298: the refusal at the compare-and-set leaves its own row.
    const [refusal] = await refusalRows(fixture.issueId);
    expect(refusal?.details).toMatchObject({
      code: "done_transition_missing_tier_declaration",
      stage: "no_repository_landing_transition_recheck",
      httpStatus: 422,
      runId: fixture.actor.runId,
    });
    expect(await activityCount(fixture.issueId, "issue.done_transition_guard_skipped")).toBe(0);
  });

  // A terminal status is the one mismatch that leaves the row changed by someone
  // else, so the issue keeps the status the other request gave it.
  it.each(["done", "cancelled"] as const)("refuses at the compare-and-set when another request already moved the issue to %s", async (terminal) => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    mockMeasureNoRepositoryLanding.mockImplementation(async (...args: Parameters<typeof measureNoRepositoryLandingForClose>) => {
      const verdict = await realMeasureNoRepositoryLandingRef.current!(...args);
      expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
      await db.update(issues).set({ status: terminal }).where(eq(issues.id, fixture.issueId));
      return verdict;
    });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("the issue's status changed after the close was measured");
    expect(await statusOf(fixture.issueId)).toBe(terminal);
    expect(await activityCount(fixture.issueId, "issue.done_transition_no_repository_landing_verified")).toBe(0);
  });

  // The recorded worktree's status is the last step of the measurement, so
  // content written while the GitHub compare runs is still caught.
  it("refuses when the worktree is dirtied during the pre-write measurement's GitHub compare", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    let measuring = false;
    let dirtied = false;
    mockMeasureNoRepositoryLanding.mockImplementation(async (...args: Parameters<typeof measureNoRepositoryLandingForClose>) => {
      measuring = true;
      try {
        return await realMeasureNoRepositoryLandingRef.current!(...args);
      } finally {
        measuring = false;
      }
    });
    mockGhFetch.mockImplementation(async (url: string) => {
      const response = compareAgainstOrigin(url);
      if (measuring && !dirtied) {
        dirtied = true;
        writeFileSync(path.join(fixture.worktree, "late.md"), "written during the measurement\n");
      }
      return response;
    });

    const res = await close(fixture.identifier);

    expect(dirtied).toBe(true);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("has uncommitted changes");
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  // A refusal at the status write's stage leaves one remedy comment. Running
  // out of the re-check's budget says nothing about the worktree, so its remedy
  // is to retry; every other refusal gets the neutral remedy, which names no
  // worktree cleaning.
  const NEUTRAL_REMEDY = "Fix what the refusal names, or retry if it says the worktree or the remote could not be verified";
  const TIMEOUT_REMEDY = "Retry the close, or use the board close path";
  it.each([
    ["the re-check runs out of its budget", "timed out at the close write", TIMEOUT_REMEDY, (_fixture: SeededIssue) => {
      mockRecheckRecordedWorktree.mockImplementation((input: Parameters<typeof recheckRecordedWorktree>[0]) =>
        realRecheckRecordedWorktreeRef.current!({ ...input, budgetMs: 1 }));
    }],
    ["the worktree is dirtied after the measurement", "has uncommitted changes", NEUTRAL_REMEDY, (fixture: SeededIssue) => {
      mockMeasureNoRepositoryLanding.mockImplementation(async (...args: Parameters<typeof measureNoRepositoryLandingForClose>) => {
        const verdict = await realMeasureNoRepositoryLandingRef.current!(...args);
        writeFileSync(path.join(fixture.worktree, "late.md"), "written after the measurement\n");
        return verdict;
      });
    }],
    ["an unattributed branch appears after the declaration", `branch other-999-work ${BELONGS_TO_NO_CARD}`, NEUTRAL_REMEDY, (fixture: SeededIssue) => {
      mockEvaluateDoneTierDeclaration.mockImplementation(async (...args: Parameters<typeof evaluateDoneTierDeclaration>) => {
        const result = await realEvaluateDoneTierDeclarationRef.current!(...args);
        git(fixture.repoRoot, "branch", "other-999-work", "origin/main");
        return result;
      });
    }],
    ["the repository's default branch cannot be read after the declaration", "the repository's default branch could not be read from GitHub", NEUTRAL_REMEDY, (_fixture: SeededIssue) => {
      mockEvaluateDoneTierDeclaration.mockImplementation(async (...args: Parameters<typeof evaluateDoneTierDeclaration>) => {
        const result = await realEvaluateDoneTierDeclarationRef.current!(...args);
        repositoryAnswer = { status: 500, defaultBranch: "main" };
        return result;
      });
    }],
  ] as const)("posts the matching remedy comment when %s", async (label, reasonText, remedyText, arrange) => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    arrange(fixture);

    const res = await close(fixture.identifier);

    expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(422);
    expect(res.body.error).toContain(reasonText);
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
    const refusals = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, fixture.issueId))
      .then((rows) => rows.map((row) => row.body).filter((body) => body.includes("Remedy: ")));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain(remedyText);
    expect(refusals[0]).not.toContain("Bring the issue's own worktree");
    if (remedyText === NEUTRAL_REMEDY) {
      expect(refusals[0]).toContain("the board close path stays available");
      expect(refusals[0]).not.toContain(TIMEOUT_REMEDY);
      expect(refusals[0]).not.toMatch(/clean/i);
    } else {
      expect(refusals[0]).not.toContain(NEUTRAL_REMEDY);
    }
  });

  async function issueRowIsUnlocked(issueId: string): Promise<boolean> {
    return db
      .transaction(async (tx) => {
        await tx.execute(sql`select id from issues where id = ${issueId} for update nowait`);
        return true;
      })
      .catch(() => false);
  }

  it("never holds the issue row while the probe runs: every GitHub compare finds the row unlocked", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    const rowUnlockedDuringCompare: boolean[] = [];
    mockGhFetch.mockImplementation(async (url: string) => {
      rowUnlockedDuringCompare.push(await issueRowIsUnlocked(fixture.issueId));
      return compareAgainstOrigin(url);
    });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The declaration check and the pre-write measurement each compare the tip.
    expect(rowUnlockedDuringCompare.length).toBeGreaterThanOrEqual(2);
    expect(rowUnlockedDuringCompare.every(Boolean), JSON.stringify(rowUnlockedDuringCompare)).toBe(true);
  });

  it.each(["stable clock", "forward clock adjustment"] as const)("completes twelve concurrent no-repository closes, more than the database pool holds (%s)", async (clockMode) => {
    const fixtures: SeededIssue[] = [];
    for (let index = 0; index < 12; index += 1) {
      const fixture = await seed();
      await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
      fixtures.push(fixture);
    }
    // Every fixture's tip is its origin's main: level with the base.
    const levelTips = new Set(fixtures.map((fixture) => git(fixture.worktree, "rev-parse", "HEAD")));
    answerCompares((url) => {
      const sha = /\.\.\.([0-9a-f]{40})$/.exec(url)?.[1];
      return sha && levelTips.has(sha)
        ? new Response(JSON.stringify({ ahead_by: 0 }), { status: 200 })
        : new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    });

    const realNow = Date.now;
    let offset = 0;
    const clock = clockMode === "forward clock adjustment"
      ? vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset) : null;
    if (clock) {
      mockRecheckRecordedWorktree.mockImplementation((input: Parameters<typeof recheckRecordedWorktree>[0]) => {
        const check = realRecheckRecordedWorktreeRef.current!(input);
        // Advance wall time after the budget starts, while filesystem work awaits.
        offset += 60_000;
        return check;
      });
    }
    try {
      const responses = await Promise.all(
        fixtures.map((fixture) =>
          request(app)
            .patch(`/api/issues/${fixture.identifier}`)
            .set("x-test-actor", JSON.stringify(fixture.actor))
            .send({ status: "done", doneTier: NO_REPOSITORY_DONE_TIER }),
        ),
      );
      expect(responses.map((res) => res.status), JSON.stringify(responses.map((res) => res.body))).toEqual(fixtures.map(() => 200));
      for (const fixture of fixtures) expect(await statusOf(fixture.issueId)).toBe("done");
    } finally {
      clock?.mockRestore();
    }
  }, 120_000);

  it("lets exactly one of twelve concurrent closes of one issue through; the rest refuse at the compare-and-set", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    // Hold every request at its first GitHub compare until all twelve have read
    // the issue as in_progress, so none can start after the first close commits.
    const racers = 12;
    let arrived = 0;
    let release!: () => void;
    const allArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockGhFetch.mockImplementation(async (url: string) => {
      if (arrived < racers) {
        arrived += 1;
        if (arrived === racers) release();
        await allArrived;
      }
      return compareAgainstOrigin(url);
    });

    const responses = await Promise.all(
      Array.from({ length: racers }, () =>
        request(app)
          .patch(`/api/issues/${fixture.identifier}`)
          .set("x-test-actor", JSON.stringify(fixture.actor))
          .send({ status: "done", doneTier: NO_REPOSITORY_DONE_TIER }),
      ),
    );

    const statuses = responses.map((res) => res.status).sort((a, b) => a - b);
    expect(statuses, JSON.stringify(responses.map((res) => res.body))).toEqual([200, ...Array(racers - 1).fill(422)]);
    for (const res of responses.filter((candidate) => candidate.status === 422)) {
      expect(res.body.error).toContain("the issue's status changed after the close was measured");
    }
    expect(await statusOf(fixture.issueId)).toBe("done");
    expect(await activityCount(fixture.issueId, "issue.done_transition_no_repository_landing_verified")).toBe(1);
    expect(await activityCount(fixture.issueId, "issue.updated")).toBe(1);
  }, 120_000);

  it("answers a sequential re-close of an issue already closed with the form as before: 200, no second verification", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    const first = await close(fixture.identifier);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const verified = await activityCount(fixture.issueId, "issue.done_transition_no_repository_landing_verified");
    expect(verified).toBe(1);

    const again = await close(fixture.identifier);

    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(await statusOf(fixture.issueId)).toBe("done");
    expect(await activityCount(fixture.issueId, "issue.done_transition_no_repository_landing_verified")).toBe(verified);
  });

  it("records the ruling and the probe result in the close audit, in the same transaction as the close", async () => {
    const fixture = await seed();
    const rulingId = await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [row] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.entityId, fixture.issueId),
        eq(activityLog.action, "issue.done_transition_no_repository_landing_verified"),
      ));
    expect(row?.details).toMatchObject({
      rulingDocumentId: rulingId,
      rulingRevisionNumber: 1,
      executionWorkspaceId: fixture.executionWorkspaceId,
      baseBranch: "main",
      probe: {
        result: "clean_and_level_with_base",
        branch: fixture.branch,
        headSha: git(fixture.worktree, "rev-parse", "HEAD"),
      },
    });
  });

  it("refuses a close request that also moves the issue to another project workspace", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    const other = await insertSecondProjectWorkspace(fixture);

    const res = await request(app)
      .patch(`/api/issues/${fixture.identifier}`)
      .send({ status: "done", doneTier: NO_REPOSITORY_DONE_TIER, projectWorkspaceId: other });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("cannot ride a request that changes the issue's project workspace");
    const [stored] = await db
      .select({ status: issues.status, projectWorkspaceId: issues.projectWorkspaceId })
      .from(issues)
      .where(eq(issues.id, fixture.issueId));
    expect(stored).toEqual({ status: "in_progress", projectWorkspaceId: fixture.projectWorkspaceId });
  });

  it.each([
    ["another card's branch", () => "Delivered on OTHER-999-branch", () => "OTHER-999"],
    ["another card in lower case", () => "delivered on other-999-work", () => "OTHER-999"],
    ["a card whose number extends this one's", (fixture: SeededIssue) => `Recorded alongside ${fixture.identifier}0`, (fixture: SeededIssue) => `${fixture.identifier}0`],
    ["a card whose prefix extends this one's", (fixture: SeededIssue) => `Recorded alongside X${fixture.identifier}`, (fixture: SeededIssue) => `X${fixture.identifier}`],
  ] as const)("refuses a declaration that names %s", async (_label, reason, other) => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });

    const res = await close(fixture.identifier, { ...NO_REPOSITORY_DONE_TIER, reason: reason(fixture) });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain(`the declaration names another card (${other(fixture)})`);
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it.each([
    ["this card itself", (fixture: SeededIssue) => `The deliverable of ${fixture.identifier} is the recorded entry ruling`],
    ["a standard name written like an identifier", () => "The ruling is recorded with ISO-8601 timestamps"],
  ] as const)("accepts a declaration that names %s", async (_label, reason) => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });

    const res = await close(fixture.identifier, { ...NO_REPOSITORY_DONE_TIER, reason: reason(fixture) });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it.each([
    ["a phase number", "decide-phase-2-scope"],
    ["a sprint number", "sprint-12-retro"],
    ["a quarter and year", "q3-2026-planning"],
    ["a runtime version", "upgrade-node-20"],
  ] as const)("closes a worktree on its default-template branch whose title slug carries %s", async (_label, slug) => {
    const fixture = await seed({ branchSlug: slug });
    expect(fixture.branch).toBe(`${fixture.identifier}-${slug}`);
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(fixture.issueId)).toBe("done");
  });

  async function seedStrandedRecovery() {
    const fixture = await seed({
      branchSlug: (identifier) => `recover-exhausted-recovery-for-${identifier.replace(/-1$/, "-2")}`,
    });
    const sourceIssueId = randomUUID();
    const sourceIdentifier = fixture.identifier.replace(/-1$/, "-2");
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      identifier: sourceIdentifier,
      title: "Source card",
      status: "done",
      priority: "medium",
      createdByUserId: "cloud-user-1",
    });
    await db.update(issues).set({
      originKind: "stranded_issue_recovery",
      originId: sourceIssueId,
      title: `Recover exhausted recovery for ${sourceIdentifier}`,
    }).where(eq(issues.id, fixture.issueId));
    expect(fixture.branch).toBe(`${fixture.identifier}-recover-exhausted-recovery-for-${sourceIdentifier}`);
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    return { fixture, sourceIssueId, sourceIdentifier };
  }

  it("closes a stranded recovery card whose platform-minted title slug names its source card", async () => {
    const { fixture } = await seedStrandedRecovery();

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(fixture.issueId)).toBe("done");
  });

  it("refuses when a stranded recovery source identifier changes after measurement", async () => {
    const { fixture, sourceIssueId, sourceIdentifier } = await seedStrandedRecovery();
    mockMeasureNoRepositoryLanding.mockImplementation(async (...args: Parameters<typeof measureNoRepositoryLandingForClose>) => {
      const verdict = await realMeasureNoRepositoryLandingRef.current!(...args);
      expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
      await db.update(issues).set({ identifier: `${sourceIdentifier}0` }).where(eq(issues.id, sourceIssueId));
      return verdict;
    });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("the recovery source identifier changed after the close was measured");
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it("still refuses a declaration that carries a word-number token, whatever its case", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });

    const res = await close(fixture.identifier, { ...NO_REPOSITORY_DONE_TIER, reason: "Decided in phase-2 of the rollout" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("the declaration names another card (PHASE-2)");
  });

  /** Commits ignore rules on the issue branch and makes them the remote default branch. */
  function commitIgnoreRules(fixture: SeededIssue, rules: string) {
    writeFileSync(path.join(fixture.worktree, ".gitignore"), rules);
    git(fixture.worktree, "add", ".gitignore");
    git(fixture.worktree, "commit", "-qm", "ignore rules");
    git(fixture.worktree, "push", "-q", "origin", "HEAD:main");
  }

  // The status write re-checks the measured worktree with a bounded Git
  // status, so dirt written between the measurement and the write refuses.
  it.each([
    ["an untracked file", "late.md", "has uncommitted changes"],
    ["an ignored file", "late.log", 'has an ignored entry outside the regenerated-artefact directories ("late.log")'],
  ] as const)("re-checks the worktree inside the status write: refuses %s written after the measurement", async (_label, file, expected) => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    commitIgnoreRules(fixture, "*.log\n");
    mockMeasureNoRepositoryLanding.mockImplementation(async (...args: Parameters<typeof measureNoRepositoryLandingForClose>) => {
      const verdict = await realMeasureNoRepositoryLandingRef.current!(...args);
      expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
      writeFileSync(path.join(fixture.worktree, file), "written after the measurement\n");
      return verdict;
    });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain(`refused at the close write: the recorded worktree ${expected}`);
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it("refuses work hidden in an allowlisted directory that only its own untracked .gitignore ignores", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    mkdirSync(path.join(fixture.worktree, ".paperclip"));
    writeFileSync(path.join(fixture.worktree, ".paperclip", ".gitignore"), "*\n");
    writeFileSync(path.join(fixture.worktree, ".paperclip", "deliverable.md"), "undelivered\n");
    expect(git(fixture.worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain('has a regenerated-artefact directory that no committed ignore rule ignores (".paperclip/")');
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  /** A branch in the managed checkout: ahead (its own pushed commit) or at this card's tip. */
  function branchInCheckout(fixture: SeededIssue, name: string, ahead: boolean) {
    if (!ahead) {
      git(fixture.repoRoot, "branch", name, fixture.branch);
      return;
    }
    const worktree = path.join(fixture.repoRoot, ".paperclip", "worktrees", name);
    git(fixture.repoRoot, "worktree", "add", "-q", "-b", name, worktree, "origin/main");
    writeFileSync(path.join(worktree, "work.md"), "work\n");
    git(worktree, "add", "work.md");
    git(worktree, "commit", "-qm", "work");
    git(worktree, "push", "-q", "origin", name);
  }

  /** Another card of the same project whose execution workspace registers `branchName`. */
  async function insertSiblingCard(fixture: SeededIssue) {
    const siblingIssueId = randomUUID();
    const identifier = `${fixture.identifier.replace(/-\d+$/, "")}-2`;
    await db.insert(issues).values({
      id: siblingIssueId,
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      identifier,
      title: "A sibling card",
      status: "in_progress",
      priority: "medium",
      createdByUserId: "cloud-user-1",
    });
    return { siblingIssueId, identifier };
  }

  async function registerSiblingCard(fixture: SeededIssue, branchName: string) {
    const { siblingIssueId } = await insertSiblingCard(fixture);
    const worktree = path.join(fixture.repoRoot, ".paperclip", "worktrees", branchName);
    await db.insert(executionWorkspaces).values({
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      projectWorkspaceId: fixture.projectWorkspaceId,
      sourceIssueId: siblingIssueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: branchName,
      status: "active",
      cwd: worktree,
      baseRef: "main",
      branchName,
      providerType: "git_worktree",
      providerRef: worktree,
    });
  }

  it.each([
    ["an ahead OTHER-999-work", () => "OTHER-999-work", true],
    ["an ahead lower-case other-999-work", () => "other-999-work", true],
    ["an ahead branch of another card of this company", (fixture: SeededIssue) => `${fixture.identifier}0-work`, true],
    ["a foreign branch at this card's own tip", () => "OTHER-999-same", false],
  ] as const)("refuses %s that no card's workspace registers", async (_label, name, ahead) => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    branchInCheckout(fixture, name(fixture), ahead);

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain(`branch ${name(fixture)} ${BELONGS_TO_NO_CARD}`);
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it.each([
    ["a sibling card's ahead branch registered to its workspace", async (fixture: SeededIssue) => {
      const branch = `${fixture.identifier.replace(/-\d+$/, "")}-2-sibling`;
      await registerSiblingCard(fixture, branch);
      branchInCheckout(fixture, branch, true);
    }],
    ["another branch of this card at its tip", async (fixture: SeededIssue) => {
      branchInCheckout(fixture, `${fixture.branch}-extra`, false);
    }],
  ] as const)("closes with %s and the default branch in the checkout", async (_label, arrange) => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    await arrange(fixture);
    expect(git(fixture.repoRoot, "branch", "--list", "main")).not.toBe("");

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(fixture.issueId)).toBe("done");
  });

  // The managed checkout's own branches are the project's: the clone's local
  // branch is the remote's HEAD branch, and the heartbeat checks out repoRef.
  it.each([
    [
      "repoRef main with defaultRef release: the local main is the project's reference branch",
      { repoRef: "main", defaultRef: "release" },
      "release",
      // GitHub names a different default branch, so only repoRef exempts main.
      "trunk",
    ],
    [
      "a fold-style defaultRef and repoRef: the local main is the repository's default branch on GitHub",
      { repoRef: "fold/patches", defaultRef: "fold/patches" },
      "fold/patches",
      "main",
    ],
  ] as const)("closes with %s", async (_label, refs, baseBranch, githubDefaultBranch) => {
    const fixture = await seed({ projectWorkspace: refs });
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    git(fixture.repoRoot, "push", "-q", currentOrigin, `refs/remotes/origin/main:refs/heads/${baseBranch}`);
    repositoryAnswer = { status: 200, defaultBranch: githubDefaultBranch };
    expect(git(fixture.repoRoot, "branch", "--list", "main")).not.toBe("");
    expect(git(fixture.repoRoot, "branch", "--list", baseBranch)).toBe("");

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(fixture.issueId)).toBe("done");
  });

  it("still refuses an unattributed branch when the project's reference branches are exempt", async () => {
    const fixture = await seed({ projectWorkspace: { repoRef: "main", defaultRef: "release" } });
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    git(fixture.repoRoot, "push", "-q", currentOrigin, "refs/remotes/origin/main:refs/heads/release");
    branchInCheckout(fixture, "other-999-work", true);

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain(`branch other-999-work ${BELONGS_TO_NO_CARD}`);
  });

  it.each([
    ["answers with an error", { status: 500, defaultBranch: "main" }],
    ["names no default branch", { status: 200, defaultBranch: "" }],
  ] as const)("refuses, naming the repository read, when GitHub %s for the repository itself", async (_label, answer) => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    repositoryAnswer = answer;

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("the repository's default branch could not be read from GitHub");
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it("refuses at the compare-and-set when the project's reference branch changes after the measurement", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    mockMeasureNoRepositoryLanding.mockImplementation(async (...args: Parameters<typeof measureNoRepositoryLandingForClose>) => {
      const verdict = await realMeasureNoRepositoryLandingRef.current!(...args);
      expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
      await db.update(projectWorkspaces).set({ repoRef: "release" }).where(eq(projectWorkspaces.id, fixture.projectWorkspaceId));
      return verdict;
    });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("the project's repository or default branch changed after the close was measured");
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  // The server keeps the rescue branch of a dirty-quarantined card in the
  // shared checkout: `paperclip/rescue/<ISSUE-ID>/<timestamp>`.
  it("closes with another existing card's ahead rescue branch in the checkout", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    const sibling = await insertSiblingCard(fixture);
    branchInCheckout(fixture, `paperclip/rescue/${sibling.identifier}/20261106T000000Z`, true);

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(fixture.issueId)).toBe("done");
  });

  it("refuses this card's own ahead rescue branch, which holds undelivered work", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    const rescue = `paperclip/rescue/${fixture.identifier}/20261106T000000Z`;
    branchInCheckout(fixture, rescue, true);

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain(`branch ${rescue} has 1 commit(s) not on the project's default branch`);
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it.each([
    ["names no issue", () => "paperclip/rescue/NOPE-1/20261106T000000Z"],
    ["names an issue of another company", (_fixture: SeededIssue, foreign: string) => `paperclip/rescue/${foreign}/20261106T000000Z`],
  ] as const)("refuses a rescue-shaped branch that %s", async (_label, name) => {
    const foreignCompany = await seed();
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    const branch = name(fixture, foreignCompany.identifier);
    branchInCheckout(fixture, branch, true);

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain(`branch ${branch} ${BELONGS_TO_NO_CARD}`);
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it.each([["ruling"], ["notes"]])("refuses a ruling filed under the %s key instead of entry-ruling", async (key) => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId, key });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain('requires a non-empty "entry-ruling" document on this issue');
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it.each([
    ["TODO placeholder", 'opens with the placeholder "todo"'],
    ["TBD", 'opens with the placeholder "tbd"'],
    ["n/a", "fewer than 3 words that are not placeholders"],
    ["Approved.", "fewer than 3 words that are not placeholders"],
  ])("refuses a placeholder ruling %j", async (body, expected) => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId, body });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain(expected);
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it("refuses an issue that mentions a GitHub pull request, with no pull request work product recorded", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    const [object] = await db
      .insert(externalObjects)
      .values({
        companyId: fixture.companyId,
        providerKey: "github",
        objectType: "pull_request",
        externalId: "TEA-Core/other#pull/77",
        data: { state: "open" },
      })
      .returning({ id: externalObjects.id });
    await db.insert(externalObjectMentions).values({
      companyId: fixture.companyId,
      sourceIssueId: fixture.issueId,
      sourceKind: "comment",
      objectId: object!.id,
      providerKey: "github",
      objectType: "pull_request",
    });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("cannot be declared on an issue that links pull requests (TEA-Core/other#77)");
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it("is refused through a backstop sweep, which has no closing actor and no transactional re-probe", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    const issue = await db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]!);

    const verdict = await evaluateDoneTransitionGuardForBackstopClose({
      db,
      issue,
      actorId: "system-sweep",
      closeComment: null,
      structuredDoneTier: NO_REPOSITORY_DONE_TIER,
    });

    expect(verdict).toMatchObject({ allowed: false, code: "done_transition_missing_tier_declaration" });
  });

  function zeroDeltaDoneTier(worktree: string) {
    const head = git(worktree, "rev-parse", "HEAD");
    return {
      tier: "tier2",
      probeEvidence: `probe \`git rev-list --count origin/main..HEAD\` head ${head} post-merge: origin/main..HEAD is 0 and the worktree is clean`,
    } as const;
  }

  function answerZeroDeltaGitHub(pulls: Array<{
    number: number;
    state: "open" | "closed";
    merged_at: string | null;
    title: string;
    html_url: string;
    head: { ref: string; sha: string; repo: { full_name: string } };
  }> = []) {
    mockGhFetch.mockImplementation(async (url: string) => {
      const text = String(url);
      if (/\/git\/matching-refs\/$/.test(text)) {
        const listed = git(currentOrigin, "for-each-ref", "--format=%(refname) %(objecttype) %(objectname)");
        return Response.json(listed.length === 0 ? [] : listed.split("\n").map((line) => {
          const [ref, type, sha] = line.split(" ");
          return { ref, object: { type, sha } };
        }));
      }
      if (/\/branches(?:\?|$)/.test(text)) {
        const listed = git(currentOrigin, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads");
        const body = listed.length === 0 ? [] : listed.split("\n").map((line) => {
          const space = line.indexOf(" ");
          return { name: line.slice(0, space), commit: { sha: line.slice(space + 1) } };
        });
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (/\/tags(?:\?|$)/.test(text)) return new Response(JSON.stringify([]), { status: 200 });
      if (/\/pulls(?:\?|$)/.test(text)) {
        const u = new URL(text);
        const state = u.searchParams.get("state") ?? "open";
        const head = u.searchParams.get("head");
        const listed = pulls.filter((pr) =>
          (state === "all" || pr.state === state) &&
          (!head || head === `${pr.head.repo.full_name.split("/")[0]}:${pr.head.ref}`));
        const page = Number(u.searchParams.get("page") ?? "1");
        const size = Number(u.searchParams.get("per_page") ?? "30");
        const headers = new Headers();
        if (page * size < listed.length) {
          u.searchParams.set("page", String(page + 1));
          headers.set("link", `<${u}>; rel="next"`);
        }
        return Response.json(listed.slice((page - 1) * size, page * size), { headers });
      }
      const commit = /\/commits\/([^/?]+)$/.exec(text);
      if (commit) {
        try {
          return new Response(JSON.stringify({ sha: git(currentOrigin, "rev-parse", "--verify", "--quiet", `${decodeURIComponent(commit[1]!)}^{commit}`) }), { status: 200 });
        } catch {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
      }
      const ref = /\/git\/ref\/heads\/(.+)$/.exec(text);
      if (ref) {
        try {
          git(currentOrigin, "rev-parse", "--verify", "--quiet", `refs/heads/${decodeURIComponent(ref[1]!)}`);
          return new Response(JSON.stringify({ ref: `refs/heads/${decodeURIComponent(ref[1]!)}` }), { status: 200 });
        } catch {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
      }
      return compareAgainstOrigin(text);
    });
  }

  it("closes a repository_delivery card with a server-proven zero-delta Tier 2 declaration", async () => {
    const fixture = await seed({ deliveryRequirement: "repository_delivery" });
    answerZeroDeltaGitHub();

    const res = await request(app)
      .patch(`/api/issues/${fixture.identifier}`)
      .send({ status: "done", doneTier: zeroDeltaDoneTier(fixture.worktree) });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(fixture.issueId)).toBe("done");
    expect(await activityCount(fixture.issueId, "issue.done_transition_tier2_close")).toBe(1);
  });

  it.each(["TEA-Core/records", "fork/records"])("refuses a zero-delta close with closed-unmerged card work held only by a pull ref (%s)", async (fullName) => {
    const fixture = await seed({ deliveryRequirement: "repository_delivery" });
    const baseSha = git(fixture.worktree, "rev-parse", "HEAD");
    const sha = git(currentOrigin, "commit-tree", `${baseSha}^{tree}`, "-p", baseSha, "-m", "unmerged card work");
    git(currentOrigin, "update-ref", "refs/pull/17/head", sha);
    answerZeroDeltaGitHub([{
      number: 17, state: "closed", merged_at: null, title: "Closed proposal",
      html_url: "https://github.com/TEA-Core/records/pull/17",
      head: { ref: `${fixture.identifier}-cycle`, sha, repo: { full_name: fullName } },
    }]);
    const res = await close(fixture.identifier, zeroDeltaDoneTier(fixture.worktree));
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
    expect(await activityCount(fixture.issueId, "issue.done_transition_tier2_close")).toBe(0);
  });

  it("lets the board cancel knowingly abandoned closed-PR work without claiming delivery", async () => {
    const fixture = await seed({ deliveryRequirement: "repository_delivery" });
    const baseSha = git(fixture.worktree, "rev-parse", "HEAD");
    const sha = git(currentOrigin, "commit-tree", `${baseSha}^{tree}`, "-p", baseSha, "-m", "abandoned proposal");
    git(currentOrigin, "update-ref", "refs/pull/17/head", sha);
    answerZeroDeltaGitHub([{
      number: 17, state: "closed", merged_at: null, title: "Abandoned proposal",
      html_url: "https://github.com/TEA-Core/records/pull/17",
      head: { ref: `${fixture.identifier}-cycle`, sha, repo: { full_name: "TEA-Core/records" } },
    }]);
    currentActor = { type: "board", userId: "local-board", source: "local_implicit" } as Express.Request["actor"];
    const res = await request(app).patch(`/api/issues/${fixture.identifier}`).send({
      status: "cancelled", comment: "The board abandons this proposal; no delivery is claimed.",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(fixture.issueId)).toBe("cancelled");
    expect(await activityCount(fixture.issueId, "issue.done_transition_tier2_close")).toBe(0);
    expect(git(currentOrigin, "rev-parse", "refs/pull/17/head")).toBe(sha);
  });

  it("refuses a card-named open PR beyond the legacy open-PR probe page", async () => {
    const fixture = await seed({ deliveryRequirement: "repository_delivery" });
    const baseSha = git(fixture.worktree, "rev-parse", "HEAD");
    const sha = git(currentOrigin, "commit-tree", `${baseSha}^{tree}`, "-p", baseSha, "-m", "open card work");
    git(currentOrigin, "update-ref", "refs/pull/200/head", sha);
    const unrelated = Array.from({ length: 120 }, (_, i) => ({
      number: i + 1, state: "open" as const, merged_at: null, title: "Other work",
      html_url: `https://github.com/TEA-Core/records/pull/${i + 1}`,
      head: { ref: `other-work-${i}`, sha: baseSha, repo: { full_name: "TEA-Core/records" } },
    }));
    answerZeroDeltaGitHub([...unrelated, {
      number: 200, state: "open", merged_at: null, title: "Proposal",
      html_url: "https://github.com/TEA-Core/records/pull/200",
      head: { ref: `${fixture.identifier}-cycle`, sha, repo: { full_name: "TEA-Core/records" } },
    }]);
    const res = await close(fixture.identifier, zeroDeltaDoneTier(fixture.worktree));
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("not on the base line");
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it("closes a record_only card while another registered card keeps its stash", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    const branch = `${fixture.identifier.replace(/-\d+$/, "")}-2-sibling`;
    await registerSiblingCard(fixture, branch);
    const other = path.join(fixture.repoRoot, ".paperclip", "worktrees", branch);
    git(fixture.repoRoot, "worktree", "add", "-q", "-b", branch, other, "origin/main");
    writeFileSync(path.join(other, "README.md"), "other card's work\n");
    git(other, "stash", "push", "-qm", "other card draft");
    const stash = git(other, "rev-parse", "refs/stash");
    const res = await close(fixture.identifier);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(fixture.issueId)).toBe("done");
    expect(git(other, "rev-parse", "refs/stash")).toBe(stash);
  });

  // The record_only provenance rule end to end: a stash refuses this card's
  // close only when the stash commit itself records this card's branch. The
  // `git stash store -m` label is never read. Row ids follow the frozen matrix.
  describe("record_only stash provenance through the PATCH route", () => {
    async function siblingWorktree(fixture: SeededIssue, branch: string) {
      await registerSiblingCard(fixture, branch);
      const other = path.join(fixture.repoRoot, ".paperclip", "worktrees", branch);
      git(fixture.repoRoot, "worktree", "add", "-q", "-b", branch, other, "origin/main");
      return other;
    }

    function stashCreate(dir: string, contents: string) {
      writeFileSync(path.join(dir, "README.md"), contents);
      const commit = git(dir, "stash", "create");
      git(dir, "checkout", "-q", "--", "README.md");
      return commit;
    }

    const siblingBranch = (fixture: SeededIssue) => `${fixture.identifier.replace(/-\d+$/, "")}-2-sibling`;

    it.each([
      ["R-02 this card's worktree stashes", async (fixture: SeededIssue) => {
        writeFileSync(path.join(fixture.worktree, "README.md"), "this card's work\n");
        git(fixture.worktree, "stash", "push", "-q");
      }],
      ["R-03 this card's stash relabelled as a registered sibling's", async (fixture: SeededIssue) => {
        const sibling = siblingBranch(fixture);
        await siblingWorktree(fixture, sibling);
        git(fixture.worktree, "stash", "store", "-m", `On ${sibling}: draft`, stashCreate(fixture.worktree, "this card's work\n"));
      }],
      ["R-07 this card's stash behind a packed ref", async (fixture: SeededIssue) => {
        writeFileSync(path.join(fixture.worktree, "README.md"), "this card's work\n");
        git(fixture.worktree, "stash", "push", "-q");
        git(fixture.repoRoot, "pack-refs", "--all");
      }],
    ] as const)("refuses %s", async (_id, arrange) => {
      const fixture = await seed();
      await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
      await arrange(fixture);
      const stashes = git(fixture.repoRoot, "stash", "list");

      const res = await close(fixture.identifier);

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toContain(`stashed on this card's branch ${fixture.branch} `);
      expect(await statusOf(fixture.issueId)).toBe("in_progress");
      expect(git(fixture.repoRoot, "stash", "list")).toBe(stashes);
    });

    it.each([
      ["R-04 a stash on the project branch in the managed checkout", async (fixture: SeededIssue) => {
        writeFileSync(path.join(fixture.repoRoot, "README.md"), "unattributed work\n");
        git(fixture.repoRoot, "stash", "push", "-q");
      }],
      ["R-05 a registered sibling's stash relabelled as this card's", async (fixture: SeededIssue) => {
        const other = await siblingWorktree(fixture, siblingBranch(fixture));
        git(other, "stash", "store", "-m", `On ${fixture.branch}: forged`, stashCreate(other, "sibling's work\n"));
      }],
      ["R-06 a registered sibling branch that mentions this card", async (fixture: SeededIssue) => {
        const prefix = fixture.identifier.replace(/-\d+$/, "");
        const other = await siblingWorktree(fixture, `${prefix}-2-follow-up-for-${fixture.identifier}`);
        writeFileSync(path.join(other, "README.md"), "sibling's work\n");
        git(other, "stash", "push", "-q");
      }],
    ] as const)("closes with %s", async (_id, arrange) => {
      const fixture = await seed();
      await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
      await arrange(fixture);
      const stashes = git(fixture.repoRoot, "stash", "list");

      const res = await close(fixture.identifier);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await statusOf(fixture.issueId)).toBe("done");
      expect(git(fixture.repoRoot, "stash", "list")).toBe(stashes);
    });
  });

  // The zero-delta mention rule end to end: another card's abandoned pull
  // request whose branch mentions this card stops being this card's
  // obligation only when the board registered that exact branch to the other
  // card's workspace.
  it.each([
    ["FM-R1 registered to a sibling card", true],
    ["FM-R2 registered to no card", false],
  ] as const)("decides a zero-delta close beside another card's closed pull request that mentions this card: %s", async (_id, registered) => {
    const fixture = await seed({ deliveryRequirement: "repository_delivery" });
    const followUp = `${fixture.identifier.replace(/-\d+$/, "")}-2-follow-up-for-${fixture.identifier}`;
    if (registered) await registerSiblingCard(fixture, followUp);
    const baseSha = git(fixture.worktree, "rev-parse", "HEAD");
    const sha = git(currentOrigin, "commit-tree", `${baseSha}^{tree}`, "-p", baseSha, "-m", "sibling's abandoned work");
    git(currentOrigin, "update-ref", "refs/pull/17/head", sha);
    answerZeroDeltaGitHub([{
      number: 17, state: "closed", merged_at: null, title: "Abandoned follow-up",
      html_url: "https://github.com/TEA-Core/records/pull/17",
      head: { ref: followUp, sha, repo: { full_name: "TEA-Core/records" } },
    }]);
    const res = await close(fixture.identifier, zeroDeltaDoneTier(fixture.worktree));
    if (registered) {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await statusOf(fixture.issueId)).toBe("done");
    } else {
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toContain("names this card and is not on the base line");
      expect(await statusOf(fixture.issueId)).toBe("in_progress");
    }
  });

  async function seedFinalZeroDeltaApproval() {
    const fixture = await seed({ deliveryRequirement: "repository_delivery" });
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        returnAssigneeAgentId: fixture.rulerAgentId,
        stages: [{
          id: stageId,
          type: "approval",
          approvalsNeeded: 1,
          participants: [{ type: "agent", agentId: fixture.closerAgentId }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "approval",
        currentParticipant: { type: "agent", agentId: fixture.closerAgentId },
        returnAssignee: { type: "agent", agentId: fixture.rulerAgentId },
        completedStageIds: [],
        skippedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, fixture.issueId));
    answerZeroDeltaGitHub();
    return { ...fixture, stageId };
  }

  it("closes a final-stage zero-delta approval without certifying or publishing a head", async () => {
    const fixture = await seedFinalZeroDeltaApproval();
    const res = await request(app).patch(`/api/issues/${fixture.identifier}`).send({
      status: "done",
      comment: "Independent final approval.",
      doneTier: zeroDeltaDoneTier(fixture.worktree),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [stored] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(stored?.status).toBe("done");
    expect(stored?.executionState).toMatchObject({
      completedStageIds: [fixture.stageId],
      lastDecisionOutcome: "approved",
      approvalStatus: {
        finalDeliveryUncertified: {
          decisionId: stored?.executionState?.lastDecisionId,
          reason: expect.stringContaining("zero-delta:"),
        },
        publishSkipped: { reason: expect.stringContaining("head_uncertified"), headSha: null },
      },
    });
    const approval = stored?.executionState?.approvalStatus as Record<string, unknown>;
    expect(approval.finalDelivery).toBeUndefined();
    expect(approval.approvedHeadSha).toBeUndefined();
    expect(approval.publishedHeadSha).toBeUndefined();
    const decisions = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, fixture.issueId));
    expect(decisions.map(({ stageId, outcome }) => ({ stageId, outcome }))).toEqual([{ stageId: fixture.stageId, outcome: "approved" }]);
    expect(await activityCount(fixture.issueId, "issue.done_transition_tier2_close")).toBe(1);
    expect(mockGhFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toEqual([]);
  });

  it("refuses a final-stage approval with no PR and no zero-delta declaration", async () => {
    const fixture = await seedFinalZeroDeltaApproval();
    const res = await request(app).patch(`/api/issues/${fixture.identifier}`).send({
      status: "done",
      comment: "Independent final approval.",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe("done_transition_missing_tier_declaration");
    expect(await statusOf(fixture.issueId)).toBe("in_review");
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, fixture.issueId))).toEqual([]);
    expect(await activityCount(fixture.issueId, "issue.done_transition_tier2_close")).toBe(0);
  });

  it("rolls back a final-stage approval when the zero-delta proof changes before the close write", async () => {
    const fixture = await seedFinalZeroDeltaApproval();
    mockEvaluateDoneTierDeclaration.mockImplementation(async (...args: Parameters<typeof evaluateDoneTierDeclaration>) => {
      const result = await realEvaluateDoneTierDeclarationRef.current!(...args);
      expect(result.allowed, result.reason).toBe(true);
      expect(result.zeroDeltaMeasurement).toBeDefined();
      writeFileSync(path.join(fixture.worktree, "late-work.txt"), "undelivered\n");
      return result;
    });
    const res = await request(app).patch(`/api/issues/${fixture.identifier}`).send({
      status: "done",
      comment: "Independent final approval.",
      doneTier: zeroDeltaDoneTier(fixture.worktree),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("merge_commit_unrecorded");
    const [stored] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(stored?.status).toBe("in_review");
    expect(stored?.executionState).toMatchObject({ status: "pending", completedStageIds: [], lastDecisionId: null });
    expect(stored?.executionState?.approvalStatus).toBeUndefined();
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, fixture.issueId))).toEqual([]);
    expect(await activityCount(fixture.issueId, "issue.done_transition_tier2_close")).toBe(0);
    expect(mockGhFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toEqual([]);
  });

  it("rolls back a final-stage zero-delta approval when deletion shifts the forge's offset pages", async () => {
    const fixture = await seedFinalZeroDeltaApproval();
    const baseSha = git(fixture.worktree, "rev-parse", "HEAD");
    git(currentOrigin, "branch", "a-ephemeral", baseSha);
    const normalFetch = mockGhFetch.getMockImplementation()!;
    let writePhase = false;
    mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const text = String(url);
      if (writePhase && /\/branches(?:\?|$)/.test(text)) {
        if (new URL(text).searchParams.has("page")) return Response.json([]);
        const page = [
          { name: "a-ephemeral", commit: { sha: baseSha } },
          { name: "main", commit: { sha: baseSha } },
        ];
        git(currentOrigin, "update-ref", "-d", "refs/heads/a-ephemeral");
        return Response.json(page, { headers: { link: `<https://api.github.com/repos/TEA-Core/paperclip/branches?per_page=2&page=2>; rel="next"` } });
      }
      if (/\/git\/matching-refs\/$/.test(text)) {
        const listed = git(currentOrigin, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
        return Response.json(listed.split("\n").map((line) => {
          const space = line.indexOf(" ");
          return { ref: line.slice(0, space), object: { type: "commit", sha: line.slice(space + 1) } };
        }));
      }
      return normalFetch(url, init);
    });
    mockEvaluateDoneTierDeclaration.mockImplementation(async (...args: Parameters<typeof evaluateDoneTierDeclaration>) => {
      const result = await realEvaluateDoneTierDeclarationRef.current!(...args);
      expect(result.allowed, result.reason).toBe(true);
      if (!writePhase) {
        const parked = git(currentOrigin, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
          "commit-tree", `${baseSha}^{tree}`, "-p", baseSha, "-m", "undelivered remote work");
        git(currentOrigin, "update-ref", "refs/heads/parked-work", parked);
        writePhase = true;
      }
      return result;
    });

    const res = await request(app).patch(`/api/issues/${fixture.identifier}`).send({
      status: "done",
      comment: "Independent final approval.",
      doneTier: zeroDeltaDoneTier(fixture.worktree),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("merge_commit_unrecorded");
    expect(git(currentOrigin, "rev-list", "--count", "main..parked-work")).toBe("1");
    const [stored] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(stored?.status).toBe("in_review");
    expect(stored?.executionState).toMatchObject({ status: "pending", completedStageIds: [], lastDecisionId: null });
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, fixture.issueId))).toEqual([]);
    expect(await activityCount(fixture.issueId, "issue.done_transition_tier2_close")).toBe(0);
  });

  it("rolls back a final-stage zero-delta approval when archive refs appear before the close write", async () => {
    const fixture = await seedFinalZeroDeltaApproval();
    const baseSha = git(fixture.worktree, "rev-parse", "HEAD");
    const ref = `refs/preserved/${fixture.identifier}/cycle`;
    let planted = false;
    mockEvaluateDoneTierDeclaration.mockImplementation(async (...args: Parameters<typeof evaluateDoneTierDeclaration>) => {
      const result = await realEvaluateDoneTierDeclarationRef.current!(...args);
      expect(result.allowed, result.reason).toBe(true);
      if (!planted) {
        const sha = git(currentOrigin, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
          "commit-tree", `${baseSha}^{tree}`, "-p", baseSha, "-m", "preserved archive work");
        git(currentOrigin, "update-ref", ref, sha);
        planted = true;
      }
      return result;
    });
    const res = await request(app).patch(`/api/issues/${fixture.identifier}`).send({
      status: "done",
      comment: "Independent final approval.",
      doneTier: zeroDeltaDoneTier(fixture.worktree),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("merge_commit_unrecorded");
    expect(git(currentOrigin, "rev-list", "--count", `main..${ref}`)).toBe("1");
    const [stored] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(stored?.status).toBe("in_review");
    expect(stored?.executionState).toMatchObject({ status: "pending", completedStageIds: [], lastDecisionId: null });
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, fixture.issueId))).toEqual([]);
    expect(await activityCount(fixture.issueId, "issue.done_transition_tier2_close")).toBe(0);
  });

  it("refuses a zero-delta close that rebinds the execution workspace in the same request", async () => {
    const fixture = await seed({ deliveryRequirement: "repository_delivery" });
    answerZeroDeltaGitHub();
    const otherWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: otherWorkspaceId,
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      projectWorkspaceId: fixture.projectWorkspaceId,
      sourceIssueId: fixture.issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "other-workspace",
      status: "active",
      cwd: fixture.worktree,
      repoUrl: "https://github.com/TEA-Core/records",
      baseRef: "main",
      branchName: fixture.branch,
      providerType: "git_worktree",
      providerRef: fixture.worktree,
    });

    const res = await request(app)
      .patch(`/api/issues/${fixture.identifier}`)
      .send({ status: "done", doneTier: zeroDeltaDoneTier(fixture.worktree), executionWorkspaceId: otherWorkspaceId });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("merge_commit_unrecorded");
    expect(await statusOf(fixture.issueId)).toBe("in_progress");
  });

  it("refuses a zero-delta close that moves the card to another project workspace in the same request", async () => {
    const fixture = await seed({ deliveryRequirement: "repository_delivery" });
    answerZeroDeltaGitHub();
    const other = await insertSecondProjectWorkspace(fixture);

    const res = await request(app)
      .patch(`/api/issues/${fixture.identifier}`)
      .send({ status: "done", doneTier: zeroDeltaDoneTier(fixture.worktree), projectWorkspaceId: other });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("merge_commit_unrecorded");
    const [stored] = await db
      .select({ status: issues.status, projectWorkspaceId: issues.projectWorkspaceId })
      .from(issues)
      .where(eq(issues.id, fixture.issueId));
    expect(stored).toEqual({ status: "in_progress", projectWorkspaceId: fixture.projectWorkspaceId });
  });

  // SUP-24547: a record_only card with no project, no project workspace and no
  // execution workspace, that the control plane shows never had one, closes
  // with the no-repository form without a worktree. Every neighbouring shape
  // keeps today's refusal.
  describe("a card that never had an execution workspace (SUP-24547)", () => {
    const NO_WORKSPACE_REFUSAL = `Tier 1 "no-repository-landing" requires this issue's own execution workspace.`;

    interface NoWorkspaceIssue {
      companyId: string;
      closerAgentId: string;
      rulerAgentId: string;
      issueId: string;
      identifier: string;
      actor: Express.Request["actor"];
    }

    async function insertProject(companyId: string) {
      const projectId = randomUUID();
      await db.insert(projects).values({ id: projectId, companyId, name: "Elsewhere", status: "active" });
      return projectId;
    }

    async function insertWorkspace(
      companyId: string,
      options: { sourceIssueId?: string | null; status?: string; projectId?: string } = {},
    ) {
      const projectId = options.projectId ?? (await insertProject(companyId));
      const workspaceId = randomUUID();
      await db.insert(executionWorkspaces).values({
        id: workspaceId,
        companyId,
        projectId,
        sourceIssueId: options.sourceIssueId ?? null,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        providerType: "git_worktree",
        name: "prior-workspace",
        status: options.status ?? "active",
      });
      return { projectId, workspaceId };
    }

    /** A record_only card with no project and no workspace, held by the closer, on a run that named no workspace. */
    async function seedNoWorkspace(
      options: {
        companyId?: string;
        deliveryRequirement?: "record_only" | "repository_delivery";
        withProject?: boolean;
        withProjectWorkspace?: boolean;
        omitCreationSnapshot?: boolean;
      } = {},
    ): Promise<NoWorkspaceIssue> {
      seedSequence += 1;
      const prefix = `NWS${seedSequence}`;
      const companyId = options.companyId ?? await insertCompany(prefix);
      const closerAgentId = await insertAgent(companyId, "Closer");
      const rulerAgentId = await insertAgent(companyId, "Ruler");
      let projectId: string | null = null;
      let projectWorkspaceId: string | null = null;
      if (options.withProject || options.withProjectWorkspace) {
        projectId = await insertProject(companyId);
      }
      if (options.withProjectWorkspace) {
        projectWorkspaceId = randomUUID();
        await db.insert(projectWorkspaces).values({
          id: projectWorkspaceId,
          companyId,
          projectId: projectId!,
          name: "Primary",
          repoUrl: "https://github.com/TEA-Core/records",
          isPrimary: true,
        });
      }
      const issueId = randomUUID();
      const identifier = `${prefix}-1`;
      await db.insert(issues).values({
        id: issueId,
        companyId,
        projectId: options.withProjectWorkspace ? null : projectId,
        projectWorkspaceId,
        identifier,
        title: "Record the ruling",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: closerAgentId,
        createdByUserId: "cloud-user-1",
        executionWorkspaceId: null,
        deliveryRequirement: options.deliveryRequirement ?? "record_only",
      });
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: closerAgentId,
        status: "running",
        contextSnapshot: { issueId },
      });
      if (!options.omitCreationSnapshot) {
        await db.insert(activityLog).values({
          companyId,
          actorType: "user",
          actorId: "cloud-user-1",
          action: "issue.created",
          entityType: "issue",
          entityId: issueId,
          details: {
            title: "Record the ruling",
            identifier,
            projectId: null,
            projectWorkspaceId: null,
            description: null,
          },
        });
      }
      currentActor = { type: "agent", agentId: closerAgentId, companyId, source: "agent_key", runId };
      return { companyId, closerAgentId, rulerAgentId, issueId, identifier, actor: currentActor };
    }

    // An owner of the company: the board user who writes the ruling.
    const BOARD_USER_ID = "cloud-user-1";

    async function seedAdmissible(options: Parameters<typeof seedNoWorkspace>[0] = {}) {
      const fixture = await seedNoWorkspace(options);
      const rulingId = await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorUserId: BOARD_USER_ID });
      return { ...fixture, rulingId };
    }

    async function expectRefused(fixture: NoWorkspaceIssue, res: request.Response, expected: string) {
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toBe(expected);
      expect(await statusOf(fixture.issueId)).toBe("in_progress");
      expect(await activityCount(fixture.issueId, "issue.done_transition_no_repository_landing_verified")).toBe(0);
    }

    it("closes the card on the independent ruling alone, records the proof used, and makes no repository call", async () => {
      const fixture = await seedAdmissible();

      const res = await close(fixture.identifier);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await statusOf(fixture.issueId)).toBe("done");
      const verified = await activityRows(fixture.issueId, "issue.done_transition_no_repository_landing_verified");
      expect(verified).toHaveLength(1);
      expect(verified[0]!.details).toEqual({
        proof: "never_had_execution_workspace",
        rulingDocumentId: fixture.rulingId,
        rulingRevisionNumber: 1,
        projectId: null,
        projectWorkspaceId: null,
        executionWorkspaceId: null,
        creationSnapshot: "recorded",
        checkedRecords: expect.arrayContaining([
          "external_object_mentions (none)",
          "issue_comments (none deleted, no repository reference)",
          "documents of the issue (every revision, no repository reference)",
        ]),
      });
      const bodies = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, fixture.issueId))
        .then((rows) => rows.map((row) => row.body));
      expect(bodies.some((body) => body.includes("Closed at Tier 1 (landed, not liveness-probed): no-repository-landing"))).toBe(true);
      expect(mockGhFetch).not.toHaveBeenCalled();
      expect(mockRecheckRecordedWorktree).not.toHaveBeenCalled();
    });

    describe("assurance regression: ordinary record workflows", () => {
      it.each([false, true])("re-checks a board-reopened card with repository evidence in its prior proof: %s", async (hasRepositoryEvidence) => {
        const fixture = await seedAdmissible();
        const first = await close(fixture.identifier);
        expect(first.status, JSON.stringify(first.body)).toBe(200);
        expect(await statusOf(fixture.issueId)).toBe("done");
        asBoard();
        const reopened = await request(app).patch(`/api/issues/${fixture.identifier}`).send({ status: "in_progress" });
        expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
        expect(await statusOf(fixture.issueId)).toBe("in_progress");
        if (hasRepositoryEvidence) {
          await db.update(activityLog).set({
            details: sql`jsonb_set(${activityLog.details}, '{noRepositoryLanding,repository}', '"records"'::jsonb)`,
          }).where(and(eq(activityLog.entityId, fixture.issueId), eq(activityLog.action, "issue.done_transition_tier1_close")));
        }
        currentActor = fixture.actor;
        const second = await close(fixture.identifier);
        expect(second.status, JSON.stringify(second.body)).toBe(hasRepositoryEvidence ? 422 : 200);
        expect(await statusOf(fixture.issueId)).toBe(hasRepositoryEvidence ? "in_progress" : "done");
        expect(await activityCount(fixture.issueId, "issue.done_transition_no_repository_landing_verified")).toBe(hasRepositoryEvidence ? 1 : 2);
      });

      it.each(["report: weekly staffing totals", "summary: weekly staffing totals", "repo: records"])(
        "checks staffing explanation %s without confusing report with repo",
        async (authorizationReason) => {
          const fixture = await seedAdmissible();
          await db.insert(issueComments).values({
            companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.closerAgentId,
            body: "Staffing totals accepted.",
            metadata: { version: 1, sections: [], authorizationReason },
          });
          const result = await close(fixture.identifier);
          const evidence = authorizationReason.startsWith("repo:");
          expect(result.status, JSON.stringify(result.body)).toBe(evidence ? 422 : 200);
          expect(await statusOf(fixture.issueId)).toBe(evidence ? "in_progress" : "done");
        },
      );

      it.each([
        ["https://review.example.org/policies/retention", 200],
        ["https://example.org/policies/retention", 200],
        ["https://review.example.org/c/records/+/12345", 422],
      ] as const)("checks policy URL %s by citation shape", async (url, status) => {
        const fixture = await seedAdmissible();
        await db.insert(issueComments).values({
          companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.closerAgentId,
          body: `Benefits policy: ${url}`,
        });
        const result = await close(fixture.identifier);
        expect(result.status, JSON.stringify(result.body)).toBe(status);
        expect(await statusOf(fixture.issueId)).toBe(status === 200 ? "done" : "in_progress");
      });
    });

    const UNKNOWN_CREATION_SNAPSHOT =
      `Tier 1 "no-repository-landing" cannot be declared on an issue whose creation snapshot is unknown: issue.created did not record projectId, projectWorkspaceId and description.`;
    const REWRITE_WITHOUT_OLD_VALUE =
      `Tier 1 "no-repository-landing" cannot be declared on an issue whose title or description was rewritten without a recorded earlier value: the earlier text can no longer be checked for repository work.`;

    async function insertCreationSnapshot(fixture: NoWorkspaceIssue, description: string | null = null) {
      await db.insert(activityLog).values({
        companyId: fixture.companyId,
        actorType: "user",
        actorId: BOARD_USER_ID,
        action: "issue.created",
        entityType: "issue",
        entityId: fixture.issueId,
        details: {
          title: "Record the ruling",
          identifier: fixture.identifier,
          projectId: null,
          projectWorkspaceId: null,
          description,
        },
      });
    }

    it("closes a never-had card whose missing creation snapshot is derived from a still-null project, and audits the path used", async () => {
      const fixture = await seedAdmissible({ omitCreationSnapshot: true });
      const res = await close(fixture.identifier);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const verified = await activityRows(fixture.issueId, "issue.done_transition_no_repository_landing_verified");
      expect(verified[0]!.details).toMatchObject({ creationSnapshot: "not_recorded" });
    });

    it.each([
      ["project.workspace_deleted", false],
      ["project.workspace_deleted", true],
      ["project.deleted", false],
      ["project.deleted", true],
    ] as const)("deletion audit company scope: %s (same company: %s)", async (action, sameCompany) => {
      const fixture = await seedAdmissible({ omitCreationSnapshot: true });
      const auditCompanyId = sameCompany ? fixture.companyId : (await seedAdmissible()).companyId;
      const workspaceId = randomUUID();
      // Seed a historical claim directly: write-side deletion cannot produce
      // a foreign-company claim, but the audit reader must still isolate it.
      await db.insert(activityLog).values({
        companyId: auditCompanyId,
        actorType: "user",
        actorId: BOARD_USER_ID,
        action,
        entityType: "project",
        entityId: randomUUID(),
        details: {
          workspaceId,
          affectedIssues: [{ issueId: fixture.issueId, projectWorkspaceId: workspaceId }],
          affectedCount: 1,
          affectedTruncated: false,
        },
      });
      currentActor = fixture.actor;
      const result = await close(fixture.identifier);
      if (sameCompany) {
        await expectRefused(fixture, result, NO_WORKSPACE_REFUSAL);
      } else {
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        expect(await statusOf(fixture.issueId)).toBe("done");
      }
    });

    it("refuses a legacy card after project deletion cascades through its workspace binding", async () => {
      const bound = await seedAdmissible({ withProjectWorkspace: true, omitCreationSnapshot: true });
      await expectRefused(bound, await close(bound.identifier), NO_WORKSPACE_REFUSAL);

      // issues.project_id restricts deletion; project_workspace_id is instead
      // nulled by the real project -> workspace cascade.
      const deleted = await seedAdmissible({ withProjectWorkspace: true, omitCreationSnapshot: true });
      const [before] = await db.select({
        projectId: projectWorkspaces.projectId,
        projectWorkspaceId: issues.projectWorkspaceId,
      }).from(issues).innerJoin(projectWorkspaces, eq(projectWorkspaces.id, issues.projectWorkspaceId))
        .where(eq(issues.id, deleted.issueId));
      expect(before!.projectWorkspaceId).not.toBeNull();
      asBoard();
      const removal = await request(app).delete(`/api/projects/${before!.projectId}`);
      expect(removal.status, JSON.stringify(removal.body)).toBe(200);
      expect(await db.select().from(projects).where(eq(projects.id, before!.projectId!))).toEqual([]);
      const [after] = await db.select({
        projectId: issues.projectId, projectWorkspaceId: issues.projectWorkspaceId,
      }).from(issues).where(eq(issues.id, deleted.issueId));
      expect(after).toEqual({ projectId: null, projectWorkspaceId: null });
      expect(await activityRows(before!.projectId!, "project.deleted")).toHaveLength(1);
      currentActor = deleted.actor;
      await expectRefused(deleted, await close(deleted.identifier), NO_WORKSPACE_REFUSAL);
    });

    it.each(["binding", "source issue"] as const)(
      "refuses project deletion erasing an execution-only workspace %s",
      async (association) => {
        const fixture = await seedAdmissible({ omitCreationSnapshot: true });
        const { projectId, workspaceId } = await insertWorkspace(fixture.companyId, {
          sourceIssueId: association === "source issue" ? fixture.issueId : null,
        });
        if (association === "binding") {
          await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, fixture.issueId));
        }
        asBoard();
        const removal = await request(app).delete(`/api/projects/${projectId}`);
        expect(removal.status, JSON.stringify(removal.body)).toBe(200);
        expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId))).toEqual([]);
        const [after] = await db.select({ executionWorkspaceId: issues.executionWorkspaceId }).from(issues)
          .where(eq(issues.id, fixture.issueId));
        expect(after!.executionWorkspaceId).toBeNull();
        currentActor = fixture.actor;
        await expectRefused(fixture, await close(fixture.identifier), NO_WORKSPACE_REFUSAL);
      },
    );

    it("does not attribute an unrelated project deletion to a legacy never-had card", async () => {
      const fixture = await seedAdmissible({ omitCreationSnapshot: true });
      const unrelatedProjectId = await insertProject(fixture.companyId);
      asBoard();
      const removal = await request(app).delete(`/api/projects/${unrelatedProjectId}`);
      expect(removal.status, JSON.stringify(removal.body)).toBe(200);
      expect(await activityRows(unrelatedProjectId, "project.deleted")).toHaveLength(1);
      currentActor = fixture.actor;
      const res = await close(fixture.identifier);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await statusOf(fixture.issueId)).toBe("done");
    });

    async function bulkBindToWorkspace(companyId: string, projectWorkspaceId: string, count: number) {
      for (let offset = 0; offset < count; offset += 1000) {
        const size = Math.min(1000, count - offset);
        await db.insert(issues).values(
          Array.from({ length: size }, (_, index) => ({
            id: randomUUID(),
            companyId,
            projectWorkspaceId,
            identifier: `BULK-${offset + index}-${randomUUID().slice(0, 8)}`,
            title: "Bulk bound card",
            status: "todo",
            priority: "medium",
          })),
        );
      }
    }

    it.each([
      [5000, false],
      [5001, true],
    ] as const)("records at most 5000 affected cards on project deletion (%i bound cards, truncated=%s)", async (bound, truncated) => {
      const fixture = await seedNoWorkspace({ withProjectWorkspace: true, omitCreationSnapshot: true });
      const [binding] = await db.select({
        projectId: projectWorkspaces.projectId,
        projectWorkspaceId: issues.projectWorkspaceId,
      }).from(issues).innerJoin(projectWorkspaces, eq(projectWorkspaces.id, issues.projectWorkspaceId))
        .where(eq(issues.id, fixture.issueId));
      await bulkBindToWorkspace(fixture.companyId, binding!.projectWorkspaceId!, bound - 1);

      asBoard();
      const removal = await request(app).delete(`/api/projects/${binding!.projectId}`);
      expect(removal.status, JSON.stringify(removal.body)).toBe(200);

      const [audit] = await activityRows(binding!.projectId!, "project.deleted");
      const details = audit!.details as {
        affectedIssues: Array<{ issueId: string; projectWorkspaceId: string }>;
        affectedCount: number;
        affectedTruncated: boolean;
      };
      expect(details.affectedCount).toBe(bound);
      expect(details.affectedTruncated).toBe(truncated);
      expect(details.affectedIssues).toHaveLength(Math.min(bound, 5000));
      expect(new Set(details.affectedIssues.map((entry) => entry.issueId)).size).toBe(details.affectedIssues.length);
      expect(details.affectedIssues.every((entry) => entry.projectWorkspaceId === binding!.projectWorkspaceId)).toBe(true);
      const [after] = await db.select({ projectWorkspaceId: issues.projectWorkspaceId }).from(issues)
        .where(eq(issues.id, fixture.issueId));
      expect(after!.projectWorkspaceId).toBeNull();
    }, 120_000);

    it.each(["project.deleted", "project.workspace_deleted"] as const)(
      "refuses an unaccounted legacy card after truncated %s audit",
      async (action) => {
        const fixture = await seedNoWorkspace({ withProjectWorkspace: true, omitCreationSnapshot: true });
        const [binding] = await db.select({
          projectId: projectWorkspaces.projectId,
          projectWorkspaceId: projectWorkspaces.id,
        }).from(issues).innerJoin(projectWorkspaces, eq(projectWorkspaces.id, issues.projectWorkspaceId))
          .where(eq(issues.id, fixture.issueId));
        await bulkBindToWorkspace(fixture.companyId, binding!.projectWorkspaceId, 5000);
        const [first] = await db.select({ id: issues.id }).from(issues)
          .where(eq(issues.projectWorkspaceId, binding!.projectWorkspaceId)).orderBy(issues.id).limit(1);
        const [last] = await db.select({ id: issues.id }).from(issues)
          .where(eq(issues.projectWorkspaceId, binding!.projectWorkspaceId)).orderBy(sql`${issues.id} desc`).limit(1);
        async function prepareCard(issueId: string): Promise<NoWorkspaceIssue> {
          await db.update(issues).set({
            status: "in_progress", deliveryRequirement: "record_only",
            assigneeAgentId: fixture.closerAgentId, createdByUserId: BOARD_USER_ID,
          }).where(eq(issues.id, issueId));
          const runId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: runId, companyId: fixture.companyId, agentId: fixture.closerAgentId,
            status: "running", contextSnapshot: { issueId },
          });
          await insertRuling({ companyId: fixture.companyId, issueId, authorUserId: BOARD_USER_ID });
          return {
            ...fixture, issueId, identifier: issueId,
            actor: { type: "agent", companyId: fixture.companyId, agentId: fixture.closerAgentId, source: "agent_key", runId },
          };
        }
        const listed = await prepareCard(first!.id);
        const omitted = await prepareCard(last!.id);
        const intact = await seedAdmissible({
          companyId: fixture.companyId, withProjectWorkspace: true, omitCreationSnapshot: true,
        });
        const recorded = await seedAdmissible({ companyId: fixture.companyId });
        const foreign = await seedAdmissible({ omitCreationSnapshot: true });
        const [intactBefore] = await db.select({ projectWorkspaceId: issues.projectWorkspaceId }).from(issues)
          .where(eq(issues.id, intact.issueId));
        asBoard();
        const path = action === "project.deleted"
          ? `/api/projects/${binding!.projectId}`
          : `/api/projects/${binding!.projectId}/workspaces/${binding!.projectWorkspaceId}`;
        const removal = await request(app).delete(path);
        expect(removal.status, JSON.stringify(removal.body)).toBe(200);
        const [audit] = await activityRows(binding!.projectId, action);
        const details = audit!.details as {
          affectedIssues: Array<{ issueId: string }>; affectedCount: number; affectedTruncated: boolean;
        };
        expect(details.affectedCount).toBe(5001);
        expect(details.affectedTruncated).toBe(true);
        expect(details.affectedIssues).toHaveLength(5000);
        expect(details.affectedIssues.some((entry) => entry.issueId === listed.issueId)).toBe(true);
        expect(details.affectedIssues.some((entry) => entry.issueId === omitted.issueId)).toBe(false);
        const [erased] = await db.select({
          projectId: issues.projectId, projectWorkspaceId: issues.projectWorkspaceId,
          executionWorkspaceId: issues.executionWorkspaceId,
        }).from(issues).where(eq(issues.id, omitted.issueId));
        expect(erased).toEqual({ projectId: null, projectWorkspaceId: null, executionWorkspaceId: null });
        currentActor = listed.actor;
        await expectRefused(listed, await close(listed.issueId), NO_WORKSPACE_REFUSAL);
        currentActor = intact.actor;
        await expectRefused(intact, await close(intact.issueId), NO_WORKSPACE_REFUSAL);
        const [intactAfter] = await db.select({ projectWorkspaceId: issues.projectWorkspaceId }).from(issues)
          .where(eq(issues.id, intact.issueId));
        expect(intactAfter).toEqual(intactBefore);
        for (const control of [foreign, recorded]) {
          currentActor = control.actor;
          const allowed = await close(control.issueId);
          expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
          expect(await statusOf(control.issueId)).toBe("done");
        }
        currentActor = omitted.actor;
        const result = await close(omitted.issueId);
        expect(result.status, JSON.stringify(result.body)).toBe(422);
        expect(await statusOf(omitted.issueId)).toBe("in_progress");
        expect(result.body.error).toMatch(/deletion/i);
        expect(result.body.error).toMatch(/audit.*(?:cap|limit)/i);
        expect(result.body.details.remedy).toMatch(/board/i);
        expect(result.body.details.remedy).toMatch(/close/i);
      },
      120_000,
    );

    it("persists the affected card ids on project deletion but publishes only the counts", async () => {
      const fixture = await seedNoWorkspace({ withProjectWorkspace: true, omitCreationSnapshot: true });
      const [binding] = await db.select({
        projectId: projectWorkspaces.projectId,
        projectWorkspaceId: issues.projectWorkspaceId,
      }).from(issues).innerJoin(projectWorkspaces, eq(projectWorkspaces.id, issues.projectWorkspaceId))
        .where(eq(issues.id, fixture.issueId));
      await bulkBindToWorkspace(fixture.companyId, binding!.projectWorkspaceId!, 2);

      const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const unsubscribe = subscribeCompanyLiveEvents(fixture.companyId, (event) => {
        published.push(event as unknown as { type: string; payload: Record<string, unknown> });
      });
      try {
        asBoard();
        const removal = await request(app).delete(`/api/projects/${binding!.projectId}`);
        expect(removal.status, JSON.stringify(removal.body)).toBe(200);
      } finally {
        unsubscribe();
      }

      const [audit] = await activityRows(binding!.projectId!, "project.deleted");
      const persisted = audit!.details as { affectedIssues: Array<{ issueId: string }>; affectedCount: number };
      expect(persisted.affectedCount).toBe(3);
      expect(persisted.affectedIssues.map((entry) => entry.issueId)).toContain(fixture.issueId);

      const events = published.filter(
        (event) => event.type === "activity.logged" && event.payload.action === "project.deleted",
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.details).toEqual({ affectedCount: 3, affectedTruncated: false });
      expect(JSON.stringify(events)).not.toContain(fixture.issueId);
    });

    it("rolls the project deletion back when its audit write fails", async () => {
      const fixture = await seedAdmissible({ withProjectWorkspace: true, omitCreationSnapshot: true });
      const [binding] = await db.select({
        projectId: projectWorkspaces.projectId,
        projectWorkspaceId: issues.projectWorkspaceId,
      }).from(issues).innerJoin(projectWorkspaces, eq(projectWorkspaces.id, issues.projectWorkspaceId))
        .where(eq(issues.id, fixture.issueId));

      await db.execute(sql`
        create or replace function test_fail_project_deleted_audit() returns trigger language plpgsql as $$
        begin
          if new.action = 'project.deleted' then raise exception 'audit write refused'; end if;
          return new;
        end $$`);
      await db.execute(sql`
        create trigger fail_project_deleted_audit before insert on activity_log
        for each row execute function test_fail_project_deleted_audit()`);
      try {
        asBoard();
        const removal = await request(app).delete(`/api/projects/${binding!.projectId}`);
        expect(removal.status, JSON.stringify(removal.body)).toBe(500);
      } finally {
        await db.execute(sql`drop trigger if exists fail_project_deleted_audit on activity_log`);
        await db.execute(sql`drop function if exists test_fail_project_deleted_audit()`);
      }

      expect(await db.select().from(projects).where(eq(projects.id, binding!.projectId!))).toHaveLength(1);
      expect(await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.id, binding!.projectWorkspaceId!))).toHaveLength(1);
      const [after] = await db.select({ projectWorkspaceId: issues.projectWorkspaceId }).from(issues)
        .where(eq(issues.id, fixture.issueId));
      expect(after!.projectWorkspaceId).toBe(binding!.projectWorkspaceId);
      expect(await activityRows(binding!.projectId!, "project.deleted")).toHaveLength(0);
      currentActor = fixture.actor;
      await expectRefused(fixture, await close(fixture.identifier), NO_WORKSPACE_REFUSAL);
    });

    describe("workspace-link deletion", () => {
      async function seedBoundWorkspace() {
        const fixture = await seedAdmissible({ withProjectWorkspace: true, omitCreationSnapshot: true });
        const [binding] = await db.select({
          projectId: projectWorkspaces.projectId,
          projectWorkspaceId: projectWorkspaces.id,
        }).from(issues).innerJoin(projectWorkspaces, eq(projectWorkspaces.id, issues.projectWorkspaceId))
          .where(eq(issues.id, fixture.issueId));
        return { ...fixture, ...binding! };
      }

      it("retains the former binding for close refusal after the real workspace DELETE", async () => {
        const bound = await seedBoundWorkspace();
        await expectRefused(bound, await close(bound.identifier), NO_WORKSPACE_REFUSAL);

        // A separate card prevents the still-bound refusal audit masking erased evidence.
        const deleted = await seedBoundWorkspace();
        asBoard();
        const removal = await request(app).delete(`/api/projects/${deleted.projectId}/workspaces/${deleted.projectWorkspaceId}`);
        expect(removal.status, JSON.stringify(removal.body)).toBe(200);
        expect(await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.id, deleted.projectWorkspaceId))).toEqual([]);
        expect(await db.select().from(projects).where(eq(projects.id, deleted.projectId))).toHaveLength(1);
        const [after] = await db.select({
          projectId: issues.projectId,
          projectWorkspaceId: issues.projectWorkspaceId,
          executionWorkspaceId: issues.executionWorkspaceId,
        }).from(issues).where(eq(issues.id, deleted.issueId));
        expect(after).toEqual({ projectId: null, projectWorkspaceId: null, executionWorkspaceId: null });
        currentActor = deleted.actor;
        await expectRefused(deleted, await close(deleted.identifier), NO_WORKSPACE_REFUSAL);
      });

      it("does not attribute an unrelated workspace deletion to a never-bound card", async () => {
        const fixture = await seedAdmissible({ omitCreationSnapshot: true });
        const projectId = await insertProject(fixture.companyId);
        const workspaceId = randomUUID();
        await db.insert(projectWorkspaces).values({
          id: workspaceId, companyId: fixture.companyId, projectId, name: "Other workspace",
        });
        await bulkBindToWorkspace(fixture.companyId, workspaceId, 1);
        asBoard();
        const removal = await request(app).delete(`/api/projects/${projectId}/workspaces/${workspaceId}`);
        expect(removal.status, JSON.stringify(removal.body)).toBe(200);
        currentActor = fixture.actor;
        const result = await close(fixture.identifier);
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        expect(await statusOf(fixture.issueId)).toBe("done");
      });

      it.each([
        [5000, false],
        [5001, true],
      ] as const)("bounds persisted attribution at 5000 cards (%i bound, truncated=%s)", async (bound, truncated) => {
        const fixture = await seedBoundWorkspace();
        await bulkBindToWorkspace(fixture.companyId, fixture.projectWorkspaceId, bound - 1);
        asBoard();
        const removal = await request(app).delete(`/api/projects/${fixture.projectId}/workspaces/${fixture.projectWorkspaceId}`);
        expect(removal.status, JSON.stringify(removal.body)).toBe(200);
        const [audit] = await activityRows(fixture.projectId, "project.workspace_deleted");
        const details = audit!.details as {
          affectedIssues: Array<{ issueId: string; projectWorkspaceId: string }>;
          affectedCount: number;
          affectedTruncated: boolean;
        };
        expect(details.affectedCount).toBe(bound);
        expect(details.affectedTruncated).toBe(truncated);
        expect(details.affectedIssues).toHaveLength(Math.min(bound, 5000));
        expect(new Set(details.affectedIssues.map((entry) => entry.issueId)).size).toBe(details.affectedIssues.length);
        expect(details.affectedIssues.every((entry) => entry.projectWorkspaceId === fixture.projectWorkspaceId)).toBe(true);
      }, 120_000);

      it("persists affected card ids without exposing them in live or plugin deletion events", async () => {
        const fixture = await seedBoundWorkspace();
        await bulkBindToWorkspace(fixture.companyId, fixture.projectWorkspaceId, 2);
        const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
        const pluginPayloads: Array<Record<string, unknown>> = [];
        const subscriber = deletionEventBus.forPlugin("test.workspace-deletion");
        subscriber.subscribe("project.workspace_deleted", { companyId: fixture.companyId }, async (event) => {
          pluginPayloads.push(event.payload as Record<string, unknown>);
        });
        const unsubscribe = subscribeCompanyLiveEvents(fixture.companyId, (event) => {
          published.push(event as unknown as { type: string; payload: Record<string, unknown> });
        });
        try {
          asBoard();
          const removal = await request(app).delete(`/api/projects/${fixture.projectId}/workspaces/${fixture.projectWorkspaceId}`);
          expect(removal.status, JSON.stringify(removal.body)).toBe(200);
          await vi.waitFor(() => expect(pluginPayloads).toHaveLength(1));
        } finally {
          unsubscribe();
          subscriber.clear();
        }
        const [audit] = await activityRows(fixture.projectId, "project.workspace_deleted");
        expect(audit!.details).toMatchObject({
          affectedCount: 3,
          affectedTruncated: false,
          affectedIssues: expect.arrayContaining([
            expect.objectContaining({ issueId: fixture.issueId, projectWorkspaceId: fixture.projectWorkspaceId }),
          ]),
        });
        const events = published.filter(
          (event) => event.type === "activity.logged" && event.payload.action === "project.workspace_deleted",
        );
        expect(events).toHaveLength(1);
        expect(events[0]!.payload.details).toEqual({
          workspaceId: fixture.projectWorkspaceId, name: "Primary", affectedCount: 3, affectedTruncated: false,
        });
        expect(JSON.stringify(events)).not.toContain(fixture.issueId);
        expect(pluginPayloads[0]).toMatchObject({
          workspaceId: fixture.projectWorkspaceId, name: "Primary", affectedCount: 3, affectedTruncated: false,
        });
        expect(pluginPayloads[0]).not.toHaveProperty("affectedIssues");
        expect(JSON.stringify(pluginPayloads)).not.toContain(fixture.issueId);
      });

      it("rolls back the workspace unlink when deletion audit persistence fails", async () => {
        const fixture = await seedBoundWorkspace();
        await db.execute(sql`
          create function test_fail_workspace_deleted_audit() returns trigger language plpgsql as $$
          begin
            if new.action = 'project.workspace_deleted' then raise exception 'audit write refused'; end if;
            return new;
          end $$`);
        await db.execute(sql`
          create trigger fail_workspace_deleted_audit before insert on activity_log
          for each row execute function test_fail_workspace_deleted_audit()`);
        try {
          asBoard();
          const removal = await request(app).delete(`/api/projects/${fixture.projectId}/workspaces/${fixture.projectWorkspaceId}`);
          expect(removal.status, JSON.stringify(removal.body)).toBe(500);
        } finally {
          await db.execute(sql`drop trigger if exists fail_workspace_deleted_audit on activity_log`);
          await db.execute(sql`drop function if exists test_fail_workspace_deleted_audit()`);
        }
        expect(await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.id, fixture.projectWorkspaceId))).toHaveLength(1);
        const [after] = await db.select({ projectWorkspaceId: issues.projectWorkspaceId }).from(issues)
          .where(eq(issues.id, fixture.issueId));
        expect(after!.projectWorkspaceId).toBe(fixture.projectWorkspaceId);
        expect(await activityRows(fixture.projectId, "project.workspace_deleted")).toHaveLength(0);
        currentActor = fixture.actor;
        await expectRefused(fixture, await close(fixture.identifier), NO_WORKSPACE_REFUSAL);
      });
    });

    it("refuses a close request whose own description cites repository work and closes with a clean one", async () => {
      const cited = await seedAdmissible();
      const refused = await request(app).patch(`/api/issues/${cited.identifier}`).send({
        status: "done", doneTier: NO_REPOSITORY_DONE_TIER,
        description: "Landed in https://github.com/TEA-Core/records/pull/12",
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(await statusOf(cited.issueId)).toBe("in_progress");
      const titled = await seedAdmissible();
      const titleRefused = await request(app).patch(`/api/issues/${titled.identifier}`).send({
        status: "done", doneTier: NO_REPOSITORY_DONE_TIER, title: "Fix in PR #12",
      });
      expect(titleRefused.status, JSON.stringify(titleRefused.body)).toBe(422);
      expect(await statusOf(titled.issueId)).toBe("in_progress");
      const clean = await seedAdmissible();
      const closed = await request(app).patch(`/api/issues/${clean.identifier}`).send({
        status: "done", doneTier: NO_REPOSITORY_DONE_TIER, description: "Decision only.",
      });
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    });

    it("lets the guard's own exclusion audit row stand but still scans its details", async () => {
      const clean = await seedAdmissible();
      await db.insert(activityLog).values({
        companyId: clean.companyId, actorType: "system", actorId: "done_transition_guard",
        action: "issue.done_transition_exclusion_below_threshold", entityType: "issue", entityId: clean.issueId,
        details: { reason: "carve_out_below_threshold", ladderedChildCount: 1, excludedChildIdentifiers: [], source: "done_transition_guard" },
      });
      expect((await close(clean.identifier)).status).toBe(200);
      const cited = await seedAdmissible();
      await db.insert(activityLog).values({
        companyId: cited.companyId, actorType: "system", actorId: "done_transition_guard",
        action: "issue.done_transition_exclusion_below_threshold", entityType: "issue", entityId: cited.issueId,
        details: { reason: "carve_out_below_threshold", repoUrl: "https://github.com/TEA-Core/records" },
      });
      expect((await close(cited.identifier)).status).toBe(422);
    });

    it("keeps machine traces and projected totals neutral and does not let a peer-owned run block the card", async () => {
      const traced = await seedAdmissible();
      await insertNativeRun(traced, { contextSnapshot: { traceId: "3f9c1e0a25b8c4d2", projectedTotal: 42 } });
      { const r = await close(traced.identifier); expect(r.status, JSON.stringify(r.body)).toBe(200); }

      const peerOwned = await seedAdmissible();
      const [peer] = await db.insert(issues).values({ companyId: peerOwned.companyId, title: "Peer", status: "in_progress" }).returning({ id: issues.id });
      await insertNativeRun(peerOwned, {
        nativeIssueId: peer!.id,
        contextSnapshot: { issueId: peerOwned.issueId, executionWorkspaceId: randomUUID(), repoUrl: "https://github.com/TEA-Core/records" },
      });
      { const r = await close(peerOwned.identifier); expect(r.status, JSON.stringify(r.body)).toBe(200); }

      const own = await seedAdmissible();
      await insertNativeRun(own, { nativeIssueId: null, contextSnapshot: { issueId: own.issueId, repoUrl: "https://github.com/TEA-Core/records" } });
      expect((await close(own.identifier)).status).toBe(422);
    });

    it("scopes run events to the company and refuses an event flood before reading it", async () => {
      const other = await seedNoWorkspace();
      const fixture = await seedAdmissible();
      const runId = await insertNativeRun(fixture, {});
      await db.insert(heartbeatRunEvents).values({
        companyId: other.companyId, runId, agentId: other.closerAgentId, seq: 1, eventType: "log",
        message: "pushed https://github.com/TEA-Core/records/pull/12",
      });
      expect((await close(fixture.identifier)).status).toBe(200);

      const flooded = await seedAdmissible();
      const floodRun = await insertNativeRun(flooded, {});
      await db.execute(sql`insert into heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, message)
        select ${flooded.companyId}, ${floodRun}, ${flooded.closerAgentId}, g, 'log', 'tick' from generate_series(1, 2001) g`);
      const refused = await close(flooded.identifier);
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(await statusOf(flooded.issueId)).toBe("in_progress");
    });

    it("renders quoted reserved and mixed-case catalog tables, and scans them when attributed", async () => {
      try {
        await db.execute(sql`create table "Census Mixed" (company_id uuid, issue_id uuid, "order" text)`);
        const clean = await seedAdmissible();
        await db.execute(sql`insert into "Census Mixed" values (${clean.companyId}, ${clean.issueId}, 'Decision only.')`);
        expect((await close(clean.identifier)).status).toBe(200);
        const cited = await seedAdmissible();
        await db.execute(sql`insert into "Census Mixed" values (${cited.companyId}, ${cited.issueId}, 'https://github.com/TEA-Core/records/pull/12')`);
        expect((await close(cited.identifier)).status).toBe(422);
      } finally {
        await db.execute(sql`drop table if exists "Census Mixed"`);
      }
    });

    it("looks up 22,000 identities without exceeding the parameter limit and still finds a real project", async () => {
      try {
        await db.execute(sql`create table task_census_probe (company_id uuid, issue_id uuid, note text)`);
        const clean = await seedAdmissible();
        await db.execute(sql`insert into task_census_probe
          select ${clean.companyId}, ${clean.issueId}, string_agg(gen_random_uuid()::text, ' ') from generate_series(1, 22000)`);
        const ok = await close(clean.identifier);
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        const hit = await seedAdmissible();
        const projectId = await insertProject(hit.companyId);
        await db.execute(sql`insert into task_census_probe
          select ${hit.companyId}, ${hit.issueId}, string_agg(u, ' ') from (
            select gen_random_uuid()::text as u from generate_series(1, 21999) union all select ${projectId}::text) t`);
        expect((await close(hit.identifier)).status).toBe(422);
      } finally {
        await db.execute(sql`drop table if exists task_census_probe`);
      }
    });

    it("lets explicit peer ownership beat soft and activity references, and keeps own matches", async () => {
      try {
        await db.execute(sql`create table task_census_probe (company_id uuid, issue_id uuid, scope_key text, note text)`);
        const citation = "https://github.com/TEA-Core/records/pull/12";
        const soft = await seedAdmissible();
        const [peer] = await db.insert(issues).values({ companyId: soft.companyId, title: "Peer", status: "in_progress" }).returning({ id: issues.id });
        await db.execute(sql`insert into task_census_probe values (${soft.companyId}, ${peer!.id}, ${soft.issueId}, ${citation})`);
        expect((await close(soft.identifier)).status).toBe(200);
        const own = await seedAdmissible();
        const [peer2] = await db.insert(issues).values({ companyId: own.companyId, title: "Peer", status: "in_progress" }).returning({ id: issues.id });
        await db.execute(sql`insert into task_census_probe values (${own.companyId}, ${own.issueId}, ${peer2!.id}, ${citation})`);
        expect((await close(own.identifier)).status).toBe(422);

        const activity = await seedAdmissible();
        const [peer3] = await db.insert(issues).values({ companyId: activity.companyId, title: "Peer", status: "in_progress" }).returning({ id: issues.id });
        const runId = await insertNativeRun(activity, {});
        await db.insert(activityLog).values({
          companyId: activity.companyId, actorType: "agent", actorId: activity.closerAgentId, agentId: activity.closerAgentId,
          runId, action: "issue.updated", entityType: "issue", entityId: peer3!.id,
          details: { note: citation },
        });
        expect((await close(activity.identifier)).status).toBe(200);
      } finally {
        await db.execute(sql`drop table if exists task_census_probe`);
      }
    });

    it("refuses an oversized attributed row instead of transferring it", async () => {
      try {
        await db.execute(sql`create table task_census_probe (company_id uuid, issue_id uuid, note text)`);
        const fixture = await seedAdmissible();
        await db.execute(sql`insert into task_census_probe values (${fixture.companyId}, ${fixture.issueId}, repeat('a', 2097152))`);
        const res = await close(fixture.identifier);
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(JSON.stringify(res.body)).toContain("scan size budget");
      } finally {
        await db.execute(sql`drop table if exists task_census_probe`);
      }
    });

    it("does not re-count rows from earlier attribution rounds against the card byte budget", async () => {
      try {
        await db.execute(sql`create table task_census_probe_a (company_id uuid, issue_id uuid, run_id uuid, note text)`);
        await db.execute(sql`create table task_census_probe_b (company_id uuid, run_id uuid, note text)`);
        const fixture = await seedAdmissible();
        const runId = randomUUID();
        // Round 0: 17 direct rows (~16.1 MiB). Round 1 re-selects them and adds one new run-linked row
        // from a later table. Distinct evidence (~17 MiB) fits the 32 MiB budget; double counting does not.
        await db.execute(sql`insert into task_census_probe_a
          select ${fixture.companyId}, ${fixture.issueId}, ${runId}::uuid, repeat('lorem ipsum ', 83000) from generate_series(1, 17)`);
        await db.execute(sql`insert into task_census_probe_b values (${fixture.companyId}, ${runId}::uuid, repeat('lorem ipsum ', 83000))`);
        const res = await close(fixture.identifier);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      } finally {
        await db.execute(sql`drop table if exists task_census_probe_a`);
        await db.execute(sql`drop table if exists task_census_probe_b`);
      }
    });

    it("closes a parentless card whose issue.created_without_parent row sits beside a complete creation snapshot", async () => {
      const fixture = await seedAdmissible();
      await db.insert(activityLog).values({
        companyId: fixture.companyId,
        actorType: "agent",
        actorId: fixture.closerAgentId,
        action: "issue.created_without_parent",
        entityType: "issue",
        entityId: fixture.issueId,
        details: { issueId: fixture.issueId, identifier: fixture.identifier, projectId: null, actorAgentId: fixture.closerAgentId, hasParent: false },
      });

      const res = await close(fixture.identifier);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await statusOf(fixture.issueId)).toBe("done");
    });

    it("closes a parentless card with no creation snapshot when the project is still null", async () => {
      const fixture = await seedAdmissible({ omitCreationSnapshot: true });
      await db.insert(activityLog).values({
        companyId: fixture.companyId,
        actorType: "agent",
        actorId: fixture.closerAgentId,
        action: "issue.created_without_parent",
        entityType: "issue",
        entityId: fixture.issueId,
        details: { issueId: fixture.issueId, identifier: fixture.identifier, projectId: null },
      });
      const res = await close(fixture.identifier);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
    it("refuses a citation planted in a cost event, a task session, or a wakeup payload", async () => {
      const fixture = await seedAdmissible();
      await db.insert(costEvents).values({
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        agentId: fixture.closerAgentId,
        provider: "anthropic",
        model: "test",
        costCents: 1,
        occurredAt: new Date(),
        billingCode: "https://github.com/TEA-Core/records/pull/12",
      });
      expect((await close(fixture.identifier)).status).toBe(422);
    });

    it("refuses a task session whose params cite a repository", async () => {
      const fixture = await seedAdmissible();
      await db.insert(agentTaskSessions).values({
        companyId: fixture.companyId,
        agentId: fixture.closerAgentId,
        adapterType: "codex_local",
        taskKey: fixture.issueId,
        sessionParamsJson: { repoUrl: "https://github.com/TEA-Core/records" },
      });
      expect((await close(fixture.identifier)).status).toBe(422);
    });

    it("refuses a wakeup payload that names the card and a repository", async () => {
      const fixture = await seedAdmissible();
      await db.insert(agentWakeupRequests).values({
        companyId: fixture.companyId,
        agentId: fixture.closerAgentId,
        source: "assignment",
        payload: { issueId: fixture.issueId, repoUrl: "https://github.com/TEA-Core/records" },
      });
      expect((await close(fixture.identifier)).status).toBe(422);
    });

    it.each(["run-reference", "soft-reference", "opaque-value", "comment-metadata"] as const)(
      "refuses the schema-census admission: %s",
      async (shape) => {
        const fixture = await seedAdmissible();
        try {
          if (shape === "run-reference") {
            const runId = await insertNativeRun(fixture, {});
            await db.execute(sql`create table task_census_probe (
              company_id uuid, heartbeat_run_id uuid references heartbeat_runs(id), payload jsonb
            )`);
            await db.execute(sql`insert into task_census_probe values (
              ${fixture.companyId}, ${runId}, ${JSON.stringify({ evidence: "https://github.com/TEA-Core/records/pull/12" })}::jsonb
            )`);
          } else if (shape === "soft-reference") {
            await db.execute(sql`create table task_census_probe (company_id uuid, scope_key text, payload jsonb)`);
            await db.execute(sql`insert into task_census_probe values (
              ${fixture.companyId}, ${fixture.issueId}, ${JSON.stringify({ evidence: "https://github.com/TEA-Core/records/pull/12" })}::jsonb
            )`);
          } else if (shape === "opaque-value") {
            await db.execute(sql`create table task_census_probe (
              company_id uuid, issue_id uuid references issues(id), payload bytea
            )`);
            await db.execute(sql`insert into task_census_probe values (
              ${fixture.companyId}, ${fixture.issueId}, decode('deadbeef', 'hex')
            )`);
          } else {
            await db.insert(issueComments).values({
              companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.closerAgentId,
              body: "Decision only.",
              metadata: { version: 1, sections: [], authorizationReason: "https://github.com/TEA-Core/records/pull/12" },
            });
          }
          const result = await close(fixture.identifier);
          expect(result.status, `${shape}: ${JSON.stringify(result.body)}`).toBe(422);
          expect(await statusOf(fixture.issueId)).toBe("in_progress");
        } finally {
          await db.execute(sql`drop table if exists task_census_probe`);
        }
      },
    );

    it.each([
      "clean", "other-card", "other-company", "indexed-json", "nested-indexed-json", "actor", "old-actor",
      "run-array", "propagated-run", "numeric-column", "identity-value", "other-card-on-run", "null-opaque",
    ] as const)("applies catalog attribution and drift controls: %s", async (shape) => {
      const fixture = await seedAdmissible();
      const citation = "https://github.com/TEA-Core/records/pull/12";
      try {
        if (shape === "indexed-json" || shape === "nested-indexed-json") {
          await db.execute(sql`create table task_census_probe (company_id uuid, payload jsonb, later_text text)`);
          if (shape === "nested-indexed-json") {
            await db.execute(sql`create index task_census_probe_json on task_census_probe (((payload -> 'nested') ->> 'cardToken'))`);
          } else {
            await db.execute(sql`create index task_census_probe_json on task_census_probe ((payload ->> 'cardToken'))`);
          }
          const payload = shape === "nested-indexed-json"
            ? { nested: { cardToken: fixture.identifier } }
            : { cardToken: fixture.issueId };
          await db.execute(sql`insert into task_census_probe values (
            ${fixture.companyId}, ${JSON.stringify(payload)}::jsonb, ${citation}
          )`);
        } else if (shape === "actor" || shape === "old-actor") {
          await db.execute(sql`create table task_census_probe (
            company_id uuid, holder uuid references agents(id), created_at timestamptz, payload jsonb
          )`);
          const offsetSeconds = shape === "old-actor" ? -1 : 1;
          await db.execute(sql`insert into task_census_probe
            select ${fixture.companyId}::uuid, ${fixture.closerAgentId}::uuid,
              created_at + ${offsetSeconds} * interval '1 second',
              ${JSON.stringify({ card: fixture.issueId, evidence: citation })}::jsonb
            from issues where id = ${fixture.issueId}::uuid
          `);
        } else if (shape === "run-array") {
          const runId = await insertNativeRun(fixture, {});
          await db.execute(sql`create table task_census_probe (company_id uuid, source_run_ids uuid[], payload jsonb)`);
          await db.execute(sql`insert into task_census_probe values (
            ${fixture.companyId}, array[${runId}::uuid], ${JSON.stringify({ evidence: citation })}::jsonb
          )`);
        } else if (shape === "propagated-run") {
          const runId = await insertNativeRun(fixture, { nativeIssueId: null, contextSnapshot: {} });
          await db.execute(sql`create table task_census_links (
            company_id uuid, issue_id uuid references issues(id), run_ref uuid references heartbeat_runs(id)
          )`);
          await db.execute(sql`create table task_census_probe (
            company_id uuid, owner uuid references heartbeat_runs(id), payload jsonb
          )`);
          await db.execute(sql`insert into task_census_links values (${fixture.companyId}, ${fixture.issueId}, ${runId})`);
          await db.execute(sql`insert into task_census_probe values (
            ${fixture.companyId}, ${runId}, ${JSON.stringify({ evidence: citation })}::jsonb
          )`);
        } else if (shape === "numeric-column") {
          await db.execute(sql`create table task_census_probe (company_id uuid, issue_id uuid, pull_request_number integer)`);
          await db.execute(sql`insert into task_census_probe values (${fixture.companyId}, ${fixture.issueId}, 12)`);
        } else if (shape === "identity-value") {
          const projectId = await insertProject(fixture.companyId);
          await db.execute(sql`create table task_census_probe (company_id uuid, issue_id uuid, note uuid)`);
          await db.execute(sql`insert into task_census_probe values (${fixture.companyId}, ${fixture.issueId}, ${projectId})`);
        } else if (shape === "other-card-on-run") {
          const runId = await insertNativeRun(fixture, {});
          const [peer] = await db.insert(issues).values({
            companyId: fixture.companyId, title: "Another card", status: "in_progress",
          }).returning({ id: issues.id });
          await db.execute(sql`create table task_census_probe (
            company_id uuid, issue_id uuid references issues(id),
            run_ref uuid references heartbeat_runs(id), payload jsonb
          )`);
          await db.execute(sql`insert into task_census_probe values (
            ${fixture.companyId}, ${peer!.id}, ${runId}, ${JSON.stringify({ evidence: citation })}::jsonb
          )`);
        } else if (shape === "null-opaque") {
          await db.execute(sql`create table task_census_probe (
            company_id uuid, issue_id uuid references issues(id), payload bytea
          )`);
          await db.execute(sql`insert into task_census_probe values (${fixture.companyId}, ${fixture.issueId}, null)`);
        } else {
          const other = shape === "other-card" || shape === "other-company" ? await seedAdmissible() : fixture;
          await db.execute(sql`create table task_census_probe (company_id uuid, issue_id uuid, later_text text)`);
          await db.execute(sql`insert into task_census_probe values (
            ${shape === "other-company" ? other.companyId : fixture.companyId},
            ${shape === "other-card" ? other.issueId : fixture.issueId},
            ${shape === "clean" ? "Decision only." : citation}
          )`);
        }
        currentActor = fixture.actor;
        const result = await close(fixture.identifier);
        const allowed = ["clean", "other-card", "other-company", "old-actor", "other-card-on-run", "null-opaque"].includes(shape);
        expect(result.status, `${shape}: ${JSON.stringify(result.body)}`).toBe(allowed ? 200 : 422);
        expect(await statusOf(fixture.issueId)).toBe(allowed ? "done" : "in_progress");
      } finally {
        await db.execute(sql`drop table if exists task_census_probe`);
        await db.execute(sql`drop table if exists task_census_links`);
      }
    });

    it("scans a newly added document column instead of exempting dedicated document reads", async () => {
      const fixture = await seedAdmissible();
      try {
        await db.execute(sql`alter table documents add column census_extra text`);
        await db.execute(sql`update documents set census_extra = 'https://github.com/TEA-Core/records/pull/12'
          where id = ${fixture.rulingId}`);
        const result = await close(fixture.identifier);
        expect(result.status, JSON.stringify(result.body)).toBe(422);
        expect(await statusOf(fixture.issueId)).toBe("in_progress");
      } finally {
        await db.execute(sql`alter table documents drop column census_extra`);
      }
    });

    it("scans a soft-linked activity row even when its entity type is not issue", async () => {
      const fixture = await seedAdmissible();
      await db.insert(activityLog).values({
        companyId: fixture.companyId, actorType: "system", actorId: "evidence-test",
        action: "test.evidence", entityType: "agent", entityId: fixture.issueId,
        details: { evidence: "https://github.com/TEA-Core/records/pull/12" },
      });
      const result = await close(fixture.identifier);
      expect(result.status, JSON.stringify(result.body)).toBe(422);
      expect(await statusOf(fixture.issueId)).toBe("in_progress");
    });

    it("closes a comment that only uses the word gerrit", async () => {
      const fixture = await seedAdmissible();
      await db.insert(issueComments).values({
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        authorAgentId: fixture.closerAgentId,
        body: "This card does not use gerrit.",
      });
      expect((await close(fixture.identifier)).status).toBe(200);
    });

    it("closes a comment that links an unknown host with an ordinary path", async () => {
      const fixture = await seedAdmissible();
      await db.insert(issueComments).values({
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        authorAgentId: fixture.closerAgentId,
        body: "Policy: https://example.org/policies/retention",
      });
      expect((await close(fixture.identifier)).status).toBe(200);
    });

    it("refuses pull request #12, merge request 4, and a sourcehut URL", async () => {
      for (const body of ["Opened pull request #12.", "Opened merge request 4.", "Mirrored https://sr.ht/~team/records"]) {
        const fixture = await seedAdmissible();
        await db.insert(issueComments).values({
          companyId: fixture.companyId,
          issueId: fixture.issueId,
          authorAgentId: fixture.closerAgentId,
          body,
        });
        expect((await close(fixture.identifier)).status, body).toBe(422);
      }
    });

    it("refuses a ruling author whose membership is not active, and one whose membership is in another company", async () => {
      const suspended = await seedAdmissible();
      await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.companyId, suspended.companyId));
      expect((await close(suspended.identifier)).status).toBe(422);

      const other = await seedAdmissible();
      const elsewhere = randomUUID();
      await db.insert(companies).values({ id: elsewhere, name: "Other", issuePrefix: `OTH${elsewhere.slice(0, 4)}`, issueCounter: 1, requireBoardApprovalForNewAgents: false });
      await db.update(companyMemberships).set({ companyId: elsewhere }).where(eq(companyMemberships.companyId, other.companyId));
      expect((await close(other.identifier)).status).toBe(422);
    });

    it("closes after checkout and after a preflight-blocked audit row", async () => {
      const checkedOut = await seedAdmissible();
      await db.insert(activityLog).values({
        companyId: checkedOut.companyId,
        actorType: "agent",
        actorId: checkedOut.closerAgentId,
        action: "issue.checked_out",
        entityType: "issue",
        entityId: checkedOut.issueId,
        details: { agentId: checkedOut.closerAgentId },
      });
      expect((await close(checkedOut.identifier)).status).toBe(200);

      const blocked = await seedAdmissible();
      await db.insert(activityLog).values({
        companyId: blocked.companyId,
        actorType: "system",
        actorId: "heartbeat",
        action: "issue.workspace_preflight_blocked",
        entityType: "issue",
        entityId: blocked.issueId,
        details: { hasResolvablePriorSessionWorkspace: false },
      });
      expect((await close(blocked.identifier)).status).toBe(200);
    });


    it("refuses a never-had close when a later update rewrites the description without a recorded old value", async () => {
      const fixture = await seedAdmissible();
      await insertCreationSnapshot(fixture, "Decide the retention policy.");
      await db.insert(activityLog).values({
        companyId: fixture.companyId,
        actorType: "agent",
        actorId: fixture.closerAgentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: fixture.issueId,
        details: { changes: { description: { to: "Decide the retention policy." } } },
      });

      await expectRefused(fixture, await close(fixture.identifier), REWRITE_WITHOUT_OLD_VALUE);
    });

    it("refuses a never-had close when a plugin-host patch rewrites the description without a recorded old value", async () => {
      const fixture = await seedAdmissible();
      await insertCreationSnapshot(fixture, "Decide the retention policy.");
      await db.insert(activityLog).values({
        companyId: fixture.companyId,
        actorType: "agent",
        actorId: fixture.closerAgentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: fixture.issueId,
        details: { patch: { description: "Decide the retention policy." } },
      });

      await expectRefused(fixture, await close(fixture.identifier), REWRITE_WITHOUT_OLD_VALUE);
    });

    async function insertLinkedRun(fixture: NoWorkspaceIssue, values: Record<string, unknown>) {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: fixture.companyId,
        agentId: fixture.closerAgentId,
        status: "succeeded",
        nativeIssueId: fixture.issueId,
        contextSnapshot: { issueId: fixture.issueId },
        ...values,
      }).returning({ id: heartbeatRuns.id });
      return run!.id;
    }

    it.each([
      ["a truncated stdout excerpt that names a workspace key and loses the value", async (fixture: NoWorkspaceIssue) => {
        await insertLinkedRun(fixture, { stdoutExcerpt: "{\"executionWorkspaceId\":\"" });
      }],
      ["an escaped-quote stdout excerpt that names a workspace", async (fixture: NoWorkspaceIssue) => {
        await insertLinkedRun(fixture, { stdoutExcerpt: "{\\\"executionWorkspaceId\\\":\\\"ew-1\\\",\\\"cwd\\\":\\\"/x" });
      }],
      ["an object-valued executionWorkspaceId in run context", async (fixture: NoWorkspaceIssue) => {
        await insertLinkedRun(fixture, { contextSnapshot: { issueId: fixture.issueId, executionWorkspaceId: { id: randomUUID() } } });
      }],
      ["a prefixed paperclipExecutionWorkspaceId key", async (fixture: NoWorkspaceIssue) => {
        await insertLinkedRun(fixture, { contextSnapshot: { issueId: fixture.issueId, paperclipExecutionWorkspaceId: randomUUID() } });
      }],
      ["runner_profile_json naming a workspace", async (fixture: NoWorkspaceIssue) => {
        await insertLinkedRun(fixture, { runnerProfileJson: { executionWorkspaceId: randomUUID(), repoUrl: "https://github.com/TEA-Core/records" } });
      }],
      ["log_ref naming a workspace path", async (fixture: NoWorkspaceIssue) => {
        await insertLinkedRun(fixture, { logRef: "executionWorkspaceId=/srv/worktrees/card" });
      }],
      ["trigger_detail citing a pull URL", async (fixture: NoWorkspaceIssue) => {
        await insertLinkedRun(fixture, { triggerDetail: "opened https://github.com/TEA-Core/records/pull/12" });
      }],
      ["a run event message citing a pull URL", async (fixture: NoWorkspaceIssue) => {
        const runId = await insertLinkedRun(fixture, {});
        await db.insert(heartbeatRunEvents).values({
          companyId: fixture.companyId,
          runId,
          agentId: fixture.closerAgentId,
          seq: 1,
          eventType: "log",
          message: "pushed https://github.com/TEA-Core/records/pull/12",
          payload: { executionWorkspaceId: randomUUID() },
        });
      }],
      ["an issue delivery receipt naming a pull request", async (fixture: NoWorkspaceIssue) => {
        await db.insert(issueDeliveryReceipts).values({
          companyId: fixture.companyId,
          sourceIssueId: fixture.issueId,
          provider: "github",
          owner: "TEA-Core",
          repo: "records",
          pullRequestNumber: 12,
          headSha: "3f9c1e0a25b84d7c9e1f2a3b4c5d6e7f8a9b0c1d",
          branchName: "feature/records",
          recoveryReason: "existing pull request",
          authorizedByActorType: "board",
          authorizedByActorId: BOARD_USER_ID,
          idempotencyKey: randomUUID(),
        });
      }],
      ["billingCode set to a pull URL", async (fixture: NoWorkspaceIssue) => {
        await db.update(issues).set({ billingCode: "https://github.com/TEA-Core/records/pull/12" }).where(eq(issues.id, fixture.issueId));
      }],
      ["executionPolicy.baseRef set to a branch", async (fixture: NoWorkspaceIssue) => {
        await db.update(issues).set({ executionPolicy: { baseRef: "feature/records" } }).where(eq(issues.id, fixture.issueId));
      }],
      ["a comment citing pull request 12", async (fixture: NoWorkspaceIssue) => {
        await db.insert(issueComments).values({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.closerAgentId, body: "Opened pull request 12 for the records repo." });
      }],
      ["a comment citing merge request !4", async (fixture: NoWorkspaceIssue) => {
        await db.insert(issueComments).values({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.closerAgentId, body: "Opened merge request !4." });
      }],
      ["a comment citing a Gerrit URL", async (fixture: NoWorkspaceIssue) => {
        await db.insert(issueComments).values({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.closerAgentId, body: "Reviewed https://gerrit.example.com/c/records/+/12345" });
      }],
      ["a comment citing a self-hosted clone URL", async (fixture: NoWorkspaceIssue) => {
        await db.insert(issueComments).values({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.closerAgentId, body: "Cloned https://git.company.internal/org/records.git" });
      }],
      ["a comment citing a sourcehut URL", async (fixture: NoWorkspaceIssue) => {
        await db.insert(issueComments).values({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.closerAgentId, body: "Mirrored https://git.sr.ht/~tea/records" });
      }],
    ] as const)("refuses a never-had close after %s", async (_label, shape) => {
      const fixture = await seedAdmissible();
      await shape(fixture);
      const res = await close(fixture.identifier);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(await statusOf(fixture.issueId)).toBe("in_progress");
    });

    it("closes a card whose title starts with [ and whose description starts with {", async () => {
      const fixture = await seedAdmissible();
      await db.update(activityLog).set({
        details: {
          title: "[Routine] weekly check",
          identifier: fixture.identifier,
          projectId: null,
          projectWorkspaceId: null,
          description: "{weekly} notes",
        },
      }).where(and(eq(activityLog.entityId, fixture.issueId), eq(activityLog.action, "issue.created")));
      const res = await close(fixture.identifier);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await statusOf(fixture.issueId)).toBe("done");
    });

    it("refuses a never-had close after a board agent-delete erases a run that named a workspace and left no comment or activity", async () => {
      const fixture = await seedAdmissible();
      const helperId = await insertAgent(fixture.companyId, "Helper");
      await db.insert(heartbeatRuns).values({
        companyId: fixture.companyId,
        agentId: helperId,
        status: "succeeded",
        nativeIssueId: fixture.issueId,
        contextSnapshot: { executionWorkspaceId: randomUUID() },
      });
      await agentService(db).remove(helperId);
      const res = await close(fixture.identifier);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(await statusOf(fixture.issueId)).toBe("in_progress");
    });

    it("refuses a never-had close after a board agent-delete erases a pull-URL comment", async () => {
      const fixture = await seedAdmissible();
      const helperId = await insertAgent(fixture.companyId, "Helper");
      await db.insert(issueComments).values({
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        authorAgentId: helperId,
        body: "Landed in https://github.com/TEA-Core/records/pull/12",
      });
      await agentService(db).remove(helperId);
      const res = await close(fixture.identifier);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(await statusOf(fixture.issueId)).toBe("in_progress");
    });

    it.each([
      ["has a project", { withProject: true }],
      ["has a project workspace", { withProjectWorkspace: true }],
    ] as const)("keeps today's refusal for a card that %s", async (_label, options) => {
      const fixture = await seedNoWorkspace(options);
      await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });

      await expectRefused(fixture, await close(fixture.identifier), NO_WORKSPACE_REFUSAL);
    });

    it("keeps refusing a repository_delivery card with no workspace", async () => {
      const fixture = await seedNoWorkspace({ deliveryRequirement: "repository_delivery" });
      await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });

      const res = await close(fixture.identifier);

      await expectRefused(fixture, res, `Tier 1 "no-repository-landing" is accepted only on a record_only issue.`);
      expect(res.body.details.remedy).toContain("authorized board user");
    });

    it("keeps refusing a card bound to an execution workspace it does not own", async () => {
      const fixture = await seedNoWorkspace();
      await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
      const { workspaceId } = await insertWorkspace(fixture.companyId);
      await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, fixture.issueId));

      await expectRefused(
        fixture,
        await close(fixture.identifier),
        `Tier 1 "no-repository-landing" requires an execution workspace this issue owns in this company.`,
      );
    });

    // Each record on its own: removing any one of these checks admits a card
    // that had a workspace.
    it.each([
      ["an owned workspace that was closed", async (fixture: NoWorkspaceIssue) => {
        await insertWorkspace(fixture.companyId, { sourceIssueId: fixture.issueId, status: "closed" });
      }],
      ["an owned workspace that was archived", async (fixture: NoWorkspaceIssue) => {
        await insertWorkspace(fixture.companyId, { sourceIssueId: fixture.issueId, status: "archived" });
      }],
      ["an owned workspace whose cleanup failed", async (fixture: NoWorkspaceIssue) => {
        await insertWorkspace(fixture.companyId, { sourceIssueId: fixture.issueId, status: "cleanup_failed" });
      }],
      ["a provisioning operation that named a workspace", async (fixture: NoWorkspaceIssue) => {
        const { workspaceId } = await insertWorkspace(fixture.companyId);
        await db.insert(workspaceOperations).values({
          companyId: fixture.companyId,
          executionWorkspaceId: workspaceId,
          issueId: fixture.issueId,
          phase: "worktree_prepare",
          status: "succeeded",
        });
      }],
      ["a run whose context named a workspace that no longer exists", async (fixture: NoWorkspaceIssue) => {
        await db.insert(heartbeatRuns).values({
          companyId: fixture.companyId,
          agentId: fixture.closerAgentId,
          status: "succeeded",
          contextSnapshot: { issueId: fixture.issueId, executionWorkspaceId: randomUUID() },
        });
      }],
      ["an audit row of a workspace bind that was later undone", async (fixture: NoWorkspaceIssue) => {
        await db.insert(activityLog).values({
          companyId: fixture.companyId,
          actorType: "agent",
          actorId: fixture.closerAgentId,
          action: "issue.updated",
          entityType: "issue",
          entityId: fixture.issueId,
          details: { changes: { executionWorkspaceId: { from: randomUUID(), to: null } } },
        });
      }],
      ["a work product recorded against a workspace", async (fixture: NoWorkspaceIssue) => {
        const { workspaceId } = await insertWorkspace(fixture.companyId);
        await db.insert(issueWorkProducts).values({
          companyId: fixture.companyId,
          issueId: fixture.issueId,
          executionWorkspaceId: workspaceId,
          type: "document",
          provider: "paperclip",
          title: "Notes",
          status: "active",
        });
      }],
    ] as const)("keeps today's refusal for a card with %s", async (_label, record) => {
      const fixture = await seedAdmissible();
      await record(fixture);

      await expectRefused(fixture, await close(fixture.identifier), NO_WORKSPACE_REFUSAL);
    });

    it("refuses a card with a workspace operation on a run linked only through an unindexed context key, naming the census evidence", async () => {
      const fixture = await seedAdmissible();
      const { workspaceId } = await insertWorkspace(fixture.companyId);
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: fixture.companyId,
        agentId: fixture.closerAgentId,
        status: "succeeded",
        contextSnapshot: { wake: { "issue-ref": fixture.issueId } },
      }).returning({ id: heartbeatRuns.id });
      await db.insert(workspaceOperations).values({
        companyId: fixture.companyId,
        executionWorkspaceId: workspaceId,
        heartbeatRunId: run.id,
        phase: "worktree_prepare",
        status: "succeeded",
      });

      await expectRefused(
        fixture,
        await close(fixture.identifier),
        `Tier 1 "no-repository-landing" cannot be declared on an issue whose workspace_operations row carries unread workspace or repository evidence (a project or workspace reference).`,
      );
    });

    it("keeps today's refusal for a card whose holder detached its own workspace and project", async () => {
      const fixture = await seed();
      await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });

      const detach = await request(app)
        .patch(`/api/issues/${fixture.identifier}`)
        .send({ executionWorkspaceId: null, projectWorkspaceId: null, projectId: null });
      expect(detach.status, JSON.stringify(detach.body)).toBe(200);
      const detached = await db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]!);
      expect(detached).toMatchObject({ projectId: null, projectWorkspaceId: null, executionWorkspaceId: null });

      const res = await close(fixture.identifier);

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toBe(NO_WORKSPACE_REFUSAL);
      expect(await statusOf(fixture.issueId)).toBe("in_progress");
    });

    it.each([
      ["mentions a GitHub pull request", async (fixture: NoWorkspaceIssue) => {
        const [object] = await db
          .insert(externalObjects)
          .values({
            companyId: fixture.companyId,
            providerKey: "github",
            objectType: "pull_request",
            externalId: "TEA-Core/other#pull/77",
            data: { state: "open" },
          })
          .returning({ id: externalObjects.id });
        await db.insert(externalObjectMentions).values({
          companyId: fixture.companyId,
          sourceIssueId: fixture.issueId,
          sourceKind: "comment",
          objectId: object!.id,
          providerKey: "github",
          objectType: "pull_request",
        });
      }, `Tier 1 "no-repository-landing" cannot be declared on an issue that mentions an external object (github pull_request).`],
      ["records a pull request work product", async (fixture: NoWorkspaceIssue) => {
        await insertPullRequestProduct(fixture);
      }, `Tier 1 "no-repository-landing" cannot be declared on an issue that records a repository work product (pull_request).`],
    ] as const)("refuses a card that %s", async (_label, link, expected) => {
      const fixture = await seedAdmissible();
      await link(fixture);

      await expectRefused(fixture, await close(fixture.identifier), expected);
    });

    it.each([
      ["no ruling", async (_fixture: NoWorkspaceIssue) => {}, `Tier 1 "no-repository-landing" requires a non-empty "entry-ruling" document on this issue.`],
      ["a ruling the closer wrote", async (fixture: NoWorkspaceIssue) => {
        await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.closerAgentId });
      }, `Tier 1 "no-repository-landing" requires an "entry-ruling" document written by someone other than the closing actor; the closer wrote at least one revision of it.`],
      ["a placeholder ruling", async (fixture: NoWorkspaceIssue) => {
        await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId, body: "TODO" });
      }, `Tier 1 "no-repository-landing" requires an "entry-ruling" document that states a ruling; this one is a placeholder (it opens with the placeholder "todo").`],
    ] as const)("refuses a card with %s", async (_label, rule, expected) => {
      const fixture = await seedNoWorkspace();
      await rule(fixture);

      await expectRefused(fixture, await close(fixture.identifier), expected);
    });

    it("refuses a declaration that names another card", async () => {
      const fixture = await seedAdmissible();

      const res = await close(fixture.identifier, { ...NO_REPOSITORY_DONE_TIER, reason: "Settled together with OTHER-7" });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toContain("the declaration names another card (OTHER-7)");
      expect(await statusOf(fixture.issueId)).toBe("in_progress");
    });

    it("does not let an agent that does not hold the card close it", async () => {
      const fixture = await seedAdmissible();
      const outsiderId = await insertAgent(fixture.companyId, "Outsider");
      currentActor = { type: "agent", agentId: outsiderId, companyId: fixture.companyId, source: "agent_key" } as Express.Request["actor"];

      const res = await close(fixture.identifier);

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(await statusOf(fixture.issueId)).toBe("in_progress");
    });

    it("refuses a close request that also attaches a project", async () => {
      const fixture = await seedAdmissible();
      const projectId = await insertProject(fixture.companyId);

      const res = await request(app)
        .patch(`/api/issues/${fixture.identifier}`)
        .send({ status: "done", doneTier: NO_REPOSITORY_DONE_TIER, projectId });

      await expectRefused(fixture, res, `Tier 1 "no-repository-landing" cannot ride a request that changes the issue's project.`);
    });

    it.each([
      ["the card is bound to a workspace", async (fixture: NoWorkspaceIssue) => {
        const { workspaceId } = await insertWorkspace(fixture.companyId);
        await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, fixture.issueId));
      }, `Tier 1 "no-repository-landing" refused: the issue's execution workspace changed after the declaration was checked.`],
      ["the card gains a project", async (fixture: NoWorkspaceIssue) => {
        const projectId = await insertProject(fixture.companyId);
        await db.update(issues).set({ projectId }).where(eq(issues.id, fixture.issueId));
      }, `Tier 1 "no-repository-landing" refused: the issue's workspace binding changed after the close was measured.`],
      ["a run provisions a workspace for the card", async (fixture: NoWorkspaceIssue) => {
        await insertWorkspace(fixture.companyId, { sourceIssueId: fixture.issueId });
      }, NO_WORKSPACE_REFUSAL],
      ["the board revises the ruling", async (fixture: NoWorkspaceIssue) => {
        const [document] = await db
          .select({ id: issueDocuments.documentId })
          .from(issueDocuments)
          .where(eq(issueDocuments.issueId, fixture.issueId));
        await db.update(documents).set({ latestRevisionNumber: 2, updatedAt: new Date() }).where(eq(documents.id, document!.id));
        await db.insert(documentRevisions).values({
          companyId: fixture.companyId,
          documentId: document!.id,
          revisionNumber: 2,
          body: "Ruling: the deliverable is this decision, restated by the board.",
          createdByUserId: BOARD_USER_ID,
        });
      }, `Tier 1 "no-repository-landing" refused: the "entry-ruling" document changed after the close was measured.`],
    ] as const)("refuses at the status write when %s after the measurement", async (_label, mutate, expected) => {
      const fixture = await seedAdmissible();
      mockMeasureNoRepositoryLanding.mockImplementation(async (...args: Parameters<typeof measureNoRepositoryLandingForClose>) => {
        const verdict = await realMeasureNoRepositoryLandingRef.current!(...args);
        expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
        await mutate(fixture);
        return verdict;
      });

      await expectRefused(fixture, await close(fixture.identifier), expected);
    });

    // ── Round 2: every shape below closed at the first head and is refused
    // now. Each names the check that refuses it.

    function asBoard() {
      currentActor = { type: "board", userId: BOARD_USER_ID, source: "local_implicit" } as Express.Request["actor"];
    }

    async function attachProject(fixture: NoWorkspaceIssue, withProjectWorkspace: boolean) {
      const projectId = await insertProject(fixture.companyId);
      let projectWorkspaceId: string | null = null;
      if (withProjectWorkspace) {
        projectWorkspaceId = randomUUID();
        await db.insert(projectWorkspaces).values({
          id: projectWorkspaceId,
          companyId: fixture.companyId,
          projectId,
          name: "Primary",
          repoUrl: "https://example.invalid/records",
          isPrimary: true,
        });
      }
      await db.update(issues).set({ projectId, projectWorkspaceId }).where(eq(issues.id, fixture.issueId));
    }

    it.each([
      ["the project", false, { projectId: null }],
      ["the project and its project workspace", true, { projectId: null, projectWorkspaceId: null }],
    ] as const)("keeps today's refusal after the holder strips %s in one request and closes in the next", async (_label, withProjectWorkspace, strip) => {
      const fixture = await seedAdmissible();
      await attachProject(fixture, withProjectWorkspace);

      const stripped = await request(app).patch(`/api/issues/${fixture.identifier}`).send(strip);
      expect(stripped.status, JSON.stringify(stripped.body)).toBe(200);
      expect(stripped.body).toMatchObject({ projectId: null, projectWorkspaceId: null, executionWorkspaceId: null });

      await expectRefused(fixture, await close(fixture.identifier), NO_WORKSPACE_REFUSAL);
    });

    it.each([
      ["after the holder also strips its project", true],
      ["on a card that never had a project", false],
    ] as const)("preserves landing debt after a board reclassification from repository_delivery %s", async (_label, hadProject) => {
      const fixture = await seedAdmissible({ deliveryRequirement: "repository_delivery" });
      if (hadProject) await attachProject(fixture, false);
      asBoard();
      const flipped = await request(app)
        .patch(`/api/issues/${fixture.identifier}`)
        .send({ deliveryRequirement: "record_only" });
      expect(flipped.status, JSON.stringify(flipped.body)).toBe(200);
      currentActor = fixture.actor;
      if (hadProject) {
        const stripped = await request(app).patch(`/api/issues/${fixture.identifier}`).send({ projectId: null });
        expect(stripped.status, JSON.stringify(stripped.body)).toBe(200);
      }

      const refused = await close(fixture.identifier);
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.code).toBe("done_transition_missing_delivery");
      expect(await statusOf(fixture.issueId)).toBe("in_progress");
      expect(await activityCount(fixture.issueId, "issue.done_transition_no_repository_landing_verified")).toBe(0);
    });

    it.each([
      ["an environment lease that named a workspace", async (fixture: NoWorkspaceIssue) => {
        const { workspaceId } = await insertWorkspace(fixture.companyId);
        await db.insert(environmentLeases).values({
          companyId: fixture.companyId,
          executionWorkspaceId: workspaceId,
          issueId: fixture.issueId,
          status: "released",
        });
      }],
      ["an audit row that names a project workspace while its executionWorkspaceId is null", async (fixture: NoWorkspaceIssue) => {
        await db.insert(activityLog).values({
          companyId: fixture.companyId,
          actorType: "agent",
          actorId: fixture.closerAgentId,
          action: "issue.updated",
          entityType: "issue",
          entityId: fixture.issueId,
          details: {
            executionWorkspaceId: null,
            workspaceChange: {
              from: { label: "No workspace", projectWorkspaceId: null, executionWorkspaceId: null, mode: null },
              to: { label: "Primary", projectWorkspaceId: randomUUID(), executionWorkspaceId: null, mode: "shared_workspace" },
            },
          },
        });
      }],
      ["a run whose nested context named an execution workspace", async (fixture: NoWorkspaceIssue) => {
        await db.insert(heartbeatRuns).values({
          companyId: fixture.companyId,
          agentId: fixture.closerAgentId,
          status: "succeeded",
          contextSnapshot: { issueId: fixture.issueId, paperclipWorkspace: { executionWorkspaceId: randomUUID() } },
        });
      }],
      ["a run that ran in a project workspace", async (fixture: NoWorkspaceIssue) => {
        await db.insert(heartbeatRuns).values({
          companyId: fixture.companyId,
          agentId: fixture.closerAgentId,
          status: "succeeded",
          contextSnapshot: {
            paperclipIssue: { id: fixture.issueId },
            paperclipWorkspace: { cwd: "/srv/checkout", projectId: randomUUID(), workspaceId: randomUUID() },
          },
        });
      }],
      ["a runtime service started for it", async (fixture: NoWorkspaceIssue) => {
        await db.insert(workspaceRuntimeServices).values({
          id: randomUUID(),
          companyId: fixture.companyId,
          issueId: fixture.issueId,
          scopeType: "execution_workspace",
          serviceName: "preview",
          status: "stopped",
          lifecycle: "ephemeral",
          provider: "local_process",
        });
      }],
      ["a workspace runtime lease it owned", async (fixture: NoWorkspaceIssue) => {
        const { workspaceId } = await insertWorkspace(fixture.companyId);
        await db.insert(executionWorkspaceRuntimeLeases).values({
          companyId: fixture.companyId,
          executionWorkspaceId: workspaceId,
          ownerKey: `issue:${fixture.issueId}`,
          ownerIssueId: fixture.issueId,
          lastAction: "released",
          expiresAt: new Date(),
        });
      }],
      ["a work product recorded against a project", async (fixture: NoWorkspaceIssue) => {
        const projectId = await insertProject(fixture.companyId);
        await db.insert(issueWorkProducts).values({
          companyId: fixture.companyId,
          projectId,
          issueId: fixture.issueId,
          type: "document",
          provider: "paperclip",
          title: "Notes",
          status: "active",
        });
      }],
    ] as const)("keeps today's refusal for a card with %s", async (_label, record) => {
      const fixture = await seedAdmissible();
      await record(fixture);

      await expectRefused(fixture, await close(fixture.identifier), NO_WORKSPACE_REFUSAL);
    });

    async function insertMention(fixture: NoWorkspaceIssue, providerKey: string, objectType: string, externalId: string) {
      const [object] = await db
        .insert(externalObjects)
        .values({ companyId: fixture.companyId, providerKey, objectType, externalId, data: { state: "merged" } })
        .returning({ id: externalObjects.id });
      await db.insert(externalObjectMentions).values({
        companyId: fixture.companyId,
        sourceIssueId: fixture.issueId,
        sourceKind: "comment",
        objectId: object!.id,
        providerKey,
        objectType,
      });
    }

    async function insertComment(fixture: NoWorkspaceIssue, body: string) {
      await db.insert(issueComments).values({
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        authorAgentId: fixture.closerAgentId,
        body,
      });
    }

    it.each([
      ["a comment that carries a pull request URL with no mention record", async (fixture: NoWorkspaceIssue) => {
        await insertComment(fixture, "Landed in https://github.com/TEA-Core/records/pull/12 earlier today.");
      }, `Tier 1 "no-repository-landing" cannot be declared on an issue whose thread cites repository work (a pull request URL).`],
      ["a comment that carries a GitLab merge request URL", async (fixture: NoWorkspaceIssue) => {
        await insertComment(fixture, "See https://gitlab.example.com/team/records/-/merge_requests/4 for the change.");
      }, `Tier 1 "no-repository-landing" cannot be declared on an issue whose thread cites repository work (a merge request URL).`],
      ["a description that cites a pull request number", async (fixture: NoWorkspaceIssue) => {
        await db.update(issues).set({ description: "Follow-up of PR #77." }).where(eq(issues.id, fixture.issueId));
      }, `Tier 1 "no-repository-landing" cannot be declared on an issue whose thread cites repository work (a pull request number).`],
      ["a pull request mention with a non-canonical external id", async (fixture: NoWorkspaceIssue) => {
        await insertMention(fixture, "github", "pull_request", "records-pr-twelve");
      }, `Tier 1 "no-repository-landing" cannot be declared on an issue that mentions an external object (github pull_request).`],
      ["a GitLab merge request mention", async (fixture: NoWorkspaceIssue) => {
        await insertMention(fixture, "gitlab", "merge_request", "team/records!4");
      }, `Tier 1 "no-repository-landing" cannot be declared on an issue that mentions an external object (gitlab merge_request).`],
      ["a branch work product", async (fixture: NoWorkspaceIssue) => {
        await db.insert(issueWorkProducts).values({
          companyId: fixture.companyId,
          issueId: fixture.issueId,
          type: "branch",
          provider: "github",
          title: "records-ruling",
          status: "active",
        });
      }, `Tier 1 "no-repository-landing" cannot be declared on an issue that records a repository work product (branch).`],
      ["a commit work product", async (fixture: NoWorkspaceIssue) => {
        await db.insert(issueWorkProducts).values({
          companyId: fixture.companyId,
          issueId: fixture.issueId,
          type: "commit",
          provider: "github",
          title: "Record the ruling",
          status: "active",
        });
      }, `Tier 1 "no-repository-landing" cannot be declared on an issue that records a repository work product (commit).`],
    ] as const)("refuses a card with %s", async (_label, record, expected) => {
      const fixture = await seedAdmissible();
      await record(fixture);

      await expectRefused(fixture, await close(fixture.identifier), expected);
    });

    const BOARD_AUTHOR_REFUSAL =
      `Tier 1 "no-repository-landing" requires an "entry-ruling" document whose every revision was written by a board member of this company ` +
      "(an active, non-viewer member) when the issue has no execution workspace.";

    it.each([
      ["a second agent of the company", async (fixture: NoWorkspaceIssue) => {
        await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
      }],
      ["an agent of another company", async (fixture: NoWorkspaceIssue) => {
        const otherCompanyId = await insertCompany(`NWX${seedSequence}`);
        const foreignAgentId = await insertAgent(otherCompanyId, "Foreign");
        await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: foreignAgentId });
      }],
      ["a user who is not a member of the company", async (fixture: NoWorkspaceIssue) => {
        await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorUserId: "outside-user-1" });
      }],
      ["a viewer member of the company", async (fixture: NoWorkspaceIssue) => {
        await db.insert(companyMemberships).values({
          companyId: fixture.companyId,
          principalType: "user",
          principalId: "viewer-user-1",
          status: "active",
          membershipRole: "viewer",
          updatedAt: new Date(),
        });
        await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorUserId: "viewer-user-1" });
      }],
      ["a board user, with a later revision by an agent", async (fixture: NoWorkspaceIssue) => {
        const documentId = await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorUserId: BOARD_USER_ID });
        await db.insert(documentRevisions).values({
          companyId: fixture.companyId,
          documentId,
          revisionNumber: 2,
          body: "Ruling: restated by an agent of the company.",
          createdByAgentId: fixture.rulerAgentId,
        });
      }],
      ["an instance admin who is not a member of the company", async (fixture: NoWorkspaceIssue) => {
        await db.insert(instanceUserRoles).values({ userId: `admin-${fixture.companyId}`, role: "instance_admin" });
        await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorUserId: `admin-${fixture.companyId}` });
      }],
    ] as const)("refuses a ruling written by %s", async (_label, rule) => {
      const fixture = await seedNoWorkspace();
      await rule(fixture);

      await expectRefused(fixture, await close(fixture.identifier), BOARD_AUTHOR_REFUSAL);
    });

    it("reads the card's history before its ruling", async () => {
      const fixture = await seedNoWorkspace();
      await insertPullRequestProduct(fixture);

      await expectRefused(
        fixture,
        await close(fixture.identifier),
        `Tier 1 "no-repository-landing" cannot be declared on an issue that records a repository work product (pull_request).`,
      );
    });

    // ── Round 3: the proof reads only what cannot be scrubbed. Each cell below
    // admitted at the round-2 head.

    const THREAD_CITES = (label: string) =>
      `Tier 1 "no-repository-landing" cannot be declared on an issue whose thread cites repository work (${label}).`;
    const HISTORY_CITES = (label: string) =>
      `Tier 1 "no-repository-landing" cannot be declared on an issue whose history cites repository work (${label}).`;
    const DELETED_COMMENT_REFUSAL =
      `Tier 1 "no-repository-landing" cannot be declared on an issue with a deleted comment: its text can no longer be checked for repository work.`;
    const TRUNCATED_HISTORY_REFUSAL =
      `Tier 1 "no-repository-landing" cannot be declared on an issue whose recorded title or description history is truncated: the earlier text can no longer be checked for repository work.`;

    async function postComment(identifier: string, body: string) {
      const res = await request(app).patch(`/api/issues/${identifier}`).send({ comment: body });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const [comment] = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.body, body));
      return comment!.id;
    }

    async function deleteComment(fixture: NoWorkspaceIssue, commentId: string) {
      const res = await request(app).delete(`/api/issues/${fixture.identifier}/comments/${commentId}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }

    async function patchIssue(identifier: string, body: Record<string, unknown>) {
      const res = await request(app).patch(`/api/issues/${identifier}`).send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }

    const LONG_PREFIX = "Notes on the retention decision. ".repeat(5);

    it.each([
      ["a comment citing a pull request URL, then deleted", async (fixture: NoWorkspaceIssue) => {
        const commentId = await postComment(fixture.identifier, "Landed in https://github.com/TEA-Core/records/pull/12 today.");
        await deleteComment(fixture, commentId);
      }, HISTORY_CITES("a pull request URL")],
      ["a comment citing a pull request URL past the recorded snippet, then deleted", async (fixture: NoWorkspaceIssue) => {
        const commentId = await postComment(fixture.identifier, `${LONG_PREFIX}Landed in https://github.com/TEA-Core/records/pull/12 today.`);
        await deleteComment(fixture, commentId);
      }, DELETED_COMMENT_REFUSAL],
      ["a title citing a pull request, then cleaned", async (fixture: NoWorkspaceIssue) => {
        await patchIssue(fixture.identifier, { title: "Follow-up of PR #77" });
        await patchIssue(fixture.identifier, { title: "Record the ruling" });
      }, HISTORY_CITES("a pull request number")],
      ["a description citing a pull request URL, then cleaned", async (fixture: NoWorkspaceIssue) => {
        await patchIssue(fixture.identifier, { description: "See https://github.com/TEA-Core/records/pull/12" });
        await patchIssue(fixture.identifier, { description: "Decide the retention policy." });
      }, HISTORY_CITES("a pull request URL")],
      ["a long description citing a pull request past the recorded text, then cleaned", async (fixture: NoWorkspaceIssue) => {
        await patchIssue(fixture.identifier, { description: `${LONG_PREFIX}${LONG_PREFIX}See PR #77.` });
        await patchIssue(fixture.identifier, { description: "Decide the retention policy." });
      }, TRUNCATED_HISTORY_REFUSAL],
    ] as const)("refuses a card with %s", async (_label, scrub, expected) => {
      const fixture = await seedAdmissible();
      await scrub(fixture);

      await expectRefused(fixture, await close(fixture.identifier), expected);
    });

    it("refuses a card whose board ruling cited a pull request in an earlier revision", async () => {
      const fixture = await seedNoWorkspace();
      asBoard();
      const first = await request(app)
        .put(`/api/issues/${fixture.identifier}/documents/entry-ruling`)
        .send({ format: "markdown", body: "Ruling: the decision landed in https://github.com/TEA-Core/records/pull/12." });
      expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
      const [document] = await db
        .select({ id: documents.id })
        .from(issueDocuments)
        .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
        .where(eq(issueDocuments.issueId, fixture.issueId));
      const [latest] = await db
        .select({ id: documentRevisions.id })
        .from(documentRevisions)
        .where(eq(documentRevisions.documentId, document!.id));
      const second = await request(app)
        .put(`/api/issues/${fixture.identifier}/documents/entry-ruling`)
        .send({ format: "markdown", body: "Ruling: this card's deliverable is this recorded decision.", baseRevisionId: latest!.id });
      expect(second.status, JSON.stringify(second.body)).toBeLessThan(300);
      currentActor = fixture.actor;

      const res = await close(fixture.identifier);

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toMatch(/cites repository work \(a pull request URL\)/);
      expect(await statusOf(fixture.issueId)).toBe("in_progress");
    });

    it.each([
      ["a comment with an SSH GitHub address", "Mirror at git@github.com:TEA-Core/records.git for reference.", "a GitHub address"],
      ["a comment with an Azure DevOps pull request URL", "Reviewed in https://dev.azure.com/tea/records/_git/records/pullrequest/12.", "a pull request URL"],
      ["a comment with a bare owner/repo pull reference", "Follows TEA-Core/records#12 closely.", "a repository issue or pull request reference"],
      ["a comment with a GitLab SSH address", "Pushed to git@gitlab.example.com:team/records.git.", "a GitLab address"],
    ] as const)("refuses a card with %s", async (_label, body, label) => {
      const fixture = await seedAdmissible();
      await db.insert(issueComments).values({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.closerAgentId, body });

      await expectRefused(fixture, await close(fixture.identifier), THREAD_CITES(label));
    });

    it("refuses a card with an artifact work product that names an SSH repository address", async () => {
      const fixture = await seedAdmissible();
      await db.insert(issueWorkProducts).values({
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        type: "artifact",
        provider: "paperclip",
        title: "Export",
        url: "git@example.org:team/records.git",
        status: "active",
      });

      await expectRefused(
        fixture,
        await close(fixture.identifier),
        `Tier 1 "no-repository-landing" cannot be declared on an issue that records a repository work product (artifact).`,
      );
    });

    it.each([
      ["a tool runtime slot naming an execution workspace", async (fixture: NoWorkspaceIssue) => {
        const { workspaceId } = await insertWorkspace(fixture.companyId);
        await db.insert(toolRuntimeSlots).values({
          companyId: fixture.companyId,
          issueId: fixture.issueId,
          executionWorkspaceId: workspaceId,
          slotKey: `slot-${fixture.issueId}`,
        });
      }],
      ["a run that names it only by nativeIssueId", async (fixture: NoWorkspaceIssue) => {
        await db.insert(heartbeatRuns).values({
          companyId: fixture.companyId,
          agentId: fixture.closerAgentId,
          status: "succeeded",
          contextSnapshot: { nativeIssueId: fixture.issueId, executionWorkspaceId: randomUUID() },
        });
      }],
      ["a run that names it only by a task key", async (fixture: NoWorkspaceIssue) => {
        await db.insert(heartbeatRuns).values({
          companyId: fixture.companyId,
          agentId: fixture.closerAgentId,
          status: "succeeded",
          contextSnapshot: { taskKey: `issue:${fixture.issueId}`, executionWorkspaceId: randomUUID() },
        });
      }],
      ["a run that names it only by identifier", async (fixture: NoWorkspaceIssue) => {
        await db.insert(heartbeatRuns).values({
          companyId: fixture.companyId,
          agentId: fixture.closerAgentId,
          status: "succeeded",
          contextSnapshot: { taskKey: fixture.identifier, executionWorkspaceId: randomUUID() },
        });
      }],
      ["a run context whose workspace key is spelled ExecutionWorkspaceId", async (fixture: NoWorkspaceIssue) => {
        await db.insert(heartbeatRuns).values({
          companyId: fixture.companyId,
          agentId: fixture.closerAgentId,
          status: "succeeded",
          contextSnapshot: { issueId: fixture.issueId, ExecutionWorkspaceId: randomUUID() },
        });
      }],
      ["an audit row whose repository key holds a GitHub URL", async (fixture: NoWorkspaceIssue) => {
        await db.insert(activityLog).values({
          companyId: fixture.companyId,
          actorType: "system",
          actorId: "system",
          action: "issue.updated",
          entityType: "issue",
          entityId: fixture.issueId,
          details: { repository: "https://github.com/TEA-Core/records" },
        });
      }],
      ["a deleted document", async (fixture: NoWorkspaceIssue) => {
        await db.insert(activityLog).values({
          companyId: fixture.companyId,
          actorType: "agent",
          actorId: fixture.closerAgentId,
          action: "issue.document_deleted",
          entityType: "issue",
          entityId: fixture.issueId,
          details: { key: "notes" },
        });
      }],
      ...(["issue.comment_cancelled", "issue.queued_comment_discarded"] as const).map((action) => [
        `a comment removed outright (${action})`,
        async (fixture: NoWorkspaceIssue) => {
          await db.insert(activityLog).values({
            companyId: fixture.companyId,
            actorType: "agent",
            actorId: fixture.closerAgentId,
            action,
            entityType: "issue",
            entityId: fixture.issueId,
            details: { commentId: randomUUID() },
          });
        },
      ] as const),
      ["an audit action outside the allow-list", async (fixture: NoWorkspaceIssue) => {
        await db.insert(activityLog).values({
          companyId: fixture.companyId,
          actorType: "system",
          actorId: "system",
          action: "issue.unrecognised_event",
          entityType: "issue",
          entityId: fixture.issueId,
          details: {},
        });
      }],
      ["an audit row changing a field outside the allow-list", async (fixture: NoWorkspaceIssue) => {
        await db.insert(activityLog).values({
          companyId: fixture.companyId,
          actorType: "agent",
          actorId: fixture.closerAgentId,
          action: "issue.updated",
          entityType: "issue",
          entityId: fixture.issueId,
          details: { changes: { parentId: { from: null, to: randomUUID() } } },
        });
      }],
    ] as const)("keeps today's refusal for a card with %s", async (_label, record) => {
      const fixture = await seedAdmissible();
      await record(fixture);

      await expectRefused(fixture, await close(fixture.identifier), NO_WORKSPACE_REFUSAL);
    });

    async function insertNativeRun(fixture: NoWorkspaceIssue, values: Partial<typeof heartbeatRuns.$inferInsert>) {
      const [run] = await db
        .insert(heartbeatRuns)
        .values({
          companyId: fixture.companyId,
          agentId: fixture.closerAgentId,
          status: "succeeded",
          nativeIssueId: fixture.issueId,
          contextSnapshot: {},
          ...values,
        })
        .returning({ id: heartbeatRuns.id });
      return run!.id;
    }

    it.each([
      ["a run linked only by native_issue_id whose context names a workspace", async (fixture: NoWorkspaceIssue) => {
        await insertNativeRun(fixture, { contextSnapshot: { executionWorkspaceId: randomUUID() } });
      }],
      ["a run whose result_json names a workspace", async (fixture: NoWorkspaceIssue) => {
        await insertNativeRun(fixture, { resultJson: { executionWorkspaceId: randomUUID() } });
      }],
      ["a run whose usage_json cites a pull request URL", async (fixture: NoWorkspaceIssue) => {
        await insertNativeRun(fixture, { usageJson: { note: "https://github.com/TEA-Core/records/pull/9" } });
      }],
      ["a run whose stdout excerpt cites a pull request", async (fixture: NoWorkspaceIssue) => {
        await insertNativeRun(fixture, { stdoutExcerpt: "opened PR #41" });
      }],
      ["a run whose truncated stdout excerpt names an execution workspace", async (fixture: NoWorkspaceIssue) => {
        await insertNativeRun(fixture, { stdoutExcerpt: '{"executionWorkspaceId":"ew-1","cwd":"/work/spa' });
      }],
      ["a run whose stderr excerpt cites a Git ref", async (fixture: NoWorkspaceIssue) => {
        await insertNativeRun(fixture, { stderrExcerpt: "pushed refs/heads/feature" });
      }],
      ["a run whose error cites a repository address", async (fixture: NoWorkspaceIssue) => {
        await insertNativeRun(fixture, { error: "clone of git@github.com:TEA-Core/records failed" });
      }],
      ["a native run result that names a workspace", async (fixture: NoWorkspaceIssue) => {
        const contractId = randomUUID();
        await db.insert(completionContracts).values({
          id: contractId,
          companyId: fixture.companyId,
          issueId: fixture.issueId,
          revision: 1,
          schemaVersion: "v1",
          policyVersion: "v1",
          risk: "low",
          completionAuthority: "agent",
          incompleteCriteriaPolicy: "refuse",
          contractJson: {},
          canonicalSha256: randomUUID(),
          createdByActorType: "system",
          createdByActorId: "system",
        });
        const runId = await insertNativeRun(fixture, { completionContractId: contractId });
        await db.insert(nativeRunResults).values({
          companyId: fixture.companyId,
          issueId: fixture.issueId,
          runId,
          completionContractId: contractId,
          serverFingerprint: randomUUID(),
          schemaStatus: "valid",
          resultJson: { workspaceId: randomUUID() },
          canonicalSha256: randomUUID(),
        });
      }],
      ["a run context with a hyphenated workspace key", async (fixture: NoWorkspaceIssue) => {
        await insertNativeRun(fixture, { contextSnapshot: { "execution-workspace-id": randomUUID() } });
      }],
      ["a run context with a plain workspace key", async (fixture: NoWorkspaceIssue) => {
        await insertNativeRun(fixture, { contextSnapshot: { workspace: "/srv/checkout" } });
      }],
      ["a run context with a numeric pull request number", async (fixture: NoWorkspaceIssue) => {
        await insertNativeRun(fixture, { contextSnapshot: { pullRequestNumber: 123 } });
      }],
      ["a run context carrying stringified JSON that names a workspace", async (fixture: NoWorkspaceIssue) => {
        await insertNativeRun(fixture, {
          contextSnapshot: { payload: JSON.stringify({ nested: { executionWorkspaceId: randomUUID() } }) },
        });
      }],
      ["an audit row from a plugin issues.update that stripped the project", async (fixture: NoWorkspaceIssue) => {
        await db.insert(activityLog).values({
          companyId: fixture.companyId,
          actorType: "plugin",
          actorId: "plugin-host",
          action: "issue.updated",
          entityType: "issue",
          entityId: fixture.issueId,
          details: { identifier: fixture.identifier, patch: { projectId: null } },
        });
      }],
      ["an audit row of an update that records no change at all", async (fixture: NoWorkspaceIssue) => {
        await db.insert(activityLog).values({
          companyId: fixture.companyId,
          actorType: "plugin",
          actorId: "plugin-host",
          action: "issue.updated",
          entityType: "issue",
          entityId: fixture.issueId,
          details: { identifier: fixture.identifier },
        });
      }],
    ] as const)("refuses a never-had close of a card with %s", async (_label, record) => {
      const fixture = await seedAdmissible();
      await record(fixture);

      await expectRefused(fixture, await close(fixture.identifier), NO_WORKSPACE_REFUSAL);
    });

    it("refuses a card whose description a plugin issues.update rewrote with no recorded earlier value", async () => {
      const fixture = await seedAdmissible();
      await db.insert(activityLog).values({
        companyId: fixture.companyId,
        actorType: "plugin",
        actorId: "plugin-host",
        action: "issue.updated",
        entityType: "issue",
        entityId: fixture.issueId,
        details: { identifier: fixture.identifier, patch: { description: "Nothing to see here." } },
      });

      await expectRefused(
        fixture,
        await close(fixture.identifier),
        `Tier 1 "no-repository-landing" cannot be declared on an issue whose title or description was rewritten without a recorded earlier value: the earlier text can no longer be checked for repository work.`,
      );
    });

    it("refuses a card with a comment that cites only a commit SHA", async () => {
      const fixture = await seedAdmissible();
      await insertComment(fixture, "Shipped in 4f9bf028e861 yesterday.");

      await expectRefused(
        fixture,
        await close(fixture.identifier),
        `Tier 1 "no-repository-landing" cannot be declared on an issue whose thread cites repository work (a commit SHA).`,
      );
    });

    it("holds the ruling until the close commits: an edit during the status write waits for it", async () => {
      const fixture = await seedAdmissible();
      const lockKey = 424247;
      await db.execute(sql.raw(
        `create or replace function pc_test_hold_close() returns trigger language plpgsql as $$ ` +
          `begin perform pg_advisory_xact_lock(${lockKey}); return new; end $$`,
      ));
      await db.execute(sql.raw(
        "create trigger pc_test_hold_close before insert on activity_log for each row " +
          "when (new.action = 'issue.done_transition_no_repository_landing_verified') execute function pc_test_hold_close()",
      ));
      try {
        let editError: unknown = null;
        let closing: Promise<request.Response> | null = null;
        await db.transaction(async (holder) => {
          await holder.execute(sql.raw(`select pg_advisory_xact_lock(${lockKey})`));
          closing = Promise.resolve(close(fixture.identifier));
          let waiting = false;
          // Wait for the close's transaction to block on the advisory lock (a
          // real cross-connection lock state, so there is no fake clock to drive).
          for (let attempt = 0; attempt < 400 && !waiting; attempt += 1) {
            const rows = await db.execute(sql.raw(
              `select 1 from pg_locks where locktype = 'advisory' and objid = ${lockKey} and not granted`,
            ));
            waiting = (rows as unknown as unknown[]).length > 0;
            if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
          }
          expect(waiting).toBe(true);
          try {
            await db.transaction(async (editor) => {
              await editor.execute(sql.raw("set local lock_timeout = '500ms'"));
              await editor
                .update(documents)
                .set({ latestBody: "Ruling: replaced while the close was being written.", updatedAt: new Date() })
                .where(eq(documents.id, fixture.rulingId));
            });
          } catch (err) {
            editError = err;
          }
        });
        const res = await closing!;

        const editFailure = editError as (Error & { cause?: Error }) | null;
        expect(`${editFailure?.message ?? ""} ${editFailure?.cause?.message ?? ""}`).toMatch(/lock timeout/);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const [ruling] = await db.select({ body: documents.latestBody }).from(documents).where(eq(documents.id, fixture.rulingId));
        expect(ruling!.body).toBe("Ruling: this card's deliverable is this recorded decision; no repository change.");
      } finally {
        await db.execute(sql.raw("drop trigger if exists pc_test_hold_close on activity_log"));
        await db.execute(sql.raw("drop function if exists pc_test_hold_close()"));
      }
    });

    it("reads every table that can name a workspace", () => {
      const workspaceTables = new Map<string, string[]>();
      for (const value of Object.values(dbExports)) {
        if (!is(value, PgTable)) continue;
        const config = getTableConfig(value);
        const columns = config.columns.map((column) => column.name);
        if (columns.includes("execution_workspace_id") || columns.includes("project_workspace_id")) {
          workspaceTables.set(config.name, columns);
        }
      }
      // The issue row itself is the subject: its pointers must be null.
      workspaceTables.delete("issues");

      expect([...workspaceTables.keys()].sort()).toEqual(Object.keys(NO_WORKSPACE_REFERENCE_TABLES).sort());
      for (const [table, issueColumn] of Object.entries(NO_WORKSPACE_REFERENCE_TABLES)) {
        expect(workspaceTables.get(table), table).toContain(issueColumn);
      }
    });

    it("closes a card the board created without a project, after a refused attempt and a thread comment", async () => {
      const fixture = await seedNoWorkspace();
      asBoard();
      const created = await request(app)
        .post(`/api/companies/${fixture.companyId}/issues`)
        .send({
          title: "Decide the retention policy",
          description: "Record the decision as the entry ruling.",
          status: "todo",
          deliveryRequirement: "record_only",
          assigneeAgentId: fixture.closerAgentId,
        });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const card = created.body as { id: string; identifier: string };
      // The holder's run on this card, in its agent home: no project, no workspace.
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: fixture.companyId,
        agentId: fixture.closerAgentId,
        status: "running",
        contextSnapshot: { issueId: card.id, paperclipWorkspace: { cwd: "/agents/home", source: "agent_home", projectId: null, workspaceId: null, repoUrl: null } },
      }).returning({ id: heartbeatRuns.id });
      currentActor = { type: "agent", agentId: fixture.closerAgentId, companyId: fixture.companyId, source: "agent_key", runId: run!.id };
      const started = await request(app)
        .patch(`/api/issues/${card.identifier}`)
        .send({ status: "in_progress", comment: "Drafting the retention decision for the board." });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const early = await close(card.identifier);
      expect(early.status, JSON.stringify(early.body)).toBe(422);
      expect(early.body.error).toBe(`Tier 1 "no-repository-landing" requires a non-empty "entry-ruling" document on this issue.`);
      await insertRuling({ companyId: fixture.companyId, issueId: card.id, authorUserId: BOARD_USER_ID });

      const res = await close(card.identifier);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await statusOf(card.id)).toBe("done");
      const verified = await activityRows(card.id, "issue.done_transition_no_repository_landing_verified");
      expect(verified).toHaveLength(1);
      expect(verified[0]!.details).toMatchObject({ proof: "never_had_execution_workspace" });
    });
  });
});
