import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  approvalComments,
  approvals,
  authUsers,
  boardApiKeys,
  createDb,
} from "@paperclipai/db";
import {
  describeEmbeddedPostgres,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";
import { errorHandler } from "../middleware/index.js";
import { actorMiddleware } from "../middleware/auth.js";
import { approvalRoutes } from "../routes/approvals.js";

function hashBearerToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

const AGENT_TOKEN = "work-delivery-agent-token";
const BOARD_TOKEN = "work-delivery-board-token";

const EXTERNAL_PULL_PAYLOADS: Array<[string, Record<string, unknown>]> = [
  ["top-level runtimeConfig", { name: "Pull hire", runtimeConfig: { workDelivery: "external_pull" } }],
  [
    "requestedAgentConfig.runtimeConfig",
    { name: "Pull hire", requestedAgentConfig: { runtimeConfig: { workDelivery: "external_pull" } } },
  ],
];

describeEmbeddedPostgres("approval routes refuse an agent-declared external_pull hire", () => {
  const pg = useEmbeddedPostgres("paperclip-approval-work-delivery-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(approvalComments);
      await db.delete(approvals);
    },
  });

  let db!: ReturnType<typeof createDb>;
  let companyId = "";
  let agentId = "";
  let app!: express.Express;
  let previousSchedulingSuppression: string | undefined;

  beforeAll(async () => {
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";

    db = pg.db;
    const seeded = await seedCompanyWithBoardAccess(db, "Approval Work Delivery");
    companyId = seeded.companyId;
    const userId = seeded.userId;
    await db.insert(authUsers).values({
      id: userId,
      name: "Approval Work Delivery User",
      email: `work-delivery-${userId.slice(0, 8)}@example.com`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(boardApiKeys).values({
      id: randomUUID(),
      userId,
      name: "work-delivery-board-key",
      keyHash: hashBearerToken(BOARD_TOKEN),
      scope: "all_access",
    });

    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Hiring Agent",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentApiKeys).values({
      id: randomUUID(),
      agentId,
      companyId,
      name: "work-delivery-agent-key",
      keyHash: hashBearerToken(AGENT_TOKEN),
      responsibleUserId: userId,
    });

    app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    app.use(approvalRoutes(db));
    app.use(errorHandler);
  }, 60_000);

  afterAll(async () => {
    if (previousSchedulingSuppression === undefined) {
      delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    } else {
      process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = previousSchedulingSuppression;
    }
  });

  async function seedRevisionRequestedHire() {
    const [approval] = await db
      .insert(approvals)
      .values({
        companyId,
        type: "hire_agent",
        requestedByAgentId: agentId,
        status: "revision_requested",
        payload: { name: "Pull hire" },
      })
      .returning();
    return approval!.id;
  }

  it.each(EXTERNAL_PULL_PAYLOADS)(
    "create: refuses an agent hire approval declaring external_pull in %s",
    async (_label, payload) => {
      const res = await request(app)
        .post(`/companies/${companyId}/approvals`)
        .set("Authorization", `Bearer ${AGENT_TOKEN}`)
        .send({ type: "hire_agent", payload });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.code).toBe("agent_work_delivery_board_only");
      expect(await db.select().from(approvals).where(eq(approvals.companyId, companyId))).toHaveLength(0);
    },
  );

  it("create: lets the board file a hire approval declaring external_pull", async () => {
    const res = await request(app)
      .post(`/companies/${companyId}/approvals`)
      .set("Authorization", `Bearer ${BOARD_TOKEN}`)
      .send({ type: "hire_agent", payload: EXTERNAL_PULL_PAYLOADS[0]![1] });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it.each(EXTERNAL_PULL_PAYLOADS)(
    "resubmit: refuses an agent hire resubmission declaring external_pull in %s",
    async (_label, payload) => {
      const approvalId = await seedRevisionRequestedHire();

      const res = await request(app)
        .post(`/approvals/${approvalId}/resubmit`)
        .set("Authorization", `Bearer ${AGENT_TOKEN}`)
        .send({ payload });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.code).toBe("agent_work_delivery_board_only");
      const [stored] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
      expect(stored!.status).toBe("revision_requested");
      expect(stored!.payload).toEqual({ name: "Pull hire" });
    },
  );

  it("resubmit: lets the requesting agent resubmit a hire that keeps invoked delivery", async () => {
    const approvalId = await seedRevisionRequestedHire();

    const res = await request(app)
      .post(`/approvals/${approvalId}/resubmit`)
      .set("Authorization", `Bearer ${AGENT_TOKEN}`)
      .send({ payload: { name: "Pull hire", runtimeConfig: { workDelivery: "invoked" } } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("pending");
  });
});
