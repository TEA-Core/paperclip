import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  activityLog,
  agents,
  companies,
  createDb,
  type Db,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import type { PluginEventBus } from "../services/plugin-event-bus.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const RESTRICTED = "Restricted";

function createEventBusStub(): PluginEventBus {
  // The read paths under test never emit or subscribe.
  const scoped = { emit: async () => {}, subscribe: () => {}, clear: () => {} };
  return { forPlugin: () => scoped } as unknown as PluginEventBus;
}

function manifest(capabilities: string[]) {
  return { id: "paperclip.test", capabilities } as unknown as PaperclipPluginManifestV1;
}

const WITHOUT_ISSUES_READ = [
  "issue.subtree.read",
  "issue.comments.read",
  "authorization.audit.read",
  "issues.orchestration.read",
];
const WITH_ISSUES_READ = [...WITHOUT_ISSUES_READ, "issues.read"];

describeEmbeddedPostgres("plugin issue read paths for plugins without issues.read", () => {
  let db!: Db;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-issue-read-paths-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function services(capabilities: string[]) {
    return buildHostServices(db, "plugin-record-id", "paperclip.test", createEventBusStub(), undefined, {
      manifest: manifest(capabilities),
    });
  }

  async function seedTree() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const rootId = randomUUID();
    const childId = randomUUID();
    await db.insert(issues).values([
      {
        id: rootId,
        companyId,
        title: "Root title",
        description: `${RESTRICTED} root description`,
        status: "todo",
        priority: "medium",
        identifier: "RP-1",
        billingCode: `${RESTRICTED} billing code`,
      },
      {
        id: childId,
        companyId,
        parentId: rootId,
        title: "Child title",
        description: `${RESTRICTED} child description`,
        status: "blocked",
        priority: "high",
        identifier: "RP-2",
      },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: rootId, relatedIssueId: childId, type: "blocks" });
    const [document] = await db
      .insert(documents)
      .values({ companyId, title: "Plan title", format: "markdown", latestBody: `${RESTRICTED} plan body` })
      .returning();
    await db.insert(issueDocuments).values({ companyId, issueId: childId, documentId: document!.id, key: "plan" });
    await db.insert(issueComments).values({
      companyId,
      issueId: rootId,
      authorType: "user",
      authorUserId: "user-1",
      body: `${RESTRICTED} comment body`,
    });
    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "user",
        actorId: "user-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: rootId,
        details: {
          identifier: "RP-1",
          title: "Root title",
          status: "todo",
          description: `${RESTRICTED} activity description`,
          internalNoteKey: `${RESTRICTED} suffix-matched text`,
        },
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
      {
        companyId,
        actorType: "agent",
        actorId: "agent-1",
        action: "heartbeat.failed",
        entityType: "heartbeat_run",
        entityId: randomUUID(),
        details: { status: "failed", errorCode: "adapter_failed", error: `${RESTRICTED} run error` },
        createdAt: new Date("2026-01-03T00:00:00Z"),
      },
    ]);
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Runner",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      contextSnapshot: { issueId: rootId },
      error: `${RESTRICTED} run error text`,
      startedAt: new Date("2026-01-04T00:00:00Z"),
      finishedAt: new Date("2026-01-04T00:01:00Z"),
    });
    return { companyId, rootId, childId, agentId };
  }

  it("returns subtree titles and allow-listed metadata only to a plugin without issues.read", async () => {
    const { companyId, rootId, childId } = await seedTree();
    const host = services(WITHOUT_ISSUES_READ);

    const subtree = await host.issues.getSubtree({
      issueId: rootId,
      companyId,
      includeRelations: true,
      includeDocuments: true,
    });

    expect(JSON.stringify(subtree)).not.toContain(RESTRICTED);
    expect(subtree.issueIds).toEqual([rootId, childId]);
    const root = subtree.issues.find((issue) => issue.id === rootId)!;
    expect(root).toMatchObject({ id: rootId, title: "Root title", identifier: "RP-1", status: "todo", priority: "medium" });
    expect(root).not.toHaveProperty("description");
    expect(root).not.toHaveProperty("billingCode");
    expect(root.createdAt).toBeInstanceOf(Date);
    expect(subtree.relations?.[rootId]?.blocks).toEqual([
      expect.objectContaining({ id: childId, identifier: "RP-2", title: "Child title", status: "blocked" }),
    ]);
    expect(subtree.documents?.[childId]).toEqual([
      expect.objectContaining({ key: "plan", title: "Plan title", format: "markdown" }),
    ]);
    host.dispose();
  });

  it("returns full subtree rows to a plugin with issues.read", async () => {
    const { companyId, rootId } = await seedTree();
    const host = services(WITH_ISSUES_READ);

    const subtree = await host.issues.getSubtree({ issueId: rootId, companyId });

    expect(subtree.issues.find((issue) => issue.id === rootId)).toMatchObject({
      description: `${RESTRICTED} root description`,
      billingCode: `${RESTRICTED} billing code`,
    });
    host.dispose();
  });

  it("returns comment metadata without bodies to a plugin without issues.read", async () => {
    const { companyId, rootId } = await seedTree();
    const host = services(WITHOUT_ISSUES_READ);

    const comments = await host.issues.listComments({ issueId: rootId, companyId });

    expect(comments).toHaveLength(1);
    expect(JSON.stringify(comments)).not.toContain(RESTRICTED);
    expect(comments[0]).toMatchObject({ issueId: rootId, authorType: "user", authorUserId: "user-1" });
    expect(comments[0]).not.toHaveProperty("body");
    host.dispose();
  });

  it("returns comment bodies to a plugin with issues.read", async () => {
    const { companyId, rootId } = await seedTree();
    const host = services(WITH_ISSUES_READ);

    const comments = await host.issues.listComments({ issueId: rootId, companyId });

    expect(comments[0]).toMatchObject({ body: `${RESTRICTED} comment body` });
    host.dispose();
  });

  it("strips issue content from audit entries for a plugin without issues.read", async () => {
    const { companyId, rootId } = await seedTree();
    const host = services(WITHOUT_ISSUES_READ);

    const entries = await host.authorization.searchAudit({ companyId });

    expect(JSON.stringify(entries)).not.toContain(RESTRICTED);
    expect(entries.find((entry) => entry.entityId === rootId)?.details).toEqual({
      identifier: "RP-1",
      title: "Root title",
      status: "todo",
    });
    expect(entries.find((entry) => entry.entityType === "heartbeat_run")?.details).toEqual({
      status: "failed",
      errorCode: "adapter_failed",
    });
    host.dispose();
  });

  it("returns audit entries unchanged to a plugin with issues.read", async () => {
    const { companyId, rootId } = await seedTree();
    const host = services(WITH_ISSUES_READ);

    const entries = await host.authorization.searchAudit({ companyId });

    expect(entries.find((entry) => entry.entityId === rootId)?.details).toMatchObject({
      description: `${RESTRICTED} activity description`,
    });
    expect(entries.find((entry) => entry.entityType === "heartbeat_run")?.details).toMatchObject({
      error: `${RESTRICTED} run error`,
    });
    host.dispose();
  });

  it("strips run error text and relation content from the orchestration summary for a plugin without issues.read", async () => {
    const { companyId, rootId, childId, agentId } = await seedTree();
    const host = services(WITHOUT_ISSUES_READ);

    const summary = await host.issues.getOrchestrationSummary({ issueId: rootId, companyId, includeSubtree: true });

    expect(JSON.stringify(summary)).not.toContain(RESTRICTED);
    expect(summary.runs).toHaveLength(1);
    expect(summary.runs[0]).toMatchObject({ issueId: rootId, agentId, status: "failed", invocationSource: "assignment" });
    expect(summary.runs[0]).not.toHaveProperty("error");
    expect(summary.relations[rootId]?.blocks).toEqual([
      expect.objectContaining({ id: childId, identifier: "RP-2", title: "Child title", status: "blocked" }),
    ]);
    host.dispose();
  });

  it("returns run error text in the orchestration summary to a plugin with issues.read", async () => {
    const { companyId, rootId } = await seedTree();
    const host = services(WITH_ISSUES_READ);

    const summary = await host.issues.getOrchestrationSummary({ issueId: rootId, companyId });

    expect(summary.runs[0]).toMatchObject({ error: `${RESTRICTED} run error text` });
    host.dispose();
  });
});
