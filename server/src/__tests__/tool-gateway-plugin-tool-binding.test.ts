import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issueThreadInteractions,
  issues,
  toolAccessAuditEvents,
  toolActionRequests,
  toolApplications,
  toolCallEvents,
  toolCatalogEntries,
  toolConnections,
  toolGatewaySessions,
  toolInvocations,
  toolPolicies,
} from "@paperclipai/db";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type TestDb = ReturnType<typeof createDb>;

// Two ready plugins with one tool each. The namespaced tool name is
// "<pluginKey>:<toolName>", so the plugin keys are "a.b" and "c.d".
function twoPluginDispatcher(): PluginToolDispatcher {
  return {
    initialize: async () => {},
    teardown: () => {},
    listToolsForAgent: () => [
      {
        name: "a.b:alpha",
        displayName: "A Alpha",
        description: "A tool from plugin a.b.",
        parametersSchema: { type: "object" },
        pluginId: "plugin-a",
      },
      {
        name: "c.d:beta",
        displayName: "C Beta",
        description: "A tool from plugin c.d.",
        parametersSchema: { type: "object" },
        pluginId: "plugin-c",
      },
    ],
    getTool: () => null,
    executeTool: async () => ({
      pluginId: "plugin-a",
      toolName: "alpha",
      result: { ok: true },
    }),
    registerPluginTools: () => {},
    unregisterPluginTools: () => {},
    toolCount: () => 2,
    getRegistry: () => {
      throw new Error("not implemented");
    },
  };
}

async function createAgentFixture(db: TestDb, permissions: Record<string, unknown>) {
  const company = await db
    .insert(companies)
    .values({
      name: `Binding ${randomUUID()}`,
      issuePrefix: `GB${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  const agent = await db
    .insert(agents)
    .values({
      companyId: company.id,
      name: `Binding Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions,
    })
    .returning()
    .then((rows) => rows[0]!);
  const issue = await db
    .insert(issues)
    .values({
      companyId: company.id,
      title: "plugin tool binding",
      status: "in_progress",
      assigneeAgentId: agent.id,
    })
    .returning()
    .then((rows) => rows[0]!);
  const run = await db
    .insert(heartbeatRuns)
    .values({
      companyId: company.id,
      agentId: agent.id,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId: issue.id },
    })
    .returning()
    .then((rows) => rows[0]!);
  return { company, agent, issue, run };
}

// Both plugin tools must be permitted by generic policy so the only thing
// distinguishing what the agent sees is the pluginTools allowlist itself.
async function allowBothPluginTools(db: TestDb, companyId: string) {
  await db.insert(toolPolicies).values({
    companyId,
    name: "Allow a.b:alpha",
    policyType: "allow",
    selectors: { toolName: "a.b:alpha" },
  });
  await db.insert(toolPolicies).values({
    companyId,
    name: "Allow c.d:beta",
    policyType: "allow",
    selectors: { toolName: "c.d:beta" },
  });
}

describeEmbeddedPostgres("tool gateway plugin tool binding", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-binding-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(toolGatewaySessions);
    await db.delete(toolCallEvents);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolActionRequests);
    await db.delete(toolInvocations);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueThreadInteractions);
    await db.delete(toolCatalogEntries);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(toolPolicies);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("scopes the session listing to the agent's pluginTools allowlist", async () => {
    const { company, agent, run } = await createAgentFixture(db, { pluginTools: ["a.b"] });
    await allowBothPluginTools(db, company.id);
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: twoPluginDispatcher() });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    const names = (await gateway.listToolsForSession(session.token)).map((tool) => tool.name);

    expect(names).toContain("a.b:alpha");
    expect(names).not.toContain("c.d:beta");
  });

  it("shows both plugins' tools when the agent has no pluginTools key", async () => {
    const { company, agent, run } = await createAgentFixture(db, {});
    await allowBothPluginTools(db, company.id);
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: twoPluginDispatcher() });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    const names = (await gateway.listToolsForSession(session.token)).map((tool) => tool.name);

    expect(names).toContain("a.b:alpha");
    expect(names).toContain("c.d:beta");
  });

  it("scopes listPluginToolsForAgent to the agent's pluginTools allowlist", async () => {
    const { company, agent } = await createAgentFixture(db, { pluginTools: ["a.b"] });
    await allowBothPluginTools(db, company.id);
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: twoPluginDispatcher() });

    const names = (await gateway.listPluginToolsForAgent({ companyId: company.id, agentId: agent.id })).map((tool) => tool.name);

    expect(names).toContain("a.b:alpha");
    expect(names).not.toContain("c.d:beta");
  });

  it("shows both plugins' tools in listPluginToolsForAgent when the key is absent", async () => {
    const { company, agent } = await createAgentFixture(db, {});
    await allowBothPluginTools(db, company.id);
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: twoPluginDispatcher() });

    const names = (await gateway.listPluginToolsForAgent({ companyId: company.id, agentId: agent.id })).map((tool) => tool.name);

    expect(names).toContain("a.b:alpha");
    expect(names).toContain("c.d:beta");
  });

  it("hides every plugin tool when pluginTools is present and empty", async () => {
    const { company, agent } = await createAgentFixture(db, { pluginTools: [] });
    await allowBothPluginTools(db, company.id);
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: twoPluginDispatcher() });

    const names = (await gateway.listPluginToolsForAgent({ companyId: company.id, agentId: agent.id })).map((tool) => tool.name);

    expect(names).not.toContain("a.b:alpha");
    expect(names).not.toContain("c.d:beta");
  });

  it("returns no plugin tools when the allowlist names a key with no ready plugin", async () => {
    const { company, agent } = await createAgentFixture(db, { pluginTools: ["z.z"] });
    await allowBothPluginTools(db, company.id);
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: twoPluginDispatcher() });

    const names = (await gateway.listPluginToolsForAgent({ companyId: company.id, agentId: agent.id })).map((tool) => tool.name);

    expect(names).toEqual([]);
  });

  it("denies executing an allowlist-excluded plugin tool by name via tools/call", async () => {
    const { company, agent, run } = await createAgentFixture(db, { pluginTools: ["a.b"] });
    await allowBothPluginTools(db, company.id);
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: twoPluginDispatcher() });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: "c.d:beta",
      parameters: {},
    })).rejects.toMatchObject({ status: 404, reasonCode: "tool_not_found" });
  });

  it("still executes an allowlisted plugin tool by name via tools/call", async () => {
    const { company, agent, run } = await createAgentFixture(db, { pluginTools: ["a.b"] });
    await allowBothPluginTools(db, company.id);
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: twoPluginDispatcher() });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: "a.b:alpha",
      parameters: {},
    })).resolves.toMatchObject({ status: "completed", tool: "a.b:alpha" });
  });

  it("keeps executing plugin tools by name when the agent has no pluginTools key", async () => {
    const { company, agent, run } = await createAgentFixture(db, {});
    await allowBothPluginTools(db, company.id);
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: twoPluginDispatcher() });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: "c.d:beta",
      parameters: {},
    })).resolves.toMatchObject({ status: "completed", tool: "c.d:beta" });
  });

  it("denies executing an allowlist-excluded plugin tool by name via the plugin execute route", async () => {
    const { company, agent, run } = await createAgentFixture(db, { pluginTools: ["a.b"] });
    await allowBothPluginTools(db, company.id);
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: twoPluginDispatcher() });

    await expect(gateway.executePluginTool({
      actor: { type: "agent", agentId: agent.id, companyId: company.id, runId: run.id },
      tool: "c.d:beta",
      parameters: {},
      runContext: { companyId: company.id, agentId: agent.id, runId: run.id, projectId: "" },
    })).rejects.toMatchObject({ status: 404, reasonCode: "tool_not_found" });
  });
});
