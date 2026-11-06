import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  documentRevisions,
  documents,
  executionWorkspaces,
  externalObjectMentions,
  externalObjects,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  issueWorkProducts,
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
import { projectRoutes } from "../routes/projects.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import {
  evaluateDoneTransitionGuardForBackstopClose,
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
    authorAgentId: string;
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
      createdByAgentId: input.authorAgentId,
      updatedByAgentId: input.authorAgentId,
    });
    await db.insert(documentRevisions).values({
      companyId: input.documentCompanyId ?? input.companyId,
      documentId,
      revisionNumber: 1,
      body: input.body ?? "Ruling: this card's deliverable is this recorded decision; no repository change.",
      createdByAgentId: input.authorAgentId,
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
      branchSlug?: string;
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
    const branch = `${identifier}-${options.branchSlug ?? "entry-ruling"}`;

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

  async function statusOf(issueId: string) {
    return db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]?.status);
  }

  const BELONGS_TO_NO_CARD = "belongs to no card: it is not this card's, not one of the project's branches, and not registered to another card's workspace";

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

  it("refuses an issue that records a pull request work product", async () => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
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
    });

    const res = await close(fixture.identifier);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("records a pull request work product");
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

  it("completes twelve concurrent no-repository closes, more than the database pool holds", async () => {
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

    const responses = await Promise.all(
      fixtures.map((fixture) =>
        request(app)
          .patch(`/api/issues/${fixture.identifier}`)
          .set("x-test-actor", JSON.stringify(fixture.actor))
          .send({ status: "done", doneTier: NO_REPOSITORY_DONE_TIER }),
      ),
    );

    expect(responses.map((res) => res.status)).toEqual(fixtures.map(() => 200));
    for (const fixture of fixtures) expect(await statusOf(fixture.issueId)).toBe("done");
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
  async function registerSiblingCard(fixture: SeededIssue, branchName: string) {
    const siblingIssueId = randomUUID();
    await db.insert(issues).values({
      id: siblingIssueId,
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      identifier: `${fixture.identifier.replace(/-\d+$/, "")}-2`,
      title: "A sibling card",
      status: "in_progress",
      priority: "medium",
      createdByUserId: "cloud-user-1",
    });
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
});
