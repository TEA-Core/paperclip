import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { createCompanySearchRateLimiter } from "../services/company-search-rate-limit.js";
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
