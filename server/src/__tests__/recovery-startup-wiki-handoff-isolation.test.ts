import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  pluginManagedResources,
  plugins,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { recoveryService } from "../services/recovery/service.js";

const issueUpdateHook = vi.hoisted(() => ({
  failIssueIds: new Set<string>(),
}));

vi.mock("../services/issues.js", async () => {
  const actual = await vi.importActual<typeof import("../services/issues.js")>("../services/issues.js");
  return {
    ...actual,
    issueService: (...args: Parameters<typeof actual.issueService>) => {
      const service = actual.issueService(...args);
      const update = service.update.bind(service);
      service.update = async (...updateArgs: Parameters<typeof update>) => {
        const issueId = updateArgs[0];
        if (issueUpdateHook.failIssueIds.has(issueId)) {
          throw new Error(`injected recovery write failure for ${issueId}`);
        }
        return update(...updateArgs);
      };
      return service;
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping startup wiki-handoff recovery tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("startup recovery wiki handoff isolation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-startup-wiki-guard-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    issueUpdateHook.failIssueIds.clear();
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(agentWakeupRequests);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(pluginManagedResources);
    await db.delete(agents);
    await db.delete(plugins);
    await db.delete(companies);
  });
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const maintainerId = randomUUID();
    const intruderId = randomUUID();
    const coderId = randomUUID();
    const prefix = `WG${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Startup Wiki Guard",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
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
    await db.insert(agents).values([
      {
        id: maintainerId,
        companyId,
        name: "Wiki Maintainer",
        role: "knowledge-maintainer",
        status: "paused",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: intruderId,
        companyId,
        name: "coder-LE",
        role: "engineer",
        status: "paused",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ] as never);
    await db.insert(pluginManagedResources).values({
      companyId,
      pluginId,
      pluginKey: "paperclipai.plugin-llm-wiki",
      resourceKind: "agent",
      resourceKey: "wiki-maintainer",
      resourceId: maintainerId,
      defaultsJson: {},
    });
    return { companyId, maintainerId, intruderId, coderId, prefix };
  }

  function reviewState(agentId: string, stageId: string) {
    return {
      status: "pending",
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId, userId: null },
      returnAssignee: { type: "agent", agentId, userId: null },
      reviewRequest: null,
      completedStageIds: [],
      skippedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    };
  }

  async function seedWikiHandoff(input: {
    companyId: string;
    prefix: string;
    intruderId: string;
    issueNumber: number;
  }) {
    const issueId = randomUUID();
    const stageId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "[PPC ER] Weekly Report — handoff to Wiki Maintainer",
      description: null,
      status: "in_review",
      priority: "medium",
      assigneeAgentId: input.intruderId,
      issueNumber: input.issueNumber,
      identifier: `${input.prefix}-${input.issueNumber}`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "agent", agentId: input.intruderId, userId: null }],
          },
        ],
      },
      executionState: reviewState(input.intruderId, stageId),
    });
    return issueId;
  }

  async function seedOrdinaryStranded(input: {
    companyId: string;
    prefix: string;
    coderId: string;
    issueNumber: number;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Ordinary stranded card",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: input.coderId,
      issueNumber: input.issueNumber,
      identifier: `${input.prefix}-${input.issueNumber}`,
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "model_not_found: requested model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-11-07T10:00:00.000Z"),
      finishedAt: new Date("2026-11-07T10:01:00.000Z"),
      contextSnapshot: { issueId },
    });
    return issueId;
  }

  it("parks a non-canonical Wiki handoff without throwing and still processes the other stranded card", async () => {
    const seeded = await seedCompany();
    const wikiIssueId = await seedWikiHandoff({ ...seeded, issueNumber: 1 });
    const ordinaryIssueId = await seedOrdinaryStranded({ ...seeded, issueNumber: 2 });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.issueIds).toEqual(expect.arrayContaining([wikiIssueId, ordinaryIssueId]));
    const [wiki, ordinary] = await Promise.all([
      db.select().from(issues).where(eq(issues.id, wikiIssueId)).then((rows) => rows[0]),
      db.select().from(issues).where(eq(issues.id, ordinaryIssueId)).then((rows) => rows[0]),
    ]);
    expect(wiki).toMatchObject({ status: "blocked", assigneeAgentId: seeded.intruderId });
    expect(ordinary?.status).toBe("blocked");
  });

  it("continues the sweep when one card's issue write throws a non-guard error", async () => {
    const seeded = await seedCompany();
    const failingIssueId = await seedWikiHandoff({ ...seeded, issueNumber: 3 });
    const ordinaryIssueId = await seedOrdinaryStranded({ ...seeded, issueNumber: 4 });
    issueUpdateHook.failIssueIds.add(failingIssueId);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.issueIds).toContain(ordinaryIssueId);
    expect(result.issueIds).not.toContain(failingIssueId);
    const [failing, ordinary] = await Promise.all([
      db.select().from(issues).where(eq(issues.id, failingIssueId)).then((rows) => rows[0]),
      db.select().from(issues).where(eq(issues.id, ordinaryIssueId)).then((rows) => rows[0]),
    ]);
    expect(failing).toMatchObject({ status: "in_review", assigneeAgentId: seeded.intruderId });
    expect(ordinary?.status).toBe("blocked");
  });

  it("still refuses an explicit non-canonical assignee write on a Wiki handoff", async () => {
    const seeded = await seedCompany();
    const wikiIssueId = await seedWikiHandoff({ ...seeded, issueNumber: 5 });
    const svc = issueService(db);

    await expect(svc.update(wikiIssueId, { status: "blocked", blockedByIssueIds: [] })).resolves.toMatchObject({
      status: "blocked",
      assigneeAgentId: seeded.intruderId,
    });
    await expect(svc.update(wikiIssueId, { assigneeAgentId: seeded.coderId })).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({ reason: "wiki_handoff_non_canonical_assignee" }),
    });
  });
});
