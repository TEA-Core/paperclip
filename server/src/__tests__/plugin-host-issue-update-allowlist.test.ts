import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueExecutionDecisions,
  issueLabels,
  issues,
  labels,
  pluginManagedResources,
  plugins,
} from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin-host issues.update allow-list tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const PLUGIN_KEY = "permissions-extension";
const HANDOFF_TITLE = "[PPC ER] Weekly Report — handoff to Wiki Maintainer";
const STAGE_ID = "11111111-1111-4111-8111-111111111111";

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: () => {}, subscribe: () => {}, clear: () => {} };
    },
  } as never;
}

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

// The plugin host forwards only the SDK-declared `issues.update` patch keys.
// Internal issue-service flags must not be reachable from a plugin, because
// the Wiki handoff guard trusts them.
describeEmbeddedPostgres("plugin-host issues.update patch allow-list", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-issue-update-allowlist-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueExecutionDecisions);
    await db.delete(activityLog);
    await db.delete(issueLabels);
    await db.delete(labels);
    await db.delete(issues);
    await db.delete(pluginManagedResources);
    await db.delete(plugins);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const nonce = randomUUID().slice(0, 8);
    const [company] = await db.insert(companies).values({
      name: `Plugin ${nonce}`,
      issuePrefix: `PL${nonce.slice(0, 4).toUpperCase()}`,
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
      { ...agentBase, name: "Wiki Maintainer" },
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
  async function seedIssue(companyId: string, values: Partial<typeof issues.$inferInsert> = {}) {
    issueCounter += 1;
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Plain card",
      status: "todo",
      priority: "medium",
      issueNumber: issueCounter,
      identifier: `PL-${issueCounter}`,
      ...values,
    }).returning();
    return issue!;
  }

  /** An accepted weekly-report handoff: unassigned, in review, one pending review stage. */
  async function seedUnassignedInReviewHandoff(companyId: string, reviewerId: string) {
    return seedIssue(companyId, {
      title: HANDOFF_TITLE,
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: null,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: STAGE_ID,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ type: "agent", agentId: reviewerId }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: STAGE_ID,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
        returnAssignee: null,
        deliveryAuthor: null,
        completedStageIds: [],
        skippedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        changesRequestedCount: 0,
      },
    });
  }

  async function readCard(issueId: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    return row!;
  }

  it("refuses a plugin patch that carries boardStageDecision and writes no close or execution state", async () => {
    const { company, reviewer } = await seedCompany();
    const card = await seedUnassignedInReviewHandoff(company.id, reviewer.id);
    const before = await readCard(card.id);
    const services = buildHostServices(db, randomUUID(), PLUGIN_KEY, createEventBusStub());

    for (const patch of [
      { boardStageDecision: true, status: "done", executionState: COMPLETED_STATE },
      { boardStageDecision: true, status: "todo", description: "forged" },
      { boardStageDecision: { assigneeFieldWritten: false, currentAssigneeUserId: null }, status: "done" },
    ]) {
      await expect(
        services.issues.update({ issueId: card.id, companyId: company.id, patch: patch as never }),
      ).rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({ subGuard: "wiki_handoff", reason: "wiki_handoff_unassigned" }),
      });
    }

    const after = await readCard(card.id);
    expect(after.status).toBe("in_review");
    expect(after.description).toBe(before.description);
    expect(after.executionState).toEqual(before.executionState);
    expect(after.assigneeAgentId).toBeNull();
    expect(await db.select().from(issueExecutionDecisions)).toEqual([]);
    services.dispose();
  });

  it("refuses a plugin patch that carries workflowControlledAssignment to seat a non-canonical agent", async () => {
    const { company, reviewer } = await seedCompany();
    const card = await seedUnassignedInReviewHandoff(company.id, reviewer.id);
    const services = buildHostServices(db, randomUUID(), PLUGIN_KEY, createEventBusStub());

    await expect(
      services.issues.update({
        issueId: card.id,
        companyId: company.id,
        patch: { assigneeAgentId: reviewer.id, workflowControlledAssignment: true } as never,
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        subGuard: "wiki_handoff",
        reason: "wiki_handoff_non_canonical_assignee",
      }),
    });

    expect((await readCard(card.id)).assigneeAgentId).toBeNull();
    services.dispose();
  });

  it("drops internal and undeclared keys from the patch and from the activity detail", async () => {
    const { company } = await seedCompany();
    const card = await seedIssue(company.id);
    const services = buildHostServices(db, randomUUID(), PLUGIN_KEY, createEventBusStub());

    const updated = await services.issues.update({
      issueId: card.id,
      companyId: company.id,
      patch: {
        title: "Renamed by plugin",
        boardStageDecision: true,
        workflowControlledAssignment: true,
        companyGuard: randomUUID(),
        expectedUpdatedAt: new Date(0),
        executionState: COMPLETED_STATE,
        ["__proto__"]: { status: "done" },
      } as never,
    });

    expect(updated.title).toBe("Renamed by plugin");
    const row = await readCard(card.id);
    expect(row.status).toBe("todo");
    expect(row.executionState).toBeNull();
    const [activity] = await db.select().from(activityLog).where(eq(activityLog.entityId, card.id));
    expect(Object.keys((activity!.details as { patch: Record<string, unknown> }).patch)).toEqual(["title"]);
    services.dispose();
  });

  it("still passes every SDK-declared patch field through unchanged", async () => {
    const { company, intruder } = await seedCompany();
    const blocker = await seedIssue(company.id, { title: "Blocker", status: "done" });
    const [label] = await db.insert(labels).values({ companyId: company.id, name: "plugin-label", color: "#112233" }).returning();
    const card = await seedIssue(company.id);
    const services = buildHostServices(db, randomUUID(), PLUGIN_KEY, createEventBusStub());

    const updated = await services.issues.update({
      issueId: card.id,
      companyId: company.id,
      patch: {
        title: "Declared fields",
        description: "All declared keys pass.",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: intruder.id,
        billingCode: "BILL-1",
        originKind: `plugin:${PLUGIN_KEY}:feature`,
        originId: "origin-1",
        originRunId: "run-ref-1",
        requestDepth: 2,
        blockedByIssueIds: [blocker.id],
        labelIds: [label!.id],
      },
    });

    expect(updated).toMatchObject({
      title: "Declared fields",
      description: "All declared keys pass.",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: intruder.id,
      billingCode: "BILL-1",
      originKind: `plugin:${PLUGIN_KEY}:feature`,
      originId: "origin-1",
      originRunId: "run-ref-1",
      requestDepth: 2,
    });
    const linked = await db.select().from(issueLabels).where(eq(issueLabels.issueId, card.id));
    expect(linked.map((row) => row.labelId)).toEqual([label!.id]);
    const [activity] = await db.select().from(activityLog).where(eq(activityLog.entityId, card.id));
    expect(Object.keys((activity!.details as { patch: Record<string, unknown> }).patch).sort()).toEqual([
      "assigneeAgentId",
      "billingCode",
      "blockedByIssueIds",
      "description",
      "labelIds",
      "originId",
      "originKind",
      "originRunId",
      "priority",
      "requestDepth",
      "status",
      "title",
    ]);
    services.dispose();
  });
});
