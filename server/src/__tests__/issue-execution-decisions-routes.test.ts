import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
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
  issueComments,
  issueRecoveryActions,
  issueThreadInteractions,
  issueDeliveryReceipts,
  issueDeliveryReceiptLinks,
} from "@paperclipai/db";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
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
    await db.delete(issueDeliveryReceiptLinks);
    await db.delete(issueDeliveryReceipts);
    await db.delete(activityLog);
    await db.delete(companyMemberships);
    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
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

  async function pendingDelivery({ draft = false, missing = false, mid = false, repo = true, unmentioned = false, holdPull = false, mergeArmingEnabled = false } = {}) {
    const company = await seedCompany(db);
    if (mergeArmingEnabled) {
      await db.update(companies).set({ mergeArmingEnabled: true }).where(eq(companies.id, company.id));
    }
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
    if (repo && !missing) {
      const [object] = await db.insert(externalObjects).values({
        companyId: company.id, providerKey: "github", objectType: "pull_request",
        externalId: "TEA-Core/paperclip#pull/42", displayKey: "42", displayTitle: identifier,
        sanitizedCanonicalUrl: "https://github.com/TEA-Core/paperclip/pull/42",
        canonicalIdentityHash: randomUUID(), data: pr,
      }).returning();
      if (!unmentioned) {
        await db.insert(externalObjectMentions).values({
          companyId: company.id, sourceIssueId: issue.id, sourceKind: "description",
          objectId: object!.id, providerKey: "github", detectorKey: "github_pr", objectType: "pull_request",
          matchedTextRedacted: "delivery", sanitizedDisplayUrl: object!.sanitizedCanonicalUrl,
          canonicalIdentityHash: randomUUID(), canonicalIdentity: {},
        });
      }
      await db.insert(issueDeliveryReceipts).values({
        companyId: company.id, sourceIssueId: issue.id, provider: "github",
        owner: "tea-core", repo: "paperclip", pullRequestNumber: pr.number,
        headSha: pr.head.sha, branchName: branch, sourceDeliveryRecord: { fixture: true },
        recoveryReason: "authorized test publication", authorizedByActorType: "user",
        authorizedByActorId: "board-user", idempotencyKey: `fixture-${issue.id}-${pr.head.sha}`, state: "ready",
      });
      const [receipt] = await db.select({ id: issueDeliveryReceipts.id })
        .from(issueDeliveryReceipts)
        .where(eq(issueDeliveryReceipts.sourceIssueId, issue.id));
      await db.insert(issueDeliveryReceiptLinks).values({
        companyId: company.id, receiptId: receipt!.id, sourceIssueId: issue.id,
        externalObjectId: object!.id, provider: "github", owner: "tea-core", repo: "paperclip",
        pullRequestNumber: pr.number, headSha: pr.head.sha,
      });
    }
    const writes: Array<{ url: string; body: unknown }> = [];
    const armCalls: string[] = [];
    let moveAfterPreflight = false;
    let releasePull!: () => void;
    let pullHeld!: () => void;
    const pullGate = new Promise<void>((resolve) => { releasePull = resolve; });
    const pullReached = new Promise<void>((resolve) => { pullHeld = resolve; });
    let pullHolds = holdPull;
    github.mockImplementation(async (input, init) => {
      const url = String(input);
      if (pullHolds && url.includes("/pulls/42")) {
        pullHolds = false;
        pullHeld();
        await pullGate;
      }
      if (init?.method === "POST" && url.endsWith("/graphql")) {
        if (String(init.body).includes("enablePullRequestAutoMerge")) {
          armCalls.push(String(init.body));
        }
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
      company, issue, stageId, writes, armCalls, pr,
      pullReached, releasePull,
      moveHead: () => { moveAfterPreflight = true; },
      approve: (extra: Record<string, unknown> = {}) => request(createApp(db, boardActor(company))).patch(`/api/issues/${issue.id}`)
        .send({ status: "done", comment: "Independent final review approved.", ...extra }),
      read: async () => (await db.select().from(issues).where(eq(issues.id, issue.id)))[0]!,
    };
  }
  async function raceAtDecisionTransaction(
    fixture: { pullReached: Promise<void>; releasePull: () => void },
    response: Promise<request.Response>,
    mutate: () => Promise<unknown>,
  ) {
    await fixture.pullReached;
    const transact = db.transaction.bind(db);
    let raced = false;
    const spy = vi.spyOn(db, "transaction").mockImplementation((async (...args: Parameters<typeof db.transaction>) => {
      if (!raced) {
        raced = true;
        await mutate();
      }
      return transact(...args);
    }) as typeof db.transaction);
    try {
      fixture.releasePull();
      const result = await response;
      expect(raced).toBe(true);
      return result;
    } finally {
      fixture.releasePull();
      spy.mockRestore();
    }
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

  it("does not hold the issue row while the final delivery preflight awaits GitHub", async () => {
    const previous = process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE;
    process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE = "true";
    try {
      const fixture = await pendingDelivery({ holdPull: true });
      const app = createApp(db, boardActor(fixture.company));
      const decision = request(app)
        .post(`/api/issues/${fixture.issue.id}/execution-stage/board-decision`)
        .send({ decision: "approved", comment: "Independent final approval." })
        .then((response) => response);
      await fixture.pullReached;
      const concurrent = await Promise.race([
        request(app).patch(`/api/issues/${fixture.issue.id}`).send({ title: "Renamed while preflight awaits" }),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 5_000)),
      ]);
      expect(concurrent).not.toBe("blocked");
      expect((concurrent as { status: number }).status).toBe(200);
      fixture.releasePull();
      const response = await decision;
      expect(response.status).toBe(409);
      expect(response.body.details).toMatchObject({ code: "approval_final_delivery_preflight_stale" });
      const stored = await fixture.read();
      expect(stored.title).toBe("Renamed while preflight awaits");
      expect(stored.executionState).toMatchObject({ status: "pending", completedStageIds: [] });
      expect(await db.select().from(issueExecutionDecisions)).toEqual([]);
      expect(fixture.writes).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE;
      else process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE = previous;
    }
  });

  it("refuses a PATCH final verdict when updatedAt changes after external preflight", async () => {
    const fixture = await pendingDelivery({ holdPull: true, mergeArmingEnabled: true });
    const receipts = await db.select().from(issueDeliveryReceipts)
      .where(eq(issueDeliveryReceipts.sourceIssueId, fixture.issue.id));
    const approval = fixture.approve().then((response) => response);
    const response = await raceAtDecisionTransaction(fixture, approval, async () => {
      await db.update(issues).set({ updatedAt: new Date(Date.now() + 60_000) })
        .where(eq(issues.id, fixture.issue.id));
    });
    expect(response.status).toBe(409);
    expect(response.body.details).toMatchObject({ code: "approval_final_delivery_preflight_stale" });
    const stored = await fixture.read();
    expect(stored.status).toBe("in_review");
    expect(stored.executionState).toMatchObject({
      status: "pending", completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
    });
    expect(stored.executionState?.approvalStatus).toBeUndefined();
    expect(await db.select().from(issueExecutionDecisions)).toEqual([]);
    expect(await db.select().from(issueDeliveryReceipts)
      .where(eq(issueDeliveryReceipts.sourceIssueId, fixture.issue.id))).toEqual(receipts);
    expect(fixture.writes).toEqual([]);
    expect(fixture.armCalls).toEqual([]);
  });

  it("refuses a final board verdict when the delivery binding changes during the preflight without touching the issue row", async () => {
    const previous = process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE;
    process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE = "true";
    try {
      const fixture = await pendingDelivery({ holdPull: true });
      const before = await fixture.read();
      const decision = request(createApp(db, boardActor(fixture.company)))
        .post(`/api/issues/${fixture.issue.id}/execution-stage/board-decision`)
        .send({ decision: "approved", comment: "Independent final approval." })
        .then((response) => response);
      await fixture.pullReached;
      await db.update(executionWorkspaces)
        .set({ branchName: "SUP-1-rebound-delivery" })
        .where(eq(executionWorkspaces.id, before.executionWorkspaceId!));
      fixture.releasePull();
      const response = await decision;
      expect(response.status).toBe(409);
      expect(response.body.details).toMatchObject({
        code: "approval_final_delivery_preflight_stale", reason: expect.stringContaining("head_moved"),
      });
      const stored = await fixture.read();
      expect(stored.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(stored.executionState).toMatchObject({ status: "pending", completedStageIds: [], lastDecisionId: null });
      expect(await db.select().from(issueExecutionDecisions)).toEqual([]);
      expect(fixture.writes).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE;
      else process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE = previous;
    }
  });

  it.each([{ draft: true }, { missing: true }])("keeps a pending approval comment unrecorded on a refused final delivery: %j", async (options) => {
    const fixture = await pendingDelivery(options);
    const comment = (body: string) => request(createApp(db, boardActor(fixture.company)))
      .post(`/api/issues/${fixture.issue.id}/comments`).send({ body });
    const refused = await comment("## Review: APPROVED\n\nIndependent final review.");
    expect(refused.status).toBe(409);
    expect(refused.body.details).toMatchObject({ code: "approval_final_delivery_preflight" });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issue.id))).toEqual([]);
    expect((await fixture.read()).executionState).toMatchObject({ status: "pending", completedStageIds: [] });
    expect(await db.select().from(issueExecutionDecisions)).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });

  it("stamps the certified head when the approval comment lands on a ready final delivery", async () => {
    const fixture = await pendingDelivery();
    const response = await request(createApp(db, boardActor(fixture.company)))
      .post(`/api/issues/${fixture.issue.id}/comments`)
      .send({ body: "## Review: APPROVED\n\nIndependent final review." });
    expect(response.status).toBe(201);
    expect((await fixture.read()).status).toBe("done");
    expect(fixture.writes).toEqual([{
      url: `https://api.github.com/repos/TEA-Core/paperclip/statuses/${fixture.pr.head.sha}`,
      body: expect.objectContaining({ state: "success", context: "paperclip/approved" }),
    }]);
  });

  it("closes a final approval comment after its requested run interruption", async () => {
    const fixture = await pendingDelivery({ mergeArmingEnabled: true });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: fixture.company.id,
      agentId: (await fixture.read()).createdByAgentId!,
      status: "running",
      contextSnapshot: { issueId: fixture.issue.id },
    }).returning();
    const beforeInterrupt = new Date(Date.now() - 60_000);
    await db.update(issues).set({
      executionRunId: run!.id,
      checkoutRunId: run!.id,
      executionLockedAt: beforeInterrupt,
      updatedAt: beforeInterrupt,
    }).where(eq(issues.id, fixture.issue.id));

    let response!: request.Response;
    await withIssueTrigger(
      "comment_interrupt_updated_at",
      "OLD.execution_run_id IS NOT NULL AND NEW.execution_run_id IS NULL",
      "NEW.updated_at := clock_timestamp() + interval '1 minute'; return NEW;",
      async () => {
        response = await request(createApp(db, boardActor(fixture.company)))
          .post(`/api/issues/${fixture.issue.id}/comments`)
          .send({ body: "## Review: APPROVED\n\nIndependent final review.", interrupt: true });
      },
    );

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const stored = await fixture.read();
    expect(stored.updatedAt.getTime()).toBeGreaterThan(beforeInterrupt.getTime());
    expect(stored.status).toBe("done");
    expect(stored.executionRunId).toBeNull();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0]?.status).toBe("cancelled");
    expect(await db.select().from(issueExecutionDecisions)).toEqual([
      expect.objectContaining({ issueId: fixture.issue.id, outcome: "approved" }),
    ]);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issue.id))).toEqual(
      expect.arrayContaining([expect.objectContaining({ body: "## Review: APPROVED\n\nIndependent final review." })]),
    );
    expect(fixture.writes).toEqual([{
      url: `https://api.github.com/repos/TEA-Core/paperclip/statuses/${fixture.pr.head.sha}`,
      body: expect.objectContaining({ state: "success", context: "paperclip/approved" }),
    }]);
  });

  it("refuses a final approval comment when the delivery branch changes after external preflight", async () => {
    const fixture = await pendingDelivery({ holdPull: true, mergeArmingEnabled: true });
    const before = await fixture.read();
    const receipts = await db.select().from(issueDeliveryReceipts)
      .where(eq(issueDeliveryReceipts.sourceIssueId, fixture.issue.id));
    const approval = request(createApp(db, boardActor(fixture.company)))
      .post(`/api/issues/${fixture.issue.id}/comments`)
      .send({ body: "## Review: APPROVED\n\nIndependent final review." })
      .then((response) => response);
    const response = await raceAtDecisionTransaction(fixture, approval, async () => {
      await db.update(executionWorkspaces).set({ branchName: "SUP-1-rebound-delivery" })
        .where(eq(executionWorkspaces.id, before.executionWorkspaceId!));
    });
    expect(response.status).toBe(409);
    expect(response.body.details).toMatchObject({ code: "approval_final_delivery_preflight_stale" });
    const stored = await fixture.read();
    expect(stored.status).toBe("in_review");
    expect(stored.executionState).toMatchObject({
      status: "pending", completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
    });
    expect(stored.executionState?.approvalStatus).toBeUndefined();
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issue.id))).toEqual([]);
    expect(await db.select().from(issueExecutionDecisions)).toEqual([]);
    expect(await db.select().from(issueDeliveryReceipts)
      .where(eq(issueDeliveryReceipts.sourceIssueId, fixture.issue.id))).toEqual(receipts);
    expect(fixture.writes).toEqual([]);
    expect(fixture.armCalls).toEqual([]);
  });

  async function seedEscalation(fixture: Awaited<ReturnType<typeof pendingDelivery>>) {
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId: fixture.company.id, issueId: fixture.issue.id, kind: "request_confirmation", status: "pending",
      createdByUserId: "board-user", addresseeUserId: "board-user", continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
      idempotencyKey: `review-escalation:${fixture.issue.id}:${fixture.stageId}:3:0123456789abcdef`,
      payload: { version: 1, prompt: "Approve this review, or request further changes (round cap reached)." },
    }).returning();
    return interaction!;
  }

  for (const door of ["PATCH", "comment", "escalation"] as const) {
    it.each([
      "status", "updatedAt", "delivery binding", "delivery owner", "recorded PR identity",
      "stage transition", "updatedAt during external preflight",
    ] as const)(
      `keeps ${door} final approval pending after a %s mutation`,
      async (change) => {
        const fixture = await pendingDelivery({ holdPull: true, mergeArmingEnabled: true });
        const interaction = door === "escalation" ? await seedEscalation(fixture) : null;
        if (change === "recorded PR identity") {
          const initial = await fixture.read();
          await db.update(issues).set({
            executionState: {
              ...initial.executionState,
              delivery: {
                branch: `${initial.identifier}-delivery`, headSha: fixture.pr.head.sha,
                prNumber: 42, prUrl: "https://github.com/TEA-Core/paperclip/pull/42",
                repo: { owner: "TEA-Core", repo: "paperclip" },
              },
            },
          }).where(eq(issues.id, fixture.issue.id));
        }
        const receiptsBefore = await db.select().from(issueDeliveryReceipts)
          .where(eq(issueDeliveryReceipts.sourceIssueId, fixture.issue.id));
        const events: Array<{ payload: Record<string, unknown> }> = [];
        const unsubscribe = subscribeCompanyLiveEvents(fixture.company.id, (event) => events.push(event));
        const app = createApp(db, boardActor(fixture.company));
        const approval = (
          door === "PATCH"
            ? fixture.approve()
            : door === "comment"
              ? request(app).post(`/api/issues/${fixture.issue.id}/comments`)
                .send({ body: "## Review: APPROVED\n\nIndependent final review." })
              : request(app).post(`/api/issues/${fixture.issue.id}/interactions/${interaction!.id}/accept`)
                .send({})
        ).then((result) => result);
        const mutate = async () => {
          if (change === "status") {
            await db.update(issues).set({ status: "blocked", updatedAt: new Date(Date.now() + 60_000) })
              .where(eq(issues.id, fixture.issue.id));
          } else if (change === "updatedAt" || change === "updatedAt during external preflight") {
            await db.update(issues).set({ updatedAt: new Date(Date.now() + 60_000) })
              .where(eq(issues.id, fixture.issue.id));
          } else if (change === "delivery owner") {
            const unrelated = await seedIssue(db, {
              companyId: fixture.company.id, title: "Unrelated delivery owner",
            });
            const stored = await fixture.read();
            await db.update(executionWorkspaces).set({ sourceIssueId: unrelated.id })
              .where(eq(executionWorkspaces.id, stored.executionWorkspaceId!));
          } else if (change === "delivery binding") {
            const stored = await fixture.read();
            await db.update(executionWorkspaces).set({ branchName: "rebound-delivery" })
              .where(eq(executionWorkspaces.id, stored.executionWorkspaceId!));
          } else {
            const stored = await fixture.read();
            await db.update(issues).set({
              executionState: {
                ...(stored.executionState ?? {}),
                ...(change === "recorded PR identity"
                  ? { delivery: { ...(stored.executionState?.delivery as Record<string, unknown>), prNumber: 43 } }
                  : { currentStageId: randomUUID() }),
              },
              updatedAt: new Date(Date.now() + 60_000),
            }).where(eq(issues.id, fixture.issue.id));
          }
        };
        let response: request.Response;
        try {
          if (change === "updatedAt during external preflight") {
            await fixture.pullReached;
            await mutate();
            fixture.releasePull();
            response = await approval;
          } else {
            response = await raceAtDecisionTransaction(fixture, approval, mutate);
          }
        } finally {
          fixture.releasePull();
          unsubscribe();
        }
        expect(response.status, JSON.stringify(response.body)).toBe(409);
        expect(response.body.details).toMatchObject({ code: "approval_final_delivery_preflight_stale" });
        const stored = await fixture.read();
        expect(stored.status).toBe(change === "status" ? "blocked" : "in_review");
        expect(stored.executionState).toMatchObject({
          status: "pending", completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
        });
        expect(stored.executionState?.approvalStatus).toBeUndefined();
        expect(await db.select().from(issueExecutionDecisions)).toEqual([]);
        if (door === "comment") {
          expect(await db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issue.id))).toEqual([]);
        }
        if (interaction) {
          const [pending] = await db.select().from(issueThreadInteractions)
            .where(eq(issueThreadInteractions.id, interaction.id));
          expect(pending?.status).toBe("pending");
        }
        expect(await db.select().from(issueDeliveryReceipts)
          .where(eq(issueDeliveryReceipts.sourceIssueId, fixture.issue.id))).toEqual(receiptsBefore);
        expect(events.filter((event) => {
          const action = event.payload.action;
          return typeof action === "string" &&
            (action === "issue.updated" || (action.startsWith("issue.done_") && !action.endsWith("_skipped")));
        })).toEqual([]);
        expect(fixture.writes).toEqual([]);
        expect(fixture.armCalls).toEqual([]);
      },
    );
  }

  it.each([{ draft: true }, { missing: true }])("leaves an escalation confirmation pending on a refused final delivery: %j", async (options) => {
    const fixture = await pendingDelivery(options);
    const interaction = await seedEscalation(fixture);
    const response = await request(createApp(db, boardActor(fixture.company)))
      .post(`/api/issues/${fixture.issue.id}/interactions/${interaction.id}/accept`).send({});
    expect(response.status).toBe(409);
    expect(response.body.details).toMatchObject({ code: "approval_final_delivery_preflight" });
    const [stored] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id));
    expect(stored!.status).toBe("pending");
    expect((await fixture.read()).executionState).toMatchObject({ status: "pending", completedStageIds: [] });
    expect(await db.select().from(issueExecutionDecisions)).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });

  it("closes an escalation accept on a ready final delivery and stamps the certified head", async () => {
    const fixture = await pendingDelivery();
    const interaction = await seedEscalation(fixture);
    const response = await request(createApp(db, boardActor(fixture.company)))
      .post(`/api/issues/${fixture.issue.id}/interactions/${interaction.id}/accept`).send({});
    expect(response.status).toBe(200);
    const stored = await fixture.read();
    expect(stored.status).toBe("done");
    const state = stored.executionState as Record<string, unknown>;
    expect((state.approvalStatus as Record<string, unknown>).finalDelivery).toMatchObject({
      owner: "TEA-Core",
      repo: "paperclip",
      number: fixture.pr.number,
      headSha: fixture.pr.head.sha,
      decisionId: state.lastDecisionId,
    });
    expect(fixture.writes).toEqual([{
      url: `https://api.github.com/repos/TEA-Core/paperclip/statuses/${fixture.pr.head.sha}`,
      body: expect.objectContaining({ state: "success", context: "paperclip/approved" }),
    }]);
  });

  it("keeps a final review escalation pending when status changes after external preflight", async () => {
    const fixture = await pendingDelivery({ holdPull: true, mergeArmingEnabled: true });
    const interaction = await seedEscalation(fixture);
    const receipts = await db.select().from(issueDeliveryReceipts)
      .where(eq(issueDeliveryReceipts.sourceIssueId, fixture.issue.id));
    const approval = request(createApp(db, boardActor(fixture.company)))
      .post(`/api/issues/${fixture.issue.id}/interactions/${interaction.id}/accept`)
      .send({}).then((response) => response);
    const response = await raceAtDecisionTransaction(fixture, approval, async () => {
      await db.update(issues).set({ status: "blocked", updatedAt: new Date(Date.now() + 60_000) })
        .where(eq(issues.id, fixture.issue.id));
    });
    expect(response.status).toBe(409);
    expect(response.body.details).toMatchObject({ code: "approval_final_delivery_preflight_stale" });
    const stored = await fixture.read();
    expect(stored.status).toBe("blocked");
    expect(stored.executionState).toMatchObject({
      status: "pending", completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
    });
    expect(stored.executionState?.approvalStatus).toBeUndefined();
    const [pending] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interaction.id));
    expect(pending?.status).toBe("pending");
    expect(await db.select().from(issueExecutionDecisions)).toEqual([]);
    expect(await db.select().from(issueDeliveryReceipts)
      .where(eq(issueDeliveryReceipts.sourceIssueId, fixture.issue.id))).toEqual(receipts);
    expect(fixture.writes).toEqual([]);
    expect(fixture.armCalls).toEqual([]);
  });

  async function withIssueTrigger(name: string, when: string, body: string, run: () => Promise<void>) {
    await db.execute(sql.raw(`create or replace function ${name}() returns trigger language plpgsql as $$ begin ${body} end $$`));
    await db.execute(sql.raw(`create trigger ${name} before update on issues for each row when (${when}) execute function ${name}()`));
    try {
      await run();
    } finally {
      await db.execute(sql.raw(`drop trigger if exists ${name} on issues`));
      await db.execute(sql.raw(`drop function if exists ${name}()`));
    }
  }

  async function holdAgentRun(fixture: Awaited<ReturnType<typeof pendingDelivery>>) {
    const agentId = (await fixture.read()).createdByAgentId!;
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: fixture.company.id, agentId, status: "running",
    }).returning();
    await db.update(issues).set({
      assigneeAgentId: agentId, assigneeUserId: null, executionRunId: run!.id, executionLockedAt: new Date(),
    }).where(eq(issues.id, fixture.issue.id));
    return run!;
  }

  async function staleRunFinalReview(fixture: Awaited<ReturnType<typeof pendingDelivery>>) {
    const authorId = (await fixture.read()).createdByAgentId!;
    const [author] = await db.select().from(agents).where(eq(agents.id, authorId));
    const other = await seedAgent(db, fixture.company.id);
    const [actorRun, staleCheckout, staleExecution] = await db.insert(heartbeatRuns).values([
      { companyId: fixture.company.id, agentId: authorId, status: "running", contextSnapshot: { issueId: fixture.issue.id } },
      { companyId: fixture.company.id, agentId: other.id, status: "succeeded", contextSnapshot: { issueId: fixture.issue.id }, startedAt: new Date(), finishedAt: new Date() },
      { companyId: fixture.company.id, agentId: other.id, status: "succeeded", contextSnapshot: { issueId: fixture.issue.id }, startedAt: new Date(), finishedAt: new Date() },
    ]).returning();
    const initial = await fixture.read();
    await db.update(issues).set({
      status: "in_progress", assigneeAgentId: authorId, assigneeUserId: null,
      checkoutRunId: staleCheckout!.id, executionRunId: staleExecution!.id,
      executionPolicy: {
        mode: "normal", commentRequired: true, returnAssigneeAgentId: authorId,
        stages: [{ id: fixture.stageId, type: "review", approvalsNeeded: 1,
          participants: [{ type: "agent", agentId: authorId, userId: null }] }],
      },
      executionState: {
        ...initial.executionState,
        currentParticipant: { type: "agent", agentId: authorId, userId: null },
        returnAssignee: { type: "agent", agentId: authorId, userId: null },
      },
    }).where(eq(issues.id, fixture.issue.id));
    return {
      app: createApp(db, agentActor(fixture.company, author!, actorRun!.id)),
      actorRun: actorRun!,
      comment: "Looks good.\n\nkind: review\ndecision: approved\n\nClosed at Tier 2 (live): the stage participant re-ran the close against the armed card and the delivery ref is unchanged.",
    };
  }

  const reassignToBoardUser = { assigneeAgentId: null, assigneeUserId: "board-user" };

  it("approves a final PATCH whose own run cancellation bumps updatedAt", async () => {
    const fixture = await pendingDelivery();
    const run = await holdAgentRun(fixture);
    const response = await fixture.approve(reassignToBoardUser);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const stored = await fixture.read();
    expect(stored.status).toBe("done");
    expect(stored.executionRunId).toBeNull();
    const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(cancelled?.status).toBe("cancelled");
    expect(await db.select().from(issueExecutionDecisions)).toEqual([expect.objectContaining({ outcome: "approved" })]);
    expect(fixture.writes).toHaveLength(1);
  });

  it("approves a final PATCH after returning an idle agent assignment", async () => {
    const fixture = await pendingDelivery();
    const agentId = (await fixture.read()).createdByAgentId!;
    await db.update(issues).set({ assigneeAgentId: agentId, assigneeUserId: null })
      .where(eq(issues.id, fixture.issue.id));
    const response = await fixture.approve(reassignToBoardUser);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await fixture.read()).status).toBe("done");
    expect(await db.select().from(issueExecutionDecisions)).toEqual([expect.objectContaining({ outcome: "approved" })]);
    expect(fixture.writes).toHaveLength(1);
  });

  it("approves a final PATCH after its own stale checkout adoption without a recovery action", async () => {
    const fixture = await pendingDelivery();
    const { app, comment } = await staleRunFinalReview(fixture);
    const response = await request(app).patch(`/api/issues/${fixture.issue.id}`)
      .send({ status: "done", comment });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const stored = await fixture.read();
    expect(stored.status).toBe("done");
    expect(stored.executionState).toMatchObject({
      lastDecisionOutcome: "approved", completedStageIds: [fixture.stageId],
    });
    expect(await db.select().from(issueExecutionDecisions)).toEqual([
      expect.objectContaining({ outcome: "approved", stageId: fixture.stageId }),
    ]);
  });

  it("refuses an outside timestamp change after its own stale checkout adoption", async () => {
    const fixture = await pendingDelivery({ holdPull: true, mergeArmingEnabled: true });
    const { app, comment, actorRun } = await staleRunFinalReview(fixture);
    const receipts = await db.select().from(issueDeliveryReceipts)
      .where(eq(issueDeliveryReceipts.sourceIssueId, fixture.issue.id));
    const pending = request(app).patch(`/api/issues/${fixture.issue.id}`)
      .send({ status: "done", comment }).then((response) => response);
    let response: request.Response;
    try {
      await fixture.pullReached;
      expect((await fixture.read()).checkoutRunId).toBe(actorRun.id);
      await db.update(issues).set({ updatedAt: new Date(Date.now() + 60_000) })
        .where(eq(issues.id, fixture.issue.id));
      fixture.releasePull();
      response = await pending;
    } finally {
      fixture.releasePull();
    }
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.details).toMatchObject({ code: "approval_final_delivery_preflight_stale" });
    const stored = await fixture.read();
    expect(stored.status).toBe("in_progress");
    expect(stored.executionState).toMatchObject({
      status: "pending", completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
    });
    expect(stored.executionState?.approvalStatus).toBeUndefined();
    expect(await db.select().from(issueExecutionDecisions)).toEqual([]);
    expect(await db.select().from(issueDeliveryReceipts)
      .where(eq(issueDeliveryReceipts.sourceIssueId, fixture.issue.id))).toEqual(receipts);
    expect(fixture.writes).toEqual([]);
    expect(fixture.armCalls).toEqual([]);
  });

  it.each([
    ["title", "NEW.title := 'Renamed while the run was cancelled';"],
    ["execution policy", `NEW.execution_policy := NEW.execution_policy || '{"commentRequired": true}'::jsonb;`],
    ["execution state", `NEW.execution_state := NEW.execution_state || '{"lastDecisionOutcome": "changes_requested"}'::jsonb;`],
  ])("refuses a final PATCH when a concurrent %s change lands during its own run cancellation", async (_label, mutation) => {
    const fixture = await pendingDelivery({ mergeArmingEnabled: true });
    await holdAgentRun(fixture);
    let response!: request.Response;
    await withIssueTrigger(
      "sup20467_concurrent_change",
      "OLD.execution_run_id is not null and NEW.execution_run_id is null",
      `${mutation} return NEW;`,
      async () => { response = await fixture.approve(reassignToBoardUser); },
    );
    expect(response.status).toBe(409);
    expect(response.body.details).toMatchObject({ code: "approval_final_delivery_preflight_stale" });
    const stored = await fixture.read();
    expect(stored.status).toBe("in_review");
    expect(stored.executionState?.completedStageIds).toEqual([]);
    expect(stored.executionState?.approvalStatus).toBeUndefined();
    expect(await db.select().from(issueExecutionDecisions)).toEqual([]);
    expect(fixture.writes).toEqual([]);
    expect(fixture.armCalls).toEqual([]);
  });

  it("publishes nothing and keeps the escalation pending when the accept transaction fails after the decision", async () => {
    const fixture = await pendingDelivery({ mergeArmingEnabled: true });
    const interaction = await seedEscalation(fixture);
    const events: unknown[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(fixture.company.id, (event) => events.push(event));
    let response!: request.Response;
    try {
      await withIssueTrigger(
        "sup20467_fail_after_decision",
        "OLD.status = 'done' and NEW.status = 'done'",
        "raise exception 'forced failure after the escalation decision';",
        async () => {
          response = await request(createApp(db, boardActor(fixture.company)))
            .post(`/api/issues/${fixture.issue.id}/interactions/${interaction.id}/accept`).send({});
        },
      );
    } finally {
      unsubscribe();
    }
    expect(response.status).toBe(500);
    const stored = await fixture.read();
    expect(stored.status).toBe("in_review");
    expect(stored.executionState).toMatchObject({ status: "pending", completedStageIds: [], lastDecisionId: null });
    const [pending] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id));
    expect(pending?.status).toBe("pending");
    expect(await db.select().from(issueExecutionDecisions)).toEqual([]);
    expect(events.filter((event) => {
      const action = (event as { payload?: { action?: string } }).payload?.action ?? "";
      return !action.startsWith("issue.done_");
    })).toEqual([]);
    expect(fixture.writes).toEqual([]);
    expect(fixture.armCalls).toEqual([]);
  });

  it("preserves the reviewed anchor and stamps nothing when an escalation accept races a content push", async () => {
    const fixture = await pendingDelivery();
    const interaction = await seedEscalation(fixture);
    fixture.moveHead();
    const response = await request(createApp(db, boardActor(fixture.company)))
      .post(`/api/issues/${fixture.issue.id}/interactions/${interaction.id}/accept`).send({});
    expect(response.status).toBe(200);
    const stored = await fixture.read();
    expect(stored.status).toBe("done");
    expect(stored.executionState).toMatchObject({
      approvalStatus: {
        approvedHeadSha: fixture.pr.head.sha,
        publishSkipped: expect.objectContaining({ reason: expect.stringContaining("head_moved") }),
      },
    });
    expect(fixture.writes).toEqual([]);
  });

  it("answers an escalation accept from a non-participant without a server error", async () => {
    const fixture = await pendingDelivery({ draft: true });
    const interaction = await seedEscalation(fixture);
    const outsider = { ...boardActor(fixture.company), userId: "other-board-user", isInstanceAdmin: false };
    const response = await request(createApp(db, outsider as Express.Request["actor"]))
      .post(`/api/issues/${fixture.issue.id}/interactions/${interaction.id}/accept`).send({});
    expect(response.status).toBeLessThan(500);
    expect(await db.select().from(issueExecutionDecisions)).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });

  async function recoverFinalReview(fixture: Awaited<ReturnType<typeof pendingDelivery>>) {
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId: fixture.company.id, sourceIssueId: fixture.issue.id, kind: "stranded_assigned_issue",
      status: "active", ownerType: "board", cause: "stranded_assigned_issue", fingerprint: "recovery:final-review",
      nextAction: "Complete the final review.",
    }).returning();
    return request(createApp(db, boardActor(fixture.company)))
      .post(`/api/issues/${fixture.issue.id}/recovery-actions/resolve`)
      .send({ actionId: action!.id, outcome: "restored", sourceIssueStatus: "done", resolutionNote: "Final review approved." });
  }

  it.each([{ draft: true }, { missing: true }])("refuses a recovery-resolution approval on a refused final delivery: %j", async (options) => {
    const fixture = await pendingDelivery(options);
    const response = await recoverFinalReview(fixture);
    expect(response.status).toBe(409);
    expect(response.body.details ?? response.body).toMatchObject({ code: "approval_final_delivery_preflight" });
    expect((await fixture.read()).status).toBe("in_review");
    expect((await fixture.read()).executionState).toMatchObject({ status: "pending", completedStageIds: [] });
    expect(await db.select().from(issueExecutionDecisions)).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });

  it("stamps the certified head when a recovery resolution approves a ready final delivery", async () => {
    const fixture = await pendingDelivery();
    const response = await recoverFinalReview(fixture);
    expect(response.status).toBe(200);
    expect((await fixture.read()).status).toBe("done");
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
