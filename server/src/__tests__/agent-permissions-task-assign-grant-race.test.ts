import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { accessService } from "../services/access.js";
import type * as Services from "../services/index.js";

// Barrier inside the permissions transaction: it runs after the route has read
// the projection and the stored grant rows, and before it writes.
const barrier = vi.hoisted(() => ({ beforeUpdatePermissions: null as null | (() => Promise<void>) }));

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Services>();
  return {
    ...actual,
    agentService: (db: Db) => {
      const svc = actual.agentService(db);
      return {
        ...svc,
        updatePermissions: async (...args: Parameters<typeof svc.updatePermissions>) => {
          await barrier.beforeUpdatePermissions?.();
          return svc.updatePermissions(...args);
        },
      };
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent permissions task-assign grant race tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

function createApp(db: Db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "local-board", source: "local_implicit" };
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("PATCH /agents/:id/permissions false request against a concurrent grant writer", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-permissions-grant-race-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    barrier.beforeUpdatePermissions = null;
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("deletes a tasks:assign grant that another writer commits after the request read none", async () => {
    const nonce = randomUUID().slice(0, 8);
    const [company] = await db
      .insert(companies)
      .values({ name: `Race Co ${nonce}`, issuePrefix: `RC${nonce.slice(0, 4).toUpperCase()}` })
      .returning();
    // No membership row and no grant: the request projects "none" and reads no
    // stored grant, so canAssignTasks=false matches the projection.
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        name: "Target",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: { canCreateAgents: false, canCreateSkills: true },
      })
      .returning();

    let competingWriteCommitted = false;
    barrier.beforeUpdatePermissions = async () => {
      // A grant writer that does not take the agent row lock commits here.
      await accessService(db).setPrincipalPermission(
        company!.id,
        "agent",
        agent!.id,
        "tasks:assign",
        true,
        "competing-writer",
      );
      competingWriteCommitted = true;
    };

    const res = await request(createApp(db))
      .patch(`/api/agents/${agent!.id}/permissions`)
      .send({ canCreateAgents: false, canCreateSkills: false, canAssignTasks: false });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(competingWriteCommitted).toBe(true);
    const grants = await db
      .select()
      .from(principalPermissionGrants)
      .where(and(
        eq(principalPermissionGrants.companyId, company!.id),
        eq(principalPermissionGrants.principalType, "agent"),
        eq(principalPermissionGrants.principalId, agent!.id),
        eq(principalPermissionGrants.permissionKey, "tasks:assign"),
      ));
    expect(grants).toEqual([]);
  });
});
