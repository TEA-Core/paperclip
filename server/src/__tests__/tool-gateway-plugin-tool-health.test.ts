import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  plugins,
  projects,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createCompany(db: Db) {
  return db
    .insert(companies)
    .values({
      name: `Health ${randomUUID()}`,
      issuePrefix: `PH${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: Db, companyId: string) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createIssueAndRun(db: Db, companyId: string, agentId: string) {
  const project = await db
    .insert(projects)
    .values({ companyId, name: `Project ${randomUUID()}` })
    .returning()
    .then((rows) => rows[0]!);
  const run = await db
    .insert(heartbeatRuns)
    .values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { projectId: project.id },
    })
    .returning()
    .then((rows) => rows[0]!);
  return { project, run };
}

async function allowToolsForAgent(db: Db, companyId: string, agentId: string, toolNames: string[]) {
  const profile = await db
    .insert(toolProfiles)
    .values({
      companyId,
      profileKey: `health-${randomUUID()}`,
      name: `Health profile ${randomUUID()}`,
      defaultAction: "deny",
    })
    .returning()
    .then((rows) => rows[0]!);
  await db.insert(toolProfileBindings).values({
    companyId,
    profileId: profile.id,
    targetType: "agent",
    targetId: agentId,
  });
  if (toolNames.length > 0) {
    await db.insert(toolProfileEntries).values(toolNames.map((toolName) => ({
      companyId,
      profileId: profile.id,
      selectorType: "tool_name" as const,
      effect: "include" as const,
      toolName,
    })));
  }
  return profile;
}

function makeDispatcher(pluginId: string, toolNames: string[]): PluginToolDispatcher {
  return {
    initialize: async () => {},
    teardown: () => {},
    listToolsForAgent: () => toolNames.map((name) => ({
      name,
      displayName: name,
      description: "test tool",
      parametersSchema: { type: "object" },
      pluginId,
    })),
    getTool: () => null,
    executeTool: async () => { throw new Error("not used"); },
    registerPluginTools: () => {},
    unregisterPluginTools: () => {},
    toolCount: (id?: string) => id === pluginId ? toolNames.length : 0,
    getRegistry: () => { throw new Error("not used"); },
  };
}

describe("pluginToolHealth (embedded postgres)", () => {
  let db: Db;
  let tempDb: { connectionString: string; cleanup: () => Promise<void> };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-tool-health-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb.cleanup();
  });

  afterEach(async () => {
    const allCompanies = await db.select({ id: companies.id }).from(companies);
    for (const c of allCompanies) {
      await db.delete(toolProfileBindings).where(and(eq(toolProfileBindings.companyId, c.id)));
      await db.delete(toolProfileEntries).where(and(eq(toolProfileEntries.companyId, c.id)));
      await db.delete(toolProfiles).where(and(eq(toolProfiles.companyId, c.id)));
      await db.delete(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, c.id)));
      await db.delete(projects).where(and(eq(projects.companyId, c.id)));
      await db.delete(agents).where(and(eq(agents.companyId, c.id)));
      await db.delete(companies).where(eq(companies.id, c.id));
    }
    await db.delete(plugins);
  });

  it("reports not-ready reason when a plugin declares tools but is in installed status", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run: _run } = await createIssueAndRun(db, company.id, agent.id);

    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.ready-plugin",
      packageName: "@acme/plugin-ready",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.ready-plugin",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Ready Plugin",
        description: "A ready plugin",
        author: "Acme",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
        tools: [
          { name: "do_thing", displayName: "Do Thing", description: "Does a thing", parametersSchema: { type: "object" } },
          { name: "do_other", displayName: "Do Other", description: "Does other", parametersSchema: { type: "object" } },
        ],
      },
      status: "ready",
      installOrder: 1,
    });

    const notReadyPluginId = randomUUID();
    await db.insert(plugins).values({
      id: notReadyPluginId,
      pluginKey: "acme.broken-plugin",
      packageName: "@acme/plugin-broken",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.broken-plugin",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Broken Plugin",
        description: "A broken plugin",
        author: "Acme",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
        tools: [
          { name: "do_x", displayName: "Do X", description: "Does x", parametersSchema: { type: "object" } },
        ],
      },
      status: "installed",
      installOrder: 2,
    });

    const dispatcher = makeDispatcher(pluginId, ["acme.ready-plugin:do_thing", "acme.ready-plugin:do_other"]);
    const gateway = createToolGatewayService(db, {
      pluginToolDispatcher: dispatcher,
      toolActionSigningSecret: "test-secret",
    });

    await allowToolsForAgent(db, company.id, agent.id, ["acme.ready-plugin:do_thing", "acme.ready-plugin:do_other"]);

    const result = await gateway.pluginToolHealth({ companyId: company.id, agentId: agent.id });
    expect(result.plugins).toHaveLength(2);

    const readyEntry = result.plugins.find((p: { pluginKey: string }) => p.pluginKey === "acme.ready-plugin")!;
    expect(readyEntry).toMatchObject({
      pluginKey: "acme.ready-plugin",
      pluginStatus: "ready",
      declaredToolCount: 2,
      registeredToolCount: 2,
      visibleToolCount: 2,
      deliverable: true,
      reason: null,
    });

    const notReadyEntry = result.plugins.find((p: { pluginKey: string }) => p.pluginKey === "acme.broken-plugin")!;
    expect(notReadyEntry).toMatchObject({
      pluginKey: "acme.broken-plugin",
      pluginStatus: "installed",
      declaredToolCount: 1,
      registeredToolCount: 0,
      visibleToolCount: 0,
      deliverable: false,
    });
    expect(notReadyEntry.reason).toBe('Plugin "acme.broken-plugin" is in "installed" status');
  });

  it("reports not-bound reason when a ready plugin has no tools in the agent profile", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run: _run } = await createIssueAndRun(db, company.id, agent.id);

    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.excluded-plugin",
      packageName: "@acme/plugin-excluded",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.excluded-plugin",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Excluded Plugin",
        description: "Excluded plugin",
        author: "Acme",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
        tools: [
          { name: "do_z", displayName: "Do Z", description: "Does z", parametersSchema: { type: "object" } },
        ],
      },
      status: "ready",
      installOrder: 1,
    });

    const dispatcher = makeDispatcher(pluginId, ["acme.excluded-plugin:do_z"]);
    const gateway = createToolGatewayService(db, {
      pluginToolDispatcher: dispatcher,
      toolActionSigningSecret: "test-secret",
    });

    const result = await gateway.pluginToolHealth({ companyId: company.id, agentId: agent.id });
    expect(result.plugins).toHaveLength(1);

    const entry = result.plugins[0]!;
    expect(entry).toMatchObject({
      pluginKey: "acme.excluded-plugin",
      pluginStatus: "ready",
      declaredToolCount: 1,
      registeredToolCount: 1,
      visibleToolCount: 0,
      deliverable: false,
    });
    expect(entry.reason).toBe('Plugin "acme.excluded-plugin" tools are not bound to this agent');
  });

  it("returns empty plugins array when no plugins declare tools", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    await createIssueAndRun(db, company.id, agent.id);

    const gateway = createToolGatewayService(db, {
      toolActionSigningSecret: "test-secret",
    });

    const result = await gateway.pluginToolHealth({ companyId: company.id, agentId: agent.id });
    expect(result.plugins).toEqual([]);
  });

  it("excludes plugins that do not declare tools", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    await createIssueAndRun(db, company.id, agent.id);

    await db.insert(plugins).values({
      id: randomUUID(),
      pluginKey: "acme.no-tools",
      packageName: "@acme/plugin-no-tools",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.no-tools",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "No Tools Plugin",
        description: "No tools",
        author: "Acme",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });

    const gateway = createToolGatewayService(db, {
      toolActionSigningSecret: "test-secret",
    });

    const result = await gateway.pluginToolHealth({ companyId: company.id, agentId: agent.id });
    expect(result.plugins).toEqual([]);
  });
});
