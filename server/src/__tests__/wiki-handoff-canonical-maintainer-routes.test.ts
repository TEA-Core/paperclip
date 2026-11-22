import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  pluginEntities,
  pluginManagedResources,
  plugins,
  projects,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { agentService } from "../services/agents.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueRoutes } from "../routes/issues.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Wiki handoff canonical-maintainer route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const HANDOFF_TITLE = "[PPC ER] Weekly Report — 2026-11-21 — handoff to Wiki Maintainer";
const PLUGIN_KEY = "paperclipai.plugin-llm-wiki";
const AGENT_KEY = "wiki-maintainer";
const REVIEWER_USER_ID = "board-user";

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as StorageService));
  app.use(errorHandler);
  return app;
}

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: REVIEWER_USER_ID,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function userReviewPolicy() {
  return {
    mode: "normal",
    commentRequired: true,
    stages: [
      {
        type: "review",
        approvalsNeeded: 1,
        participants: [{ type: "user", userId: REVIEWER_USER_ID }],
      },
    ],
  };
}

function maintainerMetadata(pluginId: string) {
  return {
    paperclipManagedResource: {
      pluginId,
      pluginKey: PLUGIN_KEY,
      resourceKind: "agent",
      resourceKey: AGENT_KEY,
    },
    pluginManagedAgent: {
      pluginId,
      pluginKey: PLUGIN_KEY,
      agentKey: AGENT_KEY,
      displayName: "Wiki Maintainer",
    },
  };
}
describeEmbeddedPostgres("Wiki handoff canonical maintainer lookup (SUP-24936)", () => {
  let db!: Db;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wiki-handoff-canonical-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // An admitted assignee write dispatches a fire-and-forget wakeup; drain it
    // before tearing rows down so it cannot race the deletes.
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await db.delete(plugins);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedWikiCompany(resourceId: "maintainer" | "stale" | "unresolvable") {
    const nonce = randomUUID().slice(0, 8);
    const [company] = await db.insert(companies).values({
      name: `Wiki ${nonce}`,
      issuePrefix: `WM${nonce.slice(0, 4).toUpperCase()}`,
      defaultResponsibleUserId: REVIEWER_USER_ID,
      requireBoardApprovalForNewAgents: false,
    }).returning();
    const pluginId = randomUUID();
    const agentBase = {
      companyId: company!.id,
      role: "engineer",
      status: "idle" as const,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: { pluginTools: [PLUGIN_KEY] },
    };
    const [maintainer, intruder, stale] = await db.insert(agents).values([
      {
        ...agentBase,
        name: "Wiki Maintainer",
        metadata: maintainerMetadata(pluginId),
      },
      { ...agentBase, name: "coder-LE", metadata: {} },
      { ...agentBase, name: "Stale Maintainer", metadata: {} },
    ]).returning();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: PLUGIN_KEY,
      packageName: "@paperclipai/plugin-llm-wiki",
      version: "0.1.0",
      apiVersion: 1,
      categories: [],
      manifestJson: {} as never,
      status: "ready",
      installOrder: 1,
    });
    await db.insert(pluginEntities).values({
      pluginId,
      companyId: company!.id,
      entityType: "managed_agent",
      scopeKind: "company",
      scopeId: company!.id,
      externalId: `managed:agent:${company!.id}:${AGENT_KEY}`,
      title: "Wiki Maintainer",
      status: "resolved",
      data: {
        pluginKey: PLUGIN_KEY,
        resourceKind: "agent",
        resourceKey: AGENT_KEY,
        agentId: maintainer!.id,
      },
    });
    await db.insert(pluginManagedResources).values({
      companyId: company!.id,
      pluginId,
      pluginKey: PLUGIN_KEY,
      resourceKind: "agent",
      resourceKey: AGENT_KEY,
      resourceId: resourceId === "maintainer" ? maintainer!.id : resourceId === "stale" ? stale!.id : randomUUID(),
      defaultsJson: {},
    });
    await db.insert(companyMemberships).values({
      companyId: company!.id,
      principalType: "user",
      principalId: REVIEWER_USER_ID,
      status: "active",
      membershipRole: "operator",
    });
    return { company: company!, maintainer: maintainer!, intruder: intruder!, stale: stale! };
  }

  let issueCounter = 0;
  async function seedUnassignedHandoff(companyId: string) {
    issueCounter += 1;
    const [issue] = await db.insert(issues).values({
      companyId,
      title: HANDOFF_TITLE,
      description: "interrupted create stub",
      status: "backlog",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      issueNumber: issueCounter,
      identifier: `WM-${issueCounter}`,
      executionPolicy: userReviewPolicy(),
      executionState: null,
    }).returning();
    return issue!;
  }

  async function readAssignee(issueId: string) {
    const [row] = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    return row;
  }

  it.each(["retitled", "reused"])("refuses adoption of a %s title-shaped manual card", async (shape) => {
    const { company } = await seedWikiCompany("maintainer");
    issueCounter += 1;
    const [manual] = await db.insert(issues).values({
      companyId: company.id,
      title: shape === "retitled" ? "Unrelated manual follow-up" : HANDOFF_TITLE,
      description: "Ordinary manually created work",
      originKind: "manual",
      originId: null,
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      issueNumber: issueCounter,
      identifier: `WM-${issueCounter}`,
      executionPolicy: userReviewPolicy(),
      executionState: null,
    }).returning();
    const app = createApp(db, { ...boardActor(company.id), isInstanceAdmin: false });
    const res = await request(app).patch(`/api/issues/${manual!.id}`).send({
      ...(shape === "retitled" ? { title: HANDOFF_TITLE } : {}),
      description: "Repair an unrelated manual card",
    });
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ reason: "wiki_handoff_unassigned" });
    expect(await readAssignee(manual!.id)).toMatchObject({
      assigneeAgentId: null,
      assigneeUserId: null,
      status: "todo",
    });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, company.id))).toEqual([]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id))).toEqual([]);
  });

  it("ignores a foreign marked maintainer when resolving the company-local fallback", async () => {
    const { company, maintainer } = await seedWikiCompany("unresolvable");
    await db.delete(pluginManagedResources);
    await db.delete(pluginEntities);
    const [foreignCompany] = await db.insert(companies).values({
      name: "Foreign Wiki company",
      issuePrefix: `FW${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    await db.insert(agents).values({
      companyId: foreignCompany!.id,
      name: "Foreign Wiki Maintainer",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      metadata: maintainer.metadata,
    });
    const stub = await seedUnassignedHandoff(company.id);
    const res = await request(createApp(db, boardActor(company.id)))
      .patch(`/api/issues/${stub.id}`).send({ description: "Repair the local handoff" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await readAssignee(stub.id))?.assigneeAgentId).toBe(maintainer.id);
  });

  it.each(["engineer", "pm"] as const)("refuses a title-shaped card created by a non-emitter %s agent", async (role) => {
    const { company, intruder } = await seedWikiCompany("maintainer");
    await db.update(agents).set({ role }).where(eq(agents.id, intruder.id));
    const stub = await seedUnassignedHandoff(company.id);
    await db.update(issues).set({
      createdByAgentId: intruder.id,
      createdByUserId: null,
      status: "todo",
    }).where(eq(issues.id, stub.id));
    const res = await request(createApp(db, { ...boardActor(company.id), isInstanceAdmin: false }))
      .patch(`/api/issues/${stub.id}`).send({ description: "Not a Reporter handoff" });
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ reason: "wiki_handoff_unassigned" });
    expect((await readAssignee(stub.id))?.assigneeAgentId).toBeNull();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, company.id))).toEqual([]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id))).toEqual([]);
  });

  it.each([{}, { comment: "Observation only" }])("keeps a field-less PATCH unassigned: %j", async (body) => {
    const { company } = await seedWikiCompany("maintainer");
    const stub = await seedUnassignedHandoff(company.id);
    const res = await request(createApp(db, boardActor(company.id)))
      .patch(`/api/issues/${stub.id}`)
      .send(body);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await readAssignee(stub.id)).toMatchObject({
      assigneeAgentId: null,
      assigneeUserId: null,
      status: "backlog",
    });
  });

  it("does not treat an unmarked resource target as the Wiki Maintainer", async () => {
    const { company, maintainer, intruder } = await seedWikiCompany("maintainer");
    await db.update(pluginManagedResources).set({ resourceId: intruder.id });
    const app = createApp(db, boardActor(company.id));
    const stub = await seedUnassignedHandoff(company.id);
    const refused = await request(app).patch(`/api/issues/${stub.id}`).send({ assigneeAgentId: intruder.id });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect((await readAssignee(stub.id))?.assigneeAgentId).toBeNull();

    const repaired = await request(app).patch(`/api/issues/${stub.id}`).send({ description: "Repair pointer" });
    expect(repaired.status, JSON.stringify(repaired.body)).toBe(200);
    expect((await readAssignee(stub.id))?.assigneeAgentId).toBe(maintainer.id);
  });

  it("fails closed when a live unmarked reference has no marked binding and another agent carries a forged marker", async () => {
    const { company, intruder, stale } = await seedWikiCompany("maintainer");
    await db.delete(pluginEntities);
    await db.update(pluginManagedResources).set({ resourceId: stale.id });
    await db.update(agents).set({ metadata: {} }).where(eq(agents.companyId, company.id));
    await db.update(agents).set({ metadata: maintainerMetadata(randomUUID()) }).where(eq(agents.id, intruder.id));
    const app = createApp(db, boardActor(company.id));
    const stub = await seedUnassignedHandoff(company.id);
    const repaired = await request(app).patch(`/api/issues/${stub.id}`).send({ description: "Repair pointer" });
    expect(repaired.status, JSON.stringify(repaired.body)).toBe(422);
    const explicit = await request(app).patch(`/api/issues/${stub.id}`).send({ assigneeAgentId: intruder.id });
    expect(explicit.status, JSON.stringify(explicit.body)).toBe(422);
    expect((await readAssignee(stub.id))?.assigneeAgentId).toBeNull();
  });

  it("refuses adoption of a paused maintainer", async () => {
    const { company, maintainer } = await seedWikiCompany("maintainer");
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, maintainer.id));
    const stub = await seedUnassignedHandoff(company.id);
    const res = await request(createApp(db, boardActor(company.id)))
      .patch(`/api/issues/${stub.id}`).send({ description: "Repair pointer" });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect((await readAssignee(stub.id))?.assigneeAgentId).toBeNull();
  });

  it("admits an explicit assignment of a paused canonical maintainer without a status", async () => {
    const { company, maintainer } = await seedWikiCompany("maintainer");
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, maintainer.id));
    const stub = await seedUnassignedHandoff(company.id);
    const res = await request(createApp(db, boardActor(company.id)))
      .patch(`/api/issues/${stub.id}`).send({ assigneeAgentId: maintainer.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await readAssignee(stub.id))?.assigneeAgentId).toBe(maintainer.id);
  });

  it("preserves the no-reference, no-marked-agent field write without adoption", async () => {
    const { company, maintainer } = await seedWikiCompany("maintainer");
    await db.delete(pluginManagedResources);
    await db.delete(pluginEntities);
    await db.update(agents).set({ metadata: {} }).where(eq(agents.id, maintainer.id));
    const stub = await seedUnassignedHandoff(company.id);
    const res = await request(createApp(db, boardActor(company.id)))
      .patch(`/api/issues/${stub.id}`).send({ description: "Repair pointer" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await readAssignee(stub.id))?.assigneeAgentId).toBeNull();
  });

  it("refuses adoption when two agents are marked without a resource reference", async () => {
    const { company, intruder } = await seedWikiCompany("maintainer");
    await db.delete(pluginManagedResources);
    await db.delete(pluginEntities);
    await db.update(agents).set({ metadata: maintainerMetadata(randomUUID()) }).where(eq(agents.id, intruder.id));
    const stub = await seedUnassignedHandoff(company.id);
    const res = await request(createApp(db, boardActor(company.id)))
      .patch(`/api/issues/${stub.id}`).send({ description: "Repair pointer" });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect((await readAssignee(stub.id))?.assigneeAgentId).toBeNull();
  });

  it.each(["backlog", "todo", "in_progress", "blocked", "in_review", "done", "cancelled"] as const)(
    "preserves assignment wake semantics for a statusless %s repair",
    async (status) => {
      const { company, maintainer } = await seedWikiCompany("maintainer");
      const stub = await seedUnassignedHandoff(company.id);
      await db.update(issues).set({ status }).where(eq(issues.id, stub.id));
      const res = await request(createApp(db, boardActor(company.id)))
        .patch(`/api/issues/${stub.id}`).send({ description: "Repair pointer" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe(status);
      expect(res.body.assigneeAgentId).toBe(maintainer.id);
      await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, maintainer.id));
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, maintainer.id));
      if (status === "backlog" || status === "done" || status === "cancelled") {
        expect(wakes).toEqual([]);
        expect(runs).toEqual([]);
      } else {
        expect(wakes).not.toEqual([]);
        expect(runs).not.toEqual([]);
      }
    },
  );

  it.each(["resource", "binding"] as const)(
    "serializes a late canonical %s repoint with the issue write",
    async (source) => {
      const { company, maintainer, intruder } = await seedWikiCompany("maintainer");
      await db.update(agents).set({ metadata: maintainerMetadata(randomUUID()) }).where(eq(agents.id, intruder.id));
      if (source === "binding") await db.delete(pluginManagedResources);
      const stub = await seedUnassignedHandoff(company.id);
      const requireFromDb = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
      const postgres = requireFromDb("postgres") as (url: string, options: { max: number }) => {
        unsafe: (query: string) => Promise<unknown>;
        end: (options?: { timeout?: number }) => Promise<unknown>;
      };
      const locker = postgres(tempDb!.connectionString, { max: 1 });
      const barrier = 2493601;
      let pending: Promise<request.Response> | undefined;
      try {
        await locker.unsafe(`
          CREATE FUNCTION wiki_handoff_update_barrier() RETURNS trigger AS $$
          BEGIN
            PERFORM pg_advisory_xact_lock(${barrier});
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
          CREATE TRIGGER wiki_handoff_update_barrier BEFORE UPDATE ON issues
          FOR EACH ROW WHEN (NEW.id = '${stub.id}'::uuid)
          EXECUTE FUNCTION wiki_handoff_update_barrier();
          SELECT pg_advisory_lock(${barrier});
        `);
        pending = request(createApp(db, boardActor(company.id)))
          .patch(`/api/issues/${stub.id}`).send({ description: "Repair pointer" })
          .then((res) => res);
        await expect.poll(async () => {
          const rows = await db.execute(sql`SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory' AND objid = ${barrier} AND NOT granted`);
          return rows.length;
        }, { timeout: 10_000 }).toBe(1);
        // The request has passed its service guard and reached UPDATE. A
        // second connection must not be able to repoint the canonical row.
        const repoint = db.transaction(async (tx) => {
          if (source === "resource") {
            await tx.execute(sql`SELECT id FROM plugin_managed_resources
              WHERE company_id = ${company.id} FOR UPDATE NOWAIT`);
            await tx.update(pluginManagedResources).set({ resourceId: intruder.id });
          } else {
            await tx.execute(sql`SELECT id FROM plugin_entities
              WHERE company_id = ${company.id} FOR UPDATE NOWAIT`);
            await tx.update(pluginEntities).set({ data: {
              pluginKey: PLUGIN_KEY, resourceKey: AGENT_KEY, agentId: intruder.id,
            } });
          }
        });
        await expect(repoint).rejects.toMatchObject({ cause: { code: "55P03" } });
        await locker.unsafe(`SELECT pg_advisory_unlock(${barrier})`);
        const res = await pending;
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect((await readAssignee(stub.id))?.assigneeAgentId).toBe(maintainer.id);
      } finally {
        await locker.end({ timeout: 1 });
        await pending;
        await db.execute(sql`DROP TRIGGER IF EXISTS wiki_handoff_update_barrier ON issues`);
        await db.execute(sql`DROP FUNCTION IF EXISTS wiki_handoff_update_barrier()`);
      }
    },
    20_000,
  );

  it("adopts the canonical Wiki Maintainer on the emitter field-repair PATCH", async () => {
    const { company, maintainer } = await seedWikiCompany("maintainer");
    const [project] = await db.insert(projects).values({
      companyId: company.id,
      name: "Weekly reports",
    }).returning();
    const stub = await seedUnassignedHandoff(company.id);

    const res = await request(createApp(db, boardActor(company.id)))
      .patch(`/api/issues/${stub.id}`)
      .send({
        description: "Weekly report handoff pointer",
        projectId: project!.id,
        executionPolicy: userReviewPolicy(),
        deliveryRequirement: "record_only",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = await readAssignee(stub.id);
    expect(stored?.assigneeAgentId).toBe(maintainer.id);
    expect(stored?.assigneeUserId).toBeNull();
    expect(stored?.status).toBe("backlog");
  });

  it("does not adopt the maintainer on a status-carrying field write", async () => {
    const { company } = await seedWikiCompany("maintainer");
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Weekly reports" }).returning();
    const stub = await seedUnassignedHandoff(company.id);

    const res = await request(createApp(db, boardActor(company.id)))
      .patch(`/api/issues/${stub.id}`)
      .send({
        description: "Weekly report handoff pointer",
        projectId: project!.id,
        executionPolicy: userReviewPolicy(),
        deliveryRequirement: "record_only",
        status: "todo",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({
      guard: "assignee_review_gate",
      subGuard: "wiki_handoff",
      reason: "wiki_handoff_unassigned",
    });
    const stored = await readAssignee(stub.id);
    expect(stored?.assigneeAgentId).toBeNull();
    expect(stored?.status).toBe("backlog");
  });

  it("does not adopt when the resolver finds no live canonical maintainer", async () => {
    const { company, maintainer } = await seedWikiCompany("unresolvable");
    await db.update(agents).set({ metadata: {} }).where(eq(agents.id, maintainer.id));
    await db.delete(pluginEntities);
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Weekly reports" }).returning();
    const stub = await seedUnassignedHandoff(company.id);

    const res = await request(createApp(db, boardActor(company.id)))
      .patch(`/api/issues/${stub.id}`)
      .send({
        description: "Weekly report handoff pointer",
        projectId: project!.id,
        executionPolicy: userReviewPolicy(),
        deliveryRequirement: "record_only",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({
      guard: "assignee_review_gate",
      subGuard: "wiki_handoff",
      reason: "wiki_handoff_unassigned",
    });
    const stored = await readAssignee(stub.id);
    expect(stored?.assigneeAgentId).toBeNull();
    expect(stored?.assigneeUserId).toBeNull();
    expect(stored?.status).toBe("backlog");
  });

  it("admits an assignee write of the metadata-marked Wiki Maintainer when the resource row is unresolvable", async () => {
    const { company, maintainer } = await seedWikiCompany("unresolvable");
    const stub = await seedUnassignedHandoff(company.id);

    const res = await request(createApp(db, boardActor(company.id)))
      .patch(`/api/issues/${stub.id}`)
      .send({
        assigneeAgentId: maintainer.id,
        status: "todo",
        executionPolicy: userReviewPolicy(),
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.details?.reason).not.toBe("wiki_handoff_unassigned");
    const stored = await readAssignee(stub.id);
    expect(stored?.assigneeAgentId).toBe(maintainer.id);
  });

  it("does not let forged metadata on a non-canonical agent outrank the resource row", async () => {
    const { company, maintainer, intruder } = await seedWikiCompany("maintainer");
    await db.update(agents).set({ metadata: maintainerMetadata(randomUUID()) }).where(eq(agents.id, intruder.id));
    const stub = await seedUnassignedHandoff(company.id);

    const forged = await request(createApp(db, boardActor(company.id)))
      .patch(`/api/issues/${stub.id}`)
      .send({ assigneeAgentId: intruder.id, status: "in_review", executionPolicy: userReviewPolicy() });
    expect(forged.status, JSON.stringify(forged.body)).toBe(422);
    expect(forged.body.details).toMatchObject({
      guard: "assignee_review_gate",
      subGuard: "wiki_handoff",
      canonicalMaintainerAgentId: maintainer.id,
    });
    const stored = await readAssignee(stub.id);
    expect(stored?.assigneeAgentId).toBeNull();
    expect(stored?.executionState).toBeNull();
  });

  it("refuses every assignee write when two agents are marked and the resource row is unresolvable", async () => {
    const { company, maintainer, intruder } = await seedWikiCompany("unresolvable");
    await db.update(agents).set({ metadata: maintainerMetadata(randomUUID()) }).where(eq(agents.id, intruder.id));
    await db.delete(pluginEntities);
    const stub = await seedUnassignedHandoff(company.id);

    const res = await request(createApp(db, boardActor(company.id)))
      .patch(`/api/issues/${stub.id}`)
      .send({ assigneeAgentId: maintainer.id, status: "todo", executionPolicy: userReviewPolicy() });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ guard: "assignee_review_gate", subGuard: "wiki_handoff" });
    const stored = await readAssignee(stub.id);
    expect(stored?.assigneeAgentId).toBeNull();
  });

  it("keeps the Wiki Maintainer as the return assignee when a wiki handoff enters human review", async () => {
    const { company, maintainer } = await seedWikiCompany("maintainer");
    const stub = await seedUnassignedHandoff(company.id);

    const res = await request(createApp(db, boardActor(company.id)))
      .patch(`/api/issues/${stub.id}`)
      .send({
        assigneeAgentId: maintainer.id,
        status: "in_review",
        executionPolicy: userReviewPolicy(),
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = await readAssignee(stub.id);
    expect(stored?.status).toBe("in_review");
    expect(stored?.assigneeAgentId).toBeNull();
    expect(stored?.assigneeUserId).toBe(REVIEWER_USER_ID);
    const state = stored?.executionState as { returnAssignee?: { type?: string; agentId?: string } } | null;
    expect(state?.returnAssignee).toMatchObject({ type: "agent", agentId: maintainer.id });
  });

  it("still refuses a non-canonical assignee on a wiki handoff", async () => {
    const { company, intruder } = await seedWikiCompany("maintainer");
    const stub = await seedUnassignedHandoff(company.id);

    const res = await request(createApp(db, boardActor(company.id)))
      .patch(`/api/issues/${stub.id}`)
      .send({ assigneeAgentId: intruder.id });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({
      guard: "assignee_review_gate",
      subGuard: "wiki_handoff",
      reason: "wiki_handoff_non_canonical_assignee",
      assigneeAgentId: intruder.id,
    });
    const stored = await readAssignee(stub.id);
    expect(stored?.assigneeAgentId).toBeNull();
  });
  // Hold a PATCH inside its service transaction at the issue UPDATE (after the
  // service guard resolved), run `whileHeld`, then release it.
  async function holdPatchAtUpdate(
    stubId: string,
    companyId: string,
    body: Record<string, unknown>,
    whileHeld: () => Promise<void>,
  ) {
    const requireFromDb = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
    const postgres = requireFromDb("postgres") as (url: string, options: { max: number }) => {
      unsafe: (query: string) => Promise<unknown>;
      end: (options?: { timeout?: number }) => Promise<unknown>;
    };
    const locker = postgres(tempDb!.connectionString, { max: 1 });
    const barrier = 2493602;
    let pending: Promise<request.Response> | undefined;
    try {
      await locker.unsafe(`
        CREATE FUNCTION wiki_handoff_update_barrier() RETURNS trigger AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${barrier});
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER wiki_handoff_update_barrier BEFORE UPDATE ON issues
        FOR EACH ROW WHEN (NEW.id = '${stubId}'::uuid)
        EXECUTE FUNCTION wiki_handoff_update_barrier();
        SELECT pg_advisory_lock(${barrier});
      `);
      pending = request(createApp(db, boardActor(companyId)))
        .patch(`/api/issues/${stubId}`).send(body).then((res) => res);
      await expect.poll(async () => {
        const rows = await db.execute(sql`SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND objid = ${barrier} AND NOT granted`);
        return rows.length;
      }, { timeout: 10_000 }).toBe(1);
      await whileHeld();
      await locker.unsafe(`SELECT pg_advisory_unlock(${barrier})`);
      return await pending;
    } finally {
      await locker.end({ timeout: 1 });
      await pending;
      await db.execute(sql`DROP TRIGGER IF EXISTS wiki_handoff_update_barrier ON issues`);
      await db.execute(sql`DROP FUNCTION IF EXISTS wiki_handoff_update_barrier()`);
    }
  }

  it("refuses record_only when the adopted maintainer is the calling creator agent", async () => {
    const { company, maintainer } = await seedWikiCompany("maintainer");
    const stub = await seedUnassignedHandoff(company.id);
    await db.update(issues).set({ createdByAgentId: maintainer.id }).where(eq(issues.id, stub.id));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company.id,
      agentId: maintainer.id,
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId: stub.id },
    });
    const agentActor = {
      type: "agent",
      agentId: maintainer.id,
      companyId: company.id,
      source: "agent_key",
      runId,
    } as unknown as Express.Request["actor"];
    const body = { description: "Repair pointer", deliveryRequirement: "record_only" };

    const refused = await request(createApp(db, agentActor))
      .patch(`/api/issues/${stub.id}`)
      .set("X-Paperclip-Run-Id", runId)
      .send(body);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.details).toMatchObject({ reason: "record_only_self_assignee" });
    expect((await readAssignee(stub.id))?.assigneeAgentId).toBeNull();

    // Lawful board repair of the same shape still adopts.
    const repaired = await request(createApp(db, boardActor(company.id))).patch(`/api/issues/${stub.id}`).send(body);
    expect(repaired.status, JSON.stringify(repaired.body)).toBe(200);
    expect((await readAssignee(stub.id))?.assigneeAgentId).toBe(maintainer.id);
  });

  it("does not overwrite an owner that lands between route preflight and the locked write", async () => {
    const { company, maintainer } = await seedWikiCompany("maintainer");
    const stub = await seedUnassignedHandoff(company.id);
    const requireFromDb = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
    const postgres = requireFromDb("postgres") as (url: string, options: { max: number }) => {
      unsafe: (query: string) => Promise<unknown>;
      end: (options?: { timeout?: number }) => Promise<unknown>;
    };
    const owner = postgres(tempDb!.connectionString, { max: 1 });
    let pending: Promise<request.Response> | undefined;
    try {
      await owner.unsafe(`BEGIN; SELECT id FROM issues WHERE id = '${stub.id}' FOR UPDATE;`);
      pending = request(createApp(db, boardActor(company.id)))
        .patch(`/api/issues/${stub.id}`).send({ description: "Repair pointer" }).then((res) => res);
      await expect.poll(async () => {
        const rows = await db.execute(sql`SELECT 1 FROM pg_locks
          WHERE locktype = 'transactionid' AND NOT granted`);
        return rows.length;
      }, { timeout: 10_000 }).toBeGreaterThan(0);
      await owner.unsafe(
        `UPDATE issues SET assignee_user_id = '${REVIEWER_USER_ID}' WHERE id = '${stub.id}'; COMMIT;`,
      );
      const res = await pending;
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.details).toMatchObject({ reason: "wiki_handoff_adoption_conflict" });
      expect(await readAssignee(stub.id)).toMatchObject({
        assigneeAgentId: null,
        assigneeUserId: REVIEWER_USER_ID,
      });
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, maintainer.id));
      expect(wakes).toEqual([]);
    } finally {
      await owner.end({ timeout: 1 });
      await pending;
    }
  }, 20_000);

  it.each(["marked", "unmarked-then-marked"])(
    "serializes a %s agent insertion with the metadata-fallback adoption",
    async (insertion) => {
      const { company, maintainer } = await seedWikiCompany("maintainer");
      await db.delete(pluginManagedResources);
      await db.delete(pluginEntities);
      const stub = await seedUnassignedHandoff(company.id);
      const metadata = maintainerMetadata(randomUUID());
      let created: Promise<unknown> | undefined;
      let settled = false;
      try {
        const res = await holdPatchAtUpdate(stub.id, company.id, { description: "Repair pointer" }, async () => {
          const svc = agentService(db);
          created = svc.create(company.id, {
            name: "Second Wiki Maintainer",
            role: "engineer",
            status: "idle",
            adapterType: "process",
            adapterConfig: {},
            runtimeConfig: {},
            permissions: {},
            metadata: insertion === "marked" ? metadata : {},
          }).then((agent) => insertion === "marked" ? agent : svc.update(agent.id, { metadata }))
            .finally(() => { settled = true; });
          created.catch(() => undefined);
          // Observe the insert's exclusive lock waiting on the guard's shared
          // lock, or its completion. Elapsed time alone proves neither.
          let outcome = "pending";
          await expect.poll(async () => {
            const waiting = await db.execute(sql`
              SELECT 1 FROM pg_locks AS waiter
              JOIN pg_locks AS holder
                USING (locktype, database, classid, objid, objsubid)
              WHERE waiter.locktype = 'advisory'
                AND waiter.mode = 'ExclusiveLock' AND NOT waiter.granted
                AND holder.mode = 'ShareLock' AND holder.granted
                AND waiter.database = (SELECT oid FROM pg_database WHERE datname = current_database())
            `);
            outcome = waiting.length > 0 ? "blocked" : settled ? "completed" : "pending";
            return outcome;
          }, { timeout: 10_000 }).not.toBe("pending");
          expect(outcome).toBe("blocked");
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect((await readAssignee(stub.id))?.assigneeAgentId).toBe(maintainer.id);
      } finally {
        if (created) expect(await created).toMatchObject({ metadata });
      }
    },
    30_000,
  );

  it("fails closed when the adopted fallback maintainer loses its marker before the locked write", async () => {
    const { company, maintainer } = await seedWikiCompany("maintainer");
    await db.delete(pluginManagedResources);
    await db.delete(pluginEntities);
    const stub = await seedUnassignedHandoff(company.id);
    const requireFromDb = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
    const postgres = requireFromDb("postgres") as (url: string, options: { max: number }) => {
      unsafe: (query: string) => Promise<unknown>;
      end: (options?: { timeout?: number }) => Promise<unknown>;
    };
    const locker = postgres(tempDb!.connectionString, { max: 1 });
    let pending: Promise<request.Response> | undefined;
    try {
      // Block the service's issue row lock so the marker removal lands after
      // route preflight chose the maintainer and before the locked check.
      await locker.unsafe(`BEGIN; SELECT id FROM issues WHERE id = '${stub.id}' FOR UPDATE;`);
      pending = request(createApp(db, boardActor(company.id)))
        .patch(`/api/issues/${stub.id}`).send({ description: "Repair pointer" }).then((res) => res);
      await expect.poll(async () => {
        const rows = await db.execute(sql`SELECT 1 FROM pg_locks
          WHERE locktype = 'transactionid' AND NOT granted`);
        return rows.length;
      }, { timeout: 10_000 }).toBeGreaterThan(0);
      await db.update(agents).set({ metadata: {} }).where(eq(agents.id, maintainer.id));
      await locker.unsafe(`COMMIT`);
      const res = await pending;
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect((await readAssignee(stub.id))?.assigneeAgentId).toBeNull();
    } finally {
      await locker.end({ timeout: 1 });
      await pending;
    }
  }, 20_000);
});
