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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres implicit-collision tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * The write-path guard has to resolve the return assignee the way the RUNTIME does.
 *
 * `resolveReturnAssignee()` seeds the excluded principal from the issue's own assignee
 * when the policy declares no `returnAssigneeAgentId` — and that is the MAJORITY shape:
 * 33 of the 40 collisions measured on 2026-08-19 declared nothing. A guard keyed on the
 * declared field alone lets every one of them through, and with `allowSelfAsFallback`
 * gone they no longer self-approve, they 422 at stage advance instead. That is the
 * SUP-10602 deadlock re-opened for the common case.
 *
 * These are ROUTE tests on purpose. The unit tests prove the predicate; only a route
 * test proves the assignee is actually WIRED from the request body into the guard, which
 * is the half that was missing.
 */
describeEmbeddedPostgres("execution policy — implicit return-assignee collision at the write path", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-implicit-collision-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const heartbeatStub = { requestWakeup: async () => null, enqueueWakeup: async () => null } as any;

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        isInstanceAdmin: false,
        source: "session",
      };
      next();
    });
    app.use("/api", issueRoutes(db, heartbeatStub));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithAgents() {
    const companyId = randomUUID();
    const closerAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

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
    for (const [id, name] of [[closerAgentId, "exec-CTO"], [reviewerAgentId, "support-QAE"]] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    return { companyId, closerAgentId, reviewerAgentId };
  }

  const stageGatedBy = (type: string, agentId: string) => ({
    type,
    approvalsNeeded: 1,
    participants: [{ type: "agent", agentId }],
  });

  it("refuses a create whose stage is gated solely by the issue's own assignee", async () => {
    const { companyId, closerAgentId } = await seedCompanyWithAgents();

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Self-gated close",
        status: "todo",
        assigneeAgentId: closerAgentId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [stageGatedBy("approval", closerAgentId)],
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toMatch(/gated solely by its own return assignee/);
    expect(res.body.details?.returnAssigneeSource).toBe("assigneeAgentId");
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);
  });

  it("accepts a create where the assignee is not the sole participant", async () => {
    const { companyId, closerAgentId, reviewerAgentId } = await seedCompanyWithAgents();

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Real gate",
        status: "todo",
        assigneeAgentId: closerAgentId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [stageGatedBy("review", reviewerAgentId)],
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("refuses a PATCH that writes a policy gated solely by the issue's current assignee", async () => {
    const { companyId, closerAgentId, reviewerAgentId } = await seedCompanyWithAgents();
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Drifts onto its own approver",
        status: "todo",
        assigneeAgentId: closerAgentId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [stageGatedBy("review", reviewerAgentId)],
        },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const patched = await request(createApp(companyId))
      .patch(`/api/issues/${created.body.id}`)
      .send({
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [stageGatedBy("approval", closerAgentId)],
        },
      });

    expect(patched.status, JSON.stringify(patched.body)).toBe(422);
    expect(patched.body.error).toMatch(/gated solely by its own return assignee/);
  });

  it("accepts a PATCH that moves the assignee off the collision in the same body", async () => {
    // The guard resolves against the assignee AFTER the patch, so the repair is a single
    // request. If it keyed on the stored assignee instead, this would be unrepairable.
    const { companyId, closerAgentId, reviewerAgentId } = await seedCompanyWithAgents();
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Repairable in one PATCH",
        status: "todo",
        assigneeAgentId: closerAgentId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [stageGatedBy("review", reviewerAgentId)],
        },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const patched = await request(createApp(companyId))
      .patch(`/api/issues/${created.body.id}`)
      .send({
        assigneeAgentId: reviewerAgentId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [stageGatedBy("approval", closerAgentId)],
        },
      });

    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  });

  it("leaves a PATCH that does not touch the policy alone, so a colliding issue stays repairable", async () => {
    // ADR-073 D2: the guard must never fire on a stored policy. The ~39 issues that
    // already carry a collision have to stay mutable — refusing every PATCH to them is
    // the fleet-halt this placement exists to avoid.
    const { companyId, closerAgentId, reviewerAgentId } = await seedCompanyWithAgents();
    const created = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Already colliding",
        status: "todo",
        assigneeAgentId: reviewerAgentId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [stageGatedBy("approval", closerAgentId)],
        },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    // Drift the assignee onto the approver WITHOUT sending a policy: this is the
    // post-fire reassignment the create-time guards cannot see by construction.
    const drifted = await request(createApp(companyId))
      .patch(`/api/issues/${created.body.id}`)
      .send({ assigneeAgentId: closerAgentId });
    expect(drifted.status, JSON.stringify(drifted.body)).toBe(200);

    // And the repair PATCH still goes through.
    const repaired = await request(createApp(companyId))
      .patch(`/api/issues/${created.body.id}`)
      .send({ assigneeAgentId: reviewerAgentId, description: "repaired" });
    expect(repaired.status, JSON.stringify(repaired.body)).toBe(200);
  });
});
