import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  issueWorkProducts,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { createCompanySearchRateLimiter } from "../services/company-search-rate-limit.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import type { StorageService } from "../storage/types.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("bounded bulk issue read", () => {
  let tempDb: EmbeddedPostgresTestDatabase;
  let db: Db;
  let companyId: string;
  let foreignCompanyId: string;
  let agentId: string;
  let issueIds: string[];
  let identifiers: string[];
  let conformanceParentId: string;
  let conformanceChildId: string;
  let conformanceOutOfScopeChildId: string;
  let conformanceWorkspaceId: string;
  let conformanceChildCreatedAt: Date;
  const limiter = createCompanySearchRateLimiter({ maxRequests: 2 });

  function app(actor: Express.Request["actor"]) {
    const server = express();
    server.use((req, _res, next) => { req.actor = actor; next(); });
    server.use("/api", issueRoutes(db, {} as StorageService, { bulkIssueRateLimiter: limiter }));
    server.use(errorHandler);
    return server;
  }

  function board(keyId = randomUUID(), accessibleCompanyId = companyId): Express.Request["actor"] {
    return {
      type: "board", userId: "board-user", keyId, companyIds: [accessibleCompanyId],
      memberships: [{ companyId: accessibleCompanyId, membershipRole: "operator", status: "active" }],
      source: "board_key", isInstanceAdmin: true,
    };
  }

  function agent(keyId = randomUUID(), keyScope?: { kind: "task_bridge"; parentIssueId: string }): Express.Request["actor"] {
    return {
      type: "agent", agentId, companyId, keyId, source: "agent_key",
      ...(keyScope ? { keyScope } : {}),
    };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-bulk-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    foreignCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Bulk", issuePrefix: "BK", requireBoardApprovalForNewAgents: false },
      { id: foreignCompanyId, name: "Foreign", issuePrefix: "FR", requireBoardApprovalForNewAgents: false },
    ]);
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: "Poller", role: "engineer", status: "active",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    issueIds = Array.from({ length: 9 }, () => randomUUID());
    identifiers = issueIds.map((_, index) => `BK-${index + 1}`);
    await db.insert(issues).values(issueIds.map((id, index) => ({
      id, companyId, identifier: identifiers[index], issueNumber: index + 1,
      title: `Bulk issue ${index + 1}`, status: "todo", priority: "medium" as const,
      assigneeAgentId: index === 0 ? agentId : null,
    })));
    await db.insert(issues).values({
      companyId: foreignCompanyId, identifier: "FR-1", issueNumber: 1,
      title: "Foreign issue", status: "todo", priority: "medium",
    });

    const projectId = randomUUID();
    conformanceParentId = randomUUID();
    conformanceChildId = randomUUID();
    conformanceOutOfScopeChildId = randomUUID();
    conformanceWorkspaceId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Conformance" });
    await db.insert(issues).values([
      {
        id: conformanceParentId, companyId, projectId, identifier: "BK-200", issueNumber: 200,
        title: "Conformance parent", status: "todo", priority: "medium",
      },
      {
        id: conformanceOutOfScopeChildId, companyId, projectId,
        identifier: "BK-202", issueNumber: 202, title: "Out of scope", status: "todo", priority: "medium",
      },
    ]);
    conformanceChildCreatedAt = new Date("2026-10-21T17:00:00.000Z");
    await db.insert(issues).values({
      id: conformanceChildId, companyId, projectId, parentId: conformanceParentId,
      identifier: "BK-201", issueNumber: 201, title: "In scope", status: "todo", priority: "medium",
      createdAt: conformanceChildCreatedAt,
    });
    await db.insert(executionWorkspaces).values({
      id: conformanceWorkspaceId, companyId, projectId, sourceIssueId: conformanceChildId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "conformance-child",
      status: "active", branchName: "feature/conformance-child", providerType: "git_worktree",
      metadata: { deliveryState: "merged_by_ancestry" },
    });
    await db.update(issues).set({ executionWorkspaceId: conformanceWorkspaceId }).where(eq(issues.id, conformanceChildId));
    await db.insert(issueWorkProducts).values({
      companyId, projectId, issueId: conformanceChildId, executionWorkspaceId: conformanceWorkspaceId,
      type: "pull_request", provider: "github", title: "Conformance PR", status: "merged",
      reviewState: "none", healthStatus: "healthy", metadata: { mergedAt: "2026-10-21T17:30:00.000Z" }, url: "https://github.com/example/repo/pull/1",
    });
  }, 30_000);

  afterAll(async () => { await tempDb?.cleanup(); });

  it("returns compact rows in requested order and treats foreign/unknown identifiers as missing", async () => {
    const res = await request(app(board())).get(`/api/companies/${companyId}/issues/bulk`)
      .query({ identifiers: "BK-2,FR-1,BK-1,BK-999" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.issues.map((row: { identifier: string }) => row.identifier)).toEqual(["BK-2", "BK-1"]);
    expect(res.body.missing).toEqual(["FR-1", "BK-999"]);
    expect(res.body.issues[0]).not.toHaveProperty("ancestors");
    expect(res.body.issues[0]).not.toHaveProperty("currentExecutionWorkspace");
  });

  it("returns plugin-operation issues by explicit id or identifier like single read", async () => {
    const pluginIssueId = randomUUID();
    await db.insert(issues).values({
      id: pluginIssueId, companyId, identifier: "BK-100", issueNumber: 100,
      title: "Plugin operation", status: "todo", priority: "medium",
      originKind: "plugin:acme.sync:operation",
    });
    const single = await request(app(board())).get(`/api/issues/${pluginIssueId}`);
    expect(single.status).toBe(200);
    const endpoint = `/api/companies/${companyId}/issues/bulk`;
    const byId = await request(app(board())).get(endpoint).query({ ids: pluginIssueId });
    expect(byId.body.issues.map((row: { id: string }) => row.id)).toEqual([pluginIssueId]);
    expect(byId.body.missing).toEqual([]);
    const byIdentifier = await request(app(board())).get(endpoint).query({ identifiers: "BK-100" });
    expect(byIdentifier.body.issues.map((row: { identifier: string }) => row.identifier)).toEqual(["BK-100"]);
    expect(byIdentifier.body.missing).toEqual([]);
  });

  it("enforces company boundaries and item cap before querying", async () => {
    const outsider = await request(app(board(randomUUID(), foreignCompanyId)))
      .get(`/api/companies/${companyId}/issues/bulk`).query({ ids: issueIds[0] });
    expect(outsider.status).toBe(403);
    for (const query of [
      { ids: Array.from({ length: 51 }, () => randomUUID()).join(",") },
      { ids: "" }, { ids: issueIds[0], identifiers: "BK-1" },
    ]) {
      const res = await request(app(board())).get(`/api/companies/${companyId}/issues/bulk`).query(query);
      expect(res.status).toBe(400);
    }
  });

  it("applies a separate request budget to each token", async () => {
    const key = randomUUID();
    const endpoint = `/api/companies/${companyId}/issues/bulk`;
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await request(app(board(key))).get(endpoint).query({ ids: issueIds[0] })).status).toBe(200);
    }
    const denied = await request(app(board(key))).get(endpoint).query({ ids: issueIds[0] });
    expect(denied.status).toBe(429);
    expect(denied.headers["retry-after"]).toBeDefined();
    expect((await request(app(board())).get(endpoint).query({ ids: issueIds[0] })).status).toBe(200);
  });

  it("keeps budgets separate for board sessions of the same user", async () => {
    const actor: Express.Request["actor"] = {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      source: "session",
      isInstanceAdmin: true,
    };
    const server = app(actor);
    const endpoint = `/api/companies/${companyId}/issues/bulk`;
    for (const cookie of ["paperclip.session=first", "paperclip.session=second"]) {
      for (const status of [200, 200, 429]) {
        const response = await request(server).get(endpoint)
          .set("Cookie", cookie).query({ ids: issueIds[0] });
        expect(response.status).toBe(status);
      }
    }
  });

  it("lets regular agents read but applies single-read authorization to restricted keys", async () => {
    const regular = await request(app(agent())).get(`/api/companies/${companyId}/issues/bulk`)
      .query({ ids: issueIds[0] });
    expect(regular.status, JSON.stringify(regular.body)).toBe(200);
    expect(regular.body.issues.map((row: { id: string }) => row.id)).toEqual([issueIds[0]]);
    const restricted = agent(randomUUID(), { kind: "task_bridge", parentIssueId: issueIds[0] });
    const single = await request(app(restricted)).get(`/api/issues/${issueIds[1]}`);
    const bulk = await request(app(restricted)).get(`/api/companies/${companyId}/issues/bulk`)
      .query({ ids: `${issueIds[0]},${issueIds[1]}` });
    expect(single.status).toBe(403);
    expect(bulk.status, JSON.stringify(bulk.body)).toBe(200);
    expect(bulk.body.issues.map((row: { id: string }) => row.id)).toEqual([issueIds[0]]);
    expect(bulk.body.missing).toEqual([issueIds[1]]);
  });

  it("preserves active recovery and required handoff fields from the compact list", async () => {
    const sourceRunId = randomUUID();
    const recoveryAction = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId: issueIds[0],
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: agentId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:bulk-route",
      evidence: { sourceRunId },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.successful_run_handoff_required",
      entityType: "issue",
      entityId: issueIds[0],
      agentId,
      runId: null,
      details: {
        sourceRunId,
        detectedProgressSummary: "A successful run needs a disposition.",
      },
    });

    const server = app(board());
    const list = await request(server).get(`/api/companies/${companyId}/issues`)
      .query({ view: "compact", limit: "20" });
    const bulk = await request(server).get(`/api/companies/${companyId}/issues/bulk`)
      .query({ ids: issueIds[0] });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(bulk.status, JSON.stringify(bulk.body)).toBe(200);
    const listedIssue = list.body.find((row: { id: string }) => row.id === issueIds[0]);
    expect(listedIssue.activeRecoveryAction.id).toBe(recoveryAction.id);
    expect(listedIssue.successfulRunHandoff).toMatchObject({
      state: "required",
      sourceRunId,
    });
    expect(bulk.body.issues[0].activeRecoveryAction).toMatchObject({
      id: recoveryAction.id,
      sourceIssueId: issueIds[0],
    });
    expect(bulk.body.issues[0].successfulRunHandoff).toMatchObject({
      state: "required",
      sourceRunId,
    });
  });

  it("projects only direct children with hydrated delivery state and PR products", async () => {
    const server = app(board());
    const response = await request(server).get(`/api/issues/${conformanceParentId}/children/conformance`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      id: conformanceChildId,
      identifier: "BK-201",
      currentExecutionWorkspace: {
        branchName: "feature/conformance-child",
        deliveryState: "merged_via_pr",
      },
      workProducts: [{ type: "pull_request", title: "Conformance PR" }],
    });
  });

  it("rejects invalid conformance projection bounds", async () => {
    const endpoint = `/api/issues/${conformanceParentId}/children/conformance`;
    const invalidLimit = await request(app(board())).get(endpoint).query({ limit: "51" });
    expect(invalidLimit.status, "limit").toBe(400);
    const emptyCutover = await request(app(board())).get(endpoint).query({ cutoverAt: "" });
    expect(emptyCutover.status, "empty cutoverAt").toBe(400);
    const invalidCutover = await request(app(board())).get(endpoint).query({ cutoverAt: "not-a-date" });
    expect(invalidCutover.status, "invalid cutoverAt").toBe(400);
    const arrayCutover = await request(app(board())).get(
      `${endpoint}?cutoverAt=${encodeURIComponent(conformanceChildCreatedAt.toISOString())}&cutoverAt=${encodeURIComponent(conformanceChildCreatedAt.toISOString())}`,
    );
    expect(arrayCutover.status, "array cutoverAt").toBe(400);
  });

  it("rejects malformed conformance cursors", async () => {
    const cursor = Buffer.from(JSON.stringify({
      createdAt: conformanceChildCreatedAt.toISOString(),
      id: "not-a-uuid",
    })).toString("base64url");
    const response = await request(app(board())).get(
      `/api/issues/${conformanceParentId}/children/conformance`,
    ).query({ cursor });

    expect(response.status).toBe(400);
  });

  it("applies cutover and cursor bounds to direct-child pages", async () => {
    const cursor = Buffer.from(JSON.stringify({
      createdAt: "2026-10-21T17:00:00.000000Z",
      id: conformanceChildId,
    })).toString("base64url");
    const response = await request(app(board())).get(
      `/api/issues/${conformanceParentId}/children/conformance`,
    ).query({ cutoverAt: conformanceChildCreatedAt.toISOString(), cursor });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.items).toEqual([]);
    expect(response.body.nextCursor).toBeNull();
  });

  it("keeps SQL statement count flat when requesting more issue IDs", async () => {
    const actor = board();
    const server = app(actor);
    const spy = vi.spyOn(db, "select");
    try {
      const detail = await request(server).get(`/api/issues/${issueIds[0]}`);
      const detailCount = spy.mock.calls.length;
      spy.mockClear();
      const endpoint = `/api/companies/${companyId}/issues/bulk`;
      const one = await request(server).get(endpoint).query({ ids: issueIds[0] });
      const oneCount = spy.mock.calls.length;
      spy.mockClear();
      const many = await request(server).get(endpoint).query({ ids: issueIds.join(",") });
      const manyCount = spy.mock.calls.length;
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      expect(one.status, JSON.stringify(one.body)).toBe(200);
      expect(many.status, JSON.stringify(many.body)).toBe(200);
      expect(many.body.issues).toHaveLength(issueIds.length);
      expect(manyCount).toBe(oneCount);
      expect(manyCount).toBeLessThan(detailCount * issueIds.length);
    } finally {
      spy.mockRestore();
    }
  });
});
