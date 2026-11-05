import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { reportUnexpectedRouteError } from "./helpers/report-unexpected-route-error.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres reflection-coach record-only tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * SUP-23042 — creation-time delivery classification for Reflection Coach
 * proposal cards.
 *
 * A coach card's only deliverable is an accepted instruction-bundle mutation
 * (`agent:<id>:instructions`), applied through the governed instructions API.
 * It never produces a repository merge, so storing it `repository_delivery`
 * leaves it uncloseable (SUP-22819: SUP-22802, SUP-22752). The create path
 * must therefore store a coach-filed card as `record_only` — derived
 * server-side from the built-in Reflection Coach marker, never selected by
 * the caller: an explicit `deliveryRequirement` still wins, and assignee
 * self-selection of `record_only` stays refused.
 */
describeEmbeddedPostgres("reflection-coach create — record_only at creation (SUP-23042)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousSchedulingSuppression: string | undefined;

  beforeAll(async () => {
    // Suppress heartbeat dispatch for the lifetime of this suite (seeded
    // companies/agents/assigned issues must not reach the scheduler before
    // teardown; see issue-execution-policy-implicit-collision-routes.test.ts).
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-coach-record-only-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousSchedulingSuppression === undefined) {
      delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    } else {
      process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = previousSchedulingSuppression;
    }
  });

  const heartbeatStub = {
    requestWakeup: async () => null,
    enqueueWakeup: async () => null,
    wakeup: async () => null,
  } as any;

  function createApp(companyId: string, actor: "board" | { agentId: string }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor =
        actor === "board"
          ? {
              type: "board",
              userId: "board-user",
              companyIds: [companyId],
              memberships: [{ companyId, membershipRole: "owner", status: "active" }],
              isInstanceAdmin: false,
              source: "session",
            }
          : {
              type: "agent",
              agentId: actor.agentId,
              companyId,
              source: "agent_key",
              runId: "88888888-8888-4888-8888-888888888888",
            };
      next();
    });
    app.use("/api", issueRoutes(db, heartbeatStub));
    app.use(reportUnexpectedRouteError("issue-create-reflection-coach-record-only"));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const companyId = randomUUID();
    const coachAgentId = randomUUID();
    const coderAgentId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: coachAgentId,
      companyId,
      name: "Reflection Coach",
      role: "manager",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      metadata: {
        paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: ["reflection-coach"] },
      },
    });
    await db.insert(agents).values({
      id: coderAgentId,
      companyId,
      name: "support-QAE",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, coachAgentId, coderAgentId };
  }

  async function storedDeliveryRequirement(companyId: string) {
    const rows = await db
      .select({ deliveryRequirement: issues.deliveryRequirement })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(rows).toHaveLength(1);
    return rows[0].deliveryRequirement;
  }

  it("stores a coach-filed proposal card as record_only at creation", async () => {
    const { companyId, coachAgentId } = await seed();

    const res = await request(createApp(companyId, { agentId: coachAgentId }))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Reflection: support-QAE — probe-hygiene rule exists but is never reached",
        description:
          "Mutation target key: `agent:00000000-0000-4000-8000-000000000001:instructions`",
        status: "todo",
        assigneeAgentId: coachAgentId,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.deliveryRequirement).toBe("record_only");
    expect(await storedDeliveryRequirement(companyId)).toBe("record_only");
  });

  it("keeps an explicitly requested repository_delivery on a coach create", async () => {
    const { companyId, coachAgentId } = await seed();

    const res = await request(createApp(companyId, { agentId: coachAgentId }))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Reflection: exec-CTO — catalog skill follow-up",
        status: "todo",
        assigneeAgentId: coachAgentId,
        deliveryRequirement: "repository_delivery",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.deliveryRequirement).toBe("repository_delivery");
    expect(await storedDeliveryRequirement(companyId)).toBe("repository_delivery");
  });

  it("does not classify creates by agents that are not the built-in Reflection Coach", async () => {
    const { companyId, coderAgentId } = await seed();

    const res = await request(createApp(companyId, { agentId: coderAgentId }))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Ordinary engineering card that owes a repository deliverable",
        status: "todo",
        assigneeAgentId: coderAgentId,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.deliveryRequirement).toBe("repository_delivery");
    expect(await storedDeliveryRequirement(companyId)).toBe("repository_delivery");
  });

  it("still refuses coach self-selection of record_only", async () => {
    const { companyId, coachAgentId } = await seed();

    const res = await request(createApp(companyId, { agentId: coachAgentId }))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Coach card attempting self-selection",
        status: "todo",
        assigneeAgentId: coachAgentId,
        deliveryRequirement: "record_only",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe(
      "Only the board or an authorized non-assignee may select record_only delivery",
    );
    expect(
      await db.select().from(issues).where(eq(issues.companyId, companyId)),
    ).toHaveLength(0);
  });

  it("stores a coach-filed child proposal card as record_only too", async () => {
    const { companyId, coachAgentId } = await seed();

    const parent = await request(createApp(companyId, "board"))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Reflection sweep", status: "todo", assigneeAgentId: coachAgentId });
    expect(parent.status, JSON.stringify(parent.body)).toBe(201);

    const child = await request(createApp(companyId, { agentId: coachAgentId }))
      .post(`/api/issues/${parent.body.id}/children`)
      .send({
        title: "Reflection: support-QAE — probe-hygiene rule exists but is never reached",
        status: "todo",
      });

    expect(child.status, JSON.stringify(child.body)).toBe(201);
    expect(child.body.deliveryRequirement).toBe("record_only");
    const rows = await db
      .select({ deliveryRequirement: issues.deliveryRequirement })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(rows.map((row) => row.deliveryRequirement).sort()).toEqual([
      "record_only",
      "repository_delivery",
    ]);
  });
});
