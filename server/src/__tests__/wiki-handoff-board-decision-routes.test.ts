import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issueExecutionDecisions,
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
import { issueService } from "../services/issues.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Wiki handoff board-decision route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const HANDOFF_TITLE = "[PPC ER] Weekly Report — handoff to Wiki Maintainer";
const STAGE_ID = "11111111-1111-4111-8111-111111111111";
const NON_CANONICAL_REFUSAL =
  "Refusing assigneeAgentId write on a Wiki handoff: the resulting assignee is not the canonical Wiki Maintainer managed by plugin paperclipai.plugin-llm-wiki (resourceKey wiki-maintainer)";

const COMPLETED_STATE = {
  status: "completed",
  currentStageId: null,
  currentStageIndex: null,
  currentStageType: null,
  currentParticipant: null,
  returnAssignee: null,
  deliveryAuthor: null,
  completedStageIds: [STAGE_ID],
  skippedStageIds: [],
  lastDecisionId: null,
  lastDecisionOutcome: "approved",
  changesRequestedCount: 0,
};

// SUP-24632: an accepted weekly-report Wiki handoff with NO assignee must close
// through the board stage decision without the decision writing an assignee. Every
// other assignee write on a Wiki handoff stays refused.
describeEmbeddedPostgres("Wiki handoff board stage decision on an unassigned card (SUP-24632)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousOverrideFlag: string | undefined;
  let wakeups: Array<{ agentId: string }> = [];

  beforeAll(async () => {
    previousOverrideFlag = process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wiki-handoff-board-decision-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(() => {
    process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE = "true";
    wakeups = [];
  });

  afterEach(async () => {
    await db.delete(issueExecutionDecisions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(pluginManagedResources);
    await db.delete(plugins);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (previousOverrideFlag === undefined) {
      delete process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE;
    } else {
      process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE = previousOverrideFlag;
    }
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use(
      "/api",
      issueRoutes(db, {} as StorageService, {
        executionStageWakeupEnqueue: async (agentId: string) => {
          wakeups.push({ agentId });
          return { id: "wakeup-stub" };
        },
      } as never),
    );
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
      source: "local_implicit",
    };
  }

  async function seedWikiCompany() {
    const nonce = randomUUID().slice(0, 8);
    const [company] = await db.insert(companies).values({
      name: `Wiki ${nonce}`,
      issuePrefix: `WB${nonce.slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    }).returning();
    const agentBase = {
      companyId: company!.id,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    };
    const [maintainer, reviewer, intruder] = await db.insert(agents).values([
      {
        ...agentBase,
        name: "Wiki Maintainer",
        metadata: {
          pluginManagedAgent: {
            pluginKey: "paperclipai.plugin-llm-wiki",
            agentKey: "wiki-maintainer",
          },
        },
      },
      { ...agentBase, name: "Reviewer" },
      { ...agentBase, name: "coder-LE" },
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
    return { company: company!, maintainer: maintainer!, reviewer: reviewer!, intruder: intruder! };
  }

  let issueCounter = 0;
  /**
   * An accepted weekly-report handoff parked in_review on its single review stage.
   * `returnAssigneeAgentId` is the ladder's return-to: null reproduces the stuck
   * cards (the ladder was entered while nobody owned the card).
   */
  async function seedInReviewHandoff(input: {
    companyId: string;
    reviewerId: string;
    assigneeAgentId: string | null;
    returnAssigneeAgentId: string | null;
    title?: string;
  }) {
    issueCounter += 1;
    const [issue] = await db.insert(issues).values({
      companyId: input.companyId,
      title: input.title ?? HANDOFF_TITLE,
      status: "in_review",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId,
      assigneeUserId: null,
      issueNumber: issueCounter,
      identifier: `WB-${issueCounter}`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        ...(input.returnAssigneeAgentId ? { returnAssigneeAgentId: input.returnAssigneeAgentId } : {}),
        stages: [{
          id: STAGE_ID,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ type: "agent", agentId: input.reviewerId }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: STAGE_ID,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: input.reviewerId, userId: null },
        returnAssignee: input.returnAssigneeAgentId
          ? { type: "agent", agentId: input.returnAssigneeAgentId, userId: null }
          : null,
        deliveryAuthor: null,
        completedStageIds: [],
        skippedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        changesRequestedCount: 0,
      },
    }).returning();
    return issue!;
  }

  async function readBack(issueId: string) {
    const [row] = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    return row!;
  }

  async function decisionCount(issueId: string) {
    return (await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, issueId))).length;
  }

  function approve(app: express.Express, issueId: string) {
    return request(app)
      .post(`/api/issues/${issueId}/execution-stage/board-decision`)
      .send({ decision: "approved", comment: "Accepted weekly report." });
  }

  it("approves the unassigned handoff, records the decision, and leaves it unassigned with no wake", async () => {
    const { company, reviewer } = await seedWikiCompany();
    const card = await seedInReviewHandoff({
      companyId: company.id,
      reviewerId: reviewer.id,
      assigneeAgentId: null,
      returnAssigneeAgentId: null,
    });

    const res = await approve(createApp(boardActor(company.id)), card.id);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await readBack(card.id);
    expect(after).toMatchObject({ status: "todo", assigneeAgentId: null, assigneeUserId: null });
    expect(after.executionState).toMatchObject({ status: "completed", completedStageIds: [STAGE_ID] });
    await expect(decisionCount(card.id)).resolves.toBe(1);
    expect(wakeups).toEqual([]);
  });

  it("still hands a handoff whose return-to is the canonical Maintainer back to it (sibling unchanged)", async () => {
    const { company, maintainer, reviewer } = await seedWikiCompany();
    const card = await seedInReviewHandoff({
      companyId: company.id,
      reviewerId: reviewer.id,
      assigneeAgentId: reviewer.id,
      returnAssigneeAgentId: maintainer.id,
    });

    const res = await approve(createApp(boardActor(company.id)), card.id);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expect(readBack(card.id)).resolves.toMatchObject({
      status: "in_progress",
      assigneeAgentId: maintainer.id,
      assigneeUserId: null,
    });
  });

  it("still refuses a stage decision that would hand the unassigned handoff to a non-canonical agent", async () => {
    const { company, reviewer, intruder } = await seedWikiCompany();
    const card = await seedInReviewHandoff({
      companyId: company.id,
      reviewerId: reviewer.id,
      assigneeAgentId: null,
      returnAssigneeAgentId: intruder.id,
    });

    const res = await approve(createApp(boardActor(company.id)), card.id);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toBe(NON_CANONICAL_REFUSAL);
    expect(res.body.details).toMatchObject({
      guard: "assignee_review_gate",
      subGuard: "wiki_handoff",
      reason: "wiki_handoff_non_canonical_assignee",
      assigneeAgentId: intruder.id,
    });
    await expect(readBack(card.id)).resolves.toMatchObject({
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: null,
    });
    await expect(decisionCount(card.id)).resolves.toBe(0);
  });

  it("still refuses a stage decision on a Wiki handoff owned by a non-canonical agent with no return-to", async () => {
    const { company, reviewer, intruder } = await seedWikiCompany();
    const card = await seedInReviewHandoff({
      companyId: company.id,
      reviewerId: reviewer.id,
      assigneeAgentId: intruder.id,
      returnAssigneeAgentId: null,
    });

    const res = await approve(createApp(boardActor(company.id)), card.id);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ subGuard: "wiki_handoff" });
    await expect(readBack(card.id)).resolves.toMatchObject({ status: "in_review", assigneeAgentId: intruder.id });
    await expect(decisionCount(card.id)).resolves.toBe(0);
  });

  it("does not open any other assignee write on the unassigned handoff", async () => {
    const { company, reviewer, intruder } = await seedWikiCompany();
    const card = await seedInReviewHandoff({
      companyId: company.id,
      reviewerId: reviewer.id,
      assigneeAgentId: null,
      returnAssigneeAgentId: null,
    });
    const app = createApp(boardActor(company.id));

    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["PATCH assigneeAgentId to a non-canonical agent", { assigneeAgentId: intruder.id }, "wiki_handoff_non_canonical_assignee"],
      ["PATCH assigneeAgentId null", { assigneeAgentId: null }, "wiki_handoff_unassigned"],
      ["PATCH status todo", { status: "todo" }, "wiki_handoff_unassigned"],
    ];
    for (const [name, body, reason] of cases) {
      const res = await request(app).patch(`/api/issues/${card.id}`).send(body);
      expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBe(422);
      expect(res.body.error, name).toBe(NON_CANONICAL_REFUSAL);
      expect(res.body.details, name).toMatchObject({ subGuard: "wiki_handoff", reason });
    }
    // The marker is internal: the PATCH schema rejects a body that carries it.
    const smuggled = await request(app).patch(`/api/issues/${card.id}`).send({ status: "todo", boardStageDecision: true });
    expect(smuggled.status, JSON.stringify(smuggled.body)).toBe(400);
    await expect(readBack(card.id)).resolves.toMatchObject({
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: null,
    });
  });

  it("rejects the internal marker (flat or nested) on PATCH for board and agent callers and changes nothing", async () => {
    const { company, reviewer, intruder } = await seedWikiCompany();
    const card = await seedInReviewHandoff({
      companyId: company.id,
      reviewerId: reviewer.id,
      assigneeAgentId: null,
      returnAssigneeAgentId: null,
    });
    const agentActor = {
      type: "agent",
      agentId: intruder.id,
      companyId: company.id,
      source: "agent_key",
      runId: randomUUID(),
    } as unknown as Express.Request["actor"];
    const nested = { assigneeFieldWritten: false, currentAssigneeUserId: null };
    const markers = [{ boardStageDecision: true }, { boardStageDecision: nested }];
    const writes = [{ assigneeAgentId: intruder.id }, { assigneeAgentId: null }, { status: "todo" }];

    for (const actor of [boardActor(company.id), agentActor]) {
      const app = createApp(actor);
      for (const marker of markers) {
        for (const write of writes) {
          const res = await request(app).patch(`/api/issues/${card.id}`).send({ ...write, ...marker });
          expect(res.status, JSON.stringify({ actor: actor.type, marker, write, body: res.body })).toBe(400);
        }
      }
    }
    await expect(readBack(card.id)).resolves.toMatchObject({
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: null,
    });
  });

  it("keeps refusing a service-level stage-shaped write without the board decision marker", async () => {
    const { company, reviewer, intruder } = await seedWikiCompany();
    const card = await seedInReviewHandoff({
      companyId: company.id,
      reviewerId: reviewer.id,
      assigneeAgentId: null,
      returnAssigneeAgentId: null,
    });
    const svc = issueService(db);
    const completedState = COMPLETED_STATE;

    for (const write of [
      { status: "todo", executionState: completedState, workflowControlledAssignment: true, actorAgentId: null, actorUserId: "board-user" },
      { status: "todo", executionState: completedState, actorAgentId: intruder.id },
      { status: "todo", executionState: completedState, assigneeAgentId: null, assigneeUserId: null, workflowControlledAssignment: true },
    ]) {
      await expect(svc.update(card.id, write as never)).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({ subGuard: "wiki_handoff" }),
      });
    }
    await expect(readBack(card.id)).resolves.toMatchObject({ status: "in_review", assigneeAgentId: null });
  });

  it("admits the board decision marker only for a write that leaves an unassigned row unassigned", async () => {
    const { company, reviewer, intruder } = await seedWikiCompany();
    const card = await seedInReviewHandoff({
      companyId: company.id,
      reviewerId: reviewer.id,
      assigneeAgentId: null,
      returnAssigneeAgentId: null,
    });
    const svc = issueService(db);
    const base = { status: "todo", executionState: COMPLETED_STATE, workflowControlledAssignment: true, boardStageDecision: true, actorAgentId: null, actorUserId: "board-user" };

    // Marker plus an assignee field (even null/null or a non-canonical agent) is not the skipped no-op write.
    for (const assignee of [{ assigneeAgentId: null }, { assigneeUserId: null }, { assigneeAgentId: intruder.id }]) {
      await expect(svc.update(card.id, { ...base, ...assignee } as never)).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({ subGuard: "wiki_handoff" }),
      });
    }
    // Marker on a user-owned row: the decision would clear that owner, so it stays refused.
    await db.update(issues).set({ assigneeUserId: "board-owner" }).where(eq(issues.id, card.id));
    await expect(svc.update(card.id, base as never)).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({ subGuard: "wiki_handoff" }),
    });
    // Marker on an agent-owned (non-canonical) row stays refused.
    await db.update(issues).set({ assigneeUserId: null, assigneeAgentId: intruder.id }).where(eq(issues.id, card.id));
    await expect(svc.update(card.id, base as never)).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({ subGuard: "wiki_handoff" }),
    });
    await expect(readBack(card.id)).resolves.toMatchObject({ status: "in_review", assigneeAgentId: intruder.id });
  });

  it("leaves a non-Wiki unassigned card's board decision unchanged", async () => {
    const { company, reviewer } = await seedWikiCompany();
    const card = await seedInReviewHandoff({
      companyId: company.id,
      reviewerId: reviewer.id,
      assigneeAgentId: null,
      returnAssigneeAgentId: null,
      title: "Weekly report — plain card",
    });

    const res = await approve(createApp(boardActor(company.id)), card.id);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expect(readBack(card.id)).resolves.toMatchObject({ status: "todo", assigneeAgentId: null, assigneeUserId: null });
  });
});
