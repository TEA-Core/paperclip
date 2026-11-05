import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  documentRevisions,
  documents,
  executionWorkspaces,
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
} from "../services/done-transition-guard.js";
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

vi.mock("../services/done-transition-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/done-transition-guard.js")>();
  realEvaluateDoneTierDeclarationRef.current = actual.evaluateDoneTierDeclaration;
  mockEvaluateDoneTierDeclaration.mockImplementation(actual.evaluateDoneTierDeclaration);
  return { ...actual, evaluateDoneTierDeclaration: mockEvaluateDoneTierDeclaration };
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
    app.use((req, _res, next) => {
      req.actor = currentActor;
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
    const match = /\/compare\/([^/]+)\.\.\.([0-9a-f]{40})$/.exec(url);
    if (!match) return new Response(JSON.stringify({}), { status: 404 });
    try {
      const ahead = Number.parseInt(git(currentOrigin, "rev-list", "--count", `${decodeURIComponent(match[1]!)}..${match[2]}`), 10);
      return new Response(JSON.stringify({ ahead_by: ahead }), { status: 200 });
    } catch {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
  }

  beforeEach(() => {
    mockGhFetch.mockReset();
    mockGhFetch.mockImplementation(async (url: string) => compareAgainstOrigin(url));
    mockGetByName.mockReset();
    mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
    mockResolveSecretValue.mockReset();
    mockResolveSecretValue.mockResolvedValue("test-token");
    mockEvaluateDoneTierDeclaration.mockReset();
    mockEvaluateDoneTierDeclaration.mockImplementation(realEvaluateDoneTierDeclarationRef.current!);
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
      key: "entry-ruling",
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
    const branch = `${identifier}-entry-ruling`;

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
    };
  }

  async function close(identifier: string, doneTier: unknown = NO_REPOSITORY_DONE_TIER) {
    return request(app).patch(`/api/issues/${identifier}`).send({ status: "done", doneTier });
  }

  async function statusOf(issueId: string) {
    return db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]?.status);
  }

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
    ["update-ref moves refs/remotes/origin/main onto it", (fixture: SeededIssue) =>
      git(fixture.repoRoot, "update-ref", "refs/remotes/origin/main", "HEAD")],
    ["a local fetch refspec rewrites refs/remotes/origin/main", (fixture: SeededIssue) =>
      git(fixture.repoRoot, "fetch", "-q", ".", `+refs/heads/${fixture.identifier}-entry-ruling:refs/remotes/origin/main`)],
    ["the local main branch is moved onto it", (fixture: SeededIssue) =>
      git(fixture.repoRoot, "update-ref", "refs/heads/main", "HEAD")],
  ] as const)("refuses a committed, unpushed deliverable when %s", async (_label, moveBase) => {
    const fixture = await seed();
    await insertRuling({ companyId: fixture.companyId, issueId: fixture.issueId, authorAgentId: fixture.rulerAgentId });
    commitOnIssueBranch(fixture);
    moveBase(fixture);

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
      mockGhFetch.mockImplementation(async () => new Response("{}", { status: 500 })), "could not be compared with the project's default branch on the remote"],
    ["the compare call answers without a commit count", () =>
      mockGhFetch.mockImplementation(async () => new Response(JSON.stringify({}), { status: 200 })), "could not be compared with the project's default branch on the remote"],
    ["the GitHub request cannot connect", () =>
      mockGhFetch.mockImplementation(async () => { throw new Error("ECONNREFUSED"); }), "could not be compared with the project's default branch on the remote"],
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
      mockGhFetch.mockImplementation(async () => { throw new Error("ECONNREFUSED"); });
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
    }, "already stored as record_only at the close write"],
    ["the closer edits the ruling", async (fixture: SeededIssue) => {
      const [link] = await db
        .select({ documentId: issueDocuments.documentId })
        .from(issueDocuments)
        .where(and(eq(issueDocuments.issueId, fixture.issueId), eq(issueDocuments.key, "entry-ruling")));
      await db.insert(documentRevisions).values({
        companyId: fixture.companyId,
        documentId: link!.documentId,
        revisionNumber: 2,
        body: "Ruling rewritten by the closer",
        createdByAgentId: fixture.closerAgentId,
      });
    }, "written by someone other than the closing actor"],
  ] as const)("re-probes at the status write: refuses when %s after the declaration was accepted", async (_label, mutate, expected) => {
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
