import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent permissions task-assign grant route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const ORIGINAL_GRANTER = "original-granter";
const ORIGINAL_GRANT_SCOPE = { projectIds: ["project-a"] };
const ORIGINAL_GRANT_UPDATED_AT = new Date("2026-01-01T00:00:00.000Z");

function boardActor(): Express.Request["actor"] {
  return { type: "board", userId: "local-board", source: "local_implicit" };
}

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, source: "agent_jwt" };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

type TargetFixture = {
  role?: string;
  permissions?: Record<string, unknown>;
  membershipStatus?: "active" | "suspended" | null;
  explicitGrant?: boolean;
};

async function seedTarget(db: Db, fixture: TargetFixture = {}) {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db
    .insert(companies)
    .values({ name: `Perms Co ${nonce}`, issuePrefix: `PG${nonce.slice(0, 4).toUpperCase()}` })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      companyId: company!.id,
      name: "Target",
      role: fixture.role ?? "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: fixture.permissions ?? { canCreateAgents: false, canCreateSkills: true },
    })
    .returning();
  const membershipStatus = fixture.membershipStatus === undefined ? "active" : fixture.membershipStatus;
  if (membershipStatus) {
    await db.insert(companyMemberships).values({
      companyId: company!.id,
      principalType: "agent",
      principalId: agent!.id,
      status: membershipStatus,
      membershipRole: "member",
    });
  }
  if (fixture.explicitGrant) {
    await db.insert(principalPermissionGrants).values({
      companyId: company!.id,
      principalType: "agent",
      principalId: agent!.id,
      permissionKey: "tasks:assign",
      scope: ORIGINAL_GRANT_SCOPE,
      grantedByUserId: ORIGINAL_GRANTER,
      createdAt: ORIGINAL_GRANT_UPDATED_AT,
      updatedAt: ORIGINAL_GRANT_UPDATED_AT,
    });
  }
  return { company: company!, agent: agent! };
}

async function readTaskAssignGrants(db: Db, companyId: string, agentId: string) {
  return db
    .select()
    .from(principalPermissionGrants)
    .where(and(
      eq(principalPermissionGrants.companyId, companyId),
      eq(principalPermissionGrants.principalType, "agent"),
      eq(principalPermissionGrants.principalId, agentId),
      eq(principalPermissionGrants.permissionKey, "tasks:assign"),
    ));
}

async function readStoredPermissions(db: Db, agentId: string) {
  const [row] = await db.select({ permissions: agents.permissions }).from(agents).where(eq(agents.id, agentId));
  return (row?.permissions ?? {}) as Record<string, unknown>;
}

async function readMembership(db: Db, companyId: string, agentId: string) {
  const [row] = await db
    .select()
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "agent"),
      eq(companyMemberships.principalId, agentId),
    ));
  return row ?? null;
}

async function readPermissionsActivity(db: Db, agentId: string) {
  return db
    .select()
    .from(activityLog)
    .where(and(eq(activityLog.entityId, agentId), eq(activityLog.action, "agent.permissions_updated")));
}

function patchPermissions(app: express.Express, agentId: string, body: Record<string, unknown>) {
  return request(app).patch(`/api/agents/${agentId}/permissions`).send(body);
}

describeEmbeddedPostgres("PATCH /agents/:id/permissions task-assign grant handling", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-permissions-task-assign-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("keeps a default-sourced agent on simple_default when only canCreateSkills changes", async () => {
    const { company, agent } = await seedTarget(db);
    const app = createApp(db, boardActor());

    const res = await patchPermissions(app, agent.id, {
      canCreateAgents: false,
      canCreateSkills: false,
      canAssignTasks: true,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.permissions.canCreateSkills).toBe(false);
    expect(res.body.access).toMatchObject({ canAssignTasks: true, taskAssignSource: "simple_default" });
    expect(await readTaskAssignGrants(db, company.id, agent.id)).toEqual([]);
    const stored = await readStoredPermissions(db, agent.id);
    expect(stored.canCreateSkills).toBe(false);
    expect(stored).not.toHaveProperty("canAssignTasks");
  });

  it("accepts a canCreateSkills-only body without canAssignTasks and writes no grant", async () => {
    const { company, agent } = await seedTarget(db);
    const app = createApp(db, boardActor());

    const res = await patchPermissions(app, agent.id, { canCreateAgents: false, canCreateSkills: false });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.access).toMatchObject({ canAssignTasks: true, taskAssignSource: "simple_default" });
    expect(await readTaskAssignGrants(db, company.id, agent.id)).toEqual([]);
    expect(await readStoredPermissions(db, agent.id)).not.toHaveProperty("canAssignTasks");
  });

  it("preserves an existing explicit grant byte-for-byte when only canCreateSkills changes", async () => {
    const { company, agent } = await seedTarget(db, { explicitGrant: true });
    const before = await readTaskAssignGrants(db, company.id, agent.id);
    const app = createApp(db, boardActor());

    for (const body of [
      { canCreateAgents: false, canCreateSkills: false, canAssignTasks: true },
      { canCreateAgents: false, canCreateSkills: true },
    ]) {
      const res = await patchPermissions(app, agent.id, body);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.access).toMatchObject({ canAssignTasks: true, taskAssignSource: "explicit_grant" });
    }

    const after = await readTaskAssignGrants(db, company.id, agent.id);
    expect(after).toEqual(before);
    expect(after[0]).toMatchObject({
      scope: ORIGINAL_GRANT_SCOPE,
      grantedByUserId: ORIGINAL_GRANTER,
      updatedAt: ORIGINAL_GRANT_UPDATED_AT,
    });
  });

  it("removes the grant on an actual true -> false change", async () => {
    const { company, agent } = await seedTarget(db, { explicitGrant: true });
    const app = createApp(db, boardActor());

    const res = await patchPermissions(app, agent.id, { canCreateAgents: false, canAssignTasks: false });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await readTaskAssignGrants(db, company.id, agent.id)).toEqual([]);
    expect((await readStoredPermissions(db, agent.id)).canAssignTasks).toBe(false);
  });

  it("writes the grant and activates membership on an actual false -> true change", async () => {
    const { company, agent } = await seedTarget(db, { membershipStatus: "suspended" });
    const app = createApp(db, boardActor());

    const res = await patchPermissions(app, agent.id, { canCreateAgents: false, canAssignTasks: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.access).toMatchObject({ canAssignTasks: true, taskAssignSource: "explicit_grant" });
    const grants = await readTaskAssignGrants(db, company.id, agent.id);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ scope: null, grantedByUserId: "local-board" });
    expect((await readMembership(db, company.id, agent.id))?.status).toBe("active");
    expect((await readStoredPermissions(db, agent.id)).canAssignTasks).toBe(true);
  });

  it("does not reactivate a suspended membership when canAssignTasks matches the disabled effective value", async () => {
    const { company, agent } = await seedTarget(db, { membershipStatus: "suspended" });
    const app = createApp(db, boardActor());

    const res = await patchPermissions(app, agent.id, {
      canCreateAgents: false,
      canCreateSkills: false,
      canAssignTasks: false,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.access).toMatchObject({ canAssignTasks: false, taskAssignSource: "none" });
    expect((await readMembership(db, company.id, agent.id))?.status).toBe("suspended");
    expect(await readTaskAssignGrants(db, company.id, agent.id)).toEqual([]);
    const [activity] = await readPermissionsActivity(db, agent.id);
    expect(activity?.details).toMatchObject({ canAssignTasks: false });
  });

  it("keeps creator-implied access without writing a grant when canCreateAgents stays on", async () => {
    const { company, agent } = await seedTarget(db, {
      permissions: { canCreateAgents: true, canCreateSkills: true },
    });
    const app = createApp(db, boardActor());

    const res = await patchPermissions(app, agent.id, {
      canCreateAgents: true,
      canCreateSkills: false,
      canAssignTasks: true,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.access).toMatchObject({ canAssignTasks: true, taskAssignSource: "agent_creator" });
    expect(await readTaskAssignGrants(db, company.id, agent.id)).toEqual([]);
  });

  it("falls back to simple_default without a grant when canCreateAgents is turned off and assignment is unchanged", async () => {
    const { company, agent } = await seedTarget(db, {
      permissions: { canCreateAgents: true, canCreateSkills: true },
    });
    const app = createApp(db, boardActor());

    const res = await patchPermissions(app, agent.id, { canCreateAgents: false, canAssignTasks: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.access).toMatchObject({ canAssignTasks: true, taskAssignSource: "simple_default" });
    expect(await readTaskAssignGrants(db, company.id, agent.id)).toEqual([]);
  });

  it("still writes a grant when canCreateAgents is turned off for an agent whose fallback would be disabled", async () => {
    const { company, agent } = await seedTarget(db, {
      permissions: { canCreateAgents: true, canCreateSkills: true },
      membershipStatus: "suspended",
    });
    const app = createApp(db, boardActor());

    const res = await patchPermissions(app, agent.id, { canCreateAgents: false, canAssignTasks: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.access).toMatchObject({ canAssignTasks: true, taskAssignSource: "explicit_grant" });
    expect(await readTaskAssignGrants(db, company.id, agent.id)).toHaveLength(1);
  });

  it("writes no grant for a CEO target when canAssignTasks matches its role-implied value", async () => {
    const { company, agent } = await seedTarget(db, { role: "ceo" });
    const app = createApp(db, boardActor());

    const res = await patchPermissions(app, agent.id, {
      canCreateAgents: false,
      canCreateSkills: false,
      canAssignTasks: true,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.access).toMatchObject({ canAssignTasks: true, taskAssignSource: "ceo_role" });
    expect(await readTaskAssignGrants(db, company.id, agent.id)).toEqual([]);
  });

  it("keeps writing the role-implied grant when a CEO target is sent canAssignTasks=false", async () => {
    const { company, agent } = await seedTarget(db, { role: "ceo" });
    const app = createApp(db, boardActor());

    const res = await patchPermissions(app, agent.id, { canCreateAgents: false, canAssignTasks: false });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.access).toMatchObject({ canAssignTasks: true, taskAssignSource: "ceo_role" });
    expect(await readTaskAssignGrants(db, company.id, agent.id)).toHaveLength(1);
  });

  it("records the derived effective canAssignTasks in the activity log", async () => {
    const { agent } = await seedTarget(db);
    const app = createApp(db, boardActor());

    // canAssignTasks=false on an active member still derives simple_default=true;
    // the activity row must record that effective value, not the request field.
    const res = await patchPermissions(app, agent.id, { canCreateAgents: false, canAssignTasks: false });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.access).toMatchObject({ canAssignTasks: true, taskAssignSource: "simple_default" });
    const [activity] = await readPermissionsActivity(db, agent.id);
    expect(activity?.details).toMatchObject({
      canAssignTasks: true,
      requestedCanAssignTasks: false,
      canCreateAgents: false,
    });
  });

  it("records an omitted canAssignTasks as null beside the derived value", async () => {
    const { agent } = await seedTarget(db);
    const app = createApp(db, boardActor());

    const res = await patchPermissions(app, agent.id, { canCreateAgents: false, canCreateSkills: false });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [activity] = await readPermissionsActivity(db, agent.id);
    expect(activity?.details).toMatchObject({ canAssignTasks: true, requestedCanAssignTasks: null });
  });

  it("revokes a stored grant on an agent without a membership row, as before", async () => {
    const { company, agent } = await seedTarget(db, { membershipStatus: null, explicitGrant: true });
    const app = createApp(db, boardActor());

    const res = await patchPermissions(app, agent.id, {
      canCreateAgents: false,
      canCreateSkills: false,
      canAssignTasks: false,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await readTaskAssignGrants(db, company.id, agent.id)).toEqual([]);
    expect((await readMembership(db, company.id, agent.id))?.status).toBe("active");
    expect((await readStoredPermissions(db, agent.id)).canAssignTasks).toBe(false);
  });

  it("leaves a stored grant on an agent without a membership row untouched when canAssignTasks is omitted", async () => {
    const { company, agent } = await seedTarget(db, { membershipStatus: null, explicitGrant: true });
    const before = await readTaskAssignGrants(db, company.id, agent.id);
    const app = createApp(db, boardActor());

    const res = await patchPermissions(app, agent.id, { canCreateAgents: false, canCreateSkills: false });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await readTaskAssignGrants(db, company.id, agent.id)).toEqual(before);
    expect(await readMembership(db, company.id, agent.id)).toBeNull();
  });

  it("serializes concurrent permission updates so the grant always matches one sequential order", async () => {
    // A turns creator on (grant written true); B turns it off and revokes.
    // In either sequential order the final grant exists exactly when the final
    // canCreateAgents is true. Without a membership row, B alone projects
    // "none" and skips its write, so a B that decided before A committed would
    // keep A's grant under B's canCreateAgents=false.
    for (const membershipStatus of ["active", null] as const) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const { company, agent } = await seedTarget(db, { membershipStatus });
        const app = createApp(db, boardActor());

        const [a, b] = await Promise.all([
          patchPermissions(app, agent.id, { canCreateAgents: true, canAssignTasks: false }),
          patchPermissions(app, agent.id, { canCreateAgents: false, canAssignTasks: false }),
        ]);

        expect(a.status, JSON.stringify(a.body)).toBe(200);
        expect(b.status, JSON.stringify(b.body)).toBe(200);
        const stored = await readStoredPermissions(db, agent.id);
        const grants = await readTaskAssignGrants(db, company.id, agent.id);
        expect({ membershipStatus, attempt, creator: stored.canCreateAgents, grant: grants.length === 1 })
          .toEqual({ membershipStatus, attempt, creator: stored.canCreateAgents, grant: stored.canCreateAgents === true });
      }
    }
  }, 240_000);

  it("does not create a membership when a false request meets only unrelated grants", async () => {
    const { company, agent } = await seedTarget(db, { membershipStatus: null });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent.id,
      permissionKey: "agents:create",
    });
    const app = createApp(db, boardActor());

    const res = await patchPermissions(app, agent.id, { canCreateAgents: false, canAssignTasks: false });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.access).toMatchObject({ canAssignTasks: false, taskAssignSource: "none" });
    expect(await readMembership(db, company.id, agent.id)).toBeNull();
  });

  it("rejects an agent actor whose agent row belongs to another company", async () => {
    const { company, agent } = await seedTarget(db);
    const other = await seedTarget(db, { role: "ceo" });
    const app = createApp(db, agentActor(company.id, other.agent.id));

    const res = await patchPermissions(app, agent.id, { canCreateAgents: true, canAssignTasks: true });

    expect(res.status).toBe(403);
    expect(await readStoredPermissions(db, agent.id)).toMatchObject({ canCreateAgents: false });
    expect(await readTaskAssignGrants(db, company.id, agent.id)).toEqual([]);
    expect(await readPermissionsActivity(db, agent.id)).toEqual([]);
  });

  it("rejects a non-CEO agent actor even when canAssignTasks is omitted", async () => {
    const { company, agent } = await seedTarget(db);
    const [actorAgent] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Peer",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: { canCreateAgents: true },
      })
      .returning();
    const app = createApp(db, agentActor(company.id, actorAgent!.id));

    const res = await patchPermissions(app, agent.id, { canCreateAgents: true, canCreateSkills: false });

    expect(res.status).toBe(403);
    expect(await readStoredPermissions(db, agent.id)).toMatchObject({ canCreateAgents: false, canCreateSkills: true });
    expect(await readTaskAssignGrants(db, company.id, agent.id)).toEqual([]);
    expect(await readPermissionsActivity(db, agent.id)).toEqual([]);
  });

  it("rejects a board user without agent-management permission even when canAssignTasks is omitted", async () => {
    const { company, agent } = await seedTarget(db);
    const app = createApp(db, {
      type: "board",
      userId: "unprivileged-user",
      source: "session",
      companyIds: [company.id],
      isInstanceAdmin: false,
    } as Express.Request["actor"]);

    const res = await patchPermissions(app, agent.id, { canCreateAgents: true, canCreateSkills: false });

    expect(res.status).toBe(403);
    expect(await readStoredPermissions(db, agent.id)).toMatchObject({ canCreateAgents: false, canCreateSkills: true });
    expect(await readPermissionsActivity(db, agent.id)).toEqual([]);
  });

  it("lets a CEO agent actor change one permission without canAssignTasks", async () => {
    const { company, agent } = await seedTarget(db);
    const [ceo] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "CEO",
        role: "ceo",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: { canCreateAgents: true },
      })
      .returning();
    const app = createApp(db, agentActor(company.id, ceo!.id));

    const res = await patchPermissions(app, agent.id, { canCreateAgents: false, canCreateSkills: false });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.access).toMatchObject({ canAssignTasks: true, taskAssignSource: "simple_default" });
    expect(await readTaskAssignGrants(db, company.id, agent.id)).toEqual([]);
  });

  it("rejects non-boolean canAssignTasks values", async () => {
    const { agent } = await seedTarget(db);
    const app = createApp(db, boardActor());

    const res = await patchPermissions(app, agent.id, { canCreateAgents: false, canAssignTasks: "true" });

    expect(res.status).toBe(400);
  });
});
