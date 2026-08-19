import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/index.js";
import { companyService } from "../services/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeMergeArmingFlag = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping merge-arming flag route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeMergeArmingFlag("PATCH /api/companies/:companyId mergeArmingEnabled (SUP-13366)", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-flag-");
    db = createDb(tempDb.connectionString);
    const [company] = await db
      .insert(companies)
      .values({ name: "Flag Test Co", issuePrefix: "FLG" })
      .returning();
    companyId = company!.id;
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { actor?: unknown }).actor = actor;
      next();
    });
    app.use("/api/companies", companyRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function insertCeoAgent() {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "CEO Agent",
        role: "ceo",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning();
    return agent!;
  }

  it("rejects an agent PATCH of mergeArmingEnabled and the flag stays false", async () => {
    const svc = companyService(db);
    expect((await svc.getById(companyId)).mergeArmingEnabled).toBe(false);

    const ceoAgent = await insertCeoAgent();
    const agentApp = createApp({
      type: "agent",
      agentId: ceoAgent.id,
      companyId,
      source: "agent_key",
      runId: randomUUID(),
    });

    const res = await request(agentApp)
      .patch(`/api/companies/${companyId}`)
      .send({ mergeArmingEnabled: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("mergeArmingEnabled");

    expect((await svc.getById(companyId)).mergeArmingEnabled).toBe(false);
  });

  it("accepts a board PATCH of mergeArmingEnabled=true and persists it", async () => {
    const boardApp = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: true,
    });

    const res = await request(boardApp)
      .patch(`/api/companies/${companyId}`)
      .send({ mergeArmingEnabled: true });
    expect(res.status).toBe(200);
    expect(res.body.mergeArmingEnabled).toBe(true);

    const reRead = await request(boardApp).get(`/api/companies/${companyId}`);
    expect(reRead.status).toBe(200);
    expect(reRead.body.mergeArmingEnabled).toBe(true);

    const svc = companyService(db);
    expect((await svc.getById(companyId)).mergeArmingEnabled).toBe(true);
  });
});
