import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueExecutionDecisions,
  issues,
  projects,
  executionWorkspaces,
  externalObjects,
  externalObjectMentions,
  activityLog,
  companyMemberships,
  agentWakeupRequests,
} from "@paperclipai/db";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import type * as GitHubFetch from "../services/github-fetch.js";
import type * as GitHubCredential from "../services/github-credential.js";

const github = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock("../services/github-fetch.js", async (original) => ({
  ...await original<typeof GitHubFetch>(),
  ghFetch: github,
}));
vi.mock("../services/github-credential.js", async (original) => {
  const actual = await original<typeof GitHubCredential>();
  const credential = { token: "sandbox-token", scope: "company", secretName: "sandbox" };
  return {
    ...actual,
    resolveGitHubToken: async () => credential,
    resolveGitHubTokenForRepo: async () => credential,
    resolveGitHubTokenCandidatesForRepo: async () => [credential],
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution-decisions route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

const CONTRACT_FIELDS = [
  "id",
  "issueId",
  "stageId",
  "stageType",
  "actorAgentId",
  "actorUserId",
  "outcome",
  "body",
  "createdByRunId",
  "createdAt",
] as const;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(company: CompanyRow): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [company.id],
    memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function agentActor(company: CompanyRow, agent: AgentRow, runId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: agent.id,
    companyId: company.id,
    runId,
    source: "agent_jwt",
  };
}

async function seedCompany(db: Db, label = "Decisions") {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `${label} ${nonce}`,
    issuePrefix: `DC${nonce.slice(0, 4).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
  }).returning();
  return company!;
}

async function seedAgent(db: Db, companyId: string, permissions: Record<string, unknown> = {}) {
  const [agent] = await db.insert(agents).values({
    companyId,
    name: `Agent ${randomUUID().slice(0, 6)}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions,
  }).returning();
  return agent!;
}

async function seedProject(db: Db, companyId: string, name: string) {
  const [project] = await db.insert(projects).values({
    companyId,
    name,
    status: "in_progress",
  }).returning();
  return project!;
}

async function seedIssue(db: Db, input: {
  companyId: string;
  projectId?: string | null;
  title: string;
  status?: string;
  executionPolicy?: Record<string, unknown>;
}) {
  const [issue] = await db.insert(issues).values({
    companyId: input.companyId,
    projectId: input.projectId ?? null,
    parentId: null,
    title: input.title,
    status: input.status ?? "todo",
    priority: "medium",
    assigneeAgentId: null,
    responsibleUserId: "board-user",
    executionPolicy: input.executionPolicy ?? null,
  }).returning();
  return issue!;
}

async function seedDecision(db: Db, input: {
  companyId: string;
  issueId: string;
  stageId: string;
  stageType: string;
  actorAgentId?: string | null;
  actorUserId?: string | null;
  outcome: string;
  body: string;
  createdAt: Date;
}) {
  const [row] = await db.insert(issueExecutionDecisions).values({
    companyId: input.companyId,
    issueId: input.issueId,
    stageId: input.stageId,
    stageType: input.stageType,
    actorAgentId: input.actorAgentId ?? null,
    actorUserId: input.actorUserId ?? null,
    outcome: input.outcome,
    body: input.body,
    createdByRunId: null,
    createdAt: input.createdAt,
  }).returning();
  return row!;
}

describeEmbeddedPostgres("issue execution-decisions read route (ADR-073 D4)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousAllowKeyGeneration = process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION;
  const previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-exec-decisions-redaction-${randomUUID()}`);

  beforeAll(async () => {
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION = "1";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-execution-decisions-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    github.mockReset();
    await db.delete(activityLog);
    await db.delete(companyMemberships);
    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(issueExecutionDecisions);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    if (previousAllowKeyGeneration === undefined) delete process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION;
    else process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION = previousAllowKeyGeneration;
    if (previousSchedulingSuppression === undefined) delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    else process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = previousSchedulingSuppression;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function pendingDelivery({ draft = false, missing = false, mid = false, repo = true, unmentioned = false } = {}) {
    const company = await seedCompany(db);
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: "board-user", status: "active", membershipRole: "owner",
    });
    const author = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Delivery");
    const stageId = randomUUID();
    const stages = [{ id: stageId, type: "review", participants: [{ type: "user", userId: "board-user" }] }];
    if (mid) stages.push({ id: randomUUID(), type: "approval", participants: [{ type: "user", userId: "board-user" }] });
    const issue = await seedIssue(db, {
      companyId: company.id, projectId: project.id, title: "Final delivery",
      status: "in_review", executionPolicy: { mode: "normal", stages },
    });
    const identifier = `${company.issuePrefix}-1`;
    const branch = `${identifier}-delivery`;
    let workspaceId: string | null = null;
    if (repo) {
      const [workspace] = await db.insert(executionWorkspaces).values({
        companyId: company.id, projectId: project.id, sourceIssueId: issue.id,
        mode: "isolated_workspace", strategyType: "git_worktree", name: branch,
        status: "active", cwd: "/tmp/as02-no-local-repo", repoUrl: "https://github.com/TEA-Core/paperclip",
        baseRef: "main", branchName: branch, providerType: "git_worktree",
      }).returning();
      workspaceId = workspace!.id;
    }
    await db.update(issues).set({
      identifier, issueNumber: 1, createdByAgentId: author.id, assigneeUserId: "board-user",
      executionWorkspaceId: workspaceId,
      executionState: {
        status: "pending", currentStageId: stageId, currentStageIndex: 0,
        currentStageType: "review", currentParticipant: { type: "user", userId: "board-user" },
        returnAssignee: { type: "agent", agentId: author.id }, completedStageIds: [],
        skippedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, issue.id));
    const pr = {
      number: 42, state: "open", draft, merged: false, node_id: "sandbox-pr",
      title: identifier, head: { ref: branch, sha: "a".repeat(40), repo: { full_name: "TEA-Core/paperclip" } },
    };
    if (repo && !missing && !unmentioned) {
      const [object] = await db.insert(externalObjects).values({
        companyId: company.id, providerKey: "github", objectType: "pull_request",
        externalId: "TEA-Core/paperclip#pull/42", displayKey: "42", displayTitle: identifier,
        sanitizedCanonicalUrl: "https://github.com/TEA-Core/paperclip/pull/42",
        canonicalIdentityHash: randomUUID(), data: pr,
      }).returning();
      await db.insert(externalObjectMentions).values({
        companyId: company.id, sourceIssueId: issue.id, sourceKind: "description",
        objectId: object!.id, providerKey: "github", detectorKey: "github_pr", objectType: "pull_request",
        matchedTextRedacted: "delivery", sanitizedDisplayUrl: object!.sanitizedCanonicalUrl,
        canonicalIdentityHash: object!.canonicalIdentityHash, canonicalIdentity: {},
      });
    }
    const writes: Array<{ url: string; body: unknown }> = [];
    let moveAfterPreflight = false;
    github.mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/graphql")) {
        return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
      }
      if (init?.method === "POST") {
        writes.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({ id: 1 });
      }
      if (url.includes("/pulls/42")) {
        const [stored] = await db.select().from(issues).where(eq(issues.id, issue.id));
        const head = moveAfterPreflight && stored!.executionState?.lastDecisionOutcome === "approved"
          ? { ...pr.head, sha: "b".repeat(40) } : pr.head;
        return Response.json({ ...pr, head });
      }
      if (url.includes("/pulls?")) return Response.json(missing ? [] : [pr]);
      if (url.includes("/compare/")) return Response.json({ ahead_by: 1 });
      if (url.includes("/git/ref/")) return Response.json({ object: { sha: pr.head.sha } });
      throw new Error(`Unexpected sandbox request: ${url}`);
    });
    return {
      company, issue, stageId, writes, pr,
      moveHead: () => { moveAfterPreflight = true; },
      approve: () => request(createApp(db, boardActor(company))).patch(`/api/issues/${issue.id}`)
        .send({ status: "done", comment: "Independent final review approved." }),
      read: async () => (await db.select().from(issues).where(eq(issues.id, issue.id)))[0]!,
    };
  }

  it("refuses final draft delivery without completing or recording an approval", async () => {
    const fixture = await pendingDelivery({ draft: true });
    const response = await fixture.approve();
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ details: { code: "approval_final_delivery_preflight", reason: expect.stringContaining("head_draft") } });
    const stored = await fixture.read();
    expect(stored.status).toBe("in_review");
    expect(stored.executionState).toMatchObject({ status: "pending", completedStageIds: [], lastDecisionId: null });
    expect(await db.select().from(issueExecutionDecisions)).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });

  it("names the delivery owner and leaves missing delivery pending", async () => {
    const fixture = await pendingDelivery({ missing: true });
    const response = await fixture.approve();
    expect(response.status).toBe(409);
    expect(response.body.details).toMatchObject({ deliveryOwnerIssueId: fixture.issue.id });
    expect(response.body.details.remedy).toContain(fixture.issue.id);
    expect((await fixture.read()).executionState).toMatchObject({ status: "pending", completedStageIds: [] });
    expect(await db.select().from(issueExecutionDecisions)).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });

  it("publishes the independently approved ready delivery head", async () => {
    const fixture = await pendingDelivery();
    expect((await fixture.approve()).status).toBe(200);
    const stored = await fixture.read();
    expect(stored.status).toBe("done");
    expect(stored.executionState).toMatchObject({
      completedStageIds: [fixture.stageId], lastDecisionOutcome: "approved",
      approvalStatus: { approvedHeadSha: fixture.pr.head.sha, publishedHeadSha: fixture.pr.head.sha },
    });
    expect(fixture.writes).toEqual([{
      url: `https://api.github.com/repos/TEA-Core/paperclip/statuses/${fixture.pr.head.sha}`,
      body: expect.objectContaining({ state: "success", context: "paperclip/approved" }),
    }]);
  });

  it("preserves the reviewed anchor and refuses a content push after preflight", async () => {
    const fixture = await pendingDelivery();
    fixture.moveHead();
    expect((await fixture.approve()).status).toBe(200);
    expect((await fixture.read()).executionState).toMatchObject({
      approvalStatus: {
        approvedHeadSha: fixture.pr.head.sha,
        publishSkipped: expect.objectContaining({ reason: expect.stringContaining("head_moved") }),
      },
    });
    expect(fixture.writes).toEqual([]);
  });

  it.each([{ mid: true, draft: true }, { repo: false }])("keeps lawful earlier-stage and non-repo approvals: %j", async (options) => {
    const fixture = await pendingDelivery(options);
    expect((await fixture.approve()).status).toBe(200);
    const stored = await fixture.read();
    expect(stored.status).toBe(options.mid ? "in_review" : "done");
    expect(stored.executionState).toMatchObject({ completedStageIds: [fixture.stageId], lastDecisionOutcome: "approved" });
    expect(fixture.writes).toEqual([]);
  });

  it("publishes a terminal board verdict for an uncached ready owner PR", async () => {
    const previous = process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE;
    process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE = "true";
    try {
      const fixture = await pendingDelivery({ unmentioned: true });
      const response = await request(createApp(db, boardActor(fixture.company)))
        .post(`/api/issues/${fixture.issue.id}/execution-stage/board-decision`)
        .send({ decision: "approved", comment: "Independent final approval." });
      expect(response.status).toBe(200);
      expect((await fixture.read()).executionState).toMatchObject({
        lastDecisionOutcome: "approved",
        approvalStatus: { approvedHeadSha: fixture.pr.head.sha, publishedHeadSha: fixture.pr.head.sha },
      });
      expect(fixture.writes).toEqual([{
        url: `https://api.github.com/repos/TEA-Core/paperclip/statuses/${fixture.pr.head.sha}`,
        body: expect.objectContaining({ state: "success", context: "paperclip/approved" }),
      }]);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE;
      else process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE = previous;
    }
  });

  it("returns every decision for a 3-stage ladder, ordered createdAt ascending, with the ten contract fields", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Ladder parent",
      status: "done",
    });

    const stageIds = [randomUUID(), randomUUID(), randomUUID()];
    const t1 = new Date("2026-08-20T10:00:00Z");
    const t2 = new Date("2026-08-20T11:00:00Z");
    const t3 = new Date("2026-08-20T12:00:00Z");
    // Insert out of chronological order to prove ordering comes from the query.
    await seedDecision(db, {
      companyId: company.id,
      issueId: issue.id,
      stageId: stageIds[2],
      stageType: "approval",
      actorUserId: "board-user",
      outcome: "approved",
      body: "stage-3-verdict",
      createdAt: t3,
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: issue.id,
      stageId: stageIds[0],
      stageType: "review",
      actorAgentId: agent.id,
      outcome: "approved",
      body: "stage-1-verdict",
      createdAt: t1,
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: issue.id,
      stageId: stageIds[1],
      stageType: "review",
      actorAgentId: agent.id,
      outcome: "changes_requested",
      body: "stage-2-verdict",
      createdAt: t2,
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/execution-decisions`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
    for (const row of res.body) {
      expect(Object.keys(row)).toEqual([...CONTRACT_FIELDS]);
    }
    expect(res.body.map((row: { stageId: string; stageType: string; outcome: string; body: string; createdAt: string }) => [row.stageId, row.stageType, row.outcome, row.body])).toEqual([
      [stageIds[0], "review", "approved", "stage-1-verdict"],
      [stageIds[1], "review", "changes_requested", "stage-2-verdict"],
      [stageIds[2], "approval", "approved", "stage-3-verdict"],
    ]);
    expect(res.body[0].issueId).toBe(issue.id);
    expect(res.body[0].actorAgentId).toBe(agent.id);
    expect(res.body[0].actorUserId).toBeNull();
    expect(res.body[2].actorAgentId).toBeNull();
    expect(res.body[2].actorUserId).toBe("board-user");
    expect(res.body[0].createdByRunId).toBeNull();
    expect(res.body[0].createdAt).toBe(t1.toISOString());
    expect(res.body[1].createdAt).toBe(t2.toISOString());
    expect(res.body[2].createdAt).toBe(t3.toISOString());
  });

  it("refuses an unauthorized caller with the same outcome as GET /api/issues/:id", async () => {
    const companyA = await seedCompany(db, "Company A");
    const companyB = await seedCompany(db, "Company B");
    const agentB = await seedAgent(db, companyB.id);
    const projectA = await seedProject(db, companyA.id, "A");
    const issueA = await seedIssue(db, {
      companyId: companyA.id,
      projectId: projectA.id,
      title: "Company A issue",
      status: "done",
    });
    await seedDecision(db, {
      companyId: companyA.id,
      issueId: issueA.id,
      stageId: randomUUID(),
      stageType: "review",
      outcome: "approved",
      body: "company-a-verdict",
      createdAt: new Date("2026-08-20T10:00:00Z"),
    });

    const app = createApp(db, agentActor(companyB, agentB, randomUUID()));

    const decisionsRes = await request(app).get(`/api/issues/${issueA.id}/execution-decisions`);
    const issueRes = await request(app).get(`/api/issues/${issueA.id}`);

    expect(decisionsRes.status).toBe(404);
    expect(decisionsRes.body.error).toBe("Issue not found");
    // Same authorization scope as the issue read itself.
    expect(decisionsRes.status).toBe(issueRes.status);
    expect(JSON.stringify(decisionsRes.body)).not.toContain("company-a-verdict");
  });

  it("returns 200 with an empty array for an issue that has no decisions", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "No decisions yet",
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/execution-decisions`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns a decision row whose stageId is no longer in executionPolicy.stages (orphaned completed stage)", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const currentStageId = randomUUID();
    const orphanStageId = randomUUID();
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Policy rewritten after stage completion",
      status: "done",
      // Only one stage in the live policy; the orphan row's stageId is not in it.
      executionPolicy: {
        mode: "normal",
        stages: [{ id: currentStageId, type: "review", participants: [], approvalsNeeded: 1 }],
        commentRequired: true,
      },
    });

    await seedDecision(db, {
      companyId: company.id,
      issueId: issue.id,
      stageId: orphanStageId,
      stageType: "review",
      actorUserId: "board-user",
      outcome: "approved",
      body: "orphan-stage-verdict",
      createdAt: new Date("2026-08-19T09:00:00Z"),
    });
    await seedDecision(db, {
      companyId: company.id,
      issueId: issue.id,
      stageId: currentStageId,
      stageType: "review",
      actorUserId: "board-user",
      outcome: "approved",
      body: "current-stage-verdict",
      createdAt: new Date("2026-08-19T10:00:00Z"),
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/execution-decisions`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((row: { stageId: string; body: string }) => [row.stageId, row.body])).toEqual([
      [orphanStageId, "orphan-stage-verdict"],
      [currentStageId, "current-stage-verdict"],
    ]);
  });

  it("redacts registered run secrets inside decision bodies (mirrors the comment read surface)", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Secret-laden decision",
      status: "done",
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company.id,
      agentId: agent.id,
      status: "running",
      contextSnapshot: { issueId: issue.id },
    });
    const secret = "exec-decisions-redaction-secret-value";
    await createRunSecretRedactionRegistry(db).register(company.id, runId, secret);
    await seedDecision(db, {
      companyId: company.id,
      issueId: issue.id,
      stageId: randomUUID(),
      stageType: "review",
      actorAgentId: agent.id,
      outcome: "approved",
      body: `agent pasted ${secret} in the verdict`,
      createdAt: new Date("2026-08-20T10:00:00Z"),
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/execution-decisions`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(Object.keys(res.body[0])).toEqual([...CONTRACT_FIELDS]);
    expect(res.body[0].body).toBe(`agent pasted ${REDACTED_EVENT_VALUE} in the verdict`);
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  it("returns 404 for a missing issue id", async () => {
    const company = await seedCompany(db);

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${randomUUID()}/execution-decisions`);

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toBe("Issue not found");
  });
});
