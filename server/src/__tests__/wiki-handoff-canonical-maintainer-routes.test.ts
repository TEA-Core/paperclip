import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  issues,
  pluginEntities,
  pluginManagedResources,
  plugins,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
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
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(pluginEntities);
    await db.delete(pluginManagedResources);
    await db.delete(plugins);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedWikiCompany(resourceId: "maintainer" | "stale") {
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
      resourceId: resourceId === "maintainer" ? maintainer!.id : stale!.id,
      defaultsJson: {},
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

  it("admits a field repair of an unassigned wiki handoff whose plugin-managed maintainer the resource row already names", async () => {
    const { company, maintainer } = await seedWikiCompany("maintainer");
    const stub = await seedUnassignedHandoff(company.id);

    const res = await request(createApp(db, boardActor(company.id)))
      .patch(`/api/issues/${stub.id}`)
      .send({
        description: "Weekly report handoff pointer",
        executionPolicy: userReviewPolicy(),
        deliveryRequirement: "record_only",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = await readAssignee(stub.id);
    expect(stored?.assigneeAgentId).toBeNull();
    expect(stored?.assigneeUserId).toBeNull();
    expect(maintainer.id).not.toBe(stored?.assigneeAgentId);
  });

  it("admits an assignee write of the metadata-marked Wiki Maintainer when the resource row points at a stale agent", async () => {
    const { company, maintainer } = await seedWikiCompany("stale");
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
});
