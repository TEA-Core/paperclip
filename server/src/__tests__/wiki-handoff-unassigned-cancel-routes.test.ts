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
  pluginManagedResources,
  plugins,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import type { StorageService } from "../storage/types.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Wiki handoff cancellation route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const HANDOFF_TITLE = "[PPC ER] Weekly Report — handoff to Wiki Maintainer";

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  // PATCH /issues/:id never touches storage; the route only needs the slot filled.
  app.use("/api", issueRoutes(db, {} as StorageService));
  app.use(errorHandler);
  return app;
}

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

// SUP-24280: the emitter must be able to cancel a half-emitted, unassigned
// canonical Wiki handoff stub (the SUP-24090 shape) without assigning it. Every
// other assignee write through the Wiki handoff guard stays refused.
describeEmbeddedPostgres("Wiki handoff unassigned-stub cancellation (SUP-24280)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wiki-handoff-cancel-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(pluginManagedResources);
    await db.delete(plugins);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedWikiCompany() {
    const nonce = randomUUID().slice(0, 8);
    const [company] = await db.insert(companies).values({
      name: `Wiki ${nonce}`,
      issuePrefix: `WC${nonce.slice(0, 4).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
      requireBoardApprovalForNewAgents: false,
    }).returning();
    const [maintainer, intruder] = await db.insert(agents).values([
      {
        companyId: company!.id,
        name: "Wiki Maintainer",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        metadata: {
          pluginManagedAgent: {
            pluginKey: "paperclipai.plugin-llm-wiki",
            agentKey: "wiki-maintainer",
          },
        },
      },
      {
        companyId: company!.id,
        name: "coder-LE",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]).returning();
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclipai.plugin-llm-wiki",
      packageName: "@paperclipai/plugin-llm-wiki",
      version: "0.1.0",
      apiVersion: 1,
      categories: [],
      manifestJson: {} as never,
      status: "ready",
      installOrder: 1,
    });
    await db.insert(pluginManagedResources).values({
      companyId: company!.id,
      pluginId,
      pluginKey: "paperclipai.plugin-llm-wiki",
      resourceKind: "agent",
      resourceKey: "wiki-maintainer",
      resourceId: maintainer!.id,
      defaultsJson: {},
    });
    return { company: company!, maintainer: maintainer!, intruder: intruder! };
  }

  let issueCounter = 0;
  async function seedIssue(
    companyId: string,
    values: Partial<typeof issues.$inferInsert> = {},
  ) {
    issueCounter += 1;
    const [issue] = await db.insert(issues).values({
      companyId,
      title: HANDOFF_TITLE,
      status: "backlog",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      issueNumber: issueCounter,
      identifier: `WC-${issueCounter}`,
      ...values,
    }).returning();
    return issue!;
  }

  async function readBack(issueId: string) {
    const [row] = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    return row;
  }

  it("cancels the unassigned SUP-24090 stub on a status-only PATCH and keeps it unassigned", async () => {
    const { company } = await seedWikiCompany();
    const stub = await seedIssue(company.id);

    const res = await request(createApp(db, boardActor(company.id)))
      .patch(`/api/issues/${stub.id}`)
      .send({ status: "cancelled" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: "cancelled", assigneeAgentId: null });
    await expect(readBack(stub.id)).resolves.toEqual({
      status: "cancelled",
      assigneeAgentId: null,
      assigneeUserId: null,
    });
  });

  it("cancels the unassigned stub through the service when the write carries actor bookkeeping", async () => {
    const { company } = await seedWikiCompany();
    const stub = await seedIssue(company.id);

    await expect(
      issueService(db).update(stub.id, { status: "cancelled", actorAgentId: null, actorUserId: "board-user" }),
    ).resolves.toMatchObject({ status: "cancelled", assigneeAgentId: null });
    await expect(readBack(stub.id)).resolves.toEqual({
      status: "cancelled",
      assigneeAgentId: null,
      assigneeUserId: null,
    });
  });

  it("keeps the service guard refusing every other bookkeeping-carrying write on an unassigned stub", async () => {
    const { company } = await seedWikiCompany();
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "member",
    });
    const stub = await seedIssue(company.id);
    const userOwned = await seedIssue(company.id, { status: "todo", assigneeUserId: "board-user" });
    const svc = issueService(db);
    const bookkeeping = { actorAgentId: null, actorUserId: "board-user" };

    for (const patch of [
      { status: "todo" },
      { status: "cancelled", assigneeAgentId: null },
      { status: "cancelled", assigneeUserId: null },
      { status: "cancelled", assigneeUserId: "board-user" },
    ]) {
      await expect(svc.update(stub.id, { ...patch, ...bookkeeping })).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({ subGuard: "wiki_handoff", reason: "wiki_handoff_unassigned" }),
      });
    }
    await expect(svc.update(userOwned.id, { status: "cancelled", ...bookkeeping })).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({ subGuard: "wiki_handoff", reason: "wiki_handoff_unassigned" }),
    });
    await expect(readBack(stub.id)).resolves.toEqual({
      status: "backlog",
      assigneeAgentId: null,
      assigneeUserId: null,
    });
    await expect(readBack(userOwned.id)).resolves.toEqual({
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: "board-user",
    });
  });

  it("(a) refuses a non-canonical agent assigning itself to satisfy the handoff", async () => {
    const { company, intruder } = await seedWikiCompany();
    const stub = await seedIssue(company.id);

    await expect(
      issueService(db).update(stub.id, {
        status: "cancelled",
        assigneeAgentId: intruder.id,
        actorAgentId: intruder.id,
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        subGuard: "wiki_handoff",
        reason: "wiki_handoff_non_canonical_assignee",
        assigneeAgentId: intruder.id,
      }),
    });
    await expect(readBack(stub.id)).resolves.toEqual({
      status: "backlog",
      assigneeAgentId: null,
      assigneeUserId: null,
    });
  });

  it("(b) refuses an explicit reassignment off the canonical Maintainer, even inside a cancellation", async () => {
    const { company, maintainer, intruder } = await seedWikiCompany();
    const handoff = await seedIssue(company.id, { status: "todo", assigneeAgentId: maintainer.id });
    const app = createApp(db, boardActor(company.id));

    for (const [patch, reason] of [
      [{ status: "cancelled", assigneeAgentId: intruder.id }, "wiki_handoff_non_canonical_assignee"],
      [{ status: "cancelled", assigneeAgentId: null }, "wiki_handoff_unassigned"],
    ] as const) {
      const res = await request(app).patch(`/api/issues/${handoff.id}`).send(patch);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.details).toMatchObject({
        guard: "assignee_review_gate",
        subGuard: "wiki_handoff",
        reason,
      });
    }
    await expect(readBack(handoff.id)).resolves.toEqual({
      status: "todo",
      assigneeAgentId: maintainer.id,
      assigneeUserId: null,
    });
  });

  it("(c) refuses an unrelated assignee write on a cancelled stub", async () => {
    const { company, intruder } = await seedWikiCompany();
    const stub = await seedIssue(company.id);
    const app = createApp(db, boardActor(company.id));
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "member",
    });

    const cancel = await request(app).patch(`/api/issues/${stub.id}`).send({ status: "cancelled" });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);

    for (const [patch, reason] of [
      [{ assigneeUserId: "board-user" }, "wiki_handoff_unassigned"],
      [{ assigneeAgentId: intruder.id }, "wiki_handoff_non_canonical_assignee"],
      [{ status: "cancelled", assigneeUserId: "board-user" }, "wiki_handoff_unassigned"],
      [{ status: "cancelled", assigneeAgentId: null }, "wiki_handoff_unassigned"],
    ] as const) {
      const res = await request(app).patch(`/api/issues/${stub.id}`).send(patch);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.details).toMatchObject({ subGuard: "wiki_handoff", reason });
    }
    await expect(readBack(stub.id)).resolves.toEqual({
      status: "cancelled",
      assigneeAgentId: null,
      assigneeUserId: null,
    });
  });

  it.each(["todo", "blocked", "in_review", "done"])(
    "(d) still refuses a status-only %s write on the unassigned stub",
    async (status) => {
      const { company } = await seedWikiCompany();
      const stub = await seedIssue(company.id);

      const res = await request(createApp(db, boardActor(company.id)))
        .patch(`/api/issues/${stub.id}`)
        .send({ status });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.details).toMatchObject({
        guard: "assignee_review_gate",
        subGuard: "wiki_handoff",
        reason: "wiki_handoff_unassigned",
      });
      await expect(readBack(stub.id)).resolves.toEqual({
        status: "backlog",
        assigneeAgentId: null,
        assigneeUserId: null,
      });
    },
  );

  it("(e) cancels assigned and non-handoff issues exactly as before", async () => {
    const { company, maintainer, intruder } = await seedWikiCompany();
    const app = createApp(db, boardActor(company.id));
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "member",
    });
    const canonical = await seedIssue(company.id, { status: "todo", assigneeAgentId: maintainer.id });
    const nonCanonical = await seedIssue(company.id, { status: "todo", assigneeAgentId: intruder.id });
    const userOwned = await seedIssue(company.id, { status: "todo", assigneeUserId: "board-user" });
    const ordinary = await seedIssue(company.id, { title: "Ordinary unassigned task" });

    const canonicalRes = await request(app).patch(`/api/issues/${canonical.id}`).send({ status: "cancelled" });
    expect(canonicalRes.status, JSON.stringify(canonicalRes.body)).toBe(200);
    await expect(readBack(canonical.id)).resolves.toEqual({
      status: "cancelled",
      assigneeAgentId: maintainer.id,
      assigneeUserId: null,
    });

    const ordinaryRes = await request(app).patch(`/api/issues/${ordinary.id}`).send({ status: "cancelled" });
    expect(ordinaryRes.status, JSON.stringify(ordinaryRes.body)).toBe(200);
    await expect(readBack(ordinary.id)).resolves.toEqual({
      status: "cancelled",
      assigneeAgentId: null,
      assigneeUserId: null,
    });

    for (const [issue, reason, assigneeAgentId, assigneeUserId] of [
      [nonCanonical, "wiki_handoff_non_canonical_assignee", intruder.id, null],
      [userOwned, "wiki_handoff_unassigned", null, "board-user"],
    ] as const) {
      const res = await request(app).patch(`/api/issues/${issue.id}`).send({ status: "cancelled" });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.details).toMatchObject({ subGuard: "wiki_handoff", reason });
      await expect(readBack(issue.id)).resolves.toEqual({ status: "todo", assigneeAgentId, assigneeUserId });
    }
  });
});
